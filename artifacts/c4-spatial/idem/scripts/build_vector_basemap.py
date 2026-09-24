#!/usr/bin/env python3
"""《病港》— Phase L：由本機 OSM 快取產生**向量**底圖。

為何要由 raster 轉向量
======================
舊做法係 raster LOD 圖磚（`scripts/build_map_lods.py`，已於 Gate 2 移除）：輸出尺寸固定，
改細 bbox 就等於放大。問題係**圖磚覆蓋唔到嘅地方冇得放大** ——
全港只有將軍澳一帶有街道級圖磚，其餘地區最大縮放時要將分區圖磚
拉伸 17.75 倍，必然起格。

要根治，唯一可行嘅做法係**向量**：幾何本身冇解像度，前端可以喺任何
縮放級別用 sub-pixel 精度重新繪製。

資料來源
========
`data/private/cache/osm-hk.json`（182 MB，198,300 個元素）——
Overpass API 嘅香港全境匯出，包含：
    道路 42,758 條（298,420 點）
    建築 133,341 幢（1,414,401 點）
    海岸線 1,603 條（89,464 點）
    內陸水體 3,123 個

**完全離線**：唔會再連 Overpass。快取係私有資料，唔會 commit。

輸出格式（為何係 delta 編碼整數）
================================
每個點係 `[x, y]`，單位係 **1e-5 度**（約 1.1 m），由格仔左上角起算嘅
delta。用整數 delta 而唔用浮點絕對座標，可以將每點由約 20 bytes 降到
約 6 bytes —— 對 141 萬點嘅建築層嚟講，係 8.5 MB 同 30 MB 嘅分別。

幾何一律**唔重複最後一點**（ring 由前端自動閉合），咁樣 `len(coords)`
一定係偶數，解碼簡單。

輸出
====
    public/assets/vector/manifest.json
    public/assets/vector/land.json        陸地多邊形（由海岸線推導）
    public/assets/vector/water.json       內陸水體
    public/assets/vector/roads-l0.json    低縮放：主要道路（已重度簡化）
    public/assets/vector/roads-l1.json    中縮放：全部道路（中度簡化）
    public/assets/vector/areas.json       公園／林地／工業區（面）
    public/assets/vector/tiles/r{r}c{c}.json   高縮放：道路＋建築＋POI

用法
====
    python scripts/build_vector_basemap.py --dry-run
    python scripts/build_vector_basemap.py
    python scripts/build_vector_basemap.py --only land,water
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

REPO = Path(__file__).resolve().parent.parent
OSM_CACHE = REPO / "data" / "private" / "cache" / "osm-hk.json"
OUT_DIR = REPO / "public" / "assets" / "vector"

#: 底圖覆蓋範圍（同 `public/assets/hk-basemap-coords.json` 一致）。
BBOX = {
    "lon_min": 113.79,
    "lon_max": 114.49,
    "lat_min": 22.11,
    "lat_max": 22.61,
}

#: 量化單位：1e-5 度 ≈ 1.11 m（緯度）／1.03 m（經度）。
QUANT = 100000

#: 高縮放圖磚嘅格仔大細（度）。
TILE_DEG = 0.05

# ---------------------------------------------------------------------------
# 道路分級
#
# 為何要分級而唔係全部畫同一條線
# ------------------------------
# 全港 42,758 條路，如果同一個粗細，低縮放時會變成一坨灰色。
# 分級之後可以：低縮放只畫 0–3 級（主幹），高縮放才畫 5–7 級（內街）。
# ---------------------------------------------------------------------------
ROAD_CLASS: dict[str, int] = {
    "motorway": 0,
    "motorway_link": 0,
    "trunk": 1,
    "trunk_link": 1,
    "primary": 2,
    "primary_link": 2,
    "secondary": 3,
    "secondary_link": 3,
    "tertiary": 4,
    "tertiary_link": 4,
    "residential": 5,
    "unclassified": 5,
    "living_street": 5,
    "service": 6,
    "pedestrian": 7,
    "footway": 7,
    "path": 7,
    "steps": 7,
    "cycleway": 7,
    "track": 7,
}

#: 各級喺邊個縮放層開始出現（0 = 最低）。
#: 前端用同一個表做 gate，兩邊必須一致（有測試把關）。
#: 各級喺邊個縮放層開始出現。
#:
#: 0 = 總覽層（`roads-l0.json`，主幹道）
#: 1 = 分區層（`roads-l1.json`，加到住宅街道）
#: 2 = 街道層（`tiles/`，加到服務路／行人路）
#:
#: ⚠️ 前端 `VectorBasemap.ROAD_MIN_LEVEL` 係**刻意重複**呢個表 ——
#: 兩邊唔一致就會出現「有資料但唔畫」或者「畫咗但冇資料」。有測試把關。
ROAD_MIN_LEVEL: dict[int, int] = {
    0: 0,
    1: 0,
    2: 0,
    3: 1,
    4: 1,
    5: 1,
    6: 2,
    7: 2,
}

#: 每個檔案包含到嘅最大 class（同上面嘅層級對應）。
ROADS_L0_MAX_CLASS = 2
ROADS_L1_MAX_CLASS = 5

#: 簡化容差（度）—— 低縮放用大容差（睇唔到嘅細節唔應該傳去前端）。
SIMPLIFY_TOL = {
    "l0": 0.00045,
    "l1": 0.00016,
    "tile_road": 0.000025,
    "tile_bld": 0.000020,
    "land": 0.00009,
    "water": 0.00006,
    "area": 0.00020,
}

#: 面積下限（平方米）——細過呢個嘅建築／水體喺任何縮放都係亞像素。
MIN_BUILDING_AREA_M2 = 24.0
MIN_WATER_AREA_M2 = 900.0
MIN_AREA_M2 = 4000.0

#: 經度 1 度 ≈ 幾多米（北緯 22.36）。
M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570


# ===========================================================================
# 幾何工具
# ===========================================================================

def q(v: float) -> int:
    """經緯度 → 量化整數。"""
    return int(round(v * QUANT))


def ring_area_m2(ring: list[tuple[float, float]]) -> float:
    """鞋帶公式（平方米，已按緯度校正）。"""
    if len(ring) < 3:
        return 0.0
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0 * M_PER_DEG_LON * M_PER_DEG_LAT


def signed_area(ring: list[tuple[float, float]]) -> float:
    """帶號面積（度²）—— 用嚟判斷環嘅方向（陸地／水域）。"""
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def simplify(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Douglas–Peucker 線簡化。

    為何自己寫而唔用 shapely
    ------------------------
    專案環境冇 shapely（唔想為咗一個函式加依賴），而 DP 本身只係
    20 行。用迭代式實作避免深遞歸爆 stack（海岸線環有 2.7 萬點）。
    """
    n = len(pts)
    if n <= 2 or tol <= 0:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    tol2 = tol * tol
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        x0, y0 = pts[i0]
        x1, y1 = pts[i1]
        dx, dy = x1 - x0, y1 - y0
        seg2 = dx * dx + dy * dy
        best = -1.0
        best_i = -1
        for i in range(i0 + 1, i1):
            px, py = pts[i]
            if seg2 <= 0:
                d2 = (px - x0) ** 2 + (py - y0) ** 2
            else:
                t = ((px - x0) * dx + (py - y0) * dy) / seg2
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                ex, ey = x0 + t * dx - px, y0 + t * dy - py
                d2 = ex * ex + ey * ey
            if d2 > best:
                best, best_i = d2, i
        if best > tol2:
            keep[best_i] = True
            stack.append((i0, best_i))
            stack.append((best_i, i1))
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(
    ring: list[tuple[float, float]], tol: float, min_area_m2: float
) -> list[tuple[float, float]] | None:
    """環專用簡化：先簡化，再檢查面積，太細就回 None。"""
    if len(ring) < 3:
        return None
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    if len(ring) < 3:
        return None
    s = simplify(ring + [ring[0]], tol)
    if len(s) >= 2 and s[0] == s[-1]:
        s = s[:-1]
    if len(s) < 3:
        return None
    if ring_area_m2(s) < min_area_m2:
        return None
    return s


def encode_delta(pts: list[tuple[float, float]], closed: bool = False) -> list[int]:
    """點列 → delta 編碼整數陣列。

    `closed=True` 時會自動補回最後一點（前端畫 ring 要閉合）。
    """
    if closed and pts and pts[0] != pts[-1]:
        pts = pts + [pts[0]]
    out: list[int] = []
    px = py = 0
    for i, (x, y) in enumerate(pts):
        ix, iy = q(x), q(y)
        if i == 0:
            out.extend((ix, iy))
        else:
            out.extend((ix - px, iy - py))
        px, py = ix, iy
    return out


def path_length_m(pts: list[tuple[float, float]]) -> float:
    tot = 0.0
    for i in range(len(pts) - 1):
        dx = (pts[i + 1][0] - pts[i][0]) * M_PER_DEG_LON
        dy = (pts[i + 1][1] - pts[i][1]) * M_PER_DEG_LAT
        tot += math.hypot(dx, dy)
    return tot


# ===========================================================================
# OSM 解析
# ===========================================================================

def geom_of(el: dict[str, Any]) -> list[tuple[float, float]]:
    g = el.get("geometry") or []
    return [(p["lon"], p["lat"]) for p in g if p.get("lon") is not None]


#: 海岸線自由端配對嘅最大距離（米）。
#:
#: 為何一定要補線而唔係掉咗佢
#: --------------------------
#: 本 OSM 抽取嘅 1,603 條 `natural=coastline` 斷成 **876 個連通分量**。
#: 斷口係**真實資料缺口**，唔係渲染誤差 —— 實測大嶼山主體西岸有
#: 3,504 m 缺口。唔補線嘅話：海會由缺口灌入島嶼內部，大嶼山陸地只剩
#: 3.1%；補線之後恢復到約 60%（同已於 Gate 2 移除嘅 raster 版
#: `render_binggang_map.coastline_bridges` 結論一致 —— 嗰邊係 raster，
#: 呢邊係向量，兩者用同一套拓樸修復）。
MAX_COAST_GAP_M = 6000.0


def build_coastline_rings(coast: list[dict[str, Any]]) -> list[list[tuple[float, float]]]:
    """將海岸線 ways 接成封閉環（含拓樸缺口修復）。

    演算法
    ------
    1. 建立**節點鄰接圖**（唔係 way 端點圖）—— 一條 way 中間嘅節點同
       另一條 way 嘅端點係同一個節點時，佢哋係相連嘅。
       ⚠️ 初版用 way 端點圖，得出「1599 個 degree-2 節點、8 個 degree-1」，
       結論係「只差 4 條鏈」—— **完全錯**。真相係 876 個分量、
       約 1,700 個自由端。
    2. 搵出自由端（鄰接數 = 1），按距離貪心配對補線（≤ MAX_COAST_GAP_M）。
    3. 沿邊走，抽出所有封閉環。

    ⚠️ 為何唔可以靠「沿 bbox 邊界補」
    --------------------------------
    bbox 邊界補法假設缺口全部喺圖邊 —— 但實際缺口喺圖**中間**
    （大嶼山西岸）。沿邊界補會產生橫跨全圖嘅巨型假環。
    """
    # ---- 1. 節點鄰接圖 ----
    adj: dict[int, set[int]] = defaultdict(set)
    coord: dict[int, tuple[float, float]] = {}
    for el in coast:
        nd = el.get("nodes") or []
        g = geom_of(el)
        if len(nd) < 2 or len(g) != len(nd):
            continue
        for n, p in zip(nd, g):
            coord[n] = p
            adj.setdefault(n, set())
        for a, b in zip(nd, nd[1:]):
            if a == b:
                continue
            adj[a].add(b)
            adj[b].add(a)

    # ---- 2. 自由端配對補線 ----
    ends = [n for n, nb in adj.items() if len(nb) == 1]
    if ends:
        try:
            from scipy.spatial import cKDTree  # type: ignore

            xs = [coord[n][0] * M_PER_DEG_LON for n in ends]
            ys = [coord[n][1] * M_PER_DEG_LAT for n in ends]
            tree = cKDTree(list(zip(xs, ys)))
            pairs = sorted(
                tree.query_pairs(MAX_COAST_GAP_M),
                key=lambda p: math.hypot(xs[p[0]] - xs[p[1]], ys[p[0]] - ys[p[1]]),
            )
        except ImportError:  # 冇 scipy 就退化為 O(n²)（自由端通常 < 2000）
            pairs = []
            for i in range(len(ends)):
                for j in range(i + 1, len(ends)):
                    d = math.hypot(
                        (coord[ends[i]][0] - coord[ends[j]][0]) * M_PER_DEG_LON,
                        (coord[ends[i]][1] - coord[ends[j]][1]) * M_PER_DEG_LAT,
                    )
                    if d <= MAX_COAST_GAP_M:
                        pairs.append((i, j))
            pairs.sort(
                key=lambda p: math.hypot(
                    (coord[ends[p[0]]][0] - coord[ends[p[1]]][0]) * M_PER_DEG_LON,
                    (coord[ends[p[0]]][1] - coord[ends[p[1]]][1]) * M_PER_DEG_LAT,
                )
            )
        used: set[int] = set()
        bridged = 0
        for i, j in pairs:
            if i in used or j in used:
                continue
            used.add(i)
            used.add(j)
            a, b = ends[i], ends[j]
            adj[a].add(b)
            adj[b].add(a)
            bridged += 1
        print(
            f"  拓樸修復：{len(ends)} 個自由端，就近補咗 {bridged} 條線"
            f"（≤ {MAX_COAST_GAP_M / 1000:.0f} km）",
            flush=True,
        )

        # ---- 2b. 仍然開放嘅鏈：直接連兩端 ----
        #
        # 為何要補而唔係掉
        # ----------------
        # 剩低嘅開放鏈係**大陸主體**：海岸線由后海灣（113.86, 22.56）
        # 一路繞到米埔／沙頭角（114.24, 22.56），兩端相距 39 km，
        # 冇可能就近配對。唔補嘅話，成個新界＋九龍＋將軍澳都會變成海
        # （實測 18 個測試點有 10 個錯）。
        #
        # 兩端之間係深圳陸地（唔屬香港），用直線連起等同「當深圳係陸地」，
        # 對香港境內嘅幾何冇影響。
        free2 = [n for n, nb in adj.items() if len(nb) == 1]
        if free2:
            comp: dict[int, int] = {}
            cid = 0
            for s in adj:
                if s in comp:
                    continue
                stack = [s]
                comp[s] = cid
                while stack:
                    u = stack.pop()
                    for v in adj[u]:
                        if v not in comp:
                            comp[v] = cid
                            stack.append(v)
                cid += 1
            by_comp: dict[int, list[int]] = defaultdict(list)
            for n in free2:
                by_comp[comp[n]].append(n)
            extra = 0
            for members in by_comp.values():
                if len(members) == 2:
                    a, b = members
                    adj[a].add(b)
                    adj[b].add(a)
                    extra += 1
                elif len(members) > 2:
                    # 多過兩個自由端：按方位角排序後順序連起
                    cx = sum(coord[m][0] for m in members) / len(members)
                    cy = sum(coord[m][1] for m in members) / len(members)
                    members.sort(
                        key=lambda m: math.atan2(coord[m][1] - cy, coord[m][0] - cx)
                    )
                    for a, b in zip(members, members[1:] + members[:1]):
                        adj[a].add(b)
                        adj[b].add(a)
                        extra += 1
            if extra:
                print(f"  再補 {extra} 條線封閉 {len(by_comp)} 條開放鏈（大陸主體等）")

    # ---- 3. 抽環 ----
    used_edge: set[tuple[int, int]] = set()

    def edge(a: int, b: int) -> tuple[int, int]:
        return (a, b) if a < b else (b, a)

    rings: list[list[tuple[float, float]]] = []
    for start_node in list(adj):
        for nxt in list(adj[start_node]):
            if edge(start_node, nxt) in used_edge:
                continue
            ring_nodes = [start_node]
            used_edge.add(edge(start_node, nxt))
            cur, prev = nxt, start_node
            while True:
                ring_nodes.append(cur)
                if cur == start_node:
                    break
                cand = [x for x in adj[cur] if edge(cur, x) not in used_edge]
                if not cand:
                    break
                # 優先揀非「補線」（補線係憑空加嘅，唔應該主導走法）
                cand.sort(key=lambda x: (0 if x in adj else 1))
                nxt2 = cand[0]
                used_edge.add(edge(cur, nxt2))
                prev, cur = cur, nxt2
                if len(ring_nodes) > 500000:
                    break
            if len(ring_nodes) >= 4 and ring_nodes[0] == ring_nodes[-1]:
                rings.append([coord[n] for n in ring_nodes])
    return rings


def point_in_ring(pt: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    x, y = pt
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            xin = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xin:
                inside = not inside
        j = i
    return inside


# ===========================================================================
# 主流程
# ===========================================================================

def load_osm() -> list[dict[str, Any]]:
    if not OSM_CACHE.exists():
        raise SystemExit(
            f"搵唔到 OSM 快取：{OSM_CACHE}\n"
            "呢個檔案係私有資料（182 MB），唔會 commit。請先跑 "
            "scripts/render_hk_basemap.py 產生。"
        )
    print(f"讀取 OSM 快取 {OSM_CACHE.name} …", flush=True)
    data = json.loads(OSM_CACHE.read_text(encoding="utf-8"))
    els = data["elements"]
    print(f"  {len(els):,} 個元素")
    return els


def build_land(els: list[dict[str, Any]]) -> list[list[tuple[float, float]]]:
    coast = [e for e in els if (e.get("tags") or {}).get("natural") == "coastline"]
    print(f"海岸線 ways：{len(coast)}", flush=True)
    rings = build_coastline_rings(coast)
    print(f"  接成 {len(rings)} 個環", flush=True)
    keep = []
    for r in rings:
        s = simplify_ring(r, SIMPLIFY_TOL["land"], 20000.0)
        if s:
            keep.append(s)
    keep.sort(key=lambda r: -ring_area_m2(r))
    print(f"  簡化後保留 {len(keep)} 個環，最大面積 {ring_area_m2(keep[0]) / 1e6:.1f} km²")
    return keep


def build_water(els: list[dict[str, Any]]) -> list[list[tuple[float, float]]]:
    out = []
    for e in els:
        t = e.get("tags") or {}
        if t.get("natural") not in ("water", "bay") and "waterway" not in t:
            continue
        if t.get("waterway") in ("river", "stream", "canal", "drain"):
            continue  # 線狀水系由 roads-l1 一類嘅線層處理，唔當面
        g = geom_of(e)
        s = simplify_ring(g, SIMPLIFY_TOL["water"], MIN_WATER_AREA_M2)
        if s:
            out.append(s)
    return out


def build_areas(els: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """公園／林地／工業區等大面積面層。"""
    out = []
    for e in els:
        t = e.get("tags") or {}
        kind = None
        if t.get("leisure") in ("park", "nature_reserve", "garden", "pitch", "sports_centre"):
            kind = "green"
        elif t.get("natural") in ("wood", "scrub", "grassland"):
            kind = "green"
        elif t.get("landuse") == "forest":
            kind = "green"
        elif t.get("landuse") == "industrial":
            kind = "industrial"
        elif t.get("landuse") == "cemetery":
            kind = "green"
        if kind is None:
            continue
        s = simplify_ring(geom_of(e), SIMPLIFY_TOL["area"], MIN_AREA_M2)
        if s:
            out.append({"k": 0 if kind == "green" else 1, "r": encode_delta(s, closed=True)})
    return out


def build_roads(els: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for e in els:
        t = e.get("tags") or {}
        hw = t.get("highway")
        if hw not in ROAD_CLASS:
            continue
        g = geom_of(e)
        if len(g) < 2:
            continue
        out.append({
            "cls": ROAD_CLASS[hw],
            "g": g,
            "name": t.get("name:zh") or t.get("name"),
            "tunnel": t.get("tunnel") in ("yes", "building_passage"),
            "bridge": t.get("bridge") == "yes",
        })
    return out


def build_buildings(els: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for e in els:
        t = e.get("tags") or {}
        if "building" not in t:
            continue
        g = geom_of(e)
        if len(g) < 4:
            continue
        lv = t.get("building:levels")
        try:
            levels = int(float(lv)) if lv is not None else 0
        except (TypeError, ValueError):
            levels = 0
        out.append({"g": g, "levels": max(0, min(levels, 90))})
    return out


def build_pois(els: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """由有名字嘅面／點產生標籤資料。

    `r` 係**標籤等級**：數字越細越重要，越早（縮放越細）出現。
    前端用 `LABEL_MIN_LEVEL` 對應同一套規則（有測試把關兩邊一致）。
    """
    out = []
    seen: set[tuple[str, int, int]] = set()
    for e in els:
        t = e.get("tags") or {}
        name = t.get("name:zh") or t.get("name")
        if not name:
            continue
        kind = None
        rank = 9
        place = t.get("place")
        if place in ("city", "town"):
            kind, rank = "place", 0
        elif place in ("suburb", "quarter", "neighbourhood", "village", "hamlet"):
            kind, rank = "place", 1
        elif place in ("island", "islet"):
            kind, rank = "place", 2
        elif t.get("amenity") in ("university", "college"):
            kind, rank = "campus", 2
        elif t.get("amenity") == "hospital":
            kind, rank = "hospital", 2
        elif t.get("leisure") in ("park", "nature_reserve"):
            kind, rank = "park", 3
        elif t.get("landuse") == "residential" and t.get("name"):
            kind, rank = "estate", 3
        elif t.get("amenity") == "school":
            kind, rank = "school", 4
        elif "building" in t and t.get("name"):
            # 單幢建築名只喺「地標級」才收。
            #
            # 為何要設門檻
            # ----------
            # 全港 47,119 個有名字嘅地物，其中大部分係住宅樓名
            # （「XX閣」「XX樓」）。實測呢批佔 POI 層 **3.4 MiB**，
            # 比道路層仲大；而最高密度嘅一格有 4,578 個 —— 任何縮放都
            # 冇可能畫得落。
            #
            # 門檻：樓高 ≥ 8 層（明顯係地標）或屬公共設施類別。
            try:
                lv = int(float(t.get("building:levels") or 0))
            except (TypeError, ValueError):
                lv = 0
            if lv < 8:
                continue
            kind, rank = "building", 5
        if kind is None:
            continue
        g = geom_of(e)
        if len(g) < 1:
            continue
        cx = sum(p[0] for p in g) / len(g)
        cy = sum(p[1] for p in g) / len(g)
        key = (name, q(cx) // 200, q(cy) // 200)
        if key in seen:
            continue
        seen.add(key)
        out.append({"n": name[:28], "k": kind, "r": rank, "x": q(cx), "y": q(cy)})
    out.sort(key=lambda p: p["r"])
    return out


def tile_of(lon: float, lat: float) -> tuple[int, int]:
    c = int((lon - BBOX["lon_min"]) / TILE_DEG)
    r = int((lat - BBOX["lat_min"]) / TILE_DEG)
    nc = int(math.ceil((BBOX["lon_max"] - BBOX["lon_min"]) / TILE_DEG))
    nr = int(math.ceil((BBOX["lat_max"] - BBOX["lat_min"]) / TILE_DEG))
    return max(0, min(nr - 1, r)), max(0, min(nc - 1, c))


def main() -> int:
    ap = argparse.ArgumentParser(description="產生《病港》向量底圖")
    ap.add_argument("--dry-run", action="store_true", help="只統計，唔寫檔")
    ap.add_argument("--only", default="", help="只做指定部分（逗號分隔）")
    args = ap.parse_args()

    only = {s.strip() for s in args.only.split(",") if s.strip()}

    def want(name: str) -> bool:
        return not only or name in only

    els = load_osm()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "tiles").mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {
        "version": 1,
        "generator": "scripts/build_vector_basemap.py",
        "source": "OpenStreetMap（ODbL）經 Overpass API 匯出，本機快取",
        "quant": QUANT,
        "quant_note": "座標係整數，單位 1e-5 度；由格仔左上角起算嘅 delta。",
        "bbox": BBOX,
        "tile_deg": TILE_DEG,
        "road_classes": ROAD_CLASS,
        "road_min_level": {str(k): v for k, v in ROAD_MIN_LEVEL.items()},
        "layers": {},
    }

    def write_json(name: str, obj: Any) -> int:
        p = OUT_DIR / name
        txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        p.write_text(txt, encoding="utf-8")
        return len(txt.encode("utf-8"))

    # ---- 陸地 ----
    if want("land"):
        print("建立陸地多邊形 …", flush=True)
        land = build_land(els)
        payload = {"rings": [encode_delta(r, closed=True) for r in land]}
        n = write_json("land.json", payload)
        manifest["layers"]["land"] = {"file": "land.json", "rings": len(land), "bytes": n}
        print(f"  → land.json {n / 1024:.0f} KiB（{len(land)} 環）")

    # ---- 內陸水體 ----
    if want("water"):
        print("建立內陸水體 …", flush=True)
        water = build_water(els)
        payload = {"rings": [encode_delta(r, closed=True) for r in water]}
        n = write_json("water.json", payload)
        manifest["layers"]["water"] = {"file": "water.json", "rings": len(water), "bytes": n}
        print(f"  → water.json {n / 1024:.0f} KiB（{len(water)} 環）")

    # ---- 面層（公園／工業） ----
    if want("areas"):
        print("建立面層 …", flush=True)
        areas = build_areas(els)
        n = write_json("areas.json", {"areas": areas})
        manifest["layers"]["areas"] = {"file": "areas.json", "count": len(areas), "bytes": n}
        print(f"  → areas.json {n / 1024:.0f} KiB（{len(areas)} 個）")

    roads = build_roads(els) if (want("roads") or want("tiles")) else []
    if roads:
        print(f"道路 {len(roads):,} 條", flush=True)

    # ---- 道路 L0（主要） ----
    if want("roads"):
        for level, tol, max_cls, fname in (
            ("l0", SIMPLIFY_TOL["l0"], ROADS_L0_MAX_CLASS, "roads-l0.json"),
            ("l1", SIMPLIFY_TOL["l1"], ROADS_L1_MAX_CLASS, "roads-l1.json"),
        ):
            out = []
            for r in roads:
                if r["cls"] > max_cls:
                    continue
                s = simplify(r["g"], tol)
                if len(s) < 2:
                    continue
                flags = (1 if r["tunnel"] else 0) | (2 if r["bridge"] else 0)
                out.append([r["cls"], flags] + encode_delta(s))
            n = write_json(fname, {"roads": out})
            manifest["layers"][level] = {"file": fname, "count": len(out), "bytes": n}
            print(f"  → {fname} {n / 1024:.0f} KiB（{len(out):,} 條）")

    # ---- 高縮放圖磚 ----
    if want("tiles"):
        print("建立高縮放圖磚 …", flush=True)
        blds = build_buildings(els)
        pois = build_pois(els)
        print(f"  建築 {len(blds):,} 幢、POI {len(pois):,} 個", flush=True)

        tile_roads: dict[tuple[int, int], list[Any]] = defaultdict(list)
        for r in roads:
            g = r["g"]
            cx = sum(p[0] for p in g) / len(g)
            cy = sum(p[1] for p in g) / len(g)
            s = simplify(g, SIMPLIFY_TOL["tile_road"])
            if len(s) < 2:
                continue
            flags = (1 if r["tunnel"] else 0) | (2 if r["bridge"] else 0)
            tile_roads[tile_of(cx, cy)].append([r["cls"], flags] + encode_delta(s))

        tile_bld: dict[tuple[int, int], list[Any]] = defaultdict(list)
        for b in blds:
            g = b["g"]
            cx = sum(p[0] for p in g) / len(g)
            cy = sum(p[1] for p in g) / len(g)
            s = simplify_ring(g, SIMPLIFY_TOL["tile_bld"], MIN_BUILDING_AREA_M2)
            if s:
                tile_bld[tile_of(cx, cy)].append(encode_delta(s, closed=True) + [b["levels"]])

        # 全域標籤（rank ≤ 4）另外寫一份 —— 低縮放時唔想為咗標籤載入圖磚。
        labels = [p for p in pois if p["r"] <= 4]
        nl = write_json("labels.json", {"labels": labels})
        manifest["layers"]["labels"] = {"file": "labels.json", "count": len(labels), "bytes": nl}
        print(f"  → labels.json {nl / 1024:.0f} KiB（{len(labels):,} 個標籤）")

        tile_poi: dict[tuple[int, int], list[Any]] = defaultdict(list)
        for p in pois:
            if p["r"] < 5:
                continue  # 已經喺 labels.json
            tile_poi[tile_of(p["x"] / QUANT, p["y"] / QUANT)].append(p)

        keys = set(tile_roads) | set(tile_bld) | set(tile_poi)
        files: dict[str, dict[str, int]] = {}
        total = 0
        for (r, c) in sorted(keys):
            name = f"tiles/r{r:02d}c{c:02d}.json"
            obj = {
                "rc": [r, c],
                "roads": tile_roads.get((r, c), []),
                "bld": tile_bld.get((r, c), []),
                "poi": tile_poi.get((r, c), []),
            }
            n = write_json(name, obj)
            total += n
            files[f"{r},{c}"] = {"file": name, "bytes": n}
        manifest["layers"]["tiles"] = {
            "dir": "tiles/",
            "count": len(keys),
            "bytes": total,
            "files": files,
        }
        print(f"  → {len(keys)} 個圖磚，共 {total / 1024 / 1024:.1f} MiB")

    if args.dry_run:
        print("\n（--dry-run：冇寫 manifest）")
        return 0

    # 內容 hash（可稽核：同一輸入 → 同一 hash）
    h = hashlib.sha256()
    for p in sorted(OUT_DIR.rglob("*.json")):
        if p.name == "manifest.json":
            continue
        h.update(p.relative_to(OUT_DIR).as_posix().encode())
        h.update(p.read_bytes())
    manifest["content_sha256"] = h.hexdigest()

    write_json("manifest.json", manifest)
    print(f"\n寫入 {OUT_DIR / 'manifest.json'}")
    print(f"內容 SHA-256：{manifest['content_sha256'][:16]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())

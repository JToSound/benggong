#!/usr/bin/env python3
"""量度深 zoom 視窗內「真實資料真空」嘅面積佔比（B9 Q3/Q4 根因診斷）。

為何需要呢個腳本
================
B9 實測 `center` 錨點（bbox 幾何中心 114.14, 22.36 —— 石籬邨／金山郊野
公園交界）Z6 嘅 `flatRatio` 由 Z0 嘅 0.8521 **升到** 0.9584、`meanGrad`
由 11.18 **跌到** 2.37，即係「深 zoom 比全港視圖更平」（Q3/Q4 FAIL）。

判斷「係唔係加多啲真實資料就搞得掂」之前，一定要先量度**究竟幾多面積
係真空白**。呢個腳本用 point-in-polygon 網格取樣，逐個視窗報：
    · 各資料層嘅面積覆蓋率
    · 「任何多邊形都冇」嘅空白佔比

⚠️ 唔可以用「多邊形質心落唔落喺視窗內」做過濾 —— 大範圍多邊形（例如
`landuse=residential` 嘅屋邨）質心可能喺窗外，但範圍覆蓋窗內。所以本
腳本用 bbox 相交 + 空間索引。

實測結論（2026-09-24）
======================
    center Z6：87.1% 空白（連未渲染嘅 landuse=residential 都計埋）
    center Z8：100.0% 空白
    tko    Z6：54.9% 空白（所以 tko 錨點一直 PASS）
→ 即係「加真實資料」唔可能解決 center 錨點（OSM 抽取冇等高線、冇林地
  多邊形、冇山徑）。詳細裁決見
  `docs/progress/a-deep-zoom-content-density.md`。

用法
====
    python scripts/probe_zoom_coverage.py
    python scripts/probe_zoom_coverage.py --json artifacts/zoom-coverage.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OSM_CACHE = REPO / "data" / "private" / "cache" / "osm-hk.json"

#: 經度 1 度 ≈ 幾多米（北緯 22.36）。
M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570

#: 預設量度嘅視窗（同 B9 `zoom-quality-raw.json` 嘅 `geo` 一致）。
DEFAULT_WINDOWS: dict[str, tuple[float, float, float, float]] = {
    "center Z6": (114.1347, 114.1453, 22.3562, 22.3638),
    "center Z8": (114.1388, 114.1412, 22.3591, 22.3609),
    "tko Z6": (114.2567, 114.2673, 22.3062, 22.3137),
}

#: 空間索引格大細（度）。
CELL = 0.01

#: 面積下限（平方米）—— 同 `build_vector_basemap.py` 一致。
MIN_AREA_M2 = {"building": 24.0, "water": 900.0}
DEFAULT_MIN_AREA_M2 = 4000.0


def geom_of(e: dict) -> list[tuple[float, float]]:
    return [
        (p["lon"], p["lat"])
        for p in (e.get("geometry") or [])
        if p.get("lon") is not None
    ]


def ring_area_m2(ring: list[tuple[float, float]]) -> float:
    n = len(ring)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0 * M_PER_DEG_LON * M_PER_DEG_LAT


def point_in_ring(x: float, y: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def classify(t: dict) -> str | None:
    """OSM tag → 資料層名（`None` = 唔屬任何已渲染／可渲染層）。"""
    if "building" in t:
        return "building"
    if t.get("natural") in ("water", "bay") or "waterway" in t:
        return "water"
    if t.get("leisure") in ("park", "nature_reserve", "garden", "pitch", "sports_centre"):
        return "green"
    if t.get("natural") in ("wood", "scrub", "grassland"):
        return "green"
    if t.get("landuse") in ("forest", "cemetery"):
        return "green"
    if t.get("landuse") == "industrial":
        return "industrial"
    lu = t.get("landuse")
    if lu in (
        "residential", "commercial", "retail", "village_green", "recreation_ground",
        "military", "quarry", "railway", "farmland", "plant_nursery", "orchard",
        "basin", "depot",
    ):
        return f"urban:{lu}"
    return None


def build_index() -> dict[tuple[int, int], list[tuple[str, list[tuple[float, float]]]]]:
    if not OSM_CACHE.exists():
        raise SystemExit(
            f"搵唔到 OSM 快取：{OSM_CACHE}\n"
            "呢個腳本要 `data/private/cache/osm-hk.json`（私有、唔會 commit）。"
        )
    els = json.loads(OSM_CACHE.read_text(encoding="utf-8"))["elements"]
    index: dict[tuple[int, int], list[tuple[str, list]]] = {}
    for e in els:
        key = classify(e.get("tags") or {})
        if key is None:
            continue
        g = geom_of(e)
        if len(g) < 3:
            continue
        if ring_area_m2(g) < MIN_AREA_M2.get(key, DEFAULT_MIN_AREA_M2):
            continue
        xs = [p[0] for p in g]
        ys = [p[1] for p in g]
        for ci in range(int(min(xs) // CELL), int(max(xs) // CELL) + 1):
            for ri in range(int(min(ys) // CELL), int(max(ys) // CELL) + 1):
                index.setdefault((ci, ri), []).append((key, g))
    return index


def measure(
    index: dict, box: tuple[float, float, float, float], nx: int = 200, ny: int = 150
) -> dict:
    lon0, lon1, lat0, lat1 = box
    total = nx * ny
    counts: dict[str, int] = {}
    hit_any = 0
    for iy in range(ny):
        y = lat0 + (lat1 - lat0) * (iy + 0.5) / ny
        for ix in range(nx):
            x = lon0 + (lon1 - lon0) * (ix + 0.5) / nx
            hit: str | None = None
            for key, r in index.get((int(x // CELL), int(y // CELL)), ()):
                xs = [p[0] for p in r]
                ys = [p[1] for p in r]
                if not (min(xs) <= x <= max(xs) and min(ys) <= y <= max(ys)):
                    continue
                if point_in_ring(x, y, r):
                    hit = key
                    break
            if hit:
                counts[hit] = counts.get(hit, 0) + 1
                hit_any += 1
    return {
        "box": box,
        "samples": total,
        "coverage": {k: round(v / total, 4) for k, v in sorted(counts.items(), key=lambda kv: -kv[1])},
        "anyPolygon": round(hit_any / total, 4),
        "blank": round((total - hit_any) / total, 4),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="量度深 zoom 視窗嘅資料覆蓋率")
    ap.add_argument("--json", default="", help="額外寫一份 JSON 報告")
    ap.add_argument("--nx", type=int, default=200)
    ap.add_argument("--ny", type=int, default=150)
    args = ap.parse_args()

    print("建立空間索引 …", flush=True)
    index = build_index()
    print(f"索引格數：{len(index):,}\n", flush=True)

    out: dict[str, dict] = {}
    for name, box in DEFAULT_WINDOWS.items():
        r = measure(index, box, args.nx, args.ny)
        out[name] = r
        print(f"=== {name}  lon {box[0]}..{box[1]}  lat {box[2]}..{box[3]} ===")
        for k, v in r["coverage"].items():
            print(f"  {v * 100:6.2f}%  {k}")
        print(f"  {r['anyPolygon'] * 100:6.2f}%  <任何多邊形>")
        print(f"  {r['blank'] * 100:6.2f}%  <空白>\n")

    if args.json:
        p = Path(args.json)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"寫入 {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

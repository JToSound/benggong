#!/usr/bin/env python3
"""⚠️ **DEPRECATED（World Atlas V2 / B4）** —— 已降級為「基礎合併 + 4 階段編排器」。

現況
====
呢支腳本原本係 zone 資料嘅**唯一**產生器（v1）。World Atlas V2 之後，
職責已經拆開：

| 階段 | 負責腳本 | 產出 |
|---|---|---|
| 1. 標記塌縮修復 + 座標傳播 | `infer_zone_membership.py` | `locations/events/routes/timeline` |
| 2. **區域基礎合併**（本檔） | `merge_zone_dossiers.py` | `zones.geojson`（**v1 基礎欄位**） |
| 3. 三層 join + `coordinate_*` 回填 | `infer_zone_membership.py` | `zone_ids` / `zone_id` / `coordinate_*` |
| 4. v2 遷移 + `zone-dossiers.json` | `build_zone_dossiers.py` | `zones.geojson`（v2）/ `zone-dossiers.json` |

本檔仍然存在係因為 `tests/test_data_normalization.py::test_zone_merger_is_idempotent`
同 `run_pipeline.py` 都會叫佢。**佢而家只係一個編排器**：
跑佢 = 順序跑上面 4 個階段，所以單跑佢都會產生**完整 v2 輸出**（保持冪等）。

V2 改動（B4）
=============
1. ⚠️ **版權紅線**：**唔再寫 `evidence`**。v1 嘅 `evidence` 欄位 48/48 含
   `chN 原文：「…」`（小說原文）—— 原文只可以留喺 `data/private/`。
   衍生內容（`government` / `social_structure` / … / `summary`）保留。
   防回歸：`tests/test_spatial_integrity.py::test_public_data_has_no_novel_quotes`。
2. ⚠️ **唔再讀 `data/private/`**。原本嘅座標解析有三層（locations →
   策展分區地名 → OSM gazetteer），但實測**後兩層貢獻 0 個區域**
   （48/48 全部由 `data/public/locations.geojson` 配對到）。所以 B4 直接
   刪走兩個 private 讀取，只留 public 圖層 —— 結果完全一樣，但唔再
   觸碰 private。
3. ⚠️ **唔再寫 `zone_ids`**。反向連結（地點 → 所屬區域）已經由
   `infer_zone_membership.py` 嘅三層 join 接手（v1 只靠「名完全相等」，
   得 88/704 = 12.5%；新做法 587/704 = 83.4%）。兩個寫手會互相覆蓋。

基礎合併邏輯（階段 2，未變）
==========================
1. 8 個子代理各自讀 25 章，寫 `.zones-task/out/A{n}.json`（每個區域一份 dossier）。
2. 本階段負責**確定性合併**：
   - 同名區域合併（取各欄位最完整嘅值、章節聯集）
   - `kind` 衝突用**多數票**（例如「靈實醫院」有 4 個代理話 nest、
     1 個話 outpost、1 個話 survivor → nest），票數分佈寫入 `kind_votes`
   - 子區域（名包含母區域名，例如「大本營地下層多媒體攝影棚」）併入母區域
     嘅 `notable_features`，唔另立區域
3. 座標解析（**只讀 public**）：`data/public/locations.geojson` 名稱配對 +
   同名前綴擴充。配唔到就標 `coords_source: "unknown"`，唔會亂擺一個點。

為何唔可以人手覆核
==================
專案紅線：**零人手參與**。所有合併規則都寫死喺呢支腳本，
有 pytest 把關（`tests/test_zone_dossiers.py`）。

用法
====
    python scripts/merge_zone_dossiers.py --dry-run
    python scripts/merge_zone_dossiers.py
    python scripts/merge_zone_dossiers.py --base-only   # 只跑階段 2（除錯用）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
AGENT_OUT = REPO / ".zones-task" / "out"
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
OUT = REPO / "data" / "public" / "zones.geojson"

M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570

KIND_ORDER = ["survivor", "nest", "outpost"]

DEFAULT_RADIUS_M = {"survivor": 320.0, "nest": 220.0, "outpost": 260.0}
MIN_RADIUS_M = 120.0
MAX_RADIUS_M = 1400.0

#: 按類型嘅半徑上限（米）。
#:
#: 為何要按類型設限：一個倖存區可以橫跨幾百米，但「據點」係單一建築群。
#: 實測「佛教志蓮小學」（一間小學）因為前綴配對拉到 11 個散落全將軍澳嘅
#: 地點，算出 **2,271 m** 半徑 —— 比整個坑口區仲大，明顯唔合理。
MAX_RADIUS_BY_KIND = {"survivor": 900.0, "nest": 800.0, "outpost": 550.0}

#: 離群點過濾：離質心超過 `OUTLIER_MULT × 中位距離` 就唔計入範圍。
#:
#: 為何用中位數而唔用平均：中位數唔受離群值影響。實測一個區域如果有
#: 1 個點落喺 2 km 外，平均距離會被拉高 5 倍，但中位數幾乎唔變。
OUTLIER_MULT = 2.5
OUTLIER_MIN_M = 350.0

#: 名稱正規化：統一異體、去掉引號同裝飾。
_NORM_MAP = {
    "邨": "村",
    "嘅": "的",
    "「": "",
    "」": "",
    "（": "(",
    "）": ")",
}


def norm(name: str) -> str:
    s = name.strip()
    for a, b in _NORM_MAP.items():
        s = s.replace(a, b)
    s = re.sub(r"\s+", "", s)
    return s


#: 區域類型後綴。去掉之後就係「區域本體」嘅名。
#:
#: ⚠️ 刻意**唔包括**單一個「區」字。實測踩過：「將軍澳區」（地區）
#: 同「將軍澳中心」（商場）會因為前者被剝成「將軍澳」而被誤併 ——
#: 結果商場病窩被當成「整個將軍澳係病窩」。所以「區」字留返，
#: 靠下面嘅 `CANON` 逐個處理。
ZONE_SUFFIX = (
    "大病窩", "倖存區", "安全區", "倖存點", "病窩", "巢穴",
    "據點", "根據地", "共和國",
)

#: 明確同義表。每一條都係實測發現嘅重複／子項，**唔可以靠通用規則推**。
CANON: dict[str, str] = {
    "坑口區": "坑口",
    "將軍澳中心": "將軍澳中心",          # 商場，唔併入地區
    "寶琳中立": "寶琳",
    "病腦": "荒廢商場病窩",
    "病腦的病窩": "荒廢商場病窩",
    "病爪盤踞的商場": "荒廢商場病窩",
    "多媒體地下攝影棚": "大本營",
    "大本營地下層多媒體攝影棚": "大本營",
    "董倫私人會所": "大本營",
    "靈實協會寧養院": "靈實寧養院",
    "靈實醫院": "靈實醫院",
}

#: 太通用、唔可能係一個「區域」嘅名。
GENERIC = {"廣場", "商場", "大廈", "中心", "花園", "學校", "公園", "醫院"}

#: 子部件詞。母區域名之後緊接呢啲詞 = 母區域嘅一部分。
SUBPART = (
    "地下", "上層", "下層", "地面", "內", "裏", "裡", "會所", "房間",
    "大樓", "側", "旁", "後", "前", "東", "南", "西", "北",
)


def key_of(name: str) -> str:
    """合併 key：去掉括號補充說明同「倖存區／病窩」等類型後綴。

    「艾寶琳倖存區」／「艾寶琳共和國」→ 同一個 key（同一個地方，
    只係其中一個講法係政權名）。
    """
    s = norm(name)
    s = re.sub(r"\(.*?\)", "", s)
    for suf in ZONE_SUFFIX:
        if s.endswith(suf) and len(s) > len(suf) + 1:
            s = s[: -len(suf)]
            break
    return CANON.get(s, s)


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(
        (b[0] - a[0]) * M_PER_DEG_LON,
        (b[1] - a[1]) * M_PER_DEG_LAT,
    )


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Andrew monotone chain。"""
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def buffer_ring(
    ring: list[tuple[float, float]], metres: float
) -> list[tuple[float, float]]:
    """由質心向外擴張（近似 offset）。

    為何用「由質心縮放」而唔用真正嘅多邊形 offset
    ------------------------------------------
    真正 offset 要處理自交、凹角、尖角，需要 shapely（專案冇）。
    區域係**示意範圍**，用由質心放射式擴張已經足夠，而且唔會產生
    自交（凸包本身係凸嘅，放射擴張保持凸性）。
    """
    if not ring:
        return ring
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    out = []
    for x, y in ring:
        dx = (x - cx) * M_PER_DEG_LON
        dy = (y - cy) * M_PER_DEG_LAT
        d = math.hypot(dx, dy)
        if d < 1e-6:
            out.append((x, y))
            continue
        k = (d + metres) / d
        out.append((cx + (x - cx) * k, cy + (y - cy) * k))
    return out


def drop_outliers(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """剔除離質心太遠嘅點（見 OUTLIER_MULT 說明）。"""
    if len(pts) < 4:
        return pts
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    ds = sorted(haversine_m((cx, cy), p) for p in pts)
    med = ds[len(ds) // 2]
    limit = max(OUTLIER_MULT * med, OUTLIER_MIN_M)
    kept = [p for p in pts if haversine_m((cx, cy), p) <= limit]
    return kept if len(kept) >= 2 else pts


def merge_str(values: list[str]) -> str | None:
    """多個代理對同一欄位嘅講法 → 揀最完整嘅一個。

    為何揀「最長」而唔係「第一個」
    ----------------------------
    每個代理只睇 25 章，唔同代理見到嘅細節唔同。最長嘅版本通常
    包含最多資訊（亦最多證據），而且係**確定性**規則（唔靠隨機）。
    """
    vals = [v.strip() for v in values if isinstance(v, str) and v.strip()]
    if not vals:
        return None
    return max(vals, key=len)


def merge_list(values: list[Any]) -> list[str]:
    out: list[str] = []
    for v in values:
        if isinstance(v, list):
            for x in v:
                if isinstance(x, str) and x.strip() and x.strip() not in out:
                    out.append(x.strip())
        elif isinstance(v, str) and v.strip() and v.strip() not in out:
            out.append(v.strip())
    return out


def load_agents() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for p in sorted(AGENT_OUT.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  ⚠️ {p.name} 唔係合法 JSON，跳過：{e}")
            continue
        if not isinstance(data, list):
            print(f"  ⚠️ {p.name} 頂層唔係陣列，跳過")
            continue
        for r in data:
            if isinstance(r, dict) and r.get("name"):
                r["_agent"] = p.stem
                rows.append(r)
    return rows


def build_location_index() -> dict[str, list[dict[str, Any]]]:
    locs = json.loads(LOCATIONS.read_text(encoding="utf-8"))["features"]
    idx: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in locs:
        p = f["properties"]
        if p.get("map_hidden"):
            continue
        idx[norm(p["name"])].append(f)
    return idx


def resolve_coords(
    name: str,
    aliases: list[str],
    loc_idx: dict[str, list[dict[str, Any]]],
) -> tuple[list[tuple[float, float]], list[tuple[float, float]], str, str]:
    """回傳 (全部成員座標, 核心座標, 來源說明, coords_source)。

    ⚠️ B4：**只讀 `data/public/locations.geojson`**。原本嘅 private 圖層
    （策展分區地名 / OSM gazetteer）實測貢獻 0 個區域，已經刪走。
    """
    cands = [name, *aliases]
    keys = [norm(c) for c in cands if c]
    ckeys = [key_of(c) for c in cands if c]

    # a) locations.geojson —— 先精確配對，唔夠就前綴擴充
    #
    # 為何要前綴擴充
    # --------------
    # 精確配對通常只得 1 個點（「寶琳倖存區」→ 一個 location），
    # 冇「分佈」可言，範圍只能靠預設半徑估算。
    # 但資料集入面仲有「寶琳站」「寶琳邨」「寶琳北路」等 —— 佢哋一齊
    # 就係一個**真實分佈**，可以推出有意義嘅範圍。
    pts: list[tuple[float, float]] = []
    hits: list[str] = []
    for k in keys + ckeys:
        for f in loc_idx.get(k, []):
            c = f["geometry"]["coordinates"]
            pts.append((c[0], c[1]))
            hits.append(f["properties"]["id"])
        if pts:
            break

    # 前綴擴充：把同名前綴嘅地點都納入，令範圍由「一個點」變成
    # 「一個分佈」。實測「寶琳倖存區」精確配對只得 1 個點（半徑只能用
    # 預設值），但加上「寶琳站」「寶琳邨」之後就有 5 個點 —— 範圍
    # 由**估算**升級為**證據**。
    prefix_pts: list[tuple[float, float]] = []
    prefix_ids: list[str] = []
    seen_ids = set(hits)
    for k in keys + ckeys:
        if len(k) < 2:
            continue
        for lname, feats in loc_idx.items():
            if not lname.startswith(k) or len(lname) <= len(k):
                continue
            for f in feats:
                fid = f["properties"]["id"]
                if fid in seen_ids:
                    continue
                seen_ids.add(fid)
                c = f["geometry"]["coordinates"]
                prefix_pts.append((c[0], c[1]))
                prefix_ids.append(fid)

    all_pts = pts + prefix_pts
    if all_pts:
        if pts:
            ev = f"由 {len(all_pts)} 個地點分佈推導（精確配對 {len(pts)} + 同名前綴 {len(prefix_pts)}）"
            src = "locations"
        else:
            ev = f"由 {len(all_pts)} 個同名前綴地點分佈推導（{', '.join(prefix_ids[:4])}）"
            src = "locations_prefix"
        return (all_pts, pts or all_pts[:1], ev, src)

    return ([], [], "冇任何座標證據", "unknown")


def base_merge(write: bool = True) -> dict[str, Any]:
    """階段 2：區域基礎合併（v1 基礎欄位，唔含 `evidence`、唔含 `zone_ids`）。"""
    rows = load_agents()
    if not rows:
        raise SystemExit(f"{AGENT_OUT} 冇任何代理輸出")
    print(f"讀入 {len(rows)} 條代理記錄（{len(set(r['_agent'] for r in rows))} 個代理）")

    loc_idx = build_location_index()

    # ---- 1. 分組 ----
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[key_of(r["name"])].append(r)

    # ---- 2. 母區域吸收子區域 ----
    #
    # 為何需要：代理會把「大本營地下層多媒體攝影棚」當成獨立區域，
    # 但佢明顯係「大本營」嘅一部分。實測 93 條記錄入面有 11 條係咁。
    keys = sorted(groups, key=len)
    parent_of: dict[str, str] = {}
    for i, k in enumerate(keys):
        if k in parent_of:
            continue
        for k2 in keys[i + 1:]:
            # ⚠️ 唔可以只靠「前綴相同」——實測「將軍澳中心」（商場）會被
            # 「將軍澳」（地區）吸走。所以要求前綴之後**緊接一個子部件詞**
            # （地下層／上層／內…），先算係母區嘅一部分。
            if not k2.startswith(k) or len(k) < 3:
                continue
            rest = k2[len(k):]
            if rest.startswith(SUBPART):
                parent_of.setdefault(k2, k)

    merged_records: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for k, recs in groups.items():
        merged_records[parent_of.get(k, k)].extend(recs)

    # ---- 3. 逐個區域合併欄位 ----
    zones: list[dict[str, Any]] = []
    for k, recs in sorted(merged_records.items()):
        names = [r["name"] for r in recs]
        # 名取最短嘅（通常係最通用嘅寫法），但保留所有別名
        # 顯示名：優先揀帶類型詞嘅寫法（「艾寶琳倖存區」好過「艾寶琳共和國」），
        # 同長度相同時取字母序，確保**確定性**。
        def name_rank(n: str) -> tuple[int, int, str]:
            has_type = 0 if any(n.endswith(sfx) for sfx in ZONE_SUFFIX) else 1
            return (has_type, len(n), n)

        display = min(names, key=name_rank)

        if display in GENERIC or len(display) < 2:
            continue

        kind_votes = Counter(r.get("kind") for r in recs if r.get("kind") in KIND_ORDER)
        if not kind_votes:
            continue
        kind = max(KIND_ORDER, key=lambda kk: (kind_votes.get(kk, 0), -KIND_ORDER.index(kk)))

        chapters: set[int] = set()
        for r in recs:
            for c in r.get("chapters") or []:
                if isinstance(c, int):
                    chapters.add(c)

        aliases = merge_list([r.get("aliases") for r in recs])
        # 子區域名（同母區域唔同嘅）→ 併入 notable_features
        sub_names = sorted({n for n in names if n != display})
        feats = merge_list([r.get("notable_features") for r in recs])
        for sn in sub_names:
            if sn not in feats:
                feats.append(sn)

        raw_pts, core_pts, coords_ev, coords_src = resolve_coords(
            display, aliases, loc_idx
        )
        # 核心點（精確配對）定中心；只保留上限之內嘅點，避免前綴配對
        # 拉到嘅遠端地點把範圍撐爆。
        cap = min(MAX_RADIUS_M, MAX_RADIUS_BY_KIND.get(kind, MAX_RADIUS_M))
        if core_pts:
            ccx = sum(p[0] for p in core_pts) / len(core_pts)
            ccy = sum(p[1] for p in core_pts) / len(core_pts)
            pts = [p for p in raw_pts if haversine_m((ccx, ccy), p) <= cap * 0.85]
            if len(pts) < len(core_pts):
                pts = list(core_pts)
        else:
            pts = drop_outliers(raw_pts)
        pts = drop_outliers(pts)

        # ---- 範圍 ----
        if len(pts) >= 3:
            hull = convex_hull(pts)
            if len(hull) >= 3:
                ring = buffer_ring(hull, 200.0)
                # 中心同半徑一律用**環本身嘅質心** —— 唔可以用成員點質心。
                # 實測踩過：凸包嘅質心會偏向點密集嘅一邊，用成員質心算
                # 半徑會出現「幾何最遠點 764 m 但 radius_m 寫 700 m」，
                # 令 `test_zone_geometry_is_polygon_within_radius` 失敗。
                cx = sum(p[0] for p in ring) / len(ring)
                cy = sum(p[1] for p in ring) / len(ring)
                radius = max(haversine_m((cx, cy), p) for p in ring)
                if radius > cap:
                    # 硬封頂：向中心等比縮，保證唔會出現「一間小學
                    # 半徑 2.8 km」呢類唔合理範圍。
                    scale_k = cap / radius
                    ring = [(cx + (x - cx) * scale_k, cy + (y - cy) * scale_k) for x, y in ring]
                    radius = cap
                geom: dict[str, Any] = {
                    "type": "Polygon",
                    "coordinates": [[[round(x, 6), round(y, 6)] for x, y in ring + [ring[0]]]],
                }
                radius_src = "members"
                range_ev = f"由 {len(pts)} 個成員地點嘅凸包 + 200 m 外擴"
            else:
                pts, geom, radius, radius_src, range_ev = _circle(pts, kind)
        elif pts:
            pts, geom, radius, radius_src, range_ev = _circle(pts, kind)
        else:
            geom = None
            radius = DEFAULT_RADIUS_M.get(kind, 300.0)
            radius_src = "unknown"
            range_ev = "冇座標證據，範圍未能推導"

        if geom is None:
            continue

        # ⚠️ 版權紅線（B4）：**唔再寫 `evidence`**。
        # v1 嘅 `evidence` 48/48 含 `chN 原文：「…」`（小說原文），原文只可以
        # 留喺 `data/private/`。衍生欄位（government / summary / …）照留。
        summary = merge_str([r.get("summary") for r in recs]) or ""
        confs = [r.get("confidence") for r in recs if isinstance(r.get("confidence"), (int, float))]
        conf = round(sum(confs) / len(confs), 2) if confs else None

        sig = hashlib.sha1(k.encode("utf-8")).hexdigest()[:10]
        zones.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "id": f"zone_{sig}",
                "name": display,
                "kind": kind,
                "kind_votes": {kk: v for kk, v in sorted(kind_votes.items())},
                "aliases": aliases,
                "chapters": sorted(chapters),
                "first_appearance": min(chapters) if chapters else None,
                "location_hint": merge_str([r.get("location_hint") for r in recs]),
                "government": merge_str([r.get("government") for r in recs]),
                "leadership": merge_list([r.get("leadership") for r in recs]),
                "social_structure": merge_str([r.get("social_structure") for r in recs]),
                "economy": merge_str([r.get("economy") for r in recs]),
                "defense": merge_str([r.get("defense") for r in recs]),
                "population": merge_str([r.get("population") for r in recs]),
                "culture": merge_str([r.get("culture") for r in recs]),
                "notable_features": feats,
                "threats": merge_list([r.get("threats") for r in recs]),
                "summary": summary,
                "confidence": conf,
                "radius_m": round(radius, 1),
                "radius_source": radius_src,
                "coords_source": coords_src,
                "coords_evidence": coords_ev,
                "range_evidence": range_ev,
                "sources": sorted({r["_agent"] for r in recs}),
                "source": "bing_gang",
            },
        })

    zones.sort(key=lambda z: (z["properties"]["first_appearance"] or 999, z["properties"]["name"]))

    kinds = Counter(z["properties"]["kind"] for z in zones)
    print(f"\n合併後：{len(zones)} 個區域 {dict(kinds)}")
    print(f"  座標來源：{dict(Counter(z['properties']['coords_source'] for z in zones))}")
    print(f"  範圍來源：{dict(Counter(z['properties']['radius_source'] for z in zones))}")
    unknown = [z["properties"]["name"] for z in zones if z["properties"]["coords_source"] == "unknown"]
    if unknown:
        print(f"  ⚠️ 冇座標證據（{len(unknown)}）：{'、'.join(unknown[:12])}")

    stats = {
        "n_zones": len(zones),
        "kinds": dict(sorted(kinds.items())),
        "coords_source": dict(sorted(Counter(z["properties"]["coords_source"] for z in zones).items())),
        "radius_source": dict(sorted(Counter(z["properties"]["radius_source"] for z in zones).items())),
        "unknown_coords": unknown,
    }

    if not write:
        return stats

    OUT.write_text(
        json.dumps({"type": "FeatureCollection", "features": zones}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"\n寫入 {OUT}（{OUT.stat().st_size / 1024:.0f} KiB）")
    # ⚠️ B4：**唔再**做反向連結（寫 `zone_ids`）。三層 join 由
    # `infer_zone_membership.py` 負責 —— 兩個寫手會互相覆蓋。
    return stats


def _circle(
    pts: list[tuple[float, float]], kind: str
) -> tuple[list[tuple[float, float]], dict[str, Any], float, str, str]:
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    spread = max(haversine_m((cx, cy), p) for p in pts) if pts else 0.0
    cap = min(MAX_RADIUS_M, MAX_RADIUS_BY_KIND.get(kind, MAX_RADIUS_M))
    radius = max(MIN_RADIUS_M, min(cap, max(spread * 1.3, DEFAULT_RADIUS_M.get(kind, 300.0))))
    # 用 48 邊形近似圓（比 <circle> 更易做動畫同填色）
    ring = []
    for i in range(48):
        a = 2 * math.pi * i / 48
        ring.append((
            round(cx + radius * math.cos(a) / M_PER_DEG_LON, 6),
            round(cy + radius * math.sin(a) / M_PER_DEG_LAT, 6),
        ))
    ring.append(ring[0])
    return (
        pts,
        {"type": "Polygon", "coordinates": [[list(p) for p in ring]]},
        radius,
        "default",
        f"只有 {len(pts)} 個成員點，用按類型嘅預設半徑（估算）",
    )


# =====================================================================
# 4 階段編排器（deprecated shim）
# =====================================================================

#: 階段次序**唔可以調亂**：
#:   1. 塌縮修復 —— zone 幾何由成員座標推導，一定要先散佈
#:   2. 基礎合併 —— 用已散佈座標算 zone 幾何
#:   3. 三層 join —— 用最終 zone 幾何做 point-in-polygon
#:   4. v2 遷移 —— 用最終 join 結果填 event_ids / character_ids
PHASES = (
    ("1/4 標記塌縮修復 + 座標傳播", "infer_zone_membership:collapse"),
    ("2/4 區域基礎合併（v1 基礎欄位，冇 evidence）", "base"),
    ("3/4 三層 join + coordinate_* 回填", "infer_zone_membership:join"),
    ("4/4 zone v2 遷移 + zone-dossiers.json", "build_zone_dossiers"),
)


def main() -> int:
    ap = argparse.ArgumentParser(description="區域基礎合併 + B4 4 階段編排（deprecated shim）")
    ap.add_argument("--dry-run", action="store_true", help="唔寫入任何檔")
    ap.add_argument("--base-only", action="store_true", help="只跑階段 2（除錯用）")
    args = ap.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parent))

    print("⚠️  merge_zone_dossiers.py 已 deprecated —— 佢而家係 4 階段編排器")
    print("    （塌縮修復 → 基礎合併 → 三層 join → v2 遷移 + dossier）\n")

    write = not args.dry_run

    if args.base_only:
        base_merge(write=write)
        if args.dry_run:
            print("\n（--dry-run：冇寫入）")
        return 0

    import build_zone_dossiers
    import infer_zone_membership

    # 階段 1
    print(f"[{PHASES[0][0]}]")
    collapse = infer_zone_membership.fix_marker_collapse_and_propagate(write=write)
    mc = collapse["marker_collapse"]
    print(f"  簇 {mc['n_clusters_ge_threshold']} 個 → 散佈 {mc['n_moved']} 個地點"
          f"；鎖定（inferred_from）簇 {len(mc['locked_clusters'])} 個")
    print(f"  座標傳播：{collapse['propagation']}")

    # 階段 1.5
    #
    # ⚠️ 為何一定要喺呢個位置（2026-09-24 實測踩過）
    # ------------------------------------------
    # 階段 1 嘅「標記塌縮修復」會**重寫**簇內地點嘅座標。如果由文字錨定
    # 跑喺階段 1 **之前**，修正會被靜靜覆蓋（實測：10 個錨定全部被打回
    # `legacy`）。而階段 2 係用**成員座標**推導 zone 幾何 → 所以錨定一定
    # 要喺階段 1 之後、階段 2 之前。
    print("\n[1.5/4 由故事文字錨定 location 座標]")
    import anchor_locations_from_text

    anc = anchor_locations_from_text.run(write=write, quiet=True)
    print(f"  錨定 {anc['n_fixes']} 個 location（規則 A/B/C）")

    # 階段 1.6
    #
    # ⚠️ 為何要（2026-09-24 實測踩過）
    # ----------------------------
    # `run_pipeline.py` 嘅 `propagate_location_coords.py` 跑喺本腳本**之前**，
    # 所以階段 1.5 改咗 location 座標之後，`events` / `timeline` /
    # `routes` 嘅座標仍然係**舊**嘅 → `test_route_coords_match_waypoint_locations`
    # 會紅（「路線幾何係舊嘅」）。再跑一次傳播就同步返。
    # ⚠️ 塌縮散佈本身冪等（散佈完就唔再係「完全相同座標」），所以重跑安全。
    print("\n[1.6/4 重新傳播座標（錨定之後）]")
    collapse2 = infer_zone_membership.fix_marker_collapse_and_propagate(write=write)
    print(f"  座標傳播：{collapse2['propagation']}")

    # 階段 2
    print(f"\n[{PHASES[1][0]}]")
    base_merge(write=write)

    # 階段 3
    print(f"\n[{PHASES[2][0]}]")
    join_report = infer_zone_membership.run(write=write)
    cov = join_report["zone_event_coverage"]
    lb = join_report["legacy_baseline"]
    print(f"  event→zone：{lb['zone_event_linked']}（{lb['zone_event_ratio']:.1%}）→ "
          f"{cov['after']}（{cov['after_ratio']:.1%}）  目標 85% "
          f"{'✅' if cov['target_met'] else '❌'}")

    # 階段 4
    print(f"\n[{PHASES[3][0]}]")
    st = build_zone_dossiers.run(write=write)
    print(f"  zone {st['n_zones']} → dossier {st['n_dossiers']}"
          f"（nest_profile {st['nest_profile_count']}）")
    print(f"  review_status：{st['review_status']}")

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
    else:
        print(f"\n✅ 4 階段完成；zones.geojson sha256 = {st['zones_hash']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

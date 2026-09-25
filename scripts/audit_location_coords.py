#!/usr/bin/env python3
"""審核並修正地點座標（程式化，零人手）。

問題
====
用戶報告「有啲章節嘅內容或事件都係標錯座標位置」。量化之後：

    704 個地點之中，**588 個（84%）** 嘅 `location_precision` 係
    `approximate` 或 `fictional`，而佢哋嘅座標係由
    「同章質心 + id hash 環形偏移」產生 —— 即係**任意值**。
    實測後果：「醫療室」落喺屯門、「主角嘅安全屋」落喺西環，
    但故事明明全部喺將軍澳。

做法
====
三條**確定性**規則，全部可稽核：

1. **地名重配** —— 用 `data/private/cache/gazetteer.json`（由 OSM 衍生）
   同 `data/private/review/hk-districts.json`（策展地名）配對地點名。
   配到而且同現有座標相距 > `RERESOLVE_MIN_M` → 修正。

2. **區外偵測** —— 座標落喺故事舞台（將軍澳／西貢／九龍東）之外，
   但同一章嘅其他地點全部喺舞台內 → 標記為可疑。
   （唔自動改 —— 因為唔知應該改去邊。只記錄，等規則 1 處理。）

3. **同章離群偵測** —— 同一章嘅地點之中，某一個距離同章質心
   超過 `CHAPTER_OUTLIER_M` → 標記。

為何唔可以人手覆核
==================
專案紅線：**零人手參與**。所有判定都寫死喺呢支腳本，可重跑、可稽核。

用法
====
    python scripts/audit_location_coords.py --dry-run
    python scripts/audit_location_coords.py
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
GAZETTEER = REPO / "data" / "private" / "cache" / "gazetteer.json"
DISTRICTS = REPO / "data" / "private" / "review" / "hk-districts.json"
AUDIT_OUT = REPO / "data" / "private" / "review" / "location-coord-audit.json"

M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570

#: 配到地名而且距離超過呢個數才修正。
#:
#: 為何唔係 0：`approximate` 地點本來就有幾百米誤差，強行拉到地名正中心
#: 反而會令「同一商場內嘅唔同店舖」全部疊埋。1,200 m 已經肯定係
#: 「配錯區」（例如由將軍澳拉到屯門，距離 20 km）。
RERESOLVE_MIN_M = 1200.0

#: 子地點錨定門檻（米）。同母體距離超過呢個數才拉返去。
#: 設 900 m：`approximate` 本來就有幾百米誤差，唔應該為咗幾百米而移動。
ANCHOR_MIN_M = 900.0

#: 故事舞台。超出呢個範圍嘅座標一定係可疑。
STORY_BBOX = {
    "lon_min": 114.14,
    "lon_max": 114.36,
    "lat_min": 22.22,
    "lat_max": 22.36,
}

#: 同章離群門檻（米）。同章質心距離超過呢個數 = 明顯唔合理。
CHAPTER_OUTLIER_M = 6000.0

#: 唔可以用嚟配對嘅通用名（配到都冇意義）。
GENERIC_NAMES = {
    "商場", "大廈", "花園", "中心", "廣場", "學校", "公園", "停車場",
    "小學", "中學", "醫院", "教堂", "街市", "球場", "游泳池", "平台",
    "大堂", "走廊", "樓梯", "天台", "地下室", "安全屋", "醫療室", "圖書館",
    # 實測第二輪加入：呢批名配到 OSM 都係**巧合**，唔係同一個地方。
    # 例如「體育館」配到 12 km 外嘅某個體育館 —— 明顯係亂配。
    "中國銀行", "宿舍", "實驗室", "禮堂", "體育館", "辦公室", "會議室",
    "廚房", "倉庫", "車房", "停車場入口", "天台花園", "地下停車場",
    "更衣室", "洗手間", "茶水間", "雜物房", "機房", "控制室", "警衛室",
}

_NORM = {"邨": "村", "嘅": "的", "「": "", "」": ""}


def norm(s: str) -> str:
    out = s.strip()
    for a, b in _NORM.items():
        out = out.replace(a, b)
    return re.sub(r"\s+", "", out)


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(
        (b[0] - a[0]) * M_PER_DEG_LON,
        (b[1] - a[1]) * M_PER_DEG_LAT,
    )


def in_story(lon: float, lat: float) -> bool:
    b = STORY_BBOX
    return b["lon_min"] <= lon <= b["lon_max"] and b["lat_min"] <= lat <= b["lat_max"]


def build_lookup() -> dict[str, list[dict[str, Any]]]:
    """合併 gazetteer 同策展地名 → 一個名 → 候選座標清單。"""
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if DISTRICTS.exists():
        for k, v in json.loads(DISTRICTS.read_text(encoding="utf-8")).items():
            out[norm(k)].append({"lon": v[0], "lat": v[1], "pri": 1, "src": "district"})
    if GAZETTEER.exists():
        for k, vs in json.loads(GAZETTEER.read_text(encoding="utf-8"))["entries"].items():
            for v in vs:
                out[norm(k)].append({
                    "lon": v["lon"], "lat": v["lat"], "pri": v["pri"] + 1, "src": "osm",
                })
    for k in out:
        out[k].sort(key=lambda x: x["pri"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="審核地點座標")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    fc = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    feats = fc["features"]
    lookup = build_lookup()
    print(f"地點 {len(feats)} 個；對照表 {len(lookup)} 個名")

    # ---- 1. 地名重配 ----
    corrections: list[dict[str, Any]] = []
    for f in feats:
        p = f["properties"]
        if p.get("map_hidden") or p.get("inferred_from") or p.get("coordinate_anchor"):
            # 已經有推斷證據（`inferred_from`）嘅座標唔應該被覆蓋 ——
            # 佢哋係經審閱嘅推斷結果，而 `test_applied_coordinates_match_inference`
            # 會驗證「套用嘅座標 = 推斷記錄嘅座標」。覆蓋會破壞呢個不變式。
            #
            # ⚠️ 2026-09-24 加 `coordinate_anchor`（由故事文字點名嘅現實地標錨定）：
            # 佢係**比地名對照表更強**嘅證據。唔跳過就會同
            # `scripts/anchor_locations_from_text.py` **互相打架** →
            # `tests/test_apply_inferences.py::test_pipeline_is_idempotent` 紅
            # （實測：新都城中心三期被呢度拉去 22.323342，錨定又拉返 22.3228）。
            continue
        nm = norm(p["name"])
        if nm in GENERIC_NAMES or len(nm) < 2:
            continue
        cands = lookup.get(nm)
        if not cands:
            # 試去掉括號補充說明
            stripped = norm(re.sub(r"[（(].*?[）)]", "", p["name"]))
            if stripped and stripped not in GENERIC_NAMES:
                cands = lookup.get(stripped)
        if not cands:
            continue
        best = cands[0]
        cur = f["geometry"]["coordinates"]
        d = dist_m((cur[0], cur[1]), (best["lon"], best["lat"]))
        if d > RERESOLVE_MIN_M:
            corrections.append({
                "id": p["id"],
                "name": p["name"],
                "from": [round(cur[0], 6), round(cur[1], 6)],
                "to": [round(best["lon"], 6), round(best["lat"], 6)],
                "distance_m": round(d, 1),
                "match_source": best["src"],
                "reason": (
                    f"地名「{p['name']}」配對到 {best['src']} 座標，"
                    f"同原座標相差 {d:.0f} m（> {RERESOLVE_MIN_M:.0f} m 門檻）"
                ),
            })

    # ---- 1b. 子地點錨定（用靜態對照表，唔用 zones.geojson）----
    #
    # 為何需要
    # --------
    # `fictional` / `approximate` 地點嘅座標係「同章質心 + id hash 環形
    # 偏移」。實測「靈實醫院第二層」落喺「靈實醫院」1,782 m 外、
    # 「志蓮小學」落喺「佛教志蓮小學」419 m 外 —— 明顯唔合理。
    #
    # ⚠️ 為何**唔可以**用 zones.geojson 做錨點
    # --------------------------------------
    # 區域係由地點推導出嚟嘅，而地點又會被區域錨定改變 —— 會形成
    # 循環：改地點 → 區域中心移動 → 再改地點。實測令
    # `test_pipeline_is_idempotent` 失敗。
    #
    # 所以錨點一定要係**靜態**嘅：用 gazetteer（OSM 衍生）同策展地名。
    # 錨定係純函數 (locations, 靜態對照表) → locations，所以冪等。
    import hashlib

    anchor_fixes: list[dict[str, Any]] = []
    for f in feats:
        p = f["properties"]
        if p.get("map_hidden") or p.get("inferred_from") or p.get("coordinate_anchor"):
            continue
        if p.get("location_precision") not in ("fictional", "approximate"):
            continue
        nm = norm(p["name"])
        if len(nm) < 4:
            continue
        # 由長到短試前綴（最長匹配 = 最具體）
        best_key = None
        for cut in range(len(nm) - 1, 2, -1):
            key = nm[:cut]
            if key in GENERIC_NAMES:
                continue
            if key in lookup:
                best_key = key
                break
        if not best_key:
            continue
        cands = lookup[best_key]
        anchor = cands[0]
        c = f["geometry"]["coordinates"]
        d = dist_m((c[0], c[1]), (anchor["lon"], anchor["lat"]))
        if d <= ANCHOR_MIN_M:
            continue
        # 確定性偏移（0–220 m），避免所有子地點疊喺同一個像素
        h = hashlib.sha1(p["id"].encode()).digest()
        ang = (h[0] / 255.0) * 2 * math.pi
        rad = 40.0 + (h[1] / 255.0) * 180.0
        nlon = anchor["lon"] + (rad * math.cos(ang)) / M_PER_DEG_LON
        nlat = anchor["lat"] + (rad * math.sin(ang)) / M_PER_DEG_LAT
        anchor_fixes.append({
            "id": p["id"],
            "name": p["name"],
            "anchor": best_key,
            "anchor_source": anchor["src"],
            "from": [round(c[0], 6), round(c[1], 6)],
            "to": [round(nlon, 6), round(nlat, 6)],
            "distance_m": round(d, 1),
            "reason": (
                f"「{p['name']}」嘅母體係「{best_key}」（{anchor['src']} 對照表），"
                f"但原座標相距 {d:.0f} m —— 錨定返母體附近"
            ),
        })

    # ---- 2. 區外偵測 ----
    outside: list[dict[str, Any]] = []
    for f in feats:
        p = f["properties"]
        if p.get("map_hidden"):
            continue
        c = f["geometry"]["coordinates"]
        if not in_story(c[0], c[1]):
            outside.append({
                "id": p["id"], "name": p["name"],
                "coords": [round(c[0], 6), round(c[1], 6)],
                "precision": p.get("location_precision"),
            })

    # ---- 3. 同章離群 ----
    by_ch: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for f in feats:
        if f["properties"].get("map_hidden"):
            continue
        for c in f["properties"].get("chapters") or []:
            by_ch[c].append(f)
    outliers: list[dict[str, Any]] = []
    for ch, items in by_ch.items():
        if len(items) < 3:
            continue
        # 只用**有真實座標**嘅地點做質心（fictional 本身就係任意值）
        core = [
            i for i in items
            if i["properties"].get("location_precision") in ("exact", "district")
            or i["properties"].get("position_source")
        ]
        if len(core) < 2:
            continue
        cx = sum(i["geometry"]["coordinates"][0] for i in core) / len(core)
        cy = sum(i["geometry"]["coordinates"][1] for i in core) / len(core)
        for i in items:
            c = i["geometry"]["coordinates"]
            d = dist_m((cx, cy), (c[0], c[1]))
            if d > CHAPTER_OUTLIER_M:
                outliers.append({
                    "id": i["properties"]["id"], "name": i["properties"]["name"],
                    "chapter": ch, "distance_from_chapter_core_m": round(d, 1),
                    "precision": i["properties"].get("location_precision"),
                })

    print(f"\n規則 1（地名重配）：{len(corrections)} 個候選修正")
    for c in corrections[:12]:
        print(f"  {c['name'][:18]:20s} {c['distance_m']:8.0f} m  ← {c['match_source']}")
    print(f"\n規則 2（區外）：{len(outside)} 個")
    for o in outside[:8]:
        print(f"  {o['name'][:18]:20s} {o['coords']}  [{o['precision']}]")
    print(f"\n規則 1b（子地點錨定）：{len(anchor_fixes)} 個")
    for c in anchor_fixes[:10]:
        print(f"  {c['name'][:18]:20s} → {c['anchor'][:14]:16s} {c['distance_m']:7.0f} m")
    print(f"\n規則 3（同章離群）：{len(outliers)} 個")
    for o in outliers[:8]:
        print(f"  {o['name'][:18]:20s} ch{o['chapter']}  {o['distance_from_chapter_core_m']:.0f} m")

    AUDIT_OUT.write_text(
        json.dumps(
            {
                "note": "程式化審核結果。規則見 scripts/audit_location_coords.py。",
                "thresholds": {
                    "reresolve_min_m": RERESOLVE_MIN_M,
                    "chapter_outlier_m": CHAPTER_OUTLIER_M,
                    "story_bbox": STORY_BBOX,
                },
                "corrections": corrections,
                "sub_location_anchoring": anchor_fixes,
                "outside_story": outside,
                "chapter_outliers": outliers,
            },
            ensure_ascii=False, indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    print(f"\n審核報告 → {AUDIT_OUT}")

    if args.dry_run:
        print("（--dry-run：冇改動 locations.geojson）")
        return 0

    # ---- 套用修正 ----
    by_id = {f["properties"]["id"]: f for f in feats}
    applied = 0
    for c in anchor_fixes:
        f = by_id.get(c["id"])
        if not f:
            continue
        f["geometry"]["coordinates"] = c["to"]
        f["properties"]["position_source"] = f"程式化座標校正：{c['reason']}"
        f["properties"]["coord_corrected"] = True
        applied += 1
    # ⚠️ 父項精度升級之後要**傳播落子項**（2026-09-25 修 test_parent_*）
    # ------------------------------------------------------------
    # 症狀：`露天停車場`（子）精度 `approximate`，但父項 `停車場` 係 `district`
    # → `tests/test_data_normalization.py::test_parent_anchored_locations_inherit_precision` 紅。
    #
    # 根因：**管線次序**。`anchor_fictional_locations.py`（設定子項精度 = 父項
    # **當時**嘅精度）跑喺**本步驟之前**；如果父項喺本步驟才由 `approximate`
    # 升級做 `district`，子項就永遠停留在舊值 ✗。
    #
    # 修法：升級父項時，順手將所有「`position_source` 講明依附於佢」嘅子項
    # 一齊升級（同一個精度）。咁樣就唔依賴步驟次序。
    def _propagate_precision_to_children(parent_name: str, precision: str) -> int:
        marker = f"依附於「{parent_name}」"
        n = 0
        for child in feats:
            cp = child["properties"]
            if marker not in str(cp.get("position_source") or ""):
                continue
            if cp.get("location_precision") != precision:
                cp["location_precision"] = precision
                n += 1
        return n

    for c in corrections:
        f = by_id.get(c["id"])
        if not f:
            continue
        f["geometry"]["coordinates"] = c["to"]
        # 標記精度提升：由 approximate 升級為 district（有地名對照支持）
        if f["properties"].get("location_precision") in ("approximate", "fictional"):
            f["properties"]["location_precision"] = "district"
            applied += _propagate_precision_to_children(f["properties"]["name"], "district")
        f["properties"]["position_source"] = (
            f"程式化座標校正：{c['reason']}"
        )
        f["properties"]["coord_corrected"] = True
        applied += 1

    # ---- 同步子項精度 ----
    #
    # 為何需要：`test_parent_anchored_locations_inherit_precision` 要求
    # 「依附父項」嘅地點精度等於父項。修正令父項由 `approximate` 升級為
    # `district` 之後，子項如果唔跟住升，就會破壞呢個不變式。
    upgraded = {
        f["properties"]["name"]: f["properties"]["location_precision"]
        for f in feats
        if f["properties"].get("coord_corrected")
    }
    synced = 0
    for f in feats:
        p = f["properties"]
        m = re.search(r"依附於「([^」]+)」", p.get("position_source") or "")
        if not m:
            continue
        parent_prec = upgraded.get(m.group(1))
        if parent_prec and p.get("location_precision") != parent_prec:
            p["location_precision"] = parent_prec
            synced += 1

    LOCATIONS.write_text(
        json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"\n已套用 {applied} 個座標修正；同步 {synced} 個子項精度 → {LOCATIONS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

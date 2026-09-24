#!/usr/bin/env python3
"""由故事文字錨定 location 座標（確定性、可重跑、零人手）。

問題（用戶 2026-09-24 報告）
==========================
> 「標記地方仍然有錯，例如寶林倖存區應該喺寶林，故事內容當中應該有描述
>   相關地方喺現實嘅位置或地標，好似皇室區噉應該有講過。」

實例：`皇室區` 嘅 dossier 明寫「位於**寶琳地鐵站上蓋**及商場…**皇宮即
新都城二期商場**」，但座標距離真正嘅新都城二期 **2,368 m**。

做法：**證據優先次序**（每項都記錄規則 + 信心，可稽核）
====================================================
| 規則 | 證據 | 信心 | 例 |
|---|---|---|---|
| **A** | location 嘅 **名／別名包含**恰好一個地標名 | 0.95 | 「新都城二期」→ 新都城二期 |
| **B** | location 嘅 **描述**喺「定位片語」內提到恰好一個地標 | 0.85 | 「…位於X上蓋…」 |
| **C** | zone dossier 喺「定位片語」提到恰好一個地標，**而且有同名 location** | 0.80 | 皇室區 → 皇宮即新都城二期商場 |

「定位片語」= 地標名前後 `LOCATOR_WINDOW` 字之內出現
`位於` / `設於` / `即` / `喺` / `上蓋` / `在`。
⚠️ 冇定位片語就**唔改** —— 描述提到地標唔代表**該地點就係**嗰個地標
（例如「艾寶琳倖存區」嘅 overview 提到皇室區喺新都城二期，但艾寶琳
倖存區本身唔係新都城二期）。

⚠️ 泛稱唔可以做錨（例如「燒烤區」）→ 要求錨名 ≥ `MIN_ANCHOR_LEN` 字。
⚠️ 距離 ≤ `MATCH_TOLERANCE_M` 就唔郁（已經夠準）。

寫入欄位
========
`coordinate_source = "text_landmark"`、
`coordinate_review_status = "auto_corrected"`、
`coordinate_confidence = <規則信心>`、
`coordinate_anchor = {"name": …, "coord": […], "rule": "A|B|C", "distanceM": …}`

⚠️ 改完 `data/public/locations.geojson` 之後**一定要重跑 zone 推導**
（zone 幾何係由成員 location 推導）：
    python scripts/merge_zone_dossiers.py

用法
====
    python scripts/anchor_locations_from_text.py --dry-run   # 只報告
    python scripts/anchor_locations_from_text.py --apply     # 寫入
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from audit_coordinate_text_consistency import (  # noqa: E402
    M_PER_DEG_LAT,
    M_PER_DEG_LON,
    MATCH_TOLERANCE_M,
    build_landmark_index,
    dist_m,
)

LOCATIONS = REPO / "data" / "public" / "locations.geojson"
ZONES = REPO / "data" / "public" / "zones.geojson"
DOSSIERS = REPO / "data" / "public" / "zone-dossiers.json"

#: 錨名最短長度（過濾泛稱，例如「燒烤區」）。
MIN_ANCHOR_LEN = 4

#: 「定位片語」嘅前後窗。
LOCATOR_WINDOW = 14

#: **強**定位片語 —— 只有呢三個可以做錨定證據。
#:
#: ⚠️ 為何剔除 `喺` / `在` / `上蓋`（2026-09-24 實測）：
#: 「坑口38號街」嘅描述係「與老師**喺寶康公園**病窩塔頂畫嘅地圖吻合嘅位置」
#: —— 寶康公園只係「畫地圖」嘅地點，唔係條街嘅位置。收 `喺` 就會誤錨 1,224 m。
LOCATORS = ("位於", "設於", "即")

#: Rule C 專用：`位於` 一定要喺 overview **開頭**（= 對區域本身嘅位置陳述）。
#: 「不法者監獄」嘅 overview 開頭係「位於將軍澳工業邨仁興工業大廈」✓；
#: 「艾寶琳倖存區」嘅「皇宮設於新都城二期商場」主語係**皇宮**唔係區域 ✗。
HEAD_WINDOW = 25

#: 「相鄰」用詞 —— 錨定後要記錄（錨係地標本身，地點可能只係喺隔籬）。
ADJACENT_WORDS = ("左邊", "右邊", "對面", "隔一條馬路", "附近", "旁邊", "毗鄰", "上蓋")

#: ⚠️ 環形偏移（C4 對抗驗收 2026-09-24 發現嘅回歸）
#: ------------------------------------------------
#: 第一版直接寫**地標精確座標、零偏移** → 多個 location 錨去同一個地標就會
#: **完全疊埋**（C4 實測 3 組：新都城中心三期／梁潔華小學／新都城中心三期賭場）。
#: 而 `audit_coordinate_integrity.py` 嘅 R6（重複／近重複）門檻係 **20**，
#: 得 2–3 個嘅簇**永遠捉唔到** → 即係「靜默疊埋」。
#:
#: 舊機制（`audit_location_coords.py` 規則 1b）本身有 40–220 m 偏移；
#: 本腳本沿用同一數量級，令兩個機制一致。
ANCHOR_RING_MIN_M = 40.0
ANCHOR_RING_STEP_M = 30.0
ANCHOR_RING_MAX_M = 220.0

#: 「相鄰」關係嘅偏移距離（米）—— 文字講「喺地標隔籬」，唔應該擺喺地標中心。
ADJACENT_OFFSET_M = 120.0

#: 碰撞門檻（米）—— 兩個地點相距少於呢個數就當「疊埋」。
#: ⚠️ 唔可以用精確相等：候選 `22.322799` vs 佔用 `22.3228` 相差 0.000001°
#: ≈ **0.1 m**，精確比對會當成唔撞（C4 §4.14 實測）。
COLLISION_MIN_M = 15.0


def apply_offsets(
    fixes: list[dict[str, Any]],
    index: dict[str, tuple[float, float]],
    occupied: set[tuple[float, float]] | None = None,
) -> None:
    """為錨定結果加**確定性**偏移（就地改 `fixes`）。

    規則（完全確定性，唔用隨機）
    --------------------------
    1. 按最終座標分組（同一地標 = 同一組）。
    2. 組內按 `id` 排序 → 第 i 個放喺環上：
       · `relation == "adjacent"` → 半徑固定 `ADJACENT_OFFSET_M`（120 m）
         （文字明講「喺地標隔籬」，唔應該擺喺地標中心）
       · 其餘 → 半徑 `40 + 30×i`（上限 220 m）
    3. 組內**只有 1 個** 而且 `relation == "at"` → **唔偏移**（保留精確錨定）。

    ⚠️ 一定要有偏移：唔係就會令多個 location 座標完全相同，而 R6 嘅門檻（20）
    捉唔到細簇 → 靜默疊埋。

    ⚠️ **碰撞避免**（C4 對抗驗收 2026-09-24 §2）：偏移位置可能**巧合撞正**
    另一個（推斷鎖定嘅）地點座標。實測：新都城中心三期嘅 40 m 北偏移
    （`114.256992, 22.3228`）啱啱好等於梁潔華小學嘅 `inferred_from` 鎖定值。
    所以最後要同 `occupied`（所有其他地點座標）比對，撞到就加大半徑重試
    （確定性、有上限）。
    """
    groups: dict[tuple[float, float], list[dict[str, Any]]] = {}
    for r in fixes:
        groups.setdefault((r["to"][0], r["to"][1]), []).append(r)

    for coord, members in groups.items():
        members.sort(key=lambda r: r["id"])
        n = len(members)
        for i, r in enumerate(members):
            adjacent = r.get("relation") == "adjacent"
            # ⚠️ 零偏移只可以喺**個位冇被佔用**嘅時候用。實測：`不法者監獄`
            # 錨去 `仁興工業大廈`（語義上正確 —— 監獄真係喺嗰幢樓），但嗰個
            # 座標已經有 `仁興工業大廈` 呢個 location → 會疊標記。
            if n == 1 and not adjacent and not (occupied and coord in occupied):
                r["offset_m"] = 0.0
                continue
            radius = (
                ADJACENT_OFFSET_M
                if adjacent
                else min(ANCHOR_RING_MAX_M, ANCHOR_RING_MIN_M + ANCHOR_RING_STEP_M * i)
            )
            bearing = 360.0 * i / max(n, 1)
            rad = math.radians(bearing)
            dlon = (radius * math.sin(rad)) / M_PER_DEG_LON
            dlat = (radius * math.cos(rad)) / M_PER_DEG_LAT
            # 碰撞避免：同其他地點座標比對，撞到就加大半徑（最多 6 次）
            #
            # ⚠️ 一定要用**距離門檻**而唔係精確相等（C4 對抗驗收 §4.14）：
            # 候選 `22.322799` vs 佔用 `22.3228` 相差 0.000001° ≈ **0.1 m**
            # → 精確比對當成「唔撞」→ 仍然疊標記。改用 < 15 m。
            for attempt in range(7):
                rr = radius + attempt * ANCHOR_RING_STEP_M
                dlon = (rr * math.sin(rad)) / M_PER_DEG_LON
                dlat = (rr * math.cos(rad)) / M_PER_DEG_LAT
                cand = (round(coord[0] + dlon, 6), round(coord[1] + dlat, 6))
                if not occupied or all(
                    dist_m(cand, o) >= COLLISION_MIN_M for o in occupied
                ):
                    break
            r["to"] = [cand[0], cand[1]]
            r["offset_m"] = rr
            r["offset_bearing_deg"] = round(bearing, 1)
            if occupied:
                occupied.add(cand)


def has_locator(text: str, name: str) -> bool:
    """`name` 出現嘅位置前後 `LOCATOR_WINDOW` 字之內有冇**強**定位片語。"""
    start = 0
    while True:
        i = text.find(name, start)
        if i < 0:
            return False
        lo = max(0, i - LOCATOR_WINDOW)
        hi = min(len(text), i + len(name) + LOCATOR_WINDOW)
        if any(loc in text[lo:hi] for loc in LOCATORS):
            return True
        start = i + 1


def has_zone_locator(text: str, name: str) -> bool:
    """Rule C 用：`即`（同一性斷言）**任何位置**都收；
    `位於` 只收喺 overview 開頭 `HEAD_WINDOW` 字之內（＝對區域本身嘅陳述）。"""
    start = 0
    while True:
        i = text.find(name, start)
        if i < 0:
            return False
        lo = max(0, i - LOCATOR_WINDOW)
        hi = min(len(text), i + len(name) + LOCATOR_WINDOW)
        win = text[lo:hi]
        if "即" in win:
            return True
        if "位於" in win and i <= HEAD_WINDOW:
            return True
        start = i + 1


def relation_of(text: str, name: str) -> str:
    """文字有冇講「相鄰」（錨係地標，地點只喺隔籬）。"""
    i = text.find(name)
    if i < 0:
        return "at"
    lo = max(0, i - LOCATOR_WINDOW)
    hi = min(len(text), i + len(name) + LOCATOR_WINDOW)
    return "adjacent" if any(w in text[lo:hi] for w in ADJACENT_WORDS) else "at"


def anchors_in(text: str, index: dict[str, tuple[float, float]], *, require_locator: bool) -> list[str]:
    out = []
    for name in index:
        if len(name) < MIN_ANCHOR_LEN or name not in text:
            continue
        if require_locator and not has_locator(text, name):
            continue
        out.append(name)
    # 去除被其他命中包含嘅短名（「新都城二期」vs「新都城」）
    return [n for n in out if not any(n != m and n in m for m in out)]


def run(write: bool = False, *, quiet: bool = False) -> dict[str, Any]:
    """執行錨定。回傳統計（畀 `merge_zone_dossiers.py` 編排器用）。

    ⚠️ 一定要喺 `infer_zone_membership.fix_marker_collapse_and_propagate()`
    **之後**、區域基礎合併**之前**跑 —— 階段 1 會重寫簇內地點座標，
    跑早咗就會被覆蓋（2026-09-24 實測踩過）。
    """
    log = (lambda *a: None) if quiet else print
    log("建立地標索引 …")
    index = build_landmark_index()
    log(f"地標索引：{len(index):,} 個名（錨名門檻 ≥ {MIN_ANCHOR_LEN} 字）")

    doc = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    dossiers = {
        d["zone_id"]: d
        for d in json.loads(DOSSIERS.read_text(encoding="utf-8"))["dossiers"]
    }
    zones = json.loads(ZONES.read_text(encoding="utf-8"))["features"]

    # zone 名 → 同名 location id（規則 C 用）
    by_name: dict[str, list[dict[str, Any]]] = {}
    for f in doc["features"]:
        by_name.setdefault(f["properties"]["name"], []).append(f)

    # zone 名 → dossier overview（規則 C 用）
    zone_overview: dict[str, str] = {}
    for z in zones:
        zid = z["properties"].get("id")
        nm = z["properties"].get("name") or ""
        dz = dossiers.get(zid) or {}
        zone_overview[nm] = dz.get("overview") or ""

    fixes: list[dict[str, Any]] = []
    seen: set[str] = set()

    def try_fix(f: dict[str, Any], rule: str, anchor: str, conf: float, text: str) -> None:
        p = f["properties"]
        if p["id"] in seen:
            return
        # ⚠️ 一定要跳過 `inferred_from` 非空嘅地點（2026-09-24 實測踩過）
        # ------------------------------------------------------------
        # 佢哋嘅座標被**上游推斷記錄**（`data/private/review/place-inference.jsonl`）
        # 鎖定 —— 移動會破壞 `tests/test_apply_inferences.py::
        # test_applied_coordinates_match_inference`。
        # 實例：梁潔華小學（`inferred_from = inf_loc_0376`）。
        # 同一規則已經喺 `infer_zone_membership.fix_marker_collapse()` 用咗。
        if p.get("inferred_from"):
            return
        cur = (f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1])
        target = index[anchor]
        d = dist_m(cur, target)
        if d <= MATCH_TOLERANCE_M:
            return
        seen.add(p["id"])
        fixes.append(
            {
                "id": p["id"],
                "name": p["name"],
                "rule": rule,
                "anchor": anchor,
                "confidence": conf,
                "relation": relation_of(text, anchor),
                "distanceM": round(d, 1),
                "from": [round(cur[0], 6), round(cur[1], 6)],
                "to": [round(target[0], 6), round(target[1], 6)],
            }
        )

    # ---- 規則 A：名／別名包含恰好一個錨 ----
    for f in doc["features"]:
        p = f["properties"]
        text = " ".join([p["name"]] + list(p.get("aliases") or []))
        hits = anchors_in(text, index, require_locator=False)
        if len(hits) == 1:
            try_fix(f, "A", hits[0], 0.95, text)

    # ---- 規則 B：描述喺**強**定位片語內提到恰好一個錨 ----
    for f in doc["features"]:
        p = f["properties"]
        text = p.get("description") or ""
        hits = anchors_in(text, index, require_locator=True)
        if len(hits) == 1:
            try_fix(f, "B", hits[0], 0.85, text)

    # ---- 規則 C：zone dossier（有同名 location）----
    for nm, overview in zone_overview.items():
        if not overview or nm not in by_name:
            continue
        hits = [n for n in anchors_in(overview, index, require_locator=False)
                if has_zone_locator(overview, n)]
        if len(hits) != 1:
            continue
        for f in by_name[nm]:
            try_fix(f, "C", hits[0], 0.80, overview)

    # ---- 補：已經錨定過嘅（令腳本**冪等**）----
    #
    # ⚠️ 為何要（2026-09-24）：三個規則用「距離 > 容差」做觸發條件，所以
    # **重跑時已經錨定嘅 location 唔會再入 `fixes`** → 之後加嘅偏移邏輯
    # （`apply_offsets`）永遠唔會套用到佢哋。加呢個 pass 之後，重跑會由
    # `coordinate_anchor.name` 重新取地標基準座標 → 重新計偏移 ✓ 冪等。
    for f in doc["features"]:
        p = f["properties"]
        anc = p.get("coordinate_anchor")
        if not anc or p["id"] in seen or p.get("inferred_from"):
            continue
        name = anc.get("name")
        if name not in index:
            continue
        seen.add(p["id"])
        base = index[name]
        cur = (f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1])
        fixes.append(
            {
                "id": p["id"],
                "name": p["name"],
                "rule": anc.get("rule", "A"),
                "anchor": name,
                "confidence": anc.get("confidence", 0.95),
                "relation": anc.get("relation", "at"),
                "distanceM": round(dist_m(cur, base), 1),
                "from": [round(cur[0], 6), round(cur[1], 6)],
                "to": [round(base[0], 6), round(base[1], 6)],
            }
        )

    # ⚠️ 清理：`inferred_from` 非空嘅地點**唔應該**有 `coordinate_anchor`
    # （座標由上游推斷鎖定，文字錨定對佢無效）。之前嘅 run 可能留低咗過期值。
    stale = [
        f["properties"]["id"]
        for f in doc["features"]
        if f["properties"].get("inferred_from") and f["properties"].get("coordinate_anchor")
    ]
    for f in doc["features"]:
        if f["properties"]["id"] in stale:
            f["properties"].pop("coordinate_anchor", None)
    if stale:
        log(f"清除 {len(stale)} 個過期 coordinate_anchor（inferred_from 鎖定）")

    # ⚠️ 加確定性偏移（C4 對抗驗收發現：唔加就會多個 location 座標完全疊埋）
    # `occupied` = 所有**唔喺 fixes 入面、而且唔係推斷鎖定**嘅地點座標。
    #
    # ⚠️ 為何要排除 `inferred_from` 鎖定嘅（2026-09-24 實測踩過「追逐」）
    # --------------------------------------------------------------
    # 推斷鎖定嘅座標由上游 `infer_places.py` / `apply_place_inferences.py`
    # 產生，而且**會跟隨其他地點嘅位置**（例如 `inf_loc_0376`（梁潔華小學）
    # 嘅 `inferred_lonlat` 就係「同新都城中心三期一樣」）。
    # 如果碰撞避免考慮佢哋，就會變成互相追逐：
    #   錨定推開 → 推斷跟隨 → 下次錨定再推開 → …（每次 hash 都唔同 = 唔冪等）
    # 排除之後，本腳本嘅輸出**只依賴地標本身** → 穩定、冪等 ✓。
    # （推斷鎖定簇嘅疊埋問題屬上游 DA8，唔係本腳本嘅職責。）
    moving = {r["id"] for r in fixes}
    occupied = {
        (round(f["geometry"]["coordinates"][0], 6), round(f["geometry"]["coordinates"][1], 6))
        for f in doc["features"]
        if f["properties"]["id"] not in moving and not f["properties"].get("inferred_from")
    }
    apply_offsets(fixes, index, occupied)

    log(f"=== 建議修正：{len(fixes)} 個 location ===")
    for r in sorted(fixes, key=lambda x: -x["distanceM"]):
        log(
            f"  [{r['rule']}] {r['name']:22} 偏移 {r.get('offset_m', 0.0):5.0f} m → {r['anchor']}"
            f"（信心 {r['confidence']}、{r['relation']}）"
        )
    log(f"規則分佈：{dict(Counter(r['rule'] for r in fixes))}")
    log(f"關係分佈：{dict(Counter(r['relation'] for r in fixes))}")

    if not write:
        log("（dry-run：冇寫入）")
        return {"n_fixes": len(fixes), "fixes": fixes, "written": False}

    by_id = {f["properties"]["id"]: f for f in doc["features"]}
    for r in fixes:
        f = by_id[r["id"]]
        f["geometry"]["coordinates"] = list(r["to"])
        p = f["properties"]
        p["coordinate_source"] = "text_landmark"
        p["coordinate_review_status"] = "auto_corrected"
        p["coordinate_confidence"] = r["confidence"]
        # ⚠️ 冪等：`from` / `distance_m` 係「**第一次**錨定時」嘅事實，
        # 重跑唔應該覆蓋（否則檔案 hash 每次唔同 → 唔冪等）。
        prev = p.get("coordinate_anchor") or {}
        p["coordinate_anchor"] = {
            "name": r["anchor"],
            "coord": list(r["to"]),
            "rule": r["rule"],
            "relation": r["relation"],
            "confidence": r["confidence"],
            "distance_m": prev.get("distance_m", r["distanceM"]),
            "offset_m": r.get("offset_m", 0.0),
            "offset_bearing_deg": r.get("offset_bearing_deg"),
        }
        # ⚠️ 2026-09-24（C4 對抗驗收 §4.12）：`from` 係「錨定**之前**嘅座標」。
        # 如果佢同最終座標一樣（例如第一次跑嘅時候已經喺地標附近），
        # 咁個欄位**冇任何資訊**，只會令人誤讀成「冇郁過」→ 唔寫。
        origin = prev.get("from", r["from"])
        if origin != list(r["to"]):
            p["coordinate_anchor"]["from"] = origin
    LOCATIONS.write_text(
        json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    log(f"✅ 已寫入 {LOCATIONS}（{len(fixes)} 個 location）")
    return {"n_fixes": len(fixes), "fixes": fixes, "written": True}


def main() -> int:
    ap = argparse.ArgumentParser(description="由故事文字錨定 location 座標")
    ap.add_argument("--apply", action="store_true", help="寫入 locations.geojson")
    ap.add_argument("--dry-run", action="store_true", help="只報告（預設）")
    ap.add_argument("--json", default="", help="額外寫一份 JSON 報告")
    args = ap.parse_args()

    stats = run(write=args.apply)
    if args.json:
        p = Path(args.json)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"寫入 {p}")
    if not args.apply:
        print("\n（dry-run：冇寫入。要寫入加 --apply）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

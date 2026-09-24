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

    log(f"=== 建議修正：{len(fixes)} 個 location ===")
    for r in sorted(fixes, key=lambda x: -x["distanceM"]):
        log(
            f"  [{r['rule']}] {r['name']:22} {r['distanceM']:7.0f} m → {r['anchor']}"
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
        p["coordinate_anchor"] = {
            "name": r["anchor"],
            "coord": list(r["to"]),
            "rule": r["rule"],
            "relation": r["relation"],
            "confidence": r["confidence"],
            "distance_m": r["distanceM"],
        }
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

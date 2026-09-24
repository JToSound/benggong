#!/usr/bin/env python3
"""套用人手核實嘅地點修正（`data/private/review/location-corrections.json`）。

為何需要呢個機制
================
自動推斷一定有錯。與其每次改 script，不如將人手核實嘅修正集中喺一個
**可稽核**嘅檔案：

- 每條修正都要有 `evidence`（原文引用或 OSM 依據）同 `reason`
- 修正係 **idempotent**（重跑唔會累積副作用）
- 修正記錄喺 `location-correction-applied.json`，可以追溯

支援嘅動作
==========
  `set_coord`   —— 修正座標（附 prototype 名同依據）
  `exclude`     —— 由地圖標記排除（例如比喻、整體設定）

⚠️ `exclude` 唔會刪除記錄 —— 只係加 `map_hidden: true`。資料仍然喺
   `locations.geojson` 入面（前端可以選擇顯示），因為「呢個名喺文中
   出現過」本身係有價值嘅資訊。

用法：
    python scripts/apply_location_corrections.py --dry-run
    python scripts/apply_location_corrections.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
CORRECTIONS = REPO / "data" / "private" / "review" / "location-corrections.json"
APPLIED_LOG = REPO / "data" / "private" / "review" / "location-correction-applied.json"


def main() -> int:
    ap = argparse.ArgumentParser(description="套用人手核實嘅地點修正")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not CORRECTIONS.exists():
        print(f"冇修正檔：{CORRECTIONS}")
        return 0

    spec = json.loads(CORRECTIONS.read_text(encoding="utf-8"))
    items = spec.get("corrections", [])

    fc = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    by_name: dict[str, list[dict]] = {}
    for f in fc["features"]:
        by_name.setdefault(f["properties"]["name"], []).append(f)

    applied: list[dict] = []
    problems: list[str] = []

    for c in items:
        name = c["location_name"]
        action = c["action"]
        targets = by_name.get(name, [])
        if not targets:
            problems.append(f"搵唔到地點「{name}」")
            continue

        for f in targets:
            p = f["properties"]
            if action == "set_coord":
                lon, lat = c["lonlat"]
                old = f["geometry"]["coordinates"]
                f["geometry"]["coordinates"] = [round(lon, 6), round(lat, 6)]
                # 精度升級為 approximate（有人手核實嘅原型）
                p["location_precision"] = "approximate"
                p["fictional"] = False
                p["inferred_from"] = None
                p["position_source"] = (
                    f"人手核實修正 → {c.get('prototype', '')}；{c['reason']}"
                )
                applied.append({
                    "name": name,
                    "action": action,
                    "old": old,
                    "new": [round(lon, 6), round(lat, 6)],
                    "prototype": c.get("prototype"),
                })
            elif action == "reclassify_fictional":
                # 重分類為虛構精度：交返俾 anchor_fictional_locations.py
                # 按同章錨點放置（誠實表達「位置唔確定」）
                p["location_precision"] = "fictional"
                p["fictional"] = True
                p["inferred_from"] = None
                p["position_source"] = f"重分類為虛構：{c['reason']}"
                applied.append({"name": name, "action": action})
            elif action == "exclude":
                p["map_hidden"] = True
                p["position_source"] = f"由地圖排除：{c['reason']}"
                applied.append({"name": name, "action": action})
            else:
                problems.append(f"未知動作「{action}」（{name}）")

    print(f"修正條目：{len(items)}")
    print(f"  已套用：{len(applied)}")
    for a in applied:
        label = {
            "set_coord": f"→ {a.get('prototype')}  {a.get('new')}",
            "exclude": "→ 由地圖排除",
            "reclassify_fictional": "→ 重分類為虛構（由錨定腳本定位）",
        }.get(a["action"], a["action"])
        print(f"    {a['name']} {label}")
    if problems:
        print(f"  ⚠️ 問題：{len(problems)}")
        for p in problems:
            print(f"    {p}")

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
        return 0

    LOCATIONS.write_text(
        json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    APPLIED_LOG.write_text(
        json.dumps({"applied": applied, "problems": problems}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"\n寫入 {LOCATIONS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""公開資料嘅確定性正規化（deterministic normalisation）。

為何要有獨立一支正規化腳本
==========================
有啲問題唔係「推斷」，係「資料生成次序」造成嘅 —— 佢哋唔應該用推斷
機制處理（推斷係價值判斷），亦唔應該每次改 builder 都重跑全個 pipeline
（風險高）。所以集中喺一支**確定性、可重複執行**嘅正規化步驟。

現時處理兩件事：

1. **時間線排序**
   `timeline.json` 嘅 `date_label` 寫住「按章節先後」，但實測有 **41 個
   逆序對**（例如 index 15 係 ch3、index 16 係 ch1）。因為 builder 按
   event id 次序產生，而 event id 唔一定跟章節遞增。
   前端照陣列次序顯示 → 用戶會見到時間倒流。

2. **路線精度重算**
   全部 42 條路線嘅 `precision` 都係 `fictional`，但地點推斷之後，
   有啲路線嘅 waypoint 大部分已經係真實座標。精度應該反映實況，
   否則前端會用「虛構」嘅方式處理（例如唔畫線）。

用法：
    python scripts/normalize_public_data.py --dry-run
    python scripts/normalize_public_data.py
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
LOG = REPO / "data" / "private" / "review" / "normalize-applied.json"

#: 路線精度門檻（真實 waypoint 佔比）。
#:
#: ⚠️ 只可以用 route.schema.json 允許嘅值：`reference`／`approximate`／
#: `fictional`。原本寫 `district` 會令驗證器報錯 —— 呢個係 schema 契約，
#: 唔可以自己發明新值。
#:
#: 為何門檻訂 0.6：路線嘅可信度取決於「大部分途經點係唔係真實位置」。
#: 一半以上虛構嘅路線，畫出嚟仍然係假線，唔應該標 approximate。
ROUTE_REAL_FRACTION = {"approximate": 0.6}


def sort_timeline(tl: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """按 `date_sort`（章節）排序，同章節內保持原本次序（穩定排序）。

    用 `date_sort` 而唔係 `chapter`：前者係已格式化的排序鍵
    （`ch002`），補零之後字典序等於數值序，而且係資料自己聲明嘅排序依據。

    穩定性很重要：同章節內嘅事件本身有敘事次序（由 event id 決定），
    排序唔應該打亂佢。Python 嘅 `sorted` 保證穩定。
    """
    def key(t: dict[str, Any]) -> str:
        ds = t.get("date_sort")
        if isinstance(ds, str) and ds:
            return ds
        # 冇 date_sort 就退回章節（補零令字典序 = 數值序）
        return f"ch{int(t.get('chapter') or 0):03d}"

    before = [t.get("id") for t in tl]
    out = sorted(tl, key=key)
    after = [t.get("id") for t in out]
    moved = sum(1 for a, b in zip(before, after) if a != b)
    return out, moved


def recompute_route_precision(
    routes: list[dict[str, Any]], precision_by_loc: dict[str, str]
) -> tuple[list[dict[str, Any]], Counter[str]]:
    """按真實 waypoint 佔比重算路線精度。"""
    changes: Counter[str] = Counter()
    for f in routes:
        p = f["properties"]
        wps = p.get("waypoints") or []
        if not wps:
            continue
        real = sum(
            1
            for w in wps
            if precision_by_loc.get(w.get("location_id"), "fictional") != "fictional"
        )
        frac = real / len(wps)
        new = "approximate" if frac >= ROUTE_REAL_FRACTION["approximate"] else "fictional"
        if p.get("precision") != new:
            changes[f"{p.get('precision')} → {new}"] += 1
            p["precision"] = new
        p["real_waypoint_fraction"] = round(frac, 3)
    return routes, changes


def main() -> int:
    ap = argparse.ArgumentParser(description="公開資料確定性正規化")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    report: dict[str, Any] = {}

    # ---- 1. 時間線排序 ----
    tl_path = PUBLIC / "timeline.json"
    tl = json.loads(tl_path.read_text(encoding="utf-8"))
    seq = [
        int(t["date_sort"][2:])
        for t in tl
        if isinstance(t.get("date_sort"), str) and t["date_sort"].startswith("ch")
    ]
    inversions_before = sum(1 for i in range(len(seq) - 1) if seq[i] > seq[i + 1])

    tl_sorted, moved = sort_timeline(tl)
    seq2 = [
        int(t["date_sort"][2:])
        for t in tl_sorted
        if isinstance(t.get("date_sort"), str) and t["date_sort"].startswith("ch")
    ]
    inversions_after = sum(1 for i in range(len(seq2) - 1) if seq2[i] > seq2[i + 1])

    print("=== 時間線排序 ===")
    print(f"  逆序對：{inversions_before} → {inversions_after}")
    print(f"  位置改變嘅記錄：{moved} / {len(tl)}")
    report["timeline"] = {
        "inversions_before": inversions_before,
        "inversions_after": inversions_after,
        "moved": moved,
    }

    # ---- 2. 路線精度 ----
    locs = json.loads((PUBLIC / "locations.geojson").read_text(encoding="utf-8"))
    precision_by_loc = {
        f["properties"]["id"]: f["properties"]["location_precision"]
        for f in locs["features"]
    }
    rt_path = PUBLIC / "routes.geojson"
    routes = json.loads(rt_path.read_text(encoding="utf-8"))
    routes["features"], changes = recompute_route_precision(
        routes["features"], precision_by_loc
    )

    print("\n=== 路線精度重算 ===")
    if changes:
        for k, v in changes.most_common():
            print(f"  {k}：{v} 條")
    else:
        print("  冇改動")
    after = Counter(f["properties"]["precision"] for f in routes["features"])
    print(f"  精度分佈：{dict(after)}")
    report["routes"] = {"changes": dict(changes), "precision_after": dict(after)}

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
        return 0

    tl_path.write_text(
        json.dumps(tl_sorted, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    rt_path.write_text(
        json.dumps(routes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    LOG.write_text(
        json.dumps({"applied_at": "2026-09-16", **report}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"\n寫入 {tl_path}")
    print(f"寫入 {rt_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""角色合併：把已審閱嘅合併決定套用到 characters.json。

為何要獨立一支腳本
==================
角色合併係**破壞性**操作 —— 會令一個實體消失。同地點推斷（只改座標，
可回復）唔同，所以：

1. 唔會由 `apply_place_inferences.py` 自動處理（已加測試鎖住）
2. 決定要逐條人手記錄理由（`character-merge-decisions.json`）
3. 合併之前要驗證**引用完整性** —— 事件／路線／時間線可能引用緊被
   合併嘅角色，唔更新就會出現「指向唔存在角色」嘅斷鏈
4. 合併之後要可以追溯（被合併嘅名會加入 canonical 嘅 `aliases`）

用法：
    python scripts/merge_characters.py --dry-run
    python scripts/merge_characters.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
CHARACTERS = REPO / "data" / "public" / "characters.json"
DECISIONS = REPO / "data" / "private" / "review" / "character-merge-decisions.json"
PUBLIC = REPO / "data" / "public"
LOG = REPO / "data" / "private" / "review" / "character-merge-applied.json"

#: 會引用角色名／角色 id 嘅資料集
REFERENCING = ["events.geojson", "routes.geojson", "timeline.json"]

# ⚠️ 合併邏輯係**共用**嘅（`scripts/character_merge_core.py`）——
# `build_public_dataset.py --merge-decisions` 用同一份實作。
# 兩份實作 = 兩套真相 → 分歧會靜默。
from character_merge_core import (  # noqa: E402
    build_merge_map,
    build_name_map,
    merge_records_inplace,
    propagate_references_inplace,
)


def load_decisions() -> dict[str, Any]:
    if not DECISIONS.exists():
        print(f"缺少合併決定檔：{DECISIONS}", file=sys.stderr)
        raise SystemExit(2)
    return json.loads(DECISIONS.read_text(encoding="utf-8"))


def propagate_references(
    merge_map: dict[str, str],
    name_map: dict[str, str],
    dry_run: bool,
) -> dict[str, int]:
    """更新所有引用被合併角色嘅資料集（讀檔 → 改 → 寫檔）。

    ⚠️ 真正嘅邏輯喺 `character_merge_core.propagate_references_inplace()`；
    呢度只負責 I/O。
    """
    out: dict[str, int] = {}
    for fname in REFERENCING:
        path = PUBLIC / fname
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        n = propagate_references_inplace(data, merge_map, name_map)
        if n and not dry_run:
            path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        out[fname] = n
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="合併角色（破壞性，需人手決定）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    chars = json.loads(CHARACTERS.read_text(encoding="utf-8"))
    decisions = load_decisions()
    by_id = {c["id"]: c for c in chars}

    merge_map = build_merge_map(chars, decisions)
    if not merge_map:
        print("冇任何可套用嘅合併（檢查決定檔）")
        return 0

    name_map = build_name_map(chars, merge_map)

    print("=== 合併計劃 ===")
    for sid, dst in sorted(merge_map.items(), key=lambda kv: by_id[kv[0]]["name"]):
        print(f"  {by_id[sid]['name']:18s} → {by_id[dst]['name']}")
    print(f"合計 {len(merge_map)} 個角色會被合併\n")

    # 1. 更新 canonical 嘅 aliases／章節，再移除被合併嘅記錄（⚠️ 共用核心）
    remaining = merge_records_inplace(chars, merge_map)

    # 2. 更新引用
    refs = propagate_references(merge_map, name_map, args.dry_run)
    print("=== 引用更新 ===")
    for f, n in refs.items():
        print(f"  {f}：{n} 處")

    print(f"\n角色數：{len(chars)} → {len(remaining)}")

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
        return 0

    CHARACTERS.write_text(
        json.dumps(remaining, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    LOG.write_text(
        json.dumps(
            {
                "applied_at": "2026-09-16",
                "reviewed_by": decisions.get("reviewed_by"),
                "merged_count": len(merge_map),
                "merges": [
                    {
                        "from_id": sid,
                        "from_name": by_id[sid]["name"],
                        "into_id": dst,
                        "into_name": by_id[dst]["name"],
                        "reason": next(
                            (
                                m.get("reason")
                                for m in decisions.get("merges", [])
                                if by_id[sid]["name"] in m.get("from", [])
                            ),
                            None,
                        ),
                    }
                    for sid, dst in sorted(merge_map.items())
                ],
                "references_updated": refs,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"寫入 {CHARACTERS}")
    print(f"寫入 {LOG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

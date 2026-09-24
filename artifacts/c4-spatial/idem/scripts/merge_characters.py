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


def load_decisions() -> dict[str, Any]:
    if not DECISIONS.exists():
        print(f"缺少合併決定檔：{DECISIONS}", file=sys.stderr)
        raise SystemExit(2)
    return json.loads(DECISIONS.read_text(encoding="utf-8"))


def build_merge_map(
    chars: list[dict[str, Any]], decisions: dict[str, Any]
) -> dict[str, str]:
    """回傳 {被合併角色 id: canonical 角色 id}（已做傳遞閉包）。

    為何要傳遞閉包
    --------------
    決定可能形成鏈：主角 ~ 鳥嘴、鳥嘴 ~ 敘事者。如果只做一層，
    敘事者就會漏咗。所以要一直摺到不動點。
    """
    by_name = {c["name"]: c for c in chars}
    by_id = {c["id"]: c for c in chars}
    direct: dict[str, str] = {}
    for m in decisions.get("merges", []):
        canon_name = m["into"]
        canon = by_name.get(canon_name)
        if canon is None:
            print(f"  ⚠️ 跳過：canonical「{canon_name}」唔存在")
            continue
        for src_name in m["from"]:
            src = by_name.get(src_name)
            if src is None:
                print(f"  ⚠️ 跳過：「{src_name}」唔存在")
                continue
            if src["id"] == canon["id"]:
                continue
            direct[src["id"]] = canon["id"]

    # 傳遞閉包（防止 A→B→C 只摺一層）
    resolved: dict[str, str] = {}
    for sid in direct:
        seen = {sid}
        cur = direct[sid]
        while cur in direct and cur not in seen:
            seen.add(cur)
            cur = direct[cur]
        resolved[sid] = cur
    # 唔可以有任何 id 指向自己
    for sid, dst in list(resolved.items()):
        if sid == dst:
            del resolved[sid]
    del by_id
    return resolved


def propagate_references(
    merge_map: dict[str, str],
    name_map: dict[str, str],
    dry_run: bool,
) -> dict[str, int]:
    """更新所有引用被合併角色嘅資料集。

    `name_map` 係 {被合併名: canonical 名}，用嚟改字串引用（例如
    `character_name`）。`merge_map` 用嚟改 id 引用。
    """
    out: dict[str, int] = {}
    for fname in REFERENCING:
        path = PUBLIC / fname
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        n = 0

        def walk(node: Any) -> None:
            nonlocal n
            if isinstance(node, dict):
                for k, v in list(node.items()):
                    if isinstance(v, str):
                        if k in ("character_id", "id") and v in merge_map:
                            node[k] = merge_map[v]
                            n += 1
                        elif v in name_map:
                            node[k] = name_map[v]
                            n += 1
                    elif isinstance(v, list):
                        for i, item in enumerate(v):
                            if isinstance(item, str):
                                if item in merge_map:
                                    v[i] = merge_map[item]
                                    n += 1
                                elif item in name_map:
                                    v[i] = name_map[item]
                                    n += 1
                            else:
                                walk(item)
                    else:
                        walk(v)
            elif isinstance(node, list):
                for item in node:
                    walk(item)

        walk(data)
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

    name_map: dict[str, str] = {}
    for sid, dst in merge_map.items():
        name_map[by_id[sid]["name"]] = by_id[dst]["name"]

    print("=== 合併計劃 ===")
    for sid, dst in sorted(merge_map.items(), key=lambda kv: by_id[kv[0]]["name"]):
        print(f"  {by_id[sid]['name']:18s} → {by_id[dst]['name']}")
    print(f"合計 {len(merge_map)} 個角色會被合併\n")

    # 1. 更新 canonical 嘅 aliases（保留可追溯性）
    for sid, dst in merge_map.items():
        canon = by_id[dst]
        for nm in (by_id[sid]["name"], *(by_id[sid].get("aliases") or [])):
            if nm and nm != canon["name"] and nm not in canon["aliases"]:
                canon["aliases"].append(nm)
        # 章節聯集（合併之後 canonical 應該覆蓋兩者嘅章節）
        canon["chapter_refs"] = sorted(
            set(canon.get("chapter_refs") or []) | set(by_id[sid].get("chapter_refs") or [])
        )

    # 2. 更新引用
    refs = propagate_references(merge_map, name_map, args.dry_run)
    print("=== 引用更新 ===")
    for f, n in refs.items():
        print(f"  {f}：{n} 處")

    # 3. 移除被合併嘅記錄
    remaining = [c for c in chars if c["id"] not in merge_map]
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

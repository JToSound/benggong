#!/usr/bin/env python3
"""C 項全鏈重建：可重跑嘅「重建 → 殘餘偏差」帳目。

為何要有呢個檔
==============
`characters.json` **唔可以由現時輸入完整重現** —— 呢個結論喺 Gate 2
（`docs/progress/gate-2-zero-manual-review.md` §3.2）同 C 項報告
（`c-characters-reproducibility.md` §2.3）都已經實測過，但**兩次都係一次性
人手量度**（`artifacts/gate2/gen_probe.py` 之類）→ 冇守衛。

本腳本將佢變成**可重跑、可稽核**嘅帳目：

    產生器（`--merge-decisions`：合併決定前移）→ provisional
    ↓ 逐 id 對照
    凍結 `data/public/characters.json`

並將每一條差異**歸類**：
  · `absorbed_as_alias`：個名已經喺凍結檔嘅 aliases → 即「本來就應該合併」；
  · `unexplained`：兩邊都對唔上 → 真正嘅輸入 skew。

⚠️ 殘餘（2026-10-12 第四輪實測）＝ **0 extra ＋ 1 missing**：
  · `老師`（`ent_40e6666820`）—— 現時輸入產生唔到（真輸入 skew）。

歷史（第三輪，2026-10-11）：曾經係 **4 extra ＋ 1 missing**：
  · `鳥嘴兄` / `鳥嘴先生` / `鳥嘴弟兄` / `鳥嘴老師` —— 已喺第四輪補 4 條合併
    決定閉合（根因：上游 `character_definitions` 把「鳥嘴」開成獨立群）。
  · `老師`（`ent_40e6666820`）—— 仍然係真 skew。

用法：
    python scripts/verify_characters_rebuild.py
    python scripts/verify_characters_rebuild.py --json <out.json> --fail-on-unexpected
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
FROZEN = REPO / "data" / "public" / "characters.json"
DECISIONS = REPO / "data" / "private" / "review" / "character-merge-decisions.json"

#: 已量測、已解釋嘅殘餘（**唯一真相來源**：`tests/test_characters_full_rebuild.py` 讀呢度）。
#:
#: ⚠️ 2026-10-12 第四輪更新：補咗 4 條「鳥嘴」系列合併決定之後，
#: extra 由 4 條 → **0 條**。原本 4 條嘅根因唔係輸入 skew，而係上游
#: `manual-resolutions.json` 嘅 `character_definitions`（Phase E v17 FINAL）
#: 把「鳥嘴」開成獨立互斥群（同「主角」群零交集）→ 重建時變獨立 canonical。
#: 診斷：`scripts/diagnose_merge_groups.py`（可重跑）。
EXPECTED_EXTRA: dict[str, str] = {}
EXPECTED_MISSING: dict[str, str] = {
    "ent_40e6666820": "「老師」—— 現時輸入產生唔到（真輸入 skew；與「鳥嘴」系列無關）",
}


def _id_hash(ids: set[str]) -> str:
    return hashlib.sha256("\n".join(sorted(ids)).encode("utf-8")).hexdigest()


def rebuild(
    out_dir: Path, review_dir: Path, decisions: Path | None
) -> tuple[list[dict[str, Any]], str]:
    """跑一次產生器（沙盒目錄）→ 回傳 (characters, 產生器輸出 tail)。"""
    import build_public_dataset as bpd  # noqa: PLC0415（要 scripts/ 喺 sys.path）

    argv = [
        "--force",
        "--out-dir",
        str(out_dir),
        "--private-review-dir",
        str(review_dir),
    ]
    if decisions is not None:
        argv += ["--merge-decisions", str(decisions)]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = bpd.main(argv)
    if rc != 0:
        raise SystemExit(f"產生器 exit {rc}")
    chars = json.loads((out_dir / "characters.json").read_text(encoding="utf-8"))
    return chars, "\n".join(buf.getvalue().splitlines()[-4:])


def build_ledger(rebuilt: list[dict[str, Any]], frozen: list[dict[str, Any]]) -> dict[str, Any]:
    """逐 id 對照，並將差異歸類。"""
    r_ids = {c["id"] for c in rebuilt}
    f_ids = {c["id"] for c in frozen}
    r_names = {c["id"]: c["name"] for c in rebuilt}
    f_names = {c["id"]: c["name"] for c in frozen}
    f_aliases = {a for c in frozen for a in (c.get("aliases") or [])}

    extra = sorted(r_ids - f_ids, key=lambda i: r_names[i])
    missing = sorted(f_ids - r_ids, key=lambda i: f_names[i])
    return {
        "rebuilt_count": len(rebuilt),
        "frozen_count": len(frozen),
        "rebuilt_id_hash": _id_hash(r_ids),
        "frozen_id_hash": _id_hash(f_ids),
        "id_sets_equal": r_ids == f_ids,
        "extra": [
            {
                "id": i,
                "name": r_names[i],
                "absorbed_as_alias": r_names[i] in f_aliases,
                "expected": r_names[i] in EXPECTED_EXTRA,
            }
            for i in extra
        ],
        "missing": [
            {"id": i, "name": f_names[i], "expected": i in EXPECTED_MISSING} for i in missing
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="characters.json 全鏈重建帳目")
    ap.add_argument("--json", help="將帳目寫入呢個檔案")
    ap.add_argument(
        "--fail-on-unexpected",
        action="store_true",
        help="如果殘餘同已記錄嘅 baseline 唔一致就 exit 1",
    )
    ap.add_argument("--no-merge", action="store_true", help="唔套用合併決定（對照用）")
    args = ap.parse_args()

    frozen = json.loads(FROZEN.read_text(encoding="utf-8"))
    use_merge = not args.no_merge and DECISIONS.exists()

    print("=== characters.json 全鏈重建帳目 ===")
    print(f"  凍結：{len(frozen)} 條（id_hash {_id_hash({c['id'] for c in frozen})[:16]}）")
    if not use_merge:
        print("  ⚠️ 冇套用合併決定（決定檔唔存在或者 --no-merge）")

    with tempfile.TemporaryDirectory(prefix="bg-rebuild-") as td:
        tmp = Path(td)
        rebuilt, tail = rebuild(
            tmp / "public", tmp / "review", DECISIONS if use_merge else None
        )

    led = build_ledger(rebuilt, frozen)
    led["merge_decisions_applied"] = use_merge
    led["generator_tail"] = tail

    print(f"  重建：{led['rebuilt_count']} 條（id_hash {led['rebuilt_id_hash'][:16]}）")
    print(f"  id 集合相同：{led['id_sets_equal']}")
    print(f"  extra（重建有、凍結冇）：{len(led['extra'])}")
    for e in led["extra"]:
        mark = "（已併入 aliases）" if e["absorbed_as_alias"] else "（⚠️ 完全對唔上）"
        exp = "✓ 已記錄" if e["expected"] else "❌ 未記錄"
        print(f"    · {e['name']:10s} {mark} {exp}")
    print(f"  missing（凍結有、重建冇）：{len(led['missing'])}")
    for m in led["missing"]:
        exp = "✓ 已記錄" if m["expected"] else "❌ 未記錄"
        print(f"    · {m['name']:10s} {exp}")

    unexpected = [e["name"] for e in led["extra"] if not e["expected"]]
    unexpected += [m["name"] for m in led["missing"] if not m["expected"]]
    led["unexpected"] = unexpected

    if args.json:
        Path(args.json).write_text(
            json.dumps(led, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        print(f"\n帳目：{args.json}")

    if args.fail_on_unexpected and unexpected:
        print(f"\n❌ 有未記錄嘅殘餘：{unexpected}", file=sys.stderr)
        return 1
    print("\n✅ 殘餘全部已記錄（byte-level 重建仍然唔可能 —— 見報告 §已知限制）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

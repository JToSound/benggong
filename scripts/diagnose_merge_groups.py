#!/usr/bin/env python3
"""角色合併「群一致性」診斷 —— 將 C 項殘餘嘅**根因**變成可重跑檢查。

為何要有呢個檔
==============
`verify_characters_rebuild.py`（C 項）只答一條問題：
「重建出嚟嘅 id 集合同凍結檔差幾多？」—— 佢**唔答「為咩差」**。

實際調查（2026-10-12）發現：`鳥嘴兄`／`鳥嘴先生`／`鳥嘴弟兄`／`鳥嘴老師`
之所以喺「已合併」重建中仍然係獨立記錄，**唔係**輸入 skew，而係上游
私有決定檔嘅**內部結構**造成：

    1. `manual-resolutions.json` → `character_definitions`（Phase E v17 FINAL）
       將「鳥嘴」開成一個**獨立互斥群**（含 鳥嘴兄／鳥嘴先生／鳥嘴弟兄／
       鳥嘴老師／黑袍嘅人），同「主角」群**零交集**；
    2. `manual-resolutions.json` → `merge_routes` 嘅 `主角.from_aliases`
       只列咗**帶括號**嘅形式（`M（鳥嘴兄）`／`M（鳥嘴先生）`／`M（鳥嘴老師）`）；
    3. `apply_parenthetical_merge()` 喺兩者**之前**已經把括號拆走 →
       `M（鳥嘴兄）` 變成 `name=M` ＋ `alias=鳥嘴兄` → 第 2 步嗰個字串**永遠對唔上**；
    4. 結果：以 `鳥嘴兄` 為 `name` 嘅 row 原封不動 → `resolve_characters()`
       按 alias 交集分組 → 分離出獨立 canonical。

呢條鏈**唔可以只靠讀 code 就信** —— 所以要一個可重跑嘅腳本去證實同鎖住：

    · 群互斥性：`character_definitions` 各群兩兩交集必須為空；
    · 群鍵入群：每個定義群嘅 **key** 唔可以出現喺**另一個**群嘅 alias 入面
      （即「一個名同時做群名同別人嘅別名」= 定義矛盾）；
    · 殘餘歸屬：每一條殘餘名都要指得出「佢屬邊個定義群」；
    · 可閉合性：每一條「屬 A 群但應該併入 B 群」嘅名，都要喺
      `character-merge-decisions.json` 有對應決定（否則就係**未閉合**）。

⚠️ 本腳本**唯讀** —— 唔改任何 `data/` 檔案。佢只係把「為咩差」量化。

用法：
    python scripts/diagnose_merge_groups.py
    python scripts/diagnose_merge_groups.py --json artifacts/merge-group-diag.json
    python scripts/diagnose_merge_groups.py --fail-on-inconsistent
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
REVIEW = REPO / "data" / "private" / "review"
MANUAL = REVIEW / "manual-resolutions.json"
DECISIONS = REVIEW / "character-merge-decisions.json"
FROZEN = REPO / "data" / "public" / "characters.json"

#: 已知、已解釋嘅殘餘（同 `verify_characters_rebuild.py` 同步）。
#: ⚠️ 呢度**唔**重複定義 —— 由 `verify_characters_rebuild` 匯入，確保單一真相。
sys.path.insert(0, str(REPO / "scripts"))


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s).strip()


def extract_definition_groups(manual: dict) -> dict[str, set[str]]:
    """由 `manual-resolutions.json` 抽 `character_definitions` 群（key → alias 集）。"""
    groups: dict[str, set[str]] = {}
    for d in manual.get("decisions", []):
        if d.get("action") != "character_definitions":
            continue
        for name, defn in d.get("definitions", {}).items():
            if isinstance(defn, list):
                members = {_norm(x) for x in defn}
            else:
                members = {_norm(x) for x in defn.get("aliases", [])}
            members.add(_norm(name))
            groups[_norm(name)] = members
    return groups


def extract_merge_routes(manual: dict) -> dict[str, set[str]]:
    """由 `manual-resolutions.json` 抽 `merge_routes` 群（target → from_aliases 集）。"""
    out: dict[str, set[str]] = {}
    for d in manual.get("decisions", []):
        if d.get("action") != "merge_routes":
            continue
        for m in d.get("merges", []):
            out.setdefault(_norm(m["into"]), set()).update(
                _norm(x) for x in m.get("from_aliases", [])
            )
    return out


def extract_decisions_merges(doc: dict) -> dict[str, set[str]]:
    """由 `character-merge-decisions.json` 抽合併決定（into → from 集）。"""
    out: dict[str, set[str]] = {}
    for m in doc.get("merges", []):
        out.setdefault(_norm(m["into"]), set()).update(_norm(x) for x in m.get("from", []))
    return out


def check_group_disjoint(groups: dict[str, set[str]]) -> list[dict[str, Any]]:
    """檢查定義群兩兩交集（應該全部為空）。"""
    problems = []
    keys = sorted(groups)
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            inter = groups[a] & groups[b]
            if inter:
                problems.append(
                    {"kind": "group_overlap", "a": a, "b": b, "shared": sorted(inter)}
                )
    return problems


def check_key_captured_by_other_group(groups: dict[str, set[str]]) -> list[dict[str, Any]]:
    """檢查「群 key 出現喺另一個群嘅 alias」= 定義自相矛盾。

    例：若「鳥嘴」係一個群 key，但「主角」群嘅 alias 又含「鳥嘴」，
    咁 union-find 就會把兩群合埋 —— 即定義檔內部矛盾。

    ⚠️ 呢個檢查係**雙向**嘅：key 喺「任何其他群」出現都算。
    """
    problems = []
    for k, members in groups.items():
        for other, other_members in groups.items():
            if other == k:
                continue
            if k in other_members:
                problems.append({"kind": "key_captured", "key": k, "captured_by": other})
    return problems


def attribute_residual(
    residual_names: list[str],
    groups: dict[str, set[str]],
    merges: dict[str, set[str]],
) -> list[dict[str, Any]]:
    """為每條殘餘名指出：佢屬邊個定義群、有冇決定去合併佢。"""
    out = []
    for nm in residual_names:
        owner_groups = sorted(g for g, mem in groups.items() if nm in mem)
        merge_froms = sorted(t for t, srcs in merges.items() if nm in srcs)
        out.append(
            {
                "name": nm,
                "definition_groups": owner_groups,
                "merge_decisions_into": merge_froms,
                "closable_by_decision": bool(merge_froms),
            }
        )
    return out


def diagnose() -> dict[str, Any]:
    manual = _load(MANUAL)
    decisions = _load(DECISIONS)
    frozen = _load(FROZEN)

    groups = extract_definition_groups(manual)
    routes = extract_merge_routes(manual)
    merges = extract_decisions_merges(decisions)

    f_names = {c["name"] for c in frozen}

    # 「殘餘」= **實際重建**（已套合併）後，id 集合同凍結檔對唔上嘅名。
    #
    # ⚠️ 為何唔可以用「定義群 key 唔喺凍結檔」做啟發式：咁會誤把
    # `Sona`／`大BOSS`／`馬姑娘` 當成殘餘 —— 佢哋嘅定義群 key 雖然唔喺
    # 凍結檔（凍結檔用嘅係已合併嘅別名），但重建時佢哋**已經**被
    # `merge_routes` 摺走，根本唔會剩做獨立記錄（2026-10-12 實測）。
    # 唯一可靠嘅來源係**跑一次重建**再取差集。
    from verify_characters_rebuild import rebuild as _rebuild  # noqa: PLC0415

    import tempfile  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="bg-merge-diag-") as td:
        tmp = Path(td)
        rebuilt, _tail = _rebuild(tmp / "public", tmp / "review", DECISIONS)
    r_names = {c["name"] for c in rebuilt}
    residual_names = sorted(r_names - f_names)

    report: dict[str, Any] = {
        "definition_groups": {k: sorted(v) for k, v in sorted(groups.items())},
        "definition_group_count": len(groups),
        "merge_routes_targets": {k: len(v) for k, v in sorted(routes.items())},
        "decisions_merge_count": sum(len(v) for v in merges.values()),
        "decisions_targets": {k: sorted(v) for k, v in sorted(merges.items())},
        "frozen_count": len(frozen),
        "rebuilt_count": len(rebuilt),
        "group_overlaps": check_group_disjoint(groups),
        "key_captured": check_key_captured_by_other_group(groups),
        "residual_names": residual_names,
    }

    report["residual_attribution"] = attribute_residual(residual_names, groups, merges)
    report["unclosed_names"] = sorted(
        r["name"] for r in report["residual_attribution"] if not r["closable_by_decision"]
    )
    # 「一致」= **群結構**冇矛盾（互斥、群鍵唔被其他群收納）。
    # ⚠️ 刻意**唔**把 `unclosed_names` 計入 —— 冇決定可閉合嘅殘餘係
    # 「真正嘅輸入 skew」，係**已知限制**，唔係「結構矛盾」。
    report["consistent"] = not report["group_overlaps"] and not report["key_captured"]
    report["all_residual_closable"] = not report["unclosed_names"]
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description="角色合併群一致性診斷（唯讀）")
    ap.add_argument("--json", help="將報告寫入呢個檔案")
    ap.add_argument(
        "--fail-on-inconsistent",
        action="store_true",
        help="群互斥／群鍵衝突就 exit 1（真 skew 唔算）",
    )
    args = ap.parse_args()

    if not MANUAL.exists() or not DECISIONS.exists():
        print("⚠️ 缺私有決定檔（data/private/review/）—— 喺 CI 屬預期，exit 0")
        return 0

    rep = diagnose()

    print("=== 角色合併群一致性診斷 ===")
    print(f"  character_definitions 群數：{rep['definition_group_count']}")
    print(f"  merge_routes 群數：{len(rep['merge_routes_targets'])}")
    print(f"  合併決定 from 總數：{rep['decisions_merge_count']}")
    print(f"  凍結 {rep['frozen_count']} 條；重建 {rep['rebuilt_count']} 條")
    print()

    print(f"  群兩兩交集（應該 0）：{len(rep['group_overlaps'])}")
    for o in rep["group_overlaps"]:
        print(f"    ❌ {o['a']} ∩ {o['b']} = {o['shared']}")

    print(f"  群鍵被其他群收納（應該 0）：{len(rep['key_captured'])}")
    for k in rep["key_captured"]:
        print(f"    ❌ 「{k['key']}」被「{k['captured_by']}」收納")

    print()
    print(f"  重建殘餘名（重建有、凍結名冇）：{len(rep['residual_names'])}")
    for r in rep["residual_attribution"]:
        mark = "✅ 有決定" if r["closable_by_decision"] else "⚠️ 冇決定（真 skew）"
        grp = "／".join(r["definition_groups"]) or "（唔屬任何定義群）"
        into = "、".join(r["merge_decisions_into"]) or "—"
        print(f"    · {r['name']:10s} 群={grp:14s} → {into:12s} {mark}")

    print()
    if rep["unclosed_names"]:
        print(f"  ⚠️ 冇決定可閉合（＝真正嘅輸入 skew）：{rep['unclosed_names']}")
    else:
        print("  ✅ 所有殘餘名都有對應合併決定（殘餘可閉合）")

    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n報告：{out}")

    if args.fail_on_inconsistent:
        if not rep["consistent"]:
            print("\n❌ 群一致性檢查失敗", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""D 階段 2 工具：按清單**精確**移除／保留 CSS `!important`（可重現）。

為何要精確（唔可以用 `sed 's/!important//'`）
============================================
`legacy-migrated.css` 嘅 `!important` 係舊檔**原文**，唔可以動；
`@media (prefers-reduced-motion: reduce)` 之下嘅 `!important` 係**正當**用法
（要蓋過任意 transition）。盲目全域取代會兩者都破壞。

本工具用同 `audit_css_important.py` 一樣嘅註解感知解析器，只改
**指定 key** 嘅宣告，而且係按字元 offset 改 `!important` token（唔會影響
同一行其他內容）。

用法：
    # 全部候選都移除（做實驗）
    python scripts/apply_css_important.py --inventory <inv.json> --keep none

    # 只保留指定 key（還原必要嘅）
    python scripts/apply_css_important.py --inventory <inv.json> --keep keep.json

    # 還原全部（由 git 拎返）
    git checkout -- src/styles/mobile.css src/styles/layout.css
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STYLES = REPO / "src" / "styles"
IMPORTANT_RE = re.compile(r"\s*!important", re.IGNORECASE)


def scan(path: Path) -> list[dict]:
    """回傳每個 `!important` 宣告：key / 字元 offset / 長度。

    ⚠️ offset 係喺**原文**（未去註解）上嘅位置 —— 所以去註解要保留長度。
    """
    raw = path.read_text(encoding="utf-8")
    # 去註解但**保留長度**（用等長空白取代），令 offset 同原文一致
    def blank(m: re.Match[str]) -> str:
        return re.sub(r"[^\n]", " ", m.group(0))
    text = re.sub(r"/\*[\s\S]*?\*/", blank, raw)

    out: list[dict] = []
    stack: list[dict] = []
    decl_start = 0
    line = 1
    rule_line = 1
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\n":
            line += 1
        if ch == "{":
            head = text[decl_start:i].strip()
            if head.startswith("@"):
                stack.append({"kind": "at", "head": head})
            else:
                stack.append({"kind": "rule", "selector": head, "line": rule_line})
            decl_start = i + 1
            rule_line = line
            i += 1
            continue
        if ch == "}":
            if stack:
                stack.pop()
            decl_start = i + 1
            i += 1
            continue
        if ch == ";":
            decl = text[decl_start:i]
            if stack and stack[-1]["kind"] == "rule":
                m = IMPORTANT_RE.search(decl)
                pm = re.match(r"\s*([a-zA-Z-]+)\s*:", decl)
                if m and pm:
                    prop = pm.group(1).strip().lower()
                    out.append({
                        "key": f"{path.name}:{stack[-1]['line']}:{prop}",
                        "file": path.name,
                        "line": stack[-1]["line"],
                        "selector": stack[-1]["selector"],
                        "media": " ".join(s["head"] for s in stack if s["kind"] == "at"),
                        "property": prop,
                        # offset 落喺原文：decl_start + decl 內嘅位置
                        "offset": decl_start + m.start(),
                        "length": m.end() - m.start(),
                        "text": decl.strip()[:60],
                    })
            decl_start = i + 1
            i += 1
            continue
        i += 1
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="按清單移除／保留 CSS !important")
    ap.add_argument("--inventory", required=True)
    ap.add_argument("--keep", default="none", help="'none'／'all'／一個 JSON 檔（key 陣列）")
    args = ap.parse_args()

    inv = json.loads(Path(args.inventory).read_text(encoding="utf-8"))
    keys = [c["key"] for c in inv["candidates"]]

    if args.keep == "none":
        keep: set[str] = set()
    elif args.keep == "all":
        keep = set(keys)
    else:
        keep = set(json.loads(Path(args.keep).read_text(encoding="utf-8")))

    by_file: dict[str, list[dict]] = {}
    for path in sorted(STYLES.glob("*.css")):
        found = scan(path)
        if found:
            by_file[path.name] = found

    total_removed = 0
    total_kept = 0
    for name, decls in by_file.items():
        path = STYLES / name
        raw = path.read_text(encoding="utf-8")
        # 由後往前改，offset 唔會飄
        edits = []
        for d in decls:
            key = d["key"]
            # ⚠️ key 只對「候選」有意義；非候選（reduced-motion / legacy）一律保留
            if key in keys:
                if key in keep:
                    total_kept += 1
                    continue
                edits.append(d)
                total_removed += 1
        # ⚠️ 冇改動就**唔好寫檔**（寫檔會改 mtime → git 誤報 modified）
        if not edits:
            print(f"  {name}: 移除 0 條（未寫檔）")
            continue
        for d in sorted(edits, key=lambda x: -x["offset"]):
            raw = raw[: d["offset"]] + raw[d["offset"] + d["length"]:]
        path.write_text(raw, encoding="utf-8")
        print(f"  {name}: 移除 {len(edits)} 條")

    print(f"\n合計移除 {total_removed} 條、保留（候選中）{total_kept} 條")
    print("⚠️ 非候選（legacy-migrated / reduced-motion）一律未動。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

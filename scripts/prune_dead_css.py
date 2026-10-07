#!/usr/bin/env python3
"""D 階段 4 工具：由 CSS 精確剪除「死 class」嘅規則。

安全判準（保守）
================
一條規則**只有喺全部選擇器都含至少一個死 class** 嘅時候才刪。

  · `.bg-search-results li { … }` → 唯一選擇器含死 class → **刪** ✓
  · `.dead-x, .alive-y { … }`    → 第二個選擇器冇死 class → **唔刪** ✗（保守）

⚠️ 唔會碰 `@keyframes` 等非 style rule；`@media` 會遞歸處理。

用法：
    python scripts/prune_dead_css.py --analysis <dead-css-final2.json> [--apply]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TARGET = REPO / "src" / "styles" / "legacy-migrated.css"


def find_rules(css: str) -> list[dict]:
    """回傳所有 style rule：{start, end, selector, depth}（字元 offset）。"""
    rules: list[dict] = []
    stack: list[int] = []  # 每個 '{' 嘅位置
    i = 0
    n = len(css)
    while i < n:
        ch = css[i]
        if ch == "{":
            # 由上一個 '}' 或 '{' 之後到呢度係 selector
            start = stack[-1] + 1 if stack else 0
            seg = css[start:i]
            # 由後往前搵最後一個 '}' 或 ';' 做真正起點
            cut = max(seg.rfind("}"), seg.rfind(";"))
            sel_start = start + cut + 1
            selector = css[sel_start:i].strip()
            stack.append(i)
            # 用一個哨兵記錄「呢一層嘅 selector 起點」
            rules.append({"sel_start": sel_start, "open": i, "selector": selector, "depth": len(stack)})
        elif ch == "}":
            if stack:
                open_at = stack.pop()
                # 由後往前搵最近一條未配對嘅 rule
                for r in reversed(rules):
                    if r["open"] == open_at:
                        r["close"] = i
                        break
        i += 1
    return rules


def main() -> int:
    ap = argparse.ArgumentParser(description="剪除死 class 規則")
    ap.add_argument("--analysis", required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    data = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    dead = set(data["summary"]["dead"])
    print(f"死 class：{len(dead)} 個")

    css = TARGET.read_text(encoding="utf-8")
    rules = find_rules(css)
    # 只理有 close 嘅（完整 rule）
    rules = [r for r in rules if "close" in r and r["selector"] and not r["selector"].startswith("@")]

    # 最深層先（避免 offset 重疊）→ 由後往前刪
    victims = []
    for r in rules:
        sels = [s.strip() for s in r["selector"].split(",") if s.strip()]
        if not sels:
            continue
        # 全部選擇器都要含至少一個死 class
        ok = True
        for s in sels:
            classes = set(re.findall(r"\.([A-Za-z_][\w-]*)", s))
            if not (classes & dead):
                ok = False
                break
        if ok:
            victims.append(r)

    victims.sort(key=lambda r: -r["open"])
    print(f"要刪嘅規則：{len(victims)} 條")
    for r in victims[:8]:
        print(f"    {r['selector'][:70].replace(chr(10), ' ')}")

    if not args.apply:
        print("\n（dry-run；加 --apply 才真刪）")
        return 0

    out = css
    for r in victims:
        # 連同前置空白／註解行一齊刪（保留換行數，方便 diff）
        start = r["sel_start"]
        # 由 start 往前食走空白
        while start > 0 and out[start - 1] in " \t":
            start -= 1
        end = r["close"] + 1
        while end < len(out) and out[end] in " \t":
            end += 1
        if end < len(out) and out[end] == "\n":
            end += 1
        out = out[:start] + out[end:]

    TARGET.write_text(out, encoding="utf-8")
    print(f"\n✅ 已寫入 {TARGET}")
    print(f"   {len(css):,} → {len(out):,} 字元（−{len(css) - len(out):,}，{100 * (len(css) - len(out)) / len(css):.1f}%）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

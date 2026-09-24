#!/usr/bin/env python3
"""D 舊 CSS 遷移（階段 1）：抽取 80 個「風險 class」嘅規則到 V2 層。

背景
====
Gate 2 分析（`artifacts/gate2/analyze-legacy-css.py`）證實：spec §6.1 要求刪除嘅
舊 CSS **唔係死碼** —— 有 **80 個 class 仍然被 `src/` 引用但 V2 CSS 冇定義**。
刪咗佢哋會壞（例：`.skip-link`（B8 P0-2）、`.basemap-layer`（Phase L 向量底圖）、
`.zd-*`（Zone Dossier 面板））。

用戶裁決：**(a) 遷移 80 個 class**。

本腳本做嘅事（**只加不減**，可逆）
================================
1. 由 Gate 2 分析輸出取得 80 個風險 class（**唔重新發明**規則）。
2. 掃 `main.css` / `hud.css` / `timeline.css`，抽取**選擇器提到任何目標 class**
   嘅規則（**原文照搬**，唔改寫 —— 避免引入語意差異）。
   · 保留 `@media` / `@supports` 巢狀上下文
   · 保留原本次序（同一個檔案內）
3. 寫 `src/styles/legacy-migrated.css`。
4. 報告：邊啲 class 抽到規則、邊啲冇（冇 = 真死碼，可以唔搬）。

⚠️ 本階段**唔刪**任何舊檔 —— 新增嘅檔案 import 喺舊檔**之後**，所以
「後載入者勝」會令行為同遷移前一致（同名同特異度之下）。

用法
====
    python scripts/migrate_legacy_css.py --dry-run
    python scripts/migrate_legacy_css.py --apply
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STYLES = REPO / "src" / "styles"
LEGACY = ("main.css", "hud.css", "timeline.css")
OUT = STYLES / "legacy-migrated.css"
ANALYZER = REPO / "artifacts" / "gate2" / "analyze-legacy-css.py"

#: 由分析輸出嘅「② 風險點清單」段落抽 class 名。
RISK_HEAD = "【② 風險點清單"
CLASS_RE = re.compile(r"^\s*\.([A-Za-z0-9_-]+)\s+←")


def risk_classes() -> list[str]:
    """由 Gate 2 分析器即時取得風險 class（唔硬編碼）。"""
    out = subprocess.run(
        [sys.executable, str(ANALYZER)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    ).stdout
    lines = out.splitlines()
    start = next((i for i, l in enumerate(lines) if RISK_HEAD in l), None)
    if start is None:
        raise SystemExit("搵唔到『② 風險點清單』段落 —— 分析器輸出格式改咗？")
    found: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("===") or line.startswith("【"):
            break
        m = CLASS_RE.match(line)
        if m:
            found.append(m.group(1))
        elif line.strip().startswith("…"):
            raise SystemExit("分析器輸出被截斷（有『…（其餘 N 個）』）—— 要令佢完整輸出")
    return sorted(set(found))


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def extract_rules(text: str, targets: set[str]) -> tuple[list[str], set[str]]:
    """抽取選擇器提到任何 target class 嘅規則（連 `@media` 上下文）。

    回傳 `(規則字串清單, 命中嘅 class 集合)`。
    """
    src = strip_comments(text)
    out: list[str] = []
    hit: set[str] = set()
    i = 0
    n = len(src)
    # 用 stack 追蹤 at-rule 前綴（@media 等）
    stack: list[str] = []
    while i < n:
        # 跳過空白
        while i < n and src[i].isspace():
            i += 1
        if i >= n:
            break
        # 讀到下一個 { 或 ;
        j = i
        depth = 0
        while j < n and not (src[j] in "{;" and depth == 0):
            if src[j] == "(":
                depth += 1
            elif src[j] == ")":
                depth -= 1
            j += 1
        if j >= n:
            break
        head = src[i:j].strip()
        if src[j] == ";":
            # @import / @charset 之類 —— 唔搬
            i = j + 1
            continue
        # head 之後係 block：搵配對嘅 }
        k = j + 1
        d = 1
        while k < n and d > 0:
            if src[k] == "{":
                d += 1
            elif src[k] == "}":
                d -= 1
            k += 1
        body = src[j + 1 : k - 1]
        if head.startswith("@"):
            # at-rule 容器 → 遞歸處理內容，保留上下文
            stack.append(head)
            inner_rules, inner_hit = extract_rules(body, targets)
            hit |= inner_hit
            if inner_rules:
                indent = "  "
                joined = "\n".join(indent + r.replace("\n", "\n" + indent) for r in inner_rules)
                out.append(f"{head} {{\n{joined}\n}}")
            stack.pop()
        else:
            classes = set(re.findall(r"\.([A-Za-z0-9_-]+)", head))
            matched = classes & targets
            if matched:
                hit |= matched
                out.append(f"{head} {{ {body.strip()} }}")
        i = k
    return out, hit


def main() -> int:
    ap = argparse.ArgumentParser(description="D 舊 CSS 遷移（階段 1：抽取）")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    targets = set(risk_classes())
    print(f"Gate 2 風險 class：{len(targets)} 個\n")

    chunks: list[str] = []
    all_hit: set[str] = set()
    for name in LEGACY:
        p = STYLES / name
        if not p.exists():
            print(f"  ⚠️ 搵唔到 {name}（可能已經刪咗）")
            continue
        rules, hit = extract_rules(p.read_text(encoding="utf-8"), targets)
        print(f"  {name:14} 抽到 {len(rules):4} 條規則，覆蓋 {len(hit):3} 個風險 class")
        all_hit |= hit
        if rules:
            chunks.append(f"/* ══ 由 {name} 遷移 ══ */\n" + "\n\n".join(rules))

    missing = sorted(targets - all_hit)
    print(f"\n總覆蓋：{len(all_hit)} / {len(targets)} 個風險 class")
    if missing:
        print(f"⚠️ 冇抽到規則（可能係真死碼，或者由變數拼成）：{missing}")

    header = (
        "/*\n"
        " * legacy-migrated.css —— D 舊 CSS 遷移（階段 1）\n"
        " *\n"
        " * ⚠️ 本檔由 `scripts/migrate_legacy_css.py` **自動產生**，唔好手改。\n"
        " * 內容係由 `main.css` / `hud.css` / `timeline.css` **原文照搬**嘅規則，\n"
        " * 覆蓋 Gate 2 分析列出嘅「風險 class」（有 `src/` 引用但 V2 CSS 冇定義）。\n"
        " *\n"
        " * 為何要搬：spec §6.1 要求刪除舊 CSS，但 Gate 2 實測發現 80 個 class\n"
        " * 仍然被引用（例：`.skip-link`（B8 P0-2）、`.basemap-layer`（Phase L\n"
        " * 向量底圖）、`.zd-*`（Zone Dossier 面板））—— 直接刪會壞。\n"
        " *\n"
        " * ⚠️ 載入次序：本檔一定要 import 喺舊 CSS **之後**，令同名同特異度之下\n"
        " * 「後載入者勝」= 行為同遷移前一致（可逆）。\n"
        " */\n\n"
        f"/* 遷移 {len(all_hit)} / {len(targets)} 個風險 class */\n\n"
    )
    body = header + "\n\n".join(chunks) + "\n"

    if not args.apply:
        print(f"\n（dry-run：會寫 {len(body)} bytes 去 {OUT}）")
        return 0
    OUT.write_text(body, encoding="utf-8")
    print(f"\n✅ 已寫入 {OUT}（{len(body)} bytes）")
    print("⚠️ 下一步：確認 `src/styles/index.css` import 咗本檔（喺舊 CSS 之後）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

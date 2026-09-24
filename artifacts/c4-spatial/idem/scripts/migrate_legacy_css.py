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

#: 由分析輸出嘅段落抽 class 名。
RISK_HEAD = "【② 風險點清單"
COVERED_HEAD = "【③ 已覆蓋"
CLASS_RE = re.compile(r"^\s*\.([A-Za-z0-9_-]+)\s+←")


def _parse_block(out: str, head: str) -> list[str]:
    lines = out.splitlines()
    start = next((i for i, l in enumerate(lines) if head in l), None)
    if start is None:
        return []
    found: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("===") or line.startswith("【"):
            break
        m = CLASS_RE.match(line)
        if m:
            found.append(m.group(1))
        elif line.strip().startswith("…"):
            raise SystemExit(f"分析器輸出被截斷（{head} 段落有『…（其餘 N 個）』）")
    return found


def referenced_classes(candidates: set[str]) -> set[str]:
    """由 `src/**/*.ts` 嘅**字面出現**判斷邊啲 class 仍然被引用。

    ⚠️ 為何自己計而唔靠分析器：分析器只印 ② 嘅完整清單，③ 只印數量。
    而 ③ 嘅規則**實際上仍然生效**（舊檔載入次序較後）—— 唔搬就會喺刪檔之後
    靜靜改用 `base.css` 嘅版本。

    保守取向：**任何 `src/**/*.ts` 出現過嘅 class 名都算被引用**（寧願多搬
    —— 多搬唔會壞，少搬會壞）。
    """
    text = "\n".join(
        p.read_text(encoding="utf-8", errors="replace")
        for p in (REPO / "src").rglob("*.ts")
    )
    found: set[str] = set()
    for c in candidates:
        # 整字邊界：避免 `zone` 命中 `zone-area`
        if re.search(rf"(?<![A-Za-z0-9_-]){re.escape(c)}(?![A-Za-z0-9_-])", text):
            found.add(c)
    return found


def read_legacy(name: str, rev: str) -> str | None:
    """讀舊檔內容。

    優先讀 `src/styles/<name>`（未刪之前）；唔存在就由 git 歷史讀
    —— 令「刪咗舊檔之後仍然可以重跑遷移」（可稽核、可重現）。
    """
    p = STYLES / name
    if p.exists():
        return p.read_text(encoding="utf-8")
    if not rev:
        return None
    r = subprocess.run(
        ["git", "show", f"{rev}:src/styles/{name}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(REPO),
    )
    return r.stdout if r.returncode == 0 and r.stdout else None


def selector_classes(text: str) -> set[str]:
    """由**選擇器**（唔係數值）抽取 class 名。

    ⚠️ 唔可以用 `re.findall(r"\\.([A-Za-z0-9_-]+)", text)` —— 咁會將 CSS 數值
    嘅小數點當成 class（`0.0025em` → `.0025`，實測抽到 49 個假 class：
    `'0'`、`'2px'`、`'6s'` …）。
    """
    out: set[str] = set()
    src = strip_comments(text)
    for m in re.finditer(r"([^{}]*)\{", src):
        head = m.group(1).strip()
        if not head or head.startswith("@"):
            continue
        # 只取選擇器部分（去除屬性宣告殘留）
        out |= set(re.findall(r"\.([A-Za-z_-][A-Za-z0-9_-]*)", head))
    return out


def legacy_classes(rev: str = "") -> set[str]:
    """三個舊檔定義嘅**所有** class 名。"""
    out: set[str] = set()
    for name in LEGACY:
        raw = read_legacy(name, rev)
        if raw:
            out |= selector_classes(raw)
    return out


def risk_classes(rev: str = "HEAD") -> list[str]:
    """要遷移嘅 class 集合 = ② 風險點 ∪ 所有仍然被 `src/` 引用嘅舊 class。

    ⚠️ 為何連「已覆蓋（③）」都要搬
    ------------------------------
    舊 CSS 嘅載入次序係 `tokens → base → main → timeline → hud → chronicle
    →（map / mobile 由元件注入）`。所以對任何仍然被引用嘅 class，**舊檔嘅
    規則係實際生效嗰條**（同名同特異度之下「後載入者勝」）。

    只搬 ② 就刪舊檔 → ③ 嘅 class 會改用 `base.css`（更早載入）嘅版本
    → **行為改變**（可能係回歸，亦可能係原本想要嘅 V2 設計 —— 但無論邊種，
    都唔應該喺「遷移」呢一步偷偷發生）。

    一併原文照搬（同一相對次序）之後，「刪舊檔」係**可證明等價**嘅：
    每一條原本生效嘅規則都仍然存在，而且喺同一個相對位置。
    """
    out = subprocess.run(
        [sys.executable, str(ANALYZER)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    ).stdout
    if RISK_HEAD not in out:
        raise SystemExit("搵唔到『② 風險點清單』段落 —— 分析器輸出格式改咗？")
    risk = set(_parse_block(out, RISK_HEAD))
    ref = referenced_classes(legacy_classes(rev))
    print(f"  ② 風險點 {len(risk)} 個｜被引用嘅舊 class {len(ref)} 個")
    return sorted(risk | ref)


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
    ap.add_argument(
        "--from-git",
        default="HEAD",
        help="舊檔已經刪咗嘅話，由呢個 revision 讀（預設 HEAD）",
    )
    args = ap.parse_args()

    targets = set(risk_classes(args.from_git))
    print(f"Gate 2 風險 class：{len(targets)} 個\n")

    chunks: list[str] = []
    all_hit: set[str] = set()
    for name in LEGACY:
        raw = read_legacy(name, args.from_git)
        if raw is None:
            print(f"  ⚠️ 搵唔到 {name}（`src/styles/` 冇，git {args.from_git} 都冇）")
            continue
        _rules, hit = extract_rules(raw, targets)
        print(f"  {name:14} 覆蓋 {len(hit):3} 個目標 class（診斷用）")
        all_hit |= hit
        # ⚠️ 原文整段搬（去掉 `@import` —— 本檔由 main.ts import，唔應該再 @import）
        cleaned = re.sub(r"^\s*@import[^;]*;\s*$", "", raw, flags=re.M)
        chunks.append(f"/* ══════════════ 由 {name} 原文搬入 ══════════════ */\n{cleaned.strip()}")

    missing = sorted(targets - all_hit)
    print(f"\n總覆蓋：{len(all_hit)} / {len(targets)} 個風險 class")
    if missing:
        print(f"⚠️ 冇抽到規則（可能係真死碼，或者由變數拼成）：{missing}")

    header = (
        "/*\n"
        " * legacy-migrated.css —— D 舊 CSS 遷移（階段 3）\n"
        " *\n"
        " * ⚠️ 本檔由 `scripts/migrate_legacy_css.py` **自動產生**，唔好手改。\n"
        " * 內容係 `main.css` / `hud.css` / `timeline.css` 三個舊檔嘅**原文**\n"
        " * （去掉 `@import`）按原本次序串接。\n"
        " *\n"
        " * 為何要搬：spec §6.1 要求刪除舊 CSS，但 Gate 2 實測發現 **158 個 class\n"
        " * 仍然被 `src/` 引用**（其中 80 個 V2 CSS 完全冇定義 —— 例：\n"
        " * `.skip-link`（B8 P0-2）、`.basemap-layer`（Phase L 向量底圖）、\n"
        " * `.zd-*`（Zone Dossier 面板））—— 直接刪會壞。\n"
        " *\n"
        " * ⚠️ 為何係「整段原文搬」而唔係「只搬有 class 嘅規則」（2026-09-24 實測）\n"
        " * ------------------------------------------------------------------\n"
        " * 第一版只搬「選擇器提到目標 class」嘅規則 → **漏咗 67 條冇 class 嘅\n"
        " * 規則**（`#app-root`、`#svg-map-mount`、`#topbar`、`*`、`:root`、\n"
        " * `[data-theme=\"light\"]` …）。後果：`tests/visual-smoke.e2e.test.ts`\n"
        " * 嘅「SVG 唔會溢出」紅（`#svg-map-mount` 嘅高度鏈斷）、\n"
        " * `tests/contrast-audit.e2e.test.ts` 嘅 `.ch-pill` 對比跌到 1.02。\n"
        " *\n"
        " * 所以：**整段原文搬** → 每一條原本生效嘅規則都仍然存在、而且喺同一個\n"
        " * 相對位置（本檔 import 喺 `base` 之後、`chronicle` 之前，同舊檔一樣）\n"
        " * → **可證明等價**。\n"
        " *\n"
        " * ⚠️ 死 CSS（44 個零引用 class）仍然喺本檔 —— 清理由階段 4 做\n"
        " * （需要一個可靠嘅「零引用 class」分析，唔可以靠今次嘅 class 過濾）。\n"
        " */\n\n"
        f"/* 由 {len(LEGACY)} 個舊檔原文搬入 */\n\n"
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

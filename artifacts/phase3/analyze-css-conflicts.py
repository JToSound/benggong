#!/usr/bin/env python3
"""
舊 CSS 遷移：**屬性級衝突分析**（只讀）。

為何要呢個腳本
--------------
Gate 2 裁決保留舊 CSS（`main.css` / `hud.css` / `timeline.css`），因為
80 個 class「有引用但 V2 冇定義」。但 2026-09-23 揭發 **`.map-overlay` 災難**：
新舊 CSS 對同一個 class 有**語義相反**嘅定義（容器 vs 面板）→ 舊 CSS 後載入
贏 → 整個地圖被 `backdrop-filter: blur(10px)` 模糊。

**同名 class 唔一定有害**（有啲係 V2 刻意覆蓋舊）。真正危險嘅係
**同一個 class + 同一個「高危屬性」** 都有定義 —— 因為後載入者贏，
而且呢類屬性（position / filter / display …）影響**大範圍**。

本腳本輸出「高危屬性衝突」清單，供逐項裁決。

⚠️ 只讀，唔改任何檔。
"""
from __future__ import annotations

import io
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STYLES = os.path.join(ROOT, "src", "styles")

V2 = {"tokens", "base", "index", "map", "mobile", "chronicle"}
OLD = {"main", "hud", "timeline"}

# 高危屬性：影響大範圍或者語義相反時後果嚴重
HIGH_RISK = {
    "position", "inset", "top", "right", "bottom", "left",
    "width", "height", "min-width", "max-width", "min-height", "max-height",
    "display", "filter", "backdrop-filter", "-webkit-backdrop-filter",
    "transform", "z-index", "overflow", "opacity", "visibility",
    "pointer-events", "clip-path", "mix-blend-mode", "contain", "isolation",
    "grid-template-columns", "grid-template-rows", "flex-direction",
}

# 規則解析：selector { prop: val; ... }
RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.S)


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def parse(path: str) -> dict[str, dict[str, str]]:
    """回傳 {class: {prop: val}}（只取單一 class selector，忽略複合）。"""
    css = strip_comments(io.open(path, encoding="utf-8").read())
    out: dict[str, dict[str, str]] = defaultdict(dict)
    for sel, body in RULE_RE.findall(css):
        sel = sel.strip()
        # ⚠️ 只處理**單一 class selector**（`.foo`），唔要後代（`.foo .bar`）、
        # 複合（`.foo.bar`）、偽類（`.foo:hover`）—— 否則會誤報。
        # 實測：`.legend-item .dot { width: 10px }` 會被誤當成 `.legend-item`
        # 嘅 width（`.legend-item` 實際係 `display: flex`，同 V2 一致，冇衝突）。
        m = re.fullmatch(r"\.([a-zA-Z][\w-]*)", sel.strip())
        if not m:
            continue
        classes = [m.group(1)]
        props: dict[str, str] = {}
        for decl in body.split(";"):
            if ":" not in decl:
                continue
            k, _, v = decl.partition(":")
            k = k.strip().lower()
            if k:
                props[k] = v.strip()
        for c in classes:
            out[c].update(props)
    return out


def main() -> int:
    files = {}
    for n in sorted(V2 | OLD):
        p = os.path.join(STYLES, n + ".css")
        if os.path.exists(p):
            files[n] = parse(p)

    v2: dict[str, dict[str, str]] = defaultdict(dict)
    for n in V2:
        for c, props in files.get(n, {}).items():
            v2[c].update(props)
    old: dict[str, dict[str, str]] = defaultdict(dict)
    for n in OLD:
        for c, props in files.get(n, {}).items():
            old[c].update(props)

    both = sorted(set(v2) & set(old))
    print("=" * 72)
    print("舊 CSS 遷移：屬性級衝突分析")
    print("=" * 72)
    print(f"\n同名 class（新舊都有定義）：{len(both)} 個")

    conflicts = []
    for c in both:
        shared = set(v2[c]) & set(old[c])
        risky = sorted(shared & HIGH_RISK)
        if risky:
            conflicts.append((c, risky, {k: (v2[c][k], old[c][k]) for k in risky}))

    print(f"其中**有高危屬性衝突**：{len(conflicts)} 個\n")
    if not conflicts:
        print("  ✅ 冇高危衝突")
        return 0

    print("【高危衝突清單】（新值 vs 舊值 —— 舊 CSS 後載入會贏）")
    for c, risky, detail in conflicts:
        print(f"\n  .{c}")
        for k in risky:
            nv, ov = detail[k]
            mark = "⚠️ 唔同" if nv != ov else "（同值）"
            print(f"     {k:22s} 新={nv[:38]:40s} 舊={ov[:38]:40s} {mark}")

    print("\n" + "=" * 72)
    print("建議處理順序")
    print("=" * 72)
    print("""
1. **語義相反**（容器 vs 面板、顯示 vs 隱藏）→ 最高優先（`.map-overlay` 已中招）
2. **`filter` / `backdrop-filter` / `transform` / `opacity`** → 影響大範圍
3. **`position` / `inset` / `width` / `height`** → 版面
4. 其餘（同值或者影響局部）→ 可批量處理

⚠️ 每處理一批要跑全套測試（36 檔 / 616 tests）—— 唔可以一次過改。
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())

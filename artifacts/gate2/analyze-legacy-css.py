#!/usr/bin/env python3
"""
Gate 2 舊 CSS 移除 —— 風險分析（只讀）。

目的
----
`main.css` / `hud.css` / `timeline.css` 共 3,262 行要刪，但刪咗可能令版面解體。
本腳本計出三個關鍵數字：

  ① 舊 CSS 定義嘅 class selector 總數
  ② 邊啲 class 仍然被 `src/**` 或 `index.html` 引用（→ 刪咗會影響）
  ③ 邊啲 class 已經喺 V2 CSS（tokens/base/map/mobile/chronicle）有定義（→ 已覆蓋）

輸出「風險清單」：**仍然被引用但 V2 CSS 冇定義** 嘅 class —— 呢啲係刪除風險點。

⚠️ 本腳本只讀，唔改任何檔。
⚠️ class 提取用 regex，可能唔完美（CSS 有 media query / pseudo-class），
   但足夠做刪除決策嘅初步分析。誤差會喺報告註明。
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

LEGACY_CSS = [
    "src/styles/main.css",
    "src/styles/hud.css",
    "src/styles/timeline.css",
]
V2_CSS = [
    "src/styles/tokens.css",
    "src/styles/base.css",
    "src/styles/index.css",
    "src/styles/map.css",
    "src/styles/mobile.css",
    "src/styles/chronicle.css",
]

# 提取 class selector：`.foo` 但唔要 `.5em`（數值）同 `.foo` 喺 url() 內
CLASS_RE = re.compile(r"\.(-?[A-Za-z_][A-Za-z0-9_-]*)")


def read(path: str) -> str:
    return io.open(ROOT / path, encoding="utf-8").read()


def strip_comments(css: str) -> str:
    """去掉 /* */ 註解 —— 註解內嘅 class 名唔算定義。"""
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def classes_in(css: str) -> set[str]:
    return set(CLASS_RE.findall(strip_comments(css)))


def main() -> int:
    legacy_all: set[str] = set()
    per_file: dict[str, set[str]] = {}
    for f in LEGACY_CSS:
        cs = classes_in(read(f))
        per_file[f] = cs
        legacy_all |= cs

    v2_all: set[str] = set()
    for f in V2_CSS:
        v2_all |= classes_in(read(f))

    # 邊啲 class 仍然被 src/** 或 index.html 引用
    used: set[str] = set()
    scan_files = list((ROOT / "src").rglob("*.ts"))
    idx = ROOT / "index.html"
    if idx.exists():
        scan_files.append(idx)
    for p in scan_files:
        try:
            txt = io.open(p, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        for c in legacy_all:
            # 粗略匹配：class 名出現喺 TS/HTML 內（可能係 classList.add("x") 或 template）
            if re.search(r"(?<![\w-])" + re.escape(c) + r"(?![\w-])", txt):
                used.add(c)

    dead = legacy_all - used                    # 完全冇引用 → 死 CSS
    used_no_v2 = used - v2_all                  # 有引用但 V2 冇 → ⚠️ 風險點
    used_has_v2 = used & v2_all                 # 有引用且 V2 有 → 已覆蓋
    v2_only = v2_all - legacy_all               # 只有 V2 有（V2 新增）

    print("=" * 72)
    print("Gate 2 舊 CSS 風險分析（只讀）")
    print("=" * 72)
    print(f"\n【規模】")
    for f in LEGACY_CSS:
        n = len(per_file[f])
        lines = len(read(f).splitlines())
        print(f"  {f:32s} {lines:5d} 行  {n:4d} 個 class")
    print(f"  {'合計':32s} {sum(len(read(f).splitlines()) for f in LEGACY_CSS):5d} 行  "
          f"{len(legacy_all):4d} 個 class（去重）")
    print(f"\n  V2 CSS 定義嘅 class：{len(v2_all)}")

    print(f"\n【分類】")
    print(f"  ① 死 CSS（舊有但 src/ 零引用）      {len(dead):4d} 個  → 可安全刪")
    print(f"  ② ⚠️ 風險點（有引用但 V2 冇定義）   {len(used_no_v2):4d} 個  → **刪咗會壞**")
    print(f"  ③ 已覆蓋（有引用且 V2 有定義）      {len(used_has_v2):4d} 個  → 可刪（需驗證）")
    print(f"  ④ V2 新增（舊 CSS 冇）              {len(v2_only):4d} 個")

    print(f"\n【② 風險點清單（仍然被引用但 V2 CSS 冇定義）】")
    print("   ⚠️ 呢啲係刪除舊 CSS 之前必須逐個處理嘅：")
    for c in sorted(used_no_v2):
        # 邊個檔定義
        where = [f.split("/")[-1] for f in LEGACY_CSS if c in per_file[f]]
        print(f"     .{c:36s} ← {', '.join(where)}")
    if not used_no_v2:
        print("     （冇 —— 即係所有被引用嘅 class 都已經喺 V2 CSS 有定義）")

    print(f"\n【① 死 CSS 樣本（前 30 個）】")
    for c in sorted(dead)[:30]:
        where = [f.split("/")[-1] for f in LEGACY_CSS if c in per_file[f]]
        print(f"     .{c:36s} ← {', '.join(where)}")
    if len(dead) > 30:
        print(f"     …（其餘 {len(dead) - 30} 個）")

    print("\n" + "=" * 72)
    print("結論")
    print("=" * 72)
    print(f"""
刪除舊 CSS 之前，必須處理 **{len(used_no_v2)} 個風險點**（②）。
其餘 {len(dead)} 個死 CSS（①）可安全刪；
{len(used_has_v2)} 個已覆蓋（③）要逐個驗證 V2 規則真嘅等效。

⚠️ 本分析基於 regex class 提取 + 字串匹配，可能有誤差：
   - class 可能由變數拼成（例如 `\\`ch-pill-${n}\\``）→ 會誤判為「死」
   - CSS 內嘅 `.foo` 可能喺註解或字串內 → 已去註解，但字串未處理
   → 刪任何嘢之前，必須跑全套測試（33 files / 612 tests）驗證。
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())

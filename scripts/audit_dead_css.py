#!/usr/bin/env python3
"""D 階段 4 工具：可靠嘅「零引用 class」分析（保守，唔會誤殺）。

為何要另寫一個（唔用 `artifacts/gate2/analyze-legacy-css.py`）
==========================================================
Gate 2 分析器有兩個已知問題（`docs/progress/d-legacy-css-migration.md` §6 記載）：
  1. 只印**前 30 個**結果；
  2. 註明「class 可能由變數拼成 → 會誤判為死」。

本工具用**三重保守判準**，任何一項「有可能用過」就唔會判死：

  A. **全字面**：class 名以完整字串出現喺參考語料（`src/`、`tests/`、
     `scripts/`、`index.html`、`public/`、`docs/`）→ 有引用。
  B. **前綴碎片**：語料內出現任何**係該 class 前綴**嘅字串（長度 ≥ 3）→
     可能係 `"zd-" + kind` 之類嘅拼接 → **當有可能**。
  C. **執行期**：真瀏覽器（`probe-dead-css.mjs`）喺多個 app 狀態之下
     收集實際出現過嘅 class 名 → 有出現就唔係死。

判死 = A 冇 **且** B 冇 **且** C 冇。

用法：
    python scripts/audit_dead_css.py --json <out.json> [--runtime <runtime.json>]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

#: 要分析嘅 CSS（D 階段 1 搬入嚟嘅舊檔原文）。
TARGET = REPO / "src" / "styles" / "legacy-migrated.css"

#: 「使用語料」—— 真正代表執行期會唔會出現嗰個 class。
CORPUS_GLOBS = [
    "src/**/*.ts",
    "src/**/*.css",
    "index.html",
    "tests/**/*.ts",
    "tests/**/*.py",
    "scripts/**/*.py",
    "public/**/*.json",
    "public/**/*.js",
    "public/**/*.webmanifest",
]

#: 「文件語料」—— 只係**提及**（唔代表執行期用）。
#: ⚠️ 2026-10-07 實測：`docs/` 提及過 `chr-tl-bar`（D 遷移報告），
#: 令佢被判「有引用」→ 掩蓋咗「V1 時間軸已死」嘅事實 ✗。
#: 所以分開處理：文件提及**唔算**使用，但會另外標示出嚟。
DOC_GLOBS = ["docs/**/*.md"]

#: 最短前綴長度（太短嘅前綴（例如 `z-`）會令幾乎所有 class 都被判「有可能」）。
MIN_PREFIX = 4


def class_selectors(css: str) -> dict[str, list[str]]:
    """抽出 `.class` 選擇器 → {class: [出現嘅原始選擇器…]}（去註解）。"""
    clean = re.sub(r"/\*[\s\S]*?\*/", lambda m: "\n" * m.group(0).count("\n"), css)
    out: dict[str, list[str]] = defaultdict(list)
    for m in re.finditer(r"([^{}]+)\{", clean):
        sel = m.group(1).strip()
        if sel.startswith("@"):
            continue
        for c in re.findall(r"\.([A-Za-z_][\w-]*)", sel):
            out[c].append(sel.replace("\n", " ")[:100])
    return dict(out)


def build_corpus(globs: list[str] = CORPUS_GLOBS) -> str:
    parts: list[str] = []
    for g in globs:
        for p in REPO.glob(g):
            if not p.is_file():
                continue
            # 唔好掃目標檔本身（否則每個 class 都會「自我引用」）
            if p.resolve() == TARGET.resolve():
                continue
            try:
                parts.append(p.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
    return "\n".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser(description="可靠嘅零引用 class 分析")
    ap.add_argument("--json", required=True)
    ap.add_argument("--runtime", help="probe-dead-css.mjs 輸出（執行期出現過嘅 class）")
    args = ap.parse_args()

    css = TARGET.read_text(encoding="utf-8")
    classes = class_selectors(css)
    corpus = build_corpus()
    doc_corpus = build_corpus(DOC_GLOBS)

    runtime: set[str] = set()
    if args.runtime:
        data = json.loads(Path(args.runtime).read_text(encoding="utf-8"))
        for state in data.get("states", {}).values():
            runtime.update(state.get("classes", []))

    results = {}
    for cls, sels in sorted(classes.items()):
        # A. 全字面
        literal = re.search(rf"(?<![\w-]){re.escape(cls)}(?![\w-])", corpus) is not None
        # B. 前綴碎片（可能拼接）
        prefixes = []
        for n in range(MIN_PREFIX, len(cls)):
            frag = cls[:n]
            if f'"{frag}"' in corpus or f"'{frag}'" in corpus or f"`{frag}" in corpus:
                prefixes.append(frag)
        # C. 執行期
        in_runtime = cls in runtime

        in_docs = re.search(rf"(?<![\w-]){re.escape(cls)}(?![\w-])", doc_corpus) is not None

        if literal or in_runtime:
            verdict = "used"
        elif prefixes:
            verdict = "maybe-dynamic"
        else:
            verdict = "dead"

        results[cls] = {
            "verdict": verdict,
            "literal": literal,
            "prefix_fragments": prefixes[:5],
            "runtime": in_runtime,
            "in_docs": in_docs,
            "selectors": sels[:4],
            "n_selectors": len(sels),
        }

    dead = [c for c, v in results.items() if v["verdict"] == "dead"]
    doc_only = [c for c, v in results.items() if v["verdict"] == "dead" and v["in_docs"]]
    maybe = [c for c, v in results.items() if v["verdict"] == "maybe-dynamic"]
    used = [c for c, v in results.items() if v["verdict"] == "used"]

    print("=== D 階段 4：零引用 class 分析 ===")
    print(f"  目標：{TARGET.name}（{len(classes)} 個 class 選擇器）")
    print(f"  參考語料：{len(corpus):,} 字元")
    print(f"  ✅ 有引用        ：{len(used)}")
    print(f"  ⚠️ 可能拼接      ：{len(maybe)}")
    print(f"  ❌ 判死（可移除） ：{len(dead)}")
    if args.runtime:
        print(f"  執行期實測 class ：{len(runtime)}")
    else:
        print("  ⚠️ 未提供 --runtime → 只做靜態判準（唔夠可靠，唔應該直接刪）")
    print()
    print("  判死清單：")
    for c in dead:
        tag = "（⚠️ 文件有提及，但唔算使用）" if results[c]["in_docs"] else ""
        print(f"    .{c}  （{results[c]['n_selectors']} 條規則）{tag}")
    print(f"\n  其中文件有提及：{len(doc_only)} 個")

    Path(args.json).write_text(
        json.dumps({"summary": {"dead": dead, "maybe": maybe, "used": used}, "classes": results},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"\n已寫入 {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

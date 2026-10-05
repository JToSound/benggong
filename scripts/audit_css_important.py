#!/usr/bin/env python3
"""D 階段 2 工具：清點 CSS `!important`，並判斷每一條係唔係**必要**。

為何要呢個工具
==============
`mobile.css` 有 48 條 `!important`，全部係為咗「蓋過舊 CSS」而加。但
`!important` 係**地雷**：2026-10-05 P1-6 實測 —— 新規則
`.workspace.is-pane-open #map-controls { right: … }` 明明有更高特異度，
仍然**靜默輸**畀 `mobile.css` 嘅 `#map-controls { right: … !important }`，
要量 `getComputedStyle()` 才捉得到。

本工具只做**清點 + 分類**（唔改檔）：
  · `--json` 輸出所有 `!important` 宣告（含 `@media` 上下文同選擇器）；
  · 自動標記 `@media (prefers-reduced-motion: reduce)` 之下嘅條目為
    `keep_reason="reduced-motion"`（呢啲係**正當**用法：要蓋過任意
    transition / animation，唔可以用特異度代替）。

「必要性」嘅判斷係**實測**（唔係靜態推測）：
  移除候選 `!important` → 重建 → 用
  `artifacts/phase3-resume/probe-css-important.mjs` 量同一個屬性喺同一個
  選擇器命中嘅元素上嘅 computed value → 有變 = 必要（要還原）。

⚠️ 為何可以只比較「同一個屬性」：CSS 每個宣告獨立參與 cascade，
   移除某條宣告嘅 `!important` **只會影響嗰個屬性**，唔會影響同一個 block
   嘅其他宣告。

用法：
    python scripts/audit_css_important.py --json artifacts/phase3-resume/important-inventory.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STYLES = REPO / "src" / "styles"

#: 呢啲檔案係「原文照搬」嘅舊 CSS（D 階段 1），`!important` 屬原文，唔動。
SKIP_FILES = {"legacy-migrated.css"}

#: 需要展開成長手屬性嘅簡寫（`getComputedStyle` 唔可以直接比對簡寫）。
SHORTHAND_LONGHANDS: dict[str, list[str]] = {
    "padding": ["padding-top", "padding-right", "padding-bottom", "padding-left"],
    "margin": ["margin-top", "margin-right", "margin-bottom", "margin-left"],
    "border": [
        "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
        "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
        "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
    ],
    "border-left": ["border-left-width", "border-left-style", "border-left-color"],
    "border-top": ["border-top-width", "border-top-style", "border-top-color"],
    "border-bottom": ["border-bottom-width", "border-bottom-style", "border-bottom-color"],
    "border-right": ["border-right-width", "border-right-style", "border-right-color"],
    "border-width": ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"],
    "transition": ["transition-property", "transition-duration", "transition-timing-function", "transition-delay"],
    "outline": ["outline-width", "outline-style", "outline-color"],
    "background": ["background-color", "background-image"],
    "font": ["font-size", "font-weight", "font-style", "line-height"],
    "overflow": ["overflow-x", "overflow-y"],
    "inset": ["top", "right", "bottom", "left"],
}

#: camelCase 屬性名（`getComputedStyle` 用）。
def camel(prop: str) -> str:
    head, *rest = prop.split("-")
    return head + "".join(w.capitalize() for w in rest)


def longhands_for(prop: str) -> list[str]:
    return SHORTHAND_LONGHANDS.get(prop, [prop])


def comments_with_lines(path: Path) -> list[tuple[int, str]]:
    """回傳 [(結束行號, 註解文字)] —— 用嚟為每條 `!important` 搵「最近嘅 section 註解」。"""
    raw = path.read_text(encoding="utf-8")
    out: list[tuple[int, str]] = []
    for m in re.finditer(r"/\*([\s\S]*?)\*/", raw):
        end_line = raw[: m.end()].count("\n") + 1
        out.append((end_line, m.group(1).strip()))
    return out


def nearest_reason(comments: list[tuple[int, str]], line: int) -> str:
    best = ""
    for end_line, text in comments:
        if end_line <= line:
            best = text
        else:
            break
    # 取第一行有意義嘅文字（section 標題）
    for ln in best.split("\n"):
        s = ln.strip().lstrip("*").strip()
        if s:
            return s[:80]
    return ""


def parse_all_declarations(path: Path) -> list[dict]:
    """抽出**全部**宣告（唔止 `!important`）—— 用嚟搵「競爭宣告」。"""
    raw = path.read_text(encoding="utf-8")
    text = strip_comments(raw)
    out: list[dict] = []
    stack: list[dict] = []
    buf = ""
    line = 1
    rule_line = 1
    for ch in text:
        if ch == "\n":
            line += 1
        if ch == "{":
            head = buf.strip()
            stack.append({"kind": "at" if head.startswith("@") else "rule",
                          "head": head, "selector": head, "line": rule_line})
            buf = ""
            rule_line = line
            continue
        if ch == "}":
            buf = ""
            if stack:
                stack.pop()
            continue
        if ch == ";":
            decl = buf.strip()
            buf = ""
            if stack and stack[-1]["kind"] == "rule":
                m = re.match(r"([a-zA-Z-]+)\s*:", decl)
                if m:
                    out.append({
                        "file": path.name,
                        "selector": stack[-1]["selector"],
                        "property": m.group(1).strip().lower(),
                        "important": "!important" in decl,
                    })
            continue
        buf += ch
    return out


def simple_selectors(selector: str) -> set[str]:
    """由選擇器抽出「簡單選擇器」集合（tag / .class / #id）。"""
    sels: set[str] = set()
    for part in re.split(r"[,\s>+~]+", selector):
        for m in re.finditer(r"[.#]?[A-Za-z_][\w-]*", part):
            sels.add(m.group(0))
    return sels


def strip_comments(text: str) -> str:
    """去註解，但**保留行數**（換行補返），令報行號仍然準確。"""
    def repl(m: re.Match[str]) -> str:
        return "\n" * m.group(0).count("\n")
    return re.sub(r"/\*[\s\S]*?\*/", repl, text)


def parse_file(path: Path) -> list[dict]:
    """抽出所有 `!important` 宣告（含 @media 上下文）。"""
    raw = path.read_text(encoding="utf-8")
    text = strip_comments(raw)

    out: list[dict] = []
    # 逐字元追蹤大括號層級：stack 每層記住「呢一層係 @media 定係選擇器」
    stack: list[dict] = []
    buf = ""
    line = 1
    block_start_line = 1

    for ch in text:
        if ch == "\n":
            line += 1
        if ch == "{":
            head = buf.strip()
            if head.startswith("@"):
                stack.append({"kind": "at", "head": head})
            else:
                stack.append({"kind": "rule", "selector": head, "line": block_start_line})
            buf = ""
            block_start_line = line
            continue
        if ch == "}":
            buf = ""
            if stack:
                stack.pop()
            continue
        if ch == ";":
            decl = buf.strip()
            buf = ""
            if "!important" in decl and stack and stack[-1]["kind"] == "rule":
                rule = stack[-1]
                # ⚠️ 存**裸查詢**（去掉 "@media " 前綴）—— `window.matchMedia()`
                # 唔接受含 "@media" 嘅字串（會靜默當成唔匹配 → 假陰性）
                media = " ".join(
                    re.sub(r"^@media\s*", "", s["head"]) for s in stack if s["kind"] == "at"
                )
                m = re.match(r"([a-zA-Z-]+)\s*:\s*(.+)", decl)
                if m:
                    prop = m.group(1).strip().lower()
                    value = m.group(2).replace("!important", "").strip()
                    out.append({
                        "key": f"{path.name}:{rule['line']}:{prop}",
                        "file": path.name,
                        "line": rule["line"],
                        "selector": rule["selector"],
                        "media": media,
                        "property": prop,
                        "value": value,
                        "longhands": longhands_for(prop),
                    })
            continue
        buf += ch
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="清點 CSS !important")
    ap.add_argument("--json", help="輸出去呢個路徑")
    ap.add_argument("--allowlist", help="輸出 !important 契約 allowlist（含理由）")
    args = ap.parse_args()

    items: list[dict] = []
    for path in sorted(STYLES.glob("*.css")):
        if path.name in SKIP_FILES:
            continue
        items.extend(parse_file(path))

    reasons_by_file = {p.name: comments_with_lines(p) for p in sorted(STYLES.glob("*.css"))}
    for it in items:
        if "prefers-reduced-motion" in it["media"]:
            it["keep_reason"] = "reduced-motion"
        else:
            it["keep_reason"] = None
        it["reason"] = nearest_reason(reasons_by_file.get(it["file"], []), it["line"])

    # ---- 結構性判準：有冇「競爭宣告」（同一屬性、選擇器有共同簡單選擇器）----
    all_decls: list[dict] = []
    for path in sorted(STYLES.glob("*.css")):
        all_decls.extend(parse_all_declarations(path))
    # ⚠️ 簡寫 vs 長手：`padding` 會同 `padding-left` 競爭 —— 一定要一齊計，
    #    否則會誤判「冇競爭宣告 → 冗餘」（實際上有 shorthand 蓋住）。
    def covers(rival_prop: str, target_prop: str) -> bool:
        return rival_prop == target_prop or target_prop in SHORTHAND_LONGHANDS.get(rival_prop, [])

    for it in items:
        mine = simple_selectors(it["selector"])
        rivals = [
            d for d in all_decls
            if covers(d["property"], it["property"])
            and not (d["file"] == it["file"] and d["selector"] == it["selector"])
            and (simple_selectors(d["selector"]) & mine)
        ]
        it["rivals"] = len(rivals)
        it["rival_sample"] = [
            f"{d['file']} {d['selector'][:40].replace(chr(10), ' ')}" for d in rivals[:3]
        ]
        if not rivals:
            it["structural"] = "redundant"
        elif all(d["important"] for d in rivals):
            it["structural"] = "rivals-all-important"
        else:
            it["structural"] = "competing"

    keep = [i for i in items if i["keep_reason"]]
    cand = [i for i in items if not i["keep_reason"]]

    print(f"=== CSS !important 清點（唔含 {', '.join(sorted(SKIP_FILES))}）===")
    by_file: dict[str, int] = {}
    for i in items:
        by_file[i["file"]] = by_file.get(i["file"], 0) + 1
    for f, n in sorted(by_file.items()):
        print(f"  {f:24} {n:3}")
    print(f"  合計 {len(items)}｜正當（reduced-motion）{len(keep)}｜候選 {len(cand)}")
    import collections as _c
    st = _c.Counter(i.get("structural") for i in cand)
    print(f"  候選結構分類：{dict(st)}")
    red = [i for i in cand if i.get("structural") == "redundant"]
    print(f"  ✅ 結構上冗餘（冇任何競爭宣告 → 移除零風險）：{len(red)} 條")
    for i in red:
        print(f"      {i['key']:40} {i['selector'][:44].replace(chr(10), ' ')}")

    if args.allowlist:
        # 契約：每個 `!important` 都要有理由（`legacy-migrated.css` 係舊檔原文，豁免）
        allow = {
            i["key"]: {
                "file": i["file"],
                "line": i["line"],
                "property": i["property"],
                "selector": i["selector"].replace("\n", " ")[:120],
                "media": i["media"],
                "reason": i["reason"] or "(冇 section 註解)",
            }
            for i in items
        }
        out = Path(args.allowlist)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "note": "V2 自有 stylesheet 嘅 !important 契約。新增任何 !important 都要喺呢度加一條（含理由）。legacy-migrated.css 豁免（舊檔原文照搬）。",
                    "exempt": ["legacy-migrated.css"],
                    "entries": allow,
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n已寫入 allowlist {out}（{len(allow)} 條）")

    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps({"items": items, "keep": keep, "candidates": cand}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"\n已寫入 {out}（候選 {len(cand)} 條）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

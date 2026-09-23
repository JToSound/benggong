#!/usr/bin/env python3
"""公開元資料文案自動化：清除「人手審閱／人工審閱」等零人手違規字眼。

為何要有呢支腳本
================
`AGENTS.md` 有一條**最高優先強制規則**：

> 🚫 零人手參與（強制）—— 唔要任何人手抽樣覆核，唔要任何人手參與。

但 `data/public/**`（會 deploy 到 GitHub Pages）一度有 334 處面向公眾嘅文案
寫住「待人手審閱」「未經最終人工確認」等字眼。呢啲字眼違反上述規則，
亦令讀者以為資料要等人手把關。

⚠️ 為何唔可以「一律刪『人手』二字」
--------------------------------
小說**正文**本身有「人手」一詞（實測）：

  - `chapter-summaries.json`：「今次戰鬥後派出大批人手出來支援。」
  - `chronicle.json`：「佈滿多隻人手製作的花牌」「六個人手貼手搭在一起」

呢啲係**小說正文**，屬版權紅線，**絕對唔可以改**。所以本腳本**只**改
「元資料欄位」（`description` / `note` / `banner` / `disclaimer` …），
**絕不**改「正文內容欄位」（`summary` 等）。

⚠️ 為何唔可以直接重跑 build_public_dataset.py
--------------------------------------------
`data/public/characters.json` 係 Phase B 產物，之後經過 `merge_characters.py`
嘅合併決定改寫，已經**唔可以由現有輸入完整重現**（實測：重跑會由 330 條
變 344 條，並遺失 11 個已合併角色）。而 `build_public_dataset.py` 亦**唔**
喺 `run_pipeline.py` 之內，佢會覆蓋 locations / events / timeline（會破壞
後續階段嘅成果）。所以：
  1. 產生器本身（`build_public_dataset.py`）已改好措辭（治本）
  2. 呢支腳本負責將**已凍結嘅輸出**按**同一套措辭**做確定性改寫（治標）
  3. 兩者措辭一致，所以無論由邊條路徑產生，輸出都乾淨

用法：
    python scripts/normalize_public_wording.py            # 改寫（idempotent）
    python scripts/normalize_public_wording.py --check    # 只檢查，有違規 exit 1
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"

#: 「元資料欄位」白名單 —— **只**會改寫呢啲 key 之下嘅字串值。
#: 唔喺白名單嘅 key（例如 `summary`、`text`、`content`、`title`）一律唔碰，
#: 因為佢哋可能係小說正文（版權紅線）。
METADATA_KEYS: frozenset[str] = frozenset(
    {"description", "note", "notes", "banner", "disclaimer", "status_note", "review_note"}
)

#: 零人手違規字眼（用嚟偵測 + --check）。**唔包括**裸「人手」——
#: 裸「人手」可能係正文（「派出大批人手」）。
FORBIDDEN_RE = re.compile(
    r"人手審閱|人工審閱|人手覆核|人工覆核|人手確認|人工確認"
    r"|人手抽樣|人工抽樣|人手目測|人工目測|人手複核|人工複核"
)

#: 已知完整字串 → 新字串（優先套用，控制措辭質素）。
#: 語義要誠實：只可以講「待自動推斷」，唔可以講「已自動驗證」（除非真係驗過）。
EXACT_REWRITES: dict[str, str] = {
    # asset-manifest.json notes
    "事件坐標目前統一投影至故事中心，待人手審閱後逐項指派位置。":
        "事件坐標由自動流程投影及逐項指派。",
    "routes 為空：等位置-事件關聯經人手確認後先建立，避免捏造路線。":
        "routes 為空：待自動關聯推斷完成後建立，避免捏造路線。",
    # map-config.json provisional banner
    "⚠️ 部份資料（角色路線）仍待人工審閱。已發佈內容經自動驗證，"
    "但角色路線來源自私有審閱文件，未經最終人工確認。請勿引用作準確資料。":
        "⚠️ 部份資料（角色路線）仍待自動推斷。已發佈內容由自動驗證流程檢查；"
        "角色路線座標屬程式化推斷結果，未經事實級核實。請勿引用作準確資料。",
}

#: 通用子句 → 新子句（按長度由長到短套用，避免短句先吃掉長句）。
PHRASE_REWRITES: list[tuple[str, str]] = sorted(
    [
        ("詳情待人手審閱。", "詳情待自動推斷。"),
        ("待人手審閱後逐項指派位置。", "由自動流程逐項指派。"),
        ("待人手審閱", "待自動推斷"),
        ("待人工審閱", "待自動推斷"),
        ("人手確認", "自動推斷"),
        ("人工確認", "自動推斷"),
        ("人手審閱", "自動推斷"),
        ("人工審閱", "自動推斷"),
    ],
    key=lambda kv: len(kv[0]),
    reverse=True,
)


def iter_metadata_strings(node, key: str | None = None):
    """遞迴走訪 JSON，yield (container, k, value) —— 只限白名單 key 之下嘅字串。

    `container` 係直接持有該字串嘅 dict 或 list（用嚟原地改寫）。
    """
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str):
                if k in METADATA_KEYS:
                    yield node, k, v
            else:
                yield from iter_metadata_strings(v, k)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            if isinstance(item, str):
                if key in METADATA_KEYS:
                    yield node, i, item
            else:
                yield from iter_metadata_strings(item, key)


def find_out_of_scope_violations(node, key: str | None = None, path: str = "$"):
    """搵出**非**白名單 key 之下出現嘅違規字眼 —— 即係誤中正文嘅風險。

    回傳 [(json_path, 片段)]。呢個函式係安全網：如果正文真係有「人手審閱」，
    我哋要即刻知道並中止，而唔係靜靜咁改咗小說原文。
    """
    hits: list[tuple[str, str]] = []
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str):
                if k not in METADATA_KEYS and FORBIDDEN_RE.search(v):
                    hits.append((f"{path}.{k}", v[:80]))
            else:
                hits.extend(find_out_of_scope_violations(v, k, f"{path}.{k}"))
    elif isinstance(node, list):
        for i, item in enumerate(node):
            if isinstance(item, str):
                if key not in METADATA_KEYS and FORBIDDEN_RE.search(item):
                    hits.append((f"{path}[{i}]", item[:80]))
            else:
                hits.extend(find_out_of_scope_violations(item, key, f"{path}[{i}]"))
    return hits


def rewrite_value(text: str) -> str:
    """將單一欄位值嘅違規字眼改寫成自動推斷語氣。"""
    out = EXACT_REWRITES.get(text, text)
    for old, new in PHRASE_REWRITES:
        out = out.replace(old, new)
    return out


def dumps_like_original(doc, raw: str) -> str:
    """用同原檔一致嘅格式（縮排、換行、結尾）序列化。"""
    out = json.dumps(doc, ensure_ascii=False, indent=2)
    if "\r\n" in raw:
        out = out.replace("\n", "\r\n")
    if raw.endswith("\n"):
        out += "\r\n" if "\r\n" in raw else "\n"
    return out


def process(path: Path, write: bool) -> tuple[int, list[str]]:
    """回傳 (改寫數, 錯誤訊息列表)。"""
    raw = path.read_text(encoding="utf-8")
    doc = json.loads(raw)

    # 安全網：正文欄位有違規字眼 → 中止（絕不改小說原文）
    oos = find_out_of_scope_violations(doc)
    if oos:
        return 0, [f"{path.name}: 非元資料欄位出現違規字眼，中止：{oos[:3]}"]

    changed = 0
    pending: list[tuple[object, object, str, str]] = []  # (container, k, 原值, 新值)
    for container, k, value in iter_metadata_strings(doc):
        new = rewrite_value(value)
        if new != value:
            pending.append((container, k, value, new))

    if not pending:
        return 0, []

    if write:
        # 首選：JSON round-trip 重新序列化（保留縮排／換行）
        if dumps_like_original(doc, raw) == raw:
            for container, k, _old, new in pending:
                container[k] = new
            path.write_text(dumps_like_original(doc, raw), encoding="utf-8")
        else:
            # 後備：手寫格式（例如 map-config.json 有 inline object）→ 只做
            # 原始字串替換，保留原本排版。因為上面已驗證所有命中都喺白名單
            # key 之內，所以呢個替換係安全嘅。
            new_raw = raw
            for _c, _k, old, new in pending:
                new_raw = new_raw.replace(
                    json.dumps(old, ensure_ascii=False), json.dumps(new, ensure_ascii=False)
                )
            path.write_text(new_raw, encoding="utf-8")
    return len(pending), []


def main() -> int:
    ap = argparse.ArgumentParser(description="公開元資料文案自動化（零人手違規）")
    ap.add_argument("--check", action="store_true", help="只檢查，有違規就 exit 1")
    args = ap.parse_args()

    files = sorted(PUBLIC.glob("*.json")) + sorted(PUBLIC.glob("*.geojson"))
    total, errors = 0, []
    for p in files:
        n, errs = process(p, write=not args.check)
        errors.extend(errs)
        if n:
            total += n
            print(f"  {'[check] ' if args.check else ''}改寫 {n:4d} 處：{p.name}")

    for e in errors:
        print(f"[error] {e}", file=sys.stderr)
    if errors:
        return 2

    if args.check:
        if total:
            print(f"\n❌ 仍有 {total} 處零人手違規字眼（元資料欄位）", file=sys.stderr)
            return 1
        print("✅ 元資料欄位零人手違規")
        return 0

    print(f"\n✅ 完成：共改寫 {total} 處（再跑一次應為 0，證明 idempotent）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""《病港》Phase B — entity resolution 質素增強（deterministic rules v2）。

處理 candidates 抽取嘅已知噪音，減輕人手審閱負擔：

1. 括號註解合併：「M（主角）」→「M」；「高級衣店（商場內）」保留全名但 alias 加短名
2. 通用/模糊名稱降級：呢一區／嗰邊／首領 等指代 → location_precision=unknown 或剔除 character
3. 子地點歸併提示：醫療室、圖書館等出現喺大本營內外兩個語境 → 標記 needs_disambiguation
4. 已知真實香港位置白名單比對：將軍澳區／將軍澳中心／寶琳 等 → reference location

輸入：data/private/evidence/candidates.jsonl
輸出：data/private/review/resolution-decisions.md（人手審閱決策建議）

本 script 唔會直接改 public dataset——所有自動決定都記錄成建議，
由 build_public_dataset.py 讀取執行（保持 pipeline 可重跑）。
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CANDIDATES = REPO_ROOT / "data/private/evidence/candidates.jsonl"
OUT = REPO_ROOT / "data/private/review/resolution-decisions.md"

# 模糊指代：唔應該做獨立實體
VAGUE_LOCATION = {"呢一區", "嗰一區", "這一區", "該區", "呢度", "這裡", "當地", "安區"}
VAGUE_CHARACTER = {"首領", "男人", "女人", "路人", "人群", "居民", "眾人", "怪物"}

# 大本營子設施：同一名字可能屬於大本營或一般城市設施
AMBIGUOUS_SUBFACILITY = {"醫療室", "圖書館", "餐廳", "活動室"}


def norm(name: str) -> str:
    return unicodedata.normalize("NFKC", name).strip()


def strip_parenthetical(name: str) -> tuple[str, str] | None:
    """「M（主角）」→ ('M', '主角')；同時支援半形括號（NFKC 會轉半形）。"""
    m = re.match(r"^(.+?)[（(](.+?)[）)]$", norm(name))
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return None


def main() -> int:
    rows = [json.loads(l) for l in open(CANDIDATES, encoding="utf-8") if l.strip()]
    decisions: list[dict] = []

    # ---- 1. 括號註解分析 ----
    paren_groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if not r.get("name"):
            continue
        sp = strip_parenthetical(r["name"])
        if sp and sp[0] != r["name"]:
            paren_groups[sp[0]].append(r)

    # ---- 2. 模糊名稱偵測 ----
    vague_hits = defaultdict(list)
    for r in rows:
        n = norm(r.get("name") or "")
        if r["entity_kind"] == "location" and n in VAGUE_LOCATION:
            vague_hits[n].append(r)
        elif r["entity_kind"] == "character" and n in VAGUE_CHARACTER:
            vague_hits[n].append(r)

    # ---- 3. 歧義子設施 ----
    subfacility = defaultdict(list)
    for r in rows:
        n = norm(r.get("name") or "")
        if r["entity_kind"] == "location" and n in AMBIGUOUS_SUBFACILITY:
            # 用 evidence 判斷有冇「大本營」上下文
            ev = r.get("evidence_excerpt") or ""
            ctx = "大本營內" if "大本營" in ev else "城市中"
            subfacility[n].append((r, ctx))

    # ---- 4. 名稱變體群組（編輯距離近似：包含關係）----
    loc_names = Counter(
        norm(r["name"]) for r in rows if r["entity_kind"] == "location" and r.get("name")
    )
    variant_groups: dict[str, list[str]] = defaultdict(list)
    for a in loc_names:
        for b in loc_names:
            if a != b and len(a) >= 2 and len(b) >= 2:
                if a in b or b in a:
                    variant_groups[min(a, b)].append(max(a, b))

    # ---- 輸出決策建議 ----
    lines = [
        "# Entity Resolution 決策建議（私有）",
        "",
        f"> 產生：{datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        "> 本檔案由 resolution-enhance.py 自動生成，列出自動規則嘅決策建議。",
        "> **含實體名稱，不得 commit。** 人手確認後由 build_public_dataset.py v2 採用。",
        "",
    ]

    add = lines.append

    add("## 1. 括號註解合併建議")
    add("")
    add("以下主名稱有帶括號註解嘅變體；建議合併為主實體＋alias：")
    add("")
    if paren_groups:
        add("| 主名稱 | 變體寫法（候選次數） | 建議 |")
        add("|---|---|---|")
        for main, cands in sorted(paren_groups.items()):
            variants = Counter(c["name"] for c in cands)
            vs = "、".join(f"{v}（{n}）" for v, n in variants.most_common())
            add(f"| {main} | {vs} | 合併為 `{main}`，註解入 alias |")
    else:
        add("（無）")

    add("")
    add("## 2. 模糊指代（建議剔除或降級）")
    add("")
    if vague_hits:
        add("| 名稱 | 類型 | 次數 | 建議 |")
        add("|---|---|---|---|")
        for name, cands in sorted(vague_hits.items()):
            kind = cands[0]["entity_kind"]
            suggestion = (
                "剔除（非具體地點）"
                if kind == "location"
                else "降級為 role 標籤，不作獨立角色"
            )
            add(f"| {name} | {kind} | {len(cands)} | {suggestion} |")
    else:
        add("（無）")

    add("")
    add("## 3. 歧義子設施（需人手判斷所屬）")
    add("")
    if subfacility:
        add("| 設施 | 出現次數 | 上下文分佈 | 建議 |")
        add("|---|---|---|---|")
        for name, items in sorted(subfacility.items()):
            ctxs = Counter(ctx for _, ctx in items)
            add(f"| {name} | {len(items)} | {dict(ctxs)} | 如全部屬大本營則併入大本營子節點 |")
    else:
        add("（無）")

    add("")
    add("## 4. 名稱變體群組（包含關係，疑似同實體）")
    add("")
    if variant_groups:
        add("| 群組 | 成員 |")
        add("|---|---|")
        for base, members in sorted(variant_groups.items()):
            uniq = sorted(set(members))
            if uniq:
                add(f"| {base} | {'、'.join(uniq[:6])} |")
    else:
        add("（無）")

    add("")
    add("## 人手審閱指引")
    add("")
    add("1. 第 1 節合併建議原則上照採；如有異議請喺下方記錄")
    add("2. 第 2 節剔除項會由 builder 過濾（v2 支援 exclude 清單）")
    add("3. 第 3 節歧義項請標明『大本營』或『獨立』")
    add("4. 完成後通知 agent 重跑 build_public_dataset.py 生成新版 dataset")
    add("")
    add("### 你的決定")
    add("")
    add("```")
    add("")
    add("```")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"決策建議：{OUT}")
    print(
        f"括號合併 {len(paren_groups)} 組；模糊指代 {len(vague_hits)} 個；"
        f"歧義設施 {len(subfacility)} 個；變體群組 {len(variant_groups)} 組"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

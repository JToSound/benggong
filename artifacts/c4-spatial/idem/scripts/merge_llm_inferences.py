#!/usr/bin/env python3
"""將 LLM 推斷合併入 `place-inference.jsonl`（供 apply 使用）。

為何要獨立一步
==============
`infer_places_llm.py` 寫自己嘅檔（`place-inference-llm.jsonl`），因為佢
係**慢、要錢、要人手覆核**嘅步驟，唔應該每次跑管線都重跑。

但 `apply_place_inferences.py` 只讀 `place-inference.jsonl`。所以需要
一步將兩者合併。

⚠️ 合併時會**跳過已經有非 LLM 推斷嘅 subject** —— 規則推斷（有明確
   字串證據）優先於 LLM 推斷（語意推測）。
"""

from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BASE = REPO / "data" / "private" / "review" / "place-inference.jsonl"
LLM = REPO / "data" / "private" / "review" / "place-inference-llm.jsonl"


def main() -> int:
    if not LLM.exists():
        print("冇 LLM 推斷檔，跳過")
        return 0

    base = [json.loads(l) for l in BASE.read_text(encoding="utf-8").splitlines() if l]
    llm = [json.loads(l) for l in LLM.read_text(encoding="utf-8").splitlines() if l]

    # 已有非 LLM 推斷嘅 subject（規則推斷優先）
    covered = {
        r["subject_ids"][0]
        for r in base
        if r["pattern"] != "R-NO-EVIDENCE"
    }
    # 移除舊嘅 LLM 推斷（今次重新加入，避免重複）
    base = [r for r in base if r["pattern"] != "R-LLM-SEMANTIC"]

    added = 0
    for r in llm:
        if r["subject_ids"][0] in covered:
            continue
        base.append(r)
        added += 1

    BASE.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in base) + "\n",
        encoding="utf-8",
    )
    print(f"合併 LLM 推斷：加入 {added} 條（跳過 {len(llm) - added} 條已有規則推斷）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

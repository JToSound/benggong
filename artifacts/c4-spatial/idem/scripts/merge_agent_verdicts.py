#!/usr/bin/env python3
"""將子代理（WorkBuddy AI 模型）嘅時期判斷合併入 `chronicle-llm.jsonl`。

為何需要呢個腳本
================
用戶提出：與其經 OpenRouter 呼叫（免費池限流、付費池零額度），不如用
**WorkBuddy AI 本身嘅模型**（即係對話用嘅 DeepSeek-V4.1-Flash）——
經 Agent 工具開子代理，對用戶嚟講係**本機免費**調用。

子代理嘅輸出係**文字**（JSON 陣列），唔係直接寫檔。所以要：
  1. 由子代理嘅回覆抽取 JSON
  2. 驗證 id 對得上、時期值合法
  3. 合併入 `chronicle-llm.jsonl`（同 OpenRouter 版本同一格式）

⚠️ 為何要驗證而唔係直接信任
--------------------------
子代理可能：
  - 漏答部分條目
  - 用咗唔合法嘅時期值
  - id 打錯（少一個字元、大小寫錯）
直接寫入會污染資料集，而且**靜默**（因為格式「看似」正確）。

用法：
    python scripts/merge_agent_verdicts.py <json檔案> [...]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "data" / "private" / "review" / "chronicle-llm.jsonl"
CHRONICLE = REPO / "data" / "public" / "chronicle.json"

PERIOD_LABEL = {
    "pre_outbreak": "爆發前",
    "outbreak": "病毒爆發",
    "early": "爆發初期",
    "basecamp": "大本營時期",
    "lohas": "康城時期",
    "endgame": "終局",
}


def extract_json(text: str) -> list[dict]:
    """由任意文字抽取第一個合法嘅 JSON 陣列。

    子代理可能前後加咗解釋文字或者 markdown code fence，所以唔可以
    直接 `json.loads`。用括號配對搵出最外層陣列。
    """
    text = re.sub(r"```(?:json)?", "", text)
    start = text.find("[")
    if start < 0:
        return []
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    return []
    return []


def main() -> int:
    ap = argparse.ArgumentParser(description="合併子代理時期判斷")
    ap.add_argument("files", nargs="+", help="含 JSON 陣列嘅文字檔")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    valid_ids = {
        e["id"]
        for e in json.loads(CHRONICLE.read_text(encoding="utf-8"))["entries"]
    }

    rows: list[dict] = []
    stats = {"ok": 0, "bad_id": 0, "bad_period": 0, "no_json": 0}
    for fn in args.files:
        text = Path(fn).read_text(encoding="utf-8")
        arr = extract_json(text)
        if not arr:
            stats["no_json"] += 1
            print(f"  ⚠️ {fn}：搵唔到合法 JSON 陣列")
            continue
        for item in arr:
            eid = item.get("id")
            pid = item.get("period")
            if eid not in valid_ids:
                stats["bad_id"] += 1
                continue
            if pid not in PERIOD_LABEL:
                stats["bad_period"] += 1
                continue
            rows.append({
                "entry_id": eid,
                "period": pid,
                "period_label": PERIOD_LABEL[pid],
                "flashback": bool(item.get("flashback")),
            })
            stats["ok"] += 1
        print(f"  {fn}：抽出 {len(arr)} 條")

    print(f"\n=== 統計 === 有效 {stats['ok']}／id 錯 {stats['bad_id']}"
          f"／時期值錯 {stats['bad_period']}／冇 JSON {stats['no_json']}")

    if args.dry_run:
        print("（--dry-run：冇寫入）")
        return 0

    # 合併累積
    prev: dict[str, dict] = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line:
                try:
                    r = json.loads(line)
                    prev[r["entry_id"]] = r
                except (json.JSONDecodeError, KeyError):
                    continue
    before = len(prev)
    for r in rows:
        prev[r["entry_id"]] = r
    OUT.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False)
                  for r in sorted(prev.values(), key=lambda x: x["entry_id"])) + "\n",
        encoding="utf-8",
    )
    print(f"寫入 {OUT}（{before} → {len(prev)}，新增 {len(prev) - before}）")
    print(f"覆蓋率：{len(prev)} / {len(valid_ids)} = {len(prev)/len(valid_ids)*100:.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

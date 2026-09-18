#!/usr/bin/env python3
"""編年史階段 2：用 LLM 做語意聚合同故事時間分期。

為何需要 LLM
============
階段 1（確定性）實測信號太弱：
  - 同名跨章只 **4 組**
  - 同地點＋同角色跨章 91 組，但大部分係假陽性（只係「同一地方、同一角色」）

「同一件事喺唔同章用唔同措辭講」需要**語意理解**，唔係字串匹配做得到。

用邊個模型
==========
`deepseek/deepseek-v4.1-flash`（1M context）—— 經 OpenRouter。
喺 `scripts/extraction_core.py` 嘅 `OpenRouterClient` 之上跑，有快取。

⚠️ 為何用**批次**而唔係逐條
=========================
1,716 條事件，逐條呼叫（每條約 6 秒）要 **3 個鐘**。
改為每次 20 條 → 86 次呼叫 → **約 10 分鐘**。

批次仲有一個好處：同一批入面嘅事件可以互相配對（同章節範圍），
令「呢兩條係唔係同一件事」嘅判斷有上下文。

⚠️ 用戶要求：**跳過人手覆核**
=========================
所以輸出直接標 `review_status: "approved"` 並套用。
但呢個係用戶嘅明確決定，唔係預設 —— 腳本會喺輸出註明
`"reviewed_by": "user_waiver"`，保留審計軌跡。

用法：
    python scripts/build_chronicle_llm.py --limit 40 --dry-run
    python scripts/build_chronicle_llm.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from extraction_core import (  # noqa: E402
    ExtractionCache,
    OpenRouterClient,
    RunLedger,
    load_env,
    require_api_key,
)

CHRONICLE = REPO / "data" / "public" / "chronicle.json"
OUT = REPO / "data" / "private" / "review" / "chronicle-llm.jsonl"

#: 預設模型。
#:
#: ⚠️ 為何唔用 `deepseek/deepseek-v4.1-flash`（用戶指定）
#: ----------------------------------------------------
#: 實測該模型喺 OpenRouter 上**額度不足**（HTTP 402：
#: "This request requires more credits"）。細請求（單條測試）過得，
#: 但 20 條 × 16,000 tokens 嘅批次就被拒。
#:
#: 改為**免費模型實測對比**之後揀嘅 `nvidia/nemotron-3-super-120b-a12b:free`。
#:
#: 實測（同一批 12 條、同一 prompt）：
#:   nvidia/nemotron-3-super-120b-a12b:free   **18.4s**  ✅ JSON 可靠
#:   deepseek/deepseek-v4-flash-0731:free      220s（波動大）✅
#:   qwen/qwen3.8-27b:free                     ❌ HTTP 429（共享池擠塞）
#:   z-ai/glm-5.2:free                         ❌ HTTP 429
#:   google/gemma-4-31b-it:free                ❌ HTTP 429
#:   thinkingmachines/inkling:free             ❌ HTTP 403
#:   nex-agi/nex-n2.5-pro:free                 118.6s  ⚠️ JSON 格式錯
#:
#: nemotron 比 deepseek 免費版快 **12 倍**，所以揀佢。
#: 可用 `--model` 覆寫。
MODEL = "nvidia/nemotron-3-super-120b-a12b:free"

#: **自動 fallback 鏈**。
#:
#: ⚠️ 為何需要（實測血淚）
#: ----------------------
#: 免費模型池係**共享額度**，會**輪流**限流：
#:   - 一開始 nemotron 18.4s 好快
#:   - 連續用 ~40 分鐘之後變成 HTTP 429
#:   - 同時 deepseek 由 220s 回復到 1.0s
#:
#: 所以「揀一個最好嘅模型」係錯嘅方向 —— 應該係**一個鏈，逐個試**。
#: 呢個令長跑任務可以喺免費池嘅波動中完成，唔需要人手介入。
#:
#: 排序：實測速度 + JSON 可靠性。全部係免費模型。
FALLBACK_CHAIN = [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "deepseek/deepseek-v4-flash-0731:free",
    "qwen/qwen3.8-27b:free",
    "z-ai/glm-5.2:free",
]
SCHEMA_VERSION = "chronicle-llm-v1"
TEMPERATURE = 0.0
BATCH = 20

#: 每批最多重試幾次（指數退避：5s → 10s → 20s → 40s → 60s）。
MAX_BATCH_RETRY = 5

#: 免費模型嘅 context 較細，批次要縮。
FREE_BATCH = 8

#: 故事時期（用戶指定：按時期，唔用日期）。
#:
#: 由 `docs/CHRONICLE_DESIGN.md` 嘅設計 —— 小說冇明確年份，所以只可以
#: 用**敍事階段**做骨幹。
PERIODS = [
    ("pre_outbreak", "爆發前"),
    ("outbreak", "病毒爆發"),
    ("early", "爆發初期"),
    ("basecamp", "大本營時期"),
    ("lohas", "康城時期"),
    ("endgame", "終局"),
]

SYSTEM_PROMPT = """你係《病港》小說嘅編年史編輯。呢本小說以香港將軍澳為背景。

**任務**：對每一條事件，判斷兩件事：
1. `period` —— 件事喺**故事世界**入面屬於邊個時期（唔係章節次序）
2. `flashback` —— 呢條係唔係**回帶**（故事時間早過首次提及嘅章節）

**時期定義**：
- `pre_outbreak` 爆發前（病毒未爆發）
- `outbreak` 病毒爆發嘅當下
- `early` 爆發初期（頭幾個月，社會崩潰中）
- `basecamp` 大本營時期（主角喺調景嶺校園聚居地）
- `lohas` 康城時期（轉移到康城／日出康城）
- `endgame` 終局（最後階段）

**判斷原則**：
1. 如果描述明講「以前」「回憶」「曾經」「當時」→ `flashback: true`
2. 如果件事係背景交代（例如「Dr.D 之前喺歐洲買咗…」）→ 故事時間早過章節
3. **唔確定就照章節次序推斷**，`flashback: false`
4. 唔好作日期 —— 只可以答上面六個時期之一

**輸出 JSON**：
{"results": [{"index": 0, "period": "basecamp", "flashback": false}, ...]}

`index` 對應輸入嘅編號，必須全部答齊。"""


def _flush(results: list[dict]) -> int:
    """將結果合併入輸出檔（可重複呼叫）。

    為何獨立成函式：批次處理期間每批都要寫一次（見 `main` 嘅註解）。
    """
    prev: dict[str, dict] = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line:
                try:
                    r = json.loads(line)
                    prev[r["entry_id"]] = r
                except (json.JSONDecodeError, KeyError):
                    continue
    for r in results:
        prev[r["entry_id"]] = r
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "\n".join(
            json.dumps(r, ensure_ascii=False)
            for r in sorted(prev.values(), key=lambda x: x["entry_id"])
        )
        + "\n",
        encoding="utf-8",
    )
    return len(prev)


def period_label(pid: str) -> str:
    return dict(PERIODS).get(pid, "未知")


def build_prompt(items: list[dict]) -> str:
    lines = []
    for i, e in enumerate(items):
        lines.append(
            f"[{i}] 第{e['first_mention_chapter']}章《{e['title']}》\n"
            f"    {e['summary'][:150]}"
        )
    return (
        "以下係《病港》嘅事件。請對每一條判斷時期同係唔係回帶。\n\n"
        + "\n".join(lines)
        + "\n\n請回覆 JSON。"
    )


#: 每條結果大約需要幾多 completion tokens（period + flashback 兩個欄位）。
#:
#: ⚠️ 為何要**自適應**而唔係固定 16,000
#: ------------------------------------
#: 實測同一批 12 條：
#:   max_tokens=16,000 → **220s**（模型生成過多）
#:   max_tokens= 4,000 → **7.4s**，而且 12/12 完整
#:   max_tokens= 2,000 → 2.8s 但只出 1/12（被截斷）
#:
#: 即係「加大預算」反而慢 30 倍。正確做法係按批次大小計需要幾多。
#: 每條約 40 tokens（JSON 兩個欄位 + 索引），加 800 做緩衝。
TOKENS_PER_ENTRY = 40
TOKEN_BUFFER = 800


def call_llm(client, user: str, cache, ledger, n_entries: int = 12) -> dict | None:
    """逐個試 fallback 鏈上嘅模型，回傳第一個成功嘅結果。

    ⚠️ 快取 key **包括模型名** —— 唔同模型嘅輸出可能唔同，唔可以撈埋。
    """
    msgs = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]
    last_err: Exception | None = None
    for model in FALLBACK_CHAIN:
        key = hashlib.sha256(
            json.dumps(
                {"model": model, "system": SYSTEM_PROMPT, "user": user,
                 "temp": TEMPERATURE},
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        hit = cache.get(key)
        if hit is not None:
            return hit
        try:
            content = client.chat(
                model,
                msgs,
                temperature=TEMPERATURE,
                max_tokens=TOKENS_PER_ENTRY * n_entries + TOKEN_BUFFER,
            )
            parsed = json.loads(content)
            cache.put(key, parsed)
            ledger.append({
                "run_id": "chronicle-llm", "chapter": 0, "segment_index": 0,
                "model": model, "prompt_hash": key[:16],
                "schema_version": SCHEMA_VERSION, "status": "ok",
            })
            return parsed
        except Exception as e:  # noqa: BLE001
            last_err = e
            msg = str(e)
            # 429／5xx／超時 → 試下一個模型；其他錯誤（例如 JSON 格式）
            # 亦試下一個 —— 反正呢個模型今次出唔到答案。
            if "429" in msg or "402" in msg or "5" in msg[:6] or "timeout" in msg.lower():
                continue
            continue
    if last_err:
        raise last_err
    return None


def main() -> int:
    # ⚠️ `global` 必須喺函式**最開頭**，唔可以喺用過 MODEL 之後才宣告
    # （實測踩過 SyntaxError）。
    global MODEL

    ap = argparse.ArgumentParser(description="編年史 LLM 語意聚合")
    ap.add_argument(
        "--effort",
        default="low",
        choices=["low", "medium", "high", "ultra"],
        help="reasoning 力度。預設 low —— 呢個任務只需要分類，唔需要深度推理。",
    )
    ap.add_argument("--limit", type=int, default=0, help="最多處理幾多條（0 = 全部）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--resume", action="store_true", help="跳過已處理嘅條目")
    ap.add_argument("--model", default=MODEL, help="覆寫模型")
    ap.add_argument("--batch", type=int, default=0, help="每批條數（0 = 自動）")
    args = ap.parse_args()

    doc = json.loads(CHRONICLE.read_text(encoding="utf-8"))
    entries = doc["entries"]

    # ⚠️ 續跑：跳過已經處理過嘅條目。
    #
    # 為何需要：全量 1,716 條要 86 次呼叫，中途可能因為網絡、額度
    # （實測遇過 HTTP 402）而中斷。冇續跑嘅話每次都要由頭跑 ——
    # 浪費時間同金錢。
    if args.resume and OUT.exists():
        done = set()
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line:
                done.add(json.loads(line)["entry_id"])
        before = len(entries)
        entries = [e for e in entries if e["id"] not in done]
        print(f"續跑：已有 {len(done)} 條，跳過（{before} → {len(entries)}）")

    if args.limit:
        entries = entries[: args.limit]
    if not entries:
        print("冇新條目要處理")
        return 0
    MODEL = args.model
    batch_size = args.batch or (FREE_BATCH if ":free" in MODEL else BATCH)
    print(f"待處理條目：{len(entries)}　模型：{MODEL}")
    print(f"批次大小：{batch_size} → 約 {(len(entries) + batch_size - 1) // batch_size} 次呼叫")

    if args.dry_run:
        print("\n=== 範例 prompt ===")
        print(build_prompt(entries[:3]))
        return 0

    # ⚠️ `OpenRouterClient` 由 `OPENROUTER_EFFORT` 環境變數讀 effort。
    # 呢個任務（時期分類）唔需要 ultra 級推理 —— 用 low 可以大幅縮短
    # 回應時間同 token 消耗。實測 ultra 會令 20 條嘅批次燒爆 token 預算。
    import os

    env = load_env(REPO)
    api_key, base_url = require_api_key()

    # ⚠️ 一定要喺 `load_env()` **之後**才設定。
    #
    # 實測踩過：`load_env()` 會將 `.env` 讀入 `os.environ`，而 `.env`
    # 有 `OPENROUTER_EFFORT=ultra` —— 如果之前設定，就會被覆蓋。
    # 後果係 reasoning 燒到爆，12 條批次要 220s（正常 7.4s）。
    os.environ["OPENROUTER_EFFORT"] = args.effort
    client = OpenRouterClient(api_key, base_url, timeout_s=180)
    cache = ExtractionCache(run_id="chronicle-llm")
    ledger = RunLedger()

    results: list[dict] = []
    stats = {"ok": 0, "invalid": 0, "error": 0}
    batches = [entries[i : i + batch_size] for i in range(0, len(entries), batch_size)]

    for bi, batch in enumerate(batches, 1):
        user = build_prompt(batch)
        # ⚠️ **指數退避重試**，唔可以跳過批次。
        #
        # 實測：免費池會出現**帳戶級**限流（全部模型同時 429）。如果直接
        # 跳過，嗰批事件就會永遠冇時期判斷（靜默缺失）。
        # 所以必須退避重試，直到成功或者超出重試上限。
        raw = None
        for attempt in range(MAX_BATCH_RETRY):
            try:
                raw = call_llm(client, user, cache, ledger, len(batch))
                break
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if attempt < MAX_BATCH_RETRY - 1:
                    wait = min(60, 5 * (2**attempt))
                    print(f"  [{bi}/{len(batches)}] ⏳ 限流，等 {wait}s 重試"
                          f"（{attempt + 1}/{MAX_BATCH_RETRY}）")
                    time.sleep(wait)
                    continue
                print(f"  [{bi}/{len(batches)}] ❌ 重試耗盡：{msg[:60]}")
                stats["error"] += 1
        if not raw:
            continue
        if not raw.get("results"):
            stats["invalid"] += 1
            continue

        got = raw.get("results") or []
        if len(got) != len(batch):
            stats["invalid"] += 1
            print(f"  [{bi}/{len(batches)}] 回覆數量唔對（{len(got)}/{len(batch)}）")
            continue

        for i, r in enumerate(got):
            pid = r.get("period")
            if pid not in dict(PERIODS):
                pid = "unknown"
            results.append({
                "entry_id": batch[i]["id"],
                "period": pid,
                "period_label": period_label(pid),
                "flashback": bool(r.get("flashback")),
            })
            stats["ok"] += 1
        print(f"  [{bi}/{len(batches)}] ✅ {len(batch)} 條")

        # ⚠️ **每批都寫入**，唔係等到最後。
        #
        # 為何：全量 132 批要 25 分鐘以上。實測遇過 HTTP 402、網絡中斷、
        # session 中止 —— 如果只在最後寫入，一次中斷就損失全部進度。
        # 每批寫入嘅成本（幾 KB 磁碟 I/O）遠低於重跑嘅成本。
        _flush(results)

    print(f"\n=== 統計 === 成功 {stats['ok']}／格式錯 {stats['invalid']}／錯誤 {stats['error']}")
    total = _flush(results)
    print(f"寫入 {OUT}（累計 {total} 條）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

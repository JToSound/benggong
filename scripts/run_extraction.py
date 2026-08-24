#!/usr/bin/env python3
"""《病港》Phase B — 全書 extraction runner。

前置條件（全部滿足先會發 LLM 請求）：
1. cleaning pipeline 已標記 human-sampled-approved（cleaning-approval.json）
2. OPENROUTER_API_KEY 已設定（.env 或環境變數）

行為：
- 只讀 data/private/cleaned/bing-gang.clean.jsonl
- 章節升序、逐段處理；strict JSON；temperature 0.1；retry ≤2；cache 續跑
- candidates 寫入 data/private/evidence/candidates.jsonl（私有）
- ledger 寫入 data/private/review/extraction-ledger.jsonl（只記 metadata+hash）

用法：
    python scripts/run_extraction.py --dry-run          # 只計算分段，唔呼叫 API
    python scripts/run_extraction.py --chapters 1-5     # 先細範圍試行
    python scripts/run_extraction.py                    # 全書 1-198
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from extraction_core import (  # noqa: E402
    CACHE_DIR,
    EXTRACTION_TEMPERATURE,
    PRIVATE_DIR,
    REPO_ROOT,
    CandidateStore,
    ExtractionCache,
    ExtractionConfigError,
    OpenRouterClient,
    RunLedger,
    build_segments,
    call_with_retry,
    iter_cleaned_rows,
    load_env,
    now_iso,
    require_api_key,
)
from extraction_prompts import EXTRACTION_SYSTEM_PROMPT, EXTRACTION_USER_TEMPLATE  # noqa: E402
from novel_lib import SCHEMA_VERSION  # noqa: E402


def parse_chapter_range(spec: str) -> list[int]:
    if not spec:
        return list(range(1, 199))
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            lo, _, hi = part.partition("-")
            out.update(range(int(lo), int(hi) + 1))
        else:
            out.add(int(part))
    return sorted(i for i in out if 1 <= i <= 198)


def approval_ok() -> bool:
    p = PRIVATE_DIR / "review/cleaning-approval.json"
    if not p.exists():
        return False
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        return doc.get("status") == "human-sampled-approved"
    except (json.JSONDecodeError, OSError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase B extraction runner")
    parser.add_argument("--chapters", help="章節範圍，如 '1-5' 或 '1,3,7'；預設全書")
    parser.add_argument("--dry-run", action="store_true", help="只計算分段統計，唔呼叫 API")
    parser.add_argument("--model", help="覆蓋 extraction model id")
    args = parser.parse_args()

    env = load_env()
    model = (
        args.model
        or os_model(env)
    )

    # ---- 前置檢查 ----
    if not approval_ok():
        print("[error] cleaning pipeline 未標記 human-sampled-approved（data/private/review/cleaning-approval.json）")
        return 2

    chapters_wanted = set(parse_chapter_range(args.chapters or ""))

    if args.dry_run:
        total_segs = 0
        total_chars = 0
        per_chapter: list[tuple[int, int]] = []
        for idx, num, content in iter_cleaned_rows():
            if idx not in chapters_wanted:
                continue
            segs = build_segments(idx, content)
            total_segs += len(segs)
            total_chars += sum(len(s.text) for s in segs)
            per_chapter.append((idx, len(segs)))
        multi = [(i, n) for i, n in per_chapter if n > 1]
        print(f"[dry-run] 範圍：{len(per_chapter)} 章 → {total_segs} 段，共 {total_chars:,} 字符")
        print(f"模型（將使用）：{model or '(未設定 OPENROUTER_EXTRACTION_MODEL，執行時需 --model）'}")
        print(f"溫度：{EXTRACTION_TEMPERATURE}；schema {SCHEMA_VERSION}")
        print(f"需要切分嘅章節（>1 段）：{multi[:10]}{'…' if len(multi) > 10 else ''}")
        print(f"cache 目錄：{CACHE_DIR}")
        print("未發送任何請求。")
        return 0

    # ---- 真實 run ----
    try:
        api_key, base_url = require_api_key()
    except ExtractionConfigError as e:
        print(f"[blocked] {e}")
        return 3
    if not model:
        print("[blocked] 未設定 OPENROUTER_EXTRACTION_MODEL（.env）亦無 --model 參數。")
        return 3

    run_id = f"run_{now_iso().replace(':', '').replace('-', '')}"
    client = OpenRouterClient(api_key=api_key, base_url=base_url)
    cache = ExtractionCache(run_id=run_id)
    ledger = RunLedger()
    store = CandidateStore()
    done = ledger.completed_keys()

    cand_seq = 0
    ok_segs = err_segs = queue_segs = 0
    t0 = time.time()

    for idx, chapter_num, content in iter_cleaned_rows():
        if idx not in chapters_wanted:
            continue
        segments = build_segments(idx, content)
        for seg in segments:
            key = f"{idx}:{seg.segment_index}"
            if key in done:
                ok_segs += 1
                continue
            user_prompt = EXTRACTION_USER_TEMPLATE.format(
                chapter=idx,
                chapter_num=chapter_num,
                segment_index=seg.segment_index,
                segment_total=len(segments),
                text=seg.text,
            )
            parsed, status = call_with_retry(
                client=client,
                model=model,
                system_prompt=EXTRACTION_SYSTEM_PROMPT,
                user_prompt=user_prompt,
                cache=cache,
                ledger=ledger,
                chapter=idx,
                segment_index=seg.segment_index,
                schema_version=SCHEMA_VERSION,
            )
            if status != "ok" or parsed is None:
                err_segs += status == "error"
                queue_segs += status == "invalid_schema_review_queue"
                continue
            ok_segs += 1
            for c in parsed.get("candidates", []):
                cand_seq += 1
                store.append(
                    {
                        "candidate_id": f"c_{cand_seq:05d}",
                        "run_id": run_id,
                        "chapter": idx,
                        "segment_index": seg.segment_index,
                        "entity_kind": c.get("entity_kind"),
                        "name": c.get("name"),
                        "claim": c.get("claim"),
                        "evidence_excerpt": c.get("evidence_excerpt"),
                        "confidence": c.get("confidence"),
                        "spoiler_level": c.get("spoiler_level"),
                        "location_type": c.get("location_type"),
                        "fictional": c.get("fictional"),
                        "aliases": c.get("aliases"),
                        "status": "pending",
                        "needs_review_reasons": [],
                        "model_meta": {
                            "model_id": model,
                            "temperature": EXTRACTION_TEMPERATURE,
                            "prompt_hash": seg.prompt_hash[:64],
                            "schema_version": SCHEMA_VERSION,
                        },
                    }
                )
        print(
            f"\r第 {idx} 章完成（累計 ok={ok_segs} err={err_segs} review_queue={queue_segs} "
            f"candidates={cand_seq}）",
            end="",
            flush=True,
        )
        time.sleep(0.5)  # polite rate limit

    print()
    summary = {
        "run_id": run_id,
        "finished_at": now_iso(),
        "model": model,
        "chapters_requested": len(chapters_wanted),
        "segments_ok": ok_segs,
        "segments_error": err_segs,
        "segments_review_queue": queue_segs,
        "candidates_total": cand_seq,
        "elapsed_s": round(time.time() - t0, 1),
    }
    (PRIVATE_DIR / "review/extraction-last-run.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if err_segs == 0 else 1


def os_model(env: dict[str, str]) -> str:
    import os

    return os.environ.get("OPENROUTER_EXTRACTION_MODEL") or env.get("OPENROUTER_EXTRACTION_MODEL", "")


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""《病港》Phase B 前置 — 私有人手審閱抽樣器。

由 cleaned JSONL 建立 stratified review sample，並輸出私有 packet：
  data/private/review/manual-review-packet.md
  data/private/review/review-sample.json（機讀清單，供後續 pipeline 用）

抽樣規則（deterministic，seed 固定）：
  - 早期 1–20 抽 5；中期 21–130 抽 7；後期 131–198 抽 5
  - 31 章短章 warning 按字數升序抽 8
  - 重複補足至最少 25 個獨立 issue

⚠️ 本 script 輸出只寫入 data/private/，永不 commit。
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from novel_lib import SCHEMA_VERSION, compute_word_count, parse_jsonl, sha256_of_file  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CLEANED = REPO_ROOT / "data/private/cleaned/bing-gang.clean.jsonl"
DEFAULT_VALIDATION = REPO_ROOT / "data/private/review/validation-report.json"
DEFAULT_OUT = REPO_ROOT / "data/private/review/manual-review-packet.md"
DEFAULT_SAMPLE_JSON = REPO_ROOT / "data/private/review/review-sample.json"

STRATA = [
    ("早期（issue 1–20）", range(1, 21), 5),
    ("中期（issue 21–130）", range(21, 131), 7),
    ("後期（issue 131–198）", range(131, 199), 5),
]
SHORT_CHAPTER_SAMPLE_N = 8
MIN_TOTAL_UNIQUE = 25
HEAD_CHARS = 500
TAIL_CHARS = 500


def load_warnings(validation_path: Path) -> dict[int, list[dict]]:
    if not validation_path.exists():
        return {}
    report = json.loads(validation_path.read_text(encoding="utf-8"))
    out: dict[int, list[dict]] = {}
    for w in report.get("warnings", []):
        out.setdefault(w["chapter"], []).append(w)
    return out


def pick_stratified(rows_by_idx: dict[int, dict]) -> tuple[list[tuple[str, list[int]]], set[int]]:
    rng = random.Random(20260824)  # deterministic seed
    picked: list[tuple[str, list[int]]] = []
    used: set[int] = set()
    for label, span, n in STRATA:
        pool = [i for i in span if i in rows_by_idx]
        chosen = sorted(rng.sample(pool, min(n, len(pool))))
        picked.append((label, chosen))
        used.update(chosen)
    return picked, used


def main() -> int:
    parser = argparse.ArgumentParser(description="私有人手審閱抽樣器")
    parser.add_argument("--cleaned", default=str(DEFAULT_CLEANED))
    parser.add_argument("--validation-report", default=str(DEFAULT_VALIDATION))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    cleaned_path = Path(args.cleaned)
    validation_path = Path(args.validation_report)
    out_path = Path(args.out)
    sample_json_path = Path(args.sample_json) if hasattr(args, "sample_json") else DEFAULT_SAMPLE_JSON

    rows = parse_jsonl(cleaned_path)
    rows_by_idx = {r["issue_index"]: r for r in rows}
    warnings = load_warnings(validation_path)

    short_chapters = sorted(
        (
            (w["chapter"], w["word_count"])
            for ws in warnings.values()
            for w in ws
            if w["type"] == "word_count_deviation"
        ),
        key=lambda x: (x[1], x[0]),
    )
    short_sample = [i for i, _ in short_chapters[:SHORT_CHAPTER_SAMPLE_N]]

    stratified, used = pick_stratified(rows_by_idx)

    # 補足至最少 25 個獨立 issue：以「聯集」實際大小判斷（分層同短章可能重疊）
    extra: list[int] = []
    all_indices = sorted(rows_by_idx.keys())
    rng = random.Random(20260824 + 1)
    remaining = [i for i in all_indices if i not in used and i not in short_sample]
    while len(set(used) | set(short_sample) | set(extra)) < MIN_TOTAL_UNIQUE and remaining:
        pick = rng.choice(remaining)
        remaining.remove(pick)
        extra.append(pick)

    final_sorted = sorted(set(used | set(short_sample) | set(extra)))

    lines: list[str] = []
    add = lines.append
    add("# 《病港》清理結果人手審閱 Packet")
    add("")
    add(f"> 產生時間：{datetime.now(timezone.utc).isoformat(timespec='seconds')}　|　schema {SCHEMA_VERSION}")
    add(f"> 來源：`{cleaned_path.relative_to(REPO_ROOT)}`（SHA-256 `{sha256_of_file(cleaned_path)[:16]}…`）")
    add("> **本檔案含小說節錄，屬私有 material：不得 commit、不得部署。**")
    add("")
    add("## 審閱前必讀")
    add("")
    add("準則同 FAIL 處理流程見 `manual-review-checklist.md`。每章請喺表格填：`PASS` / `FAIL` / `不確定`，並加粵文 note。")
    add("")
    add("## 抽樣結構")

    total_n = len(final_sorted)
    add("")
    add(f"合共 **{total_n}** 個獨立 issue（要求 ≥{MIN_TOTAL_UNIQUE}）。")
    add("")
    for label, chosen in stratified:
        add(f"- {label}（抽 {len(chosen)}）：{chosen}")
    add(f"- 短章 warning 按字數升序抽 {len(short_sample)}：{short_sample}")
    add(f"- 隨機補足（去重後）：{sorted(set(extra)) or '無'}")
    add("")

    def chapter_block(idx: int) -> None:
        row = rows_by_idx[idx]
        content = row["content"]
        wc = compute_word_count(content)
        raw_wc = row.get("raw_word_count") or wc
        ratio = raw_wc / wc if wc else 0
        head = content[:HEAD_CHARS].replace("\n", "⏎\n")
        tail = content[-TAIL_CHARS:].replace("\n", "⏎\n")
        warns = warnings.get(idx, [])
        add("---")
        add("")
        add(f"## 第 {idx} 章 — {row['chapter_num']}")
        add("")
        add("| 清理後字數 | 原始字數 | raw/clean 比率 | URL |")
        add("|---|---|---|---|")
        add(f"| {wc:,} | {raw_wc:,} | {ratio:.3f} | {row['url']} |")
        add("")
        if warns:
            add("**本章 warning**：")
            for w in warns:
                add(f"- `{w['type']}`：字數 {w.get('word_count', '—')}（中位數 {w.get('median', '—')}）")
            add("")
        add(f"**開頭 {HEAD_CHARS} 字**：")
        add("")
        add(head)
        add("")
        add(f"**結尾 {TAIL_CHARS} 字**：")
        add("")
        add(tail)
        add("")
        add("**審查項目**（準則見 checklist）：")
        add("")
        add("| 項目 | 內容 | 結論 |")
        add("|---|---|---|")
        add("| a | 開頭由正文開始，而非網站 UI | ☐ PASS ☐ FAIL ☐ 不確定 |")
        add("| b | 中段無版權雜訊／亂碼 | ☐ PASS ☐ FAIL ☐ 不確定 |")
        add("| c | 結尾未被讀者名單／介面污染 | ☐ PASS ☐ FAIL ☐ 不確定 |")
        add("| d | 正文無明顯被截斷 | ☐ PASS ☐ FAIL ☐ 不確定 |")
        add("| e | 章節標題與內容一致 | ☐ PASS ☐ FAIL ☐ 不確定 |")
        add("")
        add("**總體評定**：☐ PASS　☐ FAIL　☐ 不確定")
        add("")
        add("**Review note（粵文）**：")
        add("")
        add("```")
        add("")
        add("```")
        add("")

    add("## 逐章審閱")
    add("")
    for idx in final_sorted:
        chapter_block(idx)

    out_path.write_text("\n".join(lines), encoding="utf-8")

    # 機讀樣本清單（private）
    sample_doc = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "cleaned_sha256": sha256_of_file(cleaned_path),
        "stratified": {label: chosen for label, chosen in stratified},
        "short_warning_sample": short_sample,
        "filler": sorted(set(extra)),
        "final_sample": final_sorted,
        "count": len(final_sorted),
    }
    sample_json_path.write_text(
        json.dumps(sample_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"Packet：{out_path}")
    print(f"樣本清單：{sample_json_path}")
    print(f"抽樣：{total_n} 章 = 分層 {sum(len(c) for _, c in stratified)} + 短章 {len(short_sample)} + 補足 {len(set(extra))}（去重後）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

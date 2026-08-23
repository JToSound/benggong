#!/usr/bin/env python3
"""《病港》Phase B 前置 — 短章 warning 統計分析。

對 validation-report 入面全部 word_count_deviation warning 章節產生：
- 字數、段落數、句子數估算
- 首尾各 120 字（僅供私審閱用）
- raw/clean ratio
- 全體分布統計（min/median/max、直方圖）

輸出：data/private/review/short-chapter-analysis.md（私有，不得 commit）
唔會輸出任何一章全文。

用法：python scripts/analyze_short_chapters.py [--validation-report PATH] [--cleaned PATH]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from novel_lib import SCHEMA_VERSION, compute_word_count, parse_jsonl, sha256_of_file  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CLEANED = REPO_ROOT / "data/private/cleaned/bing-gang.clean.jsonl"
DEFAULT_VALIDATION = REPO_ROOT / "data/private/review/validation-report.json"
DEFAULT_OUT = REPO_ROOT / "data/private/review/short-chapter-analysis.md"
SNIPPET_CHARS = 120


def main() -> int:
    parser = argparse.ArgumentParser(description="短章 warning 統計分析")
    parser.add_argument("--cleaned", default=str(DEFAULT_CLEANED))
    parser.add_argument("--validation-report", default=str(DEFAULT_VALIDATION))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    cleaned_path = Path(args.cleaned)
    validation_path = Path(args.validation_report)
    out_path = Path(args.out)

    if not validation_path.exists():
        print(f"[error] 搵唔到 {validation_path}，請先跑 validate_novel.py")
        return 1

    rows_by_idx = {r["issue_index"]: r for r in parse_jsonl(cleaned_path)}
    report = json.loads(validation_path.read_text(encoding="utf-8"))
    warned = sorted(
        (w["chapter"], w["word_count"]) for w in report["warnings"]
        if w["type"] == "word_count_deviation"
    )
    if not warned:
        print("無短章 warning，無需分析。")
        return 0

    all_wc = [compute_word_count(r["content"]) for r in rows_by_idx.values()]
    global_median = statistics.median(all_wc)

    lines: list[str] = []
    add = lines.append
    add("# 《病港》短章 Warning 分析（私有）")
    add("")
    add(f"> 產生時間：{datetime.now(timezone.utc).isoformat(timespec='seconds')}　|　schema {SCHEMA_VERSION}")
    add(f"> cleaned SHA-256：`{sha256_of_file(cleaned_path)[:16]}…`")
    add("> **本檔案含小說節錄，屬私有 material：不得 commit、不得部署。**")
    add("")
    add("## 全書分布")
    add("")
    add(f"- 總章數：{len(all_wc)}；中位數：{global_median:,.0f}；平均：{statistics.mean(all_wc):,.0f}")
    add(f"- 最短：{min(all_wc):,}；最長：{max(all_wc):,}")
    quartiles = statistics.quantiles(all_wc, n=4)
    add(f"- 四分位：Q1={quartiles[0]:,.0f}／Q2={quartiles[1]:,.0f}／Q3={quartiles[2]:,.0f}")
    add("")
    add("## 短章 warning 分布")

    n = len(warned)
    add("")
    add(f"共 **{n}** 章。字數區間分布：")
    buckets = [(0, 500), (500, 1000), (1000, 1500), (1500, 2000), (2000, 2500)]
    add("")
    add("| 區間 | 章數 |")
    add("|---|---|")
    for lo, hi in buckets:
        c = sum(1 for _, w in warned if lo <= w < hi)
        add(f"| {lo:,}–{hi:,} | {c} |")
    sm = [w for _, w in warned]
    add(f"\nWarning 組內：最短 {min(sm):,}／中位數 {statistics.median(sm):,.0f}／最長 {max(sm):,}")
    add(f"佔全書比例：{n}/{len(all_wc)}（{n/len(all_wc)*100:.1f}%）")
    add("")

    # 直方圖（文字版）
    add("## 字數直方圖（全書，每格 500 字）")
    add("")
    max_wc = max(all_wc)
    n_buckets = -(-max_wc // 500)  # ceil division
    hist_buckets = [(lo, lo + 500) for lo in range(0, int(n_buckets) * 500, 500)]
    max_bar = 40
    counts_all = [sum(1 for w in all_wc if lo <= w < hi) for lo, hi in hist_buckets]
    peak = max(counts_all) or 1
    for (lo, hi), c in zip(hist_buckets, counts_all):
        if c == 0:
            continue
        bar = "█" * max(1, round(c / peak * max_bar))
        warn_c = sum(1 for _, w in warned if lo <= w < hi)
        mark = f"（其中 warning {warn_c}）" if warn_c else ""
        add(f"{lo:>5,}–{hi:>5,} │ {bar} {c}{mark}")
    add("")

    add("## 逐章明細（按字數升序）")
    add("")
    for idx, wc in warned:
        row = rows_by_idx.get(idx)
        if not row:
            add(f"### 第 {idx} 章 — ⚠️ 喺 cleaned 檔搵唔到！")
            continue
        content = row["content"]
        paragraphs = [p for p in content.split("\n") if p.strip()]
        sentences = content.count("。") + content.count("！」") + content.count("？」")
        raw_wc = row.get("raw_word_count") or wc
        head = content[:SNIPPET_CHARS].replace("\n", "⏎")
        tail = content[-SNIPPET_CHARS:].replace("\n", "⏎")
        add("---")
        add("")
        add(f"### 第 {idx} 章 — {row['chapter_num']}")
        add("")
        add("| 清理後字數 | 段落數 | 句數(約) | 原始字數 | raw/clean | 距中位數 |")
        add("|---|---|---|---|---|---|")
        add(
            f"| {wc:,} | {len(paragraphs)} | {sentences} | {raw_wc:,} "
            f"| {raw_wc/wc:.2f} | {wc/global_median*100:.0f}% |"
        )
        add("")
        add(f"- **首 {SNIPPET_CHARS} 字**：`{head}`")
        add(f"- **尾 {SNIPPET_CHARS} 字**：`{tail}`")
        add("- 審閱重點：呢章係咪完整獨立段落（例如番外／過場），定係有被誤刪跡象？")
        add("")

    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"報告：{out_path}")
    print(f"分析咗 {n} 個 short-chapter warning；全文無被輸出。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

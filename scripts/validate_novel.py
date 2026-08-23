#!/usr/bin/env python3
"""《病港》Phase A — 清理結果驗證器。

檢查 cleaned JSONL：
- 有且只有 198 章，index 完整 1..198
- 無任何已知 Penana 雜訊（No Plagiarism / copyright protection /
  Please respect copyright / IP pattern / And N More / UI token）
- 每章字數 > 30；偏離中位數太大出 warning
- CJK / Latin / punctuation ratio 異常偵測
- content hash duplicate 偵測
- invalid Unicode / 不可見 control chars

用法：
    python scripts/validate_novel.py [--cleaned PATH] [--report PATH] [--if-present]

Exit code：0 = 全部通過；1 = 有 error；2 = 只有 warning。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from novel_lib import (  # noqa: E402
    CLEAN_RULES_VERSION,
    SCHEMA_VERSION,
    compute_word_count,
    parse_jsonl,
    sha256_of_file,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CLEANED = REPO_ROOT / "data/private/cleaned/bing-gang.clean.jsonl"
DEFAULT_REPORT = REPO_ROOT / "data/private/review/validation-report.json"

EXPECTED_CHAPTERS = list(range(1, 199))

# ---- 雜訊殘留偵測（全部都係 error）----
NOISE_PATTERNS: dict[str, re.Pattern[str]] = {
    "no_plagiarism": re.compile(r"No Plagiarism", re.IGNORECASE),
    "copyright_protection": re.compile(r"copyright protection", re.IGNORECASE),
    "respect_copyright": re.compile(r"Please respect copyright", re.IGNORECASE),
    "penana_token": re.compile(r"[PＰ][EＥ][NＮ][AＡ][NＮ][AＡ]"),
    "ip_pattern": re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"),
    "ns_da": re.compile(r"\bns\d{1,3}(?:\.\d{1,3}){3}\s*da\d*\b"),
    "and_n_more": re.compile(r"And\s+\d+\s+More", re.IGNORECASE),
}

# ---- UI token 殘留（error）----
UI_TOKENS = (
    "上一章",
    "下一章",
    "後一篇 >",
    "前一篇 <",
    "書籤!",
    "format_color_text",
    "open_in_full",
    "arrow_back_ios_new",
    "arrow_forward_ios",
    "posted on P",
    "login with facebook",
)

MIN_WORDS = 30
WORD_DEVIATION_WARN = 0.55  # 字數低過中位數 55% 出 warning


def check_chapter(row: dict) -> tuple[list[dict], list[dict]]:
    """單章檢查。回傳（errors, warnings）。"""
    errors: list[dict] = []
    warnings: list[dict] = []
    idx = row.get("issue_index")
    content = row.get("content", "")

    # 雜訊殘留
    for name, pattern in NOISE_PATTERNS.items():
        m = pattern.search(content)
        if m:
            ctx_start = max(0, m.start() - 30)
            errors.append(
                {
                    "chapter": idx,
                    "type": f"noise_{name}",
                    "context": content[ctx_start : m.end() + 30].replace("\n", "\\n"),
                }
            )

    # UI token
    for tok in UI_TOKENS:
        if tok in content:
            pos = content.find(tok)
            errors.append(
                {
                    "chapter": idx,
                    "type": "ui_token",
                    "token": tok,
                    "context": content[max(0, pos - 25) : pos + len(tok) + 25].replace("\n", "\\n"),
                }
            )

    # 字數下限
    wc = compute_word_count(content)
    if wc <= MIN_WORDS:
        errors.append(
            {"chapter": idx, "type": "word_count_too_low", "word_count": wc, "threshold": MIN_WORDS}
        )
    row["_wc"] = wc

    # control chars（除咗 \n \r \t）
    bad_chars = [
        (m.start(), hex(ord(m.group(0))))
        for m in re.finditer(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", content)
    ]
    if bad_chars:
        errors.append({"chapter": idx, "type": "control_chars", "positions": bad_chars[:10]})

    # invalid unicode（surrogates）
    try:
        content.encode("utf-8")
    except UnicodeEncodeError as e:
        errors.append({"chapter": idx, "type": "invalid_unicode", "detail": str(e)})

    return errors, warnings


def ratio_checks(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """全書統計檢查：字數分佈、CJK/Latin/punct ratio、hash duplicates。"""
    errors: list[dict] = []
    warnings: list[dict] = []

    wcs = [r["_wc"] for r in rows]
    median_wc = statistics.median(wcs)

    cjk_re = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
    latin_re = re.compile(r"[A-Za-z]")
    punct_re = re.compile(r"[^\w\s\u3400-\u4dbf\u4e00-\u9fff]", re.UNICODE)

    hashes: dict[str, int] = {}
    for r in rows:
        content = r["content"]
        n = max(1, compute_word_count(content))
        cjk_ratio = len(cjk_re.findall(content)) / n
        latin_ratio = len(latin_re.findall(content)) / n
        punct_ratio = len(punct_re.findall(content)) / n

        if r["_wc"] < median_wc * WORD_DEVIATION_WARN:
            warnings.append(
                {
                    "chapter": r["issue_index"],
                    "type": "word_count_deviation",
                    "word_count": r["_wc"],
                    "median": median_wc,
                }
            )
        if cjk_ratio + latin_ratio < 0.5:
            warnings.append(
                {
                    "chapter": r["issue_index"],
                    "type": "low_text_ratio",
                    "cjk_ratio": round(cjk_ratio, 3),
                    "latin_ratio": round(latin_ratio, 3),
                }
            )
        if punct_ratio > 0.35:
            warnings.append(
                {"chapter": r["issue_index"], "type": "high_punctuation", "ratio": round(punct_ratio, 3)}
            )

        h = hashlib.sha256(r["content"].encode("utf-8")).hexdigest()
        if h in hashes and hashes[h] != r["issue_index"]:
            errors.append(
                {
                    "chapter": r["issue_index"],
                    "type": "duplicate_content_hash",
                    "duplicate_of": hashes[h],
                }
            )
        else:
            hashes[h] = r["issue_index"]

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="《病港》清理結果驗證器")
    parser.add_argument("--cleaned", help="cleaned JSONL 路徑")
    parser.add_argument("--report", help="驗證報告輸出路徑")
    parser.add_argument(
        "--if-present",
        action="store_true",
        help="如 cleaned 檔案唔存在，exit 0 並跳過（CI 用）",
    )
    args = parser.parse_args()

    cleaned_path = Path(args.cleaned) if args.cleaned else DEFAULT_CLEANED
    report_path = Path(args.report) if args.report else DEFAULT_REPORT

    if not cleaned_path.exists():
        if args.if_present:
            print(f"[skip] {cleaned_path} 唔存在 -- --if-present 模式跳過")
            return 0
        print(f"[error] 搵唔到 {cleaned_path}。請先執行 scripts/clean_novel.py")
        return 1

    rows = parse_jsonl(cleaned_path)
    all_errors: list[dict] = []
    all_warnings: list[dict] = []

    # ---- 章節完整性 ----
    indices = [r.get("issue_index") for r in rows]
    expected_set = set(EXPECTED_CHAPTERS)
    actual_set = set(i for i in indices if isinstance(i, int))
    missing = sorted(expected_set - actual_set)
    extra = sorted(actual_set - expected_set)
    dupes = sorted({i for i in indices if indices.count(i) > 1})

    if missing:
        all_errors.append({"type": "missing_chapters", "chapters": missing})
    if extra:
        all_errors.append({"type": "unexpected_indices", "indices": extra})
    if dupes:
        all_errors.append({"type": "duplicate_issue_index", "indices": dupes})
    if 0 in actual_set:
        all_errors.append({"type": "issue0_present"})

    # ---- 逐章檢查 ----
    per_chapter = []
    for r in rows:
        errs, warns = check_chapter(r)
        all_errors.extend(errs)
        all_warnings.extend(warns)
        per_chapter.append(
            {
                "issue_index": r["issue_index"],
                "raw_word_count": r.get("raw_word_count"),
                "clean_word_count": r["_wc"],
                "removed_chars": (r.get("raw_word_count") or r["_wc"]) - r["_wc"]
                if r.get("raw_word_count")
                else None,
                "sha256": hashlib.sha256(r["content"].encode("utf-8")).hexdigest(),
                "errors": errs,
                "warnings": warns,
            }
        )

    # ---- 全書統計 ----
    stat_errs, stat_warns = ratio_checks(rows)
    all_errors.extend(stat_errs)
    all_warnings.extend(stat_warns)

    # ---- 報告 ----
    report = {
        "schema_version": SCHEMA_VERSION,
        "rules_version": CLEAN_RULES_VERSION,
        "validated_file": str(cleaned_path),
        "file_sha256": sha256_of_file(cleaned_path),
        "run_timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": {
            "chapters": len(rows),
            "expected": 198,
            "errors": len(all_errors),
            "warnings": len(all_warnings),
            "median_word_count": statistics.median([r["_wc"] for r in rows]) if rows else 0,
            "total_clean_words": sum(r["_wc"] for r in rows),
        },
        "structure": {"missing": missing, "extra": extra, "duplicates": dupes},
        "per_chapter": per_chapter,
        "errors": all_errors,
        "warnings": all_warnings,
    }

    report_path.parent.mkdir(parents=True, exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    s = report["summary"]
    print(f"驗證：{s['chapters']}/198 章；errors={s['errors']} warnings={s['warnings']}")
    print(f"中位數字數：{s['median_word_count']}；總字數：{s['total_clean_words']:,}")
    if all_errors:
        print("錯誤明細（頭 10）：")
        for e in all_errors[:10]:
            print(f"  - {json.dumps(e, ensure_ascii=False)[:160]}")
    if all_warnings:
        print(f"Warning 明細（頭 10 / 共 {len(all_warnings)}）：")
        for w in all_warnings[:10]:
            print(f"  - {json.dumps(w, ensure_ascii=False)[:160]}")
    print(f"報告：{report_path}")

    if all_errors:
        return 1
    if all_warnings:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

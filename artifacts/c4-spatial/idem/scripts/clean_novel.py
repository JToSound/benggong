#!/usr/bin/env python3
"""《病港》Phase A — 正文清理器。

由 data/private/raw/ 讀取 canonical JSONL，套用 versioned regex rules，
輸出 cleaned JSONL / Markdown、cleaning report、input manifest。

用法：
    python scripts/clean_novel.py [--raw PATH] [--out-dir PATH]

預設：
    --raw      data/private/raw/Bing-Gang-_full.jsonl
    --out-dir  data/private/（cleaned/ 與 review/ 子目錄）
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# 讓 script 可以直接執行（import 同目錄 novel_lib）
sys.path.insert(0, str(Path(__file__).parent))
from novel_lib import (  # noqa: E402
    CLEAN_RULES_VERSION,
    SCHEMA_VERSION,
    CleanStats,
    clean_content,
    compute_word_count,
    parse_jsonl,
    sha256_of_file,
    validate_raw_row,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = REPO_ROOT / "data/private/raw/Bing-Gang-_full.jsonl"
DEFAULT_OUT = REPO_ROOT / "data/private"
VALID_INDEX_RANGE = range(1, 199)  # issue 1..198


def get_git_commit() -> str:
    """攞目前 git commit hash；失敗回 'unknown'。"""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            timeout=10,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return "unknown"


def auto_detect_and_stage(raw_arg: str | None) -> tuple[Path, bool]:
    """Auto-detect Bing-Gang-_full.jsonl；如喺 root 或 user path 就複製入 raw/。

    回傳（最終 raw 路徑，是否複製咗）。
    """
    repo_root = REPO_ROOT
    default_path = DEFAULT_RAW

    # 已經有 staged copy 就直接用
    if default_path.exists():
        return default_path, False

    candidates: list[Path] = []
    if raw_arg:
        candidates.append(Path(raw_arg))
    candidates.append(repo_root / "Bing-Gang-_full.jsonl")
    # 常見外部來源：Desktop/病港/
    desktop_src = Path.home() / "Desktop" / "病港" / "Bing-Gang-_full.jsonl"
    candidates.append(desktop_src)

    for c in candidates:
        c = c.expanduser()
        if c.exists() and c.resolve() != default_path.resolve():
            default_path.parent.mkdir(parents=True, exist_ok=True)
            import shutil

            shutil.copy2(c, default_path)
            return default_path, True

    raise FileNotFoundError(
        "搵唔到 Bing-Gang-_full.jsonl。請將檔案放入 data/private/raw/ "
        "或者用 --raw 指定路徑。"
    )


def build_markdown(rows: list[dict]) -> str:
    """組合 cleaned Markdown。"""
    parts = [f"# 《病港》清理後全文（{CLEAN_RULES_VERSION}）\n"]
    for r in rows:
        parts.append(f"\n## 第 {r['issue_index']} 章 {r['chapter_num']}\n")
        parts.append(r["content"].strip())
        parts.append("")
    return "\n".join(parts)


def main() -> int:
    parser = argparse.ArgumentParser(description="《病港》正文清理器")
    parser.add_argument("--raw", help="原始 JSONL 路徑（可選；會自動 staging 入 raw/）")
    parser.add_argument("--out-dir", help="輸出根目錄（預設 data/private/）")
    args = parser_args = parser.parse_args()

    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUT
    cleaned_dir = out_dir / "cleaned"
    review_dir = out_dir / "review"
    cleaned_dir.mkdir(parents=True, exist_ok=True)
    review_dir.mkdir(parents=True, exist_ok=True)

    # ---- 1. staging ----
    raw_path, copied = auto_detect_and_stage(args.raw)
    print(f"[1/4] 原始檔：{raw_path}{'（已自動複製入 raw/）' if copied else ''}")

    # ---- 2. parse + per-chapter validation ----
    rows = parse_jsonl(raw_path)
    parse_errors: list[dict] = []
    skipped_issue0: list[int] = []
    seen_indices: dict[int, int] = {}
    duplicates: list[dict] = []

    kept_rows: list[dict] = []
    stats_list: list[CleanStats] = []

    for obj in rows:
        errs = validate_raw_row(obj)
        idx = obj.get("issue_index")
        if errs:
            parse_errors.append({"line": obj.get("_line_no"), "errors": errs})
            continue
        if idx == 0:
            skipped_issue0.append(obj["_line_no"])
            continue
        if not isinstance(idx, int):
            parse_errors.append(
                {"line": obj["_line_no"], "errors": [f"issue_index 唔係整數：{idx!r}"]}
            )
            continue
        if idx in seen_indices:
            duplicates.append(
                {"issue_index": idx, "lines": [seen_indices[idx], obj["_line_no"]]}
            )
            continue
        content = obj.get("content")
        if not isinstance(content, str) or len(content.strip()) == 0:
            parse_errors.append(
                {"line": obj["_line_no"], "errors": [f"第 {idx} 章 content 空白"]}
            )
            continue
        seen_indices[idx] = obj["_line_no"]

        # ---- 3. clean ----
        st = CleanStats(issue_index=idx)
        cleaned = clean_content(content, st)
        stats_list.append(st)
        kept_rows.append(
            {
                "story": obj["story"],
                "issue_index": idx,
                "chapter_num": obj["chapter_num"],
                "url": obj["url"],
                "content": cleaned,
                "word_count": compute_word_count(cleaned),
                "raw_word_count": compute_word_count(content),
            }
        )

    # ---- 4. write outputs ----
    run_ts = datetime.now(timezone.utc).isoformat(timespec="seconds")

    out_jsonl = cleaned_dir / "bing-gang.clean.jsonl"
    with open(out_jsonl, "w", encoding="utf-8") as f:
        for r in sorted(kept_rows, key=lambda x: x["issue_index"]):
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    out_md = cleaned_dir / "bing-gang.clean.md"
    with open(out_md, "w", encoding="utf-8") as f:
        f.write(build_markdown(sorted(kept_rows, key=lambda x: x["issue_index"])))

    total_removed = sum(s.removed_head_noise + s.removed_inline_noise + s.removed_footer for s in stats_list)
    report = {
        "schema_version": SCHEMA_VERSION,
        "rules_version": CLEAN_RULES_VERSION,
        "run_timestamp": run_ts,
        "git_commit": get_git_commit(),
        "input_file": str(raw_path.relative_to(REPO_ROOT)) if raw_path.is_relative_to(REPO_ROOT) else str(raw_path),
        "input_sha256": sha256_of_file(raw_path),
        "total_lines": len(rows),
        "kept_chapters": len(kept_rows),
        "skipped_issue0_lines": skipped_issue0,
        "duplicates": duplicates,
        "parse_errors": parse_errors,
        "stats_per_chapter": [
            {
                "issue_index": s.issue_index,
                "raw_chars": s.raw_chars,
                "clean_chars": s.clean_chars,
                "removed_chars": s.raw_chars - s.clean_chars,
                "removed_head_noise": s.removed_head_noise,
                "removed_inline_noise": s.removed_inline_noise,
                "footer_truncated": s.footer_truncated,
                "trailing_count_removed": s.trailing_count_removed,
                "warnings": s.warnings,
            }
            for s in stats_list
        ],
        "totals": {
            "chapters_with_footer_truncated": sum(1 for s in stats_list if s.footer_truncated),
            "chapters_with_trailing_counts_removed": sum(1 for s in stats_list if s.trailing_count_removed),
            "total_removed_chars": total_removed,
        },
    }

    report_json = review_dir / "cleaning-report.json"
    with open(report_json, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    # 人類可讀版
    lines = [
        "# 《病港》清理報告",
        "",
        f"- Run：{run_ts}",
        f"- Rules：{CLEAN_RULES_VERSION}（schema {SCHEMA_VERSION}）",
        f"- Input SHA-256：`{report['input_sha256']}`",
        f"- 總行數：{report['total_lines']}；保留章數：{report['kept_chapters']}",
        f"- Skip issue/0 行：{len(skipped_issue0)}",
        f"- Duplicates：{len(duplicates)}；Parse errors：{len(parse_errors)}",
        "",
        "## 總計",
        "",
        f"- Footer 截斷章數：{report['totals']['chapters_with_footer_truncated']}",
        f"- 移除結尾數字行章數：{report['totals']['chapters_with_trailing_counts_removed']}",
        f"- 總移除字符：{total_removed:,}",
        "",
        "## 逐章統計（頭尾各 5）",
        "",
        "| 章 | raw | clean | removed | footer | counts |",
        "|---|---|---|---|---|---|",
    ]
    sample = stats_list[:5] + stats_list[-5:] if len(stats_list) > 10 else stats_list
    for s in sample:
        lines.append(
            f"| {s.issue_index} | {s.raw_chars} | {s.clean_chars} | {s.raw_chars - s.clean_chars} | {'✓' if s.footer_truncated else ''} | {'✓' if s.trailing_count_removed else ''} |"
        )
    report_md = review_dir / "cleaning-report.md"
    with open(report_md, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    # input manifest
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": run_ts,
        "pipeline_git_commit": report["git_commit"],
        "inputs": {
            "Bing-Gang-_full.jsonl": {
                "sha256": report["input_sha256"],
                "bytes": raw_path.stat().st_size,
                "role": "canonical_raw_input",
            }
        },
        "outputs": {
            "bing-gang.clean.jsonl": {"sha256": sha256_of_file(out_jsonl)},
            "bing-gang.clean.md": {"sha256": sha256_of_file(out_md)},
        },
    }
    manifest_path = review_dir / "input-manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"[2/4] Parse：{len(rows)} 行；保留 {len(kept_rows)} 章；skip issue/0：{len(skipped_issue0)}")
    print(f"      duplicates={len(duplicates)} parse_errors={len(parse_errors)}")
    print(f"[3/4] 輸出：{out_jsonl.name} / {out_md.name}")
    print(f"[4/4] 報告：{report_json.name} / cleaning-report.md / input-manifest.json")
    print(f"      總移除字符：{total_removed:,}")

    return 0 if (not parse_errors and not duplicates and len(kept_rows) == 198) else 1


if __name__ == "__main__":
    sys.exit(main())

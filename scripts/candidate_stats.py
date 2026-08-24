#!/usr/bin/env python3
"""《病港》Phase B — candidates 質素分析（私有輸出）。

對 data/private/evidence/candidates.jsonl 做：
- JSON Schema 驗證（evidence-candidate.schema.json）
- 實體類型／章節分佈
- confidence 分佈
- 高頻實體名稱（跨章出現次數，供 resolution 審閱參考）
- 異常偵測：confidence 超界、空 claim、過長 excerpt、重複 candidate_id

輸出：data/private/review/candidates-stats.md（私有）
用法：python scripts/candidate_stats.py [--candidates PATH]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:
    print("[error] 缺少 jsonschema：pip install jsonschema")
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CANDIDATES = REPO_ROOT / "data/private/evidence/candidates.jsonl"
DEFAULT_SCHEMA = REPO_ROOT / "data/schemas/evidence-candidate.schema.json"
DEFAULT_OUT = REPO_ROOT / "data/private/review/candidates-stats.md"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", default=str(DEFAULT_CANDIDATES))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    cand_path = Path(args.candidates)
    if not cand_path.exists():
        print(f"[error] 搵唔到 {cand_path}")
        return 2

    rows = [json.loads(l) for l in open(cand_path, encoding="utf-8") if l.strip()]
    if not rows:
        print("無 candidates 記錄。")
        return 0

    # ---- schema 驗證 ----
    schema = json.loads(DEFAULT_SCHEMA.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    violations: list[str] = []
    for r in rows:
        errs = list(validator.iter_errors(r))
        for e in errs[:2]:
            loc = ".".join(str(p) for p in list(e.absolute_path)[:4])
            violations.append(f"{r.get('candidate_id','?')} {loc}: {e.message[:120]}")

    # ---- 分佈 ----
    kind_counter = Counter(r.get("entity_kind") for r in rows)
    chapter_counter = Counter(r["chapter"] for r in rows)
    confidences = [r["confidence"] for r in rows if isinstance(r.get("confidence"), (int, float))]
    conf_bands = Counter(
        "0.9+" if c >= 0.9 else "0.7–0.9" if c >= 0.7 else "0.5–0.7" if c >= 0.5 else "<0.5"
        for c in confidences
    )

    # ---- 高頻名稱 ----
    name_chapters: dict[tuple[str, str], set[int]] = defaultdict(set)
    for r in rows:
        if r.get("entity_kind") in ("location", "character"):
            name_chapters[(r["entity_kind"], r["name"])].add(r["chapter"])
    frequent = sorted(
        ((kind, name, len(chs)) for (kind, name), chs in name_chapters.items() if len(chs) >= 2),
        key=lambda x: (-x[2], x[1]),
    )

    # ---- 異常 ----
    anomalies: list[str] = []
    ids = Counter(r.get("candidate_id") for r in rows)
    dup_ids = [i for i, n in ids.items() if n > 1]
    if dup_ids:
        anomalies.append(f"重複 candidate_id：{dup_ids[:5]}")
    bad_conf = [
        r.get("candidate_id")
        for r in rows
        if not isinstance(r.get("confidence"), (int, float))
        or not (0 <= r["confidence"] <= 1)
    ]
    if bad_conf:
        anomalies.append(f"confidence 超界／非數值：{bad_conf[:5]}")
    empty_claim = sum(1 for r in rows if not r.get("claim"))
    long_excerpt = sum(1 for r in rows if len(r.get("evidence_excerpt") or "") > 300)
    null_name = sum(1 for r in rows if not r.get("name"))

    # ---- 報告 ----
    lines = []
    add = lines.append
    add("# Candidates 質素分析（私有）")
    add("")
    add(f"> 產生：{datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    add(f"> 來源：`{cand_path.relative_to(REPO_ROOT)}`；共 **{len(rows)}** 條")
    add("> 本檔案屬私有 material，不得 commit。")
    add("")
    add("## Schema 合規")
    add("")
    add(f"- 驗證違規：**{len(violations)}** 條")
    for v in violations[:10]:
        add(f"  - `{v}`")
    add("")
    add("## 分佈")
    add("")
    add("| 維度 | 分佈 |")
    add("|---|---|")
    add(f"| 實體類型 | {dict(kind_counter.most_common())} |")
    add(f"| 章節覆蓋 | {len(chapter_counter)} 章（ch{min(chapter_counter)}–ch{max(chapter_counter)}）|")
    add(f"| 每章密度 | min={min(chapter_counter.values())} max={max(chapter_counter.values())} 平均={len(rows)/len(chapter_counter):.0f} |")
    add(f"| confidence 帶 | {dict(conf_bands.most_common())} |")
    add("")
    add("## 高頻實體（跨 ≥2 章，resolution 重點對象）")
    add("")
    add("| 類型 | 名稱 | 出現章數 |")
    add("|---|---|---|")
    for kind, name, n in frequent[:40]:
        add(f"| {kind} | {name} | {n} |")
    add("")
    add("## 異常")
    add("")
    if anomalies:
        for a in anomalies:
            add(f"- ⚠️ {a}")
    else:
        add("- 無重複 id、無超界 confidence ✓")
    add(f"- 空 claim：{empty_claim}；excerpt>300 字：{long_excerpt}；缺 name：{null_name}")
    add("")
    add("## 建議")
    add("")
    add("- 高頻同名實體係 entity resolution 嘅首要合併對象；alias 寫法差異（如『阿佐』vs『少佐』）由 union-find exact-match 處理")
    add("- 低 confidence（<0.5）記錄建議全數入 review queue 人手過目")

    Path(args.out).write_text("\n".join(lines), encoding="utf-8")
    print(f"報告：{args.out}")
    print(f"{len(rows)} candidates | schema 違規 {len(violations)} | 高頻實體 {len(frequent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

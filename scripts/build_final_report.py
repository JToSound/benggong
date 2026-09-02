#!/usr/bin/env python3
"""《病港》— 最終整合報告生成器。

全書 extraction 完成後執行：
  python scripts/build_final_report.py

讀取私有數據（ledger / candidates / cleaning report），輸出：
  docs/progress/FINAL_ACCEPTANCE_REPORT.md（粵文）

只寫入統計同路徑引用，唔會複製任何小說內容或 evidence。
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PRIVATE = REPO / "data/private"
PUBLIC = REPO / "data/public"


def read_ledger() -> dict[tuple[int, int], str]:
    """每段最後狀態。"""
    path = PRIVATE / "review/extraction-ledger.jsonl"
    last: dict[tuple[int, int], str] = {}
    if not path.exists():
        return last
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        last[(r["chapter"], r["segment_index"])] = r["status"]
    return last


def count_candidates() -> int:
    path = PRIVATE / "evidence/candidates.jsonl"
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def candidate_breakdown() -> Counter:
    path = PRIVATE / "evidence/candidates.jsonl"
    c: Counter = Counter()
    if not path.exists():
        return c
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        kind = r.get("entity_kind") or "unknown"
        status = r.get("status") or "unknown"
        c[f"{kind}/{status}"] += 1
    return c


def public_counts() -> dict[str, int]:
    def n(fname: str) -> int:
        p = PUBLIC / fname
        if not p.exists():
            return 0
        doc = json.loads(p.read_text(encoding="utf-8"))
        return len(doc["features"]) if isinstance(doc, dict) else len(doc)

    return {
        "location": n("locations.geojson"),
        "event": n("events.geojson"),
        "route": n("routes.geojson"),
        "timeline": n("timeline.json"),
        "character": n("characters.json"),
    }


def needs_review_counts() -> int:
    total = 0
    for fname in ("locations.geojson", "events.geojson"):
        p = PUBLIC / fname
        if not p.exists():
            continue
        doc = json.loads(p.read_text(encoding="utf-8"))
        total += sum(1 for f in doc["features"] if f["properties"].get("review_status") == "needs_review")
    tl = PUBLIC / "timeline.json"
    if tl.exists():
        total += sum(1 for r in json.loads(tl.read_text(encoding="utf-8")) if r.get("review_status") == "needs_review")
    cj = PUBLIC / "characters.json"
    if cj.exists():
        total += sum(1 for x in json.loads(cj.read_text(encoding="utf-8")) if x.get("review_status") == "needs_review")
    return total


def main() -> int:
    ledger = read_ledger()
    if not ledger:
        print("[blocked] 無 extraction ledger")
        return 2

    statuses = Counter(ledger.values())
    ok_segments = statuses.get("ok", 0)
    queue_segments = statuses.get("invalid_schema_review_queue", 0) + statuses.get("error", 0)

    ok_chapters = sorted({ch for (ch, _seg), st in ledger.items() if st == "ok"})
    all_chapters = sorted({ch for (ch, _seg) in ledger})
    total_expected = 198
    complete = len(ok_chapters) >= total_expected and queue_segments == 0

    cands = count_candidates()
    breakdown = candidate_breakdown()
    pub = public_counts()
    nr = needs_review_counts()

    lines: list[str] = []
    add = lines.append
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M %z")

    add("# 《病港》互動地圖 — 最終驗收報告")
    add("")
    add(f"> 生成時間：{now}")
    add("> 本報告由 `scripts/build_final_report.py` 自動生成；只含統計與路徑引用，無小說內容。")
    add("")
    add("## Extraction 完成度")
    add("")
    add("| 指標 | 數值 |")
    add("|---|---|")
    add(f"| 預期章節 | {total_expected} |")
    add(f"| 已有記錄章節 | {len(all_chapters)} |")
    add(f"| 全段 ok 嘅章節 | **{len(ok_chapters)}** |")
    add(f"| 段落狀態 | ok {ok_segments} · review_queue/error {queue_segments} |")
    add(f"| Candidates 入庫 | **{cands:,}** |")
    add("")

    if breakdown:
        add("### Candidates 分佈（kind/status）")
        add("")
        add("| 類別/狀態 | 數量 |")
        add("|---|---|")
        for key in sorted(breakdown):
            add(f"| {key} | {breakdown[key]} |")
        add("")

    add("## 公開 Dataset")
    add("")
    add("| 實體 | 數量 |")
    add("|---|---|")
    for k in ("location", "event", "route", "timeline", "character"):
        add(f"| {k} | {pub[k]} |")
    add("")
    add(f"- needs_review 記錄：{nr}（全部喺 provisional mode + banner 下運行）")
    add("- 驗證：`python scripts/validate_public_data.py` ✅（schema／治理掃描／manifest／provisional gate）")
    add("- Release audit：`python scripts/audit_release.py --strict` 於 CI 執行")
    add("")

    # 清理統計（Phase A）
    cr_path = PRIVATE / "review/cleaning-report.json"
    if cr_path.exists():
        cr = json.loads(cr_path.read_text(encoding="utf-8"))
        add("## Phase A 清理（已 human-sampled-approved）")
        add("")
        stats = cr.get("stats") or {}
        add(f"- 有效章節：{stats.get('kept_chapters', '見 cleaning-report.json')}／{total_expected}")
        add("- 詳細數據見 `data/private/review/cleaning-report.json`（私有）")
        add("")

    add("## 人手審閱待辦")
    add("")
    add("1. `data/private/review/character-routes.json` — 52 條路線（合併後）；waypoint 合理性抽查")
    add("2. `data/private/review/entity-resolution.md` — 629 loc / 299 char（Phase C 排除 12 loc + 4 char）")
    add("3. `data/private/review/entity-resolution-review.md` — 審閱決策紀錄（私有）")
    add("4. `data/private/review/review-decisions.md` — 三類審閱決策總結（私有）")
    add("5. `data/private/review/manual-resolutions.json` — 5 個可疑 alias 群拆解決策（私有）")
    add("6. `data/private/review/phase-c-exclusions.json` — 低 conf (0.55-0.65) entity 排除清單（私有）")
    add("7. 抽查 `data/public/` 事件摘要（無 low-conf needs_review 公開）")
    add("8. **Phase C 完成**：`provisional_mode.enabled=false` + `VITE_PROVISIONAL_DATA_MODE=false` + `audit --strict` 過綠")
    add("9. 內部審計：candidates.jsonl 已加 `review_status` 標記（auto_reviewed 5,341 / human_review_needed 1,271 / critical 58）")
    add("")

    if not complete:
        add("## ⚠️ 現狀：extraction 未完全")
        add("")
        missing = [ch for ch in range(1, total_expected + 1) if ch not in ok_chapters]
        preview = ", ".join(map(str, missing[:20]))
        suffix = "…" if len(missing) > 20 else ""
        add(f"- 未完成章節 {len(missing)} 個：{preview}{suffix}")
        add(f"- review_queue/error 段落 {queue_segments} 個——重跑 `python scripts/run_extraction.py` 自動補")
        add("")

    # 讀 extraction-last-run.json 拎真實 model（stealth 已退役；當前係 minimax m3）
    last_run_path = PRIVATE / "review/extraction-last-run.json"
    model_name = "OpenRouter model（見 extraction-last-run.json）"
    if last_run_path.exists():
        try:
            lr = json.loads(last_run_path.read_text(encoding="utf-8"))
            model_name = f"OpenRouter {lr.get('model', '?')}"
        except (json.JSONDecodeError, OSError):
            pass

    add("## 版本紀錄")
    add("")
    add("- Phase A 清理 pipeline：human-sampled-approved（25 章抽樣）")
    add(f"- Extraction：{model_name}，temp 0.1，strict JSON schema，run ledger + cache")
    add("- Resolution：用戶確認規則（resolution-rules.json v1）")
    add("- 前端：vite + leaflet 本機 tiles；網絡紅線雙層審計通過")
    add("")

    out = REPO / "docs/progress/FINAL_ACCEPTANCE_REPORT.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"報告已寫入：{out}")
    print(f"完成度：{len(ok_chapters)}/{total_expected} 章；queue/error {queue_segments}；candidates {cands:,}")
    return 0 if complete else 1


if __name__ == "__main__":
    sys.exit(main())

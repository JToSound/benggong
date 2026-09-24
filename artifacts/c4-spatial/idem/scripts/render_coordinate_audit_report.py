#!/usr/bin/env python3
"""B4 —— 讀 `artifacts/b4/coordinate-audit.json` 出粵文 markdown 報告。

用法：
    python scripts/audit_coordinate_integrity.py        # 先產生 JSON
    python scripts/render_coordinate_audit_report.py    # 再出報告
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ARTIFACTS = REPO / "artifacts" / "b4"
SRC = ARTIFACTS / "coordinate-audit.json"
OUT = ARTIFACTS / "coordinate-audit-report.md"


def render(report: dict) -> str:
    lines: list[str] = []
    s = report["summary"]
    lines.append("# B4 座標完整性審計報告（R1–R8）")
    lines.append("")
    lines.append("> 由 `scripts/render_coordinate_audit_report.py` 讀 "
                 "`artifacts/b4/coordinate-audit.json` 自動產生。**零人手**。")
    lines.append(f"> schema_version = {report['schema_version']}")
    lines.append("")
    lines.append("## 1. 摘要")
    lines.append("")
    c = report["counts"]
    lines.append(f"| 項 | 值 |")
    lines.append("|---|---|")
    lines.append(f"| locations / events / routes / zones | {c['locations']} / {c['events']} / "
                 f"{c['routes']} / {c['zones']} |")
    lines.append(f"| findings 總數 | {s['n_findings']} |")
    lines.append(f"| severity 分佈 | `{s['by_severity']}` |")
    lines.append(f"| 失敗規則 | {s['rules_failed'] or '（無）'} |")
    lines.append(f"| 全部通過 | {'✅' if s['all_pass'] else '❌'} |")
    lines.append("")
    lines.append("## 2. 逐條規則")
    lines.append("")
    lines.append("| 規則 | 描述 | findings | fail | 狀態 |")
    lines.append("|---|---|---:|---:|---|")
    for key, r in report["rules"].items():
        mark = {"pass": "✅ pass", "fail": "❌ fail"}[r["status"]]
        lines.append(f"| `{key}` | {r['description']} | {r['n_findings']} | {r['n_fail']} | {mark} |")
    lines.append("")
    lines.append("## 3. 逐規則統計")
    for key, r in report["rules"].items():
        lines.append("")
        lines.append(f"### {key}")
        lines.append("")
        lines.append(f"```json\n{json.dumps(r['summary'], ensure_ascii=False, indent=2)}\n```")
        fails = [f for f in r["findings"] if f["severity"] in ("fail", "quarantine")]
        if fails:
            lines.append("")
            lines.append(f"**未通過／隔離（{len(fails)} 條，最多列 10 條）**")
            lines.append("")
            lines.append("| feature_id | severity | evidence |")
            lines.append("|---|---|---|")
            for f in fails[:10]:
                ev = json.dumps(f["evidence"], ensure_ascii=False)
                lines.append(f"| `{f['feature_id']}` | {f['severity']} | `{ev[:160]}` |")
    lines.append("")
    lines.append("## 4. 輸入檔 SHA-256")
    lines.append("")
    lines.append("| 檔 | sha256 |")
    lines.append("|---|---|")
    for n, h in report["inputs"].items():
        lines.append(f"| `{n}` | `{h}` |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    if not SRC.exists():
        print(f"[error] 搵唔到 {SRC} —— 請先跑 python scripts/audit_coordinate_integrity.py",
              file=sys.stderr)
        return 1
    report = json.loads(SRC.read_text(encoding="utf-8"))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(report), encoding="utf-8")
    print(f"報告 → {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

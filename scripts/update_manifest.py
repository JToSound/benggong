#!/usr/bin/env python3
"""更新 `asset-manifest.json` 嘅 counts（由實際資料檔重算）。

為何要納入管線
==============
counts 係人手／其他腳本更新嘅話，就會出現「加咗新資料集但 counts 冇更新」
（實測：加咗 zones.geojson 之後 manifest 仍然寫住舊數，驗證器報錯）。
由實際檔案重算係唯一可靠做法。
"""

from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
MANIFEST = PUBLIC / "asset-manifest.json"

#: counts key → 資料檔
SOURCES: dict[str, str] = {
    "location": "locations.geojson",
    "event": "events.geojson",
    "route": "routes.geojson",
    "timeline": "timeline.json",
    "character": "characters.json",
    "chapter_summary": "chapter-summaries.json",
    "zone": "zones.geojson",
    "chronicle_entry": "chronicle.json",
}


def count(fn: str) -> int:
    d = json.loads((PUBLIC / fn).read_text(encoding="utf-8"))
    if isinstance(d, dict) and "features" in d:
        return len(d["features"])
    if isinstance(d, dict) and "entries" in d:
        return len(d["entries"])
    return len(d)


def main() -> int:
    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    before = dict(m.get("counts") or {})
    m["counts"] = {k: count(v) for k, v in SOURCES.items()}
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    changed = {k: (before.get(k), v) for k, v in m["counts"].items() if before.get(k) != v}
    print(f"manifest counts 已更新：{m['counts']}")
    if changed:
        print(f"  有改動：{changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

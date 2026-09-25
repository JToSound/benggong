#!/usr/bin/env python3
"""量測公開資料嘅**真實傳輸大小**（gzip）—— 唔係 raw 大小。

⚠️ 為何要呢個腳本（C8 P1-8 / 驗收矩陣 §3 量測更正，2026-09-25）
=============================================================
驗收矩陣 §3 有一行：

    | `*.geojson` gzip | 首屏資料 ≤1.2 MB | response header | **3.65 MB ❌** |

嗰個 3.65 MB 係**用 `vite preview` 量嘅** —— 而 `vite preview` **唔會壓縮**
（冇 gzip / brotli）→ 量到嘅係 **raw** 大小，唔係真實傳輸大小。
GitHub Pages **會** gzip 文字資源，所以嗰個 ❌ 係**量測假象**。

呢個腳本用 `gzip`（level 9）逐檔壓縮，俾出真實嘅傳輸預算數字。
可重跑、確定性（同一個輸入永遠同一個輸出）。

用法
====
    python scripts/measure_payload_gzip.py
    python scripts/measure_payload_gzip.py --json artifacts/payload-gzip.json
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"

#: 首屏（`loadAllData` 嘅 `Promise.all`）會 fetch 嘅檔。
#:
#: ⚠️ `timeline.json` 同 `zone-dossiers.json` **唔喺**首屏（lazy）——
#: 佢哋分開列，唔可以計入首屏預算。
FIRST_LOAD = (
    "map-config.json",
    "locations.geojson",
    "events.geojson",
    "routes.geojson",
    "characters.json",
    "zones.geojson",
    "chronicle.json",
    "chapter-appearances.json",
    "chapter-summaries.json",
)

#: 按需載入（唔計入首屏）。
LAZY = ("timeline.json", "zone-dossiers.json", "asset-manifest.json")

#: 驗收矩陣 §3 嘅預算：首屏資料 ≤1.2 MB。
BUDGET_MB = 1.2


def gz_size(p: Path) -> int:
    return len(gzip.compress(p.read_bytes(), 9))


def main() -> int:
    ap = argparse.ArgumentParser(description="量測公開資料 gzip 傳輸大小")
    ap.add_argument("--json", default="", help="額外寫一份 JSON 報告")
    args = ap.parse_args()

    rows: list[dict[str, object]] = []
    print(f"{'檔':30} {'raw':>9} {'gzip':>9} {'比率':>7}")
    print("-" * 60)
    for group, names in (("first", FIRST_LOAD), ("lazy", LAZY)):
        for name in names:
            p = PUBLIC / name
            if not p.exists():
                continue
            raw = p.stat().st_size
            gz = gz_size(p)
            rows.append(
                {"file": name, "group": group, "raw": raw, "gzip": gz}
            )
            print(f"{name:30} {raw / 1024:8.0f}K {gz / 1024:8.0f}K {gz / raw * 100:6.1f}%")
        print("-" * 60)

    first = [r for r in rows if r["group"] == "first"]
    lazy = [r for r in rows if r["group"] == "lazy"]
    f_raw = sum(int(r["raw"]) for r in first)
    f_gz = sum(int(r["gzip"]) for r in first)
    l_gz = sum(int(r["gzip"]) for r in lazy)

    print(f"首屏（{len(first)} 檔）：raw {f_raw / 1024 / 1024:.2f} MB → **gzip {f_gz / 1024:.0f} KB**")
    print(f"按需（{len(lazy)} 檔）：gzip {l_gz / 1024:.0f} KB（唔計入首屏）")
    ok = f_gz / 1024 / 1024 <= BUDGET_MB
    print(
        f"\n預算 ≤{BUDGET_MB} MB：{'✅ PASS' if ok else '❌ FAIL'}"
        f"（實測 {f_gz / 1024 / 1024:.2f} MB gzip）"
    )

    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "note": "gzip level 9；`vite preview` 唔壓縮，所以 raw 數字唔代表真實傳輸量。",
                    "budget_mb": BUDGET_MB,
                    "first_load_gzip_bytes": f_gz,
                    "first_load_pass": ok,
                    "files": rows,
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"寫入 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

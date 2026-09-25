"""首屏 payload 預算（gzip）—— 驗收矩陣 §3 嘅自動守門。

⚠️ 為何要呢個測試（2026-09-25，C8 P1-8 + 量測更正）
================================================
驗收矩陣 §3 原本寫：

    | `*.geojson` gzip | 首屏資料 ≤1.2 MB | response header | **3.65 MB ❌** |

嗰個 3.65 MB 係**用 `vite preview` 量嘅**，而 `vite preview` **唔壓縮**
（冇 gzip / brotli）→ 量到嘅係 **raw** 大小。GitHub Pages **會** gzip 文字
資源 → 嗰個 ❌ 係**量測假象**。

實測（`scripts/measure_payload_gzip.py`，gzip level 9）：

    首屏 9 檔：raw 5.52 MB → **gzip 626 KB** → ✅ PASS（預算 1.2 MB）

呢個測試將「首屏 gzip ≤1.2 MB」變成**每次跑 pytest 都驗**嘅硬性閘門，
並且**明確列出邊啲檔算首屏**（`timeline.json` / `zone-dossiers.json` 係
按需載入，唔可以計入）。
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"

#: 首屏會 fetch 嘅檔（同 `scripts/measure_payload_gzip.py` 一致）。
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

#: 驗收矩陣 §3 預算。
BUDGET_BYTES = int(1.2 * 1024 * 1024)


def test_first_load_payload_within_budget():
    """首屏資料（gzip）≤ 1.2 MB。

    ⚠️ 一定要用 **gzip 後** 嘅大小 —— raw 大小唔代表真實傳輸量
    （見本檔頂部嘅量測更正說明）。
    """
    total = 0
    per_file: list[tuple[str, int]] = []
    for name in FIRST_LOAD:
        p = PUBLIC / name
        if not p.exists():
            pytest.skip(f"缺少 {name}（未跑過 pipeline？）")
        gz = len(gzip.compress(p.read_bytes(), 9))
        per_file.append((name, gz))
        total += gz

    detail = "、".join(f"{n} {b / 1024:.0f}K" for n, b in sorted(per_file, key=lambda x: -x[1]))
    assert total <= BUDGET_BYTES, (
        f"首屏 gzip payload {total / 1024 / 1024:.2f} MB 超出預算 "
        f"{BUDGET_BYTES / 1024 / 1024:.1f} MB\n  逐檔：{detail}"
    )


def test_lazy_files_are_not_in_first_load():
    """`timeline.json` / `zone-dossiers.json` **唔可以**喺首屏清單。

    為何：兩者都係按需載入（A8 P1-2 / A6 lazy），加返入 `loadAllData`
    會令首屏多 209 KB gzip（timeline 183K + dossiers 26K）。
    """
    lazy = {"timeline.json", "zone-dossiers.json"}
    assert not (lazy & set(FIRST_LOAD)), "lazy 檔唔可以入首屏清單"

    load_all = (REPO / "src" / "data" / "loadAllData.ts").read_text(encoding="utf-8")
    for name in lazy:
        # 註解提及冇所謂 —— 只睇真正嘅 fetch 呼叫（`base + "<name>"`）
        assert f'base + "{name}"' not in load_all, (
            f"{name} 應該係 lazy，但 `loadAllData.ts` 有 `base + \"{name}\"`"
        )


def test_gzip_ratio_is_reasonable():
    """所有公開資料檔嘅 gzip 比率應該 ≤60%（JSON 壓縮率通常 10–30%）。

    超過 60% 通常代表：① 已經係壓縮內容（例如 PNG base64 混入 JSON），
    或者 ② 內容高度隨機（例如 hash 清單）→ 兩者都應該檢視。
    """
    bad: list[str] = []
    for p in sorted(PUBLIC.glob("*.json")) + sorted(PUBLIC.glob("*.geojson")):
        raw = p.read_bytes()
        # 細檔（<10 KB）嘅比率天然偏高（header 開銷），唔算異常
        if len(raw) < 10 * 1024:
            continue
        ratio = len(gzip.compress(raw, 9)) / len(raw)
        if ratio > 0.60:
            bad.append(f"{p.name} {ratio:.0%}")
    assert not bad, f"gzip 比率異常（>60%）：{bad}"

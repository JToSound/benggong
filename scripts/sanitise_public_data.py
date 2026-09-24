#!/usr/bin/env python3
"""消毒公開資料（版權紅線 + 私有路徑外洩）。

背景（C5 對抗驗收 2026-09-24 發現）
==================================
**(a) 小說原文引用逃逸** —— `scripts/audit_release.py` /
`validate_public_data.py` / `validate_spatial_narrative.py` 三個偵測器原本
只捉「`原文`」字樣 → **`ch0092：「…」`（冇「原文」二字）會逃逸**。實測命中：

    zones.geojson  zone_d3f76d3c94（大本營）嘅 `population` 欄位
    = 百多人（ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」）

**(b) 私有路徑外洩** —— `asset-manifest.json` 嘅 `notes[4]` 寫住
`詳見 data/private/review/character-merge-applied.json`，而 manifest 係
**deployed** 嘅（`dist/data/public/`）。

做法（**文字層**，唔做 JSON round-trip —— 保留原檔格式）
=====================================================
1. `（chN：「…」）`（全形括號包住嘅章節引用）→ **整段括號連引用一齊刪**
   （保留括號前嘅事實，例如「百多人」）
2. 剩下嘅 `chN：「…」` → 換成 `（chN）`（保留章節參照，刪走原文）
3. `data/private/<path>` → 換成「專案私有記錄」（唔對外）

⚠️ 只改**元資料**，唔改小說正文 —— 本腳本只掃 `data/public/`，
正文喺 `data/private/`（唔會觸碰）。

用法
====
    python scripts/sanitise_public_data.py --dry-run
    python scripts/sanitise_public_data.py --apply
"""

from __future__ import annotations

import argparse
import re
import sys
from typing import Any
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"

#: 章節引用 + 引號（含「原文」變體）—— 原文引用嘅指紋。
QUOTE = r"(?:原文\s*[：:]?\s*)?ch\s*\d{1,4}\s*[：:]\s*[「『][^」』]*[」』]"

#: ① 全形括號包住 → 連括號一齊刪（保留前面嘅事實）。
PAREN_QUOTE = re.compile(rf"[（(]\s*{QUOTE}\s*[）)]")

#: ② 剩下嘅裸引用 → 只保留章節編號。
BARE_QUOTE = re.compile(QUOTE)

#: ③ `data/private/...` 路徑（可能連路徑字元一齊）。
PRIVATE_PATH = re.compile(r"data/private/[A-Za-z0-9._/\-]+")


def sanitise(text: str) -> tuple[str, int]:
    """回傳 `(消毒後文字, 改動次數)`。"""
    n = 0
    text, k = PAREN_QUOTE.subn("", text)
    n += k
    text, k = BARE_QUOTE.subn(
        lambda m: f"（{re.search(r'ch\\s*\\d+', m.group(0), re.I).group(0)}）", text
    )
    n += k
    text, k = PRIVATE_PATH.subn("專案私有記錄", text)
    n += k
    return text, n


def run(write: bool = False, *, quiet: bool = False) -> dict[str, Any]:
    """掃描（並可選寫入）`data/public/`。回傳統計（畀管線編排器用）。"""
    log = (lambda *a: None) if quiet else print
    total = 0
    changed: list[str] = []
    for p in sorted(PUBLIC.rglob("*")):
        if p.suffix not in (".json", ".geojson"):
            continue
        raw = p.read_text(encoding="utf-8")
        out, n = sanitise(raw)
        if n:
            total += n
            changed.append(f"  {p.relative_to(REPO)}：{n} 處")
            if write:
                p.write_text(out, encoding="utf-8")

    log(f"掃描 {PUBLIC.relative_to(REPO)}：{total} 處要消毒")
    for c in changed:
        log(c)
    return {"n_fixes": total, "files": changed, "written": write}


def main() -> int:
    ap = argparse.ArgumentParser(description="消毒公開資料（版權紅線 + 私有路徑）")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    stats = run(write=args.apply)
    if not args.apply:
        print("\n（dry-run：冇寫入。要寫入加 --apply）")
        return 0
    if stats["n_fixes"]:
        print("\n⚠️ 改完之後一定要重跑：python scripts/sync_public_data.py")
    else:
        print("\n✅ 冇嘢要改")
    return 0


if __name__ == "__main__":
    sys.exit(main())

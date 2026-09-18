#!/usr/bin/env python3
"""跑完整資料管線（順序有依賴，唔可以調亂）。

為何要有呢支腳本
================
Phase J 期間我一直手動逐支跑，結果出過幾次次序錯誤（例如 `derive_zones`
喺 `apply_place_inferences` 之前跑，令區域成員用咗舊座標）。

**依賴關係**：

    1. infer_places.py            產生推斷候選
    2. apply_place_inferences.py  套用已批核 + 傳播 + 修孤兒
    3. anchor_fictional_locations 虛構地點錨定到同章已解析地點
    4. apply_location_corrections 人手核實修正（要喺錨定之後，否則會被覆蓋）
    5. derive_zones.py            區域（讀最終座標）+ 反向填 zone_ids
    6. link_event_characters.py   事件角色連結 + 身份
    7. normalize_public_data.py   時間線排序 + 路線精度
    8. update_manifest.py         重算 asset-manifest counts
    9. sync_public_data.py        同步到 public/data/public/

⚠️ 為何 `derive_zones` 一定要喺 `anchor_fictional` **之後**：
   區域半徑係由成員地點嘅**實際座標**推導。如果虛構地點仲喺散落狀態，
   區域質心會被拉歪。

⚠️ 為何 `normalize` 一定要喺最後（sync 之前）：
   `apply_place_inferences` 會改路線座標，令 `normalize` 嘅路線精度
   計算失效。順序錯會令冪等性測試失敗。

用法：
    python scripts/run_pipeline.py --dry-run   # 只列步驟
    python scripts/run_pipeline.py             # 全部跑
    python scripts/run_pipeline.py --skip-llm-cache  # 唔理（預留）
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

STEPS: list[tuple[str, str]] = [
    ("infer_places.py", "產生推斷候選"),
    ("apply_place_inferences.py", "套用已批核推斷 + 傳播 + 修孤兒引用"),
    ("anchor_fictional_locations.py", "虛構地點錨定到同章已解析地點"),
    ("apply_location_corrections.py", "人手核實修正"),
    ("derive_zones.py", "區域（讀最終座標）+ 反向填 zone_ids"),
    ("link_event_characters.py", "事件角色連結 + 身份"),
    ("normalize_public_data.py", "時間線排序 + 路線精度"),
    ("update_manifest.py", "重算 asset-manifest counts"),
    ("sync_public_data.py", "同步到 public/data/public/"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="跑完整資料管線")
    ap.add_argument("--dry-run", action="store_true", help="只列步驟")
    args = ap.parse_args()

    print(f"資料管線（{len(STEPS)} 步）\n")
    for i, (script, desc) in enumerate(STEPS, 1):
        print(f"  {i}. {script:34s} {desc}")
    if args.dry_run:
        return 0

    print()
    failed: list[str] = []
    for i, (script, desc) in enumerate(STEPS, 1):
        t0 = time.time()
        r = subprocess.run(
            [sys.executable, str(REPO / "scripts" / script)],
            cwd=str(REPO),
            capture_output=True,
            text=True,
        )
        dt = time.time() - t0
        if r.returncode != 0:
            failed.append(script)
            print(f"[{i}/{len(STEPS)}] ❌ {script}（{dt:.1f}s）")
            print((r.stderr or r.stdout)[-600:])
        else:
            # 只印最後一行有意義嘅輸出
            tail = [ln for ln in (r.stdout or "").strip().splitlines() if ln.strip()]
            print(f"[{i}/{len(STEPS)}] ✅ {script}（{dt:.1f}s）  {tail[-1][:70] if tail else ''}")

    if failed:
        print(f"\n❌ {len(failed)} 步失敗：{failed}")
        return 1
    print(f"\n✅ 管線完成（{len(STEPS)} 步全部成功）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

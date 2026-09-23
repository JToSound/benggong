#!/usr/bin/env python3
"""跑完整資料管線（順序有依賴，唔可以調亂）。

為何要有呢支腳本
================
Phase J 期間我一直手動逐支跑，結果出過幾次次序錯誤（例如 `derive_zones`
喺 `apply_place_inferences` 之前跑，令區域成員用咗舊座標）。

**依賴關係**：

    1. infer_places.py            產生推斷候選
    2. merge_llm_inferences.py    合併 LLM 推斷（規則推斷優先）
    3. apply_place_inferences.py  套用已批核 + 傳播 + 修孤兒
    3. anchor_fictional_locations 虛構地點錨定到同章已解析地點
    4. apply_location_corrections 人手核實修正（要喺錨定之後，否則會被覆蓋）
    4. audit_location_coords     程式化座標審核（要喺錨定之後、傳播之前）
    4. audit_location_coords     程式化座標審核（要喺錨定之後、傳播之前）
    5. propagate_location_coords  將最終座標傳播到 events／timeline／routes
    6. merge_zone_dossiers.py     區域 4 階段編排（B4 deprecated shim）：
                                    1) 標記塌縮修復 + 座標傳播
                                    2) 區域基礎合併（v1 基礎欄位，冇 evidence）
                                    3) 三層 join + coordinate_* 回填
                                    4) zone v2 遷移 + zone-dossiers.json
    6. audit_coordinate_integrity 座標完整性審計 R1–R8（B4；只讀，出 artifact）
    6. render_coordinate_audit_report  審計報告 → markdown（B4）
    6. validate_spatial_narrative 空間敘事一致性（B4；雙向連結 + 版權掃描）
    6. link_event_characters.py   事件角色連結 + 身份
    7. build_chronicle.py         建置第一季編年史
    8. normalize_public_data.py   時間線排序 + 路線精度
    8. normalize_public_wording.py 公開元資料文案自動化（零人手違規）
    8. update_manifest.py         重算 asset-manifest counts
    9. sync_public_data.py        同步到 public/data/public/

⚠️ 為何 `normalize_public_wording` 要喺 `sync` **之前**、`update_manifest` 隔籬：
   佢負責清除公開元資料（`description` / `note` / `banner` …）嘅
   「人手審閱」字眼（違反 AGENTS.md 零人手參與規則）。放喺 sync 之前，
   先保證 `public/data/public/` 同步嘅係已清理版本；放喺 update_manifest
   之前，係因為 update_manifest 只重算 counts、唔會改文案，次序無耦合。
   ⚠️ 佢**只**改元資料欄位，**絕不**改小說正文（`summary` 等）——
   `characters.json` 已凍結（經 merge_characters 改寫，無法由輸入重現），
   所以需要呢一步做確定性改寫。

⚠️ 為何 `merge_zone_dossiers` 一定要喺 `anchor_fictional` **之後**：
   區域座標係由成員地點嘅**實際座標**解析。如果虛構地點仲喺散落狀態，
   區域中心會被拉歪。

⚠️ 為何 B4 嘅 4 階段**次序唔可以調亂**：
   塌縮修復改地點座標 → 基礎合併用新座標算 zone 幾何 → 三層 join 用
   最終幾何做 point-in-polygon → v2 遷移用最終 join 結果填 event_ids。
   調亂會令 pipeline **非冪等**（第一次跑同第二次跑出唔同結果）。

⚠️ 舊嘅 `derive_zones.py` 已經被 `merge_zone_dossiers.py` 取代：
   前者只由**地點名**推導（每個區域一句 120 字描述），後者由**全文抽取**
   出政權／社會結構／經濟／防禦等完整 dossier。
   而家 `derive_zones.py` 已經加咗守門（直接跑會 exit 2），避免雙軌寫入。

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
    ("merge_llm_inferences.py", "合併 LLM 推斷（規則推斷優先）"),
    ("apply_place_inferences.py", "套用已批核推斷 + 傳播 + 修孤兒引用"),
    ("anchor_fictional_locations.py", "虛構地點錨定到同章已解析地點"),
    ("apply_location_corrections.py", "人手核實修正"),
    ("audit_location_coords.py", "程式化座標審核（地名重配 + 歸屬錨定）"),
    ("propagate_location_coords.py", "將最終座標傳播到 events／timeline／routes"),
    ("merge_zone_dossiers.py", "區域 4 階段編排（塌縮 → 基礎合併 → join → v2+dossier）"),
    ("audit_coordinate_integrity.py", "座標完整性審計 R1–R8"),
    ("render_coordinate_audit_report.py", "審計報告 → artifacts/b4/*.md"),
    ("validate_spatial_narrative.py", "空間敘事一致性 + 版權掃描"),
    ("link_event_characters.py", "事件角色連結 + 身份"),
    ("build_chronicle.py", "建置第一季編年史（跨章聚合）"),
    ("normalize_public_data.py", "時間線排序 + 路線精度"),
    ("normalize_public_wording.py", "公開元資料文案自動化（零人手違規）"),
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

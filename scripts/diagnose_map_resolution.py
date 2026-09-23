#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""diagnose_map_resolution.py — B9：由 Q1–Q11 量測出「根因診斷」（唔止 pass/fail）。

為何要有呢個腳本
================
`verify_zoom_quality.py` 只講「邊項唔達標」。但 Phase 3 C3（Zoom/Render QA）
要嘅係「**邊個 zoom level 最差、點解、對應邊條 spec、應該邊個 agent 修**」。
呢個腳本讀 `zoom-quality-raw.json` + `zoom-quality-report.json`，用
**deterministic 規則**由量測值推導根因假設（唔係人手寫死結論），
輸出 `artifacts/b9-qa/map-resolution-diagnosis.json`。

規則
====
* 全部結論都要有 `evidence`（指向具體量測欄位同數值）。
* 每個根因都要有 `specRef` 同 `suggestedOwner`。
* **唔准**建議「人手覆核／人手目測」—— 只可以建議「擴充自動驗證規則」。

用法
====
    python scripts/diagnose_map_resolution.py
    python scripts/diagnose_map_resolution.py --refresh   # 先重跑量測再診斷
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "artifacts" / "b9-qa"
RAW_PATH = ART / "zoom-quality-raw.json"
REPORT_PATH = ART / "zoom-quality-report.json"
OUT_PATH = ART / "map-resolution-diagnosis.json"

DEEP_TARGET = 6
MID_TARGETS = (2, 4)
# 判定「真空區」嘅門檻（同 verify 腳本一致嘅精神，但用嚟描述現象）
EMPTY_FLAT_RATIO = 0.90
EMPTY_MEAN_GRAD = 5.0


def load(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"[b9] 缺少 {path} —— 請先跑 verify_zoom_quality.py")
    return json.loads(path.read_text(encoding="utf-8"))


def level_of(raw: dict[str, Any], anchor: str, target: int, dpr: int = 1) -> dict[str, Any] | None:
    for l in raw["levels"]:
        if l["anchor"] == anchor and l["target"] == target and l["dpr"] == dpr:
            return l
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="B9 地圖解析度／內容密度診斷")
    ap.add_argument("--refresh", action="store_true", help="先重跑 verify（會連帶重跑量測）")
    args = ap.parse_args()

    if args.refresh:
        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "verify_zoom_quality.py"), "--refresh"],
            cwd=str(ROOT),
        )

    raw = load(RAW_PATH)
    report = load(REPORT_PATH)

    # ------------------------------------------------------------------
    # 1. 每個 anchor 嘅 zoom 曲線（搵最差）
    # ------------------------------------------------------------------
    curves: dict[str, list[dict[str, Any]]] = {}
    for l in raw["levels"]:
        if l["dpr"] != 1:
            continue
        curves.setdefault(l["anchor"], []).append(
            {
                "target": l["target"],
                "reachedZ": l["reachedZ"],
                "viewW": l["viewW"],
                "flatRatio": round(l["canvas"]["flatRatio"], 4),
                "meanGrad": round(l["canvas"]["meanGrad"], 2),
                "edgeDensity": round(l["canvas"]["edgeDensity"], 4),
                "detailState": l["detailState"],
                "zonesInView": l["zonesInView"],
                "eventsInView": l.get("eventsAll", l["eventsInView"]),
                "canvasLabelsInCanvas": l["labels"]["inCanvas"],
            }
        )
    for k in curves:
        curves[k].sort(key=lambda r: r["target"])

    # 最差 level：meanGrad 最低（跳過 Z0，因為 Z0 係全港視圖，唔係「深 zoom」）
    worst: list[dict[str, Any]] = []
    for anchor, rows in curves.items():
        deep = [r for r in rows if r["target"] >= 2]
        if not deep:
            continue
        w = min(deep, key=lambda r: r["meanGrad"])
        worst.append({"anchor": anchor, **w})
    worst.sort(key=lambda r: r["meanGrad"])

    # ------------------------------------------------------------------
    # 2. 根因假設（deterministic：由量測值觸發）
    # ------------------------------------------------------------------
    root_causes: list[dict[str, Any]] = []

    # RC-1：真空區 —— 深 zoom 又平又冇 gradient，而且 zone/event 都冇
    for anchor, rows in curves.items():
        deep = next((r for r in rows if r["target"] == DEEP_TARGET), None)
        if not deep:
            continue
        if deep["flatRatio"] >= EMPTY_FLAT_RATIO and deep["meanGrad"] <= EMPTY_MEAN_GRAD:
            root_causes.append(
                {
                    "id": f"RC-EMPTY-{anchor.upper()}",
                    "title": f"{anchor} 錨點深 zoom（Z{DEEP_TARGET}）內容近乎空白",
                    "hypothesis": (
                        "深 zoom 視窗落喺**底圖資料真空區**：該處冇 zone polygon、"
                        "冇 event、冇足夠建築幾何，所以畫面接近均勻（flatRatio 極高、"
                        "meanGrad 極低）。呢個係「內容密度隨 zoom 反向下降」嘅極端情況"
                        "（A4 §1.2 成因 G1/G2/G3 嘅殘餘）。"
                    ),
                    "evidence": {
                        "anchor": anchor,
                        "z": deep["target"],
                        "viewW": deep["viewW"],
                        "flatRatio": deep["flatRatio"],
                        "meanGrad": deep["meanGrad"],
                        "zonesInView": deep["zonesInView"],
                        "eventsInView": deep["eventsInView"],
                        "canvasLabelsInCanvas": deep["canvasLabelsInCanvas"],
                    },
                    "specRef": [
                        "rendering-lod-strategy §3.1（Z6–Z8 應有「細節 landmark、事件 clusters、密集 route waypoint、局部 texture」）",
                        "rendering-lod-strategy §4.3（no-fake-zoom：低密度 tile → procedural contour + 狀態文字）",
                        "rendering-lod-strategy §7 Q3 / Q4",
                    ],
                    "suggestedOwner": "B5（BaseGeometryLayer / VectorBasemap）/ B4（zone 覆蓋）",
                    "suggestedFix": (
                        "① 為真空區加 procedural contour（spec §4.3 明文要求），令畫面有結構；"
                        "② 檢視 zone polygon 覆蓋率（該區係唔係真係冇 zone，抑或 zone 半徑過細）；"
                        "③ 檢視 tile 是否缺格（manifest 有冇該格）。"
                    ),
                }
            )

    # RC-2：no-fake-zoom 誤報 ok（累加效應）
    nd = raw.get("noDetail") or {}
    center_deep = level_of(raw, "center", DEEP_TARGET)
    if (
        center_deep is not None
        and center_deep["detailState"] == "ok"
        and center_deep["canvas"]["flatRatio"] >= EMPTY_FLAT_RATIO
        and nd.get("sparseState") == "sparse"
    ):
        root_causes.append(
            {
                "id": "RC-NOFAKEZOOM-ACCUM",
                "title": "no-fake-zoom 誤報 `ok`：tileBuildingCount 跨圖磚累加",
                "hypothesis": (
                    "`BaseGeometryLayer.tileBuildingCount` 係**所有已載入圖磚**嘅建築總和"
                    "（LRU 上限 24 格）。由 Z0 一路 zoom 入嚟，中間 level 載入過密集格，"
                    "令 count 一直高企 → 即使當前視窗係空白，`lowDensity` 都係 false，"
                    "`data-detail-state` 報 `ok`，唔會畫「此區未有細節資料」。"
                    "喺**全新 session** 直接去稀疏區（唔經密集區）就會正確報 `sparse` —— "
                    "證明係累加效應，唔係判斷邏輯本身壞。"
                ),
                "evidence": {
                    "centerZ6_detailState": center_deep["detailState"],
                    "centerZ6_flatRatio": round(center_deep["canvas"]["flatRatio"], 4),
                    "sparseFreshSession_detailState": nd.get("sparseState"),
                    "sparseFreshSession_textDrawn": nd.get("drawnInSparse"),
                },
                "specRef": [
                    "rendering-lod-strategy §4.3（No-fake-zoom）",
                    "rendering-lod-strategy §7 Q11",
                ],
                "suggestedOwner": "B5（BaseGeometryLayer）",
                "suggestedFix": (
                    "`lowDensity` 應由**當前視窗內**嘅建築數決定，而唔係全部已載入圖磚嘅"
                    "累加值。可加「當前 viewBox 內建築數」統計（或按視窗相交圖磚求和）。"
                ),
            }
        )

    # RC-3：冷 zoom 阻塞
    cz = raw.get("coldZoom") or {}
    if cz and cz.get("totalMs", 0) > 300:
        root_causes.append(
            {
                "id": "RC-COLDZOOM-REDRAW",
                "title": f"冷 zoom 合計主線程阻塞 {cz.get('totalMs')} ms（目標 300 ms）",
                "hypothesis": (
                    "20 次冷 zoom 產生多個 50–200 ms longtask。最長單一已達標，"
                    "但**合計**超標 → 剩餘成本係「每次 zoom 都做全量 canvas + SVG 重繪」"
                    "（唔再係 A8 嘅 O(tiles²) 病態）。"
                ),
                "evidence": {
                    "longTaskCount": cz.get("longTasks"),
                    "totalMs": cz.get("totalMs"),
                    "maxMs": cz.get("maxMs"),
                    "fps": cz.get("fps"),
                },
                "specRef": [
                    "rendering-lod-strategy §6.2（冷 zoom 主線程阻塞 ≤300 ms）",
                    "rendering-lod-strategy §7 Q10",
                ],
                "suggestedOwner": "B5 / B6（增量 layer 更新；spec §2.2 規則 R3）",
                "suggestedFix": (
                    "per-layer incremental update（唔好每次 zoom 重建全部 layer）；"
                    "或將幾何建構移去 worker。"
                ),
            }
        )

    # RC-4：Z8 不可達
    z8 = [t for t in raw.get("zTargets", []) if t > raw.get("maxZ", 0)]
    if z8:
        root_causes.append(
            {
                "id": "RC-Z8-UNREACHABLE",
                "title": f"target Z{z8} 物理上不可達（MAX_SCALE=64 → 最深 Z={raw.get('maxZ')}）",
                "hypothesis": (
                    "`src/components/SvgMap.ts` 嘅 `MAX_SCALE = 64` 令 viewW 下限 = "
                    f"{raw.get('maxViewW'):.6f}°（= Z{raw.get('maxZ')}）。spec §7 Q1 要求"
                    "量到 Z8，但 spec §3.1 規則 L3 只講「MAX_SCALE 35→64 令 Z6 可達」。"
                    "即係 **spec 內部有落差**：Q1 嘅 target 清單同 L3 嘅實作上限唔一致。"
                ),
                "evidence": {
                    "maxZ": raw.get("maxZ"),
                    "maxViewW": raw.get("maxViewW"),
                    "zTargets": raw.get("zTargets"),
                    "unreachable": z8,
                    "note": "Z8 截圖同 Z6 完全相同（reachedZ 都係 6）",
                },
                "specRef": [
                    "rendering-lod-strategy §7 Q1（要求 Z8）",
                    "rendering-lod-strategy §3.2 規則 L3（MAX_SCALE 64 → 只保證 Z6）",
                ],
                "suggestedOwner": "主代理（spec 決策：提升 MAX_SCALE 抑或將 Q1 改成 Z0/Z2/Z4/Z6）",
                "suggestedFix": (
                    "二選一並寫入 spec：① `MAX_SCALE` 提升到 256（令 Z8 可達，但要確認"
                    "tile/POI 喺 Z7–Z8 仍有內容）；② 將 Q1 嘅 target 清單改為 Z0/Z2/Z4/Z6。"
                    "**唔可以**靜靜當 Z8 量過。"
                ),
            }
        )

    # RC-5：故事主場都有密度衰減（watch item，未過 FAIL 線）
    tko = curves.get("tko", [])
    if tko:
        mid_peak = max((r["meanGrad"] for r in tko if r["target"] in MID_TARGETS), default=0)
        deep = next((r for r in tko if r["target"] == DEEP_TARGET), None)
        if deep and mid_peak and deep["meanGrad"] < mid_peak * 0.8:
            root_causes.append(
                {
                    "id": "RC-TKO-DECAY",
                    "title": "故事主場（將軍澳）深 zoom 密度仍然衰減",
                    "hypothesis": (
                        "即使喺故事主場，Z2 → Z6 嘅 meanGrad 仍然下降。Q4 嘅 50% 地板"
                        "過得到，但趨勢同 spec「深 zoom 應有足夠內容可探索」嘅北極星"
                        "方向唔完全一致。屬 watch item。"
                    ),
                    "evidence": {
                        "tkoMidPeakMeanGrad": round(mid_peak, 2),
                        "tkoDeepMeanGrad": round(deep["meanGrad"], 2),
                        "ratio": round(deep["meanGrad"] / mid_peak, 3),
                        "tkoDeepZonesInView": deep["zonesInView"],
                    },
                    "specRef": [
                        "rendering-lod-strategy §1.3（北極星：最大 zoom 有足夠內容可探索）",
                        "rendering-lod-strategy §3.1（Z6–Z8 目標密度）",
                    ],
                    "suggestedOwner": "B5 / B6（label 密度、POI 渲染）",
                    "suggestedFix": (
                        "提高 detail tier 嘅 label/POI 密度（`maxLabelRank` / "
                        "`includesTilePoi`），並確認 rank 5 tile POI 真係畫咗。"
                    ),
                }
            )

    # ------------------------------------------------------------------
    # 3. 下一步自動檢查（唔准人手）
    # ------------------------------------------------------------------
    next_checks = [
        {
            "id": "Q12-suggested",
            "title": "深 zoom 每個 anchor 嘅 `data-detail-state` 必須同「當前視窗可見建築數」一致",
            "rationale": "RC-NOFAKEZOOM-ACCUM：而家嘅判定用累加值，會誤報 ok。",
            "how": "Node 側喺 `BaseGeometryLayer` 曝露「當前 viewBox 相交圖磚嘅建築數」，Python 比對 detailState。",
        },
        {
            "id": "Q13-suggested",
            "title": "深 zoom 每個 anchor 至少有 1 個可見 label（唔可以全部離屏）",
            "rationale": "center Z4/Z6 嘅 zone-label 全部離屏（visible=0），視覺上等於冇標籤。",
            "how": "Python 由 raw 嘅 zoneLabelBoxes 過濾 viewport 後要求 ≥1。",
        },
        {
            "id": "Q14-suggested",
            "title": "tile 覆蓋完整性：max zoom 視窗內每格圖磚都存在於 manifest",
            "rationale": "區分「真空區係冇資料」抑或「資料存在但冇渲染」。",
            "how": "Python 用 viewBox→圖磚範圍（同 VectorBasemap.tileRange 同公式）比對 manifest。",
        },
        {
            "id": "Q15-suggested",
            "title": "Q1 target 清單同 MAX_SCALE 保持一致（spec 內部一致性斷言）",
            "rationale": "RC-Z8-UNREACHABLE：spec Q1 要求 Z8 但 L3 只到 Z6。",
            "how": "Python 讀 raw.maxZ，要求 max(zTargets) ≤ maxZ，否則 needs_review（已有，改成硬斷言）。",
        },
    ]

    checks_by_id = {c["id"]: c for c in report.get("checks", [])}
    out = {
        "schema": "b9.map-resolution-diagnosis/1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "raw": "artifacts/b9-qa/zoom-quality-raw.json",
            "report": "artifacts/b9-qa/zoom-quality-report.json",
        },
        "summary": report.get("summary"),
        "failedChecks": [c["id"] for c in report.get("checks", []) if c["status"] == "fail"],
        "needsReviewChecks": [c["id"] for c in report.get("checks", []) if c["status"] == "needs_review"],
        "curves": curves,
        "worstLevels": worst,
        "rootCauses": root_causes,
        "nextChecks": next_checks,
        "checkIndex": {
            k: {"status": v["status"], "title": v["title"]} for k, v in checks_by_id.items()
        },
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- 印摘要 ----
    print()
    print("=" * 88)
    print("B9 地圖解析度／內容密度診斷")
    print("=" * 88)
    print(f"失敗項：{out['failedChecks']}　待決項：{out['needsReviewChecks']}")
    print()
    print("各錨點 zoom 曲線（flatRatio 越細越有細節）")
    print(f"{'anchor':8}{'Z':>3}{'viewW':>12}{'flat':>9}{'meanGrad':>10}{'edge':>8}{'detail':>8}{'zones':>7}{'events':>8}")
    for anchor, rows in curves.items():
        for r in rows:
            print(
                f"{anchor:8}{r['target']:>3}{r['viewW']:>12.6f}{r['flatRatio']:>9.4f}"
                f"{r['meanGrad']:>10.2f}{r['edgeDensity']:>8.4f}{str(r['detailState']):>8}"
                f"{r['zonesInView']:>7}{r['eventsInView']:>8}"
            )
        print()
    print("根因假設：")
    for rc in root_causes:
        print(f" - [{rc['id']}] {rc['title']}")
        print(f"     owner: {rc['suggestedOwner']}")
    print()
    print("建議下一步自動檢查：")
    for nc in next_checks:
        print(f" - [{nc['id']}] {nc['title']}")
    print()
    print(f"輸出：{OUT_PATH.relative_to(ROOT)}")
    print("=" * 88)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

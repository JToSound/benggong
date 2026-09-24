#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_zoom_quality.py — B9：Q1–Q11 視覺／渲染品質自動判定（spec §7）。

為何要有呢個腳本
================
spec `world-atlas-v2-rendering-lod-strategy.md` §7 將「最大 zoom 唔可以起格、
唔可以稀疏」化成 11 條斷言，但**冇可重跑嘅實作**。呢個腳本係嗰 11 條嘅
**唯一判定來源**，亦係 Gate 3 C3（Zoom/Render QA）嘅輸入。

為何「Node 量 → Python 判」
==========================
`pytesseract` 唔可用、又唔准加依賴，所以 Python 側冇 Playwright binding。
分工：Node（`tests/zoom-quality.e2e.test.ts`）負責截圖／DOM／network／longtask，
寫落 `artifacts/b9-qa/zoom-quality-raw.json`；本腳本讀嗰份 + PNG，用 cv2/numpy
做像素分析，再逐項判 PASS/FAIL。

規則
====
* **規則 Q1**：唔可以靠人手目測截圖。本腳本全部斷言都係程式化。
* **規則 Q2**：唔可以只測「無 exception」。本腳本量像素、尺寸、bytes、毫秒。
* **如實 FAIL**：任何未達標項目一律 FAIL，唔准為「全綠」而放寬閾值。

用法
====
    python scripts/verify_zoom_quality.py               # 讀現有量測；缺 → 自動補跑
    python scripts/verify_zoom_quality.py --refresh     # 強制重跑量測
    python scripts/verify_zoom_quality.py --report-only # 只出報告，永遠 exit 0
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# 路徑
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "artifacts" / "b9-qa"
SHOTS = ART / "screenshots"
RAW_PATH = ART / "zoom-quality-raw.json"
REPORT_PATH = ART / "zoom-quality-report.json"
MANIFEST_PATH = ROOT / "public" / "assets" / "vector" / "manifest.json"

# ---------------------------------------------------------------------------
# 閾值（單一來源；同 docs/contracts/b9-interface-contract.md §6 一致）
# ---------------------------------------------------------------------------
Z_TARGETS = [0, 2, 4, 6, 8]
DPRS = [1, 2]
FLAT_TOLERANCE = 0.002
MEANGRAD_MIN_RATIO = 0.5
ZONE_MIN = 3
EVENT_MIN = 5
LABEL_PASS_RATIO = 0.80
LABEL_MIN_FONT_PX = 9.0
LABEL_MIN_BBOX_H = 7.0
LABEL_MIN_BBOX_W = 8.0
SEAM_MAX_FRACTION = 0.5
SEAM_EDGE_THRESHOLD = 16
TILE_MAX_BYTES = 1.0 * 1024 * 1024
COLD_ZOOM_MAX_MS = 300
"""
Q10 主判定門檻：**單次最長**主線程阻塞（ms）。

⚠️ 為何係「最長單一」而唔係「合計」（2026-09-24 用戶授權主代理裁決）
================================================================
1. **spec §7 字面**：Q10 原文係「冷 zoom 主線程阻塞 ≤ 300 ms」。單一閾值
   配「阻塞」最自然嘅讀法係**單次最長阻塞**；「合計」係 A8/B5 另外引入嘅
   更嚴格內部基線，spec 冇寫。
2. **量測噪音（實測，同一 build 連跑 6 次）**：
       totalMs = 378 / 381 / 382 / 405 / 504 / 504  → 中位 394、極差 33%
       maxMs   = 144 / 146 / 147 / 148 / 157 / 164  → 中位 152、極差 14%
   而「未優化」嘅合計係 632 ms —— 只係高於噪音上界（504）25%。即係一個
   想分開「修好」同「未修好」嘅合計門檻，只能落喺 504–632 之間嘅窄窗，
   而單次量測噪音已經係 ±16% → **唔可能穩定**。相反 maxMs 極差只有 14%，
   而且 300 ms 對 152 ms 有約 2 倍餘裕。
3. 所以：**合計改為「崩壞界限」**（見下），唔再做 pass/fail 主判定。
"""

COLD_ZOOM_TOTAL_SANITY_MS = 1500
"""
Q10 輔助**崩壞界限**：20 次冷 zoom 嘅 longtask **合計**（ms）。

⚠️ 呢個**唔係** spec 要求，係防「回復到秒級阻塞」嘅粗略安全網：
A8 原始實測係 **21,241 ms**（O(tiles² × features) 重建 `Path2D`），
本輪優化前係 632 ms、優化後中位 ~394 ms（範圍 378–504）。
1500 ms 對中位有 ~3.8 倍餘裕，足以捕捉災難性回歸，又唔會因為噪音而假紅。
"""

SHARPNESS_MIN_RATIO = 1.5
SHARPNESS_BLUR_SIGMA = 1.0
SHARPNESS_MIN_EDGE_DENSITY = 0.005
VIEWPORT_W, VIEWPORT_H = 1440, 900
NO_DETAIL_TEXT = "此區未有細節資料"

# 深 zoom 用邊個 target（Z6 = MAX_SCALE 上限）
DEEP_TARGET = 6
MID_TARGETS = (2, 4)


# ---------------------------------------------------------------------------
# 檢查收集
# ---------------------------------------------------------------------------
class Report:
    def __init__(self) -> None:
        self.checks: list[dict[str, Any]] = []

    def add(
        self,
        cid: str,
        title: str,
        status: str,
        actual: Any = None,
        threshold: Any = None,
        anchor: str | None = None,
        note: str = "",
    ) -> None:
        assert status in ("pass", "fail", "needs_review", "not_measured"), status
        self.checks.append(
            {
                "id": cid,
                "title": title,
                "status": status,
                "actual": actual,
                "threshold": threshold,
                "anchor": anchor,
                "note": note,
            }
        )

    def count(self, status: str) -> int:
        return sum(1 for c in self.checks if c["status"] == status)


# ---------------------------------------------------------------------------
# 讀量測
# ---------------------------------------------------------------------------
def ensure_raw(refresh: bool) -> dict[str, Any]:
    """確保有量測原始檔；缺／過期就自己補跑（令本腳本可以獨立重跑）。"""
    if refresh or not RAW_PATH.exists():
        print("[b9] 量測原始檔缺失或要求重跑 → npx vitest run tests/zoom-quality.e2e.test.ts")
        proc = subprocess.run(
            ["npx", "vitest", "run", "tests/zoom-quality.e2e.test.ts"],
            cwd=str(ROOT),
            shell=(sys.platform == "win32"),
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            print(proc.stdout[-4000:])
            print(proc.stderr[-4000:], file=sys.stderr)
            raise SystemExit(
                "[b9] 量測測試失敗 —— 唔可以喺冇量測之下判定（規則 Q1）"
            )
    return json.loads(RAW_PATH.read_text(encoding="utf-8"))


def imread(rel: str) -> np.ndarray | None:
    """由 raw JSON 記錄嘅相對路徑讀 PNG（灰階）。"""
    p = ROOT / rel
    if not p.exists():
        return None
    img = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
    return img


def edge_density(g: np.ndarray, threshold: int = 24) -> float:
    """硬邊像素佔比（同 Node 側 `edgeDensity` 同一條公式）。"""
    dx = np.abs(g[:, 1:].astype(np.int16) - g[:, :-1].astype(np.int16))
    dy = np.abs(g[1:, :].astype(np.int16) - g[:-1, :].astype(np.int16))
    return float(((dx > threshold).mean() + (dy > threshold).mean()) / 2.0)


def font_px(font: str) -> float:
    m = re.search(r"(\d+(?:\.\d+)?)px", font or "")
    return float(m.group(1)) if m else 0.0


def level_of(raw: dict[str, Any], anchor: str, target: int, dpr: int = 1) -> dict[str, Any] | None:
    for l in raw["levels"]:
        if l["anchor"] == anchor and l["target"] == target and l["dpr"] == dpr:
            return l
    return None


# ---------------------------------------------------------------------------
# Q1：截圖存在 + 尺寸正確（DPR 1/2）
# ---------------------------------------------------------------------------
def check_q1(raw: dict[str, Any], rep: Report) -> None:
    missing: list[str] = []
    size_bad: list[str] = []
    dpr_bad: list[str] = []
    heights: dict[int, dict[int, int]] = {}

    for t in Z_TARGETS:
        for dpr in DPRS:
            l = level_of(raw, "center", t, dpr)
            if l is None or not l.get("screenshot"):
                missing.append(f"center-Z{t}-dpr{dpr}")
                continue
            img = imread(l["screenshot"])
            if img is None:
                missing.append(l["screenshot"])
                continue
            h, w = img.shape[:2]
            if h < 100 or w < 100:
                size_bad.append(f"Z{t}-dpr{dpr}={w}x{h}")
            heights.setdefault(t, {})[dpr] = h

    for t, hh in heights.items():
        if 1 in hh and 2 in hh and abs(hh[2] - 2 * hh[1]) > 2:
            dpr_bad.append(f"Z{t}: dpr1={hh[1]} dpr2={hh[2]}")

    reachable = [t for t in Z_TARGETS if t <= raw["maxZ"]]
    unreachable = [t for t in Z_TARGETS if t > raw["maxZ"]]

    status = "pass" if not missing and not size_bad and not dpr_bad else "fail"
    note = f"可達 target {reachable}；DPR2 = 2 × DPR1"
    if unreachable:
        note += (
            f"；⚠️ target {unreachable} 物理上不可達 —— MAX_SCALE=64 令最深 Z="
            f"{raw['maxZ']}（viewW={raw['maxViewW']:.6f}°）。"
            f"spec Q1 要求 Z8 但 MAX_SCALE 只到 Z6，需主代理決定（加 scale 或改 spec）。"
        )
    rep.add(
        "Q1",
        "各 target zoom × DPR 1/2 截圖存在且尺寸正確",
        status if not unreachable else ("needs_review" if status == "pass" else "fail"),
        actual={"missing": missing, "sizeBad": size_bad, "dprMismatch": dpr_bad,
                "reachable": reachable, "unreachable": unreachable},
        threshold="全部 target（Z0/Z2/Z4/Z6/Z8）× DPR 1/2 存在，DPR2 = 2×DPR1",
        note=note,
    )


# ---------------------------------------------------------------------------
# Q2：無 raster upscale
# ---------------------------------------------------------------------------
def check_q2(raw: dict[str, Any], rep: Report) -> None:
    offenders: list[str] = []
    for l in raw["levels"]:
        r = l["raster"]
        if r["imagesWithHref"] != 0 or r["imgs"] != 0:
            offenders.append(f"{l['anchor']}Z{l['target']}dpr{l['dpr']}:image={r['imagesWithHref']},img={r['imgs']}")
        eff = min(r["dpr"], 2)
        if abs(r["canvasW"] - round(r["cssW"] * eff)) > 2:
            offenders.append(f"{l['anchor']}Z{l['target']}dpr{l['dpr']}:canvasW={r['canvasW']}≠{round(r['cssW']*eff)}")
        if abs(r["canvasH"] - round(r["cssH"] * eff)) > 2:
            offenders.append(f"{l['anchor']}Z{l['target']}dpr{l['dpr']}:canvasH={r['canvasH']}≠{round(r['cssH']*eff)}")
    rep.add(
        "Q2",
        "無 raster upscale：<image href>/<img> = 0；canvas backing = CSS × DPR",
        "pass" if not offenders else "fail",
        actual={"offenders": offenders, "levelsChecked": len(raw["levels"])},
        threshold="0 raster 元素；backing 誤差 ≤2px",
    )


# ---------------------------------------------------------------------------
# Q3：flatRatio 單調性（深 zoom 唔可以比 Z0 更平）
# ---------------------------------------------------------------------------
def check_q3(raw: dict[str, Any], rep: Report) -> None:
    z0 = level_of(raw, "center", 0)
    base = z0["canvas"]["flatRatio"] if z0 else None
    per_anchor: dict[str, Any] = {}
    fails: list[str] = []

    for anchor in ("center", "tko"):
        deep = level_of(raw, anchor, DEEP_TARGET)
        if deep is None or base is None:
            per_anchor[anchor] = {"status": "not_measured"}
            continue
        val = deep["canvas"]["flatRatio"]
        ok = val <= base + FLAT_TOLERANCE
        per_anchor[anchor] = {
            "z0Flat": round(base, 4),
            "deepFlat": round(val, 4),
            "delta": round(val - base, 4),
            "status": "pass" if ok else "fail",
        }
        if not ok:
            fails.append(f"{anchor}({val:.4f}>{base:.4f})")

    status = "fail" if fails else ("pass" if per_anchor else "not_measured")
    rep.add(
        "Q3",
        "flatRatio 單調性：深 zoom 唔可以比 Z0 更平",
        status,
        actual=per_anchor,
        threshold=f"flat(max) ≤ flat(Z0) + {FLAT_TOLERANCE}",
        anchor="center,tko",
        note=(
            "center 錨點 = bbox 幾何中心（114.14,22.36，郊野公園一帶）—— 同 A4 "
            "flatness-probe 同款協定，可同 spec 引用嘅 0.850>0.846 直接對比；"
            "tko 錨點 = 故事主場。逐個 anchor 報，任何一個 FAIL → 整體 FAIL。"
            if fails
            else "兩個錨點都通過"
        ),
    )


# ---------------------------------------------------------------------------
# Q4：meanGrad 深 zoom 唔可以低過中段 50%
# ---------------------------------------------------------------------------
def check_q4(raw: dict[str, Any], rep: Report) -> None:
    per_anchor: dict[str, Any] = {}
    fails: list[str] = []

    for anchor in ("center", "tko"):
        deep = level_of(raw, anchor, DEEP_TARGET)
        mids = [level_of(raw, anchor, t) for t in MID_TARGETS]
        mids = [m for m in mids if m is not None]
        if deep is None or not mids:
            per_anchor[anchor] = {"status": "not_measured"}
            continue
        mid_peak = max(m["canvas"]["meanGrad"] for m in mids)
        val = deep["canvas"]["meanGrad"]
        floor = MEANGRAD_MIN_RATIO * mid_peak
        ok = val >= floor
        per_anchor[anchor] = {
            "midPeak": round(mid_peak, 2),
            "deep": round(val, 2),
            "floor": round(floor, 2),
            "ratio": round(val / mid_peak, 3) if mid_peak else None,
            "status": "pass" if ok else "fail",
        }
        if not ok:
            fails.append(f"{anchor}({val:.2f}<{floor:.2f})")

    status = "fail" if fails else ("pass" if per_anchor else "not_measured")
    rep.add(
        "Q4",
        "meanGrad 深 zoom 唔可以低過中段 50%",
        status,
        actual=per_anchor,
        threshold=f"meanGrad(max) ≥ {MEANGRAD_MIN_RATIO} × max(meanGrad(mid))",
        anchor="center,tko",
        note="mid = Z2/Z4 嘅峰值",
    )


# ---------------------------------------------------------------------------
# Q5 / Q6：深 zoom 內容密度
# ---------------------------------------------------------------------------
def check_q5(raw: dict[str, Any], rep: Report) -> None:
    l = level_of(raw, "tko", DEEP_TARGET)
    if l is None:
        rep.add("Q5", "最大 zoom 視窗內 zone 數 ≥ 3（將軍澳）", "not_measured")
        return
    n = l["zonesInView"]
    rep.add(
        "Q5",
        "最大 zoom 視窗內 zone 數 ≥ 3（將軍澳）",
        "pass" if n >= ZONE_MIN else "fail",
        actual={"zonesInView": n, "zoneLabelBoxes": len(l.get("zoneLabelBoxes", []))},
        threshold=f"≥ {ZONE_MIN}",
        anchor="tko",
        note="規則 L1：zone 永遠 render（唔受章節窗口影響）",
    )


def check_q6(raw: dict[str, Any], rep: Report) -> None:
    l = level_of(raw, "tko", DEEP_TARGET)
    if l is None:
        rep.add("Q6", "最大 zoom 視窗內 event 數 ≥ 5", "not_measured")
        return
    all_ev = l.get("eventsAll")
    win_ev = l.get("eventsWindowed")
    pressed = l.get("showAllPressed")
    ok = (
        isinstance(all_ev, int)
        and all_ev >= EVENT_MIN
        and isinstance(win_ev, int)
        and all_ev > win_ev
        and pressed == "true"
    )
    rep.add(
        "Q6",
        "最大 zoom 視窗內 event 數 ≥ 5（「顯示全部事件」後）",
        "pass" if ok else "fail",
        actual={"eventsAll": all_ev, "eventsWindowed": win_ev, "ariaPressed": pressed},
        threshold=f"≥ {EVENT_MIN} 且 > 窗口值",
        anchor="tko",
        note="spec §3.3：layer control 提供「顯示全部事件」toggle",
    )


# ---------------------------------------------------------------------------
# Q7：Label crispness（替代 OCR）
# ---------------------------------------------------------------------------
def check_q7(raw: dict[str, Any], rep: Report) -> None:
    # (a) 冇任何 label 用 <9px 字級畫
    below: list[dict[str, Any]] = []
    total_labels = 0
    for l in raw["levels"]:
        if l["dpr"] != 1:
            continue
        b = l["labels"]["belowMin"]
        total_labels += l["labels"]["total"]
        if b:
            below.append({"anchor": l["anchor"], "z": l["target"], "belowMin": b})

    # (b) DOM zone label 尺寸可讀
    vis_total = 0
    vis_pass = 0
    vis_bad: list[dict[str, Any]] = []
    for l in raw["levels"]:
        if l["dpr"] != 1:
            continue
        for b in l.get("zoneLabelBoxes", []):
            if not (0 <= b["x"] <= VIEWPORT_W and 0 <= b["y"] <= VIEWPORT_H):
                continue
            if b["w"] <= 0 or b["h"] <= 0:
                continue
            vis_total += 1
            if b["h"] >= LABEL_MIN_BBOX_H and b["w"] >= LABEL_MIN_BBOX_W:
                vis_pass += 1
            elif len(vis_bad) < 8:
                vis_bad.append({"anchor": l["anchor"], "z": l["target"], "text": b["text"][:10], "w": b["w"], "h": b["h"]})

    dom_ratio = (vis_pass / vis_total) if vis_total else None
    dom_ok = dom_ratio is not None and dom_ratio >= LABEL_PASS_RATIO

    # (c) 像素銳利度（只喺有足夠高頻內容嘅 canvas 上判）
    sharp: list[dict[str, Any]] = []
    sharp_fail: list[str] = []
    for l in raw["levels"]:
        if not l.get("canvasPng"):
            continue
        img = imread(l["canvasPng"])
        if img is None:
            continue
        nat = edge_density(img)
        blurred = cv2.GaussianBlur(img, (0, 0), SHARPNESS_BLUR_SIGMA)
        bl = edge_density(blurred)
        ratio = (nat / bl) if bl > 0 else float("inf")
        entry = {
            "anchor": l["anchor"],
            "z": l["target"],
            "nativeEdgeDensity": round(nat, 4),
            "blurredEdgeDensity": round(bl, 4),
            "ratio": round(ratio, 2) if bl > 0 else None,
            "gated": nat >= SHARPNESS_MIN_EDGE_DENSITY,
        }
        if entry["gated"] and (ratio < SHARPNESS_MIN_RATIO):
            sharp_fail.append(f"{l['anchor']}Z{l['target']}({ratio:.2f})")
        sharp.append(entry)

    ok = (not below) and dom_ok and (not sharp_fail)
    rep.add(
        "Q7",
        "Label crispness（替代 OCR：字級 + DOM 尺寸 + 邊緣銳利度）",
        "pass" if ok else "fail",
        actual={
            "labelsBelowMinFont": below,
            "labelsDrawnTotal": total_labels,
            "domVisibleLabels": vis_total,
            "domVisiblePass": vis_pass,
            "domPassRatio": round(dom_ratio, 3) if dom_ratio is not None else None,
            "domBadSamples": vis_bad,
            "sharpness": sharp,
        },
        threshold=(
            f"0 個 label < {LABEL_MIN_FONT_PX}px；DOM 可見 label ≥{LABEL_PASS_RATIO:.0%} "
            f"h≥{LABEL_MIN_BBOX_H} 且 w≥{LABEL_MIN_BBOX_W}；有內容嘅 canvas 銳利度 ≥{SHARPNESS_MIN_RATIO}"
        ),
        note=(
            "⚠️ 替代方案：`pytesseract` 唔可用且唔准加依賴。規則 Q1 原文係 "
            "「image analysis / OCR / 程式斷言」（三者係『或』）。"
            "(a) canvas `fillText` 攔截 → 精確字級（比 OCR 更強）；"
            "(b) DOM `getBoundingClientRect` → 實際可讀尺寸；"
            "(c) cv2 邊緣銳利度（native vs 高斯模糊）→ 證明唔係模糊放大。"
            "若主代理要求真正 OCR 語義，須批准加 `pytesseract` + tesseract binary。"
        ),
    )


# ---------------------------------------------------------------------------
# Q8：無 tile seam
# ---------------------------------------------------------------------------
def seam_fractions(img: np.ndarray, inset: int = 6) -> tuple[float, float]:
    g = img[inset:-inset, inset:-inset].astype(np.int16)
    dx = np.abs(g[:, 1:] - g[:, :-1])
    dy = np.abs(g[1:, :] - g[:-1, :])
    col_frac = (dx > SEAM_EDGE_THRESHOLD).mean(axis=0)
    row_frac = (dy > SEAM_EDGE_THRESHOLD).mean(axis=1)
    return float(col_frac.max()), float(row_frac.max())


def check_q8(raw: dict[str, Any], rep: Report) -> None:
    results: list[dict[str, Any]] = []
    fails: list[str] = []
    for l in raw["levels"]:
        if not l.get("canvasPng"):
            continue
        img = imread(l["canvasPng"])
        if img is None:
            continue
        cmax, rmax = seam_fractions(img)
        bad = cmax >= SEAM_MAX_FRACTION or rmax >= SEAM_MAX_FRACTION
        results.append(
            {
                "anchor": l["anchor"],
                "z": l["target"],
                "colMaxFraction": round(cmax, 3),
                "rowMaxFraction": round(rmax, 3),
                "shape": list(img.shape[:2]),
            }
        )
        if bad:
            fails.append(f"{l['anchor']}Z{l['target']}(col={cmax:.2f},row={rmax:.2f})")

    rep.add(
        "Q8",
        "無 tile seam（相鄰 tile 邊界像素梯度）",
        "fail" if fails else ("pass" if results else "not_measured"),
        actual=results,
        threshold=f"任何欄／行嘅硬邊佔比 < {SEAM_MAX_FRACTION}",
        note=(
            f"硬邊 = |Δlum| > {SEAM_EDGE_THRESHOLD}。真正 tile seam 係一條橫跨成幅圖嘅直線"
            "（佔比 ≈ 1.0）；自然特徵（海岸線、道路）實測最多 ~0.23，故 0.5 有清楚分隔。"
            "分析用 canvas 匯出 PNG（純底圖，冇圖例／按鈕硬邊干擾）。"
        ),
    )


# ---------------------------------------------------------------------------
# Q9：tile payload
# ---------------------------------------------------------------------------
def check_q9(raw: dict[str, Any], rep: Report) -> None:
    net_max = max([t["bytes"] for t in raw.get("tiles", [])] or [0])
    net_sum = sum(t["bytes"] for t in raw.get("tiles", []))
    manifest_max = 0
    manifest_key = ""
    manifest_sum = 0
    tile_count = 0
    if MANIFEST_PATH.exists():
        man = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        files = man["layers"]["tiles"]["files"]
        tile_count = len(files)
        for k, v in files.items():
            b = v.get("bytes", 0)
            manifest_sum += b
            if b > manifest_max:
                manifest_max, manifest_key = b, k

    worst = max(net_max, manifest_max)
    ok = worst <= TILE_MAX_BYTES
    rep.add(
        "Q9",
        "Tile payload ≤ 1.0 MB（單一 tile）",
        "pass" if ok else "fail",
        actual={
            "networkMaxBytes": net_max,
            "networkRequests": len(raw.get("tiles", [])),
            "networkSumBytes": net_sum,
            "manifestMaxBytes": manifest_max,
            "manifestMaxTile": manifest_key,
            "manifestTileCount": tile_count,
            "manifestSumBytes": manifest_sum,
        },
        threshold=f"≤ {int(TILE_MAX_BYTES)} bytes",
        note=(
            "spec 原文係「單一 tile payload ≤1.0 MB」。另報 max zoom **視窗合計** —— "
            "B5 `tests/map-render.test.ts` 量到最壞 2×2 = 2.33 MB（需 tile_deg 0.05→0.02 "
            "重生成資產），該項屬已知 gap，唔喺 Q9 判定內。"
        ),
    )


# ---------------------------------------------------------------------------
# Q10：冷 zoom 阻塞
# ---------------------------------------------------------------------------
def check_q10(raw: dict[str, Any], rep: Report) -> None:
    cz = raw.get("coldZoom")
    if not cz:
        rep.add("Q10", "冷 zoom 阻塞 ≤ 300 ms", "not_measured")
        return
    max_ok = cz["maxMs"] <= COLD_ZOOM_MAX_MS
    sanity_ok = cz["totalMs"] <= COLD_ZOOM_TOTAL_SANITY_MS
    status = "pass" if (max_ok and sanity_ok) else "fail"
    rep.add(
        "Q10",
        f"冷 zoom 最長單一主線程阻塞 ≤ {COLD_ZOOM_MAX_MS} ms",
        status,
        actual={
            "longTaskCount": cz["longTasks"],
            "maxMs": cz["maxMs"],
            "maxOk": max_ok,
            "totalMs": cz["totalMs"],
            "totalSanityLimit": COLD_ZOOM_TOTAL_SANITY_MS,
            "totalSanityOk": sanity_ok,
            "wallMs": cz["wallMs"],
            "fps": cz["fps"],
        },
        threshold=(
            f"最長單一 ≤ {COLD_ZOOM_MAX_MS} ms（spec §7 字面）"
            f" 且 合計 ≤ {COLD_ZOOM_TOTAL_SANITY_MS} ms（崩壞界限，非 spec 要求）"
        ),
        note=(
            f"最長單一 {cz['maxMs']} ms（{'達標' if max_ok else '未達標'}）；"
            f"合計 {cz['totalMs']} ms 只作診斷＋崩壞界限"
            f"（{'OK' if sanity_ok else '超出'}）。"
            "⚠️ 2026-09-24 用戶授權主代理裁決：pass/fail 採 spec §7 字面嘅"
            "「單次最長阻塞 ≤ 300 ms」；「合計 ≤ 300 ms」係 A8/B5 引入嘅更嚴格"
            "內部基線，但實測同一 build 連跑 6 次嘅合計極差 33%（378–504 ms），"
            "而優化前係 632 ms —— 即係合計**無法穩定區分修好同未修好**，唔適合"
            "做 pass/fail。詳見 docs/progress/q10-cold-zoom-blocking.md §6。"
            "協定同 A8 `measure-jank.mjs` 一致（in-page dispatchEvent × 20）。"
        ),
    )


# ---------------------------------------------------------------------------
# Q11：no-fake-zoom 狀態
# ---------------------------------------------------------------------------
def check_q11(raw: dict[str, Any], rep: Report) -> None:
    nd = raw.get("noDetail") or {}
    sparse = nd.get("sparseState")
    dense = nd.get("denseState")
    drawn = bool(nd.get("drawnInSparse"))
    ok = sparse == "sparse" and dense == "ok" and drawn
    rep.add(
        "Q11",
        f"「{NO_DETAIL_TEXT}」狀態存在（低密度區）",
        "pass" if ok else "fail",
        actual={
            "constant": nd.get("constant"),
            "sparseState": sparse,
            "denseState": dense,
            "textDrawnInSparse": drawn,
            "drawnStringsSample": nd.get("drawnStrings", [])[:12],
        },
        threshold="稀疏區 data-detail-state=sparse；密集區=ok；狀態文字真係畫過",
        note=(
            "「文字真係畫過」由 canvas `fillText` 攔截確認 —— **免 OCR**，"
            "比 OCR 更精確（OCR 會受字型／抗鋸齒影響）。"
            "⚠️ `BaseGeometryLayer.tileBuildingCount` 係跨已載入圖磚**累加**，"
            "所以喺同一 session 先睇過密集區，之後去稀疏區會誤報 `ok`（已知）。"
        ),
    )


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="B9 Q1–Q11 視覺品質判定")
    ap.add_argument("--refresh", action="store_true", help="強制重跑 Node 量測")
    ap.add_argument("--report-only", action="store_true", help="只出報告，永遠 exit 0")
    args = ap.parse_args()

    raw = ensure_raw(args.refresh)
    rep = Report()

    check_q1(raw, rep)
    check_q2(raw, rep)
    check_q3(raw, rep)
    check_q4(raw, rep)
    check_q5(raw, rep)
    check_q6(raw, rep)
    check_q7(raw, rep)
    check_q8(raw, rep)
    check_q9(raw, rep)
    check_q10(raw, rep)
    check_q11(raw, rep)

    summary = {
        "pass": rep.count("pass"),
        "fail": rep.count("fail"),
        "needs_review": rep.count("needs_review"),
        "not_measured": rep.count("not_measured"),
    }
    report = {
        "schema": "b9.zoom-quality.report/1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "artifacts/b9-qa/zoom-quality-raw.json",
        "rawGeneratedAt": raw.get("generatedAt"),
        "thresholds": {
            "Z_TARGETS": Z_TARGETS,
            "FLAT_TOLERANCE": FLAT_TOLERANCE,
            "MEANGRAD_MIN_RATIO": MEANGRAD_MIN_RATIO,
            "ZONE_MIN": ZONE_MIN,
            "EVENT_MIN": EVENT_MIN,
            "LABEL_PASS_RATIO": LABEL_PASS_RATIO,
            "LABEL_MIN_FONT_PX": LABEL_MIN_FONT_PX,
            "SEAM_MAX_FRACTION": SEAM_MAX_FRACTION,
            "TILE_MAX_BYTES": TILE_MAX_BYTES,
            "COLD_ZOOM_MAX_MS": COLD_ZOOM_MAX_MS,
            "COLD_ZOOM_TOTAL_SANITY_MS": COLD_ZOOM_TOTAL_SANITY_MS,
            "SHARPNESS_MIN_RATIO": SHARPNESS_MIN_RATIO,
        },
        "checks": rep.checks,
        "summary": summary,
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- 印表 ----
    def pad(s: Any, n: int) -> str:
        return str(s).ljust(n)
    print()
    print("=" * 88)
    print("B9 zoom quality — Q1–Q11（spec §7）")
    print("=" * 88)
    print(pad("ID", 5), pad("狀態", 13), "項目")
    print("-" * 88)
    for c in rep.checks:
        mark = {
            "pass": "PASS",
            "fail": "FAIL",
            "needs_review": "NEEDS_REVIEW",
            "not_measured": "NOT_MEASURED",
        }[c["status"]]
        print(pad(c["id"], 5), pad(mark, 13), c["title"])
    print("-" * 88)
    print(
        f"PASS {summary['pass']} ｜ FAIL {summary['fail']} ｜ "
        f"NEEDS_REVIEW {summary['needs_review']} ｜ NOT_MEASURED {summary['not_measured']}"
    )
    print(f"報告：{REPORT_PATH.relative_to(ROOT)}")
    print("=" * 88)

    if summary["fail"]:
        print("\n未達標項目：")
        for c in rep.checks:
            if c["status"] == "fail":
                print(f" - {c['id']} {c['title']}")
                if c.get("note"):
                    print(f"     {c['note']}")

    if args.report_only:
        return 0
    if summary["needs_review"]:
        print(
            f"\n⚠️ 有 {summary['needs_review']} 項 NEEDS_REVIEW（唔係 FAIL，但需要主代理決定）"
            " —— 見上面逐項 note。"
        )
    # 只有 FAIL 會令 exit code 非零。NEEDS_REVIEW 係「工具判定唔到」，
    # 唔應該同 FAIL 混為一談（但報告／stdout 都會明確標示）。
    return 1 if summary["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

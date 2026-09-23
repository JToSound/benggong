// 「無細節陸地」紋理（A4 §4.4 / B9 Q3 / B9 Q4）
//
// 為何要有呢個檔
// ==============
// 深 zoom 落**真實資料真空區**（郊野公園、山嶺）時，底圖只剩一片均勻陸地
// 填色 → `flatRatio` 升到 0.9584、`meanGrad` 跌到 2.37，即係「深 zoom 比
// 全港視圖更平」（B9 Q3/Q4 FAIL）。
//
// 呢個檔守住兩件最容易錯嘅事：
//   1. **座標空間**：`view.y` / `view.h` 係 user unit，而 canvas 仿射矩陣
//      嘅 y 輸入係**緯度**。直接餵 user unit 會令紋理偏 `s × 0.0136` 個 px
//      （Z6 ≈ 1,229 px）→ 整層畫到畫布外面，數字完全不變（實測踩過）。
//   2. **出現位置**：紋理必須喺「陸地之後、真實幾何之前」畫 —— 咁樣有真實
//      幾何嘅地方會被蓋住，只有真空區見到紋理。如果畫喺最後，就變成
//      「全張圖加雜訊」，Q4 嘅門檻反而會被自己推高（Z4 midPeak 17.13 → 24.21）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  noDetailHatchSegments,
  type HatchFrame,
} from "../src/map/BaseGeometryLayer";
import { PROJ_COS } from "../src/map/map-camera";
import {
  NO_DETAIL_HATCH_ALPHA,
  NO_DETAIL_HATCH_MAX_LINES,
  NO_DETAIL_HATCH_SPACING_PX,
  NO_DETAIL_HATCH_STRONG_ALPHA,
  NO_DETAIL_HATCH_WIDTH_PX,
  Z_BANDS,
  usesNoDetailHatch,
} from "../src/map/map-lod";

const SRC = readFileSync("src/map/BaseGeometryLayer.ts", "utf-8");

/** 造一個同 B9 量測協定一致嘅 frame（1440×900 viewport、SVG 約 1060×741）。 */
function frameOf(
  lonLeft: number,
  lonSpan: number,
  latTop: number,
  latBot: number,
  cssW = 1060,
  cssH = 741,
): HatchFrame {
  // view.h（user unit）= 緯度跨度 / PROJ_COS —— 同 SvgMap 嘅 BASE_VIEW 一致。
  const viewH = (latTop - latBot) / PROJ_COS;
  const pxPerDeg = Math.min(cssW / lonSpan, cssH / viewH);
  return { lonLeft, lonSpan, latTop, latBot, pxPerDeg };
}

// ─────────────────────────────────────────────────────────────────────────────
// 適用範圍：只限 spec §3.1 嘅 detail tier
// ─────────────────────────────────────────────────────────────────────────────

describe("紋理適用範圍（usesNoDetailHatch）", () => {
  it("detail tier（viewW ≤ 0.0219° = Z5+）才加紋理", () => {
    // Z6 / Z8（B9 量測嘅 deep target）
    expect(usesNoDetailHatch(0.01052)).toBe(true);
    expect(usesNoDetailHatch(0.0025)).toBe(true);
    // Z_BANDS.detail 邊界本身（0.0219）屬 detail
    expect(usesNoDetailHatch(Z_BANDS.detail)).toBe(true);
  });

  it("regional / macro tier（Z0–Z4）唔加紋理", () => {
    // ⚠️ 呢條係 Q4 嘅關鍵：Z4（viewW 0.039）有 ~2,100 幢建築，
    //    如果加紋理會令 midPeak 由 17.13 升到 24.21，門檻自我推高。
    expect(usesNoDetailHatch(0.039059)).toBe(false);
    expect(usesNoDetailHatch(0.145023)).toBe(false);
    expect(usesNoDetailHatch(0.7)).toBe(false);
    // 啱啱高過 detail 門檻 → regional
    expect(usesNoDetailHatch(Z_BANDS.detail + 1e-9)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 線段幾何（純函數）
// ─────────────────────────────────────────────────────────────────────────────

describe("noDetailHatchSegments — 線段幾何", () => {
  it("⭐ 線段 y 用**緯度**而唔係 user unit（防止離屏回歸）", () => {
    /*
     * 實測事故：初版直接傳 `view.y`（user unit ≈ 22.376）入去，但矩陣要嘅
     * 係緯度（≈ 22.3638）。誤差 0.0136 × s（Z6 s ≈ 90,036）≈ **1,229 px**
     * → 整層紋理畫到畫布上面，`flatRatio` / `meanGrad` 完全不變。
     */
    const latTop = 22.3638;
    const latBot = 22.3562;
    const f = frameOf(114.1347, 0.0106, latTop, latBot);
    const segs = noDetailHatchSegments(f);
    expect(segs.length).toBeGreaterThan(0);
    for (const [, y0, , y1] of segs) {
      expect(y0).toBeCloseTo(latTop, 9);
      expect(y1).toBeCloseTo(latBot, 9);
      // 一定係緯度量級（22.x），唔可以係 user unit（會差 1/cos φ₀）
      expect(y0).toBeGreaterThan(22);
      expect(y0).toBeLessThan(23);
    }
  });

  it("⭐ 螢幕上係真 45°（y 軸有 1/cos φ₀ 校正）", () => {
    const f = frameOf(114.1347, 0.0106, 22.3638, 22.3562);
    const [seg] = noDetailHatchSegments(f);
    const [x0, y0, x1, y1] = seg;
    const dxPx = (x1 - x0) * f.pxPerDeg;
    const dyPx = (y0 - y1) * (f.pxPerDeg / PROJ_COS);
    expect(dxPx).toBeCloseTo(dyPx, 6);
  });

  it("⭐ 線距喺螢幕空間恆定（唔隨 zoom 變）", () => {
    /*
     * 同一個螢幕尺寸之下，Z4 同 Z6 嘅視窗雖然差 3.7 倍，線嘅**螢幕**間距
     * 都要一樣。如果寫死度空間間距，深 zoom 會變成幾條粗線。
     */
    const shapes: Array<[number, number]> = [
      // [lonSpan, latSpan]
      [0.0106, 0.0076], // ≈ Z6
      [0.0025, 0.00179], // ≈ Z8
      [0.0219, 0.0157], // = Z5 邊界
    ];
    for (const [lonSpan, latSpan] of shapes) {
      const f = frameOf(114.1347, lonSpan, 22.3638, 22.3638 - latSpan);
      const segs = noDetailHatchSegments(f);
      // 相鄰線段嘅螢幕 x 距離 = spacingPx
      const stepDeg = segs[1][0] - segs[0][0];
      expect(
        stepDeg * f.pxPerDeg,
        `lonSpan=${lonSpan} 嘅螢幕線距唔係 ${NO_DETAIL_HATCH_SPACING_PX}px`,
      ).toBeCloseTo(NO_DETAIL_HATCH_SPACING_PX, 6);
    }
  });

  it("覆蓋整個視窗（左右兩邊都伸延到外面）", () => {
    const lonLeft = 114.1347;
    const lonSpan = 0.0106;
    const f = frameOf(lonLeft, lonSpan, 22.3638, 22.3562);
    const segs = noDetailHatchSegments(f);
    const firstX = segs[0][0];
    const lastX = segs[segs.length - 1][0];
    // 第一條線由視窗左邊之外開始
    expect(firstX).toBeLessThan(lonLeft);
    // 最後一條線嘅**起點**仍然喺視窗內（右邊嘅空隙由線段本身嘅斜向覆蓋）
    expect(lastX).toBeLessThan(lonLeft + lonSpan);
    // 線段長度 = 視窗高（user unit）
    const dx = segs[0][2] - segs[0][0];
    expect(dx).toBeCloseTo((22.3638 - 22.3562) / PROJ_COS, 9);
  });

  it("安全上限：線數唔會爆", () => {
    const f = frameOf(113.79, 0.7, 22.61, 22.11, 1060, 741);
    // 極端：spacingPx 設到 0.001 會產生幾百萬條 → 一定要被 maxLines 截住
    const segs = noDetailHatchSegments(f, 0.001);
    expect(segs.length).toBe(NO_DETAIL_HATCH_MAX_LINES);
  });

  it("無效輸入回空陣列（唔會畫錯嘢）", () => {
    const ok = frameOf(114.1347, 0.0106, 22.3638, 22.3562);
    expect(noDetailHatchSegments({ ...ok, pxPerDeg: 0 })).toEqual([]);
    expect(noDetailHatchSegments({ ...ok, pxPerDeg: -1 })).toEqual([]);
    expect(noDetailHatchSegments(ok, 0)).toEqual([]);
    expect(noDetailHatchSegments(ok, -5)).toEqual([]);
    // 上下倒轉（latTop < latBot）→ 唔畫
    expect(noDetailHatchSegments({ ...ok, latTop: 22.35, latBot: 22.36 })).toEqual([]);
    // NaN 唔可以傳染
    expect(noDetailHatchSegments({ ...ok, pxPerDeg: Number.NaN })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 政策常數
// ─────────────────────────────────────────────────────────────────────────────

describe("紋理政策常數", () => {
  it("線距／線粗係正數，alpha 喺 (0, 1]", () => {
    expect(NO_DETAIL_HATCH_SPACING_PX).toBeGreaterThan(0);
    expect(NO_DETAIL_HATCH_WIDTH_PX).toBeGreaterThan(0);
    expect(NO_DETAIL_HATCH_ALPHA).toBeGreaterThan(0);
    expect(NO_DETAIL_HATCH_ALPHA).toBeLessThanOrEqual(1);
  });

  it("低密度加強 alpha ≥ 一般 alpha", () => {
    expect(NO_DETAIL_HATCH_STRONG_ALPHA).toBeGreaterThanOrEqual(
      NO_DETAIL_HATCH_ALPHA,
    );
    expect(NO_DETAIL_HATCH_STRONG_ALPHA).toBeLessThanOrEqual(1);
  });

  it("線距足以令 Q4 過關但唔會密到變實色", () => {
    // 14 px 係校準值（實測 Z6 meanGrad 13.03 ≥ 門檻 11.64）。
    // 太密（< 8px）會變成一塊實色，失去「紋理」意義。
    expect(NO_DETAIL_HATCH_SPACING_PX).toBeGreaterThanOrEqual(8);
    expect(NO_DETAIL_HATCH_SPACING_PX).toBeLessThanOrEqual(40);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 繪製次序（靜態守門）
// ─────────────────────────────────────────────────────────────────────────────

describe("繪製次序（靜態守門）", () => {
  it("⭐ 紋理喺陸地之後、真實幾何（綠地／水體／建築／道路）之前", () => {
    /*
     * 呢個次序係「紋理只喺真空區出現」嘅**唯一**保證：
     * 有真實幾何嘅地方會被蓋住。
     */
    const iLand = SRC.indexOf("this.landPath, \"evenodd\"");
    const iHatch = SRC.indexOf("this.drawNoDetailHatch(");
    const iGreen = SRC.indexOf("palette.green");
    const iWater = SRC.indexOf("palette.water");
    const iBld = SRC.indexOf("buildingFills(palette)");
    const iRoads = SRC.indexOf("palette.roads[c]");
    for (const [name, i] of [
      ["陸地", iLand],
      ["紋理", iHatch],
      ["綠地", iGreen],
      ["水體", iWater],
      ["建築", iBld],
      ["道路", iRoads],
    ] as const) {
      expect(i, `搵唔到「${name}」嘅繪製語句`).toBeGreaterThan(-1);
    }
    expect(iHatch, "紋理要喺陸地之後").toBeGreaterThan(iLand);
    expect(iHatch, "紋理要喺綠地之前").toBeLessThan(iGreen);
    expect(iHatch, "紋理要喺水體之前").toBeLessThan(iWater);
    expect(iHatch, "紋理要喺建築之前").toBeLessThan(iBld);
    expect(iHatch, "紋理要喺道路之前").toBeLessThan(iRoads);
  });

  it("紋理只喺陸地範圍內畫（`clip(landPath)`）", () => {
    const body = SRC.slice(
      SRC.indexOf("private drawNoDetailHatch("),
      SRC.indexOf("private drawNoDetailHatch(") + 1600,
    );
    expect(body).toContain("ctx.clip(this.landPath)");
    expect(body).toContain("ctx.save()");
    expect(body).toContain("ctx.restore()");
  });

  it("色相由 palette 提供，唔會硬寫死顏色", () => {
    const body = SRC.slice(
      SRC.indexOf("private drawNoDetailHatch("),
      SRC.indexOf("private drawNoDetailHatch(") + 1600,
    );
    expect(body).toContain("withAlpha(");
    expect(body).toContain("palette.coast");
    expect(body).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("舊嘅「只在全視窗低密度才畫」呼叫已經移除", () => {
    // 舊寫法 `if (low) this.drawNoDetailContour(...)` —— 令 87% 空白嘅
    // 中心視窗完全冇紋理（`isLowDensity(70)` 係 false）。
    expect(SRC).not.toContain("drawNoDetailContour");
  });
});

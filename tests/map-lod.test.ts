// B5 — LOD 政策（`src/map/map-lod.ts`）同相機幾何（`src/map/map-camera.ts`）
//
// 為何要有呢個檔
// ==============
// spec §3 將「邊個 zoom 應該有幾多內容」正式定義成政策，而政策之前係
// 散落喺 `SvgMap.ts`（`LABEL_FADE_IN`、`MAX_SCALE`）同 `VectorBasemap.ts`
// （`pickLevel` 嘅 `0.35 / 0.05`）兩處嘅**未文件化硬編碼**。
//
// 呢個檔鎖死三件事：
//   1. Z 定義（`Z = log2(0.70 / viewW)`）同門檻邊界值（含 ±1e-9）；
//   2. **兩條正交嘅 LOD 軸**唔可以合併 —— 內容密度軸用 `0.175 / 0.0219`，
//      幾何資料集軸用 `0.35 / 0.05`。合併會令兩個既有 e2e 變紅（見下）；
//   3. 相機幾何係純函數，可以喺 node 直接驗（唔需要 DOM）。
//
// ⚠️ 為何「兩條軸」要寫成測試而唔止註釋
// ------------------------------------
// `tests/phase-i.e2e.test.ts` 由全港按 4 次放大 → viewW = 0.70/1.3⁴
// = 0.2451°，斷言 `data-basemap-level ≥ 1`；`tests/phase-j-lod.test.ts`
// 按 13 次 → viewW = 0.0231°，斷言 `=== 2`。如果將 spec 嘅
// `0.175 / 0.0219` 硬套落幾何軸，兩者都會變紅。呢兩個檔唔喺 B5
// 可寫範圍，所以政策層明文分開，並由以下測試守住。

import { describe, expect, it } from "vitest";

import basemapCoords from "../public/assets/hk-basemap-coords.json";
import {
  BASEMAP_LEVEL_THRESHOLDS,
  BASE_VIEW_W,
  BUILDING_ALPHA_RANGE,
  BUILDING_EDGE_WIDTH_PX,
  CHAPTER_WINDOW,
  LOW_DENSITY_BUILDING_THRESHOLD,
  NO_DETAIL_TEXT,
  Z,
  Z_BANDS,
  chapterWindowFor,
  includesTilePoi,
  isLowDensity,
  maxLabelRank,
  selectBasemapLevel,
  selectTier,
  selectZoneLod,
  tierOfZ,
} from "../src/map/map-lod";
import {
  PROJ_COS,
  baseViewOf,
  clampView,
  easeInOutCubic,
  flyTo,
  geoBoundsOfView,
  projectLonLat,
  pxToUserUnits,
  scaleView,
  softFocus,
  viewBoxForGeoBounds,
  viewYToLat,
  type GeoBbox,
} from "../src/map/map-camera";

const BBOX = basemapCoords.bbox as GeoBbox;
const BASE = baseViewOf(BBOX);

/** 由全港按 n 次 ×1.3 放大之後嘅 viewBox 寬（同 e2e 按鈕行為一致）。 */
const zoomedW = (n: number): number => BASE_VIEW_W / 1.3 ** n;

describe("map-lod: Z 定義（spec §3.1）", () => {
  it("Z = log2(0.70 / viewW)", () => {
    expect(Z(BASE_VIEW_W)).toBeCloseTo(0, 12);
    expect(Z(BASE_VIEW_W / 2)).toBeCloseTo(1, 12);
    expect(Z(BASE_VIEW_W / 4)).toBeCloseTo(2, 12);
    expect(Z(BASE_VIEW_W / 64)).toBeCloseTo(6, 12);
  });

  it("Z 隨 viewW 減半而 +1", () => {
    for (const w of [0.7, 0.35, 0.175, 0.0875, 0.04375]) {
      expect(Z(w / 2) - Z(w)).toBeCloseTo(1, 12);
    }
  });

  it("可以傳自訂基準寬（方便測試公式本身）", () => {
    expect(Z(1, 1)).toBeCloseTo(0, 12);
    expect(Z(1, 8)).toBeCloseTo(3, 12);
  });

  it("spec 門檻對應嘅 Z 值：0.175 → Z2、0.0219 → 約 Z5", () => {
    expect(Z(Z_BANDS.macro)).toBeCloseTo(2, 6);
    expect(Z(Z_BANDS.detail)).toBeGreaterThan(4.99);
    expect(Z(Z_BANDS.detail)).toBeLessThan(5.0);
  });
});

describe("map-lod: 內容密度 tier（selectTier / tierOfZ）", () => {
  it("三段：macro > 0.175°、regional 0.0219–0.175°、detail ≤ 0.0219°", () => {
    expect(selectTier(0.7)).toBe("macro");
    expect(selectTier(0.176)).toBe("macro");
    expect(selectTier(0.175)).toBe("regional");
    expect(selectTier(0.05)).toBe("regional");
    expect(selectTier(0.022)).toBe("regional");
    expect(selectTier(0.0219)).toBe("detail");
    expect(selectTier(0.005)).toBe("detail");
  });

  it("門檻邊界係嚴格大於（±1e-9 要分得開）", () => {
    expect(selectTier(Z_BANDS.macro + 1e-9)).toBe("macro");
    expect(selectTier(Z_BANDS.macro - 1e-9)).toBe("regional");
    expect(selectTier(Z_BANDS.detail + 1e-9)).toBe("regional");
    expect(selectTier(Z_BANDS.detail - 1e-9)).toBe("detail");
  });

  it("tierOfZ 同 selectTier 一致（由 viewW 反推，唔會有第二組門檻）", () => {
    // ⚠️ 只驗內部點：門檻值 0.175 / 0.0219 係十進位近似（0.7/2⁵
    // = 0.021875），喺邊界上 round-trip 冇保證 —— 而政策本身以
    // `selectTier(viewW)` 為準（見 map-lod.ts 嘅說明）。
    for (const w of [0.7, 0.3, 0.1, 0.05, 0.005]) {
      expect(tierOfZ(Z(w))).toBe(selectTier(w));
    }
  });

  it("tierOfZ 隨 Z 遞增而單調（macro → regional → detail）", () => {
    const seq = [0, 1, 2.5, 3, 4.5, 6, 8].map(tierOfZ);
    const order = { macro: 0, regional: 1, detail: 2 } as const;
    for (let i = 1; i < seq.length; i++) {
      expect(order[seq[i]]).toBeGreaterThanOrEqual(order[seq[i - 1]]);
    }
    expect(seq[0]).toBe("macro");
    expect(seq[seq.length - 1]).toBe("detail");
  });
});

describe("map-lod: Zone LOD 三層（spec §3.2）", () => {
  it("cluster / boundary / full 同 tier 用同一組門檻", () => {
    expect(selectZoneLod(0.7)).toBe("cluster");
    expect(selectZoneLod(0.175)).toBe("boundary");
    expect(selectZoneLod(0.022)).toBe("boundary");
    expect(selectZoneLod(0.0219)).toBe("full");
    expect(selectZoneLod(0.005)).toBe("full");
  });

  it("邊界值 ±1e-9 分得開", () => {
    expect(selectZoneLod(Z_BANDS.macro + 1e-9)).toBe("cluster");
    expect(selectZoneLod(Z_BANDS.macro - 1e-9)).toBe("boundary");
    expect(selectZoneLod(Z_BANDS.detail + 1e-9)).toBe("boundary");
    expect(selectZoneLod(Z_BANDS.detail - 1e-9)).toBe("full");
  });

  it("三層都係「點畫」而唔係「畫唔畫」——函數永遠有返回值", () => {
    for (const w of [10, 1, 0.7, 0.175, 0.05, 0.0219, 1e-9]) {
      expect(["cluster", "boundary", "full"]).toContain(selectZoneLod(w));
    }
  });
});

describe("map-lod: 幾何資料集軸（selectBasemapLevel）—— 唔可以同內容軸合併", () => {
  it("0.35 / 0.05 三段", () => {
    expect(selectBasemapLevel(0.7)).toBe(0);
    expect(selectBasemapLevel(0.351)).toBe(0);
    expect(selectBasemapLevel(0.35)).toBe(1);
    expect(selectBasemapLevel(0.051)).toBe(1);
    expect(selectBasemapLevel(0.05)).toBe(2);
    expect(selectBasemapLevel(0.01)).toBe(2);
  });

  it("邊界值 ±1e-9 分得開", () => {
    const { l1Max, l2Max } = BASEMAP_LEVEL_THRESHOLDS;
    expect(selectBasemapLevel(l1Max + 1e-9)).toBe(0);
    expect(selectBasemapLevel(l1Max - 1e-9)).toBe(1);
    expect(selectBasemapLevel(l2Max + 1e-9)).toBe(1);
    expect(selectBasemapLevel(l2Max - 1e-9)).toBe(2);
  });

  it("兩個既有 e2e 嘅縮放級別仍然落到正確幾何層", () => {
    // phase-i.e2e：4 次放大 → 0.2451°
    expect(selectBasemapLevel(zoomedW(4))).toBeGreaterThanOrEqual(1);
    // phase-j-lod：13 次放大 → 0.0231°
    expect(selectBasemapLevel(zoomedW(13))).toBe(2);
  });

  it("⚠️ 同一點上兩條軸刻意唔一致（D-1 嘅理由）", () => {
    // 4 次放大：內容仍然 macro（0.2451 > 0.175），幾何已經 level 1
    expect(selectTier(zoomedW(4))).toBe("macro");
    expect(selectBasemapLevel(zoomedW(4))).toBe(1);
    // 13 次放大：內容 regional（0.0231 > 0.0219），幾何已經 level 2
    expect(selectTier(zoomedW(13))).toBe("regional");
    expect(selectBasemapLevel(zoomedW(13))).toBe(2);
  });

  it("門檻常數同 spec §3.1 嘅內容軸門檻唔同值", () => {
    expect(BASEMAP_LEVEL_THRESHOLDS.l1Max).not.toBe(Z_BANDS.macro);
    expect(BASEMAP_LEVEL_THRESHOLDS.l2Max).not.toBe(Z_BANDS.detail);
  });
});

describe("map-lod: 密度政策（label rank / tile POI / 建築 / no-fake-zoom）", () => {
  it("maxLabelRank：macro 2、regional 4、detail 5", () => {
    expect(maxLabelRank("macro")).toBe(2);
    expect(maxLabelRank("regional")).toBe(4);
    expect(maxLabelRank("detail")).toBe(5);
  });

  it("maxLabelRank 單調遞增（越深睇得越多）", () => {
    expect(maxLabelRank("macro")).toBeLessThan(maxLabelRank("regional"));
    expect(maxLabelRank("regional")).toBeLessThan(maxLabelRank("detail"));
  });

  it("tile POI（rank 5）只有 detail tier 才納入（A4 G2）", () => {
    expect(includesTilePoi("macro")).toBe(false);
    expect(includesTilePoi("regional")).toBe(false);
    expect(includesTilePoi("detail")).toBe(true);
  });

  it("建築對比政策：alpha 0.35–0.65、描邊 0.7px（A4 G3）", () => {
    const [lo, hi] = BUILDING_ALPHA_RANGE;
    expect(lo).toBe(0.35);
    expect(hi).toBe(0.65);
    expect(lo).toBeLessThan(hi);
    // 舊值上限 0.42 → 新下限 0.35 已經接近舊上限，即係整體提亮
    expect(lo).toBeGreaterThan(0.2);
    expect(BUILDING_EDGE_WIDTH_PX).toBe(0.7);
    expect(BUILDING_EDGE_WIDTH_PX).toBeGreaterThan(0.35);
  });

  it("isLowDensity：< 24 幢 = 稀疏（no-fake-zoom）", () => {
    expect(isLowDensity(0)).toBe(true);
    expect(isLowDensity(LOW_DENSITY_BUILDING_THRESHOLD - 1)).toBe(true);
    expect(isLowDensity(LOW_DENSITY_BUILDING_THRESHOLD)).toBe(false);
    expect(isLowDensity(9999)).toBe(false);
  });

  it("no-fake-zoom 文案係 spec §4.3 指定嘅一句", () => {
    expect(NO_DETAIL_TEXT).toBe("此區未有細節資料");
  });
});

describe("map-lod: 章節窗口政策（spec §3.3）", () => {
  it("location ± 5 章、event ± 1 章", () => {
    expect(CHAPTER_WINDOW.location).toBe(5);
    expect(CHAPTER_WINDOW.event).toBe(1);
    expect(chapterWindowFor("location")).toBe(5);
    expect(chapterWindowFor("event")).toBe(1);
  });

  it("「顯示全部」= Infinity（唔過濾）", () => {
    expect(chapterWindowFor("event", true)).toBe(Number.POSITIVE_INFINITY);
    expect(chapterWindowFor("location", true)).toBe(Number.POSITIVE_INFINITY);
  });

  it("location 窗口一定要比 event 闊（否則 event 唔會比 location 密）", () => {
    expect(chapterWindowFor("location")).toBeGreaterThan(chapterWindowFor("event"));
  });

  it("zone 唔喺呢個政策入面（規則 L1：zone 永遠 render）", () => {
    // 只有 location / event 兩個 kind；zone 冇窗口函數可以傳入
    expect(Object.keys(CHAPTER_WINDOW).sort()).toEqual(["event", "location"]);
  });
});

describe("map-camera: 基準視圖同投影", () => {
  it("baseViewOf 由 bbox 推導，垂直乘 1/cos(φ₀)", () => {
    expect(BASE.x).toBeCloseTo(BBOX.lon_min, 12);
    expect(BASE.y).toBeCloseTo(BBOX.lat_min, 12);
    expect(BASE.w).toBeCloseTo(BBOX.lon_max - BBOX.lon_min, 12);
    expect(BASE.h).toBeCloseTo((BBOX.lat_max - BBOX.lat_min) / PROJ_COS, 12);
  });

  it("投影：四個角落對應 viewBox 四角", () => {
    expect(projectLonLat(BBOX, BASE, BBOX.lon_min, BBOX.lat_max)).toEqual({
      x: BASE.x,
      y: BASE.y,
    });
    const br = projectLonLat(BBOX, BASE, BBOX.lon_max, BBOX.lat_min);
    expect(br.x).toBeCloseTo(BASE.x + BASE.w, 9);
    expect(br.y).toBeCloseTo(BASE.y + BASE.h, 9);
  });

  it("投影會 clamp 出界座標（唔會畫到畫面外）", () => {
    expect(projectLonLat(BBOX, BASE, 0, 0)).toEqual({ x: BASE.x, y: BASE.y + BASE.h });
    expect(projectLonLat(BBOX, BASE, 999, 999)).toEqual({ x: BASE.x + BASE.w, y: BASE.y });
  });

  it("viewYToLat 係 projectLonLat 嘅逆運算（唔可以漏 lat_min）", () => {
    for (const lat of [BBOX.lat_min, 22.3, 22.36, BBOX.lat_max]) {
      const { y } = projectLonLat(BBOX, BASE, 114.1, lat);
      expect(viewYToLat(BBOX, y)).toBeCloseTo(lat, 9);
    }
  });

  it("geoBoundsOfView：全港視圖 → 就係 bbox 本身", () => {
    const g = geoBoundsOfView(BBOX, BASE, BASE);
    expect(g.lon_min).toBeCloseTo(BBOX.lon_min, 9);
    expect(g.lon_max).toBeCloseTo(BBOX.lon_max, 9);
    expect(g.lat_min).toBeCloseTo(BBOX.lat_min, 9);
    expect(g.lat_max).toBeCloseTo(BBOX.lat_max, 9);
  });

  it("geoBoundsOfView：中央一半視窗 → 經緯範圍都收窄一半", () => {
    const half = clampView(
      { x: BASE.x + BASE.w / 4, y: BASE.y + BASE.h / 4, w: BASE.w / 2, h: BASE.h / 2 },
      BASE,
    );
    const g = geoBoundsOfView(BBOX, BASE, half);
    expect(g.lon_max - g.lon_min).toBeCloseTo((BBOX.lon_max - BBOX.lon_min) / 2, 9);
    expect(g.lat_max - g.lat_min).toBeCloseTo((BBOX.lat_max - BBOX.lat_min) / 2, 9);
  });
});

describe("map-camera: clampView / scaleView", () => {
  it("clampView 唔會畀視窗移出底圖", () => {
    const v = clampView({ x: BASE.x - 5, y: BASE.y - 5, w: 0.1, h: 0.1 }, BASE);
    expect(v.x).toBeCloseTo(BASE.x, 12);
    expect(v.y).toBeCloseTo(BASE.y, 12);
    const w = clampView({ x: BASE.x + 99, y: BASE.y + 99, w: 0.1, h: 0.1 }, BASE);
    expect(w.x).toBeCloseTo(BASE.x + BASE.w - 0.1, 12);
    expect(w.y).toBeCloseTo(BASE.y + BASE.h - 0.1, 12);
  });

  it("clampView 唔改尺寸", () => {
    const v = clampView({ x: 0, y: 0, w: 0.2, h: 0.3 }, BASE);
    expect(v.w).toBe(0.2);
    expect(v.h).toBe(0.3);
  });

  it("視窗大過底圖 → 置中（唔會出現負數 range）", () => {
    const big = { x: 0, y: 0, w: BASE.w * 2, h: BASE.h * 2 };
    const v = clampView(big, BASE);
    expect(v.x).toBeCloseTo(BASE.x + (BASE.w - big.w) / 2, 12);
    expect(v.y).toBeCloseTo(BASE.y + (BASE.h - big.h) / 2, 12);
  });

  it("scaleView 以中心縮放，長寬比不變", () => {
    const v = scaleView(BASE, BASE, 2);
    expect(v.w).toBeCloseTo(BASE.w / 2, 12);
    expect(v.h).toBeCloseTo(BASE.h / 2, 12);
    // 置中：中心點唔郁
    expect(v.x + v.w / 2).toBeCloseTo(BASE.x + BASE.w / 2, 9);
    expect(v.y + v.h / 2).toBeCloseTo(BASE.y + BASE.h / 2, 9);
  });

  it("scaleView 受 maxScale / minScale 夾住", () => {
    let v = BASE;
    for (let i = 0; i < 50; i++) v = scaleView(v, BASE, 2, { maxScale: 64 });
    expect(v.w).toBeCloseTo(BASE.w / 64, 12);

    let u = BASE;
    for (let i = 0; i < 50; i++) u = scaleView(u, BASE, 0.5, { minScale: 1 });
    expect(u.w).toBeCloseTo(BASE.w, 12);
  });

  it("scaleView 支援錨點（雙指縮放：手指下面嘅點唔郁）", () => {
    const anchor = { fx: 0.25, fy: 0.75 };
    const v = scaleView(BASE, BASE, 2, { anchorFrac: anchor });
    const anchorX = BASE.x + anchor.fx * BASE.w;
    const anchorY = BASE.y + anchor.fy * BASE.h;
    expect(v.x + anchor.fx * v.w).toBeCloseTo(anchorX, 9);
    expect(v.y + anchor.fy * v.h).toBeCloseTo(anchorY, 9);
  });
});

describe("map-camera: pxToUserUnits（preserveAspectRatio=meet）", () => {
  it("用 min(rectW/view.w, rectH/view.h)，唔係兩軸獨立", () => {
    const view = { x: 0, y: 0, w: 1, h: 0.5 };
    // 元素比 viewBox 闊 → 高度係限制軸
    expect(pxToUserUnits(view, 1000, 400)).toBeCloseTo(1 / 800, 12);
    // 元素比 viewBox 高 → 闊度係限制軸
    expect(pxToUserUnits(view, 400, 1000)).toBeCloseTo(1 / 400, 12);
  });

  it("零尺寸 → 0（唔會除零）", () => {
    expect(pxToUserUnits(BASE, 0, 0)).toBe(0);
  });
});

describe("map-camera: viewBoxForGeoBounds（flyTo 目標）", () => {
  it("單點章節唔會產生 0 尺寸 viewBox（minSpan 0.02）", () => {
    const v = viewBoxForGeoBounds(BBOX, BASE, {
      lon_min: 114.26,
      lon_max: 114.26,
      lat_min: 22.31,
      lat_max: 22.31,
    });
    expect(v.w).toBeGreaterThan(0);
    expect(v.h).toBeGreaterThan(0);
    // 0.02° + 25% padding 後仍然 ≥ 0.02
    expect(v.w).toBeGreaterThanOrEqual(0.02);
  });

  it("padding 令目標比原本 bounds 闊", () => {
    const bounds = { lon_min: 114.2, lon_max: 114.3, lat_min: 22.25, lat_max: 22.35 };
    const withPad = viewBoxForGeoBounds(BBOX, BASE, bounds, { padding: 0.25 });
    const noPad = viewBoxForGeoBounds(BBOX, BASE, bounds, { padding: 0 });
    expect(withPad.w).toBeGreaterThan(noPad.w);
  });

  it("目標一定落喺縮放範圍之內（唔會露出黑邊）", () => {
    const tiny = viewBoxForGeoBounds(
      BBOX,
      BASE,
      { lon_min: 114.26, lon_max: 114.2601, lat_min: 22.31, lat_max: 22.3101 },
      { maxScale: 64, minScale: 1 },
    );
    expect(tiny.w).toBeGreaterThanOrEqual(BASE.w / 64 - 1e-12);
    expect(tiny.w).toBeLessThanOrEqual(BASE.w + 1e-12);
  });

  it("目標永遠喺 bbox 之內", () => {
    const v = viewBoxForGeoBounds(BBOX, BASE, BBOX, { padding: 0.25 });
    expect(v.x).toBeGreaterThanOrEqual(BASE.x - 1e-12);
    expect(v.y).toBeGreaterThanOrEqual(BASE.y - 1e-12);
    expect(v.x + v.w).toBeLessThanOrEqual(BASE.x + BASE.w + 1e-12);
    expect(v.y + v.h).toBeLessThanOrEqual(BASE.y + BASE.h + 1e-12);
  });

  it("長寬比同基準視圖一致", () => {
    const v = viewBoxForGeoBounds(BBOX, BASE, {
      lon_min: 114.2,
      lon_max: 114.3,
      lat_min: 22.25,
      lat_max: 22.35,
    });
    expect(v.h / v.w).toBeCloseTo(BASE.h / BASE.w, 9);
  });
});

describe("map-camera: softFocus / easeInOutCubic / flyTo", () => {
  const target = { x: BASE.x + 0.1, y: BASE.y + 0.1, w: 0.1, h: 0.05 };

  it("softFocus(0) 唔郁、softFocus(1) 等於目標、中間線性", () => {
    expect(softFocus(BASE, target, 0)).toEqual(BASE);
    const end = softFocus(BASE, target, 1);
    expect(end.x).toBeCloseTo(target.x, 12);
    expect(end.y).toBeCloseTo(target.y, 12);
    expect(end.w).toBeCloseTo(target.w, 12);
    expect(end.h).toBeCloseTo(target.h, 12);
    const mid = softFocus(BASE, target, 0.5);
    expect(mid.x).toBeCloseTo((BASE.x + target.x) / 2, 12);
    expect(mid.w).toBeCloseTo((BASE.w + target.w) / 2, 12);
  });

  it("softFocus 夾到 0–1（唔會 overshoot）", () => {
    expect(softFocus(BASE, target, -5)).toEqual(BASE);
    const over = softFocus(BASE, target, 5);
    expect(over.x).toBeCloseTo(target.x, 12);
    expect(over.w).toBeCloseTo(target.w, 12);
  });

  it("easeInOutCubic：0 → 0、0.5 → 0.5、1 → 1、單調遞增", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const e = easeInOutCubic(Math.min(1, t));
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });

  it("flyTo：reduced 模式同步跳終態，唔開 rAF（B1 §2.3 硬性契約）", () => {
    const applied: Array<{ x: number; y: number; w: number; h: number }> = [];
    let done = false;
    const cancel = flyTo({
      from: BASE,
      to: target,
      durMs: 500,
      reduced: true,
      apply: (v) => applied.push(v),
      onDone: () => {
        done = true;
      },
    });
    // 只 apply 一次，而且係終態
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual(target);
    expect(done).toBe(true);
    // 已經完成 → cancel 係 no-op，唔應該 throw
    expect(() => cancel()).not.toThrow();
  });

  it("flyTo：durMs ≤ 0 亦係同步跳終態", () => {
    const applied: number[] = [];
    flyTo({
      from: BASE,
      to: target,
      durMs: 0,
      apply: (v) => applied.push(v.w),
    });
    expect(applied).toEqual([target.w]);
  });

  it("flyTo：reduced 時唔會留低任何待執行嘅 frame", () => {
    // node 環境冇 rAF —— 如果 flyTo 喺 reduced 模式仍然排 frame，
    // 呢個測試會因為 ReferenceError / 未預期嘅 callback 而爆。
    let calls = 0;
    flyTo({
      from: BASE,
      to: target,
      durMs: 1000,
      reduced: true,
      apply: () => {
        calls++;
      },
    });
    expect(calls).toBe(1);
  });
});

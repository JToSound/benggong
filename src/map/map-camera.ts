/**
 * map-camera.ts — 相機幾何：投影 / 夾限 / flyTo / soft-focus（spec §2.2）。
 *
 * 為何要由 `SvgMap.ts` 抽出一層
 * ============================
 * A3 審計指出 `SvgMap.ts`（1,646 行）混齊 layout / projection / LOD /
 * render / interaction / data access 六件事。相機運算（投影、縮放夾限、
 * 平移換算、flyTo 目標計算）係其中最**純**嘅一部分 —— 完全唔需要 DOM，
 * 但舊 code 將佢哋散落喺 `lonlatToViewbox` / `clampView` / `scaledView` /
 * `pxToUserUnits` / `flyToChapter` 五個方法度。
 *
 * 抽呢層嘅實際收益：
 *   1. B6 可以喺唔碰 `SvgMap.ts` 嘅情況下做 fly-to（route / event deep link）；
 *   2. 投影公式只有一份 —— A4 明確指出「同一組常數喺 3 個地方各自定義」
 *      係 1.622 倍垂直拉伸 bug 嘅溫床；
 *   3. 全部函數可以 node 直接單元測試（`tests/map-lod.test.ts` 順帶覆蓋）。
 *
 * 座標系
 * ======
 * user unit x = 經度偏移；y 由 `lat_max` 向下遞增，垂直尺度乘咗
 * `1 / cos(φ₀)`（φ₀ = 22.36°，標準緯線）。同 `VectorBasemap` 嘅
 * 「度空間 → 螢幕」仿射矩陣係同一套座標，所以 canvas 同 SVG 完全對齊。
 */

import { MAX_SCALE } from "./map-lod";

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GeoBbox {
  lon_min: number;
  lon_max: number;
  lat_min: number;
  lat_max: number;
}

/** 標準緯線校正 —— 必須同 `VectorBasemap.PROJ_COS`、`build_vector_basemap.py` 一致。 */
export const PROJ_COS = 0.9247;

/** 由經緯 bbox 造基準視圖（全港）。 */
export function baseViewOf(bbox: GeoBbox, cos: number = PROJ_COS): ViewBox {
  return {
    x: bbox.lon_min,
    y: bbox.lat_min,
    w: bbox.lon_max - bbox.lon_min,
    h: (bbox.lat_max - bbox.lat_min) / cos,
  };
}

/**
 * lon/lat → SVG user unit。超出 bbox 會 clamp 到邊緣。
 *
 * ⚠️ 冇 `cos` 參數：垂直校正已經編碼喺 `base.h`（見 `baseViewOf`）。
 * 再收一個 `cos` 只會製造「兩個來源可以唔一致」嘅風險 —— A4 指出
 * 嗰個正是 1.622 倍垂直拉伸 bug 嘅成因。
 */
export function projectLonLat(
  bbox: GeoBbox,
  base: ViewBox,
  lon: number,
  lat: number,
): { x: number; y: number } {
  // SVG y 軸向下、地理緯度向北遞增，所以 y fraction 要反轉。
  const x = Math.max(bbox.lon_min, Math.min(bbox.lon_max, lon));
  const y = Math.max(bbox.lat_min, Math.min(bbox.lat_max, lat));
  const fx = (x - bbox.lon_min) / (bbox.lon_max - bbox.lon_min);
  const fy = (bbox.lat_max - y) / (bbox.lat_max - bbox.lat_min);
  return { x: base.x + fx * base.w, y: base.y + fy * base.h };
}

/**
 * user unit y → 真實緯度。
 *
 * ⚠️ `view.y` **唔係**緯度，而係「user unit y」：
 *     userY(lat) = lat_min + (lat_max − lat) / cos(φ₀)
 * 直接寫 `(lat_max − lat)/cos − view.y` 會漏咗 `lat_min`，令所有幾何偏離
 * 約 22 個 user unit（即整個畫面以外）。A4 實測症狀：「海畫得出、
 * 陸地完全唔見」。
 */
export function viewYToLat(bbox: GeoBbox, y: number, cos: number = PROJ_COS): number {
  return bbox.lat_max - (y - bbox.lat_min) * cos;
}

/** 目前視窗覆蓋嘅經緯範圍。 */
export function geoBoundsOfView(
  bbox: GeoBbox,
  base: ViewBox,
  view: ViewBox,
  cos: number = PROJ_COS,
): GeoBbox {
  const fx0 = (view.x - base.x) / base.w;
  const fx1 = (view.x + view.w - base.x) / base.w;
  const lonSpan = bbox.lon_max - bbox.lon_min;
  return {
    lon_min: bbox.lon_min + fx0 * lonSpan,
    lon_max: bbox.lon_min + fx1 * lonSpan,
    lat_max: viewYToLat(bbox, view.y, cos),
    lat_min: viewYToLat(bbox, view.y + view.h, cos),
  };
}

/**
 * 限制視窗喺底圖範圍之內（唔可以平移到出界）。
 *
 * 為何需要：底圖只有 BASEMAP_BBOX 咁大。視窗移出界就會露出底色
 * （用戶見到嘅「黑邊」）。視窗大過底圖（MIN_SCALE 應該擋住）就置中。
 */
export function clampView(view: ViewBox, base: ViewBox): ViewBox {
  const minX = base.x;
  const maxX = base.x + base.w - view.w;
  const minY = base.y;
  const maxY = base.y + base.h - view.h;
  return {
    ...view,
    x: maxX < minX ? base.x + (base.w - view.w) / 2 : Math.min(Math.max(view.x, minX), maxX),
    y: maxY < minY ? base.y + (base.h - view.h) / 2 : Math.min(Math.max(view.y, minY), maxY),
  };
}

export interface ScaleOptions {
  maxScale?: number;
  minScale?: number;
  /** 縮放錨點（0–1 畫面比例）。唔傳 = 視圖中心。 */
  anchorFrac?: { fx: number; fy: number };
}

/**
 * 縮放（唔改變視圖中心，除非指定錨點）。
 *
 * 為何錨點係「畫面比例」而唔係座標：雙指縮放要令**手指中點**下面嘅
 * 地理位置唔郁。用戶捏兩隻手指嘅位置就係佢想放大嘅位置；如果以視圖
 * 中心縮放，手指以外嘅內容會移走，感覺「唔跟手」。
 */
export function scaleView(
  view: ViewBox,
  base: ViewBox,
  factor: number,
  opts: ScaleOptions = {},
): ViewBox {
  // ⚠️ 預設用 LOD 政策嘅 `MAX_SCALE`（spec §3.1：Z8 必須可達）。
  // 唔可以再寫死 64 —— 0.70/64 = 0.0109° = Z6.0，Z7／Z8 會不可達。
  const maxScale = opts.maxScale ?? MAX_SCALE;
  const minScale = opts.minScale ?? 1;
  const minW = base.w / maxScale;
  const maxW = base.w / minScale;
  const w = Math.max(minW, Math.min(maxW, view.w / factor));
  const h = w * (base.h / base.w);
  const fx = opts.anchorFrac?.fx ?? 0.5;
  const fy = opts.anchorFrac?.fy ?? 0.5;
  const anchorX = view.x + fx * view.w;
  const anchorY = view.y + fy * view.h;
  return clampView(
    { x: anchorX - fx * w, y: anchorY - fy * h, w, h },
    base,
  );
}

/**
 * 畫面像素 → user unit（兩個方向同一個比例）。
 *
 * 為何唔可以寫 `view.w / rect.width`
 * ----------------------------------
 * `<svg>` 用 `preserveAspectRatio="xMidYMid meet"`：內容等比縮放至
 * **完全放得入**，所以實際比例係 `min(rectW / view.w, rectH / view.h)`，
 * 而且短邊會留黑邊。假設兩軸獨立嘅話，當元素長寬比同 viewBox 長寬比
 * 唔同時（例如 1280×800 視窗 vs 1.295 嘅 viewBox），平移速度會偏離
 * 約 1.24 倍 —— 拖曳同手指唔同步。
 */
export function pxToUserUnits(view: ViewBox, rectW: number, rectH: number): number {
  const scale = Math.min(rectW / view.w, rectH / view.h);
  return scale > 0 ? 1 / scale : 0;
}

export interface FlyToOptions {
  /** 邊界留白比例（0.25 = 25%）。 */
  padding?: number;
  /** 最小跨度（度）—— 避免單點章節造成 0 尺寸 viewBox。 */
  minSpan?: number;
  maxScale?: number;
  minScale?: number;
}

/**
 * 由經緯 bounds 計算 flyTo 目標視窗。
 *
 * ⚠️ 目標視窗要夾到縮放範圍之內，否則飛去一個章節之後用戶可以縮到
 * 細過底圖（露出黑邊）。
 */
export function viewBoxForGeoBounds(
  bbox: GeoBbox,
  base: ViewBox,
  bounds: GeoBbox,
  opts: FlyToOptions = {},
): ViewBox {
  const padding = opts.padding ?? 0.25;
  const minSpan = opts.minSpan ?? 0.02;
  // 同 `scaleView`：預設由 LOD 政策提供，唔再寫死 64（見該處註釋）。
  const maxScale = opts.maxScale ?? MAX_SCALE;
  const minScale = opts.minScale ?? 1;

  let { lon_min, lon_max, lat_min, lat_max } = bounds;
  const lonPad = (lon_max - lon_min) * padding;
  const latPad = (lat_max - lat_min) * padding;
  lon_min = Math.max(bbox.lon_min, lon_min - lonPad);
  lon_max = Math.min(bbox.lon_max, lon_max + lonPad);
  lat_min = Math.max(bbox.lat_min, lat_min - latPad);
  lat_max = Math.min(bbox.lat_max, lat_max + latPad);

  if (lon_max - lon_min < minSpan) {
    const c = (lon_min + lon_max) / 2;
    lon_min = c - minSpan / 2;
    lon_max = c + minSpan / 2;
  }
  if (lat_max - lat_min < minSpan) {
    const c = (lat_min + lat_max) / 2;
    lat_min = c - minSpan / 2;
    lat_max = c + minSpan / 2;
  }

  const fx0 = (lon_min - bbox.lon_min) / (bbox.lon_max - bbox.lon_min);
  const fx1 = (lon_max - bbox.lon_min) / (bbox.lon_max - bbox.lon_min);
  // y 軸反轉（SVG y 向下、緯度向北遞增）
  const fy0 = (bbox.lat_max - lat_max) / (bbox.lat_max - bbox.lat_min);
  const fy1 = (bbox.lat_max - lat_min) / (bbox.lat_max - bbox.lat_min);

  const rawW = Math.abs(fx1 - fx0) * base.w;
  const w = Math.max(base.w / maxScale, Math.min(base.w / minScale, rawW));
  return clampView(
    {
      x: base.x + Math.min(fx0, fx1) * base.w,
      y: base.y + Math.min(fy0, fy1) * base.h,
      w,
      h: w * (base.h / base.w),
    },
    base,
  );
}

/**
 * 溫和聚焦（soft focus）。
 *
 * 用途：story context 改變時唔想整幅地圖跳走，只想「推近少少」引起注意。
 * `ratio` = 0 唔郁、= 1 等於直接飛到目標。唔會超出 target 本身。
 */
export function softFocus(view: ViewBox, target: ViewBox, ratio: number): ViewBox {
  const t = Math.max(0, Math.min(1, ratio));
  return {
    x: view.x + (target.x - view.x) * t,
    y: view.y + (target.y - view.y) * t,
    w: view.w + (target.w - view.w) * t,
    h: view.h + (target.h - view.h) * t,
  };
}

/** ease-in-out cubic（同 `SvgMap.animateViewBox` 用嘅曲線完全一樣）。 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface FlyToParams {
  from: ViewBox;
  to: ViewBox;
  durMs: number;
  /** 由 `motion.prefersReducedMotion()` 傳入（唔喺度讀 DOM，保持純）。 */
  reduced?: boolean;
  apply: (v: ViewBox) => void;
  onDone?: () => void;
}

/**
 * rAF 驅動嘅視窗轉場；回傳 cancel 函式。
 *
 * B1 §2.3 硬性契約：`reduced` 為 true → **同步一次** `apply(to)`，
 * 唔開 rAF、唔插值。舊 code 繞過咗呢點（實測 reduce 模式下 rAF
 * `viewBox` 仍有 11 個相異值）。
 */
export function flyTo(params: FlyToParams): () => void {
  const { from, to, durMs, reduced, apply, onDone } = params;
  if (reduced || durMs <= 0) {
    apply({ ...to });
    onDone?.();
    return () => {};
  }
  const t0 = performance.now();
  let raf = 0;
  let cancelled = false;
  const step = (now: number) => {
    if (cancelled) return;
    const t = Math.min(1, (now - t0) / durMs);
    const e = easeInOutCubic(t);
    apply({
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      w: from.w + (to.w - from.w) * e,
      h: from.h + (to.h - from.h) * e,
    });
    if (t < 1) {
      raf = requestAnimationFrame(step);
    } else {
      raf = 0;
      onDone?.();
    }
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
}

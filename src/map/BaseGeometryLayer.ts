/**
 * BaseGeometryLayer.ts — 由 `VectorBasemap` 抽出嘅**幾何繪製層**（spec §2.2）。
 *
 * 負責：陸地 / 綠地 / 工業區 / 內陸水體 / 建築 / 道路。
 * 唔負責：海漸層、經緯格線、暗角、標籤（留喺 `VectorBasemap`）。
 *
 * 為何要拆出嚟
 * ============
 * A8 P0-1 實測：`ensureTiles()` 每載入**一格**圖磚就
 * `buildTileRoadPaths()` + `buildBuildingPaths()` 對**全部已載入圖磚**
 * 重建 `Path2D`（O(tiles × features)）→ 冷 zoom 20 個 longtask、
 * 合計 **21,241 ms** 阻塞、最長單一 4,164 ms、1.8 fps。
 *
 * 本檔嘅解法係**增量建構**：
 *   · 每格圖磚**自己**一份 `Path2D`（載入時建一次，O(該格 features)）；
 *   · 聚合 `Path2D` 用 `Path2D.addPath()` 由各格**拼接**（O(tiles)，唔重行幾何）；
 *   · 淘汰圖磚時只重拼一次聚合（O(tiles)）。
 * 總成本由 O(tiles² × features) 降到 O(features + tiles)。
 *
 * 另一件事：A4 G3 實測建築描繪對比過低（light alpha 0.16–0.42、
 * 描邊 0.35 px），令 max zoom 有 401–978 幢建築但 `meanGrad` 只有 9.12。
 * 本檔按 `BUILDING_ALPHA_RANGE` 將 4 個 rank 嘅 alpha 正規化到 0.35–0.65，
 * 描邊改 0.7 px（色相仍然由 `theme-tokens` 嘅 palette 提供）。
 */

import {
  BUILDING_ALPHA_RANGE,
  BUILDING_EDGE_WIDTH_PX,
  NO_DETAIL_HATCH_ALPHA,
  NO_DETAIL_HATCH_MAX_LINES,
  NO_DETAIL_HATCH_SPACING_PX,
  NO_DETAIL_HATCH_STRONG_ALPHA,
  NO_DETAIL_HATCH_WIDTH_PX,
  isLowDensity,
  usesNoDetailHatch,
} from "./map-lod";
import { PROJ_COS, type GeoBbox, type ViewBox } from "./map-camera";
import type { BasemapPalette } from "../theme-tokens";

export interface RoadRec {
  cls: number;
  flags: number;
  /** 度空間座標，[x0,y0, x1,y1, …] */
  pts: Float64Array;
}

export interface BldRec {
  pts: Float64Array;
  levels: number;
}

/** 一格圖磚嘅幾何。 */
export interface TileGeometry {
  roads: RoadRec[];
  bld: BldRec[];
}

export interface BaseDrawFrame {
  view: ViewBox;
  cssW: number;
  cssH: number;
  dpr: number;
  bbox: GeoBbox;
  level: 0 | 1 | 2;
  palette: BasemapPalette;
}

export interface BaseDrawStats {
  /** 目前視窗可見嘅建築數（由已載入圖磚估算）。 */
  buildings: number;
  /** 有冇圖磚幾何（level 2 用嚟決定要唔要 fallback 到 roads-l1）。 */
  hasTileGeometry: boolean;
  /** No-fake-zoom：可見建築數低於門檻。 */
  lowDensity: boolean;
  /** 度空間 → 螢幕嘅比例（呼叫者畫標籤時要用）。 */
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 解碼 delta 整數陣列 → 度空間 Float64Array。 */
export function decodeDelta(arr: number[], quant: number): Float64Array {
  const n = arr.length >> 1;
  const out = new Float64Array(n * 2);
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      x = arr[0];
      y = arr[1];
    } else {
      x += arr[i * 2];
      y += arr[i * 2 + 1];
    }
    out[i * 2] = x / quant;
    out[i * 2 + 1] = y / quant;
  }
  return out;
}

export function ringToPath(p: Path2D, pts: Float64Array): void {
  const n = pts.length >> 1;
  if (n < 3) return;
  p.moveTo(pts[0], pts[1]);
  for (let i = 1; i < n; i++) p.lineTo(pts[i * 2], pts[i * 2 + 1]);
  p.closePath();
}

/** 由圖磚幾何造 8 條道路路徑（按 class 分桶）。 */
export function buildRoadPathsFrom(roads: RoadRec[]): {
  paths: Array<Path2D | null>;
  used: Set<number>;
} {
  const buckets: Path2D[] = [];
  for (let c = 0; c < 8; c++) buckets.push(new Path2D());
  const used = new Set<number>();
  for (const rec of roads) {
    const p = buckets[rec.cls];
    if (!p) continue;
    const pts = rec.pts;
    const n = pts.length >> 1;
    if (n < 2) continue;
    p.moveTo(pts[0], pts[1]);
    for (let i = 1; i < n; i++) p.lineTo(pts[i * 2], pts[i * 2 + 1]);
    used.add(rec.cls);
  }
  const paths: Array<Path2D | null> = new Array(8).fill(null);
  for (const c of used) paths[c] = buckets[c];
  return { paths, used };
}

/** 由圖磚幾何造 4 條建築路徑（按層數分桶）。 */
export function buildBuildingPathsFrom(bld: BldRec[]): {
  paths: Array<Path2D | null>;
  used: Set<number>;
} {
  const buckets: Path2D[] = [];
  for (let i = 0; i < 4; i++) buckets.push(new Path2D());
  const used = new Set<number>();
  for (const b of bld) {
    const bin = b.levels === 0 ? 0 : b.levels < 6 ? 1 : b.levels < 18 ? 2 : 3;
    ringToPath(buckets[bin], b.pts);
    used.add(bin);
  }
  const paths: Array<Path2D | null> = new Array(4).fill(null);
  for (const i of used) paths[i] = buckets[i];
  return { paths, used };
}

/** 解析 `rgba(r,g,b,a)` / `rgb(...)` / `#rrggbb` / `#rgb`。 */
function parseColor(c: string): { r: number; g: number; b: number } | null {
  const s = c.trim();
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  const h = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (h) {
    const v = h[1];
    const full = v.length === 3 ? v.split("").map((x) => x + x).join("") : v;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  return null;
}

/** 換 alpha 但保留色相（palette 嘅色相係 B1 token，唔可以改）。 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${Number(a.toFixed(3))})`;
}

/** 一條「無細節」紋理線段（度空間）：`[x0, y0, x1, y1]`。 */
export type HatchSegment = [number, number, number, number];

/**
 * 產生紋理線段要用嘅視窗框架。
 *
 * ⚠️ **`latTop` / `latBot` 係緯度，唔係 user unit。**
 *
 * `BaseGeometryLayer.draw()` 設定嘅仿射矩陣，輸入係 `(經度, 緯度)`：
 * ```
 * ctx.setTransform(dpr*s, 0, 0, -dpr*s/PROJ_COS, …, dpr*(s*(lat_min + lat_max/PROJ_COS − view.y) + oy))
 * ```
 * 而 `view.y` / `view.h` 係 **user unit**（`userY(lat) = lat_min + (lat_max − lat)/cos φ₀`）。
 * 兩者相差 `1/PROJ_COS ≈ 1.083` 倍 —— 直接將 `view.y` 餵入去，誤差會隨
 * `view.y`（≈22.4）放大成 `s × 0.0136` 個 **螢幕 px**：
 *   · Z6（s ≈ 90,036）→ 偏 **1,229 px** → 整層紋理畫到畫布**上面**，完全離屏；
 *   · Z4（s ≈ 24,651）→ 只偏 209 px → 露出左上角一小塊。
 * 呢個就係「明明加咗紋理，Z6 數字完全不變」嘅根因（實測）。
 */
export interface HatchFrame {
  /** 視窗左邊經度（度）。 */
  lonLeft: number;
  /** 視窗經度跨度（度）。 */
  lonSpan: number;
  /** 視窗**頂部緯度**（度）。 */
  latTop: number;
  /** 視窗**底部緯度**（度）。 */
  latBot: number;
  /** 螢幕 px / 經度（= `min(cssW / view.w, cssH / view.h)`）。 */
  pxPerDeg: number;
}

/**
 * 產生「無細節陸地」紋理嘅斜線線段（**純函數**，可 node 單測）。
 *
 * ⚠️ 線距喺**螢幕空間**定義（`spacingPx`）再換算返度 —— 紋理密度喺任何
 * zoom 都一樣。如果寫死度空間間距，深 zoom 會變成幾條粗線、淺 zoom 會密到變灰。
 *
 * 斜線係 45°（螢幕空間）。因為 y 軸有 `1/cos φ₀` 校正，要令螢幕上真係
 * 45°，經度方向嘅延伸量要係 `(latTop − latBot) / PROJ_COS`（＝ `view.h`）。
 */
export function noDetailHatchSegments(
  f: HatchFrame,
  spacingPx: number = NO_DETAIL_HATCH_SPACING_PX,
  maxLines: number = NO_DETAIL_HATCH_MAX_LINES,
): HatchSegment[] {
  if (!(f.pxPerDeg > 0) || !(spacingPx > 0)) return [];
  const step = spacingPx / f.pxPerDeg; // 經度（度）
  if (!Number.isFinite(step) || step <= 0) return [];
  const dx = (f.latTop - f.latBot) / PROJ_COS;
  if (!Number.isFinite(dx) || dx <= 0) return [];
  const out: HatchSegment[] = [];
  // 由左上外側掃到右下外側，確保斜線覆蓋整個視窗。
  for (let d = -dx; d < f.lonSpan; d += step) {
    out.push([f.lonLeft + d, f.latTop, f.lonLeft + d + dx, f.latBot]);
    if (out.length >= maxLines) break;
  }
  return out;
}

/**
 * 建築 4 個 rank 嘅 fill。
 *
 * A4 G3：唔可以再跟 palette 嘅原始 alpha（light 0.16–0.42 / dark 0.14–0.40），
 * 要正規化到 `BUILDING_ALPHA_RANGE`（0.35–0.65）。色相仍然來自 palette。
 */
export function buildingFills(palette: BasemapPalette): [string, string, string, string] {
  const [lo, hi] = BUILDING_ALPHA_RANGE;
  const n = palette.bld.length;
  const out = palette.bld.map((c, i) =>
    withAlpha(c, lo + ((hi - lo) * i) / Math.max(1, n - 1)),
  );
  return [out[0], out[1], out[2], out[3]];
}

interface TilePaths {
  roads: Array<Path2D | null>;
  bld: Array<Path2D | null>;
  roadUsed: Set<number>;
  bldUsed: Set<number>;
  buildings: number;
}

export class BaseGeometryLayer {
  // ---- 全域圖層（常駐） ----
  private landPath: Path2D | null = null;
  private waterPath: Path2D | null = null;
  private greenPath: Path2D | null = null;
  private indusPath: Path2D | null = null;

  // ---- 全域道路（按 level 快取，唔再每次切層重建） ----
  private globalRoads: Record<0 | 1, RoadRec[]> = { 0: [], 1: [] };
  private globalRoadPaths: Record<0 | 1, Array<Path2D | null>> = {
    0: new Array(8).fill(null),
    1: new Array(8).fill(null),
  };
  private globalRoadUsed: Record<0 | 1, Set<number>> = { 0: new Set(), 1: new Set() };

  // ---- 圖磚（逐格增量） ----
  private tilePaths = new Map<string, TilePaths>();
  private aggRoads: Array<Path2D | null> = new Array(8).fill(null);
  private aggRoadUsed = new Set<number>();
  private aggBld: Array<Path2D | null> = new Array(4).fill(null);
  private aggBldUsed = new Set<number>();
  private tileBuildingCount = 0;

  // ---- 上一 frame 嘅狀態（避免重複重拼） ----
  private aggregateDirty = false;
  private lastLowDensity = false;

  setLand(rings: Float64Array[]): void {
    const p = new Path2D();
    for (const r of rings) ringToPath(p, r);
    this.landPath = p;
  }

  setWater(rings: Float64Array[]): void {
    const p = new Path2D();
    for (const r of rings) ringToPath(p, r);
    this.waterPath = p;
  }

  setAreas(areas: Array<{ k: number; pts: Float64Array }>): void {
    const green = new Path2D();
    const indus = new Path2D();
    for (const a of areas) ringToPath(a.k === 0 ? green : indus, a.pts);
    this.greenPath = green;
    this.indusPath = indus;
  }

  /** 設定某一級嘅全域道路（level 0 = roads-l0；level 1 = roads-l1）。 */
  setGlobalRoads(level: 0 | 1, roads: RoadRec[]): void {
    this.globalRoads[level] = roads;
    const { paths, used } = buildRoadPathsFrom(roads);
    this.globalRoadPaths[level] = paths;
    this.globalRoadUsed[level] = used;
  }

  hasGlobalRoads(level: 0 | 1): boolean {
    return this.globalRoadUsed[level].size > 0;
  }

  /**
   * 加入一格圖磚（增量）。
   *
   * ⚠️ 呢度**只**建該格自己嘅 `Path2D`，唔會重行其他圖磚嘅幾何。
   * 呢個就係 A8 P0-1 嘅修正核心。
   */
  addTile(key: string, tile: TileGeometry): void {
    if (this.tilePaths.has(key)) this.removeTile(key);
    const r = buildRoadPathsFrom(tile.roads);
    const b = buildBuildingPathsFrom(tile.bld);
    this.tilePaths.set(key, {
      roads: r.paths,
      roadUsed: r.used,
      bld: b.paths,
      bldUsed: b.used,
      buildings: tile.bld.length,
    });
    this.tileBuildingCount += tile.bld.length;
    this.aggregateDirty = true;
  }

  removeTile(key: string): void {
    const t = this.tilePaths.get(key);
    if (!t) return;
    this.tilePaths.delete(key);
    this.tileBuildingCount -= t.buildings;
    this.aggregateDirty = true;
  }

  clearTiles(): void {
    this.tilePaths.clear();
    this.tileBuildingCount = 0;
    this.aggregateDirty = true;
  }

  get tileCount(): number {
    return this.tilePaths.size;
  }

  /**
   * 重拼聚合 `Path2D`。
   *
   * 用 `Path2D.addPath()` —— 只係複製路徑指令，唔會重行 delta 解碼／
   * 簡化，所以係 O(tiles)，唔係 O(tiles × features)。
   */
  private rebuildAggregates(): void {
    const roads: Path2D[] = [];
    for (let c = 0; c < 8; c++) roads.push(new Path2D());
    const bld: Path2D[] = [];
    for (let i = 0; i < 4; i++) bld.push(new Path2D());
    const rUsed = new Set<number>();
    const bUsed = new Set<number>();
    for (const t of this.tilePaths.values()) {
      for (const c of t.roadUsed) {
        roads[c].addPath(t.roads[c]!);
        rUsed.add(c);
      }
      for (const i of t.bldUsed) {
        bld[i].addPath(t.bld[i]!);
        bUsed.add(i);
      }
    }
    this.aggRoads = roads;
    this.aggRoadUsed = rUsed;
    this.aggBld = bld;
    this.aggBldUsed = bUsed;
    this.aggregateDirty = false;
  }

  /** 上一 frame 係唔係低密度（Q11 狀態）。 */
  get lowDensity(): boolean {
    return this.lastLowDensity;
  }

  /** 目前圖磚嘅建築總數（測試／除錯用）。 */
  get buildingCount(): number {
    return this.tileBuildingCount;
  }

  /**
   * 畫幾何層。
   *
   * ⚠️ 呼叫前 ctx 係 identity transform；本方法會自行設定
   * 「度空間 → 螢幕」仿射矩陣，畫完**唔會**還原（由呼叫者決定）。
   */
  draw(ctx: CanvasRenderingContext2D, frame: BaseDrawFrame): BaseDrawStats {
    const { view, cssW: W, cssH: H, dpr, bbox: b, level, palette } = frame;
    if (this.aggregateDirty) this.rebuildAggregates();

    const s = Math.min(W / view.w, H / view.h);
    const ox = (W - view.w * s) / 2;
    const oy = (H - view.h * s) / 2;

    // 度空間 → 螢幕（同 SvgMap 嘅投影完全一致）
    ctx.setTransform(
      dpr * s,
      0,
      0,
      (-dpr * s) / PROJ_COS,
      dpr * (ox - view.x * s),
      dpr * (s * (b.lat_min + b.lat_max / PROJ_COS - view.y) + oy),
    );

    // ---- 陸地 ----
    if (this.landPath) {
      const lg = ctx.createLinearGradient(0, b.lat_max, 0, b.lat_min);
      lg.addColorStop(0, palette.landHi);
      lg.addColorStop(1, palette.land);
      ctx.fillStyle = lg;
      ctx.fill(this.landPath, "evenodd");
      ctx.lineWidth = 1.6 / s;
      ctx.strokeStyle = palette.coastGlow;
      ctx.stroke(this.landPath);
      ctx.lineWidth = 0.7 / s;
      ctx.strokeStyle = palette.coast;
      ctx.stroke(this.landPath);
    }

    /*
     * ---- 無細節陸地紋理（A4 §4.4）----
     *
     * ⚠️ 位置係關鍵：一定要喺**陸地填色之後、真實幾何之前**。
     * 咁樣有建築／道路／綠地／水體嘅地方會被蓋住，只有真實資料真空區
     * （郊野公園、山嶺）見到紋理 —— 即係「紋理出現嘅地方 = 冇細節資料
     * 嘅地方」，而唔係「全張圖加雜訊」。
     *
     * 之前嘅做法係「全視窗低密度才畫」，但 `center` 錨點 Z6 有 ~70 幢
     * 建築（全部集中喺西側 40%），所以 `isLowDensity` 永遠係 false，
     * 東側 60% 嘅真空區就一直空白（B9 Q3/Q4 FAIL 嘅直接成因）。
     */
    const hatch = usesNoDetailHatch(view.w);
    const low = hatch && isLowDensity(this.tileBuildingCount);
    if (hatch) this.drawNoDetailHatch(ctx, frame, s, low);

    // ---- 綠地／工業區 ----
    if (this.greenPath) {
      ctx.fillStyle = palette.green;
      ctx.fill(this.greenPath, "evenodd");
    }
    if (this.indusPath) {
      ctx.fillStyle = palette.industrial;
      ctx.fill(this.indusPath, "evenodd");
    }

    // ---- 內陸水體 ----
    if (this.waterPath) {
      ctx.fillStyle = palette.water;
      ctx.fill(this.waterPath, "evenodd");
      ctx.lineWidth = 0.5 / s;
      ctx.strokeStyle = palette.waterEdge;
      ctx.stroke(this.waterPath);
    }

    // ---- 建築（只有 level 2；對比按 BUILDING_ALPHA_RANGE 提升） ----
    if (level === 2) {
      const fills = buildingFills(palette);
      for (let i = 0; i < 4; i++) {
        const p = this.aggBld[i];
        if (!p || !this.aggBldUsed.has(i)) continue;
        ctx.fillStyle = fills[i];
        ctx.fill(p, "evenodd");
      }
      if (this.aggBldUsed.size > 0) {
        ctx.lineWidth = BUILDING_EDGE_WIDTH_PX / s;
        ctx.strokeStyle = palette.bldEdge;
        for (let i = 0; i < 4; i++) {
          const p = this.aggBld[i];
          if (p && this.aggBldUsed.has(i)) ctx.stroke(p);
        }
      }
    }

    // ---- 道路 ----
    const tileRoads = level === 2 && this.aggRoadUsed.size > 0;
    const roadPaths = tileRoads
      ? this.aggRoads
      : this.globalRoadPaths[level === 0 ? 0 : 1];
    const roadUsed = tileRoads
      ? this.aggRoadUsed
      : this.globalRoadUsed[level === 0 ? 0 : 1];
    const maxClass = level === 0 ? 2 : level === 1 ? 5 : 7;
    const glowScale = level === 0 ? 0.35 : level === 1 ? 0.55 : 0.75;
    for (let c = maxClass; c >= 0; c--) {
      if (!roadUsed.has(c)) continue;
      const p = roadPaths[c];
      if (!p) continue;
      const st = palette.roads[c];
      if (!st) continue;
      /*
       * ⚠️ 發光**只畀 class ≤ 2**（高速／幹道／主要道路）。
       * 初版冇設限制 → 街道層 2,000+ 條路一齊描發光邊，變成一層均勻
       * 琥珀色霧，蓋過建築同綠地。
       */
      if (st.glow > 0 && c <= 2) {
        ctx.lineWidth = (st.w + st.glow * glowScale) / s;
        ctx.strokeStyle = st.color;
        ctx.globalAlpha = 0.1 * glowScale + 0.025;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke(p);
        ctx.globalAlpha = 1;
      }
      ctx.lineWidth = st.w / s;
      ctx.strokeStyle = st.color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(p);
    }

    // ---- No-fake-zoom（spec §4.3）----
    const buildings = level === 2 ? this.tileBuildingCount : 0;
    this.lastLowDensity = low;

    return {
      buildings,
      hasTileGeometry: this.aggRoadUsed.size > 0,
      lowDensity: low,
      scale: s,
      offsetX: ox,
      offsetY: oy,
    };
  }

  /**
   * 「無細節陸地」紋理（A4 §4.4：唔可以顯示空白陸地）。
   *
   * 為何唔可以留白：空白會令用戶以為地圖壞咗。喺陸地填色之上畫一層
   * 低對比斜線，再配「此區未有細節資料」文字（由 `VectorBasemap` 畫），
   * 就變成「已知冇細節」而唔係「未知」。
   *
   * ⚠️ 由 `draw()` 喺**陸地之後、真實幾何之前**呼叫 —— 有真實幾何嘅地方
   * 會被蓋住，所以紋理只會喺資料真空區見到（見 `map-lod.ts` 嘅說明）。
   *
   * 線距／線粗／alpha 全部由 `map-lod.ts` 提供（唯一政策來源）。
   */
  private drawNoDetailHatch(
    ctx: CanvasRenderingContext2D,
    frame: BaseDrawFrame,
    s: number,
    strong: boolean,
  ): void {
    const { view, bbox, palette } = frame;
    const segs = noDetailHatchSegments({
      lonLeft: view.x,
      lonSpan: view.w,
      // ⚠️ view.y / view.h 係 user unit；矩陣要嘅係緯度（見 HatchFrame 註釋）。
      latTop: bbox.lat_max - (view.y - bbox.lat_min) * PROJ_COS,
      latBot: bbox.lat_max - (view.y + view.h - bbox.lat_min) * PROJ_COS,
      pxPerDeg: s,
    });
    if (segs.length === 0) return;
    ctx.save();
    if (this.landPath) ctx.clip(this.landPath);
    ctx.strokeStyle = withAlpha(
      palette.coast,
      strong ? NO_DETAIL_HATCH_STRONG_ALPHA : NO_DETAIL_HATCH_ALPHA,
    );
    ctx.lineWidth = NO_DETAIL_HATCH_WIDTH_PX / s;
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of segs) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 清空所有快取（`VectorBasemap.destroy()` 用）。 */
  dispose(): void {
    this.landPath = null;
    this.waterPath = null;
    this.greenPath = null;
    this.indusPath = null;
    this.globalRoads = { 0: [], 1: [] };
    this.globalRoadPaths = { 0: new Array(8).fill(null), 1: new Array(8).fill(null) };
    this.globalRoadUsed = { 0: new Set(), 1: new Set() };
    this.clearTiles();
    this.rebuildAggregates();
  }
}

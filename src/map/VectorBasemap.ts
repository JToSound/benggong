/**
 * VectorBasemap — 由本機向量圖磚繪製嘅底圖（Canvas 2D）。
 *
 * 為何要放棄 raster LOD
 * =====================
 * 舊做法係 raster LOD 圖磚（輸出尺寸固定、改細 bbox = 放大）。根本限制：
 * **冇圖磚覆蓋嘅地方冇得放大**。全港只有將軍澳一帶有街道級圖磚，
 * 其餘地區最大縮放時要將分區圖磚拉伸 **17.75 倍**。要覆蓋全港街道級，
 * raster 需要約 670 MB。A4 實測：raster 路徑 **0 次參與**渲染
 * （`map-lod/` 請求 = 0、`<image href>` = 0），所以 V2 唔再投資 raster。
 *
 * 為何用 <canvas> 而唔係 <svg>
 * ============================
 * 一平方公里市區有幾千幢建築。SVG 要為每個多邊形建一個 DOM 節點，
 * 5,000 個節點會令平移卡頓。Canvas 2D 冇 DOM 開銷，而且可以用
 * `setTransform` 將**整批路徑**一次過變換 —— 平移／縮放唔需要重建路徑。
 *
 * 本檔喺 V2 嘅角色（B5）
 * =====================
 *   · 幾何繪製（陸地／水體／道路／建築）已抽去 `BaseGeometryLayer`；
 *   · LOD 門檻改由 `map-lod.ts` 提供（唔再自己寫 literal）；
 *   · 圖磚 `Path2D` 改為**逐格增量**（A8 P0-1：冷 zoom 阻塞 21,241 ms）；
 *   · tile POI 終於會渲染（A4 G2：唯一嘅街道級地標來源）；
 *   · 標籤加寬度快取 + 空間網格碰撞剔除（A8 P1-1：pan 29 fps）；
 *   · 低密度區加 no-fake-zoom 狀態（spec §4.3 / Q11）。
 *
 * 座標系統
 * ========
 * 圖磚座標係整數 delta（單位 1e-5 度）。解碼之後係 (lon, lat) 度。
 * 繪製時用一個仿射變換直接由「度」映射到「螢幕像素」，所以
 * `setTransform` 之後路徑只需要建立一次，平移／縮放只改矩陣。
 */

import { PALETTE_DARK, PALETTE_LIGHT, type BasemapPalette } from "../theme-tokens";
import {
  BaseGeometryLayer,
  decodeDelta,
  type BldRec,
  type RoadRec,
} from "./BaseGeometryLayer";
import { PROJ_COS, viewYToLat, type GeoBbox, type ViewBox } from "./map-camera";
import {
  NO_DETAIL_TEXT,
  includesTilePoi,
  maxLabelRank,
  selectBasemapLevel,
  selectTier,
  type BasemapLevel,
} from "./map-lod";

export { PROJ_COS };
export type { BasemapLevel, ViewBox };

interface Manifest {
  version: number;
  quant: number;
  bbox: GeoBbox;
  tile_deg: number;
  layers: Record<string, { file: string; count?: number; bytes?: number; dir?: string }>;
}

interface PoiRec {
  n: string;
  k: string;
  r: number;
  /** 圖磚／標籤檔入面嘅量化整數座標（1e-5 度）。 */
  x: number;
  y: number;
  /** 解碼後嘅經緯度。 */
  lon: number;
  lat: number;
}

/**
 * 各級道路喺邊個縮放層出現。
 *
 * ⚠️ **刻意同 Python 重複**。兩邊唔一致就會出現「有資料但唔畫」
 * 或者「畫咗但冇資料」。`tests/vector-basemap.test.ts` 會比對兩邊。
 */
export const ROAD_MIN_LEVEL: Record<number, BasemapLevel> = {
  0: 0,
  1: 0,
  2: 0,
  3: 1,
  4: 1,
  5: 1,
  6: 2,
  7: 2,
};

/**
 * 圖磚快取上限（個）。
 *
 * ⚠️ 為何一定要有上限而唔係「離開視野就丟」：初版每次 `ensureTiles()`
 * 都刪走唔喺視野嘅圖磚，代價係每次平移／切章都要重新 `JSON.parse`
 * 最多 1 MiB 嘅圖磚 —— 實測令「逐章掃 198 章」由 30 秒變成逾時。
 * 瀏覽器 HTTP 快取幫唔到手（瓶頸係解析）。所以改 LRU。
 */
const TILE_CACHE_MAX = 24;

/** 標籤等級 → 最早出現嘅縮放層。 */
const LABEL_MIN_LEVEL: Record<number, BasemapLevel> = {
  0: 0,
  1: 0,
  2: 1,
  3: 1,
  4: 2,
  5: 2,
};

/** 標籤等級 → 字級（像素）／字重。顏色由目前 palette 決定。 */
const LABEL_SIZE: Array<{ size: number; weight: number }> = [
  { size: 17, weight: 700 },
  { size: 13.5, weight: 600 },
  { size: 11.5, weight: 600 },
  { size: 10.5, weight: 500 },
  { size: 10, weight: 500 },
  { size: 9.5, weight: 400 },
];

const LABEL_FONT_STACK =
  '"Noto Sans TC", "PingFang HK", "Microsoft JhengHei", system-ui, sans-serif';

/**
 * 標籤字體字串（按 rank 預先算好）。
 *
 * ⚠️ 為何要預算：`ctx.font = …` 唔係免費 —— Chromium 要解析字串再做
 * 字型查找。原本喺標籤迴圈**逐個標籤**指派（實測 ~343 次/frame），
 * 而且每次都重新串接字串。預先算好 6 個 + 只在 rank 改變時指派
 * （`labelOrder` 已按 rank 排序，所以通常只會指派 1–6 次）。
 */
const LABEL_FONTS: readonly string[] = LABEL_SIZE.map(
  (st) => `${st.weight} ${st.size}px ${LABEL_FONT_STACK}`,
);

/** 按 rank 取字體字串（越界回最細字級）。 */
function fontOfRank(rank: number): string {
  return LABEL_FONTS[rank] ?? LABEL_FONTS[LABEL_FONTS.length - 1];
}

/**
 * 量度文字寬度用嘅**獨立** 2D context。
 *
 * ⚠️ 為何唔用主 canvas 嘅 ctx：`measureText` 要先把 `ctx.font` 設成該
 * 標籤嘅字體，會**干擾**繪製迴圈對 `ctx.font` 嘅狀態追蹤（令「只在
 * rank 改變時指派」嘅守門失效）。獨立 context 之後，主 canvas 嘅
 * `ctx.font` 只由繪製迴圈管理。
 */
let measureCtx: CanvasRenderingContext2D | null = null;
function measureContext(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined") return null;
  measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/** 碰撞剔除嘅空間網格大細（CSS px）。 */
const COLLIDE_CELL = 44;

/** 標籤光暈粗細（CSS px）。 */
const LABEL_HALO_WIDTH = 3.5;

/**
 * `labelWidths` 快取上限（**唯一無上限嘅快取**）。
 *
 * ⚠️ 為何要設上限：key 係 `rank|文字`，而圖磚 POI 有 ~11,645 個建築名
 * ＋全域標籤 7,847 個 —— 即係理論上 ~20,000 個 entry。長 session
 * 行過全港會逐個累積（用戶報告「移動地圖一段時間之後 out of memory」，
 * 呢個係唯一搵到嘅無上限結構）。設上限之後最壞情況係重新 `measureText`
 * 一次（~0.14 ms），唔會影響正確性。
 */
const LABEL_WIDTH_CACHE_MAX = 12000;

/**
 * 圖磚處理分片大細（幢建築／片）。
 *
 * 實測：一格圖磚 ~4,500 幢建築，一次過「解碼 + 建 `Path2D`」要 ~59 ms
 * （一個 59 ms longtask）。800 幢／片 ≈ 8–10 ms，全部落到 longtask
 * 門檻（50 ms）之下。
 */
const TILE_CHUNK = 800;

/**
 * 讓出主線程（macrotask）。
 *
 * ⚠️ 一定要 `setTimeout`（macrotask）而唔係 `Promise.resolve()`
 * （microtask）—— microtask 唔會讓瀏覽器 render 或者處理輸入，
 * 分片就完全冇意義。
 */
const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function assetUrl(p: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
}

export interface BasemapStats {
  level: BasemapLevel;
  tiles: number;
  roads: number;
  buildings: number;
  bytes: number;
  ready: boolean;
}

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class VectorBasemap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private manifest: Manifest | null = null;
  private readonly base = "assets/vector/";

  /** 幾何層（陸地／水體／道路／建築）—— 由本檔抽出。 */
  private readonly geom = new BaseGeometryLayer();

  /** 全域地名標籤（`labels.json`）。 */
  private labels: PoiRec[] = [];
  /** 全域標籤按 rank 排序嘅快取（A8 P1-1：唔好每次 draw 都 sort）。 */
  private labelOrder: PoiRec[] = [];
  /** 量度過嘅文字寬度快取（key = rank|text）。 */
  private readonly labelWidths = new Map<string, number>();

  /**
   * 螢幕空間**靜態層**快取（海漸層／暗角）。
   *
   * 見 `layerCanvas()` 註釋 —— headless 軟件光柵化之下，全畫布漸層填色
   * 係冷 zoom 阻塞嘅主要來源之一。
   */
  private readonly layerCache = new Map<
    string,
    { key: string; canvas: HTMLCanvasElement }
  >();

  private loaded: Record<string, boolean> = {};

  /** 圖磚 POI（rank 5，街道級地標）—— A4 G2：之前下載但 0 渲染。 */
  private readonly tilePoi = new Map<string, PoiRec[]>();
  private poiOrder: PoiRec[] = [];
  private poiOrderDirty = true;
  private tileRoadCount = 0;

  private readonly tileOrder: string[] = [];
  private readonly tilePending = new Set<string>();

  /** 目前配色（跟 `<html data-theme>`；色相來自 B1 token）。 */
  private palette: BasemapPalette = PALETTE_DARK;
  private themeListener: (() => void) | null = null;

  private view: ViewBox = { x: 0, y: 0, w: 1, h: 1 };
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private raf = 0;
  private level: BasemapLevel = 0;
  private bytesLoaded = 0;
  /** 底圖完全就緒（可以淡入）嘅回呼。 */
  onReady?: (s: BasemapStats) => void;
  onError?: (e: Error) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("瀏覽器唔支援 Canvas 2D");
    this.ctx = ctx;
  }

  /**
   * 切換配色。
   *
   * canvas 唔會讀 CSS 變數，所以 `theme.ts` 換 `<html data-theme>` 之後，
   * `SvgMap` 會轉發過嚟。
   */
  setTheme(theme: "dark" | "light"): void {
    this.palette = theme === "light" ? PALETTE_LIGHT : PALETTE_DARK;
    this.scheduleDraw();
  }

  get isReady(): boolean {
    return this.manifest !== null && this.loaded.land === true;
  }

  /** 載入 manifest 同基礎圖層（陸地／水體／面層／標籤）。 */
  async init(): Promise<void> {
    try {
      const m = (await this.fetchJSON("manifest.json")) as unknown as Manifest;
      this.manifest = m;
      const [land, water, areas, labels] = await Promise.all([
        this.fetchJSON("land.json"),
        this.fetchJSON("water.json"),
        this.fetchJSON("areas.json"),
        this.fetchJSON("labels.json"),
      ]);
      const q = m.quant;
      this.geom.setLand((land.rings as number[][]).map((r) => decodeDelta(r, q)));
      this.geom.setWater((water.rings as number[][]).map((r) => decodeDelta(r, q)));
      this.geom.setAreas(
        (areas.areas as Array<{ k: number; r: number[] }>).map((a) => ({
          k: a.k,
          pts: decodeDelta(a.r, q),
        })),
      );
      this.labels = (labels.labels as PoiRec[]).map((p) => ({
        ...p,
        lon: p.x / q,
        lat: p.y / q,
      }));
      /*
       * ⚠️ 排序只做一次。
       * A8 P1-1 實測：舊 `drawLabels()` **每次 draw** 都
       * `[...items].sort(...)`（7,847 個）+ 7,847 次 `measureText`
       * + O(n²) 碰撞檢測 —— 呢個就係 pan 只有 29 fps 嘅主因。
       */
      this.labelOrder = [...this.labels].sort((p, q2) => p.r - q2.r);
      this.loaded.land = true;
      this.watchTheme();
      this.scheduleDraw();
      this.emitReady();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.onError?.(err);
      throw err;
    }
  }

  private async fetchJSON(rel: string): Promise<Record<string, unknown>> {
    const url = assetUrl(this.base + rel);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`載入 ${url} 失敗：HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      throw new Error(
        `載入 ${url} 時收到 HTML 而唔係 JSON —— 通常代表檔案唔存在。` +
          `請先跑 python scripts/build_vector_basemap.py。`,
      );
    }
    return (await r.json()) as Record<string, unknown>;
  }

  // ------------------------------------------------------------------
  // 縮放層同圖磚
  // ------------------------------------------------------------------

  private ensureLevelData(level: BasemapLevel): void {
    if (!this.manifest) return;
    if (level >= 1 && !this.loaded.roads1) {
      this.loaded.roads1 = true;
      void this.fetchJSON(this.manifest.layers.l1?.file ?? "roads-l1.json")
        .then((d) => {
          const q = this.manifest!.quant;
          const roads = (d.roads as Array<number[]>).map((r) => ({
            cls: r[0],
            flags: r[1],
            pts: decodeDelta(r.slice(2), q),
          })) as RoadRec[];
          this.geom.setGlobalRoads(1, roads);
          this.scheduleDraw();
          this.emitReady();
        })
        .catch((e) => this.onError?.(e as Error));
    }
    if (level === 0 && !this.loaded.roads0) {
      this.loaded.roads0 = true;
      void this.fetchJSON(this.manifest.layers.l0?.file ?? "roads-l0.json")
        .then((d) => {
          const q = this.manifest!.quant;
          const roads = (d.roads as Array<number[]>).map((r) => ({
            cls: r[0],
            flags: r[1],
            pts: decodeDelta(r.slice(2), q),
          })) as RoadRec[];
          this.geom.setGlobalRoads(0, roads);
          this.scheduleDraw();
          this.emitReady();
        })
        .catch((e) => this.onError?.(e as Error));
    }
  }

  /**
   * 目前視窗覆蓋嘅圖磚行列範圍。
   *
   * ⚠️ **唔加 ±1 margin**（舊 code 有）。
   *
   * 為何：A4 F4 實測 max zoom 時視窗只需 **4 格**覆蓋，但 ±1 margin
   * 令佢下載 **16 格** = 4.15 MB（2.9× 過度下載），亦係 Q9（≤1.0 MB）
   * 失敗嘅唯一原因。相交範圍本身已經**冇縫**（floor/ceil 包住所有
   * 相交圖磚），margin 只係為咗平移時預載鄰格 —— 而嗰個可以由
   * LRU + l1 道路 fallback 取代。
   */
  private tileRange(): { r0: number; r1: number; c0: number; c1: number } | null {
    const m = this.manifest;
    if (!m) return null;
    const b = m.bbox;
    const td = m.tile_deg;
    const nc = Math.ceil((b.lon_max - b.lon_min) / td);
    const nr = Math.ceil((b.lat_max - b.lat_min) / td);
    // view.y 係 user unit，唔係緯度 —— 要反解返真實緯度
    const latTop = viewYToLat(b, this.view.y);
    const latBot = viewYToLat(b, this.view.y + this.view.h);
    const c0 = Math.max(0, Math.floor((this.view.x - b.lon_min) / td));
    const c1 = Math.min(nc - 1, Math.floor((this.view.x + this.view.w - b.lon_min) / td));
    const r0 = Math.max(0, Math.floor((latBot - b.lat_min) / td));
    const r1 = Math.min(nr - 1, Math.floor((latTop - b.lat_min) / td));
    if (c1 < c0 || r1 < r0) return null;
    return { r0, r1, c0, c1 };
  }

  private ensureTiles(): void {
    const m = this.manifest;
    if (!m) return;
    const range = this.tileRange();
    if (!range) return;
    const keys: string[] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        keys.push(`${r},${c}`);
      }
    }
    // 安全網：相交格數異常代表視窗太大（應該係上層圖層），唔好爆網絡
    if (keys.length > 16) return;
    // LRU touch：令目前可見嘅圖磚排到最後（最遲被丟）
    for (const k of keys) {
      if (this.tilePoi.has(k)) {
        const i = this.tileOrder.indexOf(k);
        if (i >= 0) this.tileOrder.splice(i, 1);
        this.tileOrder.push(k);
      }
    }
    for (const k of keys) {
      if (this.tilePoi.has(k) || this.tilePending.has(k)) continue;
      this.tilePending.add(k);
      const [r, c] = k.split(",").map(Number);
      const url = `tiles/r${String(r).padStart(2, "0")}c${String(c).padStart(2, "0")}.json`;
      void this.fetchJSON(url)
        .then(async (d) => {
          const q = m.quant;
          const roads = (d.roads as Array<number[]>).map((x) => ({
            cls: x[0],
            flags: x[1],
            pts: decodeDelta(x.slice(2), q),
          })) as RoadRec[];
          /*
           * ⚠️ 建築**分片解碼**（B9 Q10 冷 zoom 阻塞）。
           *
           * 一格圖磚實測有 ~4,500 幢建築，一次過 `decodeDelta` 出 4,500 個
           * `Float64Array` + 建 `Path2D` 要 **~59 ms** —— 一個 59 ms 嘅
           * longtask。分片之後每片 ~800 幢（約 8–10 ms），瀏覽器可以喺
           * 片與片之間處理輸入同 render。
           *
           * ⚠️ 一定要用 macrotask 讓出（`setTimeout`）；`Promise.resolve()`
           * 係 microtask，唔會讓出 rendering，分片就冇意義。
           */
          const rawBld = d.bld as Array<number[]>;
          const bld: BldRec[] = [];
          for (let i = 0; i < rawBld.length; i += TILE_CHUNK) {
            const end = Math.min(i + TILE_CHUNK, rawBld.length);
            for (let j = i; j < end; j++) {
              const x = rawBld[j];
              bld.push({
                pts: decodeDelta(x.slice(0, x.length - 1), q),
                levels: x[x.length - 1],
              });
            }
            if (end < rawBld.length) await yieldToEventLoop();
          }
          const poi = (d.poi as PoiRec[]).map((p) => ({
            ...p,
            lon: p.x / q,
            lat: p.y / q,
          }));
          /*
           * ⚠️ 增量：只建**本格**嘅 Path2D，然後標記聚合為 dirty。
           * 聚合（`Path2D.addPath`）由 `BaseGeometryLayer.draw()` 喺
           * 下一個 frame 做一次 —— 唔會每格重行全部圖磚幾何。
           * 呢個就係 A8 P0-1（21,241 ms 阻塞）嘅修正核心。
           *
           * ⚠️ 用 `addTileChunked`（唔用 `addTile`）：`Path2D` 建立同樣要
           * 分片，否則分片解碼省落嘅時間會喺呢一步一次過還返。
           */
          /*
           * 該格嘅經緯範圍 —— 交畀 `BaseGeometryLayer` 做「視窗內建築數」
           * 嘅快速篩選（B9 `RC-NOFAKEZOOM-ACCUM`）。冇呢個 bbox 就會變成
           * O(全部已載入建築) 每 frame。
           */
          const tileBbox = {
            lon_min: m.bbox.lon_min + c * m.tile_deg,
            lon_max: m.bbox.lon_min + (c + 1) * m.tile_deg,
            lat_min: m.bbox.lat_min + r * m.tile_deg,
            lat_max: m.bbox.lat_min + (r + 1) * m.tile_deg,
          };
          await this.geom.addTileChunked(
            k,
            { roads, bld, bbox: tileBbox },
            yieldToEventLoop,
            TILE_CHUNK,
          );
          this.tilePoi.set(k, poi);
          this.poiOrderDirty = true;
          this.tileOrder.push(k);
          this.tileRoadCount += roads.length;
          /*
           * 唔可以喺度 `JSON.stringify(d)` 嚟量度大小 —— 實測一個圖磚
           * 可以係 1 MiB，每載入一格就重新序列化係純浪費。
           * 改用記錄數估算（每筆約 40 bytes）。
           */
          this.bytesLoaded += (roads.length + bld.length + poi.length) * 40;
          this.scheduleDraw();
          this.emitReady();
        })
        .catch(() => {
          /* 單一圖磚失敗唔應該令成個底圖消失 —— 其餘圖磚照畫 */
        })
        .finally(() => this.tilePending.delete(k));
    }
    // LRU 淘汰：只喺超出上限時丟最舊嘅
    while (this.tileOrder.length > TILE_CACHE_MAX) {
      const old = this.tileOrder.shift()!;
      if (keys.includes(old)) {
        // 仲喺視野內 —— 唔應該丟，放返隊尾
        this.tileOrder.push(old);
        break;
      }
      this.dropTile(old);
    }
  }

  private dropTile(key: string): void {
    const poi = this.tilePoi.get(key);
    if (poi) {
      this.tilePoi.delete(key);
      this.poiOrderDirty = true;
    }
    this.geom.removeTile(key);
  }

  private emitReady(): void {
    if (!this.isReady) return;
    this.onReady?.({
      level: this.level,
      tiles: this.geom.tileCount,
      roads: this.tileRoadCount,
      buildings: this.geom.buildingCount,
      bytes: this.bytesLoaded,
      ready: true,
    });
  }

  // ------------------------------------------------------------------
  // 繪製
  // ------------------------------------------------------------------

  setView(view: ViewBox, cssW: number, cssH: number, dpr: number): void {
    this.view = view;
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    if (dpr !== this.dpr) {
      // DPR 變 → 量度過嘅文字寬度唔再啱
      this.labelWidths.clear();
    }
    this.dpr = dpr;
    const next = selectBasemapLevel(view.w);
    /*
     * 對外暴露層級。
     *
     * ⚠️ 一定要**無條件**寫，唔可以只喺層級改變時寫。實測踩過：
     * 初始層級 0、`next` 都係 0 → 條件唔成立 → 屬性從來冇設定 →
     * e2e 讀到 -1 而失敗。
     */
    this.canvas.dataset.basemapLevel = String(next);
    if (next !== this.level) {
      this.level = next;
      this.canvas.dispatchEvent(
        new CustomEvent("basemap-level-change", {
          bubbles: true,
          detail: { level: next, span: view.w },
        }),
      );
    }
    this.ensureLevelData(next);
    if (next === 2) this.ensureTiles();
    this.scheduleDraw();
  }

  private scheduleDraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const { ctx } = this;
    const W = this.cssW;
    const H = this.cssH;
    const pxW = Math.round(W * this.dpr);
    const pxH = Math.round(H * this.dpr);
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }

    // ---- 海 + 格線（螢幕空間；海同暗角係靜態 → 用快取 canvas blit）----
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.blitSea(ctx, W, H);
    this.drawGrid(ctx, W, H);

    if (!this.manifest) return;

    // ---- 幾何（陸地／水體／道路／建築；BaseGeometryLayer 自己設 transform） ----
    const stats = this.geom.draw(ctx, {
      view: this.view,
      cssW: W,
      cssH: H,
      dpr: this.dpr,
      bbox: this.manifest.bbox,
      level: this.level,
      palette: this.palette,
    });

    // ---- 標籤（要 reset transform，用螢幕像素座標） ----
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawLabels(ctx, stats.scale, stats.offsetX, stats.offsetY);
    if (stats.lowDensity) this.drawNoDetailNotice(ctx, W, H);
    this.blitVignette(ctx, W, H);

    /*
     * No-fake-zoom 狀態（Q11）。
     *
     * 為何要寫落 DOM：canvas 入面嘅字**唔可以**由測試查詢。A4 明確
     * 讚同呢個 pattern（`data-basemap-level` 令「層級有冇跟住縮放切換」
     * 可以自動化）。所以狀態要有一個可程式化讀取嘅出口。
     */
    this.canvas.dataset.detailState = stats.lowDensity ? "sparse" : "ok";
    this.canvas.dataset.tilePoi = String(this.visiblePoiCount());
  }

  /** 目前圖磚 POI 數（測試／除錯用）。 */
  private visiblePoiCount(): number {
    let n = 0;
    for (const list of this.tilePoi.values()) n += list.length;
    return n;
  }

  /**
   * 暗角。
   *
   * 為何要：平面填色嘅地圖四邊同中央一樣亮，睇落「平」同「未完成」。
   * 加一層由邊緣向內漸淡嘅黑，令視線自然集中喺中央。
   *
   * ⚠️ 內容係**螢幕空間、靜態**（只跟尺寸／DPR／配色），所以快取落
   * 一張 canvas，每 frame 只 blit（見 `layerCanvas()` 註釋）。
   */
  private blitVignette(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const c = this.layerCanvas("vignette", W, H, (g) => {
      const r = Math.hypot(W, H) / 2;
      const grad = g.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, this.palette.vignette);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    });
    if (c) ctx.drawImage(c, 0, 0, W, H);
  }

  /**
   * 海（垂直漸層）。
   *
   * ⚠️ 同上：螢幕空間、靜態（只跟尺寸／DPR／配色）。
   */
  private blitSea(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const c = this.layerCanvas("sea", W, H, (g) => {
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, this.palette.seaTop);
      grad.addColorStop(1, this.palette.seaBottom);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    });
    if (c) ctx.drawImage(c, 0, 0, W, H);
  }

  /**
   * 螢幕空間靜態層嘅快取（B9 Q10 冷 zoom 阻塞）。
   *
   * 為何要快取：海漸層同暗角都係**全畫布**漸層填色（785k px）。headless
   * Chromium 用**軟件光柵化**，每個漸層填色要逐像素計漸層值；快取之後
   * 每 frame 只係一次 `drawImage`（唔需要再計漸層）。
   *
   * 快取鍵包含尺寸／DPR／配色 —— 三者任一改變就要重建。
   */
  private layerCanvas(
    kind: "sea" | "vignette",
    W: number,
    H: number,
    paint: (g: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement | null {
    const key = `${kind}|${Math.round(W)}x${Math.round(H)}@${this.dpr}|${this.palette.seaTop}|${this.palette.seaBottom}|${this.palette.vignette}`;
    const cached = this.layerCache.get(kind);
    if (cached && cached.key === key) return cached.canvas;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(W * this.dpr));
    canvas.height = Math.max(1, Math.round(H * this.dpr));
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    paint(g);
    this.layerCache.set(kind, { key, canvas });
    return canvas;
  }

  /** 經緯網格（未來感底紋）。 */
  private drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const step = this.view.w > 0.4 ? 0.1 : this.view.w > 0.15 ? 0.05 : 0.01;
    const s = Math.min(W / this.view.w, H / this.view.h);
    const ox = (W - this.view.w * s) / 2;
    ctx.save();
    ctx.strokeStyle = this.palette.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const c0 = Math.ceil(this.view.x / step) * step;
    for (let lon = c0; lon <= this.view.x + this.view.w; lon += step) {
      const x = Math.round((lon - this.view.x) * s + ox) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = 0; y <= H; y += step * s * 4) {
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(W, yy);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 文字寬度（量度一次，之後由快取讀 —— pan 期間零 `measureText`）。 */
  private labelWidth(ctx: CanvasRenderingContext2D, p: PoiRec): number {
    const key = `${p.r}|${p.n}`;
    const cached = this.labelWidths.get(key);
    if (cached !== undefined) return cached;
    const m = measureContext() ?? ctx;
    m.font = fontOfRank(p.r);
    const w = m.measureText(p.n).width;
    if (this.labelWidths.size >= LABEL_WIDTH_CACHE_MAX) {
      // FIFO 淘汰（Map 保留插入次序）
      const oldest = this.labelWidths.keys().next().value;
      if (oldest !== undefined) this.labelWidths.delete(oldest);
    }
    this.labelWidths.set(key, w);
    return w;
  }

  /**
   * 畫標籤（全域地名 + tile POI）。
   *
   * A4 G2：`TileData.poi`（11,645 個建築名，rank 5）由 Phase L 開始
   * 一直**有下載、有解析、有計入 `bytesLoaded`，但 `draw()` 從未引用**。
   * 佢哋係唯一嘅街道級地標來源（帝京酒店 / 朗豪坊 / 英華小學…），
   * 所以 max zoom 只有 39–63 個屋苑／公園名（rank 3），冇一個地標名。
   *
   * 本方法將兩者合併、按名去重、用**空間網格**做碰撞剔除（唔再 O(n²)）。
   */
  private drawLabels(
    ctx: CanvasRenderingContext2D,
    s: number,
    ox: number,
    oy: number,
  ): void {
    const tier = selectTier(this.view.w);
    const maxRank = maxLabelRank(tier);
    const wantPoi = includesTilePoi(tier);

    const candidates: PoiRec[] = [];
    for (const p of this.labelOrder) {
      if (p.r > maxRank) continue;
      candidates.push(p);
    }
    if (wantPoi) {
      if (this.poiOrderDirty) {
        this.poiOrder = [...this.tilePoi.values()]
          .flat()
          .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
        this.poiOrderDirty = false;
      }
      for (const p of this.poiOrder) candidates.push(p);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    /*
     * ⚠️ 光暈嘅 `strokeStyle` / `lineWidth` 係**每 frame 常數** → 喺迴圈外
     * 設一次。原本逐個標籤指派，等於每 frame 做 ~343 次 CSS 顏色字串解析
     * （`rgba(...)`）＋屬性驗證。實測連同字體快取一齊做，冷 zoom longtask
     * 合計由 449 → 395 ms。
     */
    ctx.strokeStyle = this.palette.labelHalo;
    ctx.lineWidth = LABEL_HALO_WIDTH;

    const grid = new Map<number, LabelBox[]>();
    const gkey = (cx: number, cy: number) =>
      ((cx + 512) << 11) + (cy + 512);
    const hits = (box: LabelBox): boolean => {
      const c0 = Math.floor(box.x / COLLIDE_CELL);
      const c1 = Math.floor((box.x + box.w) / COLLIDE_CELL);
      const r0 = Math.floor(box.y / COLLIDE_CELL);
      const r1 = Math.floor((box.y + box.h) / COLLIDE_CELL);
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const arr = grid.get(gkey(cx, cy));
          if (!arr) continue;
          for (const o of arr) {
            if (
              box.x < o.x + o.w &&
              box.x + box.w > o.x &&
              box.y < o.y + o.h &&
              box.y + box.h > o.y
            ) {
              return true;
            }
          }
        }
      }
      return false;
    };
    const insert = (box: LabelBox): void => {
      const c0 = Math.floor(box.x / COLLIDE_CELL);
      const c1 = Math.floor((box.x + box.w) / COLLIDE_CELL);
      const r0 = Math.floor(box.y / COLLIDE_CELL);
      const r1 = Math.floor((box.y + box.h) / COLLIDE_CELL);
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const k = gkey(cx, cy);
          const arr = grid.get(k);
          if (arr) arr.push(box);
          else grid.set(k, [box]);
        }
      }
    };

    const drawnNames = new Set<string>();
    /** 目前 `ctx.font` 對應嘅 rank（-1 = 未設定）。見下面嘅指派守門。 */
    let curRank = -1;
    for (const p of candidates) {
      const lv = LABEL_MIN_LEVEL[p.r] ?? 2;
      if (lv > this.level) continue;
      const x = (p.lon - this.view.x) * s + ox;
      const py = (this.userY(p.lat) - this.view.y) * s + oy;
      if (x < -120 || x > this.cssW + 120 || py < -40 || py > this.cssH + 40) continue;
      // 同名去重（tile POI 同 global labels 會有重疊）
      if (drawnNames.has(p.n)) continue;
      const tw = this.labelWidth(ctx, p);
      const st = LABEL_SIZE[p.r] ?? LABEL_SIZE[5];
      const box: LabelBox = {
        x: x - tw / 2 - 4,
        y: py - st.size / 2 - 2,
        w: tw + 8,
        h: st.size + 4,
      };
      if (hits(box)) continue;
      insert(box);
      drawnNames.add(p.n);
      /*
       * ⚠️ 唔可以用 sprite 快取（實測否決，2026-09-24）
       * ------------------------------------------------
       * 試過將「光暈 + 填色」預先畫落細 canvas 再 `drawImage`：
       * 標籤成本**由 184 ms 升到 260 ms**（+41%）。原因係 `drawImage`
       * 嘅目標座標係分數 px → 每次貼圖都要做**濾波重取樣**，比原生
       * 字形光柵化更慢；而且連續縮放期間可見標籤集每格都變，命中率
       * 唔足以抵銷建 canvas 嘅開銷。
       * → 保持直接 `strokeText` + `fillText`。
       */
      if (p.r !== curRank) {
        /*
         * `ctx.font` / `ctx.fillStyle` 指派唔係免費（字串解析 + 字型查找）
         * → 只在 rank 改變時指派（`labelOrder` 已按 rank 排序，所以通常
         * 只會指派 1–6 次而唔係 ~343 次）。
         */
        ctx.font = fontOfRank(p.r);
        ctx.fillStyle = this.palette.label[p.r] ?? this.palette.label[5];
        curRank = p.r;
      }
      ctx.strokeText(p.n, x, py);
      ctx.fillText(p.n, x, py);
    }
  }

  /** 緯度 → user unit y（同 `SvgMap.lonlatToViewbox` 完全一致）。 */
  private userY(lat: number): number {
    const b = this.manifest!.bbox;
    return b.lat_min + (b.lat_max - lat) / PROJ_COS;
  }

  /**
   * No-fake-zoom 文字（spec §4.3 / Q11）。
   *
   * 低密度區唔可以只係「空白陸地」—— 要明確講「此區未有細節資料」，
   * 令用戶知道係資料邊界而唔係地圖壞咗。
   */
  private drawNoDetailNotice(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
  ): void {
    const text = NO_DETAIL_TEXT;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 13px ${LABEL_FONT_STACK}`;
    const x = W / 2;
    const y = H / 2;
    ctx.strokeStyle = this.palette.labelHalo;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = this.palette.label[1] ?? this.palette.label[5];
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /** 跟隨 `<html data-theme>`（由 `theme.ts` 設定）。 */
  private watchTheme(): void {
    const read = () => {
      const t = document.documentElement.getAttribute("data-theme");
      this.setTheme(t === "light" ? "light" : "dark");
    };
    read();
    this.themeListener = read;
    window.addEventListener("basemap-theme-change", read);
  }

  destroy(): void {
    if (this.themeListener) {
      window.removeEventListener("basemap-theme-change", this.themeListener);
      this.themeListener = null;
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.tilePoi.clear();
    this.tileOrder.length = 0;
    this.tilePending.clear();
    this.labelWidths.clear();
    this.layerCache.clear();
    this.geom.dispose();
  }
}

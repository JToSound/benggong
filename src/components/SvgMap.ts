/**
 * SvgMap — 《病港》互動故事地圖。
 *
 * 底圖：香港全境 OSM procedural basemap（PNG），由
 * `scripts/render_hk_basemap.py` 生成，覆蓋 bbox
 * lon 113.85–114.45 / lat 22.18–22.55。標記直接由 lon/lat 線性投影。
 *
 * 互動：
 * - Hover marker → tooltip（<title>）
 * - Click marker → 選中，開詳情面板
 * - 拖曳平移、滾輪／按鈕縮放
 *
 * Phase I 新增：
 * - `resolveCoord()` 四層座標解析（有證據支持嘅資料集座標 → FALLBACK_ANCHORS → FULL_HK_ANCHORS → 原始座標）
 * - `animateViewBox()` 用 requestAnimationFrame + ease-in-out cubic 做平滑轉場
 * - `#label-detail-layer`：獨立透明標籤圖層，按 `viewScale` 線性插值透明度
 *   （zoom out 時隱藏次要街道名，做到 zoom-dependent label decluttering）
 * - 雙語圖例（zh / en），`data-i18n` 標記 + `#legend-lang-btn` 切換
 */

import type { App } from "../app";
import type { AppData, RouteFeature, EventFeature } from "../data/loadAllData";
import { FULL_HK_ANCHORS } from "../data/fallbackAnchors";
import basemapPngUrl from "../../public/assets/hk-basemap.png?url";
import labelDetailPngUrl from "../../public/assets/hk-basemap-labels.png?url";
import basemapCoords from "../../public/assets/hk-basemap-coords.json";
import lodManifest from "../../public/assets/map-lod/manifest.json";

/**
 * 投影：等距圓柱 + 標準緯線校正。
 *
 * 為何要乘 1/cos(φ₀)
 * ------------------
 * SVG user unit 直接用「度」會令 1° 經度同 1° 緯度一樣長。但喺北緯 22.36°，
 * 1° 緯度（110.6 km）比 1° 經度（103.0 km）長 1.081 倍。所以垂直方向要乘
 * 1/cos(22.36°) ≈ 1.081，圖上長度才同真實距離成比例。
 *
 * 舊版嘅嚴重錯誤
 * --------------
 * 舊底圖係 2048×2048 正方形，但覆蓋 0.6°×0.37°（長寬比 1.622），
 * 再配合 `preserveAspectRatio="xMidYMid slice"` 放入 0.6×0.37 嘅框。
 * slice 會把正方形圖等比放大到覆蓋，再垂直裁走 38% —— 結果底圖相對
 * 標記座標被**垂直拉伸 1.622 倍**（以中心為軸），邊緣位置偏差達
 * ±0.115°（約 12.8 km）。即係「標記唔喺真實位置」嘅主因之一。
 *
 * 現在底圖由 `render_binggang_map.py` 以同一投影產生（畫布長寬比 =
 * 校正後 bbox 長寬比），前端用 `preserveAspectRatio="none"` 精確貼合
 * 對應經緯矩形，兩者像素級對齊。
 */
const PROJ_COS = lodManifest.projection_cos;

/** 底圖覆蓋嘅經緯範圍（由 render script 生成）。 */
const BASEMAP_BBOX = (
  basemapCoords as {
    bbox: { lon_min: number; lon_max: number; lat_min: number; lat_max: number };
  }
).bbox;

/**
 * 預設視圖：覆蓋全港。亦係所有座標換算嘅基準。
 *
 * user unit 定義：x 數值 = 經度偏移；y 由 lat_max 向下遞增，
 * 垂直尺度已乘 1/cos(φ₀)（見上面說明）。
 */
const BASE_VIEW = {
  x: BASEMAP_BBOX.lon_min,
  y: BASEMAP_BBOX.lat_min,
  w: BASEMAP_BBOX.lon_max - BASEMAP_BBOX.lon_min,
  h: (BASEMAP_BBOX.lat_max - BASEMAP_BBOX.lat_min) / PROJ_COS,
};
const VIEWBOX = `${BASE_VIEW.x} ${BASE_VIEW.y} ${BASE_VIEW.w} ${BASE_VIEW.h}`;

/** 縮放層級圖磚（由 `scripts/build_map_lods.py` 產生）。 */
interface LodTier {
  id: string;
  label: string;
  note: string;
  image: string;
  bbox: { lon_min: number; lon_max: number; lat_min: number; lat_max: number };
  output_size: number[];
  lod: string;
  label_layer?: string;
}

const LOD_TIERS: LodTier[] = (lodManifest as unknown as { tiers: LodTier[] })
  .tiers;

/** 層級圖磚嘅經度跨度，用嚟揀「最窄但仍然覆蓋視窗」嘅層級。 */
function tierSpan(t: LodTier): number {
  return t.bbox.lon_max - t.bbox.lon_min;
}

/**
 * 層級圖磚 → SVG user unit 矩形。
 *
 * 每個圖磚覆蓋一個經緯 bbox，換算方式同 `lonlatToViewbox` 完全一致，
 * 所以圖磚上任何一點嘅地理位置都同標記座標系對得上。
 */
function tierRect(t: LodTier): { x: number; y: number; w: number; h: number } {
  const a = lonlatToViewbox(t.bbox.lon_min, t.bbox.lat_max);
  const b = lonlatToViewbox(t.bbox.lon_max, t.bbox.lat_min);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/**
 * manifest 入面嘅路徑係相對 `public/`（例如 `assets/map-lod/tko-street.png`）。
 * 要加 `BASE_URL` 前綴才喺 GitHub Pages 之類嘅子路徑部署下正確解析。
 */
function assetUrl(p: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
}

/**
 * 縮放上下限（相對基準視圖）。
 *
 * ⚠️ MAX_SCALE 必須同 LOD 圖磚嘅跨度匹配
 * ------------------------------------
 * 視窗最窄寬度 = BASE_VIEW.w / MAX_SCALE。如果圖磚跨度細過呢個值，
 * 佢就**永遠唔會被揀到**（因為揀層要求「完全覆蓋視窗」）。
 *
 * 實測踩過：MAX_SCALE = 12 → 最窄視窗 0.0583°；而 tko-campus 圖磚
 * 跨度只有 0.036°、tko-north 只有 0.068°，結果兩者幾乎永遠用唔到，
 * 白白多咗 3.2 MiB 資產。
 *
 * 現時：0.70 / 30 ≈ 0.0233°，足夠覆蓋最窄嘅圖磚（tko-campus 0.036°）。
 */
const MIN_SCALE = 0.5;
const MAX_SCALE = 30;

/** 標籤圖層淡入區間：viewScale ≤ 0.8 完全隱藏，≥ 1.2 完全顯示。 */
const LABEL_FADE_IN = 0.8;
const LABEL_FADE_FULL = 1.2;

const ANIM_DURATION_MS = 500;

// Basemap PNG（由 render script 生成；bbox 同投影常數見上方）。
const BASEMAP_PNG = basemapPngUrl;
const LABEL_DETAIL_PNG = labelDetailPngUrl;

/**
 * 虛構／離網故事地點嘅人工錨點。
 *
 * 部分故事地點（艾寶琳倖存區、病者之都等）係虛構，OSM 冇記錄，
 * 資料集嘅 lon/lat 亦唔可靠，所以喺將軍澳一帶指定座標。
 * 呢層優先級最高，因為佢係人手核對過嘅。
 */
const FALLBACK_ANCHORS: Record<string, { lon: number; lat: number }> = {
  // Tseung Kwan O fictional / off-grid
  "艾寶琳倖存區": { lon: 114.27, lat: 22.31 },
  "艾寶琳": { lon: 114.27, lat: 22.31 },
  "寶琳倖存區": { lon: 114.27, lat: 22.31 },
  "病者之都": { lon: 114.2, lat: 22.3 },
  "病者平權組織": { lon: 114.27, lat: 22.32 },
  "不良人": { lon: 114.3, lat: 22.3 },
  "大本營": { lon: 114.265, lat: 22.315 },
  "大本營市集": { lon: 114.265, lat: 22.318 },
  "將軍澳地鐵站": { lon: 114.26, lat: 22.318 },
  "坑口地鐵站": { lon: 114.265, lat: 22.316 },
  "調景嶺地鐵站": { lon: 114.255, lat: 22.305 },
  "寶琳地鐵站": { lon: 114.255, lat: 22.32 },
  "日出康城地鐵站": { lon: 114.275, lat: 22.295 },
  "康城": { lon: 114.275, lat: 22.295 },
  "將軍澳醫院": { lon: 114.25, lat: 22.32 },
  "調景嶺體育館": { lon: 114.255, lat: 22.31 },
  "香港知專設計學院": { lon: 114.262, lat: 22.314 },
  "TKO Spot": { lon: 114.26, lat: 22.31 },
  "寶盈花園": { lon: 114.262, lat: 22.317 },
  "將軍澳中心": { lon: 114.265, lat: 22.318 },
  "東港城": { lon: 114.265, lat: 22.317 },
  "PopCorn": { lon: 114.265, lat: 22.317 },
  "MCP": { lon: 114.265, lat: 22.318 },
  "尚德": { lon: 114.262, lat: 22.318 },
  "彩明": { lon: 114.265, lat: 22.316 },
  "厚德": { lon: 114.262, lat: 22.318 },
  "唐明": { lon: 114.265, lat: 22.316 },
  "富康": { lon: 114.262, lat: 22.318 },
  "英明": { lon: 114.265, lat: 22.316 },
  "廣明": { lon: 114.265, lat: 22.316 },
  "景明": { lon: 114.265, lat: 22.316 },
  "港澳碼頭": { lon: 114.15, lat: 22.29 },
  "中環碼頭": { lon: 114.158, lat: 22.285 },
  "尖沙咀碼頭": { lon: 114.17, lat: 22.295 },
};

/** 座標來源，方便除錯同測試。 */
export type CoordSource = "fallback" | "full-hk" | "raw";

/**
 * 座標解析（四層）。
 *
 * 0. **資料集自帶座標（有證據支持）** — 最高優先
 * 1. `FALLBACK_ANCHORS` — Phase I 人手估算嘅錨點
 * 2. `FULL_HK_ANCHORS` — Phase I 由 OSM 抽出嘅 503 個 landmark
 * 3. 原始 lon/lat
 *
 * ⚠️ 為何「有證據支持」要排第一
 * ----------------------------
 * `FALLBACK_ANCHORS` 係 **Phase I 嘅人手估算**，喺當時冇真實資料嘅情況下
 * 用嚟頂住。Phase J 之後，好多地點已經有**經 OSM／推斷核實**嘅座標
 * （`inferred_from` 有值）。
 *
 * 但原本嘅優先級令硬編碼估算**蓋過**已核實座標 —— 實測 12 個最重要嘅
 * 地點中招，包括：
 *   「香港知專設計學院」硬編碼 (114.262, 22.314)，實際 OSM (114.2525, 22.3060)
 *     → 偏差約 900 m
 *   「大本營」「將軍澳中心」「寶琳倖存區」「將軍澳地鐵站」…
 * 即係話：**推斷做嘅嘢喺地圖上完全睇唔到**。
 *
 * 所以有 `inferred_from`（可稽核嘅證據來源）嘅座標優先。冇嘅話，
 * 仍然用返硬編碼錨點（嗰啲地點未有更好嘅資料）。
 */
export function resolveCoord(
  name: string,
  lon: number,
  lat: number,
  opts?: { evidenceBacked?: boolean },
): { lon: number; lat: number; source: CoordSource } {
  if (opts?.evidenceBacked) {
    return { lon, lat, source: "raw" };
  }
  const curated = FALLBACK_ANCHORS[name];
  if (curated) {
    return { lon: curated.lon, lat: curated.lat, source: "fallback" };
  }
  const fullHk = FULL_HK_ANCHORS[name];
  if (fullHk) {
    return { lon: fullHk.lon, lat: fullHk.lat, source: "full-hk" };
  }
  return { lon, lat, source: "raw" };
}

/** lon/lat → SVG user unit。超出 bbox 會 clamp 到邊緣。 */
function lonlatToViewbox(lon: number, lat: number): { x: number; y: number } {
  // SVG y 軸向下，地理緯度向北遞增，所以 y fraction 要反轉。
  const x = Math.max(BASEMAP_BBOX.lon_min, Math.min(BASEMAP_BBOX.lon_max, lon));
  const y = Math.max(BASEMAP_BBOX.lat_min, Math.min(BASEMAP_BBOX.lat_max, lat));
  const fx =
    (x - BASEMAP_BBOX.lon_min) / (BASEMAP_BBOX.lon_max - BASEMAP_BBOX.lon_min);
  const fy =
    (BASEMAP_BBOX.lat_max - y) / (BASEMAP_BBOX.lat_max - BASEMAP_BBOX.lat_min);
  return { x: BASE_VIEW.x + fx * BASE_VIEW.w, y: BASE_VIEW.y + fy * BASE_VIEW.h };
}

/** 圖例文案。key 同 HTML 嘅 `data-i18n` 對應。 */
const LEGEND_ZH: Record<string, string> = {
  "legend.title": "地圖標記",
  "legend.event-current": "本章事件",
  "legend.event-other": "其他章事件",
  "legend.loc-real": "真實地點",
  "legend.loc-fictional": "虛構地點",
  "legend.selected": "選中",
  "legend.route": "角色路線（僅真實地點之間）",
  "legend.zone-survivor": "倖存區（安全）",
  "legend.zone-nest": "病窩（危險）",
  "legend.zone-estimated": "虛線＝範圍係估算",
};

const LEGEND_EN: Record<string, string> = {
  "legend.title": "Map legend",
  "legend.event-current": "Current-chapter event",
  "legend.event-other": "Other-chapter event",
  "legend.loc-real": "Real location",
  "legend.loc-fictional": "Fictional location",
  "legend.selected": "Selected",
  "legend.route": "Character route (real places only)",
};

/** 視圖狀態（單一真相來源）。 */
interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class SvgMap {
  root: HTMLElement;
  app: App;
  data: AppData;
  svg!: SVGSVGElement;

  /** 目前 viewBox —— pan／zoom／flyTo 全部改呢個，render() 只負責套用。 */
  private view: ViewBox = { ...BASE_VIEW };
  /** 目前圖例語言。 */
  private lang: "zh" | "en" = "zh";
  /** 進行中嘅轉場 frame id（用嚟取消舊動畫）。 */
  private animFrameId: number | null = null;
  /** 拖曳平移狀態。 */
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartView: ViewBox = { ...BASE_VIEW };
  /** 目前生效嘅 LOD 圖磚 id（避免重複設定同一張圖）。 */
  private currentTierId: string = "";

  constructor(root: HTMLElement, app: App) {
    this.root = root;
    this.app = app;
    this.data = app.data;
    this.init();
  }

  /** 相對基準視圖嘅縮放倍率（1 = 全港）。 */
  get viewScale(): number {
    return BASE_VIEW.w / this.view.w;
  }

  /**
   * 標記半徑補償：user unit 半徑 ÷ 縮放倍率 → 屏幕尺寸大致恆定。
   *
   * 為何需要
   * --------
   * 標記半徑寫死喺 user unit（例如 0.008）。全港視圖寬 0.70°，睇落啱；
   * 但街道級視圖寬只有 0.058°，同一個 0.008 就佔咗畫面 27% —— 實測
   * 放大到將軍澳市中心時，幾個標記會完全蓋住地圖。
   *
   * 上限 10 倍：再放大時容許標記略微變大，避免縮到睇唔到。
   */
  private markerR(base: number): number {
    const s = Math.min(Math.max(this.viewScale, 0.5), 10);
    return base / s;
  }

  private init(): void {
    this.root.innerHTML = `
      <div class="svg-map-wrap">
        <svg id="svg-map" class="svg-map" viewBox="${VIEWBOX}" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="markerGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="0.0015" result="blur"/>
              <feMerge>
                <feMergeNode in="blur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
            <pattern id="paperTexture" width="0.02" height="0.02" patternUnits="userSpaceOnUse">
              <circle cx="0.005" cy="0.005" r="0.0005" fill="#a8c8e8" opacity="0.15"/>
              <circle cx="0.015" cy="0.012" r="0.0005" fill="#88a8c8" opacity="0.15"/>
            </pattern>
          </defs>
          <g id="map-content">
            <image id="basemap-group" class="basemap-layer" href="${BASEMAP_PNG}"
                   x="${BASE_VIEW.x}" y="${BASE_VIEW.y}" width="${BASE_VIEW.w}" height="${BASE_VIEW.h}"
                   preserveAspectRatio="none" />
            <g id="label-detail-layer" class="label-detail-layer" pointer-events="none" opacity="0">
              <image id="label-detail-image" class="label-detail-image" href="${LABEL_DETAIL_PNG}"
                     x="${BASE_VIEW.x}" y="${BASE_VIEW.y}" width="${BASE_VIEW.w}" height="${BASE_VIEW.h}"
                     preserveAspectRatio="none" />
            </g>
            <g id="zones-layer" class="zones-layer"></g>
            <g id="routes-layer" class="routes-layer"></g>
            <g id="locations-layer" class="locations-layer"></g>
            <g id="events-layer" class="events-layer"></g>
          </g>
        </svg>
        <div class="map-overlay" id="map-overlay">
          <div class="map-legend" id="map-legend">
            <div class="legend-title-row">
              <div class="legend-title" data-i18n="legend.title">地圖標記</div>
              <button id="legend-lang-btn" class="legend-lang-btn" type="button"
                      title="切換圖例語言 / Toggle legend language">EN</button>
            </div>
            <div class="legend-item"><span class="dot dot-event-current"></span><span data-i18n="legend.event-current">本章事件</span></div>
            <div class="legend-item"><span class="dot dot-event-other"></span><span data-i18n="legend.event-other">其他章事件</span></div>
            <div class="legend-item"><span class="dot dot-loc-real"></span><span data-i18n="legend.loc-real">真實地點</span></div>
            <div class="legend-item"><span class="dot dot-loc-fictional"></span><span data-i18n="legend.loc-fictional">虛構地點</span></div>
            <div class="legend-item"><span class="dot dot-selected"></span><span data-i18n="legend.selected">選中</span></div>
            <div class="legend-item"><span class="area area-survivor"></span><span data-i18n="legend.zone-survivor">倖存區（安全）</span></div>
            <div class="legend-item"><span class="area area-nest"></span><span data-i18n="legend.zone-nest">病窩（危險）</span></div>
            <div class="legend-item"><span class="area area-estimated"></span><span data-i18n="legend.zone-estimated">虛線＝範圍係估算</span></div>
            <div class="legend-item"><span class="line route-legend"></span><span data-i18n="legend.route">角色路線（僅真實地點之間）</span></div>
          </div>
        </div>
        <div class="map-controls">
          <button id="map-zoom-in" class="map-ctrl" title="放大" type="button">+</button>
          <button id="map-zoom-out" class="map-ctrl" title="縮小" type="button">−</button>
          <button id="map-reset" class="map-ctrl" title="重置視圖" type="button">⌂</button>
        </div>
      </div>
    `;
    this.svg = this.root.querySelector<SVGSVGElement>("#svg-map")!;
    this.bindEvents();
    this.render();
  }

  private bindEvents(): void {
    this.root
      .querySelector("#map-zoom-in")!
      .addEventListener("click", () => this.zoomBy(1.3));
    this.root
      .querySelector("#map-zoom-out")!
      .addEventListener("click", () => this.zoomBy(1 / 1.3));
    this.root.querySelector("#map-reset")!.addEventListener("click", () => {
      this.animateViewBox({ ...BASE_VIEW });
    });

    // 圖例語言切換
    const langBtn = this.root.querySelector("#legend-lang-btn");
    if (langBtn) {
      langBtn.addEventListener("click", () => this.toggleLegendLanguage());
    }

    // Marker / route click delegation
    this.svg.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.classList.contains("event-marker")) {
        const id = t.getAttribute("data-event-id");
        if (id) this.app.setSelectedEvent(id);
      } else if (
        t.classList.contains("location-marker-cluster") ||
        t.parentElement?.classList.contains("location-marker-cluster")
      ) {
        // 聚合標記：放大去拆開佢（而唔係選中單一地點）
        const cluster =
          t.closest(".location-marker-cluster") ?? t.parentElement!;
        const cid = cluster.getAttribute("data-loc-id");
        if (cid) this.zoomToLocation(cid);
      } else if (t.classList.contains("location-marker")) {
        const id = t.getAttribute("data-loc-id");
        if (id) this.app.setSelectedLocation(id);
      } else if (t.classList.contains("route-line")) {
        const id = t.getAttribute("data-route-id");
        if (id) {
          const route = this.data.routes.features.find(
            (f) => f.properties.id === id,
          );
          if (route) this.app.setChapter(route.properties.chapters_span[0]);
        }
      }
    });

    // 平移：mousedown 記低起點，mousemove 累加 delta
    this.svg.addEventListener("mousedown", (e) => {
      const t = e.target as Element;
      if (t.tagName === "svg" || t.id === "basemap-group" || t.id === "label-detail-layer") {
        this.isPanning = true;
        this.panStartX = e.clientX;
        this.panStartY = e.clientY;
        this.panStartView = { ...this.view };
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.isPanning) return;
      const rect = this.svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const u = this.pxToUserUnits(rect.width, rect.height);
      this.view = {
        ...this.panStartView,
        x: this.panStartView.x - (e.clientX - this.panStartX) * u,
        y: this.panStartView.y - (e.clientY - this.panStartY) * u,
      };
      this.applyViewBox();
    });
    window.addEventListener("mouseup", () => {
      this.isPanning = false;
    });

    // 滾輪縮放
    this.svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
      },
      { passive: false },
    );

    // 觸控：單指平移、雙指縮放
    let pinchStartDist = 0;
    let pinchStartView: ViewBox = { ...BASE_VIEW };
    this.svg.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        this.isPanning = true;
        this.panStartX = e.touches[0].clientX;
        this.panStartY = e.touches[0].clientY;
        this.panStartView = { ...this.view };
      } else if (e.touches.length === 2) {
        this.isPanning = false;
        pinchStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        pinchStartView = { ...this.view };
      }
    }, { passive: true });
    this.svg.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1 && this.isPanning) {
        const rect = this.svg.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const u = this.pxToUserUnits(rect.width, rect.height);
        this.view = {
          ...this.panStartView,
          x: this.panStartView.x - (e.touches[0].clientX - this.panStartX) * u,
          y: this.panStartView.y - (e.touches[0].clientY - this.panStartY) * u,
        };
        this.applyViewBox();
      } else if (e.touches.length === 2 && pinchStartDist > 0) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        const factor = dist / pinchStartDist;
        this.view = this.scaledView(pinchStartView, factor);
        this.applyViewBox();
      }
    }, { passive: true });
    this.svg.addEventListener("touchend", () => {
      this.isPanning = false;
      pinchStartDist = 0;
    }, { passive: true });
  }

  /** 以視圖中心縮放，並 clamp 到容許範圍。 */
  private scaledView(base: ViewBox, factor: number): ViewBox {
    const cx = base.x + base.w / 2;
    const cy = base.y + base.h / 2;
    const w = Math.max(BASE_VIEW.w / MAX_SCALE, Math.min(BASE_VIEW.w / MIN_SCALE, base.w / factor));
    const h = w * (BASE_VIEW.h / BASE_VIEW.w);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  private zoomBy(factor: number): void {
    this.view = this.scaledView(this.view, factor);
    this.render();
  }

  /**
   * 放大並置中到指定地點 —— 聚合標記點擊時用。
   *
   * 為何要「放大」而唔係「選中」：聚合標記代表多個地點疊喺同一位置
   * （例如 52 個「大本營內設施」共用校園質心座標）。放大係唯一可以
   * 將佢哋拆開嘅方法；選中邊一個都係任意嘅。
   */
  private zoomToLocation(locId: string): void {
    const loc = this.data.locations.features.find(
      (l) => l.properties.id === locId,
    );
    if (!loc) return;
    const raw = loc.geometry.coordinates as [number, number];
    const { lon, lat } = resolveCoord(loc.properties.name, raw[0], raw[1], {
      evidenceBacked: Boolean(loc.properties.inferred_from),
    });
    const { x, y } = lonlatToViewbox(lon, lat);
    const target = this.scaledView(this.view, 2);
    this.animateViewBox({
      x: x - target.w / 2,
      y: y - target.h / 2,
      w: target.w,
      h: target.h,
    });
  }

  /**
   * 畫面像素 → SVG user unit（兩個方向同一個比例）。
   *
   * 為何唔可以寫 `view.w / rect.width`
   * ----------------------------------
   * `<svg>` 用 `preserveAspectRatio="xMidYMid meet"`：內容等比縮放至
   * **完全放得入**，所以實際比例係 `min(rectW / view.w, rectH / view.h)`，
   * 而且短邊會留黑邊。舊寫法假設兩軸比例獨立，當元素長寬比同 viewBox
   * 長寬比唔同時（例如 1280×800 視窗 vs 1.295 嘅 viewBox），平移速度
   * 會偏離約 1.24 倍，拖曳同手指唔同步。
   */
  private pxToUserUnits(rectW: number, rectH: number): number {
    const scale = Math.min(rectW / this.view.w, rectH / this.view.h);
    return scale > 0 ? 1 / scale : 0;
  }

  /** 將 this.view 套用到 <svg>，並按 viewScale 更新標籤圖層透明度。 */
  private applyViewBox(): void {
    const { x, y, w, h } = this.view;
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    this.updateBasemapTier();
    this.updateLabelLayerOpacity();
  }

  /** 目前視窗覆蓋嘅經緯範圍。 */
  private currentGeoBbox(): {
    lon_min: number;
    lon_max: number;
    lat_min: number;
    lat_max: number;
  } {
    const fx0 = (this.view.x - BASE_VIEW.x) / BASE_VIEW.w;
    const fx1 = (this.view.x + this.view.w - BASE_VIEW.x) / BASE_VIEW.w;
    const fy0 = (this.view.y - BASE_VIEW.y) / BASE_VIEW.h;
    const fy1 = (this.view.y + this.view.h - BASE_VIEW.y) / BASE_VIEW.h;
    const lonSpan = BASEMAP_BBOX.lon_max - BASEMAP_BBOX.lon_min;
    const latSpan = BASEMAP_BBOX.lat_max - BASEMAP_BBOX.lat_min;
    return {
      lon_min: BASEMAP_BBOX.lon_min + fx0 * lonSpan,
      lon_max: BASEMAP_BBOX.lon_min + fx1 * lonSpan,
      lat_max: BASEMAP_BBOX.lat_max - fy0 * latSpan,
      lat_min: BASEMAP_BBOX.lat_max - fy1 * latSpan,
    };
  }

  /**
   * 按目前視窗揀 LOD 圖磚：**最窄但仍然完全覆蓋視窗**嘅層級。
   *
   * 為何要「完全覆蓋」而唔係「最接近」
   * --------------------------------
   * 圖磚只有 bbox 內嘅內容。如果揀咗一個唔完全覆蓋視窗嘅圖磚，視窗邊緣
   * 就會出現空白（露出底色）。所以先篩「覆蓋得住」，再喺入面揀最窄嘅
   * （最窄 = 每像素覆蓋地理範圍最小 = 最清晰）。
   *
   * 若果連最闊嘅層級都覆蓋唔到（例如視窗拉到超出香港），就退回最闊層級，
   * 超出部分自然留白。
   */
  private pickTier(): LodTier {
    if (LOD_TIERS.length === 0) {
      throw new Error("LOD manifest 冇任何層級");
    }
    const v = this.currentGeoBbox();
    const covers = LOD_TIERS.filter(
      (t) =>
        t.bbox.lon_min <= v.lon_min &&
        t.bbox.lon_max >= v.lon_max &&
        t.bbox.lat_min <= v.lat_min &&
        t.bbox.lat_max >= v.lat_max,
    );
    const pool = covers.length > 0 ? covers : LOD_TIERS;
    return pool.reduce((best, t) => (tierSpan(t) < tierSpan(best) ? t : best));
  }

  /** 切換底圖圖磚（只有層級改變時才改 DOM）。 */
  private updateBasemapTier(): void {
    const tier = this.pickTier();
    if (tier.id === this.currentTierId) return;
    this.currentTierId = tier.id;

    const rect = tierRect(tier);
    const img = this.root.querySelector<SVGImageElement>("#basemap-group");
    if (img) {
      img.setAttribute("href", assetUrl(tier.image));
      img.setAttribute("x", String(rect.x));
      img.setAttribute("y", String(rect.y));
      img.setAttribute("width", String(rect.w));
      img.setAttribute("height", String(rect.h));
    }

    // 標籤圖層只跟總覽層配套（其餘層級嘅標籤已經烙入圖磚，
    // 而且比例唔同，疊上去會變成兩套唔同大小嘅字）。
    const labelImg = this.root.querySelector<SVGImageElement>("#label-detail-image");
    const hasLabelLayer = Boolean(tier.label_layer);
    if (labelImg && hasLabelLayer) {
      labelImg.setAttribute("href", assetUrl(tier.label_layer!));
    }
    const labelGroup = this.root.querySelector("#label-detail-layer");
    if (labelGroup) {
      labelGroup.setAttribute("data-tier-label-layer", hasLabelLayer ? "1" : "0");
    }
    this.root.dispatchEvent(
      new CustomEvent("map-lod-change", {
        detail: { tier: tier.id, label: tier.label, lod: tier.lod },
      }),
    );
  }

  /**
   * Phase I label decluttering：
   * viewScale ≤ 0.8 → 完全隱藏次要街道標籤；
   * 0.8–1.2 之間線性插值；≥ 1.2 完全顯示。
   *
   * 另外：只有總覽層有獨立標籤圖層；分區／街道層嘅標籤已烙入圖磚，
   * 所以該兩層強制歸零，避免兩套唔同比例嘅字疊埋。
   */
  private updateLabelLayerOpacity(): void {
    const layer = this.root.querySelector("#label-detail-layer");
    if (!layer) return;
    const labelOpacity = this.viewScale <= 0.8 ? 0.0 : (
      Math.min(1, (this.viewScale - LABEL_FADE_IN) / (LABEL_FADE_FULL - LABEL_FADE_IN))
    );
    const tierHasLayer =
      layer.getAttribute("data-tier-label-layer") !== "0" ? 1 : 0;
    layer.setAttribute("opacity", (labelOpacity * tierHasLayer).toFixed(3));
  }

  /**
   * 平滑轉場到目標 viewBox。
   * 用 ease-in-out cubic；重複呼叫會取消上一個動畫。
   */
  private animateViewBox(target: ViewBox, durationMs: number = ANIM_DURATION_MS): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    const start: ViewBox = { ...this.view };
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      // ease-in-out cubic
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.view = {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        w: start.w + (target.w - start.w) * eased,
        h: start.h + (target.h - start.h) * eased,
      };
      this.applyViewBox();
      if (t < 1) {
        this.animFrameId = requestAnimationFrame(step);
      } else {
        this.animFrameId = null;
      }
    };
    this.animFrameId = requestAnimationFrame(step);
  }

  /**
   * 取路線頂點嘅 SVG 座標。
   *
   * 用 `resolveCoord` 而唔係直接用 route geometry 嘅座標，係為咗同
   * location marker 用同一套座標解析（marker 亦係行 resolveCoord），
   * 否則線同點會對唔上。
   */
  private routeVertex(
    locationId: string,
    fallback: [number, number],
  ): { x: number; y: number } {
    const loc = this.data.locations.features.find(
      (l) => l.properties.id === locationId,
    );
    if (!loc) return lonlatToViewbox(fallback[0], fallback[1]);
    const { lon, lat } = resolveCoord(
      loc.properties.name,
      fallback[0],
      fallback[1],
      { evidenceBacked: Boolean(loc.properties.inferred_from) },
    );
    return lonlatToViewbox(lon, lat);
  }

  /** 切換圖例語言（zh ↔ en），保留 dot／line 樣本 span。 */
  toggleLegendLanguage(): void {
    this.lang = this.lang === "zh" ? "en" : "zh";
    const dict = this.lang === "zh" ? LEGEND_ZH : LEGEND_EN;
    const legend = this.root.querySelector("#map-legend");
    if (legend) {
      legend.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        if (key && dict[key]) el.textContent = dict[key];
      });
    }
    const btn = this.root.querySelector<HTMLButtonElement>("#legend-lang-btn");
    if (btn) btn.textContent = this.lang === "zh" ? "EN" : "中文";
  }

  render(): void {
    const cur = this.app.getCurrentChapter();
    this.applyViewBox();

    const content = this.svg.querySelector("#map-content")!;

    // Active character routes（本章有出現嘅路線）
    const activeRoutes = (this.data.routesByChapter.get(cur) || []).filter(
      (r: RouteFeature) => {
        const span = r.properties.chapters_span;
        return span && cur >= span[0] && cur <= span[1];
      },
    );

    // Active locations（本章 ± 3 章，避免大 cluster）
    const locationsToShow = this.data.locations.features.filter((l) => {
      const fp = l.properties.first_appearance;
      const chs = l.properties.chapters || [fp];
      return chs.some((c: number) => Math.abs(c - cur) <= 3) || fp === cur;
    });

    // Active events（本章 ± 1 章作上下文）
    const eventsToShow: EventFeature[] = [];
    for (let d = -1; d <= 1; d++) {
      eventsToShow.push(...(this.data.eventsByChapter.get(cur + d) || []));
    }

    // 只重建標記圖層，底圖 <image> 保持不動（避免每次 render 重新載入 PNG）
    const zonesLayer = content.querySelector("#zones-layer")!;
    const routesLayer = content.querySelector("#routes-layer")!;
    const locLayer = content.querySelector("#locations-layer")!;
    const evLayer = content.querySelector("#events-layer")!;
    zonesLayer.replaceChildren();
    routesLayer.replaceChildren();
    locLayer.replaceChildren();
    evLayer.replaceChildren();

    const SVG_NS = "http://www.w3.org/2000/svg";

    // location_id → {fictional, name}；路線誠實性規則同標記對齊都用得着
    const fictionalById = new Map<string, boolean>();
    for (const l of this.data.locations.features) {
      fictionalById.set(l.properties.id, Boolean(l.properties.fictional));
    }

    // Zones（倖存區／病窩）
    //
    // 為何要獨立一層、而且喺標記之下
    // ----------------------------
    // 區域係「面」，用嚟一眼睇到「呢一帶安全／危險」。畫喺標記之下
    // 就唔會遮住地名同事件點。
    //
    // 顏色語意（同圖例一致）：
    //   survivor（倖存區／安全區）→ 青綠色，代表安全
    //   nest（病窩／巢穴／據點）  → 橙紅色，代表危險
    //
    // 實線 vs 虛線：
    //   實線 = 範圍有證據（由成員地點分佈推導，或文中明文描述）
    //   虛線 = 範圍係估算（只有一個成員點，用按類型嘅預設半徑）
    //   呢個區分好重要 —— 唔可以令估算睇落同證據一樣確定。
    const ZONE_STYLE: Record<string, { fill: string; stroke: string }> = {
      survivor: { fill: "#1abc9c", stroke: "#16a085" },
      nest: { fill: "#e74c3c", stroke: "#c0392b" },
    };
    for (const z of this.data.zones.features) {
      const zp = z.properties;
      const chs = zp.chapters || [];
      const active = chs.length === 0 || chs.some((c) => c <= cur && cur <= c + 12);
      if (!active) continue;
      const style = ZONE_STYLE[zp.kind] ?? ZONE_STYLE.nest;
      // 米 → user unit（x 軸 = 經度）
      const r = zp.radius_m / 102940;
      const { x, y } = lonlatToViewbox(
        z.geometry.coordinates[0],
        z.geometry.coordinates[1],
      );
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(x));
      circle.setAttribute("cy", String(y));
      circle.setAttribute("r", String(r));
      circle.setAttribute("class", "zone-area");
      circle.setAttribute("fill", style.fill);
      circle.setAttribute("fill-opacity", "0.12");
      circle.setAttribute("stroke", style.stroke);
      circle.setAttribute("stroke-width", String(this.markerR(0.0009)));
      circle.setAttribute("stroke-opacity", "0.7");
      if (zp.radius_source === "default") {
        // 估算範圍：虛線，令佢睇落唔同實證範圍一樣確定
        circle.setAttribute("stroke-dasharray", String(this.markerR(0.004)));
      }
      circle.setAttribute("data-zone-id", zp.id);
      circle.setAttribute("data-zone-name", zp.name);
      const title = document.createElementNS(SVG_NS, "title");
      const srcLabel =
        zp.radius_source === "members"
          ? "範圍由成員地點分佈推導"
          : zp.radius_source === "curated"
            ? "範圍由文中描述推導"
            : "範圍係估算（示意）";
      title.textContent =
        `${zp.name}（${zp.kind === "survivor" ? "倖存區／安全" : "病窩／危險"}）\n` +
        `半徑約 ${Math.round(zp.radius_m)} m — ${srcLabel}\n` +
        `${zp.evidence}`;
      circle.appendChild(title);
      zonesLayer.appendChild(circle);
    }

    // Routes
    //
    // 誠實性規則（Phase I fix）：543/714 個 location 嘅 `location_precision`
    // 係 `fictional`，即係話佢哋嘅座標係任意值（例如「醫療室」被放在屯門、
    // 「主角的安全屋大廈」被放在西環，但故事設定喺將軍澳）。如果照樣將
    // waypoint 連成直線，就等於宣稱一條唔存在嘅移動路徑 —— 實測 717 段
    // 相鄰 waypoint 之中，459 段係「虛構-虛構」（中位數 16.1 km、最長
    // 41.4 km），只有 39 段係「真實-真實」（中位數 999 m）。
    //
    // 所以只繪製「兩端都係真實 location」嘅線段；其餘留空（唔連線）。
    // 呢個做法唔會捏造位置，亦保留咗有意義嘅短距離移動。
    for (const route of activeRoutes) {
      const coords = route.geometry.coordinates as [number, number][];
      const wps = route.properties.waypoints || [];
      if (coords.length < 2) continue;

      const segments: string[] = [];
      for (let i = 0; i < coords.length - 1; i++) {
        // waypoints 同 coordinates 係 1:1（見 scripts/derive_routes_geojson.py）
        const a = wps[i]?.location_id;
        const b = wps[i + 1]?.location_id;
        if (!a || !b) continue;
        if (fictionalById.get(a) !== false) continue;
        if (fictionalById.get(b) !== false) continue;
        const p = this.routeVertex(a, coords[i]);
        const q = this.routeVertex(b, coords[i + 1]);
        // 同一個 location 連續出現兩次 → 零長度線段，畫出嚟冇意思
        if (Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6) continue;
        segments.push(`M ${p.x} ${p.y} L ${q.x} ${q.y}`);
      }
      if (segments.length === 0) continue;

      const d = segments.join(" ");
      const span = route.properties.chapters_span;
      const opacity = cur >= span[0] && cur <= span[1] ? 0.7 : 0.2;
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", d);
      el.setAttribute("class", "route-line");
      el.setAttribute("stroke", route.properties.color || "#F39C12");
      el.setAttribute("stroke-width", String(this.markerR(0.0015)));
      el.setAttribute("fill", "none");
      el.setAttribute("opacity", String(opacity));
      el.setAttribute("data-route-id", route.properties.id);
      el.setAttribute("data-character-name", route.properties.character_name);
      const titleEl = document.createElementNS(SVG_NS, "title");
      titleEl.textContent = `${route.properties.character_name} 路線 (ch${span[0]}-${span[1]})`;
      el.appendChild(titleEl);
      routesLayer.appendChild(el);
    }

    // Locations
    //
    // 標記聚合（marker aggregation）
    // ----------------------------
    // 地點推斷之後，52 個「大本營內設施」（市集、醫療室、圖書館、拘留所…）
    // 共用同一個校園質心座標 —— 因為佢哋真係同一個校園。逐個畫會完全疊埋，
    // 變成一大坨，比原本隨機散開更難睇。
    //
    // 做法：落喺同一個「畫面格」嘅標記合成一個，並顯示數量。格仔大細用
    // 固定**畫面**尺寸定義（÷ viewScale），所以放大之後自然會分開顯示。
    interface LocMarker {
      x: number;
      y: number;
      active: boolean;
      selected: boolean;
      fictional: boolean;
      id: string;
      name: string;
      first: number;
    }
    const markerBuf: LocMarker[] = [];
    for (const loc of locationsToShow) {
      const props = loc.properties;
      const raw = loc.geometry.coordinates as [number, number];
      const { lon, lat } = resolveCoord(props.name, raw[0], raw[1], {
        evidenceBacked: Boolean(props.inferred_from),
      });
      const { x, y } = lonlatToViewbox(lon, lat);
      markerBuf.push({
        x,
        y,
        active:
          props.chapters.includes(cur) ||
          (props.first_appearance <= cur && props.first_appearance + 5 > cur),
        selected: this.app.selectedLocationId === props.id,
        fictional: Boolean(props.fictional),
        id: props.id,
        name: props.name,
        first: props.first_appearance,
      });
    }

    const cell = this.markerR(0.008);
    const groups = new Map<string, LocMarker[]>();
    for (const m of markerBuf) {
      const key = `${Math.round(m.x / cell)}:${Math.round(m.y / cell)}`;
      const arr = groups.get(key);
      if (arr) arr.push(m);
      else groups.set(key, [m]);
    }

    for (const items of groups.values()) {
      const head = items[0];
      const anyActive = items.some((m) => m.active);
      const anySelected = items.some((m) => m.selected);
      const anyReal = items.some((m) => !m.fictional);
      const r = this.markerR(anyActive ? 0.005 : 0.002);
      const fill = anySelected ? "#ffeb3b" : anyReal ? "#e67e22" : "#9b59b6";

      if (items.length === 1) {
        const el = document.createElementNS(SVG_NS, "circle");
        el.setAttribute("cx", String(head.x));
        el.setAttribute("cy", String(head.y));
        el.setAttribute("r", String(r));
        el.setAttribute("class", "location-marker");
        el.setAttribute("fill", fill);
        el.setAttribute("stroke", "#fff");
        el.setAttribute("stroke-width", String(this.markerR(0.0008)));
        el.setAttribute("opacity", String(anyActive ? 0.9 : 0.45));
        el.setAttribute("data-loc-id", head.id);
        el.setAttribute("data-loc-name", head.name);
        const titleEl = document.createElementNS(SVG_NS, "title");
        // 虛構地點嘅座標係任意值（location_precision: fictional），
        // tooltip 要講清楚，唔可以當成精確位置。
        titleEl.textContent = head.fictional
          ? `${head.name}（ch${head.first}・虛構座標，僅供參考）`
          : `${head.name}（ch${head.first}）`;
        el.appendChild(titleEl);
        locLayer.appendChild(el);
        continue;
      }

      // 聚合標記：一個圓 + 數量。tooltip 列出全部名稱，資訊唔會消失。
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "location-marker-cluster");
      g.setAttribute("data-loc-count", String(items.length));
      // 保留 head 嘅 id，令現有查詢（[data-loc-id]）同點擊處理都搵得到
      g.setAttribute("data-loc-id", head.id);
      g.setAttribute("data-loc-name", head.name);
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", String(head.x));
      c.setAttribute("cy", String(head.y));
      c.setAttribute("r", String(r * 1.35));
      c.setAttribute("fill", fill);
      c.setAttribute("stroke", "#fff");
      c.setAttribute("stroke-width", String(this.markerR(0.0008)));
      c.setAttribute("opacity", String(anyActive ? 0.9 : 0.5));
      g.appendChild(c);
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(head.x));
      label.setAttribute("y", String(head.y));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "central");
      label.setAttribute("font-size", String(r * 1.5));
      label.setAttribute("fill", "#fff");
      label.setAttribute("pointer-events", "none");
      label.textContent = String(items.length);
      g.appendChild(label);
      const titleEl = document.createElementNS(SVG_NS, "title");
      titleEl.textContent = `${items.length} 個地點喺同一位置：\n${items
        .map((m) => `・${m.name}`)
        .join("\n")}`;
      g.appendChild(titleEl);
      locLayer.appendChild(g);
    }

    // Events
    for (const ev of eventsToShow) {
      const props = ev.properties;
      const raw = ev.geometry.coordinates as [number, number];
      // 事件優先跟隨所屬 location 嘅錨點
      const loc = props.location_id
        ? this.data.locations.features.find(
            (l) => l.properties.id === props.location_id,
          )
        : undefined;
      const { lon, lat } = loc
        ? resolveCoord(loc.properties.name, raw[0], raw[1], {
            evidenceBacked: Boolean(loc.properties.inferred_from),
          })
        : resolveCoord(props.title, raw[0], raw[1]);
      const { x, y } = lonlatToViewbox(lon, lat);
      const isCurrent = props.chapter === cur;
      const isSelected = this.app.selectedEventId === props.id;
      const r = this.markerR(isCurrent ? 0.008 : 0.005);
      const fill = isSelected ? "#ff5252" : isCurrent ? "#e74c3c" : "#f39c12";
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", String(x));
      el.setAttribute("cy", String(y));
      el.setAttribute("r", String(r));
      el.setAttribute("class", "event-marker");
      el.setAttribute("fill", fill);
      el.setAttribute("stroke", "#fff");
      el.setAttribute("stroke-width", String(this.markerR(0.001)));
      el.setAttribute("opacity", String(isCurrent ? 1.0 : 0.6));
      el.setAttribute("data-event-id", props.id);
      el.setAttribute("data-event-title", props.title);
      const titleEl = document.createElementNS(SVG_NS, "title");
      titleEl.textContent = `[ch${props.chapter}] ${props.title}`;
      el.appendChild(titleEl);
      evLayer.appendChild(el);
    }
  }

  /**
   * Phase H/I：飛到指定章節。
   *
   * 計算本章 ± 2 章所有 location 嘅 bounding box，加 25% padding，
   * 再用 animateViewBox 平滑轉場。冇 location 就重繪現狀。
   */
  flyToChapter(_ch: number): void {
    const cur = _ch;
    const contextChs = new Set<number>();
    for (let d = -2; d <= 2; d++) contextChs.add(cur + d);

    let lonMin = Infinity;
    let lonMax = -Infinity;
    let latMin = Infinity;
    let latMax = -Infinity;
    let has = false;

    for (const loc of this.data.locations.features) {
      const fp = loc.properties.first_appearance;
      const chs = loc.properties.chapters || [fp];
      if (!chs.some((c: number) => contextChs.has(c))) continue;
      const [rawLon, rawLat] = loc.geometry.coordinates as [number, number];
      const { lon, lat } = resolveCoord(loc.properties.name, rawLon, rawLat, {
        evidenceBacked: Boolean(loc.properties.inferred_from),
      });
      if (lon < BASEMAP_BBOX.lon_min || lon > BASEMAP_BBOX.lon_max) continue;
      if (lat < BASEMAP_BBOX.lat_min || lat > BASEMAP_BBOX.lat_max) continue;
      lonMin = Math.min(lonMin, lon);
      lonMax = Math.max(lonMax, lon);
      latMin = Math.min(latMin, lat);
      latMax = Math.max(latMax, lat);
      has = true;
    }

    if (!has) {
      this.render();
      return;
    }

    // 25% padding 留白
    const lonPad = (lonMax - lonMin) * 0.25;
    const latPad = (latMax - latMin) * 0.25;
    lonMin = Math.max(BASEMAP_BBOX.lon_min, lonMin - lonPad);
    lonMax = Math.min(BASEMAP_BBOX.lon_max, lonMax + lonPad);
    latMin = Math.max(BASEMAP_BBOX.lat_min, latMin - latPad);
    latMax = Math.min(BASEMAP_BBOX.lat_max, latMax + latPad);

    // 避免單點章節造成 0 尺寸 viewBox
    const minSpan = 0.02;
    if (lonMax - lonMin < minSpan) {
      const c = (lonMin + lonMax) / 2;
      lonMin = c - minSpan / 2;
      lonMax = c + minSpan / 2;
    }
    if (latMax - latMin < minSpan) {
      const c = (latMin + latMax) / 2;
      latMin = c - minSpan / 2;
      latMax = c + minSpan / 2;
    }

    const fx0 =
      (lonMin - BASEMAP_BBOX.lon_min) / (BASEMAP_BBOX.lon_max - BASEMAP_BBOX.lon_min);
    const fx1 =
      (lonMax - BASEMAP_BBOX.lon_min) / (BASEMAP_BBOX.lon_max - BASEMAP_BBOX.lon_min);
    // y 軸反轉（SVG y 向下、緯度向北遞增）
    const fy0 =
      (BASEMAP_BBOX.lat_max - latMax) / (BASEMAP_BBOX.lat_max - BASEMAP_BBOX.lat_min);
    const fy1 =
      (BASEMAP_BBOX.lat_max - latMin) / (BASEMAP_BBOX.lat_max - BASEMAP_BBOX.lat_min);

    const target: ViewBox = {
      x: BASE_VIEW.x + Math.min(fx0, fx1) * BASE_VIEW.w,
      y: BASE_VIEW.y + Math.min(fy0, fy1) * BASE_VIEW.h,
      w: Math.abs(fx1 - fx0) * BASE_VIEW.w,
      h: Math.abs(fy1 - fy0) * BASE_VIEW.h,
    };
    // 標記同路線唔跟 viewBox 縮放，所以要即刻重繪（章節已變）。
    this.render();
    this.animateViewBox(target);
  }
}

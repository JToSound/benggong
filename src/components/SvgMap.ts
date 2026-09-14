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
 * - `resolveCoord()` 三層座標 fallback（FALLBACK_ANCHORS → FULL_HK_ANCHORS → 原始座標）
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

/** 預設視圖：覆蓋全港。亦係所有座標換算嘅基準。 */
const BASE_VIEW = { x: 113.85, y: 22.18, w: 0.6, h: 0.37 };
const VIEWBOX = `${BASE_VIEW.x} ${BASE_VIEW.y} ${BASE_VIEW.w} ${BASE_VIEW.h}`;

/** 縮放上下限（相對基準視圖）。 */
const MIN_SCALE = 0.5;
const MAX_SCALE = 12;

/** 標籤圖層淡入區間：viewScale ≤ 0.8 完全隱藏，≥ 1.2 完全顯示。 */
const LABEL_FADE_IN = 0.8;
const LABEL_FADE_FULL = 1.2;

const ANIM_DURATION_MS = 500;

// Basemap PNG 同 bbox metadata（由 render script 生成）。
const BASEMAP_PNG = basemapPngUrl;
const LABEL_DETAIL_PNG = labelDetailPngUrl;
const BASEMAP_BBOX = (
  basemapCoords as {
    bbox: { lon_min: number; lon_max: number; lat_min: number; lat_max: number };
  }
).bbox;

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
 * 三層座標解析。
 *
 * 1. `FALLBACK_ANCHORS` — 人手核對過嘅虛構地點錨點（最高優先）
 * 2. `FULL_HK_ANCHORS` — Phase I 由 OSM 抽出嘅 503 個真實香港 landmark
 * 3. 原始 lon/lat — 資料集自帶座標
 */
export function resolveCoord(
  name: string,
  lon: number,
  lat: number,
): { lon: number; lat: number; source: CoordSource } {
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
};

const LEGEND_EN: Record<string, string> = {
  "legend.title": "Map legend",
  "legend.event-current": "Current-chapter event",
  "legend.event-other": "Other-chapter event",
  "legend.loc-real": "Real location",
  "legend.loc-fictional": "Fictional location",
  "legend.selected": "Selected",
  "legend.route": "Character route",
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
                   preserveAspectRatio="xMidYMid slice" />
            <g id="label-detail-layer" class="label-detail-layer" pointer-events="none" opacity="0">
              <image class="label-detail-image" href="${LABEL_DETAIL_PNG}"
                     x="${BASE_VIEW.x}" y="${BASE_VIEW.y}" width="${BASE_VIEW.w}" height="${BASE_VIEW.h}"
                     preserveAspectRatio="xMidYMid slice" />
            </g>
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
      // 畫面像素 → SVG user unit（viewBox 每 px 幾多 user unit）
      const ux = this.view.w / rect.width;
      const uy = this.view.h / rect.height;
      this.view = {
        ...this.panStartView,
        x: this.panStartView.x - (e.clientX - this.panStartX) * ux,
        y: this.panStartView.y - (e.clientY - this.panStartY) * uy,
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
        const ux = this.view.w / rect.width;
        const uy = this.view.h / rect.height;
        this.view = {
          ...this.panStartView,
          x: this.panStartView.x - (e.touches[0].clientX - this.panStartX) * ux,
          y: this.panStartView.y - (e.touches[0].clientY - this.panStartY) * uy,
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

  /** 將 this.view 套用到 <svg>，並按 viewScale 更新標籤圖層透明度。 */
  private applyViewBox(): void {
    const { x, y, w, h } = this.view;
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    this.updateLabelLayerOpacity();
  }

  /**
   * Phase I label decluttering：
   * viewScale ≤ 0.8 → 完全隱藏次要街道標籤；
   * 0.8–1.2 之間線性插值；≥ 1.2 完全顯示。
   */
  private updateLabelLayerOpacity(): void {
    const layer = this.root.querySelector("#label-detail-layer");
    if (!layer) return;
    const labelOpacity = this.viewScale <= 0.8 ? 0.0 : (
      Math.min(1, (this.viewScale - LABEL_FADE_IN) / (LABEL_FADE_FULL - LABEL_FADE_IN))
    );
    layer.setAttribute("opacity", labelOpacity.toFixed(3));
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
    const routesLayer = content.querySelector("#routes-layer")!;
    const locLayer = content.querySelector("#locations-layer")!;
    const evLayer = content.querySelector("#events-layer")!;
    routesLayer.replaceChildren();
    locLayer.replaceChildren();
    evLayer.replaceChildren();

    const SVG_NS = "http://www.w3.org/2000/svg";

    // location_id → {fictional, name}；路線誠實性規則同標記對齊都用得着
    const fictionalById = new Map<string, boolean>();
    for (const l of this.data.locations.features) {
      fictionalById.set(l.properties.id, Boolean(l.properties.fictional));
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
      el.setAttribute("stroke-width", "0.0015");
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
    for (const loc of locationsToShow) {
      const props = loc.properties;
      const raw = loc.geometry.coordinates as [number, number];
      const { lon, lat } = resolveCoord(props.name, raw[0], raw[1]);
      const { x, y } = lonlatToViewbox(lon, lat);
      const active =
        props.chapters.includes(cur) ||
        (props.first_appearance <= cur && cur < props.first_appearance + 5);
      const isSelected = this.app.selectedLocationId === props.id;
      const r = active ? 0.005 : 0.002;
      const fill = isSelected ? "#ffeb3b" : props.fictional ? "#9b59b6" : "#e67e22";
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", String(x));
      el.setAttribute("cy", String(y));
      el.setAttribute("r", String(r));
      el.setAttribute("class", "location-marker");
      el.setAttribute("fill", fill);
      el.setAttribute("stroke", "#fff");
      el.setAttribute("stroke-width", "0.0008");
      el.setAttribute("opacity", String(active ? 0.9 : 0.45));
      el.setAttribute("data-loc-id", props.id);
      el.setAttribute("data-loc-name", props.name);
      const titleEl = document.createElementNS(SVG_NS, "title");
      // 虛構地點嘅座標係任意值（location_precision: fictional），
      // tooltip 要講清楚，唔可以當成精確位置。
      titleEl.textContent = props.fictional
        ? `${props.name}（ch${props.first_appearance}・虛構座標，僅供參考）`
        : `${props.name}（ch${props.first_appearance}）`;
      el.appendChild(titleEl);
      locLayer.appendChild(el);
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
        ? resolveCoord(
            loc.properties.name,
            raw[0],
            raw[1],
          )
        : resolveCoord(props.title, raw[0], raw[1]);
      const { x, y } = lonlatToViewbox(lon, lat);
      const isCurrent = props.chapter === cur;
      const isSelected = this.app.selectedEventId === props.id;
      const r = isCurrent ? 0.008 : 0.005;
      const fill = isSelected ? "#ff5252" : isCurrent ? "#e74c3c" : "#f39c12";
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", String(x));
      el.setAttribute("cy", String(y));
      el.setAttribute("r", String(r));
      el.setAttribute("class", "event-marker");
      el.setAttribute("fill", fill);
      el.setAttribute("stroke", "#fff");
      el.setAttribute("stroke-width", "0.001");
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
      const { lon, lat } = resolveCoord(loc.properties.name, rawLon, rawLat);
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

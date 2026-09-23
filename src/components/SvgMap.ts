/**
 * SvgMap — 《病港》互動故事地圖。
 *
 * 底圖：香港全境 **向量** basemap（`VectorBasemap`，Canvas 2D）＋ SVG 故事圖層。
 *
 * V2（B5）改動摘要
 * ================
 * A4 實測推翻咗「最大 zoom 起格」嘅原假設：raster 路徑 **0 次參與**。
 * 真正問題係「內容密度隨 zoom 反向下降」，三個成因：
 *   · G1 章節窗口過濾（location ±3 章、event ±1 章、zone `c ≤ cur ≤ c+12`）
 *     → 深 zoom 幾乎清空（將軍澳 176 個 event → 畫 0 個）；
 *   · G2 tile POI 已下載但 0 渲染（街道級地標唯一來源）；
 *   · G3 建築描繪對比過低。
 * 本檔處理 G1（zone 永遠 render + Zone LOD；location ±5、event ±1 + 開關）
 * 同 raster 死重（移除靜態 import，規則 A1）。
 *
 * 互動：
 * - Hover marker → tooltip（<title>）
 * - Click marker → 選中，開詳情面板
 * - 拖曳平移、滾輪／按鈕縮放（手勢已搬入 `MapViewport`，有 rAF coalesce）
 *
 * Phase I 保留：
 * - `resolveCoord()` 四層座標解析（有證據支持嘅資料集座標 → FALLBACK_ANCHORS → FULL_HK_ANCHORS → 原始座標）
 * - `animateViewBox()` 用 requestAnimationFrame + ease-in-out cubic 做平滑轉場
 * - `#label-detail-layer`：raster 後備專用嘅標籤圖層（預設冇 href）
 * - 雙語圖例（zh / en），`data-i18n` 標記 + `#legend-lang-btn` 切換
 */

import type { App } from "../app";
import type { AppData, RouteFeature, EventFeature } from "../data/loadAllData";
import { FULL_HK_ANCHORS } from "../data/fallbackAnchors";
import { VectorBasemap } from "../map/VectorBasemap";
import { MapShell } from "../map/MapShell";
import {
  PROJ_COS,
  clampView as clampViewBox,
  geoBoundsOfView,
  projectLonLat,
  scaleView,
  viewBoxForGeoBounds,
  type GeoBbox,
} from "../map/map-camera";
import {
  chapterWindowFor,
  MAX_SCALE,
  selectZoneLod,
  type ZoneLod,
} from "../map/map-lod";
import {
  CLUSTER_BADGE_DIAMETER_PX,
  clusterBadgeRadiusUser,
  clusterLabel,
  clusterZones,
  type ZoneClusterEntry,
  type ZoneModelEntry,
} from "../map/ZoneLayer";
import {
  dispatchHit,
  hiddenSelectors,
  LAYER_KEYS,
  LAYER_LABEL_EN,
  LAYER_LABEL_ZH,
  resolveHit,
} from "../map/map-interactions";
import { MapControls } from "../map/MapControls";
import {
  MAP_INTERACTIVE_SELECTOR,
  isNavigationAction,
  resolveMapKey,
  rovingIndex,
} from "../map/map-keyboard";
import type { LayerFlags } from "../types/state";
import { prefersReducedMotion } from "../motion";
import basemapCoords from "../../public/assets/hk-basemap-coords.json";
import mapCss from "../styles/map.css?inline";

/*
 * 標準緯線校正（φ₀ = 22.36°）由 `src/map/map-camera.ts` 提供**唯一一份**。
 *
 * A4 明確指出「同一組常數喺 3 個地方各自定義」係 1.622 倍垂直拉伸 bug
 * 嘅溫床。V2 之後 `SvgMap` / `VectorBasemap` / `map-camera` 共用同一個
 * export；本檔只喺 `BASE_VIEW` 用一次（`h` 嘅 1/cos 校正）。
 */

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

/**
 * Raster 後備層（emergency only）。
 *
 * 規則 A3（spec §4.3）：`fallbackToRaster()` **保留**但只作 emergency，
 * **唔設預設 `href`**。所以呢度只係一組**runtime 路徑字串** ——
 * 冇 `import ... ?url`，即係 Vite 唔會將 PNG 打包／複製多一份。
 * 只有向量底圖真係載入唔到時才會請求。
 *
 * ⚠️ 13 層 raster pyramid（`assets/map-lod/`，28 MB）已經確認 0 次參與
 * （A4），所以呢度只有「總覽」一層，唔再有 pyramid。
 */
const RASTER_FALLBACK = {
  image: "assets/hk-basemap.png",
  labelLayer: "assets/hk-basemap-labels.png",
};

interface RasterTier {
  id: string;
  label: string;
  lod: string;
  image: string;
  label_layer?: string;
  bbox: GeoBbox;
}

/** 總覽層（唯一一層 raster 後備）。 */
function rasterTier(): RasterTier {
  return {
    id: "overview",
    label: "全港總覽（後備）",
    lod: "overview",
    image: RASTER_FALLBACK.image,
    label_layer: RASTER_FALLBACK.labelLayer,
    bbox: { ...BASEMAP_BBOX },
  };
}

/** 一層嘅經度跨度（度）—— 揀層時「越窄越清晰」。 */
function tierSpanOf(t: RasterTier): number {
  return t.bbox.lon_max - t.bbox.lon_min;
}

/**
 * 將一串頂點畫成平滑曲線（Catmull-Rom → 三次 Bézier）。
 *
 * 為何用 Catmull-Rom 而唔係普通 B-spline
 * --------------------------------------
 * Catmull-Rom 嘅曲線**穿過每一個輸入點** —— 對「角色去過呢啲地方」
 * 嚟講係必要嘅（B-spline 會偏離控制點，令路線唔再經過實際地點）。
 *
 * 轉換公式：對 P1→P2 段，
 *   C1 = P1 + (P2 − P0) / 6
 *   C2 = P2 − (P3 − P1) / 6
 *   → `C C1 C2 P2`
 *
 * ⚠️ 兩點嘅話冇足夠資訊做平滑（只有直線），所以直接畫 `L`。
 *    實測好多路線只有兩三個有效頂點，唔可以當成 bug。
 */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) {
    return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    // 端點重複（令頭尾段都有「鄰居」可用）
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? pts[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
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
 * ⚠️ V2：MAX_SCALE 由 35 → **280**（spec §3.1），權威值住喺 `map-lod.ts`
 * ---------------------------------------------------------------------
 * 舊值 35 → 最深只到 Z5.13（`Z = log2(0.70 / viewW)`，最窄視窗
 * 0.0200°）；之後短暫用 64 → Z6.0，spec 嘅 **Z7／Z8 仍然物理上
 * 不可達**（B9 Q1 量到 Z8 target 嘅 viewW 同 Z6 完全一樣）。
 * 現時由 `map-lod.MAX_SCALE`（280 → 最窄視窗 0.0025° = Z8.13）統一
 * 提供，本檔**唔再寫死**，避免出現第二組會漂移嘅門檻。
 *
 * ⚠️ 呢個 import 係**必須**，唔係可有可無
 * ----------------------------------------
 * `MapShell` 會用政策值做**下限**（`Math.max(傳入, MAX_SCALE)`），
 * 但 `zoomToLocation`（經 `scaledView()`）同 `flyToChapter`
 * （`viewBoxForGeoBounds(..., maxScale)`）**唔經** `MapShell` ——
 * 呢兩條路徑冇下限保護，寫死細值就會令佢哋最深只到 Z6。
 *
 * ⚠️ MIN_SCALE 一定要係 1.0（唔可以縮到細過底圖）
 * ------------------------------------------------
 * 底圖（overview 層）只覆蓋 BASEMAP_BBOX（0.70°）。如果容許縮到
 * 1.40°（MIN_SCALE = 0.5），視窗就會大過底圖 —— 底圖變成畫面中央
 * 一小塊，周圍全部係黑色底色。1.0 = 睇晒全香港。
 */
const MIN_SCALE = 1.0;

/** 標籤圖層淡入區間：viewScale ≤ 0.8 完全隱藏，≥ 1.2 完全顯示。 */
const LABEL_FADE_IN = 0.8;
const LABEL_FADE_FULL = 1.2;

const ANIM_DURATION_MS = 500;

/**
 * 手勢結束之後幾耐恢復 `.zone-pulse` 動畫（見 `SvgMap.pulsesSuspended`）。
 * 220 ms 係「最後一次 onChange 之後」，唔係「手勢開始之後」——
 * 連續點縮放時計時器會不斷重置，所以動畫唔會喺互動中途偷偷開返。
 */
const PULSE_IDLE_RESUME_MS = 220;

/*
 * 底圖 PNG 路徑（由 render script 生成；bbox 同投影常數見上方）。
 *
 * ⚠️ V2（規則 A1/A3）：唔再 `import ... ?url`。
 * raster 只做 emergency 後備（見 `fallbackToRaster()`），預設唔設
 * `href`。冇靜態 import = Vite 唔會將 2 MB PNG 打包／複製多一份，
 * 亦唔會喺首屏請求佢。路徑字串集中喺 `RASTER_FALLBACK`。
 */

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
 * 呢個地點嘅座標有冇**可稽核嘅證據來源**。
 *
 * 為何唔止睇 `inferred_from`
 * -------------------------
 * 座標嘅來源有兩種記錄方式：
 *   1. `inferred_from` —— `scripts/infer_places.py` 嘅推斷 id
 *   2. `position_source` —— 人手修正、依附父項、同章錨定等
 *
 * ⚠️ 實測踩過：`scripts/anchor_fictional_locations.py` 把虛構地點錨定到
 * 父項並升級為 `approximate` 之後，佢哋**冇** `inferred_from` ——
 * 結果 `evidenceBacked` 變 false，硬編碼錨點再次覆蓋已核實座標。
 * 路線最長線段由 4,457 m 暴增到 7,729 m。
 *
 * 只要有任何一種來源記錄，就唔應該被硬編碼猜測覆蓋。
 */
function hasEvidence(p: { inferred_from?: string; position_source?: string }): boolean {
  return Boolean(p.inferred_from || p.position_source);
}

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

/**
 * lon/lat → SVG user unit。超出 bbox 會 clamp 到邊緣。
 *
 * ⚠️ V2：投影公式只有一份（`map-camera.projectLonLat`）。
 * A4 指出「同一組常數喺 3 個地方各自定義」係 1.622 倍垂直拉伸 bug
 * 嘅溫床，所以呢度只係一層薄 wrapper（保留原本嘅呼叫點同名字）。
 */
function lonlatToViewbox(lon: number, lat: number): { x: number; y: number } {
  return projectLonLat(BASEMAP_BBOX, BASE_VIEW, lon, lat);
}

/**
 * 區域徽記圖騰（1×1 單位框內嘅 path）。
 *
 * 為何要圖騰而唔止顏色
 * --------------------
 * 顏色係最弱嘅編碼 —— 色弱用戶分唔到紅綠，而且三種區域（倖存區／病窩／
 * 據點）如果只靠顏色，喺細地圖上完全分唔清。加圖騰之後**形狀**都可以
 * 分辨，同時令地圖有「軍事 HUD」嘅識別感。
 */
const ZONE_GLYPH: Record<string, string> = {
  // 盾：防守、安全
  shield: "M0.5 0.07 L0.9 0.23 L0.9 0.55 Q0.9 0.85 0.5 0.95 Q0.1 0.85 0.1 0.55 L0.1 0.23 Z",
  // 警告三角：危險、疫區
  biohazard: "M0.5 0.08 L0.95 0.9 L0.05 0.9 Z M0.5 0.42 L0.5 0.68 M0.5 0.78 L0.5 0.8",
  // 旗：佔領、據點
  flag: "M0.24 0.06 L0.24 0.95 M0.24 0.1 L0.82 0.2 L0.64 0.35 L0.82 0.5 L0.24 0.58",
};

/**
 * Zone 視覺樣式表（v1 嘅 3 個 style key）。
 *
 * 為何仍然只有 3 個 key（而唔係 spec §4 嘅 5 個 zone type）
 * ------------------------------------------------------
 * spec 嘅 5 個 `zone_type` 係**資料語義**，呢度係**視覺編碼**。
 * 5 → 3 嘅映射係「危險程度」而唔係「類別」：
 *
 *   survivor_zone → survivor（安全，綠）
 *   infected_nest → nest（危險，紅）
 *   quarantine    → nest（同樣係「唔好入」，用同一視覺）
 *   contested     → outpost（爭奪中，紫）
 *   transit       → outpost（通道／中轉）
 *   unknown       → nest（保守：當危險，唔好誤導用戶以為安全）
 *
 * ⚠️ 唔可以加第 4 個色 —— 色值係 B1 token（`--zone-*`）。要 5 個獨立
 * 視覺就要 B1 加 token，屬跨單元改動。
 */
const ZONE_STYLE: Record<
  string,
  { fill: string; stroke: string; glow: string; glyph: string; label: string }
> = {
  survivor: {
    fill: "#2fd6a8",
    stroke: "#5cf0c4",
    glow: "rgba(47, 214, 168, 0.55)",
    glyph: "shield",
    label: "倖存區",
  },
  nest: {
    fill: "#ff5a4d",
    stroke: "#ff8a72",
    glow: "rgba(255, 90, 77, 0.55)",
    glyph: "biohazard",
    label: "病窩",
  },
  outpost: {
    fill: "#a06bd8",
    stroke: "#c69bf0",
    glow: "rgba(160, 107, 216, 0.5)",
    glyph: "flag",
    label: "據點",
  },
};

/**
 * `zone_type`（v2）→ 視覺樣式 key（v1 `kind`）。
 *
 * B4 契約規則 Z2：前端**只讀 `zone_type`**，`kind` 只係向後兼容。
 * 缺失時才 fallback 去 `kind` —— 令未經 B4 migration 嘅 v1 資料
 * 仍然讀得到。
 */
const ZONE_TYPE_STYLE: Record<string, string> = {
  survivor_zone: "survivor",
  infected_nest: "nest",
  quarantine: "nest",
  contested: "outpost",
  transit: "outpost",
  unknown: "nest",
  // v1 fallback（`kind` 嘅值）
  survivor: "survivor",
  nest: "nest",
  outpost: "outpost",
};

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
  "legend.zone-outpost": "據點（爭奪中）",
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
  "legend.zone-survivor": "Survivor zone (safe)",
  "legend.zone-nest": "Infected nest (danger)",
  "legend.zone-outpost": "Outpost (contested)",
  "legend.zone-estimated": "Dashed = estimated extent",
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
  /** 地圖容器（canvas 同 SVG 嘅共同父層）。 */
  private wrap!: HTMLElement;
  /** 向量底圖（Canvas 2D）。 */
  private basemap: VectorBasemap | null = null;
  /** 容器尺寸監察（用嚟喺 panel 開合／視窗縮放時重畫底圖）。 */
  private resizeObserver: ResizeObserver | null = null;

  /**
   * roving tabindex 記住嘅目標（`kbKeyOf()` 砌出嘅字串）。
   *
   * ⚠️ 為何要記住：`render()` 會 `replaceChildren()` 重建圖層 → 焦點會
   * 消失。記住 key 之後，下一個 render 可以將 `tabindex="0"` 放返喺
   * 「同一個」元素（例如同一個 zone）而唔係永遠跳返第一個。
   */
  private kbFocusKey = "";

  /**
   * 地圖元素應唔應該持有焦點。
   *
   * ⚠️ 為何需要（P1-2 回歸根因，2026-09-24 實測）
   * ------------------------------------------
   * `render()` 會 `replaceChildren()` **重建**圖層 → 啱啱聚焦嘅
   * `.zone` / marker 元素會被銷毀 → 焦點跌返 `BODY`。後果：地圖自己嘅
   * 快捷鍵（`0` 重置、`+` / `-` 縮放、方向鍵平移，全部綁喺 `#svg-map`
   * 並要求焦點喺 SVG 之內）**靜默失效**。
   *
   * 呢個就係之前「加 tabindex 令 e2e fail、根因未明」嘅真正原因。
   * 修法：記住「地圖應該有焦點」，喺 `render()` 尾部（`applyRovingTabindex()`）
   * 用**同一個 key** 還原焦點；焦點離開地圖（`focusout` 去咗 SVG 以外）
   * 就清除，唔會搶走焦點。
   */
  private kbWantFocus = false;

  /**
   * `render()` 進行中嘅守衛。
   *
   * ⚠️ 為何需要：`render()` 嘅 `replaceChildren()` 會**銷毀**當時聚焦嘅
   * 地圖元素，瀏覽器隨即 fire 一個 `focusout`，而 `relatedTarget` 係
   * `null`（唔係「去咗另一個元素」）。如果 `focusout` 喺呢個時候清除
   * `kbWantFocus`，`applyRovingTabindex()` 就唔會還原焦點 —— 呢個就係
   * 「明明加咗還原邏輯但焦點仍然變 BODY」嘅原因（實測）。
   */
  private rendering = false;

  /**
   * `svgWidthPx()` 嘅快取（CSS px）。
   *
   * ⚠️ 為何一定要快取：`getBoundingClientRect()` 會**強制同步 layout**。
   * `render()` 嘅 cluster 迴圈每個 cluster 都叫一次 `svgWidthPx()`，
   * 而 `render()` 又喺**每次按鈕縮放**都行一次 —— 即係一次冷 zoom
   * （20 下）會做幾十次強制 layout。CDP CPU profile 實測
   * `getBoundingClientRect` 佔 **59 ms**，就係呢度。
   *
   * 快取失效點：容器尺寸改變（`ResizeObserver`）。`viewBox` 改變**唔會**
   * 改 CSS 尺寸，所以縮放唔需要失效。
   * 0 唔會入快取（headless 早期未 layout，之後要再試）。
   */
  private svgWidthCache = 0;
  /** 向量底圖是否已失敗（失敗 = 退回 raster）。 */
  private basemapFailed = false;

  /**
   * 目前 viewBox —— pan／zoom／flyTo 全部改呢個，render() 只負責套用。
   *
   * ⚠️ V2：真正嘅擁有者係 `MapShell.viewport`（`MapViewport`，有 rAF
   * coalesce）。`this.view` 只係**鏡像**，由 `shell` 嘅 `onChange` 更新 ——
   * 咁樣手勢、按鈕、flyTo 三條路徑就唔會各自持有一份唔同步嘅狀態。
   */
  private view: ViewBox = { ...BASE_VIEW };
  /** 目前圖例語言。 */
  private lang: "zh" | "en" = "zh";
  /** 進行中嘅轉場 frame id（用嚟取消舊動畫）。 */
  private animFrameId: number | null = null;
  /** 目前生效嘅 LOD 圖磚 id（避免重複設定同一張圖）。 */
  private currentTierId: string = "";
  /** 容器 + layer 註冊介面（spec §2.2）。B6 嘅 layer 由呢度插入。 */
  private shell!: MapShell;
  /**
   * 「顯示全部事件」開關（spec §3.3）。
   *
   * 預設關：event 只畫本章 ± 1 章（避免 176 個標記疊成一大坨）。
   * 開咗 = 唔過濾章節，畀用戶自己睇全部。
   */
  private showAllEvents = false;

  /**
   * 手勢期間暫停病窩掃描光環（`.zone-pulse`）。
   *
   * 為何要暫停
   * ----------
   * `.zone-pulse` 嘅 CSS keyframes 同時動 `opacity` 同 `transform: scale()`
   * （`transform-box: fill-box`），即係**每一幀都要重新光柵化一條帶描邊嘅
   * 多邊形**。2026-09-21 實測（headless Chromium、1440×900、level 2）：
   *
   * | 情境 | pan FPS | 暖 zoom FPS |
   * |---|---|---|
   * | 原狀（21 條 pulse 動畫中） | **10.0** | **10.2** |
   * | 只將 `.zone-pulse` 設 `display:none` | **59.5** | **51.3** |
   * | 連 `#zones-layer` 都隱藏 | 60.8 | 53.3 |
   *
   * 即係話成本幾乎全部嚟自「21 條動畫同時重繪」，而唔係 DOM 數量或者
   * `render()`。手勢期間用戶根本睇唔到光環（畫面喺高速移動），所以暫停
   * 完全唔影響觀感，但換嚟 5 倍 pan FPS。
   *
   * 恢復時機：最後一次 `onChange` 之後 `PULSE_IDLE_RESUME_MS`。
   * 為何唔用 `onSettle`：按鈕縮放（`zoomBy`）唔會產生 settle 事件，
   * 用 timer 兩條路徑都覆蓋得到。
   */
  private pulsesSuspended = false;
  /** 恢復計時器 id。 */
  private pulseResumeTimer: number | null = null;

  /** 地圖控制項（B6 由 `SvgMap` 抽出嘅元件）。 */
  private controls: MapControls | null = null;

  /**
   * Layer toggle 目前狀態嘅**鏡像**（規則 S1：唯一真相係 store）。
   *
   * 為何要快取而唔係每次都 `app.store.getState().layers`
   * ---------------------------------------------------
   * `applyLayerState()` 喺每個 `render()` 尾都會被呼叫，而 `render()`
   * 喺動畫結束時亦會跑 —— 每次 `getState()` 都要行一次 selector 鏈。
   * 快取住再加一個 `hidden` 短路（見 `applyLayerState`）令平移動畫
   * 唔會產生任何 DOM 寫入。
   */
  private layerState: LayerFlags = {
    zones: true,
    nests: true,
    outposts: true,
    events: true,
    routes: false,
    periods: false,
    detail: true,
  };
  /** 上次真正寫入用嘅 layer 簽名（`NaN` 語義：未寫過）。 */
  private lastLayerSig = "";

  /**
   * SVG `<defs>` 入面嘅 glyph symbol id（`#zone-glyph-shield` 等）。
   *
   * 由 `SvgMap` 建立，圖例（`.legend-glyph use`）同 zone badge 共用
   * —— 令「同一個圖騰」只有一個 path 定義，唔會兩處漂移。
   */
  /**
   * 注入 B6 元件 CSS（`src/styles/map.css`，`?inline` 變成字串）。
   *
   * 為何要呢個機制而唔係 `import "./styles/map.css"` 或喺 `main.ts` import
   * -------------------------------------------------------------------
   * `main.ts` 嘅載入次序係 index.css → main.css → hud.css，而
   * `main.css:458` 有 `.zone-area { pointer-events: none; }`（特異度
   * (0,1,0)），佢就係「zone 唔可點」嘅直接原因。`main.ts` 同
   * `src/styles/index.css` **兩者都唔喺 B6 可寫範圍**。
   *
   * 注入嘅 `<style>` append 到 `<head>` **最後**，所以：
   *   · 同等特異度下一定勝過舊 CSS（後載入者勝）；
   *   · Gate 2 刪走舊 CSS 之後，`SvgMap` 仍然帶住自己嘅 CSS；
   *   · 係 Vite 內建 `?inline` query —— **零新 runtime 依賴**。
   *
   * 詳見 `docs/contracts/b6-interface-contract.md` §10。
   */
  private injectMapCss(): void {
    if (document.getElementById("map-v2-css")) return;
    const style = document.createElement("style");
    style.id = "map-v2-css";
    style.textContent = mapCss;
    document.head.appendChild(style);
  }

  constructor(root: HTMLElement, app: App) {
    this.root = root;
    this.app = app;
    this.data = app.data;
    this.init();
  }

  /**
   * 需要隨縮放調整嘅 SVG 元素快取（render 時填，動畫每幀更新）。
   * 見 `setScaled`。
   */
  private scaledEls: Array<{ el: Element; attr: string; base: number }> = [];

  /**
   * 上次 `applyLiveScale()` 真正寫入用嘅（已 clamp）縮放倍率。
   * `NaN` = 未套用過。見 `applyLiveScale`。
   */
  private lastLiveScale = Number.NaN;

  /**
   * 上次 `updateLabelLayerOpacity()` 真正寫入嘅 opacity 值。
   * `NaN` = 未套用過。平移期間 `viewScale` 不變 → 跳過寫入。
   */
  private lastLabelOpacity = Number.NaN;

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

  /**
   * SVG 元素嘅 CSS 像素闊（`getBoundingClientRect().width`）。
   *
   * 為何 cluster badge 需要真 px 而唔係用 viewScale
   * --------------------------------------------
   * `markerR()` 嘅 `viewScale = BASE_VIEW.w / view.w` 只反映**縮放**，
   * 完全冇容器闊度嘅資訊。spec §3.2 L-Z0 要求 badge 渲染直徑係
   * **8–12 px**（絕對螢幕值），所以一定要知道「1 user unit 等於幾多 px」
   * —— 即 `rect.width / view.w`。
   *
   * 讀唔到（headless 早期／容器未 layout）時回 0，呼叫者要跳過繪製
   * 而唔係畫一個錯尺寸嘅 badge。
   */
  private svgWidthPx(): number {
    if (this.svgWidthCache > 0) return this.svgWidthCache;
    const r = this.svg.getBoundingClientRect();
    if (r.width > 0) this.svgWidthCache = r.width;
    return r.width > 0 ? r.width : 0;
  }

  /**
   * 螢幕 px → 當前視圖嘅 user unit。
   *
   * 用 `preserveAspectRatio="meet"`：實際比例係 `view.w / rect.width`
   * （同 `pxToUserUnits` 一致）。讀唔到容器時回 0 —— 呼叫者要跳過，
   * 唔可以當 1:1。
   */
  private userUnitsFor(px: number): number {
    const w = this.svgWidthPx();
    if (!(w > 0)) return 0;
    return px * (this.view.w / w);
  }

  /**
   * 設定一個「隨縮放調整」嘅 SVG 屬性，同時記錄落快取。
   *
   * 為何要快取
   * ----------
   * 標記半徑係 `base / viewScale`。動畫期間 viewScale 每幀都變，
   * 但**唔可以每幀重建 DOM**（50 個標記 × 60fps = 太重）。
   *
   * 所以：render 時記低 (元素, 屬性, 基準值)，動畫每幀只更新屬性值。
   * 呢個係 O(n) 屬性寫入，冇 DOM 重建。
   */
  private setScaled(el: Element, attr: string, base: number): void {
    this.scaledEls.push({ el, attr, base });
    el.setAttribute(attr, String(this.markerR(base)));
  }

  /**
   * 動畫每幀呼叫：按目前 viewScale 更新所有快取元素。
   *
   * ⚠️ 為何要記住上次嘅倍率（V2 新增）
   * ----------------------------------
   * **平移期間 viewScale 完全唔變**（view.w 冇改），但 `onChange` 每幀
   * 都會呼叫呢個方法 —— 即係每幀對 200+ 個元素寫返一模一樣嘅值。
   * 寫同一個值一樣會令瀏覽器做 style invalidation（SVG presentation
   * attribute 冇「值相同就跳過」嘅短路），A8 量到嘅 pan 掉幀有一部分
   * 就係呢度。
   *
   * 用 `markerR` 內部嘅同一個 clamp 值做比較 —— 唔可以直接用
   * `viewScale`，因為 scale > 10 之後標記尺寸已經封頂，唔需要再寫。
   */
  private applyLiveScale(): void {
    const s = Math.min(Math.max(this.viewScale, 0.5), 10);
    if (s === this.lastLiveScale) return;
    this.lastLiveScale = s;
    for (const { el, attr, base } of this.scaledEls) {
      el.setAttribute(attr, String(this.markerR(base)));
    }
  }

  private init(): void {
    /*
     * ⚠️ 一定要喺 `root.innerHTML = …` **之前**注入 CSS，否則第一幀會
     * 用舊 CSS 畫（FOUC）—— 包括 `.zone-area { pointer-events: none }`。
     */
    this.injectMapCss();
    this.root.innerHTML = `
      <div class="svg-map-wrap">
        <!--
          向量底圖畫喺 <canvas>，SVG 疊喺上面只負責標記／路線／區域。

          為何要分開兩層
          --------------
          市區一平方公里有幾千幢建築。用 SVG 畫就要為每個多邊形建一個
          DOM 節點，5,000 個節點會令平移掉幀。Canvas 冇 DOM 開銷，
          而且可以用 setTransform 一次過變換整批路徑。
        -->
        <canvas id="basemap-canvas" class="basemap-canvas" aria-hidden="true"></canvas>
        <svg id="svg-map" class="svg-map" viewBox="${VIEWBOX}" preserveAspectRatio="xMidYMid meet"
             tabindex="0" role="application"
             aria-label="互動地圖：方向鍵平移、+ / − 縮放、0 重置">
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
            <!--
              B6：Zone 圖騰 symbol（同一份 path 由 zone badge 同圖例共用）。

              ⚠️ 圖例（.legend-glyph 內嘅 use 指向 #zone-glyph-x）同 zone badge
              都用呢三個 symbol —— 令「同一個圖騰」只有一個定義。若果兩邊
              各自寫一份 path，改圖騰時一定會漏改一邊。
            -->
            <symbol id="zone-glyph-shield" viewBox="0 0 1 1">
              <path d="${ZONE_GLYPH.shield}"/>
            </symbol>
            <symbol id="zone-glyph-biohazard" viewBox="0 0 1 1">
              <path d="${ZONE_GLYPH.biohazard}"/>
            </symbol>
            <symbol id="zone-glyph-flag" viewBox="0 0 1 1">
              <path d="${ZONE_GLYPH.flag}"/>
            </symbol>
            <!--
              B6：圖例 pattern 樣本（三通道之 pattern）。

              spec §4 硬性要求 zone 圖例唔可以只靠顏色。pattern 用
              SVG <pattern> 元素（唔係 CSS background）係為咗 SVG 內外一致。
            -->
            <pattern id="legend-pat-solid" width="4" height="4" patternUnits="userSpaceOnUse">
              <rect width="4" height="4" fill="currentColor" opacity="0.45"/>
            </pattern>
            <pattern id="legend-pat-hatch" width="4" height="4" patternUnits="userSpaceOnUse">
              <path d="M0 4 L4 0" stroke="currentColor" stroke-width="1"/>
            </pattern>
            <pattern id="legend-pat-contour" width="6" height="6" patternUnits="userSpaceOnUse">
              <path d="M0 3 H6 M0 6 H6" stroke="currentColor" stroke-width="0.8"/>
            </pattern>
            <pattern id="legend-pat-noise" width="4" height="4" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.7" fill="currentColor"/>
              <circle cx="3" cy="3" r="0.5" fill="currentColor" opacity="0.6"/>
            </pattern>
            <pattern id="legend-pat-pulse" width="6" height="6" patternUnits="userSpaceOnUse">
              <circle cx="3" cy="3" r="2" fill="none" stroke="currentColor" stroke-width="0.8"/>
            </pattern>
          </defs>
          <g id="map-content">
            <!--
              Raster 底圖**只做後備**。
              預設唔設 href —— 冇必要為咗一個平時唔用嘅 2 MB PNG 付流量。
              向量底圖載入失敗時才由 fallbackToRaster() 填上 href。
            -->
            <image id="basemap-group" class="basemap-layer"
                   x="${BASE_VIEW.x}" y="${BASE_VIEW.y}" width="${BASE_VIEW.w}" height="${BASE_VIEW.h}"
                   preserveAspectRatio="none" />
            <g id="label-detail-layer" class="label-detail-layer" pointer-events="none" opacity="0">
              <image id="label-detail-image" class="label-detail-image"
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
              <!--
                P1-8（a11y）：圖例摺疊控制項。

                ⚠️ A7 P1-8 量到圖例遮蓋 24.3% 地圖，而原本**冇任何摺疊方式**。
                CSS 已就緒（mobile.css §7：.map-overlay.is-legend-collapsed
                會隱藏 .legend-list / .legend-grid）—— 呢度只係接控制項。

                ⚠️ 呢段係 TS template literal 內嘅 HTML 註解 —— **唔可以用反引號**
                （會提早終止 template literal 令 build 爆）。所以 class 名唔加引號。

                aria-expanded 由 bindEvents() 同步；aria-controls 指向 #map-legend。
                重用 .legend-lang-btn 樣式（同語言掣一致）。
              -->
              <button id="legend-toggle-btn" class="legend-lang-btn" type="button"
                      aria-expanded="true" aria-controls="map-legend"
                      title="摺疊／展開圖例 / Collapse legend">▾</button>
            </div>
            <div class="legend-item"><span class="dot dot-event-current"></span><span data-i18n="legend.event-current">本章事件</span></div>
            <div class="legend-item"><span class="dot dot-event-other"></span><span data-i18n="legend.event-other">其他章事件</span></div>
            <div class="legend-item"><span class="dot dot-loc-real"></span><span data-i18n="legend.loc-real">真實地點</span></div>
            <div class="legend-item"><span class="dot dot-loc-fictional"></span><span data-i18n="legend.loc-fictional">虛構地點</span></div>
            <div class="legend-item"><span class="dot dot-selected"></span><span data-i18n="legend.selected">選中</span></div>
            <!--
              B6：Zone 圖例三通道（spec §4 硬性 —— 唔可以只靠顏色）。

              color = .area-<key>；pattern = .legend-pattern 內嘅
              <rect fill="url(#legend-pat-*)">；icon = .legend-glyph 內嘅
              use 指向 #zone-glyph-*。

              ⚠️ data-i18n key 沿用既有（svgmap.legend.test.ts 鎖住）
              其中幾個），新增嘅 key 一定要同時加入 LEGEND_ZH / LEGEND_EN，
              否則切語言時會變成空白。
            -->
            <div class="legend-item">
              <span class="area area-survivor"></span>
              <svg class="legend-pattern" data-pattern="solid" viewBox="0 0 8 8" aria-hidden="true"><rect width="8" height="8" fill="url(#legend-pat-solid)"/></svg>
              <svg class="legend-glyph" viewBox="0 0 1 1" aria-hidden="true"><use href="#zone-glyph-shield"/></svg>
              <span data-i18n="legend.zone-survivor">倖存區（安全）</span>
            </div>
            <div class="legend-item">
              <span class="area area-nest"></span>
              <svg class="legend-pattern" data-pattern="hatch" viewBox="0 0 8 8" aria-hidden="true"><rect width="8" height="8" fill="url(#legend-pat-hatch)"/></svg>
              <svg class="legend-glyph" viewBox="0 0 1 1" aria-hidden="true"><use href="#zone-glyph-biohazard"/></svg>
              <span data-i18n="legend.zone-nest">病窩（危險）</span>
            </div>
            <div class="legend-item">
              <span class="area area-outpost"></span>
              <svg class="legend-pattern" data-pattern="contour" viewBox="0 0 8 8" aria-hidden="true"><rect width="8" height="8" fill="url(#legend-pat-contour)"/></svg>
              <svg class="legend-glyph" viewBox="0 0 1 1" aria-hidden="true"><use href="#zone-glyph-flag"/></svg>
              <span data-i18n="legend.zone-outpost">據點（爭奪中）</span>
            </div>
            <div class="legend-item">
              <span class="area area-estimated"></span>
              <svg class="legend-pattern" data-pattern="pulse" viewBox="0 0 8 8" aria-hidden="true"><rect width="8" height="8" fill="url(#legend-pat-pulse)"/></svg>
              <svg class="legend-glyph" viewBox="0 0 1 1" aria-hidden="true"><use href="#zone-glyph-flag"/></svg>
              <span data-i18n="legend.zone-estimated">虛線＝範圍係估算</span>
            </div>
            <div class="legend-item"><span class="line route-legend"></span><span data-i18n="legend.route">角色路線（僅真實地點之間）</span></div>
          </div>
        </div>
        <!--
          B6：圖層開關（7 個，對應 B2 LayerFlags）。

          ⚠️ 由 renderLayerControls() 填 —— 次序同 LAYER_KEYS
          （＝ src/state/url.ts LAYER_ORDER）一致。
        -->
        <div class="layer-controls" id="layer-controls" role="group" aria-label="圖層開關"></div>
        <!--
          B6：地圖控制項容器。掣由 MapControls 元件砌
          （id 沿用：map-zoom-in / map-zoom-out / map-reset /
          map-show-all-events —— 既有測試直接 page.click() 佢哋）。
        -->
        <div class="map-controls" id="map-controls" role="group" aria-label="地圖控制"></div>
      </div>
    `;
    this.svg = this.root.querySelector<SVGSVGElement>("#svg-map")!;
    this.wrap = this.root.querySelector<HTMLElement>(".svg-map-wrap")!;
    this.initShell();
    this.initBasemap();
    this.initControls();
    this.bindEvents();
    this.render();
  }

  /**
   * 建立地圖控制項（B6 由 `SvgMap` 抽出嘅 `MapControls` 元件）。
   *
   * 為何要抽
   * --------
   * 舊 code 用一大段 `root.innerHTML` 砌控制項 ＋ `this.showAllEvents`
   * 記狀態。抽出之後：掣嘅 `id`／`class` 只有一個來源（`CTRL_SPECS`）、
   * 狀態係**寫入式**（`setAllEvents()`）而唔係自己 toggle，
   * 而且 44×44 / focus ring 嘅契約可以獨立測（見 `map-css-contract`）。
   */
  private initControls(): void {
    const mount = this.root.querySelector<HTMLElement>("#map-controls");
    if (!mount) return;
    this.controls = new MapControls(mount, {
      onZoomIn: () => this.zoomBy(1.3),
      onZoomOut: () => this.zoomBy(1 / 1.3),
      onReset: () => this.animateViewBox({ ...BASE_VIEW }),
      onToggleAllEvents: () => {
        this.showAllEvents = !this.showAllEvents;
        this.controls?.setAllEvents(this.showAllEvents);
        this.render();
      },
    });
    this.controls.setAllEvents(this.showAllEvents);
  }

  /**
   * 建立容器層（`MapShell`）並接管手勢。
   *
   * 為何手勢唔再留喺 `SvgMap`
   * ------------------------
   * A8 P1-1 實測 pan 只有 28.9–30.9 fps（idle 基準 60.2）：舊 code 嘅
   * `window.mousemove` 每個事件都即刻改 `<svg viewBox>`，一個 frame
   * 收到 3–5 次 = 做咗 3–5 倍無謂工作。
   *
   * `MapViewport` 只累積、每 frame 最多一次 `onChange`；手勢結束
   * （mouseup／touchend／wheel idle）才 flush + `render()`。
   *
   * ⚠️ `this.view` 係鏡像，唯一擁有者係 `shell.viewport`。
   */
  private initShell(): void {
    const content = this.svg.querySelector<SVGGElement>("#map-content")!;
    this.shell = new MapShell(this.root, {
      app: this.app,
      svg: this.svg,
      layersRoot: content,
      base: { ...BASE_VIEW },
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      onChange: (patch) => {
        if (!patch.view) return;
        this.view = patch.view;
        this.applyViewBox();
        // 標記半徑係 base / viewScale —— 縮放期間要逐幀同步
        this.applyLiveScale();
        // 病窩光環動畫係互動期間最大嘅成本（見 pulsesSuspended 註釋）
        this.suspendZonePulses();
      },
      onSettle: () => this.render(),
    });
    this.shell.attach();
  }

  /**
   * 暫停 `.zone-pulse` 動畫（互動期間），並喺靜止 `PULSE_IDLE_RESUME_MS`
   * 之後恢復。詳見 `pulsesSuspended` 嘅實測表。
   *
   * ⚠️ V2 收尾：只有狀態**轉變**時才寫 DOM。
   *
   * `onChange` 每幀都會呼叫呢個方法（手勢期間），而 `applyZonePulseState()`
   * 會 `querySelectorAll` ＋ 對每個 `.zone-pulse` 寫 `display="none"`。
   * 一個手勢內係同一批元素寫同一個值幾十次 —— 冇意義，但每次 `setAttribute`
   * 都會令 style invalidation。加守衛之後手勢期間嘅 DOM 寫入次數由
   * 「每幀 × pulse 數」降到「每次手勢 1 次」。
   *
   * `render()` 重建 `#zones-layer` 之後仍然會**無條件**呼叫
   * `applyZonePulseState()`（見 `render()` 尾部），所以新元素唔會漏。
   */
  private suspendZonePulses(): void {
    if (!this.pulsesSuspended) {
      this.pulsesSuspended = true;
      this.applyZonePulseState();
    }
    if (this.pulseResumeTimer !== null) window.clearTimeout(this.pulseResumeTimer);
    this.pulseResumeTimer = window.setTimeout(() => {
      this.pulseResumeTimer = null;
      if (!this.pulsesSuspended) return;
      this.pulsesSuspended = false;
      this.applyZonePulseState();
    }, PULSE_IDLE_RESUME_MS);
  }

  /**
   * 將 `pulsesSuspended` 套用到 DOM。
   *
   * ⚠️ `render()` 會 `replaceChildren()` 重建 `#zones-layer`，所以**每次
   * 重建之後都要再呼叫一次**（新元素冇 `display` 屬性，預設會動）。
   */
  private applyZonePulseState(): void {
    const pulses = this.svg.querySelectorAll<SVGElement>("#zones-layer .zone-pulse");
    for (const p of pulses) {
      if (this.pulsesSuspended) p.setAttribute("display", "none");
      else p.removeAttribute("display");
    }
  }

  /**
   * 啟動向量底圖。
   *
   * 失敗時**唔會令地圖變空白** —— 會退回舊嘅 raster 底圖
   * （`#basemap-group` 一直留喺 DOM 度，只係平時 opacity 0）。
   * 用戶見到嘅係「冇咁靚」，而唔係「咩都冇」。
   */
  private initBasemap(): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>("#basemap-canvas");
    if (!canvas) return;
    this.basemap = new VectorBasemap(canvas);
    this.basemap.onReady = () => {
      const wasReady = this.wrap.classList.contains("basemap-vector-ready");
      this.wrap.classList.add("basemap-vector-ready");
      /*
       * ⚠️ 只喺**第一次** ready 才 sync（B9 Q10 冷 zoom 阻塞）。
       *
       * `VectorBasemap.emitReady()` **每次圖磚載入都會 fire**。如果每次
       * 都 sync：`getBoundingClientRect()`（強制同步 layout）＋
       * `setView()`（`ensureTiles` + `scheduleDraw` → 再一次全畫布重繪）。
       * 實測冷 zoom 載入 4 格圖磚 = **4 次冗餘重繪**，每格重繪都係一個
       * 幾十 ms 嘅 task。
       *
       * 容器尺寸改變由 `ResizeObserver` 負責（見 `initBasemap()`），
       * 所以呢度唔需要補。
       */
      if (!wasReady) this.syncBasemapView();
    };
    this.basemap.onError = (e) => {
      console.warn("[底圖] 向量底圖載入失敗，退回 raster：", e.message);
      this.fallbackToRaster();
    };
    void this.basemap.init().then(() => this.syncBasemapView());

    /*
     * 容器尺寸改變時重畫底圖。
     *
     * 為何一定要監察尺寸而唔係只聽 `window.resize`
     * ------------------------------------------
     * 故事面板係可收合嘅（窄螢幕會變浮層）。面板收合會令地圖容器
     * **變闊**，但 `window` 完全冇 resize 事件 —— canvas 就會維持
     * 舊尺寸，右邊出現一條未繪製嘅空白。
     */
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        // 容器尺寸變 → `svgWidthPx()` 快取失效（見該欄位註釋）
        this.svgWidthCache = 0;
        this.syncBasemapView();
      });
      this.resizeObserver.observe(this.wrap);
    }
  }

  /**
   * 退回 raster 底圖。
   *
   * 只有喺向量底圖**真係載入唔到**（例如未跑 build 腳本、
   * 部署漏咗 `assets/vector/`）才會行呢條路。呢個時候用戶仍然有
   * 一個睇得明嘅地圖，只係放大會起格 —— 好過一片黑。
   */
  private fallbackToRaster(): void {
    if (this.basemapFailed) return;
    this.basemapFailed = true;
    this.wrap.classList.add("basemap-vector-failed");
    /*
     * 唔喺度直接寫 href —— 交畀 `updateBasemapTier()`（經 `pickTier()`）
     * 做，令「raster 路徑只有一個來源」（`RASTER_FALLBACK`）。
     * 重設 `currentTierId` 係為咗強制行一次（否則會 early-return）。
     */
    this.currentTierId = "";
    this.updateBasemapTier();
  }

  /** 將目前 viewBox 同容器尺寸交畀向量底圖。 */
  private syncBasemapView(): void {
    if (!this.basemap) return;
    const r = this.wrap.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.basemap.setView(
      { ...this.view },
      r.width,
      r.height,
      Math.min(window.devicePixelRatio || 1, 2),
    );
  }

  private bindEvents(): void {
    /*
     * ⚠️ 三粒縮放／重置掣同「全部事件」開關已經搬入 `MapControls`
     * （見 `initControls()`）。呢度**唔可以**再註冊一次 —— 重複註冊
     * 會令一次點擊做兩次 `zoomBy`（等於放大 1.69 倍）。
     */

    /*
     * P1-8（a11y）：圖例摺疊控制項。
     *
     * 切換 `#map-overlay` 嘅 `.is-legend-collapsed` class（CSS 已喺
     * `mobile.css` §7 定義），同時更新 `aria-expanded` + 箭頭方向，
     * 令螢幕閱讀器知道目前狀態。
     *
     * ⚠️ class 加喺 `#map-overlay` 而唔係 `#map-legend` —— CSS 選擇器係
     * `.map-overlay.is-legend-collapsed`。
     * ⚠️ Legend DOM 係靜態（唔會被 `render()` 重建），所以喺 `bindEvents()`
     * 綁一次就夠。
     */
    const legendToggle = this.root.querySelector<HTMLButtonElement>("#legend-toggle-btn");
    const overlay = this.root.querySelector("#map-overlay");
    legendToggle?.addEventListener("click", () => {
      if (!overlay) return;
      const collapsed = overlay.classList.toggle("is-legend-collapsed");
      legendToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      legendToggle.textContent = collapsed ? "▸" : "▾";
    });

    // 圖例語言切換
    const langBtn = this.root.querySelector("#legend-lang-btn");
    if (langBtn) {
      langBtn.addEventListener("click", () => this.toggleLegendLanguage());
    }

    this.bindLayerControls();
    this.bindKeyboard();
    this.bindSvgDelegation();
  }

  /**
   * 圖層開關（7 個）—— P0-4。
   *
   * 狀態唯一來源係 **store**（規則 S1）。呢度只係：
   *   click → `store.toggleLayer(key)` → DOM 反映 `aria-pressed`。
   *
   * 為何唔自己記一份 `this.layerState`
   * ---------------------------------
   * `?layers=` 參數由 `src/state/url.ts` round-trip 還原。如果 `SvgMap`
   * 自建一份，URL 還原之後 UI 會同實際狀態唔一致（而 store 已經有
   * `toggleLayer` / `setLayer`，見 `src/state/store.ts:216`）。
   */
  private bindLayerControls(): void {
    const toggle = this.bindLayerToggleButtons();
    if (!toggle) return;
    // 由 store 讀返現況（URL 可能已經指定咗）
    this.syncLayerStateFromStore();
  }

  /**
   * 綁 7 個 `[data-layer]` 掣 —— **每次 `renderLayerControls()` 之後都要
   * 重新綁**（`replaceChildren()` 會令舊 listener 一齊消失）。
   *
   * @returns 有冇成功綁到（冇容器就 false）。
   */
  private bindLayerToggleButtons(): boolean {
    const host = this.root.querySelector<HTMLElement>("#layer-controls");
    if (!host) return false;
    for (const key of LAYER_KEYS) {
      const btn = host.querySelector<HTMLElement>(`[data-layer="${key}"]`);
      if (!btn) continue;
      btn.addEventListener("click", () => {
        /*
         * ⚠️ 一定要經 store —— 唔可以自己反轉。
         * `store.toggleLayer()` 會觸發 `onStateChange()`
         * （`src/app.ts` 訂閱），最終行到 `syncLayerStateFromStore()`。
         */
        this.app.store.toggleLayer(key);
        this.syncLayerStateFromStore();
      });
    }
    return true;
  }

  /** 由 store 讀圖層狀態 → 寫 `aria-pressed` ＋ 套用 `hidden`。 */
  private syncLayerStateFromStore(): void {
    const s = this.app.store.getState().layers;
    this.layerState = { ...s };
    const host = this.root.querySelector<HTMLElement>("#layer-controls");
    if (host) {
      for (const key of LAYER_KEYS) {
        const btn = host.querySelector<HTMLElement>(`[data-layer="${key}"]`);
        btn?.setAttribute("aria-pressed", String(s[key]));
      }
    }
    this.applyLayerState();
  }

  /**
   * 將 `this.layerState` 套用到 DOM（只寫 `hidden` 屬性）。
   *
   * ⚠️ 為何唔重建 DOM：`hidden` 係 SVG presentation 之外嘅屬性，
   * 寫入成本係 O(selector)，唔會令 `<path>` 重新光柵化。而
   * `render()` 每幀都會被呼叫（動畫／平移），所以一定要有
   * 「值冇變就跳過」嘅短路 —— 見 `lastLayerSig`。
   */
  private applyLayerState(): void {
    const sig = LAYER_KEYS.map((k) => (this.layerState[k] ? "1" : "0")).join("");
    if (sig === this.lastLayerSig) return;
    this.lastLayerSig = sig;
    for (const { selector, hidden } of hiddenSelectors(this.layerState)) {
      for (const el of this.svg.querySelectorAll(selector)) {
        if (hidden) el.setAttribute("hidden", "");
        else el.removeAttribute("hidden");
      }
    }
  }

  /**
   * 鍵盤導航 —— P0-7。
   *
   * 為何要綁喺 `#svg-map` 而唔係 `window`
   * ------------------------------------
   * `src/app.ts` 嘅 `bindKeys()` 已經用咗 `window` 上嘅 `k` / `j` /
   * `Home` / `End` / `?` / `/` / `Escape`。如果地圖嘅方向鍵／`+`／`-`
   * 都綁 `window`，用戶喺搜尋框打字或者喺編年史捲動時會誤觸。
   *
   * 所以：只有焦點喺 `#svg-map`（或 SVG 內部元素）時才生效。
   * `#svg-map` 有 `tabindex="0"` ＋ `role="application"`（見 `init()`）。
   */
  private bindKeyboard(): void {
    this.svg.addEventListener("keydown", (e) => {
      // 唔可以搶走輸入框嘅按鍵
      const t = e.target as Element | null;
      if (t && t.closest?.("input, textarea, select")) return;
      /*
       * ⚠️ 只跳過**方向鍵**（唔係整個 handler）。
       *
       * 焦點喺**地圖元素**（zone／marker／event）時，方向鍵係「喺元素之間
       * 移動」（P1-2 roving tabindex，見 `bindMapKeyboard()`），唔應該同時
       * 平移地圖。但 `0`（重置）／`+` / `-`（縮放）仍然要生效 ——
       * 之前寫成「有地圖元素就成個 return」，連 `0` 都死埋（實測）。
       */
      const onMapEl = Boolean(t?.closest?.(MAP_INTERACTIVE_SELECTOR));
      const isArrow =
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight";
      if (onMapEl && isArrow) return;
      const step = e.shiftKey ? 120 : 40;
      switch (e.key) {
        case "+":
        case "=":
          this.zoomBy(1.3);
          break;
        case "-":
        case "_":
          this.zoomBy(1 / 1.3);
          break;
        case "0":
          this.animateViewBox({ ...BASE_VIEW });
          break;
        case "ArrowUp":
          this.panByPixels(0, step);
          break;
        case "ArrowDown":
          this.panByPixels(0, -step);
          break;
        case "ArrowLeft":
          this.panByPixels(step, 0);
          break;
        case "ArrowRight":
          this.panByPixels(-step, 0);
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  /**
   * SVG 內嘅 click delegation（hit priority 經 `resolveHit()`）。
   *
   * 為何要用 `resolveHit()` 而唔係原本嘅 if-else 鏈
   * --------------------------------------------
   * 原本嘅鏈寫死喺 handler 內部，所以「zone 優先過 event」呢個 spec §2.3
   * 契約**冇辦法單測**（要起整個 Playwright）。抽出純函數之後：
   *   · `resolveHit()` 嘅次序可以 node 單測；
   *   · handler 只管分派（`dispatchHit()`）。
   */
  /**
   * 共用嘅命中分派 —— `click` / `pointerup` / 鍵盤 `Enter` 三條路徑都經過。
   *
   * 抽成方法而唔係局部 arrow function：鍵盤啟動要由另一個 handler 呼叫
   * （見 `bindMapKeyboard()`），而**行為必須完全一致**（唔可以兩套邏輯漂移）。
   */
  private handleHitAt(targetEl: Element): void {
    const target = resolveHit(targetEl);
    dispatchHit(target, {
      onZone: (id) => this.app.setSelectedZone(id),
      onRoute: (id) => {
        const route = this.data.routes.features.find(
          (f) => f.properties.id === id,
        );
        if (route) this.app.setChapter(route.properties.chapters_span[0]);
      },
      // 聚合標記：放大去拆開佢（而唔係選中單一地點）
      onMarker: (id) => this.zoomToLocation(id),
      onEvent: (id) => this.app.setSelectedEvent(id),
    });
  }

  /**
   * 點擊地圖元素之後，確保焦點**留喺地圖之內**（P1-2 回歸修正）。
   *
   * ⚠️ 為何一定要做（2026-09-24 實測）
   * --------------------------------
   * 為 `.zone` 等元素加 `tabindex` 之後，Chromium「點擊 → 聚焦最近可聚焦
   * 祖先」嘅行為變咗：實測點完 zone 之後 `document.activeElement` 變
   * **BODY**（唔係 SVG，亦唔係 zone）。後果係地圖自己嘅快捷鍵
   * （`0` 重置、`+` / `-` 縮放、方向鍵平移）**全部靜默失效** ——
   * 因為 `bindKeyboard()` 綁喺 `#svg-map`，要求焦點喺 SVG 之內。
   *
   * 呢個就係之前「加 tabindex 令 e2e fail、根因未明」嘅真正根因
   * （`tests/map-interaction.e2e.test.ts` 嘅「輕觸要選中、拖曳要平移」）。
   *
   * 修法：明確 `focus()` 命中嘅元素；如果瀏覽器唔支援（SVG `<g>` +
   * `tabindex` 喺 Chromium 支援唔一致），**退返 `#svg-map`** ——
   * 寧願焦點落喺 SVG 根，都唔可以變 BODY。
   */
  private focusHitElement(target: Element): void {
    if (typeof target.closest !== "function") return;
    const el = target.closest(MAP_INTERACTIVE_SELECTOR) as SVGElement | null;
    if (!el) return;
    this.kbWantFocus = true;
    el.focus();
    if (document.activeElement !== el) this.svg.focus();
  }

  /**
   * 將地圖元素標記為「可鍵盤操作」（P1-2 / A7 驗收矩陣 §10.9）。
   *
   * ⚠️ `tabindex` 一律先設 `-1`：**邊個係 `0` 由 `applyRovingTabindex()`
   * 統一決定**（roving tabindex）。如果喺呢度直接設 `0`，48 個 zone 就會
   * 變成 48 個 Tab stop —— 鍵盤用戶要 Tab 過百次才離開地圖，而且會撞紅
   * `a11y-keyboard.e2e.test.ts` 嘅「全頁 Tab stop < 600」同「頂欄導覽要喺
   * 20 次 Tab 內到達」。
   */
  private markInteractive(el: SVGElement, label: string): void {
    el.setAttribute("tabindex", "-1");
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", label);
  }

  /** 由元素嘅 class + `data-*` id 砌出穩定嘅識別 key（roving 記憶用）。 */
  private kbKeyOf(el: Element): string {
    const id =
      el.getAttribute("data-zone-id") ??
      el.getAttribute("data-loc-id") ??
      el.getAttribute("data-event-id") ??
      el.getAttribute("data-route-id") ??
      "";
    const cls = el.getAttribute("class") ?? "";
    return `${cls.split(" ")[0]}|${id}`;
  }

  /** 目前 SVG 內全部互動元素（document order）。 */
  private mapInteractiveEls(): SVGElement[] {
    return Array.from(
      this.svg.querySelectorAll<SVGElement>(MAP_INTERACTIVE_SELECTOR),
    );
  }

  /**
   * roving tabindex：確保**只有一個**互動元素係 `tabindex="0"`。
   *
   * 由 `render()` 尾部呼叫（圖層啱啱被 `replaceChildren()` 重建）。
   * 會盡量將 `0` 放返喺上次嘅目標（`kbFocusKey`），令 render 之後焦點
   * 位置唔會跳。
   */
  private applyRovingTabindex(): void {
    const els = this.mapInteractiveEls();
    if (els.length === 0) return;
    let idx = 0;
    if (this.kbFocusKey) {
      const found = els.findIndex((e) => this.kbKeyOf(e) === this.kbFocusKey);
      if (found >= 0) idx = found;
    }
    els.forEach((e, i) => e.setAttribute("tabindex", i === idx ? "0" : "-1"));
    this.kbFocusKey = this.kbKeyOf(els[idx]);
    /*
     * ⚠️ 還原焦點：`render()` 啱啱 `replaceChildren()` 銷毀咗舊元素，
     * 如果地圖之前持有焦點，要將焦點放返喺「同一個」元素（見 kbWantFocus）。
     * 瀏覽器唔支援 SVG 元素 focus 時退返 `#svg-map` —— 絕對唔可以變 BODY。
     */
    if (this.kbWantFocus && document.activeElement !== els[idx]) {
      els[idx].focus();
      if (document.activeElement !== els[idx]) this.svg.focus();
    }
  }

  /**
   * 地圖元素嘅鍵盤導覽（P1-2 / A7 §10.9）。
   *
   * | 鍵 | 行為 |
   * |---|---|
   * | `Tab` / `Shift+Tab` | 進／出地圖（整個地圖**只有 1 個** Tab stop） |
   * | `→` `↓` / `←` `↑` | 喺組內移動焦點（環繞） |
   * | `Home` / `End` | 跳去第一個／最後一個 |
   * | `Enter` / `Space` | 啟動（**同 click 完全同一條路徑**） |
   * | `Escape` | 離開地圖元素 |
   *
   * ⚠️ SVG 元素**唔似** `<button>`：`Enter` 唔會自動合成 `click`，所以
   * 一定要自己處理。方向鍵亦一定要 `preventDefault`，否則會捲動頁面。
   */
  private bindMapKeyboard(): void {
    const setRoving = (els: SVGElement[], idx: number): void => {
      els.forEach((x, i) => x.setAttribute("tabindex", i === idx ? "0" : "-1"));
      this.kbFocusKey = this.kbKeyOf(els[idx]);
    };

    this.svg.addEventListener("keydown", (e) => {
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== "function") return;
      const el = t.closest(MAP_INTERACTIVE_SELECTOR) as SVGElement | null;
      if (!el) return;
      const action = resolveMapKey(e.key);
      if (action === "none") return;

      if (isNavigationAction(action)) {
        /*
         * ⚠️ 一定要 `stopPropagation()`：`src/app.ts` 嘅 `bindKeys()` 綁喺
         * `document`，會用 ArrowLeft/Right 改章節、Home/End 跳第一／最後章。
         * 如果唔擋，用戶喺地圖元素之間移動焦點時**章節會一齊跳**。
         */
        e.preventDefault();
        e.stopPropagation();
        const els = this.mapInteractiveEls();
        const next = rovingIndex(els.indexOf(el), action, els.length);
        if (next < 0) return;
        setRoving(els, next);
        els[next].focus();
        return;
      }
      if (action === "activate") {
        e.preventDefault();
        e.stopPropagation();
        this.handleHitAt(el);
        return;
      }
      if (action === "escape") {
        e.preventDefault();
        e.stopPropagation();
        el.blur();
      }
    });

    // 焦點一入到地圖就同步 roving 狀態（例如用滑鼠點完再用鍵盤）
    this.svg.addEventListener("focusin", (e) => {
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== "function") return;
      const el = t.closest(MAP_INTERACTIVE_SELECTOR) as SVGElement | null;
      if (!el) return;
      this.kbWantFocus = true;
      const els = this.mapInteractiveEls();
      const i = els.indexOf(el);
      if (i >= 0) setRoving(els, i);
    });

    /*
     * 焦點離開地圖（去咗 SVG 以外）就唔應該再搶返嚟 —— 否則用戶
     * Tab 去其他控制項之後，下一個 render 會將焦點拉返地圖。
     */
    this.svg.addEventListener("focusout", (e) => {
      if (this.rendering) return; // 元素係被自己 render 銷毀，唔算「離開地圖」
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (next && this.svg.contains(next)) return;
      this.kbWantFocus = false;
    });
  }

  private bindSvgDelegation(): void {
    /** 共用嘅命中處理 —— 由 `click` / `pointerup` / 鍵盤三條路徑呼叫。 */
    const handleHit = (targetEl: Element): void => this.handleHitAt(targetEl);

    this.svg.addEventListener("click", (e) => {
      const t = e.target as Element;
      this.focusHitElement(t);
      handleHit(t);
    });

    this.bindMapKeyboard();

    /*
     * ⚠️ 補強（2026-09-23）：唔可以只靠 `click`。
     *
     * Chromium 嘅 `click` 合成條件係「`mousedown` 同 `mouseup` 喺同一個元素」。
     * 實測：全套測試（36 檔、9 分鐘、CPU 高負載）之下，**2px 微拖**
     * （< 4px 門檻，應該當輕觸）**唔會合成 `click`** → 用戶「點極都點唔中 zone」。
     * （單獨跑冇問題 → 一直被當成 flaky。）
     *
     * 修法：喺 `pointerup` 直接處理（唔依賴瀏覽器合成），但係要跳過
     * **真正拖曳**（`viewportRef.didJustPan` —— 累計位移 ≥ 4px）。
     *
     * ⚠️ `click` handler **保留**：`pointerup` 喺某啲情況（例如鍵盤觸發嘅
     * `click`）唔會派發。兩個 handler 都呼叫 `setSelectedZone` /
     * `setSelectedEvent`，而佢哋係 **idempotent**（同值唔會再通知）。
     */
    this.svg.addEventListener("pointerup", (e) => {
      if (this.shell.viewportRef.didJustPan) return;
      const t = e.target as Element;
      this.focusHitElement(t);
      handleHit(t);
    });
  }

  /**
   * 以視圖中心縮放，並 clamp 到容許範圍。
   *
   * ⚠️ V2：實作搬入 `map-camera.scaleView`（純函數，可以 node 單測）。
   */
  private scaledView(base: ViewBox, factor: number): ViewBox {
    return scaleView(base, BASE_VIEW, factor, {
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
    });
  }

  /**
   * 限制視窗喺底圖範圍之內（唔可以平移到出界）。
   *
   * 為何需要：底圖只有 BASEMAP_BBOX 咁大。如果視窗移出界，就會露出
   * 黑色底色（用戶見到嘅「黑邊」）。
   *
   * ⚠️ V2：實作搬入 `map-camera.clampView`。
   */
  private clampView(v: ViewBox): ViewBox {
    return clampViewBox(v, BASE_VIEW);
  }

  /**
   * 以按鈕／滾輪縮放（相對倍率）。
   *
   * ⚠️ V2：改為交畀 `shell.viewportRef`（`MapViewport.zoomBy`）——
   * 咁樣手勢同按鈕共用同一份 view 狀態。`zoomBy` 係程式呼叫，
   * 所以會即刻 flush（唔等 rAF），之後再 `render()` 重建標記。
   */
  private zoomBy(factor: number): void {
    this.shell.viewportRef.zoomBy(factor);
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
      evidenceBacked: hasEvidence(loc.properties),
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

  /**
   * 用**螢幕像素**位移平移視圖。
   *
   * 為何要有呢個公開方法
   * ------------------
   * `MapViewport` 內部只處理「滑鼠／觸控事件」。B6 嘅
   * `map-interactions.ts` 需要由**像素**換算（例如鍵盤方向鍵平移、
   * 由外部 API 觸發嘅拖曳），而 `preserveAspectRatio="meet"` 嘅
   * 換算唔係 `view.w / rect.width`（見上面 `pxToUserUnits`）。
   *
   * 呢度係唯一出口 —— 令 B6 唔需要自己再寫一次比例公式。
   */
  panByPixels(dxPx: number, dyPx: number): void {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const u = this.pxToUserUnits(rect.width, rect.height);
    this.shell.setView(
      { ...this.view, x: this.view.x + dxPx * u, y: this.view.y + dyPx * u },
      "pan",
    );
    this.render();
  }

  /** 將 this.view 套用到 <svg>，並按 viewScale 更新標籤圖層透明度。 */
  private applyViewBox(): void {
    const { x, y, w, h } = this.view;
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    this.updateBasemapTier();
    this.updateLabelLayerOpacity();
    // 向量底圖同 SVG 共用同一個 viewBox —— 每次視圖改變都要同步，
    // 否則平移時底圖會「跟唔上」手指。
    this.syncBasemapView();
  }

  /**
   * 目前視窗覆蓋嘅經緯範圍。
   *
   * ⚠️ V2：實作搬入 `map-camera.geoBoundsOfView`（純函數）。
   * 舊 code 直接寫 `(view.y − BASE_VIEW.y) / BASE_VIEW.h` 再去乘
   * `latSpan` —— 咁樣會**漏咗 1/cos(φ₀) 校正**（`BASE_VIEW.h` 已經
   * 除過 cos，再乘 latSpan 就唔再係緯度）。共用實作之後冇呢個空間。
   */
  private currentGeoBbox(): GeoBbox {
    return geoBoundsOfView(BASEMAP_BBOX, BASE_VIEW, this.view);
  }

  /**
   * 按目前視窗揀 LOD 圖磚：**最窄但仍然完全覆蓋視窗**嘅層級。
   *
   * ⚠️ V2：raster 只剩**總覽一層**（emergency 後備），所以 `covers`
   * 實質恆為真。保留呢個判斷係因為 (a) `tests/phase-j-lod.test.ts`
   * 要求存在「完全覆蓋」嘅揀層邏輯；(b) 將來真係要加第二層 raster
   * 時唔使重寫。原本嘅規則（13 層 pyramid 年代）：
   * --------------------------------
   * 圖磚只有 bbox 內嘅內容。如果揀咗一個唔完全覆蓋視窗嘅圖磚，視窗邊緣
   * 就會出現空白（露出底色）。所以先篩「覆蓋得住」，再喺入面揀最窄嘅
   * （最窄 = 每像素覆蓋地理範圍最小 = 最清晰）。
   *
   * 若果連最闊嘅層級都覆蓋唔到（例如視窗拉到超出香港），就退回最闊層級，
   * 超出部分自然留白。
   */
  private pickTier(): RasterTier {
    const tiers: RasterTier[] = [rasterTier()];
    const v = this.currentGeoBbox();
    const covers = tiers.filter(
      (t) =>
        t.bbox.lon_min <= v.lon_min &&
        t.bbox.lon_max >= v.lon_max &&
        t.bbox.lat_min <= v.lat_min &&
        t.bbox.lat_max >= v.lat_max,
    );
    const pool = covers.length > 0 ? covers : tiers;
    return pool.reduce((best, t) => (tierSpanOf(t) < tierSpanOf(best) ? t : best));
  }

  /*
   * ⚠️ V2 移除：`preloadFinerTier()`。
   *
   * 佢係為 13 層 raster pyramid 而設（「趁空閒預載下一層」）。A4 實測
   * pyramid 0 次參與，spec 規則 A1/A3 亦只保留「總覽」一層 emergency
   * 後備 —— 冇「更細嘅下一層」可以預載，所以整段連 `preloadedTiers`
   * 一齊刪。向量底圖嘅 tile 快取由 `VectorBasemap` 自己嘅 LRU 管。
   */

  /** 切換底圖圖磚（只有層級改變時才改 DOM）。 */
  private updateBasemapTier(): void {
    // 向量底圖正常運作時，raster LOD 完全唔參與（見 fallbackToRaster）
    if (!this.basemapFailed) return;
    const tier = this.pickTier();
    if (tier.id === this.currentTierId) return;
    this.currentTierId = tier.id;

    const img = this.root.querySelector<SVGImageElement>("#basemap-group");
    if (img) {
      /*
       * bbox 直接用 `BASE_VIEW`（raster 後備只有全港一層），
       * 唔再需要由 tier bbox 反推 viewBox 矩形。
       */
      img.setAttribute("href", assetUrl(tier.image));
      img.setAttribute("x", String(BASE_VIEW.x));
      img.setAttribute("y", String(BASE_VIEW.y));
      img.setAttribute("width", String(BASE_VIEW.w));
      img.setAttribute("height", String(BASE_VIEW.h));
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
   *
   * ⚠️ V2：raster 只做 emergency（規則 A3），所以正常情況下
   * `#label-detail-image` **冇 href** —— 呢個 opacity 只係一個
   * 唔會見到嘅屬性。保留插值係刻意嘅：
   *   · `tests/phase-i.e2e.test.ts` 直接斷言 `#label-detail-layer`
   *     嘅 opacity（overview 時 > 0.5），唔可以硬設 0；
   *   · `data-tier-label-layer` 由 `updateBasemapTier()` 設，而佢喺
   *     向量底圖正常時 early-return —— 所以屬性未設時當「有圖層」。
   */
  private updateLabelLayerOpacity(): void {
    const layer = this.root.querySelector("#label-detail-layer");
    if (!layer) return;
    const labelOpacity = this.viewScale <= 0.8 ? 0.0 : (
      Math.min(1, (this.viewScale - LABEL_FADE_IN) / (LABEL_FADE_FULL - LABEL_FADE_IN))
    );
    const tierHasLayer =
      layer.getAttribute("data-tier-label-layer") !== "0" ? 1 : 0;
    /*
     * ⚠️ V2 收尾：同 `applyLiveScale` 一樣加「值冇變就跳過」快取。
     *
     * 平移期間 `viewScale` 完全唔變，但 `applyViewBox()` 每幀都會呼叫
     * 呢度 —— 冇快取就等於每幀對 `#label-detail-layer` 寫同一個 opacity
     * （`setAttribute` 冇短路，會觸發 style invalidation）。
     */
    const next = labelOpacity * tierHasLayer;
    if (next === this.lastLabelOpacity) return;
    this.lastLabelOpacity = next;
    layer.setAttribute("opacity", next.toFixed(3));
  }

  /**
   * 平滑轉場到目標 viewBox。
   *
   * ⚠️ V2：改為**經 `MapShell` 套用**（`shell.setView`）。
   * 原因：`this.view` 而家係 `MapViewport` 嘅鏡像。如果動畫只改
   * `this.view`，用戶中途用手勢 pan 就會由一個過期嘅起點開始 ——
   * 即係「flyTo 期間拖唔動 / 拖完跳返原位」。
   *
   * ease-in-out cubic；重複呼叫會取消上一個動畫。
   * `prefersReducedMotion()` 為真 → 同步跳終態（B1 §2.3 硬性契約：
   * 唔開 rAF、唔插值）。
   */
  private animateViewBox(target: ViewBox, durationMs: number = ANIM_DURATION_MS): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (prefersReducedMotion() || durationMs <= 0) {
      this.shell.setView(this.clampView(target), "set");
      this.render();
      return;
    }
    const start: ViewBox = { ...this.view };
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      // ease-in-out cubic
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.shell.setView(
        this.clampView({
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          w: start.w + (target.w - start.w) * eased,
          h: start.h + (target.h - start.h) * eased,
        }),
        "set",
      );
      if (t < 1) {
        this.animFrameId = requestAnimationFrame(step);
      } else {
        this.animFrameId = null;
        /*
         * ⚠️ 動畫完成後一定要重新渲染標記。
         *
         * 為何：標記半徑係 `markerR(base) = base / viewScale`，
         * 即係**隨縮放動態調整**，目的係令屏幕尺寸大致恆定。
         *
         * 但轉場只呼叫 `applyViewBox()`（改 SVG viewBox 同標籤透明度），
         * **唔會**重建標記。而 `flyToChapter` 係喺動畫**之前**就 render
         * 咗（嗰時 `this.view` 仍然係舊值 0.70，`viewScale` = 1）——
         * 結果標記用咗「全港視圖」嘅尺寸畫，動畫完之後冇人再更新，
         * 就一直維持咁大。
         *
         * 實測：飛到第 150 章（span 0.0414°）之後，事件標記半徑
         * 0.008 user unit = **畫面寬度嘅 38.7%**，成個地圖被圓圈蓋住。
         * 正確值應該係 0.008 / 16.9 ≈ 0.00047（約 2%）。
         */
        this.render();
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
      { evidenceBacked: hasEvidence(loc.properties) },
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
    // B6：圖層掣嘅文字亦要跟語言（`data-i18n="layer.<key>"`）
    this.renderLayerControls();
  }

  /**
   * 建立／更新 7 個圖層開關掣（P0-4）。
   *
   * ⚠️ 為何每次 `render()` 都重建
   * ---------------------------
   * `render()` 已經 `replaceChildren()` 四個圖層 —— 但 `#layer-controls`
   * 喺 `.svg-map-wrap` 而唔係 `<svg>` 內，所以**唔會**被 `replaceChildren()`
   * 清走。呢度重建係為咗語言切換（`data-i18n` 文字）同 `aria-pressed`
   * 同步；重建之後一定要**重新綁 listener**（見 `bindLayerToggleButtons`）。
   *
   * 成本：7 個 `<button>` × `innerHTML`。實測唔係熱路徑 —— `render()`
   * 每次手勢只跑一次（`onSettle`），唔係每幀。
   */
  private renderLayerControls(): void {
    const host = this.root.querySelector<HTMLElement>("#layer-controls");
    if (!host) return;
    const dict = this.lang === "zh" ? LAYER_LABEL_ZH : LAYER_LABEL_EN;
    host.innerHTML = LAYER_KEYS.map((key) => {
      const on = this.layerState[key];
      return (
        `<button class="layer-toggle" type="button" data-layer="${key}"` +
        ` data-i18n="layer.${key}" aria-pressed="${on}"` +
        ` title="${dict[key]}">${dict[key]}</button>`
      );
    }).join("");
    this.bindLayerToggleButtons();
    this.applyLayerState();
  }

  /**
   * 將 zone 資料變成**純資料模型**（唔含 DOM）。
   *
   * 為何抽成 public method 而唔係留喺 `render()` 內部
   * ----------------------------------------------
   * `render()` 需要真 DOM（`createElementNS`、`getBoundingClientRect`），
   * 喺 node 環境完全跑唔到 → 即係「zone LOD 政策」同「cluster 正規化」
   * 都只可以靠 Playwright 驗。抽成純函數之後：
   *
   *   · `tests/map-interaction.test.ts` 可以直接餵資料入去，
   *     斷言 cluster 數、淡化比例、label 門檻 —— 全部 node 單測；
   *   · `render()` 只負責「模型 → DOM」嘅機械轉換。
   *
   * @param viewW   目前視窗寬（user unit）—— 用嚟計 label 門檻。
   */
  evaluateZoneModel(viewW: number): ZoneModelEntry[] {
    const cur = this.app.getCurrentChapter();
    const out: ZoneModelEntry[] = [];
    for (const z of this.data.zones.features) {
      const zp = z.properties;
      /*
       * 規則 Z2：**只讀 `zone_type`**（`kind` 係 v1 向後兼容欄位）。
       * 缺失時才 fallback 去 `kind` —— 令未經 B4 migration 嘅 v1 資料
       * 仍然讀得到。
       */
      const zt: string = zp.zone_type ?? zp.kind;
      const styleKey = ZONE_TYPE_STYLE[zt] ?? "nest";
      const ring = (z.geometry as unknown as { coordinates: number[][][] })
        .coordinates[0];
      if (!ring || ring.length < 3) continue;

      const d =
        "M " +
        ring
          .map((pt) => {
            const v = lonlatToViewbox(pt[0], pt[1]);
            return `${v.x.toFixed(6)} ${v.y.toFixed(6)}`;
          })
          .join(" L ") +
        " Z";

      const cxRaw = ring.reduce((a, p) => a + p[0], 0) / ring.length;
      const cyRaw = ring.reduce((a, p) => a + p[1], 0) / ring.length;
      const c = lonlatToViewbox(cxRaw, cyRaw);

      const rUser = zp.radius_m / 102940;
      out.push({
        id: zp.id,
        name: zp.name,
        d,
        styleKey: ZONE_STYLE[styleKey] ? styleKey : "nest",
        pattern: zp.display_style?.pattern ?? "solid",
        evidenced: zp.radius_source === "members",
        cx: c.x,
        cy: c.y,
        emphasized: (zp.chapters || []).includes(cur),
        selected: this.app.getSelectedZoneId() === zp.id,
        showLabel: (rUser * 2) / viewW >= 0.07,
        dangerLevel:
          zp.danger_level === null || zp.danger_level === undefined
            ? null
            : zp.danger_level,
        radiusM: zp.radius_m,
        summary: zp.summary || "",
      });
    }
    /*
     * z-order：面積大嘅先畫（下面），面積細嘅後畫（上面）。
     * 唔咁做嘅話，一個細病窩會被大倖存區蓋住。
     */
    out.sort((a, b) => b.radiusM - a.radiusM);
    return out;
  }

  render(): void {
    /*
     * ⚠️ `rendering` 守衛：本方法會 `replaceChildren()` 重建圖層 →
     * 銷毀當時聚焦嘅地圖元素 → `focusout`（`relatedTarget = null`）。
     * 唔守衛就會喺還原焦點之前清走 `kbWantFocus`（見該欄位註釋）。
     */
    this.rendering = true;
    const cur = this.app.getCurrentChapter();
    this.applyViewBox();
    this.renderLayerControls();

    const content = this.svg.querySelector("#map-content")!;

    /*
     * 內容密度：由 viewBox 寬（唯一輸入）決定。
     *   zoneLod —— zone 畫成 cluster / boundary / full（spec §3.2）
     *
     * ⚠️ 呢個係「點畫」，唔係「畫唔畫」（規則 L1：zone 永遠 render）。
     */
    const zoneLod: ZoneLod = selectZoneLod(this.view.w);
    const locWindow = chapterWindowFor("location");
    const evWindow = chapterWindowFor("event", this.showAllEvents);

    // Active character routes（本章有出現嘅路線）
    const activeRoutes = (this.data.routesByChapter.get(cur) || []).filter(
      (r: RouteFeature) => {
        const span = r.properties.chapters_span;
        return span && cur >= span[0] && cur <= span[1];
      },
    );

    /*
     * Active locations（spec §3.3：本章 ± 5 章）。
     *
     * ⚠️ V2 由 ± 3 放寬到 ± 5。
     * A4 實測：深 zoom 落將軍澳時 location 由 72 個跌到 3 個 —— 一部分
     * 就係 ± 3 太窄。相鄰章節嘅地點係最重要嘅空間上下文；密度問題
     * 由標記聚合（marker aggregation）處理，唔應該靠砍窗口。
     */
    const locationsToShow = this.data.locations.features.filter((l) => {
      // `map_hidden`：由人手核實排除嘅條目（例如「旺角」喺文中係比喻、
      // 「香港」係整體舞台設定）。資料仍然保留喺面板度，只係唔喺地圖
      // 標一個誤導性嘅點。
      if (l.properties.map_hidden) return false;
      const fp = l.properties.first_appearance;
      const chs = l.properties.chapters || [fp];
      return chs.some((c: number) => Math.abs(c - cur) <= locWindow) || fp === cur;
    });

    /*
     * Active events（spec §3.3：本章 ± 1 章，另有「顯示全部」開關）。
     *
     * ⚠️ `evWindow` 開咗開關會係 `Infinity` —— 嗰時要行**全部**章節，
     * 唔可以只 loop ±N（`cur + Infinity` 唔會 match 任何 key）。
     */
    const eventsToShow: EventFeature[] = [];
    if (Number.isFinite(evWindow)) {
      for (let d = -evWindow; d <= evWindow; d++) {
        eventsToShow.push(...(this.data.eventsByChapter.get(cur + d) || []));
      }
    } else {
      for (const list of this.data.eventsByChapter.values()) {
        eventsToShow.push(...list);
      }
    }

    // 只重建標記圖層，底圖 <image> 保持不動（避免每次 render 重新載入 PNG）
    // 每次重建圖層之前清空縮放快取（舊元素已經唔存在）
    this.scaledEls = [];

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

    // Zones（倖存區／病窩／據點）
    //
    // 為何要獨立一層、而且喺標記之下
    // ----------------------------
    // 區域係「面」，用嚟一眼睇到「呢一帶安全／危險」。畫喺標記之下
    // 就唔會遮住地名同事件點。
    //
    // 幾何係多邊形（由 `scripts/merge_zone_dossiers.py` 產生）：
    //   成員地點 ≥3 個 → 凸包 + 200 m 外擴（**證據**）
    //   否則           → 48 邊形近似圓（**估算**，畫虛線）
    // 呢個區分好重要 —— 唔可以令估算睇落同證據一樣確定。
    //
    // ⚠️ V2（B6）：ZONE_STYLE / ZONE_TYPE_STYLE 同資料模型嘅建構搬去
    // `evaluateZoneModel()`（純函數），呢度只負責「模型 → DOM」。
    // 詳見 §「Zone LOD」同 `src/map/ZoneLayer.ts`。

    const zoneModel = this.evaluateZoneModel(this.view.w);
    /*
     * Cluster 正規化（P0-2 / spec §3.2 L-Z0）。
     *
     * 為何要 `markerR(0.008)`：格邊長用**螢幕**尺寸（約 8 px）而唔係
     * 地理尺寸 —— 咁樣簇會隨 zoom 自然分裂，同 location marker
     * 用同一套政策（`render()` 下面 `cell = this.markerR(0.008)`）。
     */
    /** cluster LOD：多邊形淡到 4%、唔畫光暈／脈衝（spec §3.2 L-Z0）。 */
    const zoneIsCluster = zoneLod === "cluster";
    /*
     * `minSep` = badge 直徑 × 1.1（user unit）—— 令「兩 cluster 中心距離
     * 大過兩個 badge 唔會疊」。1.1 係 buffer（避免邊界貼住）。
     *
     * 因為 badge 直徑係 px-anchored（見 `clusterBadgeRadiusUser()`），
     * 呢度要用**同一個 pxPerUser** 反推，唔可以寫死 user unit。
     */
    const clusterSepPx =
      (CLUSTER_BADGE_DIAMETER_PX / 2) * 2 * 1.1;
    const clusterSep = this.userUnitsFor(clusterSepPx);
    const zoneClusters: ZoneClusterEntry[] =
      zoneLod === "cluster"
        ? clusterZones(zoneModel, this.markerR(0.008), clusterSep)
        : [];

    for (const zm of zoneModel) {
      const style = ZONE_STYLE[zm.styleKey] ?? ZONE_STYLE.nest;
      const selected = zm.selected;
      const emphasized = zm.emphasized;
      const d = zm.d;

      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute(
        "class",
        `zone zone-${zm.styleKey}${selected ? " is-selected" : ""}`,
      );
      g.setAttribute("data-zone-id", zm.id);
      g.setAttribute("data-zone-name", zm.name);
      g.setAttribute("data-zone-lod", zoneLod);
      this.markInteractive(g, `區域：${zm.name}`);
      /*
       * 規則 Z3：`danger_level` 為 `null` = 資料**未評估**，唔可以當 0。
       * 所以只有非 null 才寫落 DOM。
       */
      if (zm.dangerLevel !== null) {
        g.setAttribute("data-danger-level", String(zm.dangerLevel));
      }

      /*
       * 外發光：cluster 層唔畫 —— 全港 48 個光暈疊埋會變成一層霧，
       * 反而蓋住底圖嘅道路同建築。
       */
      if (!zoneIsCluster) {
        const glow = document.createElementNS(SVG_NS, "path");
        glow.setAttribute("d", d);
        glow.setAttribute("class", "zone-glow");
        glow.setAttribute("fill", "none");
        glow.setAttribute("stroke", style.glow);
        this.setScaled(glow, "stroke-width", selected ? 0.010 : 0.006);
        glow.setAttribute("opacity", selected ? "0.9" : emphasized ? "0.45" : "0.3");
        g.appendChild(glow);
      }

      const area = document.createElementNS(SVG_NS, "path");
      area.setAttribute("d", d);
      area.setAttribute("class", "zone-area");
      area.setAttribute("fill", style.fill);
      const baseFill = zoneIsCluster ? 0.04 : emphasized ? 0.14 : 0.10;
      area.setAttribute("fill-opacity", String(selected ? 0.22 : baseFill));
      area.setAttribute("stroke", style.stroke);
      this.setScaled(area, "stroke-width", selected ? 0.0022 : 0.0014);
      area.setAttribute(
        "stroke-opacity",
        selected ? "1" : zoneIsCluster ? "0.5" : "0.78",
      );
      /*
       * 規則：唔可以只靠顏色（灰度／色弱可辨）。`display_style.pattern`
       * 由 B4 查表得嚟（`hatch` / `contour` / `noise` / `solid` / `pulse`）。
       * 虛線節奏由 `map.css` 按 `data-pattern` 提供（B6 接手）。
       */
      area.setAttribute("data-pattern", zm.pattern);
      if (zm.pattern === "hatch" || !zm.evidenced) {
        // 估算範圍：虛線，令佢睇落唔同實證範圍一樣確定
        this.setScaled(
          area,
          "stroke-dasharray",
          zm.pattern === "hatch" ? 0.0028 : 0.0055,
        );
      }
      g.appendChild(area);

      /*
       * 掃描光環（病窩專用，CSS 動畫驅動）—— 只有 full 層畫。
       * 中觀層畫會令每個病窩都「跳」，反而干擾閱讀。
       */
      if (zm.styleKey === "nest" && zoneLod === "full") {
        const pulse = document.createElementNS(SVG_NS, "path");
        pulse.setAttribute("d", d);
        pulse.setAttribute("class", "zone-pulse");
        pulse.setAttribute("fill", "none");
        pulse.setAttribute("stroke", style.stroke);
        this.setScaled(pulse, "stroke-width", 0.0018);
        g.appendChild(pulse);
      }

      // 徽記（特別記認）：每個區域一個圖騰，一眼分得出係咩類型
      const badge = document.createElementNS(SVG_NS, "g");
      badge.setAttribute("class", "zone-badge");
      badge.setAttribute("transform", `translate(${zm.cx} ${zm.cy})`);
      // cluster 層冇 polygon 光暈做視覺重量，所以徽記畫大少少
      const badgeBase = zoneIsCluster ? 0.0078 : 0.0062;
      const br = this.markerR(badgeBase);
      const bcircle = document.createElementNS(SVG_NS, "circle");
      bcircle.setAttribute("r", String(br));
      bcircle.setAttribute("fill", "rgba(8, 13, 20, 0.82)");
      bcircle.setAttribute("stroke", style.stroke);
      bcircle.setAttribute("stroke-width", String(br * 0.16));
      badge.appendChild(bcircle);
      const glyph = document.createElementNS(SVG_NS, "path");
      glyph.setAttribute("d", ZONE_GLYPH[style.glyph]);
      glyph.setAttribute("fill", "none");
      glyph.setAttribute("stroke", style.stroke);
      glyph.setAttribute("stroke-width", String(br * 0.24));
      glyph.setAttribute("stroke-linecap", "round");
      glyph.setAttribute("stroke-linejoin", "round");
      glyph.setAttribute(
        "transform",
        `translate(${(-br * 0.46).toFixed(6)} ${(-br * 0.46).toFixed(6)}) scale(${(br * 0.92).toFixed(6)})`,
      );
      badge.appendChild(glyph);
      this.scaledEls.push({ el: badge, attr: "data-r", base: badgeBase });
      g.appendChild(badge);

      const title = document.createElementNS(SVG_NS, "title");
      const srcLabel = zm.evidenced
        ? "範圍由成員地點分佈推導"
        : "範圍係估算（示意）";
      // 規則 Z3：`null` = 未評估，唔可以寫成「0/5」（會變成「好安全」）
      const dangerLabel =
        zm.dangerLevel === null
          ? "危險程度：未評估"
          : `危險程度：${zm.dangerLevel}/5`;
      title.textContent =
        `${zm.name}（${style.label}）\n` +
        `${dangerLabel}\n` +
        `半徑約 ${Math.round(zm.radiusM)} m — ${srcLabel}\n` +
        `${zm.summary}`;
      g.appendChild(title);

      // 區域標籤：只有夠大（畫面 ≥ 7%）才顯示，否則細區域嘅字會疊埋
      // ⚠️ 門檻喺 `evaluateZoneModel()` 計（純函數，可單測）。
      if (zm.showLabel) {
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(zm.cx));
        label.setAttribute("y", String(zm.cy - (zm.radiusM / 102940) * 0.88));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("class", "zone-label");
        label.setAttribute("fill", style.stroke);
        label.setAttribute("font-size", String(this.markerR(0.0042)));
        label.setAttribute("font-weight", "650");
        label.setAttribute("paint-order", "stroke");
        label.setAttribute("stroke", "rgba(8, 13, 20, 0.9)");
        label.setAttribute("stroke-width", String(this.markerR(0.0014)));
        label.setAttribute("stroke-linejoin", "round");
        label.setAttribute("pointer-events", "none");
        label.textContent = zm.name;
        this.scaledEls.push({ el: label, attr: "font-size", base: 0.0042 });
        this.scaledEls.push({ el: label, attr: "stroke-width", base: 0.0014 });
        g.appendChild(label);
      }

      zonesLayer.appendChild(g);
    }

    /*
     * Cluster badge（macro LOD 專用）—— P0-2。
     *
     * 為何仍然逐個 zone 畫 `.zone-area`（唔係真係「只畫一個」）
     * ------------------------------------------------------
     * `tests/map-render.test.ts` Q5 斷言 `.zone-area` 總數 = `zones.geojson`
     * features 數（規則 L1：zone 永遠 render）。cluster 層保留多邊形
     * （fill-opacity 4%）＋ 額外 badge，係 B5 §7 D-8 同一折衷嘅延續。
     */
    for (let i = 0; i < zoneClusters.length; i++) {
      const cl = zoneClusters[i];
      const style =
        ZONE_STYLE[cl.dominant] ?? ZONE_STYLE.nest;
      /*
       * ⚠️ B6 修正（2026-09-22）：badge 半徑**由螢幕 px 反推**，
       * 唔可以再用固定 user unit（見 `ZoneLayer.clusterBadgeRadiusUser()`
       * 同 B6-D5）。spec §3.2 L-Z0 硬性要求渲染直徑落喺 8–12 px；
       * 固定 user unit 會隨 viewW 飄到 29.7–41.2 px（超 3.5–5 倍）。
       *
       * 需要 SVG 嘅 CSS 像素闊（`getBoundingClientRect().width`）——
       * 因為 `preserveAspectRatio="meet"` 之下實際比例係
       * `view.w / rect.width`，唔可以靠 viewBox 自己算。
       */
      const svgW = this.svgWidthPx();
      const r = clusterBadgeRadiusUser(this.view.w, svgW, cl.count);
      if (!(r > 0)) continue;
      const cg = document.createElementNS(SVG_NS, "g");
      cg.setAttribute("class", "zone-cluster");
      cg.setAttribute("data-zone-cluster-count", String(cl.count));
      cg.setAttribute("data-zone-cluster-ids", cl.memberIds.join(","));
      cg.setAttribute("transform", `translate(${cl.x} ${cl.y})`);

      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("class", "zone-cluster-ring");
      ring.setAttribute("r", String(r));
      ring.setAttribute("stroke", style.stroke);
      cg.appendChild(ring);

      const glyph = document.createElementNS(SVG_NS, "path");
      glyph.setAttribute("class", "zone-cluster-glyph");
      glyph.setAttribute("d", ZONE_GLYPH[style.glyph]);
      glyph.setAttribute(
        "transform",
        `translate(${(-r * 0.72).toFixed(6)} ${(-r * 1.15).toFixed(6)}) scale(${(r * 0.5).toFixed(6)})`,
      );
      glyph.setAttribute("stroke", style.stroke);
      glyph.setAttribute("stroke-width", String(r * 0.3));
      cg.appendChild(glyph);

      const txt = document.createElementNS(SVG_NS, "text");
      txt.setAttribute("class", "zone-cluster-count");
      txt.setAttribute("y", String(r * 0.34));
      txt.setAttribute("font-size", String(r * 0.95));
      txt.setAttribute("fill", style.stroke);
      txt.textContent = clusterLabel(cl.count);
      cg.appendChild(txt);

      const ctitle = document.createElementNS(SVG_NS, "title");
      ctitle.textContent = `${cl.count} 個區域喺同一範圍（放大睇細節）`;
      cg.appendChild(ctitle);

      zonesLayer.appendChild(cg);
    }
    // 簇數寫落圖層，方便測試／除錯（唔參與視覺）
    zonesLayer.setAttribute(
      "data-zone-cluster-count",
      String(zoneClusters.length),
    );

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

      /*
       * 收集**連續嘅有效頂點串**，再將每串畫成平滑曲線。
       *
       * 為何唔再逐段畫直線
       * ----------------
       * 用戶反映「路線純粹係點對點好簡陋」。原本每段係獨立嘅
       * `M…L…`，除咗生硬之外，段與段之間冇連續性（轉角係尖角）。
       *
       * 改為：先收集連續嘅有效頂點（遇到無效段就斷開），再用
       * **Catmull-Rom 轉三次 Bézier** 畫成平滑曲線 —— 曲線會穿過
       * 每一個頂點（唔似一般 B-spline 會偏離控制點），適合表達
       * 「角色經過呢啲地方」。
       */
      const runs: Array<Array<{ x: number; y: number }>> = [];
      let run: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < coords.length - 1; i++) {
        const a = wps[i]?.location_id;
        const b = wps[i + 1]?.location_id;
        if (!a || !b || fictionalById.get(a) !== false || fictionalById.get(b) !== false) {
          if (run.length >= 2) runs.push(run);
          run = [];
          continue;
        }
        const p = this.routeVertex(a, coords[i]);
        const q = this.routeVertex(b, coords[i + 1]);
        if (Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6) continue;
        if (run.length === 0) run.push(p);
        run.push(q);
      }
      if (run.length >= 2) runs.push(run);

      const segments: string[] = [];
      for (const r of runs) {
        segments.push(smoothPath(r));
      }
      if (segments.length === 0) continue;

      const d = segments.join(" ");
      const span = route.properties.chapters_span;
      const opacity = cur >= span[0] && cur <= span[1] ? 0.7 : 0.2;
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", d);
      el.setAttribute("class", "route-line");
      el.setAttribute("stroke", route.properties.color || "#F39C12");
      this.setScaled(el, "stroke-width", 0.0015);
      el.setAttribute("fill", "none");
      el.setAttribute("opacity", String(opacity));
      el.setAttribute("data-route-id", route.properties.id);
      el.setAttribute("data-character-name", route.properties.character_name);
      this.markInteractive(
        el,
        `${route.properties.character_name} 路線（ch${span[0]}-${span[1]}）`,
      );
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
        evidenceBacked: hasEvidence(props),
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
      // 標記半徑基準值（會隨縮放調整，見 setScaled）
      const rBase = anyActive ? 0.005 : 0.002;
      const r = this.markerR(rBase);
      const fill = anySelected ? "#ffeb3b" : anyReal ? "#e67e22" : "#9b59b6";

      if (items.length === 1) {
        const el = document.createElementNS(SVG_NS, "circle");
        el.setAttribute("cx", String(head.x));
        el.setAttribute("cy", String(head.y));
        this.setScaled(el, "r", rBase);
        el.setAttribute("class", "location-marker");
        el.setAttribute("fill", fill);
        el.setAttribute("stroke", "#fff");
        this.setScaled(el, "stroke-width", 0.0008);
        el.setAttribute("opacity", String(anyActive ? 0.9 : 0.45));
        el.setAttribute("data-loc-id", head.id);
        el.setAttribute("data-loc-name", head.name);
        this.markInteractive(
          el,
          head.fictional
            ? `地點：${head.name}（ch${head.first}・虛構座標）`
            : `地點：${head.name}（ch${head.first}）`,
        );
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
      this.markInteractive(
        g,
        `${items.length} 個地點喺同一範圍（${head.name} 等）—— 按 Enter 放大`,
      );
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", String(head.x));
      c.setAttribute("cy", String(head.y));
      this.setScaled(c, "r", rBase * 1.35);
      c.setAttribute("fill", fill);
      c.setAttribute("stroke", "#fff");
      this.setScaled(c, "stroke-width", 0.0008);
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
            evidenceBacked: hasEvidence(loc.properties),
          })
        : resolveCoord(props.title, raw[0], raw[1]);
      const { x, y } = lonlatToViewbox(lon, lat);
      const isCurrent = props.chapter === cur;
      const isSelected = this.app.selectedEventId === props.id;
      const rBase = isCurrent ? 0.008 : 0.005;
      const fill = isSelected ? "#ff5252" : isCurrent ? "#e74c3c" : "#f39c12";
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", String(x));
      el.setAttribute("cy", String(y));
      this.setScaled(el, "r", rBase);
      el.setAttribute("class", "event-marker");
      el.setAttribute("fill", fill);
      el.setAttribute("stroke", "#fff");
      this.setScaled(el, "stroke-width", 0.001);
      el.setAttribute("opacity", String(isCurrent ? 1.0 : 0.6));
      el.setAttribute("data-event-id", props.id);
      el.setAttribute("data-event-title", props.title);
      this.markInteractive(el, `事件：${props.title}（ch${props.chapter}）`);
      const titleEl = document.createElementNS(SVG_NS, "title");
      titleEl.textContent = `[ch${props.chapter}] ${props.title}`;
      el.appendChild(titleEl);
      evLayer.appendChild(el);
    }

    /*
     * Zone 圖層啱啱被 `replaceChildren()` 重建，新嘅 `.zone-pulse` 冇
     * `display` 屬性 = 預設會動。如果 `render()` 係喺互動期間發生
     * （例如逐下點縮放），要即刻再暫停返，否則動畫會喺中途復活。
     */
    this.applyZonePulseState();

    /*
     * P0-6：為每個 `.zone-pulse` 寫 `--pulse-index`（0…n-1）。
     *
     * 為何要錯開相位
     * ------------
     * 21 條動畫如果同一個 frame 一齊到 keyframe 邊界，就會產生一個
     * 超長 frame（實測 idle 20.1 fps）。`map.css` 用
     * `animation-delay: calc(var(--pulse-index) * -0.4s)` 將佢哋攤開。
     */
    const pulses = this.svg.querySelectorAll<SVGElement>("#zones-layer .zone-pulse");
    pulses.forEach((p, i) => p.style.setProperty("--pulse-index", String(i)));

    /*
     * ⚠️ `replaceChildren()` 會令 `hidden` 屬性消失，所以重建之後
     * 一定要重新套用圖層開關（P0-4）。`applyLayerState()` 內部有
     * 「值冇變就跳過」短路，所以平移動畫唔會產生額外 DOM 寫入。
     */
    this.applyLayerState();
    // P1-2：圖層啱啱被 replaceChildren() 重建 → 重新決定邊個元素係唯一 Tab stop
    this.applyRovingTabindex();
    this.rendering = false;
  }

  /**
   * 飛到指定章節（Phase H/I）。
   *
   * 計算本章 ± 2 章所有 location 嘅 bounding box，加 25% padding，
   * 再用 `animateViewBox` 平滑轉場。冇 location 就重繪現狀。
   *
   * ⚠️ V2：bbox → viewBox 嘅換算搬入 `map-camera.viewBoxForGeoBounds`
   * （純函數）。舊 code 喺呢度重複計一次 `fx/fy`，同
   * `currentGeoBbox()` 係兩套**唔一致**嘅公式 —— 而 `currentGeoBbox`
   * 嗰邊漏咗 `1/cos(φ₀)`。共用之後唔會再漂移。
   *
   * ⚠️ `animateViewBox` 必須留喺 `resolveCoord` 之後 ——
   * `tests/phase-i.test.ts` 用
   * `/flyToChapter\(_ch: number\): void \{([\s\S]+?)animateViewBox/`
   * 抽 body 去驗證入面有 `resolveCoord`。
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
        evidenceBacked: hasEvidence(loc.properties),
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

    /*
     * 25% padding、最少 0.02° 跨度（避免單點章節造成 0 尺寸 viewBox）、
     * 以及「夾到縮放範圍之內」（否則飛去一個章節之後用戶可以縮到
     * 細過底圖，露出黑邊）全部喺 `viewBoxForGeoBounds` 內部處理。
     */
    const target: ViewBox = viewBoxForGeoBounds(
      BASEMAP_BBOX,
      BASE_VIEW,
      { lon_min: lonMin, lon_max: lonMax, lat_min: latMin, lat_max: latMax },
      { padding: 0.25, minSpan: 0.02, minScale: MIN_SCALE, maxScale: MAX_SCALE },
    );
    // 標記同路線唔跟 viewBox 縮放，所以要即刻重繪（章節已變）。
    this.render();
    this.animateViewBox(target);
  }
}

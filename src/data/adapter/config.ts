/**
 * B3 Data Adapter — runtime 常數（`src/data/adapter/config.ts`）
 *
 * 為何要有呢個檔
 * --------------
 * A3 §2 實測：`map-config.json` 12 個區塊只有 `chapters` 被引用，其餘（資產路徑 /
 * bbox / 投影常數）由 renderer 直接 `import` 檔案 + 硬編碼，同一組常數喺 3 個地方
 * 各自定義。呢個檔將 raw config 收斂成**單一 typed 來源**（規則 D1）：
 * renderer 唔應該再自己解析 raw config 或 `import` asset。
 *
 * 本檔係純函數 + 常數，**冇 side effect、冇 fetch**。
 */

import type { MapConfig } from "../../types/dataset";

/** 由 `map-config.json` 抽出嘅 runtime 常數（renderer 用）。 */
export interface MapRuntimeConfig {
  /** 章節總數（`config.chapters.total`，缺失 → 198）。 */
  chapterTotal: number;
  /** 首個有內容嘅章節。 */
  firstChapterWithContent: number;
  /** 座標系統標籤，例如 `"EPSG:4326"`。 */
  coordinateSystem: string;
  /** 投影方法，例如 `"equirectangular"`。 */
  projection: string;
  /** 標準緯線（投影用）。 */
  standardParallel: number;
  /** 初始視域。`centerLonLat` 可能缺失（v1 config）。 */
  initialView: { centerLonLat: [number, number] | null; zoom: number };
  /** 資產相對路徑（`null` = 資料冇宣告，renderer 自行 fallback）。 */
  assetPaths: {
    basemapPng: string | null;
    basemapLabelsPng: string | null;
    basemapCoords: string | null;
    lodManifest: string | null;
  };
  showScaleBar: boolean;
  /** `spoiler.levels`（0–3）。 */
  spoilerLevels: number;
  /** 預設劇透上限。 */
  defaultSpoilerMax: number;
  provisional: { enabled: boolean; banner: string };
}

/** 章節總數 fallback（同 B2 `DEFAULT_CHAPTER_TOTAL` 一致）。 */
export const DEFAULT_CHAPTER_TOTAL = 198;
const DEFAULT_STANDARD_PARALLEL = 22.36;

/** 全欄位 fallback：任何 config 缺失時都有一個合法 runtime config。 */
export const DEFAULT_MAP_RUNTIME_CONFIG: MapRuntimeConfig = Object.freeze({
  chapterTotal: DEFAULT_CHAPTER_TOTAL,
  firstChapterWithContent: 1,
  coordinateSystem: "EPSG:4326",
  projection: "equirectangular",
  standardParallel: DEFAULT_STANDARD_PARALLEL,
  initialView: { centerLonLat: null, zoom: 1 },
  assetPaths: {
    basemapPng: null,
    basemapLabelsPng: null,
    basemapCoords: null,
    lodManifest: null,
  },
  showScaleBar: false,
  spoilerLevels: 3,
  defaultSpoilerMax: 1,
  provisional: { enabled: false, banner: "" },
}) as MapRuntimeConfig;

/** 數字 guard：唔係有限數字 → fallback。 */
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 字串 guard：空／非字串 → fallback。 */
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/**
 * raw `MapConfig` → runtime 常數。
 *
 * 全部欄位都有 fallback，**唔會 throw**（config 係外部檔案，屬系統邊界）。
 */
export function resolveMapConfig(config: MapConfig | null | undefined): MapRuntimeConfig {
  if (!config) return DEFAULT_MAP_RUNTIME_CONFIG;
  const m = config.map;
  const center = m?.initial_view?.center_lonlat;
  const centerLonLat: [number, number] | null =
    Array.isArray(center) && center.length >= 2 && Number.isFinite(center[0]) && Number.isFinite(center[1])
      ? [center[0], center[1]]
      : null;

  return {
    chapterTotal: num(config.chapters?.total, DEFAULT_CHAPTER_TOTAL),
    firstChapterWithContent: num(config.chapters?.first_chapter_with_content, 1),
    coordinateSystem: str(m?.coordinate_system, DEFAULT_MAP_RUNTIME_CONFIG.coordinateSystem),
    projection: str(m?.projection, DEFAULT_MAP_RUNTIME_CONFIG.projection),
    standardParallel: num(m?.standard_parallel, DEFAULT_STANDARD_PARALLEL),
    initialView: { centerLonLat, zoom: num(m?.initial_view?.zoom, 1) },
    assetPaths: {
      basemapPng: m?.basemap_png ?? null,
      basemapLabelsPng: m?.basemap_labels_png ?? null,
      basemapCoords: m?.basemap_coords ?? null,
      lodManifest: m?.lod_manifest ?? null,
    },
    showScaleBar: m?.show_scale_bar === true,
    spoilerLevels: num(config.spoiler?.levels, 3),
    defaultSpoilerMax: num(config.spoiler?.default_max_level, 1),
    provisional: {
      enabled: config.provisional_mode?.enabled === true,
      banner: config.provisional_mode?.banner ?? "",
    },
  };
}

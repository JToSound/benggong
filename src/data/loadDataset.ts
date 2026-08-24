// 《病港》前端資料載入層
// 由 data/public/ 讀取五個公開檔案，組成型別化嘅 BingGangDataset。
// 所有檔案都係 build 時 bundled（Vite 靜態 import），零 runtime 第三方請求。

import locationsUrl from "../../data/public/locations.geojson?url";
import eventsUrl from "../../data/public/events.geojson?url";
import routesUrl from "../../data/public/routes.geojson?url";
import timelineUrl from "../../data/public/timeline.json?url";
import charactersUrl from "../../data/public/characters.json?url";
import mapConfigUrl from "../../data/public/map-config.json?url";
import type {
  BingGangDataset,
  CharacterRecord,
  EventFeature,
  LocationFeature,
  RouteFeature,
  TimelineRecord,
} from "../types/dataset";

export interface MapConfig {
  map: {
    crs: string;
    renderer: string;
    tiles_local_only: boolean;
    default_base_layer: string;
    base_layers: { id: string; label: string; status?: string; disclaimer?: string; dev_only?: boolean }[];
    initial_view: { center_story_position: [number, number]; zoom: number };
    zoom_range: [number, number];
  };
  scale_profile: { status: string; note: string; meters_per_map_unit: number | null };
  spoiler: { default_max_level: number } & Record<string, unknown>;
  provisional_mode: { enabled: boolean; banner: string };
  sources_enabled: string[];
  sources_reserved: string[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`載入 ${url} 失敗：HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export interface LoadResult {
  dataset: BingGangDataset;
  config: MapConfig;
}

/** 載入全部公開資料 + 地圖配置。任何一個檔案失敗都會 reject。 */
export async function loadDataset(): Promise<LoadResult> {
  const [locations, events, routes, timeline, characters, config] = await Promise.all([
    fetchJson<{ features: LocationFeature[] }>(locationsUrl),
    fetchJson<{ features: EventFeature[] }>(eventsUrl),
    fetchJson<{ features: RouteFeature[] }>(routesUrl),
    fetchJson<TimelineRecord[]>(timelineUrl),
    fetchJson<CharacterRecord[]>(charactersUrl),
    fetchJson<MapConfig>(mapConfigUrl),
  ]);

  const needsReview =
    locations.features.filter((f) => f.properties.review_status === "needs_review").length +
    events.features.filter((f) => f.properties.review_status === "needs_review").length;

  const provisionalEnabled = config.provisional_mode.enabled;
  const meta = provisionalEnabled
    ? {
        provisional: true as const,
        banner: config.provisional_mode.banner,
        reviewed_count:
          locations.features.length + events.features.length - needsReview,
        needs_review_count: needsReview,
      }
    : null;

  return {
    dataset: {
      meta,
      locations: locations.features,
      events: events.features,
      routes: routes.features,
      timeline,
      characters,
    },
    config,
  };
}

/**
 * 劇透過濾：回傳 spoiler_level <= max 嘅記錄。
 * 支援 GeoJSON Feature（properties.spoiler_level）同平記錄（spoiler_level）。
 */
export function filterBySpoiler<T extends { spoiler_level: number }>(
  items: T[],
  maxLevel: number,
): T[] {
  return items.filter((item) => item.spoiler_level <= maxLevel);
}

/** GeoJSON Feature 版本。 */
export function filterFeaturesBySpoiler<
  T extends { properties: { spoiler_level: number } },
>(features: T[], maxLevel: number): T[] {
  return features.filter((f) => f.properties.spoiler_level <= maxLevel);
}

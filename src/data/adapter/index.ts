/**
 * B3 Data Adapter — 對外唯一入口（`src/data/adapter/index.ts`）
 *
 * 規則 D1：任何 component 唔可以直接 `import` `data/public/*.geojson` 或
 * `public/assets/*.json` —— 一律經呢度。
 * 規則 D2：所有 join 經 `indexes.ts`。
 * 規則 D3：`timeline.json` 按需載入（唔 eager）。
 * 規則 D4：`resolveCoord` / `hasEvidence` / `FALLBACK_ANCHORS` 喺 `normalize.ts`。
 *
 * ⚠️ 相容性保證：呢個模組係**新增**嘅，唔會改動 `loadAllData()` / `AppData`
 * 任何簽名或 shape（見 `docs/contracts/b3-interface-contract.md` §6）。
 */

import type {
  ChapterAppearances,
  ChapterSummaries,
  CharacterRecord,
  EventFeature,
  LocationFeature,
  MapConfig,
  RouteFeature,
  TimelineRecord,
  ZoneDossier,
  ZoneFeature,
  ZonesFeatureCollection,
  LocationsFeatureCollection,
  EventsFeatureCollection,
  RoutesFeatureCollection,
  CharactersData,
} from "../../types/dataset";
import type { SearchKind, SearchResult, Waypoint, WorldIndex } from "../../types/state";
import type { ChronicleDoc, ChronicleEntry } from "../loadAllData";
import type { WorldData, RawWorldInput } from "./normalize";
import { normalizeWorld, normalizeDossier } from "./normalize";
import type { IndexBuildMetrics, WorldIndexes } from "./indexes";
import { buildIndexes } from "./indexes";
import type { MapRuntimeConfig } from "./config";
import { searchSearchIndex } from "../searchIndex";

// ─────────────────────────────────────────────────────────────────────────────
// Re-export（令 component 只需要 import 呢個入口）
// ─────────────────────────────────────────────────────────────────────────────

export type { WorldData, MapRuntimeConfig, WorldIndexes, IndexBuildMetrics };
export type { SearchIndexData } from "../searchIndex";
export { resolveMapConfig, DEFAULT_MAP_RUNTIME_CONFIG } from "./config";
export { resolveCoord, hasEvidence, FULL_HK_ANCHORS, zoneTypeOf, ZONE_TYPE_LABEL } from "./normalize";
export type { CoordSource } from "./normalize";
export { buildSearchIndex, searchSearchIndex, createEmptySearchIndex } from "../searchIndex";

// ─────────────────────────────────────────────────────────────────────────────
// Fetch（唯一網絡入口）
// ─────────────────────────────────────────────────────────────────────────────

/** 預設資料根路徑（同 `loadAllData.ts` 一致）。 */
export const DEFAULT_DATA_BASE = "./data/public/";

export interface LoadWorldOptions {
  /** 資料根路徑，預設 `"./data/public/"`。 */
  base?: string;
  /** 注入式 fetch（測試用）；預設 `globalThis.fetch`。 */
  fetchImpl?: typeof fetch;
}

interface ResolvedOptions {
  base: string;
  fetchImpl: typeof fetch;
}

function resolveOptions(opts?: LoadWorldOptions): ResolvedOptions {
  return {
    base: opts?.base ?? DEFAULT_DATA_BASE,
    fetchImpl: opts?.fetchImpl ?? globalThis.fetch.bind(globalThis),
  };
}

async function fetchJSON<T>(opts: ResolvedOptions, file: string): Promise<T> {
  const path = opts.base + file;
  const r = await opts.fetchImpl(path);
  if (!r.ok) throw new Error(`載入 ${path} 失敗：HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    throw new Error(
      `載入 ${path} 時收到 HTML 而唔係 JSON —— 通常代表檔案唔存在（伺服器回退到 index.html）。`,
    );
  }
  try {
    return (await r.json()) as T;
  } catch (e) {
    throw new Error(`解析 ${path} 失敗：${(e as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy state（dossier / timeline）
// ─────────────────────────────────────────────────────────────────────────────

export interface DossierState {
  /** 首屏 = 空 Map；`loadDossiers()` 之後**就地填充**（同一個 reference）。 */
  byZone: Map<string, ZoneDossier>;
  loaded: boolean;
  loading: Promise<Map<string, ZoneDossier>> | null;
}

export interface LazyState<T> {
  value: T | null;
  loading: Promise<T> | null;
}

/** `World`：正規化資料 + 索引 + 量度 + lazy 狀態。 */
export interface World {
  data: WorldData;
  indexes: WorldIndexes;
  metrics: IndexBuildMetrics;
  dossiers: DossierState;
  timeline: LazyState<TimelineRecord[]>;
  /** 載入選項（lazy loader 重用同一 base / fetch）。 */
  readonly loadOptions: ResolvedOptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadWorldData
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 載入 + 正規化 + 建索引。
 *
 * **唔會**載入 `timeline.json`（A8 P1-2）同 `zone-dossiers.json`（A6 lazy）。
 * 需要時用 `loadTimeline()` / `loadDossiers()`。
 */
export async function loadWorldData(opts?: LoadWorldOptions): Promise<World> {
  const ro = resolveOptions(opts);

  const [
    config,
    locations,
    events,
    routes,
    characters,
    zones,
    chronicle,
    chapterAppearances,
    chapterSummaries,
  ] = await Promise.all([
    fetchJSON<MapConfig>(ro, "map-config.json"),
    fetchJSON<LocationsFeatureCollection>(ro, "locations.geojson"),
    fetchJSON<EventsFeatureCollection>(ro, "events.geojson"),
    fetchJSON<RoutesFeatureCollection>(ro, "routes.geojson"),
    fetchJSON<CharactersData>(ro, "characters.json"),
    fetchJSON<ZonesFeatureCollection>(ro, "zones.geojson"),
    fetchJSON<ChronicleDoc>(ro, "chronicle.json"),
    fetchJSON<ChapterAppearances>(ro, "chapter-appearances.json"),
    fetchJSON<ChapterSummaries>(ro, "chapter-summaries.json"),
  ]);

  const raw: RawWorldInput = {
    config,
    locations,
    events,
    routes,
    zones,
    characters,
    chronicle,
    chapterAppearances,
    chapterSummaries,
  };

  const data = normalizeWorld(raw);

  // dossierByZone 嘅 Map 由呢度建立，令 lazy 載入可以就地填充（同一個 reference）。
  const dossierByZone = new Map<string, ZoneDossier>();
  const { indexes, metrics } = buildIndexes(data, { dossierByZone });

  return {
    data,
    indexes,
    metrics,
    dossiers: { byZone: dossierByZone, loaded: false, loading: null },
    timeline: { value: null, loading: null },
    loadOptions: ro,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy loaders
// ─────────────────────────────────────────────────────────────────────────────

interface ZoneDossiersFile {
  schema_version: number;
  dossiers: ZoneDossier[];
}

/**
 * 按需載入 `zone-dossiers.json`（memoized）。首次呼叫才 fetch。
 * 載入後**就地填充** `world.dossiers.byZone`（= `world.indexes.dossierByZone`）。
 */
export function loadDossiers(world: World, opts?: LoadWorldOptions): Promise<Map<string, ZoneDossier>> {
  if (world.dossiers.loading) return world.dossiers.loading;
  const ro = opts ? resolveOptions(opts) : world.loadOptions;
  const p = fetchJSON<ZoneDossiersFile>(ro, "zone-dossiers.json").then((file) => {
    for (const d of file.dossiers ?? []) {
      world.dossiers.byZone.set(d.zone_id, normalizeDossier(d));
    }
    world.dossiers.loaded = true;
    return world.dossiers.byZone;
  });
  world.dossiers.loading = p;
  return p;
}

/** 按需載入 `timeline.json`（規則 D3；`AppData.timeline` 已經唔 eager 載）。 */
export function loadTimeline(world: World, opts?: LoadWorldOptions): Promise<TimelineRecord[]> {
  if (world.timeline.loading) return world.timeline.loading;
  const ro = opts ? resolveOptions(opts) : world.loadOptions;
  const p = fetchJSON<TimelineRecord[]>(ro, "timeline.json").then((rows) => {
    world.timeline.value = rows;
    return rows;
  });
  world.timeline.loading = p;
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// B2 橋接
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由 `World` 造 B2 `WorldIndex`（取代 `buildWorldIndex()` 過渡橋）。
 * 回傳物件**滿足 b2-interface-contract §2.4**，可以直接餵入 `src/state/selectors.ts`。
 */
export function toWorldIndex(world: World): WorldIndex {
  const ix = world.indexes;
  return {
    zones: world.data.zones,
    events: world.data.events,
    routes: world.data.routes,
    locations: world.data.locations,
    characters: world.data.characters,
    chronicle: world.data.chronicle,
    chapterTotal: world.data.runtime.chapterTotal,
    zonesById: ix.zonesById,
    eventsById: ix.eventsById,
    locationsById: ix.locationsById,
    charactersById: ix.charactersById,
    routesById: ix.routesById,
    routesByCharacter: ix.routesByCharacter,
    eventsByZone: ix.eventsByZone,
    zonesByLocation: ix.zonesByLocation,
    dossierByZone: ix.dossierByZone,
    searchIndex: ix.search.entries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Indexed selectors（純函數；component 唔可以自己掃 raw array）
// ─────────────────────────────────────────────────────────────────────────────

export function selectZone(world: World, id: string): ZoneFeature | null {
  return world.indexes.zonesById.get(id) ?? null;
}

export function selectEvent(world: World, id: string): EventFeature | null {
  return world.indexes.eventsById.get(id) ?? null;
}

export function selectLocation(world: World, id: string): LocationFeature | null {
  return world.indexes.locationsById.get(id) ?? null;
}

export function selectCharacter(world: World, id: string): CharacterRecord | null {
  return world.indexes.charactersById.get(id) ?? null;
}

export function selectEventsByZone(world: World, zoneId: string): EventFeature[] {
  return world.indexes.eventsByZone.get(zoneId) ?? [];
}

export function selectEventsByLocation(world: World, locationId: string): EventFeature[] {
  return world.indexes.eventsByLocation.get(locationId) ?? [];
}

export function selectEventsByCharacter(world: World, characterId: string): EventFeature[] {
  return world.indexes.eventsByCharacter.get(characterId) ?? [];
}

/** 地點所屬嘅 zone（由 `zonesByLocation` 反查，唔會線性掃 48 個 zone）。 */
export function selectZonesByLocation(world: World, locationId: string): ZoneFeature[] {
  const ids = world.indexes.zonesByLocation.get(locationId) ?? [];
  const out: ZoneFeature[] = [];
  for (const id of ids) {
    const z = world.indexes.zonesById.get(id);
    if (z) out.push(z);
  }
  return out;
}

export function selectChronicleByPeriod(world: World, period: string): ChronicleEntry[] {
  return world.indexes.chronicleByPeriod.get(period || "_unknown") ?? [];
}

export function selectRouteByCharacter(world: World, characterId: string): RouteFeature | null {
  return world.indexes.routesByCharacter.get(characterId) ?? null;
}

export function selectWaypoints(world: World, routeId: string): Waypoint[] {
  const route = world.indexes.routesById.get(routeId);
  if (!route) return [];
  return route.properties.waypoints.map((w) => ({
    ...w,
    locationName: world.indexes.locationsById.get(w.location_id)?.properties.name ?? null,
  }));
}

/** 同步讀 dossier（未載入 → null）。載入流程見 `loadDossiers()`。 */
export function selectDossier(world: World, zoneId: string): ZoneDossier | null {
  return world.indexes.dossierByZone.get(zoneId) ?? null;
}

/** 5 類搜尋（無硬上限）。 */
export function selectSearchResults(
  world: World,
  kind: SearchKind | null,
  query: string,
): SearchResult[] {
  return searchSearchIndex(world.indexes.search, kind, query);
}

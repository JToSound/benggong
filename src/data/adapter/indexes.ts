/**
 * B3 Data Adapter — 索引層（`src/data/adapter/indexes.ts`）
 *
 * 對應 spec §2.3「必須建立嘅索引」逐條實作。全部用 `Map` / `Set`，
 * **冇任何線性 `find()`**（規則 D2：所有 join 必須經呢度）。
 *
 * 建構時間用 `performance.now()` 量度，結果放 `IndexBuildMetrics`
 * （交付報告要列索引建構時間表）。
 */

import type {
  CharacterRecord,
  EventFeature,
  LocationFeature,
  RouteFeature,
  ZoneDossier,
  ZoneFeature,
} from "../../types/dataset";
import type { ChronicleEntry } from "../loadAllData";
import type { SearchIndexData } from "../searchIndex";
import { buildSearchIndex } from "../searchIndex";
import type { WorldData } from "./normalize";

/** 索引名稱（同時係量度 key）。 */
export type IndexName =
  | "locationsById"
  | "eventsById"
  | "zonesById"
  | "eventsByLocation"
  | "eventsByZone"
  | "charactersById"
  | "eventsByCharacter"
  | "zonesByLocation"
  | "dossierByZone"
  | "chronicleByPeriod"
  | "routesById"
  | "routesByCharacter"
  | "search";

/** spec §2.3 表 + B2 `WorldIndex` 需要嘅補充索引。 */
export interface WorldIndexes {
  // ── spec §2.3 ──
  locationsById: ReadonlyMap<string, LocationFeature>;
  eventsById: ReadonlyMap<string, EventFeature>;
  zonesById: ReadonlyMap<string, ZoneFeature>;
  eventsByLocation: ReadonlyMap<string, EventFeature[]>;
  eventsByZone: ReadonlyMap<string, EventFeature[]>;
  charactersById: ReadonlyMap<string, CharacterRecord>;
  eventsByCharacter: ReadonlyMap<string, EventFeature[]>;
  zonesByLocation: ReadonlyMap<string, string[]>;
  /** ⚠️ lazy：首屏係空 Map，`loadDossiers()` 之後**就地填充**（同一個 reference）。 */
  dossierByZone: ReadonlyMap<string, ZoneDossier>;
  chronicleByPeriod: ReadonlyMap<string, ChronicleEntry[]>;

  // ── B2 `WorldIndex` 需要（additive） ──
  routesById: ReadonlyMap<string, RouteFeature>;
  routesByCharacter: ReadonlyMap<string, RouteFeature>;

  // ── 搜尋 ──
  search: SearchIndexData;
}

export interface IndexBuildMetrics {
  /** 每個索引嘅建構時間（ms）。 */
  perIndex: Record<IndexName, number>;
  totalMs: number;
  /** 索引項數（測試斷言用）。 */
  sizes: Record<IndexName, number>;
}

const INDEX_NAMES: IndexName[] = [
  "locationsById",
  "eventsById",
  "zonesById",
  "eventsByLocation",
  "eventsByZone",
  "charactersById",
  "eventsByCharacter",
  "zonesByLocation",
  "dossierByZone",
  "chronicleByPeriod",
  "routesById",
  "routesByCharacter",
  "search",
];

export interface BuildIndexesOptions {
  /**
   * `dossierByZone` 嘅目標 Map（由 `index.ts` 建立，令 lazy 載入可以**就地填充**）。
   * 唔提供 → 建一個新空 Map。
   */
  dossierByZone?: Map<string, ZoneDossier>;
}

/** 逐項計時。 */
function timed<T>(name: IndexName, per: Record<IndexName, number>, fn: () => T): T {
  const t0 = performance.now();
  const r = fn();
  per[name] = performance.now() - t0;
  return r;
}

function pushInto<K, V>(m: Map<K, V[]>, key: K, value: V): void {
  const list = m.get(key);
  if (list) list.push(value);
  else m.set(key, [value]);
}

/**
 * 建全部索引（純函數；除 `dossierByZone` 之外唔 mutate 輸入）。
 */
export function buildIndexes(
  data: WorldData,
  opts: BuildIndexesOptions = {},
): { indexes: WorldIndexes; metrics: IndexBuildMetrics } {
  const perIndex = Object.fromEntries(INDEX_NAMES.map((n) => [n, 0])) as Record<IndexName, number>;
  const t0 = performance.now();

  // ── locationsById / eventsById / zonesById / charactersById ──
  const locationsById = timed("locationsById", perIndex, () => {
    const m = new Map<string, LocationFeature>();
    for (const f of data.locations) m.set(f.properties.id, f);
    return m;
  });

  const eventsById = timed("eventsById", perIndex, () => {
    const m = new Map<string, EventFeature>();
    for (const f of data.events) m.set(f.properties.id, f);
    return m;
  });

  const zonesById = timed("zonesById", perIndex, () => {
    const m = new Map<string, ZoneFeature>();
    for (const f of data.zones) m.set(f.properties.id, f);
    return m;
  });

  const charactersById = timed("charactersById", perIndex, () => {
    const m = new Map<string, CharacterRecord>();
    for (const c of data.characters) m.set(c.id, c);
    return m;
  });

  // ── eventsByLocation（跳過 location_id === null） ──
  const eventsByLocation = timed("eventsByLocation", perIndex, () => {
    const m = new Map<string, EventFeature[]>();
    for (const ev of data.events) {
      const locId = ev.properties.location_id;
      if (locId) pushInto(m, locId, ev);
    }
    return m;
  });

  // ── zonesByLocation（兩個方向都收，去重） ──
  const zonesByLocation = timed("zonesByLocation", perIndex, () => {
    const m = new Map<string, string[]>();
    const add = (locId: string, zoneId: string) => {
      const list = m.get(locId);
      if (list) {
        if (!list.includes(zoneId)) list.push(zoneId);
      } else m.set(locId, [zoneId]);
    };
    for (const z of data.zones) {
      for (const locId of z.properties.member_location_ids ?? []) add(locId, z.properties.id);
    }
    for (const l of data.locations) {
      for (const zoneId of l.properties.zone_ids ?? []) add(l.properties.id, zoneId);
    }
    return m;
  });

  // ── eventsByZone（zone_id 優先；否則由 location 反查） ──
  const eventsByZone = timed("eventsByZone", perIndex, () => {
    const m = new Map<string, EventFeature[]>();
    // 先為每個 zone 開 key（令 `get(zoneId)` 永遠有值，唔使 `?? []`）。
    for (const z of data.zones) m.set(z.properties.id, []);
    for (const ev of data.events) {
      const explicit = ev.properties.zone_id;
      if (explicit) {
        if (m.has(explicit)) m.get(explicit)!.push(ev);
        continue;
      }
      const locId = ev.properties.location_id;
      if (!locId) continue;
      for (const zoneId of zonesByLocation.get(locId) ?? []) {
        if (m.has(zoneId)) m.get(zoneId)!.push(ev);
      }
    }
    return m;
  });

  // ── eventsByCharacter（`event.characters[]` 實測 173/173 都係合法角色 id） ──
  const eventsByCharacter = timed("eventsByCharacter", perIndex, () => {
    const m = new Map<string, EventFeature[]>();
    for (const ev of data.events) {
      for (const cid of ev.properties.characters ?? []) pushInto(m, cid, ev);
    }
    return m;
  });

  // ── routesById / routesByCharacter（首個命中，同 B2 一致） ──
  const routesById = timed("routesById", perIndex, () => {
    const m = new Map<string, RouteFeature>();
    for (const r of data.routes) m.set(r.properties.id, r);
    return m;
  });

  const routesByCharacter = timed("routesByCharacter", perIndex, () => {
    const m = new Map<string, RouteFeature>();
    for (const r of data.routes) {
      if (!m.has(r.properties.character_id)) m.set(r.properties.character_id, r);
    }
    return m;
  });

  // ── chronicleByPeriod（`story_time.label`；空 label → "_unknown"） ──
  const chronicleByPeriod = timed("chronicleByPeriod", perIndex, () => {
    const m = new Map<string, ChronicleEntry[]>();
    for (const e of data.chronicle) {
      const label = e.story_time?.label || "_unknown";
      pushInto(m, label, e);
    }
    return m;
  });

  // ── dossierByZone（lazy；呢度只提供目標 Map，唔 fetch） ──
  const dossierByZone = timed("dossierByZone", perIndex, () => opts.dossierByZone ?? new Map<string, ZoneDossier>());

  // ── search ──
  const search = timed("search", perIndex, () =>
    buildSearchIndex({
      zones: data.zones,
      events: data.events,
      locations: data.locations,
      characters: data.characters,
      chapterSummaries: data.chapterSummaries,
    }),
  );

  const indexes: WorldIndexes = {
    locationsById,
    eventsById,
    zonesById,
    eventsByLocation,
    eventsByZone,
    charactersById,
    eventsByCharacter,
    zonesByLocation,
    dossierByZone,
    chronicleByPeriod,
    routesById,
    routesByCharacter,
    search,
  };

  const sizes: Record<IndexName, number> = {
    locationsById: locationsById.size,
    eventsById: eventsById.size,
    zonesById: zonesById.size,
    eventsByLocation: eventsByLocation.size,
    eventsByZone: eventsByZone.size,
    charactersById: charactersById.size,
    eventsByCharacter: eventsByCharacter.size,
    zonesByLocation: zonesByLocation.size,
    dossierByZone: dossierByZone.size,
    chronicleByPeriod: chronicleByPeriod.size,
    routesById: routesById.size,
    routesByCharacter: routesByCharacter.size,
    search: search.entries.length,
  };

  return { indexes, metrics: { perIndex, totalMs: performance.now() - t0, sizes } };
}

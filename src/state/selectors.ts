/**
 * World Atlas V2 — Derived selectors（B2 獨佔）
 *
 * 規則 SEL1：component **唔可以**喺內部重算呢啲結果。
 * 規則 SEL2：全部係**純函數** —— 唔讀 DOM、唔讀 store、唔 mutate 輸入。
 *
 * 硬性（D2）：`selectVisibleZones` **完全唔讀 `state.chapter`**。
 * 48 個 zone 永遠全部 render；章節只經 `selectEmphasisZoneIds` 做 emphasis。
 */

import {
  CHRONICLE_PAGE_SIZE,
  DEFAULT_CHAPTER_TOTAL,
  EVENT_CHAPTER_WINDOW,
  type AppState,
  type ChronicleFilters,
  type SearchKind,
  type SearchEntry,
  type SearchResult,
  type Waypoint,
  type WorldIndex,
} from "../types/state";
import type {
  ChapterSummaries,
  CharacterRecord,
  EventFeature,
  EventsFeatureCollection,
  LocationsFeatureCollection,
  RoutesFeatureCollection,
  ZoneDossier,
  ZoneFeature,
  ZoneType,
  ZonesFeatureCollection,
} from "../types/dataset";

// ─────────────────────────────────────────────────────────────────────────────
// 過渡橋：AppData → WorldIndex
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `buildWorldIndex` 嘅輸入。
 *
 * 故意用**結構型別**（唔 import `AppData`），令 B2 唔會綁死 B3 嘅實作。
 * B3 交付 `src/data/adapter/index.ts` 之後可以直接提供 `WorldIndex`。
 */
export interface WorldSourceData {
  zones: ZonesFeatureCollection;
  events: EventsFeatureCollection;
  routes: RoutesFeatureCollection;
  locations: LocationsFeatureCollection;
  characters: CharacterRecord[];
  chronicle: { entries: WorldIndex["chronicle"] };
  chapterSummaries?: ChapterSummaries;
  config?: { chapters?: { total?: number } };
  dossiers?: ZoneDossier[];
}

const ZONE_TYPE_BY_KIND: Record<string, ZoneType> = {
  survivor: "survivor_zone",
  nest: "infected_nest",
  outpost: "contested",
};

const ZONE_TYPE_LABEL: Record<ZoneType, string> = {
  survivor_zone: "倖存區",
  infected_nest: "病窩",
  quarantine: "隔離區",
  contested: "爭議地帶",
  transit: "中轉區",
  unknown: "未知區",
};

/** 前端**只讀** `zone_type`；v1 資料缺失時由 `kind` 確定性推導（規則 Z2）。 */
export function zoneTypeOf(z: ZoneFeature): ZoneType {
  return z.properties.zone_type ?? ZONE_TYPE_BY_KIND[z.properties.kind] ?? "unknown";
}

/** zone 相關章節：v2 `chapter_refs` → v1 `chapters` → `first_appearance`。 */
export function zoneChapters(z: ZoneFeature): number[] {
  const p = z.properties;
  if (p.chapter_refs?.length) return p.chapter_refs;
  if (p.chapters?.length) return p.chapters;
  return p.first_appearance ? [p.first_appearance] : [];
}

function zoneMemberLocations(z: ZoneFeature): string[] {
  const p = z.properties;
  if (p.member_location_ids?.length) return p.member_location_ids;
  return [];
}

/** 建立過渡用 WorldIndex。B3 adapter 上線後會被取代（selector 簽名不變）。 */
export function buildWorldIndex(data: WorldSourceData): WorldIndex {
  const zones = data.zones.features;
  const events = data.events.features;
  const routes = data.routes.features;
  const locations = data.locations.features;
  const characters = data.characters ?? [];
  const chronicle = data.chronicle?.entries ?? [];
  const chapterTotal = data.config?.chapters?.total ?? DEFAULT_CHAPTER_TOTAL;

  const zonesById = new Map<string, ZoneFeature>();
  for (const z of zones) zonesById.set(z.properties.id, z);

  const eventsById = new Map<string, EventFeature>();
  for (const e of events) eventsById.set(e.properties.id, e);

  const locationsById = new Map<string, (typeof locations)[number]>();
  for (const l of locations) locationsById.set(l.properties.id, l);

  const charactersById = new Map<string, CharacterRecord>();
  for (const c of characters) charactersById.set(c.id, c);

  const routesById = new Map<string, (typeof routes)[number]>();
  const routesByCharacter = new Map<string, (typeof routes)[number]>();
  for (const r of routes) {
    routesById.set(r.properties.id, r);
    if (!routesByCharacter.has(r.properties.character_id)) {
      routesByCharacter.set(r.properties.character_id, r);
    }
  }

  // location → zoneIds（兩個方向都收，因為 v1/v2 資料各自補一邊）。
  const zonesByLocation = new Map<string, string[]>();
  const addZoneLoc = (locId: string, zoneId: string) => {
    const list = zonesByLocation.get(locId);
    if (list) {
      if (!list.includes(zoneId)) list.push(zoneId);
    } else {
      zonesByLocation.set(locId, [zoneId]);
    }
  };
  for (const z of zones) {
    for (const locId of zoneMemberLocations(z)) addZoneLoc(locId, z.properties.id);
  }
  for (const l of locations) {
    for (const zoneId of l.properties.zone_ids ?? []) addZoneLoc(l.properties.id, zoneId);
  }

  // event → zone（優先用 v2 `zone_id`，否則用 location 反查）。
  const eventsByZone = new Map<string, EventFeature[]>();
  const pushEventZone = (zoneId: string, ev: EventFeature) => {
    const list = eventsByZone.get(zoneId);
    if (list) list.push(ev);
    else eventsByZone.set(zoneId, [ev]);
  };
  for (const ev of events) {
    const explicit = ev.properties.zone_id;
    if (explicit) {
      pushEventZone(explicit, ev);
      continue;
    }
    const locId = ev.properties.location_id;
    if (!locId) continue;
    for (const zoneId of zonesByLocation.get(locId) ?? []) pushEventZone(zoneId, ev);
  }

  const dossierByZone = new Map<string, ZoneDossier>();
  for (const d of data.dossiers ?? []) dossierByZone.set(d.zone_id, d);

  const searchIndex = buildSearchIndex({
    zones,
    events,
    locations,
    characters,
    chapterSummaries: data.chapterSummaries,
  });

  return {
    zones,
    events,
    routes,
    locations,
    characters,
    chronicle,
    chapterTotal,
    zonesById,
    eventsById,
    locationsById,
    charactersById,
    routesById,
    routesByCharacter,
    eventsByZone,
    zonesByLocation,
    dossierByZone,
    searchIndex,
  };
}

/** 空 index（測試／載入失敗降級用）。 */
export function createEmptyWorldIndex(): WorldIndex {
  return {
    zones: [],
    events: [],
    routes: [],
    locations: [],
    characters: [],
    chronicle: [],
    chapterTotal: DEFAULT_CHAPTER_TOTAL,
    zonesById: new Map(),
    eventsById: new Map(),
    locationsById: new Map(),
    charactersById: new Map(),
    routesById: new Map(),
    routesByCharacter: new Map(),
    eventsByZone: new Map(),
    zonesByLocation: new Map(),
    dossierByZone: new Map(),
    searchIndex: [],
  };
}

function buildSearchIndex(input: {
  zones: ZoneFeature[];
  events: EventFeature[];
  locations: LocationsFeatureCollection["features"];
  characters: CharacterRecord[];
  chapterSummaries?: ChapterSummaries;
}): SearchEntry[] {
  const out: SearchEntry[] = [];
  const push = (e: SearchEntry) => out.push(e);

  for (const c of input.characters) {
    push({
      kind: "character",
      id: c.id,
      label: c.name,
      sublabel: c.role,
      text: `${c.name} ${c.aliases.join(" ")} ${c.description}`.toLowerCase(),
    });
  }
  for (const z of input.zones) {
    const t = zoneTypeOf(z);
    push({
      kind: "zone",
      id: z.properties.id,
      label: z.properties.name,
      sublabel: ZONE_TYPE_LABEL[t],
      text: `${z.properties.name} ${(z.properties.aliases ?? []).join(" ")} ${ZONE_TYPE_LABEL[t]}`.toLowerCase(),
    });
  }
  for (const l of input.locations) {
    push({
      kind: "location",
      id: l.properties.id,
      label: l.properties.display_name || l.properties.name,
      sublabel: l.properties.location_type,
      text: `${l.properties.name} ${l.properties.display_name} ${l.properties.description}`.toLowerCase(),
    });
  }
  for (const e of input.events) {
    push({
      kind: "event",
      id: e.properties.id,
      label: e.properties.title,
      sublabel: `第 ${e.properties.chapter} 章`,
      text: `${e.properties.title} ${e.properties.description}`.toLowerCase(),
    });
  }
  const summaries = input.chapterSummaries ?? {};
  for (const key of Object.keys(summaries)) {
    const n = Number.parseInt(key, 10);
    if (!Number.isFinite(n)) continue;
    const first = summaries[n]?.locations?.[0];
    push({
      kind: "chapter",
      id: `ch_${n}`,
      label: `第 ${n} 章`,
      sublabel: first?.name ?? "",
      text: `第 ${n} 章 ${first?.name ?? ""} ${first?.summary ?? ""}`.toLowerCase(),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 可見 zone。
 *
 * **硬性 D2**：永遠全部 render —— 唔受 `state.chapter` 過濾。
 * 只受 layer flags 控制。
 */
export function selectVisibleZones(state: AppState, world: WorldIndex): ZoneFeature[] {
  const f = state.layers;
  return world.zones.filter((z) => {
    switch (zoneTypeOf(z)) {
      case "survivor_zone":
        return f.zones;
      case "infected_nest":
        return f.nests;
      default:
        // contested / quarantine / transit / unknown → 「據點／爭議區」層
        return f.outposts;
    }
  });
}

/**
 * 章節 emphasis（唔係 filter）。
 * 命中當前章嘅 zone + 目前選中嘅 zone。
 */
export function selectEmphasisZoneIds(state: AppState, world: WorldIndex): Set<string> {
  const ids = new Set<string>();
  if (state.chapter >= 1) {
    for (const z of world.zones) {
      if (zoneChapters(z).includes(state.chapter)) ids.add(z.properties.id);
    }
  }
  if (state.context.kind === "zone") ids.add(state.context.zoneId);
  return ids;
}

export function selectDossier(zoneId: string, world: WorldIndex): ZoneDossier | null {
  return world.dossierByZone.get(zoneId) ?? null;
}

export function selectRelatedEvents(zoneId: string, world: WorldIndex): EventFeature[] {
  return world.eventsByZone.get(zoneId) ?? [];
}

export function selectRelatedCharacters(zoneId: string, world: WorldIndex): CharacterRecord[] {
  const zone = world.zonesById.get(zoneId);
  const out = new Map<string, CharacterRecord>();
  for (const id of zone?.properties.character_ids ?? []) {
    const c = world.charactersById.get(id);
    if (c) out.set(c.id, c);
  }
  if (out.size === 0) {
    // 降級：由關聯事件嘅角色推導（v1 資料冇 character_ids）。
    for (const ev of selectRelatedEvents(zoneId, world)) {
      for (const name of ev.properties.characters) {
        const c = world.characters.find((x) => x.name === name || x.aliases.includes(name));
        if (c) out.set(c.id, c);
      }
    }
  }
  return [...out.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

export function selectRoute(characterId: string, world: WorldIndex): WorldIndex["routes"][number] | null {
  return world.routesByCharacter.get(characterId) ?? null;
}

export function selectWaypoints(routeId: string, world: WorldIndex): Waypoint[] {
  const route = world.routesById.get(routeId);
  if (!route) return [];
  return route.properties.waypoints.map((w) => ({
    ...w,
    locationName: world.locationsById.get(w.location_id)?.properties.name ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Event
// ─────────────────────────────────────────────────────────────────────────────

/** 當前章 ± `EVENT_CHAPTER_WINDOW`，且 spoiler level ≤ 上限。 */
export function selectVisibleEvents(state: AppState, world: WorldIndex): EventFeature[] {
  return world.events.filter(
    (e) =>
      e.properties.spoiler_level <= state.spoilerMax &&
      Math.abs(e.properties.chapter - state.chapter) <= EVENT_CHAPTER_WINDOW,
  );
}

/** 「已隱藏 M 條（spoiler ≥ N）」用：全部事件中 spoiler level 高過上限嘅數量。 */
export function selectHiddenCount(state: AppState, world: WorldIndex): number {
  let n = 0;
  for (const e of world.events) {
    if (e.properties.spoiler_level > state.spoilerMax) n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chronicle
// ─────────────────────────────────────────────────────────────────────────────

function entrySpoilerLevel(entry: WorldIndex["chronicle"][number], world: WorldIndex): number {
  let max = 0;
  for (const id of entry.source_event_ids) {
    const ev = world.eventsById.get(id);
    if (ev) max = Math.max(max, ev.properties.spoiler_level);
  }
  return max;
}

function matchChronicleFilters(
  entry: WorldIndex["chronicle"][number],
  filters: ChronicleFilters,
  world: WorldIndex,
): boolean {
  if (filters.chapter !== null) {
    const hitChapter =
      entry.first_mention_chapter === filters.chapter ||
      entry.chapters.some((c) => c.chapter === filters.chapter);
    if (!hitChapter) return false;
  }
  if (filters.characterId) {
    if (!entry.characters.includes(filters.characterId)) return false;
  }
  if (filters.zoneId) {
    const locId = entry.location_id;
    if (!locId) return false;
    if (!(world.zonesByLocation.get(locId) ?? []).includes(filters.zoneId)) return false;
  }
  if (filters.period) {
    const label = entry.story_time.label ?? "";
    const order = entry.story_time.order;
    if (!label.includes(filters.period) && String(order) !== filters.period) return false;
  }
  if (filters.query) {
    const q = filters.query.toLowerCase();
    if (!`${entry.title} ${entry.summary}`.toLowerCase().includes(q)) return false;
  }
  return entrySpoilerLevel(entry, world) <= filters.spoilerMax;
}

/**
 * 編年史分頁。`cursor` 係 offset（number）。`PAGE_SIZE = CHRONICLE_PAGE_SIZE`。
 */
export function selectChroniclePage(
  filters: ChronicleFilters,
  cursor: number,
  world: WorldIndex,
): { items: WorldIndex["chronicle"]; nextCursor: number | null; total: number } {
  const offset = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  const all = world.chronicle.filter((e) => matchChronicleFilters(e, filters, world));
  const items = all.slice(offset, offset + CHRONICLE_PAGE_SIZE);
  const next = offset + CHRONICLE_PAGE_SIZE;
  return {
    items,
    nextCursor: next < all.length ? next : null,
    total: all.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 5 類搜尋。**冇硬上限**（唔再係 50）；virtualization 由 B7/B8 負責。
 */
export function selectSearchResults(
  kind: SearchKind | null,
  query: string,
  world: WorldIndex,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchResult[] = [];
  for (const entry of world.searchIndex) {
    if (kind && entry.kind !== kind) continue;
    if (!entry.text.includes(q)) continue;
    out.push({
      kind: entry.kind,
      id: entry.id,
      label: entry.label,
      sublabel: entry.sublabel,
    });
  }
  return out;
}

/**
 * Phase F: 統一 data loader.
 * 一次性 load 所有 public dataset 然後 expose 為 typed 結構.
 */

import type {
  LocationsFeatureCollection,
  EventsFeatureCollection,
  RoutesFeatureCollection,
  TimelineRecord,
  CharactersData,
  ChapterAppearances,
  ChapterSummaries,
  MapConfig,
  LocationFeature,
  EventFeature,
  RouteFeature,
} from "../types/dataset";

export type {
  LocationFeature,
  EventFeature,
  RouteFeature,
  MapConfig,
  CharactersData,
  ChapterAppearances,
  ChapterSummaries,
  LocationsFeatureCollection,
  EventsFeatureCollection,
  RoutesFeatureCollection,
  TimelineRecord,
};

export interface AppData {
  config: MapConfig;
  locations: LocationsFeatureCollection;
  events: EventsFeatureCollection;
  routes: RoutesFeatureCollection;
  timeline: TimelineRecord[];
  characters: CharactersData;
  chapterAppearances: ChapterAppearances;
  chapterSummaries: ChapterSummaries;
  // Indices
  locationsById: Map<string, LocationFeature>;
  charactersByName: Map<string, { id: string; name: string; aliases: string[]; color: string; description: string }>;
  eventsByChapter: Map<number, EventFeature[]>;
  routesByChapter: Map<number, RouteFeature[]>;
}

async function fetchJSON<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) {
    throw new Error(`Failed to load ${path}: ${r.status}`);
  }
  return r.json();
}

/** chapters_span [start, end] → 展開成章節陣列（span 缺失時回空陣列）。 */
function spanToChapters(span?: [number, number]): number[] {
  if (!span || span.length < 2) return [];
  const out: number[] = [];
  for (let ch = span[0]; ch <= span[1]; ch++) out.push(ch);
  return out;
}

export async function loadAllData(): Promise<AppData> {
  const base = "./data/public/";

  const [
    config,
    locations,
    events,
    routes,
    timeline,
    characters,
    chapterAppearances,
    chapterSummaries,
  ] = await Promise.all([
    fetchJSON<MapConfig>(base + "map-config.json"),
    fetchJSON<LocationsFeatureCollection>(base + "locations.geojson"),
    fetchJSON<EventsFeatureCollection>(base + "events.geojson"),
    fetchJSON<RoutesFeatureCollection>(base + "routes.geojson"),
    fetchJSON<TimelineRecord[]>(base + "timeline.json"),
    fetchJSON<CharactersData>(base + "characters.json"),
    fetchJSON<ChapterAppearances>(base + "chapter-appearances.json"),
    fetchJSON<ChapterSummaries>(base + "chapter-summaries.json"),
  ]);

  // Build indices
  const locationsById = new Map<string, LocationFeature>();
  for (const f of locations.features) {
    locationsById.set(f.properties.id, f);
  }
  const charactersByName = new Map<string, { id: string; name: string; aliases: string[]; color: string; description: string }>();
  for (const c of characters) {
    charactersByName.set(c.name, c);
  }
  const eventsByChapter = new Map<number, EventFeature[]>();
  for (const f of events.features) {
    const ch = f.properties.chapter;
    if (!eventsByChapter.has(ch)) eventsByChapter.set(ch, []);
    eventsByChapter.get(ch)!.push(f);
  }
  const routesByChapter = new Map<number, RouteFeature[]>();
  for (const f of routes.features) {
    // 按 route 實際出現嘅每一章做索引。
    //
    // 原本只按 chapters_span[0]（起始章）索引，結果全書 198 章之中只有
    // 35 章（18%）會顯示到路線 —— 其餘章節 routesByChapter.get() 回空陣列。
    // 改用 properties.chapters（角色實際出場章節）之後覆蓋 184/198 章。
    const chs: number[] = f.properties.chapters?.length
      ? f.properties.chapters
      : spanToChapters(f.properties.chapters_span);
    for (const ch of chs) {
      if (!routesByChapter.has(ch)) routesByChapter.set(ch, []);
      routesByChapter.get(ch)!.push(f);
    }
  }

  return {
    config,
    locations,
    events,
    routes,
    timeline,
    characters,
    chapterAppearances,
    chapterSummaries,
    locationsById,
    charactersByName,
    eventsByChapter,
    routesByChapter,
  };
}

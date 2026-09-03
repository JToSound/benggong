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
    const ch_start = f.properties.chapters_span?.[0] || 0;
    if (!routesByChapter.has(ch_start)) routesByChapter.set(ch_start, []);
    routesByChapter.get(ch_start)!.push(f);
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

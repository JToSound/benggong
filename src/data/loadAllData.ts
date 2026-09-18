/**
 * Phase F: 統一 data loader.
 * 一次性 load 所有 public dataset 然後 expose 為 typed 結構.
 */

import type {
  ZonesFeatureCollection,
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

/** 編年史條目嘅章節參照。 */
export interface ChronicleChapterRef {
  chapter: number;
  role: "first_mention" | "reveal" | "flashback";
  note?: string;
}

/**
 * 編年史條目 = 故事世界入面嘅一件事。
 *
 * 核心係 `story_time`（幾時發生）同 `first_mention_chapter`（讀者幾時知）
 * 分開 —— 兩者唔同就係「回帶」，即係用戶想要嘅伏筆補完效果。
 */
export interface ChronicleEntry {
  id: string;
  title: string;
  summary: string;
  story_time: { order: number | null; label: string; source: string };
  first_mention_chapter: number;
  chapters: ChronicleChapterRef[];
  foreshadows: string[];
  pays_off: string[];
  location_id: string | null;
  location_name: string | null;
  characters: string[];
  confidence: number;
  source_event_ids: string[];
  review_status: string;
  /** 由 LLM 判斷（階段 2）。 */
  flashback?: boolean;
  reviewed_by?: string;
}

export interface ChronicleDoc {
  version: number;
  season: number;
  generated_by: string;
  entries: ChronicleEntry[];
}

export interface AppData {
  config: MapConfig;
  locations: LocationsFeatureCollection;
  events: EventsFeatureCollection;
  routes: RoutesFeatureCollection;
  timeline: TimelineRecord[];
  characters: CharactersData;
  zones: ZonesFeatureCollection;
  /** 第一季編年史（跨章聚合嘅事件）。見 docs/CHRONICLE_DESIGN.md */
  chronicle: ChronicleDoc;
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
    throw new Error(`載入 ${path} 失敗：HTTP ${r.status}`);
  }
  /*
   * 為何要檢查 content-type
   * ----------------------
   * 當檔案唔存在時，SPA 會回退去 `index.html`，於是 `r.json()` 收到 HTML
   * 而拋出 `SyntaxError: Unexpected token '<'` —— 呢個訊息完全幫唔到手，
   * 用戶唔會知係咩事。
   *
   * 實測踩過：建置期間 `dist/data/public/` 被寫入中，瀏覽器請求到
   * 404 → index.html → 就係呢個錯誤。
   */
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    throw new Error(
      `載入 ${path} 時收到 HTML 而唔係 JSON —— 通常代表檔案唔存在` +
        `（伺服器回退到 index.html）。請確認已跑 npm run build（會自動同步資料）。`,
    );
  }
  try {
    return (await r.json()) as T;
  } catch (e) {
    throw new Error(`解析 ${path} 失敗：${(e as Error).message}`);
  }
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
    zones,
    chronicle,
    chapterAppearances,
    chapterSummaries,
  ] = await Promise.all([
    fetchJSON<MapConfig>(base + "map-config.json"),
    fetchJSON<LocationsFeatureCollection>(base + "locations.geojson"),
    fetchJSON<EventsFeatureCollection>(base + "events.geojson"),
    fetchJSON<RoutesFeatureCollection>(base + "routes.geojson"),
    fetchJSON<TimelineRecord[]>(base + "timeline.json"),
    fetchJSON<CharactersData>(base + "characters.json"),
    fetchJSON<ZonesFeatureCollection>(base + "zones.geojson"),
    fetchJSON<ChronicleDoc>(base + "chronicle.json"),
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
    zones,
    chronicle,
    chapterAppearances,
    chapterSummaries,
    locationsById,
    charactersByName,
    eventsByChapter,
    routesByChapter,
  };
}

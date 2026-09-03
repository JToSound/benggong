// 《病港》Phase B 資料模型 — 對應 data/schemas/*.json
// 《病港2》預留：所有 source 欄位已含 "bing_gang_2"，現階段零內容。

export type SourceId = "bing_gang" | "bing_gang_2";

export type ReviewStatus = "needs_review" | "reviewed" | "verified";

/** 劇透等級：0–3；前端預設只顯示 0–1。 */
export type SpoilerLevel = 0 | 1 | 2 | 3;

export type EventType =
  | "major"
  | "minor"
  | "battle"
  | "discovery"
  | "death"
  | "reunion"
  | "travel"
  | "landmark";

export type LocationPrecision =
  | "district"
  | "approximate"
  | "fictional"
  | "unknown";

export type LocationType =
  | "district"
  | "street"
  | "building"
  | "facility"
  | "fictional"
  | "overseas"
  | "unknown";

export interface StoryPosition {
  x: number; // normalized 0–1
  y: number;
}

interface GeometryPoint {
  type: "Point";
  coordinates: [number, number]; // [lon, lat] EPSG:4326；虛構地點只作 render 投影
}

interface FeatureBase<P> {
  type: "Feature";
  geometry: GeometryPoint;
  properties: P;
}

// ---- Locations ----

export interface LocationProperties {
  id: string;
  name: string;
  display_name: string;
  location_type: LocationType;
  fictional: boolean;
  location_precision: LocationPrecision;
  story_position: StoryPosition;
  description: string; // ≤100 字粵文摘要
  first_appearance: number;
  chapters: number[];
  characters: string[];
  confidence: number;
  review_status: ReviewStatus;
  source: SourceId;
}

export type LocationFeature = FeatureBase<LocationProperties>;

// ---- Events ----

export interface EventProperties {
  id: string;
  title: string;
  description: string; // ≤200 字，不可轉載長段正文
  chapter: number;
  chapter_name: string;
  chapter_refs: number[];
  characters: string[];
  event_type: EventType;
  spoiler_level: SpoilerLevel;
  /** 對應 location id；null = 未指派（待人手審閱或後續 pipeline） */
  location_id: string | null;
  confidence: number;
  review_status: ReviewStatus;
  source: SourceId;
}

export type EventFeature = FeatureBase<EventProperties>;

// ---- Routes ----

export interface RouteWaypoint {
  location_id: string;
  chapter: number;
  note: string; // 粵文短說明
  confidence: number;
}

export interface RouteProperties {
  id: string;
  character_id: string;
  character_name: string;
  color: string;
  chapters_span: [number, number];
  precision: "reference" | "approximate" | "fictional";
  waypoints: RouteWaypoint[];
  source: SourceId;
  review_status: ReviewStatus;
}

export interface RouteFeature {
  type: "Feature";
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
  properties: RouteProperties;
}

// ---- Characters ----

export interface CharacterRecord {
  id: string;
  name: string;
  aliases: string[];
  role: "protagonist" | "main" | "supporting" | "antagonist" | "minor";
  color: string;
  first_appearance: number;
  chapter_refs: number[];
  spoiler_level: SpoilerLevel;
  description: string;
  confidence: number;
  review_status: ReviewStatus;
  portrait_asset_id: string | null;
  source?: SourceId;
}

// ---- Timeline ----

export interface TimelineRecord {
  id: string;
  date_label: string; // 如無可靠日期必須係「按章節先後」
  date_sort: string; // ISO date 或 chNNN
  chapter: number;
  location_id: string | null;
  characters: string[];
  type: EventType;
  spoiler_level: SpoilerLevel;
  description: string;
  confidence: number;
  review_status: ReviewStatus;
  event_id: string | null; // deep link 返地圖
}

// ---- Dataset bundle（前端單一載入點）----

export type FeatureCollection<F> = {
  type: "FeatureCollection";
  features: F[];
};

export type LocationsFeatureCollection = FeatureCollection<LocationFeature>;
export type EventsFeatureCollection = FeatureCollection<EventFeature>;
export type RoutesFeatureCollection = FeatureCollection<RouteFeature>;

export type CharactersData = CharacterRecord[];

/** Phase B legacy: 統一 bundle 包含全部 dataset. Phase F 改用獨立 fetch. */
export interface BingGangDataset {
  meta: {
    provisional: true;
    banner: string;
    reviewed_count: number;
    needs_review_count: number;
  } | null;
  locations: LocationFeature[];
  events: EventFeature[];
  routes: RouteFeature[];
  timeline: TimelineRecord[];
  characters: CharacterRecord[];
}

export interface MapConfig {
  map: {
    renderer: "svg" | "leaflet";
    svg_basemap?: string;
    tiles_local_only: boolean;
    default_base_layer: string;
    base_layers: BaseLayer[];
    initial_view: { center_lonlat?: [number, number]; center_story_position?: [number, number]; zoom: number };
    coordinate_system: string;
    show_scale_bar: boolean;
  };
  scale_profile: {
    status: string;
    note: string;
    meters_per_map_unit: number | null;
  };
  spoiler: {
    levels: 0 | 1 | 2 | 3;
    default_max_level: number;
  };
  provisional_mode: {
    enabled: boolean;
    banner: string;
  };
  sources_enabled: SourceId[];
  sources_reserved: SourceId[];
  chapters?: {
    total: number;
    first_chapter_with_content: number;
  };
}

export interface BaseLayer {
  id: string;
  label: string;
  status: string;
  svg?: string;
  disclaimer?: string;
  dev_only?: boolean;
}

export interface ChapterAppearances {
  generated_at: string;
  total_characters: number;
  appearances: Record<string, {
    first_appearance: number;
    last_appearance: number;
    chapter_count: number;
    chapters: number[];
  }>;
}

export type ChapterSummaries = Record<number, string>;

/** 預設角色配色（master prompt §7.7）。 */
export const CHARACTER_COLORS: Record<string, string> = {
  protagonist: "#E74C3C",
  ha_ching: "#3498DB",
  a_ming: "#2ECC71",
};

/** 其他角色 deterministic palette。 */
export const FALLBACK_PALETTE = ["#F39C12", "#9B59B6", "#1ABC9C", "#E67E22"];

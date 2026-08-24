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

export interface ProvisionalMeta {
  provisional: true;
  banner: string; // 粵文醒目提示
  reviewed_count: number;
  needs_review_count: number;
}

/**
 * 前端資料 bundle：data/public/ 全部檔案嘅型別化集合。
 * provisional mode 下只載入最小 sample，並帶 meta.banner。
 */
export interface BingGangDataset {
  meta: ProvisionalMeta | null; // null = 已有人手 review 嘅正式版
  locations: LocationFeature[];
  events: EventFeature[];
  routes: RouteFeature[];
  timeline: TimelineRecord[];
  characters: CharacterRecord[];
}

/** 預設角色配色（master prompt §7.7）。 */
export const CHARACTER_COLORS: Record<string, string> = {
  protagonist: "#E74C3C",
  ha_ching: "#3498DB",
  a_ming: "#2ECC71",
};

/** 其他角色 deterministic palette。 */
export const FALLBACK_PALETTE = ["#F39C12", "#9B59B6", "#1ABC9C", "#E67E22"];

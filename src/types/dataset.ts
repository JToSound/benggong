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
  /** 由 OSM 建築輪廓／已核實來源取得嘅精確座標（誤差 ~10 m） */
  | "exact"
  | "district"
  | "approximate"
  | "fictional"
  | "unknown";

// ---- Coordinate Integrity（V2 新增，見 spatial-data-contract §4）----
//
// 4 個 coordinate_* 欄位喺 V2 加到全部 spatial layer。用途：令「座標可信度」
// 可稽核、可顯示，避免「未知當已知」。全部 optional —— v1 資料仍然讀得到。

/** 座標證據來源。`legacy` = 舊資料未分類；**唔可以**當作已驗證。 */
export type CoordinateSource =
  | "explicit_text"
  | "cross_chapter_evidence"
  | "zone_inference"
  | "legacy"
  | "manual_geometry";

/** 座標審核狀態。`quarantined` = 已排除出地圖，但資料保留。 */
export type CoordinateReviewStatus =
  | "validated"
  | "auto_corrected"
  | "needs_validation"
  | "quarantined";

/** 全部 spatial layer 共用嘅座標完整性欄位（V2）。 */
export interface CoordinateIntegrity {
  /** 0–1；`unknown` 精度必須係 0.0。 */
  coordinate_confidence?: number;
  coordinate_source?: CoordinateSource;
  coordinate_review_status?: CoordinateReviewStatus;
  /** schema 版本；v1 資料冇呢個欄位。 */
  schema_version?: number;
}

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

export interface LocationProperties extends CoordinateIntegrity {
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
  /** 若座標由 scripts/infer_places.py 推斷得出，記錄推斷 id（可稽核）。 */
  inferred_from?: string;
  /** 同一地點嘅其他寫法（合併之後保留，可追溯）。 */
  aliases?: string[];
  /** 所屬區域 id（倖存區／病窩）；由 derive_zones.py 反向填入。 */
  zone_ids?: string[];
  /** 由地圖標記排除（比喻、整體設定等）。資料仍然保留。 */
  map_hidden?: boolean;
  /** 座標來源說明（人手修正／同章錨定），可稽核。 */
  position_source?: string;
}

export type LocationFeature = FeatureBase<LocationProperties>;

// ---- Events ----

export interface EventProperties extends CoordinateIntegrity {
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
  /** V2：三層 join 得出嘅 zone id；無法確定 → null + needs_validation（spatial §4.2）。 */
  zone_id?: string | null;
}

export type EventFeature = FeatureBase<EventProperties>;

// ---- Routes ----

export interface RouteWaypoint {
  location_id: string;
  chapter: number;
  note: string; // 粵文短說明
  confidence: number;
}

export interface RouteProperties extends CoordinateIntegrity {
  id: string;
  character_id: string;
  character_name: string;
  color: string;
  chapters_span: [number, number];
  /** 角色實際出場嘅章節（最多 50 筆；由 derive_routes_geojson.py 產生）。 */
  chapters?: number[];
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
    /**
     * 舊欄位：指向 `assets/tseung-kwan-o-basemap.svg`，但該檔案從來冇存在過，
     * 而且前端一直硬編碼用 `assets/hk-basemap.png`。保留只為兼容舊資料。
     */
    svg_basemap?: string;
    /** 實際底圖資產（由 `scripts/build_map_lods.py` 產生）。 */
    basemap_png?: string;
    basemap_labels_png?: string;
    basemap_coords?: string;
    /** LOD 圖磚清單；前端據此按縮放切換底圖。 */
    lod_manifest?: string;
    tiles_local_only: boolean;
    default_base_layer: string;
    base_layers: BaseLayer[];
    initial_view: { center_lonlat?: [number, number]; center_story_position?: [number, number]; zoom: number };
    coordinate_system: string;
    projection?: string;
    standard_parallel?: number;
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

export interface ChapterSummaryEntry {
  id: string;
  name: string;
  summary: string;
  confidence: number;
}

export interface ChapterSummary {
  locations: ChapterSummaryEntry[];
}

export type ChapterSummaries = Record<number, ChapterSummary>;

/** 預設角色配色（master prompt §7.7）。 */
export const CHARACTER_COLORS: Record<string, string> = {
  protagonist: "#E74C3C",
  ha_ching: "#3498DB",
  a_ming: "#2ECC71",
};

/** 其他角色 deterministic palette。 */
export const FALLBACK_PALETTE = ["#F39C12", "#9B59B6", "#1ABC9C", "#E67E22"];

// ---- Zones（倖存區／病窩／據點）----

export type ZoneKind = "survivor" | "nest" | "outpost";

// ---- Zone Schema v2（spatial-data-contract §5）----
//
// `kind` 保留作向後兼容，但**前端只讀 `zone_type`**（規則 Z2）。
// 映射：survivor → survivor_zone、nest → infected_nest、outpost → contested。

export type ZoneType =
  | "survivor_zone"
  | "infected_nest"
  | "quarantine"
  | "contested"
  | "transit"
  | "unknown";

export type ZoneStatus = "active" | "collapsed" | "unknown" | "historical";

export type ZoneSpatialPrecision = "verified" | "approximate" | "fictional" | "unknown";

/** 灰度可辨用嘅 pattern（規則：唔可以只靠色，spec §2.4）。 */
export type ZonePattern = "hatch" | "contour" | "noise" | "solid" | "pulse";

/**
 * 顯示樣式由 `zone_type` 查表；**唔存 raw hex**（用 token 名，規則 Z1/§5.2）。
 * 顏色一律由 B1 token 決定，資料層只講「用邊個語意色」。
 */
export interface ZoneDisplayStyle {
  /** 語意色 token 名（例如 `--zone-survivor`），唔係 hex。 */
  fill: string;
  pattern: ZonePattern;
  icon: string;
}

/** zone v2 審核狀態（同 location 嘅 `ReviewStatus` 語意唔同，分開定義）。 */
export type ZoneReviewStatus = "validated" | "auto_inferred" | "needs_validation";

/** 範圍來源：members = 由成員地點分佈推導（證據）；default = 按類型預設（估算）；unknown = 冇證據。 */
export type ZoneRadiusSource = "members" | "default" | "unknown";

/** 座標來源。全部可稽核 —— 唔會出現「來源不明」嘅座標。 */
export type ZoneCoordSource =
  | "locations"
  | "locations_prefix"
  | "district"
  | "osm"
  | "unknown";

/**
 * 區域檔案（dossier）。
 *
 * 由 `scripts/merge_zone_dossiers.py` 從全文抽取 + 確定性合併。
 * 用戶要求嘅「政權種類、人文風格、社會結構」對應 `government`、
 * `culture`、`social_structure`；`kind_votes` 令「點解係呢個分類」
 * 可稽核。
 */
export interface ZoneProperties extends CoordinateIntegrity {
  id: string;
  name: string;
  kind: ZoneKind;
  // ── V2 欄位（全部 optional：v1 資料仍然讀得到，由 B4 migration 補齊） ──
  /** 前端**只讀**呢個（規則 Z2）；缺失時由 `kind` 推導。 */
  zone_type?: ZoneType;
  status?: ZoneStatus;
  /** `unknown` 必須係 `null`，**唔可以亂填**（§5.2）。 */
  danger_level?: number | null;
  spatial_precision?: ZoneSpatialPrecision;
  display_style?: ZoneDisplayStyle;
  chapter_refs?: number[];
  event_ids?: string[];
  character_ids?: string[];
  member_location_ids?: string[];
  dossier_id?: string | null;
  /** v2 審核狀態（同 `kind_votes` 一致 → auto_inferred）。 */
  zone_review_status?: ZoneReviewStatus;
  /** 多代理對 kind 嘅票數分佈。 */
  kind_votes?: Record<string, number>;
  aliases?: string[];
  chapters: number[];
  first_appearance: number | null;
  location_hint?: string | null;
  government?: string | null;
  leadership?: string[];
  social_structure?: string | null;
  economy?: string | null;
  defense?: string | null;
  population?: string | null;
  culture?: string | null;
  notable_features?: string[];
  threats?: string[];
  summary?: string | null;
  evidence?: string | null;
  confidence?: number | null;
  radius_m: number;
  radius_source: ZoneRadiusSource;
  coords_source?: ZoneCoordSource;
  coords_evidence?: string;
  range_evidence?: string;
  sources?: string[];
  source: SourceId;
}

/**
 * 區域用**多邊形**（唔係點）—— 用戶要求「畫晒各個倖存區範圍、病窩範圍」。
 * 所以唔可以用 `FeatureBase`（佢嘅 geometry 係 `GeometryPoint`）。
 */
export interface GeometryPolygon {
  type: "Polygon";
  coordinates: number[][][];
}

export interface ZoneFeature {
  type: "Feature";
  geometry: GeometryPolygon;
  properties: ZoneProperties;
}

export interface ZonesFeatureCollection {
  type: "FeatureCollection";
  features: ZoneFeature[];
}

// ---- Zone Dossier（獨立檔 `data/public/zone-dossiers.json`，spatial §6）----
//
// 規則 DS1：每個 field **只有 evidence 足夠先可填**；不足 → `unknown`，
// UI 顯示「資料未足以確認」（**唔可以**補寫 fiction）。

export interface DossierGovernance {
  system: string;
  authority: string;
  legitimacy: string;
}

export interface DossierSociety {
  population_structure: string;
  daily_life: string;
  culture: string;
}

export interface DossierInfrastructure {
  security: string;
  resources: string;
  mobility: string;
}

export interface DossierRiskProfile {
  threats: string[];
  danger_level: number | null;
}

/** 病窩專用（規則 DS2：用呢組代替 governance / society）。 */
export interface DossierNestProfile {
  threat_signature: string;
  activity_pattern: string;
  affected_radius: string;
}

export interface ZoneDossier {
  schema_version: number;
  id: string;
  zone_id: string;
  /** 最多 180 字粵文概述；不足 → `unknown`。 */
  overview: string;
  governance?: DossierGovernance;
  society?: DossierSociety;
  infrastructure?: DossierInfrastructure;
  risk_profile?: DossierRiskProfile;
  nest_profile?: DossierNestProfile;
  key_characters: string[];
  chapter_refs: number[];
  evidence_sources: string[];
  confidence: number;
  review_status: ZoneReviewStatus;
}

export interface ZoneDossiersFile {
  schema_version: number;
  dossiers: ZoneDossier[];
}

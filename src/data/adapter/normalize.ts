/**
 * B3 Data Adapter — 正規化（`src/data/adapter/normalize.ts`）
 *
 * 職責：raw GeoJSON / JSON → 內部 typed shape。**只做 shape 轉換 + 補預設值**，
 * 唔 fetch、唔建索引（索引見 `indexes.ts`）。
 *
 * 規則 D4：`resolveCoord` / `hasEvidence` / `FALLBACK_ANCHORS` 由 renderer 搬入呢度。
 *
 * 設計原則
 * --------
 * - 每個 `normalizeX()` **唔 mutate 輸入**：用 spread 造新 properties 物件（nested
 *   array 共用 reference，零深拷貝成本），令呼叫者可以放心重用 raw 資料。
 * - 全部欄位都有**確定性 fallback**，唔會 throw（資料係外部檔案，屬系統邊界）。
 * - v1 資料（冇 zone v2 欄位）同 v2 資料都讀得到（規則 Z2 向後兼容）。
 */

import type {
  ChapterAppearances,
  ChapterSummaries,
  CharacterRecord,
  EventFeature,
  EventProperties,
  LocationFeature,
  LocationProperties,
  MapConfig,
  RouteFeature,
  RouteProperties,
  RouteWaypoint,
  ZoneDossier,
  ZoneDisplayStyle,
  ZoneFeature,
  ZoneProperties,
  ZoneType,
} from "../../types/dataset";
import type { ChronicleDoc, ChronicleEntry } from "../loadAllData";
import type { MapRuntimeConfig } from "./config";
import { resolveMapConfig } from "./config";
import { FULL_HK_ANCHORS } from "../fallbackAnchors";

/**
 * 規則 D4：`FULL_HK_ANCHORS` 由 adapter re-export，令下游只需要 import 呢個入口。
 *
 * ⚠️ 實際資料仍然住喺 `src/data/fallbackAnchors.ts` —— 因為
 * `tests/phase-i.test.ts` **直接讀該檔內容**做斷言（`readFileSync`），
 * 搬走內容會令該測試紅，而該檔唔屬 B3 allowlist。詳見
 * `docs/contracts/b3-interface-contract.md` §7 D-1。
 */
export { FULL_HK_ANCHORS };
export type { FullHKAnchor } from "../fallbackAnchors";

// ─────────────────────────────────────────────────────────────────────────────
// 規則 D4：座標解析（由 SvgMap.ts 搬入）
// ─────────────────────────────────────────────────────────────────────────────

/** 座標來源，方便除錯同測試。 */
export type CoordSource = "fallback" | "full-hk" | "raw";

export interface CoordAnchor {
  lon: number;
  lat: number;
}

/**
 * 虛構／離網故事地點嘅人工錨點（Phase I 人手核對過）。
 *
 * ⚠️ 暫時同 `src/components/SvgMap.ts` 內嘅同名表並存 —— 因為 `SvgMap.ts`
 * 唔屬 B3 allowlist（B5 正並行改寫）。B5 接手之後應該改為由呢度 import，
 * 呢份就係單一來源（見 b3-interface-contract §7 D-1）。
 */
export const FALLBACK_ANCHORS: Record<string, CoordAnchor> = {
  // Tseung Kwan O fictional / off-grid
  "艾寶琳倖存區": { lon: 114.27, lat: 22.31 },
  "艾寶琳": { lon: 114.27, lat: 22.31 },
  "寶琳倖存區": { lon: 114.27, lat: 22.31 },
  "病者之都": { lon: 114.2, lat: 22.3 },
  "病者平權組織": { lon: 114.27, lat: 22.32 },
  "不良人": { lon: 114.3, lat: 22.3 },
  "大本營": { lon: 114.265, lat: 22.315 },
  "大本營市集": { lon: 114.265, lat: 22.318 },
  "將軍澳地鐵站": { lon: 114.26, lat: 22.318 },
  "坑口地鐵站": { lon: 114.265, lat: 22.316 },
  "調景嶺地鐵站": { lon: 114.255, lat: 22.305 },
  "寶琳地鐵站": { lon: 114.255, lat: 22.32 },
  "日出康城地鐵站": { lon: 114.275, lat: 22.295 },
  "康城": { lon: 114.275, lat: 22.295 },
  "將軍澳醫院": { lon: 114.25, lat: 22.32 },
  "調景嶺體育館": { lon: 114.255, lat: 22.31 },
  "香港知專設計學院": { lon: 114.262, lat: 22.314 },
  "TKO Spot": { lon: 114.26, lat: 22.31 },
  "寶盈花園": { lon: 114.262, lat: 22.317 },
  "將軍澳中心": { lon: 114.265, lat: 22.318 },
  "東港城": { lon: 114.265, lat: 22.317 },
  "PopCorn": { lon: 114.265, lat: 22.317 },
  "MCP": { lon: 114.265, lat: 22.318 },
  "尚德": { lon: 114.262, lat: 22.318 },
  "彩明": { lon: 114.265, lat: 22.316 },
  "厚德": { lon: 114.262, lat: 22.318 },
  "唐明": { lon: 114.265, lat: 22.316 },
  "富康": { lon: 114.262, lat: 22.318 },
  "英明": { lon: 114.265, lat: 22.316 },
  "廣明": { lon: 114.265, lat: 22.316 },
  "景明": { lon: 114.265, lat: 22.316 },
  "港澳碼頭": { lon: 114.15, lat: 22.29 },
  "中環碼頭": { lon: 114.158, lat: 22.285 },
  "尖沙咀碼頭": { lon: 114.17, lat: 22.295 },
};

/**
 * 地點係唔係有「可稽核嘅座標證據」。
 *
 * ⚠️ 為何唔可以只用 `inferred_from`：`scripts/anchor_fictional_locations.py`
 * 把虛構地點錨定到父項並升級為 `approximate` 之後**冇** `inferred_from` ——
 * 結果硬編碼錨點再次覆蓋已核實座標（路線最長線段 4,457 m → 7,729 m）。
 * 只要有任何一種來源記錄，就唔應該被硬編碼猜測覆蓋。
 */
export function hasEvidence(p: { inferred_from?: string; position_source?: string }): boolean {
  return Boolean(p.inferred_from || p.position_source);
}

/**
 * 座標解析（四層）。
 *
 * 0. **資料集自帶座標（有證據支持）** — 最高優先
 * 1. `FALLBACK_ANCHORS` — Phase I 人手估算嘅錨點
 * 2. `FULL_HK_ANCHORS` — Phase I 由 OSM 抽出嘅 503 個 landmark
 * 3. 原始 lon/lat
 *
 * 有 `inferred_from`（可稽核嘅證據來源）嘅座標優先；冇嘅話用返硬編碼錨點。
 */
export function resolveCoord(
  name: string,
  lon: number,
  lat: number,
  opts?: { evidenceBacked?: boolean },
): { lon: number; lat: number; source: CoordSource } {
  if (opts?.evidenceBacked) return { lon, lat, source: "raw" };
  const curated = FALLBACK_ANCHORS[name];
  if (curated) return { lon: curated.lon, lat: curated.lat, source: "fallback" };
  const fullHk = FULL_HK_ANCHORS[name];
  if (fullHk) return { lon: fullHk.lon, lat: fullHk.lat, source: "full-hk" };
  return { lon, lat, source: "raw" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone v2 確定性 fallback（規則 Z2）
// ─────────────────────────────────────────────────────────────────────────────

const ZONE_TYPE_BY_KIND: Record<string, ZoneType> = {
  survivor: "survivor_zone",
  nest: "infected_nest",
  outpost: "contested",
};

/** v1 `kind` → v2 `zone_type`（確定性映射，spec §5.2）。 */
export function zoneTypeFromKind(kind: string | undefined): ZoneType {
  return (kind && ZONE_TYPE_BY_KIND[kind]) || "unknown";
}

/** 由 `zone_type` 查表嘅 `display_style`（token 名，**唔存 raw hex**）。 */
export const ZONE_DISPLAY_STYLE_BY_TYPE: Record<ZoneType, ZoneDisplayStyle> = {
  survivor_zone: { fill: "--zone-survivor", pattern: "contour", icon: "shield" },
  infected_nest: { fill: "--zone-nest", pattern: "hatch", icon: "virus" },
  quarantine: { fill: "--zone-quarantine", pattern: "hatch", icon: "gate" },
  contested: { fill: "--zone-contested", pattern: "contour", icon: "crossed-swords" },
  transit: { fill: "--zone-unknown", pattern: "solid", icon: "route" },
  unknown: { fill: "--zone-unknown", pattern: "noise", icon: "question" },
};

/** `zone_type` 中文標籤（legend / search sublabel 用）。 */
export const ZONE_TYPE_LABEL: Record<ZoneType, string> = {
  survivor_zone: "倖存區",
  infected_nest: "病窩",
  quarantine: "隔離區",
  contested: "爭議地帶",
  transit: "中轉區",
  unknown: "未知區",
};

/** 前端**只讀** `zone_type`；缺失時由 `kind` 確定性推導（規則 Z2）。 */
export function zoneTypeOf(z: ZoneFeature): ZoneType {
  return z.properties.zone_type ?? zoneTypeFromKind(z.properties.kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐 feature 正規化
// ─────────────────────────────────────────────────────────────────────────────

function arr<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v : [];
}

/** zone：補 `zone_type` / `display_style` / v2 陣列欄位 / `dossier_id`。 */
export function normalizeZone(zone: ZoneFeature): ZoneFeature {
  const p = zone.properties;
  const zoneType = p.zone_type ?? zoneTypeFromKind(p.kind);
  const props: ZoneProperties = {
    ...p,
    zone_type: zoneType,
    display_style: p.display_style ?? ZONE_DISPLAY_STYLE_BY_TYPE[zoneType],
    danger_level: p.danger_level ?? null,
    status: p.status ?? "unknown",
    spatial_precision: p.spatial_precision ?? "unknown",
    chapter_refs: p.chapter_refs?.length ? p.chapter_refs : arr(p.chapters),
    event_ids: arr(p.event_ids),
    character_ids: arr(p.character_ids),
    member_location_ids: arr(p.member_location_ids),
    dossier_id: p.dossier_id ?? null,
    zone_review_status: p.zone_review_status ?? "needs_validation",
    aliases: arr(p.aliases),
    chapters: arr(p.chapters),
    threats: arr(p.threats),
    notable_features: arr(p.notable_features),
    leadership: arr(p.leadership),
    sources: arr(p.sources),
  };
  return { ...zone, properties: props };
}

/** location：補 `zone_ids` / `aliases`。 */
export function normalizeLocation(loc: LocationFeature): LocationFeature {
  const p = loc.properties;
  const props: LocationProperties = {
    ...p,
    zone_ids: arr(p.zone_ids),
    aliases: arr(p.aliases),
    characters: arr(p.characters),
    chapters: arr(p.chapters),
  };
  return { ...loc, properties: props };
}

/** event：補 `zone_id`（`null` 而非 undefined）/ 陣列欄位。 */
export function normalizeEvent(ev: EventFeature): EventFeature {
  const p = ev.properties;
  const props: EventProperties = {
    ...p,
    zone_id: p.zone_id ?? null,
    characters: arr(p.characters),
    chapter_refs: p.chapter_refs?.length ? p.chapter_refs : [p.chapter],
  };
  return { ...ev, properties: props };
}

/** route waypoint：保留 B4 新增嘅 `coordinate_*` 欄位（原樣）。 */
export function normalizeWaypoint(w: RouteWaypoint): RouteWaypoint {
  return { ...w };
}

/** route：補 `chapters` / waypoints 正規化。 */
export function normalizeRoute(route: RouteFeature): RouteFeature {
  const p = route.properties;
  const props: RouteProperties = {
    ...p,
    chapters: arr(p.chapters),
    waypoints: arr(p.waypoints).map(normalizeWaypoint),
  };
  return { ...route, properties: props };
}

/** character：補 `aliases` / `chapter_refs`。 */
export function normalizeCharacter(c: CharacterRecord): CharacterRecord {
  return { ...c, aliases: arr(c.aliases), chapter_refs: arr(c.chapter_refs) };
}

/** chronicle entry：補全部陣列欄位。 */
export function normalizeChronicleEntry(e: ChronicleEntry): ChronicleEntry {
  return {
    ...e,
    chapters: arr(e.chapters),
    foreshadows: arr(e.foreshadows),
    pays_off: arr(e.pays_off),
    characters: arr(e.characters),
    source_event_ids: arr(e.source_event_ids),
    location_id: e.location_id ?? null,
    location_name: e.location_name ?? null,
  };
}

/** zone-dossiers.json 嘅一筆 dossier（原樣保留；只補 `key_characters`）。 */
export function normalizeDossier(d: ZoneDossier): ZoneDossier {
  return { ...d, key_characters: arr(d.key_characters), chapter_refs: arr(d.chapter_refs), evidence_sources: arr(d.evidence_sources) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 整批正規化
// ─────────────────────────────────────────────────────────────────────────────

/** `loadWorldData()` 收到嘅 raw 輸入（fetch 之後、normalize 之前）。 */
export interface RawWorldInput {
  config: MapConfig;
  locations: { features: LocationFeature[] };
  events: { features: EventFeature[] };
  routes: { features: RouteFeature[] };
  zones: { features: ZoneFeature[] };
  characters: CharacterRecord[];
  chronicle: ChronicleDoc;
  chapterAppearances: ChapterAppearances;
  chapterSummaries: ChapterSummaries;
}

/** 正規化後嘅資料容器（索引唔喺呢度；見 `indexes.ts`）。 */
export interface WorldData {
  /** 原始 map-config（B4 產生）。 */
  config: MapConfig;
  /** 由 config 抽出嘅 runtime 常數（renderer 唔應該自己解析 raw config）。 */
  runtime: MapRuntimeConfig;
  locations: LocationFeature[];
  events: EventFeature[];
  routes: RouteFeature[];
  zones: ZoneFeature[];
  characters: CharacterRecord[];
  chronicle: ChronicleEntry[];
  chapterAppearances: ChapterAppearances;
  chapterSummaries: ChapterSummaries;
}

/** raw → `WorldData`（純函數，唔 mutate 輸入）。 */
export function normalizeWorld(raw: RawWorldInput): WorldData {
  return {
    config: raw.config,
    runtime: resolveMapConfig(raw.config),
    locations: raw.locations.features.map(normalizeLocation),
    events: raw.events.features.map(normalizeEvent),
    routes: raw.routes.features.map(normalizeRoute),
    zones: raw.zones.features.map(normalizeZone),
    characters: (raw.characters ?? []).map(normalizeCharacter),
    chronicle: (raw.chronicle?.entries ?? []).map(normalizeChronicleEntry),
    chapterAppearances: raw.chapterAppearances,
    chapterSummaries: raw.chapterSummaries ?? {},
  };
}

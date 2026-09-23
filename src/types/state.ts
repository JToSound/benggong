/**
 * World Atlas V2 — State 型別（B2 獨佔）
 *
 * 呢個檔係 **state contract 嘅單一型別來源**。所有下游 agent（B3 / B5 / B6 /
 * B7 / B8 / B9）只可以**讀**，需要加欄位要開 PR 畀 B2（migration plan §3.2）。
 *
 * 對應規格：
 *   - `docs/specs/world-atlas-v2-component-state-contract.md` §1.3–§1.5
 *   - `docs/specs/world-atlas-v2-information-architecture.md` §2、§3
 *   - `docs/contracts/b2-interface-contract.md` §2
 */

import type {
  CharacterRecord,
  EventFeature,
  LocationFeature,
  RouteFeature,
  RouteWaypoint,
  ZoneDossier,
  ZoneFeature,
} from "./dataset";
import type { ChronicleEntry } from "../data/loadAllData";

// ─────────────────────────────────────────────────────────────────────────────
// 基礎
// ─────────────────────────────────────────────────────────────────────────────

/** 地圖視域（user units，同 SVG viewBox 同一座標系）。 */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Theme = "dark" | "light";

/** 主視圖（D3：預設 map）。 */
export type ViewMode = "map" | "chronicle";

export type SheetSnap = "peek" | "half" | "full";

export type SearchKind = "character" | "zone" | "location" | "event" | "chapter";

/** 非阻塞錯誤（規則：唔可以 throw 到 uncaught，唔可以污染「零 console error」）。 */
export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  at: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer flags（IA §6）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 7 個圖層開關。預設值見 `DEFAULT_LAYERS`：
 * zones / nests / outposts / events / detail = ON，routes / periods = OFF。
 */
export interface LayerFlags {
  /** 倖存區（`zone_type = survivor_zone`）。 */
  zones: boolean;
  /** 病窩／危險區（`infected_nest`）。 */
  nests: boolean;
  /** 據點／爭議區（`contested` / `quarantine` / `transit` / `unknown`）。 */
  outposts: boolean;
  events: boolean;
  /** 角色旅程（route polyline + waypoint）。 */
  routes: boolean;
  /** 時期分層／流向。 */
  periods: boolean;
  /** 地圖細節（道路／樓宇／POI，LOD 控制）。 */
  detail: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// PrimaryContext（IA §2 —— 同一時間只有一個）
// ─────────────────────────────────────────────────────────────────────────────

export interface ChronicleFilters {
  chapter: number | null;
  period: string | null;
  zoneId: string | null;
  characterId: string | null;
  spoilerMax: 0 | 1 | 2 | 3;
  query: string;
}

/**
 * 主 context union（10 個 kind）。
 *
 * ⚠️ `measure` 比 IA §2 多一個 `ids` 欄位 —— URL 參數 `?measure=<csv>` 需要
 * 承載 id 清單先做到 round-trip（見 b2-interface-contract §2.5，需主代理追認）。
 */
export type PrimaryContext =
  | { kind: "explore" }
  | { kind: "search"; query: string }
  | { kind: "zone"; zoneId: string }
  | { kind: "event"; eventId: string }
  | { kind: "location"; locationId: string }
  | { kind: "character"; characterId: string }
  | { kind: "route"; characterId: string }
  | { kind: "chronicle"; filters: ChronicleFilters }
  | { kind: "chapter"; issueIndex: number }
  | { kind: "measure"; ids: string[] };

export type ContextKind = PrimaryContext["kind"];

// ─────────────────────────────────────────────────────────────────────────────
// AppState（唯一 state 來源）
// ─────────────────────────────────────────────────────────────────────────────

export interface AppState {
  /** 主 context（唯一）。 */
  context: PrimaryContext;

  /** 劇透上限（D4：預設 1）。 */
  spoilerMax: 0 | 1 | 2 | 3;
  layers: LayerFlags;
  /** 1..chapterTotal。**唔過濾 zone**，只做 emphasis（D2）。 */
  chapter: number;
  /** D1：dark-first，唔跟系統偏好。 */
  theme: Theme;
  view: ViewMode;

  /** 地圖視域；**唔入 URL**（spec §1.4）。 */
  viewport: Viewport;

  /** mobile bottom sheet 3 段 snap。 */
  sheetSnap: SheetSnap;
  searchKind: SearchKind | null;
  /** focus restoration target（a11y）。 */
  pendingFocus: string | null;
  loading: { map: boolean; data: boolean };
  /** 非阻塞錯誤清單（最新喺最後）。 */
  errors: AppError[];
}

// ─────────────────────────────────────────────────────────────────────────────
// WorldIndex（selector 嘅輸入契約；B3 adapter 負責提供）
// ─────────────────────────────────────────────────────────────────────────────

/** 搜尋索引嘅一筆記錄（倒排／前綴索引嘅扁平化形式）。 */
export interface SearchEntry {
  kind: SearchKind;
  id: string;
  label: string;
  sublabel: string;
  /** 已 lowercase 嘅可搜尋文字（label + sublabel + aliases）。 */
  text: string;
}

export interface SearchResult {
  kind: SearchKind;
  id: string;
  label: string;
  sublabel: string;
}

/** route waypoint + 解析後嘅地點名（UI 唔應該顯示原始 id）。 */
export interface Waypoint extends RouteWaypoint {
  locationName: string | null;
}

/**
 * Selector 需要嘅 read model。
 *
 * B2 提供 `buildWorldIndex(data)` 作**過渡橋**；B3 交付
 * `src/data/adapter/index.ts` 之後會取代佢，selector 簽名唔變。
 */
export interface WorldIndex {
  zones: ZoneFeature[];
  events: EventFeature[];
  routes: RouteFeature[];
  locations: LocationFeature[];
  characters: CharacterRecord[];
  chronicle: ChronicleEntry[];

  chapterTotal: number;

  zonesById: ReadonlyMap<string, ZoneFeature>;
  eventsById: ReadonlyMap<string, EventFeature>;
  locationsById: ReadonlyMap<string, LocationFeature>;
  charactersById: ReadonlyMap<string, CharacterRecord>;
  routesById: ReadonlyMap<string, RouteFeature>;
  routesByCharacter: ReadonlyMap<string, RouteFeature>;
  eventsByZone: ReadonlyMap<string, EventFeature[]>;
  zonesByLocation: ReadonlyMap<string, string[]>;
  dossierByZone: ReadonlyMap<string, ZoneDossier>;
  searchIndex: SearchEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// URL 驗證
// ─────────────────────────────────────────────────────────────────────────────

/** URL 參數可以指向嘅 entity 種類（`route` 嘅值係 characterId）。 */
export type IdKind = "zone" | "event" | "location" | "character" | "route";

/**
 * `fromUrl` 嘅驗證 context。
 *
 * - 唔提供 → 只做**語法**檢查（長度 / 控制字元 / 字元集）。
 * - 提供 `isValidId` → 額外做**語意**檢查（id 真係存在）。
 */
export interface UrlValidationContext {
  chapterTotal?: number;
  isValidId?: (kind: IdKind, id: string) => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 預設值
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LAYERS: Readonly<LayerFlags> = Object.freeze({
  zones: true,
  nests: true,
  outposts: true,
  events: true,
  routes: false,
  periods: false,
  detail: true,
});

export const DEFAULT_SPOILER_MAX: 0 | 1 | 2 | 3 = 1;
export const DEFAULT_CHAPTER = 1;
export const DEFAULT_CHAPTER_TOTAL = 198;
export const DEFAULT_VIEW: ViewMode = "map";
export const DEFAULT_THEME: Theme = "dark";

/** 事件顯示窗口（當前章 ±N）。 */
export const EVENT_CHAPTER_WINDOW = 3;
/** Chronicle 分頁大小。 */
export const CHRONICLE_PAGE_SIZE = 50;
/** URL id 長度上限（超出視為無效）。 */
export const MAX_ID_LENGTH = 200;

export const DEFAULT_VIEWPORT: Readonly<Viewport> = Object.freeze({
  x: 0,
  y: 0,
  w: 1,
  h: 1,
});

export function defaultFilters(): ChronicleFilters {
  return {
    chapter: null,
    period: null,
    zoneId: null,
    characterId: null,
    spoilerMax: DEFAULT_SPOILER_MAX,
    query: "",
  };
}

/** 建立初始 state（`overrides` 用嚟注入持久化值／測試值）。 */
export function createInitialState(overrides: Partial<AppState> = {}): AppState {
  return {
    context: { kind: "explore" },
    spoilerMax: DEFAULT_SPOILER_MAX,
    layers: { ...DEFAULT_LAYERS },
    chapter: DEFAULT_CHAPTER,
    theme: DEFAULT_THEME,
    view: DEFAULT_VIEW,
    viewport: { ...DEFAULT_VIEWPORT },
    sheetSnap: "half",
    searchKind: null,
    pendingFocus: null,
    loading: { map: false, data: false },
    errors: [],
    ...overrides,
  };
}

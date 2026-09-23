# B3 Data Adapter — 介面契約（Interface Contract）

> 子代理：**B3 Data Adapter**｜Branch：`refactor/world-atlas-v2`
> 主要規格：`docs/specs/world-atlas-v2-component-state-contract.md` §1.5、§2（規則 D1–D4）、
> `docs/specs/world-atlas-v2-information-architecture.md` §8、
> `docs/specs/world-atlas-v2-rendering-lod-strategy.md` §6.3
> 依據審計：`docs/audits/data-performance-audit.md`（A8，P1-2／P1-4）、
> `docs/audits/frontend-architecture-audit.md`（A3 §4）
> 上游契約：`docs/contracts/b4-interface-contract.md`（資料 shape）、`docs/contracts/b2-interface-contract.md`（state / selector）
> **本檔先寫，後實作**（spec §4.4、migration plan §8）。所有文字用粵文。

---

## 0. 一句話總結

B3 建立 **唯一資料邊界**：`src/data/adapter/`。所有 raw GeoJSON / JSON 只可以經呢度入嚟；
component 唔可以再 `features.find()/filter()` 掃 raw array，唔可以自己 fetch。

**最重要嘅保證**：

> ### 🚧 `loadAllData()` 嘅函式簽名同 `AppData` 嘅 shape **完全不變**（additive only）
>
> B5（Vector Map Renderer）、B6 / B7（Map Interaction / Chronicle）可以**繼續照舊**用
> `loadAllData(): Promise<AppData>`，唔使改任何一行。B3 冇刪、冇改任何 `AppData` 欄位嘅型別或語意。
> 唯一內部行為改動係 `AppData.timeline` 由「eager 載入嘅 1,796 條記錄」變成 `[]`
> —— 因為實測 `src/` **零引用**（A8 P1-2），改動**唔影響任何下游**（詳見 §6）。

---

## 1. B3 獨佔（Owned by B3）

| 檔案 | 狀態 | 說明 |
|---|---|---|
| `src/data/adapter/index.ts` | **新** | 對外唯一入口：`loadWorldData()` / `toWorldIndex()` / 全部 selectors |
| `src/data/adapter/normalize.ts` | **新** | raw GeoJSON / JSON → 內部 typed shape；`resolveCoord` / `hasEvidence`（規則 D4） |
| `src/data/adapter/indexes.ts` | **新** | `Map` / `Set` 索引建構 + 建構時間量度 |
| `src/data/adapter/config.ts` | **新** | 由 B4 產生嘅 `map-config` → runtime 常數（唔再由 renderer import asset） |
| `src/data/searchIndex.ts` | **新** | 5 類倒排索引 + `searchSearchIndex()`（≤150 ms） |
| `src/data/loadAllData.ts` | **改** | 移除 `timeline.json` eager load（A8 P1-2）；簽名／shape **不變** |
| `src/data/fallbackAnchors.ts` | **保留** | 見 §7（**唔搬**：`tests/phase-i.test.ts` 直接讀檔內容） |
| `tests/data-adapter.test.ts` | **新** | adapter 契約 + lazy dossier + fetch 清單斷言 |
| `tests/data-indexes.test.ts` | **新** | 10 個索引嘅正確性（確定性抽樣）＋覆蓋率 |
| `tests/search-index.test.ts` | **新** | 5 類搜尋 + 無硬上限 + ≤150 ms benchmark |
| `vite.config.ts` | **改** | 只改 build 相關（`emptyOutDir`）；**唔改** `test.exclude` |

**B3 唔會改**：`src/state/**`（B2）、`src/styles/**`（B1）、`src/ui/**`、`src/map/**`（B5）、
`src/components/**`（B5/B6/B7/B8）、`src/app.ts`、`src/main.ts`、`src/router.ts`（B2）、
`src/types/**`（B2 獨佔）、`data/**`（B4）、`scripts/**`、`package.json`、`tests/visual-smoke.e2e.test.ts`。

---

## 2. `WorldData` —— 正規化後嘅資料容器

```ts
// 型別定義喺 `src/data/adapter/normalize.ts`，由 `src/data/adapter/index.ts` re-export。
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
```

**保證**：
- `zones` 只讀 `zone_type`（規則 Z2）；`normalize.ts` 會喺 `zone_type` 缺失時由 `kind` **確定性推導**
  （`survivor→survivor_zone`、`nest→infected_nest`、`outpost→contested`），令 v1 資料都讀得到。
- `events[].properties.zone_id` 缺失時補 `null`（唔會 undefined）。
- `locations[].properties.zone_ids` 缺失時補 `[]`。
- `display_style` 缺失時由 `zone_type` 查表補（token 名，**唔存 raw hex**）。
- 所有 `coordinate_*` 欄位**原樣保留**（唔會過濾 `needs_validation` 嘅 feature，UI 負責顯示「資料未足以確認」）。

### 2.1 `MapRuntimeConfig`（`src/data/adapter/config.ts`）

```ts
export interface MapRuntimeConfig {
  chapterTotal: number;              // config.chapters.total ?? 198
  firstChapterWithContent: number;   // 預設 1
  coordinateSystem: string;          // "EPSG:4326"
  projection: string;                // "equirectangular"
  standardParallel: number;          // 22.36
  initialView: { centerLonLat: [number, number] | null; zoom: number };
  assetPaths: {
    basemapPng: string | null;
    basemapLabelsPng: string | null;
    basemapCoords: string | null;
    lodManifest: string | null;
  };
  showScaleBar: boolean;
  spoilerLevels: number;
  defaultSpoilerMax: number;
  provisional: { enabled: boolean; banner: string };
}

export function resolveMapConfig(config: MapConfig): MapRuntimeConfig;
export const DEFAULT_MAP_RUNTIME_CONFIG: MapRuntimeConfig;
```

> **規則 D1 落實**：`assetPaths` 令 renderer 由 `config.runtime.assetPaths.*` 攞路徑，
> 而唔係自己 `import "../../public/assets/..."`（A3 §2 指出同一組常數喺 3 個地方各自定義）。

---

## 3. `WorldIndexes` —— 索引層（spec §2.3）

```ts
// src/data/adapter/indexes.ts
export interface WorldIndexes {
  // ── 由 spec §2.3 表逐條實作 ──────────────────────────────
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

  // ── B2 `WorldIndex` 需要嘅補充索引（additive；spec §2.3 表以外） ──
  routesById: ReadonlyMap<string, RouteFeature>;
  routesByCharacter: ReadonlyMap<string, RouteFeature>;

  // ── 搜尋索引（見 §5） ───────────────────────────────────
  search: SearchIndexData;
}

export interface IndexBuildMetrics {
  /** 每個索引嘅建構時間（ms，`performance.now()` 差）。 */
  perIndex: Record<IndexName, number>;
  totalMs: number;
  /** 索引項數（測試斷言用）。 */
  sizes: Record<IndexName, number>;
}

export type IndexName =
  | "locationsById" | "eventsById" | "zonesById" | "eventsByLocation"
  | "eventsByZone" | "charactersById" | "eventsByCharacter" | "zonesByLocation"
  | "dossierByZone" | "chronicleByPeriod" | "routesById" | "routesByCharacter"
  | "search";

export function buildIndexes(data: WorldData): {
  indexes: WorldIndexes;
  metrics: IndexBuildMetrics;
};
```

### 3.1 每個 index 嘅 key → value（**逐條對照 spec §2.3**）

| 索引 | Key | Value | 建構來源（確定性） |
|---|---|---|---|
| `locationsById` | `location.properties.id` | `LocationFeature` | `locations` |
| `eventsById` | `event.properties.id` | `EventFeature` | `events` |
| `zonesById` | `zone.properties.id` | `ZoneFeature` | `zones` |
| `eventsByLocation` | `event.properties.location_id` | `EventFeature[]`（**跳過 `location_id === null`**） | `events` 按 `location_id` 分組 |
| `eventsByZone` | `zone_id` | `EventFeature[]` | ① 有 `event.zone_id` → 直接入；② 否則由 `location_id` 經 `zonesByLocation` 反查（覆蓋率見 §3.2） |
| `charactersById` | `character.id` | `CharacterRecord` | `characters` |
| `eventsByCharacter` | `character_id`（= `event.properties.characters[]` 嘅值，實測 173/173 都係合法角色 id） | `EventFeature[]` | `events` 按 `characters[]` 展開 |
| `zonesByLocation` | `location_id` | `zone_id[]`（去重，**兩個方向都收**） | ① `zone.member_location_ids` → `location_id`；② `location.zone_ids` → `zone_id` |
| `dossierByZone` | `dossier.zone_id` | `ZoneDossier` | `zone-dossiers.json`（**lazy**，見 §4） |
| `chronicleByPeriod` | `entry.story_time.label`（空 label → `"_unknown"`） | `ChronicleEntry[]` | `chronicle.entries` 按 `story_time.label` 分組 |
| `routesById` | `route.properties.id` | `RouteFeature` | `routes` |
| `routesByCharacter` | `route.properties.character_id` | `RouteFeature`（**首個命中**，同 B2 一致） | `routes` |

> **規則 D2 落實**：所有 zone ↔ location ↔ event ↔ character join 一律經呢張表。
> 全部用 `Map` / `Set`，**冇任何線性 `find()`**。

### 3.2 `eventsByZone` 覆蓋率（對齊 B4 報告）

- B4 `events.geojson.zone_id` 覆蓋率實測 **90.6%**（1,627 / 1,796）。
- B3 嘅 `eventsByZone` 係**覆蓋率嘅超集**：有 `zone_id` 直接入；冇 `zone_id` 但 `location_id`
  有 zone membership 嘅，經 `zonesByLocation` 反查補上。
- 測試斷言：`eventsByZone` 覆蓋到嘅**唯一 event id 數 / events 總數 ≥ 0.906`。
- 每個 zone 嘅 `eventsByZone.get(zoneId).length` 同 `zone.properties.event_ids.length` **必須一致**
  （B4 §9 要求「二者必須一致」）—— 測試逐個 zone 斷言。

### 3.3 `chronicleByPeriod` 嘅 key

`story_time.label`（例如 `"第1日"` / `"_unknown"`）。`story_time.order` 另存於
`ChronicleEntry.story_time.order`，唔做 key（可能 `null`）。

---

## 4. `dossierByZone` 必須 lazy（A6 / A8）

```ts
// src/data/adapter/index.ts
export interface DossierState {
  /** 首屏 = 空 Map。載入後**就地填充**（同一個 reference）。 */
  byZone: Map<string, ZoneDossier>;
  loaded: boolean;
  loading: Promise<Map<string, ZoneDossier>> | null;
}

/**
 * 按需載入 `data/public/zone-dossiers.json`（memoized）。
 * 首次呼叫才 fetch；之後回同一 Promise。**唔可以**喺 `loadWorldData()` 內呼叫。
 */
export function loadDossiers(world: World, opts?: LoadWorldOptions): Promise<Map<string, ZoneDossier>>;

/** 同步讀（未載入 → null）。 */
export function getDossier(world: World, zoneId: string): ZoneDossier | null;
```

**硬性**：
1. `loadWorldData()` **唔會** fetch `zone-dossiers.json`（測試用注入式 `fetchImpl` 斷言 fetch 清單）。
2. `world.indexes.dossierByZone === world.dossiers.byZone`（同一個 `Map` reference）。
3. `loadDossiers()` 之後，同一個 reference 見到 48 個 dossier —— B2 `selectDossier()`
   同 `WorldIndex.dossierByZone` **唔使改簽名**都即刻生效。
4. UI（B6 `ZoneDossier`）流程：`zone 選中 → await loadDossiers(world) → getDossier(world, zoneId)`
   → 未有資料顯示「資料未足以確認」。

---

## 5. Search Index（IA §8）

```ts
// src/data/searchIndex.ts
export interface SearchIndexData {
  /** 扁平、穩定次序（character → zone → location → event → chapter）。 */
  entries: SearchEntry[];
  /** kind → `entries` 嘅 index 清單。 */
  byKind: ReadonlyMap<SearchKind, readonly number[]>;
  /** 單字倒排：CJK 字／ASCII 小寫字母數字 → `entries` 嘅 index 清單。 */
  postings: ReadonlyMap<string, readonly number[]>;
  buildMs: number;
}

export function buildSearchIndex(input: {
  zones: ZoneFeature[];
  events: EventFeature[];
  locations: LocationFeature[];
  characters: CharacterRecord[];
  chapterSummaries: ChapterSummaries;
}): SearchIndexData;

/**
 * 5 類搜尋。**冇硬上限**（唔再係 50）。
 * 演算法：由 query 揀**最稀有嘅字**攞 postings 做候選 → 套 kind 過濾 → `includes()` 覆核。
 * 覆核保證正確性；倒排保證亞線性。
 */
export function searchSearchIndex(
  index: SearchIndexData,
  kind: SearchKind | null,
  query: string,
): SearchResult[];
```

### 5.1 5 個 kind 嘅來源同 label（IA §8 逐條）

| kind | 來源 | `id` | `label` | `sublabel` |
|---|---|---|---|---|
| `character` | `characters`（330） | `character.id` | `name` | `role` |
| `zone` | `zones`（48） | `zone.id` | `name` | `zone_type` 中文標籤（倖存區／病窩／…） |
| `location` | `locations`（704） | `location.id` | `display_name \|\| name` | `location_type` |
| `event` | `events`（1,796） | `event.id` | `title` | `第 N 章` |
| `chapter` | `chapter-summaries`（195） | `ch_{n}` | `第 N 章` | 首個地點名 |

- `text` = `label + sublabel + aliases + description`（**已 lowercase**）。
- 回傳**全部**符合項（唔再截 50）；virtualization 由 B7 / B8 負責。
- 響應時間預算 **≤150 ms**（rendering spec §6.2）；實測見交付報告。

---

## 6. `loadAllData()` / `AppData` 不變保證（⚠️ 給 B5 / B6 / B7）

### 6.1 保證內容

| 項目 | 保證 |
|---|---|
| `loadAllData()` 簽名 | **不變**：`(): Promise<AppData>` |
| `AppData` 欄位 | **不變**：`config` / `locations` / `events` / `routes` / `timeline` / `characters` / `zones` / `chronicle` / `chapterAppearances` / `chapterSummaries` / `locationsById` / `charactersByName` / `eventsByChapter` / `routesByChapter` 全部保留 |
| `AppData` 欄位型別 | **不變**（冇刪、冇改；B3 冇加新欄位） |
| 現有 4 個 index | **不變**：`locationsById` / `charactersByName` / `eventsByChapter` / `routesByChapter` 嘅 key → value 同建構規則**完全一樣** |
| `loadAllData.ts` 嘅 export | **不變**（`AppData` / `loadAllData` / 全部 re-export type 原樣） |

### 6.2 唯一行為改動：`AppData.timeline`

| | 之前 | 之後 |
|---|---|---|
| 行為 | `fetch("./data/public/timeline.json")` + `JSON.parse` 1,796 條 | **唔 fetch**；`timeline: []` |
| 型別 | `TimelineRecord[]` | `TimelineRecord[]`（**一樣**） |
| 下游影響 | — | **零**（A8 P1-2：`grep "\.timeline" src/` 只中一個 CSS class 名；`AppData.timeline` 冇任何 component 讀） |
| 收益 | — | 省 195 KB transfer + 3.6 ms parse（A8 實測） |

> 需要 timeline 嘅新 code 用 `loadTimeline(world)`（lazy，見 §8）；舊 code 完全唔受影響。

### 6.3 B5 / B6 / B7 應該點用 B3

**（A）最低風險路徑 —— 乜都唔改**

B5 / B6 / B7 可以**繼續**用 `loadAllData()` + `AppData`。B3 冇逼你哋搬。

**（B）用 adapter（推薦，取代散落嘅 `features.find()`）**

```ts
import { loadWorldData, toWorldIndex, getDossier, loadDossiers } from "../data/adapter";

const world = await loadWorldData();          // fetch + normalize + 建索引
const wi = toWorldIndex(world);               // → B2 嘅 WorldIndex（selector 簽名唔變）
// 之後 B2 selectors 照用：selectVisibleZones(state, wi) …
```

- `toWorldIndex(world)` 回傳嘅物件**滿足 B2 `WorldIndex` 契約**（§2.4），可以直接餵入
  `src/state/selectors.ts` 嘅全部 selector，**唔使改 B2 任何一行**。
- B2 `buildWorldIndex(data)` 過渡橋**保留**（B2 自己決定幾時移除）。

**（C）Zone dossier（B6 `ZoneDossier.ts`）**

```ts
const zoneId = state.context.kind === "zone" ? state.context.zoneId : null;
if (zoneId) {
  await loadDossiers(world);                  // 首次才 fetch；之後 cached
  const d = getDossier(world, zoneId);        // ZoneDossier | null
  // d?.review_status === "needs_validation" 或 field === "unknown" → 顯示「資料未足以確認」
}
```

**（D）坐標解析（B5，規則 D4）**

`resolveCoord()` / `hasEvidence()` 由 `SvgMap.ts` 搬入 `src/data/adapter/normalize.ts`（**新 export**）。
`SvgMap.ts` 自己嗰份**暫時保留**（唔屬 B3 allowlist，唔可以改），B5 接手 `SvgMap` / `src/map/**`
之後改為 `import { resolveCoord, hasEvidence } from "../data/adapter/normalize"`。

**（E）搜尋（B7 / B8 `SearchOverlay`）**

```ts
import { searchSearchIndex } from "../data/searchIndex";
const results = searchSearchIndex(world.indexes.search, state.searchKind, query); // 無上限
```

---

## 7. 偏離說明（需主代理知悉）

| # | 偏離 | 理由（證據） |
|---|---|---|
| **D-1** | `src/data/fallbackAnchors.ts` **唔搬**入 adapter（改為 adapter `normalize.ts` re-export `FULL_HK_ANCHORS`） | `tests/phase-i.test.ts:9` 用 `readFileSync("src/data/fallbackAnchors.ts")` **直接讀檔內容**，斷言 `export const FULL_HK_ANCHORS: Record<string, FullHKAnchor>` + ≥500 條 `"key": {` 條目。搬走檔案內容（改成 re-export）會令該測試**必然紅**，而該檔唔屬 B3 allowlist（唔可以改）。為守住「現有 14 files / 195 tests 全綠」嘅硬性約束，保留原檔為**資料單一來源**，adapter 只做 re-export。規則 D4 嘅**邏輯**部分（`resolveCoord` / `hasEvidence`）已搬入 adapter。 |
| **D-2** | `AppData` **冇加**新欄位 | 任務允許 additive，但 B5/B6/B7 正並行依賴 `AppData`；加欄位會改 `AppData` 嘅 object literal 構造點。B3 選擇**零改動**（除 `timeline` 內容），把新能力放喺**新模組**（adapter / searchIndex），風險最低。 |
| **D-3** | `WorldIndexes` 比 spec §2.3 表多 2 個索引（`routesById` / `routesByCharacter`） | B2 `WorldIndex`（b2-interface-contract §2.4）需要佢哋；additive，唔影響 §2.3 表任何一條。 |
| **D-4** | `SearchIndexData` 用**單字倒排**（唔用 bigram） | 單字倒排已經係真倒排（亞線性），記憶體遠低於 bigram（後者 ~53 萬 postings）；正確性由 `includes()` 覆核保證。詳見交付報告實測。 |

---

## 8. 其餘 export（`src/data/adapter/index.ts`）

```ts
export interface LoadWorldOptions {
  base?: string;                 // 預設 "./data/public/"
  fetchImpl?: typeof fetch;      // 預設 globalThis.fetch（測試注入用）
}

export interface World {
  data: WorldData;
  indexes: WorldIndexes;
  metrics: IndexBuildMetrics;
  dossiers: DossierState;
}

export async function loadWorldData(opts?: LoadWorldOptions): Promise<World>;

/** 由已載入嘅 World 造 B2 `WorldIndex`（取代 `buildWorldIndex` 過渡橋）。 */
export function toWorldIndex(world: World): WorldIndex;

/** 按需載入 timeline.json（規則 D3；`AppData.timeline` 已唔 eager 載）。 */
export function loadTimeline(world: World, opts?: LoadWorldOptions): Promise<TimelineRecord[]>;

// ── Indexed selectors（純函數；component 唔可以自己掃 raw array） ──
export function selectZone(world: World, id: string): ZoneFeature | null;
export function selectEvent(world: World, id: string): EventFeature | null;
export function selectLocation(world: World, id: string): LocationFeature | null;
export function selectCharacter(world: World, id: string): CharacterRecord | null;
export function selectEventsByZone(world: World, zoneId: string): EventFeature[];
export function selectEventsByLocation(world: World, locationId: string): EventFeature[];
export function selectEventsByCharacter(world: World, characterId: string): EventFeature[];
export function selectZonesByLocation(world: World, locationId: string): ZoneFeature[];
export function selectChronicleByPeriod(world: World, period: string): ChronicleEntry[];
export function selectRouteByCharacter(world: World, characterId: string): RouteFeature | null;
export function selectWaypoints(world: World, routeId: string): Waypoint[];
export function selectDossier(world: World, zoneId: string): ZoneDossier | null;

// ── 規則 D4：由 renderer 搬入 ──
export { resolveCoord, hasEvidence, FULL_HK_ANCHORS } from "./normalize";
```

### 8.1 `Waypoint`（同 B2 §4.1 一致）

```ts
export interface Waypoint extends RouteWaypoint {
  locationName: string | null;   // 由 locationsById 解析，UI 唔應該顯示原始 id
}
```

---

## 9. 驗收（B3 自己跑）

```bash
npm run typecheck    # 0 error
npm run lint         # B3 檔案 0 error
npm run test         # 新增 3 個測試檔全綠；現有 14 files / 195 tests 保持全綠
npm run build        # 必須成功（emptyOutDir: true 之後）
```

**測試硬性斷言**：

| # | 斷言 | 檔案 |
|---|---|---|
| 1 | 10 個索引 key → value 正確（確定性抽樣，用資料檔真實內容） | `tests/data-indexes.test.ts` |
| 2 | `eventsByZone` 覆蓋率 ≥ 0.906；逐 zone 同 `event_ids` 一致 | `tests/data-indexes.test.ts` |
| 3 | `loadWorldData()` fetch 清單**唔含** `timeline.json` 同 `zone-dossiers.json` | `tests/data-adapter.test.ts` |
| 4 | `loadWorldData()` 之後 `dossierByZone.size === 0`；`loadDossiers()` 之後 48 | `tests/data-adapter.test.ts` |
| 5 | 5 個 kind 全部有結果；「大本營」等查詢**唔截 50** | `tests/search-index.test.ts` |
| 6 | 搜尋 ≤150 ms（連續 50 次取最大） | `tests/search-index.test.ts` |
| 7 | `toWorldIndex()` 輸出符合 B2 `WorldIndex`（key 齊全、map 有值） | `tests/data-adapter.test.ts` |
| 8 | 索引建構總時間有量度（`metrics.totalMs > 0`、每項 ≥ 0） | `tests/data-indexes.test.ts` |

---

## 10. 已知衝突（需主代理裁決）

| # | 衝突 | 說明 |
|---|---|---|
| C1 | `fallbackAnchors.ts` 位置 | 見 §7 D-1。要真正搬入 adapter，必須改 `tests/phase-i.test.ts`（唔屬 B3 allowlist）。**建議**：主代理喺 B5 接手 `SvgMap.ts` 時一併更新該測試為 `import { FULL_HK_ANCHORS } from "../src/data/adapter"`。 |
| C2 | `vite.config.ts` 嘅 geojson gzip | GitHub Pages **會自動 gzip**（CDN edge），所以 build-time `.gz` sidecar **冇收益**（GitHub Pages 唔 serve sidecar），反而令 `dist/` +3.1 MB。A8 量到嘅「未壓縮」係**本機 `vite preview`（sirv）現象**。B3 **唔加** pre-compression，只喺交付報告如實說明。 |
| C3 | `emptyOutDir` 由 `false` → `true` | 舊註解講嘅本機 `rm` shim 問題。若改 `true` 之後 `npm run build` 真係失敗，會**保留 `false`** 並喺報告記錄 block reason（唔強行）。 |

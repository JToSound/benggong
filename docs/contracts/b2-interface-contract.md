# B2 — App State & Router Interface Contract

> 子代理：**B2 App State & Router**
> 性質：**介面契約（先寫，後實作）**。依 `docs/specs/world-atlas-v2-component-state-contract.md` §4.4。
> 語言：粵文。所有下游 agent（B3 / B5 / B6 / B7 / B8 / B9）**必須**先讀本檔再寫 code。

---

## 0. 一句總結

B2 提供 **唯一 state 來源（`src/state/store.ts`）＋ 唯一 URL 契約（`src/state/url.ts`）＋ 唯一 derived selector 入口（`src/state/selectors.ts`）**。
其他 agent **唔可以**自己持有跨 context 嘅 state、**唔可以**讀返 DOM 做邏輯判斷、**唔可以**直接改 store 物件。所有轉換一律經 action。

---

## 1. B2 獨佔（Owned by B2）

| 檔案 | 狀態 | 說明 |
|---|---|---|
| `src/state/store.ts` | **新** | `AppState` + `PrimaryContext` + 全部 action + `subscribe`（規則 S1–S4） |
| `src/state/url.ts` | **新** | `toUrl` / `fromUrl` / `isCanonical`（規則 U1–U6） |
| `src/state/selectors.ts` | **新** | 全部 derived selector（component 唔可以重算） |
| `src/state/persistence.ts` | **新** | spoiler + theme 持久化（**必須** try/catch） |
| `src/state/index.ts` | **新** | 對外唯一入口 + `bindUrlSync` + `createUrlEffects` |
| `src/types/state.ts` | **新** | state / context / world 型別 |
| `src/app.ts` | **改** | 由私有 state 改為經 store 讀寫（**唔可以刪** —— Gate 2 主代理才 cleanup） |
| `src/router.ts` | **改** | 降為 **legacy shim**（讀 `#ch=` / `#loc=` → store action）；**唔可以刪** |
| `src/main.ts` | **改** | bootstrap store + `import "./styles/index.css"` + `mountIconSprite()` |
| `src/types/dataset.ts` | **改** | 加 `coordinate_*` / zone v2 / dossier 型別 |
| `tests/state-store.test.ts` | **新** | store + selector 契約 |
| `tests/url-contract.test.ts` | **新** | URL round-trip + 無效值 fallback |
| `tests/url-legacy-alias.test.ts` | **新** | `#ch=` / `#loc=` legacy alias + precedence |

> **其他 agent 要加型別**：`src/types/dataset.ts` 屬 B2。B3 / B4 / B5 / B6 需要新欄位 → 開 PR 畀 B2，**唔可以**自己改。
> B2 **唔會**改：`src/styles/**`（B1）、`src/map/**`（B5）、`src/components/**`（B6/B7/B8）、`src/data/**`（B3）、`data/**`（B4）、`scripts/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`tests/visual-smoke.e2e.test.ts`（主代理）。

---

## 2. State 契約

### 2.1 `AppState`（`src/state/store.ts`）

```ts
export interface AppState {
  // ── 主 context（唯一；同一時間只有一個） ──────────────
  context: PrimaryContext;

  // ── 正交狀態 ─────────────────────────────────────────
  spoilerMax: 0 | 1 | 2 | 3;            // 預設 1（D4）
  layers: LayerFlags;                    // 7 個 toggle
  chapter: number;                       // 1..198（唔過濾 zone，只做 emphasis — D2）
  theme: "dark" | "light";               // 預設 "dark"（D1）
  view: "map" | "chronicle";             // 主視圖（預設 "map" — D3）

  // ── 地圖視域（由 MapViewport 擁有，但存喺 store） ─────
  viewport: Viewport;                    // { x, y, w, h }；**唔入 URL**

  // ── 暫時性 UI 狀態 ───────────────────────────────────
  sheetSnap: SheetSnap;                  // "peek" | "half" | "full"
  searchKind: SearchKind | null;
  pendingFocus: string | null;           // focus restoration target
  loading: { map: boolean; data: boolean };
  errors: AppError[];                    // 唔可以 throw 到 uncaught
}
```

### 2.2 `PrimaryContext`（10 個 kind，與 IA §2 逐條對齊）

```ts
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
  | { kind: "measure"; ids: string[] };   // ← 見 §2.5 偏離說明
```

### 2.3 輔助型別

```ts
export interface LayerFlags {
  zones: boolean;     // survivor_zone      預設 ON
  nests: boolean;     // infected_nest      預設 ON
  outposts: boolean;  // contested/quarantine/transit/unknown  預設 ON
  events: boolean;    // 預設 ON
  routes: boolean;    // 預設 OFF
  periods: boolean;   // 預設 OFF
  detail: boolean;    // 地圖細節（LOD）    預設 ON
}

export type SearchKind = "character" | "zone" | "location" | "event" | "chapter";
export type SheetSnap = "peek" | "half" | "full";
export type Viewport = { x: number; y: number; w: number; h: number };
export interface AppError { code: string; message: string; retryable: boolean; at: number }

export interface ChronicleFilters {
  chapter: number | null;
  period: string | null;
  zoneId: string | null;
  characterId: string | null;
  spoilerMax: 0 | 1 | 2 | 3;
  query: string;
}
```

### 2.4 `WorldIndex`（selector 嘅輸入契約，由 B3 adapter 提供）

```ts
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
```

> B2 提供 `buildWorldIndex(data: AppData): WorldIndex` 作**過渡橋**（`src/state/selectors.ts`）。
> B3 交付 `src/data/adapter/index.ts` 之後，會**取代**呢個橋；selector 簽名**唔變**。

### 2.5 偏離說明（唯一一項，需主代理知悉）

`PrimaryContext` 嘅 `measure` 喺 IA §2 只寫 `{ kind: "measure" }`，但 URL 參數 `?measure=<csv of ids>`（IA §3.1）需要承載 id 清單。
故 B2 加 `ids: string[]`（空陣列 = 無 payload）。除此之外 **100% 逐條對齊** IA §2。

---

## 3. Action 契約（`AppStore`）

```ts
export interface AppStore {
  getState(): AppState;
  subscribe(fn: (next: AppState, prev: AppState) => void): () => void;   // 回傳 unsubscribe

  setContext(ctx: PrimaryContext): void;        // replaceState + 衍生 DOM
  navigate(ctx: PrimaryContext): void;          // 同上，但 pushState（用戶主動導航）
  setChapter(n: number): void;                  // clamp 1..chapterTotal；唔過濾 zone
  setSpoilerMax(n: 0 | 1 | 2 | 3): void;        // clamp + 持久化 + 重算可見集合
  toggleLayer(k: keyof LayerFlags): void;       // 更新 URL ?layers=
  setLayer(k: keyof LayerFlags, on: boolean): void;
  setTheme(t: "dark" | "light"): void;          // 派發 basemap-theme-change（經 B1 theme.ts）
  setView(v: "map" | "chronicle"): void;
  setViewport(v: Viewport): void;               // **唔寫 URL**
  setSheetSnap(s: SheetSnap): void;             // 唔寫 URL
  setSearchKind(k: SearchKind | null): void;
  setPendingFocus(id: string | null): void;
  setLoading(patch: Partial<{ map: boolean; data: boolean }>): void;
  pushError(e: { code: string; message: string; retryable?: boolean }): void;  // **唔可以 throw**
  clearError(code?: string): void;
  hydrateFromUrl(url: URL, ctx?: UrlValidationContext): AppState;              // 一次性
}
```

### 3.1 硬性規則（S1–S4）

| 規則 | 實作 |
|---|---|
| **S1** 唯一 state 來源 | `createAppStore()` 係唯一 `AppState` 持有者；component 只可 `getState()` / `subscribe()` |
| **S2** DOM 只可作衍生輸出 | store **零 DOM 依賴**；DOM 更新由 `App` 嘅 subscriber 做；新 code **唔可以**用 `classList.contains()` 做邏輯判斷 |
| **S3** 所有轉換經 action | `getState()` 回傳 **凍結（frozen）** 物件；直接改會喺 strict mode throw |
| **S4** URL 係投影 | `projectUrl(state, mode)` 由 action 內部呼叫（`replaceState` / `pushState`），**唔係**第二份 state |

### 3.2 邊個 action 會寫 URL

| 會寫 URL | 唔會寫 URL |
|---|---|
| `setContext`（replace）、`navigate`（push）、`setChapter`、`setSpoilerMax`、`toggleLayer`、`setLayer`、`setView`、`setSearchKind`、`hydrateFromUrl` | `setViewport`、`setSheetSnap`、`setTheme`、`setPendingFocus`、`setLoading`、`pushError`、`clearError` |

> `setViewport` 唔寫 URL 係 spec §1.4 明文（避免 pan/zoom 每個 frame 都寫 history）。只有 `flyTo` 完成後由 MapViewport 呼叫 `setContext` / 一次 `setViewport` 才反映。

---

## 4. Selector 契約（`src/state/selectors.ts`）

```ts
selectVisibleZones(state, world): ZoneFeature[]          // 受 layers 控制，**唔受 chapter 過濾**（D2）
selectEmphasisZoneIds(state, world): Set<string>         // 受 chapter 影響（emphasis 而非 filter）
selectVisibleEvents(state, world): EventFeature[]        // 受 spoilerMax + chapter 窗口
selectDossier(zoneId, world): ZoneDossier | null
selectRoute(characterId, world): RouteFeature | null
selectWaypoints(routeId, world): Waypoint[]
selectRelatedEvents(zoneId, world): EventFeature[]
selectRelatedCharacters(zoneId, world): CharacterRecord[]
selectChroniclePage(filters, cursor, world): { items: ChronicleEntry[]; nextCursor: number | null; total: number }
selectSearchResults(kind, query, world): SearchResult[]
selectHiddenCount(state, world): number
```

### 4.1 硬性決定

| 項 | 內容 |
|---|---|
| **D2（48 zone 永遠全部 render）** | `selectVisibleZones` **完全唔讀 `state.chapter`**。實作上有測試斷言：chapter 由 1 掃到 198，回傳長度**恆等於** `world.zones` 長度。 |
| Emphasis 而非 filter | 章節只經 `selectEmphasisZoneIds` 影響視覺強調；`selectVisibleZones` 唔會被 chapter 縮減。 |
| Layer → zone_type 映射 | `zones` ← `survivor_zone`；`nests` ← `infected_nest`；`outposts` ← `contested` / `quarantine` / `transit` / `unknown`。 |
| `selectVisibleEvents` 窗口 | `EVENT_CHAPTER_WINDOW = 3`（`|event.chapter - state.chapter| <= 3`）＋ `spoiler_level <= spoilerMax`。 |
| `selectHiddenCount` | 全部事件中 `spoiler_level > state.spoilerMax` 嘅數量（對應 D4「已隱藏 M 條」）。 |
| `selectChroniclePage` cursor | `cursor` 係 **offset（number）**；`PAGE_SIZE = 50`；`nextCursor = offset + PAGE_SIZE < total ? offset + PAGE_SIZE : null`。 |
| Search 無硬上限 | 回傳**全部**符合項（唔再係 50）；virtualization 由 B7/B8 負責。 |
| `selectWaypoints` 輸入 | `routeId`（唔係 characterId）；回傳 `Waypoint = RouteWaypoint & { locationName: string | null }`。 |

> **規則 SEL1**：component **唔可以**喺內部重算上述任何 derived 結果。
> **規則 SEL2**：selector 係**純函數**（唔讀 DOM、唔讀 store、唔 mutate 輸入）。

---

## 5. URL 契約（`src/state/url.ts`）

```ts
export function toUrl(state: AppState): string;                 // canonical query（唔含 pathname；空 → ""）
export function fromUrl(url: URL, ctx?: UrlValidationContext): AppState;
export function isCanonical(url: URL): boolean;
export function applyUrl(state: AppState, mode: "replace" | "push"): void;   // 瀏覽器專用
```

### 5.1 參數 ↔ context 映射表（**11 個參數全部實作**）

| 參數 | 型別 | → state | 序列化條件 |
|---|---|---|---|
| `?event=<id>` | string | `context = {kind:'event', eventId}` | context 係 event |
| `?zone=<id>` | string | `context = {kind:'zone', zoneId}` | context 係 zone |
| `?location=<id>` | string | `context = {kind:'location', locationId}` | context 係 location |
| `?character=<id>` | string | `context = {kind:'character', characterId}` | context 係 character |
| `?route=<characterId>` | string | `context = {kind:'route', characterId}` | context 係 route |
| `?chapter=<n>` | int 1–198 | `chapter = n`；若無更高 precedence context → `context = {kind:'chapter', issueIndex:n}` | `state.chapter !== 1` |
| `?spoiler=<0-3>` | int | `spoilerMax`（clamp） | `spoilerMax !== 1`（預設） |
| `?layers=<csv>` | csv | `layers`（只列非預設偏差） | 有任何非預設 layer |
| `?view=map\|chronicle` | enum | `view` | `view === 'chronicle'` |
| `?measure=<csv>` | csv of ids | `context = {kind:'measure', ids}` | context 係 measure |
| `?q=<query>` | string | `context = {kind:'search', query}` | context 係 search |
| `?kind=<SearchKind>` | enum | `searchKind` | `searchKind !== null`（配合 `?q=` 用） |

### 5.2 Context precedence（同時出現多個 context 參數時）

```
event > zone > location > character > route > measure > q(search) > chapter > explore
```

- `?chapter=` **永遠**設定 `state.chapter`（無論 context 由邊個參數決定）。
- 例如 `?zone=z1&chapter=150` → `context = zone z1`、`chapter = 150`（唔會變 chapter context）。
- 例如 `?chapter=150` → `context = {kind:'chapter', issueIndex:150}`。

### 5.3 Legacy alias（**必須保留，唔可以拆**）

| Legacy | → canonical | 讀取規則 |
|---|---|---|
| `#ch=<n>` | `?chapter=<n>` | **只喺 `?chapter=` 缺席時**生效（rule 3 precedence） |
| `#loc=<id>` | `?location=<id>` | **只喺 `?location=` 缺席時**生效 |

- 接受 `#ch=150`、`#ch=150&loc=loc_0029`、`#loc=loc_0029`。
- `tests/visual-smoke.e2e.test.ts` 依賴 `#ch=150` → **`#ch=` 讀取路徑係紅線**。
- 寫入**一律** canonical query；**唔會**寫 `?chapter=150#ch=150`（rule 4：同一 state 只有一個 canonical URL）。

### 5.4 規則 U1–U6 實作對照

| 規則 | 內容 | 實作位置 |
|---|---|---|
| U1 | 只序列化 `context` + `spoilerMax` + `layers`（非預設）＋ `view`；`viewport` / `sheetSnap` / `theme` 唔入 URL | `toUrl()` |
| U2 | `layers` 只列**非預設**值 | `toUrl()` — 見 §5.5 |
| U3 | 讀取順序：`?x=` → `#x=`（legacy）→ 預設 | `fromUrl()` |
| U4 | 無效值 → 落回預設 + `console.warn`（**唔可以 throw**） | `fromUrl()` + `warn()` |
| U5 | 轉換用 `replaceState`；用戶主動導航用 `pushState` | `setContext`（replace）/ `navigate`（push） |
| U6 | `popstate` / `hashchange` 必須觸發 `hydrateFromUrl` + 重繪 | `bindUrlSync(store)`（popstate）＋ `initRouter(app)`（hashchange，legacy shim） |

### 5.5 `?layers=` 編碼（偏差編碼，規則 U2）

只有**同預設唔同**嘅 flag 才會出現：

| token | 意思 |
|---|---|
| `routes` | `routes` 由 OFF → ON |
| `periods` | `periods` 由 OFF → ON |
| `-events` | `events` 由 ON → OFF |
| `-zones` | `zones` 由 ON → OFF |

- 例：`?layers=routes,-events` = `routes` ON、`events` OFF、其餘預設。
- 未知 token → **忽略該 token** + `console.warn`（唔會 throw）。
- 空 `?layers=` → 全部預設。

### 5.6 無效值 fallback 行為（U4 實作細節）

| 輸入 | 行為 |
|---|---|
| `?event=INVALID`（`isValidId` 判定唔存在） | `console.warn` + context 落回 `explore` |
| `?zone=<唔存在>` | 同上 |
| `?chapter=99999` / `-5` / `abc` / 空 | clamp / 落回 **1** + `console.warn` |
| `?spoiler=99` | clamp 到 **3** + `console.warn` |
| `?spoiler=abc` | 落回 **1**（預設）+ `console.warn` |
| `?view=xyz` | 落回 **"map"** + `console.warn` |
| `?kind=xyz` | `searchKind = null` + `console.warn` |
| id 長度 > `MAX_ID_LENGTH`（200） | 視為無效 → fallback + `console.warn` |
| id 含控制字元（`\u0000-\u001F`、`\u007F`） | 視為無效 → fallback + `console.warn` |
| id 含非法字元（非 `[A-Za-z0-9_.:-]`） | 視為無效 → fallback + `console.warn` |
| `?layers=unknownflag` | 忽略 token + `console.warn` |

> **零 crash 保證**：`fromUrl` **唔會 throw**。任何未預期輸入都經 `warn()` + 預設值。
> `UrlValidationContext.isValidId` 由呼叫方注入（`App` 用 `WorldIndex` 建 predicate；node 測試可注入假 predicate）。**唔提供** → 只做語法檢查（shape/長度/字元集）。

### 5.7 `isCanonical(url)`

```ts
isCanonical(url) === (url.search === toUrl(fromUrl(url)) && url.hash === "")
```

---

## 6. 其他 agent 應該點用

### 6.1 B3（Data Adapter）

1. 交付 `src/data/adapter/index.ts` 之後，實作 `WorldIndex`（§2.4）並**取代** `buildWorldIndex()`。
2. **唔可以**改 selector 簽名；B2 selector 係 read model 契約。
3. 需要新欄位 → 開 PR 畀 B2 改 `src/types/dataset.ts`。

### 6.2 B5（Renderer / LOD）

1. `state.viewport` 係唯一視域來源；`MapViewport` 用 `setViewport` 寫入（rAF coalesce）。
2. **唔可以**自己 `history.replaceState`；所有 URL 寫入經 store action。
3. 主題：讀 `state.theme`；換 palette 靠 `basemap-theme-change`（B1 保留）。

### 6.3 B6（Map Interaction）

1. Zone hover 狀態係**本地** UI（唔入 store）；zone **選擇**必須 `store.navigate({kind:'zone', zoneId})`。
2. **hit priority**：zone 高於 event marker（IA §2 表）。
3. 由 zone 轉 event **必須**明確 `setContext({kind:'event'})`（修正 A9 P0-4）。
4. 圖層開關只經 `toggleLayer` / `setLayer`。

### 6.4 B7（Chronicle）

1. 篩選維度 → `store.setContext({kind:'chronicle', filters})`；**唔可以**自持 `filterChapter`。
2. 分頁經 `selectChroniclePage(filters, cursor, world)`；virtualization 喺 component 層。
3. Card → map deep link 用 `store.navigate({kind:'zone'|'event'|...})`。

### 6.5 B8（Mobile / A11y）

1. Bottom sheet snap 用 `state.sheetSnap` + `setSheetSnap`（**唔可以**自持）。
2. 收合面板**必須**同時處理 `inert` / `aria-hidden`（A7 P0-1）；`is-collapsed` 只係**衍生 class**。
3. Search overlay：query 入 `setContext({kind:'search'})`；kind 入 `setSearchKind`。

### 6.6 B9（Visual QA）

- 可用 `toUrl(fromUrl(x))` 做 URL 契約斷言。
- `selectVisibleZones` 長度斷言（chapter 無關）係 D2 嘅自動化證據。

---

## 7. 相容性（legacy adapter）

`src/app.ts` 保留**原有公開方法**做薄 adapter（component 暫時仍傳 `App` 實例）：

| 舊 API | 新行為 |
|---|---|
| `app.currentChapter` / `getCurrentChapter()` | `store.getState().chapter` |
| `app.setChapter(n)` | `store.setChapter(n)` |
| `app.selectedZoneId` / `getSelectedZoneId()` | `context.kind === 'zone' ? context.zoneId : null` |
| `app.selectedLocationId` / `getSelectedLocationId()` | `context.kind === 'location' ? context.locationId : null` |
| `app.selectedEventId` | `context.kind === 'event' ? context.eventId : null` |
| `app.setSelectedZone(id)` | `id ? navigate({kind:'zone'}) : setContext({kind:'explore'})` |
| `app.setSelectedLocation(id)` | `id ? navigate({kind:'location'}) : setContext({kind:'explore'})` |
| `app.setSelectedEvent(id)` | `id ? navigate({kind:'event'}) : setContext({kind:'explore'})` |
| `app.goToChapter(n)` | `setView('map')` + `setChapter(n)` |
| `app.setViewMode(m)` / `getViewMode()` | 由 `view` + `context.kind` **衍生**（唔再有 `viewMode` 私有欄位） |
| `app.getChapterTotal()` | `data.config.chapters?.total ?? 198` |

> **`viewMode` 映射**：`'chronicle'` → `view='chronicle'`；`'zone'` → `view='map'` + `context.kind='zone'`；`'chapter'` → `view='map'` + `context.kind='explore'`。

`src/router.ts` 保留 `initRouter(app)` 簽名，但只做 legacy `hashchange` → store action，**唔再**持有 state。

---

## 8. 已知衝突（需主代理裁決）

| # | 衝突 | 說明 |
|---|---|---|
| C1 | `tests/visual-smoke.e2e.test.ts:486-490` 斷言「按 `k` 後 `window.location.hash` 含 `ch=2`」 | 與 D5（canonical = query string）**直接衝突**。B2 依 spec 只寫 `?chapter=2`，hash 會清空。該檔屬主代理，B2 唔可以改 → **需主代理更新斷言為 `?chapter=2`**。`#ch=150` 讀取路徑**不受影響**。 |
| C2 | `main.ts` 移除 `main.css` / `timeline.css` / `hud.css` import（B1 契約要求） | 過渡期 component CSS 未交付（B6/B7/B8），舊 UI 會暫時失去樣式 → `visual-smoke` 嘅版面斷言會紅，直到 B6/B7/B8 + B9 完成。 |
| C3 | `PrimaryContext.measure` 加 `ids` 欄位 | 見 §2.5。 |
| C4 | `?kind=` 參數 | IA §5.1 entry point 用 `?q=&kind=character`，但 §3.1 參數表冇列 `kind`。B2 補上以令 4 個入口可 deep-link。 |

---

## 9. 驗收（B2 自己跑）

```bash
npm run typecheck    # 0 error
npm run lint         # B2 檔案 0 error（artifacts/** 有 pre-existing error，唔屬 B2 scope）
npm run test         # tests/state-store.test.ts、tests/url-contract.test.ts、tests/url-legacy-alias.test.ts 全綠
npm run build        # 成功
```

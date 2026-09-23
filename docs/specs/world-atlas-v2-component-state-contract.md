# World Atlas V2 — Component & State Contract

> **Gate 1 交付物 3／8** · 狀態：**定稿**
> 依據：spec §5.1、§5.3；A3（架構審計）、A9（URL/state 實測）、A7（a11y state）

---

## 1. State Ownership（單一來源原則）

### 1.1 現況問題（A3 實測）

| 問題 | 證據 |
|---|---|
| 冇單一 state 來源 | `App` 4 個欄位（`currentChapter`/`selectedLocationId`/`selectedEventId`/`selectedZoneId`）+ `viewMode` private + `ChronicleView.filterChapter/expanded` + `SvgMap.view/lang` |
| 大量狀態只存在於 DOM | `#story-pane.is-collapsed`、`#zone-dossier-mount[hidden]`、`.zone.is-selected`、`#label-detail-layer[opacity]`、`canvas.dataset.basemapLevel` |
| 收合面板仍可 Tab | `#story-pane` 收埋只係 `transform: translateX(100%)`，仍有 **2,920 個 Tab stop**（A7 P0-1） |

### 1.2 V2 契約（硬性）

> **規則 S1**：`src/state/store.ts` 係**唯一** state 來源。
> **規則 S2**：DOM class / attribute / `hidden` / `opacity` **只可以係衍生輸出**，任何 component 唔可以「讀返 DOM」嚟做邏輯判斷。
> **規則 S3**：任何 state 轉換必須經 store action；唔可以直接改 store 物件。
> **規則 S4**：URL 係 state 嘅**序列化投影**，唔係第二份 state。

### 1.3 Store shape

```ts
// src/state/store.ts
export interface AppState {
  // ── 主 context（唯一） ────────────────────────────
  context: PrimaryContext;

  // ── 正交狀態 ─────────────────────────────────────
  spoilerMax: 0 | 1 | 2 | 3;          // 預設 1（D4）
  layers: LayerFlags;                  // zones / nests / outposts / events / routes / periods / detail
  chapter: number;                     // 1..198（唔過濾 zone，只做 emphasis — D2）
  theme: 'dark' | 'light';             // 預設 'dark'（D1）
  view: 'map' | 'chronicle';

  // ── 地圖視域（由 MapViewport 擁有，但存喺 store） ──
  viewport: { x: number; y: number; w: number; h: number };

  // ── 暫時性 UI 狀態 ────────────────────────────────
  sheetSnap: 'peek' | 'half' | 'full';  // mobile only
  searchKind: SearchKind | null;
  pendingFocus: string | null;          // focus restoration target
  loading: { map: boolean; data: boolean };
  errors: AppError[];                   // 唔可以 throw 到 uncaught
}

export interface LayerFlags {
  zones: boolean;     // survivor
  nests: boolean;     // infected_nest
  outposts: boolean;  // contested
  events: boolean;
  routes: boolean;
  periods: boolean;
  detail: boolean;    // 地圖細節（道路／樓宇／POI）
}

export type SearchKind = 'character' | 'zone' | 'location' | 'event' | 'chapter';

export interface AppError {
  code: string;
  message: string;      // 粵文
  retryable: boolean;
  at: number;
}
```

### 1.4 Actions（store API）

| Action | 簽名 | 副作用 |
|---|---|---|
| `setContext` | `(ctx: PrimaryContext) => void` | 更新 URL（replaceState）+ 更新衍生 DOM |
| `navigate` | `(ctx: PrimaryContext) => void` | 同上但用 pushState |
| `setChapter` | `(n: number) => void` | 更新 chapter strip + emphasis（**唔過濾 zone**） |
| `setSpoilerMax` | `(n: 0\|1\|2\|3) => void` | 持久化到 localStorage + 重算可見集合 |
| `toggleLayer` | `(k: keyof LayerFlags) => void` | 更新 URL `?layers=` |
| `setTheme` | `(t: 'dark'\|'light') => void` | 派發 `basemap-theme-change`（canvas 唔讀 CSS 變數） |
| `setViewport` | `(v: Viewport) => void` | **唔寫 URL**（避免 spam）；只在 `flyTo` 後寫 |
| `setSheetSnap` | `(s) => void` | mobile only |
| `pushError` / `clearError` | — | 顯示非阻塞 error UI（**唔可以 throw**） |
| `hydrateFromUrl` | `(url: URL) => AppState` | 啟動時一次性 |

### 1.5 Derived selectors（唔可以喺 component 內重算）

```ts
// src/state/selectors.ts
selectVisibleZones(state): ZoneFeature[]        // 受 layers 控制，唔受 chapter 過濾
selectEmphasisZoneIds(state): Set<string>       // 受 chapter 影響（emphasis 而非 filter）
selectVisibleEvents(state): EventFeature[]      // 受 spoilerMax + chapter 窗口
selectDossier(zoneId): ZoneDossier | null
selectRoute(characterId): RouteFeature | null
selectWaypoints(routeId): Waypoint[]
selectRelatedEvents(zoneId): EventFeature[]
selectRelatedCharacters(zoneId): Character[]
selectChroniclePage(filters, cursor): { items, nextCursor, total }
selectSearchResults(kind, query): SearchResult[]
selectHiddenCount(state): number                // 「已隱藏 M 條」提示用
```

---

## 2. Data Adapter 邊界

### 2.1 現況問題（A3）

- **冇** data adapter / selector / index layer。
- 10 處直接 `features.find()/filter()` 線性掃描 raw GeoJSON。
- `SvgMap.render()` 內部有 O(events × locations) 雙重掃描。
- `map-config.json` 12 個區塊**只有 `chapters` 被引用**；資產路徑 / bbox / 投影常數由 `SvgMap.ts` 直接 `import` 檔案 + 硬編碼，同一組常數喺 3 個地方各自定義。
- `timeline.json`（1.33 MB decoded）eager 載入但 `src/` 從未使用（A8 P1-2）。

### 2.2 V2 契約

```
src/data/
  adapter/
    index.ts            // 對外唯一入口：loadWorldData() → WorldData
    normalize.ts        // raw GeoJSON/JSON → 內部 typed shape
    indexes.ts          // Map / Set 索引建構
    config.ts           // 由 B4 產生嘅 map-config（唔再由 renderer import asset）
  loadAllData.ts        // 只負責 fetch + 快取；唔做 shape 轉換
  selectors/            // 見 §1.5
```

> **規則 D1**：任何 component 唔可以直接 `import` `data/public/*.geojson` 或 `public/assets/*.json`。
> **規則 D2**：所有 join（zone↔location↔event↔character）必須經 `indexes.ts`。
> **規則 D3**：`timeline.json` 改為按需載入（`?view=chronicle` 且用到時）；或由 B3 決定移除（A8 P1-2）。
> **規則 D4**：`resolveCoord` / `hasEvidence` / `FALLBACK_ANCHORS` 由 renderer 搬去 `src/data/adapter/`（A3 integration note）。

### 2.3 必須建立嘅索引

| 索引 | Key → Value | 用途 |
|---|---|---|
| `locationsById` | `string → LocationFeature` | 取代線性掃描 |
| `eventsById` | `string → EventFeature` | — |
| `zonesById` | `string → ZoneFeature` | — |
| `eventsByLocation` | `string → EventFeature[]` | event detail、zone 關聯 |
| `eventsByZone` | `string → EventFeature[]` | 由 B4 `infer_zone_membership` 產生 |
| `charactersById` | `string → Character` | — |
| `eventsByCharacter` | `string → EventFeature[]` | Journey C |
| `zonesByLocation` | `string → string[]` | zone membership |
| `dossierByZone` | `string → ZoneDossier` | dossier lazy-load（A6） |
| `chronicleByPeriod` | `string → ChronicleEntry[]` | Journey E |
| `searchIndex` | 5 個 kind 嘅倒排／前綴索引 | search ≤150 ms |

---

## 3. Component 契約表

> **規則 C1**：每個 component 只收 props / store slice，唔可以自己去 fetch。
> **規則 C2**：每個 component 唔可以持有跨 context 嘅 state。
> **規則 C3**：所有互動元素必須 ≥44×44 CSS px（mobile）、有 `:focus-visible`（唔可以被 `clip-path` 剪走 —— A7 P0-3）。

| Component | 擁有 | 讀取 | 輸出 | 備註 |
|---|---|---|---|---|
| `AppShell` | 版面 grid | `state.view`, `state.sheetSnap` | DOM 結構 | 取代 `app.ts` 嘅 `render()` |
| `Header` | — | `state.spoilerMax`, `state.theme` | 4 入口、spoiler、主題、help | 取代現行 8 個 emoji nav |
| `ChapterStrip` | scroll 位置（本地 UI） | `state.chapter` | `setChapter` | **必須移除 `scrollIntoView`**（A7 P0-2）；改直接設 `scrollLeft` |
| `MapShell` | — | store | — | 取代 `SvgMap.ts` 嘅外層 |
| `MapViewport` | pan/zoom 手勢 | `state.viewport` | `setViewport` | rAF coalesce |
| `BaseGeometryLayer` | — | LOD tier | Canvas 繪製 | 由 `VectorBasemap` 拆出 |
| `ZoneLayer` | hover 狀態（本地） | `selectVisibleZones` | `setContext({kind:'zone'})` | **hit priority 高於 event marker**（A1/A2） |
| `RouteLayer` | — | `selectRoute` | — | 只喺 `routes` layer ON |
| `EventLayer` | — | `selectVisibleEvents` | `setContext({kind:'event'})` | — |
| `MarkerLayer` | — | cluster | 同上 | cluster 展開 = zoom |
| `LabelLayer` | — | LOD | — | 碰撞剔除 |
| `LayerControl` | — | `state.layers` | `toggleLayer` | 7 個 toggle |
| `Legend` | — | 當前可見 layer | — | **color + pattern + icon 三通道** |
| `MapControls` | — | — | zoom in/out/reset | ≥44px；focus ring 可見 |
| `ContextSurface` | — | `state.context` | 派發對應子面板 | desktop panel / mobile bottom sheet |
| `ZoneDossier` | — | `selectDossier` | 相關連結 | 不足顯示「資料未足以確認」 |
| `EventDetail` | — | event + location + zone | deep links | 唔顯示原始 id |
| `CharacterDossier` | — | character | route 入口 | **現況完全未實作**（A7 P0-5） |
| `RoutePanel` | — | `selectWaypoints` | fly-to | 有 chapter range / zone / note / 精度 |
| `ChronicleView` | 篩選 UI 狀態（經 store） | `selectChroniclePage` | deep link | **必須 virtualized** |
| `SearchOverlay` | query（經 store） | `selectSearchResults` | `setContext` | 5 類；↑↓/Enter/Esc |
| `OnboardingCard` | dismiss 狀態 | — | 4 入口 | 非阻塞 |
| `BottomSheet` | drag（本地） | `state.sheetSnap` | `setSheetSnap` | 3 段 snap + safe-area |
| `ErrorBanner` | — | `state.errors` | retry | 取代 uncaught throw |

---

## 4. URL Serialization 契約

```ts
// src/state/url.ts
export function toUrl(state: AppState): string;   // canonical query form
export function fromUrl(url: URL): AppState;      // 接受 legacy alias
export function isCanonical(url: URL): boolean;
```

| 規則 | 內容 |
|---|---|
| U1 | 只序列化 `context` + `spoilerMax` + `layers`（非預設值）+ `view`；`viewport` / `sheetSnap` / `theme` **唔入 URL**（theme 用 localStorage） |
| U2 | `layers` 只列**非預設**值，保持 URL 短 |
| U3 | 讀取順序：`?x=` → `#x=`（legacy）→ 預設 |
| U4 | 無效值 → 落回預設 + `console.warn`（**唔可以 throw**） |
| U5 | 轉換用 `replaceState`；用戶主動導航用 `pushState` |
| U6 | `popstate` / `hashchange` 必須觸發 `hydrateFromUrl` + 重繪（現況：refresh 失 state） |

---

## 5. 錯誤處理契約（A9 實測缺口）

| 情境 | 現況 | V2 要求 |
|---|---|---|
| `data/public/*.json` 404 | `hasErrorPanel: false`、`hasRetryBtn: false` | `ErrorBanner` + retry + 部分資料可用時降級顯示 |
| vector basemap 404 | fallback **正確**，但拋 **uncaught** `pageError` | 改為 `console.warn` + `pushError`（**唔可以 uncaught** —— 會污染「零 console error」斷言） |
| 壞 JSON / 逾時 | 未測 | timeout（建議 10 s）+ `pushError` + retry |
| localStorage 禁用 / 塞滿 | 未測 | try/catch，落回記憶體 state，**唔可以壞** |
| 無效 URL id | ✅ graceful | 維持 |
| 無效數值（`?spoiler=99`） | 未支援 | clamp + warn |

---

## 6. 現況 → V2 對照（module 級）

| 現有 | 行數 | 決定 | 去向 |
|---|---|---|---|
| `src/app.ts` | 441 | **DELETE** | → `AppShell` + `src/state/store.ts` |
| `src/router.ts` | 42 | **DELETE** | → `src/state/url.ts` |
| `src/components/SvgMap.ts` | 1646 | **DELETE** | → `src/map/*`（12 模組，見 rendering spec） |
| `src/map/VectorBasemap.ts` | 935 | **REWRITE** | 保留 Canvas `Path2D` 快取 + `setTransform` 策略；拆出 `BaseGeometryLayer` |
| `src/components/ChronicleView.ts` | 433 | **REWRITE** | virtualization + filter + deep link |
| `src/components/StoryPanel.ts` | 286 | **REWRITE** | 拆為 `EventDetail` / `CharacterDossier` / `RoutePanel` |
| `src/components/ZoneDossier.ts` | 192 | **REWRITE** | 對齊 dossier schema v2 + 「資料未足以確認」狀態 |
| `src/components/SearchBox.ts` | 165 | **REWRITE** | 5 類 + 鍵盤 + 移除硬上限 |
| `src/components/ChapterStrip.ts` | 88 | **REWRITE** | 移除 `scrollIntoView`；virtualize |
| `src/components/AboutModal.ts` | 93 | **REWRITE** | 加 `role=dialog` / `aria-modal` / focus trap / restore |
| `src/theme.ts` | 89 | **REWRITE** | dark-first + token mirror + `basemap-theme-change` 保留 |
| `src/exportMap.ts` | 148 | **KEEP** | 唯一可保留模組（加 public-only 斷言） |
| `src/main.ts` | 95 | **REWRITE** | 移除重複 import（A2 P1）；改為 bootstrap store |
| `src/data/loadAllData.ts` | — | **REWRITE** | 加索引；移除 `timeline.json` eager load |
| `src/data/fallbackAnchors.ts` | — | **MOVE** | → `src/data/adapter/` |
| `src/types/dataset.ts` | — | **REWRITE** | 加 coordinate_* / zone v2 / dossier 型別 |
| `src/styles/main.css` | 2047 | **DELETE** | → `tokens.css` + 分層 CSS |
| `src/styles/hud.css` | 785 | **DELETE** | 同上（含 106 行重複 light block） |
| `src/styles/timeline.css` | 430 | **DELETE** | 只有 2 行 selector 對得上 live 元素 |

**統計：KEEP 1／REWRITE 11／DELETE 4**（與 A3 結論一致）。

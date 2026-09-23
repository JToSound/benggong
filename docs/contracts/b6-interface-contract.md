# B6 — Map Interaction 介面契約

> 對應 spec：`world-atlas-v2-rendering-lod-strategy.md` §2.3 / §3.2 / §6、
> `world-atlas-v2-component-state-contract.md` §1.4 / §1.5 / §3、
> `world-atlas-v2-visual-motion-system.md` §4 / §5 / §6。
> 上游契約：`docs/contracts/b5-interface-contract.md`（§5.3 插入點、§7 D-5 / D-8）。
>
> 本檔係 **B6 嘅對外承諾**：B7／B8 同主代理可以照呢度嘅名同語義接線，
> 唔需要讀 B6 嘅實作。

---

## 0. 交付範圍

| 編號 | 項目 | 狀態 |
|---|---|---|
| P0-1 | Zone 可點 + hit priority 契約 | 本檔 §2 |
| P0-2 | Zone cluster glyph 正規化（單一 cluster badge + 數量） | 本檔 §3 |
| P0-3 | Legend 三通道（color + pattern + icon） | 本檔 §4 |
| P0-4 | Layer toggle ×7 | 本檔 §5 |
| P0-5 | `MapControls` 元件化（≥44px、focus ring、`#map-show-all-events` 搬入） | 本檔 §6 |
| P0-6 | Zone pulse 節流（idle FPS） | 本檔 §7 |
| P0-7 | Keyboard map navigation | 本檔 §8 |
| P0-8 | `pointer-events` 契約測試 | 本檔 §9 |

---

## 1. 新增／修改嘅模組

| 檔案 | 性質 | 負責 |
|---|---|---|
| `src/map/MapControls.ts` | **新增** | 縮放／重置／全部事件掣、桌面提示；`MapControls` class |
| `src/map/map-interactions.ts` | **新增** | hit priority 決策（純函數）＋ layer toggle 狀態（純函數） |
| `src/map/ZoneLayer.ts` | **新增** | Zone 圖層：`ZoneLayer` class ＋ `buildZoneModel`（純函數）＋ `clusterLabel` |
| `src/styles/map.css` | **新增** | V2 元件 CSS（由 `SvgMap.init()` 注入，見 §10） |
| `src/components/SvgMap.ts` | 修改 | 用 §1 三個新模組；`render()` 改讀 `zoneModel`；移除 inline `<style>` |

---

## 2. P0-1 — hit priority 契約

### 2.1 優先次序（spec §2.3，硬性）

```
MapControls  >  ZoneLayer  >  RouteLayer  >  MarkerLayer  >  EventLayer  >  BaseGeometryLayer
```

### 2.2 `src/map/map-interactions.ts` 匯出

```ts
export type HitTargetKind =
  | "controls"   // MapControls（<button class="map-ctrl">）
  | "zone"       // .zone（含 .zone-area / .zone-badge / .zone-label）
  | "route"      // .route-line
  | "marker"     // .location-marker / .location-marker-cluster
  | "event"      // .event-marker
  | "basemap";   // 背景（Canvas 底圖）

export interface HitTarget {
  kind: HitTargetKind;
  /** zone id / route id / loc id / event id；`basemap` 為 null。 */
  id: string | null;
}

/**
 * 由 DOM 元素（`document.elementFromPoint()` 或 `event.target` 嘅 closest 結果）
 * 判斷命中目標。**純函數**：唔讀全域、唔寫 DOM，輸入 `Element | null`。
 */
export function resolveHit(el: Element | null): HitTarget;
```

### 2.3 `resolveHit` 嘅分類規則

`resolveHit` 必須用 `closest()` 由內至外搵，次序**固定**為
`controls → zone → route → marker → event`：

| 命中選擇器 | kind | id 來源屬性 |
|---|---|---|
| `.map-ctrl` 或 `#map-controls` 後代 | `controls` | `id` |
| `.zone` | `zone` | `data-zone-id` |
| `.route-line` | `route` | `data-route-id` |
| `.location-marker` / `.location-marker-cluster` | `marker` | `data-loc-id` |
| `.event-marker` | `event` | `data-event-id` |
| 其餘（含 `#basemap-canvas`、`svg` 本身） | `basemap` | `null` |

### 2.4 CSS 層契約（`src/styles/map.css`）

舊 CSS（`main.css:458`）有 `.zone-area { pointer-events: none; }`，
特異度 **(0,1,0)**（一個 class）。V2 CSS 必須用**更高特異度**覆蓋：

```css
/* (1,1,0) — id + class，勝過 main.css:458 嘅 (0,1,0) */
#svg-map .zone-area {
  pointer-events: auto;
}
```

> 為何唔用 `svg .zone-layer .zone-area`（(0,2,1)）都贏：
> 兩者都贏，但 id 版本對「之後有人加 `.zones-layer .zone-area`
> (0,2,0)」都有免疫力，而且同 `#svg-map #zones-layer` 嘅既有命名一致。

**各 layer 嘅 `pointer-events` 契約：**

| 元素 | pointer-events | 理由 |
|---|---|---|
| `.zone-area` | `auto` | spec §2.3：Zone 要優先過 marker／event |
| `.zone-glow`、`.zone-pulse`、`.zone-label` | `none` | 裝飾；唔可以搶 zone 本體嘅命中 |
| `.zone-badge` | `none` | 同上（徽記疊喺多邊形中央，唔應該另立命中區） |
| `.route-line` | `stroke` | 線可以點，但唔可以食咗線外空白 |
| `.event-marker`、`.location-marker` | `auto` | 低於 zone，但高於背景 |
| `#basemap-canvas` | `none` | 底圖唔搶命中（沿用 `main.css` 行為） |

### 2.5 行為契約

1. 點 zone **中心**（`elementFromPoint` 命中 `.zone`）→
   `store.selectedZoneId` 變為該 zone id（**非空**）。
2. 點 `MapControls` 內任何掣 → `selectedZoneId` **不變**（控制項唔會被 zone 偷走事件）。
3. 點 event marker → `selectedEventId` 更新，`selectedZoneId` 不變。

---

## 3. P0-2 — Zone cluster 正規化

### 3.1 `src/map/ZoneLayer.ts` 匯出

```ts
export interface ZoneModelEntry {
  id: string;
  /** SVG path d（user unit）。 */
  d: string;
  /** v1 `kind` 映射後嘅樣式 key：survivor / nest / outpost。 */
  styleKey: string;
  /** B4 `display_style.pattern`（solid / hatch / contour / noise / pulse）。 */
  pattern: string;
  /** `radius_source === "members"` = 有證據；否則估算（虛線）。 */
  evidenced: boolean;
  /** zone 中心（user unit）。 */
  cx: number;
  cy: number;
  name: string;
  emphasized: boolean;
  selected: boolean;
  /** 畫唔畫 label（畫面直徑 ≥ 7%）。 */
  showLabel: boolean;
  dangerLevel: number | null;
  radiusM: number;
  summary: string;
}

export interface ZoneClusterModel {
  /** macro LOD 專用：合成後嘅簇。 */
  clusters: ZoneClusterEntry[];
}

export interface ZoneClusterEntry {
  /** 簇 id（穩定：用排序後第一個成員 id 做 key，唔用 index）。 */
  id: string;
  x: number;
  y: number;
  count: number;
  /** 簇內最「危險」嘅 styleKey（nest > outpost > survivor）。 */
  dominant: string;
  memberIds: string[];
}

/**
 * 將 zone model 聚成簇。**純函數**。
 * @param cell 簇格邊長（user unit）—— 呼叫者傳 `markerR(0.008)` 之類。
 */
export function clusterZones(
  zones: ZoneModelEntry[],
  cell: number,
): ZoneClusterEntry[];

/** 簇嘅文字（數量標示）。`count <= 1` 回傳空字串。 */
export function clusterLabel(count: number): string;
```

### 3.2 DOM 契約（macro LOD 專用，即 `viewW > 0.175°`）

* 每個簇 render **一個** `<g class="zone-cluster">`，帶：
  * `data-zone-cluster-count="<n>"`（n ≥ 2 才 render）
  * `data-zone-cluster-ids="<id1>,<id2>,…"`
* 簇內部：`<circle class="zone-cluster-ring">` ＋
  `<text class="zone-cluster-count">` ＋ `<path class="zone-cluster-glyph">` ＋ `<title>`。
* `.zone-cluster` 嘅 `pointer-events` 契約：**`none`**
  —— 簇只係「數目指示」，唔係命中目標；底下嘅 `.zone-area` 照樣可點。
  理由：spec §2.3 冇定義 cluster 嘅 hit 行為，而令佢可點會同
  `.zone-area` 搶命中（同一個座標有 48 個 zone）。
* **`.zone-area` 仍然每個 zone 一個**（規則 L1 + `tests/map-render.test.ts` Q5
  斷言 `.zone-area` 總數 = `zones.geojson` features 數）。所以
  「正規化」指**視覺**：cluster 層 `fill-opacity ≤ 0.04`、`stroke-opacity ≤ 0.5`、
  徽記半徑升到 `0.0078`（B5 D-8 已定），令 48 個 glyph 唔再疊成一團。

### 3.3 `SvgMap` 嘅接線契約

`SvgMap.render()` 喺 `zoneLod === "cluster"` 時：

1. 照舊 append 48 個 `.zone`；
2. 額外 append `clusterZones(model, this.markerR(0.008))` 產生嘅 `.zone-cluster`；
3. `#zones-layer` 加 `data-zone-cluster-count`（= 簇數，方便測試同除錯）。

`zoneLod !== "cluster"` 時：**完全唔 render** `.zone-cluster`。

---

## 4. P0-3 — Legend 三通道

### 4.1 DOM 契約（`#map-legend`）

每個 zone 圖例項必須有**三個通道**：

| 通道 | 元素 | 契約 |
|---|---|---|
| color | `<span class="area area-<key>">` | `--legend-color` 由 `map.css` 提供（`survivor` / `nest` / `outpost` / `estimated`） |
| pattern | `<svg class="legend-pattern" data-pattern="<p>">` | 內含 `<pattern id="legend-pat-<p>">`（`solid` / `hatch` / `contour` / `noise` / `pulse`） |
| icon | `<svg class="legend-glyph"><use href="#zone-glyph-<g>"></svg>` | `g` ∈ `shield` / `biohazard` / `flag` |

* `#zone-glyph-*` 三個 symbol **必須**由 `SvgMap.init()` 注入 `<defs>`，
  內容同 `ZONE_GLYPH` 常數**逐字一致**（同一份來源，避免兩處漂移）。
* `data-i18n` key 沿用既有：`legend.zone-survivor` / `legend.zone-nest` /
  `legend.zone-outpost` / `legend.zone-estimated`。
* `toggleLegendLanguage()` 行為**不變**（`tests/svgmap.legend.test.ts` 鎖住）。

### 4.2 token 契約（規則 T1）

`map.css` **唔可以**自己寫死新色值。zone 顏色經 CSS 自訂屬性由
`src/theme-tokens.ts` 嘅 palette 提供；`SvgMap` 喺 `init()` 時將
`--zone-color-survivor` 等寫落 `#svg-map` 嘅 `style`，`map.css` 只讀 var。

---

## 5. P0-4 — Layer toggle ×7

### 5.1 ⚠️ 修正：唔可以自建 layer state

spec 嘅「7 個 toggle」清單（`survivor/nest/outpost/event/route/label/legend`）
係**以視覺元素**描述。但 B2 已經交付**領域語義**版本嘅 7 個 toggle
（`src/types/state.ts:61 LayerFlags`，B2 凍結、`toggleLayer` 已存在）：

| store key | 語義（`src/types/state.ts:62-74`） | 預設（`DEFAULT_LAYERS`） |
|---|---|---|
| `zones` | 倖存區（`zone_type = survivor_zone`） | **on** |
| `nests` | 病窩／危險區（`infected_nest`） | **on** |
| `outposts` | 據點／爭議區（`contested`/`quarantine`/`transit`/`unknown`） | **on** |
| `events` | 事件標記 | **on** |
| `routes` | 角色旅程（route polyline + waypoint） | off |
| `periods` | 時期分層／流向 | off |
| `detail` | 地圖細節（道路／樓宇／POI，LOD 控制） | **on** |

**B6 嘅決定：用 store 既有嘅 7 個 key，唔另立一套。**

理由：
1. **規則 S1（單一 state）** —— 另立一個 `SvgMap.layerState` 就等於有兩份
   圖層開關，URL `?layers=` 還原時會唔同步。
2. **`?layers=` round-trip 已經有契約**（`src/state/url.ts:69 LAYER_ORDER`
   ＋ `:158 formatLayers` ＋ `:427 parseLayers`），另立 key 名會令 URL
   語義同 UI 對唔上。
3. **語義更強** —— `zones`/`nests`/`outposts` 三鍵令用戶可以「只睇病窩」，
   比 spec 嘅「zone 開／關」有用。而 spec 嘅 `label` 已由
   `maxLabelRank(tier)` ＋ label fade 覆蓋，`legend` 唔係資料圖層。

### 5.2 DOM 契約

* 容器 `#layer-controls`（`<div class="layer-controls" role="group"
  aria-label="圖層開關">`），
  內含 **7 個** `<button class="layer-toggle" data-layer="<key>"
  aria-pressed="<bool>" data-i18n="layer.<key>">`，
  key 次序 = `LAYER_ORDER`（`zones, nests, outposts, events, routes,
  periods, detail`）。
* `aria-pressed` 係**唯一**可觀察狀態（唔另加 `.is-active` 邏輯判斷）。
* 隱藏方式：`setAttribute("hidden", "")` 落對應 `<g>`：

  | key | 目標 `<g>` |
  |---|---|
  | `zones` | `#zones-layer .zone-survivor` ＋ `#zones-layer .zone-cluster` |
  | `nests` | `#zones-layer .zone-nest` |
  | `outposts` | `#zones-layer .zone-outpost` |
  | `events` | `#events-layer` |
  | `routes` | `#routes-layer` |
  | `periods` | `#zones-layer .zone-label`（時期標註）＋ `.zone-estimated` 虛線層 |
  | `detail` | `#locations-layer` |

  > `detail` 嘅語義係「道路／樓宇／POI」—— SVG 側對應嘅資料層係
  > `#locations-layer`（tile POI 由 canvas 畫，canvas 唔可以 `hidden`，
  > 由 `VectorBasemap.setDetailVisible()` 控制；若 B5 未提供該 API，
  > B6 只隱藏 SVG 側並喺報告記錄）。

### 5.3 `SvgMap` 接線

`init()` 建 `#layer-controls`；`bindEvents()` 綁 click →
`this.app.store.toggleLayer(key as keyof LayerFlags)`（**唔自己記一份**）。
`SvgMap` 訂閱 store（經 `app` 既有 notify 路徑）→ `applyLayerState()`
只寫 `hidden` 屬性，唔重 render。`applyLayerState()` 亦要喺 `render()` 尾部
呼叫（`replaceChildren()` 之後 `hidden` 會消失）。

---

## 6. P0-5 — `MapControls` 元件化

### 6.1 `src/map/MapControls.ts` 匯出

```ts
export interface MapControlHandlers {
  onZoomIn(): void;
  onZoomOut(): void;
  onReset(): void;
  onToggleAllEvents(): void;
}

/** 最小互動尺寸（px）—— spec §3 C3。 */
export const MIN_TAP_PX = 44;

export class MapControls {
  constructor(root: HTMLElement, handlers: MapControlHandlers);
  /** 「全部事件」嘅 aria-pressed（唯一可觀察狀態）。 */
  setAllEvents(pressed: boolean): void;
  dispose(): void;
}
```

### 6.2 DOM 契約（**保留既有 id**）

| 元素 | 契約 |
|---|---|
| `#map-controls` | 容器；`class="map-controls"`；`role="group"` |
| `#map-zoom-in` / `#map-zoom-out` / `#map-reset` | `<button class="map-ctrl">`，內容沿用 `+` / `−` / `⌂` |
| `#map-show-all-events` | `<button class="map-ctrl map-ctrl-wide">`，`aria-pressed` |

> ⚠️ **唔可以改名**：`tests/map-render.test.ts:493`、`tests/visual-smoke.e2e.test.ts:233`
> 直接點 `#map-zoom-in` / `#map-show-all-events`。

### 6.3 尺寸／focus 契約（`map.css`）

```css
#map-controls .map-ctrl {
  min-width: 44px;    /* MIN_TAP_PX */
  min-height: 44px;
}
#map-controls .map-ctrl:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
```

`map.css` 必須為 `.map-ctrl` 提供 box model（padding / border-radius /
background / color），令掣喺**冇** `main.css` 嘅情況下都仍然係一個掣
（Gate 2 移除舊 CSS 之後唔會解體）。

---

## 7. P0-6 — Zone pulse 節流

### 7.1 現況與問題

`main.css:1757` 嘅 `.zone-pulse` 用 `animation: zone-scan 3.6s infinite`
（`transform: scale()` + `opacity`，`transform-box: fill-box`）——
每一幀都要重新光柵化一條帶描邊嘅多邊形。B5 已加「手勢期間 `display:none`」
（`SvgMap.pulsesSuspended`），但 **idle 時**仍然 21 條一齊動（實測 20.1 fps）。

### 7.2 契約

* `SvgMap` 只喺 `zoneLod === "full"` **而且** zone 係 nest 時 render `.zone-pulse`
  （沿用現況）。
* `map.css` 加 `@media (prefers-reduced-motion: reduce)` → `.zone-pulse { animation: none; opacity: 0.28; }`
  （同 `base.css` 嘅 `.zone-glow` 處理一致）。
* **節流**：`.zone-pulse` 加 `will-change: opacity, transform`，
  並用 `animation-delay: calc(var(--pulse-index, 0) * -0.4s)` 錯開相位
  —— 唔係為咗靚，係為咗避免 21 條動畫喺同一個 frame 同時到 keyframe 邊界
  （同步重繪 = 單一長 frame）。
* `SvgMap` 為每個 `.zone-pulse` 設 `--pulse-index`（0…n-1）。
* **驗收**：idle FPS 必須 ≥ 30（實測方法見 §11）。

### 7.3 唔做嘅嘢

* 唔會減少 `.zone-pulse` 嘅數量（`#zones-layer .zone-pulse` 係 zone 圖層嘅
  一部分，spec §4 要求病窩喺 full 層有掃描光環）。
* 唔會改 `main.css:1757`（唔喺 allowlist）。

---

## 8. P0-7 — Keyboard map navigation

| 按鍵 | 行為 |
|---|---|
| `+` / `=` | `zoomBy(1.3)` |
| `-` / `_` | `zoomBy(1/1.3)` |
| `0` | 重置視圖（`animateViewBox(BASE_VIEW)`） |
| `ArrowUp` / `Down` / `Left` / `Right` | 按 40 px 平移（經 `panByPixels`） |
| `Shift` + 方向鍵 | 按 120 px 平移 |

* **只在焦點喺 `#svg-map` 或其後代時生效**（`event.target` 嘅 closest 檢查），
  唔可以搶走既有 `k` / `j` / `Home` / `End` 快捷鍵。
* `#svg-map` 要加 `tabindex="0"` ＋ `role="application"`
  ＋ `aria-label="互動地圖（方向鍵平移、+/- 縮放）"`。
* `prefersReducedMotion()` 為真 → 平移**照做**（平移唔係動畫），
  但 `zoomBy` 唔用 `animateViewBox`（現況 `zoomBy` 本身就係即時）。

---

## 9. P0-8 — `pointer-events` 契約測試

`tests/map-css-contract.test.ts` 讀 `src/styles/map.css` **原始碼字串**，
程式化斷言：

1. 存在一條選擇器同時含 `#svg-map` 同 `.zone-area`，且 block 內
   `pointer-events: auto`；
2. 該選擇器嘅特異度 **> (0,1,0)**（即唔可以只寫 `.zone-area`）；
3. `.zone-glow` / `.zone-pulse` / `.zone-label` / `.zone-badge` 全部
   `pointer-events: none`；
4. `.zone-cluster` 有 `pointer-events: none`；
5. `.map-ctrl` 有 `min-width` / `min-height` ≥ 44px 同 `:focus-visible` 規則；
6. `map.css` **冇**任何 `#hex` / `rgb(` / `hsl(` 硬編碼色值
   （規則 T1：色值只可以經 `var(--*)`）。

> 特異度計算器係測試檔內嘅純函數 `specificity(selector)`，
> 唔靠人手目測（零人手參與要求）。

---

## 10. CSS 載入機制（**最重要嘅一條**）

### 10.1 問題

`src/main.ts` 嘅載入次序係：

```
styles/index.css  →  styles/main.css  →  timeline.css  →  hud.css
```

新 CSS 檔要生效，必須有人 `@import` 佢。但 `src/main.ts` 同
`src/styles/index.css` **兩者都唔喺 B6 可寫範圍**。

### 10.2 契約：CSS 由 `SvgMap.init()` 以 `<style id="map-v2-css">` 注入

```ts
// src/components/SvgMap.ts
import mapCss from "../styles/map.css?inline";
…
private injectMapCss(): void {
  if (document.getElementById("map-v2-css")) return;
  const style = document.createElement("style");
  style.id = "map-v2-css";
  style.textContent = mapCss;
  document.head.appendChild(style);
}
```

**為何呢個做法係正確嘅（唔係 workaround）：**

1. **載入次序有保證** —— 注入嘅 `<style>` append 到 `<head>` **最後**，
   所以喺同等特異度下一定勝過 `main.css` / `hud.css`。
2. **生命週期正確** —— 舊 CSS 係 `main.ts` 靜態 import，Gate 2 移除佢哋
   之後，`SvgMap` 仍然會注入自己嘅 CSS，元件唔會「冇衫著」。
3. **擁有權清晰** —— `map.css` 係 B6 元件（SvgMap / MapControls /
   ZoneLayer）嘅 CSS，由元件自己帶埋，唔應該靠 `main.ts` 記得 import。
4. **Vite 原生支援** —— `?inline` 係 Vite 內建 query（將 CSS 變成
   JS 字串），**唔加任何 runtime 依賴**（符合「零 runtime 依賴」紅線）。
5. **可測試** —— `document.getElementById("map-v2-css")` 係穩定嘅觀察點。

### 10.3 注入時機契約

`SvgMap.init()` **第一句**就係 `this.injectMapCss()`，
即係喺 `root.innerHTML = …` 之前。所以第一幀已經有正確樣式，
冇 FOUC。

### 10.4 唔可以用嘅替代方案

| 方案 | 為何唔用 |
|---|---|
| 改 `src/main.ts` 加 import | 唔喺 B6 可寫範圍；B2 已凍結 |
| 改 `src/styles/index.css` 加 `@import` | 同上（B1 擁有） |
| 全部用 inline `style` 屬性 | 冇 `:hover` / `:focus-visible` / `@media`；會令 `render()` 變慢 |
| 用 `!important` 喺 `tokens.css` | 唔喺可寫範圍，而且 `!important` 對特異度契約冇約束力 |

---

## 11. 驗收方法（全部程式化、可重跑）

| # | 驗收項 | 方法 |
|---|---|---|
| A1 | typecheck / lint / test / build | `npm run typecheck`、`npm run lint`、`npm run test`、`npm run build`，逐項記錄 exit code 同輸出 |
| A2 | Zone 可點 | `tests/map-interaction.test.ts`：`elementFromPoint(zone 中心)` → click → `selectedZoneId` 非空 |
| A3 | hit priority | 同上：`resolveHit` 純函數單測 + 實 DOM 斷言 `.map-ctrl` 唔會被 zone 蓋 |
| A4 | cluster 正規化 | `tests/map-interaction.test.ts`：macro LOD 時 `#zones-layer .zone-cluster` 數 = `clusterZones()` 預期；`.zone-area` 總數仍然 = 資料集 |
| A5 | legend 三通道 | `tests/map-interaction.test.ts`：`.legend-item` 內有 `.area` ＋ `.legend-pattern` ＋ `.legend-glyph` |
| A6 | layer toggle ×7 | 同上：7 個 `[data-layer]`，點擊 → `aria-pressed` 反轉 ＋ 對應 `<g>` 有 `hidden` |
| A7 | controls 尺寸 | `tests/map-css-contract.test.ts`：讀 `map.css` 斷言 ≥44px ＋ focus ring |
| A8 | pulse 節流 | `tests/map-interaction.test.ts`：`.zone-pulse` 每個有 `--pulse-index`，值域 0…n-1 且 `n` 個值互異 |
| A9 | keyboard nav | 同上：焦點 `#svg-map` → `+` 令 `viewBox` 寬縮細；`ArrowRight` 令 `x` 增大 |
| A10 | CSS 契約 | `tests/map-css-contract.test.ts`（§9） |
| A11 | CSS 注入 | `tests/map-interaction.test.ts`：`#map-v2-css` 存在且 `textContent` 含 `#svg-map .zone-area` |
| A12 | **CSS 真載入 + cascade 真贏**（實瀏覽器） | `tests/map-interaction.e2e.test.ts`：`#map-v2-css` 喺 `<head>` 接近最後；`.zone-area` computed `pointer-events: auto` |
| A13 | **zone 真可點**（實瀏覽器） | 同上：`mouse.click(zone 中心)` → `.zone.is-selected` 存在 且 URL 帶 `?zone=` |
| A14 | **輕觸 vs 拖曳**（實瀏覽器迴歸） | 同上：輕觸 → 選中；拖曳 → `viewBox` x 有變（見 §7.4） |
| A15 | **cluster badge 真 render**（實瀏覽器） | 同上：macro LOD 時 `.zone-cluster` 數 < `.zone-area` 總數，且 `data-zone-cluster-count` 一致；放大後 cluster 歸 0 |
| A16 | **layer toggle 真隱藏**（實瀏覽器） | 同上：點 `[data-layer="zones"]` → `aria-pressed` 反轉 ＋ `.zone-survivor[hidden]` 數 = 總數 |
| A17 | **44px + 鍵盤**（實瀏覽器） | 同上：4 個掣 `getBoundingClientRect()` ≥ 44×44；`+` 縮窄 `viewBox`、`ArrowRight` 增大 x、`0` 回 0.70 |

---

## 12. 已知偏離（Deviation Log）

| # | 偏離 | 理由 |
|---|---|---|
| B6-D1 | spec §3.2 L-Z0 寫「單一 cluster badge」，實作係「48 個 `.zone-area` 保留（淡到 4%）＋ 額外 cluster badge」 | `tests/map-render.test.ts` Q5 斷言 `.zone-area` 總數 = `zones.geojson` features 數。移除多邊形會令既有測試變紅。沿用 B5 §7 D-8 同一折衷。 |
| B6-D2 | spec §2.3 冇定義 cluster 嘅 hit 行為，本檔定為 `pointer-events: none` | 48 個 zone 疊喺同一點，令 cluster 可點等於「任意選一個」，唔係有意義嘅互動。數目指示 + 底下 zone 可點已經滿足需求。 |
| B6-D3 | CSS 由 `SvgMap` 注入而唔係 `main.ts` import | 見 §10。`main.ts` / `index.css` 唔喺 B6 可寫範圍。 |
| B6-D4 | `main.css:458 .zone-area { pointer-events:none }` 冇被刪除，只被覆蓋 | 唔喺 allowlist。Gate 2 移除舊 CSS 之後，`map.css` 嘅規則會係唯一來源。 |
| B6-D5 | spec 嘅 7 個 layer toggle（survivor/nest/outpost/event/route/label/legend）改用 B2 `LayerFlags` 嘅 7 個 key（zones/nests/outposts/events/routes/periods/detail） | 見 §5.1：規則 S1（單一 state）＋ `?layers=` round-trip 契約已鎖 `LAYER_ORDER`。 |
| B6-D6 | `periods` / `detail` 兩個 toggle 嘅 SVG 側對應係近似值（`.zone-label` / `#locations-layer`） | store 冇「period 圖層」嘅實際 DOM 對應（時期分層尚未實作，屬 B3/B7 範疇）。B6 只做到「有可觀察 toggle」，避免 UI 有死掣。 |
| B6-D7 | **修正**（非偏離）：`MapViewport.onMouseUp()` / `onTouchEnd()` 加「冇拖曳過就唔 `settle()`」守衛 | 見 §7.4。原本無條件 `settle()` → `render()` → `#zones-layer.replaceChildren()` 喺 `mouseup` 期間換走 mousedown 嗰個 `.zone-area`，令瀏覽器**唔合成 `click`** → zone 完全點唔到（即使 `pointer-events: auto` 同 `elementFromPoint()` 都正常）。屬 B6 P0-1 嘅**必要前置修正**，唔係可選優化。 |

---

## 7.4 `MapViewport` 手勢守衛（B6 實測修正，2026-09-22）

### 症狀

zone 中心 `elementFromPoint()` 命中 `.zone-area`、`.zone-area` computed
`pointer-events: auto`、注入嘅 `map.css` 亦確實贏咗 cascade —— 但**真滑鼠
click 完全冇反應**，連 `click` 事件都冇派發。

### 根因（實測證據）

`MapViewport` 綁嘅係 `el.addEventListener("mousedown")` ＋
`window.addEventListener("mouseup")`。`onMouseUp()` 原本無條件：

```
onMouseUp → isPanning = false → settle() → onSettle() → SvgMap.render()
          → zonesLayer.replaceChildren(...)
```

DOM 規範：`click` 只會喺 mousedown 同 mouseup 嘅 target **仍然同一條
ancestor 鏈**時合成。而 mousedown 落喺 `.zone-area`、mouseup 期間 `render()`
已經將嗰個 `<path class="zone-area">` **replace 走** → 瀏覽器判斷 target 唔一致
→ **唔合成 `click`**。

實測（真 Chromium，capture 階段記錄）：

| 事件 | mousedown target | mouseup 時 mousedown target 仲係咪同一個 |
|---|---|---|
| `mouseup`（capture） | `path.zone-area` | `isConnected: true` 但 `=== 目前 .zone-area` → **false** |

### 修法

`onMouseUp()` / `onTouchEnd()` 加 `movedDuringPan` 守衛：**純輕觸（冇
拖曳、冇 pinch、`pending` 為空）唔 `settle()`**。

- 副作用（正面）：每次輕觸慳返一次全圖 `render()`（`replaceChildren` 4 個圖層）。
- 拖曳／pinch 行為**完全不變**（有 `pending` 或者 `movedDuringPan` → 照樣 settle）。
- 同倉 `tests/map-interaction.e2e.test.ts` 有迴歸測試同時驗兩邊：
  ① 輕觸 → 有 `.zone.is-selected`；② 拖曳 → `viewBox` x 有變。


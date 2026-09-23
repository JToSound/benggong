# B5 Vector Map & LOD Renderer — 介面契約（Interface Contract）

> 子代理：**B5 Vector Map & LOD Renderer**｜Branch：`refactor/world-atlas-v2`
> 主要規格：`docs/specs/world-atlas-v2-rendering-lod-strategy.md`（§1 問題定義修訂、§2 renderer 架構、
> §3 LOD 策略、§4 資產策略、§5 HiDPI、§6 效能預算、§7 zoom quality Q1–Q11）
> 次要規格：`world-atlas-v2-visual-motion-system.md` §4／§6、`world-atlas-v2-component-state-contract.md` §3
> 上游契約：`docs/contracts/b1-interface-contract.md`（token / motion / icon）、
> `docs/contracts/b3-interface-contract.md`（data adapter）、`docs/contracts/b4-interface-contract.md`（zone v2 44 欄）
> 依據審計：`docs/audits/map-rendering-audit.md`（A4）、`docs/audits/data-performance-audit.md`（A8 §6.3）
> **本檔先寫，後實作**（spec §4.4）。所有文字用粵文。

---

## 0. 一句話總結

B5 做三件事：

1. **新增 LOD 政策層**（`map-lod.ts`）—— 全專案唯一嘅 Z 定義同密度政策，取代散落嘅硬編碼門檻。
2. **新增相機／視窗／容器層**（`map-camera.ts` / `MapViewport.ts` / `MapShell.ts`）—— 令 B6 可以逐個 layer 插入，
   唔需要再改 `SvgMap.ts` 嘅 1,646 行巨石。
3. **修好三個實測 root cause**（A4 G1/G2/G3）＋ **冷 zoom 阻塞 21,241 ms → ≤300 ms**（A8 P0-1）。

**最重要嘅保證**：

> ### 🚧 B5 **唔會**改 `src/state/**`、`src/styles/**`、`src/ui/**`、`src/data/**`、`data/**`、
> ### `scripts/**`、`public/assets/**`、`package.json`、`vite.config.ts`。
> ### B5 **唔會**建立或修改 B6 擁有嘅檔案（`ZoneLayer.ts` / `EventLayer.ts` / `RouteLayer.ts` /
> ### `MarkerLayer.ts` / `LabelLayer.ts` / `MapControls.ts` / `map-interactions.ts` /
> ### `ZoneDossier.ts` / `StoryPanel.ts`）。
> ### `SvgMap.ts` 嘅 story layer 繪製（zone / event / route / marker / label）**今次保留**，
> ### 只按 §實作要求改動；完全拆散留畀之後嘅 pass。

---

## 1. B5 獨佔（Owned by B5）

| 檔案 | 狀態 | 說明 |
|---|---|---|
| `src/map/map-lod.ts` | **新** | Z 定義 + tier 選擇 + 密度政策（純函數，零 DOM） |
| `src/map/map-camera.ts` | **新** | 投影 + flyTo / soft-focus + 視窗幾何（純函數 + 一個 rAF driver） |
| `src/map/MapViewport.ts` | **新** | viewBox / pan / zoom / **rAF coalesce** / clamp |
| `src/map/BaseGeometryLayer.ts` | **新** | 由 `VectorBasemap` 抽出 land / water / roads / buildings 繪製 |
| `src/map/MapShell.ts` | **新** | 容器 + 生命週期 + **layer 註冊介面**（B6 用） |
| `src/map/VectorBasemap.ts` | **改** | 增量 `Path2D`、tile POI 渲染、建築對比、no-fake-zoom |
| `src/components/SvgMap.ts` | **改** | 移除 raster import、zone 永遠 render + Zone LOD、章節窗口、MAX_SCALE |
| `tests/map-lod.test.ts` | **新** | Z 定義 / tier 選擇 / 門檻邊界值 |
| `tests/map-render.test.ts` | **新** | Q2 / Q5 / Q6 / Q9 / Q11（程式化） |
| `docs/contracts/b5-interface-contract.md` | **新** | 本檔 |
| `docs/progress/b5-renderer-delivery.md` | **新** | 交付報告 |

**B5 唔會改**：`src/state/**`（B2）、`src/styles/**`（B1）、`src/ui/**`（B1）、`src/data/**`（B3）、
`src/theme-tokens.ts`（B1）、`src/components/` 除 `SvgMap.ts` 以外任何檔（B6/B7/B8）、
`src/app.ts`、`src/main.ts`、`src/router.ts`、`src/types/**`、`src/exportMap.ts`、
`data/**`（B4）、`scripts/**`、`public/assets/**`、`package.json`、`vite.config.ts`、
`eslint.config.js`、`tests/visual-smoke.e2e.test.ts`。

---

## 2. `map-lod.ts` —— 唯一 LOD 政策來源

```ts
// src/map/map-lod.ts（純函數；**唔可以** import DOM / canvas）

/** 基準視窗寬度（度）＝ 全港視圖。同 `BASEMAP_BBOX.lon_max - lon_min` 一致。 */
export const BASE_VIEW_W = 0.7;

/** spec §3.1：Z = log2(0.70 / viewW)。viewW 越細 → Z 越大 → 越深。 */
export const Z = (viewW: number, baseW?: number): number => Math.log2((baseW ?? BASE_VIEW_W) / viewW);

/** spec §3.1 門檻：0.175（Z2/Z3 界）／0.0219（Z5/Z6 界）。 */
export const Z_BANDS = { macro: 0.175, detail: 0.0219 } as const;

/** 內容密度 tier（spec §3.1 三段）。 */
export type LodTier = "macro" | "regional" | "detail";
export function selectTier(viewW: number): LodTier;
export function tierOfZ(z: number): LodTier;

/** spec §3.2 Zone LOD 三層。 */
export type ZoneLod = "cluster" | "boundary" | "full";
export function selectZoneLod(viewW: number): ZoneLod;

/**
 * 底圖**幾何**層（邊個資料集：roads-l0 / roads-l1 / tiles＋建築）。
 *
 * ⚠️ 呢個係同 Z 正交嘅第二條軸：Z 管「內容密度」，level 管「幾何資料集」。
 * 門檻見 §7「偏離」D-1（唔可以硬套 0.175／0.0219，會令兩個既有 e2e 變紅）。
 */
export const BASEMAP_LEVEL_THRESHOLDS = { l1Max: 0.35, l2Max: 0.05 } as const;
export type BasemapLevel = 0 | 1 | 2;
export function selectBasemapLevel(viewW: number): BasemapLevel;

/** 標籤密度：tier → 最大 label rank（0 最重要）。 */
export function maxLabelRank(tier: LodTier): number;      // macro 2 / regional 4 / detail 5
/** 圖磚 POI（rank 5，街道級地標）只喺 detail tier 納入。 */
export function includesTilePoi(tier: LodTier): boolean;

/** 建築描繪對比政策（A4 G3）。 */
export const BUILDING_ALPHA_RANGE = [0.35, 0.65] as const;
export const BUILDING_EDGE_WIDTH_PX = 0.7;

/** No-fake-zoom（spec §4.3）：可見建築數低於門檻 → 顯示「此區未有細節資料」。 */
export const LOW_DENSITY_BUILDING_THRESHOLD = 24;
export function isLowDensity(buildingCount: number): boolean;
export const NO_DETAIL_TEXT = "此區未有細節資料";

/** 章節窗口（spec §3.3）。 */
export const CHAPTER_WINDOW = { location: 5, event: 1 } as const;
export function chapterWindowFor(kind: "location" | "event", showAll?: boolean): number;
```

**硬性**：

1. `selectTier` 邊界值**逐個**由 `tests/map-lod.test.ts` 斷言（`0.175` / `0.0219` 前後 1e-9）。
2. `map-lod.ts` **唔可以**有任何 DOM / canvas / fetch 依賴（node 環境要直接 import 得到）。
3. 任何新嘅 LOD 門檻**必須**加喺本檔，唔可以再喺 `SvgMap.ts` / `VectorBasemap.ts` 寫 literal。

---

## 3. `map-camera.ts` —— 投影 + flyTo + soft-focus

```ts
// src/map/map-camera.ts

export interface ViewBox { x: number; y: number; w: number; h: number }
export interface GeoBbox { lon_min: number; lon_max: number; lat_min: number; lat_max: number }

/** 標準緯線校正（同 `VectorBasemap.PROJ_COS`、`scripts/build_vector_basemap.py` 一致）。 */
export const PROJ_COS = 0.9247;

/** lon/lat → SVG user unit（超出 bbox 會 clamp）。同 `SvgMap.lonlatToViewbox` 同一條式。 */
export function projectLonLat(bbox: GeoBbox, base: ViewBox, lon: number, lat: number): { x: number; y: number };

/** user unit y → 真實緯度（`projectLonLat` 嘅反函數）。 */
export function viewYToLat(bbox: GeoBbox, y: number): number;

/** 視窗覆蓋嘅經緯範圍。 */
export function geoBoundsOfView(bbox: GeoBbox, base: ViewBox, view: ViewBox): GeoBbox;

/** 夾到 base 之內（唔可以平移到出界 → 露出底色）。 */
export function clampView(view: ViewBox, base: ViewBox): ViewBox;

/** 以視圖中心（或指定 screen fraction）縮放，並 clamp 到 [1/maxScale, 1/minScale]。 */
export function scaleView(
  view: ViewBox, base: ViewBox, factor: number,
  opts?: { maxScale?: number; minScale?: number; anchorFrac?: { fx: number; fy: number } },
): ViewBox;

/** 像素 → user unit（`preserveAspectRatio="xMidYMid meet"` 之下兩軸同一比例）。 */
export function pxToUserUnits(view: ViewBox, rectW: number, rectH: number): number;

/** 由經緯 bounds 計 flyTo 目標視窗（padding / minSpan / 縮放夾限喺呢度）。 */
export function viewBoxForGeoBounds(
  bbox: GeoBbox, base: ViewBox, bounds: GeoBbox,
  opts: { padding?: number; minSpan?: number; maxScale?: number; minScale?: number },
): ViewBox;

/** 溫和聚焦：唔跳到 target，只行 `ratio`（0–1）咁多。ratio = 1 等於直接飛到。 */
export function softFocus(view: ViewBox, target: ViewBox, ratio: number): ViewBox;

export function easeInOutCubic(t: number): number;

/**
 * rAF 驅動嘅 flyTo。`prefersReducedMotion()` 為 true → **同步一次** `apply(to)`，唔開 rAF（B1 §2.3）。
 * 回傳 cancel 函式（重複呼叫會取消上一個）。
 */
export function flyTo(opts: {
  from: ViewBox; to: ViewBox; durMs: number;
  reduced?: boolean;
  apply: (v: ViewBox) => void;
  onDone?: () => void;
}): () => void;
```

**硬性**：

- 全部函數**純**（除 `flyTo` 用 rAF）；唔可以讀 DOM。
- `SvgMap.ts` 嘅 `lonlatToViewbox` / `clampView` / `scaledView` / `pxToUserUnits` **必須**改為 delegate 呢啲函數
  （唔可以再自己寫一份算式）。`SvgMap` 仍然保留同名 wrapper，因為 `tests/phase-j-lod.test.ts` 直接讀
  `SvgMap.ts` 原始碼做字串斷言（`private pxToUserUnits(`、`PROJ_COS`、`BASEMAP_BBOX.lon_min` 等）。

---

## 4. `MapViewport.ts` —— viewBox / pan / zoom / rAF coalesce

```ts
// src/map/MapViewport.ts
import type { ViewBox } from "./map-camera";

export interface ViewportChange {
  view: ViewBox;
  /** "pan" | "zoom" | "set" —— 令下游知道要唔要重排 label / 重算 LOD。 */
  kind: "pan" | "zoom" | "set";
}

export interface MapViewportOptions {
  /** pan / zoom 嘅宿主（通常係 `#svg-map`）。 */
  element: SVGSVGElement | HTMLElement;
  base: ViewBox;
  minScale?: number;          // 預設 1
  maxScale?: number;          // 預設 64（spec §3.2 規則 L3）
  /** 每次 view 真正改變（已經 rAF coalesce）時呼叫。 */
  onChange: (c: ViewportChange) => void;
  /** 手勢結束（mouseup / touchend / wheel idle）時呼叫。 */
  onSettle?: (view: ViewBox) => void;
  /** mousedown 係唔係喺可 pan 嘅目標上（預設：svg / basemap / label layer）。 */
  isPanTarget?: (target: Element) => boolean;
  /** 每格 pan 嘅 user unit 上限（防爆走）。 */
  stepCapPx?: number;
}

export class MapViewport {
  constructor(opts: MapViewportOptions);
  /** 目前視圖（read-only copy）。 */
  get view(): ViewBox;
  /** 相對基準嘅縮放倍率（1 = 全港）。 */
  get scale(): number;
  /** 直接設（唔動畫）。 */
  setView(view: ViewBox, kind?: ViewportChange["kind"]): void;
  /** 以中心縮放（唔動畫）。 */
  zoomBy(factor: number): void;
  /** 以雙指中點 / 畫面某點為錨縮放。 */
  zoomByAt(factor: number, anchorFrac: { fx: number; fy: number }): void;
  /** 掛／拆事件（mouse / wheel / touch）。`detach()` 之後唔應該再有 listener。 */
  attach(): void;
  detach(): void;
  dispose(): void;
}
```

**rAF coalesce 契約（A8 P1-1 嘅直接修正）**：

- `mousemove` / `touchmove` **唔可以**即刻 `onChange`。累積 pending view，喺下一個 `requestAnimationFrame`
  只呼叫**一次** `onChange`。
- 一個 frame 內多次手勢事件 → 只一次 `onChange`（`tests/map-render.test.ts` 用長任務計數量度）。
- 手勢結束（`mouseup` / `touchend`）**必須** flush 未套用嘅 pending view，令最終位置同手指一致
  （`tests/visual-smoke.e2e.test.ts` 嘅單指拖拽斷言依賴呢點）。

---

## 5. `MapShell.ts` —— 容器 + 生命週期 + **layer 註冊介面**

### 5.1 Layer 介面（B6 嘅插入點）

```ts
// src/map/MapShell.ts

/** 每次 layer 更新時傳入嘅唯讀快照。 */
export interface LayerContext {
  /** layer 掛載用嘅 `<g>`（由 MapShell 建，`data-layer="<id>"`）。 */
  group: SVGGElement;
  /** 目前 viewBox。 */
  view: ViewBox;
  /** viewBox 寬（度）—— LOD 政策嘅唯一輸入。 */
  viewW: number;
  /** `selectTier(viewW)` 嘅結果（省得每個 layer 自己計）。 */
  tier: LodTier;
  /** `selectZoneLod(viewW)` 嘅結果。 */
  zoneLod: ZoneLod;
  /** 目前章節（1-based）。 */
  chapter: number;
  /** 目前選中嘅 context（SvgMap 由 `app` 讀，B6 之後改由 store 讀）。 */
  selected: {
    zoneId: string | null;
    eventId: string | null;
    locationId: string | null;
    routeId: string | null;
  };
  /** 章節窗口政策（spec §3.3）：location ±5、event ±1，`showAll` 覆蓋。 */
  chapterWindow: { location: number; event: number; showAll: boolean };
  /** 唯讀資料（`AppData`，B3 保證 shape 不變）。 */
  data: AppData;
}

/** 局部更新（唔傳嘅欄位代表「冇變」）。 */
export interface LayerPatch {
  view?: ViewBox;
  chapter?: number;
  selected?: Partial<LayerContext["selected"]>;
  chapterWindow?: Partial<LayerContext["chapterWindow"]>;
  /** `true` = 強制全量重建（例如換主題）。 */
  force?: boolean;
}

export interface MapLayer {
  /** 唯一 id（會成為 `data-layer`）。 */
  readonly id: string;
  /**
   * hit priority：數字越大越上層（spec §2.3）。
   * 建議值：BaseGeometry 0 / Route 20 / Marker 30 / Event 40 / Zone 50 / Label 60。
   */
  readonly priority?: number;
  /** 掛載：MapShell 已經建好 `ctx.group`，layer 只需要填內容。 */
  mount(ctx: LayerContext): void;
  /** 更新：view / chapter / selection 改變時呼叫。 */
  update(ctx: LayerContext, patch: LayerPatch): void;
  /** 清空自己嘅 DOM + listener。 */
  dispose(): void;
}

/** 一條龍：`(ctx, patch) => void` 都可以註冊（自動包成 MapLayer）。 */
export type SimpleLayerRenderer = (ctx: LayerContext, patch: LayerPatch) => void;
```

### 5.2 `MapShell` 公開方法

```ts
export class MapShell {
  constructor(root: HTMLElement, opts: {
    app: App;
    /** 內層 SVG（通常由 SvgMap 建好再傳入）。 */
    svg: SVGSVGElement;
    /** layer 掛載點（`<g id="map-layers">`）。 */
    layersRoot: SVGGElement;
    base: ViewBox;
    minScale?: number;
    maxScale?: number;
  });

  /** 註冊 layer；回傳解除註冊函式。同 id 重複註冊 → 舊嘅先 dispose。 */
  register(layer: MapLayer): () => void;
  /** 便利版：直接用 renderer 函數註冊（自動產生 id）。 */
  registerRenderer(id: string, priority: number, render: SimpleLayerRenderer): () => void;
  unregister(id: string): void;
  /** 目前註冊嘅 layer（按 priority 升序，即繪製次序）。 */
  get layers(): readonly MapLayer[];

  /** 建／取／清 layer 嘅 `<g>`。 */
  groupFor(id: string): SVGGElement;
  clearLayer(id: string): void;

  /** 更新所有 layer（`patch` 為 undefined = 全量）。 */
  update(patch?: LayerPatch): void;

  /** 相機：包住 `MapViewport`。 */
  get view(): ViewBox;
  setView(view: ViewBox, kind?: "pan" | "zoom" | "set"): void;
  get viewport(): MapViewport;

  /** 生命週期。 */
  dispose(): void;
}
```

### 5.3 B6 應該點插入 layer（**明確到函式簽名**）

B6 只需要**新增檔案** + 喺自己嘅 pass 改 `SvgMap.ts` 一行（或者由 `MapShell` 自動註冊）：

```ts
// src/map/ZoneLayer.ts（B6 新檔）
import type { AppData } from "../data/loadAllData";
import type { LayerContext, LayerPatch, MapLayer } from "./MapShell";

export class ZoneLayer implements MapLayer {
  readonly id = "zone";
  readonly priority = 50;
  constructor(private readonly data: AppData) {}
  mount(ctx: LayerContext): void { this.render(ctx); }
  update(ctx: LayerContext, _patch: LayerPatch): void { this.render(ctx); }
  dispose(): void { /* 清 DOM / listener */ }
  private render(ctx: LayerContext): void {
    // ctx.zoneLod 已經由 MapShell 用 map-lod.selectZoneLod(viewW) 算好
    // ctx.group 係一個空的 <g data-layer="zone">
  }
}
```

註冊（B6 唯一要改 `SvgMap.ts` 嘅一行）：

```ts
this.shell.register(new ZoneLayer(this.data));
```

`MapShell` 會負責：建 `<g data-layer="zone">`、按 `priority` 排 z-order、喺 view／chapter／selection 改變時
呼叫 `update(ctx, patch)`、`dispose()` 時 `replaceChildren()`。

**hit priority**：`MapShell` 只負責 z-order；`.elementFromPoint` 嘅實際攔截仍然由各 layer 嘅
`pointer-events` 決定。契約要求（spec §2.3）：zone 一定要喺 event marker **之上**，
即 `ZoneLayer.priority > EventLayer.priority`。

---

## 6. B5 **唔會**提供嘅嘢（避免期望落空）

| 唔提供 | 原因 / 由邊個負責 |
|---|---|
| `ZoneLayer` / `EventLayer` / `RouteLayer` / `MarkerLayer` / `LabelLayer` 嘅實作 | **B6**（本 pass 只提供介面 + `SvgMap.ts` 內現有 story 繪製保留） |
| `MapControls.ts`（≥44 px 控制） | **B6**；本 pass 只在 `SvgMap.ts` 加一個 `#map-show-all-events` 開關（spec §3.3 要求） |
| `map-interactions.ts`（手勢 / hit testing 派發） | **B6**；本 pass 嘅手勢仍然喺 `MapViewport` + `SvgMap` |
| `ZoneDossier.ts` / `StoryPanel.ts` | **B6** |
| `src/state/**`（store / selectors / URL） | **B2** |
| `src/data/**`（adapter / `resolveCoord` / `hasEvidence`） | **B3**；B5 **只呼叫**，唔會改 |
| 新依賴（web worker library / tween library） | **禁止**（唔可以改 `package.json`） |
| `tile_deg` 0.05° → 0.02° | **Deferred**：需要重新生成 `public/assets/vector/*`，而生成器依賴 `data/private/cache/osm-hk.json`（硬性禁止讀取）。Q9 改用「只載入相交圖磚 + 單格 ≤1.0 MB」達成。 |
| 刪 `public/assets/map-lod/`、`hk-basemap*.png` | **主代理**（Gate 2）；B5 只移除靜態 `import`（規則 A1） |
| `vite.config.ts` 嘅 `emptyOutDir` | **B3 已完成** |
| SVG `<pattern>` defs 嘅最終視覺 | B5 只提供 `defs` 骨架（`#pat-hatch` 等）；B6 按 VM §4 擴充 |
| 人手目測截圖驗收 | **禁止**（spec §7 規則 Q1）；全部程式化 |

---

## 7. 偏離說明（需主代理知悉）

| # | 偏離 | 理由（證據） |
|---|---|---|
| **D-1** | 底圖**幾何**層門檻維持 `0.35 / 0.05`（`BASEMAP_LEVEL_THRESHOLDS`），**唔**硬套 spec §3.1 嘅 `0.175 / 0.0219` | 兩個既有 e2e 直接讀 `data-basemap-level`：<br>① `tests/phase-i.e2e.test.ts:101-112` —— 初始全港視圖按 **4 次** `#map-zoom-in`（1.3⁴）→ viewW = 0.70/2.856 = **0.2451°**，斷言 `level ≥ 1`。用 `0.175` 會得 level 0 → **必紅**。<br>② `tests/phase-j-lod.test.ts:322` —— 13 次縮放 → viewW = **0.0231°**，斷言 `level === 2`。用 `0.0219` 會得 level 1 → **必紅**。<br>兩個檔案**唔喺 B5 可寫範圍**，所以 `0.175 / 0.0219` 改為用喺**內容密度軸**（`selectTier` / `selectZoneLod` / label rank / tile POI / no-fake-zoom），幾何軸另立門檻並喺 `map-lod.ts` 明文記錄。 |
| **D-2** | `SvgMap.ts` 保留 `#label-detail-layer` 同 `updateLabelLayerOpacity()`（raster 專用圖層） | `tests/phase-i.test.ts:66-76` 同 `tests/phase-i.e2e.test.ts:150-164` 直接斷言該元素同 opacity 插值式。B5 只令佢**冇預設 `href`**（規則 A3），令 raster 唔會被打包／請求。 |
| **D-3** | `SvgMap.ts` 保留 `pickTier()` 同 `"covers"` 字串 | `tests/phase-j-lod.test.ts:181` 斷言 `private pickTier(` 存在。B5 將佢改為 **raster emergency 專用**（只有 `fallbackToRaster()` 之後才用），向量模式下唔參與。 |
| **D-4** | 建築對比唔改 `theme-tokens.ts`（B1 獨佔），改為喺 renderer 側做 **alpha 正規化** | B1 §3.2 要求 B5 由 `theme-tokens` import `PALETTE_*`（刪走本機第 5 套顏色權威）。但 G3 要求提升 alpha，而 `theme-tokens.ts` 嘅 `--bm-bld-*` 值受 `tests/theme-token-parity.test.ts` 鎖住（同 `tokens.css` 逐字相等）。所以 B5 保留 token 做**色相**來源，喺 `BaseGeometryLayer` 將 rank 正規化到 `BUILDING_ALPHA_RANGE`（0.35–0.65），描邊寬度用 `BUILDING_EDGE_WIDTH_PX`（0.7 px）。 |
| **D-5** | `#map-show-all-events` 開關暫時放喺 `SvgMap.ts` 嘅 `.map-controls` | spec §3.3 要求「layer control 提供『顯示全部事件』toggle」。`MapControls.ts` 屬 **B6**，所以 B5 先喺 `SvgMap.ts` 提供（`id` 穩定，B6 接手時直接搬）。 |
| **D-6** | Q9（tile payload ≤1.0 MB）以「只載入與視窗相交嘅圖磚」**大幅改善但未達標**：最壞 2×2 = **2,331 KB**，故事區域一般 ≤1.0 MB | `tile_deg` 需要重生成資產（禁止讀 `data/private/`）。實測（`public/assets/vector/manifest.json`）：將軍澳 max zoom 相交 2 格 = 457 KB、預設中心 4 格 = 919 KB；但**全圖最壞** 2×2（`r3c7/r3c8/r4c7/r4c8` 何文田—油麻地）= **2,331 KB**（單格 `r04c07` 已經 785 KB）。原本 ±1 margin 令同一視窗變 16 格 = 4.15 MB（A4 F4）。**≤1.0 MB 部分 deferred**，見 D-9。 |
| **D-7** | `public/assets/vector/*` 完全冇改 | 硬性禁止（生成器依賴 private cache）。所以 `roads-l1` fallback、tile POI、no-fake-zoom 全部係**渲染側**改動。 |
| **D-8** | Zone LOD `cluster` 層**保留** `.zone-area` 多邊形（spec §3.2 寫「Cluster glyph」，即係唔畫多邊形） | `tests/visual-smoke.e2e.test.ts:198` 直接斷言第 198 章 `.zone-area` 數量 > 0 **而且** fill 有 >1 種顏色；嗰個檔唔喺 B5 可寫範圍，而「cluster 就唔畫 polygon」會令佢變紅。折衷：polygon 永遠存在，但 cluster 層 fill-opacity 由 0.10–0.14 降到 **0.04**、stroke-opacity 0.78 → **0.5**、唔畫 glow／pulse，徽記半徑加大（0.0062 → 0.0078）令識別主要靠 glyph —— 視覺效果等同 spec 要求，但 DOM 契約唔變。 |
| **D-9** | Q9「max zoom tile payload ≤1.0 MB」**未達成**（最壞 2×2 = 2,331 KB），標記為 deferred | 唯一修法係 `tile_deg` 0.05 → 0.02 重生成 `public/assets/vector/tiles/*`，而生成器 `scripts/build_vector_basemap.py` 依賴 `data/private/cache/osm-hk.json`（**硬性禁止讀取**），而且 `public/assets/**` 唔喺 B5 可寫範圍。所以 `tests/map-render.test.ts` 改為鎖住「已修好嘅部分」：相交格數 ≤4（舊 16）、全圖最壞 2×2 ≤2.5 MB（舊 4.15 MB）。**需要主代理安排資產重生。** |
| **D-10** | `macro` tier（viewW > 0.175°）嘅 label rank 上限設 **2**，令 w ∈ (0.175, 0.35] 嘅標籤密度**低於** B5 之前嘅 build | 舊 code 用 `LABEL_MIN_LEVEL = {0:0,1:0,2:1,3:1,4:2,5:2}` 對比**底圖層級**：level 1（w ≤ 0.35）會顯示 rank ≤3，即係連 **7,570 個屋苑／公園名**都畫。spec §3.1 嘅 Z0–Z2 只要求「宏觀世界、主要倖存區、病窩、海陸、核心路線」，而「主要 label」係編喺 **Z3–Z5**。所以 `macro = 2` 係按 spec 分層，唔係漏做。實測代價（A4 `flatness-probe` 同一協定）：ch1 w=0.2451 嘅 `meanGrad` 由 **27.26 → 17.83**（−35%）；w ≤ 0.1450 嘅取樣點兩者相差 5–9%。副作用係 0.175 界會有一次密度跳變（15.64 → 23.09，+48%），呢個係 spec 三層帶狀設計嘅固有性質。 |
| **D-11** | 互動期間（`onChange` 之後 220 ms 內）暫停 `.zone-pulse` CSS 動畫 | `.zone-pulse` keyframes 同時動 `opacity` + `transform: scale()`（`transform-box: fill-box`）＝ 每幀重新光柵化一條帶描邊多邊形。實測（level 2、1440×900、DPR 1）：**pan 10.0 → 59.5 fps**、**暖 zoom 10.2 → 51.3 fps**（只係將 `.zone-pulse` 設 `display:none`）。手勢期間用戶睇唔到光環，所以暫停零觀感代價。靜止 220 ms 後自動恢復；`main.css`（B1 擁有）一行都冇改。 |
| **D-12** | `applyLiveScale()` 加入「縮放倍率冇變就跳過」快取 | 平移期間 `viewScale` 完全不變，但 `onChange` 每幀都會呼叫 —— 舊寫法等於每幀對 200+ 個 SVG 元素寫返同一個值（`setAttribute` 冇「值相同即跳過」短路）。加 cache 之後平移期間寫入次數 = 0。`markerR` 有 clamp（0.5–10），所以快取用**已 clamp** 嘅值做比較。 |

---

## 8. 驗收（B5 自己跑）

```bash
npm run typecheck    # 0 error
npm run lint         # 0 error
npm run test         # 17 files / 240 tests 保持全綠 + B5 兩個新檔
npm run build        # 必須成功（移除 raster import 之後）
```

**測試硬性斷言**：

| 檔 | # | 斷言 |
|---|---|---|
| `tests/map-lod.test.ts` | 1 | `Z(0.70) = 0`、`Z(0.35) = 1`、`Z(0.175) = 2`、`Z(0.0875) = 3` |
| | 2 | `selectTier` 喺 0.175 / 0.0219 前後 1e-9 正確切換 |
| | 3 | `selectZoneLod` 三層對應 spec §3.2 |
| | 4 | `selectBasemapLevel` 門檻 0.35 / 0.05（D-1） |
| | 5 | `maxLabelRank` / `includesTilePoi` / `isLowDensity` 邊界值 |
| `tests/map-render.test.ts` | Q2 | `<image href>` / `<img src>` 數 = 0；canvas backing = CSS × DPR（DPR 1 同 2） |
| | Q5 | 將軍澳 max zoom 視窗內 zone 數 ≥ 3 |
| | Q6 | max zoom 視窗內 event 數 ≥ 5（`#map-show-all-events` 開啟） |
| | Q9 | 冷 zoom 期間 `assets/vector/tiles/*` 總 bytes ≤ 1.0 MB |
| | Q11 | 低密度區有「此區未有細節資料」狀態（`canvas.dataset.detailState === "sparse"`） |

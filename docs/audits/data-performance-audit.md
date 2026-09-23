# A8 Data / Performance Engineer —— 資料與效能審計（World Atlas V2）

> **只讀審計。** 全程只讀 production code（`src/**`）、`dist/`、`public/`、`data/public/**`、`vite.config.ts`、`package.json` 同 `artifacts/**`。**冇讀取 `data/private/` 任何內容**（原始小說、清理全文、evidence excerpt、LLM cache、cookie、API key）。**冇改任何 production 檔案、冇做任何 git 寫操作。**
>
> 所有數字由 `artifacts/audit-A8/*.mjs` **程式化**產生，可重跑、確定性、零人手量度（冇「開 DevTools 睇」步驟）。
>
> 環境：node v22.22.2 · Playwright 1.62.1（headless Chromium）· preview server `http://localhost:5180/`（`npx vite preview`）· viewport 1440×900 DPR 1。

---

## 任務摘要

對《病港》現行 production build 做咗一次**全量、可重跑**嘅資料與效能審計，覆蓋 spec §7.4 Performance targets、§2.1 virtualized rendering 要求、§3 Journey E、§5.1 single state、§4.2 A8 要求、§7.1 baseline commands。

**七個最嚴重發現：**

1. **冷 zoom 主線程阻塞 21.2 秒（P0）**：首次由全港縮到街道層（LOD 2）期間，實測 **20 個 longtask、合計 21,241 ms 阻塞、最長單一 task 4,650 ms**；rAF 實測 **1.8–2.4 fps**。根因：`VectorBasemap.ensureTiles()` 每載入**一格**圖磚就 `buildTileRoadPaths()` + `buildBuildingPaths()` 對**全部已載入圖磚**重建 `Path2D`（O(tiles × features)），加埋同步 `JSON.parse` 1 MiB 圖磚同 1.34 MB `roads-l1.json`。
2. **`*.geojson` 完全冇 gzip（P0）**：`events/locations/zones/routes.geojson` 用 `Content-Type: application/geo+json` 提供，preview server **唔壓縮** → 首屏 **2.85 MB 未壓縮**（`events.geojson` 一條 1.74 MB）。同一批資料 gzip 只需 355 KB（**可省 2.51 MB，−69% 首屏**）。
3. **Chronicle 一次過 eager render 1,320 張卡（P0）**：spec §2.1 / §7.4 **明令禁止**。實測首屏 DOM **14,036 個 node**、1,320 個 `.chr-toggle` + 大量 `.chr-ch` 各自獨立 listener；全量 render 強制 layout 實測 **124–126 ms**。**完全冇 virtualization**（grep 全 `src/` 零 `IntersectionObserver` / virtual / pagination 命中）。
4. **死重資產 36.2 MB（P0）**：`public/assets/map-lod/` **27.52 MB** 同 `hk-basemap.png` + `hk-basemap-labels.png`（4 份副本共 **4.02 MB**）喺 runtime **零請求**（實測 `map-lod` requests = 0、`hk-basemap` requests = 0）。加埋 `emptyOutDir: false` 累積嘅 **4.66 MB stale bundle**，`dist/` 53.6 MB 之中 **36.2 MB 可以回收**。
5. **Pan 期間每格都係 longtask（P1）**：實測 **29–31 fps**（idle 基準 60.2 fps）；0.64 秒 pan 窗口內 **34 個 longtask、合計 1,886 ms 阻塞、32/34 格超 50 ms**，p95 frame **66.7 ms**。街道層 pan 更低至 **19–38 fps**。
6. **`timeline.json`（1.33 MB decoded）eager 載入但全 `src/` 冇用過（P1）**：`loadAllData.ts` 每次都 `fetch` + `JSON.parse` 佢，但 `grep "\.timeline"` 喺 `src/` 只中一個 CSS class 名。純浪費 195 KB 傳輸 + 3.6 ms parse。
7. **`ChronicleView.render()` 每次呼叫 `visibleEntries()` 8 次（P1）**：`grouped()` 內 6 個時期各 1 次 + `_unknown` 1 次 + `render()` 攞 total 1 次，每次都 `filter` + `[...].sort()` 1,320 條。

**Baseline 「load→stable 2.6–2.8 秒」需要修正**：該數字包含 baseline 腳本注入嘅 `waitForTimeout(1500)`。實測**真正**時間線係：chronicle 首次 render **165 ms**、主線程最後 longtask 結束 **566 ms**、networkidle **1,017 ms**。spec §7.4 嘅 `<=3 秒` 目標**餘裕極大**，唔係「接近上限」。

**預算驗收**：以 V2 目標預算表自動檢查 **25 項 → PASS 8 / FAIL 17**（`verify-budget.mjs` exit 1）。

---

## 假設與證據

### 讀取範圍（全部實測）

| 檔案 | 實測 |
|---|---|
| `data/public/events.geojson` | 1,739,566 B / 1,796 Point |
| `data/public/locations.geojson` | 708,033 B / 704 Point |
| `data/public/zones.geojson` | 311,388 B / 48 Polygon |
| `data/public/routes.geojson` | 224,370 B / 42 LineString（759 waypoint） |
| `data/public/timeline.json` | 1,331,751 B / 1,796 entries（**未被使用**） |
| `data/public/chronicle.json` | 1,464,747 B / 1,320 entries |
| `data/public/characters.json` | 163,191 B / 330 |
| `data/public/chapter-summaries.json` | 216,803 B / 195 |
| `data/public/chapter-appearances.json` | 69,226 B / 3 |
| `data/public/map-config.json` | 1,888 B |
| `public/assets/vector/labels.json` | 512,159 B / **7,847 labels** |
| 公開資料集合計（decoded） | **5.94 MB**（cold parse 合計 24.66 ms，node 22） |

### 量測方法（全部程式化）

| 指標 | 方法 |
|---|---|
| Bundle / deploy size | `measure-bundle.mjs`：node 逐檔 `statSync` + `zlib.gzipSync(level 9)` |
| JSON parse 成本 | `measure-json-parse.mjs`：`process.hrtime.bigint()` 包住 `JSON.parse` |
| 演算法成本 | `measure-algorithms.mjs`：複製 production 演算法（`visibleEntries` / label sort / search scan） |
| 載入時間線 | `measure-load-timeline.mjs`：`PerformanceObserver`（longtask / paint）+ Playwright `networkidle` |
| 初次 render / DOM | `measure-runtime.mjs`：`MutationObserver` 記 chronicle 首現；`getElementsByTagName("*")` 數 DOM |
| 互動延遲 | `measure-runtime.mjs`：`dispatchEvent` 觸發同步 handler，`performance.now()` 前後夾；強制 `scrollHeight` 計 layout |
| Frame rate | `measure-runtime.mjs`：rAF 迴圈記錄 frame 間隔，合成 mousemove / click 序列驅動 pan / zoom |
| 主線程阻塞 | `measure-jank.mjs`：`PerformanceObserver({type:'longtask'})`，可重置收集器分開量度每個互動 |
| gzip 差異 | `curl -H "Accept-Encoding: gzip" -D -` 睇 `Content-Encoding` |

### 環境校準

- **Idle FPS = 60.2–60.5**（無互動 rAF 基準）→ 證明 headless Chromium 嘅 rAF 正常行 60 fps，所以互動期間嘅低 fps 係**真實掉幀**，唔係量測偏差。
- Chronicle 純 scroll **61.0–61.7 fps** → 已 layout 好嘅列表滾動冇問題，問題喺 render 同 DOM 量。
- 零外部請求、零 console error（與 baseline §6.1 一致）。

---

## 發現／改動

> **本審計冇改動任何 production 檔案。** 以下全部係「發現 + 建議」，按 P0 / P1 / P2 分級。

### P0 —— blocker / spec 直接違反

#### P0-1 冷 zoom 主線程阻塞 21.2 秒

**證據**（`jank-longtasks.json`）：

| 情境 | longtask 數 | 阻塞總量 | 最長單一 task | rAF FPS | p95 frame | 最長 frame |
|---|---|---|---|---|---|---|
| 冷 zoom（首次 LOD1/LOD2 + 圖磚） | 20 | **21,241 ms** | **4,164 ms** | **1.8–2.4** | 3,350–3,583 ms | **4,650–4,666 ms** |
| 暖 zoom（圖磚已喺 LRU cache） | 0 | 0 ms | 0 | 45.0–45.1 | 33.4 ms | 33.4 ms |
| 街道層 pan（LOD 2） | — | — | — | 19.3–37.7 | 50–100 ms | 100.1 ms |

**根因**（`src/map/VectorBasemap.ts`）：

- `ensureTiles()`（:542）每載入一格圖磚，`.then()` 內就 `this.buildTileRoadPaths()`（:591）＋ `this.buildBuildingPaths()`（:592）—— 兩個方法都**遍歷 `this.tiles.values()` 全部圖磚**重建 `Path2D`。24 格 cache × 每格重跑 = O(tiles²)。
- 同一段 `.then()` 內 `decode()`（:575/:578）對每格圖磚嘅全部座標做 delta 解碼。
- `roads-l1.json`（1,341,851 B）喺 level 1 才首次 `fetch`（:490），亦係同步 `JSON.parse`。
- `draw()`（:694）內 `ctx.createLinearGradient` × 2、`createRadialGradient` × 1、land 兩次 stroke、level 2 建築 4 fill + 4 stroke，全部每 frame 重做。

**建議**：圖磚 `Path2D` 改為**逐格增量**建構（每格自帶 `Path2D`，`draw()` 只 `ctx.fill()` 各自路徑）；或將解碼／建路徑搬入 Web Worker 並用 `OffscreenCanvas`／`transferable` typed array。`roads-l1.json` 改 lazy + `requestIdleCallback`（現時 `ensureLevelData` 係即時載）。

#### P0-2 `*.geojson` 未 gzip，首屏多 2.85 MB

**證據**（`curl -D -`，見 `bundle-analysis.json`）：

```
GET /data/public/events.geojson    → Content-Type: application/geo+json   無 Content-Encoding  1,739,566 B
GET /data/public/locations.geojson → Content-Type: application/geo+json   無 Content-Encoding    708,033 B
GET /data/public/zones.geojson     → Content-Type: application/geo+json   無 Content-Encoding    311,388 B
GET /data/public/routes.geojson    → Content-Type: application/geo+json   無 Content-Encoding    224,370 B
GET /data/public/timeline.json     → Content-Type: application/json       Content-Encoding: gzip  194,740 B（1,331,751 decoded）
GET /data/public/chronicle.json    → Content-Type: application/json       Content-Encoding: gzip  186,258 B（1,464,747 decoded）
```

| 檔案 | raw | gzip (level 9) | 壓縮率 |
|---|---|---|---|
| events.geojson | 1,739,566 | 201,088 | 12% |
| locations.geojson | 708,033 | 82,698 | 12% |
| zones.geojson | 311,388 | 57,912 | 19% |
| routes.geojson | 224,370 | 13,452 | 6% |
| **合計** | **2,845,150** | **355,150** | **12.5%** |

**影響**：首屏 transfer 實測 3.33 MB（本機 304 cache 下）／首次訪問約 **3.65 MB**；修正後約 **1.14 MB**（−69%）。呢個係單一最大、最低成本嘅效能改善。

**建議**：`vite.config.ts` 加 `build.assetsDir` 唔關事 —— 應改為（a）將 geojson 副檔名改 `.json` 或用 `preview.headers` 補 `Content-Encoding`；（b）部署層（GitHub Pages / CDN）確保 `application/geo+json` 亦 gzip／brotli；（c）長遠將 GeoJSON 轉 compact 陣列格式（如 TopoJSON / flat arrays），同 `vector/` 一致。

#### P0-3 Chronicle eager render 1,320 張卡

**證據**（`runtime-metrics.json`）：

| 指標 | 實測 |
|---|---|
| 首屏 DOM node 總數 | **14,036** |
| `.chr-entry` 卡片數 | **1,320** |
| `.chr-toggle` 獨立 listener | **1,320** |
| 全量 render：`innerHTML` + bind | 29.7–32.9 ms |
| 全量 render：**強制 layout** | **124–126 ms** |
| expand 一條 → 全量重繪 | 36–45.5 ms（+layout） |
| JS heap | 17.4–24.8 MB |
| virtualization | **無**（grep 零命中） |

**根因**（`src/components/ChronicleView.ts`）：

- `render()`（:336）直接 `this.root.innerHTML = ...` 拼 1,320 個 `renderEntry()` 字串，無 windowing / pagination。
- `grouped()`（:162）內每個時期都重新呼叫 `visibleEntries()`，`render()` 又再呼叫一次 → **每次 render 8 次 `visibleEntries()`**，每次 `filter` + `[...].sort()` 1,320 條（node 實測單次 2.11 ms、8 次 15.42 ms）。
- `bind()`（:386）對**每個** `.chr-ch` 同 `[data-toggle]` 逐一 `addEventListener`。
- 冇 `content-visibility: auto`、冇 `IntersectionObserver`。

**違反**：spec §2.1「時間軸／編年史需支援 virtualized / paginated rendering，唔可以一開始 render 大量 card」、§7.4「禁止 eager render 所有 chronicle cards」、Journey E「大量卡片採 virtualization / pagination」。

**建議**：`content-visibility: auto` + `contain-intrinsic-size` 係最低成本即時緩解；正式應做 windowing（只 render viewport ± N 張）＋ event delegation（一個 listener 掛喺容器，用 `data-*` 分派）＋ `visibleEntries()` memoize（`filterChapter` 做 key）。

#### P0-4 死重資產 36.2 MB

**證據**（`bundle-analysis.json`，`measure-runtime.mjs` `mapLodRequests = 0`、`hk-basemap requests = 0`）：

| 資產 | 大小 | Runtime 請求 | 處置 |
|---|---|---|---|
| `public/assets/map-lod/`（27 檔，含 13 張 1.8–3.0 MB PNG） | **27.52 MB** | **0** | 完全冇用（`fallbackToRaster()` 預設唔觸發）→ 可全刪 |
| `hk-basemap.png`（public 副本） | 1.98 MB | 0 | 可刪 |
| `hk-basemap-_tR-jzZe.png`（Vite bundled 副本） | 1.98 MB | 0 | 同上（要改 `SvgMap.ts` import） |
| `hk-basemap-labels.png` + `-DtX8PzYn.png` | 0.26 MB | 0 | 同上 |
| `emptyOutDir: false` 累積 stale bundle | **4.66 MB** | — | 44 個舊 `index-*.js`（4.28 MB）+ 14 個舊 `index-*.css`（0.38 MB）；另 `sw.js` 仍在使用 |
| 空目錄（`map-tiles/` `markers/` `ui/` `generated/` `attribution/`） | 0 B | — | 5 個 |
| **可回收合計** | **≈ 36.2 MB** | | `dist/` 由 53.6 MB → **≈ 17.6 MB（−67%）** |

**注意**：`hk-basemap.png` 同時存在 public 副本同 Vite hashed 副本（`import basemapPngUrl from "../../public/assets/hk-basemap.png?url"`，`SvgMap.ts:25`）→ **重複 2.11 MB**。

### P1 —— 明顯效能損失 / 死資料

#### P1-1 Pan 期間每格都係 longtask

**證據**（`measure-jank.mjs` + `runtime-metrics.json`）：

| 情境 | longtask 數 | 阻塞總量 | 最長 | FPS | p95 frame |
|---|---|---|---|---|---|
| pan（全港視圖） | **34** | **1,886 ms**（0.64 s 窗口） | 71 ms | **28.9–30.9** | 66.6 ms |
| 街道層 pan | 0（該次 run） | 0 | 0 | 19.3–37.7 | 50–100 ms |
| idle 基準 | — | — | — | **60.2–60.5** | — |

**根因**（`src/components/SvgMap.ts`）：
- `window.addEventListener("mousemove")`（:674）每次 pan 都 `applyViewBox()`（:853）→ 改 `<svg viewBox>`（觸發**全部 SVG 標記重繪**）＋ `updateBasemapTier()` ＋ `updateLabelLayerOpacity()` ＋ `syncBasemapView()` → `basemap.setView()` → `scheduleDraw()`。
- `VectorBasemap.drawLabels()`（:870）**每次 draw** 都 `[...items].sort(...)`（7,847 labels，node 實測 0.2 ms，但連同 7,847 次 `measureText` + O(n²) 碰撞檢測就唔平）＋ 重建 gradient。
- 冇 throttle / coalesce：每個 mousemove 都觸發全套。

**建議**：pan 期間只改 `viewBox` 同 canvas `setTransform`，**唔**重建 SVG 標記；label 排序結果 cache（只有 view 改變時重排，或按 rank 預先分桶）；`mousemove` 用 rAF coalesce。

#### P1-2 `timeline.json` eager 載入但完全冇用

`loadAllData.ts:150` `fetchJSON<TimelineRecord[]>(base + "timeline.json")` 每次都載 195 KB（gzip）／1.33 MB decoded（parse 3.6–5.1 ms），但 `grep -rn "\.timeline" src/` 只中 `ChronicleView.ts:299` 一個 CSS class。**建議**：移除 eager load，需要時才 lazy。

#### P1-3 `ChronicleView.render()` 內 8 次 `visibleEntries()`

node 微基準（`algorithm-cost.json`）：單次 `visibleEntries()` **2.11 ms**（1,320 條 filter + sort）；一次完整 render pass **15.42 ms**。**建議**：memoize（key = `filterChapter`）＋ 排序 key 預計算。

#### P1-4 `SvgMap.render()` 內線性 `find` 風暴

- `routeVertex()`（:1073）對**每個** waypoint 做 `locations.features.find()` → 759 waypoint × 704 locations，node 實測 **3.77 ms**。
- event marker 迴圈（:1526）每個 event 再 `locations.features.find()`。
- `render()`（:1120）每次 filter 704 locations、:1153 再掃 704 建 `fictionalById`。
- `flyToChapter()`（:1576）再掃 704。
- **`render()` 喺每次 selection 都會被呼叫**（`app.ts:360/396/424`）。

**建議**：用已有嘅 `locationsById` Map（`loadAllData.ts:159` 已建好）取代所有 `.find()`；`fictionalById` 亦應喺 loader 建一次。

#### P1-5 `dist/` stale bundle 4.66 MB

`vite.config.ts:21` `emptyOutDir: false`（註解解釋係因為本機 `rm` shim 攔截）。結果 44 個舊 `index-*.js`（4.28 MB）+ 14 個舊 `index-*.css`（0.38 MB）永久累積。**建議**：CI／deploy 前跑 `npm run clean`（已存在）或用 `vite build --emptyOutDir`；deploy workflow 應該 `rm -rf dist` 再 build。

#### P1-6 `main.ts` 重複 import `hud.css`

`src/main.ts:5-6` 兩次 `import "./styles/hud.css";`。Vite 會 dedupe，無實際影響，但屬噪音。

### P2 —— 低優先 / 未達痛點

- **Search 冇 debounce / 冇 index**：`SearchBox.renderResults()`（:73）每個 keystroke 線性掃 330 char + 1,796 event（含 `description.toLowerCase()`）+ 704 location。**實測 0.55–0.92 ms／查詢、逐字打「將軍澳大本營」合計 2.66 ms** → spec §7.4 `<=150 ms` 有 **>150× 餘裕**，唔係痛點。仍建議加 120 ms debounce + 預建 lowercase index 以應付資料增長。
- **冇 code splitting**：`dist/assets/` 只有單一 `index-*.js`（128 KB / 41.6 KB gzip）。目前可接受；V2 若加 zone dossier / chronicle 重型邏輯可考慮 dynamic import。
- **`renderEntry` 內每張卡重建 `byId` Map**：`renderLinks()`（:317）每次 `new Map(this.doc.entries.map(...))`，只喺展開時觸發，影響有限。
- **`StoryPanel.updateForChapter()`** 每次 `Object.entries(chars).filter(...)` 掃 330 角色；`updateForLocation/Event` 線性 find 1,796 events。屬 O(n) 小常數。
- **5 個空目錄** 喺 `public/assets/`（部署噪音，0 byte）。
- **`hk-basemap-coords.json`** 同時被 Vite inline 入 JS 同複製到 `dist/assets/`（1 KB，可忽略）。

---

## Bundle 逐檔表

### Active bundle（`dist/index.html` 實際引用）

| 檔案 | raw | gzip | 備註 |
|---|---|---|---|
| `dist/index.html` | 974 B | 570 B | |
| `dist/assets/index-8RBFSg4n.js` | **128,468 B** | **41,602 B** | 單一 entry，24 modules transformed |
| `dist/assets/index--5RrUFrx.css` | **45,170 B** | **9,315 B** | |
| `dist/assets/icon-192.png` | 1,475 B | — | |
| `dist/assets/icon-512.png` | 4,411 B | — | |
| `dist/sw.js` | 4,678 B | — | service worker |
| `dist/manifest.webmanifest` | 631 B | — | |
| `dist/assets/hk-basemap-coords.json` | 1,088 B | — | 同時 inline 入 JS |
| **Active 小計** | **≈ 186 KB** | **≈ 52 KB** | |

### `dist/` 分類總量表

| 分類 | 檔數 | 大小 | 狀態 |
|---|---|---|---|
| `assets/index-*.js` | 45 | 4.40 MB | 1 active（128 KB）+ **44 stale（4.28 MB）** |
| `assets/index-*.css` | 15 | 0.42 MB | 1 active（45 KB）+ **14 stale（0.38 MB）** |
| `assets/map-lod/` | 27 | **27.52 MB** | **死重（0 請求）** |
| `assets/vector/main` | 7 | 2.42 MB | 使用中（eager 6 檔 + lazy roads-l1） |
| `assets/vector/tiles/` | 89 | **8.86 MB** | 使用中（**只喺 LOD 2 lazy 載**） |
| `data/public/` | 11 | 5.94 MB | 全部 eager（timeline.json 係死資料） |
| 其他（basemap PNG ×4、coords、icons、html、sw、manifest） | 10 | 4.04 MB | basemap PNG 4.02 MB 死重 |
| **總計** | **204** | **53.60 MB** | **可回收 36.2 MB → 17.6 MB** |

### `public/assets/vector/` 明細

| 檔案 | raw | gzip |
|---|---|---|
| `roads-l1.json` | 1,341,851 B | — |
| `labels.json` | 512,159 B | — |
| `roads-l0.json` | 329,333 B | — |
| `water.json` | 129,485 B | — |
| `areas.json` | 123,265 B | — |
| `land.json` | 92,229 B | — |
| `manifest.json` | 5,318 B | — |
| **main 合計** | **2,416,268 B（2.42 MB）** | **0.74 MB** |
| `tiles/`（89 檔） | **8,857,395 B（8.86 MB）** | **2.47 MB** |

**有冇 code splitting？** 冇。`dist/assets/` 只有單一 active `index-*.js`（其餘係 stale 殘留）。所有 component（SvgMap / ChronicleView / SearchBox / StoryPanel / ZoneDossier / exportMap / fallbackAnchors 503 錨點）全部打入同一個 128 KB bundle。

**1.98 MB raster PNG 係唔係必要？** **唔係。** 實測 runtime 對 `hk-basemap.png` 同 `map-lod/*.png` **零請求**；`SvgMap.init()` 內 `#basemap-group` 唔設 `href`，只有 `fallbackToRaster()`（向量底圖載入失敗才觸發）才會用。向量底圖（`VectorBasemap` + `assets/vector/`）正常運作時，raster 完全唔參與。

---

## 初次載入時間線

### 精確時間線（`load-timeline.json`，無注入等待）

| 事件 | 時間 |
|---|---|
| `domInteractive` | 8 ms |
| `domContentLoaded` | 15 ms |
| `loadEventEnd` | 16 ms |
| **Chronicle 首次 render（1,320 卡）** | **165 ms** |
| 最後一個 resource `responseEnd` | 498 ms |
| **主線程最後 longtask 結束（= 主線程空閒）** | **566 ms** |
| `networkidle`（Playwright） | **1,017 ms** |

**longtask（初次載入）**：3 個，`{69ms×95, 165ms×232, 507ms×59}` → 合計 **386 ms**，最長 232 ms。
（baseline 另一次 run 錄得 4 個、合計 433–634 ms、最長 256–336 ms。）

### ⚠️ 對 baseline「load→stable 2.6–2.8 秒」嘅修正

`artifacts/baseline-capture.mjs:143` 有 `await page.waitForTimeout(1500)`，而 `loadMs = Date.now() - t0` **包埋嗰 1.5 秒**。所以 baseline §6.1 嘅 2,621–2,761 ms ≈ 真實載入（~1.1–1.3 s）+ 1.5 s 固定等待。**唔應該**理解為「2.6 秒工作量，餘裕只剩 0.2–0.4 秒」。

以 spec §7.4「初次 interactive map shell `<=3 秒`」計：
- 可互動（chronicle 出齊）= **165 ms** → 餘裕 **~2.84 s**
- 主線程完全空閒 = **566 ms** → 餘裕 **~2.43 s**
- networkidle = **1,017 ms** → 餘裕 **~1.98 s**

**結論：載入階段目標大幅達標**；真正嘅效能風險集中喺 **map 互動（pan / zoom）** 同 **deploy size**，唔係首屏。

### 最大 5 個 resource（transferSize，`runtime-metrics.json`）

| # | 資源 | transferSize | decoded | 備註 |
|---|---|---|---|---|
| 1 | `data/public/events.geojson` | **1,739,866 B** | 1,739,566 B | **未壓縮** |
| 2 | `data/public/locations.geojson` | **708,333 B** | 708,033 B | **未壓縮** |
| 3 | `data/public/zones.geojson` | **311,688 B** | 311,388 B | **未壓縮** |
| 4 | `data/public/routes.geojson` | **224,670 B** | 224,370 B | **未壓縮** |
| 5 | `data/public/timeline.json` | 194,873 B | 1,331,751 B | gzip；**死資料** |
| （6） | `data/public/chronicle.json` | 186,391 B | 1,464,747 B | gzip |
| （7） | `assets/vector/labels.json` | 512,159 B（cache 命中時 0） | 512,159 B | 每次 draw sort |
| （8） | `assets/vector/roads-l0.json` | 329,333 B | 329,333 B | |
| （9） | `assets/index-*.js` | 42,125 B | 128,468 B | gzip |

**總 transfer（首次訪問估算，本機無 CDN gzip for geojson）≈ 3.65 MB**；geojson 修正後 ≈ **1.14 MB**。

---

## 慢性能量測表（render / filter / search / click / pan / zoom）

> 全部數值為 headless Chromium、1440×900 DPR 1、localhost preview。idle 基準 **60.2–60.5 fps**。

| 操作 | 實測 | spec §7.4 目標 | 結果 | 分級 |
|---|---|---|---|---|
| **Chronicle 首次 render**（1,320 卡） | 165 ms（含 layout） | 禁止 eager render | **違反** | P0 |
| Chronicle 全量 render（`innerHTML`+bind） | 29.7–32.9 ms | — | — | |
| Chronicle 全量 render（**+強制 layout**） | **124–126 ms** | — | 主線程阻塞 | P0 |
| Chronicle filter（ch1，0 條） | 9.0–13.7 ms | ≤250 ms | **PASS** | |
| Chronicle filter（最密章 ch131，18 條） | **10.6 ms** | ≤250 ms | **PASS** | |
| Chronicle expand 一條（觸發全量重繪） | 36–45.5 ms | — | 全量重繪屬浪費 | P1 |
| Chronicle scroll（已 layout） | **61.0–61.7 fps** | 無明顯掉幀 | **PASS** | |
| **Search「大本營」** | 1.9–4.6 ms（50 結果 / 另有 206） | ≤150 ms | **PASS** | |
| Search「陳」 | 0.8–1.4 ms（3 結果） | ≤150 ms | **PASS** | |
| Search「將軍澳」 | 1.3–10 ms（50 結果 / 另有 9） | ≤150 ms | **PASS** | |
| Search「病」 | 1.3–1.6 ms（50 / 另有 634） | ≤150 ms | **PASS** | |
| Search 逐字打「將軍澳大本營」 | 2.66–7.7 ms 合計（6 keystroke） | ≤150 ms | **PASS** | |
| **Marker click → 面板更新**（location-marker） | handler **16.3 ms**／+layout **25.7 ms** | ≤100 ms | **PASS** | |
| Marker click（cluster） | 0.2 ms（觸發 fly-to 動畫） | ≤100 ms | **PASS** | |
| **Pan FPS**（全港） | **28.9–30.9 fps**，p95 66.7 ms，34 個 longtask / 1,886 ms | 無明顯 frame drop | **FAIL** | P1 |
| Pan FPS（街道層 LOD 2） | **19.3–37.7 fps**，p95 50–100 ms | 無明顯 frame drop | **FAIL** | P1 |
| **Zoom FPS（冷）** | **1.8–2.4 fps**，最長 frame **4,650 ms**，阻塞 **21,241 ms** | 無明顯 frame drop | **FAIL** | P0 |
| Zoom FPS（暖，圖磚 cached） | **45.0–45.1 fps**，p95 33.4 ms | 無明顯 frame drop | 接近但未達 60 | P1 |
| 初次載入主線程阻塞 | 386–634 ms（3–4 longtask） | — | 可接受 | |

---

## 資料載入策略分析

### 現況（`src/data/loadAllData.ts`）

`loadAllData()`（:131）用 `Promise.all` **一次過 eager 載入全部 10 個 JSON**，冇 lazy、冇按需、冇分層：

| 檔案 | transfer（gzip） | decoded | 首屏需要？ |
|---|---|---|---|
| map-config.json | 1,079 B | 1,888 B | ✅ |
| locations.geojson | 708,033 B | 708,033 B | ✅（地圖） |
| events.geojson | 1,739,566 B | 1,739,566 B | ✅（地圖 + 搜尋） |
| routes.geojson | 224,370 B | 224,370 B | ✅ |
| **timeline.json** | **194,740 B** | **1,331,751 B** | ❌ **完全冇用** |
| characters.json | 15,291 B | 163,191 B | ✅（搜尋） |
| zones.geojson | 311,388 B | 311,388 B | ✅ |
| chronicle.json | 186,258 B | 1,464,747 B | ✅（**預設視圖**） |
| chapter-appearances.json | 7,319 B | 69,226 B | ✅（StoryPanel） |
| chapter-summaries.json | 52,843 B | 216,803 B | ✅（StoryPanel） |
| **合計** | **≈ 3.44 MB**（含 geojson 未壓縮） | **5.94 MB** | |

### 實測請求

- **總 request 36 個、`fetch` 33 個、外部請求 0 個、失敗 0 個**（與 baseline §6.1 一致）。
- `loadAllData` 10 個 + `VectorBasemap.init` 6 個（manifest / land / water / areas / labels / roads-l0）+ lazy（roads-l1 + tiles）。
- `map-lod` 請求 **0**、`hk-basemap*` 請求 **0**。

### 有冇 eager load 唔需要嘅資料？**有。**

1. **`timeline.json`（1.33 MB decoded）全 `src/` 冇引用** → 純浪費（P1）。
2. **`chronicle.json`（1.46 MB decoded）** 雖然係預設視圖，但一次過 parse 1,320 條再 eager render 全部卡（P0-3）。
3. `chapter-summaries` / `chapter-appearances` 只有 StoryPanel（非預設視圖）用，但 eager 載入（合計 286 KB decoded，影響小）。

### JSON parse 成本（node 22，`json-parse-cost.json`）

| 檔案 | 冷 parse | 暖 parse |
|---|---|---|
| events.geojson | 8.27 ms | 4.66 ms |
| timeline.json | 5.10 ms | 3.59 ms |
| locations.geojson | 4.14 ms | 1.72 ms |
| chronicle.json | 3.58 ms | 3.13 ms |
| zones.geojson | 0.86 ms | 1.36 ms |
| routes.geojson | 0.86 ms | 0.74 ms |
| 其他 4 檔 | 1.86 ms | 1.26 ms |
| **合計** | **24.66 ms** | **16.45 ms** |

→ parse 本身唔係瓶頸（24.66 ms）。瓶頸係 **geojson 未壓縮嘅傳輸** 同 **eager render**。

### 有冇 index / selector layer？

**部分有，但 component 仍直接 filter 巨型 array。**

`loadAllData.ts` 有建 4 個 index：`locationsById`（:159）、`charactersByName`（:163）、`eventsByChapter`（:167）、`routesByChapter`（:173）。

**但 component 大量繞過 index 直接掃 raw array**：

| 位置 | 問題 |
|---|---|
| `SvgMap.ts:1077` `routeVertex` | 每個 waypoint `locations.features.find()`（759 次 × 704） |
| `SvgMap.ts:1120` `render` | `locations.features.filter()` 掃 704 |
| `SvgMap.ts:1153` `render` | 再掃 704 建 `fictionalById`（其實可預建） |
| `SvgMap.ts:1527` `render` | 每個 event `locations.features.find()` |
| `SvgMap.ts:1576` `flyToChapter` | 再掃 704 |
| `SvgMap.ts:818` `zoomToLocation` | `locations.features.find()` |
| `StoryPanel.ts:173` | `routes.features.find()`（42，可接受） |
| `StoryPanel.ts:213/254` | `events.features.filter/find()` 掃 1,796 |
| `ZoneDossier.ts:89` | `zones.features.find()`（48，可接受） |
| `AboutModal.ts:62` | 兩次 `locations.features.filter()` 掃 704 |

→ V2 spec §2.1「將 raw dataset 轉成 adapter / selector layer；component 不可散落直接讀取巨型 raw JSON shape」**目前未達成**。

---

## 死重資產可回收 MB

| 項目 | 大小 | 證據 |
|---|---|---|
| `public/assets/map-lod/`（27 檔） | **27.52 MB** | runtime 請求 0；`fallbackToRaster()` 預設唔觸發 |
| basemap PNG ×4（public 2 份 + Vite hashed 2 份） | **4.02 MB** | runtime 請求 0；`#basemap-group` 初始無 `href` |
| `emptyOutDir:false` 累積 stale bundle | **4.66 MB** | 44 個舊 `index-*.js`（4.28 MB）+ 14 個舊 CSS（0.38 MB） |
| 空目錄 ×5 | 0 B | `map-tiles/` `markers/` `ui/` `generated/` `attribution/` |
| **可回收合計** | **≈ 36.2 MB** | |
| `dist/` 現況 → 清理後 | 53.60 MB → **≈ 17.6 MB** | **−67%** |

**另外可省（唔算死重，屬傳輸優化）**：geojson gzip **2.51 MB**（2.85 MB → 0.35 MB）。

**對 deploy 嘅影響**：GitHub Pages 每次 deploy 要推 53.6 MB → 可降至 ~17.6 MB；`map-lod` 27.52 MB 對首次 deploy 同任何 CI artifact 上傳都係純負擔。

---

## V2 效能預算提案

> 每個項目都對應 `artifacts/audit-A8/verify-budget.mjs` 嘅自動檢查。**現況實測**欄為本次量測值。

### A. 傳輸 / Bundle

| 指標 | 現況實測 | V2 預算 | 方向 | 量測 |
|---|---|---|---|---|
| JS bundle（gzip） | 41,602 B | ≤ 60 KB | ≤ | node `zlib.gzipSync` |
| CSS bundle（gzip） | 9,315 B | ≤ 20 KB | ≤ | 同上 |
| 首屏 transfer（首次訪問，gzip） | ≈ 3.65 MB | **≤ 1.2 MB** | ≤ | Playwright `resource.transferSize` 總和 |
| geojson transfer | 2.85 MB（未壓縮） | **≤ 0.4 MB** | ≤ | `curl -H Accept-Encoding` |
| Deploy size（`dist/` 總量） | 53.60 MB | **≤ 12 MB** | ≤ | node `statSync` 遞歸 |
| 死重資產 | 36.2 MB | **0 MB** | ≤ | 同上 |
| stale bundle | 4.66 MB | **0 MB** | ≤ | build 前 `npm run clean` |
| `vector/main` | 2.42 MB | ≤ 1.5 MB | ≤ | labels.json 512 KB 應分層／tile 化 |
| `vector/tiles` | 8.86 MB | ≤ 8 MB | ≤ | lazy，只喺 LOD 2 載 |
| 單一 raster tile | 1.79–2.97 MB | ≤ 512 KB | ≤ | 改 WebP/AVIF + 更細 tile |

### B. 初次載入 / 主線程

| 指標 | 現況實測 | V2 預算 | 方向 |
|---|---|---|---|
| Chronicle 首次 render（可互動） | 165 ms | ≤ 400 ms | ≤ |
| 主線程最後 longtask 結束 | 566 ms | ≤ 1,000 ms | ≤ |
| 主線程阻塞總量（載入） | 386–634 ms | ≤ 300 ms | ≤ |
| `networkidle` | 1,017 ms | ≤ 1,500 ms | ≤ |
| LCP | 500–644 ms | ≤ 1,500 ms | ≤ |
| CLS | 0 | ≤ 0.05 | ≤ |
| 首屏 DOM node 總數 | 14,036 | **≤ 4,000** | ≤ |
| JS heap（首屏後） | 17.4–24.8 MB | ≤ 25 MB | ≤ |

### C. 每類操作延遲

| 操作 | 現況實測 | V2 預算 | 方向 | spec 對應 |
|---|---|---|---|---|
| Chronicle 卡片 DOM 數 | 1,320 | **≤ 60**（virtualized） | ≤ | §2.1 / §7.4 禁止 eager |
| Chronicle filter | 10.6 ms | ≤ 250 ms | ≤ | §7.4 |
| Chronicle render（單次，virtualized） | 124 ms（+layout） | ≤ 60 ms | ≤ | — |
| Search local index response | 0.6–10 ms | ≤ 150 ms | ≤ | §7.4 |
| Marker click → 面板更新 | 16–26 ms | ≤ 100 ms | ≤ | §7.4 |
| Zone selection → dossier | 未量（zone 未 render） | ≤ 100 ms | ≤ | §7.4 |
| Pan FPS | 28.9 fps / p95 66.7 ms | **≥ 55 fps / p95 ≤ 20 ms** | ≥ / ≤ | §7.4 |
| Pan longtask 數 | 34 | **0** | ≤ | §7.4 |
| Zoom FPS（冷） | 1.8 fps / 最長 4,650 ms | **≥ 50 fps / 最長 frame ≤ 100 ms** | ≥ / ≤ | §7.4 |
| Zoom FPS（暖） | 45.1 fps | ≥ 55 fps | ≥ | §7.4 |
| 街道層 pan FPS | 19.3–37.7 fps | ≥ 55 fps | ≥ | §7.4 |
| 冷 zoom 阻塞總量 | 21,241 ms | ≤ 300 ms | ≤ | §7.4 |

### D. 自動化量測方案（已實作，放 `artifacts/audit-A8/`）

| 腳本 | 作用 | 輸出 |
|---|---|---|
| `run-all.mjs` | 一鍵跑齊全部量測 + 預算驗收 | 串流 stdout，exit code |
| `measure-bundle.mjs` | dist / public 逐檔 size + gzip、死重、geojson 壓縮 | `bundle-analysis.json` |
| `measure-json-parse.mjs` | 每個資料集 cold/warm `JSON.parse` | `json-parse-cost.json` |
| `measure-algorithms.mjs` | 複製 production 演算法微基準（chronicle render pass / label sort / search scan / waypoint find） | `algorithm-cost.json` |
| `measure-load-timeline.mjs` | 精確載入時間線（無注入等待） | `load-timeline.json` |
| `measure-runtime.mjs` | 初次 render / DOM / filter / search / click / pan / zoom frame rate | `runtime-metrics.json` |
| `measure-jank.mjs` | 每個互動嘅 longtask 統計 | `jank-longtasks.json` |
| `verify-budget.mjs` | 讀齊上面輸出，逐條對 V2 預算，**任何 FAIL → exit 1** | PASS/FAIL 表 |

**執行方式**（先起 preview server）：

```bash
npx vite preview --port 5180 &
node artifacts/audit-A8/run-all.mjs        # 量測 + 驗收
# 或只驗收（已有輸出時）
node artifacts/audit-A8/verify-budget.mjs
```

**建議接入 CI**：`verify-budget.mjs` 已用 exit code 表達 pass/fail，可直接作為 V2 嘅效能 gate（C6 Performance Auditor 可重用）。

**注意**：`measure-*.mjs` 嘅互動數字係 headless Chromium 軟件渲染，**相對值**（vs idle 60 fps 基準）比絕對值可靠。預算表嘅 fps 目標係以 idle 基準換算（≥ 55 fps 即 ≤ 1.09× idle frame time）。

---

## 修改檔案

**冇。** 本審計冇改任何 production 檔案（`src/**`、`data/**`、`public/**`、`tests/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`scripts/**`、`.gitignore`），亦冇做任何 git 寫操作。

新增（全部喺允許範圍內）：

| 檔案 | 用途 |
|---|---|
| `docs/audits/data-performance-audit.md` | 本報告 |
| `artifacts/audit-A8/run-all.mjs` | 一鍵重跑 |
| `artifacts/audit-A8/measure-bundle.mjs` | bundle / deploy size |
| `artifacts/audit-A8/measure-json-parse.mjs` | JSON parse 成本 |
| `artifacts/audit-A8/measure-algorithms.mjs` | 演算法微基準 |
| `artifacts/audit-A8/measure-load-timeline.mjs` | 載入時間線 |
| `artifacts/audit-A8/measure-runtime.mjs` | 執行期效能 |
| `artifacts/audit-A8/measure-jank.mjs` | longtask 阻塞 |
| `artifacts/audit-A8/verify-budget.mjs` | 預算驗收 |

產出資料：`bundle-analysis.json`、`json-parse-cost.json`、`algorithm-cost.json`、`load-timeline.json`、`runtime-metrics.json`、`jank-longtasks.json`。

---

## 沒有修改但相關的檔案

| 檔案 | 相關發現 |
|---|---|
| `src/data/loadAllData.ts` | eager 載入 10 檔；timeline.json 無用；有 4 個 index 但 component 繞過 |
| `src/components/ChronicleView.ts` | eager render 1,320 卡；`visibleEntries()` 每次 render 8 次；逐個 listener |
| `src/components/SearchBox.ts` | 無 debounce / index；線性掃 2,830 項（實測仍遠低於 150 ms） |
| `src/components/SvgMap.ts` | pan 每 mousemove 全套重繪；`routeVertex` / event marker 線性 find；重複 import raster PNG |
| `src/map/VectorBasemap.ts` | 每格圖磚重建全部 Path2D；每次 draw sort 7,847 labels；重建 gradient |
| `src/components/StoryPanel.ts` | 線性 find/filter 1,796 events；每次掃 330 角色 |
| `src/app.ts` | 每次 selection 呼叫 `svgMap.render()` |
| `src/main.ts` | 重複 import `hud.css` |
| `vite.config.ts` | `emptyOutDir: false` → stale bundle 累積；無 `manualChunks` |
| `package.json` | 無 `bundle-analyzer`；`clean` script 已存在但 deploy 未用 |
| `public/assets/map-lod/` | 27.52 MB 死重 |
| `public/assets/hk-basemap*.png` | 4.02 MB 死重（重複 2 份） |
| `public/assets/vector/labels.json` | 512 KB / 7,847 labels，每次 draw sort |
| `dist/` | 53.60 MB，含 4.66 MB stale bundle |

---

## 驗證命令與結果

```bash
# 前置：preview server
npx vite preview --port 5180    # → HTTP 200 @ http://localhost:5180/

# 逐項量測（可獨立跑）
node artifacts/audit-A8/measure-bundle.mjs
node artifacts/audit-A8/measure-json-parse.mjs
node artifacts/audit-A8/measure-algorithms.mjs
node artifacts/audit-A8/measure-load-timeline.mjs
node artifacts/audit-A8/measure-runtime.mjs
node artifacts/audit-A8/measure-jank.mjs

# 一鍵 + 預算驗收
node artifacts/audit-A8/run-all.mjs
node artifacts/audit-A8/verify-budget.mjs    # exit 1（17 項 FAIL）
```

**實測結果摘要**：

| 命令 | 結果 |
|---|---|
| `measure-bundle.mjs` | dist 53.60 MB / 204 檔；active JS 128,468 B（gzip 41,602）；死重 36.2 MB；geojson 2.85 MB → gzip 可省 2.51 MB |
| `measure-json-parse.mjs` | 10 檔合計 5.94 MB decoded；cold parse 24.66 ms |
| `measure-algorithms.mjs` | chronicle render pass 15.42 ms（8× visibleEntries）；label sort 0.2 ms；search 0.55–0.92 ms；waypoint find 3.77 ms |
| `measure-load-timeline.mjs` | chronicle 首 render 165 ms；主線程空閒 566 ms；networkidle 1,017 ms；longtask 3 個 / 386 ms |
| `measure-runtime.mjs` | DOM 14,036；chronicle 1,320 卡；全量 render+layout 124 ms；pan 28.9 fps；冷 zoom 1.8 fps；暖 zoom 45.1 fps |
| `measure-jank.mjs` | pan 34 longtask / 1,886 ms；冷 zoom 20 longtask / 21,241 ms（最長 4,164 ms）；暖 zoom 0 |
| `verify-budget.mjs` | **25 項：PASS 8 / FAIL 17** |

**零外部請求、零 console error、零 failed request** —— 與 baseline §6.1 一致，離線目標已達成。

---

## Screenshots / Artifacts

- 本審計**冇新增 screenshot**（spec §7.3 嘅 screenshot 由 A2/A4/C2/C3 負責；本審計以程式化 metrics 為證據）。
- 產出目錄：`artifacts/audit-A8/`

```
artifacts/audit-A8/
  run-all.mjs                    一鍵重跑
  measure-bundle.mjs             bundle / deploy size
  measure-json-parse.mjs         JSON parse 成本
  measure-algorithms.mjs         演算法微基準
  measure-load-timeline.mjs      載入時間線
  measure-runtime.mjs            執行期效能
  measure-jank.mjs               longtask 阻塞
  verify-budget.mjs              V2 預算驗收（exit code）
  bundle-analysis.json           產出
  json-parse-cost.json           產出
  algorithm-cost.json            產出
  load-timeline.json             產出
  runtime-metrics.json           產出
  jank-longtasks.json            產出
```

---

## 風險、衝突、限制

1. **headless 軟件渲染**：本機 headless Chromium 冇 GPU 加速，canvas 繪製成本被放大。**絕對 fps 值應保守解讀**；但 idle 基準 60.2 fps 證明 rAF 正常，所以「pan 29 fps vs idle 60 fps」嘅**相對差**係真實嘅。真機（有 GPU）數字應會好啲，但冷 zoom 21 秒阻塞嘅主因（同步 parse + 全量 Path2D 重建）同 GPU 無關，屬真問題。
2. **本機 preview server 冇 CDN gzip**：geojson 未壓縮係 `vite preview`（sirv）行為。GitHub Pages 對 `application/geo+json` 亦**未必**自動 gzip（需驗證）。若部署層已 gzip，則 P0-2 影響下降；但仍應喺 repo 層保證（改副檔名或加 headers），唔應該依賴部署環境。
3. **量測變異**：fps / longtask 數字 run-to-run 有 ±20% 波動（例如街道層 pan 19.3 ↔ 37.7 fps、載入 longtask 3 ↔ 4 個）。報告已列範圍而非單值。關鍵 P0（冷 zoom 阻塞、eager render、死重）跨 run 穩定。
4. **`baseline-findings.md` 數字修正**：§6.1「load→stable 2.6–2.8 秒」含腳本注入 1.5 s 等待，唔應直接對 spec 3 秒目標。此為對 baseline 嘅**修正**，非矛盾。
5. **未量測項目**：zone polygon selection → dossier（現時 48 個 zone 完全冇 render，無法量測）；mobile viewport 效能（本次集中 desktop 1440）；reduced-motion 情境。建議 V2 補。
6. **衝突風險**：P0-2（geojson gzip）涉及 `vite.config.ts` / 部署層，屬 B 階段（B3 Data Adapter / build）範圍；P0-3（virtualization）屬 B7 Chronicle；P0-1 / P1-1（canvas / pan）屬 B5/B6。**主代理需喺 Gate 1 決定邊個 agent 擁有 `vite.config.ts`**（本審計建議由 build / infra 負責人單獨擁有）。
7. **唔建議「人手量度」**：本審計所有數字均由腳本產生；報告內任何「未量測」項目都應該用新增 `measure-*.mjs` 補，而唔係叫人開 DevTools。

---

## 給主代理的 integration note

1. **P0 共 4 項、P1 共 6 項**（另有 6 項 P2）。`verify-budget.mjs` 25 項檢查中 **FAIL 17**，可作為 V2 Gate 1 → Gate 2 嘅進度儀表。

2. **最高 ROI 排序（建議寫入 Gate 1 規格）**：
   - **① geojson gzip（2.51 MB，零風險）** → 首屏 3.65 MB → 1.14 MB。屬 build/infra，唔使改 component。
   - **② 刪死重（36.2 MB）** → `map-lod/` + basemap PNG + `emptyOutDir` 修正。屬 infra / asset pipeline。
   - **③ Chronicle virtualization（P0-3）** → 直接滿足 spec §2.1/§7.4 硬要求，DOM 14,036 → ≤4,000。
   - **④ 冷 zoom 圖磚路徑增量建構（P0-1）** → 21.2 s → 目標 ≤0.3 s 阻塞。屬 B5/B6。
   - **⑤ pan rAF coalesce + label 排序 cache（P1-1）** → 29 fps → ≥55 fps。
   - **⑥ 移除 `timeline.json` eager load（P1-2）** → 一行改動，省 195 KB + 3.6 ms。

3. **對 spec 嘅澄清**：spec §7.4「初次 interactive map shell `<=3 秒`」**已經達成**（實測 165 ms 可互動 / 566 ms 主線程空閒 / 1,017 ms networkidle）。V2 應該**收緊**呢個預算（例如 ≤1.5 s networkidle），而唔係將 baseline 嘅 2.6 s 當成「接近上限」。

4. **需要主代理裁決嘅 ownership**：
   - `vite.config.ts`（gzip / `emptyOutDir` / `manualChunks`）→ 建議單一 owner（B3 或 infra）。
   - `src/map/VectorBasemap.ts`（Path2D 增量 + label cache）→ B5。
   - `src/components/SvgMap.ts`（pan coalesce + `locationsById`）→ B6。
   - `src/components/ChronicleView.ts`（virtualization + delegation）→ B7。

5. **可直接複用嘅資產**：`artifacts/audit-A8/verify-budget.mjs` 建議接入 C6 Performance Auditor 同 CI，作為 V2 效能 gate；`measure-*.mjs` 全部可重跑、無人手步驟。

6. **未覆蓋嘅 gap（建議 V2 補測）**：zone selection 延遲（現時 zone 未 render，無法量）、mobile 390 效能、reduced-motion 情境、Brotli vs gzip 差異、真機 GPU 對照。

# World Atlas V2 — Rendering & LOD Strategy

> **Gate 1 交付物 6／8** · 狀態：**定稿**
> 依據：spec §2.3、§5.3；A4（地圖渲染審計）、A8（效能審計）、A2（視覺）

---

## 1. 問題定義修訂（**取代 spec §2.3**）

### 1.1 原假設已被推翻

原 spec §2.3 假設：「最大 zoom 出現 pixelation，表示 base-map 係單張低 resolution raster 被 CSS / SVG 放大，或 max zoom / LOD policy 錯誤。」

**A4 逐項實測結論：**

| 假設 | 實測 | 判定 |
|---|---|---|
| base-map 係低清 raster 被放大 | raster 路徑 **0 參與**（`map-lod/` 請求數 = 0、`<image href>` / `<img src>` = 0） | ❌ 排除 |
| CSS / viewBox 拉伸 | viewBox 等比、無拉伸 | ❌ 排除 |
| canvas DPR 不足 | DPR1 = 1060×752；DPR2 = 2120×1503（**正確 HiDPI**） | ❌ 排除 |
| 資產精度不足 | `quant: 100000` ≈ 1.1 m/unit；亞像素 | ❌ 排除 |
| max zoom / LOD policy 錯 | 部分成立（見 §1.3） | ⚠️ 次要 |

### 1.2 真正 root cause：**內容密度隨 zoom 反向下降**

| 量度 | 初始全港視圖（0.70°） | 中段（0.245°） | **最大 zoom（0.020°）** |
|---|---|---|---|
| `flatRatio`（越細越有細節） | 0.846 | **0.662（峰值）** | **0.850（比初始更平）** |
| `meanGrad` | 10.25 | **27.26** | **9.12** |
| 將軍澳視窗內 event 繪製數 | — | — | **176 → 0** |
| location 繪製數 | — | — | **72 → 3** |
| zone 繪製數 | — | — | **19 → 0** |

**三個獨立成因（全部有實測）：**

| # | 成因 | 證據 | 負責 |
|---|---|---|---|
| G1 | **章節窗口過濾** | `SvgMap.render()` 用 `Math.abs(c - cur) <= 3`（location）、`cur ± 1`（event）；深 zoom 幾乎清空 | B5/B6 |
| G2 | **tile POI 已下載但 0 渲染** | `VectorBasemap.drawLabels()` 冇畫 tile POI（rank 5）—— 街道級地標唯一來源 | B5 |
| G3 | **建築描繪對比過低** | light palette `bld` alpha 0.16–0.42、`bldEdge` 0.35 px 描邊；dark 更差（0.862） | B1/B5 |

### 1.3 修訂後嘅 §2.3

> **2.3 地圖放大後內容稀疏、缺少細節（唔係 pixelation）**
> 問題定義：最大 zoom 時故事圖層同底圖細節**反向下降**，使用者感知為「冇嘢睇」。
> 三個實測成因：(a) 章節窗口過濾令 zone / location / event 喺深 zoom 幾乎清空；(b) tile POI 已下載但未渲染；(c) 建築描繪對比度過低。

**北極星修訂**：§0.3 第 2 點「最大 zoom 唔起格、唔模糊」**實測已達成**，唔應再列為待修項；應改為「最大 zoom **有足夠內容可探索**」。

---

## 2. Renderer 架構（spec §5.3）

### 2.1 現況

| 模組 | 行數 | 問題 |
|---|---|---|
| `src/components/SvgMap.ts` | 1646 | 混齊 layout / projection / LOD / render / interaction / data access |
| `src/map/VectorBasemap.ts` | 935 | Canvas 2D 向量底圖；**同 SvgMap 雙軌並存**（唔係替換關係） |

合共 **2581 行**做齊六件事（A3 P0-3）。

### 2.2 V2 模組拆分（12 模組）

```
src/map/
  MapShell.ts            // 容器、生命週期、layer 註冊
  MapViewport.ts         // viewBox / pan / zoom / rAF coalesce / flyTo
  BaseGeometryLayer.ts   // 由 VectorBasemap 拆出：land / water / roads / buildings
  ZoneLayer.ts           // zone polygon + pattern + hit priority
  EventLayer.ts          // event marker + cluster
  RouteLayer.ts          // route polyline + waypoint
  MarkerLayer.ts         // 通用 marker / beacon
  LabelLayer.ts          // label + 碰撞剔除 + LOD 密度
  MapControls.ts         // zoom in/out/reset（≥44px）
  map-lod.ts             // Z 定義 + tier 選擇 + 密度策略
  map-camera.ts          // flyTo / soft-focus / projection
  map-interactions.ts    // 手勢、hit testing、hover/click 派發
```

> **規則 R1**：`SvgMap.ts` **完全刪除**（唔可以保留做兼容層）。
> **規則 R2**：`VectorBasemap.ts` **rewrite**，但**保留** Canvas `Path2D` 快取 + `setTransform` 策略（A3 明確要求）。
> **規則 R3**：**layer 更新必須係 incremental**。現況 `SvgMap.render()` 每次 selection 全量重建 4 個 SVG layer —— 呢個係 V2 交互流暢度最大瓶頸（A3 integration note 第 2 點）。

### 2.3 Hit Priority 契約（A1/A2 實測 bug）

```
最高  ┌ MapControls / UI 浮層
      │ ZoneLayer（polygon + label）
      │ RouteLayer
      │ MarkerLayer
      │ EventLayer
最低  └ BaseGeometryLayer
```

現況：zone 中心點 `.elementFromPoint` 頂層係 `circle.event-marker`（A1：380/380 px 不可點；A2：`selected=0`）。
**要求**：zone 可點；event marker 喺 zone 內時，zone 仍可經**邊界**或 **legend/dossier 入口**選中。

---

## 3. LOD 策略（spec §2.3 第 2 點）

### 3.1 Z 定義

```ts
// src/map/map-lod.ts
export const Z = (viewW: number) => Math.log2(0.70 / viewW);  // viewW = viewBox 寬（度）
```

| Zoom 級 | viewBox 寬 | 顯示內容 | 目標密度 |
|---|---|---|---|
| **Z0–Z2** | 0.70° – 0.175° | 宏觀世界、主要倖存區、病窩、海陸、核心路線 | zone 48 全顯示（**glyph / cluster**） |
| **Z3–Z5** | 0.175° – 0.0219° | 區域結構、主要設施、道路骨架、zone subregion | zone **邊界** + 主要 label |
| **Z6–Z8** | 0.0219° – 0.0027° | 細節 landmark、事件 clusters、密集 route waypoint、局部 texture | zone **完整 pattern** + POI + 樓宇 |

**門檻值**：`0.175`（Z2/Z3 界）／`0.0219`（Z5/Z6 界）—— 取代現行未文件化嘅 `pickLevel`。

### 3.2 Zone LOD（解 S3：78 km vs 260 m = 300 倍差距）

| 級 | 觸發 | zone 渲染方式 |
|---|---|---|
| L-Z0 | viewW > 0.175° | **Cluster glyph**（直徑 8–12 px 嘅 badge，帶 kind icon + 數量） |
| L-Z1 | 0.0219° < viewW ≤ 0.175° | **邊界 polygon**（1 px 描邊 + 12% fill）+ 名稱 label |
| L-Z2 | viewW ≤ 0.0219° | **完整**：pattern + icon + 內部 landmark + danger 標示 |

> **規則 L1**：zone **永遠** render（D2）—— 章節只影響 **emphasis**（例如本章活躍 zone 提高 opacity / 加 pulse），**唔過濾**。
> **規則 L2**：現行 `SvgMap.ts:1204` 嘅 `c <= cur && cur <= c + 12` gate **必須移除**（A1/A2/A4/A10 一致指出）。
> **規則 L3**：`MAX_SCALE` 由 **35 → 64**（令 Z6 可達）。

### 3.3 章節過濾改為可調

| 現況 | V2 |
|---|---|
| location `Math.abs(c - cur) <= 3` | 預設「本章 ± 5 章」 |
| event `cur ± 1` | 預設「本章 ± 1 章」+ **layer control 提供「顯示全部事件」toggle** |

---

## 4. 資產策略（A4 明確指示）

### 4.1 **唔好做**（實測證明 0 參與）

- ❌ 再加 raster pyramid
- ❌ HiDPI raster tiles
- ❌ 提升 `hk-basemap.png` 解像度

### 4.2 必須刪除（死重）

| 資產 | Source | Dist | Runtime 請求 |
|---|---|---|---|
| `public/assets/map-lod/`（13 tier） | 27.52 MB | 27.52 MB | **0** |
| `public/assets/hk-basemap.png` | 1.9 MB | 3.9 MB（hashed + public 各一份） | **0** |
| `public/assets/hk-basemap-labels.png` | 132 KB | 264 KB | **0** |
| `map-tiles/`、`markers/`、`ui/`、`generated/` | 空 | 空 | — |
| **合計可回收** | **約 30 MB** | **約 32 MB** | — |
| `dist/` stale bundle（`emptyOutDir: false`） | — | 4.66 MB | — |
| **總可回收** | | **約 36.2 MB**（dist 53.6 MB → 17.6 MB） | |

> **規則 A1**：刪資產**必須**同一個 PR 內先移除 `SvgMap.ts` 嘅靜態 `import`（`lodManifest` / `basemapPngUrl` / `labelDetailPngUrl`），否則 `npm run build` 會爆。
> **規則 A2**：`vite.config.ts` 嘅 `emptyOutDir: false` **必須改回 `true`**（現時註解講嘅 `rm` shim 問題已可改用 `npm run clean` 解決）。
> **規則 A3**：`fallbackToRaster()` 保留但**只作 emergency**；唔設預設 `href`。

### 4.3 向量資產調整

| 項 | 現況 | V2 |
|---|---|---|
| `tile_deg` | 0.05° | **0.02°**（payload 4.15 MB → 約 1.0 MB） |
| `roads-l1.json` | 1.34 MB | 按 Z 分層載入；Level 2 道路要 fallback 到 `roads-l1`（tile 未載入時） |
| Tile POI | 已下載但 0 渲染 | **必須**喺 `drawLabels()` 畫（rank 5），同 global labels 合併／去重／碰撞剔除 |
| 建築對比 | light alpha 0.16–0.42、edge 0.35 px | light **0.35–0.65**、edge **0.7 px**；dark 同樣處理 |
| No-fake-zoom | 冇 | 低密度 tile → procedural contour + 「此區未有細節資料」label |

---

## 5. HiDPI 與 Seam

| 項 | 現況 | V2 要求 |
|---|---|---|
| Canvas backing store | DPR1 1060×752、DPR2 2120×1503 ✅ | **維持**；加斷言測試 |
| Tile seam | 未見白邊 | 維持；加 C3 檢查 |
| Tile transition | 未見閃爍 | layer cross-fade（`normal` duration）+ loading skeleton |
| Retina | 已支援 2x | 斷言 DPR 1 / 2 都通過 |

---

## 6. 效能預算（修訂 spec §7.4）

### 6.1 現況實測（A8）

| 操作 | 實測 | 目標 | 狀態 |
|---|---|---|---|
| 首屏 networkidle | **1,017 ms** | ≤3,000 ms | ✅ **已達標**（spec 原文） |
| 首屏可互動 | 165 ms | — | ✅ |
| 主線程空閒 | 566 ms | — | ✅ |
| **冷 zoom（首次入街道層）** | **20 longtask / 21,241 ms 阻塞 / 最長 4,650 ms / 1.8 fps** | ≤300 ms 阻塞 | ❌ **P0** |
| **Pan** | **29–31 fps**、p95 66.7 ms、34 longtask / 1,886 ms | ≥55 fps | ❌ **P1** |
| **Chronicle eager render** | **1,320 卡、DOM 14,036、強制 layout 124 ms** | DOM ≤4,000 | ❌ **P0** |
| Search | 0.6–10 ms | ≤150 ms | ✅ |
| Marker click | 16–26 ms | ≤100 ms | ✅ |
| Chronicle filter | 10.6 ms | ≤250 ms | ✅ |
| Zone selection | 未能量（zone 未 render） | ≤100 ms | ⏳ |

### 6.2 V2 收緊後嘅預算

| 指標 | 預算 | 驗收 |
|---|---|---|
| 首屏 networkidle | **≤1,500 ms** | Playwright timing |
| 首屏 JS transfer（gzip） | ≤60 KB | build 輸出斷言 |
| **`*.geojson` 必須 gzip/brotli** | 首屏資料 ≤1.2 MB（現 3.65 MB） | header 斷言（A8 P0-2） |
| 冷 zoom 主線程阻塞 | ≤300 ms | CDP longtask |
| Pan frame rate | ≥55 fps | CDP |
| Chronicle 首 render DOM | ≤4,000 nodes | DOM 計數 |
| Zone selection | ≤100 ms | Playwright |
| Search | ≤150 ms | Playwright |
| 單一 tile payload | ≤1.0 MB（現 4.15 MB） | network |
| `dist/` 總大小 | ≤20 MB（現 53.6 MB） | `du` |

### 6.3 效能修正優先次序（A8 最高 ROI）

| # | 項 | 收益 | 風險 | Owner |
|---|---|---|---|---|
| ① | **geojson gzip** | 首屏 3.65 MB → 1.14 MB（−69%） | 零 | infra / B3 |
| ② | **刪死重資產** | 36.2 MB | 低（需同 PR 移除 import） | B5 + 主代理 |
| ③ | **Chronicle virtualization** | DOM 14,036 → ≤4,000 | 中 | B7 |
| ④ | **圖磚路徑增量建構**（`ensureTiles` 唔好每次重建全部 `Path2D`） | 21.2 s → ≤0.3 s | 中 | B5 |
| ⑤ | **pan rAF coalesce + label 排序 cache** | 29 → ≥55 fps | 中 | B6 |
| ⑥ | **移除 `timeline.json` eager load** | 省 195 KB + 3.6 ms | 零 | B3 |

> ⚠️ **`VectorBasemap.ensureTiles()` 根因**：每載入**一格**圖磚就 `buildTileRoadPaths()` + `buildBuildingPaths()` 對**全部已載入圖磚**重建 `Path2D`（O(tiles × features)），加埋同步 `JSON.parse` 1 MiB 圖磚。

---

## 7. Zoom Quality 測試（程式化，spec §2.3 / §7.2-13）

> **規則 Q1**：**唔可以**靠人手目測截圖。必須 image analysis / OCR / 程式斷言。
> **規則 Q2**：**唔可以**只測「無 exception」。

| # | 斷言 | 方法 |
|---|---|---|
| Q1 | 各 target zoom（Z0/Z2/Z4/Z6/Z8）× DPR 1/2 截圖存在且尺寸正確 | Playwright |
| Q2 | 無 raster upscale：`<image>` / `<img>` 數 = 0；canvas backing = CSS × DPR | DOM 斷言 |
| Q3 | `flatRatio` 單調性：Z6–Z8 唔可以比 Z0 更平（**現況 0.850 > 0.846 → FAIL**） | 灰度梯度分析 |
| Q4 | `meanGrad` 深 zoom 唔可以低過中段 50% | 同上 |
| Q5 | 最大 zoom 視窗內 zone 數 ≥ 3（將軍澳） | DOM 計數 |
| Q6 | 最大 zoom 視窗內 event 數 ≥ 5 | DOM 計數 |
| Q7 | Label crispness：OCR 可讀出 ≥80% 可見 label | OCR |
| Q8 | 無 tile seam（相鄰 tile 邊界像素梯度 < threshold） | pixel diff |
| Q9 | Tile payload ≤1.0 MB | network |
| Q10 | 冷 zoom 阻塞 ≤300 ms | CDP longtask |
| Q11 | 「此區未有細節資料」狀態存在（低密度區） | DOM |

**現況**：Q3 / Q4 / Q5 / Q6 預期 FAIL —— 正好做 remediation 門檻。

---

## 8. spec §2.3 要求嘅 scripts 對照

| spec 要求 | repo 現況 | 裁定 |
|---|---|---|
| `diagnose_map_resolution.py` | ❌ 冇 | **新寫**（讀 zoom quality 量測結果出診斷） |
| `generate_vector_basemap.py` | ✅ 有 `build_vector_basemap.py` | **保留原名**（唔改名，避免無謂 churn） |
| `build_lod_assets.py` | ⚠️ 有 `build_map_lods.py`（raster） | **改為 vector LOD** 或 **deprecated**（raster LOD 已刪） |
| `render_hidpi_tiles.py` | ⚠️ 有 `render_binggang_map.py` | **deprecated**（raster 路徑唔再需要） |
| `verify_zoom_quality.py` | ❌ 冇 | **新寫**（Q1–Q11） |

> **規則 A4**：`build_map_lods.py` / `render_binggang_map.py` / `render_hk_basemap.py` 一旦確認冇其他依賴，**必須刪除**（避免雙軌）。

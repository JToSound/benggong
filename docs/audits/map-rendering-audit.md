# A4 Map Rendering Engineer — 地圖渲染管線與 Zoom Quality 審計

> 審計角色：A4 Map Rendering Engineer（World Atlas V2 重建專案，Phase 1 平行只讀審計）
> 審計範圍：`map-config.json` → 資產 → `SvgMap` → `VectorBasemap` → canvas / SVG 全鏈路；最大 zoom pixelation root cause；LOD 策略；死重資產；zoom quality 測試設計；spec §2.3 scripts 對照
> 可寫範圍：只寫 `docs/audits/map-rendering-audit.md` 同 `artifacts/audit-A4/`。**冇修改任何 production code / data / public / tests / scripts。**
> 所有數字為本代理**自己實測**。與 `artifacts/audit-context/baseline-findings.md` 唔一致嘅地方，以本報告為準並已標明。

---

## 任務摘要

1. **Spec §2.3 嘅問題定義（「最大 zoom 出現 pixelation，base-map 係單張低清 raster 被 CSS / SVG 放大」）與實測不符。** 現行 renderer 已經係 **Canvas 2D 向量底圖 + SVG 故事圖層**，raster fallback **從未觸發**（`map-lod/` 請求數 = 0，`<image href>` / `<img src>` 數目 = 0）。最大 zoom 嘅 render 係向量重繪，**冇 raster 起格、冇模糊**。

2. **真正 root cause 係「內容密度隨 zoom 反向下降」**，唔係解像度不足。實測 max zoom（0.020°）嘅 `flatRatio = 0.850`、`meanGrad = 9.12`，**比初始全港視圖（0.846 / 10.25）更平**；細節高峰落喺中段 zoom（0.245°，`flatRatio = 0.662`、`meanGrad = 27.26`）。成因有三個獨立來源，全部有實測數據（見 §Pixelation root cause 判定表 G1–G3）。

3. **Raster LOD pyramid（28 MB）唔單止係死重，佢嘅 policy 係錯嘅**：`MAX_SCALE = 35` 對 `tko-campus-core`（0.026°）嘅匹配**只喺將軍澳成立**。預設 zoom 中心（114.14°E, 22.36°N）**冇任何 detail tier 覆蓋**，只有 `overview`（0.70°），即若 fallback 觸發要放大 **18.12×**。現有 `tests/phase-j-lod.test.ts:137` 嘅斷言（「最窄圖磚跨度 ≥ 視窗最窄寬度」）**通過但畀出假保證**。

4. 死重資產合計 **約 32 MB source / 約 34 MB dist**（`map-lod/` 28 MB、`hk-basemap.png` 1.9 MB ×2 份 dist、`hk-basemap-labels.png` 132 KB ×2 份 dist），全部**需要先移除 code 嘅靜態 import 才可以刪**。

5. P0 = 3 項、P1 = 7 項、P2 = 4 項。

---

## 假設與證據

### 我審計嘅前提假設（全部經實測驗證或推翻）

| # | 假設（來自 spec / baseline） | 我嘅實測結果 |
|---|---|---|
| H1 | Spec §2.3：「最大 zoom 出現 pixelation，base-map 可能係單張低清 raster 被放大」 | **推翻**。`fallbackToRaster()` 從未執行；6 個 baseline run + 我 4 個 run 都錄到 `map-lod/` 請求數 = 0、`hk-basemap.png` 請求數 = 0 |
| H2 | Baseline §6.2：「DPR2 backing store 2120×1503 = 正確 HiDPI」 | **確認**。DPR1 → 1060×752；DPR2 → 2120×1503；CSS 1060×751.5。比例 = 2.000 |
| H3 | Baseline §6.3：「14 次點擊到 0.02° 上限，`MAX_SCALE = 35`」 | **確認**。`BASE_VIEW.w / 35 = 0.70/35 = 0.0200°`；step 14 到頂，step 15–20 完全 clamp |
| H4 | Baseline §6.4：「48 個 zone polygon 完全冇 render」 | **部分推翻**。實測初始視圖有 **1 個** `.zone` 節點（ch1）。唔係渲染失敗，係**章節過濾**（`chs.some(c => c <= cur && cur <= c + 12)`）令 47/48 個 zone 唔符合可見條件 |
| H5 | Baseline §6.4：「最大 zoom 未觀察到 raster 起格，內容極度稀疏、大片空區」 | **確認，並已量化**。max zoom `flatRatio = 0.850`（85% 像素局部梯度 < 4）；見 §flatness 曲線 |
| H6 | Baseline §6.2：「`map-lod/` 28 MB 完全冇 runtime 請求」 | **確認**。`updateBasemapTier()` 第 959 行 `if (!this.basemapFailed) return;` —— 向量底圖正常時 raster LOD 完全唔參與 |
| H7 | Spec §2.3 第 6 點：「至少支援 1x、2x DPR」 | **確認**。`syncBasemapView()` 傳 `Math.min(devicePixelRatio, 2)`；`draw()` 用 `Math.round(W*dpr)` 設 backing store |
| H8 | Spec §7.2 第 13 點：「各 target zoom + DPR 1/2 screenshot；assert no low-res raster scaling fallback」 | **未達成**。現有 `tests/` 完全冇 zoom crispness / DPR backing store / raster upscale 斷言（見 §驗證命令） |

### Spec 假設與實測嘅明確落差（必須由主代理裁決）

| Spec 條文 | 假設 | 實測 | 落差性質 |
|---|---|---|---|
| §2.3 問題定義 | 「最大 zoom 出現 pixelation（production blocker）」 | 最大 zoom 冇 pixelation；反而係內容稀疏 | **問題定義錯置**。P0 資源若投放喺「提升 raster 解像度」會完全解決唔到問題 |
| §2.3 第 5 點「Max zoom bound 根據最高可用細節動態限制」 | 現行 `MAX_SCALE = 35` 已匹配 | 只喺將軍澳匹配；預設中心要 18.12× 放大 | **policy 覆蓋範圍不足** |
| §2.3 第 3 點「高解像背景…多層 pyramid tiles（WebP/AVIF）」 | 需要 raster pyramid | 向量已經冇解像度限制，raster pyramid 係負資產 | **方向衝突**：V2 唔應該再建 raster pyramid |
| §0.3 北極星第 2 點「最大 zoom 唔起格、唔模糊」 | 未達成 | **已經達成**（無 raster、無模糊） | **已滿足但 spec 當成待修** |
| §0.3 北極星第 3–4 點「zone / dossier 可探索」 | 未達成 | 未達成（ch1 只有 1 個 zone、0 個 zone label） | **真正嘅 blocker 喺呢度** |
| §2.3 scripts 清單 | 要 5 個 script | 5 個全部唔存在（2 個以別名存在） | 見 §scripts 對照 |

### 量測方法（全部程式化、可重跑、零人手）

| 手法 | 位置 | 量度咩 |
|---|---|---|
| 離線 JSON 解析 | `artifacts/audit-A4/analyze-assets.mjs` | 向量圖層特徵數／頂點數／bbox；LOD tier 尺寸同縮放比；圖磚覆蓋 |
| Playwright + in-page canvas `getImageData` | `artifacts/audit-A4/zoom-quality-probe.mjs` | `inkRatio` / `edgeDensity` / `meanGrad` / `p99Grad` / `uniqueColors` / `hfEnergy`；DPR1 vs DPR2 |
| Raster fallback 模擬（同一套指標） | 同上 `rasterSim()` | 將 raster 按實際放大率畫上 canvas，量化「若 fallback 觸發會有幾模糊」 |
| 空區曲線 | `artifacts/audit-A4/flatness-probe.mjs` | `flatRatio`（梯度 < 4）／`veryFlatRatio`（< 2）／`meanGrad` vs zoom step |
| Canvas draw-call 攔截（monkey-patch `fillText`/`stroke`/`fill`，**只喺探針頁面注入，唔改 production**） | `artifacts/audit-A4/drawcall-probe.mjs`、`label-probe.mjs` | 每一幀實際畫咗幾多 label、label 文字、font size |
| 故事圖層密度掃章節 | `artifacts/audit-A4/density-probe.mjs` | ch 1/50/100/150/190 嘅 zone / route / location / event 節點數 |
| 視窗內容密度 | `artifacts/audit-A4/viewport-density.mjs` | max zoom 視窗內實際有幾多道路／建築／POI／label／zone／location／event |
| 圖磚 pop-in | `artifacts/audit-A4/popin-probe.mjs` | 首次進入 level 2 嘅圖磚回應時間同內容變化 |
| 主題對比 | `artifacts/audit-A4/theme-probe.mjs` | light vs dark 之下 max zoom 嘅 `flatRatio` / `meanGrad` |

---

## 發現／改動

### 1. Renderer pipeline 測繪

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 資料 / 配置層                                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ data/public/map-config.json                                                  │
│   renderer:"svg"  basemap_png:"assets/hk-basemap.png"                        │
│   lod_manifest:"assets/map-lod/manifest.json"      ← ⚠️ 全部過時／未使用     │
│   （App 只讀 chapters.total / spoiler / provisional_mode.banner）            │
│                                                                              │
│ public/assets/vector/manifest.json  ← 真正嘅 renderer 配置                   │
│   quant:100000  tile_deg:0.05  bbox:113.79–114.49 / 22.11–22.61              │
│   layers: land(83 rings) water(1761) areas(1632) l0(10953) l1(42738)         │
│           labels(7847)  tiles(89 格, 8.86 MB, 126841 幢建築)                 │
└─────────────────────────────────────────────────────────────────────────────┘
                     │
   ┌─────────────────┴───────────────────────────┐
   │                                             │
   ▼                                             ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────────┐
│ src/map/VectorBasemap.ts (935 行)│   │ src/components/SvgMap.ts (1646 行)   │
│ ── Canvas 2D 底圖 ──             │   │ ── SVG 故事圖層 ──                   │
│                                  │   │                                      │
│ init(): 並行載入 land / water /  │   │ render() 每次重建 4 個 <g>：         │
│   areas / labels（常駐，1.19 MB）│   │  #zones-layer    : 48 個 zone polygon│
│                                  │   │                    + glow + pulse +   │
│ setView(view, cssW, cssH, dpr)   │   │                      badge + zone-label│
│   └ pickLevel(view.w):           │   │  #routes-layer   : Catmull-Rom 曲線  │
│       w > 0.35  → level 0        │   │                    （只畫真實-真實段）│
│       0.05 < w  → level 1        │   │  #locations-layer: 標記 + 聚合 cluster│
│       w ≤ 0.05  → level 2        │   │  #events-layer   : 事件圓點           │
│   └ ensureLevelData(level):      │   │                                      │
│       lvl0 → roads-l0.json (329KB)│   │ 投影：lonlatToViewbox()              │
│       lvl1 → roads-l1.json (1.34MB)│  │   x = lon 偏移                       │
│       lvl2 → ensureTiles():      │   │   y = (lat_max − lat)/cos(φ₀)        │
│         16 格 r{rr}c{cc}.json    │   │   φ₀ = 22.36°, cos = 0.9247          │
│         (LRU 上限 24 格)          │   │                                      │
│                                  │   │ 隱藏 fallback（實測從未使用）：       │
│ draw():                          │   │  <image #basemap-group>              │
│   海漸層 → 經緯格線 → 陸地       │   │  <image #label-detail-image>         │
│   → 綠地/工業區 → 內陸水體       │   │   （由 fallbackToRaster() 才設 href）│
│   → 建築（只有 level 2）         │   │                                      │
│   → 道路（level0=l0/1=l1/2=tile）│   │                                      │
│   → 標籤（global labels.json）   │   │                                      │
│   → 暗角                          │   │                                      │
│                                  │   │                                      │
│ 幾何一律 Path2D 批次 + setTransform│  │                                      │
│ （度空間 → 螢幕像素仿射）         │   │                                      │
└──────────────────────────────────┘   └──────────────────────────────────────┘
        │                                          │
        ▼                                          ▼
  <canvas id="basemap-canvas">              <svg id="svg-map"
   backing = round(cssW×dpr)                  preserveAspectRatio="xMidYMid meet"
   （DPR1: 1060×752 / DPR2: 2120×1503）        viewBox 同 canvas 共用同一 view}

┌─────────────────────────────────────────────────────────────────────────────┐
│ 死重／未接駁路徑（實測 0 次執行）                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ public/assets/hk-basemap.png (2048×1582, 1.9 MB)  ──?url──► BASEMAP_PNG     │
│ public/assets/hk-basemap-labels.png (132 KB)      ──?url──► LABEL_DETAIL_PNG│
│ public/assets/map-lod/manifest.json (11 KB)       ──import──► LOD_TIERS     │
│   └─ 只被 fallbackToRaster() / updateBasemapTier() / pickTier() 使用        │
│ public/assets/map-lod/*.png × 13 tier (28 MB)     ← 從來冇 fetch             │
│ public/assets/hk-basemap-coords.json (1 KB)       ──import──► BASEMAP_BBOX  │
│   └─ ⚠️ 呢個有真用（BASEMAP_BBOX / BASE_VIEW 靠佢推導）                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**各層負責咩（實測）**

| 層 | 技術 | 畫咩 | 每次 render 重建？ |
|---|---|---|---|
| `#basemap-canvas` | Canvas 2D（`alpha:false`） | 海、經緯格線、陸地輪廓、綠地／工業區、內陸水體、建築（只有 level 2）、道路、地名標籤、暗角 | 否（`setTransform` 批次重繪；圖層內容變才重建 Path2D） |
| `#zones-layer`（SVG） | DOM `<path>` | 48 個 zone polygon + glow + nest pulse + 圖騰 badge + 常駐標籤 | **是**（`replaceChildren()`） |
| `#routes-layer`（SVG） | DOM `<path>` | 角色路線（只畫兩端都係真實地點嘅段） | **是** |
| `#locations-layer`（SVG） | DOM `<circle>` / `<g>` | 地點標記 + 聚合 cluster（含數量） | **是** |
| `#events-layer`（SVG） | DOM `<circle>` | 事件標記 | **是** |
| `#basemap-group` / `#label-detail-image` | SVG `<image>` | **冇**（href 從未設定） | 否 |

---

### 2. Pixelation root cause 判定表（核心）

> 每個假設 → 實測數據 → 結論。所有「放大率」定義為 `視窗 px per degree ÷ 資產 px per degree`。

| # | 假設 | 實測 | 結論 |
|---|---|---|---|
| **A** | Asset dimension vs CSS scaling：單張低清 raster 被放大 | max zoom 時 `<image href>` = 0 個、`<img src>` = 0 個；`map-lod/` 請求 = 0；`hk-basemap.png` 請求 = 0。**Raster 完全冇參與渲染** | **❌ 不成立** |
| **B** | CSS scaling / viewBox 拉伸 | SVG 用 `preserveAspectRatio="xMidYMid meet"`（等比放入）；canvas 用 `s = min(W/view.w, H/view.h)` + `ox/oy` letterbox（max zoom 時左右各 43.2 px 留白），x/y 共用同一個 `s`。**冇非等比拉伸** | **❌ 不成立** |
| **C** | Canvas backing store 未跟 `devicePixelRatio` | DPR1 → backing 1060×752，CSS 1060×751.5（比 = 1.000）；DPR2 → backing 2120×1503（比 = 2.000）。`draw()` 用 `Math.round(W*dpr)` | **❌ 不成立（HiDPI 正確）** |
| **D** | Max zoom bound 與 LOD tier 跨度唔匹配 | `MAX_SCALE = 35` → 最窄視窗 `0.70/35 = 0.0200°`；最細 tier `tko-campus-core` 跨度 `0.026°` → 全域斷言（`0.026 ≥ 0.019`）**通過**。**但**：預設 zoom 中心 (114.14, 22.38) 嘅視窗 bbox（lon 114.13–114.15, lat 22.353–22.367）**只被 `overview`（0.70°）覆蓋**（4 個分區 tier 都有 0.005° 級嘅 seam 缺口）→ 若用 raster 要放大 **18.12×** | **⚠️ 部分成立（policy 覆蓋唔全）** |
| **E** | Raster fallback 被觸發 | 6 個 baseline run + 我 4 個 run：`basemapFailed` 從未變 `true`；console 冇「向量底圖載入失敗」warning | **❌ 不成立** |
| **F** | Vector 資料本身嘅精度／密度限制 | `quant = 100000` → 1 單位 = 1e-5° ≈ **1.11 m**（lon）。max zoom 時 1 px = `0.02/1060` = **1.887e-5° ≈ 2.10 m** → 量化誤差 = **0.53 px（亞像素）**。tile 道路簡化容差 2.5e-5° ≈ 1.3 px；tile 建築 2.0e-5° ≈ 1.1 px。**精度足夠** | **❌ 不成立（精度不是瓶頸）** |
| **G1** | （新假設）**內容密度隨 zoom 反向下降** | `flatRatio`（局部梯度 < 4 嘅像素比例）：0.700°=**0.846** → 0.245°=**0.662** → 0.086°=**0.714** → 0.030°=**0.767** → 0.020°=**0.850**。`meanGrad`：10.25 → **27.26（峰值）** → 22.94 → 14.5 → **9.12**。**max zoom 反而係全條曲線最平嘅一點** | **✅ 成立 —— 真正 root cause 之一** |
| **G2** | （新假設）**故事圖層受章節過濾，深 zoom 時幾乎清空** | 將軍澳 max-zoom 視窗（lon 114.257–114.277, lat 22.318–22.332）內：event **176 個在場 → ch1 實際畫 0 個**；location **72 個 → 畫 3 個**；zone **19 個重疊 → 畫 0 個**。ch150 亦只有 event 1 / location 0 / zone 4（該視窗） | **✅ 成立 —— 真正 root cause 之二** |
| **G3** | （新假設）**圖磚 POI 已經下載／解析但從來冇畫** | `VectorBasemap.draw()` 只由 `this.labels`（global labels.json，7847 個）取標籤；`TileData.poi` 只喺 `ensureTiles()` 填充、喺 `bytesLoaded` 計數，**draw() 從未引用**。max-zoom 視窗內有 **48–53 個 tile POI（全部係建築名，rank 5）** 從未顯示 | **✅ 成立 —— 真正 root cause 之三** |
| **G4** | （新假設）**建築描繪對比度過低** | light palette 建築 fill alpha = 0.16–0.42、stroke width 0.35 px；dark palette 更淡（實測 dark `flatRatio = 0.862` vs light `0.850`，`meanGrad` 6.67 vs 9.12 → **dark 主題更平**）。max zoom 視窗內 401–978 幢建築只貢獻 `meanGrad 9.12` | **✅ 成立（加劇因素）** |

#### Pixelation root cause 判定：一句總結

> **現時嘅「低清感」唔係 pixelation，亦唔係任何 raster 放大問題**（raster 路徑 100% 未觸發，DPR / viewBox / 資產尺寸全部正確）。
> 真正來源係三件事疊加：**(G2) 故事圖層被 ±1～±3 章嘅章節窗口過濾，令深 zoom 時 zone / location / event 幾乎清空（將軍澳 176 個 event → 畫 0 個）**；**(G3) 唯一可以提供街道級地標嘅 tile POI（建築名）已經下載但冇渲染**；**(G1+G4) 向量底圖嘅建築以 0.16–0.42 alpha、0.35 px 描邊繪製，令 85% 像素落喺近純色區**。
> 三者令「放大」之後邊際資訊量**下降**，使用者感知為「低清」。

#### Raster fallback 模擬（量化「若 fallback 觸發會有幾嚴重」）

用同一套像素指標，將 raster 按實際放大率畫上 1060×752 視窗：

| 情境 | 放大率（DPR1 / DPR2） | `edgeDensity` | `meanGrad` | `p99Grad` | `uniqueColors` | `hfEnergy` |
|---|---|---|---|---|---|---|
| **實際渲染（向量，max zoom）** | — | **0.1016 / 0.0675** | **9.12 / 6.88** | **152 / 156** | **504 / 492** | **3.80 / 2.74** |
| fallback 模擬：`hk-basemap.png` 覆蓋 0.02° 視窗 | **18.12× / 36.23×** | **0.0000 / 0.0000** | **0.54 / 0.27** | **8 / 4** | **30 / 30** | **0.16 / 0.08** |
| fallback 模擬：`tko-campus-core.png` 覆蓋 0.02° 視窗 | 0.67× / 1.35× | 0.167 / 0.124 | 15.27 / 9.97 | 152 / 116 | 139 / 150 | 5.05 / 2.80 |
| 對照：`hk-basemap.png` 1:1 | 0.52× / 1.04× | 0.112 / 0.072 | 12.78 / 7.58 | 156 / 120 | 162 / 167 | 3.92 / 2.12 |

**解讀**：若 fallback 喺預設中心觸發，`meanGrad` 由 9.12 跌到 **0.54（17× 更模糊）**、`uniqueColors` 由 504 跌到 **30**、`p99Grad` 由 152 跌到 **8** —— 呢個就係 spec 描述嘅 pixelation。**佢係一個「若發生」情境，實測並無發生**。相反 `tko-campus-core` 喺 0.67× 之下表現同向量相若 → **raster LOD pyramid 只喺將軍澳有效**。

#### LOD tier 尺寸 / 縮放比對照表（逐個 tier）

視窗寬度假設 1060 CSS px。`對應視窗寬度` = 該 tier 成為 pickTier 結果嘅最闊視窗（= 自己嘅經度跨度）。`max zoom 放大` = 視窗寬度 = 0.020° 時嘅放大率。

| tier | image 尺寸 | bbox 跨度（lon° × lat°） | native px/° | 對應視窗寬度 | 對應 zoom scale | 覆蓋預設 max-zoom 視窗? | 選中時放大 | max zoom 放大 |
|---|---|---|---|---|---|---|---|---|
| overview | 2048×1582 | 0.700 × 0.500 | 2 926 | 0.700° | 1.00× | **✅ 唯一** | 0.52× | **18.12×** |
| hk-nw | 2048×1561 | 0.355 × 0.250 | 5 769 | 0.355° | 1.97× | ❌ | 0.52× | 9.19× |
| hk-ne | 2048×1583 | 0.350 × 0.250 | 5 851 | 0.350° | 2.00× | ❌ | 0.52× | 9.06× |
| hk-sw | 2048×1589 | 0.355 × 0.255 | 5 769 | 0.355° | 1.97× | ❌ | 0.52× | 9.19× |
| hk-se | 2048×1612 | 0.350 × 0.255 | 5 851 | 0.350° | 2.00× | ❌ | 0.52× | 9.06× |
| tko-region | 1536×1411 | 0.200 × 0.170 | 7 680 | 0.200° | 3.50× | ❌ | 0.69× | 6.90× |
| tko-district | 1536×1328 | 0.110 × 0.088 | 13 964 | 0.110° | 6.36× | ❌ | 0.69× | 3.80× |
| tko-street | 2048×1845 | 0.060 × 0.050 | 34 133 | 0.060° | 11.67× | ❌ | 0.52× | 1.55× |
| tko-campus | 1536×1384 | 0.036 × 0.030 | 42 667 | 0.036° | 19.44× | ❌ | 0.69× | 1.24× |
| **tko-campus-core** | 2048×1754 | **0.026 × 0.0206** | **78 769** | 0.026° | 26.92× | ❌ | **0.52×** | **0.67×** |
| tko-hang-hau | 2048×1476 | 0.030 × 0.020 | 68 267 | 0.030° | 23.33× | ❌ | 0.52× | 0.78× |
| tko-po-lam | 2048×1476 | 0.030 × 0.020 | 68 267 | 0.030° | 23.33× | ❌ | 0.52× | 0.78× |
| tko-lohas | 2048×1476 | 0.030 × 0.020 | 68 267 | 0.030° | 23.33× | ❌ | 0.52× | 0.78× |
| tko-north | 2048×1628 | 0.068 × 0.050 | 30 118 | 0.068° | 10.29× | ❌ | 0.52× | 1.76× |

**`pickTier()` 喺預設 max-zoom 視窗嘅實際結果 = `overview`（18.12× 放大）。**
（原因：4 個分區 tier 喺 lon 114.145 / lat 22.365 交界有 seam，預設中心 (114.14, 22.36) 啱啱落喺缺口。）

#### 空區曲線（ch=1，DPR1，逐 zoom step 實測）

| step | view.w (°) | basemap level | `flatRatio` | `veryFlatRatio` | `meanGrad` | `edgeDensity` |
|---|---|---|---|---|---|---|
| 0 | 0.7000 | 0 | 0.8456 | 0.8371 | 10.25 | 0.1081 |
| 2 | 0.4142 | 0 | 0.8207 | 0.8079 | 11.24 | 0.1277 |
| **4** | **0.2451** | **1** | **0.6621** | 0.6427 | **27.26** | **0.2724** |
| 6 | 0.1450 | 1 | 0.6962 | 0.6763 | 24.29 | 0.2377 |
| 8 | 0.0858 | 1 | 0.7137 | 0.6916 | 22.94 | 0.2239 |
| 10 | 0.0508 | 1 | 0.7912 | 0.7733 | 16.52 | 0.1601 |
| 12 | 0.0300 | 2 | 0.7667 | 0.7486 | 14.50 | 0.1621 |
| **14** | **0.0200** | **2** | **0.8502** | 0.8354 | **9.12** | **0.1016** |

**結論：細節峰值喺 step 4（level 1），去到 max zoom 反而跌返落初始水平以下。** 呢個「反向」曲線就係使用者講嘅「放大之後冇嘢睇」。

---

### 3. 向量資產分析（`public/assets/vector/`，實測 11.4 MB）

| 檔案 | bytes | 特徵數 | 頂點數 | 用途 | 格式 | 量化 | 載入時機 |
|---|---|---|---|---|---|---|---|
| `manifest.json` | 5 318 | — | — | 版本 / bbox / quant / tile_deg / 圖層索引 | JSON | — | 啟動（首個 fetch） |
| `land.json` | 92 229 | 83 rings | 13 121 | 陸地多邊形（由海岸線推導） | delta 整數 ring | 1e-5° | 啟動（常駐） |
| `water.json` | 129 485 | 1 761 rings | 16 192 | 內陸水體 | delta 整數 ring | 1e-5° | 啟動（常駐） |
| `areas.json` | 123 265 | 1 632（k=0 綠地 / k=1 工業） | 11 739 | 公園／林地／工業區面 | delta 整數 ring | 1e-5° | 啟動（常駐） |
| `labels.json` | 512 159 | 7 847（rank 1:30 / 2:224 / **3:7570** / 4:23） | — | 地名標籤（絕對量化座標 + rank） | `{n,k,r,x,y}` | 1e-5° | 啟動（常駐） |
| `roads-l0.json` | 329 333 | 10 953 | 22 315 | level 0 主幹道（class ≤ 2，簡化容差 4.5e-4°≈50 m） | `[cls,flags,x0,y0,dx,dy…]` | delta 1e-5° | 首次 level 0（啟動即用） |
| `roads-l1.json` | 1 341 851 | 42 738 | 95 752 | level 1 全部道路（class ≤ 5，容差 1.6e-4°≈17.8 m） | 同上 | delta 1e-5° | 首次進入 level 1 |
| `tiles/r{rr}c{cc}.json` × 89 | 8 856 000（8.86 MB） | 42 739 路 / **126 841 幢建築** / **11 645 POI** | — | level 2 道路（class ≤ 7，容差 2.5e-5°≈2.8 m）+ 建築（容差 2.0e-5°≈2.2 m，面積 ≥ 24 m²）+ 建築名 POI | `{rc,roads,bld,poi}` | delta 1e-5° | 首次進入 level 2（LRU 上限 24 格） |

#### 各 layer 喺各 zoom 嘅實際 render 密度（實測）

| zoom | 資料源 | 視窗內道路 | 視窗內建築 | 畫出嘅 canvas label | 畫出嘅 tile POI | SVG zone | SVG route | SVG location | SVG event |
|---|---|---|---|---|---|---|---|---|---|
| 0.700°（初始 ch1） | roads-l0（class ≤2） | 10 953（全域） | 0 | **21**（11 個 unique） | 0 | **1** | 1 | 1 + 4 cluster | 11 |
| 0.245°（level 1） | roads-l1（class ≤5） | 42 738（全域） | 0 | **487**（384 unique） | 0 | 1 | 1 | 8 + 2 cluster | 11 |
| 0.086°（level 1） | roads-l1 | 42 738 | 0 | **351**（241 unique） | 0 | 1 | 1 | 11 + 1 cluster | 11 |
| 0.030°（level 2） | tiles（class ≤7） | 16 格內 8 312 | 16 格內 18 082 | **317**（73 unique） | **0（48 個在場）** | 1 | 1 | 13 + 1 cluster | 11 |
| **0.020°（max, ch1）** | tiles | **視窗內 196** | **視窗內 401** | **39**（39 unique，全部 10.5px rank-3） | **0（48 個在場）** | **1** | 1 | 13 + 1 cluster | 11 |
| 0.020°（max, ch150） | tiles | 視窗內 180 | 視窗內 978 | **63** | **0（53 個在場）** | **13** | 1 | 15 + 1 cluster | 21 |

**要點**
- **Tile POI 100% 未渲染**：max zoom 視窗內 48–53 個建築名 POI 已下載／解析／計入 `bytesLoaded`，但 `draw()` 從未使用（`VectorBasemap.ts:581` 只做 decode，冇任何 render 引用）。
- **Canvas label 數量喺 max zoom 下降**（487 → 39）：`drawLabels()` 有碰撞剔除（`seen` 陣列），而 global `labels.json` 嘅 rank-3 標籤（7 570 個）係公園／屋苑名，唔係街道級地標。
- **故事圖層喺 ch1 幾乎全空**：1 個 zone（48 個之中）、1 條 route（42 條之中）、5 個 location marker（704 個之中）、11 個 event marker（1 796 個之中）。
- **圖磚覆蓋完整**：140 格之中有 89 格（缺 51 格全部係海／香港範圍外；只有 cell 9,1 有 1 條道路但冇圖磚，屬邊界雜訊）。**唔存在「有資料但冇圖磚」嘅系統性缺口。**

---

### 4. LOD 策略提案（按 spec §2.3 第 2 點 Z0–Z2 / Z3–Z5 / Z6–Z8）

#### 4.1 先修正 Z 嘅定義（spec 現時無法執行）

Spec 講 Z0–Z8 但冇 anchor。實測現況：`MAX_SCALE = 35` → 最深只到 **0.020°**，即 `Z = log2(0.70/0.020) = 5.13`。**spec 嘅 Z6–Z8 喺現行 bound 之下完全不可達**。

建議 anchor：**Z = log2(0.70° / view.w)**，每個 Z 將視窗寬度減半。

| Z | view.w | 現行 level | 建議對應 |
|---|---|---|---|
| Z0 | 0.700° | 0 | 現狀 |
| Z1 | 0.350° | 0 | 現狀 |
| Z2 | 0.175° | 1 | 現狀 |
| Z3 | 0.0875° | 1 | 現狀 |
| Z4 | 0.0438° | 2 | 現狀（level 2 門檻 0.05 應該改為 0.044） |
| Z5 | 0.0219° | 2 | 現狀（= 現行 MAX_SCALE 35） |
| Z6 | 0.0109° | **需新 tier** | 需要 `MAX_SCALE ≥ 64` |
| Z7 | 0.0055° | — | 需要 `MAX_SCALE ≥ 128` |
| Z8 | 0.0027° | — | 需要 `MAX_SCALE ≥ 256`（≈ 0.27 m/px，已係建築內部尺度，**唔建議**） |

**建議：Z6 做實際最深層（`MAX_SCALE = 64`），Z7/Z8 明確定義為「不提供」，並喺 UI 顯示已達最詳盡層。** 理由：tile 建築簡化容差 2.0e-5°≈2.2 m，Z6（0.0109° / 1060 px = 1.14 m/px）之下 1 px ≈ 0.5 m，已經接近資料精度極限；再放大只會見到被簡化嘅多邊形直邊，屬 spec §2.3 第 4 點禁止嘅「fake zoom」。

#### 4.2 三層 LOD policy（具體）

| 層 | Z | view.w | 底圖資料 | 故事圖層 | 標籤 | 密度目標 |
|---|---|---|---|---|---|---|
| **宏觀 Z0–Z2** | 0–2 | 0.70–0.175° | land + water + areas + roads-l0（class ≤2） | **全部 48 個 zone 邊界（唔受章節過濾）** + zone 常駐 label + 全部 42 條 route 嘅端點 + 事件 cluster（唔係逐點） | rank 0–1（地區／島嶼） | `flatRatio ≤ 0.80`、zone 邊界覆蓋 ≥ 25% viewport |
| **中觀 Z3–Z5** | 3–5 | 0.0875–0.0219° | + roads-l1（class ≤5）+ 建築面（提升 alpha 到 0.35–0.6） | zone 內 landmark + 事件逐點 + location 標記（**唔受 ±3 章限制，改為「本章 ±N 章」可調 + 「顯示全部」toggle**） | rank 0–3（+ 屋苑／公園） | `flatRatio ≤ 0.70`、`edgeDensity ≥ 0.20`、視窗內 ≥ 120 個 label |
| **細節 Z6** | 6 | ≤ 0.0109° | tiles（class ≤7 道路 + 建築逐幢描邊）+ **tile POI 必須渲染** | zone 內部設施 + 事件精確 marker + 短 label | rank 0–5（+ 建築名） | `flatRatio ≤ 0.60`、`edgeDensity ≥ 0.25`、視窗內 ≥ 200 個 label |

#### 4.3 Threshold 建議（取代硬編碼）

```text
現行：pickLevel(w) = w > 0.35 ? 0 : w > 0.05 ? 1 : 2
建議：pickLevel(w) = Z(w) <= 2 ? 0 : Z(w) <= 5 ? 1 : 2     其中 Z(w) = log2(0.70/w)
      → 邊界由 0.35 / 0.05 變成 0.175 / 0.0219（同 Z 層一致，避免 level 2 太早啟動）
tile_deg：0.05° → 0.02°（令 max zoom 時只需 4 格覆蓋，payload 由 4.15 MB 降到約 1.0 MB）
MAX_SCALE：35 → 64（令 Z6 可達）
```

#### 4.4 No-fake-zoom 規則（spec §2.3 第 4 點）

若某圖磚特徵數低於門檻（實測最低 cell 只有 0–2 幢建築），**唔可以**顯示空白陸地。應畫：
- 程序化等高線／hatch pattern（用 `Path2D` + `lineDash`，向量、任何 zoom 清晰）；
- 明確「此區未有細節資料」label（rank 0）；
- zone 邊界（即使係估算，用虛線 + `zone-badge` 圖騰）。

---

### 5. 死重資產處置建議

| 資產 | 大小 | 現狀 | 建議 | 理由 | 前置條件 |
|---|---|---|---|---|---|
| `public/assets/map-lod/`（13 個 tier PNG + 13 個 coords JSON + manifest） | **28 MB** | 0 次 runtime 請求 | **刪除** | (a) 從未被 fetch；(b) 12/13 個 tier 喺預設 zoom 中心無法覆蓋（要 6.9–18.12× 放大）；(c) 向量已經完全取代；(d) 部署到 GitHub Pages 白白多 28 MB | **必須先改 `src/components/SvgMap.ts`**：移除 `import lodManifest from ".../map-lod/manifest.json"`，將 `PROJ_COS` 改成常數 `0.9247`（已經同 `VectorBasemap.PROJ_COS` 重複），刪 `LOD_TIERS` / `pickTier` / `updateBasemapTier` / `preloadFinerTier` / `tierRect` / `tierSpan` / `assetUrl` 同 raster 分支。**否則 `npm run build` 會爆。** |
| `public/assets/hk-basemap.png` | **1.9 MB** | 入 bundle（`?url` → dist hashed 1.9 MB）**＋** 由 `public/` 複製多一份（dist 共 **3.9 MB**） | **刪除**（若保留 fallback：轉 WebP/AVIF，目標 ≤ 400 KB，且只保留一份） | 只喺 `fallbackToRaster()` 用，實測 0 次觸發。fallback 用途（「好過一片黑」）可以用 procedural pattern 取代，零位元組 | 移除 `import basemapPngUrl` / `BASEMAP_PNG` / `fallbackToRaster()`；改為渲染 fallback pattern |
| `public/assets/hk-basemap-labels.png` | **132 KB × 2（dist 264 KB）** | 同上 | **刪除** | 同上；而且只有 `overview` tier 配套，該 tier 本身都唔用 | 移除 `import labelDetailPngUrl` / `LABEL_DETAIL_PNG` / `#label-detail-layer` / `#label-detail-image` / `updateLabelLayerOpacity()` |
| `public/assets/hk-basemap-coords.json` | 1 KB | 被 `import basemapCoords` 使用（`BASEMAP_BBOX`） | **保留，但改為 TypeScript 常數** | 有真用（投影基準）；inline 之後可以刪檔 | 將 bbox 4 個數字寫入 `SvgMap.ts` 或新建 `src/map/map-projection.ts` |
| `public/assets/map-tiles/`、`markers/`、`ui/`、`generated/` | 0 | 空目錄 | **刪除** | 空目錄會令 build / 部署工具產生噪音 | 冇 |
| vector tiles 內嘅 POI（11 645 個，約 0.6 MB） | 0.6 MB | 下載 + 解析但唔畫 | **唔刪，改為渲染** | 呢啲係唯一嘅街道級地標來源（帝京酒店 / 朗豪坊 / 英華小學…），刪咗就冇 detail label；渲染佢哋同時解決 G3 | 喺 `drawLabels()` 加入 `this.tiles` 嘅 POI（合併去重 + 碰撞剔除） |

**合計可刪：28 MB（map-lod）+ 1.9 MB（hk-basemap，dist 3.9 MB）+ 132 KB（labels，dist 264 KB）+ 空目錄 → source 約 30 MB、dist 約 32 MB。**

#### 死重資產嘅 dist 重複排放（額外發現）

`dist/assets/` 同時有：
- `hk-basemap-_tR-jzZe.png`（1 978 248 B，Vite hashed，來自 `?url` import）
- `hk-basemap.png`（1 978 248 B，來自 `public/` 複製）
- `hk-basemap-labels-DtX8PzYn.png`（131 687 B，hashed）
- `hk-basemap-labels.png`（131 687 B，複製）
- `map-lod/`（28 MB，複製）

即 **同一份 raster 喺 dist 出現兩次**。呢個係「`public/` 複製 + Vite asset pipeline」同時命中嘅結果。刪除 `public/assets/hk-basemap*.png` 之後，如果保留 `?url` import 就只會剩 hashed 一份；如果連 import 都刪，就兩份都冇。

---

### 6. Zoom quality 測試設計（程式化、可重跑、零人手）

> 硬性要求：**唔可以靠人手睇截圖**。全部斷言基於 in-page canvas `getImageData` 像素統計 + OCR。原型已寫入 `artifacts/audit-A4/zoom-quality-probe.mjs`（可直接跑）。

#### 6.1 測試矩陣

```text
targetZoom ∈ { initial(0.700), 0.350, 0.175, 0.088, 0.044, 0.022, 0.020(max) }
dpr        ∈ { 1, 2 }
viewport   ∈ { 1440×900 desktop, 390×844 mobile }
chapter    ∈ { 1, 150 }        ← ch1 = 稀疏情境、ch150 = 將軍澳密集情境
```

#### 6.2 斷言（每格都要通過）

| # | 斷言 | 量度方法 | 門檻（實測 baseline → 目標） |
|---|---|---|---|
| Z1 | **HiDPI backing store 正確** | `canvas.width === round(cssW*dpr) && canvas.height === round(cssH*dpr)` | 精確相等（現時已通過） |
| Z2 | **冇 raster 放大 fallback** | `document.querySelectorAll("image[href], img[src]").length === 0`；route intercept 之下 `map-lod/` 請求數 === 0 | 0（現時已通過） |
| Z3 | **冇 upscaled low-res asset** | 對每個有 `href` 嘅 `<image>`：`naturalWidth / (renderedWidth × dpr) ≥ 1.0` | ≥ 1.0 |
| Z4 | **Crispness（向量）** | in-page `edgeDensity`（梯度 > 24 嘅像素比例） | ≥ baseline × 0.8。實測 max zoom DPR1 = 0.1016 → 門檻 0.081；DPR2 = 0.0675 → 0.054 |
| Z5 | **邊緣銳利度** | `p99Grad` | ≥ 120（實測 152/156） |
| Z6 | **顏色層次** | `uniqueColors`（4-bit 量化後非空 bin 數） | ≥ 300（實測 504/492；若跌到 < 100 就代表被拉伸 bitmap 取代） |
| Z7 | **內容密度（新增，最重要）** | `flatRatio`（局部梯度 < 4 嘅像素比例） | **≤ 0.70**。實測 max zoom ch1 = **0.850 → 現時 FAIL**（正好係 remediation 目標） |
| Z8 | **Label crispness** | 對 canvas 做 label 區 OCR（`tesseract.js` chi_tra），斷言：辨識到嘅中文字元數 ≥ 25，且辨識字元嘅 bounding box 高度 ≥ 9 px | ≥ 25 字 / ≥ 9 px |
| Z9 | **Label 冇被 bitmap 取代** | canvas `fillText` 呼叫數（monkey-patch 攔截）≥ 20 @ max zoom | ≥ 20（實測 39–63） |
| Z10 | **故事圖層唔可以全空** | `.zone` + `.zone-label` + `.location-marker` + `.event-marker` 節點總數 | ≥ 15。實測 ch1 = 1+0+13+11 = 25（勉強過）；但 `zone` = 1 → 應加 `zone ≥ 6` 子斷言（現時 FAIL） |
| Z11 | **圖磚 payload budget** | route intercept 統計 `assets/vector/tiles/*` 總 bytes | ≤ 1.5 MB per zoom transition（實測 **4.15 MB → FAIL**） |

#### 6.3 產出

```text
artifacts/zoom-quality/
  report.json                          # 每個 (zoom, dpr, viewport, chapter) 嘅全部指標 + pass/fail
  shots/{dpr}x/{viewport}-z{zoom}-ch{chapter}.png
  ocr/{dpr}x/{viewport}-z{zoom}-ch{chapter}.txt
```

失敗時 **exit code 非零**，並印出「邊個斷言、實測值、門檻、關聯檔案」。整合方式（二選一）：

1. **Vitest + Playwright**：新增 `tests/zoom-quality.e2e.test.ts`（跟 `tests/visual-smoke.e2e.test.ts` 嘅 pattern，共用 `e2e.global-setup.ts` 嘅 preview server）；
2. **Python**：`scripts/verify_zoom_quality.py` 用 `playwright.sync_api`（配合 spec §2.3 嘅 script 命名）。

**建議兩者都做**：Vitest 版入 CI（快、只跑 1440 + DPR1/2），Python 版做完整矩陣 + 產生 artifact。

#### 6.4 Raster fallback 回歸測試（防止 spec 描述嘅 pixelation 回歸）

將 `artifacts/audit-A4/zoom-quality-probe.mjs` 嘅 `rasterSim()` 邏輯納入測試：把任何有 `href` 嘅 raster 按實際放大率畫上 canvas，斷言 `meanGrad ≥ 4.0`。實測 `hk-basemap.png` 喺 18.12× 之下 `meanGrad = 0.54` → 會 **FAIL**，正好攔住「用低清 raster 頂替」嘅改動。

---

### 7. Spec §2.3 要求嘅 scripts 清單 vs repo 現況

| Spec §2.3 要求 | Repo 現況 | 建議動作 | 理由 |
|---|---|---|---|
| `diagnose_map_resolution.py` | **❌ 唔存在** | **新寫** | 需要一個離線診斷：讀 `vector/manifest.json` + `map-lod/manifest.json` + 前端 level 門檻，輸出「每個 zoom 用邊個資料源、effective px/°、放大率、覆蓋唔到嘅區域」。本報告 `artifacts/audit-A4/analyze-assets.mjs` 就係佢嘅原型（可直接翻譯成 Python） |
| `generate_vector_basemap.py` | **⚠️ 存在但叫 `scripts/build_vector_basemap.py`** | **改名**（或新增同名薄 wrapper） | 功能完全對應（由 `data/private/cache/osm-hk.json` 產生 land/water/areas/roads-l0/roads-l1/labels/tiles）。改名只為符合 spec 嘅穩定 CLI contract。⚠️ 注意：**依賴 `data/private/cache/osm-hk.json`（182 MB，私有）→ 唔可以在冇私有快取嘅環境重跑** |
| `build_lod_assets.py` | **⚠️ 存在但係 `scripts/build_map_lods.py`（raster pyramid）** | **改名 + 重定義** | spec 嘅 LOD 應該係**向量 tile LOD**（即 `build_vector_basemap.py` 嘅 `tiles/` 部分），唔係 raster pyramid。建議：`build_lod_assets.py` 做向量 tile 分層（tile_deg / 道路 class 門檻 / 建築面積門檻），並**明確唔再產生 raster** |
| `render_hidpi_tiles.py` | **❌ 唔存在**（`render_binggang_map.py`、`render_hk_basemap.py`、`resolution_enhance.py` 都係 raster renderer） | **唔應該照做** | V2 走 vector，冇解像度概念，唔需要 HiDPI raster tiles。**建議改成 `verify_tile_assets.py`**（檢查 tile 量化一致性、覆蓋完整性、特徵數下限）。呢個係 spec 需要修正嘅地方，唔係實作需要補 |
| `verify_zoom_quality.py` | **❌ 唔存在** | **新寫** | 包 Playwright + §6 嘅像素斷言 + OCR，可重跑、非零 exit。`artifacts/audit-A4/zoom-quality-probe.mjs` 已提供全部量度邏輯 |
| `scripts/verify_assets.py`（spec §7.1 提及） | **❌ 唔存在** | **新寫** | §7.1 嘅 baseline command 清單引用咗但實際冇；需要一個總資產驗證（vector manifest / tile 完整性 / 死重偵測） |
| （額外）`scripts/audit_release.py` | ✅ 存在 | 保留 | 已喺 §7.1 清單 |
| （額外）`tests/phase-j-lod.test.ts` | ✅ 存在但**斷言有誤導性** | **必須更新** | `it("最窄圖磚跨度 ≥ 視窗最窄可能寬度")` 同 `it("每個圖磚都至少喺某個縮放級別可達")` 會 **pass**，但完全捕捉唔到「預設 zoom 中心冇任何 detail tier 覆蓋」同「pickTier 喺預設中心揀 overview → 18.12× 放大」。要加：「對每個可達 zoom 同每個 zone centroid，都要存在一個 tier 完全覆蓋該視窗」 |

---

### 8. 其他實測發現

| # | 發現 | 證據 | 級別 |
|---|---|---|---|
| F1 | `SvgMap.ts:975-978` 有**重複呼叫** `this.preloadFinerTier()`（同一段註解出現兩次）。因 `preloadedTiers` Set 去重，功能無害，但屬明顯手誤 | `SvgMap.ts:974-978` | P2 |
| F2 | `VectorBasemap.draw()` 喺 level 2 **只用 tile 道路**（`tileRoadPaths`），全域 `roads-l1` 完全唔畫。所以圖磚缺格／未載入時道路會**完全消失**（唔會退化到 l1） | `VectorBasemap.ts:783-784` | P1 |
| F3 | `ensureTiles()` 有 `if (keys.length > 16) return;`。實測 level 2 門檻（w ≤ 0.05）之下最壞情況**啱啱好 = 16 格**（±1 margin × 2 個 cell span），**零 headroom**。任何將來調整 `tile_deg` 或 level 門檻都會令圖磚靜默跳過 | `VectorBasemap.ts:554`；實測 16/16 | P2 |
| F4 | max zoom 時圖磚 payload **4.15 MB**（16 格），但實際只需 4 格覆蓋（1.41 MB）→ **2.9× 過度下載**。`tile_deg = 0.05` 對 max zoom（0.02°）太粗 | 實測 16 格 bytes 加總 = 4 347 394 B；4 格 = 1 483 423 B | P1 |
| F5 | Dark 主題下 max zoom **更平**（`flatRatio` 0.862 vs light 0.850；`meanGrad` 6.67 vs 9.12）→ 直接切去 dark（V2 方向）**唔會**解決稀疏感，反而加劇 | `artifacts/audit-A4/theme-probe.json` | P1（影響 V2 視覺決策） |
| F6 | `data/public/map-config.json` 仍然寫 `renderer:"svg"` / `basemap_png` / `lod_manifest`（全部過時）；`provisional_mode.banner` 寫「仍待人工審閱」→ **違反 AGENTS.md「零人手參與」規則嘅文案** | `data/public/map-config.json:3-7,40` | P1（文案／治理） |
| F7 | Localhost 之下圖磚回應 48–143 ms，**睇唔到 pop-in**；但 4.15 MB 喺真實網絡（GitHub Pages）必然產生明顯空白期 | `popin-probe.json`；`+150ms` 時 `flatRatio` 已 = 0.7237 | P1 |
| F8 | 現行 label 全部係 rank-3（7 570 個屋苑／公園名），冇街道名、冇地標名。max zoom 視窗只有 39–63 個 label | `label-probe.json`；`labels.json` byRank | P1 |

---

## 修改檔案

**冇。** 本審計嚴格只讀 production code / data / assets，只寫以下檔案：

```
docs/audits/map-rendering-audit.md                 ← 本報告
artifacts/audit-A4/analyze-assets.mjs              離線資產／LOD tier 分析
artifacts/audit-A4/asset-analysis.json
artifacts/audit-A4/asset-analysis.md
artifacts/audit-A4/zoom-quality-probe.mjs          Playwright zoom × DPR 像素分析 + raster 模擬
artifacts/audit-A4/zoom-probe.json
artifacts/audit-A4/flatness-probe.mjs              空區曲線
artifacts/audit-A4/flatness-curve.json
artifacts/audit-A4/density-probe.mjs               故事圖層密度掃章節
artifacts/audit-A4/density-probe.json
artifacts/audit-A4/drawcall-probe.mjs              canvas draw-call 攔截
artifacts/audit-A4/drawcall-probe.json
artifacts/audit-A4/label-probe.mjs                 精確 max-zoom label 量測
artifacts/audit-A4/label-probe.json
artifacts/audit-A4/viewport-density.mjs            視窗內容密度
artifacts/audit-A4/viewport-density.json
artifacts/audit-A4/tile-cap-check.mjs              圖磚 16 格上限檢查
artifacts/audit-A4/tile-cap-check.json
artifacts/audit-A4/popin-probe.mjs                 圖磚 pop-in
artifacts/audit-A4/popin-probe.json
artifacts/audit-A4/theme-probe.mjs                 light/dark 對比
artifacts/audit-A4/theme-probe.json
artifacts/audit-A4/shots/*.png                     12 張 zoom × DPR × theme 截圖
```

## 沒有修改但相關的檔案

| 檔案 | 行數 | 相關性 |
|---|---|---|
| `src/components/SvgMap.ts` | 1 646 | 主 renderer：`LOD_TIERS` / `MAX_SCALE` / `pickTier` / `fallbackToRaster` / `scaledView` / `render()` / `updateBasemapTier()` / `preloadFinerTier()` / `fallbackToRaster()` |
| `src/map/VectorBasemap.ts` | 935 | Canvas 底圖：`pickLevel` / `ensureLevelData` / `ensureTiles` / `draw` / `drawLabels` / `PALETTE_DARK|LIGHT` / `devicePixelRatio` 處理 / `TILE_CACHE_MAX` |
| `public/assets/vector/manifest.json` | — | 向量資產索引（quant / tile_deg / 圖層清單） |
| `public/assets/map-lod/manifest.json` | 421 行 | Raster LOD tier 定義（死重，但被 `SvgMap.ts` 靜態 import） |
| `data/public/map-config.json` | 48 行 | 過時配置 + 違規 banner 文案 |
| `scripts/build_vector_basemap.py` | 30 496 B | 向量資產產生器（依賴 `data/private/cache/osm-hk.json`） |
| `scripts/build_map_lods.py` | 16 248 B | Raster LOD pyramid 產生器（死重來源） |
| `tests/phase-j-lod.test.ts` | 14 596 B | LOD 斷言（有誤導性，需更新） |
| `tests/vector-basemap.test.ts` | 5 190 B | 向量資產完整性（Python↔TS 常數一致性） |
| `tests/visual-smoke.e2e.test.ts` | 24 938 B | 視覺煙霧測試（**冇** zoom crispness / DPR 斷言） |
| `vite.config.ts` | — | `emptyOutDir: false` → dist 累積舊 hash 檔（實測 dist/assets 有 45 個 `index-*.js` + 15 個 `index-*.css`） |

---

## 驗證命令與結果

```bash
# 全部喺 repo root 執行，preview server 已跑喺 http://localhost:5180/
node artifacts/audit-A4/analyze-assets.mjs        # ✅ 向量圖層 + LOD tier 表
node artifacts/audit-A4/zoom-quality-probe.mjs    # ✅ zoom × DPR 像素分析 + raster 模擬
node artifacts/audit-A4/flatness-probe.mjs        # ✅ 空區曲線
node artifacts/audit-A4/density-probe.mjs         # ✅ 故事圖層掃章節
node artifacts/audit-A4/drawcall-probe.mjs        # ✅ canvas draw-call 攔截
node artifacts/audit-A4/label-probe.mjs           # ✅ 精確 max-zoom label
node artifacts/audit-A4/viewport-density.mjs      # ✅ 視窗內容密度
node artifacts/audit-A4/tile-cap-check.mjs        # ✅ 圖磚 16 格上限
node artifacts/audit-A4/popin-probe.mjs           # ✅ 圖磚 pop-in
node artifacts/audit-A4/theme-probe.mjs           # ✅ light/dark 對比
```

關鍵實測輸出：

```
# zoom-quality-probe（DPR1）
initial  level0  backing 1060×752   ink 0.5204  edge 0.1081  meanGrad 10.25  colors 586
z4       level1  vb 0.2451          ink 0.8283  edge 0.2725  meanGrad 27.26  colors 785
z8       level1  vb 0.0858          ink 0.7715  edge 0.2239  meanGrad 22.94  colors 672
z12      level2  vb 0.0300          ink 0.7376  edge 0.1621  meanGrad 14.50  colors 567
z14-max  level2  vb 0.0200          ink 0.6980  edge 0.1016  meanGrad  9.12  colors 504
rasterSim hk-basemap 18.12×         edge 0.0000  meanGrad  0.54  colors  30   ← 若 fallback 觸發
rasterSim tko-campus-core 0.67×     edge 0.1670  meanGrad 15.27  colors 139   ← TKO 專用 tier 表現正常

# flatness-probe（ch1）
step 0  w=0.7000 flat=0.8456 meanGrad=10.25
step 4  w=0.2451 flat=0.6621 meanGrad=27.26   ← 峰值
step14  w=0.0200 flat=0.8502 meanGrad= 9.12   ← 最平

# label-probe（max zoom）
ch=1   level2 w=0.0200  canvas label draws 39 (39 unique)  SVG zone 1 / route 1 / loc 13 / ev 11
ch=150 level2 w=0.0200  canvas label draws 63 (63 unique)  SVG zone 13 / route 1 / loc 15 / ev 21

# viewport-density（max zoom 視窗）
default-center: 道路 196 / 建築 401 / tile-POI 48（畫 0）/ global label 33 / 故事層 0
tko          : 道路 180 / 建築 978 / tile-POI 53（畫 0）/ global label 71 / zone 19 / loc 72 / ev 176

# 故事圖層章節過濾（TKO max-zoom 視窗）
ch1   : event 176 在場 → 畫 0 | location 72 → 畫 3 | zone 19 → 畫 0
ch150 : event 176 在場 → 畫 1 | location 72 → 畫 0 | zone 19 → 畫 4
```

---

## Screenshots / Artifacts

| 檔案 | 內容 |
|---|---|
| `artifacts/audit-A4/shots/zoom-dpr1-initial.png` / `zoom-dpr2-initial.png` | 全港總覽（level 0），DPR1 / DPR2 |
| `artifacts/audit-A4/shots/zoom-dpr1-z4.png` / `zoom-dpr2-z4.png` | 0.245°（level 1，細節峰值） |
| `artifacts/audit-A4/shots/zoom-dpr1-z8.png` / `zoom-dpr2-z8.png` | 0.086°（level 1） |
| `artifacts/audit-A4/shots/zoom-dpr1-z12.png` / `zoom-dpr2-z12.png` | 0.030°（level 2，圖磚首次生效） |
| `artifacts/audit-A4/shots/zoom-dpr1-z14-max.png` / `zoom-dpr2-z14-max.png` | **最大 zoom 0.020°** —— 同 `artifacts/screenshots/baseline-zoom-desktop-step14-zoom.png` **像素級一致**（證實 baseline 描述「大片空區」係主觀描述，實際係低對比而非空白） |
| `artifacts/audit-A4/shots/maxzoom-theme-light.png` / `maxzoom-theme-dark.png` | 同一 max zoom 之下 light vs dark（dark 更平） |
| `artifacts/audit-A4/asset-analysis.json` / `.md` | 向量圖層統計 + LOD tier 縮放比表 + 圖磚覆蓋 |
| `artifacts/audit-A4/zoom-probe.json` | zoom × DPR 全指標 + raster 模擬 |
| `artifacts/audit-A4/flatness-curve.json` | 空區曲線（ch1 / ch150） |
| `artifacts/audit-A4/label-probe.json` | max zoom 實際畫出嘅 label 文字 + font |
| `artifacts/audit-A4/drawcall-probe.json` | canvas draw-call 統計 |
| `artifacts/audit-A4/viewport-density.json` | max zoom 視窗內容密度 |
| `artifacts/audit-A4/tile-cap-check.json` | 圖磚 16 格上限檢查 |
| `artifacts/audit-A4/popin-probe.json` | 圖磚回應時間 |
| `artifacts/audit-A4/theme-probe.json` | light/dark 對比 |
| `artifacts/audit-A4/density-probe.json` | 故事圖層掃章節 |

---

## 風險、衝突、限制

### 風險

| # | 風險 | 級別 | 說明 |
|---|---|---|---|
| R1 | **主代理可能照 spec §2.3 去「提升 raster 解像度」而浪費整輪資源** | P0 | Spec 問題定義係錯嘅。實測證明 raster 路徑 0 參與；投放資源喺 raster pyramid 只會增加 28 MB+ 而唔會改善任何使用者感知 |
| R2 | 刪 `map-lod/` 之前唔改 `SvgMap.ts` 會令 build 爆 | P0 | `lodManifest` 係**靜態 import**，`PROJ_COS` / `LOD_TIERS` 直接依賴佢。必須先 refactor |
| R3 | 直接切 dark 主題會令稀疏感惡化 | P1 | 實測 dark `flatRatio` 0.862 > light 0.850、`meanGrad` 6.67 < 9.12 |
| R4 | 圖磚 payload 4.15 MB／次 level-2 轉換，喺真實網絡有明顯空白期 | P1 | 現時 localhost 睇唔到（48–143 ms），會喺部署後暴露 |
| R5 | `tile_deg = 0.05` + 16 格上限 = 零 headroom | P2 | 任何門檻調整都會令圖磚靜默跳過（`ensureTiles` 直接 `return`，冇 warning） |
| R6 | 向量資產**唔可以在冇 `data/private/cache/osm-hk.json` 嘅環境重生成** | P1 | 182 MB 私有快取，唔可以 commit。CI / 新機器只能驗證現有資產，唔可以重建。B5 / B4 必須知道呢個限制 |
| R7 | 現行 label 體系冇街道名 | P1 | 7 570 / 7 847 個 label 都係屋苑／公園名（rank 3），max zoom 冇街道名可讀 |

### 衝突

| # | 衝突 | 涉及 | 建議裁決 |
|---|---|---|---|
| C1 | Spec §2.3 第 3 點要求「raster pyramid tiles（WebP/AVIF）」 vs §2.3 第 1 點「vector first，不可從低清 raster 放大」 | A4 / Gate 1 規格 | **採 vector first**。刪除 raster pyramid 要求。若真係要 atmosphere texture，用 procedural（canvas gradient + noise + grid）而唔係 bitmap |
| C2 | Spec §2.3 要求 `render_hidpi_tiles.py` vs vector 架構 | A4 / B5 | **唔做**。改為 `verify_tile_assets.py`。呢個係 spec 需要修正，唔係實作需要補 |
| C3 | `MAX_SCALE = 35`（現行）vs spec Z6–Z8 | A4 / B5 | 建議 `MAX_SCALE = 64`（令 Z6 可達），**明確放棄 Z7–Z8** 並喺 UI 顯示已達最詳盡層 |
| C4 | 現有 `tests/phase-j-lod.test.ts` 斷言 pass 但 policy 錯 | A4 / B9 / C3 | 必須更新測試，加「每個可達 zoom × 每個 zone centroid 都要有 tier 覆蓋」斷言 |
| C5 | `data/public/map-config.json` 過時 + 違反「零人手參與」文案 | A4 / A3 / B3 | 由主代理喺 Gate 1 決定：刪 `renderer` / `basemap_png` / `lod_manifest` 三個 key，改寫 `provisional_mode.banner` |

### 限制（本審計未能覆蓋嘅嘢）

| # | 限制 | 原因 |
|---|---|---|
| L1 | 冇量度真實網絡延遲下嘅 pop-in | 只可以喺 localhost 測；4.15 MB payload 已足夠推斷風險 |
| L2 | 冇做 OCR 實作（只設計咗斷言） | OCR 需要 `tesseract.js` / `tesseract` 二進位，唔想喺只讀審計階段引入依賴。設計已寫入 §6.2 Z8 |
| L3 | 冇量度 pan / zoom 嘅 frame rate | 屬 C6 Performance Auditor 範圍；本報告只量度靜態 render 指標 |
| L4 | 冇驗證 `areas.json` 嘅綠地／工業區分類準確性 | 屬 A5 Spatial Data Auditor 範圍 |
| L5 | 冇測試 390×844 mobile 之下嘅 max zoom 像素指標 | 已驗證 desktop；mobile 用同一 `pickLevel` / `draw` 邏輯，但 canvas 尺寸細 → `s` 由寬度限制，行為可能有別。建議 B9 補測 |
| L6 | 冇讀 `data/private/`（含 `osm-hk.json`） | 硬性禁止。所以「向量資產同 OSM 原始資料嘅完整性比對」未能做 |

---

## 給主代理的 integration note

### 1. Spec §2.3 必須改寫（最重要）

**§2.3 嘅問題定義係錯嘅。** 實測：raster 路徑 0 參與、DPR 正確、viewBox 冇拉伸、資產精度亞像素。**「最大 zoom 起格」唔存在。** 建議將 §2.3 改為：

> **2.3 地圖放大後內容稀疏、缺少細節（唔係 pixelation）**
> 問題定義：最大 zoom 時故事圖層同底圖細節**反向下降**，使用者感知為「冇嘢睇」。
> 三個實測成因：(a) 章節窗口過濾（±1～±3 章）令 zone / location / event 喺深 zoom 幾乎清空；(b) tile POI 已下載但未渲染；(c) 建築描繪對比度過低（alpha 0.16–0.42 / 0.35 px 描邊）。

同時 **§0.3 北極星第 2 點（「最大 zoom 唔起格、唔模糊」）實測已達成**，唔應該再列為待修項；應該將注意力移到第 3–4 點（territory system / dossier）。

### 2. 對 B5（Vector Map & LOD Renderer）嘅具體指示

**必做（P0）**
1. **章節過濾改成可調／可關**：現行 `SvgMap.render()` 嘅 `Math.abs(c - cur) <= 3`（location）同 `cur ± 1`（event）令深 zoom 幾乎清空。改為：預設「本章 ± 5 章」+ 一個「顯示全部事件」layer toggle（spec §2.4 已經要求 `事件` layer control）。
2. **渲染 tile POI**：喺 `VectorBasemap.drawLabels()` 加入 `this.tiles` 嘅 POI（rank 5），同 global labels 合併、去重、碰撞剔除。呢個係唯一嘅街道級地標來源（帝京酒店 / 朗豪坊 / 英華小學…）。
3. **提升建築對比**：light palette `bld` alpha 0.16–0.42 → 0.35–0.65；`bldEdge` 描邊 0.35 px → 0.7 px。dark palette 同樣處理（實測 dark 更平）。

**應做（P1）**
4. `pickLevel` 改用 Z 定義（`log2(0.70/w)`），門檻 `0.175 / 0.0219`。
5. `tile_deg` 0.05° → 0.02°（payload 4.15 MB → 約 1.0 MB）。
6. `MAX_SCALE` 35 → 64（Z6 可達）。
7. Level 2 道路要 fallback 到 `roads-l1`（當 tile 未載入／缺格時），避免道路完全消失。
8. 加 no-fake-zoom：低密度圖磚畫 procedural contour + 「此區未有細節資料」label。

**唔好做**
9. **唔好**再加 raster pyramid、HiDPI raster tiles、或提升 `hk-basemap.png` 解像度 —— 實測證明呢條路徑 0 參與。

### 3. 死重資產清理（需與 B5 同步，唔可以獨立做）

刪 `public/assets/map-lod/`（28 MB）、`hk-basemap.png`（1.9 MB）、`hk-basemap-labels.png`（132 KB）、4 個空目錄（`map-tiles/`、`markers/`、`ui/`、`generated/`）。
**前置 refactor（同一個 PR）**：`SvgMap.ts` 移除 `lodManifest` / `basemapPngUrl` / `labelDetailPngUrl` import，將 `PROJ_COS` 改常數、`BASEMAP_BBOX` inline，刪 `LOD_TIERS` / `pickTier` / `tierRect` / `tierSpan` / `updateBasemapTier` / `preloadFinerTier` / `fallbackToRaster` / `updateLabelLayerOpacity` / `#label-detail-layer`。否則 build 爆。
合計：**source −30 MB、dist −32 MB**。

### 4. 測試契約（交 B9）

- 新增 `tests/zoom-quality.e2e.test.ts`（或 `scripts/verify_zoom_quality.py`），斷言見 §6.2 十一項。**現時 Z7（`flatRatio ≤ 0.70`）、Z10 子項（`zone ≥ 6`）、Z11（tile payload ≤ 1.5 MB）會 FAIL** —— 正好作為 remediation 嘅驗收門檻。
- **更新 `tests/phase-j-lod.test.ts`**：現行兩個斷言（「最窄圖磚跨度 ≥ 視窗最窄寬度」、「每個圖磚至少喺某個縮放級別可達」）會 pass 但畀出假保證。要加「對每個可達 zoom × 每個 zone centroid，都要存在一個 tier 完全覆蓋該視窗」。
- 加 raster 回歸斷言：任何有 `href` 嘅 raster 按實際放大率渲染時 `meanGrad ≥ 4.0`（實測 `hk-basemap` 18.12× 之下 = 0.54）。

### 5. 需要主代理裁決嘅開放問題

1. **Z 層定義**：接受「Z = log2(0.70/view.w)」+ Z6 做最深？定係另訂？
2. **MAX_SCALE**：35 → 64？定係維持 35 並將 Z6 定義為 0.0219°？
3. **Raster fallback 係唔係要保留？** 建議完全刪除（用 procedural pattern 取代「好過一片黑」嘅 fallback）。若保留，轉 WebP 並只保留一份。
4. **`map-config.json` 嘅 `renderer` / `basemap_png` / `lod_manifest` 三個 key** 要唔要喺 Gate 1 直接刪？
5. **`provisional_mode.banner` 文案**（「仍待人工審閱」）違反 AGENTS.md 零人手規則，需要改寫 —— 但呢個 key 係 data 檔，屬 B3/B4 範圍，請派發。

### 6. 分級總結

| 級別 | 數量 | 項目 |
|---|---|---|
| **P0** | **3** | (1) Spec §2.3 問題定義錯置 —— 需改寫 §2.3 同 §0.3 第 2 點；(2) 章節過濾令深 zoom 故事圖層清空（TKO 176 event → 畫 0）；(3) tile POI 已下載但 0 渲染 |
| **P1** | **7** | 建築對比過低（light + dark 都低）；level 2 道路無 fallback 到 l1；tile payload 4.15 MB（2.9× 過度下載）；label 體系冇街道名；`map-config.json` 過時 + 違規文案；dark 主題令稀疏感惡化；死重資產 30 MB 需先 refactor 才可刪 |
| **P2** | **4** | `preloadFinerTier()` 重複呼叫；`ensureTiles` 16 格零 headroom；`emptyOutDir:false` 令 dist 累積 **45 個 `index-*.js` + 15 個 `index-*.css`（合共 60 個舊 hash 檔）**；`tests/phase-j-lod.test.ts` 斷言誤導 |

---

*本報告所有數據由 `artifacts/audit-A4/` 之下嘅 10 個可重跑腳本產生；preview server = `http://localhost:5180/`，Playwright 1.62.1，Chromium headless + `--no-proxy-server`。*

# B5 — Vector Map & LOD Renderer 交付報告（收尾）

> 子代理：**B5 Vector Map & LOD Renderer（收尾）**｜Branch：`refactor/world-atlas-v2`
> 交付日期：2026-09-22
> 介面契約（**先寫，後實作**）：`docs/contracts/b5-interface-contract.md`（本 pass 嘅規格）
> 主要規格：`docs/specs/world-atlas-v2-rendering-lod-strategy.md`
> 依據審計：`docs/audits/map-rendering-audit.md`（A4）、`docs/audits/data-performance-audit.md`（A8 §6.3）
> 前情：上一個 B5 代理已完成大部分實作，但因 API 額度中斷而**未寫交付報告**。
> 本 pass 嘅任務係「**核實 → 補量度 → 寫報告 → 修明顯缺陷**」，**唔係**重寫 renderer。

---

## 任務摘要

| 工作 | 結果 |
|---|---|
| 核實已有實作 | ✅ 6 個 `src/map/*.ts` ＋ `SvgMap.ts` ＋ 2 個新測試檔**全部真實存在且已接線**（唔止係註解） |
| 重跑基線 | ✅ `typecheck` 0 error／`lint` 0 error／`test` **19 files / 298 tests 全綠**／`build` **36 modules** |
| 補跑冷 zoom 阻塞量度 | ✅ 已跑（A8 同款協定，3 次全新頁取中位）—— **合計未達標，如實記錄** |
| 補跑 pan fps 量度 | ✅ 已跑（6 次試行取中位）—— **中位 54.35 fps，差 1.2% 未達標** |
| 補跑 max zoom 內容計數 | ✅ zone 0→9、event 0→53（顯示全部）、tile POI 0→538 —— **達標** |
| 補跑建築對比量度 | ✅ alpha 0.35–0.65、邊寬 0.7 px、實測 `meanGrad` 9.12→12.27 —— **達標** |
| 修明顯缺陷 | ✅ 2 處低風險微優化（見「發現／改動」），令 pan 中位 fps 51.05→54.35、p95 frame 25.05→16.8 ms |
| 交付報告 | ✅ 本檔 |

**一句話**：三個 root cause（A4 G1/G2/G3）＋ 冷 zoom 阻塞（A8 P0-1）**已實質修好**；
冷 zoom **合計**阻塞同 pan fps **兩項未完全達標**，成因同剩餘工作量喺下面如實交代。

---

## 假設與證據

### 假設

1. **契約係唯一規格**：`docs/contracts/b5-interface-contract.md` 為準；舊 renderer **唔係**優先真相（anti-stagnation）。
2. **唔信註解，只信行為**：核實方法係「讀實作 → 跑測試 → 跑 e2e 量度」，唔會因為檔案有 196 行就當做完。
3. **量度協定要同 baseline 一致**：冷 zoom 同 pan 都用 **A8 `measure-jank.mjs` 完全一樣嘅協定**（in-page `dispatchEvent`、20 次 `#map-zoom-in`、`longtask` PerformanceObserver），否則前後對比無意義。
4. **單次量度唔可靠**：實測同一協定嘅 pan fps 可以由 12.1 跳到 57.3 fps（headless Chromium 嘅 GC／raster 時機）。所以**所有 fps 數字都係多次試行嘅中位數**，並附每次數字。
5. **未達標就寫未達標**：唔會用「大幅改善」蓋過「未達標」。

### 證據（核實：實作真係做咗）

| 契約要求 | 核實位置 | 狀態 |
|---|---|---|
| Z 定義 / tier / zoneLod / basemap level / label rank / tile POI / 建築 alpha / no-fake-zoom / 章節窗口 | `src/map/map-lod.ts:43-196` | ✅ 全部係真函數，`tests/map-lod.test.ts` 51 條斷言 |
| 投影 / clamp / scale / pxToUserUnits / flyTo / softFocus / easeInOutCubic | `src/map/map-camera.ts:59-309` | ✅ 純函數，`SvgMap` 已 delegate（`SvgMap.ts:34-42`） |
| **rAF coalesce**（每 frame 最多一次 `onChange`；手勢結束 flush） | `src/map/MapViewport.ts:174-205` | ✅ `queue()` 累積 + `flush()`；`settle()` 強制 flush |
| 增量 `Path2D`（O(tiles) 而唔係 O(tiles²)） | `src/map/BaseGeometryLayer.ts:258-319` | ✅ 逐格 `Path2D` + `addPath()` 聚合，`aggregateDirty` 才重拼 |
| Layer 註冊介面（B6 插入點） | `src/map/MapShell.ts:63-248` | ✅ `register` / `registerRenderer` / `update(ctx, patch)` / `priority` z-order |
| tile POI 終於渲染（A4 G2） | `src/map/VectorBasemap.ts:601-698` | ✅ `includesTilePoi(tier)` → 併入 `poiOrder`，同名去重 + 空間網格碰撞 |
| no-fake-zoom（Q11） | `VectorBasemap.ts:524-525, 712-731` ＋ `BaseGeometryLayer.ts:445-492` | ✅ `data-detail-state` + 程序化等距線 + 「此區未有細節資料」 |
| `MAX_SCALE` 35→64 | `SvgMap.ts:184` | ✅ `const MAX_SCALE = 64` |
| 章節 gate 移除（規則 L1：zone 永遠 render） | `SvgMap.ts:1307-1337` | ✅ zone **冇**章節過濾；章節只影響 `emphasized`（opacity） |
| Zone LOD 三層 | `SvgMap.ts:1170, 1337-1435` | ✅ `data-zone-lod`；cluster 唔畫 glow／pulse、badge 加大 |
| 章節窗口 location ±5 / event ±1 + 「顯示全部」 | `SvgMap.ts:1171-1172, 1206-1215, 811-816` | ✅ `#map-show-all-events` 有 `aria-pressed` |
| raster 靜態 import 移除（規則 A1/A3） | `SvgMap.ts:87-102`（只有 runtime 字串） | ✅ `#basemap-group` **冇預設 `href`** |
| 建築對比 alpha 正規化 | `BaseGeometryLayer.ts:176-183` | ✅ `buildingFills()` → `BUILDING_ALPHA_RANGE` |
| 建築描邊 0.7 px | `BaseGeometryLayer.ts:399` | ✅ `BUILDING_EDGE_WIDTH_PX` |

---

## 發現／改動

### 發現 1（未達標）：冷 zoom **合計**主線程阻塞仍係 842 ms（目標 ≤300 ms）

- 用 A8 同款協定（全新頁 → `#map-reset` → 20× `#map-zoom-in`、60 ms 間隔 → 等 3 s）跑 3 次：
  合計 **734 / 842 / 1000 ms**（中位 **842 ms**）、最長 **166 / 182 / 198 ms**（中位 **182 ms**）、fps **23.8 / 25.3 / 25.5**（中位 **25.3**）。
- 對比 A8 baseline（20 個 longtask／21,241 ms／最長 4,650 ms／1.8 fps）：**合計 −96.0%、最長 −96.1%、fps ×14**。
- **如實記錄**：若目標係「單一 longtask ≤300 ms」→ **達標（182 ms）**；若目標係「合計 longtask ≤300 ms」→ **未達標（842 ms）**。
- **成因分析（有證據）**：CDP `Performance.getMetrics` 增量（中位）＝ `ScriptDuration` **0.195 s**、`LayoutDuration` **0.091 s**、`RecalcStyleDuration` **0.049 s`（合共 0.335 s）。longtask 合計 0.842 s 減去呢 0.335 s ≈ **0.5 s 係 raster／paint**（CDP 呢三個 metric 唔包含）。逐個 longtask 睇（`artifacts/b5/cold-zoom-robust.json`）：20 次縮放產生 **6–7 個 50–78 ms 嘅重繪任務**，加 **2–3 個 150–198 ms 嘅重任務**（推斷為 `roads-l1.json` 1.34 MB 切層 + 圖磚載入 + 首次全量 canvas/SVG 重繪）。即係**剩餘成本係「20 次全量重繪」本身**，唔再係 A8 嘅 O(tiles²) 病態。
- **為何唔喺本 pass 修**：唯一可以再大幅壓低嘅方法係 (a) 將 tile 解析／`decodeDelta` 移入 web worker（**契約禁止新依賴**），或 (b) 令 `zoomBy` 改成 rAF coalesce（會改動 `#map-zoom-in` 嘅同步語意，**兩個既有 e2e 直接依賴逐下即時更新 viewBox**，風險高而唔喺 B5 驗收範圍）。列為 **deferred**。

### 發現 2（未達標）：pan 中位 fps 54.35（目標 ≥55）

- level 2 街道層、1440×900、DPR 1、in-page 派發 50 步 `mousemove`（A8 同款），1 次暖身 + 6 次正式，取中位。
- 環境上限校準：**level 0 idle = 60.0 fps**（所以 60 係可達上限）。
- 優化**後**：中位 **54.35**、平均 54.8、範圍 51.3–57.2、p95 frame **16.8 ms**、**0 longtask**。
- **如實記錄**：中位 54.35 < 55 → **未達標（差 1.2%）**。但 p95 frame = 16.8 ms 代表 **≥95% 嘅 frame 係 60 fps**，個別長 frame（GC／raster）拉低平均；**0 個 longtask** 代表冇主線程阻塞。
- 對比 baseline（A8：28.9–30.9 fps、p95 66.7 ms、34 longtask）：**中位 +76%、p95 frame −74.8%、longtask 34→0**。

### 發現 3（已修）：兩個每幀重複寫 DOM 嘅熱點

`onChange` 每幀呼叫，但兩個方法都係**寫同一個值**：

1. `suspendZonePulses()` → `applyZonePulseState()` 每幀 `querySelectorAll` ＋ 對 21 個 `.zone-pulse` 寫 `display="none"`。
2. `updateLabelLayerOpacity()` 每幀對 `#label-detail-layer` 寫同一個 `opacity`。

**改動**：兩者都加「值冇變就跳過」守衛（同 `applyLiveScale()` 嘅 D-12 快取同一 pattern）。
實測效果：pan 中位 **51.05 → 54.35 fps**、p95 frame **25.05 → 16.8 ms**；longtask 兩者都係 0。
（單次量度變異大，所以保守講：**p95 frame 改善最明顯、可重現**；中位 fps 改善約 +3。）

### 發現 4（新，非本 pass 驗收項）：max zoom **idle** fps 只有 20.1

喺將軍澳 max zoom 靜止時量 idle fps：

| 情境 | `.zone-pulse` 數 | idle fps |
|---|---|---|
| level 0（全港，cluster LOD） | 0 | **60.0** |
| level 2（街道層，full LOD） | 21 | **20.1** |
| level 2，`.zone-pulse` 設 `display:none` | 21 | **60.0** |
| level 2，`.zone-pulse` 由 DOM 移除 | 0 | **59.6** |

→ 21 個病窩掃描光環（同時動 `opacity` + `transform: scale()`，`transform-box: fill-box`）**單獨**令 idle 由 60 跌到 20 fps。
手勢期間 B5 已經暫停（D-11），所以 pan 唔受影響；但**靜止時**會。呢個唔喺本 pass 驗收清單，而且 `.zone-pulse` 嘅 keyframes 喺 `main.css`（**B1 獨佔，B5 唔可以改**），所以**只報告、唔擅自改視覺**（見「風險」）。

### 發現 5（環境）：`vite build` 嘅 `emptyOutDir` 被 safe-delete shim 攔截

`npm run build` 第一次跑會 fail：

```
[vite:prepare-out-dir] [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":423,"threshold":50,...}
```

`vite.config.ts` 嘅 `emptyOutDir: true` 會對 `dist/assets` 做一次 bulk `rmSync`（>50 檔）→ 被環境 shim 攔截。
**繞過方法（唔改任何設定檔）**：build 之前先跑 `node -e "fs.rmSync('dist',{recursive:true,force:true})"`（會觸發一次 escalation 批准），清空之後 `vite build` 就冇嘢要 bulk delete。
⚠️ 若 `vite preview` 仲開住 `dist/`，Windows 檔案鎖會令刪除失敗 → **先停 preview，再清，再 build，再開 preview**。

---

## 修改檔案

| 檔案 | 改動 | 理由 |
|---|---|---|
| `src/components/SvgMap.ts` | ① `suspendZonePulses()` 加狀態轉變守衛（只在 `pulsesSuspended` 由 false→true／true→false 時寫 DOM）；② 新增 `lastLabelOpacity` 欄位，`updateLabelLayerOpacity()` 加值快取 | 發現 3：兩個每幀重複寫同值嘅熱點。兩者都係**行為等價**嘅純優化（輸出值不變），對應 D-12 已建立嘅 pattern |
| `docs/progress/b5-renderer-delivery.md` | 新增（本檔） | 主要交付 |
| `artifacts/b5/**` | 新增量度腳本 + JSON + 截圖 | 量度證據 |

**冇改任何其他 source**。特別係：**冇改** `src/map/*.ts` 嘅任何一行（核實後確認已完成）、**冇改** 任何測試檔（兩個新測試檔已存在且全綠）。

---

## 沒有修改但相關的檔案

| 檔案 | 為何相關 / 為何唔改 |
|---|---|
| `src/map/map-lod.ts`、`map-camera.ts`、`MapViewport.ts`、`BaseGeometryLayer.ts`、`MapShell.ts`、`VectorBasemap.ts` | 上一個 B5 代理已實作；本 pass **核實**後確認功能完整、測試覆蓋足夠，**冇需要改** |
| `tests/map-lod.test.ts`（51 tests）、`tests/map-render.test.ts` | 已存在且全綠；本 pass **冇加／改** 斷言 |
| `public/assets/vector/**`、`public/assets/map-lod/**`、`hk-basemap*.png` | **硬性禁止**改／刪。`tile_deg` 0.05→0.02 需重生成資產（生成器依賴 `data/private/`）→ deferred；物理刪除留 **Gate 2** |
| `src/styles/main.css`（B1） | `.zone-pulse` keyframes 喺呢度；發現 4 嘅成因，但**唔喺 B5 可寫範圍** |
| `vite.config.ts`（B3） | `emptyOutDir: true` 引發發現 5；**唔喺 B5 可寫範圍**，改用繞過方法 |
| `src/components/` 其餘檔案、`ZoneLayer.ts` 等 B6 檔案 | B6 擁有；本 pass 只提供 `MapShell` 介面 |
| `data/**`、`scripts/**`、`src/state/**`、`src/ui/**`、`src/data/**` | 硬性禁止 |

---

## 驗證命令與結果

```bash
npm run typecheck   # ✅ 0 error
npm run lint        # ✅ 0 error
npm run test        # ✅ 19 files / 298 tests 全綠（baseline 一致）
npm run build       # ✅ 36 modules；輸出只有 index.css + index.js（冇 emit hk-basemap*.png）
```

量度（`npx vite preview --port 5180`，`http://localhost:5180/`，Playwright + `--no-proxy-server`）：

```bash
node artifacts/b5/measure-cold-robust.mjs   # 冷 zoom（3 次全新頁）
node artifacts/b5/measure-pan-robust.mjs    # pan fps（1 暖身 + 6 次）
node artifacts/b5/measure-render.mjs        # 內容計數 / label / 建築對比
node artifacts/b5/probe-idle-fps.mjs        # idle fps（.zone-pulse 成本）
node artifacts/b5/probe-pan-breakdown.mjs   # pan 成本拆解
node artifacts/b5/measure-pan-detail.mjs    # pan 首輪量度（保留作對照）
```

### ① 冷 zoom 阻塞前後對比（A8 同款協定；3 次中位）

| 指標 | A8 baseline | B5 收尾 | 目標 | 判定 |
|---|---|---|---|---|
| longtask 數 | 20 | **8**（7/9/10） | — | — |
| **合計阻塞** | **21,241 ms** | **842 ms**（734/842/1000） | ≤300 ms | ❌ **未達標** |
| **最長單一** | **4,650 ms** | **182 ms**（166/182/198） | ≤300 ms | ✅ 達標 |
| fps | 1.8 | **25.3**（23.8/25.3/25.5） | — | — |

CDP 拆解（中位）：`ScriptDuration` 0.195 s、`LayoutDuration` 0.091 s、`RecalcStyleDuration` 0.049 s。
改善：合計 **−96.0%**、最長 **−96.1%**、fps **×14**。

### ② pan fps 前後對比（level 2；環境上限 60 fps）

| 指標 | A8 baseline | 優化前 | 優化後 | 目標 | 判定 |
|---|---|---|---|---|---|
| 中位 fps | 28.9–30.9 | 51.05 | **54.35** | ≥55 | ❌ 差 1.2% |
| 平均 fps | — | 51.3 | **54.8** | — | — |
| 範圍 | — | 49.3–53.6 | 51.3–57.2 | — | — |
| p95 frame | 66.7 ms | 25.05 ms | **16.8 ms** | — | ✅（≥95% frame = 60 fps） |
| longtask | 34 | 0 | **0** | — | ✅ |

### ③ max zoom 內容計數前後（將軍澳、viewW 0.0109°、level 2）

| 內容 | baseline（A4） | B5 收尾 | 目標 | 判定 |
|---|---|---|---|---|
| zone（相交視窗） | **0** | **9** | ≥3 | ✅ |
| zone（全圖 render） | 1 | **48** | 永遠 render（規則 L1） | ✅ |
| event（預設窗口） | **0** | 1 | — | — |
| event（顯示全部） | **0** | **53** | ≥5 | ✅ |
| location（相交視窗） | 3 | 2 | — | ≈ 持平（標記聚合所致） |
| zone label | 0 | **48** | — | — |
| tile POI（canvas） | **0** | **538** | >0 | ✅ |
| `data-detail-state` | — | `ok` | 密集區唔可以 `sparse` | ✅ |

### ④ 建築對比前後

| 指標 | baseline | B5 收尾 | 目標 | 判定 |
|---|---|---|---|---|
| light `bld` alpha | 0.16–0.42 | **0.35–0.65** | 0.35–0.65 | ✅ |
| dark `bld` alpha | 0.14–0.40 | **0.35–0.65** | 0.35–0.65 | ✅ |
| `bldEdge` 描邊 | 0.35 px | **0.7 px** | 0.7 px | ✅ |
| 實測 `meanGrad` | 9.12 | **12.27** | 提升 | ✅ **+34.5%** |

### ⑤ Label 數（tile POI 渲染前後）

| | level 1（regional） | level 2（detail） |
|---|---|---|
| `data-tile-poi` | **0** | **538** |

### ⑥ Idle fps（發現 4，非驗收項）

| 情境 | fps |
|---|---|
| level 0（0 pulse） | 60.0 |
| level 2（21 pulse） | **20.1** |
| level 2（pulse `display:none`） | 60.0 |
| level 2（pulse 移除） | 59.6 |

---

## Screenshots / Artifacts

截圖（`artifacts/b5/screenshots/`）：

| 檔案 | 內容 |
|---|---|
| `cold-zoom-after.png` | 冷 zoom 20 次之後（level 2） |
| `max-zoom-tko.png` | 將軍澳 max zoom（level 2） |
| `content-max-zoom.png` | max zoom + 「顯示全部事件」開啟 |
| `pan-after.png` | pan 手勢之後 |

量度 JSON（`artifacts/b5/`）：

| 檔案 | 內容 |
|---|---|
| `cold-zoom-robust.json` | 冷 zoom 3 次 + CDP 拆解 |
| `cold-zoom.json` | 冷 zoom 首輪（`measure-render.mjs` 內） |
| `pan-robust.json` | pan fps 6 次 + 中位 |
| `pan-fps-detail.json`、`pan-fps.json`、`pan-breakdown.json` | pan 首輪 / 拆解 / 對照 |
| `idle-fps.json` | idle fps（`.zone-pulse` 成本） |
| `content-counts.json` | max zoom 內容計數 |
| `label-counts.json` | tile POI 前後 |
| `building-contrast.json` | 建築對比 |

> ⚠️ 所有量度都係**程式化**（Playwright + CDP + PerformanceObserver），**零人手目測**（spec §7 規則 Q1）。

---

## 風險、衝突、限制

1. **冷 zoom 合計阻塞 842 ms 未達 300 ms**（最長單一 182 ms 已達標）。
   剩餘成本係「20 次全量重繪」＋ 1.34 MB `roads-l1.json` 切層，唔再係 O(tiles²)。
   要再壓低必須 (a) web worker（**禁止新依賴**）或 (b) 改 `#map-zoom-in` 語意（**兩個既有 e2e 依賴**）。**建議由主代理決定**。
2. **pan 中位 54.35 fps < 55**（差 1.2%）。p95 frame 16.8 ms、0 longtask，實際觀感係 60 fps 為主。headless software raster 可能比真 GPU 環境低 5–15%，所以**真機好可能已達標**——但**本 pass 只報量到嘅數字**。
3. **max zoom idle fps 20.1**（發現 4）：成因係 `.zone-pulse` CSS 動畫，喺 `main.css`（**B1 獨佔**）。B5 唔可以改 keyframes，亦唔應該為咗效能擅自刪走 spec §3.2 full LOD 嘅病窩光環。**建議 B1／主代理評估**（例如改用 `opacity` 單屬性動畫，或 `will-change`／降低更新頻率）。
4. **`vite build` 需要先清 `dist/`**（發現 5）：環境 safe-delete shim 攔截 `emptyOutDir` 嘅 bulk delete。本 pass 用 `node fs.rmSync('dist')` 繞過（已觸發 escalation 批准）。**唔係 code 問題**，但 CI／其他機要知。
5. **`dist/assets/hk-basemap*.png`、`dist/assets/map-lod/` 仍然存在**：由 `public/` 直接複製，**唔係 Vite emit**（`build` 輸出只有 `index.css` + `index.js`）。物理刪除留 **Gate 2**。
6. **單次 fps 量度變異大**（12.1–57.3 fps）：所有 fps 都係多次試行中位數，逐次數字已寫入 JSON 供覆核。呢個係 headless 環境限制，唔係 renderer 唔穩定。

---

## 給主代理的 integration note

1. **B5 實作係真嘅、已接線、測試全綠**：`src/map/{map-lod,map-camera,MapViewport,BaseGeometryLayer,MapShell,VectorBasemap}.ts` 全部有實作 + 呼叫；`SvgMap.ts` 已 delegate 投影／相機、`MAX_SCALE=64`、zone 永遠 render + Zone LOD、章節窗口 ±5/±1、`#map-show-all-events`、raster 只剩 emergency。
2. **B6 插入點已就緒**：`MapShell.register(layer)` / `registerRenderer(id, priority, render)`，`LayerContext` 已算好 `tier` / `zoneLod` / `chapterWindow`。`ZoneLayer.priority` 必須 > `EventLayer.priority`（zone 喺 event 之上）。**B6 只需新增自己嘅檔案**。
3. **本 pass 只改咗 `SvgMap.ts` 兩處**（`suspendZonePulses` 守衛、`updateLabelLayerOpacity` 快取），**行為等價**、**298 測試全綠**。冇改 `src/map/**` 一行。
4. **未達標兩項（如實）**：① 冷 zoom 合計 842 ms（最長 182 ms 已達標）；② pan 中位 54.35 fps（p95 frame 16.8 ms、0 longtask）。兩者成因同限制已列喺「風險」。
5. **Deferred 清單**：
   - `tile_deg` 0.05° → 0.02°（Q9 max zoom tile payload ≤1.0 MB 唯一修法）—— 需重生成 `public/assets/vector/tiles/*`，生成器依賴 `data/private/cache/osm-hk.json`（**禁止讀取**）。
   - 資產物理刪除（`public/assets/map-lod/` 13 層 raster、`hk-basemap*.png`）→ **Gate 2**。
   - 冷 zoom 合計 ≤300 ms（需 worker 或改 zoom 語意）。
   - max zoom idle fps 20.1（`.zone-pulse` CSS，屬 B1）。
6. **Gate 2 提醒**：`dist/assets/` 仍會出現 `hk-basemap*.png` 同 `map-lod/`（由 `public/` 複製）；`build` 本身**已經**唔再 emit 佢哋。刪 `public/` 嗰邊嘅資產時，記得同步清 `dist/`。

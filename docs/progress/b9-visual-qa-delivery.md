# B9 — Visual QA Automation 交付報告

> 子代理：**B9 Visual QA Automation（收尾）**｜Branch：`refactor/world-atlas-v2`
> 交付日期：2026-09-23
> 介面契約：`docs/contracts/b9-interface-contract.md`
> 主要規格：`docs/specs/world-atlas-v2-rendering-lod-strategy.md` §6／§7（Q1–Q11）
> 驗收矩陣：`docs/specs/world-atlas-v2-acceptance-matrix.md` §2（#11/#12/#13）、§7（C1–C8）
> 前情：實作代理已完成全部實作與量測，但喺寫報告前因 API 額度中斷；本 pass 任務係
> 「**核實產出 → 讀量測 JSON → 寫報告**」，**唔係**重跑量測、**唔係**改 code。
> 硬規則：**零人手參與**（`AGENTS.md`）—— 所有驗收程式化、可重跑；報告「下一步」只可以係
> 「擴充自動驗證規則／加語義約束」，**唔可以**寫「人手覆核／人手目測」。

---

## 0. 一句話總結

B9 將 spec §7 嘅 Q1–Q11 由「文件上嘅期望」變成**可重跑嘅程式斷言**（Node/Playwright 量 →
Python cv2/numpy 判），並交付咗驗收矩陣 **#11 / #12 / #13** 三條 e2e 同兩支診斷腳本。
現況 **7 pass / 3 fail / 1 needs_review / 0 not_measured**：設計上必然成立嘅（無 raster、無 seam、
label 可讀、tile payload、no-fake-zoom 狀態）**全部 PASS**；有實質 gap 嘅（Q3/Q4 深 zoom 內容密度、
Q10 冷 zoom 合計阻塞）**如實 FAIL，冇為咗全綠而放寬閾值**；Q1 嘅 Z8 target 因 `MAX_SCALE=64` **物理上不可達**，
標 `needs_review` 交主代理做 spec 決策。呢套產出係 **C3（Zoom/Render QA）嘅直接輸入**（C3 通過條件 = Q1–Q11 PASS），
同時為 **C5（Data Governance Auditor，§2-12）**、**C2（Visual Quality Critic，before/after evidence）** 提供程式化證據。

---

## 1. 交付檔案清單

| 類別 | 路徑 | 用途 | 大小 |
|---|---|---|---|
| 判定腳本 | `scripts/verify_zoom_quality.py` | 讀 raw JSON + PNG → cv2 分析 → Q1–Q11 判定 → report JSON；可獨立重跑 | 27,772 B |
| 診斷腳本 | `scripts/diagnose_map_resolution.py` | 讀 report → 根因假設 + spec 條文 + owner（唔止 pass/fail） | 17,609 B |
| QA 工具庫 | `tests/qa/harness.ts` | Playwright 量測庫（開瀏覽器、zoom、pan、截圖、DOM/像素/網絡量度） | 15,035 B |
| QA 工具庫 | `tests/qa/probes.ts` | 注入瀏覽器嘅 init script 源碼 + 型別（純字串，零 import） | 3,842 B |
| 新 e2e | `tests/local-only-network.e2e.test.ts` | 驗收矩陣 **#11**：完整旅程零外部請求 | 4,200 B |
| 新 e2e | `tests/public-data-safety.e2e.test.ts` | 驗收矩陣 **#12**：public 資料紅線掃描（純靜態，唔開瀏覽器） | 6,223 B |
| 新 e2e | `tests/zoom-quality.e2e.test.ts` | **#13**：Q1–Q11 量測編排 → `zoom-quality-raw.json` | 14,443 B |
| 契約 | `docs/contracts/b9-interface-contract.md` | B9 介面契約（先寫後實作） | 13,302 B |
| 量測輸出 | `artifacts/b9-qa/zoom-quality-report.json` | **Q1–Q11 逐項結果**（判定嘅權威來源） | 9 KB |
| 量測輸出 | `artifacts/b9-qa/zoom-quality-raw.json` | 原始量測（13 level × DPR × anchor + tiles + coldZoom + noDetail） | 727 KB |
| 量測輸出 | `artifacts/b9-qa/map-resolution-diagnosis.json` | 根因診斷（5 個 rootCause + 4 個 nextCheck） | 12 KB |
| 量測輸出 | `artifacts/b9-qa/screenshots/` | 18 張截圖（14 張 `zoom-*` + 4 張 `canvas-*`） | — |
| 閘門日誌 | `artifacts/b9-qa/run-*.log` | vitest／pytest／build／validate／audit／e2e／zoom 七份日誌 | — |
| 交付報告 | `docs/progress/b9-visual-qa-delivery.md` | 本檔 | — |

> **規則 B9-3**：`artifacts/b9-qa/` 係唯一輸出目錄（已由 vitest／eslint 排除），唔會污染 `src/**`、`tests/**`（既有檔）、`data/**`。

---

## 2. Q1–Q11 逐項結果

### 2.1 總表

| # | 斷言（spec §7） | 狀態 | 關鍵實測值 | 判定閾值 |
|---|---|---|---|---|
| Q1 | 各 target zoom（Z0/Z2/Z4/Z6/Z8）× DPR 1/2 截圖存在且尺寸正確 | ⚠️ **needs_review** | 可達 `[0,2,4,6]`、不可達 `[8]`；`missing=[]`、`sizeBad=[]`、`dprMismatch=[]` | 全部 target × DPR 存在；DPR2 = 2×DPR1 |
| Q2 | 無 raster upscale：`<image href>`/`<img>` = 0；backing = CSS×DPR | ✅ **pass** | `offenders=[]`、`levelsChecked=13`；13/13 level `imagesWithHref=0`、`imgs=0` | 0 raster 元素；backing 誤差 ≤2px |
| Q3 | `flatRatio` 單調性：深 zoom 唔可以比 Z0 更平 | ❌ **fail** | center `0.8521→0.9549`（Δ **+0.1028**）；tko `0.8521→0.8088`（Δ −0.0433） | `flat(max) ≤ flat(Z0)+0.002` |
| Q4 | `meanGrad` 深 zoom 唔可以低過中段 50% | ❌ **fail** | center `midPeak 23.28 / deep 2.54 / floor 11.64 / ratio 0.109`；tko `20.14 / 12.54 / 10.07 / 0.623` | `meanGrad(max) ≥ 0.5×max(meanGrad(mid))` |
| Q5 | 最大 zoom 視窗內 zone 數 ≥ 3（將軍澳） | ✅ **pass** | `zonesInView=9`、`zoneLabelBoxes=48` | ≥ 3 |
| Q6 | 最大 zoom 視窗內 event 數 ≥ 5（「顯示全部事件」後） | ✅ **pass** | `eventsAll=101`、`eventsWindowed=1`、`ariaPressed="true"` | ≥ 5 且 > 窗口值 |
| Q7 | Label crispness（**替代 OCR**） | ✅ **pass** | 低於 9px label `0` 個；DOM 可見 label `55/55`（passRatio **1.0**）；銳利度 `2.21 / 10.94 / 5.67` | 0 個 <9.0px；DOM ≥80% h≥7 w≥8；銳利度 ≥1.5 |
| Q8 | 無 tile seam | ✅ **pass** | center Z0 `col 0.207 / row 0.233`；center Z6 `0.133 / 0.094`；tko Z6 `0.224 / 0.175` | 任何欄／行硬邊佔比 < 0.5 |
| Q9 | Tile payload ≤ 1.0 MB（單一 tile） | ✅ **pass** | 網絡單格最大 `297,739 B`；manifest 單格最大 `803,470 B`（tile `4,7`）；84 格合計 `9,285,855 B` | ≤ 1,048,576 B |
| Q10 | 冷 zoom 主線程阻塞 ≤ 300 ms | ❌ **fail** | 合計 **525 ms**（raw 最新 **538 ms**）；最長單一 `160 ms`（raw 161）；`longTaskCount=6`；`fps=5` | 合計 ≤300 ms **且** 最長單一 ≤300 ms |
| Q11 | 「此區未有細節資料」狀態存在（低密度區） | ✅ **pass** | 常數 `此區未有細節資料`；`sparseState="sparse"`、`denseState="ok"`、`textDrawnInSparse=true` | 稀疏區 `sparse`、密集區 `ok`、狀態文字真係畫過 |

> 統計：`{ pass: 7, fail: 3, needs_review: 1, not_measured: 0 }`。

### 2.2 逐項詳述

#### Q1 — needs_review（Z8 物理上不可達）
- **實測**：target `Z0/Z2/Z4/Z6` 全部可達並截到圖（DPR1/DPR2 齊）；`Z8` **不可達**，量到嘅 `reachedZ` 同 `Z6` 完全相同（`viewW=0.010937°`）。`missing/sizeBad/dprMismatch` 三項皆空 → 已量到嘅 4 個 target **完全合格**，唯一問題係 target 清單要求多一個唔存在嘅級。
- **判定依據**：spec §7 Q1 要求量到 `Z8`；但 spec §3.2 規則 L3 只講「`MAX_SCALE` 35→64（令 **Z6** 可達）」。`src/components/SvgMap.ts` 嘅 `MAX_SCALE = 64` → `viewW_min = 0.70/64 = 0.010937°` → `Z = log2(64) = 6`。即 **spec 內部有落差**：Q1 嘅 target 清單同 L3 嘅實作上限唔一致。
- **根因假設**（`map-resolution-diagnosis.json` RC-Z8-UNREACHABLE）：`MAX_SCALE` 只保證到 Z6，Q1 清單卻列到 Z8。
- **建議下一步**（二選一，須主代理定案並寫入 spec）：① 將 `MAX_SCALE` 提升到 256（令 Z8 可達，但要先確認 tile／POI 喺 Z7–Z8 仍有內容，否則只會製造新嘅「內容真空」）；② 將 Q1 target 清單改為 `Z0/Z2/Z4/Z6`。**唔可以**靜靜當 Z8 量過。

#### Q2 — pass
- **實測**：13 個 level 全部 `imagesWithHref=0`、`imgs=0`（地圖容器內零 raster 元素）；canvas backing 正確，例：`canvasW=1060 = cssW 1060 × dpr 1`，DPR2 亦符 `CSS × 2`。
- **判定依據**：spec §7 Q2 要求「無 raster upscale」——即唔可以靠放大低解像 raster 冒充高解像；`<image href>`/`<img>` 數 = 0 直接證明係向量繪製。

#### Q3 — fail（深 zoom 比 Z0 更平）
- **實測**：`center` 錨點（bbox 幾何中心 `114.14,22.36`，郊野公園一帶）`flatRatio` 由 Z0 `0.8521` **升到** Z6 `0.9549`（Δ **+0.1028**）；`tko` 錨點（故事主場）由 `0.8521` **降到** `0.8088`（Δ −0.0433，pass）。
- **判定依據**：閾值 `flat(max) ≤ flat(Z0) + 0.002`（0.002 = 量測雜訊上限，細過 A4 真實回歸值 0.004）。**逐 anchor 報，任何一個 FAIL → 整體 FAIL**。`center` 錨點同 A4 `flatness-probe` 同款協定，可同 spec 引用嘅「0.850 > 0.846」直接對比。
- **根因假設**（RC-EMPTY-CENTER）：`center` 深 zoom 視窗落喺**底圖資料真空區**——冇 zone polygon、冇 event、冇足夠建築幾何，畫面接近均勻，所以 `flatRatio` 極高。屬 A4 §1.2 成因 G1/G2/G3 嘅殘餘極端情況。
- **建議下一步**：① 為真空區加 spec §4.3 明文要求嘅 **procedural contour**，令畫面有結構；② 檢視 zone polygon 覆蓋率（該區係真係冇 zone，抑或 zone 半徑過細）；③ 檢視 tile 有冇缺格（manifest 有冇該格）。全部可用 **Q14-suggested**（tile 覆蓋完整性斷言）程式化驗證。

#### Q4 — fail（center 深 zoom 梯度暴跌）
- **實測**：`center` `midPeak=23.28`（Z2）、`deep=2.54`（Z6）、`floor=11.64`、`ratio=0.109`；`tko` `midPeak=20.14`、`deep=12.54`、`floor=10.07`、`ratio=0.623`（pass）。
- **判定依據**：閾值 `meanGrad(max) ≥ 0.5 × max(meanGrad(mid))`，`mid = Z2/Z4 嘅峰值`。
- **根因假設**：同 Q3 同源（RC-EMPTY-CENTER）——`center` 深 zoom 視窗冇足夠細節令灰度梯度撐起。
- **建議下一步**：同 Q3；另加 **Q13-suggested**（深 zoom 每個 anchor 至少 1 個可見 label），避免「有 zone 但全部 label 離屏」嘅假內容。

#### Q5 — pass
- **實測**：將軍澳 Z6 視窗內 `zonesInView=9`、`zoneLabelBoxes=48`。
- **判定依據**：閾值 ≥3。規則 L1：zone **永遠** render（唔受章節窗口影響）——B5 已移除章節 gate，故深 zoom 仍有 zone。

#### Q6 — pass
- **實測**：開「顯示全部事件」（`#map-show-all-events`、`aria-pressed="true"`）後視窗內 event 由 `1`（窗口值）升到 `101`。
- **判定依據**：閾值「≥5 **且** > 窗口值」。spec §3.3 要求 layer control 提供「顯示全部事件」toggle，實測開關有 `aria-pressed` 反映狀態。

#### Q7 — pass（替代 OCR，詳見 §3）
- **實測**：`labelsBelowMinFont=[]`（0 個 <9px）；`labelsDrawnTotal=3685`；DOM 可見 `.zone-label` `55` 個、全部 pass（`domPassRatio=1.0`）；cv2 邊緣銳利度（native vs 高斯模糊）`center Z0 = 2.21`、`center Z6 = 10.94`、`tko Z6 = 5.67`。
- **判定依據**：三條同時滿足 —— 0 個 label < 9.0px；DOM 可見 label ≥80% 滿足 h≥7.0、w≥8.0；有內容嘅 canvas 銳利度 ≥1.5。

#### Q8 — pass
- **實測**：三組分析（center Z0、center Z6、tko Z6）嘅最硬欄／行佔比為 `0.233 / 0.133 / 0.224`（欄）同 `0.233 / 0.094 / 0.175`（行），全部遠低於 0.5。
- **判定依據**：硬邊 = `|Δlum| > 16`。真正 tile seam 係一條橫跨成幅圖嘅直線（佔比 ≈ 1.0）；自然特徵（海岸線、道路）實測最多 ~0.23，故 0.5 有清楚分隔。分析用 canvas 匯出 PNG（純底圖，冇圖例／按鈕硬邊干擾）。

#### Q9 — pass
- **實測**：網絡攔截 2 個 tile（`r04c09.json=297,739 B`、`r03c09.json=153,618 B`，合計 `451,357 B`）；manifest 84 格，單格最大 `803,470 B`（tile `4,7`），合計 `9,285,855 B`。已核實 manifest：`tile_deg=0.05`、84 格、最大格 `4,7`。
- **判定依據**：spec 原文係「**單一 tile** payload ≤1.0 MB」→ 單格最大 803,470 B ≤ 1,048,576 B，**PASS**。
- **已知 gap（唔喺 Q9 判定內）**：max zoom **視窗合計** 最壞 2.33 MB（B5 `tests/map-render.test.ts` 量到），需 `tile_deg 0.05→0.02` 重生成資產先可解決。B9 兩個數都報，判定仍依 spec 原文。

#### Q10 — fail（詳見 §4）
- **實測**：20 次冷 zoom 產生 `longTaskCount=6`、**合計 525 ms**（raw 最新量測 538 ms）、最長單一 `160 ms`（raw 161）、`wallMs=4040`、`fps=5`。**合計未達標、最長單一達標**。
- **判定依據**：閾值「合計 ≤300 ms **且** 最長單一 ≤300 ms」。協定同 A8 `measure-jank.mjs` 一致（in-page `dispatchEvent` × 20）。

#### Q11 — pass
- **實測**：常數 `此區未有細節資料`；稀疏區（`114.315,22.235`，tile (2,10) 只有 2 幢建築）報 `data-detail-state="sparse"`、密集區報 `"ok"`；`fillText` 攔截確認狀態文字**真係畫過**（`drawnStrings=["此區未有細節資料"]`）。
- **判定依據**：「文字真係畫過」由 canvas `fillText` 攔截確認 —— **免 OCR**，比 OCR 更精確（OCR 會受字型／抗鋸齒影響）。另見 §6 已知缺陷（累加效應）。

---

## 3. Q7 替代方案說明（為何唔用 OCR）

- **限制**：`pytesseract` **唔可用**，亦**唔准加依賴**；`tesseract` binary 同樣冇。故唔可以 OCR。
- **規格依據**：spec §7 規則 Q1 原文係「必須 **image analysis / OCR / 程式斷言**」—— 三者係 **「或」** 關係，唔係「必須 OCR」。
- **改用嘅三層證據**：
  1. **canvas `fillText` 攔截** → 直接取得 App 真正畫咗嘅字串同 `ctx.font` 字級（精確到 px）。
  2. **DOM `getBoundingClientRect()`** → `.zone-label` 嘅**實際可讀尺寸**（h≥7.0、w≥8.0）。
  3. **cv2 邊緣銳利度**（native 圖 vs 高斯模糊圖嘅 edge density 比值）→ 證明唔係被放大嘅模糊 raster。
- **為何等效或更佳**：OCR 係「由像素反推文字」嘅**間接**方法，會受字型、抗鋸齒、背景對比而假陰性；`fillText` 攔截係「App 自己報畫咗乜」嘅**直接**證據，對「label 有冇用可讀字級畫」呢條斷言更強。三層合計覆蓋「字級正確 ∧ 實際尺寸可讀 ∧ 唔係模糊放大」，係「可讀」嘅完整程式化定義。
- **升級條件**（規則 B9-4）：若主代理要求**真正 OCR 語義**（例如「OCR 可讀出 ≥80% 可見 label」嘅字面實作），必須由主代理批准加 `pytesseract` + `tesseract` binary；B9 **唔會自行加**。已列入「已知限制」。

---

## 4. Q10 嘅 gap（如實記錄）

- **現況**：B9 冷 zoom 合計 **525 ms**（report JSON）／**538 ms**（raw JSON 最新）→ 目標 **300 ms**，**未達標**。最長單一 160／161 ms → **達標**。
- **對比 baseline**：B5 交付報告實測合計 **842 ms**、最長單一 182 ms（`b5-renderer-delivery.md` 發現 1）；A8 原始 baseline 係 **21,241 ms／20 longtask／最長 4,650 ms**。即 B9 量到嘅 525–538 ms 已較 B5 再改善，但**仍然超標**。
- **如實立場**：**唔會**為咗全綠而放寬閾值，亦**唔會**用「大幅改善」蓋過「未達標」。
- **根因假設**（`map-resolution-diagnosis.json` RC-COLDZOOM-REDRAW）：剩餘成本係「**每次 zoom 都做全量 canvas + SVG 重繪**」，唔再係 A8 嘅 O(tiles²) 病態（該病態已由 B5 增量 `Path2D` 修好）。6 個 50–200 ms 嘅 longtask 加埋就係合計 525 ms。
- **建議下一步**（spec §2.2 規則 R3）：per-layer incremental update（唔好每次 zoom 重建全部 layer）；或將幾何建構移去 worker。

---

## 5. Q3 / Q4 嘅 gap（如實記錄）

- **現況**：深 zoom 仍然偏平 —— 正係 A4/A2 一直指出嘅「**內容密度隨 zoom 反向下降**」。B5 已改善（`meanGrad` 9.12 → 12.27）但**未達標**。
- **逐 anchor**：故事主場（將軍澳）**已改善並 PASS**（Q3 Δ −0.0433、Q4 ratio 0.623）；但 bbox 幾何中心（郊野公園一帶）**仍然比 Z0 更平**（Q3 Δ +0.1028、Q4 ratio 0.109）。整體因「任何 anchor FAIL → 整體 FAIL」而 FAIL。
- **如實立場**：呢個係真實 gap，**唔會**因為 tko 已達標而當整體過。
- **建議下一步**：同 §2.2 Q3/Q4 —— 為真空區加 procedural contour、檢視 zone polygon 覆蓋率、檢視 tile 缺格；用 **Q12/Q13/Q14-suggested** 三個自動斷言鎖住，避免回退。

---

## 6. 已知缺陷（由診斷腳本標出，唔影響 Q 判定但需記錄）

| ID | 問題 | 證據 | Owner | 建議 |
|---|---|---|---|---|
| RC-NOFAKEZOOM-ACCUM | `BaseGeometryLayer.tileBuildingCount` 係**跨已載入圖磚累加**（LRU 上限 24 格）→ 先睇過密集區再去稀疏區會**誤報 `ok`**，唔畫「此區未有細節資料」 | `centerZ6_detailState="ok"`（但 `flatRatio=0.9549` 近乎空白）vs 全新 session 直接去稀疏區 `sparse` + 文字真係畫過 | B5 | `lowDensity` 應由**當前視窗內**建築數決定，而唔係全部已載入圖磚累加值 |
| RC-TKO-DECAY | 故事主場深 zoom 密度仍衰減（Z2 `meanGrad 20.14` → Z6 `12.54`） | Q4 tko ratio 0.623（過 50% 地板但趨勢向下） | B5 / B6 | 提高 detail tier 嘅 label/POI 密度（`maxLabelRank` / `includesTilePoi`） |

> ⚠️ **RC-NOFAKEZOOM-ACCUM 係 Q11 PASS 之下嘅一個潛在假陽性**：Q11 判定用「全新 session 直接去稀疏區」嘅協定（正確報 `sparse`），但同一 session 由密集區 zoom 入稀疏區會誤報。B9 **如實記錄**，並建議加 **Q12-suggested** 斷言（`data-detail-state` 必須同「當前視窗可見建築數」一致）作為回歸保護。

---

## 7. 驗收矩陣 #11 / #12 / #13 對應

| # | 矩陣斷言 | B9 檔案 | 驗咗咩 | 實際結果 |
|---|---|---|---|---|
| **#11** | Local-only network：intercept requests；assert no external request | `tests/local-only-network.e2e.test.ts` | 一條**長旅程**：載入 → 縮放 ×8 → 平移 → 圖層切換 → chronicle → 搜尋 → 主題切換 → reload；全程 `page.on("request")` 攔截，非本機（非同源／非 `data:`／`blob:`／`about:`）請求即記錄 | ✅ **PASS**（1 test）：`total > 5`（證明攔截器生效）、`external = []`。補足既有靜態掃描（`network-audit.test.ts`）同短動態（`network-dynamic.test.ts`） |
| **#12** | Public data safety：no private-text pattern / secrets in public routes / export；**加** `zones.geojson.evidence` 移除斷言 | `tests/public-data-safety.e2e.test.ts` | 5 條靜態斷言：① `zones.geojson` 冇 feature 帶 `evidence`（DA6 版權紅線）；② public 冇 `原文：「…」`；③ public + dist 冇 remote map/tile API（OSM/Mapbox/Google/Carto/Esri/Bing）；④ 冇「人工審閱／人手覆核」字眼（零人手紅線）；⑤ dist 冇 `private` 路徑 | ✅ **PASS**（5 tests）。⚠️ ④ 有一項 **已知 Gate 2 待修**：`data/public/map-config.json` 同 `dist/data/public/map-config.json` 仍含「人工審閱／人工確認」（owner B4／主代理，migration-plan §6.3-1），已列入 allowlist，測試只對**新違規** FAIL |
| **#13** | Zoom quality：各 target zoom + DPR 1/2 截圖；no low-res raster fallback；labels/zone outline/markers crisp | `tests/zoom-quality.e2e.test.ts`（量）＋ `scripts/verify_zoom_quality.py`（判） | Q1–Q11 全套：截圖存在性、raster 參與、flatRatio 單調、meanGrad 地板、zone/event 計數、label crispness、tile seam、tile payload、冷 zoom 阻塞、no-fake-zoom 狀態 | ⚠️ **部分**：Q1–Q11 = **7 pass / 3 fail / 1 needs_review**。C3（Zoom/Render QA）通過條件 = Q1–Q11 PASS，故 C3 **未可結案**，卡喺 Q3/Q4/Q10 三個實質 gap + Q1 嘅 spec 落差 |

> **e2e 專跑結果**（`run-e2e.log`）：#11 + #12 合共 **2 files / 6 tests passed**，11.80 s。
> **zoom 專跑結果**（`run-zoom.log`）：#13 量測 **2 tests passed**，56.03 s。

---

## 8. 閘門結果（讀 `artifacts/b9-qa/run-*.log`）

| 閘門 | 指令 | 結果 | 備註 |
|---|---|---|---|
| 單元／整合 | `npm run test` | ✅ **33 files / 612 tests passed** | 494.71 s；基線 30/604 + B9 新增 3 檔（local-only-network 1、public-data-safety 5、zoom-quality 2） |
| Python | `pytest -q` | ✅ **260 passed** | 42.20 s；B9 冇加 pytest |
| Build | `npm run build` | ✅ **exit 0** | `tsc --noEmit` 0 error；`vite build` 50 modules；`index.js` 213.03 kB（gzip 67.99 kB）、`index.css` 59.64 kB（gzip 12.48 kB） |
| 公開資料驗證 | `validate_public_data.py` | ✅ **全部通過** | location 704／event 1796／route 42／zone 48／chronicle 1320；schema、引用一致性、治理掃描、manifest、provisional gate 全過 |
| Release audit | `audit` | ✅ **RELEASE AUDIT PASSED** | 掃描 128 個文字檔、4668 記錄（needs_review 0）；無私隱洩漏、無 secrets、無 remote map URL |
| e2e（#11/#12） | 專跑 | ✅ 2 files / 6 tests | 11.80 s |
| zoom（#13） | 專跑 | ✅ 2 tests（量測本身綠；判定另由 Python 出 3 FAIL） | 56.03 s |

> ⚠️ **時序注意**：`run-full-vitest.log`（04:06–04:15）嘅完整跑**再次執行咗** `tests/zoom-quality.e2e.test.ts`，因此 `zoom-quality-raw.json`（04:12）係最新；但 `zoom-quality-report.json`（03:54）**未跟隨重生成**。詳見 §11。

---

## 9. 已知限制

1. **Q1 嘅 Z8 不可達**：`MAX_SCALE=64` → 最深只到 Z6（`viewW=0.010937°`）。Z8 截圖同 Z6 完全相同（已如實標 `needs_review`，**冇偽造**）。
2. **Q7 唔用真正 OCR**：`pytesseract` 唔可用且唔准加依賴，改用「`fillText` 攔截 + DOM 尺寸 + cv2 銳利度」替代（見 §3）。若需字面 OCR 語義，須主代理批准加依賴。
3. **只測 Chromium**：`launchB9()` 撞唔到 chromium → 回 `null` 並 skip。其他瀏覽器（Firefox/WebKit）未驗。
4. **headless software raster 影響 fps**：Q10 量到嘅 `fps=5` 係 headless Chromium 嘅 software raster 結果，同真機 GPU 唔可直接比；longtask 時長（525/538 ms）係主線程阻塞嘅可信指標，fps 僅作參考。
5. **冷 zoom 計時有 run-to-run 抖動**：同一協定兩次跑出 525 ms vs 538 ms（±13 ms），屬正常量測雜訊；合計遠超 300 ms，結論穩定（FAIL）。
6. **Q11 累加效應**：`tileBuildingCount` 跨圖磚累加 → 同一 session 由密集區入稀疏區會誤報 `ok`（見 §6，RC-NOFAKEZOOM-ACCUM）。
7. **Q9 視窗合計未達標**：單格 803 KB ✅，但 max zoom 視窗合計最壞 2.33 MB ❌，需 `tile_deg 0.05→0.02` 重生成資產（唔喺 Q9 判定內）。
8. **#12 嘅已知 Gate 2 待修**：`map-config.json` 仍含「人工審閱／人工確認」字眼（owner B4／主代理）。

---

## 10. 重跑指令（全部零人手、可重跑）

```bash
# --- 閘門（會佔用 vite preview 嘅 port 5174；唔可以同其他 e2e 並行）---
npm run test                       # 33 files / 612 tests（含 #11/#12/#13）
python -m pytest -q                # 260 passed
npm run build                      # tsc --noEmit && vite build

# --- B9 量測（Node/Playwright 側）---
npx vitest run tests/zoom-quality.e2e.test.ts    # 重寫 artifacts/b9-qa/zoom-quality-raw.json + screenshots/
npx vitest run tests/local-only-network.e2e.test.ts
npx vitest run tests/public-data-safety.e2e.test.ts

# --- B9 判定 + 診斷（Python 側，唔起 server）---
python scripts/verify_zoom_quality.py              # 讀現有 raw；缺 → 自動補跑量測；有 FAIL → exit 1
python scripts/verify_zoom_quality.py --refresh    # 強制重跑量測（會起 vite preview）
python scripts/verify_zoom_quality.py --report-only# 只出報告，永遠 exit 0（讀現有 raw，唔起 server）
python scripts/diagnose_map_resolution.py          # 讀 report → 根因診斷 JSON
```

> **規則 B9-1**：`verify_zoom_quality.py` 可獨立重跑；raw 缺失／過期時會自己補跑 `npx vitest run tests/zoom-quality.e2e.test.ts`。
> **注意**：`--report-only` 只讀現有 raw、**唔需要 preview server**，係修正 §11 過時報告嘅最小重跑方式。

---

## 11. 核實發現：report JSON 相對 raw JSON 已過時（不一致，如實記錄）

收尾核實期間發現**一個產出一致性問題**，必須記錄：

| 檔案 | `generatedAt` | 內容 |
|---|---|---|
| `artifacts/b9-qa/zoom-quality-raw.json` | `2026-09-22T20:12:29Z`（本地 04:12） | 最新量測：`coldZoom = { longTasks:6, totalMs:538, maxMs:161, wallMs:4162, fps:4.8 }` |
| `artifacts/b9-qa/zoom-quality-report.json` | `2026-09-22T19:54:56Z`（本地 03:54），`rawGeneratedAt = 19:54:50Z` | 舊量測：Q10 `actual = { longTaskCount:6, totalMs:525, maxMs:160, wallMs:4040, fps:5 }` |

- **成因**：`run-full-vitest.log`（04:06–04:15）嘅完整跑**再次執行咗** `tests/zoom-quality.e2e.test.ts`，將 `zoom-quality-raw.json` 重寫成最新量測；但 `verify_zoom_quality.py` **冇跟隨重跑**，所以 `zoom-quality-report.json`（同基於佢嘅 `map-resolution-diagnosis.json`）仍然係 03:54 嘅舊數。
- **影響範圍**：**只有 Q10 嘅計時數字**受影響（525 vs 538 ms）。已逐項比對 `center/tko` 全部 level 嘅 `flatRatio` / `meanGrad` / `edgeDensity` / `zonesInView` / `eventsInView` / `detailState` —— **同 report 完全一致**（量測確定性良好，重跑唔漂移）。Q10 **兩次都係 FAIL**（合計遠超 300 ms），**判定結論不變**。
- **建議修正**（唔喺本 pass 授權範圍內，故未執行）：跑一次 `python scripts/verify_zoom_quality.py --report-only`（**唔需要 preview server**）令 report 同 diagnosis 跟隨最新 raw。或喺 CI 加一步「raw 新過 report 就自動重判」嘅守門斷言。

### 11.1 ✅ 已修正（主代理，2026-09-23 04:41）

主代理已執行上述修正：

```bash
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe \
  scripts/verify_zoom_quality.py --report-only    # exit=0
```

- `zoom-quality-report.json` 嘅 `generatedAt` 已由 `2026-09-22T19:54:56Z` 更新為 **`2026-09-22T20:41:15Z`**
- Q10 數字已同步為最新 raw 值（`totalMs 538` / `maxMs 161` / `fps 4.8`）
- **`summary` 不變**：`{ pass: 7, fail: 3, needs_review: 1, not_measured: 0 }`

→ 印證本節「**只有 Q10 計時數字受影響、判定結論不變**」嘅判斷正確。

⚠️ **仍未處理**（建議 Gate 2 或 CI 加入）：本節提出嘅「**raw 新過 report 就自動重判**」守門斷言
—— 呢個係**結構性防護**，避免同類不一致再發生。屬自動驗證規則擴充，零人手。

---

## 12. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議新斷言 | 針對 gap | 做法（程式化） |
|---|---|---|---|
| Q12 | 深 zoom 每個 anchor 嘅 `data-detail-state` 必須同「**當前視窗可見建築數**」一致 | RC-NOFAKEZOOM-ACCUM（累加誤報） | Node 側喺 `BaseGeometryLayer` 曝露「當前 viewBox 相交圖磚嘅建築數」，Python 比對 detailState |
| Q13 | 深 zoom 每個 anchor **至少 1 個可見 label**（唔可以全部離屏） | center Z4/Z6 嘅 zone-label 全部離屏（`visible=0`） | Python 由 raw 嘅 `zoneLabelBoxes` 過濾 viewport 後要求 ≥1 |
| Q14 | tile 覆蓋完整性：max zoom 視窗內每格圖磚都存在於 manifest | 區分「真空區係冇資料」抑或「資料存在但冇渲染」 | Python 用 viewBox→圖磚範圍（同 `VectorBasemap.tileRange` 同公式）比對 manifest |
| Q15 | Q1 target 清單同 `MAX_SCALE` 保持一致（spec 內部一致性**硬斷言**） | RC-Z8-UNREACHABLE | Python 讀 `raw.maxZ`，要求 `max(zTargets) ≤ maxZ`，否則 `needs_review`（現為軟檢查，改成硬斷言） |
| Q16 | 合計冷 zoom 阻塞回歸保護：CI 上跑 `verify_zoom_quality.py`，合計 >300 ms 即 exit 1 | Q10 gap 回退 | 接入 CI（spec §6.2 / 規則 P1 精神），避免改善被無聲回退 |
| Q17 | 深 zoom 內容密度回歸保護：`center` 錨點 `flat(max) ≤ flat(Z0)+0.002` 同 `meanGrad ratio ≥0.5` 硬性 gate | Q3/Q4 gap 回退 | 已喺 `verify_zoom_quality.py --strict`（預設 exit 1）；接入 CI 即可 |

> 以上全部係**自動斷言**，冇任何「人手覆核／人手目測」。已交付嘅 `scripts/verify_zoom_quality.py --strict`（預設）同 `scripts/diagnose_map_resolution.py` 就係呢啲斷言嘅載體。

---

## 13. 完成定義（DoD）對照

| # | DoD（契約 §7） | 結果 |
|---|---|---|
| 1 | `typecheck`／`lint`／`build` = exit 0 | ✅ build exit 0（tsc 0 error） |
| 2 | `npm run test` 基線全綠 + B9 新檔全綠 | ✅ 33 files / 612 tests |
| 3 | `pytest` = 260 passed | ✅ 260 passed |
| 4 | `verify_zoom_quality.py` 有實際逐項輸出 | ✅ `zoom-quality-report.json`（Q1–Q11 齊） |
| 5 | `diagnose_map_resolution.py` 有根因 + spec 條文 + owner | ✅ 5 rootCause + 4 nextCheck |
| 6 | `docs/progress/b9-visual-qa-delivery.md` 逐項填寫 | ✅ 本檔 |
| 7 | 零人手：下一步只可以係自動驗證／語義約束 | ✅ §12 全部係自動斷言 |

**B9 狀態**：**交付完成**（實作 + 量測 + 判定 + 診斷 + 報告齊全），Q1–Q11 判定 **7 pass / 3 fail / 1 needs_review**；Q3/Q4/Q10 三個 gap 同 Q1 嘅 spec 落差**如實記錄、未放寬**。

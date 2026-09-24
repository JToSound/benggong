# UX Decisions —《病港》互動地圖 World Atlas V2

> 日期：2026-09-23
> 依據：`docs/specs/world-atlas-v2-product-spec.md` §0.1、`docs/specs/world-atlas-v2-migration-plan.md` §1
> 用途：記錄**被拒絕嘅舊 UI pattern、state design、LOD policy、zone semantics、motion rules**
> （spec §8「最終交付條件」第 10 項）

---

## 1. 被拒絕嘅舊 UI pattern

| # | 舊 pattern | 為何拒絕 | V2 取代 |
|---|---|---|---|
| 1 | **資料 dump 式首屏**（章節列表為主） | 地圖產品未存在（zone 0/380 px 可點） | **首屏主 context = 地圖**；chronicle 改 `?view=chronicle` |
| 2 | **右側抽屜面板**（`position: absolute; width: min(360px, 88vw)`） | 遮蓋 88% 地圖；冇 drag handle；冇 snap | mobile 改 **bottom sheet 3 段 snap**（peek 25% / half 55% / full 92%） |
| 3 | **章節過濾 zone**（`c <= cur && cur <= c + 12` gate） | 令世界地圖「空」—— 違反「48 個 zone 永遠全部 render」 | 章節只作 **emphasis**（提高 opacity / 加 pulse），**唔過濾** |
| 4 | **Leaflet + raster tiles** | 32 MB 死重資產令 LOD policy 失效；max zoom pixelation | **Canvas 2D 向量底圖**（`VectorBasemap.ts`） |
| 5 | **`role="application"` 包全 app** | 令螢幕閱讀器關閉所有標準導覽快捷鍵（H 跳 heading 等） | 只喺 `#svg-map` 保留；`#app-root` 移除 |
| 6 | **`clip-path` 剪走 focus ring** | 12 個主要控制項 focus ring 完全不可見 | 改用 **`box-shadow: inset`**（畫喺 border box 內，剪唔走） |
| 7 | **`transform: translateX(100%)` 收合面板** | 唔會移除 Tab 序／accessibility tree（2,920 個 Tab stop） | 改用 **`visibility: hidden`** + `inert` |
| 8 | **`outline` 做 focus ring** | 被 `clip-path` 剪走 | `box-shadow: inset` + **保留 `outline`**（forced-colors 之下唯一通道） |

---

## 2. State design

| # | 舊做法 | 為何拒絕 | V2 做法 |
|---|---|---|---|
| 1 | **散落喺 `App` 嘅 4 個 selection 欄位 + `viewMode` private** | 冇單一 state 來源；URL 8 參數中 7 個零支援 | **單一 store**（`src/state/store.ts`）+ URL contract（11 參數） |
| 2 | **`#ch=` / `#loc=` hash 為主** | 唔可組合（多參數） | **統一 query string**；hash 只作 legacy alias |
| 3 | **`localStorage` 直接讀寫散落各處** | 難測試 | 集中喺 `src/state/persistence.ts` |
| 4 | **元件自己持有 state** | 難同步 | 元件只讀 store + 派發 action |
| 5 | **首次 store 通知當「有變更」** | `prev === null` 判斷陷阱 → 開機即 `flyToChapter(1)` | 加 **`initialised` 旗標** |

---

## 3. LOD policy

| # | 舊做法 | 為何拒絕 | V2 做法 |
|---|---|---|---|
| 1 | **raster 13 層 pyramid**（28 MB） | **實測 0 次參與**（`SvgMap.ts:103`） | **刪除**（Gate 2 已做，省 28 MB） |
| 2 | **章節窗口過濾** | 令深 zoom「反向變空」 | 內容密度隨 zoom **正向**提升 |
| 3 | **`MAX_SCALE = 35`** | Z6 不可達 | **`MAX_SCALE = 64`** |
| 4 | **zone LOD 用固定 user unit 尺寸** | user unit ↔ px 換算率隨 `viewW` 改變 | **先定 px，再反推 user unit** |
| 5 | **cluster badge 寫死 `0.0078 user × 1.45`** | 實測 29.7–41.2 px（超 spec 3.5–5 倍） | **`CLUSTER_BADGE_DIAMETER_PX = 10`** → 實測 8.64–10.58 px |
| 6 | **`emptyOutDir: false`** | 累積 4.66 MB stale bundle | **`true`**（撞 safe-delete shim 時用 `mv` 繞法） |

**LOD 三層**（spec §3.2）：L-Z0（`viewW > 0.175°`）cluster glyph；L-Z1（`0.0219° < viewW ≤ 0.175°`）邊界 polygon；L-Z2（`viewW ≤ 0.0219°`）完整。

---

## 4. Zone semantics

| # | 舊做法 | 為何拒絕 | V2 做法 |
|---|---|---|---|
| 1 | **`zone_type` 8 個欄位** | **原 4 個 layer 全部唔存在** | 實際欄位叫 **`kind`**（`survivor` / `nest` / `outpost`） |
| 2 | **zone = Point + radius** | 幾何唔準 | **Polygon** |
| 3 | **`danger_level = null` 當 0** | 資料**未評估** ≠ 0 | **只有非 null 才寫落 DOM**（規則 Z3） |
| 4 | **`zones.geojson.evidence` 含小說原文** | **版權紅線**（原 48/48 全含原文） | **全部移除**（B4 已做） |
| 5 | **只靠顏色分辨 zone** | 灰度／色弱不可辨 | **三通道**：color + pattern（`hatch`/`contour`/`noise`/`solid`/`pulse`）+ icon |
| 6 | **zone 唔可點**（`pointer-events: none`） | 地圖產品未存在 | **可點**（`#svg-map .zone-area` 特異度 `(1,1,0)` 覆蓋） |
| 7 | **冇「資料不足」狀態** | 令人以為「冇內容」 | **誠實標示**（`unknown` / `approximate` / `fictional` / `needs_review`） |

---

## 5. Motion rules

| # | 舊做法 | 為何拒絕 | V2 做法 |
|---|---|---|---|
| 1 | **動畫時長散落各處** | 唔一致 | **3 duration + 2 easing + 7 用途白名單**（`src/motion.ts`） |
| 2 | **`prefers-reduced-motion` 只做 CSS 層** | **JS 驅動動畫完全無效**（A7 P1-6） | **CSS + JS 雙層**（`prefersReducedMotion()`） |
| 3 | **`rAF` 補間唔檢查 reduce** | 同上 | 全部經 `motion.ts`（`tests/reduced-motion.test.ts` 斷言） |
| 4 | **`scrollIntoView` 做章節捲動** | 會移動 Tab 起始點（頂欄 Tab 到唔到） | 改用 **`scrollElementTo()`** 直接設 `scrollLeft` |
| 5 | **`onMouseUp()` 無條件 `settle()`** | 令 `click` 唔合成（zone 點唔到） | 加 **`movedDuringPan` 守衛**（`PAN_THRESHOLD_PX = 4`） |

---

## 6. 其他被拒絕嘅做法

| # | 做法 | 拒絕理由 |
|---|---|---|
| 1 | **online map API / remote tile / runtime geocoding** | 專案硬性要求「完全離線、零 runtime 依賴」 |
| 2 | **加 `html2canvas` 等新 runtime 依賴** | 同上 |
| 3 | **人手抽樣覆核 LLM 輸出** | `AGENTS.md`「🚫 零人手參與」 |
| 4 | **「review queue」等人手處理** | 同上 |
| 5 | **用 `rm` 批量刪檔** | 本機 sandbox 直接 deny（一律用 `mv`） |
| 6 | **`git checkout -b <含 slash 名>`** | 會摧毀 `.git`（本機環境限制） |
| 7 | **保留 raster `fallbackToRaster()` 嘅預設 `href`** | 唔想為平時唔用嘅 2 MB PNG 付流量 |
| 8 | **直接刪舊 CSS（唔遷移）** | 80 個 class 有引用但 V2 冇定義 → 會版面解體。**2026-09-24 已改為「先原文整段搬入 `legacy-migrated.css`，再刪三個舊檔」**（D 遷移，見 `docs/progress/d-legacy-css-migration.md`） |
| 9 | **CSS 遷移只搬「有 class 嘅規則」** | 實測漏咗 **67 條冇 class 嘅規則**（`#svg-map-mount`、`#topbar`、`:root`…）→ 兩個真回歸（SVG 溢出、`.ch-pill` 對比 1.02）。元素／id 選擇器一樣影響版面 |

---

## 7. 未決事項

| # | 項 | 現況 |
|---|---|---|
| 1 | **spec §8 第 8 項「old dead CSS 已刪」** | ✅ **已解決（2026-09-24）**：D 遷移階段 1+3 —— 158 個被引用 class 原文搬入 `legacy-migrated.css`，`main.css` / `hud.css` / `timeline.css` 已刪。⏳ 死 CSS 清理（階段 4）待做 |
| 2 | **P1-2 地圖元素鍵盤可達** | ✅ **已解決（2026-09-24）**：roving tabindex + `role="button"` + `aria-label` + Enter/Space 啟動 + 焦點環。A7 §10.9 由 FAIL（0/14）→ PASS（量測方法亦升級為真鍵盤驅動）。見 `docs/progress/p1-2-map-keyboard-access.md` |
| 3 | **P0-5 角色 dossier 內容** | `StoryPanel.ts:162` 仍係 `console.log` + TODO |
| 4 | **Q3/Q4 深 zoom 偏平** | `center` flatRatio 0.8521→0.9549（FAIL） |
| 5 | **Q10 冷 zoom 阻塞** | 合計 538 ms（目標 300 ms） |

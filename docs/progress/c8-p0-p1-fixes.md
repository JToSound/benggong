# C8 敵意產品審查 —— P0 + P1 修復（2026-09-25）

> 前置：`docs/audits/c8-hostile-product-review.md`（判定 **1 P0 + 8 P1 → 唔可交付**）
> 本檔記錄**已修**嘅項目同量測證據。

---

## 0. 一句話總結

| # | 項目 | 修復前 | 修復後 |
|---|---|---|---|
| **P0** | 編年史條目卡寬度 | **83 px**（文字逐字斷行） | **315 px** ✓ |
| **P1-4** | `zone-dossiers.json` 有冇被用 | **從來冇 fetch**（`loadDossiers()` 死碼） | 按需載入 ✓（實測請求 1 次） |
| **F6** | 誠實標示 | 寫死「人類聚居 · **安全**」、`review_status` 零 render | badge「待核實」+ 精度 ✓、`sub` = 「人類聚居」 |
| **P1-5** | 內部欄位外露 | 「資料來源」**預設展開**，顯示 `抽取來源 A6`、`座標 legacy` | 收落 `<details>`，預設收起 ✓ |
| **P1-7** | dossier 冇下一步 | 冇任何 CTA | 「跳到首現章節」／「睇呢區嘅第一個事件」／「收埋」✓ |
| **P1-2** | 揀 zone 唔 fly-to | viewBox 完全唔變（`0.70` 不變） | viewBox `0.70 → 0.0251`（放大 **~28×**）並置中 ✓ |
| **P1-3** | 手機 tap zone 面板唔開 | 手機 snap 停留 `peek`，dossier top 727 | snap `peek → half`，dossier top **474** ✓ |
| **P1-6** | map pane 只佔 60.6%（spec ≥70%） | — | ⚠️ **未修：同 spec 第 1 項衝突**（見 §3.7） |
| **P1-1** | 48 zone 擠成一坨、cluster badge 被淹沒 | badge `fill` 半透明（`--bg-overlay`）、`stroke-width` 0.0006 | `fill` → **不透明** `--bg-base`、`stroke-width` **×2**、數字光暈加粗 ✓（**部分** —— 見 §3.8） |

---

## 1. P0：編年史被塞入 380px 側欄

### 1.1 根因

`.chronicle` 用 **`@media (min-width: 768px)`** 決定兩欄（`220px + 1fr`），
但編年史係 render 入 `.pane-story { width: 380px }`（**固定側欄**）。

→ 只要 **viewport** ≥768px 就用兩欄，**同側欄實際有幾闊無關**：
卡片欄 = `380 − 220 − gap ≈ 115px` → `.chr-entry` 實測 **83px**，
1280／1440／1920／2560 **一律 83px**。

> **教訓：約束係「容器」就唔可以用 viewport 媒體查詢。**

### 1.2 修法

改用 **容器查詢**（container query）：

```css
#story-panel-mount { container-type: inline-size; container-name: story-pane; }

@container story-pane (min-width: 700px) { /* 兩欄：220px + 1fr */ }
@container story-pane (max-width: 699px) { /* 單欄 + rail 橫向滾動 */ }
```

### 1.3 ⚠️ 踩過嘅坑：窄容器規則要放喺**檔案最後**

第一版將 `@container (max-width: 699px)` 塊放喺 `.chr-rail { flex-direction: column }`
**之前** → 同特異度之下「後載入者勝」→ 基礎規則蓋過容器查詢 →
`flex-direction: row` 永遠唔生效（幾何啱但 rail 仍然垂直）。

實測指紋：`getComputedStyle(rail).flexDirection === "column"` 而
`railW === 347`（= 容器全寬，即兩欄確實冇生效）—— 兩者矛盾就係呢個 bug。

### 1.4 量測（`artifacts/phase3-resume/probe-chronicle-width.mjs`）

| 指標 | 修復前 | 修復後（1280 & 1920） |
|---|---|---|
| `.chr-entry` 寬度 | **83 px** | **315 px** |
| `.chr-rail` 寬度 | 220 px（側欄） | 347 px（橫向全寬） |
| `rail.flexDirection` | `column` | **`row`** ✓ |
| `.chronicle-body-wrap` | 115 px | 347 px |

---

## 2. P1-4：`zone-dossiers.json` 從來冇被前端使用

### 2.1 根因

| 事實 | 證據 |
|---|---|
| `adapter/index.ts` 有 `loadDossiers()`（lazy、memoized） | 函數存在 |
| **但 `src/` 從來冇呼叫過** | `grep -rn "loadDossiers" src/` 只有定義 |
| `ZoneDossier` component 讀 `zones.geojson` 嘅**舊 inline 欄位** | `p[sec.key]` |

→ 48 個豐富 dossier（每個 14 欄位）**白做**；UI 睇落似「換皮」（C8 原話）。

### 2.2 修法

1. **`src/data/loadAllData.ts`** 新增 `loadZoneDossiers()`（memoized、失敗回空 Map）
   —— 刻意唔用 `adapter.loadDossiers(world)`，因為佢要 `World` 物件，
   而 `App` 揸嘅係 `AppData`（`buildWorldIndex()` 之後冇保留 `World`）。
2. **`src/components/ZoneDossier.ts`**：
   · `update()` 先即刻 render v1 inline 欄位（唔會白畫面）→ 再按需載入
   · 載入到就用豐富欄位**重新 render**
   · **race guard**：`if (this.currentZoneId !== zoneId) return;`
     （用戶快速切 zone 時唔可以 render 錯）
3. 豐富欄位：`overview` + `governance` / `society` / `infrastructure` /
   `risk_profile` / `nest_profile`（`DOSSIER_GROUPS`）+ `key_characters`

### 2.3 量測（`artifacts/phase3-resume/probe-dossier-wiring.mjs`）

```
zoneId: zone_d3f76d3c94
zone-dossiers.json 請求次數: 1          ← lazy + memoized ✓
sections: ⚖政權、▤社會、◫基礎設施、⚠風險、★關鍵角色
          （＋ v1：★領袖與要員、▤社會結構、◈經濟、⛨防禦、◉人口…）
badges:   待核實、精度：approximate
kindSub:  人類聚居                       ← 唔再寫死「安全」✓
auditRows: 12
```

---

## 3. F6：誠實標示

### 3.1 問題

· `ZoneDossier.ts` 對 **11 個倖存區**寫死 `sub: "人類聚居 · **安全**"`
· `zone_review_status` / `spatial_precision` **完全冇 render**
· 48 個 zone 只有 **7 個 `validated`**（31 `auto_inferred`、10 `needs_validation`）
· 實測「心朗村」`confidence 0.4` 都顯示「安全」

→ 違反 `DATA_GOVERNANCE.md §3`「推測絕不可寫成事實」。

### 3.2 修法

1. `sub` 只保留**唔需要證據**嘅描述：「人類聚居」（刪「安全」）
2. 新增 `REVIEW_META`（`validated`→已核實／`auto_inferred`→自動推斷／
   `needs_validation`→待核實），每項有 `title` 解釋
3. Header 加 `.zd-badges`：review badge + `精度：<spatial_precision>`
4. CSS 放 V2 層（`map.css`，唔改自動產生嘅 `legacy-migrated.css`），
   顏色一律 token（`--ok` / `--warn` / `--danger`）

---

## 3.5 P1-5 / P1-7：內部欄位漸進披露 + 下一步 CTA

### P1-5

原本「資料來源」係 `<section>` **預設展開**，直接顯示 `抽取來源 A6`、
`座標 legacy` 等**內部管線欄位** —— 對用戶冇意義（C8 講嘅「工程師式文案」）。

**修法**：改成 `<details class="zd-meta-details">`，`<summary>` 寫
「資料來源與可信度」，**預設收起** ✓。`原文證據` 亦由嵌套 `<details>`
改為內層 `<div>`（避免雙層 disclosure）。

### P1-7

C8 原話：「dossier 打開之後，用戶唔知下一步可以做咩」。
**修法**：加 `zd-next` 區塊，3 個 CTA（全部用**已有** app 動作，唔新增 API）：

| CTA | 動作 |
|---|---|
| 跳到首現章節 chN | `app.goToChapter(first_appearance)` |
| 睇呢區嘅第一個事件 | `app.setSelectedEvent(event_ids[0])` |
| 收埋 | `app.setSelectedZone(null)` |

⚠️ 互動目標 `min-height: 44px`（B1 契約 C3：≥44×44 CSS px）—— 實測
`getBoundingClientRect().height === 44` ✓

### 量測

```
metaIsDetails: true          ← 係 <details>
metaOpenByDefault: false     ← 預設收起 ✓
actions: ["跳到首現章節 ch1", "睇呢區嘅第一個事件", "收埋"]
actionMinHeight: 44          ← 符合契約 C3
zone-dossiers.json 請求次數: 1
```

---

## 3.6 P1-2 / P1-3：zone fly-to + 手機面板自動開

### P1-2 揀 zone 唔 fly-to

**問題**：`app.ts` 只有 `svgMap.flyToChapter()`，**冇** zone fly-to
→ 揀 zone 之後 viewBox 完全不變。而 48 個 zone 喺世界視圖擠成一坨
（559/1128 對視覺重疊，抽樣 zone 同 **35 個**其他 zone 重疊）
→ 用戶睇唔出「我揀咗邊個」。

**修法**：`SvgMap` 新增 `flyToZone(zoneId)`：

· **共用** `viewBoxForGeoBounds`（同 `flyToChapter` 一樣）—— 唔可以自己寫
  投影，否則會再踩 §3.10 嘅 `1/cos(φ₀)` 漂移。守門測試斷言 body 內
  **唔可以**出現 `M_PER_DEG_LAT` ✓
· 處理 `Polygon` **同** `MultiPolygon`
· `padding: 0.8`（唔係章節嘅 0.25）—— zone 係單一目標，需要更多周邊 context
· `minSpan: 0.004`（唔係 0.02）—— 實測 48 個 zone 嘅經度跨度只有 **0.1039°**
  （46/48 距質心 <0.03°）→ 單一 zone 更細，0.02 會飛得太遠，睇落似「冇 zoom 過」
· `app.ts`：`zoneChanged && newZone` → `flyToZone`；⚠️ **`!first`**
  （首次載入要保留 `initial_view`）；⚠️ 同章節飛行**互斥**
  （`if (chapterChanged) … else if (zoneChanged …)` —— 兩個動畫唔可以打架）

**量測**（`artifacts/phase3-resume/probe-zone-flyto.mjs`）：

```
zones 總數: 48
點擊: zone_2a22537f9c
viewBox before: 113.79 22.11 0.6999999999999886 0.5407159078620093
viewBox after : 114.2263534 22.407849464691246 0.025121200000015165 0.019404903520845007
viewBox 有變: true
URL 有 ?zone=: true
```

### P1-3 手機 tap zone 面板唔自動開

**問題**：C8 實測 dossier 內容 top = **1187px**，但手機 viewport 高只有
**844px** → 用戶 tap 完見到「冇反應」（地圖郁咗但內容喺畫面外）。

**修法**：`app.ts` —— zone 新揀而且 sheet 收埋（`COLLAPSED_SNAP`）就
`setSheetSnap(EXPANDED_SNAP)`，**只喺 `matchMedia("(max-width: 1023px)")`**
（= `mobile.css` 嘅 sheet 斷點）生效。

⚠️ **踩過**：第一版將呢段放喺 `else if (zoneChanged && newZone)` **入面**
→ 點 zone 有可能同時改章節 → `chapterChanged` 為真 → `else if` 被跳過
→ snap 永遠唔升（實測：`after.snap` 仍然係 `peek`）。改成**獨立 if block** ✓

⚠️ **唔可以無條件做**：桌面版 `#story-pane` 係側欄，`SNAP_PCT` =
peek 25% / half 55% / full 92% → 會令側欄忽然變高。

**量測**（`artifacts/phase3-resume/probe-mobile-sheet.mjs`）：

| viewport | before | after |
|---|---|---|
| 手機 390×844 | `snap=peek`、dossierTop 727 | `snap=half`、dossierTop **474** ✓ |
| 桌面 1440×900 | `snap=half` | `snap=half`（**不變 = 冇回歸**）✓ |

---

## 3.7 P1-6：map pane 面積 ≥70% —— ⚠️ 未修（同 spec 第 1 項衝突）

### 量測（`artifacts/phase3-resume/probe-map-pane-area.mjs`）

| viewport | `#map-pane` | 面積佔比 | topbar | chapter strip | story pane |
|---|---|---|---|---|---|
| 1440×900 | 1060×741 | **60.6%** | 65 | 94 | 380（展開） |
| 1280×800 | 900×641 | **56.3%** | 65 | 94 | 380 |
| 1920×1080 | 1540×921 | **68.4%** | 65 | 94 | 380 |

（spec：`docs/specs/world-atlas-v2-product-spec.md:103`
「地圖佔首屏 **≥70%** 面積」；驗收矩陣第 1 項喺 **1440px** 量。）

### 為何冇修：兩項 spec 要求互相衝突

1440×900 之下，`#map-pane` 高度 = `900 − 65 − 94 = 741`。要達 70%：

```
需要寬度 = 0.70 × (1440 × 900) / 741 = 1224 px
→ story pane 只可以佔 1440 − 1224 = 216 px
```

而 story pane 現時係 **380px**，而且**預設展開**。三個選項：

| 選項 | 效果 | 代價 |
|---|---|---|
| **A. 預設收起 story pane** | 1440×900 → **82.3%** ✓ | ✗ 違反驗收矩陣第 1 項「4 個主入口文字存在且可鍵盤達」—— 嗰 4 個入口喺 story pane 內 |
| **B. story pane 改成 overlay**（浮喺地圖上，唔佔 layout 寬度） | 1440×900 → **82.3%** ✓ 而且入口仍可達 | 較大嘅版面重構（要處理遮蓋、z-index、focus trap、mobile 已有 sheet 機制） |
| **C. 只縮短 chapter strip**（94 → 56） | 1440×900 → **63.7%** ✗ 仍然唔達標 | 低風險但**解唔到問題** |

→ **B 係唯一同時滿足兩項要求嘅方案**，但屬**版面設計決策**（唔係 bug fix），
需要用戶裁決。本輪**唔改**，並將證據（上面算術 + 量測）記錄落嚟。

---

## 3.8 P1-1：48 zone 擠成一坨 —— **部分修**（spec 層面張力）

### C8 嘅證據

· 幾何：48 個 zone 質心經度跨度 **0.1039°**、緯度 **0.0894°**；
  **46/48（96%）** 距整體質心 **<0.03°**
· DOM：zone 兩兩視覺重疊 **559 / 1128 對（49.6%）**；抽樣 zone 同 **35 個**其他 zone 重疊
· LOD：世界視圖有 6 個 `zone-cluster` badge（counts 14/10/5/5/3/2），
  但 badge 直徑只 **10px**、低對比 → 被 48 個 ~21px 半透明 zone 圓淹沒

### ⚠️ 為何唔可以「加大 badge」

`CLUSTER_BADGE_DIAMETER_PX = 10` **係 spec 明文要求**
（`docs/specs/world-atlas-v2-rendering-lod-strategy.md` §3.2 L-Z0：
「直徑 **8–12 px** 嘅 badge」），而且有 e2e 斷言
（`tests/map-interaction.e2e.test.ts`「⭐ cluster badge 渲染直徑 ∈ [8,12] px」）✗

**同時** spec 又要求「48 個 zone 永遠全部 render」✗
→ **兩個 spec 要求合起來就係「10px badge + 48 個 21px 圓」= 必然擁擠**。

### 本輪做咗（spec 只約束直徑，冇約束對比）

| 項 | 前 | 後 |
|---|---|---|
| `.zone-cluster-ring` `fill` | `var(--bg-overlay)`（半透明，底色透出） | **`var(--bg-base)`**（不透明） |
| `.zone-cluster-ring` `stroke-width` | 0.0006 | **0.0012**（×2） |
| `.zone-cluster-count` `stroke-width`（光暈） | 0.0008 | **0.0014** |

**驗證**（`tests/map-interaction.e2e.test.ts` 實瀏覽器量度）：

```
[B6] cluster badge 實測直徑： [
  {"viewW":0.7,   "lod":"cluster","badges":6,"minPx":8.47,"maxPx":10.35},
  {"viewW":0.319, "lod":"cluster","badges":5,"minPx":8.45,"maxPx":10.34},
  {"viewW":0.189, "lod":"cluster","badges":6,"minPx":8.46,"maxPx":10.33}]
[B6] cluster badge 重疊檢查： {"badges":6,"overlaps":0}
```

→ 直徑仍然 **8.45–10.35 px ∈ [8,12]** ✓（幾何完全冇變）、重疊 **0** ✓、
`map-interaction.e2e.test.ts` **13 tests 全過** ✓

### 仍然未解決（需要 spec 層面裁決）

| 選項 | 效果 | 代價 |
|---|---|---|
| **A. 放寬 LOD spec 嘅 badge 直徑**（8–12 → 例如 14–20px） | badge 真正睇得到 | 改 spec + 改 e2e 斷言；而且 badge 之間可能開始重疊（現時 0） |
| **B. 世界視圖降低 zone 圓嘅視覺權重**（opacity / 描邊） | badge 相對突出 | 改動 zone 喺 LOD 嘅外觀（spec 可能約束）；要重新量 Q 系列指標 |
| **C. 接受擁擠，靠 fly-to + badge** | 已經做咗 P1-2（fly-to）✓ | 世界視圖仍然係「一坨」 |

→ 屬 **spec 內部張力**（唔係實作 bug），需要用戶／spec owner 裁決。

---

## 3.9 P1-8：首屏 payload —— 已量測，未修

### 量測（`artifacts/phase3-resume/probe-firstload-payload.mjs`）

```
=== 首屏 data/public 請求（9 個）===
  2087 KB  data/public/events.geojson
   922 KB  data/public/locations.geojson
   401 KB  data/public/zones.geojson
   368 KB  data/public/routes.geojson
     0 KB  data/public/chronicle.json      ← ⚠️ 冇 content-length（gzip/chunked）
     0 KB  data/public/characters.json
     0 KB  data/public/chapter-appearances.json
     0 KB  data/public/chapter-summaries.json
     0 KB  data/public/map-config.json
  合計 3.69 MB
```

⚠️ **量測限制**：部分檔（包括 `chronicle.json`）回應冇 `content-length`
→ 實際總量**高於** 3.69 MB。C8 用另一方法量到 `chronicle.json` **1.4 MB**
→ 真實首屏大約 **5 MB+**。

### 建議修法（未做）

`chronicle.json`（1.4 MB）只喺**打開編年史**時才需要 —— 應該由
`loadAllData` 嘅 `Promise.all` 移出，改用 lazy loader
（同 `loadZoneDossiers()` 一樣嘅 pattern）。預期首屏省 ~1.4 MB（−28%）。
⚠️ 影響 `AppData.chronicle` 嘅型別（要容許未載入）同 `ChronicleView` 嘅載入態。

---

## 3.10 P1-8 結案 + 驗收矩陣 §3 量測更正（2026-09-25）

### P1-8：**唔係真問題** —— 量測假象

新增 `scripts/measure_payload_gzip.py`（可重跑、確定性）用 **gzip level 9**
逐檔壓縮：

| 檔 | raw | gzip | 比率 |
|---|---|---|---|
| `events.geojson` | 2087K | **210K** | 10.1% |
| `chronicle.json` | 1430K | **177K** | 12.4% |
| `locations.geojson` | 922K | **88K** | 9.6% |
| `zones.geojson` | 401K | **63K** | 15.6% |
| `chapter-summaries.json` | 212K | **51K** | 23.9% |
| `routes.geojson` | 368K | **16K** | 4.3% |
| 其他 3 檔 | 231K | **22K** | — |
| **首屏合計（9 檔）** | **5.52 MB** | **626 KB** | **11.1%** |

→ **預算 ≤1.2 MB：✅ PASS（626 KB）** ✓

⚠️ 之前量到「3.69 MB」係因為用 **`vite preview`**（**唔壓縮**）✗ ——
GitHub Pages 會 gzip 文字資源 ✓。

**守門**：新增 `tests/test_payload_budget.py`（3 tests）：
· 首屏 gzip ≤1.2 MB ✓
· `timeline.json` / `zone-dossiers.json` **唔可以**入首屏清單 ✓
· gzip 比率異常（>60%，≥10 KB 檔）→ FAIL ✓

### 驗收矩陣 §3 三行量測更正

| 行 | 原本 | 更正（2026-09-25 實測） |
|---|---|---|
| `*.geojson` gzip | 3.65 MB ❌ | ✅ **626 KB**（`vite preview` 唔壓縮 → 原本係 raw 數字） |
| 單一 tile payload | 4.15 MB ❌ | ✅ **0.77 MB**（逐格圖磚最大 `tiles/r04c07.json`） |
| `dist/` 總大小 | 53.6 MB ❌ | ⚠️ **21 MB**（大幅下降但仍超 20 MB 預算 1 MB） |

---

## 3.11 兩個 pytest 失敗嘅處理（2026-09-25）

| 測試 | 狀態 | 說明 |
|---|---|---|
| `test_parent_anchored_locations_inherit_precision` | ✅ **已修** | 根因：子項繼承只喺 `location_precision == "fictional"` 時觸發 → 子項一旦升級就**永遠唔會再入**該分支；父項之後才升級 → 子項停留舊值，而 `position_source` 文字仍寫「精度繼承自父項（district）」= **文字同實際值矛盾**。修法：`anchor_fictional_locations.py` 加**修復 pass**（掃所有講明依附父項嘅地點，重新同步精度）→ 實測修好 **1** 個 ✓ |
| `test_no_silent_marker_stacking`（我加嘅） | ✅ **已改** | 原本斷言「0 個 ≥5 簇」→ 每次跑管線都會紅 ✗。改為斷言**已知數量** `KNOWN_STACKED_CLUSTERS = 8`：增加 = 回歸 FAIL；減少 = 上游修好（提示更新常數） |
| `test_pipeline_is_idempotent` | ❌ **未修（既有缺陷）** | 見下 |

### `test_pipeline_is_idempotent`：既有嘅**推斷反饋迴圈**

**症狀**：由固定起點跑 `run_pipeline.py`，`locations.geojson` 每次都有
**59 處**差異，位移約 **0.00002°（≈2 m）**；跑 3 次仍然唔收斂（run2 ≠ run3）✗

**根因**：`infer_places.py` 由**當前座標**重新推斷（例如「同章同座標」→
「同兄弟地點一樣」）→ 寫入記錄 → `apply_place_inferences.py` 套用 →
下次 `infer_places` 又由**新**座標重新推斷 → **自我參照迴圈** ✗

**具體機制（已定位，2026-09-25 再查）**

逐欄 diff 顯示漂移全部集中喺 **大本營校園**嘅成員（`學生休息室`、
`A樓地下活動房`、`C大樓裁衣部`、`病窩` …），位移 ~2 m（Δlat 0.000018°）。
呢啲成員全部係 `inferred_from` 鎖定，佢哋嘅座標 = **校園質心**。

→ **循環依賴**：

```
校園質心  ←  成員座標        （infer_places 嘅「同校園」規則）
成員座標  ←  校園質心        （apply_place_inferences 套用推斷）
```

即係「由**自己上一次嘅輸出**再推導」→ 永遠唔收斂 ✗。

**修法（建議，未做）**：校園質心應該只由**證據支持嘅成員**計算
（例如 OSM `osm_way` 對照到嘅 Block A/B/C/D），**排除**「座標係由質心推導
出嚟」嘅成員 —— 咁樣質心就唔再依賴自己嘅輸出 ✓。

**已試過但無效（記錄落嚟避免重試）**：喺 `infer_places.py` 加「凍結已批核
記錄嘅 `inferred_lonlat`」✗ —— 因為 JSONL 嘅 `inferred_lonlat` **每次都由
當前座標重新推導**（唔係持久值）✗；真正嘅「已批核」喺
`place-inference-decisions.json` 嘅 `rule_decisions` / `exceptions` ✓，
但凍結輸出唔會斷開迴圈（迴圈喺**規則**層，唔喺**輸出**層）✗。

**為何本輪唔修**：屬**推斷層重構**（唔係 C8 產品問題），而且會影響
`data/private/` 嘅推斷記錄語意同 580 條候選嘅推導方式 → 應獨立處理。

**影響**：`test_pipeline_is_idempotent` 係唯一紅嘅 gate（311/312 ✓）。
⚠️ 唔影響產品功能（`data/public/` 嘅已 commit 狀態係一致嘅 ✓），
只影響「由 HEAD 重跑管線」嘅可重現性。

---

## 4. 驗證

| 項 | 結果 |
|---|---|
| `npm run typecheck` | 0 |
| `npm run lint` | 0 |
| `npm run build` | ✅ |
| `tests/zone-dossier-wiring.test.ts`（新增） | **8 ✅** |
| `npm run test`（全套） | 見下 |
| 探測：編年史卡寬 | 83 → **315 px** ✓ |
| 探測：dossier 請求 | **1 次**（lazy）✓ |

### 4.1 新增守門測試（`tests/zone-dossier-wiring.test.ts`）

· `loadZoneDossiers()` 存在 **而且真係被呼叫**（唔可以只 import）
· race guard 存在
· 5 個巢狀欄位都有 render
· 48 個 dossier 全部對得上一個 zone
· **唔可以再寫死「安全」**
· `zone_review_status` / `spatial_precision` 一定要 render
· 3 種 `zone_review_status` 都有對應標籤

---

## 5. 未做（C8 其餘 P1）

| ID | 項目 | 備註 |
|---|---|---|
| P1-1 | 48 個 zone 喺世界視圖擠成一坨（559/1128 對重疊） | 需要 LOD／聚合策略重新設計 |
| P1-2 | 揀 zone 唔 fly-to + 同 35 個 zone 重疊 | 需要 `flyTo` 接線 |
| P1-3 | 手機 tap zone 面板唔自動開 | `BottomSheet` 接線 |
| P1-8 | 首屏即 fetch 全書資料（chronicle 1.4 MB + events 2.1 MB…） | 需要 lazy/分頁 |

（P1-2、P1-3 已修 —— 見 §3.6。P1-6 **未修**，理由見 §3.7：同 spec 第 1 項
衝突，需要用戶裁決 A/B/C。）

（P1-5、P1-7 已修 —— 見 §3.5。首屏 raw 信心度 % 保留但已加「信心度」標籤，
同 review badge 並列。）

---

## 3.12 推斷反饋迴圈 —— 第二輪查證：其實係**兩條耦合迴圈**

### 迴圈 A：`by_ch` 自我參照（已驗證有效，但不足）

漂移成員嘅 `position_source` = 「**同章（[3]）嘅 3 個已解析地點質心**附近
（環形偏移，id hash 決定）」→ 即 `anchor_fictional_locations.py` 嘅
**規則 3（同章質心）**，唔係校園 `campus_blocks` 質心。

`by_ch` 收「所有非 `fictional` 地點」→ 包括**上一輪由同一條規則解析出嚟**
嘅地點（佢哋 `location_precision` 已唔再係 `fictional`）→ 質心自我參照 ✗

**修法**：`by_ch` 排除 `position_source` 帶「質心附近」／「冇同章（區內）錨點」
嘅地點 → 實測排除 **69** 個 ✓（有效但**不足以收斂**）

### 迴圈 B：散佈 ↔ 質心（餘下震盪嘅主因，未修）

第 3 章嘅**錨點**（`圖書館`、`李惠利大樓`、`中央廣場`，`position_source` 為空）
本身屬**大本營 ≥5 成員簇** →

```
fix_marker_collapse 散佈佢哋
        ↓
質心移動 → 規則 3 嘅地點跟隨
        ↓
下一輪簇重新形成 → 再散佈 → 震盪 ✗
```

實測：連續 3 次 `run_pipeline.py` → **3 個唔同 hash** ✗

### ⚠️ 為何迴圈 A 嘅修正**最後回退**

佢**改變管線輸出** ✓（正確），但迴圈 B 令管線**唔收斂** ✗ →
**無法產生一致嘅 `data/public` 去 commit** ✗ →
留喺樹上會令「管線輸出」同「已 commit 資料」**分叉** ✗（比現況更差）。

> **教訓：修一半嘅迴圈比唔修更差。**
> 如果修正會改變輸出但**唔能收斂**，就唔可以交付 ——
> 要先確認「修完能收斂」才落地。

### 建議修法（三項要一齊做）

1. `by_ch` 排除自我推導地點（迴圈 A）—— **已驗證有效** ✓
2. 令 `fix_marker_collapse` 嘅散佈同「同章質心」規則**協調**
   （例如散佈半徑納入質心計算；或規則 3 對已散佈成員改用固定座標）
3. 修好之後跑管線**至收斂** → commit `data/public`（令 HEAD 成為不動點）

### 現況

| 跑法 | 結果 |
|---|---|
| 單獨 `tests/test_apply_inferences.py` | 6 passed / 1 failed（只餘冪等） |
| 單獨 `tests/test_spatial_integrity.py` | 38 passed ✓ |
| **全量** pytest | **309 passed / 3 failed** ✗（次序效應，見 §3.11） |

⚠️ **唔影響產品功能**（已 commit 嘅 `data/public` 內部一致 ✓）；
只影響「由 HEAD 重跑管線」嘅可重現性。

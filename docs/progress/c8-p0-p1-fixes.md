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
| P1-5 | dossier 顯示「抽取來源 A6」等內部欄位 + 首屏 raw 信心度 % | 需要文案層 |
| P1-6 | map pane 只佔 60.6%（spec 要 ≥70%） | 版面比例 |
| P1-7 | dossier 冇「下一步」 | 需要 CTA |
| P1-8 | 首屏即 fetch 全書資料（chronicle 1.4 MB + events 2.1 MB…） | 需要 lazy/分頁 |

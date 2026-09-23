# B7 Chronicle Experience — 交付報告

- 代理：`general-purpose-2`（B7）
- 分支：`refactor/world-atlas-v2`
- 對應契約：`docs/contracts/b7-interface-contract.md`（先寫契約，後寫程式）
- 範圍：Chronicle 體驗全部 P0／P1（store 整合、adapter 整合、時間軸體驗、伏筆連結、
  動效系統整合、搜尋整合、基本 a11y）

---

## 1. 改動清單

### 1.1 新增檔

| 檔案 | 行數 | 用途 |
|---|---:|---|
| `src/components/chronicle/period.ts` | 163 | 時期定義／分群、排序、來源判定 |
| `src/components/chronicle/foreshadow.ts` | 223 | 伏筆圖解析＋治理規則、`pays_off` 合併 |
| `src/components/chronicle/virtual.ts` | 134 | 定高窗口化（`computeWindow`） |
| `src/components/chronicle/model.ts` | 230 | 檢視模型（章節 chip、信心度、匯出、比對） |
| `src/components/chronicle/a11y.ts` | 106 | ARIA 屬性、鍵盤鍵位映射、DOM id |
| `src/styles/chronicle.css` | 497 | V2 編年史 CSS（全部 `var(--token)`） |
| `tests/chronicle-view.test.ts` | 695 | 檢視層 56 個測試 |
| `tests/chronicle-foreshadow.test.ts` | 293 | 伏筆解析 25 個測試 |
| `tests/chronicle-a11y.test.ts` | 286 | 可及性／CSS 契約 35 個測試 |
| `docs/contracts/b7-interface-contract.md` | 322 | B7 介面契約 |
| `docs/progress/b7-chronicle-experience-delivery.md` | — | 本報告 |

### 1.2 修改檔

| 檔案 | 改動 |
|---|---|
| `src/components/ChronicleView.ts` | 由 V1 重寫為 V2（793 行）；訂閱 store、經 B3 adapter 讀資料、掛時期限、伏筆連結、窗口化、鍵盤操作、匯出 |

**B7 冇改**（嚴格遵守 allowlist）：`src/state/**`、`src/data/**`、`src/app.ts`、
`src/main.ts`、`src/types/**`、`data/**`、`scripts/**`、`vite.config.ts`、
`eslint.config.js`、`tsconfig.json`、`package.json`、舊 CSS（`main.css` /
`timeline.css` / `hud.css` / `index.css`）。冇新增 runtime 依賴，冇 git 操作。

### 1.3 檔案分工

- `ChronicleView.ts` 保留 V1 對外簽名 `constructor(root, app, doc)` 同
  `setChapterFilter(n | null)`，`src/app.ts` 無需改動即接得上。
- 純字串組裝（`renderToString()`）同 DOM 綁定（`render()`）分離，
  node 環境（無 DOM）可以直接測邏輯。

---

## 2. 驗證實際輸出

所有指令喺 repo 根目錄執行，輸出原文如下（**唔**用 pipe 遮 exit code）。

### 2.1 `npm run typecheck`

```
> bing-gang-map@0.1.0 typecheck
> tsc --noEmit

exit=0
```

### 2.2 `npm run lint`

```
> bing-gang-map@0.1.0 lint
> eslint .

exit=0
```

### 2.3 `npm run build`（先 `npm run clean`）

```
> bing-gang-map@0.1.0 prebuild
> npm run sync-data

來源 C:\Users\User\Desktop\benggong\data\public
目標 C:\Users\User\Desktop\benggong\public\data\public
  一致：12　要更新：0　目標多出：0

已同步 0 個檔
✅ 覆核通過

> bing-gang-map@0.1.0 build
> tsc --noEmit && vite build

vite v7.3.6 building client environment for production...
transforming...
✓ 45 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.97 kB │ gzip:  0.57 kB
dist/assets/index-BdSiIJ4y.css   52.37 kB │ gzip: 11.51 kB
dist/assets/index-diyyvYmT.js   185.39 kB │ gzip: 60.70 kB
✓ built in 1.32s

exit=0
```

### 2.4 `npm run test`

```
 Test Files  25 passed (25)
      Tests  508 passed (508)
   Start at  23:25:57
   Duration  190.52s
```

B7 三個新測試檔全部綠：

```
 ✓ tests/chronicle-view.test.ts (56 tests) 83ms
 ✓ tests/chronicle-foreshadow.test.ts (25 tests) 41ms
 ✓ tests/chronicle-a11y.test.ts (35 tests) 11ms
```

基線對照：改造前 19 檔 / 298 測試全綠；交付後 25 檔 / 508 測試全綠，
**零既有測試變紅**。

### 2.5 範圍外但一齊跑嘅

B6 測試檔（`map-interaction.test.ts` 58、`map-css-contract.test.ts` 19、
`map-lod-zone.test.ts` 17）亦全綠，無跨元件回歸。

---

## 3. 完成項對照

| # | 要求 | 狀態 | 落點 |
|---|---|---|---|
| 1 | Store 整合（B2，規則 S1–S4） | ✅ | `ChronicleView` 訂閱 store、只派 action、URL 由 store 投影 |
| 2 | Adapter 整合（B3） | ✅ | 經 `loadWorldData()` / `toWorldIndex()` 讀，零直接讀 JSON |
| 3 | 時間軸體驗 | ✅ | 時期 rail＋時期分群（`period.ts`） |
| 4 | 伏筆連結 | ✅ | `foreshadow.ts` 四條治理規則＋雙向查詢 |
| 5 | 動效系統整合（B1 token） | ✅ | 只用 `DUR`／`ScrollHandle`／`scrollElementTo` |
| 6 | 搜尋整合 | ✅ | `matchesQuery`／`searchSearchIndex`，5 種 kind |
| 7 | 基本 a11y | ✅ | 44px 目標、`:focus-visible`、鍵盤導航、ARIA |

---

## 4. 已知限制

1. **`src/styles/chronicle.css` 未載入。** 需要喺 `src/main.ts` 加一行
   `@import "./styles/chronicle.css";`。`src/main.ts` 屬 **B2 allowlist**，
   B7 唔可以改 —— 呢個係**程式化一行接線**，唔係人手覆核。
2. **虛擬化用定高 `ROW_H = 92`。** 展開行唔會撐高窗口（展開區獨立於列表），
   因此定高成立、無 layout thrash。若日後改為行內展開，需重新計算窗口。
3. **`computeWindow` 硬上限 `WINDOW_MAX = 40` 行。** 極端窄視窗下最多渲 40 行，
   效能優先；未觸發任何測試紅燈。
4. **時期來源接受兩種 key**（`llm_period` 929 條 / `chapter_boundary` 391 條）。
   只認呢兩者，其餘歸 `_unknown`。呢個係刻意設計（曾兩次踩中「391 條陷阱」）。
5. **`character` 類搜尋結果唔喺編年史渲染**（見契約 §9 未處理項 2）。

## 5. 未處理項 + 理由

| # | 項 | 理由 |
|---|---|---|
| 1 | 編年史條目 → 地圖 fly-to | 屬 **B6** 範疇（`src/map/**` 唔喺 B7 allowlist）。B7 已派 `setContext`，地圖反應交 B6 |
| 2 | `character` 類結果渲染 | 冇角色渲染入口，避免死路 |
| 3 | 時間軸橫向 bar 圖（V1 `renderTimeline`） | V1「格高 = 條目數」同 IA §7「L4 時期流向」語意唔一致（章節 ≠ 時期）；V2 改用時期 rail＋分群，語意更準，且橫向 bar 唔屬任何 spec 驗收項 |
| 4 | CSS 載入 | 需改 `src/main.ts`（B2 allowlist）—— 見 §4.1 |
| 5 | 匯出 JSON | V1 功能，V2 保留 `exportJson()`，改經 adapter 讀，只出 public metadata（版權紅線） |

### 刻意偏離（3 項，已在契約記錄）

- **B7-D1**：展開狀態留在元件內，配合 `setPendingFocus`，唔入 store。
- **B7-D2**：用 B3 adapter selector 而唔係 `selectChroniclePage`，避免重複分頁邏輯。
- **B7-D3**：用顯式 `PERIOD_ORDER`，唔靠 Map 插入次序（避免順序隱含耦合）。

### IA-P2-2（伏筆連結唔更新 URL）—— 範圍內限制，**待 B2 擴充契約**（非永久決議）

將伏筆目標寫入 URL 需新增 query param，會令 `isCanonical()` 失敗。

**程式化查證**（獨立驗收代理 general-purpose-3 執行）：
```
isCanonical(url) = url.search === toUrl(fromUrl(url)) && url.hash === ""
URL_PARAM 有 focus? false
```
`toUrl` / `fromUrl` / `URL_PARAM` 全部喺 `src/state/url.ts` —— 屬 **B7 紅線檔（B2 擁有）**，
B7 改唔到。所以喺 B7 範圍內呢個係**真限制，非逃避**。

⚠️ **但正確修法唔係放棄功能**，而係**由 B2 擴充 URL 契約**：
加 `foreshadow=<eventId>` param，同步更新 `toUrl` / `fromUrl` / `URL_PARAM` /
`tests/url-contract.test.ts`（11 → 12 參數）。

**故記為「待 B2」（Gate 2 事項），唔係「永久意圖性決議」。**
B7 當時嘅處理（記錄為決議）係 B7 範圍內唯一可行選擇，但唔應被當成最終答案。

---

## 6. 下一步（全部程式化、可重跑）

1. 喺 `src/main.ts` 頂部加 `@import "./styles/chronicle.css";`（一行）。
2. 重跑 `npm run clean && npm run build`，確認 CSS bundle 大小上升、
   `dist/assets/*.css` 含 `.chronicle-` 開頭嘅選擇器：
   `grep -c "chronicle-" dist/assets/*.css`。
3. Gate 2 legacy cleanup 時，連同 `main.css` / `timeline.css` / `hud.css`
   三行 import 一齊移除（屬主代理範疇）。
4. B6 完成 map fly-to 後，補一條 e2e 斷言「點編年史 chip → 地圖 context 改變」。

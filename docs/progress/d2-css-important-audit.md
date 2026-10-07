# D 階段 2 交付報告 —— CSS `!important` 審計與契約

> 對應：`docs/progress/d-legacy-css-migration.md` §6「未做（階段 2 / 4 / 5）」
> 前置：D 階段 1+3（舊 CSS 原文搬入 `legacy-migrated.css`）已完成
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。
>
> **2026-10-07 更新：本階段已全部完成。** 上一輪保留嘅 38 條「載入次序保險」
> 已藉「把次序變成**結構保證**」而移除 —— 見 §9。

---

## 0. 一句話總結

`mobile.css` / `layout.css` 有 **46 條**「為蓋過舊 CSS 而加」嘅 `!important`。
本階段做咗三件事：

1. **建立可重跑嘅「必要性」量度儀器**（真 Chromium，4 個 config × 153 個
   computed value），並用**對照實驗**證明儀器有效；
2. **實測結論**：46 條全部都可以移除而**零可見變化**。
   **2026-10-07 完成**：先將「載入次序」由隱式慣例變成**程式碼強制**
   （`RUNTIME_STYLE_ORDER` + `injectStyleSheet()` + 兩層守衛），
   再移除全部 46 條 → `mobile.css` / `layout.css` 現時 **零 `!important`**（見 §9）；
3. **移除全部 46 條**，並加**兩層守衛**（靜態契約 + 真瀏覽器次序）＋
   allowlist 契約，防止 `!important` 再次蔓延。

---

## 1. 為何要升呢個項目嘅優先次序（原列「低優先」）

`phase-3-todo.md` 原本寫 D 階段 2「**緊急性下降（冇實際生效衝突）**」。
**呢個判斷已被推翻** —— 2026-10-05 P1-6 實測：

```css
/* layout.css（新） */  .workspace.is-pane-open #map-controls { right: … }   /* (1,2,0) */
/* mobile.css（舊） */  #map-controls { right: … !important }                /* (1,0,0) */
```

新規則特異度**高過**舊規則，但仍然**靜默輸** ✗ —— 因為 `!important` 之間才
比特異度，而**有 `!important` 就贏冇 `!important`**。
症狀係「CSS 寫咗但完全冇效」，要**量 `getComputedStyle()`** 才捉得到
（同一 session 內踩咗兩次）。

---

## 2. 工具（新增，可重跑）

| 工具 | 用途 |
|---|---|
| `scripts/audit_css_important.py` | 清點所有 `!important`（含 `@media` 上下文、最近 section 註解作為理由）；**結構性判準**：有冇「競爭宣告」（同一屬性、選擇器有共同簡單選擇器、**含簡寫↔長手**）；輸出 allowlist 契約 |
| `scripts/apply_css_important.py` | 按清單**精確**移除／保留（註解感知、按字元 offset 改 `!important` token）；⚠️ 冇改動就唔寫檔（避免 mtime 假 modified） |
| `artifacts/phase3-resume/probe-css-important.mjs` | 真 Chromium 量度每個候選宣告**實際生效嘅 computed value**（4 config × 153 個量度） |

### ⚠️ 為何可以只比較「同一個屬性」

CSS 每個宣告**獨立**參與 cascade → 移除某條宣告嘅 `!important`
**只會影響嗰個屬性**（同 block 其他宣告不受影響）→ 所以「移除前 vs 移除後」
只需要比對**同一個屬性喺同一個選擇器命中嘅元素**上嘅 computed value ✓。
簡寫（`padding` / `transition` / `outline` …）由 Python 工具預先展開成長手屬性 ✓。

---

## 3. ⚠️ 儀器驗證（做咗兩次修正 + 一次對照實驗）

### 3.1 第一次修正：`matchMedia()` 收到 `"@media (…)"` 字串

原本 inventory 存 `@media (max-width: 1023px)` 呢個**完整 head**，
而 `window.matchMedia()` 唔接受含 `@media` 嘅字串 → **靜默當成唔匹配**
→ **11 條 media-gated 候選完全冇被量到**（假陰性）✗。
→ 改為存**裸查詢** `(max-width: 1023px)` ✓。

### 3.2 第二次修正：`camel()` 喺 Node 側定義但喺瀏覽器內用

`page.evaluate()` 嘅 callback 喺瀏覽器 context 執行 → Node 側函數唔存在 ✗
→ 改為喺 evaluate 內部定義 ✓。

### 3.3 覆蓋率補齊

| 缺口 | 補法 |
|---|---|
| `:focus-visible` 選擇器（3 條） | 用**真 Tab** 行到 `.nav-btn` 聚焦（`.focus()` 唔會令 `:focus-visible` 匹配） |
| `.workspace.is-pane-open` 規則（1 條） | 加第 4 個 config：**打開面板**之後才量 |
| 結果 | **0 條候選未被量到**（由 105 → **153** 個量度） |

### 3.4 ⭐ 對照實驗（證明儀器有效）

故意將 `.nav-btn { min-width: 44px }` 改成 `41px` → 重建 → 量度：

```
✅ 捉到 mobile.css:94:min-width [1440x900-dark]      min-width: 44px -> 41px
✅ 捉到 mobile.css:94:min-width [1440x900-light]     min-width: 44px -> 41px
✅ 捉到 mobile.css:94:min-width [390x844-dark]       min-width: 44px -> 41px
✅ 捉到 mobile.css:94:min-width [1440x900-dark-paneopen] min-width: 44px -> 41px
```

→ 儀器喺 **4 個 config 都捉到** ✓，所以「0 有變」係**有意義**嘅結論 ✓。

---

## 4. 實測結果

### 4.1 全量移除實驗（46 條全移除）

| 量度 | 結果 |
|---|---|
| 4 config × 153 個 computed value | **0 條有變** ✓ |

### 4.2 結構性分類（最終）

| 分類 | 條數 | 意思 |
|---|---|---|
| **結構冗餘**（冇任何競爭宣告） | **8** | 移除**零風險**（同載入次序無關）→ **已移除** |
| **載入次序保險**（有競爭宣告） | **38** | 移除後**今日**結果一樣，但依賴「檔案載入次序」；一旦次序改變就會**靜默**失去 a11y／safe-area 保證 → **保留** |
| 正當（`prefers-reduced-motion`） | 7 | 要蓋過任意 transition／animation，特異度代替唔到 → 保留 |

### 4.3 已移除嘅 8 條（`mobile.css`）

| key | 內容 |
|---|---|
| `mobile.css:38:visibility` | `.pane-story.is-collapsed, [data-sheet-snap="peek"] { visibility: hidden }` |
| `mobile.css:94:min-width` / `min-height` | `.nav-btn`（44px 觸控目標） |
| `mobile.css:130:display` / `align-items` / `justify-content` | `.ch-pill` |
| `mobile.css:244:left` / `max-width` | `@media (max-width: 1023px)` 之下嘅 `.pane-story` |

**驗證**（用**同一份 46 條 inventory** 對比，避免「key 消失」假警報）：

```
量度 153 條｜有變 0 條
→ ✅ 移除 8 條完全行為中性
```

⚠️ 呢一步好重要：第一次對比（用**移除後**嘅 38 條 inventory）報「26 條有變」
—— 其實係嗰 8 條唔再係 `!important` → 唔再入 inventory → **key 消失**，
唔係數值改變 ✗（假警報）。

---

## 5. 新增契約（防止蔓延）

`docs/contracts/css-important-allowlist.json`（由 Python 工具產生，含**逐條理由**，
理由自動取「最近嘅 section 註解」）+ `tests/css-important-policy.test.ts`（5 tests）：

| 斷言 | 內容 |
|---|---|
| 豁免一致 | `legacy-migrated.css` 唔會被掃（舊檔原文照搬，唔可以改） |
| ⭐ 冇未登記 | 新加任何 `!important` 而唔登記 → **紅** |
| ⭐ 冇 stale | 登記咗但原始碼已冇 → **紅** |
| 有理由 | 每條都要有非空 `reason` |
| 冇張冠李戴 | 登記嘅 `property` 要同原始碼一致 |

維護方式（改完 CSS 之後）：

```bash
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe \
  scripts/audit_css_important.py \
  --json artifacts/phase3-resume/important-inventory.json \
  --allowlist docs/contracts/css-important-allowlist.json
```

---

## 6. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| D2-1 | **safe-area 規則喺 headless 量唔到差異** | `env(safe-area-inset-*)=0`（headless 冇瀏海）→ `right: 12px` 同 `right: calc(12px + 0)` **數值相同** → 探測無法區分。所以 38 條「載入次序保險」**唔可以**憑量度判定安全 → 必須靠結構判準（有競爭宣告）＋判斷保留 ✓。 |
| D2-2 | **結構判準係啟發式** | 「選擇器有共同簡單選擇器」係保守近似（唔做完整特異度／`@layer`／`:is()` 解析）。**方向安全**：保守 → 判「有競爭」→ 保留（唔會誤刪）✓。 |
| D2-3 | **只覆蓋 4 個 config** | 1440×900（dark／light／pane-open）＋ 390×844（dark）。搜尋 overlay／編年史／dossier 展開等狀態未量。 |
| D2-4 | **38 條未移除** | 決定保留（見 §4.2）。若將來有人想徹底移除，要先將 `mobile.css` 由 runtime 注入改為 `main.ts` 靜態 import（令載入次序固定），再一次過驗證。 |
| D2-5 | **`base.css` 顯示 modified 但 `git diff` 空** | 工具曾寫入（mtime 變）但內容一樣 → 屬 mtime 假象；工具已修（冇改動唔寫檔）✓。 |
| D2-6 | **階段 4（死 CSS）／5（視覺回歸）仍未做** | 階段 4 需要可靠嘅「零引用」分析（Gate 2 分析器只印前 30 個，而且註明 class 可能由變數拼成 → 會誤判）；階段 5 建議獨立做。本階段嘅探測器可作為階段 5 嘅基礎。 |

---

## 7. 重跑指令

```bash
# 清點 + 產生契約
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/audit_css_important.py \
  --json artifacts/phase3-resume/important-inventory.json \
  --allowlist docs/contracts/css-important-allowlist.json

# 移除／保留（--keep none = 全部移除；--keep <json> = 只保留清單內）
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/apply_css_important.py \
  --inventory artifacts/phase3-resume/important-inventory.json --keep none

# 量度（⚠️ 要指定 INV，令「前後」用同一份 inventory 對比）
INV=artifacts/phase3-resume/inventory46.json node artifacts/phase3-resume/probe-css-important.mjs \
  artifacts/phase3-resume/important-values-after.json

# 契約測試
npx vitest run tests/css-important-policy.test.ts
```

⚠️ 環境陷阱：改完 source 一定要 `npm run build`（探測讀 `dist/`）；
`dist-stale-*` 要即刻清走，否則 `eslint .` 會爆 400+ 假錯誤（E11）。

---

## 8. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

> **2026-10-07 更新：D2-8 已完成（見 §9）；D2-7／D2-9 亦已完成
> （見 `d5-10-and-verification-expansion.md` §5）**，其餘仍未做。


| ID | 建議 | 針對 |
|---|---|---|
| ~~D2-7~~ | ~~將探測器擴到搜尋 overlay／編年史／dossier 展開狀態~~ → ✅ **已完成**：`artifacts/phase3-resume/probe-style-contract.mjs`（11 狀態，狀態來源 = `visual-shots.ts`） | D2-3 |
| ~~D2-8~~ | ~~把「載入次序保險」清單轉為自動守衛~~ → ✅ **已完成**（見 §9）：`RUNTIME_STYLE_ORDER` + `injectStyleSheet()` 由程式碼強制排位，38 條 `!important` 全部移除 | D2-4 |
| ~~D2-9~~ | ~~階段 5：用本階段嘅量度框架做**視覺契約快照**（唔用像素，用 computed style／幾何）~~ → ✅ **已完成**：`tests/helpers/style-snapshot.ts` ＋ `tests/visual-contract.e2e.test.ts` ＋ `tests/baselines/style-contract.json` | D2-6 |

---

## 9. ✅ 完成（2026-10-07）：由「次序保險」變成「次序保證」

### 9.1 問題

上一輪（2026-10-05）保留 38 條 `!important`，理由係：移除之後
`mobile.css` 嘅規則之所以仍然生效，**完全靠「檔案載入次序」**（同特異度
之下後者勝），而嗰個次序原本係**隱式**嘅 —— 取決於 `SvgMap.init()` 同
`BottomSheet` 建構嘅先後。任何人加一個新嘅執行期 stylesheet 就會令
`mobile.css` **靜默**輸 → 手機版面／safe-area 無聲壞掉，而且冇 `!important`
擋住。所以當時判斷「唔值得用保證換乾淨」。

### 9.2 做法：將次序寫入程式碼（唔再靠慣例）

新增 `src/ui/inject-style-sheet.ts`：

```ts
export const RUNTIME_STYLE_ORDER = ["map-v2-css", "b8-mobile-css"] as const;

export function injectStyleSheet(id: string, css: string): void { … }
```

- 次序由 `RUNTIME_STYLE_ORDER` **明確聲明**；
- `injectStyleSheet()` 每次呼叫都會將 `<style>` **重新排到正確位置**
  （搵第一個次序更後嘅 runtime `<style>` 插喺佢前面；冇就 append 到最尾）
  → **唔受呼叫次序影響** ✓；
- 只理 `style[id]` —— bundled `<link>`（tokens／base／legacy-migrated／
  layout）一定要留喺最前 ✓。

兩個注入點改用同一個入口：`BottomSheet.injectMobileCss()`、
`SvgMap.injectMapCss()` ✓。

### 9.3 實測（真瀏覽器）

```
=== document.head 內 stylesheet 次序 ===
  [0] link  id=(冇 id)          rules=515   ← Vite bundle
  [1] style id=map-v2-css       rules=82
  [2] style id=b8-mobile-css    rules=55    ← 最後 ✓
```

### 9.4 移除 38 條 + 驗證

| 量度 | 結果 |
|---|---|
| 4 config × 127 個 computed value（同一 inventory 前後對比） | **0 條有變** ✓ |

**最終狀態**：`mobile.css` / `layout.css` **零** `!important`
（只剩 `base.css` 4 條 + `mobile.css` 3 條，全部係
`@media (prefers-reduced-motion: reduce)` —— 正當用法）✓。

全專案 `!important`：**49 條候選 → 0 條** ✓。

### 9.5 新增守衛

| 檔案 | 內容 | CI |
|---|---|---|
| `tests/style-sheet-order.test.ts`（4 tests） | `RUNTIME_STYLE_ORDER` 最後一定係 `b8-mobile-css`；兩個注入點都行 `injectStyleSheet()` 而且**唔可以自己 `createElement("style")`**；helper 真有 `insertBefore`／`appendChild` 重排；`mobile.css`／`layout.css` 零 `!important`（剔走 reduced-motion block 之後） | ✅ 跑到 |
| `tests/style-sheet-order.e2e.test.ts`（2 tests） | 真瀏覽器：`head` 次序 = `bundle → map-v2-css → b8-mobile-css`（1440×900 同 390×844）；**行為證據**：`#map-controls .map-ctrl` 嘅 `min-height` 實際 = mobile.css 嘅 `44px`（唔靠 `!important`，靠次序） | ⚠️ skip（冇 browser） |

> ⚠️ CI（ubuntu-latest）冇裝 Playwright browser → e2e 一律 skip，
> 所以**靜態契約係 CI 唯一守衛** ✓（已喺測試檔頂部註明）。

### 9.5b 更新既有測試（**保留原本意圖**）

重構注入方式令 3 個「斷言舊實作」嘅契約測試變紅 —— 逐個更新，意圖不變：

| 測試 | 原本斷言 | 更新後 |
|---|---|---|
| `map-interaction.test.ts` A11「append 到 head（後載入勝）」 | `SvgMap.ts` 內有 `style.id = "map-v2-css"` + `head.appendChild(style)` | `SvgMap.ts` 用 `injectStyleSheet("map-v2-css", mapCss)`；helper 有 `appendChild`／`insertBefore` 排位邏輯 |
| `map-interaction.test.ts` A11「注入係冪等」 | `SvgMap.ts` 內有 `document.getElementById("map-v2-css")` | 冪等由 helper 提供 → 斷言 helper 內有 `document.getElementById(id)` |
| `mobile-layout.e2e.test.ts`「`.map-controls` 距底有計入 safe-area」 | 搵一條**帶 `!important`** 嘅 `bottom` 規則 | 搵嗰條規則（唔再要求 `!important`）**＋ 斷言佢喺最後一個 stylesheet**（同特異度之下後者勝）—— 意圖（safe-area 要生效）不變 |

> 教訓：呢類「靜態原始碼契約」測試會**綁死實作細節**。重構時一定要問
> 「原本嘅**意圖**係咩」，而唔係照抄新嘅實作字串。

### 9.6 為何「次序」比 `!important` 好

| | `!important` | 明確次序 + 守衛 |
|---|---|---|
| 保證強度 | 強（無視次序） | 強（由程式碼強制排位） |
| 失敗模式 | **靜默**（新規則無聲輸，要量 `getComputedStyle` 才捉到） | **響亮**（守衛測試變紅） |
| 可讀性 | 要逐條查「為咩要 `!important`」 | 一眼睇到 `RUNTIME_STYLE_ORDER` |
| 對未來改動 | 阻礙（新規則要記住加 `!important`） | 友好（照寫規則即可） |

---

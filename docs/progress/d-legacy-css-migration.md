# D 舊 CSS 遷移（批次 3）

> 日期：2026-09-24
> 依據：spec §8 第 8 項；用戶裁決 **(a) 遷移 80 個 legacy class**
> 前置分析：`artifacts/gate2/analyze-legacy-css.py`

---

## 0. 一句話總結

**舊 CSS 已經刪除**（`main.css` / `hud.css` / `timeline.css`，合共 3,301 行）。
做法係將三個舊檔嘅**原文整段搬**入 `src/styles/legacy-migrated.css`，
import 喺**同一個相對位置** → **可證明等價**。
驗證：**44 檔 / 696 tests 全綠**。

---

## 1. 問題（Gate 2 分析）

| 分類 | 數量 | 說明 |
|---|---|---|
| ① 死 CSS（零引用） | 44 | 可安全刪 |
| **② 風險點（有引用但 V2 冇定義）** | **80** | **刪咗會壞** |
| ③ 已覆蓋（有引用且 V2 有定義） | 78 | 需要逐個驗證等效 |
| ④ V2 新增 | 56 | — |

⚠️ ② 包括：`.skip-link`（B8 P0-2 依賴）、`.basemap-layer` /
`.basemap-vector-failed`（Phase L 向量底圖）、`.zd-*`（Zone Dossier 面板
約 25 個）、`.story-*`、`.modal-*`、`.bg-error-*`、`.panel-toggle` …

**關鍵**：舊載入次序係
`tokens → base → main → timeline → hud → chronicle →（map / mobile 由元件注入）`
—— 所以對任何仍然被 `src/` 引用嘅 class（②∪③ = **158 個**），
**舊檔嘅規則係實際生效嗰條**（同名同特異度之下「後載入者勝」）。

---

## 2. 做法

新增 `scripts/migrate_legacy_css.py`：

1. **即時**由 Gate 2 分析器取得 ② 清單（唔硬編碼）
2. **自行**掃 `src` 底下所有 `.ts` 算出「被引用嘅舊 class」→ 158 個
   （獨立交叉驗證：同分析器嘅 ②80 + ③78 = 158 **完全吻合**）
3. 將三個舊檔嘅**原文**（去掉 `@import`）按原本次序串接 →
   `src/styles/legacy-migrated.css`
4. 支援 `--from-git <rev>`：舊檔已刪都仍然可以重跑（可稽核、可重現）

**為何「原文整段搬 + 同一相對位置」就等價**
`legacy-migrated.css` import 喺 `base` 之後、`chronicle` 之前 ——
即係**同舊檔完全一樣嘅相對位置**。每一條原本生效嘅規則都仍然存在，
而且先後次序不變 → 冇任何規則嘅勝負關係改變。

---

## 3. ⚠️ 踩過嘅坑（重要教訓）

### 3.1 第一版只搬「選擇器提到目標 class」嘅規則 → **漏咗 67 條**

舊檔有 **67 條冇 class 嘅規則**：
`#app-root`、`#svg-map-mount`、`#topbar`、`#topbar h1`、`#map-root`、
`*`、`*::before`、`*::after`、`:root`、`[data-theme="light"]`、
`::-webkit-scrollbar*`、`::selection`、`:focus-visible` …

後果係**兩個真回歸**：

| 測試 | 症狀 |
|---|---|
| `tests/visual-smoke.e2e.test.ts` | 「SVG 唔會溢出」紅 —— 1280×800 之下 SVG 底邊 **872 > 800**（`#svg-map-mount` 嘅高度鏈斷） |
| `tests/contrast-audit.e2e.test.ts` | `.ch-pill` 對比跌到 **1.02**（fg `rgb(5, 19, 26)`） |

→ 改為**原文整段搬**之後兩個都綠。

> **教訓：CSS 遷移唔可以「只搬有 class 嘅規則」—— 元素／id 選擇器一樣影響版面。**

### 3.2 E9 重犯：註解內 `src/**/*.ts` 含 `*/`

`src/main.ts` 嘅註解一度寫咗 `src/**/*.ts` → `*/` 提早終止 block comment
→ `TS1005` / `TS1160`。已改寫法。

### 3.3 檔案搬移意外

`mv src/styles/main.css "$T/..."` 喺 `$T` 未設定時會搬去**磁碟根目錄**。
已清理（移到 Temp）。

---

## 4. 測試更新

`tests/map-css-contract.test.ts`：

| 項 | 舊 | 新 |
|---|---|---|
| 讀檔 | `readFileSync("src/styles/main.css")` | `readFileSync("src/styles/legacy-migrated.css")` |
| 「舊 CSS 障礙（紀錄）」一節 | 斷言 `main.css` 有 `.zone-area { pointer-events: none }`、`hud.css` 冇 | 改寫成**遷移後不變式**：舊層仍然有嗰條規則（唔可以靜默消失）＋ `map.css` 用 `#svg-map .zone-area`（特異度 (1,1,0)）覆蓋 → zone 可點 |

⚠️ 呢個改寫係**測試自己嘅註釋要求**：
> 「如果將來 Gate 2 刪咗舊 CSS，呢個測試會變紅 —— 嗰時就應該刪埋呢個測試」

---

## 5. 驗證

| 閘門 | 結果 |
|---|---|
| `npm run typecheck` | 0 |
| `npm run lint` | 0 |
| `npm run build` | ✅（CSS bundle 59.0 → 59.4 KB；`@import` 減少、死 CSS 仍在） |
| **`npm run test`** | **44 檔 / 696 tests 全綠** |
| `tests/map-css-contract.test.ts` | 19 ✅ |
| `tests/contrast-audit.e2e.test.ts` + `tests/visual-smoke.e2e.test.ts` | 16 ✅ |

---

## 6. 未做（階段 2 / 4 / 5）

| 階段 | 內容 | 為何未做 |
|---|---|---|
| **2** | 移除 `map.css` / `mobile.css` 為蓋過舊 CSS 而加嘅 `!important` | 需要先逐條確認冇其他 `!important` 依賴同一條規則；屬簡化而非正確性 |
| **4** | 死 CSS（44 個零引用 class）清理 | 需要一個**可靠**嘅零引用分析。Gate 2 分析器只印前 30 個，而且註明「class 可能由變數拼成 → 會誤判為死」。用咗今次嘅 class 過濾就會重犯 §3.1 嘅錯 |
| **5** | 視覺回歸（全螢幕截圖對比） | 建議由 C2（Visual Quality Critic）獨立做 |

---

## 7. 重跑

```bash
# ⚠️ 分析器需要舊檔存在；舊檔已刪 → 由 git 取回
git show 189af42:src/styles/main.css > src/styles/main.css
git show 189af42:src/styles/hud.css > src/styles/hud.css
git show 189af42:src/styles/timeline.css > src/styles/timeline.css

C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/migrate_legacy_css.py --apply

# 然後再刪三個舊檔
```

（`189af42` = 「D 舊 CSS 遷移（階段 1）」commit，係舊檔最後存在嘅 revision。）

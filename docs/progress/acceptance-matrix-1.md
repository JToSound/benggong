# 驗收矩陣 §1 交付報告 —— 初次入站 1440px（由「⚠️ 部分」變 ✅）

> 對應：`docs/specs/world-atlas-v2-acceptance-matrix.md` §2 第 1 項
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

矩陣第 1 項原本標「⚠️ 部分（只有 2 入口）」。本輪逐項補齊 5 個斷言，
全部喺 `tests/panel-overlay.e2e.test.ts`（真瀏覽器）：

| 要求 | 斷言 | 狀態 |
|---|---|---|
| `h1` 存在 | 首屏**只有一個** `h1`、非空、可見（實測「《病港》世界地圖」） | ✅ 新增 |
| 4 個入口文字存在且可鍵盤達 | `.onboarding-card .onboarding-action` × 4 → 存在、**可見**、**可聚焦** | ✅ 已有（P1-6） |
| **預設 spoiler = 1** | `?spoiler=1` 會被 URL **正規化走**；`?spoiler=0` 保留 | ✅ 新增 |
| `#map-pane` 面積 ≥70% | 1440×900 實測 **82.3%** | ✅ 已有（P1-6） |
| 無 blocking modal | 首屏**冇**可見 `[role=dialog][aria-modal=true]` | ✅ 新增 |

---

## 1. 「預設 spoiler = 1」點樣程式化證明

### 1.1 為何唔可以直接讀常數

`DEFAULT_SPOILER_MAX` 係 `src/types/state.ts` 嘅常數 ✓ ——
但「讀原始碼常數」唔算行為證據 ✗（常數可能冇被用到 ✓）。

### 1.2 用 URL 正規化做證據（行為層）

`src/state/url.ts` 嘅 `serialize()` 只喺
`state.spoilerMax !== DEFAULT_SPOILER_MAX` 時才寫 `spoiler` 參數 ✓。

所以：

| 輸入 | 正規化之後 | 推論 |
|---|---|---|
| `?spoiler=1` | **冇** `spoiler` 參數 | **1 就係預設** ✓ |
| `?spoiler=0` | **保留** `?spoiler=0` | 對照組（證明唔係「乜都刪」）✓ |

### 1.3 對照實驗（證明斷言敏感）

把 `DEFAULT_SPOILER_MAX` 由 `1` 改成 `0` → 重建 → 跑：

```
AssertionError: ?spoiler=1 正規化之後唔應該有 spoiler 參數
（實際 http://localhost:5174/?spoiler=1）: expected true to be false
```

→ 斷言**真係測緊「預設值係 1」** ✓✓（唔係恆真 ✓）。

---

## 2. 「無 blocking modal」點樣定義

矩陣原文寫「無 `.modal[open]`」—— 但 V2 **唔用** `<dialog open>` ✗，
所以按**語意**定義：

> 「首屏**冇**任何**可見**嘅 `[role="dialog"][aria-modal="true"]`」

⚠️ 為何要「可見」：`BottomSheet` 只喺 sheet `full` 狀態才加
`role=dialog` ＋ `aria-modal`（見 `src/components/BottomSheet.ts:302-306`）✓
—— 首屏係 `peek` → 冇 dialog ✓。

### 對照（證明選擇器唔係恆假）

同一測試內**順手**撳 `/` 開搜尋 overlay → 再數 → 應該 **> 0** ✓
→ 證明「首屏 0 個」唔係因為選擇器永遠揀唔到嘢 ✓。

---

## 3. 測試檔案

`tests/panel-overlay.e2e.test.ts` —— 由 9 個測試增至 **12 個**：

| § | 內容 |
|---|---|
| 1 | `#map-pane` 面積 ≥70%（1440／1280／1920） |
| 2 | 首屏 pane 收起 ＋ 開關唔改地圖幾何 |
| 3 | 4 個主入口存在、可見、可聚焦 |
| 4 | 自動開 pane（編年史／`?location=`／揀 zone） |
| 5 | 浮層唔蓋住地圖控制項 |
| **6** | **矩陣 §1：`h1`／預設 spoiler=1／無 blocking modal** |

---

## 4. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| M1-1 | **`h1` 只驗「存在、非空、可見」** | 冇驗文字內容（避免把文案綁死；文案改動唔應該令矩陣紅 ✓）。 |
| M1-2 | **「可鍵盤達」係「可聚焦」嘅近似** | 真正嘅 Tab 序驗證由 `tests/a11y-keyboard.e2e.test.ts` 覆蓋（全頁 Tab stop 數、第 1 個 Tab stop = `.skip-link`）✓。 |
| M1-3 | **矩陣第 1 項以外嘅 12 項仍未逐項核對** | 本輪只補第 1 項（其餘各項狀態見矩陣表本身）。 |
| M1-4 | **CI 唔跑 e2e** | CI（ubuntu-latest）冇裝 Playwright browser → 呢 12 個斷言喺 CI **skip** ✗（本地 / 有 browser 嘅環境才跑到 ✓）。 |

---

## 5. 重跑

```bash
npx vitest run tests/panel-overlay.e2e.test.ts
```

⚠️ 跑之前清 5174（殘留 server 會令測試測舊 build —— 見
`docs/progress/d5-visual-regression.md` §10）。

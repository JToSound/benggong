# B1 — Design System & Motion 交付報告

> 子代理：**B1 Design System & Motion**
> 專案：`C:\Users\User\Desktop\benggong` · branch `refactor/world-atlas-v2`
> 依據：`docs/specs/world-atlas-v2-visual-motion-system.md`（§2/§4/§5/§6/§7/§8/§9）、component-state-contract §3、migration-plan §3/§6.2、A2、A10
> 語言：粵文。

---

## 任務摘要

建立 **單一 token 語言 + motion primitives + 本機 icon**，取代現況 5 套互斥顏色權威：

| 權威（現況） | V2 處置 |
|---|---|
| `--accent-*` legacy 7 色 | 由 `tokens.css` 語意色取代（唔再引入） |
| `--hud-*` 7 色 | 由 `tokens.css` 取代（唔再引入） |
| `--color-*` 12 個從未定義死 token | 消滅（`tokens.css` 冇 `--color-*`） |
| canvas `PALETTE_DARK/LIGHT`（自持色值） | 改由 `theme-tokens.ts` mirror，parity 測試把關 |
| TS inline 61 個 distinct hex | 由 token 取代（下游遷移時） |

交付 9 個檔案（3 個新 CSS、4 個新 TS、1 個改寫、2 個新測試）＋ 1 份 interface contract。**冇加任何依賴、冇任何 online asset、冇任何 git 寫操作。**

---

## 假設與證據

1. **spec §2 係 token 唯一權威**；A2/A10 嘅 `--c-*` 命名係草案，B1 依 spec §2.1 嘅命名（`--bg-*` / `--text-*` / `--accent` / `--zone-*`）。
2. **spec §2.1 有 4 個色值同 spec 自己嘅對比度要求衝突** —— 實測（WCAG 2.x 公式）證明原值 fail（見「風險」表），B1 取「硬性 ≥4.5:1」為準並修正，需主代理追認。
3. **z-index 數目**：task 描述寫「7 級」，但 spec §2.2 code block 實際列 8 個 token（`--z-map` → `--z-toast`）。B1 **逐個實作 spec code block 嘅 8 個**（spec 為權威），並喺 parity 測試斷言完整集合。
4. **canvas 讀唔到 CSS 變數** → basemap palette 亦要 mirror；因此 `tokens.css` 加入 `--bm-*` token（規則 T2），令 parity 測試可以覆蓋**全部** canvas 色值。
5. **`src/main.ts` 屬 B2** → B1 唔可以 import 自己嘅 CSS；build 仍然綠（新 CSS 未被 import，唔會入 bundle）。
6. 現況 `VectorBasemap` 嘅 basemap 值屬「唔可以誤刪」範圍（migration-plan §6.2 保留 `Path2D` 快取）→ B1 **逐字 mirror 現值**（唔喺 token 層偷改道路顏色）；去橙化留畀 B5，並已提供 `--bm-road-trunk` 建議 token。

---

## 發現／改動

### 1. `src/styles/tokens.css`（新，唯一 token 定義處）

- **color（dark 預設 `:root` + light `[data-theme="light"]`）**：66 個顏色 token × 2 主題。
  - 表面 4、線 2、文字 4、語意 8、zone 5、zone pattern fill 5、basemap 26、紋理 3、玻璃 2。
- **spacing 7 級**（`--sp-1/2/3/4/6/8/12`）。
- **radius 4 級**（`--radius-sm/md/lg/pill`）。
- **shadow 3 級**（light 有獨立值）。
- **z-index 8 個**（spec §2.2 全部）。
- **motion 3 duration + 2 easing**（`--dur-*` / `--ease-*`）。
- **輔助 primitives**：`--font-sans` / `--font-mono`、`--fs-2xs…2xl`（下限 12px）、`--lh-*`、`--clip` / `--clip-sm`（HUD 切角）、`--glass` / `--glass-solid`、`--grid-line` / `--scanline`。
- `@media (prefers-contrast: more)` 加強線同次文字。

### 2. `src/styles/base.css`（新）

- 最小 reset + 排版階梯（全部 ≥12px；正文 14px、標籤 12px）。
- `:focus-visible` 用 `--focus-ring`，並提供 `.clip-focus` 內描邊 fallback（focus ring 唔可以被 `clip-path` 剪走 —— A7 P0-3）。
- `.tap-target`（44×44）、`.tabular`（數字對齊）。
- **reduced-motion CSS 層**：全域收斂（iteration 1、duration .01ms、`scroll-behavior:auto`）**＋ 逐個需要保留終態嘅元素指定靜態樣式**（`.zone-outline--selected` / `.route-flow` / `.route--drawing .route-base` / `.skeleton::after` / `.zone-glow` / `.beacon-ping`）—— 唔靠壓縮 duration 令光環／skeleton 消失。

### 3. `src/styles/index.css`（新）

`@import "./tokens.css";` → `@import "./base.css";`（tokens 一定最先）。

### 4. `src/theme-tokens.ts`（新）

- `TOKEN_COLORS_DARK` / `TOKEN_COLORS_LIGHT`：66 個色值，**逐個**同 CSS 一致。
- `PALETTE_DARK` / `PALETTE_LIGHT` / `MAP_PALETTE`：由 token map **派生**（唔重複寫 literal）。
- `ROAD_STYLE`：道路粗細／發光（非顏色）。
- `MOTION_TOKENS`：duration/easing mirror，供 `motion.ts` 讀取。

### 5. `src/theme.ts`（改寫）

- **dark-first**：`currentTheme()` = `stored() ?? "dark"`，**移除** `systemPrefers()` 跟隨系統（spec §1.2 D1）。
- **保留** `data-theme` 屬性、`basemap-theme-change` 事件、`localStorage` 持久化。
- 保持向後兼容 export：`Theme` / `currentTheme` / `setTheme` / `toggleTheme` / `initTheme`（`src/app.ts` 現時仍 import 呢 3 個，唔可以斷）。

### 6. `src/motion.ts`（新）

- `prefersReducedMotion()`（node 環境安全回 false）、`onReducedMotionChange()`。
- `DUR` / `EASE` / `EASE_FN`（真正 cubic-bezier 求值器，同 CSS 逐點一致）。
- `animateViewport()` / `animateNumber()` / `scrollElementTo()` / `cancelMotion()`。
- **reduce 為真 → 同步一次跳終態、唔開 rAF、唔插值**（修 A7 P1：現況 rAF viewBox 11 個相異值、smooth scroll 57 個）。
- `scrollElementTo` **唔用** `scrollIntoView`（規則 C1 / A7 P0-2）。

### 7. `src/ui/icons.ts`（新）

- 29 個 icon、24×24 viewBox、`currentColor`、`<symbol>` + `<use>`、`stroke-linecap: square`（HUD 切角語言）。
- 覆蓋 8 個 nav emoji（`ic-chronicle`/`search`/`share`/`export`/`theme`/`help`/`info`/`panel`）＋ 控制 4 ＋ zone 5 ＋ 資料 5 ＋ 通用 7。
- `icon(id, {size,label,className})` 預設 `aria-hidden`；傳 `label` → `role="img"` + `aria-label`。
- `mountIconSprite(doc)`（idempotent，開機注入一次）。零外部 library。

### 8. 測試（新）

- `tests/theme-token-parity.test.ts`（16 tests）：CSS ↔ TS 逐值一致、light ⊆ dark、motion 一致、只准 3+2、PALETTE 由 token 派生、**對比度契約**（文字 ≥4.5:1、語意色 ≥3:1、inverse-on-accent ≥4.5:1）、結構（7 spacing / 4 radius / 8 z）、零外部 asset。
- `tests/motion.test.ts`（13 tests）：可控時鐘 + rAF stub，驗 reduce 跳終態（0 rAF）、no-preference 插值 >2 相異值、cancel、token 一致。

---

## 修改檔案

| 檔案 | 性質 |
|---|---|
| `docs/contracts/b1-interface-contract.md` | 新（先寫，spec §4.4） |
| `src/styles/tokens.css` | 新 |
| `src/styles/base.css` | 新 |
| `src/styles/index.css` | 新 |
| `src/theme-tokens.ts` | 新 |
| `src/motion.ts` | 新 |
| `src/ui/icons.ts` | 新 |
| `src/theme.ts` | 改寫 |
| `tests/theme-token-parity.test.ts` | 新 |
| `tests/motion.test.ts` | 新 |
| `docs/progress/b1-tokens-motion-delivery.md` | 新（本檔） |

---

## 沒有修改但相關的檔案

| 檔案 | 為何相關 | Owner |
|---|---|---|
| `src/main.ts` | **必須**加 `import "./styles/index.css";` + 呼叫 `mountIconSprite()`；移除舊 3 個 CSS import | **B2** |
| `src/app.ts` | 仍用 `initTheme/toggleTheme/Theme`（B1 已保持兼容）；8 個 nav emoji 待換成 `icons.ts` | **B2** |
| `src/map/VectorBasemap.ts` | 刪除自持 `PALETTE_DARK/LIGHT`，改 import `theme-tokens`；保留 `basemap-theme-change` 訂閱 | **B5** |
| `src/styles/main.css` / `hud.css` / `timeline.css` | Gate 2 才刪；B1 **冇改** | 主代理 |
| `src/components/**` | 換 token / motion / icon | B6/B7/B8 |
| `package.json` | 規則 T4 嘅 stylelint gate（如需） | 主代理 |

---

## 驗證命令與結果

```bash
npm run typecheck
# ✅ 0 error

npx eslint src/theme.ts src/theme-tokens.ts src/motion.ts src/ui/icons.ts \
  tests/theme-token-parity.test.ts tests/motion.test.ts
# ✅ exit 0（B1 檔案 0 error）

npm run build
# ✅ prebuild sync-data 通過 → tsc --noEmit → vite build 成功
#   dist/assets/index--5RrUFrx.css 45.17 kB │ gzip 9.35 kB
#   dist/assets/index-BV8AKgq5.js  128.28 kB │ gzip 41.77 kB
#   （B1 新 CSS 未 import，未入 bundle —— 預期之內）

npm run test
# ✅ 11 個 test file 全過（含 B1 新增 29 個 test：parity 16 + motion 13）
# ⚠️ 1 個 file fail：artifacts/audit-A7/v2-mobile-a11y.e2e.test.ts（17 tests）
#    根因：page.goto("/") → "Cannot navigate to invalid URL"（缺 BASE_URL）
#    性質：A7 嘅 **V2 驗收 spec**，檔案 header 自己寫明「對現行 production 版本
#          會大量 FAIL …… B8 完成後應該全綠」，可用 A7_EXPECT_FAIL=1 容忍。
#    同 B1 無關（導航前已失敗，唔會載入任何 B1 模組；亦喺 B1 allowlist 之外）。
```

**`tests/**` 範圍內：11 個 file 全綠、0 fail。**

---

## Screenshots / Artifacts

- `docs/contracts/b1-interface-contract.md` —— 公開介面清單（CSS token / TS 匯出 / 用法）。
- 無截圖：B1 交付係 token/契約層，未接落 production DOM（B2 未 import CSS）。視覺驗收屬 Gate 2 / B9。

---

## 風險、衝突、限制

| # | 項 | 說明 |
|---|---|---|
| R1 | **4 個 token 值修正（需追認）** | spec §2.1 原值唔符合 spec 自己嘅對比度要求：`--text-muted` dark `#6b7c8f`（4.49/4.17/3.73 ❌）→ `#7d8fa3`（5.79/5.38/4.81 ✅）；`--text-muted` light `#6e7681`（4.11/4.59/4.33 ❌）→ `#5f6873`（5.06/5.65/5.33 ✅）；`--accent` light `#0f7f9c`（4.14 ❌）→ `#0c6f88`（5.16 ✅）；`--unknown` light `#8a8f98`（2.91，連 3:1 都 fail）→ `#71777f`（4.04 ✅）。其餘逐字採用 spec。 |
| R2 | **z-index 8 vs「7 級」** | 依 spec §2.2 code block 實作 8 個 token；task 描述寫 7。 |
| R3 | **`--danger` dark 喺 `--bg-elevated` 上 4.08:1** | 語意色門檻係 ≥3:1（非文字）；若下游要將 `--danger` 做**文字**放喺 elevated，需改用 `--danger-soft` 底 + `--text-primary`。已喺 contract 註明。 |
| R4 | **`src/main.ts` 未 import 新 CSS** | build 綠係預期（新 CSS 未入 bundle）；實際生效要等 B2。 |
| R5 | **`artifacts/audit-A7/v2-mobile-a11y.e2e.test.ts` fail** | pre-existing、非 B1 scope、唔可以改（allowlist 外）。 |
| R6 | **`npm run lint` 全域仍有 16 error** | 全部喺 `artifacts/audit-*/**.mjs`（pre-existing，allowlist 外）。B1 檔案 0 error。 |
| R7 | **basemap 道路仍係 8 階橙** | B1 只 mirror 現值；去橙化係 B5 渲染決定，已提供 `--bm-road-trunk`。 |
| R8 | **未驗 Firefox / Safari** | `color-mix` 未用；`clip-path` / `backdrop-filter` 未實測（B9 負責）。 |

---

## 給主代理的 integration note

1. **必做（B2）**：
   - `src/main.ts` 加 `import "./styles/index.css";`，並移除 `main.css` / `timeline.css` / `hud.css` import（現時 `hud.css` 更係重複 import 兩次）。
   - 呼叫 `mountIconSprite()` 一次。
   - 移除 `src/app.ts` 8 個 nav emoji，改用 `icon("ic-…")`。
2. **必做（B5）**：`VectorBasemap` 刪自持 `PALETTE_*`，改 `import { PALETTE_DARK, PALETTE_LIGHT } from "../theme-tokens"`；**保留** `basemap-theme-change`。
3. **需裁決**：
   - R1 嘅 4 個 token 值修正（spec 值 vs 對比度硬性要求）—— 建議以對比度為準（spec §9「0 違規」）。
   - R2 z-index 8 vs 7。
   - 規則 T4 stylelint `color-no-hex` gate 要唔要入 CI（涉及 `package.json`，B1 唔可以加）。
4. **唔可以誤刪**：`basemap-theme-change`、`VectorBasemap` 嘅 `Path2D` 快取、`#ch=`/`#loc=` legacy alias。
5. **零人手**：所有驗收（parity、對比、reduced-motion）都係可重跑測試，冇任何人手覆核步驟。

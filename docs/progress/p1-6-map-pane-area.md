# P1-6 交付報告 —— story pane 改 overlay（地圖佔首屏 ≥70%）

> 對應：spec `world-atlas-v2-product-spec.md:103` ＋ 驗收矩陣第 1 項
> 裁決：用戶 2026-10-05 選 **(B) story pane 改 overlay**
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

`#map-pane` 實測只有 **60.6%**（spec 要 ≥70%）。算術上要達標，story pane 只可以
216px —— 但佢承載產品一半內容。裁決係將 story pane 由**側欄**改成**浮層**：
`#map-pane` 拿到 workspace 全部闊度 → **82.3%** ✓。

⚠️ **但浮層一定要預設收起** —— 展開嘅浮層會蓋住右邊 380px（21.7% 面積），
用戶真正睇到嘅地圖**仍然只有 60.6%**。只滿足 spec 嘅字面、唔滿足意圖嘅做法
唔可以當「完成」。

---

## 1. 問題

| viewport | `#map-pane`（前） | 面積佔比 | 組成 |
|---|---|---|---|
| 1440×900（驗收基準） | 1060×741 | **60.6%** | topbar 65 ＋ strip 94 ＋ **pane 380** |
| 1280×800 | 900×641 | 56.3% | 同上 |
| 1920×1080 | 1540×921 | 68.4% | 同上 |

算術（1440×900，地圖高 741）：
```
需要闊度 = 0.70 × 1440 × 900 / 741 = 1224 px
→ story pane 只可以 216 px（現時 380 px）
```

---

## 2. ⚠️ 先修正上一輪報告嘅一個**錯誤前提**

`docs/progress/c8-p0-p1-fixes.md` §3.7 否決「選項 A（預設收起）」嘅理由係：

> ✗ 違反驗收矩陣第 1 項「4 個主入口文字存在且可鍵盤達」—— **嗰 4 個入口喺 story pane 內**

**呢句唔成立**（本輪實測）：

- 4 個主入口（`探索地區`／`搵角色`／`搵事件`／`打開編年史`）係
  **`OnboardingCard`** 嘅 `.onboarding-action` 按鈕
  （`src/components/OnboardingCard.ts:46-50`）；
- `OnboardingCard` 掛喺 **`#map-pane`**（浮喺地圖上）——
  `src/app.ts` `new OnboardingCard({ root: mapPane })`；
- `tests/a11y-aria.test.ts` 嘅「4 個入口文字存在」斷言亦係讀
  `OnboardingCard.ts`。

→ **收起 story pane 完全唔影響嗰 4 個入口。**
（本輪新增嘅 e2e 會用**實瀏覽器**驗證佢哋存在、可見、可聚焦，
唔再只係讀原始碼。）

---

## 3. 為何「overlay + 預設收起」（而唔係「overlay + 預設展開」）

| 方案 | `#map-pane` 版面面積 | 用戶**真正睇到**嘅地圖 | 4 主入口 |
|---|---|---|---|
| 側欄（現狀） | 60.6% | 60.6% | ✓ |
| overlay ＋**預設展開** | 82.3% | **60.6%**（被蓋住 380px） ✗ | ✓ |
| **overlay ＋ 預設收起（本輪）** | **82.3%** | **82.3%** ✓ | ✓ |

中間嗰行只滿足 spec 嘅**字面**。而 V2 五個不可模糊決定之一係
「**首屏主 context = 地圖**」→ 首屏唔可以有展開嘅浮層。

---

## 4. 實作

### 4.1 新增 `src/styles/layout.css`（V2 自有）

```css
.workspace   { position: relative; }          /* overlay 嘅定位上下文 */
.panel-toggle{ display: inline-block; }        /* 原本只喺 <1024px 顯示 */
.pane-story  {
  position: absolute; top: 0; right: 0; bottom: 0;
  z-index: var(--z-panel);
  box-shadow: var(--shadow-high);
  transition: transform var(--dur-normal) var(--ease-standard);
}
```

- **唔改** `legacy-migrated.css` —— 嗰個檔係 `scripts/migrate_legacy_css.py`
  「自動產生」嘅。雖然三個舊檔已刪（產生器實際上已經跑唔到），
  但為免將來有人復原舊檔重跑而覆蓋改動，新規則放喺 V2 自有檔。
- `layout.css` 喺 `main.ts` 排喺 `chronicle.css` **之後** —— 要贏過
  `legacy-migrated.css` 嘅 `.panel-toggle { display: none }`
  （同名選擇器、同特異度 → 後載入者勝）。
- `mobile.css` 由 `BottomSheet` **runtime 注入**（最後載入）→ 佢嘅
  `@media (max-width: 1023px)` 用 `position: fixed !important` 將 pane 變
  bottom sheet，**仍然贏過**本檔 ✓（手機行為完全不變）。
- 收合狀態嘅 `visibility: hidden` ＋ `transform` 由 `mobile.css` §1 提供
  （全域、冇 media query）→ 唔重複定義，避免兩處分叉。

### 4.2 `src/app.ts`

| 改動 | 內容 |
|---|---|
| 預設收起 | 原本只喺 `matchMedia("(max-width: 1023px)")` 之下 `setSheetSnap(COLLAPSED_SNAP)` → 改成**所有闊度**都做 |
| `aria-expanded` | 模板初值 `"true"` → **`"false"`**（之後由 `syncSurfaces` 同步） |
| 自動開 pane | 原本只喺手機、而且只處理「揀 zone」→ 改成**所有闊度**，準則改為「**內容係唔係只喺 pane 內**」 |

**自動開 pane 嘅三類情況**（內容只喺 pane 內，唔開就係「撳咗冇反應」）：

1. **context = `zone`** → zone dossier 喺 `#zone-dossier-mount`（pane 內）
2. **context = `location`** → story panel（含 `.char-chip` 等）喺
   `#story-panel-mount`（pane 內）。⚠️ 包括 `?location=…` **深連結**
3. **view = `chronicle`** → 整個編年史喺 `#story-panel-mount`（pane 內）
   ⚠️ 呢條係**新加嘅必要條件**：浮層化之後，唔加就會出現「撳頂欄
   『📜 編年史』完全冇反應」。

**刻意唔包純 `chapter` context**（含首屏）：換章節已經有可見回饋
（地圖飛去該章 ＋ 章節條高亮），章節摘要一撳「面板」就有。自動開會蓋住地圖，
違背「首屏主 context = 地圖」。

⚠️ 第 2 類（location）係**跑全套測試時發現漏咗**：`tests/character-dossier.e2e.test.ts`
用 `?location=loc_0004` 深連結然後撳 `.char-chip` → 面板收起 → 撳唔到 ✗。
補上呢條之後該測試**唔需要改**就過 ✓（證明係產品漏 case，唔係測試問題）。

---

## 5. ⚠️ 坑（一）：喺狀態處理器入面再寫狀態 → 同步再入一次

**症狀**：`store` 層面明明成功（`data-sheet-snap="half"`），但 pane 仍然
`visibility: hidden`、`is-collapsed` 仲喺度、`aria-expanded="false"`
→ 撳「編年史」完全冇反應。

**根因**：`store.notify()` 係**同步 for-loop** → `setSheetSnap()` 會**即刻再入**
`onStateChange()` 一次。內層已經跑完 `bottomSlide.render()` ＋ `syncSurfaces()`，
但**外層返嚟之後繼續用嗰個舊 `s`** 再跑一次 `syncSurfaces(s_old)` →
將 `is-collapsed` **加返** ✗。

**修法**：`const s` → `let s`，改完 snap **重讀 `this.store.getState()`**。

> **教訓**：喺「狀態變更處理器」入面再寫狀態，一定要假設**會同步再入一次**，
> 而且**唔可以再用入面嗰份舊快照**去做衍生 DOM 更新。

---

## 6. ⚠️ 坑（二）：地圖變闊揭露嘅兩個**真回歸**（唔係測試噪音）

改完之後跑 `tests/map-interaction.e2e.test.ts` → **2 個測試變紅**。兩者都係
「地圖變闊」揭露嘅**潛伏缺陷**，唔係測試問題。

### 6.1 cluster badge 直徑跌出 spec：8.45–10.35 px → **6.13–7.53 px**

spec §3.2 L-Z0 硬性要求 badge 直徑 **8–12 px**。

**根因**：`clusterBadgeRadiusUser(viewW, svgWidthPx, count)` 內部用
`pxPerUser = svgWidthPx / viewW`。但 SVG 用 `preserveAspectRatio="meet"`
→ **真實比例係 `min(w/viewW, h/viewH)`**。

| 地圖闊 | 闊度比例 | 高度比例 | 真實比例 | 誤差 | 實測直徑 |
|---|---|---|---|---|---|
| 1020 px（改前） | 1457 | 1370 | 1370 | **6.0%** | 8.45–10.35 ✓（啱啱好落喺 [8,12]） |
| 1400 px（改後） | 2000 | 1370 | 1370 | **31.5%** | **6.13–7.53** ✗ |

即係：呢條式**一直都錯**，只係 1020 px 之下誤差細（6%）而未爆；
地圖變闊之後高度變成限制因素，誤差跳到 31.5% 就爆咗。

**同一個錯誤假設仲有第二處**：`SvgMap.userUnitsFor(px)`
= `px * (view.w / svgWidthPx)` —— 一樣只除闊度。佢用嚟計 cluster 嘅
最小間距（`clusterSep`）→ 令 cluster 數目由 **6 個變 9 個**（間距細咗）。

**修法**：
1. `clusterBadgeRadiusUser(pxPerUser, count)` —— 比例改由**呼叫者**提供
   （`SvgMap.pxPerUser()` = `1 / min(w/viewW, h/viewH)`），
   唔再喺函數內部重複（兼且錯）嘅假設。
2. `SvgMap.userUnitsFor()` 改用同一個 `pxPerUser()`。
3. 新增 `svgHeightPx()`（同 `svgWidthPx()` 一樣有快取，一齊由
   `ResizeObserver` 失效）。
4. 更新 3 個單元測試嘅呼叫（`map-lod-zone.test.ts` / `map-interaction.test.ts`）。

> **教訓**：`preserveAspectRatio="meet"` 之下，「px ↔ user unit」嘅比例
> **只有一個正確答案**：`min(w/viewW, h/viewH)`。專案本來已經有
> `pxToUserUnits()` 做啱，但 `userUnitsFor()` / `clusterBadgeRadiusUser()`
> 各自重寫咗一條錯嘅。**凡「由 px 反推 user unit」都要行同一條路。**

### 6.2 浮層蓋住地圖控制項 → 撳唔到「放大」

**症狀**：`page.click("#map-zoom-in")` 逾時，Playwright 報
`<p class="zd-summary"> … from <aside id="story-pane"> subtree intercepts pointer events`。

**根因**：`#map-controls` 喺 `bottom: sp-3; right: sp-3`，
`z-index: var(--z-controls)` = 20；浮層 `z-index: var(--z-panel)` = 30
→ 浮層打開時完全蓋住控制項。

**修法**：`layout.css`
```css
@media (min-width: 1024px) {
  #map-controls { transition: right var(--dur-normal) var(--ease-standard); }
  .workspace.is-pane-open #map-controls {
    right: calc(var(--story-pane-w) + var(--sp-3) + var(--safe-right)) !important;
  }
}
```
`is-pane-open` 由 `app.ts` `syncSurfaces()` 加／除（`sheetSnap` 嘅衍生輸出，
規則 S2，唔係第二份 state）。`--story-pane-w` 亦成為 pane 闊度嘅單一來源
（380px／<1280px 320px）。

⚠️ 只喺 `≥1024px` 生效 —— `<1024px` 面板係 bottom sheet（由底部升起），
讓開「右邊」冇意義。

⚠️⚠️ **一定要 `!important`**（第二次踩）：`mobile.css`（runtime 注入、最後載入）
有一條 P1-7 safe-area 規則
`.map-controls, #map-controls { right: calc(sp-3 + safe-right) !important }`。
唔加 `!important` 就會**靜默**輸（`wsClasses` 明明有 `is-pane-open`，
但 `computed right` 仍然係 `12px`）—— 第一次寫漏咗，靠探測
`getComputedStyle(#map-controls).right` 才捉到。

> **教訓**：專案有 `!important` 舊規則時，覆蓋規則**一定要**同樣 `!important`
> ＋ 更高特異度；只靠特異度係唔夠（`!important` 之間才比特異度）。
> 驗證方法係量 `getComputedStyle()`，唔係睇 CSS 原始碼。

---

## 7. 驗證

### 7.1 面積量度（`artifacts/phase3-resume/probe-map-pane-area.mjs`）

| viewport | 前 | 後 | 達標 |
|---|---|---|---|
| **1440×900**（驗收基準） | 60.6% | **82.3%**（1440×741） | ✅ |
| 1280×800 | 56.3% | **80.1%**（1280×641） | ✅ |
| 1920×1080 | 68.4% | **85.3%**（1920×921） | ✅ |

### 7.2 新增 e2e（`tests/panel-overlay.e2e.test.ts`，**9 tests 全過**）

| # | 斷言 |
|---|---|
| 1 | ⭐ 1440×900 `#map-pane` 面積 ≥70%（驗收矩陣第 1 項） |
| 2 | 1280×800 同 1920×1080 亦 ≥70%（回歸） |
| 3 | ⭐ 首屏 pane **唔可見**（否則實際可視面積跌返 60.6%）＋ `aria-expanded="false"` |
| 4 | ⭐ pane 開／關**唔會改變** `#map-pane` 幾何（證明真係 overlay 唔佔 layout） |
| 5 | ⭐ 4 個主入口存在、**可見**、**可聚焦**（實瀏覽器，唔係只讀原始碼） |
| 6 | ⭐ 切去編年史 → pane 自動開 |
| 7 | ⭐ `?location=` 深連結 → pane 自動開（story panel 喺 pane 內） |
| 8 | ⭐ 揀 zone → pane 自動開（用 `elementFromPoint` 搵真正可點嘅 zone） |
| 9 | ⭐ pane 打開時 `#map-zoom-in` **仍然撳得到**（`elementFromPoint` 冇被蓋 ＋ 真 click 令 viewBox 變） |

### 7.2b 更新既有測試（**冇改任何斷言嘅實質內容**）

| 檔案 | 改動 |
|---|---|
| `tests/map-interaction.e2e.test.ts` | 「輕觸要選中、拖曳要平移」加一步「如果面板開咗就先收返」（因為揀完 zone 會自動開浮層 → 蓋住右邊 zone → `pick()` 回 null）。**斷言不變。** |
| `tests/visual-smoke.e2e.test.ts` | 原本斷言「闊螢幕唔需要切換鈕（`display: none`）」→ 改為「**唔可以係 `none`**」，並新增「地圖用盡全闊 > 1500px」。 |
| `tests/zone-flyto-and-sheet.test.ts` | 原本斷言「自動開 pane 要按 `matchMedia(max-width: 1023px)`」→ 改為斷言新準則（zone／location context ＋ chronicle view），並**負向斷言**唔應該再按寬度判斷。 |
| `tests/map-lod-zone.test.ts`／`tests/map-interaction.test.ts` | `clusterBadgeRadiusUser()` 新簽名（見 §6.1）。 |

### 7.3 閘門

見下方「§8 重跑指令」同 `artifacts/phase3-resume/`（`full-vitest6.log` 等）。

---

## 8. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| P1-6-1 | **換章節唔會自動開 pane** | 刻意（見 §4.2）。章節摘要要多一撳「面板」。若果用戶覺得唔夠，可以改成「首次換章節自動開一次」。 |
| P1-6-1b | **用戶手動收埋面板之後，再揀 zone／location 會自動開返** | 刻意（新內容要睇得到）。如果用戶覺得煩，可以加「用戶收埋過就唔自動開」嘅記憶。 |
| P1-6-2 | **浮層展開時會蓋住地圖右邊 380px** | 呢個係 overlay 嘅本質。用戶一撳「面板」就可以收返。spec 冇要求「展開時仍 ≥70%」。 |
| P1-6-2b | ⚠️ **浮層展開時，被蓋住嘅 zone 唔可以用滑鼠點** | overlay 嘅固有效果（側欄版係「地圖變窄但全部可點」）。實測：`tests/map-interaction.e2e.test.ts` 嘅「輕觸要選中、拖曳要平移」要**先收面板**才 pick 得到 zone（已喺測試加一步還原可點區域，**冇改斷言**）。**緩解**：一撳「面板」即收；鍵盤（方向鍵平移、`+`／`-` 縮放）唔受影響。 |
| P1-6-3 | **`legacy-migrated.css` 有兩個 dangling token** | `<1024px` 嘅 overlay 區塊用咗 `var(--shadow-lg)` / `var(--transition)` —— 兩個 token **`tokens.css` 根本冇定義** → 嗰兩條宣告一直係無效值（即係嗰個 overlay 一直冇投影／冇過場）。本檔用真實 token。⚠️ 未改 `legacy-migrated.css`（自動產生檔）。 |
| P1-6-4 | **`probe-map-pane-area.mjs` 跑完唔收 browser／server** | 會 hang（實測 15 分鐘）。要手動 `taskkill`。屬工具問題，唔影響產品；已記錄。 |
| P1-6-5 | **驗收矩陣文件未更新** | `docs/specs/world-atlas-v2-acceptance-matrix.md` 第 1 項嘅狀態仍寫「⚠️ 部分（只有 2 入口）」。本輪已滿足「`#map-pane` ≥70%」同「4 入口可鍵盤達」，但「預設 spoiler=1」「無 blocking modal」未一併驗 → 未改文件（避免報大數）。 |
| P1-6-6 | **`#map-controls` 覆蓋規則一定要 `!important`** | `mobile.css`（runtime 注入）有一條 `!important` safe-area 規則。將來若要再改 `#map-controls` 位置，**一定要**同樣 `!important` ＋ 更高特異度，否則**靜默無效**。 |

---

## 9. 重跑指令

```bash
# 面積量度（⚠️ 跑完要手動清 5174：netstat -ano | grep 5174 → taskkill /PID <pid> /T /F）
node artifacts/phase3-resume/probe-map-pane-area.mjs

# P1-6 e2e（7 tests）
npx vitest run tests/panel-overlay.e2e.test.ts

# 全套閘門
npm run typecheck && npm run lint && npm run test
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe -m pytest -q
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/validate_public_data.py
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/audit_release.py
```

⚠️ 環境陷阱：
- e2e 跑 `dist/` → 改完 source **必須 `npm run build`**。
- 撞 `SAFE_DELETE_BULK_*`（E11）→ `mv dist dist-stale-$(date +%s)` 再 build，
  跑完清走。

---

## 10. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議 | 針對 |
|---|---|---|
| P1-6-6 | 把驗收矩陣第 1 項其餘兩項（預設 spoiler=1、無 blocking modal）補成自動斷言 | P1-6-5 |
| P1-6-7 | 清 `legacy-migrated.css` 嘅 dangling token（要連 `map-css-contract.test.ts` 一齊加斷言：`var(--x)` 必須喺 `tokens.css` 有定義） | P1-6-3 |
| P1-6-8 | 修 `probe-map-pane-area.mjs` 收檔（`finally { browser.close(); killTree(server) }`） | P1-6-4 |
| P1-6-9 | 為「狀態處理器內再寫狀態」加通用守衛（例如 `onStateChange` 內禁止直接 `setXxx`，或統一用 `queueMicrotask`） | §5 嘅坑 |

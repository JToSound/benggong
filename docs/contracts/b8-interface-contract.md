# B8 Mobile + A11y — 介面契約（Interface Contract）

> 子代理：**B8 Mobile + A11y**｜Branch：`refactor/world-atlas-v2`
> 上游契約：`b1-interface-contract.md`（token / motion）、`b2-interface-contract.md`（state / selector / URL）、
> `b3-interface-contract.md`（adapter / searchIndex）、`b6-interface-contract.md`（map interaction / MapControls）、
> `b7-interface-contract.md`（chronicle / a11y 契約）
> 主要規格：`docs/audits/mobile-a11y-audit.md`（A7，20 項發現）、
> `docs/specs/world-atlas-v2-acceptance-matrix.md` §2（第 1／4／9／10 項）、§5（VA3/VA4/VA8/VA9/VA12）、
> `docs/specs/world-atlas-v2-component-state-contract.md`（規則 C3 / `sheetSnap`）、
> `docs/specs/world-atlas-v2-information-architecture.md`（§5.4 mobile / §5.1 四入口 / §2.2 search 5 類）、
> `docs/specs/world-atlas-v2-migration-plan.md` §3.1（B8 allowlist）
> **本檔先寫，後實作**（spec §4.4、migration plan §8）。所有文字用粵文。

---

## 0. 一句話總結

B8 將 A7 審計入面**五個 P0（鍵盤用戶完全用唔到）**全部修好，並令 mobile 版面
由「縮細版 desktop」變成**真 bottom sheet**：

1. **P0-1** 收合嘅故事面板 2,920 個 Tab stop → **0**（`inert` + `aria-hidden`）。
2. **P0-2** 頂欄 Tab 到唔到（`scrollIntoView` 移動 focus starting point）→ 改 `scrollLeft`。
3. **P0-3** 12 個控制項 focus ring 被自身 `clip-path` 剪走 → 改用 `box-shadow`。
4. **P0-4** 搜尋 modal 冇 dialog 語意 / 冇 trap / Esc 後 focus 卡死 → `SearchOverlay`。
5. **P0-5** Journey C/D 鍵盤無法完成 → `aria-activedescendant` + ↑↓/Enter/Esc。

**最重要嘅保證**：

> 🚧 B8 **唔改** B1 / B2 / B3 / B4 / B5 / B6 / B7 任何 export 嘅簽名或語意。
> B8 只喺自己 allowlist 內新增／改寫檔案。若果需要改 `src/app.ts` /
> `src/state/**` / `index.html`，**唔會自己改** —— 喺交付報告列出精確改動由主代理執行。

---

## 1. B8 獨佔（Owned by B8）

| 檔案 | 狀態 | 說明 |
|---|---|---|
| `src/components/BottomSheet.ts` | **新** | mobile 3 段 snap bottom sheet（drag handle / safe-area / focus 管理） |
| `src/components/SearchOverlay.ts` | **新** | 5 類搜尋 overlay（dialog 語意 / trap / `aria-activedescendant`） |
| `src/components/OnboardingCard.ts` | **新** | 非阻塞初次入站卡（4 主入口） |
| `src/components/AboutModal.ts` | **改** | `role=dialog` / `aria-modal` / focus trap / restore |
| `src/components/ChapterStrip.ts` | **改** | 移除 `scrollIntoView`；≥44px；`aria-current` |
| `src/components/MapControls.ts` | **改** | focus ring 用 `box-shadow`（唔可以改 id / `MIN_TAP_PX` 語意） |
| `src/styles/mobile.css` | **新** | mobile 版面 + 44px 下限 + clip-path 修正 + safe-area + legend 可摺疊 |
| `tests/mobile-layout.e2e.test.ts` | **新** | 390×844 版面量測 |
| `tests/a11y-keyboard.e2e.test.ts` | **新** | Tab 序 / focus ring 逐像素 / Esc / Journey C/D |
| `tests/a11y-aria.test.ts` | **新** | ARIA 屬性斷言（node 單測元件輸出） |
| `tests/reduced-motion.test.ts` | **新** | JS 層 `matchMedia` 查詢斷言 |
| `docs/contracts/b8-interface-contract.md` | **新** | 本檔 |
| `docs/progress/b8-mobile-a11y-delivery.md` | **新** | 交付報告 |

**B8 唔會改**：`src/styles/main.css`、`timeline.css`、`hud.css`、`index.css`（Gate 2 才清）、
`src/state/**`、`src/data/**`、`src/app.ts`、`src/main.ts`、`src/router.ts`、`src/map/**`、
`src/types/**`、`data/**`、`scripts/**`、`vite.config.ts`、`eslint.config.js`、
`tsconfig.json`、`package.json`、`index.html`。

---

## 2. 上游介面（只讀）

B8 依賴以下**已凍結**介面，唔會改：

```ts
// src/state/store.ts（B2）
store.setSheetSnap(s: "peek" | "half" | "full"): void   // 已存在，唔寫 URL
store.getState(): AppState                              // state.sheetSnap 已接線
store.setSearchKind(k: SearchKind | null): void         // 已存在（"character"|"zone"|"location"|"event"|"chapter"）
store.setPendingFocus(id: string | null): void          // focus restoration 目標
store.navigate(ctx) / store.setContext(ctx)             // 選中 = push，轉換 = replace

// src/motion.ts（B1）—— **唯一**動效入口（規則 M2）
prefersReducedMotion(): boolean                         // 已檢查 matchMedia
scrollElementTo(el, left, top, dur): MotionHandle       // 直接設 scrollLeft（唔用 scrollIntoView）
animateViewport / animateNumber                         // reduce → 同步跳終態
DUR.fast / DUR.normal / DUR.slow                        // 3 duration

// src/map/MapControls.ts（B6）
MIN_TAP_PX = 44                                         // 契約常數，唔可以改值
setAllEvents(pressed: boolean): void                    // 冪等
```

> **B8-D1（偏離，需主代理知悉）**：`SearchOverlay` 需要「5 類搜尋結果」。
> B3 adapter 已經有 `selectSearchResults`（`docs/contracts/b3-interface-contract.md`），
> 但 `src/app.ts:270` 目前只 mount 舊 `SearchBox`（`src/components/SearchBox.ts` 唔喺 B8 allowlist）。
> 所以 B8 **新增** `SearchOverlay.ts`（5 類實作於此），而**唔改** `SearchBox.ts`；
> 由主代理喺 app.ts 換 mount 點。B8 唔會刪 `SearchBox.ts`（唔喺 allowlist）。

---

## 3. 五個 P0 嘅修法（逐項）

### P0-1：收合面板 2,920 個 Tab stop → 0

**根因**：`main.css:1080-1084` 只做 `transform: translateX(100%)` + `pointer-events: none`，
對鍵盤 focus **完全無效**（唔會離開 Tab 序 / accessibility tree）。

**B8 契約**（`mobile.css`，用 `!important` 蓋過後載入嘅 legacy `main.css`）：

```css
/* 收合／半開時，面板內容唔可以 Tab 到 */
.pane-story.is-collapsed,
.pane-story.is-peek { /* peek = 同樣唔可 Tab 內容 */
  visibility: hidden;   /* 由 accessibility tree 移除 + 唔可 focus */
  pointer-events: none;
}
```

**為何用 `visibility: hidden` 而唔係單純 JS `inert`**：
- `visibility: hidden` 係**純 CSS**、承載於 class（`is-collapsed` 已經係 `sheetSnap` 嘅衍生輸出）；
- 同時移除 Tab 序 + accessibility tree（Chromium / Firefox / WebKit 一致）；
- 唔需要改 `src/app.ts`（可以喺 `mobile.css` 完成）；
- 配合 `BottomSheet` 嘅 `inert`（見下）雙重保險。

**額外**：`BottomSheet`（full 狀態 = modal）對 `#map-pane` 加 `inert`；
`peek` / `is-collapsed` 時對 sheet 內容加 `inert`。

**驗收**：`收合面板內可 Tab 元素 = 0`（A7 §10.3 補強斷言）；
`tests/mobile-layout.e2e.test.ts` 斷言 `#story-pane` 收合時
`querySelectorAll` 到嘅可 Tab 元素**中心點喺 viewport 內** = 0 **且**可 Tab 總數 = 0。

---

### P0-2：頂欄 Tab 到唔到（`scrollIntoView` 移動 starting point）

**根因**：`ChapterStrip.ts:75`
```ts
target.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
```
首次 render 對「目前章節 pill」呼叫 → Chromium 將 sequential focus navigation
**starting point** 移到該 pill → 之後 Tab 由該 pill 開始，永遠到唔到頂欄。

**B8 契約**：

```ts
// ChapterStrip.updateSelection() —— 直接設 scrollLeft，唔用 scrollIntoView
const track = this.root.querySelector<HTMLElement>("#strip-track");
if (track && target) {
  const left = target.offsetLeft - (track.clientWidth - target.offsetWidth) / 2;
  scrollElementTo(track, Math.max(0, left), track.scrollTop, DUR.normal); // B1 motion（內建 reduce 判斷）
}
```

**為何唔用 `target.scrollIntoView`**：任何形式嘅 `scrollIntoView`（連 `behavior:"auto"`）
都會移動 starting point。規則 C1 明文要求移除。用 `offsetLeft` + `scrollLeft` 可以
保留「捲到目前章節」功能（A7 風險 5）。

**驗收**：全新載入後第 1 個 Tab stop = `.skip-link`（A7 §10.1）。

---

### P0-3：12 個控制項 focus ring 被 `clip-path` 剪走

**根因**：`.nav-btn` / `.map-ctrl` / `.legend-lang-btn` 有 `clip-path: var(--hud-clip-sm)`
（`hud.css:124` / `:209`），而 `outline` 畫喺 border box **以外**（`outline-offset: 2px`）
→ 被 `clip-path` 剪走。實測 ring 區變化像素 = 0。

**B8 契約**（`mobile.css`，唔准移除 `clip-path` —— spec §5.4 視覺語言）：

```css
/* clip-path 會剪走 outline，所以要用 box-shadow（喺 border box 內） */
.nav-btn:focus-visible,
#map-controls .map-ctrl:focus-visible,
.legend-lang-btn:focus-visible,
.ch-pill:focus-visible {
  outline: 2px solid var(--focus-ring) !important;
  outline-offset: 2px !important;
  box-shadow: inset 0 0 0 2px var(--focus-ring) !important; /* 唔會被 clip 剪走 */
}
```

**為何兩者並存**：`outline` 保留（支援高對比模式／強制顏色模式），
`box-shadow: inset` 係 `clip-path` 之下**保證可見**嘅通道。保留切角視覺語言。

**驗收**：12 個控制項 focused / unfocused 截圖逐像素比對，ring 區變化 > 0
（A7 §10.4、VA8）。

---

### P0-4：搜尋 modal 冇 dialog 語意 / 冇 trap / Esc 後 focus 卡死

**根因**：`SearchBox.show()` 只 `classList.add("open")`；Esc 只綁 `input`；
Tab 8 次內逃離 modal；Esc 後 focus 留喺隱藏 `#search-input` →
`app.ts:420` 嘅 `if (target instanceof HTMLInputElement) return` 令之後所有快捷鍵靜默失效。

**B8 契約**（`SearchOverlay.ts`）：

| 項 | 契約 |
|---|---|
| 角色 | `.search-overlay` 有 `role="dialog"` + `aria-modal="true"` + `aria-labelledby` |
| Focus trap | Tab / Shift+Tab 循環喺 overlay 內（唔可以逃離） |
| Esc | 關閉 + focus **還原**去 `#btn-search`（`pendingFocus` 唔夠，要直接 `focus()`） |
| 背景 | 開 overlay 時對 `#app-root` 加 `inert`（解除時移除） |
| 焦點還原 | 記錄 `document.activeElement`（開啟前）→ 關閉時 `focus()` 返 |
| 捲動 | overlay 內 `.search-results` 用 `tabindex="-1"`（唔做多餘 Tab stop） |

> ⚠️ **連鎖失效（A7 P0-4）**：修好 focus restore 之後，Esc 後
> `document.activeElement` 唔再係隱藏 input → `app.ts` 嘅快捷鍵自動恢復。
> **唔需要改 `app.ts`**。

---

### P0-5：Journey C / D 鍵盤無法完成

**根因**：搜尋結果係 `<li class="search-result-item">` + click-only，
`tabIndex = -1`、冇 `role`、冇 `aria-activedescendant`。

**B8 契約**（`SearchOverlay.ts`）：

```html
<input id="search-input" role="combobox"
       aria-expanded="true" aria-controls="search-results"
       aria-activedescendant="search-opt-0" aria-autocomplete="list" />
<ul id="search-results" role="listbox" aria-label="搜尋結果">
  <li id="search-opt-0" role="option" class="search-result-item" data-idx="0" aria-selected="false">…</li>
</ul>
```

| 鍵 | 行為 |
|---|---|
| `ArrowDown` | active index +1（clamp）；更新 `aria-activedescendant` + `aria-selected` |
| `ArrowUp` | active index −1（clamp） |
| `Enter` | 開啟目前 active 結果（`jumpTo()`） |
| `Esc` | 關閉 + focus 還原 |
| `Tab` | 困喺 overlay 內 |

**5 類**：`character` / `zone` / `location` / `event` / `chapter`
（`typeLabel()` 5 個分支；移除 `slice(0, 50)` 硬上限改為分組 + 顯示總數）。

> ⚠️ **Journey C 嘅 dossier 本體未實作**（`StoryPanel.ts:162` 係 `console.log` + TODO，
> 而 `StoryPanel.ts` 唔喺 B8 allowlist）。B8 可以令**搜尋 → 選中 → 導航（setChapter /
> setContext）** 全程可鍵盤完成；角色 dossier 嘅**內容**由 B6 / 主代理接。
> 呢點喺交付報告列為「需要主代理接線」。

---

## 4. P1 處理範圍

| ID | 內容 | B8 做法 |
|---|---|---|
| P1-1 | 24 個 <44px 元素 | `mobile.css` 對 `.nav-btn` / `.ch-pill` / `#map-controls .map-ctrl` / `.legend-lang-btn` 設 `min-width:44px; min-height:44px`（`!important` 蓋過 legacy） |
| P1-2 | 地圖 0/19 鍵盤可達 | **唔完全喺 B8**（zone/marker DOM 由 B6 `ZoneLayer` 建）。B8 提供 `.zone[tabindex]` / `.event-marker[tabindex]` 嘅 **focus ring CSS** + 喺交付報告列接線點 |
| P1-3 | 冇 `aria-live` / `aria-current` | `ChapterStrip` 加 `aria-current="true"`；`SearchOverlay` 加 `aria-live="polite"` 結果數；`BottomSheet` 提供 `aria-live` 播報容器 |
| P1-4 | 首屏只有 1 個 heading | `OnboardingCard` 加 `h2`；sheet 加 `h2` heading |
| P1-5 | `role="application"` 包全 app | **唔喺 B8 allowlist**（`index.html` / `app.ts`）→ 列精確改動由主代理執行 |
| P1-6 | reduced-motion JS 層無效 | 上游 B1 `motion.ts` 已修（`prefersReducedMotion`）；`SvgMap.animateViewBox` 已查。B8 加 `tests/reduced-motion.test.ts` **程式化斷言**整個 repo 冇 rAF 動畫繞過 `motion.ts` |
| P1-7 | 冇 safe-area | `mobile.css` 加 `env(safe-area-inset-*)`（sheet / `#topbar` / `.map-controls`）；`viewport-fit=cover` 要改 `index.html` → 列接線 |
| P1-8 | 圖例遮蓋 24.3% | `OnboardingCard` 唔關事；**圖例可摺疊**要靠 `SvgMap`（唔喺 allowlist）→ B8 提供 `.map-overlay.is-legend-collapsed` CSS + 列接線點 |
| P1-9 | 頂欄標題 4 行 | `mobile.css` 收斂 `#topbar h1` 字級 + `nav` 可橫向捲 → ≤2 行（390px / 320px） |

---

## 5. `BottomSheet` 公開介面

```ts
// src/components/BottomSheet.ts
export type SheetSnap = "peek" | "half" | "full";

export interface BottomSheetOptions {
  /** sheet 內容嘅 host（唔包括 handle）。 */
  root: HTMLElement;
  /** 由 store 讀當前 snap（唯一狀態來源）。 */
  getSnap(): SheetSnap;
  /** 寫入 snap（store action）。 */
  setSnap(s: SheetSnap): void;
  /** sheet 標題（`h2`；亦係 `aria-labelledby` 目標）。 */
  title: string;
}

export class BottomSheet {
  constructor(opts: BottomSheetOptions);

  /** store 變更 → 更新衍生 DOM（class / aria-* / inert），規則 S2。 */
  render(snap: SheetSnap): void;

  /** Esc 處理；回傳有冇消費事件（`false` 就交返畀 app.ts 嘅次序）。 */
  handleEsc(): boolean;

  destroy(): void;
}
```

**Snap 高度**（spec IA §5.4 要求 25% / 55% / 92%）：

| snap | 高度 | 內容 |
|---|---|---|
| `peek` | `25dvh` | handle + 標題 + 第一行摘要 |
| `half` | `55dvh` | + 路線／事件清單 |
| `full` | `92dvh` | 完整 dossier（等同 modal） |

- `peek` 時 overlap ÷ 地圖 **≤ 25%**（A7 §9 驗收）。
- `touch-action: none`（handle）／`pan-y`（內容）。
- handle 外層 ≥44×44（`role="separator"` + `aria-valuenow`）。
- `prefers-reduced-motion` → snap 即時（用 `DUR` 由 `motion.ts`，唔硬寫）。

---

## 6. `SearchOverlay` 公開介面

```ts
// src/components/SearchOverlay.ts
export interface SearchOverlayOptions {
  root: HTMLElement;
  /** 提供搜尋結果（由 B3 adapter / app 注入，保持零 DOM 依賴）。 */
  search(kind: SearchKind | null, query: string): SearchItem[];
  /** 結果被啟動（Enter / click）。 */
  onPick(item: SearchItem): void;
  /** 關閉前嘅 focus 還原目標。 */
  restoreFocus: () => HTMLElement | null;
}

export interface SearchItem {
  kind: "character" | "zone" | "location" | "event" | "chapter";
  /** 實體 id（`selectSearchResults()` 嘅 `r.id`）；`onPick` 靠佢砌導覽。 */
  id: string;
  label: string;
  sublabel?: string;
  chapter?: number;
}

export class SearchOverlay {
  constructor(opts: SearchOverlayOptions);
  open(kind?: SearchKind | null): void;
  close(): void;
  isOpen(): boolean;
  /** 可測嘅鍵盤入口。 */
  handleKeydown(e: KeyboardEvent): boolean;
  destroy(): void;
}
```

**分類標籤**（5 類，spec IA §8）：

| kind | 標籤 |
|---|---|
| `character` | 角色 |
| `zone` | 區域 |
| `location` | 地點 |
| `event` | 事件 |
| `chapter` | 章節 |

---

## 7. 範疇外（需要主代理接線）

以下**唔喺 B8 allowlist**，B8 唔會改；交付報告會列精確改動：

| # | 檔案:位置 | 改動 | 對應 |
|---|---|---|---|
| W1 | `index.html:5` | `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">` | P1-7 |
| W2 | `index.html:13` | 移除 `#app-root` 嘅 `role="application"`（地圖已經自己 `role="application"`） | P1-5 |
| W3 | `src/app.ts` `render()` | 換 mount：`SearchBox` → `SearchOverlay`；加 `BottomSheet`；加 `OnboardingCard` | P0-4 / P0-5 |
| W4 | `src/app.ts` Esc handler | 加 sheet 優先次序（full→half→peek→清選中） | P2-2 |
| W5 | `src/app.ts` `syncSurfaces()` | `#story-pane` 加 `inert`（`sheetSnap === "peek"` 時） | P0-1 |
| W6 | `src/app.ts:252` | `#story-pane` 加 `class="pane-story"` → 加 `data-sheet` / `aria-live` 容器 | P1-3 |
| W7 | `src/components/SvgMap.ts` | zone / marker 加 `tabindex` / `role` / `aria-label` + 方向鍵導覽 | P1-2 |
| W8 | `src/components/SvgMap.ts` | 圖例可摺疊（`aria-expanded` 控制項） | P1-8 |
| W9 | `src/main.ts` | `import "./styles/mobile.css"`（排喺 legacy CSS 之後） | 全部 |

> W9 係硬性：`mobile.css` 必須**後載入** legacy `main.css` / `hud.css`，
> 同時用足夠 specificity 或 `!important` 蓋過 legacy 規則。

---

## 8. 驗收（程式化、可重跑、零人手）

| 檢查 | 方法 | 門檻 |
|---|---|---|
| 9.1 冇橫向 overflow | `documentElement.scrollWidth` | ≤ 390 |
| 9.2 可見互動元素 ≥44×44 | 中心點喺 viewport + `elementFromPoint` 遮蓋過濾 | 0 個 < 44px |
| 9.3 bottom sheet | `hasBottomSheetClass` + `hasDragHandle` + `hasSnapPoints ≥3` | 全部 true |
| 9.4 safe-area | `viewport-fit=cover` + `env(safe-area-inset-*)` 規則數 | ≥3（W1 + mobile.css） |
| 9.6 legend ≤15% 或可摺疊 | overlap ÷ 地圖 | ≤25%（peek） |
| 10.1 首個 Tab stop | `document.activeElement` | `.skip-link` |
| 10.2 Tab ≤20 到頂欄 | Tab 序 | ≤20 |
| 10.3 收合面板 Tab stop | `querySelectorAll` 可 Tab | 0 |
| 10.4 focus ring 可見 | focused/unfocused 逐像素 diff | ring 區 > 0 px |
| 10.5 Esc 關 modal/sheet + focus 還原 | 步驟斷言 | pass |
| 10.6 搜尋 ↑↓/Enter | `aria-activedescendant` | pass |
| 10.7 modal `role=dialog` + trap | DOM 斷言 | pass |
| 10.8 快捷鍵（含 Esc 後） | key sequence | pass |
| 10.12 reduced-motion JS 層 | `viewBox` 相異值 | ≤2 |

---

## 9. 已知限制（實作前聲明）

1. **`main.css` / `hud.css` 唔可以改**，而佢哋**後載入**。所以 `mobile.css`
   一定要用 `!important` 或高 specificity 蓋過 —— 呢個係過渡期雙軌嘅代價，
   Gate 2 刪舊 CSS 之後可以移除 `!important`。
2. **Journey C 嘅角色 dossier 內容未實作**（屬 `StoryPanel.ts`，範疇外）。
   B8 保證「搜尋 → 選中 → 導覽」可鍵盤完成。
3. **e2e 跑 `dist/`**，所以每次改 source 之後必須 `npm run build`。
4. 唔做真機（iOS Safari / NVDA）實測 —— Playwright 只有 Chromium；
   全部 a11y 斷言基於 DOM / computed style / 像素 diff。

---

*契約完。實作見 `docs/progress/b8-mobile-a11y-delivery.md`。*

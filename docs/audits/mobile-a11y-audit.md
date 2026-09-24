# A7 Mobile / Accessibility Audit — 《病港》互動地圖 World Atlas V2

> 審計對象：**現行 production build**（`dist/`，由 `npx vite preview` 提供）
> 審計方式：只讀 production code + Playwright 1.62.1 **程式化實測**（冇任何人手目測／人手點擊核對）
> Viewport：mobile 390×844（`hasTouch: true, isMobile: true`）、tablet 768×1024、desktop 1440×900、narrow 320×568
> preview server：`http://localhost:5190/`（**必須用 `localhost`**；vite preview 只綁 IPv6 `[::1]`）
> 對應 spec：`prompts/world-atlas-v2-rebuild.md` §7.2 第 9／10／11 項、§3 Journey C／D、§7.4
> 所有數字均為本代理實測，可逐條覆核；量測腳本全部喺 `artifacts/audit-A7/`。

---

## 任務摘要

本代理接手上一輪 A7 審計（已完成大量實測但因額度中斷而未落報告），做三件事：**(1) 核實並修正兩個明顯過大嘅量測數字**、**(2) 補跑四項缺口量測**、**(3) 寫出完整報告**。

**結論：mobile 版喺「可觸控、可讀取」層面係可接受嘅，但喺「可鍵盤操作」層面係完全失效嘅。** 最關鍵嘅五點：

1. **收合嘅故事面板仍然有 2,920 個可 Tab 元素。** 面板「收埋」只係 `transform: translateX(100%)`（`main.css:1080-1084`），冇 `aria-hidden`、冇 `inert`、冇 `display:none`。鍵盤用戶由第 199 個 Tab stop 開始，就會連續 Tab 過 **2,920 個喺畫面外嘅元素**（當中有 1,401 個編年史章節鈕 + 1,320 個展開鈕 + 198 條時間軸 bar）。整個 app 有 3,131 個 Tab stop。
2. **頂欄（skip link + 8 個導覽按鈕）喺全新載入後，用 Tab 完全到唔到。** 實測連續 Tab **350 次**都到唔到。根因已用因果實驗證明：`ChapterStrip.ts:75` 嘅 `target.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" })` 會移動 Chromium 嘅 **sequential focus navigation starting point** 到目前章節 pill。Runtime 將 `scrollIntoView` 改成 no-op 之後，第一個 Tab stop 就正確變返 `.skip-link`、第二個係 `#btn-mode`。
3. **12 個主要控制項嘅 focus ring 完全不可見。** 用「focused / unfocused 截圖逐像素比對」量度：8 個頂欄按鈕 + 3 個地圖控制 + legend 語言鈕嘅 **ring 區變化像素 = 0**（內部變化 71–80 px，證明 focus 狀態確實生效），但 `outline` 係畫喺 border box 之外（`outline-offset: 2px`），被元素自身嘅 `clip-path: polygon(...)` 剪走。Runtime 移除 `clip-path` 之後，ring 區變化像素 = **136–555 px**（即係 ring 一直有畫，只係睇唔到）。
4. **Journey C（搵角色）同 Journey D（搵事件）都無法用鍵盤完成。** 搜尋結果係 `<li class="search-result-item">` + click-only listener，`tabIndex = -1`、冇 `role`、冇 `aria-activedescendant`。實測 ArrowDown 之後 focus 仍然喺 `#search-input`，Enter 唔會啟動任何結果。`char-chip` 嘅 click handler 本身就係 `console.log` + `// TODO: open character modal`（`StoryPanel.ts:162-169`），即角色 dossier **根本未實作**。
5. **上一輪嘅 `fail44Count: 3131 / totalTargets: 3131` 同 `contrast 3,135/8,423 fail` 係量測方法高估，唔係真實規模。** 修正後：**真正 < 44px 嘅可見互動元素 = 24 個（mobile-390）**；**真正喺畫面上嘅對比違規 = 12 個（dark）／6 個（light）**。

**發現總數 20 項：P0 × 5、P1 × 9、P2 × 6。**

---

## 假設與證據

### 假設

1. 驗收標準 = `prompts/world-atlas-v2-rebuild.md` §7.2 第 9／10／11 項 + §3 Journey C／D + §0.3「mobile 唔係縮細 desktop」。
2. 「44px」以 **CSS px** 為單位，參照 WCAG 2.1 SC 2.5.5 Target Size (Enhanced, AAA) 同 spec §7.2 第 9 項明文要求；同時量度 WCAG 2.2 SC 2.5.8 (AA, 24×24 或足夠間距) 作對照。
3. 「可見」定義（全部程式化判定，非目測）：
   - `getComputedStyle` 唔係 `display:none` / `visibility:hidden` / `opacity:0`；
   - 元素自身同所有祖先都冇被 `display:none` / `visibility:hidden` 屏蔽；
   - `getBoundingClientRect()` 寬高 > 0；
   - **元素中心點落喺 viewport 內**；
   - `document.elementFromPoint(中心點)` 命中自己或自己嘅子孫（即冇被其他元素遮蓋）；
   - 冇喺 `aria-hidden="true"` 或 `inert` 祖先之下；
   - 冇被 `overflow` 祖先完全剪走。
4. 對比度計算採 WCAG 2.x relative luminance 公式，`(L1+0.05)/(L2+0.05)`；文字 < 24px（或 < 18.66px 且 weight < 700）需 4.5:1，否則需 3:1。
5. 上一輪 `a7-*.json` 數字凡與本輪實測不符，以本輪為準，並已在文中標明差異原因。

### 一、方法論修正 #1：`fail44Count: 3131` 為何係高估

上一輪 `a7-audit.mjs:219-241` 用嘅 selector 係：

```
button, a[href], [role=button], [role=link], [role=tab], [role=option],
input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])
```

而 `visible()`（`a7-audit.mjs:116-122`）只檢查三樣：`display`、`visibility`、`opacity`、非零 box。**佢冇檢查元素中心點係唔係真喺 viewport 內，亦冇檢查有冇被遮蓋。**

實測結果（`a7-verify-targets.json`）：

| 指標 | mobile-390 | tablet-768 | desktop-1440 |
|---|---|---|---|
| 上一輪 selector 命中數 | 3,131 | 3,131 | 3,131 |
| 上一輪「可見」判定通過 | 3,130 | 3,130 | 3,129 |
| 上一輪 `fail44Count` | **3,131** | **3,131** | **3,130** |
| 本輪嚴格「真互動 + 真可見 + 中心點喺 viewport」 | **24** | **33** | **240** |
| 真正 < 44px 違規 | **24** | **33** | **240** |
| 真互動但離屏（唔應計入） | 3,107 | 3,098 | 2,889 |

**高估來源逐項拆解（mobile-390，共 3,131 → 真實 24，高估 3,107）**

| 來源 | 數量 | 為何被誤判 |
|---|---|---|
| `button.chr-ch`（編年史章節鈕，58.7×18） | 1,401 | 喺 **collapsed `#story-pane`** 內，面板被 `transform: translateX(343.188px)` 移出畫面（rect x = 403 > viewport 390）。computed style 仍然 `display:flex; visibility:visible; opacity:1`，所以舊 `visible()` 判定「可見」 |
| `button.chr-toggle`（展開鈕，22×15） | 1,320 | 同上 |
| `button.chr-tl-bar`（時間軸 bar，**寬 1px**） | 195 | 同上 |
| `button.ch-pill`（章節 pill，30×24） | 185 | 喺 `#strip-track` 橫向滾動容器內、中心點喺 viewport 右邊之外（例如 left 404 → right 435）。舊方法只檢查 box 非零 |
| `a.skip-link` | 1 | `top: -40px`，喺 viewport 上方之外 |
| **合計** | **3,107** | |

> **額外澄清**：上一輪報告嘅 `overflowers: 40` **唔係**橫向 overflow 問題。實測 `document.documentElement.scrollWidth = 390 = viewport`，`hasHorizontalOverflow: false`。嗰 40 個「overflowers」全部係 `#strip-track` 內正常滾動嘅章節 pill（`left` 370→1703）。呢個係量測命名容易誤導之處，唔應視為缺陷。

**獨立交叉驗證**：`v2-mobile-a11y-result.json` 嘅 9.2 檢查（由上一輪寫嘅 `v2-checks.mjs:80-96`）用另一個 viewport 過濾寫法（`r.bottom < 0 || r.top > innerHeight || ...`），獨立得出 **24 個元素 < 44px**，同本輪中心點 + 遮蓋過濾嘅結果**完全一致**。兩個獨立方法互相印證。

### 二、方法論修正 #2：`contrast 3,135 / 8,423 fail` 為何係高估

上一輪 `a7-audit.mjs:325-362` 用 `document.createTreeWalker(document.body, SHOW_TEXT)` 行**全份 DOM 嘅文字節點**，包括 `#story-pane` 內 160,405px 高、完全離屏嘅編年史。分母 8,423 當中 **8,385 個（99.5%）唔喺畫面上**。

本輪分開統計（`a7-remeasure.json`，mobile-390）：

| 主題 | 全部文字節點 | 畫面上文字節點 | 畫面上 fail | 離屏文字節點 | 離屏 fail |
|---|---|---|---|---|---|
| dark | 8,423 | **38** | **12** | 8,385 | 3,123 |
| light | 8,423 | **38** | **6** | 8,385 | 3,938 |

- 上一輪報「dark 3,135 fail」＝ 12（畫面）＋ 3,123（離屏）。
- 上一輪報「light 3,943 fail」＝ 6（畫面）＋ 3,937（離屏，實測 3,938）。
- **畫面上真正要修嘅係 12 個（dark）同 6 個（light）。** 離屏數字唔係冇意義（編年史本身係一個內容區，當用戶打開面板就會見到），但**唔應該同首屏可讀性混為一談**，而應該歸入「打開面板後嘅對比」問題。

**對比度計算方法（必須明示，因為有兩個限制）**

1. 前景色：`getComputedStyle(el).color`，若含 alpha 就用 `over()` 合成到背景上。
2. 背景色：由元素向上逐層累積 `backgroundColor`，遇到 `a >= 0.999` 就停；底線預設白 `rgb(255,255,255)`。
3. **限制 A（gradient / background-image）**：如果祖先有 `background-image`（gradient、紋理）而 `backgroundColor` 未完全覆蓋，本方法**冇能力**計出真實底色，會標記 `uncertainBg: true`。實測 mobile-390 有 **222 個文字節點**屬「背景不確定」（佔 2.6%），其中 dark 207 個、light 14 個嘅 fail 判定落喺不確定類別。**即係話：本報告列出嘅對比數字係「有 gradient 就當底色係 backgroundColor」嘅保守估算，唔係最終裁決。**
4. **限制 B**：SVG `<text>` 元素（zone label、map label）唔喺 `body` 嘅 text node walker 範圍內（係 `<text>` 子節點，會行到），但佢哋嘅底色係底圖 raster，本方法完全冇能力量度 → **地圖標籤對比度未量測**，屬已知缺口（見「風險、衝突、限制」）。

---

## 發現／改動

> 本節全部係**發現**。本代理為只讀審計子代理，**冇改動任何 production code**（見「修改檔案」）。

### P0 — 阻斷級（鍵盤用戶完全用唔到）

---

#### P0-1：收合嘅故事面板仍有 2,920 個可 Tab 元素（無 `aria-hidden` / `inert` / `display:none`）

**實測（`a7-collapsed-focus.json`，mobile-390，已等 chronicle render 完成）**

| 項目 | 實測值 |
|---|---|
| `#story-pane` class | 有 `is-collapsed` |
| `getComputedStyle(#story-pane).transform` | `matrix(1, 0, 0, 1, 343.188, 0)` |
| `#story-pane` rect | `x = 390, y = 187, w = 343.2, h = 657`（viewport 闊 390 → **完全喺畫面右邊之外**） |
| `position` | `absolute` |
| `display` | `block`（**唔係 none**） |
| `visibility` | `visible`（**唔係 hidden**） |
| `pointer-events` | `none` |
| `aria-hidden` | **`null`（冇設）** |
| `inert` | **`false`（冇設）** |
| `scrollHeight / clientHeight` | **160,429 / 657** |
| `#story-pane` 內可 Tab 元素 | **2,920** |
| 其中中心點喺 viewport 內 | **0** |
| 全頁 Tab stop 總數 | **3,131** |

**根因（兩個檔案協同造成）**

- `src/styles/main.css:1080-1084`
  ```css
  .pane-story.is-collapsed {
    transform: translateX(100%);
    /* 收起時唔應該攔截點擊（否則會擋住地圖右邊） */
    pointer-events: none;
  }
  ```
- `src/app.ts:73-75`
  ```ts
  if (window.matchMedia("(max-width: 1023px)").matches) {
    pane.classList.add("is-collapsed");
  }
  ```

**為何係 bug**：`pointer-events: none` 只擋滑鼠／觸控**命中測試**，對鍵盤 focus **完全無效**。`transform` 亦唔會令元素離開 accessibility tree 或 Tab 序。結果：手機用戶按 Tab 一次（實際係第 199 個 stop 之後），就會連續 Tab 過 2,920 個畫面外元素，畫面完全冇任何視覺回饋（focus ring 喺畫面外），亦冇辦法知道要按幾多次 Tab 才返得返地圖。

**修法方向（B8 執行）**：收合時對 `#story-pane` 加 `inert`（最乾淨，Chromium 102+ 全支援）或 `aria-hidden="true"` + 對所有子元素設 `tabindex="-1"`。**兩者必須同步 `aria-expanded`**。另外 `ChronicleView` 必須 virtualize（見 P1-3 同 spec §2.1）。

---

#### P0-2：頂欄（skip link + 8 個導覽按鈕）喺全新載入後 Tab 完全到唔到

**實測 A（`a7-keyboard-journey.json` / `a7-probe-tabstart4.mjs`）**

全新載入 → 連續按 Tab **350 次**，第一次出現嘅 stop 分佈：

| Tab stop | 元素 | 區域 |
|---|---|---|
| 1–197 | `button.ch-pill` | `#chapter-strip-mount` |
| 198 | `button#legend-lang-btn` | `#map-overlay` |
| 199–201 | `button#map-zoom-in/out/reset` | `.map-controls` |
| 202 → | `#chr-export-json`、`.chr-tl-bar`、`.chr-ch`、`.chr-toggle` … | `#story-pane`（離屏） |

**`a.skip-link`、`#btn-mode`、`#btn-search`、`#btn-share`、`#btn-export`、`#btn-theme`、`#btn-help`、`#btn-about`、`#btn-toggle-panel` 喺 350 次 Tab 之內一次都冇出現過。**

**因果實驗（`a7-probe-tabstart5.mjs`）**

| 情境 | Tab #1 | Tab #2 | Tab #3 |
|---|---|---|---|
| baseline（原版） | `BUTTON.ch-pill` | `BUTTON.ch-pill` | `BUTTON.ch-pill` |
| runtime 將 `Element.prototype.scrollIntoView` 改成 no-op | **`A.skip-link`** | **`BUTTON#btn-mode`** | **`BUTTON#btn-search`** |
| runtime 只過濾 `behavior: "smooth"` 嘅呼叫 | **`A.skip-link`** | **`BUTTON#btn-mode`** | **`BUTTON#btn-search`** |

**根因**：`src/components/ChapterStrip.ts:75`

```ts
target.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
```

首次 render 時對「目前章節 pill」呼叫 `scrollIntoView`，會令 Chromium 將 **sequential focus navigation starting point** 移到該 pill。之後按 Tab 就由該 pill 之後開始，永遠向前行，唔會返轉頭去頂欄。

**附帶影響**：呢個亦解釋咗上一輪兩份 artifact 嘅矛盾 —— `a7-taborder.json` 報 `firstNav: null`（正確，因為有 scrollIntoView），而 `a7-followup.json` 報 `skipLinkTabSeq[0] = a.skip-link`（因為該腳本喺 Tab 之前做咗 `document.body.setAttribute("tabindex","-1"); document.body.focus()`，人為重設咗 starting point）。**兩者都唔可以單獨引用**；本輪用「baseline vs no-op 對照」嘅因果實驗取代。

**修法方向**：`ChapterStrip` 唔應該喺首次 render 時呼叫 `scrollIntoView`（首次已經喺第 1 章，唔需要捲）；或改用 `#strip-track.scrollLeft = ...` 直接設定 scroll 位置，唔觸發 starting point 變更。

---

#### P0-3：12 個主要控制項嘅 focus ring 完全不可見（被自身 `clip-path` 剪走）

**量測方法（程式化，非目測）**：每個元素用**全新 page**（消除 Tab 起始點污染）→ 鍵盤 `Tab` / `Shift+Tab` 到達目標 → 重置所有 scroll → 截圖（focused）／先截圖（unfocused）→ 逐像素比對，分開統計「border box 以外嘅 ring 區」同「border box 以內」嘅變化像素。

**實測（`a7-focus-ring.json`，每個元素獨立 page）**

| 元素 | 到達方式 | `:focus-visible` 命中 | ring 區變化 px | 內部變化 px | ring 可見 | 自身 `clip-path` |
|---|---|---|---|---|---|---|
| `#btn-mode` | Shift+Tab ×8 | ✓ | **0** | 74 | **✗** | `polygon(6px 0px, 100% 0px, …)` |
| `#btn-search` | Shift+Tab ×7 | ✓ | **0** | 76 | **✗** | ✓ |
| `#btn-share` | Shift+Tab ×6 | ✓ | **0** | 76 | **✗** | ✓ |
| `#btn-export` | Shift+Tab ×5 | ✓ | **0** | 76 | **✗** | ✓ |
| `#btn-theme` | Shift+Tab ×4 | ✓ | **0** | 76 | **✗** | ✓ |
| `#btn-help` | Shift+Tab ×3 | ✓ | **0** | 76 | **✗** | ✓ |
| `#btn-about` | Shift+Tab ×2 | ✓ | **0** | 71 | **✗** | ✓ |
| `#btn-toggle-panel` | Shift+Tab ×1 | ✓ | **0** | 79 | **✗** | ✓ |
| `#map-zoom-in` | Tab ×199 | ✓ | **0** | 78 | **✗** | ✓ |
| `#map-zoom-out` | Tab ×200 | ✓ | **0** | 78 | **✗** | ✓ |
| `#map-reset` | Tab ×201 | ✓ | **0** | 78 | **✗** | ✓ |
| `#legend-lang-btn` | Tab ×198 | ✓ | **0** | 1 | **✗** | ✓ |
| `.ch-pill` | Tab ×1 | ✓ | **38** | 12 | **✓** | 無 |

**對照組（runtime 移除所有 `clip-path`）**

| 元素 | ring 區變化 px | ring 可見 |
|---|---|---|
| `#btn-mode` | **522** | ✓ |
| `#btn-search` | **522** | ✓ |
| `#map-zoom-in` | **310** | ✓ |
| `#legend-lang-btn` | **136** | ✓ |

**根因**：所有 HUD 控制項都用 `clip-path: polygon(...)` 做「切角」外觀（`main.css` HUD 區段）。`outline` 係畫喺 border box **以外**（`outline-offset: 2px`），而 `clip-path` 會剪走元素繪製範圍以外嘅所有內容 —— 包括自己嘅 outline。實測 computed style 完全正常（`outline: solid 2px rgb(36, 114, 164); outline-offset: 2px`），`:focus-visible` 亦命中，但**像素上完全冇 ring**。

**修法方向**：改用 `box-shadow`（`inset` 或 `0 0 0 Npx`）做 focus 指示，因為 box-shadow 喺 border box 內／緊貼邊緣，唔會被 `clip-path` 剪走；或者為 focus 狀態改用 `outline` + `clip-path: none`；或者外層再包一層負責畫 ring。**必須保留「切角」視覺語言**（spec §5.4）。

---

#### P0-4：搜尋 modal 冇 dialog 語意、冇 focus trap、Esc 後 focus 留在隱藏 input

**實測（`a7-keyboard-journey.json` → `keyboard.openViaSlash` / `focusTrap` / `escSearch`）**

| 檢查 | 實測值 |
|---|---|
| `#search-modal` 有冇 `role` | **`null`** |
| 有冇 `aria-modal` | **`null`** |
| 有冇 `aria-labelledby` | **`null`** |
| `.search-content` 有冇 `role` | **`null`** |
| 背景 `#app-root` 有冇 `inert` | **`false`** |
| 背景有冇 `aria-hidden` | **冇** |
| 關閉按鈕 `#search-close` 尺寸 | **14 × 24 px** |
| 搜尋輸入框尺寸 | 322 × 34 px |
| 全頁 `role="dialog"` 數量 | **0** |
| 全頁 `inert` 數量 | **0** |
| `/` 鍵開搜尋 | ✓ 成功，focus 落 `#search-input` |

**Focus trap 實測（由 modal 內連續 Tab 8 次）**

```
Tab 1 → #search-close         (insideModal: true)
Tab 2 → BODY                  (insideModal: false)   ← 立即逃離
Tab 3 → a.skip-link           (insideModal: false)
Tab 4 → #btn-mode             (insideModal: false)
Tab 5 → #btn-search           ...
Tab 6 → #btn-share
Tab 7 → #btn-export
Tab 8 → #btn-theme
```

**Esc 行為實測**

| 項目 | 實測值 |
|---|---|
| Esc 之前 focus | `#search-input` |
| Esc 之後 modal 開唔開 | 關咗（`modalOpen: false`）✓ |
| Esc 之後 `document.activeElement` | **仍然係 `#search-input`** |
| 該 input 係唔係仍然「可 focus 但隱藏」 | **`hiddenStillFocusable: true`** |

**連鎖後果（實測，`keyboard.shortcuts`）**：因為 focus 卡喺隱藏嘅 `#search-input`，`app.ts:267` 嘅全域 keydown handler 第一行就 `if (e.target instanceof HTMLInputElement) return;`。結果：

| 快捷鍵 | 期望 | 實測 |
|---|---|---|
| `ArrowRight` 改章 | ch1 → ch2 | **ch1 → ch1（無效）** |
| `Shift+/`（`?`）開關於 | 開 | **冇開（`aboutOpen: false`）** |
| `/` 再開搜尋 | 開 | **冇開（`searchModalOpen: false`）** |

**即係話：用戶用一次搜尋 + Esc 之後，所有鍵盤快捷鍵都會靜默失效，直到佢用滑鼠點其他地方。**

**根因**：`SearchBox.show()`（`SearchBox.ts:27-60`）只係 `classList.add("open")`；`hide()` 只係 `classList.remove("open")`。冇 focus 管理、冇 focus restore、冇 trap、冇 `role="dialog"`、Esc 只綁喺 `input` 上（`SearchBox.ts:53-55`）。

---

#### P0-5：Journey C / Journey D 無法用鍵盤完成

**實測（`a7-keyboard-journey.json` → `keyboard.journeyC` / `journeyD`）**

**Journey C（搵角色路線）**

| 步驟 | 期望 | 實測 | 結果 |
|---|---|---|---|
| 1. `/` 開搜尋 | 開 | 開，focus 落 input | ✓ |
| 2. 打「夏晴」 | 出結果 | 30 個結果，第一個 `角色 夏晴 ch1` | ✓ |
| 3. 結果係唔係可聚焦 | `tabindex` 或 `role=option` | `<li>`，`tabIndex = -1`、`tabindex = null`、`role = null`、父 `<ul>` 亦冇 `role` | **✗** |
| 4. ArrowDown 揀下一個 | focus 移到結果 | focus **仍然喺 `#search-input`**，`aria-activedescendant = null` | **✗** |
| 5. Enter 開啟 dossier | 開角色檔案 | modal **仍然開住**、chapter 仍然 `1`、hash 空 | **✗** |
| 6. 角色 dossier 存在？ | 有 | `hasCharacterDossier: false` | **✗** |
| 7. route 區存在？ | 有 | `hasRouteSection: false`、`routeItems: 0` | **✗** |
| 8. waypoint 清單存在？ | 有 | `waypointEls: 0` | **✗** |

**結論：Journey C 用鍵盤完全無法完成（第 3 步就斷）。** 而且即使換成滑鼠，`char-chip` 嘅 click handler 本身係 `console.log("char click:", name)` + `// TODO: open character modal`（`StoryPanel.ts:162-169`），`.route-item` 亦只係 `setChapter(chapters_span[0])`（`StoryPanel.ts:170-176`）—— **Journey C 嘅核心（角色 dossier、route 突出、waypoint 清單）根本未實作，同鍵盤無關。**

**Journey D（搵事件／地點）**

| 步驟 | 期望 | 實測 | 結果 |
|---|---|---|---|
| 1. 搜尋分類 | 5 類（character/zone/location/event/chapter，spec §3） | 只有 **3 類**（`角色 3` + `事件 47`），`hasZoneOrChapterType: false` | **✗** |
| 2. 打「病腦」 | 出結果 | 50 個（硬上限 `results.slice(0, 50)`） | ✓ |
| 3. 鍵盤揀結果 | 可揀 | 同 Journey C，`<li>` click-only | **✗** |
| 4. Enter fly-to + detail | 有 | chapter 仍然 `1`、hash 空、`selectedEventVisible: false` | **✗** |
| 5. detail 顯示 summary / characters / chapter refs / spoiler / precision / zone relation | 有 | 面板仍然係編年史首屏，冇 event detail | **✗** |

**結論：Journey D 用鍵盤完全無法完成。**

---

### Tab 順序記錄（首 20 個，實測）

**量測方式**：全新載入 → 等 app 完成首次 render（`.ch-pill` > 100）→ 連續 `page.keyboard.press("Tab")`，每次讀 `document.activeElement`。資料：`a7-keyboard-journey.json` → `mobileTabOrder.first25` / `desktopTabOrder.first20`。

**mobile-390×844**

| # | tag | id | class | 文字 | 區域 | 尺寸 | x | 喺 viewport |
|---|---|---|---|---|---|---|---|---|
| 1 | button | — | `ch-pill` | `2` | chapterStrip | 30 × 24 | 48 | ✓ |
| 2 | button | — | `ch-pill` | `3` | chapterStrip | 30 × 24 | 80 | ✓ |
| 3 | button | — | `ch-pill` | `4` | chapterStrip | 30 × 24 | 112 | ✓ |
| 4 | button | — | `ch-pill` | `5` | chapterStrip | 30 × 24 | 144 | ✓ |
| 5 | button | — | `ch-pill` | `6` | chapterStrip | 30 × 24 | 176 | ✓ |
| 6 | button | — | `ch-pill` | `7` | chapterStrip | 30 × 24 | 208 | ✓ |
| 7 | button | — | `ch-pill` | `8` | chapterStrip | 30 × 24 | 240 | ✓ |
| 8 | button | — | `ch-pill` | `9` | chapterStrip | 30 × 24 | 272 | ✓ |
| 9 | button | — | `ch-pill` | `10` | chapterStrip | 31.4 × 24 | 304 | ✓ |
| 10 | button | — | `ch-pill` | `11` | chapterStrip | 31.4 × 24 | 337.4 | ✓ |
| 11 | button | — | `ch-pill` | `12` | chapterStrip | 31.4 × 24 | 370.7 | ✓ |
| 12 | button | — | `ch-pill` | `13` | chapterStrip | 31.4 × 24 | **179.1** | ✓ |
| 13 | button | — | `ch-pill` | `14` | chapterStrip | 31.4 × 24 | 212.4 | ✓ |
| 14 | button | — | `ch-pill` | `15` | chapterStrip | 31.4 × 24 | 245.8 | ✓ |
| 15 | button | — | `ch-pill` | `16` | chapterStrip | 31.4 × 24 | 279.2 | ✓ |
| 16 | button | — | `ch-pill` | `17` | chapterStrip | 31.4 × 24 | 312.5 | ✓ |
| 17 | button | — | `ch-pill` | `18` | chapterStrip | 31.4 × 24 | 345.9 | ✓ |
| 18 | button | — | `ch-pill` | `19` | chapterStrip | 31.4 × 24 | 379.2 | ✓ |
| 19 | button | — | `ch-pill` | `20` | chapterStrip | 31.4 × 24 | **179.6** | ✓ |
| 20 | button | — | `ch-pill` | `21` | chapterStrip | 31.4 × 24 | 213 | ✓ |

**摘要**：`firstIsSkipLink: false`、`firstNavIndex: null`、`firstMapCtrlIndex: null`（首 25 個都未到）、`offscreenStopsInFirst25: 0`。

> **兩個值得注意嘅細節**：
> 1. **Tab #1 係 ch-pill「2」而唔係 ch-pill「1」** —— 因為 starting point 已經被 `scrollIntoView` 移到 ch-pill「1」，所以 Tab 由「2」開始。
> 2. **Tab #12 同 #19 之後 x 座標跳返去 179** —— 呢個係 `ChapterStrip.ts:75` 嘅 `scrollIntoView({ inline: "center" })` 每次 focus 到邊緣 pill 就將佢捲到中間。呢個係**另一個鍵盤可用性問題**：用戶每 Tab 幾次，章節條就會大幅橫向捲動，視覺焦點跳動。

**desktop-1440×900（首 20 個全部係 `ch-pill`，34 × 26，全部喺 viewport 內）**

| # | tag | class | 區域 | 尺寸 |
|---|---|---|---|---|
| 1–20 | button | `ch-pill` | chapterStrip | 34 × 26 |

**摘要**：`firstIsSkipLink: false`、`firstNavIndex: null`。

> **同源結論**：desktop 同 mobile 一樣，第一個 Tab stop 都唔係 skip link，頂欄亦到唔到（`scrollIntoView` 同樣喺 1440px 觸發）。**呢個唔係 mobile 專屬問題。**

---

### P1 — 嚴重

---

#### P1-1：真正 < 44×44 嘅可見互動元素清單（mobile-390，共 24 個）

**量測準則**：真互動語意（`button` / `a[href]` / `input` / `select` / `textarea` / `summary` / 互動 `role` / 非 SVG 嘅 `tabindex>=0`）+ 中心點喺 viewport + 冇被遮蓋 + 冇喺 `aria-hidden`/`inert` 之下。**排除 SVG 內部幾何元素**（`#svg-map` 內 66 個元素全部 `tabIndex = -1`，唔屬互動語意）。

| # | 元素 | 尺寸 (w×h) | 文字／名稱 | 所屬區 |
|---|---|---|---|---|
| 1 | `button#btn-mode.nav-btn` | **39 × 76** | 📜 編年史 | 頂欄導覽 |
| 2 | `button#btn-search.nav-btn` | **39 × 76** | 🔍 搜尋 | 頂欄導覽 |
| 3 | `button#btn-share.nav-btn` | **39 × 76** | 🔗 | 頂欄導覽 |
| 4 | `button#btn-export.nav-btn` | **29 × 76** | ⬇ | 頂欄導覽 |
| 5 | `button#btn-theme.nav-btn` | **39 × 76** | ☀️ | 頂欄導覽 |
| 6 | `button#btn-help.nav-btn` | **29.2 × 76** | ? | 頂欄導覽 |
| 7 | `button#btn-about.nav-btn` | **34.5 × 76** | 關於 | 頂欄導覽 |
| 8 | `button#btn-toggle-panel.nav-btn` | **34.5 × 76** | 面板 | 頂欄導覽 |
| 9 | `button.ch-pill.active` | **33 × 26.4** | 第 1 章: 香港 | 章節條 |
| 10–20 | `button.ch-pill` × 11 | **30–31.4 × 24** | 第 2–12 章 | 章節條 |
| 21 | `button#legend-lang-btn` | **30.7 × 16** | EN | 地圖圖例 |
| 22 | `button#map-zoom-in.map-ctrl` | **30 × 30** | + | 地圖控制 |
| 23 | `button#map-zoom-out.map-ctrl` | **30 × 30** | − | 地圖控制 |
| 24 | `button#map-reset.map-ctrl` | **30 × 30** | ⌂ | 地圖控制 |

**全部 24 個都係「寬度」不足（高度普遍夠）；只有 `#legend-lang-btn` 係高度亦不足（16px）。**

**其他 viewport（同源 CSS，規模不同）**

| Viewport | 真互動可見元素 | < 44px 違規 | 其中 < 24px（WCAG 2.2 SC 2.5.8 亦不合格） |
|---|---|---|---|
| mobile-390 | 24 | **24** | 1（`#legend-lang-btn` 16px 高） |
| tablet-768 | 33 | **33** | 1 |
| desktop-1440 | 240 | **240** | **190** |

> **desktop 為何係 240？** 因為桌面版 `#story-pane` **唔會收合**，160,405px 高嘅編年史 timeline 就喺 viewport 內：198 條 `button.chr-tl-bar`（**寬 1px**！）+ 8 個 `button.chr-ch`（58.7×18）+ 8 個 `button.chr-toggle`（22×15）+ `#chr-export-json`（60.4×23），加埋 40 個 `ch-pill`、8 個 nav、3 個 map-ctrl、1 個 legend 鈕。**呢啲係 desktop 真實存在嘅違規，唔係量測誤差**（已通過中心點 + `elementFromPoint` 遮蓋檢查）。

**1px 闊嘅 `button.chr-tl-bar` 係最嚴重嘅一個**：佢係編年史時間軸嘅互動 bar，用 `flex` 按事件數量分配闊度，視覺上係一條 bar，但實際 `<button>` 只有 1px 闊 —— 滑鼠都幾乎點唔到，鍵盤 focus 到亦睇唔到 ring。

**最小尺寸樣本**：`button.chr-tl-bar` `1×3.1`、`button.chr-toggle` `22×15`、`#legend-lang-btn` `30.7×16`。

**CSS 根因**（`src/styles/main.css:1101-1105`）

```css
@media (max-width: 639px) {
  .nav-btn { padding: 5px 10px; font-size: var(--fs-sm); }
  .map-ctrl { width: 30px; height: 30px; font-size: var(--fs-base); }
  .ch-pill { min-width: 30px; height: 24px; }
}
```

`@media (max-width: 639px)` 刻意將 `map-ctrl` 縮到 30×30、`ch-pill` 縮到 30×24 —— 直接違反 spec §7.2 第 9 項「touch target >= 44px」。**注意 `.nav-btn` 冇設定 min-height，只係靠 padding 撐出 76px 高，但闊度由文字長度決定（29–39px）。**

---

#### P1-2：地圖 0 / 19 個互動元素鍵盤可達

**實測（`a7-probe-map2.json` + `a7-keyboard-journey.json` → `mapKeyboard`）**

| 選擇器 | 數量 | `tabIndex` | `tabindex` attr | `role` | `aria-label` | 有 `<title>` | 鍵盤可達 |
|---|---|---|---|---|---|---|---|
| `.zone` | 1 | -1 | null | null | 0 | 1 | **0** |
| `.zone-area` | 1 | -1 | null | null | 0 | 0 | **0** |
| `.zone-badge` | 1 | -1 | null | null | 0 | 0 | **0** |
| `.location-marker` | 1 | -1 | null | null | 0 | 1 | **0** |
| `.location-marker-cluster` | 4 | -1 | null | null | 0 | 4 | **0** |
| `.event-marker` | 11 | -1 | null | null | 0 | 11 | **0** |
| `.route-line` | 1 | -1 | null | null | 0 | 1 | **0** |
| **合計** | **19** | 全部 -1 | 全部 null | 全部 null | **0** | 18 | **0** |

- `#svg-map` 內 66 個元素：`tabIndex` 分佈 = `{-1: 66}`，`role` 數 = 0，`aria-label` 數 = 0。
- 互動綁定係**單一 delegated click handler**（`SvgMap.ts:625` `this.svg.addEventListener("click", ...)`）→ **純滑鼠／觸控**，冇任何 `keydown` 路徑。
- `.zone-area` computed `pointer-events: **none**`（同 `ux-product-audit.md` P0-1 一致）→ 即使滑鼠都點唔到 zone polygon。
- 18 個元素有 SVG `<title>`（tooltip），但**因為元素唔可聚焦，螢幕閱讀器同鍵盤都用唔到**。

---

#### §10.9 更新（2026-09-24）：P1-2 已修，量測方法同時修正

**已修**：見 `docs/progress/p1-2-map-keyboard-access.md`（roving tabindex +
`role="button"` + `aria-label` + `Enter`／`Space` 啟動 + 方向鍵組內移動 +
`drop-shadow` 焦點環）。

**⚠️ 量測方法亦要修 —— 舊指標係錯嘅**

舊 `a7-probe-map2.mjs` 只量：

```js
keyboardReachable: els.filter(e => e.tabIndex >= 0).length   // ← 「有冇 tabindex」
```

呢個指標有兩個問題：

1. `tabindex="0"` **唔等於**真係可以用鍵盤揀到 —— 元素可能離屏／被遮蓋
   （focus 到但用戶睇唔到），或者冇 `keydown` 路徑（focus 到但 `Enter` 冇反應）。
2. **roving tabindex 之下只有一個 `tabindex="0"`** —— 舊指標會報「**1**」，
   完全反映唔到「其實全部 72 個元素都可以用方向鍵到達」。實測：
   新舊指標同時量到 `oldMetricHasTabindexGE0 = 1` vs
   `keyboardReachable = 25`。

**新量測方法（真鍵盤驅動，唔靠屬性推斷）**

| 步驟 | 動作 |
|---|---|
| 1 | 焦點放 `#svg-map` → 按 `Tab` → 記低落到邊個地圖元素（`tabEnteredMap`） |
| 2 | 連按 `ArrowRight`（環繞）24 次，每次記低 `document.activeElement` 嘅身份 → 數**唔同**元素 = `keyboardReachable` |
| 3 | 按 `Enter` → 驗證真係觸發（`.zone.is-selected` 增加 **且** URL 帶 `zone=<id>`）= `keyboardActivatable` |
| 4 | 逐像素比對 focused vs unfocused 截圖 = `focusRingVisible` |
| 5 | 另報屬性覆蓋率同 roving 不變式 |

**實測結果（`artifacts/audit-A7/a7-probe-map2.json`，1400×900）**

| 指標 | 值 |
|---|---|
| `keyboardReachable` | **25**（24 次方向鍵 + 1 次 Tab 到達 25 個唔同元素） |
| `keyboardActivatable` | **true**（`sel 0 → 1`、URL 由 `/` 變 `/?zone=zone_e0a9ccb6fd`） |
| `focusRingVisible` | **true** |
| `tabEnteredMap` | **true** |
| 互動元素總數 | 72（`.zone`／`.route-line`／`.location-marker`／`-cluster`／`.event-marker`） |
| 有 `role="button"` | **72 / 72（100%）** |
| 有 `aria-label` | **72 / 72（100%）** |
| roving 不變式 | `tabindex="0"` = **1**、`tabindex="-1"` = 71 ✓ |
| 舊指標（對照） | `tabIndex >= 0` = **1** ← 證明舊指標失效 |

**判定：§10.9 PASS**（原本 0/14）。

**重跑**：

```bash
# 先起 preview（dist/）
npx vite preview --port 5174 --strictPort &
BASE_URL=http://localhost:5174/ node artifacts/audit-A7/a7-probe-map2.mjs
```

---

#### P1-3：冇 `aria-live`、冇 `aria-current`、`aria-expanded` 只覆蓋 1 個控制項

**實測（`a7-aria-summary.json`，mobile-390）**

| ARIA 屬性 | 全頁出現次數 | 問題 |
|---|---|---|
| `aria-live` / `role=status` / `role=alert` / `role=log` | **0** | 章節切換、搜尋結果數量變化、面板內容更新、地圖飛航完成 —— **全部冇任何播報**。螢幕閱讀器用戶按 `←`/`→` 改章之後完全唔知發生咩事 |
| `aria-current` | **0** | 目前章節 pill 只用 `.active` class（`ariaCurrentStyledCount: 0`）。視覺上有樣式，程式上冇狀態 |
| `aria-expanded` | **1** | 只有 `#btn-toggle-panel`（`aria-expanded="false"`，`aria-controls="story-pane"`，`synced: true` ✓）。編年史嘅 `button.chr-toggle`（1,320 個「展開／收起」鈕）**完全冇 `aria-expanded`** |
| `aria-controls` | 1 | 同上 |
| `role` | 2 | `application` ×1（見 P1-5）、`group` ×1 |
| `aria-label` | 399 | 197 個 `ch-pill` + 其他 |
| `aria-hidden` | 1,327 | `span.chr-mark` ×1,320 + `span.chr-period-line` ×6 + `canvas#basemap-canvas` ×1（都係裝飾，正確） |
| `inert` | **0** | 完全冇用過 |
| `role="dialog"` | **0** | 搜尋 modal、關於 modal 都冇 |

---

#### P1-4：首屏只有 1 個 heading；章節條／圖例／地圖完全冇 heading 結構

**實測（`a7-aria-summary.json`）**

| 指標 | 實測值 |
|---|---|
| 全頁 heading 總數 | 1,328 |
| **中心點喺 viewport 內嘅 heading** | **1**（`h1: 《病港》互動地圖`） |
| Heading 跳級（h1→h3 等） | **0 個** ✓（層級本身冇跳） |
| 離屏 heading | 1,327（`h2 第一季編年史`、`h3.chr-period-title` ×多、`h4.chr-entry-title` ×1,320） |

**問題**：首屏（地圖 + 章節條 + 圖例 + 頂欄）除咗 `h1` 之外**冇任何 heading**。螢幕閱讀器用戶用 heading 導覽（NVDA/JAWS 嘅 `H` 鍵）喺首屏只能夠跳到 `h1`，完全跳唔到「章節條」、「地圖」、「圖例」呢三個主要區塊。**呢個唔係「層級跳級」問題，而係「首屏根本冇結構」問題。**

---

#### P1-5：`#app-root` 用 `role="application"` 會令螢幕閱讀器進入 application mode

**實測**

```html
<div id="app-root" role="application" aria-label="《病港》互動地圖主程式">
```

`role="application"` 會令 NVDA/JAWS 由「browse mode」切換到「application mode」，之後所有單鍵快速導覽（`H` 跳 heading、`K` 跳連結、`B` 跳按鈕、`D` 跳 landmark）**全部失效**，要由用戶手動切返 browse mode。對於一個以「閱讀內容」（1,320 張編年史卡、1,796 條事件）為主嘅產品，呢個係方向相反嘅選擇。正確做法係只用 `role="application"` 包住真正需要接管鍵盤嘅子元件（例如地圖），唔應該包住成個 app。

---

#### P1-6：`prefers-reduced-motion` 只做一半 —— CSS 層有效，JS 驅動動畫完全無效

**第一層實測（CSS，`a7-remeasure.json`）**

| 情境 | `matchMedia("(prefers-reduced-motion: reduce)")` | animation 數 | transition 數 |
|---|---|---|---|
| mobile-390，`no-preference` | `false` | 2 | **3,155** |
| mobile-390，`reduce` | `true` | **0** | **0** |
| desktop-1440，`reduce` | `true` | **0** | **0** |

→ **CSS 層完全有效**。`main.css:1107-1112` 同 `main.css:2040-2047` 兩處 `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; } }` 確實將 3,157 個動態歸零。**上一輪將 `mobileReduceRunning: 0` 列為疑似問題係誤讀 —— 0 係正確結果。**

**第二層實測（JS 驅動，`a7-motion-rootcause.json`）** —— 逐 frame（rAF）取樣 1.5 秒，期間按 `End` 跳去第 198 章觸發 `flyToChapter`：

| 指標 | `no-preference` | `reduce` | 差異 |
|---|---|---|---|
| `#svg-map` computed `transition-duration` | `0s` | `1e-06s` | CSS 已中和 |
| `viewBox` 相異值數量 | **11** | **11** | **完全一樣** |
| `viewBox` 起始 → 結束 | `113.79 22.11 0.7 0.5407` → `114.148 22.388 0.155 0.120` | 同上 | 一樣 |
| `#strip-track.scrollLeft` 相異值數量 | **55** | **57** | **完全一樣** |
| `scrollLeft` 起始 → 結束 | `0` → `6893` | `0` → `6893` | 一樣 |

**根因（兩個，都係 JS 驅動，CSS 媒體查詢管唔到）**

1. **`SvgMap.animateViewBox()`**（`src/components/SvgMap.ts:1019-1066`）
   ```ts
   private animateViewBox(target: ViewBox, durationMs: number = ANIM_DURATION_MS): void {
     ...
     const step = (now: number) => {
       const t = Math.min(1, (now - t0) / durationMs);
       const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
       this.view = this.clampView({ x: ..., y: ..., w: ..., h: ... });
       this.applyViewBox();
       if (t < 1) this.animFrameId = requestAnimationFrame(step);
       ...
     };
     this.animFrameId = requestAnimationFrame(step);
   }
   ```
   **完全冇檢查 `matchMedia("(prefers-reduced-motion: reduce)")`。** 呢個係地圖最主要嘅動態（每次改章、每次點 marker、每次搜尋跳轉都會觸發）。

2. **`scrollIntoView({ behavior: "smooth" })`** —— `ChapterStrip.ts:75`（改章時將 pill 捲到中間）同 `ChronicleView.ts:425`（捲到編年史條目）。`main.css` 嘅 `scroll-behavior: auto !important` **唔會覆蓋** API 上顯式指定嘅 `behavior: "smooth"`。

**修法方向**：`animateViewBox()` 開頭加 `const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; if (reduce) durationMs = 0;`（或直接跳去最終 view）；`scrollIntoView` 嘅 `behavior` 改為 `reduce ? "auto" : "smooth"`。

---

#### P1-7：完全冇 safe-area 支援

**實測（`a7-focus-verify.json` → `safeAreaSimulation`）**

| 檢查 | 實測值 | 判定 |
|---|---|---|
| `<meta name="viewport">` | `width=device-width, initial-scale=1.0` | **冇 `viewport-fit=cover`** ✗ |
| stylesheet 內 `env(safe-area-inset-*)` 規則數 | **0** | ✗ |
| `.map-controls` 距底 12px、距右 12px | `bottom gap = 12px` | **落喺 home indicator 區**（假設 34px）✗ |
| `#topbar` 距頂 | `top gap = 0px` | **落喺 notch / Dynamic Island 區**（假設 47px）✗ |
| `#btn-toggle-panel` 距右 | `6.5px` | 邊緣過窄 ✗ |

**問題**：iPhone 14/15/16 系列（notch / Dynamic Island + home indicator）上，頂欄文字同 8 個導覽按鈕會部分被系統 UI 遮住；地圖控制按鈕會同 home indicator 手勢區重疊（用戶想按 `⌂` 重置會觸發返 home）。

---

#### P1-8：圖例遮蓋 24.3% 地圖，超過 15% 門檻且不可摺疊

**實測（`a7-focus-verify.json` → `legend_mobile-390`）**

| 指標 | mobile-390 | tablet-768 |
|---|---|---|
| Viewport | 390 × 844 | 768 × 1024 |
| 地圖 mount | 390 × 657 | 768 × 875.5 |
| `#map-overlay` 尺寸 | **221 × 281.5**（位置 x=12, y=199） | 221 × 281.5 |
| 佔 viewport 面積 | 18.9% | 7.9% |
| **佔地圖面積** | **24.3%** | 9.3% |
| 佔地圖闊度 | **56.7%** | 28.8% |
| 佔地圖高度 | **42.8%** | 32.2% |
| 圖例項目數 | 9 | 9 |
| 圖例字級 | 11px | 11px |
| 地圖控制遮蓋 | 1.15% | 0.56% |
| 剩餘自由地圖面積 | **74.6%** | 90.2% |
| 可摺疊？ | **否**（`collapsible: false`） | 否 |

**門檻**：spec §7.2 第 9 項 + `v2-checks.mjs` 9.6 = 「遮蓋 ≤ 15% **或**可摺疊」。**兩者都唔滿足** → FAIL。手機上地圖有 56.7% 闊度、42.8% 高度被圖例佔用。

**附帶**：圖例 9 個項目全部係「顏色 dot + 文字」，冇 heading、冇 landmark、冇 `aria-label` 群組。

---

#### P1-9：頂欄標題 4 行；320px 時每字一行

**實測（`a7-audit-summary.json` + `a7-focus-verify.json` → `narrow320`）**

| 指標 | mobile-390 | narrow-320 |
|---|---|---|
| `#topbar` 高度 | **107px** | **107px** |
| `h1` 行數 | **4 行** | — |
| `h1` 尺寸 | — | **32.4 × 90px**（即每個中文字一行，約 6 行） |
| 導覽列行數 | 1 | 1 |
| 導覽按鈕數 | 8 | 8 |
| 圖例佔 viewport | 18.9% | **34%** |
| 地圖 mount 高度 | 657px | **381px** |
| 橫向 overflow | 冇 ✓ | 冇 ✓ |

**問題**：`h1` 文字係「《病港》互動地圖」（8 個字元 + 書名號），喺 390px 闊要 4 行（因為 `#topbar` 用 flex 同 8 個導覽按鈕爭位）。spec §7.2 第 9 項要求標題 ≤ 2 行。320px 時更極端：`h1` 只有 32.4px 闊，即每個字一行。

---

### P2 — 一般

---

#### P2-1：故事面板唔係 bottom sheet（`position: absolute` 側邊抽屜）

**實測（`a7-keyboard-journey.json` → `panel`）**

| 檢查 | 實測值 |
|---|---|
| `hasBottomSheetClass` | **false** |
| `hasDragHandle` | **false** |
| `hasSnapPoints` | **false** |
| `position` | `absolute` |
| `top` / `bottom` | `0px` / `0px`（貼齊上下） |
| `width` | `343.188px`（= `min(360px, 88vw)`） |
| `touchAction` | `auto`（**冇設 `touch-action`**） |
| `borderTopLeftRadius` | 冇圓角 |
| 開啟後 `coversMapPct`（overlap ÷ 地圖面積） | **88%** |
| 開啟後 `coversMapPct`（面板面積 ÷ viewport 面積） | **68.5%**（上一輪數字，定義不同，兩者都對） |

**問題**：面板係「由右邊滑入、蓋住 88% 地圖」嘅側邊抽屜，唔係 spec §7.2 第 9 項要求嘅 bottom sheet。冇 drag handle、冇 snap points、冇 `touch-action` 設定（`touch-action: auto` 表示瀏覽器會將垂直拖曳當成頁面滾動，同面板嘅滑動手勢衝突）。

---

#### P2-2：面板開啟後 focus 冇移入；Esc 唔會收埋面板

**實測（`a7-keyboard-journey.json` → `panel`）**

| 情境 | `collapsed` | `aria-expanded` | focus 喺邊 | `focusMovedIntoPanel` |
|---|---|---|---|---|
| 初始（mobile-390） | `true` | `false` ✓ 同步 | body | — |
| 點「面板」開啟後 | `false` | `true` ✓ 同步 | 仍然係 `#btn-toggle-panel` | **`false`** ✗ |
| 按 Esc（第 1 次） | **`false`（唔會收埋）** ✗ | `true` | `#btn-toggle-panel` | — |
| 按 Esc（第 2 次） | **`false`** ✗ | `true` | `#btn-toggle-panel` | — |

- **`aria-expanded` 同步正確**（`synced: true`）—— 呢點做得好。
- **Esc 唔會收埋面板**：`app.ts:286-308` 嘅 Esc handler 只處理「關浮層 → 清選擇」，**冇處理收合面板**。
- **開啟後 focus 冇移入面板**：面板視覺上蓋住 88% 地圖，但 focus 仍然留喺頂欄按鈕，螢幕閱讀器用戶唔知面板已開。

---

#### P2-3：對比違規清單（畫面上文字節點）

**計算方法**：見「假設與證據」第二節。**注意 222 個文字節點嘅背景含 gradient，判定屬保守估算。**

**Dark 主題（`data-theme="dark"`，body bg `rgb(11, 15, 22)`）— 畫面上 38 個文字節點中 12 個 fail**

| # | 元素 | 文字 | 前景色 | 背景色 | 對比度 | 需要 | 字級／字重 | 背景不確定 |
|---|---|---|---|---|---|---|---|---|
| 1–11 | `button.ch-pill`（第 2–12 章） | `2`…`12` | `rgb(107,124,150)` | `rgb(20,23,30)` | **4.22** | 4.5 | 12px / 600 | 是（gradient） |
| 12 | `button#legend-lang-btn` | `EN` | `rgb(107,124,150)` | `rgb(25,30,38)` | **3.93** | 4.5 | 10px / 650 | 否 |

**Light 主題（`data-theme="light"`，body bg `rgb(244, 241, 234)`）— 畫面上 38 個文字節點中 6 個 fail**

| # | 元素 | 文字 | 前景色 | 背景色 | 對比度 | 需要 | 字級／字重 | 背景不確定 |
|---|---|---|---|---|---|---|---|---|
| 1 | `button#btn-theme` | `☀️` | `rgb(15,127,156)` | `rgb(223,231,227)` | **3.67** | 4.5 | 12px / 500 | 是 |
| 2 | `span.strip-current` | `第` | `rgb(123,135,148)` | `rgb(244,241,234)` | **3.25** | 4.5 | 12px / 400 | 是 |
| 3 | `strong#strip-ch-num` | `1` | `rgb(168,134,26)` | `rgb(244,241,234)` | **3.06** | 4.5 | 14px / 700 | 是 |
| 4 | `span#strip-summary` | `香港：故事舞台位於香港，病毒爆發後第一個星期過去，整個香…` | `rgb(123,135,148)` | `rgb(244,241,234)` | **3.25** | 4.5 | 12px / 400 | 是 |
| 5 | `div.legend-title` | `地圖標記` | `rgb(15,127,156)` | `rgb(250,248,244)` | **4.38** | 4.5 | 10px / 700 | 否 |
| 6 | `button#legend-lang-btn` | `EN` | `rgb(123,135,148)` | `rgb(250,249,244)` | **3.47** | 4.5 | 10px / 650 | 否 |

**離屏（打開面板後會見到）**

| 主題 | 離屏文字節點 | 離屏 fail | 主要來源 |
|---|---|---|---|
| dark | 8,385 | **3,123** | 編年史卡文字、`a.skip-link`（2.91:1）、其餘 185 個離屏 ch-pill（4.22:1） |
| light | 8,385 | **3,938** | 編年史卡文字、離屏 ch-pill |

**`a.skip-link` 對比度 2.91:1（dark）** 值得單獨提：skip link 係鍵盤用戶第一個應該見到嘅元素，但佢嘅對比度唔合格。

---

#### P2-4：搜尋只有 3 類，spec 要求 5 類

**實測（`a7-keyboard-journey.json` → `journeyD.resultsBefore`）**

| 項目 | 實測 | spec §3 Journey D 要求 |
|---|---|---|
| 分類數 | **3**（`角色` / `事件` / `地點`） | **5**（character / zone / location / event / chapter） |
| 結果硬上限 | `results.slice(0, 50)`（`SearchBox.ts:131`） | 未明文，但「…另外 N 個結果」只有文字提示，冇分頁／載入更多 |
| 搜尋範圍 | character name/aliases、event title/description、location name | 未包含 **zone** 同 **chapter** |
| Debounce | **冇**（`input` 事件即時 `renderResults`） | §7.4 要求 ≤150ms（實測 0.55–0.92ms，有極大餘裕，唔算問題） |

**`typeLabel()`（`SearchBox.ts:158-160`）** 只有三個分支，`zone` / `chapter` 會 fallback 到「地點」。

---

#### P2-5：`#search-results` 變成多餘 Tab stop；關閉按鈕過細

**實測（`a7-modal.json`）**

| 檢查 | mobile-390 | desktop-1440 |
|---|---|---|
| `#search-modal` `role` | null | null |
| `#search-modal` `aria-modal` | null | null |
| `#search-modal` `aria-label` / `aria-labelledby` | null / null | null / null |
| `.modal-backdrop` `role` | null | null |
| `#search-input` 尺寸 | 322 × 34 | 492 × 34 |
| `#search-close` 尺寸 | **14 × 24** | **14 × 24** |
| 內容 `rect` | 0, 324.8, 390 × 194.5 | 440, 352.8, 560 × 194.5 |
| 橫向 overflow | 冇 ✓ | 冇 ✓ |

**Tab 序（`a7-modal.json` `tabSeq`）**：

```
Tab 1 → BUTTON#search-close        (insideModal: true)
Tab 2 → DIV#search-results         (insideModal: true)   ← 冇語意、冇內容可聚焦
Tab 3 → BODY                       (insideModal: false)  ← 逃離 modal
Tab 4 → A.skip-link
Tab 5 → BUTTON#btn-mode
...
```

`DIV#search-results` 之所以成為 Tab stop，係因為 Chromium 會令「有 overflow 嘅滾動容器」可被鍵盤聚焦（方便鍵盤滾動）。但呢個容器入面嘅 `.search-result-item` **全部唔可聚焦**，所以用戶 Tab 到呢度之後，除咗用方向鍵滾動，乜都做唔到。

**關閉按鈕 14 × 24px** 係全頁第二細嘅互動元素（僅次於 1px 闊嘅 `chr-tl-bar`），而且係 modal 唯一嘅逃離方式（除咗 Esc）。

---

#### P2-6：地圖喺 overview zoom 完全平移唔到，但冇任何提示

**實測（`a7-pan.json`）**

| 情境 | 縮放級別 | 操作 | `viewBox` 有冇變 | 平移成功 |
|---|---|---|---|---|
| 桌面滑鼠拖曳 120px | 3 次 zoom-in | `mouse.down/move/up` | `113.98 → 114.02` | **✓** |
| 手機合成 TouchEvent 拖曳 | 2 次 zoom-in | `touchstart/move/end` | `113.93 → 114.04` | **✓** |
| 手機 CDP 真實觸控拖曳 | 2 次 zoom-in | `Input.dispatchTouchEvent` | `113.93 → 114.06` | **✓** |
| 桌面滑鼠拖曳 120px | **overview（初始）** | 同上 | **完全冇變** | **✗** |
| 手機觸控拖曳 | **overview（初始）** | 同上 | **完全冇變** | **✗** |

**根因**：`clampView()`（`SvgMap.ts:784+`）會將 viewBox 限制喺 `BASEMAP_BBOX` 之內。初始 view 已經係全港視圖，即已經等於 bbox，所以任何方向都 clamp 到冇得郁。**呢個係預期行為，唔係 bug**；但用戶（尤其手機用戶）喺 overview 拖曳地圖時會覺得「地圖壞咗」，冇任何視覺回饋（冇 bounce、冇 hint、冇 cursor 變化）。

**同時確認**：`zoomTouch` 嘅 tap-to-zoom 有效（`viewBox` 由 `0.70` 變 `0.538`，`works: true`，見 `a7-audit-summary.json`）。

---

### 附：Bottom sheet 設計提案（< 1024px）

**現況（實測）**：`position: absolute; top: 0; bottom: 0; width: min(360px, 88vw)`，由右邊滑入，開啟後遮蓋 88% 地圖面積；冇 drag handle、冇 snap points、冇 `touch-action`、冇圓角、冇 focus 管理、Esc 唔會收合（見 P2-1／P2-2）。

以下係提案，**唔係本代理嘅改動**；實作屬 B8。

#### 1. 結構與尺寸

| 項目 | 提案值 | 理由 |
|---|---|---|
| 定位 | `position: fixed; left: 0; right: 0; bottom: 0` | bottom sheet 語意（由下升起），唔再係右側抽屜 |
| 圓角 | `border-radius: 16px 16px 0 0` | 視覺上同「側欄」區分，同時配合 §5.4 切角語言可改用 `clip-path`（**但 focus ring 要用 `box-shadow`，見 P0-3**） |
| 寬度 | `100%`（唔再 `min(360px, 88vw)`） | sheet 係「下層平面」，唔應該只佔 88% |
| 高度 | `height: 100dvh`（**用 `dvh` 唔用 `vh`**） | iOS Safari 網址欄收合時 `vh` 唔會更新，會出現底部被切 |
| 預設 snap | `peek`（見下） | 首屏要留地圖 |
| z-index | 沿用 `60` | 低於 modal（`#search-modal`），高於地圖 |

#### 2. Drag handle

| 項目 | 提案 |
|---|---|
| DOM | `<div class="sheet-handle" role="separator" aria-label="拖曳調整面板高度" tabindex="0" aria-valuenow aria-valuemin aria-valuemax>` |
| 視覺 | `width: 40px; height: 4px; border-radius: 2px; margin: 8px auto 4px` |
| 可觸範圍 | handle 本身 40×4 太細 → **外層 wrapper 要 ≥ 44×44**（padding 20px 上下），符合 P1-1 |
| 鍵盤 | `ArrowUp` / `ArrowDown` 改變 snap point（`aria-valuenow` 同步）；`Enter` / `Space` 切換 `peek ↔ full` |
| 量測驗收 | `hasDragHandle` 由 `false` → `true`；`#btn-toggle-panel` 嘅 `aria-expanded` 繼續同步 |

#### 3. Snap points（3 段）

| 名稱 | 高度 | 內容 | 觸發 |
|---|---|---|---|
| `peek`（預設） | `20dvh`（≈169px @844） | handle + 標題 + 第一行摘要 | 首次載入、向下拖過半 |
| `half` | `50dvh`（≈422px） | + 路線／waypoint 清單 | 向上拖過 30% 門檻 |
| `full` | `90dvh`（≈760px） | 完整 dossier／編年史 | 向上拖過 60% 門檻、或鍵盤 `End` |

- 拖曳結束後**吸附到最近 snap point**（`transition: height 200ms cubic-bezier(.2,0,0,1)`）。
- `prefers-reduced-motion: reduce` → 吸附即時（`duration 0`），見 P1-6。
- 遮蓋率驗收：`peek` 時 `coversMapPct`（overlap ÷ 地圖）**必須 ≤ 25%**，令 `v2-checks.mjs` 9.6 嘅「legend ≤15% 或可摺疊」同新 sheet 可以同時通過。

#### 4. Safe-area

| 項目 | 提案 |
|---|---|
| `index.html` | `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">` |
| sheet 底部 | `padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom))` |
| sheet 內部滾動區 | `padding-bottom` 同上，確保最後一項唔會畀 home indicator 蓋住 |
| `#topbar` | `padding-top: calc(var(--sp-2) + env(safe-area-inset-top))` |
| `.map-controls` | `bottom: calc(12px + env(safe-area-inset-bottom))`、`right: calc(12px + env(safe-area-inset-right))` |
| 驗收 | `safeAreaCssRuleCount` 由 `0` → **≥ 3**；`viewport-fit=cover: true` |

#### 5. 手勢

| 手勢 | 行為 | 實作要點 |
|---|---|---|
| 單指喺 handle 上垂直拖 | 改變 sheet 高度 | `touch-action: none` 喺 handle 上；用 Pointer Events + `setPointerCapture` |
| 單指喺 sheet 內容垂直拖 | 滾動內容 | `touch-action: pan-y` |
| 內容滾到頂再繼續向下拖 | 開始收合 sheet | 檢查 `scrollTop === 0` 才接管 |
| 雙指縮放 | **唔接管** | sheet 內唔做 zoom |
| 喺地圖上單指拖 | 平移地圖（**已實測可用**，見 P2-6） | 維持不變 |
| 喺地圖上雙指縮放 | 縮放地圖（**已實測可用**） | 維持不變 |
| 點地圖（`peek` 狀態下） | 收合 sheet 到 `peek` 或選取元素 | 目前「面板蓋住 88% 地圖」令呢個冇可能 |

**為何要 `touch-action`**：現況 `touch-action: auto`（實測），代表瀏覽器會將垂直拖曳當成頁面滾動。sheet 一定要明確宣告 `touch-action`，否則拖曳 handle 會變成拉動整個頁面。

#### 6. 與地圖互動

| 規則 | 理由 |
|---|---|
| `peek` 時**唔可以**蓋住 `.map-controls`（右下 30×30 三個鈕） | 用戶要繼續 zoom / reset |
| `peek` 時地圖仍然可以單指平移、雙指縮放 | 地圖係主體（spec §0.3「mobile 唔係縮細 desktop」） |
| sheet 拖曳中唔應該觸發地圖平移 | 用 `pointer-events` / `touch-action` 分離；handle 上加 `stopPropagation` |
| 選中地圖元素（zone / marker）→ sheet 自動升到 `half` 並顯示 dossier | Journey B 嘅 mobile 版本 |
| 關閉 sheet → 地圖 view 唔應該改變（唔好自動 zoom） | 避免「切換即迷失」（Journey B 第 5 點） |

#### 7. Focus 管理

| 情境 | 提案行為 | 現況 |
|---|---|---|
| sheet 由 `peek` 升到 `half` / `full` | focus **移入** sheet 第一個 heading 或 close 鈕 | **`focusMovedIntoPanel: false`** ✗ |
| sheet 收合到 `peek` 或關閉 | focus **還原**去觸發按鈕（`#btn-toggle-panel` 或地圖元素） | 冇實作 ✗ |
| sheet 開啟（`half` / `full`）時 | 對 `#map-pane` 加 `inert`（或 `aria-hidden="true"`）→ 地圖唔再可 Tab | `inert: false` ✗ |
| sheet **收合**時 | 對 `#story-pane` 加 `inert` → **2,920 個 Tab stop 歸零** | **完全冇做**（P0-1）✗ |
| `full` 狀態（等同 modal） | focus trap 喺 sheet 內（`role="dialog"` + `aria-modal="true"`） | `role: null` ✗ |
| `peek` / `half` 狀態 | **唔做** focus trap（用戶要 Tab 返地圖） | — |

**注意**：`inert` 係 `aria-hidden` 嘅加強版（同時移除 Tab 序 + 阻擋 AT）。Chromium 102+ / Safari 15.5+ / Firefox 112+ 全支援，**唔需要 polyfill**。如果一定要 `aria-hidden` 路線，就必須同時手動對所有子元素設 `tabindex="-1"`，否則會出現「AT 睇唔到但 Tab 到」嘅更嚴重不一致。

#### 8. Esc 行為（優先次序）

現況 `app.ts:286-308` 嘅 Esc handler 只處理「關浮層 → 清選擇」，**冇處理 sheet**。提案優先次序：

```
Esc 按鍵
 ├─ 1. #search-modal 開住？        → 關 modal + focus 還原去 #btn-search   【P0-4】
 ├─ 2. about modal 開住？          → 關 modal + focus 還原去 #btn-about
 ├─ 3. sheet 喺 full？             → 降到 half（唔係直接關）
 ├─ 4. sheet 喺 half？             → 降到 peek
 ├─ 5. sheet 喺 peek 且地圖有選中？ → 清除選中（現有行為）
 └─ 6. 其他                        → 冇動作（唔好將 focus 移去隱藏元素）【P0-4】
```

**驗收**：`v2-checks.mjs` 10.5 嘅 `sheet.afterEscCollapsed` 由 `false` → `true`（如果定義為「Esc 令 sheet 不再佔用 `half`/`full`」），或改為檢查 `aria-expanded` 由 `"true"` → `"false"`。

#### 9. 量測驗收清單（B8 完成後應全部反轉）

| 指標 | 現況 | 目標 |
|---|---|---|
| `hasDragHandle` | `false` | `true` |
| `hasSnapPoints` | `false` | `true`（≥3 段） |
| `hasBottomSheetClass` | `false` | `true` |
| `touchAction`（sheet） | `auto` | `none`（handle）／`pan-y`（內容） |
| `focusMovedIntoPanel` | `false` | `true` |
| `panel.afterEsc.collapsed` | `false` | `true` |
| `tabbableInside`（collapsed） | **2,920** | **0** |
| `coversMapPct`（overlap÷地圖） | **88** | `peek` ≤ 25 |
| `safeAreaCssRuleCount` | `0` | ≥ 3 |
| `viewport-fit=cover` | `false` | `true` |

---

### 附：上一輪數字 vs 本輪修正對照表（引用時請用本輪）

| 指標 | 上一輪 | 本輪修正 | 修正原因 |
|---|---|---|---|
| mobile-390 `totalTargets` | 3,131 | **3,131**（同一數字，但含義唔同：係 selector 命中數，唔係「可見 touch target」） | — |
| mobile-390 `fail44Count` | **3,131** | **24** | 舊方法冇檢查中心點喺 viewport、冇檢查遮蓋 |
| desktop-1440 `fail44Count` | **3,130** | **240** | 同上 |
| contrast dark fail | **3,135 / 8,423** | 畫面 **12 / 38**；離屏 3,123 / 8,385 | 舊方法行全份 DOM（99.5% 離屏） |
| contrast light fail | **3,943 / 8,423** | 畫面 **6 / 38**；離屏 3,938 / 8,385 | 同上 |
| `mobileReduceAnimations` | 0（疑似問題） | **0 = 正確**（CSS 層有效） | 誤讀；真正問題係 JS 驅動動畫（P1-6） |
| `mobileReduceRunning` | 0（疑似問題） | **0 = 正確** | 同上 |
| `overflowers: 40` | 疑似橫向 overflow | **正常**（`#strip-track` 內滾動嘅 pill；`hasHorizontalOverflow: false`） | 命名誤導 |
| `focusableWhenCollapsed: 2920` | 2,920 | **2,920 ✓ 確認**（已等 chronicle render 完成後複核） | 確認 |
| `panel.afterOpen.coversMapPct: 68.5` | 68.5 | **68.5（面板÷viewport）／88（overlap÷地圖）** | 兩種定義都要講清楚 |
| `panel.afterEsc.collapsed: false` | false | **false ✓ 確認**（連按兩次 Esc 都唔會收埋） | 確認 |
| skip link 係唔係第一個 Tab stop | 兩份 artifact 互相矛盾 | **唔係**（baseline Tab #1 = ch-pill；因果實驗證明係 `ChapterStrip.ts:75` 造成） | 用因果實驗解決矛盾 |

---

## 修改檔案

**冇。** 本代理係只讀審計子代理，冇改動任何 production code、資料、測試、設定檔。

- `src/**` — 冇改
- `data/**` — 冇改
- `public/**` — 冇改
- `tests/**` — 冇改
- `package.json` / `vite.config.ts` / `tsconfig.json` / `scripts/**` / `.gitignore` — 冇改
- git — 冇任何寫操作

**本輪新增（全部喺允許範圍 `docs/audits/` 同 `artifacts/audit-A7/`）**

| 路徑 | 用途 |
|---|---|
| `docs/audits/mobile-a11y-audit.md` | 本報告 |
| `artifacts/audit-A7/a7-verify-targets.mjs` / `.json` / `-brief.json` | 核實 touch target 量測方法（bucket 分析） |
| `artifacts/audit-A7/a7-verify-chronicle.mjs` / `.json` | 證明 2,721 個 chronicle 按鈕離屏 |
| `artifacts/audit-A7/a7-probe-ariahidden.mjs` | `aria-hidden` 目標分佈 + `#story-pane` 狀態 |
| `artifacts/audit-A7/a7-remeasure.mjs` / `.json` / `-brief.json` | 嚴格重新量測（touch / contrast / ARIA / motion / panel） |
| `artifacts/audit-A7/a7-aria-summary.json` | ARIA / 語意精簡摘要（3 個 viewport） |
| `artifacts/audit-A7/a7-probe-map.mjs` / `a7-probe-map2.mjs` / `a7-probe-map2.json` | 地圖互動元素鍵盤可達性 |
| `artifacts/audit-A7/a7-keyboard-journey.mjs` / `.json` | Tab 順序、panel 行為、Journey C/D、modal、快捷鍵 |
| `artifacts/audit-A7/a7-probe-tabstart.mjs` / `2.mjs` / `3.mjs` / `4.mjs` / `5.mjs` | skip link / Tab 起始點因果實驗 |
| `artifacts/audit-A7/a7-focus-ring.mjs` / `a7-focus-ring-clean.mjs` / `a7-focus-ring.json` | focus ring 逐像素量測（含 no-clip-path 對照） |
| `artifacts/audit-A7/a7-motion-rootcause.mjs` / `.json` | reduced-motion 逐 frame 取樣 |
| `artifacts/audit-A7/a7-collapsed-focus.mjs` / `.json` | 收合面板可 Tab 元素數（3 個 viewport） |
| `artifacts/audit-A7/a7-probe-theme.mjs` | 主題切換語意確認（light ↔ dark） |
| `artifacts/audit-A7/a7-probe-touchpan.mjs` / `a7-probe-pan2.mjs` / `a7-pan.json` / `a7-touchpan.json` | 觸控／滑鼠平移驗證 |
| `artifacts/audit-A7/preview-5190b.log` | preview server 日誌 |

---

## 沒有修改但相關的檔案

以下檔案係本輪發現嘅根因所在，**B8 修復時必須改**，但本代理冇改：

| 檔案:行 | 內容 | 對應發現 |
|---|---|---|
| `src/styles/main.css:1080-1084` | `.pane-story.is-collapsed { transform: translateX(100%); pointer-events: none; }` | **P0-1**（收合面板仍可 Tab） |
| `src/app.ts:73-75` | `if (matchMedia("(max-width: 1023px)").matches) pane.classList.add("is-collapsed")` | **P0-1** |
| `src/components/ChapterStrip.ts:75` | `target.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" })` | **P0-2**（頂欄到唔到）+ **P1-6**（smooth scroll 唔尊重 reduce） |
| `src/components/SvgMap.ts:1019-1066` | `animateViewBox()` 用 rAF，冇 reduced-motion 檢查 | **P1-6** |
| `src/components/SvgMap.ts:625` | `this.svg.addEventListener("click", ...)` 單一 delegated handler | **P1-2**（地圖 0/19 鍵盤可達） |
| `src/components/SvgMap.ts:1200+` | zone / marker 全部 `createElementNS` 建立，冇 `tabindex` / `role` / `aria-label` | **P1-2** |
| `src/styles/main.css:1101-1105` | `@media (max-width: 639px)` 將 `.map-ctrl` 縮到 30×30、`.ch-pill` 縮到 30×24 | **P1-1** |
| `src/styles/main.css:2040-2047`、`1107-1112` | `@media (prefers-reduced-motion: reduce)` CSS 歸零（**有效**，唔需要改） | **P1-6** 對照 |
| `src/components/SearchBox.ts:27-60` | `show()` / `hide()` 冇 focus 管理、冇 trap、冇 `role="dialog"`、Esc 只綁 input | **P0-4** |
| `src/components/SearchBox.ts:73-156` | `renderResults()` 產生 `<li class="search-result-item">` + click-only | **P0-5** |
| `src/components/SearchBox.ts:131` | `results.slice(0, 50)` 硬上限 | **P2-4** |
| `src/components/SearchBox.ts:158-160` | `typeLabel()` 只有 3 類 | **P2-4** |
| `src/components/StoryPanel.ts:162-169` | `char-chip` click = `console.log` + `// TODO: open character modal` | **P0-5**（Journey C 未實作） |
| `src/components/StoryPanel.ts:170-176` | `.route-item` click = `setChapter(chapters_span[0])`，冇 route 突出、冇 waypoint | **P0-5** |
| `src/components/ChronicleView.ts:425` | `scrollIntoView({ behavior: "smooth", block: "center" })` | **P1-6** |
| `src/app.ts:266-309` | 全域 `keydown`；第一行 `if (target instanceof HTMLInputElement) return` | **P0-4** 連鎖後果 |
| `src/app.ts:286-308` | Esc handler 冇處理「收合面板」 | **P2-2** |
| `src/app.ts:80-99` | `#app-root role="application"`；`#topbar h1` 8 字 | **P1-5**、**P1-9** |
| `src/app.ts:87-98` | 8 個 `nav-btn` 冇 `min-width` / `min-height` | **P1-1** |
| `index.html:5`（`dist/index.html` 同） | `<meta name="viewport" content="width=device-width, initial-scale=1.0">` 冇 `viewport-fit=cover` | **P1-7** |
| `src/components/ChronicleView.ts`（全檔 433 行） | 1,320 張卡 eager render，冇 virtualize | **P0-1**（放大 2,920 個 Tab stop） |

---

## 驗證命令與結果

### 環境準備

```bash
# 起 preview server（必須用 localhost；vite preview 只綁 IPv6 [::1]）
cd /c/Users/User/Desktop/benggong
npx vite preview --port 5190 --strictPort
# → ➜  Local:   http://localhost:5190/
```

### 本輪量測腳本（全部可重跑）

```bash
cd /c/Users/User/Desktop/benggong

# 1. touch target 方法核實（bucket 分析）
node artifacts/audit-A7/a7-verify-targets.mjs
# → origMatchCount 3131 / realInteractiveVisible 24 / violations 24

# 2. 證明 2,721 個 chronicle 按鈕離屏
node artifacts/audit-A7/a7-verify-chronicle.mjs
# → counts: { total: 2721, inViewportCenters: 0, hitSelf: 0 }

# 3. 嚴格重新量測（touch / contrast / ARIA / motion / panel）
node artifacts/audit-A7/a7-remeasure.mjs
# → mobile390: rawTargets 3131 → realInteractiveVisible 24 → violations 24
#   contrast dark 12/38 fail、light 6/38 fail；離屏 3123 / 3938

# 4. keyboard 完整流程 + Tab 順序 + panel + Journey C/D
node artifacts/audit-A7/a7-keyboard-journey.mjs
# → Tab#1 = ch-pill（唔係 skip link）；focusTrap.escaped = true
#   journeyC.keyboardCanReachResult = false；journeyD.keyboardCanComplete = false

# 5. Tab 起始點因果實驗（baseline vs scrollIntoView no-op）
node artifacts/audit-A7/a7-probe-tabstart5.mjs
# → baseline: [ch-pill, ch-pill, ch-pill]
#   scrollIntoView no-op: [A.skip-link, #btn-mode, #btn-search]

# 6. focus ring 逐像素量測（每個元素獨立 page）
node artifacts/audit-A7/a7-focus-ring-clean.mjs
# → 12 個控制項 ring=0；移除 clip-path 後 ring=136~555

# 7. reduced-motion 逐 frame 取樣
node artifacts/audit-A7/a7-motion-rootcause.mjs
# → reduce: viewBoxDistinct 11（同 no-preference 一樣）、stripScrollDistinct 57

# 8. 收合面板可 Tab 元素數
node artifacts/audit-A7/a7-collapsed-focus.mjs
# → mobile390: tabbableTotal 2920 / tabbableInViewport 0 / aria-hidden null / inert false

# 9. 觸控平移
node artifacts/audit-A7/a7-probe-pan2.mjs
# → 縮放後 mouse / 合成 touch / CDP touch 全部 panned=true

# 10. 上一輪嘅 V2 驗收 harness（17 項，3 pass / 14 fail）
BASE_URL=http://localhost:5190/ node artifacts/audit-A7/v2-mobile-a11y-runner.mjs
```

### V2 驗收 harness 結果（`runner-out.txt`，BASE_URL = `http://localhost:5190/`）

```
── 9-mobile ──
  PASS  9.1   冇橫向 overflow（docScrollWidth <= viewport 闊度）
  FAIL  9.2   所有可見可點元素 >= 44x44 CSS px（inline link 除外）   └─ 24 個元素 < 44px
  FAIL  9.3   有 bottom sheet                                       └─ isSheet:false, hasDragHandle:false
  FAIL  9.4   safe area：viewport-fit=cover + env(safe-area-inset-*) └─ false / 0 條規則
  FAIL  9.5   頂欄：標題 <= 2 行、導覽 <= 1 行、按鈕 >= 44x44        └─ titleLines:4, navBtnsTooSmall:8
  FAIL  9.6   legend 遮蓋地圖 <= 15% 面積（或可摺疊）                 └─ 24.3%，不可摺疊
── 10-keyboard ──
  FAIL  10.1  第一個 Tab stop 係 skip link + Enter 後 focus 到 main
  FAIL  10.2  Tab 20 次內到達頂部導覽                                └─ Tab #>20
  FAIL  10.3  全頁 Tab stop 總數 <= 300                             └─ 3,131
  FAIL  10.4  focus 指示器喺所有導覽／控制項都可見                   └─ 8 個不可見
  FAIL  10.5  Esc 關閉 modal / sheet + focus 還原                    └─ sheet.afterEscCollapsed:false
  FAIL  10.6  搜尋結果可用方向鍵 + Enter 選取                        └─ afterArrow.activeIsResult:false
  FAIL  10.7  modal 有 role=dialog + aria-modal + trap + restore     └─ role:null, escaped:true
  FAIL  10.8  快捷鍵仍然有效                                         └─ ch 1→2 ✓；/ ✓；? undefined ✗
  PASS  10.9  地圖標記／區域可鍵盤選取                               └─ 25 個元素真鍵盤可達（2026-09-24 覆核）
── 11-network ──
  PASS  11.1  零外部請求
  PASS  11.2  冇 map / tile / geocoder 外部 host
總計：3/17 PASS，14 FAIL（原始審計）
2026-09-24 覆核：10.9 轉 PASS → 4/17 PASS，13 FAIL
```

> **本輪對 10.8 嘅修正**：上一輪報 `? → undefined` 係**測試方法問題**（`page.keyboard.press("?")` 唔會產生正確嘅 `key`）。本輪改用 `Shift+Slash` 測試，發現 `?` 快捷鍵本身係正常嘅（`app.ts:279`），**真正失效嘅原因係 P0-4 嘅連鎖後果**（Esc 之後 focus 卡喺隱藏 input）。同一樣，`ArrowRight` 喺搜尋／Esc 之後亦會失效。

### 其他既有 artifact（上一輪完成，本輪只引用／複核）

| Artifact | 本輪複核結果 |
|---|---|
| `a7-audit-summary.json` | 佈局數字（header 107px、標題 4 行、legend 18.9%、map 390×657 = 77.8%、`safeAreaCssRuleCount: 0`）**全部複核一致** |
| `a7-followup.json` | skip link Tab 序：**方法有偏**（人為重設 starting point），本輪用因果實驗取代 |
| `a7-focus-evidence.json` / `a7-focus-verify.json` | focus ring 結論**方向一致**（clip-path 剪走 ring）；本輪用「每個元素獨立 page」消除污染後複核 |
| `a7-taborder.json` / `-brief.json` | `totalFocusable: 3131`、`firstNav: null`、`firstPanelContent.n = 202` **複核一致** |
| `a7-modal.json` | modal 冇 `role` / `aria-modal`、Tab 逃離、`bgIsolation.appRootInert: false` **複核一致** |
| `v2-mobile-a11y-result.json` | 17 項 3 pass / 14 fail **複核一致** |

---

## Screenshots / Artifacts

### 截圖（`artifacts/audit-A7/`，全部由上一輪 Playwright 產生）

| 檔案 | 內容 |
|---|---|
| `a7-baseline-mobile-390.png` | mobile 390×844 首屏 baseline |
| `a7-baseline-tablet-768.png` | tablet 768×1024 首屏 baseline |
| `a7-baseline-desktop-1440.png` | desktop 1440×900 首屏 baseline |
| `a7-mobile-320.png` | narrow 320px（`h1` 每字一行） |
| `a7-tablet-768-detail.png` | tablet 細節 |
| `a7-contrast-dark-mobile-390.png` / `-tablet-768.png` / `-desktop-1440.png` | dark 主題對比量測當下截圖 |
| `a7-contrast-light-mobile-390.png` / `-tablet-768.png` / `-desktop-1440.png` | light 主題對比量測當下截圖 |
| `a7-search-modal-mobile-390.png` / `-desktop-1440.png` | 搜尋 modal |
| `focus-btn-mode-focused.png` / `-unfocused.png` | `#btn-mode` focus 前後 |
| `focus-btn-mode-noclip-focused.png` / `-unfocused.png` | 移除 `clip-path` 後 focus 前後（ring 出現） |
| `focus-map-zoom-in-focused.png` / `-unfocused.png` | `#map-zoom-in` focus 前後 |
| `focus-map-zoom-in-noclip-focused.png` / `-unfocused.png` | 移除 `clip-path` 後（ring 出現） |

### 機讀資料（本輪新增，全部可重跑）

| 檔案 | 關鍵數字 |
|---|---|
| `a7-verify-targets-brief.json` | 3,131 → 24（mobile）/ 33（tablet）/ 240（desktop） |
| `a7-verify-chronicle.json` | 2,721 chronicle 按鈕、`inViewportCenters: 0` |
| `a7-remeasure-brief.json` | 24 違規清單、contrast 12/6、motion 0 |
| `a7-remeasure.json` | 完整 raw（含對比 fail 詳情、ARIA raw） |
| `a7-aria-summary.json` | ARIA 屬性 histogram、heading、landmark（3 viewport） |
| `a7-keyboard-journey.json` | Tab 首 25、panel 四態、Journey C/D、modal、快捷鍵 |
| `a7-focus-ring.json` | 12 個控制項 ring=0 + no-clip-path 對照 |
| `a7-motion-rootcause.json` | reduce vs no-pref 逐 frame 取樣 |
| `a7-collapsed-focus.json` | 2,920 / 3,131 / 160,429px |
| `a7-probe-map2.json` | 19 個地圖互動元素、`keyboardReachable: 0` |
| `a7-pan.json` | 縮放後平移成功、overview 平移被 clamp |
| `v2-mobile-a11y-result.json` | 17 項 3 pass / 14 fail |
| `runner-out.txt` | V2 harness console 輸出 |

---

## 風險、衝突、限制

### 限制（量測能力邊界，必須明示）

1. **地圖 SVG 標籤嘅對比度未量測。** `zone-label`、`text` 標籤疊喺 raster 底圖（`image#basemap-group`）之上，本方法無法由 computed style 得知底色 → 對比度屬未知。建議 B8 用「取底圖對應像素 + 取文字色」嘅方法補量（程式化，唔需要人手）。
2. **222 個文字節點（2.6%）嘅背景含 gradient / background-image**，對比度判定屬保守估算。實際值可能較好或較差。受影響嘅 fail 判定：dark 207 個、light 14 個。
3. **「可見」判定用 `elementFromPoint` 中心點命中**。對於非常細嘅元素（例如 1px 闊嘅 `chr-tl-bar`），中心點命中測試係可靠嘅；但對於被部分遮蓋嘅元素，中心點命中唔等於全部可點。本報告冇逐像素量「可點面積」（`ux-product-audit.md` 對 zone 做過 380/380 像素量測，方法更強）。
4. **`viewBox` 動畫取樣用 rAF**，61–65 frames／1.5 秒 ≈ 40–43 fps，可能漏掉部分中間值。但 11 個相異值 vs 1 個（如果 reduce 生效應該係 1–2 個）已經足夠證明差異。
5. **CDP 觸控模擬同真機有差異**。本輪用 3 種方法（合成 TouchEvent、CDP `Input.dispatchTouchEvent`、滑鼠）交叉驗證平移，三者一致。但**真機 iOS Safari 未測**（Playwright 只有 Chromium）。
6. **冇做螢幕閱讀器實測**（NVDA / JAWS / VoiceOver）。本報告嘅 ARIA 結論全部基於 DOM / accessibility tree 嘅程式化檢查（屬性存在性、同步性、可達性），唔係 AT 輸出。`role="application"` 嘅影響係根據規範推斷，未經 AT 實測。
7. **`dist/` 係現行 build 產物**。本報告量測嘅係 `dist/`（由 `npx vite preview` 提供）。如果 `src/` 之後有未 build 嘅改動，報告唔會反映。

### 風險 / 衝突

1. **同 `ux-product-audit.md` 一致**：P0-1（收合面板可 Tab）、P1-2（地圖 0 鍵盤可達）、P2-4（搜尋 3 類）同該報告嘅 P0-1、P1-3、D 項方向一致，可以合併處理。
2. **同 `data-performance-audit.md` 一致**：該報告 P0-3「Chronicle 一次過 eager render 1,320 張卡」正正係本報告 P0-1 嘅放大器 —— **virtualize 編年史同時解決兩個 P0**（DOM 14,036 → ≤4,000；Tab stop 3,131 → ≤300）。呢個係最高槓桿嘅單一修改。
3. **同 `visual-motion-audit.md` 潛在衝突**：該報告如果建議「用 smooth 動畫強化章節轉場體驗」，就會同本報告 P1-6（reduced-motion）衝突。建議：**保留動畫，但加 reduced-motion 分支**，唔需要二選一。
4. **`clip-path` 切角係 spec §5.4 明文嘅視覺語言**（`design-reference-patterns.md` 有引用）。P0-3 嘅修復**唔可以**用「移除 `clip-path`」了事，必須改用 `box-shadow` 或外層 wrapper 畫 ring。呢點要喺 B8 講清楚，否則會破壞視覺設計。
5. **P0-2 嘅修復方式有取捨**：移除首次 `scrollIntoView` 之後，如果用戶喺 URL 直接入 `#ch=150`，章節條就唔會自動捲到第 150 章。建議：首次 render 用 `#strip-track.scrollLeft = ...` 直接設定（唔觸發 starting point 變更），保留「捲到目前章節」嘅功能。
6. **P1-7（safe-area）需要改 `index.html`**，而 `index.html` 同時係 `dist/index.html` 嘅來源（`vite` 會 copy）。改完要 rebuild。
7. **本報告冇驗證「修完之後」嘅狀態** —— 全部係 baseline 現狀描述。B8 修完之後需要重跑 `v2-mobile-a11y-runner.mjs` 同本報告嘅 9 個腳本做 regression。

---

## 給主代理的 integration note

### 1. 最需要修正嘅係上一輪嘅兩個數字

如果其他 agent 已經引用過 `fail44Count: 3131` 或 `contrast 3135/8423`，**請通知佢哋改用**：

- **真正 < 44px 可見互動元素：mobile-390 = 24、tablet-768 = 33、desktop-1440 = 240。**
- **真正畫面上對比違規：dark = 12、light = 6**（分母各 38 個可見文字節點）。

高估原因已定位清楚（舊 `visible()` 冇檢查中心點喺 viewport、冇檢查遮蓋；contrast 行咗全份 DOM 包括 160,405px 高嘅離屏編年史）。兩個獨立方法（本輪中心點過濾 vs `v2-checks.mjs` 9.2 嘅 viewport 過濾）都得出 24，可以放心引用。

### 2. 五個 P0 嘅修復次序建議

| 次序 | P0 | 改動範圍 | 為何先做 |
|---|---|---|---|
| 1 | **P0-1 收合面板 2,920 個 Tab stop** | `main.css` + `app.ts` + `ChronicleView.ts` virtualize | 同 `data-performance-audit.md` P0-3 係同一個改動，一石二鳥（DOM 14,036 → ≤4,000；Tab stop 3,131 → ≤300） |
| 2 | **P0-3 focus ring 被 clip-path 剪走** | `main.css`（改 `box-shadow`） | 改動最細（幾行 CSS），影響面最大（12 個控制項），零風險 |
| 3 | **P0-2 頂欄 Tab 到唔到** | `ChapterStrip.ts:75` | 一行改動 + 保留 `scrollLeft` 直接設定 |
| 4 | **P0-4 搜尋 modal 語意 / trap / Esc restore** | `SearchBox.ts` + `app.ts` | 需要新增 focus 管理邏輯，但範圍封閉 |
| 5 | **P0-5 Journey C/D 鍵盤** | `SearchBox.ts`（roving tabindex / `aria-activedescendant`）+ `StoryPanel.ts`（角色 dossier、route、waypoint） | 最大工作量，而且 Journey C 嘅 dossier 本身未實作，唔止係鍵盤問題 |

### 3. 同其他 audit 嘅交叉引用

- **P0-1 ↔ `data-performance-audit.md` P0-3**：編年史 eager render 1,320 卡。**必須一齊修**，否則 virtualize 之後如果冇處理 `aria-hidden`/`inert`，收合面板仍然可 Tab（只係數量減少）。
- **P1-2 ↔ `ux-product-audit.md` P0-1**：zone `pointer-events: none`（`main.css:458`）+ 章節 gate。本報告確認 `.zone-area` computed `pointer-events: none`，而且**即使修好滑鼠可點，鍵盤仍然係 0/19** —— 需要另外加 `tabindex` / `role` / `aria-label` / 方向鍵導覽。
- **P1-6 ↔ `visual-motion-audit.md`**：該報告專責動態設計。本報告只提供「reduced-motion 下 JS 動畫仍運行」嘅硬證據（11 / 57 個相異值），修復方案（`animateViewBox` 加 reduce 分支）應由該報告或 B8 決定。
- **P2-3（對比）↔ 無其他報告覆蓋**。上一輪 `a7-audit-summary.json` 有對比數字但方法有偏，本報告係唯一可信來源。

### 4. V2 a11y 測試方案（spec §7.2 第 9／10／11 項）

**現狀**：`artifacts/audit-A7/v2-checks.mjs`（24,428 bytes）+ `v2-mobile-a11y-runner.mjs`（獨立 runner，唔需要 vitest）+ `v2-mobile-a11y.e2e.test.ts`（vitest spec，可入 `npm test`）已經實作 **17 項檢查**，對現行版本跑出 **3 pass / 14 fail**。三個檔案共用同一份斷言定義，設計正確。

**跑法**

```bash
# 獨立 runner（唔需要 test framework）
BASE_URL=http://localhost:5190/ node artifacts/audit-A7/v2-mobile-a11y-runner.mjs

# vitest（整合時先複製到 tests/mobile-a11y.e2e.test.ts）
BASE_URL=http://localhost:5190/ npx vitest run tests/mobile-a11y.e2e.test.ts

# CI 記錄現狀（反轉斷言，唔 block）
A7_EXPECT_FAIL=1 BASE_URL=http://localhost:5190/ npx vitest run tests/mobile-a11y.e2e.test.ts
```

**17 項檢查清單（含本輪建議修正）**

| ID | 檢查 | 現況 | 本輪建議 |
|---|---|---|---|
| 9.1 | 冇橫向 overflow | PASS ✓ | 保持 |
| 9.2 | 所有可見可點元素 >= 44×44 | FAIL（24） | **方法正確**（已有 viewport 過濾）。建議**額外加**：排除 SVG 幾何、加 `elementFromPoint` 遮蓋檢查、同時報 WCAG 2.2 SC 2.5.8（24×24 + 間距）結果 |
| 9.3 | 有 bottom sheet | FAIL | 保持（`isSheet` 判定可放寬：加 `[role=dialog]` + `data-sheet` 兩種寫法都接受） |
| 9.4 | safe area | FAIL | 保持 |
| 9.5 | 頂欄標題 ≤2 行、導覽 ≤1 行、按鈕 ≥44 | FAIL | 保持 |
| 9.6 | legend ≤15% 或可摺疊 | FAIL | 保持（目前用 overlap÷map = 24.3%，正確） |
| 10.1 | 第一個 Tab stop 係 skip link + Enter 後 focus 到 main | FAIL | **需拆成兩項**：(a) 第一個 Tab stop 係 `.skip-link`（現況 fail，根因 P0-2）；(b) Enter 之後**下一個 Tab 要落喺 `#map-pane` 內** —— 呢個才係 HTML spec 嘅正確行為（`<main>` 冇 `tabindex` 時瀏覽器唔會 `focus()` 佢，只會設 sequential focus starting point）。原本斷言 `activeElement === main` **過嚴**，會產生假失敗 |
| 10.2 | Tab 20 次內到頂欄 | FAIL | 保持 |
| 10.3 | Tab stop 總數 ≤300 | FAIL（3,131） | **需補一個更精確嘅斷言**：`收合面板內可 Tab 元素 = 0`（現況 2,920）。因為「總數 ≤300」可以由 virtualize 達成，但唔保證收合面板唔可 Tab |
| 10.4 | focus 指示器可見 | FAIL | **方法可以升級**：由「檢查 `outlineStyle` / `clip-path`」升級為「focused/unfocused 截圖逐像素比對 ring 區變化 > 20px」（本輪 `a7-focus-ring-clean.mjs` 已實作，可直接抽成 check） |
| 10.5 | Esc 關 modal/sheet + focus 還原 | FAIL | 保持，並加 `focus 唔可以留喺隱藏元素` 斷言 |
| 10.6 | 搜尋方向鍵 + Enter | FAIL | 保持 |
| 10.7 | modal `role=dialog` + `aria-modal` + trap + restore | FAIL | 保持 |
| 10.8 | 快捷鍵有效 | FAIL（部分係測試問題） | **修正測試**：`?` 要用 `Shift+Slash`；並**加一個情境**：開搜尋 → Esc → 再測 `ArrowRight` / `/`（現況會失效，根因 P0-4） |
| 10.9 | 地圖可鍵盤選取 | **PASS（2026-09-24 覆核）** | 由 0/19 → **25 個元素真鍵盤可達 + 可啟動 + 焦點環可見**。見下面「§10.9 更新」 |
| 11.1 | 零外部請求 | PASS ✓ | 保持 |
| 11.2 | 冇 map/tile/geocoder host | PASS ✓ | 保持 |

**建議新增 7 項（補齊 spec 要求但 17 項未覆蓋）**

| 新 ID | 檢查 | 現況實測 |
|---|---|---|
| 9.7 | `viewport-fit=cover` + `env(safe-area-inset-*)` 用喺 `#topbar` 同 `.map-controls` | FAIL（0 條規則） |
| 9.8 | legend 可摺疊（有 `aria-expanded` 控制項） | FAIL |
| 9.9 | 所有 touch target 亦要滿足 WCAG 2.2 SC 2.5.8（24×24 或 ≥24px 間距） | FAIL（mobile 1 個、desktop 190 個） |
| 10.10 | 有 `aria-live` 區域播報章節切換 / 搜尋結果數 | FAIL（0 個） |
| 10.11 | 目前章節有 `aria-current` | FAIL（0 個） |
| 10.12 | `prefers-reduced-motion: reduce` 下 JS 驅動動畫亦停止（`viewBox` 相異值 ≤2） | FAIL（11 個，同 no-preference 一樣） |
| 10.13 | `#app-root` 唔應該係 `role="application"`（或只包住地圖） | FAIL |

### 5. 完成後嘅 regression 指令

```bash
# 1. 重跑 V2 harness（目標：17/17 或 24/24 PASS）
BASE_URL=http://localhost:5190/ node artifacts/audit-A7/v2-mobile-a11y-runner.mjs

# 2. 重跑本報告 9 個量測腳本（目標：violations 0、ring > 20px、reduce viewBoxDistinct ≤2、
#    collapsed tabbable 0、journeyC/D keyboardCanComplete true）
for f in a7-verify-targets a7-remeasure a7-keyboard-journey a7-focus-ring-clean \
         a7-motion-rootcause a7-collapsed-focus; do node artifacts/audit-A7/$f.mjs; done
```

---

*報告完。全部量測均可由 `artifacts/audit-A7/` 內嘅腳本重跑，冇任何人手目測或人手點擊核對。*

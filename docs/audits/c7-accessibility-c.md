# C7 無障礙對抗審計（Accessibility Auditor）

> 角色：C7（Gate 3 對抗驗收）· 日期：2026-09-24
> 範圍：VA3 / VA4 / VA8 / VA9 / VA12 + §2 第 9、10 項；核心任務 = 獨立驗證
> `mobile-a11y-audit.md` §10.9「P1-2 已修、`keyboardReachable = 25`」嘅真偽。
> 限制：**冇改任何 production code**（`src/` / `scripts/` / `data/` / `tests/` 零改動）；
> 所有結論都附可重跑命令 + 實際輸出。

---

## 0. 方法同環境

| 項目 | 值 |
|---|---|
| Preview server | `npx vite preview --port 5175 --strictPort`（服務 `dist/`，dist 建於 2026-09-24 21:47，已含 `c9a8d00` P1-2 修復） |
| 代理 | ⚠️ 環境有 `http_proxy` → 所有 node / vitest 命令都前置 `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY` |
| 量測 | Playwright（`chromium`，`--no-proxy-server`），1400×900（桌面）/ 390×844（mobile） |
| 探測腳本 | `artifacts/audit-A7/c7-probe-*.mjs`（新增，唔覆蓋主代理交付） |

**⚠️ 我唔同意 §10.9 嘅 PASS 判定**，理由見 §2。以下係我自己嘅量測。

---

## 1. 執行摘要（判定表）

| 項目 | 判定 | 證據（可重跑） |
|---|---|---|
| **VA3** 文字對比 0 違規（dark+light） | **PASS（抽樣）** | `tests/contrast-audit.e2e.test.ts` 2/2 pass（dark：`.ch-pill` / `#legend-lang-btn`；light：`#btn-theme` / `.strip-current` / `#strip-ch-num` / `.legend-title` / `#legend-lang-btn`）。**只覆蓋 7 個 selector，唔係全頁掃描** |
| **VA4** 最小字級 ≥12px | **FAIL** | `c7-probe-font.mjs`：可見 HTML 文字 93 個，**12 個 < 12px**（min **10px**），dark/light 一樣 |
| **VA8** Focus ring 12 個控制項可見 | **PASS（12 控制項）／部分 FAIL（地圖元素）** | `a11y-keyboard.e2e.test.ts`「12 個控制項」pass（**只測 dark**）；地圖 `.location-marker` 焦點環多數樣本**零像素變化**（見 §4） |
| **VA9** 收合面板 Tab stop ≤300 | **PASS** | `c7-probe-vax.mjs`：mobile 390×844、`snap=peek`，全頁可見 Tab stop = **227**；`#story-pane` 內可聚焦 = **0** |
| **VA12** Zone 三通道編碼 + `outpost` 入 legend | **PASS** | `c7-probe-vax.mjs`：legend 10 項、`據點（爭奪中）` 同時有 color+pattern+glyph；4 個 zone 圖例項各有 pattern+glyph；地圖 zone 帶 `data-pattern` + `stroke-dasharray` + `zone-badge` |
| **§2-9** Mobile 390×844（sheet/safe-area/無橫向 overflow/44px） | **PASS** | `tests/mobile-layout.e2e.test.ts` **12/12 pass**（首次跑 1 項 `ERR_CONNECTION_REFUSED` 係 server 中途死嘅環境 flake，重跑全綠） |
| **§2-10** Keyboard（skip-link / 12 ring / Esc / shortcuts） | **PASS（14/14）** | `tests/a11y-keyboard.e2e.test.ts` 14/14 pass |
| **§10.9** 地圖元素鍵盤可達（P1-2） | **FAIL（部分）** | 見 §2：真值 **67/68**，唔係「全部」；前向導覽只到 **48/68** 就卡死 |

---

## 2. 「25」嘅獨立驗證（**最關鍵**）

### 2.1 結論：`keyboardReachable = 25` 係探測上限造成嘅假象

`a7-probe-map2.mjs` 第 33 行 `const MAX_ARROW = 24;`，流程係「Tab 1 次 + ArrowRight 24 次」→
最多只會觀察到 **25** 個元素。呢個數字**純粹係 `MAX_ARROW + 1`**，同「有幾多元素真正可達」無關：

- 佢量到嘅 25 個**全部係 `.zone`**（`keyboardReachableIds` 25 個都係 `zone|...`）；
- 完全冇觸及 `.route-line` / `.location-marker` / `.location-marker-cluster` / `.event-marker`；
- 所以「25」既**唔可以**證明「全部 72 個可達」，亦**唔可以**否定「有元素永遠到唔到」。

`mobile-a11y-audit.md` §10.9 第 461 行寫「其實全部 72 個元素都可以用方向鍵到達」——
呢句係**由 code 推斷**，唔係量度結果。我用無上限探測推翻咗佢。

### 2.2 無上限探測（`c7-probe-traversal.mjs`）

命令：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-traversal.mjs
```

實際輸出（`artifacts/audit-A7/c7-traversal.json`）：

```
expectedTotal   : 68          ← 48 zone + 1 route-line + 9 location-marker + 3 cluster + 7 event-marker
distinctReached : 48
allReachable    : false
seqTail         : ["zone|zone_21f011edeb", ... × 8]   ← 卡死喺最後一個 zone，永遠唔郁
neverReached    : 20 個（1 route-line + 9 location-marker + 3 cluster + 7 event-marker）
offscreenElements: { count: 1, sample: [{ i: 48, cls: "route-line" }] }
```

> ⚠️ 互動元素總數係 **68**，唔係 §10.9 寫嘅 **72**（dist 版本差異）。數字本身會漂移，唔影響結論。

### 2.3 雙向探測（`c7-probe-traversal2.mjs`）

命令：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-traversal2.mjs
```

實際輸出（`artifacts/audit-A7/c7-traversal2.json`）：

| 情境 | forward（`ArrowRight`/`ArrowDown`） | backward（`ArrowLeft`/`ArrowUp`） | 聯集 |
|---|---|---|---|
| **預設**（`routes` 圖層 OFF） | **48**，卡死喺 `zone_21f011edeb` | **20**，卡死喺 `loc_0001` | **67 / 68** |
| **`routes` 圖層 ON** | **68 / 68**（正常環繞） | — | 68 / 68 |

**永遠到唔到**：`route-line|route_ent_dd034941ef_003`（1 個）。

### 2.4 根因（`c7-probe-focusability.mjs`）

```
total = 68, focusableCount = 67
非可聚焦（nonFocusable）:
  i=48, type=route-line, tag=path,
  bbox = { w: 0, h: 0 }, parentDisplay = "none"    ← 父層 #routes-layer display:none
```

`SvgMap.mapInteractiveEls()`（`src/components/SvgMap.ts:1472`）用
`MAP_INTERACTIVE_SELECTOR` 揀元素，**冇過濾 `display:none` / 零尺寸元素**。
預設 `routes` 圖層關閉（`src/state/url.ts:84 routes:false`，
`src/map/map-interactions.ts:256 { selector:"#routes-layer", hidden: !s.routes }`），
所以 `.route-line` 係**隱藏 + 0×0**。

而 `bindMapKeyboard()`（`SvgMap.ts:1526`）嘅 roving 邏輯係：

```js
const next = rovingIndex(els.indexOf(el), action, els.length); // els 含隱藏元素
setRoving(els, next);
els[next].focus();            // ← 對 display:none 元素靜默失敗
```

Chromium 對 `display:none` 元素嘅 `focus()` **靜默失敗**，`document.activeElement`
留喺上一個元素 → 下一個 keydown 由同一個 index 再算 → `next` 永遠 = 48 →
**無限卡死**。所以：

- 用 `ArrowRight` / `ArrowDown`（「下一個」嘅自然鍵）由第一個 zone 起行，
  到第 48 個 zone 之後就**永遠去唔到** route／location／cluster／event；
- 19 個標記只可以**反方向**（`ArrowLeft` / `ArrowUp`）行到；
- `.route-line` 本身**兩個方向都到唔到**（佢就係卡點）。

### 2.5 對 §10.9 嘅判定

- 「25 個元素真鍵盤可達」——數字係假象（上限），但**方向性**嘅結論「zone 可達」係真嘅。
- 「全部 72 個元素都可以用方向鍵到達」——**FALSE**：1 個永遠到唔到；
  19 個只能反向到達。**§10.9 嘅 PASS 建基於唔成立嘅推斷 → 我判定 §10.9 應為 FAIL（部分）。**
- 附帶：`role="button"` = 68/68、`aria-label` = 68/68、roving 不變式（任何時候 1 個
  `tabindex="0"`）都成立（`c7-traversal.json` `tabindexInvariant {zero:1, minusOne:67}`）。

---

## 3. 逐類元素 `Enter` 啟動（`c7-probe-traversal2.mjs`）

| 類別 | 到得到？ | `Enter` 有冇效果 | 證據 |
|---|---|---|---|
| `.zone` | ✅ | ✅ | URL `/` → `/?zone=...`，`.zone.is-selected` 0→1 |
| `.location-marker` | ✅（需反向） | ✅ | `viewBox` 由 `113.98…0.3186` → `114.18…0.1593`（zoom） |
| `.location-marker-cluster` | ✅（需反向） | ✅ | `viewBox` → `114.17…0.1593`（zoom 拆簇） |
| `.event-marker` | ✅（需反向） | ✅ | URL → `/?event=bg_event_018` |
| `.route-line` | ❌ 永遠到唔到 | ⚠️ 到得到時亦**冇可觀察效果** | 即使 `routes` 圖層 ON 行到佢，`Enter` 後 URL / chapter 不變 |

> route-line 嘅 handler 係 `setChapter(chapters_span[0])`；該 route 嘅 `chapters_span = [1,194]`，
> 而預設章節 = 1 → `setChapter(1)` = no-op。**呢個未必係 bug**（可能係設計），
> 但結果係：用戶對 route line 按 `Enter` 睇唔到任何反應。

**判定：`Enter` 對 zone / location / cluster / event 有效；對 route-line 無可觀察效果。**

---

## 4. 焦點環 dark / light（`c7-probe-ring2.mjs` + `c7-probe-ring3.mjs`）

命令：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-ring2.mjs
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-ring3.mjs
```

同一 session 內 focused vs blurred，逐像素比對（`Buffer.compare`）：

| 類別 | dark（`--focus-ring:#7dd3fc`） | light（`--focus-ring:#0b5f80`） |
|---|---|---|
| `.zone`（32×44） | ✅ 有像素差 | ✅ 有像素差 |
| `.location-marker-cluster`（18×19） | ✅ | ✅ |
| `.event-marker`（22×22） | ✅ | ✅ |
| **`.location-marker`（5×5, opacity 0.45）** | ⚠️ **1/4 有**（loc_0001 有；loc_0002/0003/0009 零變化） | ❌ **0/3 有** |

`c7-probe-ring3.mjs` 同時確認呢啲「零變化」個案：
`activeElement.matches(':focus-visible') === true`、`filter` 已設為
`drop-shadow(...var(--focus-ring))`、焦點前後 bbox **冇移動**（`moved=false`）——
即係**唔係**「focus 失敗」或者「量測時序」造成，而係焦點環喺細小 marker 上真係睇唔到。

`c7-probe-occlusion.mjs` 進一步顯示：12 個 location/event marker 之中 **8 個嘅中心點**
被其他 marker 覆蓋（`elementFromPoint` 唔係 self）——細 marker 高度重疊，
焦點環被上層元素蓋住。**無論係「太細」定「被遮蓋」，結果一樣：細 marker 焦點環不可靠。**

### 額外發現：light 主題嘅焦點環顏色對比風險

`--focus-ring` 係 theme-aware（dark `#7dd3fc`、light `#0b5f80`），但**地圖底圖（canvas）
唔跟主題變色**（`c7-theme-dark.png` vs `c7-theme-light.png` 都係深色底圖）。
即 light 主題之下，`#0b5f80`（深青）焦點環畫喺**深色地圖**上面 → 對比偏低。
zone / event 夠大所以仍量到像素差，但細 marker 就完全消失。

**判定：VA8「焦點環可見」對 12 個 UI 控制項成立（dark）；但對地圖元素、
尤其 `.location-marker`，唔成立。§10.9 嘅 `focusRingVisible=true` 只量咗 1 個
zone 元素，唔可以推廣到「所有元素」。**

---

## 5. `prefers-reduced-motion` 覆蓋

### 5.1 實瀏覽器行為（`tests/reduced-motion.test.ts`，10/10 pass）

```
✓ reduce 模式下，改章唔會產生 rAF viewBox 插值序列（相異值 ≤2）
✓ reduce 模式下，章節條唔會做 smooth 捲動（scrollLeft 相異值 ≤2）
✓ CSS 層仍然有效（transition-duration 歸零）
```

### 5.2 靜態契約（同一檔，node）

- `src/` 冇任何 `.scrollIntoView(` 真呼叫；
- 除白名單（`motion.ts` / `VectorBasemap.ts` / `SvgMap.ts` / `map-camera.ts` / `MapViewport.ts`）
  外，冇檔案自開 `requestAnimationFrame`；
- `map-camera.ts` 有 `if (reduced || durMs <= 0)` 短路；`SvgMap.animateViewBox` 有
  `prefersReducedMotion() || durationMs <= 0` 分支。

### 5.3 CSS 覆蓋範圍（人工核對）

| 檔 | reduced-motion 區塊 | 覆蓋 |
|---|---|---|
| `base.css:170` | 全域 `animation/transition-duration` 收斂 + 逐個終態靜態樣式（`.zone-glow` / `.beacon-ping` / `.skeleton` / `.route-flow` …） | ✅ |
| `map.css:596` | `.zone-pulse` 靜態 `opacity:0.28`；zone badge/area/label 去 transition | ✅ |
| `chronicle.css:484` | `.chr-*` 去 transition + `[aria-current]` 靜態底色 | ✅ |
| `mobile.css:645` | `.pane-story` / search panel / onboarding 去過場；sheet snap 即時 | ✅ |
| `legacy-migrated.css:1143 / 2079 / 2669` | `*` 全域 `animation-duration: 0.001ms !important` | ⚠️ 見下 |

**⚠️ 風險（低）**：`legacy-migrated.css` 係喺 `base.css` **之後** import，佢嘅
`* { animation-duration: 0.001ms !important }`（特異度 0,0,0，後者勝）會**蓋過**
`base.css` 刻意用嘅 `0.01ms`。`base.css` 嘅註解明言 `0.001ms` 會令動畫「跳終態」
（光環消失）。所幸 `base.css` 嘅**逐元素靜態 fallback**（`.zone-glow` 等）係 class
特異度，唔會被 `*` 蓋過，所以實際可見終態仍然保住。建議日後清走 legacy 層嘅 `*` 規則。

**判定：reduced-motion 喺 CSS + JS 雙層、地圖轉場（`animateViewBox` / `flyTo`）/
章節捲動 / chronicle / sheet 全部生效。VA7 相關路徑覆蓋完整。**

---

## 6. 逐項細節（VA3 / VA4 / VA8 / VA9 / VA12 + §2-9 / §2-10）

### VA4 — 最小字級 ≥12px：**FAIL**

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-font.mjs
# → dark total=93 under12=12 min=10 ；light total=93 under12=12 min=10
```

違規節點（`artifacts/audit-A7/c7-font.json`）：

| 字級 | 元素 | 文字 |
|---|---|---|
| 10px | `div.story-chapter-num` | 「第 1 章」 |
| 10px | `span.badge` | 「5 個地點」 |
| 11px ×10 | `.legend-item > span` | 「本章事件 / 其他章事件 / 真實地點 / 虛構地點 / 選中 / 倖存區（安全） / 病窩（危險） / 據點（爭奪中） / 虛線＝範圍係估算 / 角色路線（僅真實地點之間）」 |

（`c7-probe-vax.mjs` 原本量到 24 個 <12px，但當中有 12 個係 `#svg-map` 內嘅 SVG 文字，
其 computed px 係 `userSpaceOnUse` 縮放值，唔代表 UI 字級 → 已剔除，見 `c7-probe-font.mjs`。）

> 由 A7 原本「78.4% ≤11px、最差 9px」大幅改善到 **12.9%（12/93）、最差 10px**，
> 但仍然**未達**「最小 ≥12px」嘅硬性斷言。

### VA9 — 收合面板 Tab stop ≤300：**PASS**

```
mobile 390×844：paneSnap=peek, tabStopsInPane=3, tabStopsInPaneFocusable=0, tabStopsTotal=227
```

`#story-pane` 收合時內部**可聚焦元素 = 0**（收合 = 唔參與 Tab），全頁 227 ≤ 300。

### VA12 — Zone 三通道 + outpost：**PASS**

```
legendItemCount=10, hasOutpost=true
outpostChannels = { color:true, pattern:true, glyph:true, label:"據點（爭奪中）" }
zoneItemsWithPattern=4, zoneItemsWithGlyph=4
```

地圖 zone 另有 `data-pattern`（`hatch`→`stroke-dasharray`）+ `zone-badge` 圖騰
（`SvgMap.ts:2272` / `2298`）→ 顏色以外仍有兩條通道。

### §2-9 — Mobile 390×844：**PASS**

`tests/mobile-layout.e2e.test.ts`：**12/12 pass**（重跑，`c7-test-mobile-layout.e2e-rerun.log`）。
首次跑有 1 項「`peek` 狀態遮蓋地圖 <= 25%」以 `page.goto: net::ERR_CONNECTION_REFUSED
at http://localhost:5174/` 失敗 —— **preview server 中途被殺**（環境衝突），
**唔係斷言失敗**；重跑該檔全綠。涵蓋：無橫向 overflow（`scrollWidth ≤ 390`）、
0 個 <44px 可見互動元素、bottom sheet `position:fixed` + 3 段 snap、`peek` 遮蓋 ≤25%、
`env(safe-area-inset-*)` ≥3 條、`viewport-fit=cover`、`h1`/導覽列行數、legend 遮蓋 ≤25%。

### §2-10 — Keyboard：**PASS（14/14）**

`tests/a11y-keyboard.e2e.test.ts` 14/14 pass，包括：
第 1 個 Tab stop = `.skip-link`；頂欄導覽 20 次 Tab 內到；收合面板 Tab stop ≤300；
**12 個控制項焦點環逐像素可見**（dark）；搜尋 modal focus trap；Esc 還原焦點；
Esc 收合面板；搜尋 5 類標籤。
**⚠️ 呢個「12 控制項」測試只喺 dark 主題量，冇 light 主題覆蓋。**

### 測試總表（單檔逐個跑，冇跑全套）

| 檔 | 結果 |
|---|---|
| `tests/map-keyboard.e2e.test.ts` | 3 passed |
| `tests/a11y-keyboard.e2e.test.ts` | 14 passed |
| `tests/contrast-audit.e2e.test.ts` | 2 passed |
| `tests/reduced-motion.test.ts` | 10 passed |
| `tests/mobile-layout.e2e.test.ts` | 12 passed（重跑；首跑 1 infra-fail） |

---

## 7. 未解決風險 / 建議（按嚴重度）

1. **[P1] roving 被隱藏元素卡死 → 20 個互動元素用「下一鍵」到唔到。**
   `mapInteractiveEls()` 要過濾「真可聚焦」（例如 `el.getClientRects().length > 0`、
   或者排除 `[hidden]` / `display:none` 祖先）。`els[next].focus()` 之後應檢查
   `document.activeElement === els[next]`，失敗就**跳過**繼續行，唔可以停。
   另外：隱藏元素唔應該有 `tabindex` / `role="button"`（對 AT 係幽靈控件）。
2. **[P1] `.location-marker` 焦點環唔可靠**（dark 1/4、light 0/3 樣本可見）。
   細 marker（5×5）用 `drop-shadow` 太弱；建議加 `stroke` 描邊或放大 marker 嘅
   命中/焦點視覺（例如畫一個唔隨縮放縮細嘅 focus halo）。亦要覆核 light 主題下
   `#0b5f80` 畫喺深色底圖嘅對比。
3. **[P2] `focusRingVisible=true` 嘅量測方法太弱**：只量 1 個元素就當「全部可見」。
   建議每個類別（zone / route / location / cluster / event）× 每個主題各量一次。
4. **[P2] VA4 仍有 12 個 <12px 文字節點**（10–11px）：`.story-chapter-num`、`.badge`、
   legend 10 條標籤。應統一改用 `--fs-2xs`（12px）。
5. **[P3] VA3 只係抽樣**：`contrast-audit.e2e.test.ts` 只查 7 個 selector，
   唔係「全頁 0 違規」嘅掃描。要真正證明 VA3 需要全頁（過濾離屏/被遮蓋）掃描。
6. **[P3] legacy 層 `* { animation-duration:0.001ms }` 蓋過 base 層**：建議清走。
7. **[P3] route-line `Enter` 無可觀察效果**：`setChapter(1)` = no-op；建議改為
   「選中該 route（只顯示該線 + fly-to）」，符合 §2-5 契約。

---

## 8. 對主代理交付嘅異議（按指示：唔改 `mobile-a11y-audit.md`）

| §10.9 原文 | 我嘅反證 |
|---|---|
| 「`keyboardReachable` = 25（24 次方向鍵 + 1 次 Tab 到達 25 個唔同元素）」 | 25 = `MAX_ARROW + 1`，係探測上限；25 個全部係 zone，冇觸及另外 43 個 |
| 「其實全部 72 個元素都可以用方向鍵到達」（第 461 行） | 實測 **67/68**；`route-line` 永遠到唔到；19 個標記只可反向到達 |
| 「`focusRingVisible` = true」 | 只量 1 個 zone；`.location-marker` dark 1/4、light 0/3 可見 |
| 「判定：§10.9 PASS」 | 我判定 **FAIL（部分）**：前向導覽 48/68 卡死係 P1 缺陷 |

---

## 附錄：可重跑命令

```bash
cd C:/Users/User/Desktop/benggong
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  npx vite preview --port 5175 --strictPort &
export BASE_URL=http://localhost:5175/

# 探測（全部輸出喺 artifacts/audit-A7/）
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=$BASE_URL node artifacts/audit-A7/c7-probe-traversal.mjs     # 「25」真相：48 卡死
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=$BASE_URL node artifacts/audit-A7/c7-probe-traversal2.mjs    # 雙向 + 逐類啟動
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=$BASE_URL node artifacts/audit-A7/c7-probe-focusability.mjs  # 根因：route-line 0×0
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=$BASE_URL node artifacts/audit-A7/c7-probe-ring2.mjs         # 焦點環 dark/light
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=$BASE_URL node artifacts/audit-A7/c7-probe-ring3.mjs         # 焦點環假陰性排除
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=$BASE_URL node artifacts/audit-A7/c7-probe-font.mjs          # VA4
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  BASE_URL=$BASE_URL node artifacts/audit-A7/c7-probe-vax.mjs           # VA9 / VA12

# e2e（單檔，逐個跑）
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY npx vitest run tests/map-keyboard.e2e.test.ts
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY npx vitest run tests/a11y-keyboard.e2e.test.ts
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY npx vitest run tests/contrast-audit.e2e.test.ts
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY npx vitest run tests/reduced-motion.test.ts
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY npx vitest run tests/mobile-layout.e2e.test.ts

# 清理 preview（Windows）
netstat -ano | grep ":5175" | grep LISTENING     # 攞 PID
taskkill /PID <pid> /T /F
```

**產出檔案**：`artifacts/audit-A7/c7-*.mjs`、`c7-*.json`、`c7-*.log`、
`c7-ring2-*.png` / `c7-ring3-*.png` / `c7-theme-*.png`、`c7-test-*.log`。

# A10 — Design Reference Patterns（世界地圖 V2 設計語言參考）

> 子代理：**A10 Design Reference Synthesizer**
> 性質：**只讀審計**。本檔只研究「可喺本機實現」嘅設計 pattern，**零 online asset dependency**。
> 所有 pattern 描述 + 可貼用 CSS / SVG / Canvas 片段 + 效能代價 + reduced-motion 版本 + 反例。
> 語言：粵文。

---

## 任務摘要

1. 診斷現行 UI 嘅**實際**設計語言（實測，非推測），列出同 V2 目標（末日情報指揮室）之間 **8 個結構性差距**。
2. 交付 **12 個可本機實現嘅 design pattern**，每個都有：視覺描述（層次／色階／形狀／間距）、純 CSS / SVG / Canvas 實現片段、效能代價與 fallback、`prefers-reduced-motion` 版本、反例。
3. 交付**完整 token 表**（color / spacing / radius / shadow / z-index / motion）＋ 可貼用嘅 CSS custom properties 草案（dark + light），並解決「canvas 讀唔到 CSS 變數」嘅兼容問題（現有 `basemap-theme-change` 事件機制）。
4. 交付**字體策略**（現況係純系統 stack，零 bundled font）同**本機 SVG sprite icon 策略**（取代現行 emoji）。
5. 交付 **anti-pattern 對照表**（spec §1.1 明令禁止嘅 6 項，逐項：禁止做法 / 替代方案 / 驗收方法）。
6. 全部按 **P0 / P1 / P2** 分級。

**核心結論（一句）**：現況唔係「設計唔夠靚」，而係**兩套互斥設計語言（暖色羊皮紙「現代檔案館」vs 冷色「戰術 HUD」）疊喺同一個 DOM 上，而實測 default 走咗暖色嗰套**，加上**世界領土層（territory）實際上冇 render**，所以「末日情報指揮室」呢個產品定位由第一眼就冇成立。修復方向係：**確立單一 dark-first token 語言 → 令 territory 成為常駐世界層 → 用 pattern/icon/形狀做非色彩冗餘編碼 → motion 收斂成有語意嘅少量動效**。

---

## 假設與證據

### 已讀檔案（全部只讀）

| 檔案 | 用途 |
|---|---|
| `prompts/world-atlas-v2-rebuild.md` | 重點 §0.1 規則 4（地圖完全本機）、規則 8（所有 AI 特效要有功能）、§1.1（視覺方向 + 禁止清單）、§2.4（Zone interaction design）、§5.2（design token 與 motion system）、§5.4（Zone 與病窩圖層視覺語言表） |
| `AGENTS.md` | 離線／零人手／粵文／版權紅線 |
| `artifacts/audit-context/baseline-findings.md` | 實測現況事實包 |
| `artifacts/screenshots/baseline-map-desktop-1440.png` | 確認 light 羊皮紙主題、通用淺灰地圖、48 zone 冇 render |
| `artifacts/screenshots/baseline-map-mobile-390.png` | 確認 mobile 係縮細 desktop、legend 遮蓋地圖、標題豎排 4 行 |
| `artifacts/screenshots/baseline-zoom-desktop-step08-zoom.png` | 確認 max zoom 唔係「起格」而係「冇嘢睇」 |
| `src/styles/main.css`（2047 行） | token 結構、元件樣式、Phase L HUD 覆寫層、light theme |
| `src/styles/hud.css`（785 行） | 同 main.css 1496–2047 **近乎逐字重複** |
| `src/theme.ts` | `data-theme` 機制 + `basemap-theme-change` 自訂事件 |
| `src/app.ts`（部分） | nav 按鈕 HTML（emoji）、mount 結構 |
| `src/components/SvgMap.ts`（部分） | zone render 邏輯 + chapter visibility gate |
| `data/public/map-config.json` | 已過時（`renderer:"svg"` 但實際係 Canvas 向量） |
| `public/assets/vector/manifest.json` | 向量底圖層清單（land/water/areas/roads-l0/l1/labels/tiles） |
| `public/assets/**` 目錄 | `ui/`、`markers/`、`generated/`、`map-tiles/` 全部**空目錄**；`map-lod/` 28 MB 死重 |
| `index.html` | 確認**冇**任何外部 `<link>` / 字體 CDN |

### 關鍵實測證據（本次自行驗證，非引用）

**E1 — 預設主題係 light（同 V2 目標相反）**

`src/styles/main.css:1191` 有 `@media (prefers-color-scheme: light) { :root:not([data-theme]) { … } }`，`src/theme.ts:31-35` `systemPrefers()` 亦係跟系統。實測環境回報 light → 整站走暖色羊皮紙路線。baseline 截圖確認 `data-theme="light"`。

**E2 — 兩套設計語言同時存在且互相覆寫**

- 「現代檔案館」層：`main.css:9-23` 註解明寫「手繪底圖 + 現代 UI 外框」、暖褐 `#d9c9a8` 系。
- 「戰術 HUD」層：`main.css:1496-2047` + `hud.css` 全檔，註解明寫「深色、低飽和、墨黑藍……青色 #38e8ff」。
- 兩者係**同一批 selector**（`#topbar`、`.nav-btn`、`.map-ctrl`、`.pane-story`、`.zd-*`）嘅先後覆寫。`hud.css` 載入次序喺 `main.css` 之後，所以 HUD 贏 —— 但 light theme 又再覆寫一次 HUD（`hud.css:584-785`）。

**E3 — CSS 明顯重複**

- `main.css:1496-2047` 同 `hud.css:1-573` 係**同一段 Phase L 區塊**（近乎逐字）。
- `hud.css:584-679` 同 `hud.css:690-785` 係**同一段 light theme 覆寫**（逐字重複兩次）。
- 全站 CSS 3262 行 > 全部 TS 邏輯（baseline §3）。呢個係「覆寫層疊覆寫層」嘅典型徵狀。

**E4 — 48 個 zone 幾何存在，但實際上唔可見（精確 root cause）**

`src/components/SvgMap.ts:1200-1205`：

```ts
const zoneList = [...this.data.zones.features]
  .filter((z) => {
    const chs = z.properties.chapters || [];
    // 章節可見性：首次出現之後 12 章內都算「活躍」
    return chs.length === 0 || chs.some((c) => c <= cur && cur <= c + 12);
  })
```

實測 `data/public/zones.geojson`（48 個 polygon，`kind` = survivor 11 / nest 21 / outpost 16）：

| 條件 | 結果 |
|---|---|
| chapter = 1 時符合 `c <= 1 && 1 <= c + 12` | **只有 1 個**（`zone_d3f76d3c94`, survivor） |
| 該 zone bbox | lon 114.250–114.257、lat 22.303–22.309（約 0.007° × 0.006°） |
| 初始 viewBox | `113.79 22.11 0.7 0.5407` |
| 佔畫面比例 | 約 **1.0% × 1.1%** → 1060×752 canvas 上約 **10 × 8 px** |

→ 結論：zone **有 render，但等於一個 10px 嘅點**，肉眼不可見；而另外 47 個 zone 因為章節 gate 完全唔喺 DOM 度。**呢個係「世界領土層實質缺失」嘅精確原因**，唔係「未寫」。

**E5 — 圖層語言只靠色**

`src/components/SvgMap.ts:1168-1193` `ZONE_STYLE` 每個 kind 只有 `fill` / `stroke` / `glow` / `glyph`（glyph 係字串，未見 render 成 icon）。`main.css:437-455` legend 亦只有 `.dot { background: … }`。**冇任何 pattern / shape / icon 冗餘編碼** → 違反 spec §2.4「legend 必須同時用 color、pattern、icon／shape，唔可以只靠色」。

**E6 — nav 用 emoji**

`src/app.ts:88-93`：`📜 編年史`、`🔍 搜尋`、`🔗`、`⬇`、`🌙/☀️`、`?`。其中 `🔗 ⬇ ?` 係**純 emoji 無文字標籤**（baseline §6.4 已記錄）。

**E7 — 字體係純系統 stack，零 bundled font**

`main.css:94`：`font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang HK", "Microsoft JhengHei", sans-serif;`
`index.html` 冇任何 `<link rel="stylesheet">` 或字體 CDN。**現況已符合「字體本機」要求**（因為根本冇用自訂字體）。

**E8 — `prefers-reduced-motion` 用全域 kill**

`main.css:1107-1112` 同 `hud.css:564-573`：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
```

`animation-duration: 0.001ms` 會令所有 animation **跳到終態**。對於 `.zone-scan`（終態 `opacity: 0`）等於 zone 光環直接消失；對於 loading skeleton 等於冇 loading 指示。呢個唔係「尊重 reduced motion」，而係「reduced motion 之下介面壞掉」。

**E9 — 冇 z-index / motion token**

z-index 硬編散落：`2`（map-overlay / map-controls）、`60`（pane-story）、`100`（topbar）、`1000`（modal / skip-link）。motion 只有 `--transition: 180ms` / `--transition-fast: 120ms`，冇 duration 分級、冇 easing 分級。

**E10 — 現況 zero external request**

baseline §6.1：6 個 run 全部 `external = 0`。呢個係**必須保住嘅既有成就**，所有 V2 pattern 都唔可以破壞。

### 本次新增驗證（A10 自建 artifact）

`artifacts/audit-A10/pattern-demo.html`（純本機、inline SVG sprite、零外部依賴）＋ `capture-demo.mjs` 跑 7 個情境，實測結果見「驗證命令與結果」一節。

---

## 發現／改動

### 1. 現況設計語言診斷

#### 1.1 現行 UI 屬咩設計語言？

**實測答案：一個「暖色羊皮紙手繪地圖」外殼，上面硬疊一層「冷色戰術 HUD」，而實際 render 出嚟係前者。**

證據：

- 程式碼自述有**兩套**語言：
  - `main.css:9-23`「**現代檔案館（Modern Archive）**」—— 手繪底圖（暖褐 `#d9c9a8`）＋ 現代 UI 外框（深藍灰 `#0d1117`）。用戶選擇「方案 C」。
  - `main.css:1496-1520` / `hud.css:1-30`「**戰術 HUD（Tactical HUD）**」—— 切角框、單色主調 + 單一強調青 `#38e8ff`、髮絲線、掃描線微網格。
- 兩套寫喺**同一批 selector** 上，靠載入次序（main → hud）分出勝負。
- 但 `[data-theme="light"]` 又喺 `hud.css:584+` 將 HUD 嘅深色表面全部翻成白色。而實測 default theme = light（E1）。

**所以實際用戶見到嘅，係一個「暖白底 + 淺灰通用地圖 + 橙色道路 + 圓角藥丸按鈕 + emoji」嘅通用 web app**，唔係「末日情報指揮室」，亦唔係「戰術 HUD」。baseline desktop 截圖完全吻合。

#### 1.2 同 V2 目標嘅 8 個結構性差距

| # | 差距 | 證據 | 影響 journey | 級別 |
|---|---|---|---|---|
| **G1** | **世界領土層實質缺失** —— 地圖係通用淺灰地圖，48 個 zone 幾何存在但 ch1 只有 1 個 eligible 且只佔畫面 ~1%，等於冇 | E4；baseline §6.4 | A（初次進入）、B（探索 zone） | **P0** |
| **G2** | **兩套互斥設計語言疊加**，靠 selector 覆寫次序決定勝負，冇單一 authority | E2、E3；main.css 3262 行 | 全部 | **P0** |
| **G3** | **預設主題同產品定位相反** —— spec §1.1 要深色末日指揮室，實際 default 跟系統走 light | E1；`main.css:1191`、`theme.ts:31` | A（3 秒印象） | **P0** |
| **G4** | **圖層語言只靠色** —— zone / marker / legend 全部只有色，冇 pattern / shape / icon 冗餘編碼 → 色盲不可用、灰度不可讀、違反 spec §2.4 | E5；`SvgMap.ts:1168-1193`、`main.css:437-455` | B、C、D、E | **P0** |
| **G5** | **資訊密度倒置** —— 首屏 `innerText` 46,246 字元、1320 張編年史卡即時 render，而地圖反而最空。完全違反「Map first, data second」 | baseline §6.4；spec §1.2 原則 1 | A、E | **P1** |
| **G6** | **Motion 冇系統，而且 reduced-motion 處理係錯嘅** —— 只有零散 keyframes；`animation-duration: 0.001ms !important` 令動畫跳終態（zone 光環消失、skeleton 失效） | E8、E9 | 全部 | **P1** |
| **G7** | **Icon 用 emoji** —— 跨平台 render 不一、唔可控色／尺寸、a11y 讀法同功能唔一致、同切角 HUD 語言完全唔夾 | E6；`app.ts:88-93` | A、全部導航 | **P1** |
| **G8** | **Mobile 係縮細版 desktop** —— legend 佔 55% 寬 45% 高遮蓋地圖、標題豎排 4 行、8 個 nav 換行 2 行、冇 bottom sheet、冇 44×44 target、冇 safe-area | baseline §6.4 mobile | A、B、C、D | **P1** |

> 補充（P2）：`main.css` 同 `hud.css` 有兩段**逐字重複**（E3），`map-config.json` 已過時（`renderer:"svg"` 但實際係 Canvas），`map-lod/` 28 MB + `hk-basemap*.png` 2 MB 係死重（baseline §7）。呢啲唔係設計語言問題，但會令 B1 嘅 token 重構做唔乾淨。

---

### 2. Pattern 庫（12 個，全部純本機實現）

> 全部 pattern 已喺 `artifacts/audit-A10/pattern-demo.html` 實現並截圖驗證（見「驗證命令與結果」）。
> 顏色一律引用 §3 嘅 token，唔寫死 hex（示範片段為可讀性會寫實際值）。

---

#### 【P0-1】玻璃儀器面板（Area-bounded Glass Panel）

**用途**：所有浮層面板 —— legend、map controls、zone dossier、search、layer control。對應 Journey A（入口）、B（dossier）、E（chronicle 篩選）。

**視覺描述**
- 層次三級：`surface`（86% 不透明）→ `elevated`（面板內卡片）→ `overlay`（hover 態）。
- 形狀：**切角**（clip-path 10px），唔用圓角 —— 圓角係消費級語言，切角係儀器語言。
- 邊界：**1px 髮絲線**（`inset box-shadow`），唔用 `border`（clip-path 會切走 border）。
- 間距：面板內 12px / 14px；面板距地圖邊 12px；面板之間 8px。
- 模糊半徑 **6px**，唔係 40px。面積**上限 = 地圖 25%**。

**純本機實現**

```css
.panel {
  --panel-bg: color-mix(in srgb, var(--c-surface) 86%, transparent);
  background: var(--panel-bg);
  backdrop-filter: blur(6px) saturate(115%);
  -webkit-backdrop-filter: blur(6px) saturate(115%);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px),
                     calc(100% - 10px) 100%, 0 100%, 0 10px);
  box-shadow: inset 0 0 0 1px var(--c-hairline), var(--sh-high);
}
/* fallback：唔支援 backdrop-filter → 提高不透明度，視覺仍然成立 */
@supports not ((backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px))) {
  .panel { background: color-mix(in srgb, var(--c-surface) 97%, transparent); }
}
/* 關鍵：地圖 pan / zoom 期間關閉 blur（backdrop 每 frame 都變 → 最貴） */
body.is-interacting .panel {
  backdrop-filter: none; -webkit-backdrop-filter: none;
  background: color-mix(in srgb, var(--c-surface) 97%, transparent);
}
```

**效能代價**
- `backdrop-filter` 成本 ∝ **被模糊嘅 backdrop 面積 × 每 frame 重繪次數**。地圖 pan/zoom 時 backdrop 每 frame 都變 → 需要每 frame 重新取樣。
- 6px + 面板面積 ≤25% 地圖 → 實測可接受；40px + 全屏 → 明顯掉 frame。
- 記憶體：每個 `backdrop-filter` 元素會建立一個獨立 compositing layer（≈ 元素面積 × 4 bytes × DPR²）。1320 張卡各一個 blur = 災難。

**`prefers-reduced-motion` 版本**：blur 唔係 motion，**唔需要關**。但要關「blur 值嘅 transition」（如果有）。

**反例**
- ❌ `backdrop-filter: blur(40px)` 鋪滿整個 viewport。
- ❌ 每個 chronicle card 一個 `backdrop-filter`（1320 個 layer）。
- ❌ pan/zoom 期間仍然開 blur。
- ❌ 用 `filter: blur()` 喺面板上（會模糊面板**自己嘅內容**，唔係背景）。

---

#### 【P0-2】戰術網格 + 掃描線底紋（Tactical Grid & Scanline Underlay）

**用途**：地圖背景嘅「儀器感」；面板／header 嘅 CRT 質感。對應 Journey A 第一印象、全部 map 畫面。

**視覺描述**
- 雙層網格：細格 8px（`--c-grid`，opacity ≈ 0.055）、粗格 64px（`--c-grid-strong`，opacity ≈ 0.10）。
- 線寬永遠 **1px**，唔隨 zoom 變。
- **邊緣用 radial mask 淡出**（中心 34% 實、82% 透明）→ 網格唔會「切死」喺地圖邊界，亦唔會遮蓋地圖中央。
- 掃描線**只喺面板／header 用**，線距 3px，opacity ≤ 0.55 —— 唔喺地圖上用。

**純本機實現**

```css
.tactical-grid {
  position: absolute; inset: 0; pointer-events: none; z-index: var(--z-map);
  background-image:
    repeating-linear-gradient(0deg,  var(--c-grid)        0 1px, transparent 1px 8px),
    repeating-linear-gradient(90deg, var(--c-grid)        0 1px, transparent 1px 8px),
    repeating-linear-gradient(0deg,  var(--c-grid-strong) 0 1px, transparent 1px 64px),
    repeating-linear-gradient(90deg, var(--c-grid-strong) 0 1px, transparent 1px 64px);
  -webkit-mask-image: radial-gradient(130% 110% at 50% 42%, #000 34%, transparent 82%);
          mask-image: radial-gradient(130% 110% at 50% 42%, #000 34%, transparent 82%);
}
@supports not (-webkit-mask-image: radial-gradient(#000, #000)) {
  .tactical-grid { opacity: .55; }   /* fallback：整體降透明度 */
}
/* 掃描線：只喺面板 */
.scanlines::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(0deg,
    var(--c-scan) 0 1px, transparent 1px 3px);
  opacity: .55;
}
```

**效能代價**
- `repeating-linear-gradient` 係 **paint-time** rasterization，唔係每 frame。成本 ≈ 一次 rasterize + 之後貼圖。**可忽略**。
- 但**唔可以跟 map transform**：如果網格跟住 pan/zoom 郁，會產生摩爾紋（moiré）而且強制每 frame 重 paint。
- `mask-image` 會令元素多一個 layer；面積 = 地圖面積 → 1 個全屏 layer，可接受。
- **避免** `<filter><feTurbulence>` 做 noise：每 frame 重算，係最大 CPU killer。

**`prefers-reduced-motion` 版本**：靜態紋理唔動 → **唔需要關**。但如果有「掃描線游走」（現況 `#topbar::after` `hud-sweep` 6s translate）→ 要停，保留靜態線：

```css
@media (prefers-reduced-motion: reduce) {
  #topbar::after { animation: none; opacity: .25; transform: none; }
}
```

**反例**
- ❌ 全屏 `animation: scanline-move` 每 frame `translateY` 一個全屏元素 → 強制全屏 repaint。
- ❌ 粒子 canvas 蓋喺地圖上（違反 spec §1.1「裝飾粒子遮住地圖」）。
- ❌ 網格 opacity > 0.15（會同道路爭對比）。
- ❌ 網格跟住 map transform 郁。

---

#### 【P0-3】Zone polygon pattern 編碼（SVG `<pattern>` 五型）

**用途**：所有 territory 圖層 —— 倖存區 / 病窩 / 隔離區 / 爭議地帶 / 未知區。對應 spec §5.4 視覺語言表、Journey B。

**視覺描述**（對應 spec §5.4 逐條）

| 類型 | 形狀語言 | 純 SVG pattern | 顏色（輔助，非唯一） |
|---|---|---|---|
| 倖存區 | 結構化方格（「已建設」） | `<pattern>` 10×10 方格，線 1px、opacity .42 | `--c-safe` |
| 病窩 | 45° 危險斜線（「封鎖」） | `<pattern>` 8×8、`patternTransform="rotate(45)"`、線 2px、opacity .5 | `--c-danger` |
| 隔離區 | -45° 警示斜帶（「管制」） | `<pattern>` 10×10、rotate(-45)、線 3px、opacity .55 | `--c-warn` |
| 爭議地帶 | 雙色同心 contour（「兩方角力」） | `<pattern>` 12×12、兩個同心圓、雙 stroke | `--c-contested` + `--c-accent` |
| 未知區 | 低對比噪點（「未有資料」） | `<pattern>` 7×7、三個 offset `<circle>` | `--c-unknown` |

> **關鍵決定**：未知區用 **`<circle>` 手砌噪點**，唔用 `<feTurbulence>`。feTurbulence 每次 viewBox 變都要重算 filter，係 zoom 期間最大 CPU 殺手；手砌 circle 只係普通 pattern tile。

**純本機實現**

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <pattern id="pat-nest-hatch" width="8" height="8" patternUnits="userSpaceOnUse"
             patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="8"
            stroke="var(--c-danger)" stroke-width="2" stroke-opacity=".5"/>
    </pattern>
    <pattern id="pat-survivor-grid" width="10" height="10" patternUnits="userSpaceOnUse">
      <path d="M0 0H10M0 0V10" fill="none"
            stroke="var(--c-safe)" stroke-width="1" stroke-opacity=".42"/>
    </pattern>
    <pattern id="pat-quarantine" width="10" height="10" patternUnits="userSpaceOnUse"
             patternTransform="rotate(-45)">
      <line x1="0" y1="0" x2="0" y2="10"
            stroke="var(--c-warn)" stroke-width="3" stroke-opacity=".55"/>
    </pattern>
    <pattern id="pat-contested" width="12" height="12" patternUnits="userSpaceOnUse">
      <circle cx="6" cy="6" r="5"   fill="none" stroke="var(--c-contested)" stroke-width="1"   stroke-opacity=".55"/>
      <circle cx="6" cy="6" r="2.4" fill="none" stroke="var(--c-accent)"    stroke-width="1"   stroke-opacity=".50"/>
    </pattern>
    <pattern id="pat-unknown-noise" width="7" height="7" patternUnits="userSpaceOnUse">
      <circle cx="1.6" cy="1.4" r=".75" fill="var(--c-unknown)" fill-opacity=".50"/>
      <circle cx="5.2" cy="3.1" r=".60" fill="var(--c-unknown)" fill-opacity=".42"/>
      <circle cx="2.8" cy="5.4" r=".55" fill="var(--c-unknown)" fill-opacity=".38"/>
    </pattern>
  </defs>
</svg>
```

```css
.zp-nest       { fill: url(#pat-nest-hatch);    stroke: var(--c-danger); }
.zp-survivor   { fill: url(#pat-survivor-grid); stroke: var(--c-safe); }
.zp-quarantine { fill: url(#pat-quarantine);    stroke: var(--c-warn); }
.zp-contested  { fill: url(#pat-contested);     stroke: var(--c-contested); }
.zp-unknown    { fill: url(#pat-unknown-noise); stroke: var(--c-unknown); }
```

**⚠️ Zoom 保持 pattern 像素大小（重要 trick）**

`patternUnits="userSpaceOnUse"` 令 pattern 定義喺 viewBox 座標系。zoom 時 viewBox 縮細 → pattern 一齊放大。要令 pattern 保持屏幕像素大小，**每次 zoom 只更新 `patternTransform` 一個 attribute**（唔需要重建 DOM、唔需要重讀 data）：

```ts
// 只喺 zoom 結束（rAF throttle 之後）跑一次，唔係每 frame
for (const [id, pat] of PATTERNS) {
  pat.setAttribute("patternTransform", `${baseRotate[id]} scale(${1 / viewScale})`);
}
```

呢個亦順便解決「pattern 唔夠細緻」問題 —— 因為 pattern 係向量，任何 zoom 都清晰（符合 spec §2.3「no fake zoom」）。

**效能代價**
- 每個 `<pattern>` 只 rasterize **一次**成一個 tile texture，之後 tiled 填充。5 個 pattern = 5 個 tile，**成本可忽略**。
- zone path 本身係普通 `<path>` fill，同 solid fill 冇分別。
- 記憶體：tile texture 極細（8×8 ~ 12×12 px × DPR²）。
- ⚠️ 唔好喺 pattern 內放 `<filter>` 或大量子節點 —— 會令 tile 變大而且每次 patternTransform 變都要重 rasterize。

**`prefers-reduced-motion` 版本**：pattern 係**靜態**，唔需要關。若做「pattern drift」（`patternTransform` 動畫）→ 必須停：

```css
@media (prefers-reduced-motion: reduce) {
  .zone--nest .zone-area { /* patternTransform 由 JS 控制 → JS 檢查 matchMedia 後唔啟動 */ }
}
```

**反例**
- ❌ `<filter><feTurbulence baseFrequency="0.8"/></filter>` 做 noise fill —— zoom 時每 frame 重算。
- ❌ 用 PNG noise texture 放大（違反 spec §2.3「no fake zoom」，會起格）。
- ❌ 每個 zone 一個獨立 pattern id（48 個 pattern → 48 個 tile + 無法共用）。
- ❌ pattern 只係「深淺唔同嘅同一種色」（仍然係色彩編碼）。

---

#### 【P0-4】未知區 Fog（Unknown Territory Fog）

**用途**：`unknown` / `needs_validation` 區域。對應 spec §5.4「未知區：低對比 fog / question marker；click 顯示資料不足，唔好假裝有 dossier」＋ §0.1 規則 7。

**視覺描述**
- **低對比**：fill opacity 0.14–0.18，唔可以搶眼（未知唔係危險）。
- 邊界 **虛線**（`stroke-dasharray: 2 4`）+ `stroke-opacity ≤ .35` —— 視覺上「未確定」。
- 加一層柔化：**雙層 path**（外層 opacity 0.07、內層 0.16）比 `feGaussianBlur` 便宜得多。
- 中心一個 `?` glyph（用 SVG sprite icon，唔用文字 `?`）。

**純本機實現**

```css
.zone--unknown .zone-area {
  fill: url(#pat-unknown-noise);
  fill-opacity: .16;
  stroke: var(--c-unknown);
  stroke-opacity: .35;
  stroke-dasharray: 2 4;
  vector-effect: non-scaling-stroke;   /* 任何 zoom 都係 2px 線 */
}
/* 柔化用雙層 path，唔用 filter */
.zone--unknown .zone-area--outer { fill-opacity: .07; stroke: none; }
```

```ts
// 只對 ≤5 個 unknown zone 用極輕量 blur（單次 rasterize，唔係每 frame）
if (unknownCount <= 5) g.style.filter = "blur(0.6px)";
```

**效能代價**：近乎零（普通 path）。`blur(0.6px)` 只對少量元素用 → 單次 rasterize。

**`prefers-reduced-motion` 版本**：fog 本身靜態。若加 drift → 停。

**反例**
- ❌ `<feGaussianBlur stdDeviation="20">` 喺每個 zone（每次 viewBox 變都重算 filter）。
- ❌ 用高對比灰／黑做 fog（會蓋住底圖，違反 spec §1.1）。
- ❌ 未知區顯示假 dossier（違反 §0.1 規則 7）。

---

#### 【P0-5】Legend 三重編碼（Color + Pattern + Icon/Shape）

**用途**：地圖 legend、layer control、任何類別標示。對應 spec §2.4「legend 必須同時用 color、pattern、icon／shape」＋ §1.1「只有色彩分辨類別」禁止項。

**視覺描述**
每行 legend 有 **4 個 channel**：
1. **色**：`--c-*`（輔助）
2. **pattern**：20×14 SVG swatch 帶同一 `<pattern>` fill
3. **icon**：14×14 sprite icon，形狀本身帶語意（盾＝安全、生化＝危險、閘＝隔離、雙旗＝爭議、交叉＝未知）
4. **量**：danger meter 分段條（見 P2-12）

行高 22px、gap 8px、swatch 20×14、icon 14×14、文字 11px。

**純本機實現**

```html
<li class="legend-item" role="listitem">
  <svg class="legend-swatch" aria-hidden="true" focusable="false">
    <rect x=".5" y=".5" width="19" height="13"
          fill="url(#pat-nest-hatch)" stroke="var(--c-danger)" stroke-width="1"/>
  </svg>
  <svg class="legend-icon" aria-hidden="true" focusable="false">
    <use href="#ic-biohazard"/>
  </svg>
  <span>病窩</span>
  <span class="danger-meter" data-level="5" role="img" aria-label="危險度 5 級，高危">…</span>
</li>
```

**效能代價**：6–10 行 legend → 10 個 pattern swatch。每個 swatch 係細 SVG（20×14），rasterize 成本可忽略。

**`prefers-reduced-motion` 版本**：靜態。現況有 `.legend-item:hover { transform: translateX(2px) }` → reduced motion 下縮短 transition 至 1ms 即可（**唔可以 0.001ms，見 G6**）。

**驗收方法（自動化，零人手）**
1. Playwright：對 legend 加 `filter: grayscale(1)`，截圖，用 pixel diff 比較每行 swatch 嘅**紋理差異**（唔係色差）。
2. 靜態檢查：每個 `.legend-item` 必須有 ≥1 個 `fill="url(#pat-*)"` 同 ≥1 個 `<use href="#ic-*">`。
3. A11y：每個 legend row 有完整 `aria-label`（例：「病窩，危險度 5 級，危險斜線紋」）。

**反例**
- ❌ 現況 `.dot { background: #e74c3c }`（只有色）。
- ❌ swatch 只係同一個圓形、唔同色。
- ❌ icon 只用嚟裝飾（同類別無對應關係）。

---

#### 【P1-6】Hover Reticle + Selected Beacon

**用途**：地圖 hover 回饋、marker 選取。對應 spec §1.1「hover reticle、selected beacon」、Journey C/D。

**視覺描述**
- **Reticle**：四段 L 形括號，形成「瞄準框」。臂長 15px、缺口 6px、線寬 1.5px、中心一個 r=1.7 圓點。跟 pointer 移動。
- **Beacon（選取態）**：中心實心點 r=3 + 一個擴散環（`scale(.55 → 1.9)`、opacity `.9 → 0`、2.4s）。
- 顏色：`--c-accent`（冷青），同 danger 紅／safe 綠完全分開。

**純本機實現**

```html
<g id="reticle" class="reticle" aria-hidden="true">
  <path class="reticle-arm" d="M-15 -6 V-15 H-6"/>
  <path class="reticle-arm" d="M 15 -6 V-15 H 6"/>
  <path class="reticle-arm" d="M-15  6 V 15 H-6"/>
  <path class="reticle-arm" d="M 15  6 V 15 H 6"/>
  <circle class="reticle-dot" r="1.7"/>
</g>
```

```css
.reticle { opacity: 0; pointer-events: none;
           transition: opacity var(--dur-fast) var(--ease-out); }
.reticle.is-active { opacity: 1; }
/* vector-effect 係關鍵：無論 viewBox 點縮，線寬都係屏幕 1.5px */
.reticle-arm  { fill: none; stroke: var(--c-accent); stroke-width: 1.5;
                vector-effect: non-scaling-stroke; }
.reticle-dot  { fill: var(--c-accent); }

.beacon-ping { fill: none; stroke: var(--c-accent); stroke-width: 1.5;
               transform-box: fill-box; transform-origin: center;
               animation: beacon-ping 2.4s var(--ease-out) infinite; }
@keyframes beacon-ping {
  0%   { transform: scale(.55); opacity: .9; }
  100% { transform: scale(1.9); opacity: 0; }
}
```

```js
// 移動用 transform，唔用 x/y attribute（避免觸發 layout）
mapPane.addEventListener('pointermove', (e) => {
  const { x, y } = toViewBox(e);
  reticle.setAttribute('transform', `translate(${x} ${y})`);
  reticle.classList.add('is-active');
});
```

**效能代價**
- `transform` 動畫 = **compositor-friendly**，唔觸發 layout / paint。
- Reticle 只有 5 個節點，移動成本可忽略。
- ⚠️ 用 `vector-effect: non-scaling-stroke` 取代現況 `setScaled()`（`SvgMap.ts` 每次 zoom 逐個元素改 `stroke-width`）—— 現況做法係 zoom 時 O(n) 嘅 DOM attribute 寫入，`vector-effect` 係 0 次寫入、由 renderer 處理。

**`prefers-reduced-motion` 版本**

```css
@media (prefers-reduced-motion: reduce) {
  .beacon-ping { animation: none; opacity: .55; transform: scale(1); }
  /* reticle 保留（唔係 motion，係 hover feedback），但 transition 縮短 */
  * { transition-duration: 1ms !important; }
}
```

> ⚠️ **唔可以**寫 `animation-duration: 0.001ms` —— 咁樣 `beacon-ping` 會跳到 `opacity: 0`（完全消失）。必須逐個 animation 指定終態。

**反例**
- ❌ 現況 `main.css:339-341`：`.location-marker:hover { filter: drop-shadow(0 0 4px #ffeb3b) }` —— 每個 hover 觸發 filter re-rasterize，而且硬編黃色唔跟主題。
- ❌ 用 `x` / `y` attribute 移 reticle（觸發 layout）。
- ❌ reticle 有 `pointer-events: auto`（會搶走地圖手勢）。

---

#### 【P1-7】危險區低頻呼吸光（Low-amplitude Danger Breath）

**用途**：病窩／危險區嘅「生命感」。對應 spec §1.1「danger zone low-amplitude pulse」、§5.4「病窩：低頻呼吸紅光」、§0.1 規則 8。

**視覺描述**
- **只改 `stroke-opacity`**：0.16 ↔ 0.36（幅度 0.20，**低幅度**）。
- **低頻**：4.8s 週期 = **0.21 Hz**（遠低於 WCAG 2.3.1 嘅 3 Hz 閃爍紅線）。
- **per-zone 去同步**：由 zone id hash 出 `animation-delay` 0–4.8s，令 21 個 nest **唔會一齊跳**（現況 `zone-scan` 全部同步係「全畫面一齊跳」）。
- 光環用 `stroke-width: 6` + `fill: none`（唔用 `box-shadow`／`drop-shadow`）。

**純本機實現**

```css
.zone-glow { fill: none; stroke: var(--c-danger); stroke-width: 6; stroke-opacity: .22; }
.zp-nest-glow { animation: danger-breath 4.8s var(--ease-in-out) infinite; }
@keyframes danger-breath {
  0%, 100% { stroke-opacity: .16; }
  50%      { stroke-opacity: .36; }
}
/* 去同步：由 JS 寫 data-phase 0–3 */
.zone[data-phase="1"] .zone-glow { animation-delay: -1.2s; }
.zone[data-phase="2"] .zone-glow { animation-delay: -2.4s; }
.zone[data-phase="3"] .zone-glow { animation-delay: -3.6s; }
```

```ts
// 穩定 hash（同一個 zone 永遠同一個 phase，refresh 後一致）
const phase = [...zone.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 4;
```

**效能代價**
- `stroke-opacity` 動畫：SVG 屬性動畫，**唔需要 layout**，但會令該 group 每 frame 重 paint（唔係 compositor-only）。
- 限制：只對 **nest 類型**（實測 21 個）開啟，唔對全部 48 個。
- 進一步優化：如果 21 個同時動造成掉 frame → 加 `will-change: opacity`，或者只在 viewport 內嘅 nest 開啟（culling）。

**`prefers-reduced-motion` 版本**

```css
@media (prefers-reduced-motion: reduce) {
  .zp-nest-glow { animation: none; stroke-opacity: .28; }  /* 保留靜態可見光環 */
}
```

**反例**
- ❌ 現況 `zone-scan`：`transform: scale(.86 → 1.06)` + `opacity 0 → .55 → 0`，3.6s，**全部 nest 同步**，幅度大。
- ❌ 動畫 `box-shadow: 0 0 40px red`（`box-shadow` 動畫觸發 paint，唔係 compositor）。
- ❌ 所有 zone 類型都 pulse（冇重點）。
- ❌ 週期 < 1s 或者幅度 > 0.4（會引起不適 + 接近 seizure 風險）。

---

#### 【P1-8】倖存區穩定 Beacon（Steady Survivor Beacon）

**用途**：倖存區嘅「穩定、安全」語意。對應 spec §5.4「倖存區：穩定邊界、低頻 beacon」。

**視覺描述**
- **唔動，或者極慢**：靜態雙環 + 中心實心點。
- 外環 `stroke-dasharray: 3 5`（虛線 = 「已建立但非實心防線」），內環實線。
- 如果要有「心跳」：**只喺 selected 時**開啟，幅度極低（opacity .85 → 1.0，6s）。
- 顏色 `--c-safe`。

**純本機實現**

```css
.beacon-ring { fill: none; stroke: var(--c-safe); stroke-width: 1.5;
               stroke-dasharray: 3 5; vector-effect: non-scaling-stroke; }
.beacon-heart { fill: none; stroke: var(--c-safe); stroke-width: 1.5;
                transform-box: fill-box; transform-origin: center;
                animation: survivor-heart 6s var(--ease-in-out) infinite; }
@keyframes survivor-heart {
  0%, 100% { opacity: .85; }
  50%      { opacity: 1; }
}
```

**效能代價**：極低。`opacity` 動畫，6s 週期 → 每秒只有 ~0.17 次狀態變化。

**`prefers-reduced-motion` 版本**：`animation: none; opacity: 1;`（完全靜態，仍然可見）。

**反例**
- ❌ 倖存區同病窩用同一種 pulse（失去「安全 vs 危險」對比）。
- ❌ 用綠色閃爍（綠色 + 閃爍 = 「前進」語意，同「穩定」矛盾）。
- ❌ 所有倖存區同時心跳（21 個一齊跳 = 冇重點）。

---

#### 【P1-9】Route Pulse / 路徑繪製動畫（Route Draw-on + Flow）

**用途**：角色旅程路線。對應 spec §5.2「route drawing / focus transition」、Journey C。

**視覺描述**
- **Draw-on（選取時）**：900ms，路徑由起點「畫」到終點（`stroke-dashoffset`）。
- **Flow（持續）**：一條短光條（`stroke-dasharray: 7 150`）沿路徑流動，3.2s linear。
- 底線 `--c-warn` 2px opacity .75；光條 `--c-accent` 2.6px。
- **只對「當前選中角色」嘅 route 開 flow** —— 實測 42 條 route 全部同時動 = 視覺噪音 + 效能災難。

**純本機實現**

```css
.route { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.route-base { stroke: var(--c-warn); stroke-width: 2; stroke-opacity: .75; }
.route-flow {
  stroke: var(--c-accent); stroke-width: 2.6;
  stroke-dasharray: 7 150;
  animation: route-flow 3.2s linear infinite;
}
@keyframes route-flow { to { stroke-dashoffset: -157; } }

/* draw-on：由 JS 設 --len（getTotalLength 只量一次，唔每 frame） */
.is-drawing .route-base {
  stroke-dasharray: var(--len);
  stroke-dashoffset: var(--len);
  animation: route-draw var(--dur-slowest) var(--ease-out) forwards;
}
@keyframes route-draw { to { stroke-dashoffset: 0; } }
```

```js
// 只量一次；重播時先移除 class、強制 reflow、再加返
const len = routeBase.getTotalLength();
g.style.setProperty('--len', len);
g.classList.remove('is-drawing'); void g.offsetWidth; g.classList.add('is-drawing');
```

**效能代價**
- `stroke-dashoffset` 動畫：SVG paint 動畫（唔係 compositor-only），但唔需要 layout。
- 1 條 route（幾百個點）→ 可接受。42 條同時 → 明顯掉 frame。
- `getTotalLength()` 係 layout 計算，**貴**。只可喺 draw-on 開始時量一次，**唔可以喺 rAF 內量**。

**`prefers-reduced-motion` 版本**

```css
@media (prefers-reduced-motion: reduce) {
  .route-flow { animation: none; stroke-dasharray: none; stroke-opacity: .9; }
  .is-drawing .route-base { animation: none; stroke-dasharray: none; stroke-dashoffset: 0; }
}
```
→ 路線**直接完整顯示**，唔係消失。

**反例**
- ❌ 42 條 route 全部同時 `stroke-dashoffset` 動畫。
- ❌ 用 `stroke-dasharray` 做「螞蟻線」（`animation: dash 1s linear infinite` 週期 < 1s）—— 視覺噪音 + 接近閃爍紅線。
- ❌ 每 frame 呼叫 `getTotalLength()`。
- ❌ 用 `filter: drop-shadow` 做 route glow（每 frame 重算 filter）。

---

#### 【P1-10】Layer Cross-fade（圖層交叉淡入）

**用途**：layer toggle（倖存區 / 病窩 / 事件 / 角色旅程 / 時期 / 地圖細節）。對應 spec §5.2「map layer fade / cross-fade」、§2.4 layer control。

**視覺描述**
- 三態：`on`（opacity 1）、`dim`（0.25，用於「selected zone 時其他區域 soft-focus」）、`off`（0 + `pointer-events: none`）。
- 過場 220ms `--ease-out`。
- **唔用 `display` 硬切**（會閃），**唔用 `filter: blur()` 做 cross-fade**（極貴）。

**純本機實現**

```css
.layer { transition: opacity var(--dur-normal) var(--ease-out); }
.layer[data-state="off"] { opacity: 0; pointer-events: none; }
.layer[data-state="dim"] { opacity: .25; }
```

```ts
// 用 data-state 而唔係 class 切換 —— 語意清楚、可以加多個維度
layer.dataset.state = on ? "on" : "off";
btn.setAttribute("aria-pressed", String(on));
```

**效能代價**
- `opacity` 動畫 = **compositor-friendly**（如果元素已經有自己嘅 layer）。
- ⚠️ 但 SVG `<g>` 有大量子節點時，opacity 動畫會令成個 group 首次變成一個 texture → 第一次會有 re-rasterize 成本。
  - 對 zone 層（48 個 path）→ 可接受。
  - 對 event 層（**1796 個 marker**）→ **唔可以**直接 group opacity 動畫。要先做 viewport culling（只 render 視窗內 marker），再對 group 做 opacity。

**`prefers-reduced-motion` 版本**

```css
@media (prefers-reduced-motion: reduce) {
  .layer { transition-duration: 1ms; }   /* 即時切換，但仍然係 opacity 而非 display */
}
```

**反例**
- ❌ `display: none` ↔ `display: block`（冇過場、會閃、失去 focus 位置）。
- ❌ `filter: blur(8px)` 做 cross-fade。
- ❌ 對 1796 個 marker 嘅 group 做 opacity 動畫。
- ❌ 用 `visibility` 切換（transition 會被中斷）。

---

#### 【P2-11】Data Stream / Loading Skeleton

**用途**：資料載入中嘅佔位。對應 spec §5.2「loading skeleton / data stream」、§7.4 效能目標。

**視覺描述**
- 骨架塊：`--c-skel-base` 底 + 一條 `--c-skel-hi` 光條由左掃到右。
- 週期 1.4s、`--ease-in-out`、**唔可以快過 1s**。
- **唔要「假數據流」文字動畫** —— spec §0.1 規則 8：所有特效要有功能。Data stream 只可以用嚟表示**真實**載入進度。

**純本機實現**

```css
.skeleton { position: relative; overflow: hidden;
            background: var(--c-skel-base); clip-path: var(--clip-sm); }
/* 用 ::after + transform（compositor-friendly），唔用 background-position */
.skeleton::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, var(--c-skel-hi), transparent);
  transform: translateX(-100%);
  animation: skeleton-sweep 1.4s var(--ease-in-out) infinite;
}
@keyframes skeleton-sweep { to { transform: translateX(100%); } }
```

**效能代價**
- `transform: translateX` = compositor-friendly。✅
- 對比：`background-position` 動畫係 paint 動畫（較貴，但只限細面積亦 OK）。
- ⚠️ 唔可以為 1320 個卡同時開 skeleton。

**`prefers-reduced-motion` 版本**

```css
@media (prefers-reduced-motion: reduce) {
  .skeleton::after { animation: none; transform: none; }
  /* 保留靜態漸層，仍然有「載入中」感 */
}
```

**反例**
- ❌ 週期 < 0.5s（閃爍）。
- ❌ 用 `opacity: 0 ↔ 1` 反覆閃（seizure 風險）。
- ❌ 假數據流文字（「CONNECTING… SCANNING…」逐字出現）但實際冇對應進度。
- ❌ 1320 個 skeleton 同時動。

---

#### 【P2-12】危險度編碼（Danger Level Encoding，非色彩）

**用途**：zone danger_level、event 嚴重度、座標可信度。對應 spec §2.4「danger」、§5.4。

**視覺描述**
- **分段條**：5 段，每段 9×6px、gap 2px。已填 = `--c-danger`，未填 = `--c-meter-off`。
- **4–5 級額加斜線紋**（`repeating-linear-gradient(45deg, …)`）→ 灰度之下仍然分得出。
- **5 級額加外框**（`outline: 1px solid var(--c-danger); outline-offset: 2px`）。
- 亦可以同步編碼喺 zone 邊界：level 越高，`stroke-dasharray` 越密（`2 6` → `1 2`）。

**純本機實現**

```html
<span class="danger-meter" data-level="5" role="img" aria-label="危險度 5 級，高危">
  <i class="dm-seg is-on"></i><i class="dm-seg is-on"></i><i class="dm-seg is-on"></i>
  <i class="dm-seg is-on"></i><i class="dm-seg is-on"></i>
</span>
```

```css
.danger-meter { display: inline-flex; gap: 2px; align-items: center; }
.dm-seg { width: 9px; height: 6px; background: var(--c-meter-off); }
.dm-seg.is-on { background: var(--c-danger); }
.danger-meter[data-level="4"] .dm-seg.is-on,
.danger-meter[data-level="5"] .dm-seg.is-on {
  background-image: repeating-linear-gradient(45deg,
    rgba(0,0,0,.38) 0 2px, transparent 2px 4px);
}
.danger-meter[data-level="5"] { outline: 1px solid var(--c-danger); outline-offset: 2px; }
```

**效能代價**：純 CSS，零動畫。每個 meter 5 個 `<i>`。可忽略。

**`prefers-reduced-motion` 版本**：靜態，唔需要。

**反例**
- ❌ 只用 `fill: red` vs `fill: orange`（現況 `ZONE_STYLE` 只有色）。
- ❌ 用 5 個唔同色階（色盲完全不可用）。
- ❌ meter 冇 `aria-label`（screen reader 只讀到空白 `<i>`）。

**驗收方法（自動化）**
- Playwright：`filter: grayscale(1)` 之後截圖，用 pixel diff 檢查 level 3 vs level 4 vs level 5 嘅 meter 區域**有可測差異**。
- 靜態檢查：每個 `.danger-meter` 有 `role="img"` + `aria-label` 含數字。

---

### 3. Token 系統建議（對應 spec §5.2）

#### 3.1 Token 表

**Color（semantic，唔用「色名」）**

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--c-void` | `#05080c` | `#eae5da` | 最外層背景（app 之外） |
| `--c-base` | `#080d13` | `#f4f1ea` | 地圖容器底 |
| `--c-surface` | `#0d141d` | `#fbf9f5` | 面板底 |
| `--c-elevated` | `#131c28` | `#ffffff` | 面板內卡片 |
| `--c-overlay` | `#1a2534` | `#f0ece3` | header / hover 態 |
| `--c-hairline` | `rgba(120,190,220,.16)` | `rgba(40,80,110,.18)` | 1px 髮絲線 |
| `--c-hairline-strong` | `rgba(120,200,235,.30)` | `rgba(40,80,110,.32)` | 強調分隔 |
| `--c-text` | `#e8eef6` | `#1f2733` | 主文字 |
| `--c-text-muted` | `#9aabc0` | `#4a5568` | 次要文字 |
| `--c-text-faint` | `#66788d` | `#7b8794` | 標籤／單位 |
| `--c-accent` | `#38e8ff` | `#0f7f9c` | 導航／選取（**唯一裝飾強調色**） |
| `--c-accent-dim` | `rgba(56,232,255,.32)` | `rgba(15,127,156,.30)` | accent 淡化 |
| `--c-danger` | `#ff5a4d` | `#c0392b` | 病窩／高危 |
| `--c-warn` | `#ffb347` | `#a8761c` | 隔離／警示 |
| `--c-safe` | `#2fd6a8` | `#1a8f6a` | 倖存區 |
| `--c-contested` | `#a06bd8` | `#7a4fa3` | 爭議地帶 |
| `--c-unknown` | `#7d8ea3` | `#6b7a8c` | 未知區 |
| `--c-grid` | `rgba(120,190,220,.055)` | `rgba(40,80,110,.07)` | 細網格 |
| `--c-grid-strong` | `rgba(120,190,220,.10)` | `rgba(40,80,110,.12)` | 粗網格 |
| `--c-scan` | `rgba(255,255,255,.030)` | `rgba(0,0,0,.022)` | 掃描線 |
| `--c-skel-base` | `rgba(255,255,255,.045)` | `rgba(31,39,51,.06)` | skeleton 底 |
| `--c-skel-hi` | `rgba(56,232,255,.18)` | `rgba(15,127,156,.18)` | skeleton 光條 |
| `--c-meter-off` | `rgba(255,255,255,.12)` | `rgba(31,39,51,.14)` | danger meter 未填段 |

**Spacing**：`--sp-1:4px` `--sp-2:8px` `--sp-3:12px` `--sp-4:16px` `--sp-5:24px` `--sp-6:32px` `--sp-7:48px`

**Radius**：`--r-xs:2px` `--r-sm:4px` `--r-md:8px` `--r-lg:12px` `--r-xl:16px` `--r-full:999px`（**注意**：HUD 面板用 `--clip` 切角，唔用 radius；radius 只留畀 mobile bottom sheet 同 avatar）

**Shadow**：`--sh-low` `--sh-med` `--sh-high`（dark 用黑陰影、light 用 `rgba(31,39,51,…)`）＋ `--sh-hairline-inset: inset 0 0 0 1px var(--c-hairline)`

**Z-index**（現況硬編散落，必須收斂）

| Token | 值 | 用途 |
|---|---|---|
| `--z-map` | 0 | 地圖底（canvas / 網格） |
| `--z-map-overlay` | 20 | legend / tooltip |
| `--z-controls` | 30 | zoom / layer 控制 |
| `--z-panel` | 60 | 右側面板 / bottom sheet |
| `--z-modal` | 1000 | modal / search |
| `--z-toast` | 1100 | toast |
| `--z-skip` | 1200 | skip-link |

**Motion**

| Token | 值 | 用途 |
|---|---|---|
| `--dur-fast` | 120ms | hover / focus / 細微回饋 |
| `--dur-normal` | 220ms | layer cross-fade / panel transition |
| `--dur-slow` | 420ms | 面板進場 / 內容 stagger |
| `--dur-slowest` | 720ms | route draw-on |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | 進場（減速） |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | 循環動效（呼吸） |
| `--ease-linear` | `linear` | 持續流動（route flow / skeleton） |

**允許動畫嘅 state（白名單，spec §5.2）**：map layer fade / selected zone outline pulse / route drawing / panel transition / marker hover & selection / loading skeleton / danger zone low-amplitude pulse。**其他一律唔准動**。

#### 3.2 可貼用嘅 CSS custom properties 草案

```css
/* ══════════════════════════════════════════════════════════════════════════
   World Atlas V2 — Design Tokens
   ══════════════════════════════════════════════════════════════════════════
   規則：
     1. 元件**只可以**引用語意 token（--c-* / --sp-* / --dur-*），唔可以寫死 hex / px。
     2. dark 係 :root 預設（V2 係 dark-first，唔跟系統偏好）。
     3. light 由 [data-theme="light"] 覆蓋。
     4. canvas 圖層讀唔到 CSS 變數 → 由 src/theme-tokens.ts 提供同一份色值，
        並由 vitest 做 parity 測試（見 §3.3）。
*/

:root {
  color-scheme: dark;

  /* ---- 表面 ---- */
  --c-void:      #05080c;
  --c-base:      #080d13;
  --c-surface:   #0d141d;
  --c-elevated:  #131c28;
  --c-overlay:   #1a2534;

  /* ---- 線 ---- */
  --c-hairline:        rgba(120, 190, 220, 0.16);
  --c-hairline-strong: rgba(120, 200, 235, 0.30);

  /* ---- 文字 ---- */
  --c-text:       #e8eef6;
  --c-text-muted: #9aabc0;
  --c-text-faint: #66788d;

  /* ---- 語意色 ---- */
  --c-accent:      #38e8ff;
  --c-accent-dim:  rgba(56, 232, 255, 0.32);
  --c-danger:      #ff5a4d;
  --c-warn:        #ffb347;
  --c-safe:        #2fd6a8;
  --c-contested:   #a06bd8;
  --c-unknown:     #7d8ea3;

  /* ---- 紋理 ---- */
  --c-grid:        rgba(120, 190, 220, 0.055);
  --c-grid-strong: rgba(120, 190, 220, 0.10);
  --c-scan:        rgba(255, 255, 255, 0.030);
  --c-skel-base:   rgba(255, 255, 255, 0.045);
  --c-skel-hi:     rgba(56, 232, 255, 0.18);
  --c-meter-off:   rgba(255, 255, 255, 0.12);

  /* ---- 間距（8px 節奏 + 4px 半格） ---- */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;

  /* ---- 圓角 ---- */
  --r-xs: 2px; --r-sm: 4px; --r-md: 8px;
  --r-lg: 12px; --r-xl: 16px; --r-full: 999px;

  /* ---- 切角（HUD 面板用，唔用 radius） ---- */
  --clip: polygon(10px 0, 100% 0, 100% calc(100% - 10px),
                  calc(100% - 10px) 100%, 0 100%, 0 10px);
  --clip-sm: polygon(6px 0, 100% 0, 100% calc(100% - 6px),
                     calc(100% - 6px) 100%, 0 100%, 0 6px);

  /* ---- 陰影 ---- */
  --sh-low:  0 1px 2px rgba(0, 0, 0, 0.32);
  --sh-med:  0 4px 12px rgba(0, 0, 0, 0.38);
  --sh-high: 0 12px 32px rgba(0, 0, 0, 0.48);
  --sh-hairline-inset: inset 0 0 0 1px var(--c-hairline);

  /* ---- z-index ---- */
  --z-map: 0; --z-map-overlay: 20; --z-controls: 30;
  --z-panel: 60; --z-modal: 1000; --z-toast: 1100; --z-skip: 1200;

  /* ---- motion ---- */
  --dur-fast: 120ms; --dur-normal: 220ms;
  --dur-slow: 420ms; --dur-slowest: 720ms;
  --ease-out:    cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --ease-linear: linear;

  /* ---- 玻璃（面積受限） ---- */
  --glass:       color-mix(in srgb, var(--c-surface) 86%, transparent);
  --glass-solid: color-mix(in srgb, var(--c-surface) 97%, transparent);

  /* ---- 字體（純系統，零 bundled font） ---- */
  --font-sans: system-ui, -apple-system, "Segoe UI",
               "PingFang HK", "PingFang TC", "Noto Sans CJK HK",
               "Microsoft JhengHei", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

[data-theme="light"] {
  color-scheme: light;

  --c-void:      #eae5da;
  --c-base:      #f4f1ea;
  --c-surface:   #fbf9f5;
  --c-elevated:  #ffffff;
  --c-overlay:   #f0ece3;

  --c-hairline:        rgba(40, 80, 110, 0.18);
  --c-hairline-strong: rgba(40, 80, 110, 0.32);

  --c-text:       #1f2733;
  --c-text-muted: #4a5568;
  --c-text-faint: #7b8794;

  --c-accent:     #0f7f9c;
  --c-accent-dim: rgba(15, 127, 156, 0.30);
  --c-danger:     #c0392b;
  --c-warn:       #a8761c;
  --c-safe:       #1a8f6a;
  --c-contested:  #7a4fa3;
  --c-unknown:    #6b7a8c;

  --c-grid:        rgba(40, 80, 110, 0.07);
  --c-grid-strong: rgba(40, 80, 110, 0.12);
  --c-scan:        rgba(0, 0, 0, 0.022);
  --c-skel-base:   rgba(31, 39, 51, 0.06);
  --c-skel-hi:     rgba(15, 127, 156, 0.18);
  --c-meter-off:   rgba(31, 39, 51, 0.14);

  --sh-low:  0 1px 2px rgba(31, 39, 51, 0.08);
  --sh-med:  0 4px 12px rgba(31, 39, 51, 0.10);
  --sh-high: 0 12px 32px rgba(31, 39, 51, 0.14);
}

/* ══════════════════════════════════════════════════════════════════════════
   Reduced motion —— 逐個 pattern 明確處理，**唔用** 0.001ms 全域 kill
   ══════════════════════════════════════════════════════════════════════════
   ⚠️ 現況 main.css:1107 / hud.css:564 用 animation-duration: 0.001ms !important，
      會令動畫「跳終態」：zone 光環（終態 opacity 0）直接消失、
      skeleton 失效。以下係正確做法。
*/
@media (prefers-reduced-motion: reduce) {
  /* 循環動效 → 停，但保留靜態可見狀態 */
  .zp-nest-glow   { animation: none; stroke-opacity: 0.28; }
  .beacon-heart   { animation: none; opacity: 1; }
  .beacon-ping    { animation: none; opacity: 0.55; transform: scale(1); }
  .route-flow     { animation: none; stroke-dasharray: none; stroke-opacity: 0.9; }
  .skeleton::after{ animation: none; transform: none; }
  #topbar::after  { animation: none; opacity: 0.25; transform: none; }

  /* 進場動效 → 停，直接顯示終態 */
  .card, .zd-section, .story-summary { animation: none; }
  .is-drawing .route-base { animation: none; stroke-dasharray: none; stroke-dashoffset: 0; }

  /* transition → 縮短到 1ms（唔可以 0.001ms：會令 transition 事件失效） */
  * { transition-duration: 1ms !important; }
}

/* 高對比偏好（順帶處理，spec §7.1 a11y） */
@media (prefers-contrast: more) {
  :root { --c-hairline: rgba(120, 200, 235, 0.45); --c-text-muted: #b9c7d8; }
  .panel { backdrop-filter: none; background: var(--c-surface); }
}
```

#### 3.3 兼容現有 `basemap-theme-change` 機制（canvas 讀唔到 CSS 變數）

**問題**：`src/theme.ts:53-55` 會 dispatch：

```ts
window.dispatchEvent(new CustomEvent("basemap-theme-change", { detail: { theme } }));
```

`src/map/VectorBasemap.ts` 訂閱之後要決定 land / water / road / label 嘅色。但 **Canvas 2D 讀唔到 CSS custom properties**（`ctx.fillStyle = "var(--c-safe)"` 唔 work）。

**建議方案（三層，由最保守到最理想）**

**方案 A（保守，最低風險）**：TS 側維護一份 mirror。

```ts
// src/theme-tokens.ts —— 新增檔案（B1 scope）
import type { Theme } from "./theme";

export interface MapPalette {
  land: string; landStroke: string;
  water: string; waterStroke: string;
  roadCasing: string; roadFill: string;
  areaFill: string;
  labelText: string; labelHalo: string;
  zoneStroke: { survivor: string; nest: string; outpost: string };
}

export const MAP_PALETTE: Record<Theme, MapPalette> = {
  dark: {
    land: "#0f1620", landStroke: "rgba(120,190,220,0.22)",
    water: "#080e16", waterStroke: "rgba(120,190,220,0.14)",
    roadCasing: "rgba(0,0,0,0.45)", roadFill: "#ffb347",
    areaFill: "rgba(120,190,220,0.06)",
    labelText: "#c7d5e6", labelHalo: "rgba(5,8,12,0.85)",
    zoneStroke: { survivor: "#2fd6a8", nest: "#ff5a4d", outpost: "#a06bd8" },
  },
  light: {
    land: "#eeeae1", landStroke: "rgba(40,80,110,0.24)",
    water: "#dfe7ee", waterStroke: "rgba(40,80,110,0.16)",
    roadCasing: "rgba(255,255,255,0.55)", roadFill: "#b9721c",
    areaFill: "rgba(40,80,110,0.05)",
    labelText: "#3b4655", labelHalo: "rgba(251,249,245,0.9)",
    zoneStroke: { survivor: "#1a8f6a", nest: "#c0392b", outpost: "#7a4fa3" },
  },
};
```

`VectorBasemap` 訂閱：

```ts
window.addEventListener("basemap-theme-change", (e) => {
  const theme = (e as CustomEvent<{ theme: Theme }>).detail.theme;
  this.palette = MAP_PALETTE[theme];
  this.render();                       // 唔需要重新 fetch，只重繪
});
```

**方案 B（推薦，防 drift）**：加一個 **parity 測試**，由 CSS 檔 parse `--c-*` 同 `MAP_PALETTE` 逐個比對：

```ts
// tests/theme-token-parity.test.ts（B1 scope）
it("CSS token 同 TS MAP_PALETTE 一致", () => {
  const css = readFileSync("src/styles/tokens.css", "utf8");
  const darkVars = parseVars(css, ":root");
  expect(darkVars["--c-safe"]).toBe(MAP_PALETTE.dark.zoneStroke.survivor);
  // …逐個 zone 色比對
});
```
→ 任何人改 CSS 但唔改 TS，測試即刻 fail。**零人手覆核**，符合 AGENTS.md。

**方案 C（最理想，但改動最大）**：CSS 由 TS 生成（build step 寫 `tokens.css`）。唯一真相 = `theme-tokens.ts`。代價係要改 build pipeline。

**建議**：先做 **A + B**（低風險、即刻可驗），C 留待 B1 評估。

**額外**：`theme.ts` 現有嘅「跟系統偏好」邏輯（`systemPrefers()`）同 V2 「dark-first 末日指揮室」定位衝突（G3）。建議：

```ts
function systemPrefers(): Theme {
  // V2：dark 係產品定位，唔跟系統 light 偏好。
  // 只有用戶主動揀過 light 才用 light。
  return "dark";
}
```
即：**default 永遠 dark**；`prefers-color-scheme: light` 唔再自動翻成 light；light 變成用戶主動選項。呢個亦令 spec §1.1 嘅視覺方向成為 default 體驗。

---

### 4. 字體策略

#### 4.1 現況實測

| 項目 | 實測值 | 檔案 |
|---|---|---|
| `font-family` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang HK", "Microsoft JhengHei", sans-serif` | `main.css:94` |
| monospace | `ui-monospace, SFMono-Regular, Menlo, monospace`（錯誤面板）、`monospace`（kbd） | `main.css:693, 788` |
| bundled font 檔 | **0 個**（`public/assets/` 冇任何 woff/woff2/ttf/otf） | `ls public/assets/` |
| 外部字體請求 | **0 個**（`index.html` 冇任何 `<link>`；baseline 6 run external = 0） | `index.html` |

→ **現況已經符合 spec「字體本機 bundled」要求**，因為根本冇用自訂字體。呢個係要**保住**嘅成就。

#### 4.2 V2 字體策略

**原則：唔 bundle 中文字體。** 理由：

- 完整 Noto Sans CJK HK（繁體 + 香港字集）WOFF2 ≈ **16 MB**；就算 subset 到常用 6,000 字，仍然 ≈ **2–4 MB**。
- 專案目標係「完全離線、可部署到 GitHub Pages」（AGENTS.md）。加 2–4 MB 字體係對初次載入（baseline 已 2.6–2.8s，接近 spec §7.4 嘅 3s 上限）嘅直接傷害。
- 系統字體（macOS PingFang HK / Windows Microsoft JhengHei）本身質素高、香港字集完整、**零 bytes**。

**三層策略**

**Layer 1 — 中文／正文：系統 stack（永遠）**

```css
--font-sans: system-ui, -apple-system, "Segoe UI",
             "PingFang HK", "PingFang TC", "Noto Sans CJK HK",
             "Microsoft JhengHei", "Microsoft YaHei", sans-serif;
```

改善點（相對現況）：
- 加 `system-ui` 放最前（現代標準，`-apple-system` / `BlinkMacSystemFont` 係舊 fallback）。
- `"PingFang HK"` 放喺 `"PingFang TC"` 之前 —— macOS 上香港字集優先（正確嘅字形，例：「睇」「嘅」「喺」）。
- 加 `"Noto Sans CJK HK"` 覆蓋 Linux / Android。

**Layer 2 — HUD 數字／拉丁（可選，≤12 KB）**

如果要有「儀器讀數」感（窄字寬、`tabular-nums`、高 x-height），只 bundle 一個**拉丁＋數字 subset**：

```bash
# 由 OFL / Apache 授權字體生成（例：Inter、IBM Plex Mono、JetBrains Mono）
# 字元集 = 數字 + 常見標點 + 大寫拉丁
pyftsubset source.ttf \
  --unicodes="U+0020-007E" \
  --layout-features="tnum,case" \
  --flavor=woff2 \
  --output-file=public/assets/fonts/atlas-num-subset.woff2
# 目標：≤ 12 KB
```

```css
@font-face {
  font-family: "Atlas Num";
  src: url("/assets/fonts/atlas-num-subset.woff2") format("woff2");
  font-weight: 400 700;
  font-display: swap;
  /* ⚠️ 關鍵：只覆蓋 ASCII。中文永遠 fallback 系統字體，
     唔會出現 tofu / 亂碼 / 半中半英嘅怪字距。 */
  unicode-range: U+0020-007E;
}
```

`unicode-range` 係呢個方案成立嘅**必要條件**：即使有人打中文落 input，因為唔喺 range，瀏覽器直接用 fallback 字體，唔會 attempt 用缺字嘅 subset。

授權要求：只可用 **SIL OFL** 或 **Apache 2.0** 字體，並喺 `docs/` 記錄字體名、版本、授權、來源 URL、SHA-256。

**Layer 3 — 如果真係要 bundle 中文（唔推薦，但提供可驗做法）**

唯一可接受做法：**由 public data 實際出現嘅字元集抽 subset**（唔可以靠人手選字）。

```bash
# 1. 由 public data 抽字元集（可重跑、deterministic）
python scripts/build_font_subset.py \
  --inputs data/public/zones.geojson data/public/locations.geojson \
           data/public/characters.json data/public/chronicle.json \
  --ui-strings src/styles src/components src/app.ts \
  --out artifacts/font-subset-charset.txt
# 2. 生成 subset
pyftsubset source.ttf --text-file=artifacts/font-subset-charset.txt \
  --flavor=woff2 --output-file=public/assets/fonts/atlas-cjk-subset.woff2
```

估體積：`zones`（48 name）+ `locations`（704 display_name）+ `characters`（330 name）+ chronicle 標題 ≈ **1,500–2,500 個不重複漢字** → WOFF2 約 **600 KB – 1.2 MB**。

**但即使做咗，仍然要面對**：新資料加入時字集會變 → subset 要重新生成 → 需要 build step 同 hash 記錄。**成本高於收益，建議唔做。**

#### 4.3 驗收方法（自動化，零人手）

1. **零外部字體請求**：Playwright `page.on("request")` 檢查所有 request 都係 `file://` / `localhost`；assert 冇 `fonts.googleapis.com` / `fonts.gstatic.com` / `use.typekit.net` / `cdn.jsdelivr.net` / `unpkg.com` / `cdnjs.cloudflare.com`。
2. **零外部 asset**：同上，檢查 `document.styleSheets` 內所有 `@import` / `url()` 都係相對路徑。
3. **CSS 掃描**：`grep -rn "https\?://" src/styles/ index.html` → 必須 0 hit（除咗註解內嘅說明）。
4. **字體載入**：`document.fonts.forEach(f => assert(f.family === 'Atlas Num'))` + `document.fonts.size` ≤ 1（如果做 Layer 2）。
5. **無 tofu**：對一組含香港字（「睇嘅喺咁啲嘢」）嘅測試字串截圖，檢查冇 `.notdef` 方框。

#### 4.4 反例

- ❌ `<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+HK">`。
- ❌ `@import url(https://fonts.googleapis.com/...)`。
- ❌ `@font-face { src: url(https://cdn.jsdelivr.net/...) }`。
- ❌ 用 `local()` 引用一個「可能唔存在」嘅系統字體名做 primary（會靜默 fallback，行為不可預測）。
- ❌ 為咗「未來感」而 bundle 一個只有 200 個拉丁字嘅「科幻字體」但用喺中文 UI（會 tofu）。
- ❌ `font-display: block`（會 FOIT，白畫面等字體）。

---

### 5. Icon 策略

#### 5.1 現況實測

| 位置 | 現況 | 問題 |
|---|---|---|
| `app.ts:88` | `📜 編年史` | emoji + 文字並存（可接受，但 emoji 字形不可控） |
| `app.ts:89` | `🔍 搜尋` | 同上 |
| `app.ts:90` | `🔗`（title="複製呢一章嘅連結"） | **純 emoji 無文字標籤** |
| `app.ts:91` | `⬇`（title="匯出目前地圖為 PNG"） | 同上 |
| `app.ts:92,169` | `🌙` / `☀️`（動態切換） | 同上 |
| `app.ts:93` | `?` | 純文字，唔係 icon |
| `app.ts:94,97` | `關於` / `面板` | 純文字 |

#### 5.2 Emoji 做 icon 嘅 6 個問題

1. **跨平台 render 完全唔同**：📜 喺 Windows（Segoe UI Emoji，平面彩色）、macOS（Apple Color Emoji，立體）、Android（Noto Color Emoji）係**三個唔同設計**。產品視覺唔可能一致。
2. **唔可以控色**：彩色 emoji 用 CBDT / COLR / sbix 格式，CSS `color` 完全無效。深色主題下 🔗 同淺色主題下 🔗 一模一樣 → 對比度不可控。
3. **唔可以精準控尺寸**：emoji 有唔對稱 side bearing，同文字基線對唔齊；`font-size: 16px` 出嚟嘅實際高度因平台而異。
4. **a11y 讀法唔一致**：screen reader 讀「scroll」「magnifying glass tilted left」「link」「downwards arrow」。同按鈕功能（編年史 / 搜尋 / 分享 / 匯出）**唔一致**，而且平台之間唔同。`?` 更係讀「question mark」。
5. **實質上係外部依賴**：emoji 由**系統 emoji 字體**提供 —— 呢個係一個唔受專案控制嘅外部 render resource。雖然唔產生 network request，但視覺輸出唔 deterministic（唔同 OS / 唔同版本都唔同）。
6. **同切角 HUD 語言完全唔夾**：現況 `hud.css` 嘅語言係「髮絲線 + 切角 + 單色 + 青強調」。彩色立體 emoji 落喺呢個語言入面會非常突兀。

#### 5.3 V2 方案：本機 inline SVG sprite

**架構決定：唔用外部 `.svg` 檔 + `<use href="icons.svg#id">`。**

原因：跨文件 `<use>` 有兩個問題 ——
1. 部分瀏覽器引擎唔會將 `currentColor` 由引用文件傳入（導致 icon 永遠黑色）。
2. 會產生一個額外 network request（雖然係本機，但會多一個 round-trip）。

**改用：inline sprite 注入 DOM 一次。**

```ts
// src/ui/icons.ts（B1 scope）
export const ICON_SPRITE = `<svg width="0" height="0" style="position:absolute"
     aria-hidden="true" focusable="false"><defs>
  <g id="ic-search" fill="none" stroke="currentColor" stroke-width="1.5"
     stroke-linecap="square" stroke-linejoin="miter">
    <circle cx="10.5" cy="10.5" r="5.5"/><path d="M14.6 14.6 20 20"/>
  </g>
  <!-- …其餘 icon -->
</defs></svg>`;

// 開機注入一次（main.ts）
document.body.insertAdjacentHTML("afterbegin", ICON_SPRITE);
```

用法（same-document reference → `currentColor` 正常繼承、零 network）：

```html
<button class="nav-btn" aria-label="搜尋">
  <svg class="ic" aria-hidden="true" focusable="false"><use href="#ic-search"/></svg>
  <span>搜尋</span>
</button>
```

**設計規格**

| 項目 | 值 | 理由 |
|---|---|---|
| grid | 24×24 | 標準，容易對齊 |
| stroke | 1.5 | 同 1px 髮絲線語言一致 |
| `stroke-linecap` | `square` | 切角語言（**唔用 round** —— round 係消費級） |
| `stroke-linejoin` | `miter` | 同上 |
| `fill` | `none` | 線性 icon |
| 色 | `currentColor` | 自動跟主題 |
| 顯示尺寸 | 16px（nav）/ 14px（legend）/ 20px（空狀態） | 由 CSS `width/height` 控 |

**需要嘅 icon 集合（對應現有 nav + V2 新功能）**

| 群組 | Icon id |
|---|---|
| 導航 | `ic-chronicle` `ic-search` `ic-share` `ic-export` `ic-theme` `ic-help` `ic-info` `ic-panel` `ic-layers` |
| 地圖控制 | `ic-zoom-in` `ic-zoom-out` `ic-reset` `ic-measure` |
| Zone 類型 | `ic-shield`（倖存）`ic-biohazard`（病窩）`ic-gate`（隔離）`ic-contested`（爭議）`ic-unknown`（未知） |
| 資料 | `ic-route` `ic-event` `ic-location` `ic-character` `ic-chapter` |
| 可信度 | `ic-verified` `ic-approximate` `ic-unknown-status` `ic-quarantined` |
| 通用 | `ic-close` `ic-chevron-left/right/down` `ic-external` `ic-warning` |

**A11y 規則（強制）**

```html
<!-- 1. icon-only button：一定要有 aria-label，svg 要 aria-hidden -->
<button aria-label="分享連結">
  <svg aria-hidden="true" focusable="false"><use href="#ic-share"/></svg>
</button>

<!-- 2. icon + 文字：svg aria-hidden，避免重複朗讀 -->
<button>
  <svg aria-hidden="true" focusable="false"><use href="#ic-search"/></svg>
  <span>搜尋</span>
</button>

<!-- 3. 純裝飾 icon：aria-hidden + role="presentation" -->
<svg aria-hidden="true" focusable="false" role="presentation">…</svg>
```

- `focusable="false"` 係必要 —— IE / 舊 Edge 會令 `<svg>` 入 tab order。
- icon-only 按鈕必須有 `aria-label` 或 `title`（**`title` 唔夠，screen reader 支援不一**）。
- Touch target：mobile（≤639px）`min-height: 44px; min-width: 44px`（spec §0.3）。

**驗收方法（自動化）**

```ts
// Playwright
const btns = await page.getByRole("button").all();
for (const b of btns) {
  const name = await b.evaluate(el =>
    el.getAttribute("aria-label") || el.textContent.trim());
  expect(name, `按鈕冇 accessible name`).toBeTruthy();
}
// 檢查所有 <svg> 有 aria-hidden 或 role
// 檢查 mobile 所有 button bounding box >= 44×44
```

**反例**

- ❌ 繼續用 emoji（跨平台唔一致、唔可控色）。
- ❌ 用 icon font（`.woff` 內藏 glyph）—— 又係一個 bundled font，而且只加到一個字元，成本比 SVG 高。
- ❌ 用外部 icon library（Font Awesome / Material Icons / Lucide CDN）。
- ❌ icon-only 按鈕冇 `aria-label`。
- ❌ `<use href="https://...">`。

---

### 6. Anti-pattern 對照表（spec §1.1 明令禁止嘅 6 項）

| # | 禁止嘅做法（反例） | 應該用咩代替 | 驗收方法（自動化，零人手） |
|---|---|---|---|
| **A1** | **過量 neon**：多過 2 個高飽和強調色同時出現；`text-shadow: 0 0 20px #0ff` 大範圍發光；所有邊框都用發光色；`filter: drop-shadow` 大量使用 | **單一裝飾強調色 `--c-accent`（冷青）**，其餘色只作**語意**用途（danger / warn / safe / contested / unknown）。發光只用 `text-shadow` 喺 ≤3 個元素（品牌標題、選中區域名），半徑 ≤18px、opacity ≤.35 | ① CSS 掃描：`grep -c "text-shadow"` ≤ 5；`grep -c "drop-shadow"` ≤ 3。② 對每個畫面抽色：計算「飽和度 > 0.7 嘅像素佔比」≤ 8%。③ 截圖 + 色相直方圖，assert 主要色相 ≤ 2 個 |
| **A2** | **低對比小字**：`--fg-muted` (#6b7c96) 喺 `#0b0f16` 上（現況）對比約 3.6:1，唔夠 AA 4.5:1；`font-size: 10px` 用喺正文；`letter-spacing: 0.16em` + 10px 嘅全大寫標籤 | **正文 ≥ 13px，對比 ≥ 4.5:1；標籤 ≥ 10px 但只作非必要資訊，對比 ≥ 4.5:1；大字（≥ 18.66px bold 或 ≥ 24px）可 3:1**。`--c-text-faint` 只可以用喺**裝飾性**標籤，唔可以用喺要讀嘅資料 | ① Playwright + `axe-core`：`color-contrast` 規則 0 violation。② 自寫檢查：遍歷所有 text node，計 `contrast(getComputedStyle(el).color, 背景)`，assert ≥ 4.5（或 ≥ 3 如果 font-size ≥ 24px）。③ 檢查 `font-size < 13px` 嘅元素只可以係 label / unit |
| **A3** | **裝飾粒子遮住地圖**：全屏 canvas 粒子層（落雨、塵埃、雪）；`opacity > 0.15` 嘅全屏 noise overlay；`pointer-events: none` 但視覺上蓋住道路／zone | **紋理必須係「底紋」而非「前景」**：網格 / 掃描線 opacity ≤ 0.10；用 `mask-image` radial 令中央淡出；**任何紋理都唔可以令道路／zone 邊界／label 嘅對比下降**。粒子只可以用喺**非地圖區域**（例如 header）並且 ≤ 30 個 | ① 截圖 pixel diff：地圖區域加紋理前後嘅「邊緣銳度」（Sobel 能量）差異 ≤ 5%。② 檢查冇 `<canvas>` 喺 `.map-pane` 之上（z-index > map）。③ `grep "animation.*infinite"` 檢查有冇全屏動畫元素 |
| **A4** | **長時間大面積 blur**：`backdrop-filter: blur(40px)` 鋪滿 viewport；每個 card 一個 blur；pan/zoom 期間仍然開 blur；用 `filter: blur()` 模糊地圖 | **面積受限玻璃面板**：blur ≤ 8px、面板面積 ≤ 地圖 25%、pan/zoom 期間 `body.is-interacting` 關閉 blur 並提高不透明度至 97%、唔支援 `backdrop-filter` 時 fallback 到實色 | ① 靜態掃描：所有 `backdrop-filter` 嘅 `blur()` 值 ≤ 8px。② Playwright trace：pan 100 次後檢查 `long tasks` 冇 `backdrop-filter` 相關；`requestAnimationFrame` frame time p95 ≤ 16ms。③ 檢查 pan 期間 `getComputedStyle(panel).backdropFilter === "none"` |
| **A5** | **只有色彩分辨類別**：zone / marker / legend 只靠 `fill` 顏色分（現況 `ZONE_STYLE` 只有色）；danger level 只靠紅橙黃綠藍 | **每個類別至少 3 個非色彩 channel**：SVG `<pattern>`（紋理）＋ sprite icon（形狀）＋ `stroke-dasharray`（邊界語言）＋ danger meter 分段條（量）。**灰度之下必須仍然完全可分辨** | ① Playwright：`document.body.style.filter = "grayscale(1)"` 之後截圖，用 pixel diff 比較每對類別嘅 zone 區域，assert 差異 > threshold。② 靜態檢查：每個 zone kind 對應嘅 class 有 `fill: url(#pat-*)` **且** 對應 legend row 有 `<use href="#ic-*">`。③ `axe-core` 唔會捉到（色彩對比 ≠ 類別編碼），所以要自寫 pattern 存在性檢查 |
| **A6** | **廉價「AI dashboard」卡片堆疊**：首屏 `innerText` 46,246 字元（實測）、1320 張 chronicle 卡即時 render、每個資訊都一張圓角卡 + 陰影 + icon + 標題 + 副標題、地圖被面板壓到剩 55% 寬 | **Map-first + progressive disclosure**：地圖係主角（≥ 60% 畫面寬）；面板只喺選取時出現；列表 virtualize（只 render viewport 內）；卡片改用**切角面板 + 髮絲線**（唔用圓角 + 大陰影）；數字用 `tabular-nums` 對齊 | ① 首屏 `document.body.innerText.length` ≤ 8,000 字元（現況 46,246）。② 首屏 DOM 節點數 ≤ 2,500。③ 地圖 pane 寬度 ÷ viewport 寬度 ≥ 0.60（desktop ≥1280px）。④ Chronicle：`IntersectionObserver` 實測 mounted card 數 ≤ 60（唔係 1320）。⑤ 檢查 `border-radius > 12px` 嘅元素數 ≤ 20（切角取代圓角） |

**額外（spec §0.1 規則 8「所有 AI 特效要有功能」）**

| 檢查 | 方法 |
|---|---|
| 每個 `@keyframes` 都有對應語意 | 靜態清單：每個 animation 名要對應 §5.2 白名單其中一項（layer fade / zone pulse / route draw / panel transition / marker hover / skeleton / danger pulse）。清單以外 = fail |
| 冇 auto-play video | `grep -rn "<video" src/` → 0 hit |
| 冇無限高速閃爍 | 所有 `infinite` animation 週期 ≥ 1.4s；冇 `animation-duration < 500ms` 配 `infinite` |
| 冇大量 JS per-frame DOM update | Playwright trace：`requestAnimationFrame` callback 內冇 `createElement` / `appendChild` / `setAttribute` 於 > 10 個節點 |

---

### 7. 分級總表

| 級別 | 項目 | 對應差距 | 交付位置 |
|---|---|---|---|
| **P0** | P0-1 玻璃儀器面板（面積受限） | G2、G3 | §2 |
| **P0** | P0-2 戰術網格 + 掃描線底紋 | G2 | §2 |
| **P0** | P0-3 Zone polygon pattern 五型（SVG `<pattern>`） | **G1、G4** | §2 |
| **P0** | P0-4 未知區 Fog | G1、G4 | §2 |
| **P0** | P0-5 Legend 三重編碼 | **G4** | §2 |
| **P0** | Token 系統（color / spacing / radius / shadow / z-index / motion）＋ `theme-tokens.ts` parity | G2、G3、G9 | §3 |
| **P1** | P1-6 Hover reticle + selected beacon | G2 | §2 |
| **P1** | P1-7 危險區低頻呼吸光 | G6 | §2 |
| **P1** | P1-8 倖存區穩定 beacon | G6 | §2 |
| **P1** | P1-9 Route pulse / draw-on | G6 | §2 |
| **P1** | P1-10 Layer cross-fade | G5 | §2 |
| **P1** | reduced-motion 逐 pattern 處理（取代全域 kill） | **G6** | §3.2 |
| **P1** | 字體策略（系統 stack + 可選拉丁 subset） | — | §4 |
| **P1** | SVG sprite icon 取代 emoji | **G7** | §5 |
| **P2** | P2-11 Loading skeleton / data stream | G5 | §2 |
| **P2** | P2-12 危險度編碼（非色彩） | G4 | §2 |
| **P2** | Anti-pattern 自動驗收清單（6 項） | 全部 | §6 |
| **P2** | Mobile touch-first（44×44、bottom sheet、safe-area） | **G8** | §2（mobile 段）＋ demo |

---

## 修改檔案

**本次任務只新增以下檔案，冇改動任何 production code。**

| 檔案 | 性質 | 說明 |
|---|---|---|
| `docs/audits/design-reference-patterns.md` | 新增（交付） | 本檔 |
| `artifacts/audit-A10/pattern-demo.html` | 新增（artifact） | 12 個 pattern 嘅可運作原型，**零外部依賴**，`file://` 可開 |
| `artifacts/audit-A10/capture-demo.mjs` | 新增（artifact） | Playwright 截圖 + 驗證 script（7 個情境） |
| `artifacts/audit-A10/shots/*.png` | 新增（artifact） | 7 張驗證截圖 |
| `artifacts/audit-A10/verify-output.json` | 新增（artifact） | `capture-demo.mjs` 嘅機器可讀輸出 |

---

## 沒有修改但相關的檔案

| 檔案 | 為何相關 | 建議 owner |
|---|---|---|
| `src/styles/main.css`（2047 行） | 含「現代檔案館」層 + Phase L HUD 層 + light theme；**1496–2047 同 `hud.css` 逐字重複** | B1（重寫 / 刪除重複段） |
| `src/styles/hud.css`（785 行） | 同 main.css 重複；**584–679 同 690–785 逐字重複兩次** | B1（合併入 tokens + 元件層） |
| `src/theme.ts` | `systemPrefers()` 令 default 跟系統 → 同 V2 dark-first 定位衝突；`basemap-theme-change` 事件機制要保留 | B1 / B2 |
| `src/components/SvgMap.ts`（1646 行） | `ZONE_STYLE` 只有色（G4）；zone chapter gate（G1）；`setScaled()` 逐元素改 stroke-width（可用 `vector-effect` 取代） | B5 / B6 |
| `src/map/VectorBasemap.ts`（935 行） | 訂閱 `basemap-theme-change`；需要接 `MAP_PALETTE` | B5 |
| `src/app.ts` | nav emoji（G7）；`initTheme` 邏輯 | B1 / B2 |
| `data/public/map-config.json` | 已過時（`renderer:"svg"` 但實際係 Canvas）；`provisional_mode.banner` 含「仍待人工審閱」違反零人手規則 | B4 |
| `public/assets/ui/`、`markers/`、`generated/`、`map-tiles/` | **空目錄** —— 可以放 `icons.svg`（但建議 inline sprite 而非外部檔） | B1 |
| `public/assets/map-lod/`（28 MB）、`hk-basemap.png`（1.9 MB）、`hk-basemap-labels.png`（132 KB） | 死重，完全冇 runtime 請求（baseline §7） | 主代理（legacy cleanup） |
| `index.html` | 冇任何外部 `<link>` —— **要保住** | B1 |
| `src/styles/timeline.css`（430 行） | 未詳讀；可能有同 main.css 重複嘅 token 定義 | B1 |

---

## 驗證命令與結果

### V1 — Pattern demo 零外部依賴 + 零 console error

```bash
node artifacts/audit-A10/capture-demo.mjs
```

**結果**：7 個情境全部 `external: []`、`errors: []`。`totalExternal = 0`、`totalErrors = 0`，exit code 0。

| 情境 | viewport | DPR | reducedMotion | external | errors |
|---|---|---|---|---|---|
| `demo-desktop-1440-dark` | 1440×900 | 1 | no-preference | **0** | **0** |
| `demo-desktop-1440-light` | 1440×900 | 1 | no-preference | **0** | **0** |
| `demo-desktop-1440-grayscale` | 1440×900 | 1 | no-preference | **0** | **0** |
| `demo-desktop-1440-dpr2` | 1440×900 | **2** | no-preference | **0** | **0** |
| `demo-mobile-390` | 390×844 | 1 | no-preference | **0** | **0** |
| `demo-desktop-1440-reduced-motion` | 1440×900 | 1 | **reduce** | **0** | **0** |
| `demo-desktop-1440-layer-off` | 1440×900 | 1 | no-preference | **0** | **0** |

→ **證明所有 12 個 pattern 可以完全本機實現，零 online asset dependency。**

### V2 — reduced-motion 行為正確（唔會「跳終態」）

| 指標 | no-preference | **reduce** | 判斷 |
|---|---|---|---|
| `danger-breath` animationName | `danger-breath` | **`none`** | ✅ 動畫停 |
| `.zone-glow` stroke-opacity | 0.359（動態中） | **0.28（靜態）** | ✅ **仍然可見**（唔係 0） |
| `beacon-ping` animationName | `beacon-ping` | **`none`** | ✅ 動畫停 |
| `.beacon-ping` opacity | 0.008（擴散中） | **0.55（靜態）** | ✅ **仍然可見**（唔係 0） |

→ 對比現況 `animation-duration: 0.001ms !important`：現況會令 `.zone-scan` 跳到終態 `opacity: 0`（zone 光環完全消失）。**本方案正確。**

### V3 — 非色彩編碼（灰度驗證）

`demo-desktop-1440-grayscale.png`（`filter: grayscale(1)`）：

5 種 zone 類型**全部仍然可分辨**：
- 倖存區 → 方格紋（`pat-survivor-grid`）
- 病窩 → 45° 斜線紋（`pat-nest-hatch`）
- 隔離區 → -45° 斜帶（`pat-quarantine`）
- 爭議地帶 → 同心圓（`pat-contested`）
- 未知區 → 噪點（`pat-unknown-noise`）

Legend 6 行亦全部可分辨（swatch 紋理 + icon 形狀 + danger meter 段數）。

→ **滿足 spec §2.4「legend 必須同時用 color、pattern、icon／shape」。**

### V4 — A11y 基本檢查（demo 內）

| 指標 | 值 | 判斷 |
|---|---|---|
| `buttonsWithoutName`（無 `aria-label` 且無文字） | **0** | ✅ |
| `iconUseCount`（`<use href="#ic-*">`） | 19 | ✅ sprite 生效 |
| `legendCount` | 6 | ✅ |
| `zonesRendered` | 5（5 種類型各一） | ✅ |

### V5 — 靜態掃描：現況冇外部 asset

```bash
grep -rn "https\?://" index.html src/styles/ src/theme.ts
```

**結果**：0 hit（`index.html` 冇任何 `<link>`；CSS 冇 `@import url(http…)`）。
→ 現況已達成「地圖完全本機」（spec §0.1 規則 4）。**V2 必須保住。**

### V6 — Zone visibility gate 實測（G1 精確證據）

```bash
python -c "
import json
d=json.load(open('data/public/zones.geojson',encoding='utf-8'))
feats=d['features']
kinds={}
for f in feats: kinds[f['properties']['kind']]=kinds.get(f['properties']['kind'],0)+1
print('total',len(feats),kinds)
for f in feats:
    p=f['properties']; ch=p.get('chapters') or []
    if any(c<=13 for c in ch):
        ring=f['geometry']['coordinates'][0]
        xs=[c[0] for c in ring]; ys=[c[1] for c in ring]
        print(p['id'],p['kind'],[c for c in ch if c<=13],
              'lon',round(min(xs),3),round(max(xs),3),
              'lat',round(min(ys),3),round(max(ys),3),'r_m',p.get('radius_m'))
"
```

**結果**：

```
total 48 {'survivor': 11, 'nest': 21, 'outpost': 16}
zone_d3f76d3c94 survivor [1..13] lon 114.25 114.257 lat 22.303 22.309 r_m 372.1
zone_51bf7d8190 nest     [2..10]  lon 114.262 114.272 lat 22.31 22.324  r_m 800.0
zone_50501d2eaf outpost  [12]     lon 114.251 114.256 lat 22.303 22.308 r_m 260.0
```

配合 `SvgMap.ts:1204` 嘅 gate（`c <= cur && cur <= c + 12`）：
- chapter = 1 → 只有 `zone_d3f76d3c94` 符合（只有佢有 chapter 1）。
- 該 zone bbox 0.007° × 0.006°，佔初始 viewBox（0.7° × 0.5407°）約 **1.0% × 1.1%** → 1060×752 canvas 上約 **10 × 8 px**。
- → **48 個 zone 之中，首屏實際可見 = 1 個 10px 嘅點。** 證實 G1。

---

## Screenshots / Artifacts

```
artifacts/audit-A10/
  pattern-demo.html                      ← 12 個 pattern 可運作原型（純本機）
  capture-demo.mjs                       ← Playwright 驗證 script
  verify-output.json                     ← 機器可讀驗證結果
  shots/
    demo-desktop-1440-dark.png           ← 主參考圖：dark tactical HUD + 5 種 zone pattern
    demo-desktop-1440-light.png          ← light token 對照
    demo-desktop-1440-grayscale.png      ← ★ 非色彩編碼驗證（5 型全部可分辨）
    demo-desktop-1440-dpr2.png           ← HiDPI 1x/2x 驗證
    demo-mobile-390.png                  ← mobile touch-first（icon-only nav 44px + bottom sheet）
    demo-desktop-1440-reduced-motion.png ← ★ reduced-motion 驗證（動畫停、元素仍在）
    demo-desktop-1440-layer-off.png      ← layer cross-fade 中間態
```

**建議主代理將以下兩張納入 Gate 1 視覺 spec 嘅參考基準**：
- `demo-desktop-1440-dark.png` —— 作為 V2 視覺方向嘅**最低標準**（唔係最終設計，係「方向正確」嘅證明）。
- `demo-desktop-1440-grayscale.png` —— 作為 spec §2.4「legend 唔可以只靠色」嘅**驗收基準**。

---

## 風險、衝突、限制

### R1 — 本報告只係「pattern 參考」，唔係 V2 最終視覺設計

本檔提供**可本機實現嘅 pattern 庫 + token 系統**，但**唔係** V2 嘅 final visual spec。實際嘅版面、資訊層級、動效節奏仍然要由 A1（Product/UX）、A2（Visual/Motion）、A7（Mobile/A11y）嘅 audit 交叉合成，再由 Gate 1 決定。**唔可以**將本檔嘅 demo 直接當成 V2 成品。

### R2 — Demo 用嘅係示意幾何，唔係真實資料

`pattern-demo.html` 嘅 5 個 zone polygon 係**手砌示意形狀**，唔係 `zones.geojson` 嘅真實幾何。真實資料嘅 zone 形狀可能係「凸包 + 200m 外擴」或者「48 邊形近似圓」（`SvgMap.ts:1164-1167` 註解說明）。**Pattern 適用性已驗證，但視覺效果喺真實幾何上要重新確認。**

### R3 — `vector-effect: non-scaling-stroke` 同 `stroke-dasharray` 嘅互動

`vector-effect: non-scaling-stroke` 令 `stroke-width` 固定為屏幕像素，但 `stroke-dasharray` **仍然係 viewBox 單位**。所以 zoom 時虛線密度會變（放大 → 虛線變疏）。如果虛線密度係語意（例如「估算範圍」），需要同 `patternTransform` 一樣每次 zoom 更新 `stroke-dasharray`。**呢點喺 demo 未完全處理，B5 要留意。**

### R4 — SVG `<pattern>` 喺 Safari 嘅已知差異

Safari 對 `patternUnits="userSpaceOnUse"` + 動態 `patternTransform` 嘅更新有延遲（需要強制 reflow）。建議 B5 喺更新 `patternTransform` 之後 `void el.getBoundingClientRect()` 一次。**未實測（本機只有 Chromium）。**

### R5 — `backdrop-filter` 喺 pan/zoom 期間嘅關閉策略需要協調

`body.is-interacting` class 由地圖手勢 controller 加／移。呢個涉及 B5（renderer）同 B6（interaction）嘅邊界。建議由 B6 擁有呢個 class，B1 只定義 CSS 規則。**需要主代理喺 file ownership map 明確。**

### R6 — 字體 Layer 2（拉丁 subset）需要授權審查

如果 B1 決定 bundle 一個拉丁數字字體，需要：① 只選 SIL OFL / Apache 2.0；② 記錄字體名、版本、來源、SHA-256 落 `docs/`；③ 唔可以係「某個網站下載嘅 free font」（來源不可稽核）。**本報告唔指定具體字體，只提供方法。**

### R7 — 現況 `theme.ts` 改動有回歸風險

建議嘅「default 永遠 dark」改動（§3.3）會改變所有現有測試／截圖嘅預期。如果 C1–C8 有依賴 light theme 嘅測試，會 fail。**需要主代理喺 Gate 1 明確：V2 係 dark-first，light 係 opt-in。** 呢個係產品決定，唔係技術決定。

### R8 — 未驗證：Firefox / Safari / 真實 mobile device

本機只有 Chromium 1.62.1。`color-mix()`、`mask-image`、`backdrop-filter`、`clip-path`、`patternTransform` 喺 Firefox / Safari 嘅行為未實測。**建議 B9（Visual QA）加 Firefox 跑一次同樣嘅 demo。**

### R9 — 效能數字係「定性」而非「定量」

本報告嘅效能描述基於機制分析（compositor vs paint vs layout），**冇做實測 profiling**。實際 frame time / GPU 記憶體需要 B9 用 Playwright trace + Chrome DevTools Performance 量化。**建議將「pan 100 次後 frame time p95 ≤ 16ms」列為 B9 嘅驗收指標。**

### R10 — 冇建議「人手覆核」／「人手選圖」

本報告全部驗收方法都係可重跑 script（Playwright / grep / pixel diff / 靜態掃描）。**零人手參與**（AGENTS.md + spec §0.1 規則 1）。

### 限制

- **冇改動任何 production code / data / config**（符合任務硬性限制）。
- **冇讀取 `data/private/`**。
- **冇任何 git 寫操作**。
- **冇引入任何 online asset dependency**（實測 `external = 0`）。
- **冇建議「人手覆核」「人手選圖」**。

---

## 給主代理的 integration note

### 1. 最重要嘅三個決定（建議喺 Gate 1 明確）

**決定 1 — V2 係 dark-first，唔跟系統偏好。**

現況 `theme.ts:31` `systemPrefers()` 令 default 跟系統，實測走咗 light 羊皮紙（同 spec §1.1 完全相反）。建議改為 default 永遠 `dark`，light 係用戶主動 opt-in。呢個係**產品定位決定**，影響所有截圖基準同視覺測試預期，必須由主代理落決定，唔應該留畀 B1。

**決定 2 — Territory 層要脫離 chapter gate，變成常駐世界層。**

實測 G1：chapter 1 時 48 個 zone 只有 1 個 eligible，而且只佔畫面 1%（約 10px）。`SvgMap.ts:1204` 嘅 `c <= cur && cur <= c + 12` gate 令「世界地圖」實際上係「單章視圖」。建議：**zone 層永遠顯示全部 48 個**（用 opacity / 密度分級表示「本章活躍 vs 非本章」），chapter 只用嚟**強調**而唔係**過濾**。呢個直接對應 spec §1.2 原則 3「地圖係可讀世界，不只係 marker 畫布」。

**決定 3 — Legend / zone 編碼必須多 channel。**

spec §2.4 明寫「legend 必須同時用 color、pattern、icon／shape」。現況 `ZONE_STYLE`（`SvgMap.ts:1168-1193`）只有色。本報告 §2 嘅 P0-3 + P0-5 提供完整可貼用方案（5 個 SVG `<pattern>` + sprite icon + danger meter）。建議列為 **P0 硬性要求**，並用 §6 嘅 A5 驗收方法（灰度 pixel diff）自動驗證。

### 2. File ownership 建議（避免多代理改同一檔）

| 交付 | 建議 owner | 可寫範圍 |
|---|---|---|
| Token 系統（CSS custom properties + `theme-tokens.ts` + parity test） | **B1** | `src/styles/tokens.css`（新）、`src/theme-tokens.ts`（新）、`src/theme.ts`、`tests/theme-token-parity.test.ts` |
| SVG sprite icon + 取代 emoji | **B1** | `src/ui/icons.ts`（新）、`src/styles/*.css`、`src/app.ts` 嘅 nav HTML |
| Zone pattern 渲染（`<pattern>` defs + zone path fill） | **B5** | `src/components/SvgMap.ts` 或 `src/map/ZoneLayer.ts`（新） |
| `body.is-interacting`（pan/zoom 關 blur） | **B6** | 地圖手勢 controller |
| Legend 三重編碼 DOM | **B6** | legend component |
| reduced-motion 逐 pattern 處理 | **B1** | `src/styles/tokens.css`（集中一處，唔好散落） |
| 刪除 `main.css` / `hud.css` 重複段 | **主代理**（Gate 2 legacy cleanup） | — |
| 刪除 `map-lod/` 28 MB + `hk-basemap*.png` 2 MB 死重 | **主代理** | — |

**⚠️ 衝突點**：`src/styles/main.css` 同 `src/styles/hud.css` 係 B1 想重寫嘅檔，但同時 `SvgMap.ts` / `ChronicleView.ts` 可能有依賴嘅 class。建議 **B1 只新增 `tokens.css`，唔改 `main.css` / `hud.css`**；重複段嘅刪除由主代理喺 Gate 2 統一處理。呢個避免多代理同時改同一份 CSS。

### 3. 立即可用嘅 artifact

- `artifacts/audit-A10/pattern-demo.html` —— 可以**直接開喺瀏覽器**（`file://`）畀主代理 / C2（Visual Quality Critic）/ C7（Accessibility Auditor）參考。**零外部依賴**，唔需要 server。
- `artifacts/audit-A10/shots/demo-desktop-1440-grayscale.png` —— 可以**直接做 spec §2.4 legend 驗收嘅視覺基準**。
- `artifacts/audit-A10/capture-demo.mjs` —— 可以**直接改成 B9 嘅 visual regression script**（改 demo URL 做 preview server URL 即可）。

### 4. 建議主代理喺 Gate 1 寫入 `world-atlas-v2-visual-motion-system.md` 嘅內容

1. **Token 表**（本檔 §3.1）—— 直接採用，或作為 baseline 再調整。
2. **Motion 白名單**（本檔 §3.1 尾）—— 只有 7 類 state 可以動，其他一律唔准。
3. **Reduced-motion 規則** —— 明確禁止 `animation-duration: 0.001ms !important`，要求逐 pattern 指定靜態終態。
4. **非色彩編碼要求** —— 每個類別 ≥ 3 個 channel（色 + pattern + icon/shape），灰度必須可分辨。
5. **Anti-pattern 6 項 + 自動驗收方法**（本檔 §6）—— 建議直接列為 C2 / C7 嘅檢查清單。

### 5. 需要主代理裁決嘅未決問題

| # | 問題 | 為何需要主代理決定 |
|---|---|---|
| Q1 | 要唔要 bundle 一個拉丁數字字體（Layer 2）？ | 涉及 12 KB bundle 增長 + 授權審查；純產品／法務決定 |
| Q2 | light theme 要唔要保留？ | 如果保留，要為 5 種 zone pattern + legend 各做一套 light 色階（本檔已提供，但要驗證對比） |
| Q3 | Zone layer 係「全部顯示」定「本章活躍優先」？ | 涉及 §5.1 state contract 同 data adapter（B3）嘅 selector 設計 |
| Q4 | `map-lod/` 28 MB raster 要唔要徹底刪？ | spec §2.3 要求「high-resolution atmospheric raster 僅作 texture，採 tile pyramid」，但 baseline 實測完全冇 runtime 請求 → 可能係完全未接駁嘅死重 |
| Q5 | 現況 `main.css` 3262 行要 rewrite 定 incremental？ | spec §0.1 規則 5「現有 code 唔係真相」→ 傾向 rewrite；但要評估 ChronicleView / StoryPanel 嘅 class 依賴面 |

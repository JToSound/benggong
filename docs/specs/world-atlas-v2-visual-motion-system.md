# World Atlas V2 — Visual & Motion System

> **Gate 1 交付物 4／8** · 狀態：**定稿**
> 依據：spec §1.1、§5.2、§5.4；A2（視覺/動效審計）、A10（design pattern 綜合）

---

## 1. 核心裁定

### 1.1 問題定性（A2 實測）

唔係「設計唔夠靚」，而係三個結構問題：

| # | 結構問題 | 實測證據 |
|---|---|---|
| S1 | **五套互斥顏色權威並存** | `--accent-*`（legacy 7 色）、`--hud-*`（7 色）、`--color-*`（12 個**從未定義**嘅死 token）、`PALETTE_DARK/LIGHT`（canvas）、TS inline 61 個 distinct hex |
| S2 | **Tactical HUD 語言冇被採用** | `--hud-cyan` 全頁只用於 **2 個元素**；實際主導係 legacy `--accent-teal`（1214 元素）/ `--accent-blue`（1320 元素） |
| S3 | **冇 LOD / 尺度策略** | 預設 viewBox 0.7° ≈ 78 km vs zone 半徑中位數 260 m → 預設視圖 zone polygon 實測 **10×10 px** |

**結論**：**確立單一 dark-first token 語言 → 令 territory 成為常駐世界層 → 用 pattern/icon/形狀做非色彩冗餘編碼 → motion 收斂成有語意嘅少量動效。**

### 1.2 唔可以誤刪嘅正面發現（A2）

| 項 | 實測 | 裁定 |
|---|---|---|
| Zoom 清晰度 | max zoom（0.02°）向量重繪，**無 pixelation** | **唔需要換 renderer** |
| Reduced-motion CSS 層 | duration 由 0.52 s → 1e-06 s（有效） | 唔需要重寫 CSS 減動效規則；只需補 JS 層 + 改為目的導向 |
| Glass blur | 最大 5.4% 面積（desktop） | **冇**違反「長時間大面積 blur」；毋須刪 `backdrop-filter` |
| Canvas rAF | `scheduleDraw()` 係需求驅動 | **冇 GPU 空轉** |

---

## 2. Design Token（唯一定義處）

> **規則 T1**：`src/styles/tokens.css` 係**唯一** token 定義檔。任何其他地方出現 raw hex **唔可以**用於 UI 顏色。
> **規則 T2**：Canvas palette **必須**由 token 讀取（mirror 於 `src/theme-tokens.ts`），唔可以自己持有色值。
> **規則 T3**：SVG 顏色用 CSS class，**唔可以** `setAttribute("fill", "#…")`。
> **規則 T4**：CI gate 加 stylelint `color-no-hex`（只准 `tokens.css` 例外）。

### 2.1 Color（dark 為預設）

| Token | dark | light | 用途 |
|---|---|---|---|
| `--bg-base` | `#0b0f14` | `#f5f2ec` | 頁面底 |
| `--bg-surface` | `#121820` | `#ffffff` | 面板 |
| `--bg-elevated` | `#1a2230` | `#faf8f4` | 卡片／浮層 |
| `--bg-overlay` | `rgba(6,10,14,.72)` | `rgba(20,24,28,.48)` | 遮罩 |
| `--border-subtle` | `#232c3a` | `#e2ddd3` | 分隔 |
| `--border-strong` | `#33404f` | `#c8c1b4` | 強調邊 |
| `--text-primary` | `#e8eef5` | `#1b1f26` | 主文字 |
| `--text-secondary` | `#9fb0c2` | `#4a525e` | 次文字 |
| `--text-muted` | `#6b7c8f` | `#6e7681` | 輔助（**仍須 ≥4.5:1**） |
| `--text-inverse` | `#0b0f14` | `#f5f2ec` | 反色 |
| `--accent` | `#4fd1c5` | `#0f7f9c` | 品牌／主要互動 |
| `--accent-strong` | `#38e8ff` | `#0a6b85` | 高亮 |
| `--danger` | `#e5484d` | `#c62a2f` | 危險／病窩 |
| `--danger-soft` | `#7f2c30` | `#f3d6d6` | 危險淡色 |
| `--safe` | `#3fb950` | `#1f7a33` | 安全／倖存區 |
| `--warn` | `#d9a341` | `#8a6414` | 警示／隔離 |
| `--unknown` | `#7c8794` | `#8a8f98` | 未知區 |
| `--focus-ring` | `#7dd3fc` | `#0b5f80` | focus（**唔可以被 clip**） |

**5 類 zone 語意色**（同時有 pattern，見 §4）：

| zone_type | 色 token | 值（dark） |
|---|---|---|
| `survivor_zone` | `--zone-survivor` | `#3fb950` |
| `infected_nest` | `--zone-nest` | `#e5484d` |
| `quarantine` | `--zone-quarantine` | `#d9a341` |
| `contested` | `--zone-contested` | `#a86bd6` |
| `unknown` | `--zone-unknown` | `#7c8794` |

### 2.2 Spacing / Radius / Shadow / z-index

```css
--sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
--sp-6: 24px; --sp-8: 32px; --sp-12: 48px;

--radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px; --radius-pill: 999px;

--shadow-low:    0 1px 2px rgba(0,0,0,.32);
--shadow-medium: 0 4px 12px rgba(0,0,0,.36);
--shadow-high:   0 12px 32px rgba(0,0,0,.44);

--z-map: 0; --z-map-overlay: 10; --z-controls: 20;
--z-panel: 30; --z-header: 40; --z-sheet: 50; --z-modal: 60; --z-toast: 70;
```

### 2.3 Motion token

```css
--dur-fast:   120ms;   /* hover / press / micro feedback */
--dur-normal: 220ms;   /* layer toggle / panel / selection */
--dur-slow:   420ms;   /* fly-to / route draw / sheet snap */

--ease-standard: cubic-bezier(.2,0,0,1);      /* 進入、狀態切換 */
--ease-emphasis: cubic-bezier(.3,0,0,1.1);    /* 強調（少量使用） */
```

> **規則 M1**：只准 3 個 duration + 2 條 easing。現況 **19 個唔同 duration**（30–520 ms）+ 3 條 bezier + 7 `ease` + 8 `ease-out` 必須收斂。
> **規則 M2**：`src/motion.ts` 係 CSS 同 JS **共用**嘅唯一動效入口。
> **規則 M3**：11 個 `@keyframes` 之中只有 3 個真正運行 → 其餘 8 個刪除。

---

## 3. Canvas / CSS 主題同步（保留現有機制）

現有 `theme.ts` 派發 `basemap-theme-change` 事件（canvas 唔會讀 CSS 變數）—— **保留**，並擴展：

```
src/theme-tokens.ts   // 由 tokens.css 手動 mirror 嘅 TS 常數（PALETTE_DARK / PALETTE_LIGHT）
tests/theme-token-parity.test.ts  // 斷言 mirror 同 CSS 完全一致（防止漂移）
```

`VectorBasemap` 只可以讀 `theme-tokens.ts`，**唔可以**再自己定義 `PALETTE_*`（A2 S1）。

---

## 4. Zone 圖層視覺語言（spec §5.4，硬性）

| 類型 | fill | pattern | icon / shape | 動效 | 互動 |
|---|---|---|---|---|---|
| **倖存區** | `--zone-survivor` @ 12% | `solid` + 內描邊 | 盾形 badge | 低頻 beacon（2.4 s，opacity 0.7↔1.0） | click → dossier |
| **病窩** | `--zone-nest` @ 16% | `hatch`（45° 斜線，8px） | 三尖叉 | 低頻呼吸紅光（3.6 s，**低幅度**） | click → 威脅特徵 |
| **隔離區** | `--zone-quarantine` @ 12% | `contour`（同心） | gate icon | 無（靜態） | click → 進出／風險 |
| **爭議地帶** | 雙色 @ 12% | `broken-boundary` | 雙箭頭 | 無 | click → 不確定性 |
| **未知區** | `--zone-unknown` @ 8% | `fog`（noise 低對比） | `?` marker | 極慢 drift（**可關**） | click → 「資料不足」 |

> **規則 Z1**：pattern **必須**用 SVG `<pattern>` 或 CSS `repeating-linear-gradient` 實現（**唔可以**用 raster texture），確保任何 zoom 下清晰。
> **規則 Z2**：legend **必須** color + pattern + icon 三通道（spec §2.4）。
> **規則 Z3**：`outpost`（16/48 = 33%）**必須**入 legend —— 現況完全冇（A2 P0-3）。
> **規則 Z4**：**唔可以**只靠色分辨類別。驗收：灰度 pixel diff（C2/C7）。

---

## 5. Motion 用途白名單（spec §5.2，封閉清單）

| # | 用途 | duration | easing | reduced-motion fallback |
|---|---|---|---|---|
| 1 | map layer fade / cross-fade | `normal` | standard | 直接切換（無 fade） |
| 2 | selected zone outline pulse | `slow` | standard | 靜態 outline（**唔可以** `animation-duration: 0.001ms` —— 會跳終態令光環消失，A10 實測） |
| 3 | route drawing / focus transition | `slow` | emphasis | 直接顯示完整 route |
| 4 | panel / bottom sheet transition | `normal` | standard | 即時顯示／隱藏 |
| 5 | marker hover / selection | `fast` | standard | 保留（屬 micro feedback，可接受） |
| 6 | loading skeleton / data stream | `slow` loop | linear | 靜態佔位 |
| 7 | danger zone low-amplitude pulse | `slow` loop | standard | 靜態 hatch |

> **規則 M4**：**禁止** auto-playing video、無限高速閃爍、大量 JS per-frame DOM update。
> **規則 M5**：任何**唔喺**上表白名單嘅動效，一律唔准加。

---

## 6. Reduced Motion（CSS + JS 雙層）

**現況**：CSS 層有效（0.52 s → 1e-06 s），但 **JS 層繞過** —— 實測 `reduce` 模式下 rAF `viewBox` 仍有 **11 個相異值**、smooth scroll **57 個**，同 `no-preference` **完全一樣**（A7 P1）。

**V2 契約**：

```ts
// src/motion.ts
export const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function animateViewport(from: Viewport, to: Viewport, dur: number): void {
  if (prefersReducedMotion()) { applyViewport(to); return; }   // 直接跳
  /* …rAF 插值… */
}
```

```css
@media (prefers-reduced-motion: reduce) {
  /* 關閉非必要 transform / pulse / particle animation；
     但唔可以用 animation-duration:0.001ms 強制跳終態 */
  *, *::before, *::after {
    animation-iteration-count: 1 !important;
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
  /* 例外：需要保留終態可見性嘅元素改為靜態樣式，而非壓縮 duration */
  .zone-outline--selected { animation: none; stroke-opacity: 1; }
}
```

**驗收（C7）**：以 `reducedMotion: 'reduce'` 開 context，斷言 rAF `viewBox` 值序列長度 ≤2（即無插值）、`scroll-behavior` 為 `auto`。

---

## 7. Icon / Font 策略

### 7.1 Icon

**現況問題（A10）**：nav 用 emoji（📜 🔍 🔗 ⬇ ☀️ ?）—— 跨平台不一致、唔可以控色／尺寸、a11y 讀法不一致、3 個冇文字標籤。

**V2**：本機 **SVG sprite**（`src/ui/icons.ts`），24×24 viewBox、`currentColor`、`<symbol>` + `<use>`。
必須：`aria-hidden="true"` + 相鄰可見文字標籤（或 `aria-label`）。**零外部 icon library。**

### 7.2 Font

**現況**：純系統 stack、零 bundled font（實測）。

**V2 策略**：
1. **維持純系統 stack**（中文網路字體體積不可接受；AGENTS.md 要求完全離線）。
2. 拉丁／數字可選 subset（`unicode-range` + `font-display: swap`），**只有**在確實需要時才 bundle。
3. **硬性**：文字最小 12px；正文 14–16px。現況 **78.4% 文字 ≤11px**、最差 9px @ 2.19:1（A2 P0-5）→ 必須修。
4. 所有文字對比 ≥4.5:1（正常）／≥3:1（≥18.66px bold 或 ≥24px）。

---

## 8. Anti-pattern 對照表（spec §1.1，逐項）

| 禁止項 | 現況（A2 實測） | V2 替代 | 自動驗收 |
|---|---|---|---|
| 過量 neon | ⚠️ 部分：`--hud-cyan` 只用 2 元素；但**橙路網**係唯一高亮（明亮像素 78% 係暖色） | 單一 accent 語意化；底圖降飽和 | 顏色直方圖：任一 hue 佔比 ≤40% |
| 低對比小字 | ❌ **嚴重**：39.6% fail AA；78.4% 文字 ≤11px；最差 9px @2.19:1 | token 化 + 最小字級 + ≥4.5:1 | C7 contrast 掃描：0 違規 |
| 裝飾粒子遮住地圖 | ✅ 冇命中（noise 0、粒子 0） | 保持 | 覆蓋率量測 |
| 長時間大面積 blur | ✅ 冇命中（最大 5.4%） | 保持；blur ≤8px 且面積 ≤25% | 面積量測 |
| 只有色彩分辨類別 | ❌ **命中**：`ZONE_STYLE` 只有色 | color + pattern + icon | 灰度 pixel diff |
| 廉價 AI dashboard 卡片堆疊 | ❌ **命中**：1320 張 `<article>`（327×115、radius 8px、統一 `--bg-elevated`） | virtualization + 分層視覺節奏 | DOM 計數 + 視覺 rubric |

---

## 9. 驗收（C2 / C7 用）

| 項 | 門檻 | 方法 |
|---|---|---|
| Token 單一來源 | `tokens.css` 以外 0 個 UI raw hex | stylelint `color-no-hex` |
| Canvas palette parity | `theme-tokens.ts` ≡ `tokens.css` | vitest |
| 文字對比 | 0 違規（dark + light） | Playwright contrast 掃描（**必須過濾離屏／被遮蓋元素** —— A7 修正版方法） |
| 最小字級 | ≥12px | computed style 掃描 |
| 三通道 legend | 灰度後仍可分辨 5 類 | pixel diff |
| Motion token | 只有 3 duration + 2 easing | CSS 掃描 |
| Reduced motion | rAF viewBox 值序列 ≤2 | Playwright `reducedMotion:'reduce'` |
| Blur 面積 | ≤25% viewport | bounding box 量測 |
| Focus ring | 12 個控制項 ring 像素變化 >0 | focused/unfocused 逐像素比對（**必須先修 `clip-path`** —— A7 P0-3） |

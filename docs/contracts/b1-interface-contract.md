# B1 — Design System & Motion Interface Contract

> 子代理：**B1 Design System & Motion**
> 性質：**介面契約（先寫，後實作）**。依 `docs/specs/world-atlas-v2-visual-motion-system.md` §4.4。
> 語言：粵文。所有下游 agent（B2 / B5 / B6 / B7 / B8 / B9）**必須**先讀本檔再寫 code。

---

## 0. 一句總結

B1 提供 **唯一 token 定義處（CSS custom properties）＋ 唯一動效入口（`motion.ts`）＋ 本機 SVG sprite（`icons.ts`）**。
其他 agent **只可以讀／引用**，**唔可以**再定義任何 UI 顏色、duration、easing 或 icon。

---

## 1. B1 獨佔（Owned by B1）

以下檔案由 B1 **獨佔**，其他 agent **唔可以改**（只可以讀）：

| 檔案 | 狀態 | 說明 |
|---|---|---|
| `src/styles/tokens.css` | **新** | 全專案**唯一** token 定義處（規則 T1） |
| `src/styles/base.css` | **新** | reset + 基礎排版 + 全域 reduced-motion CSS 層 |
| `src/styles/index.css` | **新** | `@import` tokens + base（下游 import 呢個入口） |
| `src/theme-tokens.ts` | **新** | `tokens.css` 嘅 TS mirror（canvas 唔讀 CSS 變數） |
| `src/motion.ts` | **新** | CSS 同 JS **共用**嘅唯一動效入口（規則 M2） |
| `src/ui/icons.ts` | **新** | 本機 SVG sprite（取代 8 個 nav emoji） |
| `src/theme.ts` | **改寫** | dark-first 主題切換；保留 `basemap-theme-change` |
| `tests/theme-token-parity.test.ts` | **新** | 防止 token 漂移（防 5 套權威重現） |
| `tests/motion.test.ts` | **新** | reduced-motion JS 契約 |

> B1 **唔會**改 `src/styles/main.css`、`hud.css`、`timeline.css`（Gate 2 才刪）、`src/main.ts`、`src/app.ts`、`src/map/**`、`src/components/**`、`src/data/**`、`data/**`、`scripts/**`、`package.json`、`vite.config.ts`、`tsconfig.json`。

---

## 2. B1 提供嘅公開介面

### 2.1 CSS custom properties（`src/styles/tokens.css`）

所有 token 喺 `:root` 定義（**dark 為預設**），`[data-theme="light"]` 覆蓋。元件**只可以** `var(--token)`，**唔可以**寫 raw hex（規則 T1）。

#### 2.1.1 Color（dark 預設 / light opt-in）

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
| `--text-muted` | `#7d8fa3` | `#5f6873` | 輔助文字（**仍須 ≥4.5:1**） |
| `--text-inverse` | `#0b0f14` | `#f5f2ec` | 反色（用於 accent 底上） |
| `--accent` | `#4fd1c5` | `#0c6f88` | 品牌／主要互動 |
| `--accent-strong` | `#38e8ff` | `#0a6b85` | 高亮 |
| `--danger` | `#e5484d` | `#c62a2f` | 危險／病窩 |
| `--danger-soft` | `#7f2c30` | `#f3d6d6` | 危險淡色（**底**色，唔係文字色） |
| `--safe` | `#3fb950` | `#1f7a33` | 安全／倖存區 |
| `--warn` | `#d9a341` | `#8a6414` | 警示／隔離 |
| `--unknown` | `#7c8794` | `#71777f` | 未知區（**非文字色**） |
| `--focus-ring` | `#7dd3fc` | `#0b5f80` | focus（**唔可以被 `clip-path` 剪走**） |

> ⚠️ **同 spec §2.1 表有 4 個值修正**（`--text-muted` ×2、`--accent` light、`--unknown` light）：spec 原值唔符合 spec **自己**要求嘅 ≥4.5:1（文字）／≥3:1（非文字）門檻，實測數見 §5。呢 4 個修正係 B1 依「硬性對比要求」行嘅決定，**需要主代理追認**。

#### 2.1.2 Zone 語意色（5 類，spec §2.1 + §4）

| Token | dark | light | 用途 |
|---|---|---|---|
| `--zone-survivor` | `#3fb950` | `#1f7a33` | 倖存區 |
| `--zone-nest` | `#e5484d` | `#c62a2f` | 病窩 |
| `--zone-quarantine` | `#d9a341` | `#8a6414` | 隔離區 |
| `--zone-contested` | `#a86bd6` | `#7a4fa3` | 爭議地帶 |
| `--zone-unknown` | `#7c8794` | `#71777f` | 未知區 |

**Pattern 用嘅半透明 fill（spec §4 表）**：

| Token | dark | light |
|---|---|---|
| `--zone-survivor-fill` | `rgba(63,185,80,.12)` | `rgba(31,122,51,.12)` |
| `--zone-nest-fill` | `rgba(229,72,77,.16)` | `rgba(198,42,47,.16)` |
| `--zone-quarantine-fill` | `rgba(217,163,65,.12)` | `rgba(138,100,20,.12)` |
| `--zone-contested-fill` | `rgba(168,107,214,.12)` | `rgba(122,79,163,.12)` |
| `--zone-unknown-fill` | `rgba(124,135,148,.08)` | `rgba(113,119,127,.08)` |

#### 2.1.3 Spacing（7 級）

`--sp-1:4px` `--sp-2:8px` `--sp-3:12px` `--sp-4:16px` `--sp-6:24px` `--sp-8:32px` `--sp-12:48px`

#### 2.1.4 Radius

`--radius-sm:8px` `--radius-md:12px` `--radius-lg:16px` `--radius-pill:999px`

#### 2.1.5 Shadow

`--shadow-low` `--shadow-medium` `--shadow-high`（dark 用黑；light 用淡灰，由 `[data-theme="light"]` 覆蓋）

#### 2.1.6 z-index（7 級）

`--z-map:0` `--z-map-overlay:10` `--z-controls:20` `--z-panel:30` `--z-header:40` `--z-sheet:50` `--z-modal:60` `--z-toast:70`

#### 2.1.7 Motion（只准 3 duration + 2 easing，規則 M1）

`--dur-fast:120ms` `--dur-normal:220ms` `--dur-slow:420ms`
`--ease-standard:cubic-bezier(.2,0,0,1)` `--ease-emphasis:cubic-bezier(.3,0,0,1.1)`

#### 2.1.8 排版 / 紋理 / 玻璃（輔助 primitives）

| Token | 值 | 用途 |
|---|---|---|
| `--font-sans` | 系統 stack（含 `PingFang HK` / `Microsoft JhengHei`） | 正文 |
| `--font-mono` | 系統 mono stack | 讀數／code |
| `--fs-2xs` … `--fs-2xl` | 12px 起（**最小 12px**，規則見 §7.3） | 字級階梯 |
| `--lh-tight` / `--lh-normal` | 1.25 / 1.5 | 行高 |
| `--clip` / `--clip-sm` | 切角 polygon | HUD 面板（唔用圓角） |
| `--glass` / `--glass-solid` | 半透明面板底 | 面積受限玻璃 |
| `--grid-line` / `--grid-line-strong` | 低對比網格色 | 戰術網格底紋 |
| `--scanline` | 低對比掃描線色 | 面板 CRT 質感 |

> **字級下限**：`--fs-2xs:12px` 係硬下限。任何元件**唔可以** `font-size` < 12px。現況 78.4% 文字 ≤11px、最差 9px @2.19:1 —— 必須消滅。

### 2.2 `src/theme-tokens.ts` 匯出

```ts
export interface BasemapPalette { /* 同現時 VectorBasemap 嘅 BasemapPalette 同形狀 */ }
export const PALETTE_DARK: BasemapPalette;
export const PALETTE_LIGHT: BasemapPalette;
export type TokenTheme = "dark" | "light";
export const TOKEN_COLORS_DARK: Readonly<Record<string, string>>;   // CSS 變數名 → 值
export const TOKEN_COLORS_LIGHT: Readonly<Record<string, string>>;
export const MOTION_TOKENS: { durFast: 120; durNormal: 220; durSlow: 420;
  easeStandard: string; easeEmphasis: string };
```

- `TOKEN_COLORS_*` 係 `tokens.css` 嘅**手動 mirror**；`tests/theme-token-parity.test.ts` 會逐個值斷言完全一致。
- `PALETTE_DARK` / `PALETTE_LIGHT` 係 canvas 用嘅底圖配色，**值全部由 `TOKEN_COLORS_*` 派生**。

### 2.3 `src/motion.ts` 匯出

```ts
export interface Viewport { x: number; y: number; w: number; h: number }
export const DUR: { fast: number; normal: number; slow: number };      // ms，同 CSS 一致
export const EASE: { standard: string; emphasis: string };             // cubic-bezier 字串
export function prefersReducedMotion(): boolean;
export function onReducedMotionChange(cb: (reduced: boolean) => void): () => void;
export function animateViewport(
  from: Viewport, to: Viewport, dur: number,
  apply: (v: Viewport) => void, onDone?: () => void,
): void;
export function animateNumber(
  from: number, to: number, dur: number,
  apply: (n: number) => void, onDone?: () => void,
): void;
export function scrollElementTo(
  el: HTMLElement, left: number, top: number, dur: number,
): void;
export function cancelMotion(handle: MotionHandle): void;
```

**硬性契約**：
- `prefersReducedMotion()` 為 `true` → `animateViewport` / `animateNumber` **同步一次** `apply(to)`，**唔開 rAF、唔插值**（現況 bug：reduce 模式下 rAF `viewBox` 仍有 11 個相異值）。
- `scrollElementTo` **唔用** `scrollIntoView`（規則 C1：`ChapterStrip` 唔可以再 `scrollIntoView`）；reduce 時直接設 `scrollLeft` / `scrollTop`。
- 冇 `window` / `matchMedia` 環境（node）→ `prefersReducedMotion()` 回 `false`（安全默認：唔會 crash）。

### 2.4 `src/ui/icons.ts` 匯出

```ts
export const ICON_SPRITE: string;                 // 完整 <svg><defs>…</defs></svg> 字串
export const ICON_IDS: readonly string[];          // 所有可用 id（含 "ic-" 前綴）
export interface IconOptions { size?: number; label?: string; className?: string }
export function icon(id: string, opts?: IconOptions): string;   // 回 <svg><use/></svg> 字串
export function mountIconSprite(doc?: Document): void;          // 開機注入一次（idempotent）
```

- 規格：`viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`stroke-width="1.5"`、`stroke-linecap="square"`、`stroke-linejoin="miter"`。
- `icon()` 預設加 `aria-hidden="true"` + `focusable="false"`；若傳 `label` 則改為 `role="img"` + `aria-label`。
- 零外部 icon library、零 network request。

**必須存在嘅 icon id**（對應 8 個 nav emoji + zone/控制/資料）：

| 群組 | id |
|---|---|
| nav（取代 emoji） | `ic-chronicle`(📜) `ic-search`(🔍) `ic-share`(🔗) `ic-export`(⬇) `ic-theme`(☀️) `ic-help`(?) `ic-info`(關於) `ic-panel`(面板) |
| 地圖控制 | `ic-zoom-in` `ic-zoom-out` `ic-reset` `ic-layers` |
| Zone 類型 | `ic-shield` `ic-biohazard` `ic-gate` `ic-contested` `ic-unknown` |
| 資料 | `ic-route` `ic-event` `ic-location` `ic-character` `ic-chapter` |
| 通用 | `ic-close` `ic-chevron-left` `ic-chevron-right` `ic-chevron-down` `ic-external` `ic-warning` `ic-check` |

### 2.5 `src/theme.ts` 匯出（向後兼容，唔可以移除）

```ts
export type Theme = "dark" | "light";
export function currentTheme(): Theme;        // dark-first：預設 "dark"
export function setTheme(t: Theme): void;     // 設 data-theme + localStorage + 派 basemap-theme-change
export function toggleTheme(): Theme;
export function initTheme(onChange: (t: Theme) => void): void;
```

- **行為改變（breaking，spec §1.2 D1）**：預設永遠 `dark`，**唔再**跟 `prefers-color-scheme`。light 係用戶主動 opt-in + 持久化（`localStorage["binggang-theme"]`）。
- **保留**：`window.dispatchEvent(new CustomEvent("basemap-theme-change", { detail: { theme } }))`，以及喺 `<html>` 設 `data-theme`。

---

## 3. 其他 agent 應該點用

### 3.1 B2（App State & Router / `src/main.ts`）

1. **必須**喺 `src/main.ts` 最頂加：
   ```ts
   import "./styles/index.css";
   ```
   並且**移除**現時 `main.css` / `timeline.css` / `hud.css` 嘅 import（B1 唔可以改 `main.ts`，所以呢步由 B2 做）。
2. 呼叫 `mountIconSprite()` 一次（或由 `AppShell` 注入）。
3. 主題：`initTheme(...)` / `setTheme(state.theme)`；`basemap-theme-change` 會自動派發。
4. **唔可以**自己定義顏色／duration token。

### 3.2 B5（Renderer / LOD）

1. **刪除** `src/map/VectorBasemap.ts` 內部嘅 `PALETTE_DARK` / `PALETTE_LIGHT` 定義（A2 S1），改為：
   ```ts
   import { PALETTE_DARK, PALETTE_LIGHT } from "../theme-tokens";
   ```
2. `basemap-theme-change` 訂閱機制**保留**（唔可以刪）。
3. 道路由「8 階橙色」改為「煤灰主體 + 單一 `--warn` 主幹道」（anti-pattern：橙路網佔 78% 明亮像素）。

### 3.3 B6 / B7 / B8（Interaction / Chronicle / Mobile）

1. 所有顏色、間距、圓角、陰影、z-index、duration、easing **一律** `var(--…)`。
2. 所有動效**必須**喺 spec §5 白名單內，duration 用 `--dur-fast|normal|slow`，easing 用 `--ease-standard|emphasis`。
3. 所有動畫**必須**喺 `base.css` 嘅 reduced-motion 契約下保留終態（唔准用 `animation-duration:0.001ms`）。
4. Icon 用 `icons.ts`：`<svg aria-hidden="true" focusable="false"><use href="#ic-…"/></svg>`；icon-only 按鈕**必須**有 `aria-label`。
5. `ChapterStrip`：**唔可以** `scrollIntoView`；用 `motion.scrollElementTo()`（reduce 時即時跳）。
6. `Legend`：color + pattern + icon 三通道（pattern fill 用 `--zone-*-fill`）。

### 3.4 B9（Visual QA）

- 可用 `TOKEN_COLORS_*` 做自動對比掃描基準。
- reduced-motion 斷言：rAF `viewBox` 值序列長度 ≤2（B1 已提供 `motion.ts` 契約）。
- 灰階可辨：5 類 zone 用 `--zone-*-fill` + pattern，唔靠色。

---

## 4. B1 **唔會**提供嘅嘢（避免期望落空）

| 唔提供 | 原因 / 由邊個負責 |
|---|---|
| SVG `<pattern>` 定義（`pat-hatch` 等） | Zone 渲染屬 **B5/B6**；B1 只提供 pattern 用嘅 `--zone-*-fill` 色 token |
| Zone layer / legend / layer control DOM | B6 |
| `src/state/**`、URL 序列化 | B2 |
| `src/data/**` adapter / selector | B3 |
| 元件級 CSS（`.panel`、`.legend`、`.bottom-sheet`…） | 各元件 owner（B6/B7/B8）；B1 只提供 `tokens.css` + `base.css` |
| 刪除 `main.css` / `hud.css` / `timeline.css` | **主代理**（Gate 2 legacy cleanup） |
| 改 `package.json` / 加依賴（stylelint 等） | **禁止**；規則 T4 嘅 stylelint gate 由主代理決定 |
| bundled 字體檔（中文或拉丁 subset） | spec §7.2：維持純系統 stack，零 bundled font（Q1 未決，需主代理裁決） |
| 完整 light theme 元件覆蓋 | B1 只提供 light token；元件層覆蓋由各 owner 做 |

---

## 5. Token 值修正（同 spec §2.1 差異）與對比證據

實測（WCAG 2.x 相對亮度公式，`node` 計算）：

| Token | spec 值 | 實測對比（bg-base / surface / elevated） | B1 採用值 | 採用後對比 | 理由 |
|---|---|---|---|---|---|
| `--text-muted` dark | `#6b7c8f` | 4.49 / 4.17 / 3.73 ❌ | `#7d8fa3` | 5.79 / 5.38 / 4.81 ✅ | spec 自己要求 ≥4.5:1，原值喺三個表面全部 fail |
| `--text-muted` light | `#6e7681` | 4.11 / 4.59 / 4.33 ❌ | `#5f6873` | 5.06 / 5.65 / 5.33 ✅ | 同上 |
| `--accent` light | `#0f7f9c` | 4.14 / 4.63 / 4.36 ❌ | `#0c6f88` | 5.16 / 5.76 / 5.43 ✅ | accent 會做連結／互動文字色，須 ≥4.5:1 |
| `--unknown` light | `#8a8f98` | 2.91 / 3.25 / 3.06 ❌ | `#71777f` | 4.04 / 4.52 / 4.26 ✅ | 連非文字門檻 3:1 都 fail |

其餘 token **逐字採用 spec §2.1 值**。

---

## 6. 驗收（B1 自己跑）

```bash
npm run typecheck    # 0 error
npm run lint         # B1 檔案 0 error（artifacts/** 有 16 個 pre-existing error，唔屬 B1 scope）
npm run test         # 包括 tests/theme-token-parity.test.ts、tests/motion.test.ts 全綠
npm run build        # 成功（B1 未 import 自己 CSS，build 應該維持綠）
```

- Parity 測試係**防 5 套權威重現**嘅關鍵 gate：任何人改 `tokens.css` 而唔改 `theme-tokens.ts`，測試即刻 fail（零人手覆核）。

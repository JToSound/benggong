/**
 * icons.ts — 本機 SVG sprite（取代 8 個 nav emoji）。
 *
 * 為何唔用 emoji（A10 §5.2）
 * =======================
 * 1. 跨平台 render 完全唔同（Windows / macOS / Android 三個設計）。
 * 2. 彩色 emoji 用 CBDT / COLR 格式，CSS `color` 完全無效 → 對比度不可控。
 * 3. 尺寸／基線對唔齊。
 * 4. screen reader 讀法同功能唔一致（🔗 讀「link」，但功能係「複製連結」）。
 * 5. 實質係外部 render resource（系統 emoji 字體）。
 *
 * 方案：**same-document inline sprite**（唔用外部 `.svg` 檔 + `<use href="icons.svg#id">`，
 * 因為跨文件 `<use>` 喺部分引擎唔會傳 `currentColor`，而且多一個 request）。
 *
 * 設計規格（A10 §5.3）
 * ==================
 * grid 24×24、stroke 1.5、`stroke-linecap: square`、`stroke-linejoin: miter`、
 * `fill: none`、色 = `currentColor`。顯示尺寸由 CSS / `IconOptions.size` 控制。
 * **零外部 icon library。**
 */

/** 每個 icon 嘅內部幾何（唔寫色／stroke —— 由外層 `<svg>` 繼承落 `<use>`）。 */
const GEOMETRY: Readonly<Record<string, string>> = {
  /* ── 導航（取代 8 個 emoji） ────────────────────────────────────── */
  // 📜 編年史 → 卷軸／記事本
  "ic-chronicle":
    '<rect x="5" y="4" width="14" height="16" rx="1"/>' +
    '<path d="M8.5 4v16M11 8h5M11 12h5M11 16h3"/>',
  // 🔍 搜尋
  "ic-search":
    '<circle cx="10.5" cy="10.5" r="6"/>' + '<path d="M15 15 21 21"/>',
  // 🔗 複製連結
  "ic-share":
    '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5"/>' +
    '<path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5"/>',
  // ⬇ 匯出 PNG
  "ic-export":
    '<path d="M12 3v12"/>' + '<path d="M7 10l5 5 5-5"/>' + '<path d="M4 20h16"/>',
  // ☀️ / 🌙 主題切換（太陽）
  "ic-theme":
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  // ? 說明
  "ic-help":
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.24c-.7.36-1.1.9-1.1 1.76v.5"/>' +
    '<circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  // 關於（info）
  "ic-info":
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 11v6"/>' +
    '<circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none"/>',
  // 面板
  "ic-panel":
    '<rect x="3" y="4" width="18" height="16" rx="1"/>' + '<path d="M15 4v16"/>',

  /* ── 地圖控制 ──────────────────────────────────────────────────── */
  "ic-zoom-in":
    '<circle cx="10.5" cy="10.5" r="6.5"/>' +
    '<path d="M15.5 15.5 21 21"/>' +
    '<path d="M10.5 7.5v6M7.5 10.5h6"/>',
  "ic-zoom-out":
    '<circle cx="10.5" cy="10.5" r="6.5"/>' +
    '<path d="M15.5 15.5 21 21"/>' +
    '<path d="M7.5 10.5h6"/>',
  "ic-reset": '<path d="M4 12a8 8 0 1 0 2.34-5.66"/>' + '<path d="M4 5v5h5"/>',
  "ic-layers":
    '<path d="M12 3 3 8l9 5 9-5-9-5Z"/>' + '<path d="M3 13l9 5 9-5"/>',

  /* ── Zone 類型（legend 三通道用） ───────────────────────────────── */
  "ic-shield": '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z"/>',
  "ic-biohazard":
    '<circle cx="12" cy="12" r="2.2"/>' +
    '<circle cx="12" cy="5.5" r="2.6"/>' +
    '<circle cx="6.2" cy="15.8" r="2.6"/>' +
    '<circle cx="17.8" cy="15.8" r="2.6"/>',
  "ic-gate":
    '<path d="M6 4v16M18 4v16"/>' + '<path d="M6 9h12M6 13h12"/>',
  "ic-contested":
    '<path d="M4 8h13M14 5l3 3-3 3"/>' + '<path d="M20 16H7M10 13l-3 3 3 3"/>',
  "ic-unknown":
    '<circle cx="12" cy="12" r="9" stroke-dasharray="2 3"/>' +
    '<path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.24c-.7.36-1.1.9-1.1 1.76v.4"/>' +
    '<circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none"/>',

  /* ── 資料 ──────────────────────────────────────────────────────── */
  "ic-route":
    '<circle cx="6" cy="18" r="2"/>' +
    '<circle cx="18" cy="6" r="2"/>' +
    '<path d="M7.6 16.6C10 15 9 10 12 9s4-1 4.5-1.7" stroke-dasharray="3 3"/>',
  "ic-event":
    '<path d="M12 3l7 6-7 12-7-12 7-6Z"/>' + '<circle cx="12" cy="9" r="1.6"/>',
  "ic-location":
    '<path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/>' +
    '<circle cx="12" cy="10" r="2.6"/>',
  "ic-character":
    '<circle cx="12" cy="8" r="3.5"/>' +
    '<path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/>',
  "ic-chapter": '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',

  /* ── 通用 ──────────────────────────────────────────────────────── */
  "ic-close": '<path d="M5 5l14 14M19 5 5 19"/>',
  "ic-chevron-left": '<path d="M14 6l-6 6 6 6"/>',
  "ic-chevron-right": '<path d="M10 6l6 6-6 6"/>',
  "ic-chevron-down": '<path d="M6 10l6 6 6-6"/>',
  "ic-external":
    '<path d="M14 4h6v6"/>' +
    '<path d="M20 4 11 13"/>' +
    '<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  "ic-warning":
    '<path d="M12 4 2.5 20h19L12 4Z"/>' +
    '<path d="M12 10v4"/>' +
    '<circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  "ic-check": '<path d="M4 12.5 9.5 18 20 6"/>',
};

/** 所有可用 icon id（含 `ic-` 前綴）。 */
export const ICON_IDS: readonly string[] = Object.keys(GEOMETRY);

const SPRITE_ID = "ic-sprite";

function buildSprite(): string {
  const symbols = ICON_IDS.map(
    (id) => `<symbol id="${id}" viewBox="0 0 24 24">${GEOMETRY[id]}</symbol>`,
  ).join("");
  return (
    `<svg id="${SPRITE_ID}" width="0" height="0" ` +
    `aria-hidden="true" focusable="false" style="position:absolute">` +
    `<defs>${symbols}</defs></svg>`
  );
}

/** 完整 sprite 字串（`<symbol>` + `<defs>`）。 */
export const ICON_SPRITE: string = buildSprite();

export interface IconOptions {
  /** 顯示邊長（px）。預設 16。 */
  size?: number;
  /** 有值 → `role="img"` + `aria-label`；否則 `aria-hidden="true"`。 */
  label?: string;
  /** 額外 class（例如 `ic nav-ic`）。 */
  className?: string;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 產生一個 `<svg><use href="#id"/></svg>` 字串。
 *
 * - 預設 `aria-hidden="true"` + `focusable="false"`（裝飾性）。
 * - 傳 `label` → 改為 `role="img"` + `aria-label`（icon-only 按鈕用）。
 * - 未知 id → throw（程式錯誤，唔好靜默出空白）。
 */
export function icon(id: string, opts: IconOptions = {}): string {
  if (!(id in GEOMETRY)) {
    throw new Error(`未知 icon id: ${id}（可用：${ICON_IDS.join(", ")}）`);
  }
  const size = opts.size ?? 16;
  const cls = opts.className ? ` class="${escapeAttr(opts.className)}"` : "";
  const a11y = opts.label
    ? ` role="img" aria-label="${escapeAttr(opts.label)}"`
    : ` aria-hidden="true"`;
  return (
    `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linecap="square" stroke-linejoin="miter"${a11y} focusable="false">` +
    `<use href="#${id}"/></svg>`
  );
}

/**
 * 開機注入 sprite 一次（idempotent）。
 *
 * ⚠️ 唔可以改 `src/main.ts`（屬 B2）—— 由 B2 喺 bootstrap 時呼叫本函式。
 */
export function mountIconSprite(doc: Document = document): void {
  if (doc.getElementById(SPRITE_ID)) return;
  const host = doc.body ?? doc.documentElement;
  host.insertAdjacentHTML("afterbegin", ICON_SPRITE);
}

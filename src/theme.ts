/**
 * 主題切換（dark-first）。
 *
 * 設計決定（spec §1.2 D1 / world-atlas-v2-visual-motion-system.md §2）
 * ================================================================
 * 1. **預設永遠 dark** —— 唔再跟 `prefers-color-scheme`。產品定位係
 *    「末日情報指揮室」，深色係視覺方向本身，唔應該由用戶嘅 OS 設定
 *    決定第一印象（A2 P0-1：實測 default 走咗淺色羊皮紙，同定位相反）。
 * 2. **light 係用戶主動 opt-in + 持久化** —— 撳過就記住，下次開直接套用。
 * 3. **套用喺 `<html>` 而唔係 `<body>`** —— CSS 用 `[data-theme]` 選擇器；
 *    放喺 html 可以令 `:root` 變數一齊覆蓋（body 唔得）。
 *
 * ⚠️ 保留 `basemap-theme-change` 事件：canvas 唔會讀 CSS 變數，
 *    `VectorBasemap` 靠呢個事件換底圖配色（唔可以刪）。
 */

export type Theme = "dark" | "light";

/** 預設主題（dark-first，唔跟系統偏好）。 */
export const DEFAULT_THEME: Theme = "dark";

const STORAGE_KEY = "binggang-theme";

/** 用戶手動揀過嘅主題；冇揀過就 null。 */
function stored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    // 私密模式／停用 storage 會拋錯 —— 唔應該令成個 app 掛
    return null;
  }
}

export function currentTheme(): Theme {
  return stored() ?? DEFAULT_THEME;
}

function apply(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  /*
   * 通知 canvas 底圖換色。
   *
   * 為何要一個自訂事件而唔係直接呼叫：`theme.ts` 唔應該知道地圖嘅存在
   * （依賴方向係 app → theme，唔可以反向）。用事件可以令主題模組保持
   * 零依賴，同時任何需要跟主題嘅 canvas／WebGL 圖層都可以訂閱。
   *
   * ⚠️ 實測踩過：唔通知嘅話，淺色主題之下 UI 變白、文字變深，但 canvas
   * 底圖仍然係深色 —— 深色標籤配深色底，完全睇唔到。
   */
  window.dispatchEvent(
    new CustomEvent("basemap-theme-change", { detail: { theme } }),
  );
}

export function setTheme(theme: Theme): void {
  apply(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* 存唔到都唔緊要，今次 session 仍然有效 */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/**
 * 初始化：套用目前主題（dark-first），並回呼一次通知 UI。
 *
 * 回傳值唔用；呼叫方傳入更新按鈕標籤嘅函式（由 AppShell 傳入）。
 */
export function initTheme(onChange: (t: Theme) => void): void {
  const t = currentTheme();
  apply(t);
  onChange(t);
  // 註：dark-first 之下**唔**跟隨系統 light 偏好變化 —— 用戶冇揀過就永遠 dark。
}

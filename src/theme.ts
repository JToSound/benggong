/**
 * 主題切換（深色 ↔ 淺色）。
 *
 * 設計決定
 * ========
 * 1. **跟系統偏好做預設** —— 用戶未手動揀過嘅話，跟
 *    `prefers-color-scheme`。呢個係現代網頁嘅標準做法。
 * 2. **手動揀過就記住** —— 存 localStorage，下次開直接套用。
 * 3. **套用喺 `<html>` 而唔係 `<body>`** —— CSS 用 `[data-theme]`
 *    選擇器；放喺 html 可以令 `:root` 變數一齊覆蓋（body 唔得）。
 *
 * ⚠️ 為何唔用 `class`：`data-*` 屬性嘅語意更清楚（係「狀態」唔係
 *    「樣式」），而且可以同時放多個維度（例如日後加 `data-density`）。
 */

export type Theme = "dark" | "light";

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

function systemPrefers(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function currentTheme(): Theme {
  return stored() ?? systemPrefers();
}

function apply(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
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
 * 初始化：套用目前主題，並喺用戶未手動揀過時跟隨系統變化。
 *
 * 回傳一個更新按鈕標籤嘅函式（由 app.ts 傳入）。
 */
export function initTheme(onChange: (t: Theme) => void): void {
  apply(currentTheme());
  onChange(currentTheme());

  // 用戶未手動揀過 → 系統切換時跟住變
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  mq?.addEventListener?.("change", () => {
    if (stored()) return;
    apply(systemPrefers());
    onChange(currentTheme());
  });
}

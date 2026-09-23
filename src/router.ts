/**
 * ⚠️ LEGACY SHIM（deprecated）—— **唔可以刪**（migration plan §6.2）。
 *
 * 原本係一個 hash router（只支援 `#ch=` / `#loc=`）。V2 嘅 URL 契約已經搬去
 * `src/state/url.ts`（統一 query string，規則 U1–U6），state 亦已經搬去
 * `src/state/store.ts`。呢個檔淨低嘅唯一職責係**向後兼容**：
 *
 *   - `#ch=<n>`  → `?chapter=<n>`（legacy alias，`visual-smoke` 依賴）
 *   - `#loc=<id>` → `?location=<id>`
 *
 * 讀取一律經 `App` 嘅 store adapter（`app.setChapter` / `app.setSelectedLocation`），
 * 呢個檔**唔再**持有任何 state。啟動時嘅初始 hash 由 `main.ts` 嘅
 * `app.hydrateFromUrl()` 處理（嗰度亦會 canonicalize 成 query 形式）。
 *
 * 刪除屬 Gate 2 主代理嘅 legacy cleanup 範圍。
 */

import type { App } from "./app";

/**
 * @deprecated 用 `bindUrlSync(store)`（`src/state/index.ts`）處理 `popstate`；
 *             呢個 function 只保留 `hashchange` 嘅向後兼容。
 */
export function initRouter(app: App): void {
  const total = (): number => app.getChapterTotal();

  /** 由 `#ch=` / `#loc=` 抽出 legacy 值（唔會 throw）。 */
  function readHash(): { chapter: number | null; locId: string | null } {
    const h = window.location.hash;
    const chMatch = /[#&]ch=(\d+)/.exec(h);
    const locMatch = /[#&]loc=([\w-]+)/.exec(h);
    let chapter: number | null = null;
    if (chMatch) {
      const n = Number.parseInt(chMatch[1], 10);
      if (n >= 1 && n <= total()) chapter = n;
    }
    return { chapter, locId: locMatch ? locMatch[1] : null };
  }

  // 初始值由 main.ts 嘅 hydrateFromUrl() 處理；呢度只跟之後嘅 hash 變更。
  window.addEventListener("hashchange", () => {
    const { chapter, locId } = readHash();
    if (chapter !== null && chapter !== app.getCurrentChapter()) app.setChapter(chapter);
    // 只喺 hash 有 loc 時才跟隨 —— 用戶喺 UI 上取消選擇會經 store 寫 URL，
    // 唔應該再觸發一次還原。
    if (locId && locId !== app.getSelectedLocationId()) {
      app.setSelectedLocation(locId);
    }
  });
}

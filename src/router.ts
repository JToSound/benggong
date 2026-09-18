/**
 * 簡單 hash router（可分享嘅深層連結）。
 *
 * 格式：`#ch=150` 或 `#ch=150&loc=loc_0123`
 *   - `ch`  章節（1–198）
 *   - `loc` 可選：選中嘅地點 id
 *
 * 為何用 hash 而唔係 path：GitHub Pages 係靜態託管，冇 server-side
 * rewrite；用 path 嘅話直接開 `/#/ch/150` 會 404。hash 冇呢個問題。
 */

import type { App } from "./app";

export function initRouter(app: App): void {
  const total = () => app.getChapterTotal();

  function readHash(): { chapter: number; locId: string | null } {
    const h = window.location.hash;
    const chMatch = h.match(/[#&]ch=(\d+)/);
    const locMatch = h.match(/[#&]loc=([\w-]+)/);
    let chapter = 1;
    if (chMatch) {
      const n = parseInt(chMatch[1], 10);
      if (n >= 1 && n <= total()) chapter = n;
    }
    return { chapter, locId: locMatch ? locMatch[1] : null };
  }

  const initial = readHash();
  app.setChapter(initial.chapter);
  if (initial.locId) app.setSelectedLocation(initial.locId);

  window.addEventListener("hashchange", () => {
    const { chapter, locId } = readHash();
    if (chapter !== app.getCurrentChapter()) app.setChapter(chapter);
    // 只喺 hash 有 loc 時才跟隨 —— 用戶喺 UI 上取消選擇會經
    // setSelectedLocation 寫 hash，唔應該再觸發一次還原
    if (locId && locId !== app.getSelectedLocationId()) {
      app.setSelectedLocation(locId);
    }
  });
}

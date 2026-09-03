/**
 * Phase F: 簡單 hash router.
 * - 初始 load: 讀 #ch=N，唔存在就 ch=1
 * - setChapter 時自動 update hash
 */

import type { App } from "./app";

export function initRouter(app: App): void {
  function readChapterFromHash(): number {
    const m = window.location.hash.match(/^#ch=(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 198) return n;
    }
    return 1;
  }
  const initialChapter = readChapterFromHash();
  app.setChapter(initialChapter);

  window.addEventListener("hashchange", () => {
    const ch = readChapterFromHash();
    if (ch !== app.getCurrentChapter()) {
      app.setChapter(ch);
    }
  });
}

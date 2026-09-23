/**
 * ChapterStrip: 198 章節時間軸, top of page.（B8 改寫）
 *
 * ⚠️ 相對 V1 版本嘅關鍵改動（A7 P0-2 / P1-1 / P1-3）
 * ==============================================
 *
 * 1. **移除 `scrollIntoView`**（P0-2）。
 *    舊版 `updateSelection()` 對「目前章節 pill」呼叫
 *      `target.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" })`
 *    首次 render 就會令 Chromium 將 **sequential focus navigation starting
 *    point** 移到該 pill。結果：全新載入之後按 Tab，由該 pill 開始向前行，
 *    **頂欄（skip link + 8 個導覽按鈕）Tab 350 次都到唔到**。
 *    因果實驗已證：runtime 將 `scrollIntoView` 改成 no-op 之後，Tab #1
 *    就正確變返 `A.skip-link`、Tab #2 係 `BUTTON#btn-mode`。
 *
 *    修法：改用 `scrollingElement` 直接設 `scrollLeft`（規則 C1 明文要求）。
 *    仍然保留「捲到目前章節」功能（唔會失去 A7 風險 5 提到嘅 deep-link 捲動）。
 *
 * 2. **每粒 pill >= 44x44**（P1-1）。舊版喺 `@media (max-width: 639px)`
 *    刻意縮到 `30x24`，直接違反 spec §7.2 第 9 項。尺寸由 `mobile.css` 管
 *    （`!important` 蓋過 legacy `main.css`），本檔只負責語意。
 *
 * 3. **`aria-current`**（P1-3）。舊版只用 `.active` class，程式上完全冇
 *    狀態（`ariaCurrentStyledCount: 0`）。而家目前章節 pill 有
 *    `aria-current="true"`。
 *
 * 4. **`aria-live` 播報**（P1-3）。改章之後螢幕閱讀器用戶原本完全唔知
 *    發生咩事（全頁 `aria-live` = 0）。而家有一個 `role="status"` 容器。
 *
 * 5. **`aria-label` 顯示章節標題**（保留舊行為）。
 */

import type { App } from "../app";
import type { AppData } from "../data/loadAllData";
import { DUR, scrollElementTo, type MotionHandle } from "../motion";

export class ChapterStrip {
  root: HTMLElement;
  app: App;
  data: AppData;

  /** 進行中嘅捲動動效（重複呼叫要取消，避免互相打架）。 */
  private scrollMotion: MotionHandle | null = null;

  constructor(root: HTMLElement, app: App) {
    this.root = root;
    this.app = app;
    this.data = app.data;
    this.render();
    this.bindEvents();
  }

  private render(): void {
    const total = this.data.config.chapters?.total || 198;
    this.root.innerHTML = `
      <div class="chapter-strip">
        <div class="strip-track" id="strip-track" role="group" aria-label="章節時間軸">
          ${this.renderChapters()}
        </div>
        <div class="strip-info">
          <span class="strip-current">第 <strong id="strip-ch-num">${this.app.getCurrentChapter()}</strong> / ${total} 章</span>
          <span class="strip-summary" id="strip-summary"></span>
        </div>
        <!-- P1-3：改章播報（視覺上隱藏，螢幕閱讀器讀得到） -->
        <p class="a11y-live" id="strip-live" role="status" aria-live="polite"></p>
      </div>
    `;
    this.updateSelection();
  }

  private renderChapters(): string {
    const total = this.data.config.chapters?.total || 198;
    const summaries = this.data.chapterSummaries || {};
    const items: string[] = [];
    for (let ch = 1; ch <= total; ch++) {
      // Phase E: summary 係 {locations: [...]}，攞第一個 location 嘅 name
      const summaryObj = summaries[ch];
      const titleHint = summaryObj?.locations?.[0]?.name || `第 ${ch} 章`;
      items.push(
        `<button class="ch-pill" data-ch="${ch}" aria-label="第 ${ch} 章: ${this.escapeHtml(titleHint.slice(0, 30))}">${ch}</button>`,
      );
    }
    return items.join("");
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  }

  private bindEvents(): void {
    this.root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("ch-pill")) {
        const ch = parseInt(t.dataset.ch || "1", 10);
        this.app.setChapter(ch);
      }
    });
  }

  updateSelection(): void {
    const cur = this.app.getCurrentChapter();
    const pills = this.root.querySelectorAll(".ch-pill");
    pills.forEach((p) => {
      p.classList.remove("active");
      // P1-3：目前章節嘅程式化狀態（唔再只有視覺 class）
      p.removeAttribute("aria-current");
    });
    const target = this.root.querySelector<HTMLElement>(`.ch-pill[data-ch="${cur}"]`);
    if (target) {
      target.classList.add("active");
      target.setAttribute("aria-current", "true");
      this.scrollPillIntoView(target);
    }
    const numEl = this.root.querySelector("#strip-ch-num");
    if (numEl) numEl.textContent = String(cur);
    const sumEl = this.root.querySelector("#strip-summary");
    if (sumEl) {
      // Phase E: 攞第一個 location 嘅 summary text
      const summaryObj = this.data.chapterSummaries?.[this.app.getCurrentChapter()];
      const first = summaryObj?.locations?.[0];
      const text = first ? `${first.name}：${first.summary}` : `第 ${this.app.getCurrentChapter()} 章`;
      sumEl.textContent = text.slice(0, 60) + (text.length > 60 ? "…" : "");
    }
    // P1-3：播報改章
    const live = this.root.querySelector<HTMLElement>("#strip-live");
    if (live) {
      const summaryObj = this.data.chapterSummaries?.[cur];
      const name = summaryObj?.locations?.[0]?.name ?? "";
      live.textContent = `第 ${cur} 章${name ? `：${name}` : ""}`;
    }
  }

  /**
   * 將目標 pill 捲到中間 —— **直接設 `scrollLeft`，唔用 `scrollIntoView`**（P0-2）。
   *
   * 為何唔可以 `scrollIntoView`（連 `behavior:"auto"` 都唔得）：
   * 任何形式嘅 `scrollIntoView` 都會移動 Chromium 嘅 sequential focus
   * navigation starting point，令之後 Tab 由該元素開始。呢個就係「頂欄
   * Tab 350 次到唔到」嘅根因。
   *
   * `scrollElementTo()` 係 B1 `motion.ts` 提供嘅唯一合法捲動入口，內建
   * reduced-motion 判斷（reduce → 即時跳）。
   */
  private scrollPillIntoView(pill: HTMLElement): void {
    const track = this.root.querySelector<HTMLElement>("#strip-track");
    if (!track) return;
    const left = pill.offsetLeft - (track.clientWidth - pill.offsetWidth) / 2;
    const targetLeft = Math.max(0, left);
    // 已經喺位置就唔使動（避免每次 updateSelection 都開動畫）
    if (Math.abs(track.scrollLeft - targetLeft) < 1) return;
    this.scrollMotion?.cancel();
    this.scrollMotion = scrollElementTo(track, targetLeft, track.scrollTop, DUR.normal);
  }

  /** 取消進行中嘅捲動（測試 / 熱重載用）。 */
  destroy(): void {
    this.scrollMotion?.cancel();
    this.scrollMotion = null;
  }
}

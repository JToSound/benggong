/**
 * ChapterStrip: 198 章節時間軸, top of page.
 * - Drag to scrub
 * - 顯示章節數字 + summary
 */

import type { App } from "../app";
import type { AppData } from "../data/loadAllData";

export class ChapterStrip {
  root: HTMLElement;
  app: App;
  data: AppData;

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
        <div class="strip-track" id="strip-track">
          ${this.renderChapters()}
        </div>
        <div class="strip-info">
          <span class="strip-current">第 <strong id="strip-ch-num">${this.app.getCurrentChapter()}</strong> / ${total} 章</span>
          <span class="strip-summary" id="strip-summary"></span>
        </div>
      </div>
    `;
    this.updateSelection();
  }

  private renderChapters(): string {
    const total = this.data.config.chapters?.total || 198;
    const summaries = this.data.chapterSummaries || {};
    const items: string[] = [];
    for (let ch = 1; ch <= total; ch++) {
      const summary = summaries[ch] || "";
      items.push(
        `<button class="ch-pill" data-ch="${ch}" aria-label="第 ${ch} 章: ${this.escapeHtml(summary.slice(0, 30))}">${ch}</button>`,
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
    pills.forEach((p) => p.classList.remove("active"));
    const target = this.root.querySelector(`.ch-pill[data-ch="${cur}"]`);
    if (target) {
      target.classList.add("active");
      target.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
    const numEl = this.root.querySelector("#strip-ch-num");
    if (numEl) numEl.textContent = String(cur);
    const sumEl = this.root.querySelector("#strip-summary");
    if (sumEl) {
      const summary = this.data.chapterSummaries?.[cur] || "";
      sumEl.textContent = summary.slice(0, 60) + (summary.length > 60 ? "…" : "");
    }
  }
}

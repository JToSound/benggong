/**
 * SearchBox: simple search modal.
 * 搜 character / event title / location name.
 */

import type { App } from "../app";
import type { AppData } from "../data/loadAllData";

interface SearchResult {
  type: "character" | "event" | "location";
  name: string;
  chapter?: number;
  jumpTo: () => void;
}

export class SearchBox {
  root: HTMLElement;
  app: App;
  data: AppData;

  constructor(root: HTMLElement, app: App) {
    this.root = root;
    this.app = app;
    this.data = app.data;
  }

  show(): void {
    let modal = this.root.querySelector("#search-modal") as HTMLElement | null;
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "search-modal";
      modal.className = "modal-backdrop";
      modal.innerHTML = `
        <div class="modal-content search-content">
          <header class="modal-header">
            <input type="text" id="search-input" placeholder="搜角色、事件、地點…" autofocus />
            <button id="search-close" class="close-btn">×</button>
          </header>
          <div class="search-results" id="search-results">
            <p class="hint">輸入關鍵字…</p>
          </div>
        </div>
      `;
      this.root.appendChild(modal);
      const input = modal.querySelector("#search-input") as HTMLInputElement;
      const close = modal.querySelector("#search-close") as HTMLButtonElement;
      const results = modal.querySelector("#search-results") as HTMLElement;
      input.addEventListener("input", () => this.renderResults(input.value, results));
      close.addEventListener("click", () => this.hide());
      modal.addEventListener("click", (e) => {
        if ((e.target as Element).classList.contains("modal-backdrop")) this.hide();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.hide();
      });
      // Defer focus
      setTimeout(() => input.focus(), 50);
    }
    modal.classList.add("open");
  }

  hide(): void {
    const modal = this.root.querySelector("#search-modal");
    if (modal) modal.classList.remove("open");
  }

  private renderResults(query: string, container: HTMLElement): void {
    if (!query || query.length < 1) {
      container.innerHTML = `<p class="hint">輸入關鍵字…</p>`;
      return;
    }
    const q = query.toLowerCase();
    const results: SearchResult[] = [];

    // Search characters
    for (const c of this.data.characters) {
      if (c.name.toLowerCase().includes(q) || (c.aliases || []).some((a) => a.toLowerCase().includes(q))) {
        results.push({
          type: "character",
          name: c.name,
          chapter: this.data.chapterAppearances.appearances[c.name]?.first_appearance,
          jumpTo: () => {
            this.app.setChapter(this.data.chapterAppearances.appearances[c.name]?.first_appearance || 1);
            this.hide();
          },
        });
      }
    }

    // Search events
    for (const ev of this.data.events.features) {
      const p = ev.properties;
      if (p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) {
        results.push({
          type: "event",
          name: `[ch${p.chapter}] ${p.title}`,
          chapter: p.chapter,
          jumpTo: () => {
            this.app.setChapter(p.chapter);
            this.app.setSelectedEvent(p.id);
            this.hide();
          },
        });
      }
    }

    // Search locations
    for (const loc of this.data.locations.features) {
      const p = loc.properties;
      if (p.name.toLowerCase().includes(q)) {
        results.push({
          type: "location",
          name: `${p.name}（ch${p.first_appearance}）`,
          chapter: p.first_appearance,
          jumpTo: () => {
            this.app.setChapter(p.first_appearance);
            this.app.setSelectedLocation(p.id);
            this.hide();
          },
        });
      }
    }

    // Limit
    const top = results.slice(0, 50);
    if (top.length === 0) {
      container.innerHTML = `<p class="hint">無結果</p>`;
      return;
    }

    container.innerHTML = `
      <ul class="search-result-list">
        ${top.map((r, i) => `
          <li class="search-result-item" data-idx="${i}">
            <span class="result-type type-${r.type}">${this.typeLabel(r.type)}</span>
            <span class="result-name">${this.escapeHtml(r.name)}</span>
            ${r.chapter ? `<span class="result-ch">ch${r.chapter}</span>` : ""}
          </li>
        `).join("")}
      </ul>
      ${results.length > 50 ? `<p class="more">…另外 ${results.length - 50} 個結果</p>` : ""}
    `;

    container.querySelectorAll(".search-result-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt((el as HTMLElement).dataset.idx || "0", 10);
        top[idx].jumpTo();
      });
    });
  }

  private typeLabel(t: string): string {
    return t === "character" ? "角色" : t === "event" ? "事件" : "地點";
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  }
}

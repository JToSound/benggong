/**
 * StoryPanel: 右側 chapter 內容面板.
 * 顯示:
 * - Chapter header
 * - Chapter summary (auto-generated)
 * - 本章 events
 * - 本章 characters 出現
 * - 本章 related routes
 */

import type { App } from "../app";
import type { AppData, RouteFeature } from "../data/loadAllData";
import type { EventFeature } from "../types/dataset";

export class StoryPanel {
  root: HTMLElement;
  app: App;
  data: AppData;

  constructor(root: HTMLElement, app: App) {
    this.root = root;
    this.app = app;
    this.data = app.data;
    this.updateForChapter(this.app.getCurrentChapter());
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  }

  updateForChapter(ch: number): void {
    const events = this.data.eventsByChapter.get(ch) || [];
    const summary = this.data.chapterSummaries?.[ch] || "";
    const chars = this.data.chapterAppearances?.appearances || {};
    const charList = Object.entries(chars)
      .filter(([_, info]) => info.chapters.includes(ch))
      .sort((a, b) => b[1].chapter_count - a[1].chapter_count)
      .slice(0, 12);
    const routesInChapter = (this.data.routesByChapter.get(ch) || []);

    const total = this.data.config.chapters?.total || 198;
    this.root.innerHTML = `
      <header class="story-header">
        <div class="story-chapter-num">第 ${ch} 章</div>
        <h2 class="story-title">${this.storyTitleForChapter(ch)}</h2>
      </header>

      <section class="story-summary">
        <h3>本章摘要</h3>
        <p>${summary ? this.escapeHtml(summary) : "<em>（未有摘要）</em>"}</p>
      </section>

      <section class="story-events">
        <h3>本章事件 <span class="badge">${events.length}</span></h3>
        ${events.length === 0 ? "<p class=\"empty\"><em>本章無事件記錄</em></p>" : `
        <ul class="event-list">
          ${events.slice(0, 20).map((ev) => this.renderEventItem(ev)).join("")}
        </ul>
        ${events.length > 20 ? `<p class="more">…另外 ${events.length - 20} 個事件</p>` : ""}
        `}
      </section>

      <section class="story-characters">
        <h3>本章出現角色 <span class="badge">${charList.length}</span></h3>
        ${charList.length === 0 ? "<p class=\"empty\"><em>本章無角色記錄</em></p>" : `
        <div class="char-grid">
          ${charList.map(([name, _]) => this.renderCharChip(name)).join("")}
        </div>
        `}
      </section>

      ${routesInChapter.length > 0 ? `
      <section class="story-routes">
        <h3>本章路線起點 <span class="badge">${routesInChapter.length}</span></h3>
        <ul class="route-list">
          ${routesInChapter.slice(0, 8).map((r: RouteFeature) => `
            <li class="route-item" data-route-id="${r.properties.id}">
              <span class="route-color" style="background:${r.properties.color}"></span>
              <span class="route-name">${this.escapeHtml(r.properties.character_name)}</span>
              <span class="route-span">ch${r.properties.chapters_span[0]}-${r.properties.chapters_span[1]}</span>
            </li>
          `).join("")}
        </ul>
      </section>
      ` : ""}

      <footer class="story-footer">
        <div class="chapter-nav">
          <button id="ch-prev" class="ch-nav-btn" ${ch <= 1 ? "disabled" : ""}>← 上一章</button>
          <span>${ch} / ${total}</span>
          <button id="ch-next" class="ch-nav-btn" ${ch >= total ? "disabled" : ""}>下一章 →</button>
        </div>
      </footer>
    `;

    this.bindEvents();
  }

  private storyTitleForChapter(ch: number): string {
    // 從 chapter summary 抽 title, 或者用 default
    const summary = this.data.chapterSummaries?.[ch] || "";
    if (summary) {
      // 第一句首 12 字
      const first = summary.split(/[，。！？；]/)[0].trim();
      if (first) return first.slice(0, 20);
    }
    return `第 ${ch} 章`;
  }

  private renderEventItem(ev: EventFeature): string {
    const p = ev.properties;
    const spoilerClass = p.spoiler_level > 1 ? `spoiler-${p.spoiler_level}` : "";
    return `
      <li class="event-item ${spoilerClass}" data-event-id="${p.id}">
        <span class="event-ch">ch${p.chapter}</span>
        <span class="event-title">${this.escapeHtml(p.title)}</span>
        ${p.location_id ? `<span class="event-loc" title="已綁定位置">📍</span>` : ""}
        ${p.spoiler_level > 1 ? `<span class="spoil-warn">🔒${p.spoiler_level}</span>` : ""}
      </li>
    `;
  }

  private renderCharChip(name: string): string {
    const ch = this.data.charactersByName.get(name);
    const color = ch?.color || "#888";
    return `<span class="char-chip" data-char-name="${this.escapeHtml(name)}" style="--chip-color:${color}">${this.escapeHtml(name)}</span>`;
  }

  private bindEvents(): void {
    this.root.querySelectorAll(".event-item").forEach((el) => {
      el.addEventListener("click", () => {
        const id = (el as HTMLElement).dataset.eventId;
        if (id) this.app.setSelectedEvent(id);
      });
    });
    this.root.querySelectorAll(".char-chip").forEach((el) => {
      el.addEventListener("click", () => {
        const name = (el as HTMLElement).dataset.charName;
        if (name) this.app.setSelectedLocation(null);  // could open character detail
        // TODO: open character modal
        console.log("char click:", name);
      });
    });
    this.root.querySelectorAll(".route-item").forEach((el) => {
      el.addEventListener("click", () => {
        const id = (el as HTMLElement).dataset.routeId;
        const route = this.data.routes.features.find((r: RouteFeature) => r.properties.id === id);
        if (route) this.app.setChapter(route.properties.chapters_span[0]);
      });
    });
    const prev = this.root.querySelector("#ch-prev") as HTMLButtonElement | null;
    const next = this.root.querySelector("#ch-next") as HTMLButtonElement | null;
    prev?.addEventListener("click", () => this.app.setChapter(Math.max(1, this.app.getCurrentChapter() - 1)));
    next?.addEventListener("click", () => {
      const max = this.data.config.chapters?.total || 198;
      this.app.setChapter(Math.min(max, this.app.getCurrentChapter() + 1));
    });
  }

  updateForLocation(locId: string | null): void {
    if (!locId) {
      this.updateForChapter(this.app.getCurrentChapter());
      return;
    }
    const loc = this.data.locationsById.get(locId);
    if (!loc) return;
    const p = loc.properties;
    const eventsHere = this.data.events.features.filter(
      (e: EventFeature) => e.properties.location_id === locId,
    );
    this.root.innerHTML = `
      <header class="story-header">
        <div class="back-btn" id="back-to-ch">← 返第 ${this.app.getCurrentChapter()} 章</div>
        <div class="loc-num">📍 地點</div>
        <h2 class="story-title">${this.escapeHtml(p.name)}</h2>
        <p class="loc-meta">${p.display_name} · ch${p.first_appearance} · ${p.location_precision}</p>
      </header>
      <section class="story-summary">
        <h3>簡介</h3>
        <p>${p.description ? this.escapeHtml(p.description) : "<em>（無描述）</em>"}</p>
      </section>
      ${p.characters && p.characters.length > 0 ? `
      <section class="story-characters">
        <h3>相關角色 <span class="badge">${p.characters.length}</span></h3>
        <div class="char-grid">
          ${p.characters.slice(0, 20).map((n: string) => this.renderCharChip(n)).join("")}
        </div>
      </section>
      ` : ""}
      ${eventsHere.length > 0 ? `
      <section class="story-events">
        <h3>此地點事件 <span class="badge">${eventsHere.length}</span></h3>
        <ul class="event-list">
          ${eventsHere.slice(0, 20).map((ev: EventFeature) => this.renderEventItem(ev)).join("")}
        </ul>
      </section>
      ` : ""}
    `;
    this.root.querySelector("#back-to-ch")?.addEventListener("click", () => {
      this.app.setSelectedLocation(null);
    });
  }

  updateForEvent(eventId: string | null): void {
    if (!eventId) {
      this.updateForChapter(this.app.getCurrentChapter());
      return;
    }
    const ev = this.data.events.features.find(
      (e: EventFeature) => e.properties.id === eventId,
    );
    if (!ev) return;
    const p = ev.properties;
    this.root.innerHTML = `
      <header class="story-header">
        <div class="back-btn" id="back-to-ch">← 返第 ${p.chapter} 章</div>
        <div class="loc-num">💫 事件</div>
        <h2 class="story-title">${this.escapeHtml(p.title)}</h2>
        <p class="event-meta">ch${p.chapter} · ${p.event_type} · 🔒 ${p.spoiler_level}</p>
      </header>
      <section class="story-summary">
        <h3>事件詳情</h3>
        <p>${this.escapeHtml(p.description)}</p>
      </section>
      ${p.location_id ? `
      <section class="story-characters">
        <h3>地點</h3>
        <p><a href="#" class="link-to-loc" data-loc-id="${p.location_id}">${this.escapeHtml(p.location_id)}</a></p>
      </section>
      ` : ""}
    `;
    this.root.querySelector("#back-to-ch")?.addEventListener("click", () => {
      this.app.setSelectedEvent(null);
    });
    this.root.querySelector(".link-to-loc")?.addEventListener("click", (e) => {
      e.preventDefault();
      const locId = (e.currentTarget as HTMLElement).dataset.locId;
      if (locId) this.app.setSelectedLocation(locId);
    });
  }
}

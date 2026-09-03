/**
 * Phase F: 主 App 結構.
 *
 * Layout:
 * ┌──────────────────────────────────────────┐
 * │  Top: Chapter Strip (198 chapters)      │
 * ├──────────────────────────────────────────┤
 * │              │                            │
 * │   SVG Map    │   Story Panel              │
 * │   (center)   │   (right)                  │
 * │              │                            │
 * └──────────────────────────────────────────┘
 */

import type { AppData } from "./data/loadAllData";
import { ChapterStrip } from "./components/ChapterStrip";
import { SvgMap } from "./components/SvgMap";
import { StoryPanel } from "./components/StoryPanel";
import { AboutModal } from "./components/AboutModal";
import { SearchBox } from "./components/SearchBox";

export class App {
  root: HTMLElement;
  data: AppData;
  currentChapter: number = 1;
  selectedLocationId: string | null = null;
  selectedEventId: string | null = null;

  // Component refs
  chapterStrip!: ChapterStrip;
  svgMap!: SvgMap;
  storyPanel!: StoryPanel;
  aboutModal!: AboutModal;
  searchBox!: SearchBox;

  constructor(root: HTMLElement, data: AppData) {
    this.root = root;
    this.data = data;
    this.render();
    this.bindKeys();
  }

  private render(): void {
    this.root.innerHTML = `
      <a class="skip-link" href="#map-pane">跳去主內容</a>
      <header id="topbar">
        <div class="brand">
          <h1>《病港》互動地圖</h1>
          <p class="tagline">第一章 <span class="badge">將軍澳 1990s</span> · 香港網絡小說</p>
        </div>
        <nav aria-label="主要導覽">
          <button id="btn-search" type="button" class="nav-btn">🔍 搜尋</button>
          <button id="btn-about" type="button" class="nav-btn">關於</button>
        </nav>
      </header>
      <div id="chapter-strip-mount"></div>
      <div class="workspace">
        <main id="map-pane" class="pane-map">
          <div id="svg-map-mount"></div>
        </main>
        <aside id="story-pane" class="pane-story">
          <div id="story-panel-mount"></div>
        </aside>
      </div>
    `;

    // Mount components
    this.chapterStrip = new ChapterStrip(
      this.root.querySelector("#chapter-strip-mount")!,
      this,
    );
    this.svgMap = new SvgMap(
      this.root.querySelector("#svg-map-mount")!,
      this,
    );
    this.storyPanel = new StoryPanel(
      this.root.querySelector("#story-panel-mount")!,
      this,
    );
    this.aboutModal = new AboutModal(this.root, this.data);
    this.searchBox = new SearchBox(this.root, this);

    // Bind nav buttons
    this.root.querySelector("#btn-about")!.addEventListener("click", () => this.aboutModal.show());
    this.root.querySelector("#btn-search")!.addEventListener("click", () => this.searchBox.show());
  }

  private bindKeys(): void {
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft" || e.key === "j") {
        e.preventDefault();
        this.setChapter(Math.max(1, this.currentChapter - 1));
      } else if (e.key === "ArrowRight" || e.key === "k") {
        e.preventDefault();
        const max = this.data.config.chapters?.total || 198;
        this.setChapter(Math.min(max, this.currentChapter + 1));
      } else if (e.key === "Home") {
        this.setChapter(1);
      } else if (e.key === "End") {
        this.setChapter(this.data.config.chapters?.total || 198);
      } else if (e.key === "/") {
        e.preventDefault();
        this.searchBox.show();
      } else if (e.key === "Escape") {
        this.selectedLocationId = null;
        this.selectedEventId = null;
        this.svgMap.render();
        this.storyPanel.updateForChapter(this.currentChapter);
      }
    });
  }

  setChapter(ch: number): void {
    if (ch === this.currentChapter) return;
    this.currentChapter = ch;
    this.chapterStrip.updateSelection();
    this.svgMap.flyToChapter(ch);
    this.storyPanel.updateForChapter(ch);
    // Update hash
    if (window.location.hash !== `#ch=${ch}`) {
      history.replaceState(null, "", `#ch=${ch}`);
    }
  }

  setSelectedLocation(locId: string | null): void {
    this.selectedLocationId = locId;
    this.selectedEventId = null;
    this.svgMap.render();
    this.storyPanel.updateForLocation(locId);
  }

  setSelectedEvent(eventId: string | null): void {
    this.selectedEventId = eventId;
    this.selectedLocationId = null;
    this.svgMap.render();
    this.storyPanel.updateForEvent(eventId);
  }

  getCurrentChapter(): number {
    return this.currentChapter;
  }
}

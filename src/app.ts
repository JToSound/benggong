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
    this.bindPanelToggle();
    this.bindKeys();
  }

  /**
   * 故事面板嘅顯示切換（窄螢幕用）。
   *
   * 為何需要：1280px 以下嘅螢幕，380px 面板會佔咗成個畫面嘅三分之一，
   * 地圖剩返好窄。所以窄螢幕時面板變成**浮層抽屜**，用按鈕開關。
   *
   * 用 `aria-expanded` 而唔係只改 CSS class —— 螢幕閱讀器要知狀態。
   */
  private bindPanelToggle(): void {
    const btn = this.root.querySelector("#btn-toggle-panel");
    const pane = this.root.querySelector("#story-pane");
    if (!btn || !pane) return;
    const sync = () => {
      const open = !pane.classList.contains("is-collapsed");
      btn.setAttribute("aria-expanded", String(open));
    };
    btn.addEventListener("click", () => {
      pane.classList.toggle("is-collapsed");
      sync();
    });
    // 窄螢幕預設收起（用 matchMedia 而唔係硬編闊度）
    if (window.matchMedia("(max-width: 1023px)").matches) {
      pane.classList.add("is-collapsed");
    }
    sync();
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
          <button id="btn-help" type="button" class="nav-btn" title="鍵盤快捷鍵（?）">?</button>
          <button id="btn-about" type="button" class="nav-btn">關於</button>
          <button id="btn-toggle-panel" type="button" class="nav-btn panel-toggle"
                  aria-controls="story-pane" aria-expanded="true"
                  title="顯示／隱藏故事面板">面板</button>
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
    // 快捷鍵提示：`?` 按鈕同鍵盤 `?` 都開同一個 modal
    this.root
      .querySelector("#btn-help")!
      .addEventListener("click", () => this.aboutModal.show());
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
      } else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        // 快捷鍵提示（`?` 係 Shift+/，所以要分開判斷）
        e.preventDefault();
        this.aboutModal.show();
      } else if (e.key === "/") {
        e.preventDefault();
        this.searchBox.show();
      } else if (e.key === "Escape") {
        /*
         * Esc 嘅優先次序：**先關浮層，再清選擇**。
         *
         * 為何：如果 modal／搜尋開住，用戶按 Esc 嘅意圖一定係「關佢」，
         * 唔係「清除地圖上嘅選中標記」。原本冇分先後，令開咗嘅 modal
         * 按 Esc 冇反應（實測踩過）。
         */
        if (this.aboutModal.isOpen()) {
          this.aboutModal.hide();
          return;
        }
        if (this.searchBox.isOpen()) {
          this.searchBox.hide();
          return;
        }
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

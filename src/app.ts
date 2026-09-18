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

import { ChronicleView } from "./components/ChronicleView";
import { exportMapPng } from "./exportMap";
import { initTheme, toggleTheme, type Theme } from "./theme";
import type { AppData } from "./data/loadAllData";
import { ChapterStrip } from "./components/ChapterStrip";
import { SvgMap } from "./components/SvgMap";
import { StoryPanel } from "./components/StoryPanel";
import { AboutModal } from "./components/AboutModal";
import { SearchBox } from "./components/SearchBox";

export class App {
  private chronicleView!: ChronicleView;
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
          <p class="tagline">第一章 <span class="badge">將軍澳 2010s</span> · 香港網絡小說</p>
        </div>
        <nav aria-label="主要導覽">
          <button id="btn-mode" type="button" class="nav-btn" title="切換編年史／章節視圖">📜 編年史</button>
          <button id="btn-search" type="button" class="nav-btn">🔍 搜尋</button>
          <button id="btn-share" type="button" class="nav-btn" title="複製呢一章嘅連結">🔗</button>
          <button id="btn-export" type="button" class="nav-btn" title="匯出目前地圖為 PNG">⬇</button>
          <button id="btn-theme" type="button" class="nav-btn" title="切換深色／淺色主題">🌙</button>
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
    /*
     * 編年史視圖 —— **預設**（用戶選擇「並存，編年史做預設」）。
     *
     * 章節條由「切換章節」改為「篩選編年史」（見 `setChapter`）。
     * 兩者共用同一個 mount point，用 `viewMode` 決定顯示邊個。
     */
    this.chronicleView = new ChronicleView(
      this.root.querySelector("#story-panel-mount")!,
      this,
      this.data.chronicle,
    );
    this.aboutModal = new AboutModal(this.root, this.data);
    this.searchBox = new SearchBox(this.root, this);

    // Bind nav buttons
    this.root.querySelector("#btn-about")!.addEventListener("click", () => this.aboutModal.show());
    this.root.querySelector("#btn-search")!.addEventListener("click", () => this.searchBox.show());
    // 編年史／章節視圖切換
    this.root.querySelector("#btn-mode")!.addEventListener("click", () => {
      this.setViewMode(this.viewMode === "chronicle" ? "chapter" : "chronicle");
    });

    // 分享連結
    this.root
      .querySelector("#btn-share")!
      .addEventListener("click", () => void this.copyShareLink());

    // 匯出 PNG
    this.root.querySelector("#btn-export")!.addEventListener("click", () => {
      void this.exportCurrentMap();
    });

    // 主題切換：按鈕圖示反映「下一個」主題（唔係目前主題）
    initTheme((t: Theme) => {
      const btn = this.root.querySelector("#btn-theme");
      if (btn) {
        btn.textContent = t === "dark" ? "🌙" : "☀️";
        btn.setAttribute(
          "title",
          t === "dark" ? "切換到淺色主題" : "切換到深色主題",
        );
      }
    });
    this.root
      .querySelector("#btn-theme")!
      .addEventListener("click", () => toggleTheme());

    // 快捷鍵提示：`?` 按鈕同鍵盤 `?` 都開同一個 modal
    this.root
      .querySelector("#btn-help")!
      .addEventListener("click", () => this.aboutModal.show());
  }

  /**
   * 複製目前狀態嘅可分享連結。
   *
   * 用 `navigator.clipboard`，唔支援就退回 `execCommand`（舊瀏覽器／
   * 非 HTTPS 環境）。兩者都失敗就彈出 prompt 讓用戶自己複製 ——
   * 唔可以靜靜咁失敗。
   */
  private async copyShareLink(): Promise<void> {
    const url = window.location.href;
    const btn = this.root.querySelector("#btn-share") as HTMLButtonElement | null;
    const prev = btn?.textContent ?? "🔗";
    const flash = (txt: string) => {
      if (!btn) return;
      btn.textContent = txt;
      setTimeout(() => {
        btn.textContent = prev;
      }, 1400);
    };
    try {
      await navigator.clipboard.writeText(url);
      flash("✓");
    } catch {
      // 退回：建立暫存 textarea 再 execCommand
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("execCommand 失敗");
        flash("✓");
      } catch {
        window.prompt("複製呢條連結：", url);
      }
    }
  }

  /**
   * 匯出目前地圖視圖為 PNG。
   *
   * 用 `viewBox` 嘅章節號做檔名（例如 `binggang-ch150.png`），方便
   * 用戶分辨。失敗要**明確講原因** —— 「匯出失敗」四個字幫唔到手。
   */
  private async exportCurrentMap(): Promise<void> {
    const btn = this.root.querySelector("#btn-export") as HTMLButtonElement | null;
    const svg = this.root.querySelector<SVGSVGElement>("#svg-map");
    if (!svg) return;
    const prev = btn?.textContent ?? "⬇";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    try {
      const r = await exportMapPng(svg, {
        scale: 2,
        filename: `binggang-ch${this.currentChapter}`,
        // 深色主題用深底，淺色主題用暖白（同 UI 一致）
        background: document.documentElement.getAttribute("data-theme") === "light"
          ? "#f4f1ea"
          : "#0b0f16",
      });
      console.info(`[匯出] ${r.filename}（${r.width}×${r.height}）`);
    } catch (e) {
      console.error("[匯出] 失敗", e);
      window.alert(`匯出失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prev;
      }
    }
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

  /**
   * 目前嘅面板模式。
   *
   * 用戶選擇「並存，編年史做預設，章節條保留做篩選器」——
   * 所以 `chronicle` 係預設，`chapter` 係原本嘅逐章視圖。
   */
  private viewMode: "chronicle" | "chapter" = "chronicle";

  setViewMode(mode: "chronicle" | "chapter"): void {
    this.viewMode = mode;
    const btn = this.root.querySelector("#btn-mode");
    if (btn) btn.textContent = mode === "chronicle" ? "📜 編年史" : "📖 章節";
    if (mode === "chronicle") {
      this.chronicleView.render();
    } else {
      this.storyPanel.updateForChapter(this.currentChapter);
    }
  }

  getViewMode(): "chronicle" | "chapter" {
    return this.viewMode;
  }

  setChapter(ch: number): void {
    if (ch === this.currentChapter) return;
    this.currentChapter = ch;
    this.chapterStrip.updateSelection();
    this.svgMap.flyToChapter(ch);
    /*
     * ⚠️ 章節條嘅角色已經改變。
     *
     * 用戶選擇「章節條保留做篩選器」—— 喺編年史模式下，點章節條應該
     * **篩選**該章相關嘅編年史條目，而唔係切換去逐章視圖。
     * 只有喺章節模式下才更新 StoryPanel。
     */
    if (this.viewMode === "chronicle") {
      this.chronicleView.setChapterFilter(ch);
    } else {
      this.storyPanel.updateForChapter(ch);
    }
    this.syncHash();
  }

  /** 由編年史條目嘅章節標籤跳去該章（會切換到章節模式）。 */
  goToChapter(ch: number): void {
    this.setViewMode("chapter");
    this.setChapter(ch);
  }

  setSelectedLocation(locId: string | null): void {
    this.selectedLocationId = locId;
    this.selectedEventId = null;
    this.svgMap.render();
    // 地點詳情屬逐章視圖 —— 點地圖標記時自動切過去，否則用戶
    // 見到嘅係編年史，會以為點擊冇反應。
    if (locId) this.setViewMode("chapter");
    this.storyPanel.updateForLocation(locId);
    this.syncHash();
  }

  /**
   * 將目前狀態寫入 URL hash（可分享）。
   *
   * 用 `replaceState` 而唔係 `pushState`：章節係「狀態」唔係「導航
   * 歷史」—— 用 `pushState` 嘅話快速按 `k` 會塞爆瀏覽器歷史，
   * 用戶想返回上一頁就要按幾十次。
   */
  private syncHash(): void {
    const parts = [`ch=${this.currentChapter}`];
    if (this.selectedLocationId) parts.push(`loc=${this.selectedLocationId}`);
    const want = `#${parts.join("&")}`;
    if (window.location.hash !== want) {
      history.replaceState(null, "", want);
    }
  }

  setSelectedEvent(eventId: string | null): void {
    this.selectedEventId = eventId;
    this.selectedLocationId = null;
    this.svgMap.render();
    this.storyPanel.updateForEvent(eventId);
  }

  /** 全書章節總數（router 驗證 hash 用）。 */
  getChapterTotal(): number {
    return this.data.config.chapters?.total || 198;
  }

  /** 目前選中嘅地點 id（router 比對 hash 用）。 */
  getSelectedLocationId(): string | null {
    return this.selectedLocationId;
  }

  getCurrentChapter(): number {
    return this.currentChapter;
  }
}

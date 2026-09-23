/**
 * World Atlas V2 — App shell（B2）
 *
 * ⚠️ 呢個檔由 Phase F 版本**改寫**：舊版有 4 個私有 selection 欄位 +
 * `viewMode` private + `syncHash()`，完全違反規則 S1–S4。新版：
 *
 *   - 唯一 state 來源 = `this.store`（`src/state/store.ts`）
 *   - 所有 selection / view / chapter / layer / theme 轉換 = store action
 *   - URL = store 嘅投影（`effects.projectUrl`），**唔再**有 `syncHash()`
 *   - DOM class（`is-collapsed`）只係**衍生輸出**，唔再用嚟做邏輯判斷
 *
 * 公開方法保留作**薄 adapter**（component 暫時仍然收 `App` 實例），
 * 令 B6 / B7 / B8 重寫 component 之前 build 保持綠。
 * 完整映射見 `docs/contracts/b2-interface-contract.md` §7。
 */

import { ChronicleView } from "./components/ChronicleView";
import { exportMapPng } from "./exportMap";
import { initTheme } from "./theme";
import type { AppData } from "./data/loadAllData";
import { ChapterStrip } from "./components/ChapterStrip";
import { SvgMap } from "./components/SvgMap";
import { StoryPanel } from "./components/StoryPanel";
import { AboutModal } from "./components/AboutModal";
import { BottomSheet } from "./components/BottomSheet";
import { OnboardingCard, type EntryAction } from "./components/OnboardingCard";
import { SearchBox } from "./components/SearchBox";
import { SearchOverlay, type SearchItem } from "./components/SearchOverlay";
import { ZoneDossier } from "./components/ZoneDossier";
import {
  bindUrlSync as bindStoreUrlSync,
  buildWorldIndex,
  createAppStore,
  persistedInitialState,
  selectSearchResults,
  type AppState,
  type AppStore,
  type IdKind,
  type PrimaryContext,
  type SearchKind,
  type UrlValidationContext,
  type WorldIndex,
} from "./state";

/** 面板收合狀態（mobile sheet）用嘅 snap 值。 */
const COLLAPSED_SNAP = "peek";
const EXPANDED_SNAP = "half";

/**
 * 取得 B8 搜尋 overlay 嘅 host（`#search-shell`）。
 *
 * W1/W2 接線（2026-09-23）之後，`#search-shell` **已經係 `index.html` 嘅
 * 靜態 body 直屬子節點**，所以正常情況呢個函數只係 `getElementById`。
 *
 * 為何仍然保留動態建立嘅 fallback
 * ------------------------------
 * 元件可能喺非標準環境實例化（單元測試 / SSR / 被其他 entry 收養），
 * 嗰時 `index.html` 未必存在。fallback 令「host 一定揾到」變成**保證**，
 * 唔會因為 HTML 唔同步而令搜尋靜靜哋壞（`searchOverlay.root` 係 `!` 斷言，
 * 傳 `null` 會 throw）。
 *
 * 為何 host 一定要喺 `#app-root` 外面
 * ---------------------------------
 * `SearchOverlay.open()` 會對 `#app-root` 加 `inert`（P0-4 背景隔離）。
 * 如果 overlay 係 `#app-root` 嘅子孫，佢會被自己加嘅 `inert` 一齊屏蔽
 * → `#search-input` 永遠收唔到 focus（實測 `document.activeElement` = BODY，
 * 搜尋完全用唔到）。
 *
 * 實測過用 Popover API 將 overlay 提升去 Top Layer：`showPopover()` 雖然
 * 開到，但 Chromium 嘅 popover 會令 `offsetParent` 變 `null`、focus 仍然
 * 落唔到 input（實測失敗）。所以最穩健嘅做法係**將 host 掛喺 body**——
 * 佢同 `#app-root` 係兄弟，`inert` 唔會傳過去，`.search-overlay` 本身係
 * `position: fixed; z-index: var(--z-modal)`（`mobile.css:340`）已經足夠
 * 蓋住全頁。零 Popover API 依賴，所有瀏覽器行為一致。
 */
function ensureSearchShell(): HTMLElement {
  const existing = document.getElementById("search-shell");
  if (existing) return existing;
  // fallback：`index.html` 冇靜態 host 時（測試 / 非標準 entry）即場建立。
  const shell = document.createElement("div");
  shell.id = "search-shell";
  (document.body ?? document.documentElement).appendChild(shell);
  return shell;
}

export class App {
  root: HTMLElement;
  data: AppData;
  /** 唯一 state 來源。 */
  readonly store: AppStore;
  /** selector 用嘅 read model。 */
  readonly world: WorldIndex;

  // Component refs
  chapterStrip!: ChapterStrip;
  svgMap!: SvgMap;
  storyPanel!: StoryPanel;
  aboutModal!: AboutModal;
  /**
   * 舊搜尋 modal（`SearchBox`）。
   *
   * ⚠️ **唔再掛喺 app.ts 嘅 DOM 樹**（B8 接線，見 `render()`）——
   * 由 B8 `SearchOverlay` 做主要搜尋入口。保留欄位只為咗 `SearchBox.ts`
   * 本身仍然喺 repo（唔喺 B8 allowlist，唔可以刪），令 `import` 唔會
   * 被 lint 當 unused。
   */
  searchBox!: SearchBox;
  /** B8 5 類搜尋 overlay（P0-4 / P0-5）。 */
  searchOverlay!: SearchOverlay;
  /** B8 mobile bottom sheet（P0-1 / P1-7）。 */
  bottomSheet!: BottomSheet;
  /** B8 初次入站引導卡（4 個主入口）。 */
  onboarding!: OnboardingCard;
  zoneDossier!: ZoneDossier;
  chronicleView!: ChronicleView;

  private unsubscribe: (() => void) | null = null;
  private prevState: AppState | null = null;
  /** 首次 store 通知是否已處理（見 `onStateChange()` 嘅說明）。 */
  private initialised = false;

  /**
   * 最近一次搜尋結果嘅「`kind:label` → domain id」對照。
   *
   * `SearchItem` 冇 `id`，所以由 `searchItems()` 建立、`pickSearchItem()`
   * 還原目標。唔入 store（唔係 state）。
   */
  private readonly labelToId = new Map<string, string>();

  constructor(root: HTMLElement, data: AppData, store?: AppStore) {
    this.root = root;
    this.data = data;
    this.world = buildWorldIndex(data);
    this.store =
      store ??
      createAppStore({
        initial: persistedInitialState(),
        chapterTotal: this.getChapterTotal(),
      });

    this.render();
    this.bindPanelToggle();
    this.bindKeys();

    this.unsubscribe = this.store.subscribe(() => this.onStateChange());
    this.onStateChange();
  }

  /** 解除 store 訂閱（測試／熱重載用）。 */
  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 衍生讀取（全部由 store 讀，冇任何私有 state）
  // ───────────────────────────────────────────────────────────────────────

  /** 目前選中嘅 zone id（SvgMap 渲染高亮用）。 */
  get selectedZoneId(): string | null {
    const c = this.store.getState().context;
    return c.kind === "zone" ? c.zoneId : null;
  }

  /** 目前選中嘅地點 id（SvgMap 比對用）。 */
  get selectedLocationId(): string | null {
    const c = this.store.getState().context;
    return c.kind === "location" ? c.locationId : null;
  }

  /** 目前選中嘅事件 id（SvgMap 比對用）。 */
  get selectedEventId(): string | null {
    const c = this.store.getState().context;
    return c.kind === "event" ? c.eventId : null;
  }

  getCurrentChapter(): number {
    return this.store.getState().chapter;
  }

  getChapterTotal(): number {
    return this.data.config.chapters?.total || 198;
  }

  getSelectedZoneId(): string | null {
    return this.selectedZoneId;
  }

  getSelectedLocationId(): string | null {
    return this.selectedLocationId;
  }

  /**
   * 目前面板模式（由 `view` + `context.kind` **衍生**，唔再係私有欄位）。
   */
  getViewMode(): "chronicle" | "chapter" | "zone" {
    const s = this.store.getState();
    if (s.view === "chronicle") return "chronicle";
    if (s.context.kind === "zone") return "zone";
    return "chapter";
  }

  // ───────────────────────────────────────────────────────────────────────
  // 寫入（全部經 store action）
  // ───────────────────────────────────────────────────────────────────────

  setChapter(ch: number): void {
    this.store.setChapter(ch);
  }

  /** 由編年史條目嘅章節標籤跳去該章（切回地圖 + 章節 context）。 */
  goToChapter(ch: number): void {
    this.store.setView("map");
    this.store.setChapter(ch);
  }

  setSelectedZone(zoneId: string | null): void {
    this.select({ kind: "zone", zoneId: zoneId ?? "" }, zoneId !== null);
  }

  setSelectedLocation(locId: string | null): void {
    this.select({ kind: "location", locationId: locId ?? "" }, locId !== null);
  }

  setSelectedEvent(eventId: string | null): void {
    this.select({ kind: "event", eventId: eventId ?? "" }, eventId !== null);
  }

  /** 用戶點選 = 導航（pushState）；清除 = 狀態轉換（replaceState）。 */
  private select(ctx: PrimaryContext, isSelection: boolean): void {
    if (isSelection) this.store.navigate(ctx);
    else this.store.setContext({ kind: "explore" });
  }

  setViewMode(mode: "chronicle" | "chapter" | "zone"): void {
    if (mode === "chronicle") {
      this.store.setView("chronicle");
      return;
    }
    if (mode === "zone") {
      const zoneId = this.selectedZoneId;
      this.store.setView("map");
      if (zoneId) this.store.setContext({ kind: "zone", zoneId });
      return;
    }
    this.store.setView("map");
    this.store.setContext({ kind: "explore" });
  }

  /** 由 URL 還原 state（啟動時一次性；U6 亦會經 `bindUrlSync` 呼叫）。 */
  hydrateFromUrl(url: URL): AppState {
    return this.store.hydrateFromUrl(url, this.validationContext());
  }

  /**
   * 規則 U6：監聽 `popstate` → `hydrateFromUrl` + 重繪。
   * 回傳 unsubscribe。
   */
  bindUrlSync(): () => void {
    return bindStoreUrlSync(this.store, this.validationContext());
  }

  /** URL id 語意驗證用嘅 context（由 `WorldIndex` 建 predicate）。 */
  private validationContext(): UrlValidationContext {
    return {
      chapterTotal: this.getChapterTotal(),
      isValidId: (kind, id) => this.isValidId(kind, id),
    };
  }

  private isValidId(kind: IdKind, id: string): boolean {
    switch (kind) {
      case "zone":
        return this.world.zonesById.has(id);
      case "event":
        return this.world.eventsById.has(id);
      case "location":
        return this.world.locationsById.has(id);
      case "character":
        return this.world.charactersById.has(id);
      case "route":
        return this.world.routesByCharacter.has(id);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // DOM
  // ───────────────────────────────────────────────────────────────────────

  private render(): void {
    this.root.innerHTML = `
      <a class="skip-link" href="#map-pane">跳去主內容</a>
      <header id="topbar">
        <div class="brand">
          <h1>《病港》世界地圖</h1>
          <p class="tagline">互動戰術地圖 · 世界檔案 · 編年史</p>
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
        <aside id="story-pane" class="pane-story" data-sheet-snap="half">
          <div id="zone-dossier-mount" class="zone-dossier-mount" hidden></div>
          <div id="story-panel-mount"></div>
        </aside>
      </div>
    `;

    // Mount components
    this.chapterStrip = new ChapterStrip(this.root.querySelector("#chapter-strip-mount")!, this);
    this.svgMap = new SvgMap(this.root.querySelector("#svg-map-mount")!, this);
    this.storyPanel = new StoryPanel(this.root.querySelector("#story-panel-mount")!, this);
    this.chronicleView = new ChronicleView(
      this.root.querySelector("#story-panel-mount")!,
      this,
      this.data.chronicle,
    );
    this.zoneDossier = new ZoneDossier(this.root.querySelector("#zone-dossier-mount")!, this);
    this.aboutModal = new AboutModal(this.root, this.data);

    /*
     * 舊 `SearchBox` 唔再 mount 落 DOM（B8 接線）：`SearchOverlay` 取代咗
     * 佢所有入口。保留構造只為令 `import` 有實際用途（`SearchBox.ts` 唔喺
     * B8 allowlist，唔可以刪）。
     */
    this.searchBox = new SearchBox(this.root, this);

    /*
     * B8 `SearchOverlay`：掛喺 `document.body` 之下嘅 `#search-shell`
     * （**唔係** `#app-root` 之內）。
     *
     * 為何要獨立 host：overlay 開啓時會對 `#app-root` 加 `inert`（P0-4）。
     * 如果 overlay 自己係 `#app-root` 嘅子孫，佢會被自己加嘅 `inert` 一齊
     * 屏蔽 → `#search-input` 收唔到 focus（實測失敗）。詳見 `ensureSearchShell()`。
     */
    this.searchOverlay = new SearchOverlay({
      root: ensureSearchShell(),
      search: (kind, query) => this.searchItems(kind, query),
      onPick: (item) => this.pickSearchItem(item),
      restoreFocus: () => this.root.querySelector<HTMLElement>("#btn-search"),
    });

    /*
     * B8 `BottomSheet`：掛 `#story-pane`，內容容器係 `#story-panel-mount`。
     * snap 嘅唯一來源係 `store.sheetSnap`（規則 S1）——
     * `getSnap` / `setSnap` 只做薄轉接，唔持有第二份 state。
     */
    this.bottomSheet = new BottomSheet({
      root: this.root.querySelector<HTMLElement>("#story-pane")!,
      content: this.root.querySelector<HTMLElement>("#story-panel-mount")!,
      getSnap: () => this.store.getState().sheetSnap,
      setSnap: (s) => this.store.setSheetSnap(s),
      title: "故事面板",
    });

    /*
     * B8 `OnboardingCard`：浮喺 `#map-pane` 上（非阻塞）。
     * `show()` 內部會查 localStorage，已 dismiss 過就唔顯示。
     */
    const mapPane = this.root.querySelector<HTMLElement>("#map-pane");
    if (mapPane) {
      this.onboarding = new OnboardingCard({
        root: mapPane,
        onEntry: (action) => this.onOnboardingEntry(action),
      });
      this.onboarding.show();
    }

    // Bind nav buttons
    this.root.querySelector("#btn-about")!.addEventListener("click", () => this.aboutModal.show());
    this.root
      .querySelector("#btn-search")!
      .addEventListener("click", () => this.searchOverlay.open(this.store.getState().searchKind));
    this.root.querySelector("#btn-mode")!.addEventListener("click", () => {
      this.setViewMode(this.getViewMode() === "chronicle" ? "chapter" : "chronicle");
    });

    this.root
      .querySelector("#btn-share")!
      .addEventListener("click", () => void this.copyShareLink());

    this.root.querySelector("#btn-export")!.addEventListener("click", () => {
      void this.exportCurrentMap();
    });

    /*
     * 主題：唯一來源係 `store.theme`。套用 DOM 交畀 B1 `theme.ts`（保留
     * `basemap-theme-change` 事件）；按鈕標籤由 store 訂閱者更新。
     */
    initTheme(() => {
      /* 套用持久化主題；標籤更新喺 onStateChange() */
    });
    this.root.querySelector("#btn-theme")!.addEventListener("click", () => {
      const next = this.store.getState().theme === "dark" ? "light" : "dark";
      this.store.setTheme(next);
    });

    this.root
      .querySelector("#btn-help")!
      .addEventListener("click", () => this.aboutModal.show());
  }

  /**
   * 面板收合：唯一來源係 `state.sheetSnap`（`peek` = 收埋）。
   * 唔再讀寫 DOM class 做邏輯判斷 —— class 只係衍生輸出。
   */
  private bindPanelToggle(): void {
    const btn = this.root.querySelector("#btn-toggle-panel");
    if (btn) {
      btn.addEventListener("click", () => {
        const s = this.store.getState();
        this.store.setSheetSnap(s.sheetSnap === COLLAPSED_SNAP ? EXPANDED_SNAP : COLLAPSED_SNAP);
      });
    }
    // 窄螢幕預設收起（用 matchMedia 而唔係硬編闊度）。
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      if (window.matchMedia("(max-width: 1023px)").matches) {
        this.store.setSheetSnap(COLLAPSED_SNAP);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // B8 接線：搜尋 / 引導卡
  // ───────────────────────────────────────────────────────────────────────

  /**
   * 由現有讀模型砌搜尋結果（`SearchOverlay.search` 回呼）。
   *
   * 為何唔自己掃 raw data：`this.world.searchIndex` 係 B2 `buildWorldIndex()`
   * 已經建好嘅 5 類扁平索引（character / zone / location / event / chapter），
   * 經 `selectSearchResults()`（B2 selector + B3 adapter 共用嘅 `SearchKind`）
   * 過濾 —— 零新增 data 依賴，亦同 URL `?search=` 嘅 `searchKind` 語意一致。
   *
   * ⚠️ `SearchItem`（B8 契約）**冇 `id` 欄位**（刻意保持可測、零 domain
   * 依賴）。所以另外喺 `labelToId` 記住「label → domain id」，等 `onPick`
   * 收到 `SearchItem` 時可以還原目標。key 用 `kind + label` 保證唯一。
   */
  private searchItems(kind: SearchKind | null, query: string): SearchItem[] {
    const results = selectSearchResults(kind, query, this.world);
    this.labelToId.clear();
    return results.map((r) => {
      const item: SearchItem = { kind: r.kind, id: r.id, label: r.label, sublabel: r.sublabel };
      const ch = this.chapterRefOf(r.kind, r.id);
      if (ch !== null) item.chapter = ch;
      this.labelToId.set(`${r.kind}:${r.label}`, r.id);
      return item;
    });
  }

  /** 由 id 反查章節參照（搵唔到 → `null`，唔可以捏造）。 */
  private chapterRefOf(kind: SearchItem["kind"], id: string): number | null {
    switch (kind) {
      case "character":
        return this.world.charactersById.get(id)?.first_appearance ?? null;
      case "location":
        return this.world.locationsById.get(id)?.properties.first_appearance ?? null;
      case "event":
        return this.world.eventsById.get(id)?.properties.chapter ?? null;
      case "chapter": {
        // searchIndex 用 `ch_<n>` 做 chapter id（見 `src/data/searchIndex.ts`）。
        const n = Number.parseInt(id.replace(/^ch_/, ""), 10);
        return Number.isFinite(n) ? n : null;
      }
      case "zone":
        return null;
    }
  }

  /**
   * 搜尋結果被啟動（Enter / click）。
   *
   * 沿用舊 `SearchBox` 嘅導覽語意（setChapter + 必要時 setSelected*）；
   * `zone` 係新增類別 → 切 view + context（`setSelectedZone` 內部已經係
   * `store.navigate`，會寫 URL）。
   */
  private pickSearchItem(item: SearchItem): void {
    const ch = item.chapter;
    const id = this.labelToId.get(`${item.kind}:${item.label}`) ?? null;
    switch (item.kind) {
      case "chapter":
        this.goToChapter(ch ?? this.getCurrentChapter());
        return;
      case "zone":
        if (id) this.setSelectedZone(id);
        return;
      case "event":
        if (ch) this.store.setChapter(ch);
        if (id) this.setSelectedEvent(id);
        return;
      case "location":
        if (ch) this.store.setChapter(ch);
        if (id) this.setSelectedLocation(id);
        return;
      case "character":
        if (ch) this.store.setChapter(ch);
        this.focusCharacter(id);
        return;
    }
  }

  /**
   * 角色聚焦。
   *
   * `SvgMap` 暫時**冇** `flyToLocation` / `flyToZone` 公開方法（只有
   * `flyToChapter`），所以最保守做法係淨係切章節 —— 唔嘗試用私有欄位
   * 砌第二條導覽路徑。角色 dossier 內容未實作亦係已知限制（契約 §9.2）。
   */
  private focusCharacter(_characterId: string | null): void {
    /* 已有章節跳轉；角色 dossier 內容待 B6／主代理接 StoryPanel。 */
  }

  /** 引導卡 4 個主入口（spec IA §5.1）。 */
  private onOnboardingEntry(action: EntryAction): void {
    switch (action) {
      case "explore":
        // 探索地區：開 zone 圖層，令全部 48 個區域可見。
        this.store.setLayer("zones", true);
        return;
      case "character":
        this.store.setSearchKind("character");
        this.searchOverlay.open("character");
        return;
      case "event":
        this.store.setSearchKind("event");
        this.searchOverlay.open("event");
        return;
      case "chronicle":
        this.setViewMode("chronicle");
        return;
    }
  }

  /** store 變更 → 衍生 DOM 更新（規則 S2）。 */
  private onStateChange(): void {
    const s = this.store.getState();
    const prev = this.prevState;
    this.prevState = s;

    /*
     * ⚠️ 首次通知唔可以當成「章節變更」（主代理 2026-09-21 整合修正）。
     *
     * 根因：store 接線之後，`prev === null` 令 `chapterChanged` 恆為真，
     * 於是開機即刻 `flyToChapter(1)` —— 地圖由世界視圖（viewBox 寬 0.70）
     * 縮到第 1 章 location 嘅 bbox（實測 0.1475）。呢個直接違反
     * spec 決定 D3（首屏主 context = 地圖／世界視圖）同北極星 N1，
     * 亦令 `tests/phase-i.e2e.test.ts`（初始視圖 = 全港）同
     * `tests/phase-j-lod.test.ts`（全港應該係 LOD 層級 0）變紅。
     *
     * 修法：首次通知只做 DOM 同步，唔飛。之後 `hydrateFromUrl()` 由 URL
     * 還原章節時會再觸發一次通知（`first === false`）—— 所以
     * `?chapter=150` 之類嘅 deep link 仍然會正確飛去該章。
     */
    const first = !this.initialised;
    this.initialised = true;

    /*
     * B8 BottomSheet：每次 store 變更都同步衍生 DOM（規則 S2）。
     * `render()` 係冪等嘅，所以唔怕重複呼叫。
     */
    this.bottomSheet?.render(s.sheetSnap);

    const chapterChanged = first || prev!.chapter !== s.chapter;
    const contextChanged = first || prev!.context !== s.context;
    const viewChanged = first || prev!.view !== s.view;
    const themeChanged = first || prev!.theme !== s.theme;
    const snapChanged = first || prev!.sheetSnap !== s.sheetSnap;

    if (themeChanged) this.updateThemeButton(s.theme);

    if (chapterChanged) {
      this.chapterStrip.updateSelection();
      if (!first) this.svgMap.flyToChapter(s.chapter);
    }
    if (chapterChanged || contextChanged) this.svgMap.render();

    if (chapterChanged || contextChanged || viewChanged || snapChanged) {
      this.syncSurfaces(s, { chapterChanged, contextChanged, viewChanged });
    }
  }

  private syncSurfaces(
    s: AppState,
    changed: { chapterChanged: boolean; contextChanged: boolean; viewChanged: boolean },
  ): void {
    const mode = this.getViewMode();

    const dossier = this.root.querySelector<HTMLElement>("#zone-dossier-mount");
    const panel = this.root.querySelector<HTMLElement>("#story-panel-mount");
    if (dossier) dossier.hidden = mode !== "zone";
    if (panel) panel.hidden = mode === "zone";

    // 收合 class 只係衍生輸出（唔再係 state 本身）。
    const pane = this.root.querySelector<HTMLElement>("#story-pane");
    if (pane) pane.classList.toggle("is-collapsed", s.sheetSnap === COLLAPSED_SNAP);
    const toggleBtn = this.root.querySelector("#btn-toggle-panel");
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", String(s.sheetSnap !== COLLAPSED_SNAP));
    }

    const btnMode = this.root.querySelector("#btn-mode");
    if (btnMode) {
      btnMode.textContent =
        mode === "chronicle" ? "📜 編年史" : mode === "zone" ? "◈ 區域" : "📖 章節";
    }

    if (mode === "zone") {
      this.zoneDossier.update(this.selectedZoneId);
      return;
    }
    if (mode === "chronicle") {
      const onlyChapter = changed.chapterChanged && !changed.contextChanged && !changed.viewChanged;
      if (onlyChapter) this.chronicleView.setChapterFilter(s.chapter);
      else this.chronicleView.render();
      return;
    }

    const ctx = s.context;
    if (ctx.kind === "location") this.storyPanel.updateForLocation(ctx.locationId);
    else if (ctx.kind === "event") this.storyPanel.updateForEvent(ctx.eventId);
    else this.storyPanel.updateForChapter(s.chapter);
  }

  private updateThemeButton(theme: "dark" | "light"): void {
    const btn = this.root.querySelector("#btn-theme");
    if (!btn) return;
    btn.textContent = theme === "dark" ? "🌙" : "☀️";
    btn.setAttribute(
      "title",
      theme === "dark" ? "切換到淺色主題" : "切換到深色主題",
    );
  }

  private bindKeys(): void {
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft" || e.key === "j") {
        e.preventDefault();
        this.store.setChapter(this.getCurrentChapter() - 1);
      } else if (e.key === "ArrowRight" || e.key === "k") {
        e.preventDefault();
        this.store.setChapter(this.getCurrentChapter() + 1);
      } else if (e.key === "Home") {
        this.store.setChapter(1);
      } else if (e.key === "End") {
        this.store.setChapter(this.getChapterTotal());
      } else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        // 快捷鍵提示（`?` 係 Shift+/，所以要分開判斷）
        e.preventDefault();
        this.aboutModal.show();
      } else if (e.key === "/") {
        e.preventDefault();
        this.searchOverlay.open(this.store.getState().searchKind);
      } else if (e.key === "Escape") {
        /*
         * Esc 優先次序：**先關浮層，再清 context**。
         * 冇分先後嘅話，開咗嘅 modal 按 Esc 冇反應（實測踩過）。
         *
         * B8 次序（契約 §7 W4）：
         *   1. 搜尋 overlay（`SearchOverlay` 自己 handle）→ 關 + return
         *   2. bottom sheet（`full` → `half` → `peek`）→ 消費就 return
         *   3. 原有浮層（About modal）→ 關 + return
         *   4. 最後才清 selection context
         */
        if (this.searchOverlay.isOpen()) {
          this.searchOverlay.close();
          return;
        }
        if (this.bottomSheet?.handleEsc()) return;
        if (this.aboutModal.isOpen()) {
          this.aboutModal.hide();
          return;
        }
        this.store.setContext({ kind: "explore" });
      }
    });
  }

  /**
   * 複製目前狀態嘅可分享連結。
   *
   * 用 `navigator.clipboard`，唔支援就退回 `execCommand`（舊瀏覽器／
   * 非 HTTPS 環境）。兩者都失敗就彈出 prompt 讓用戶自己複製。
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
   * 匯出目前地圖視圖為 PNG（檔名用章節號，例如 `binggang-ch150.png`）。
   */
  private async exportCurrentMap(): Promise<void> {
    const btn = this.root.querySelector("#btn-export") as HTMLButtonElement | null;
    const svg = this.root.querySelector<SVGSVGElement>("#svg-map");
    if (!svg) return;
    // 向量底圖係獨立嘅 <canvas>，唔喺 SVG 樹入面 —— 匯出要另外傳入。
    const underlay = this.root.querySelector<HTMLCanvasElement>("#basemap-canvas");
    const prev = btn?.textContent ?? "⬇";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    try {
      const r = await exportMapPng(svg, {
        scale: 2,
        filename: `binggang-ch${this.getCurrentChapter()}`,
        background:
          document.documentElement.getAttribute("data-theme") === "light"
            ? "#f4f1ea"
            : "#0b0f16",
        underlay,
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
}

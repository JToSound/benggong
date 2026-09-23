/**
 * SearchOverlay.ts — 5 類搜尋 overlay（B8）
 *
 * 為何要呢個檔（A7 P0-4 / P0-5 / P2-4 / P2-5）
 * ==========================================
 * 舊 `SearchBox.ts`（唔喺 B8 allowlist）有四個結構問題：
 *
 *   1. **冇 dialog 語意** —— `#search-modal` 冇 `role`、冇 `aria-modal`、
 *      冇 `aria-labelledby`；全頁 `role="dialog"` 數量 = 0。
 *   2. **冇 focus trap** —— 由 modal 內 Tab 2 次（`#search-close` → BODY）
 *      就逃離到背景。背景 `#app-root` 亦冇 `inert`。
 *   3. **Esc 後 focus 卡死** —— Esc 之後 `document.activeElement` 仍然係
 *      隱藏嘅 `#search-input`（`hiddenStillFocusable: true`），連鎖令
 *      `app.ts:420` 嘅 `if (target instanceof HTMLInputElement) return`
 *      令之後**所有**快捷鍵（`←`/`→`/`/`/`?`）靜默失效。
 *   4. **結果唔可鍵盤操作** —— 結果係 `<li>` + click-only，`tabIndex = -1`、
 *      冇 `role`、冇 `aria-activedescendant`。ArrowDown 之後 focus 仍然喺
 *      `#search-input`，Enter 唔會啟動任何結果（Journey C/D 第 3 步就斷）。
 *
 * 另外 spec IA §8 要求 **5 類**（character / zone / location / event /
 * chapter），舊版只有 3 類（`typeLabel()` fallback「地點」），而且有
 * `results.slice(0, 50)` 硬上限。
 *
 * 契約（見 `docs/contracts/b8-interface-contract.md` §6）
 * ------------------------------------------------
 *   · 結果由外部注入（`search()` callback）→ 本元件**零資料依賴**，
 *     可以 node 單測（規則 C1：唔可以自己 fetch）。
 *   · 開啟時對 `#app-root` 加 `inert`；關閉時移除 + focus 還原。
 *   · 鍵盤：↑↓ 改 `aria-activedescendant`、Enter 啟動、Esc 關閉、Tab 困住。
 */

import type { SearchKind } from "../types/state";

/** 一個搜尋結果（呈現用；唔含 domain 物件，保持可測）。 */
export interface SearchItem {
  kind: SearchKind;
  /**
   * 實體 id（`selectSearchResults()` 回傳嘅 `r.id`）。
   *
   * 啟動結果時（`onPick`）要靠呢個 id 去 `setSelectedZone` /
   * `setSelectedEvent` / `focusCharacter` —— 冇 id 就砌唔到導覽。
   */
  id: string;
  /** 主標（人名 / 地點名 / 事件標題 / 章節標題）。 */
  label: string;
  /** 次標（例如 zone 類型、角色別名）。 */
  sublabel?: string;
  /** 章節參照（顯示 `ch12`）。 */
  chapter?: number;
}

export interface SearchOverlayOptions {
  /** overlay 附加喺邊（通常 `document.body` 或 `#app-root`）。 */
  root: HTMLElement;
  /** 查詢（由 B3 adapter / app 注入；本元件唔自己存取資料）。 */
  search(kind: SearchKind | null, query: string): SearchItem[];
  /** 結果被啟動（Enter / click）。 */
  onPick(item: SearchItem): void;
  /** 關閉前嘅 focus 還原目標（通常 `#btn-search`）。 */
  restoreFocus: () => HTMLElement | null;
  /** 目前搜尋種類（可選；唔傳就顯示全部 5 類）。 */
  initialKind?: SearchKind | null;
}

/** 5 類嘅粵文標籤（spec IA §8）。 */
export const KIND_LABEL: Record<SearchKind, string> = {
  character: "角色",
  zone: "區域",
  location: "地點",
  event: "事件",
  chapter: "章節",
};

/** 固定次序（令結果分組穩定、可測）。 */
export const KIND_ORDER: readonly SearchKind[] = [
  "character",
  "zone",
  "location",
  "event",
  "chapter",
] as const;

/** 每類最多顯示幾多條（取代舊版全局限 50 —— 呢度係**每類**上限）。 */
export const PER_KIND_LIMIT = 20;

/** 點樣由鍵搵下一個 active index（抽做純函數方便單測）。 */
export function moveActive(cur: number, dir: number, total: number): number {
  if (total <= 0) return -1;
  if (cur < 0) return dir > 0 ? 0 : total - 1;
  return Math.min(total - 1, Math.max(0, cur + dir));
}

/** 由 query + kind 過濾 → 分組（純函數；可單測）。 */
export function groupItems(
  items: SearchItem[],
  limit = PER_KIND_LIMIT,
): Array<{ kind: SearchKind; items: SearchItem[] }> {
  const groups: Array<{ kind: SearchKind; items: SearchItem[] }> = [];
  const byKind = new Map<SearchKind, SearchItem[]>();
  for (const it of items) {
    const arr = byKind.get(it.kind);
    if (arr) arr.push(it);
    else byKind.set(it.kind, [it]);
  }
  // 固定次序，令輸出 deterministic（唔跟 Map 插入次序）
  for (const k of KIND_ORDER) {
    const arr = byKind.get(k);
    if (arr && arr.length > 0) groups.push({ kind: k, items: arr.slice(0, limit) });
  }
  return groups;
}

export class SearchOverlay {
  private root: HTMLElement;
  private opts: SearchOverlayOptions;
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private results: HTMLElement | null = null;
  /** 目前已渲染嘅結果（flatten，次序同 DOM 一致）。 */
  private flat: SearchItem[] = [];
  private active = -1;
  /** 開啟前嘅 focus 目標（還原用）。 */
  private prevFocus: HTMLElement | null = null;
  private bound: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];

  constructor(opts: SearchOverlayOptions) {
    this.root = opts.root;
    this.opts = opts;
  }

  /** 建立 DOM（只做一次）；`open()` 亦會自動叫。 */
  private build(): void {
    if (this.overlay) return;
    const el = document.createElement("div");
    el.className = "search-overlay";
    el.id = "search-overlay";
    /*
     * P0-4：dialog 語意。`aria-modal="true"` 告訴 AT 背景係 inert；
     * `aria-labelledby` 指向可見標題（唔用 `aria-label` —— 令譯文可共用）。
     */
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "search-overlay-title");
    el.innerHTML = `
      <div class="search-panel">
        <div class="search-head">
          <h2 id="search-overlay-title" class="sheet-title">搜尋</h2>
          <input type="text" id="search-input" class="search-input"
                 placeholder="搜角色、區域、地點、事件、章節…"
                 role="combobox" aria-expanded="true" aria-controls="search-results"
                 aria-autocomplete="list" autocomplete="off" spellcheck="false" />
          <button id="search-close" class="search-close" type="button" aria-label="關閉搜尋">×</button>
        </div>
        <div class="search-results" id="search-results" role="listbox"
             aria-label="搜尋結果" tabindex="-1">
          <p class="search-hint">輸入關鍵字…</p>
        </div>
        <p class="a11y-live" id="search-live" role="status" aria-live="polite"></p>
      </div>
    `;
    this.root.appendChild(el);
    this.overlay = el;
    this.input = el.querySelector<HTMLInputElement>("#search-input");
    this.results = el.querySelector<HTMLElement>("#search-results");

    const on = (target: EventTarget, type: string, fn: EventListener): void => {
      target.addEventListener(type, fn);
      this.bound.push({ el: target, type, fn });
    };

    if (this.input) {
      on(this.input, "input", () => this.renderResults());
    }
    /*
     * ⚠️ keydown **一定要綁喺 overlay**（唔可以只綁 `#search-input`）。
     *
     * 綁 input 嘅話，focus 一移到 `#search-close`（另一個 focusable），
     * `Tab` / `Escape` 就冇 handler 接 —— 原生 Tab 會走出 overlay 落到
     * `document.body`（實測 Tab 序：input → close → BODY → input…），
     * 即 focus trap 失效（P0-4）。
     */
    on(el, "keydown", ((e: KeyboardEvent) => {
      this.handleKeydown(e);
    }) as EventListener);
    el.querySelector("#search-close")?.addEventListener("click", () => this.close());

    // 點 backdrop 關閉（唔可以點 panel 內部）
    on(el, "click", ((e: MouseEvent) => {
      if (e.target === el) this.close();
    }) as EventListener);

    // 結果 click（用 delegation，避免每次 render 重綁）
    if (this.results) {
      on(this.results, "click", ((e: MouseEvent) => {
        const li = (e.target as Element).closest<HTMLElement>(".search-result-item");
        if (!li) return;
        const idx = Number(li.dataset.idx);
        const item = this.flat[idx];
        if (item) this.commit(item);
      }) as EventListener);
    }
  }

  open(kind?: SearchKind | null): void {
    this.build();
    if (!this.overlay) return;
    this.prevFocus = document.activeElement as HTMLElement | null;
    this.overlay.classList.add("is-open");
    this.input?.setAttribute("aria-controls", "search-results");
    /*
     * P0-4：背景隔離。`inert` 令背景唔可 Tab + 唔入 AT
     * （比 `aria-hidden` 強 —— 兩者一齊用會出現「AT 睇唔到但 Tab 到」）。
     */
    const appRoot = document.getElementById("app-root");
    if (appRoot && appRoot !== this.root) appRoot.setAttribute("inert", "");
    if (this.input) {
      this.input.value = "";
      if (kind) this.input.setAttribute("data-kind", kind);
      else this.input.removeAttribute("data-kind");
    }
    this.active = -1;
    this.renderResults();
    // focus 一定要喺 open 之後（避免 scroll / 動畫搶焦點）
    this.input?.focus();
  }

  close(): void {
    if (!this.overlay?.classList.contains("is-open")) return;
    this.overlay.classList.remove("is-open");
    const appRoot = document.getElementById("app-root");
    if (appRoot && appRoot !== this.root) appRoot.removeAttribute("inert");
    /*
     * P0-4：**必須**還原 focus。
     *
     * 唔還原嘅話，`document.activeElement` 會留喺（已經隱藏嘅）`#search-input`，
     * 令 `app.ts:420` 嘅 `if (target instanceof HTMLInputElement) return`
     * 之後所有快捷鍵靜默失效（A7 實測：`←`/`→` 無效、`/` 無效、`?` 無效）。
     */
    const target = this.opts.restoreFocus() ?? this.prevFocus;
    if (target && typeof target.focus === "function") {
      target.focus();
    } else {
      // 冇明確目標 → 模糊到 body，**唔可以**留喺隱藏 input
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    this.prevFocus = null;
  }

  isOpen(): boolean {
    return Boolean(this.overlay?.classList.contains("is-open"));
  }

  /** 目前 results 容器（測試用）。 */
  get resultsEl(): HTMLElement | null {
    return this.results;
  }

  /** 目前 active index（測試用）。 */
  get activeIndex(): number {
    return this.active;
  }

  /**
   * 鍵盤處理（公開，方便 e2e 直接派事件 / 單測）。
   *
   * @returns 有冇消費事件。
   */
  handleKeydown(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.setActive(moveActive(this.active, 1, this.flat.length));
        return true;
      case "ArrowUp":
        e.preventDefault();
        this.setActive(moveActive(this.active, -1, this.flat.length));
        return true;
      case "Enter": {
        const item = this.flat[this.active];
        if (item) {
          e.preventDefault();
          this.commit(item);
          return true;
        }
        return false;
      }
      case "Escape":
        e.preventDefault();
        this.close();
        return true;
      case "Tab":
        // P0-4：focus trap —— 循環喺 overlay 內
        return this.trapTab(e);
      default:
        return false;
    }
  }

  /**
   * Tab 循環（focus trap）。
   *
   * ⚠️ 為何唔可以用「到咗 first/last 才介入」嘅教科書做法：
   * `#app-root` 開 modal 時被設 `inert`，而 overlay 掛喺**兄弟**節點
   * `#search-shell`。當 focus 喺 `#search-close`（DOM 次序上係**第一個**）
   * 而唔係最後一個時，瀏覽器原生 Tab **唔會** wrap，反而會走出 overlay
   * 落到 `document.body`（實測：Tab 序 = input → close → BODY → input…）。
   *
   * 所以策略改為：**只要 focus 喺 overlay 內，就自己完全接管 Tab**，
   * 明確計出「下一個 / 上一個」可聚焦元素並 wrap，再 `preventDefault()`。
   * 呢個做法唔依賴「邊個係 first / last」，對 DOM 次序亦冇假設。
   */
  private trapTab(e: KeyboardEvent): boolean {
    if (!this.overlay) return false;
    const focusables = Array.from(
      this.overlay.querySelectorAll<HTMLElement>(
        'button, input, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === this.input);
    if (focusables.length === 0) return false;

    const cur = document.activeElement as HTMLElement | null;
    const i = cur ? focusables.indexOf(cur) : -1;
    // focus 唔喺 overlay 內（例如被外部搶走）→ 拉返第一個
    const next =
      i < 0
        ? focusables[0]
        : e.shiftKey
          ? focusables[(i - 1 + focusables.length) % focusables.length]
          : focusables[(i + 1) % focusables.length];

    e.preventDefault();
    next.focus();
    return true;
  }

  private setActive(idx: number): void {
    if (idx === this.active) return;
    this.active = idx;
    if (!this.results) return;
    const opts = this.results.querySelectorAll<HTMLElement>(".search-result-item");
    opts.forEach((el, i) => {
      const on = i === idx;
      el.setAttribute("aria-selected", String(on));
      el.classList.toggle("is-active", on);
    });
    // P0-5：`aria-activedescendant` 係 combobox 嘅唯一可觀察「當前項」
    if (this.input) {
      if (idx >= 0 && opts[idx]) this.input.setAttribute("aria-activedescendant", opts[idx].id);
      else this.input.removeAttribute("aria-activedescendant");
    }
    this.scrollOptionIntoView(opts[idx]);
    this.announce();
  }

  /**
   * 令 active 選項捲入可視範圍 —— **唔用 `scrollIntoView`**。
   *
   * 規矩 C1（A7 P0-2）：`scrollIntoView` 會移動 Chromium 嘅 sequential
   * focus 起始點，令關閉 modal 之後 Tab 序由頭開始。呢度自己算
   * `scrollTop`，效果一樣但**唔會**郁 focus 起始點。
   */
  private scrollOptionIntoView(el: HTMLElement | undefined): void {
    if (!el) return;
    const list = this.overlay?.querySelector<HTMLElement>(".search-list");
    if (!list) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }

  /** `aria-live` 播報（P1-3）。 */
  private announce(): void {
    const live = this.overlay?.querySelector<HTMLElement>("#search-live");
    if (!live) return;
    if (this.active >= 0 && this.flat[this.active]) {
      const it = this.flat[this.active];
      live.textContent = `第 ${this.active + 1} 個，共 ${this.flat.length} 個：${KIND_LABEL[it.kind]} ${it.label}`;
    } else {
      live.textContent = this.flat.length === 0 ? "冇結果" : `共 ${this.flat.length} 個結果`;
    }
  }

  /** 由 input 值重算結果（每次 render 都重建 DOM —— 結果數量細，可接受）。 */
  private renderResults(): void {
    if (!this.results || !this.input) return;
    const q = this.input.value.trim();
    const kindAttr = this.input.getAttribute("data-kind") as SearchKind | null;
    if (q.length === 0) {
      this.flat = [];
      this.active = -1;
      this.input.removeAttribute("aria-activedescendant");
      this.results.innerHTML = `<p class="search-hint">輸入關鍵字…（5 類：角色／區域／地點／事件／章節）</p>`;
      this.announce();
      return;
    }

    const raw = this.opts.search(kindAttr, q);
    const groups = groupItems(raw);
    this.flat = groups.flatMap((g) => g.items);

    if (this.flat.length === 0) {
      this.results.innerHTML = `<p class="search-hint">冇結果</p>`;
      this.active = -1;
      this.input.removeAttribute("aria-activedescendant");
      this.announce();
      return;
    }

    let html = "";
    let idx = 0;
    for (const g of groups) {
      html += `<div class="search-group"><p class="search-group-head">${KIND_LABEL[g.kind]}</p><ul class="search-result-list">`;
      for (const it of g.items) {
        const id = `search-opt-${idx}`;
        html +=
          `<li id="${id}" class="search-result-item" role="option" aria-selected="false" data-idx="${idx}">` +
          `<span class="result-type type-${it.kind}">${KIND_LABEL[it.kind]}</span>` +
          `<span class="result-name">${escapeHtml(it.label)}</span>` +
          (it.chapter ? `<span class="result-ch">ch${it.chapter}</span>` : "") +
          `</li>`;
        idx++;
      }
      html += `</ul></div>`;
    }
    this.results.innerHTML = html;

    // 保留現有 active（如果範圍內），否則 reset
    const keep = this.active >= 0 && this.active < this.flat.length ? this.active : -1;
    this.active = -1;
    this.setActive(keep);
    this.announce();
  }

  /** 啟動一個結果（Enter / click 共用）。 */
  private commit(item: SearchItem): void {
    this.opts.onPick(item);
    this.close();
  }

  destroy(): void {
    for (const { el, type, fn } of this.bound) el.removeEventListener(type, fn);
    this.bound = [];
    this.overlay?.remove();
    this.overlay = null;
    const appRoot = document.getElementById("app-root");
    if (appRoot && appRoot !== this.root) appRoot.removeAttribute("inert");
  }
}

/** HTML escape（結果內容可能含使用者輸入／小說文字）。 */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

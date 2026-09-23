/**
 * ChronicleView — 編年史體驗（B7）
 *
 * 設計理念（見 `docs/CHRONICLE_DESIGN.md`）
 * ========================================
 * 用戶原話：「唔係想逐個章節嘅內容展示，而係應該消化晒成個第一季……
 * 好似編年史噉樣展示，當中嘅有啲內容可能喺後續嘅篇章先會回帶返過去，
 * 去補完先前嘅伏筆。」
 *
 * 核心：一條條目 = **故事世界入面嘅一件事**，並區分
 *   - `story_time`            —— 件事幾時發生（故事內時間）
 *   - `first_mention_chapter` —— 讀者幾時第一次知
 *
 * 兩者唔同嘅時候就係「回帶」—— 呢個係編年史嘅價值所在。
 *
 * V2（B7）改咗咩
 * =============
 * A3 §4.3 / A7 P0-5 / A2 §8 指出 V1 有四個結構問題：
 *   1. **私有 state**（`filterChapter` / `expanded`）→ 違反規則 S1；
 *   2. **零 a11y**（冇 role / aria / 鍵盤導航）；
 *   3. **1,320 條 eager render**（1320 個 `<article>`）→ 規則 C1 要求 virtualized；
 *   4. 自己重複聲明 `ChronicleEntry` interface（同 `loadAllData` 漂移風險）。
 *
 * V2 做法：
 *   · 選中狀態 → **B2 store**（`context.filters.chapter` / `pendingFocus`）；
 *   · 資料 → **B3 adapter**（`World` + `indexes.chronicleByPeriod`），唔自己 fetch；
 *   · 時長／緩動 → **B1 token**（`motion.ts` 嘅 `DUR` / `scrollElementTo`）；
 *   · 渲染 → **窗口化**（`virtual.ts`），只 render 可見 + overscan 條目；
 *   · a11y → `role` / `aria-*` / 鍵盤（`a11y.ts`）；
 *   · 型別 → 由 `data/loadAllData` **import**，唔再重複聲明（A3 §4.3）。
 *
 * ⚠️ 為何 render 分兩層（`renderToString()` 純函數 + `render()` 落 DOM）
 * -------------------------------------------------------------------
 * `environment: node` 冇 DOM。要驗「時期分群 / 章節 chip / ARIA 屬性」，
 * 就一定要有一段**唔摸 DOM** 嘅 HTML 產生邏輯。所以：
 *   · `renderToString()` —— 純函數（輸入 state → 輸出 HTML 字串）；
 *   · `render()`         —— 把字串放入 root，然後 `bind()` 事件。
 * 兩層都唔可以互相讀對方嘅結果（規則 S2：唔可以由 DOM 讀返邏輯狀態）。
 */

import type { App } from "../app";
import type { ChronicleEntry, ChronicleDoc } from "../data/loadAllData";
import type { AppState } from "../types/state";
import { icon } from "../ui/icons";
import { DUR, scrollElementTo, type MotionHandle } from "../motion";
import {
  ACCEPTED_PERIOD_SOURCES,
  PERIOD_LABEL,
  PERIOD_ORDER,
  UNKNOWN_PERIOD_KEY,
  UNKNOWN_PERIOD_LABEL,
  groupByPeriod,
  labelForPeriodKey,
  periodKeyOf,
  sortEntries,
  type PeriodGroup,
} from "./chronicle/period";
import {
  resolveAllRelations,
  foreshadowsOf,
  paysOffOf,
  type ForeshadowPair,
  type ForeshadowResolution,
} from "./chronicle/foreshadow";
import {
  OVERSCAN,
  ROW_H,
  WINDOW_MAX,
  computeWindow,
  indexOfEntry,
  offsetOf,
  type WindowRange,
} from "./chronicle/virtual";
import {
  matchesChapter,
  matchesQuery,
  toExported,
  toItem,
  type ChronicleItem,
} from "./chronicle/model";
import {
  CHRONICLE_ARIA,
  ariaChapterChip,
  ariaEntry,
  ariaForeshadow,
  ariaPeriod,
  ariaToggle,
  entryBodyDomId,
  entryDomId,
  keyAction,
  nextIndex,
} from "./chronicle/a11y";

// ─────────────────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────────────────

/** 抽像出「可以讀取」嘅世界（B3 `World` 唔 import —— 避免 B7 綁死 B3）。 */
export interface ChronicleWorld {
  indexes: {
    chronicleByPeriod: ReadonlyMap<string, ChronicleEntry[]>;
  };
}

/** 選中狀態嘅快照（render 時唯一輸入 —— 唔可以喺 render 內讀 store）。 */
export interface ChronicleSnapshot {
  /** 章節篩選（`null` = 全部章節）。 */
  chapter: number | null;
  /** 編年史內搜尋 query。 */
  query: string;
  /** a11y focus 目標（`pendingFocus`）。 */
  focusId: string | null;
  /** 多媒體／窄螢幕（影響 rail 排版提示；唔影響資料）。 */
  compact: boolean;
}

/** 由 URL / store 衍生快照（純函數；測試可以直接餵 store state）。 */
export function snapshotOf(state: AppState): ChronicleSnapshot {
  const filters =
    state.context.kind === "chronicle" ? state.context.filters : null;
  return {
    chapter: filters?.chapter ?? null,
    query: filters?.query ?? "",
    focusId: state.pendingFocus,
    compact: state.sheetSnap !== "full",
  };
}

/** 由 store 建快照（`App` 只提供 `store`，唔會 leak 其他嘢）。 */
function storeSnapshot(app: App): ChronicleSnapshot {
  try {
    return snapshotOf(app.store.getState());
  } catch {
    // store 未接好（例如舊測試直接 new ChronicleView）→ 安全默認。
    return { chapter: null, query: "", focusId: null, compact: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 元件
// ─────────────────────────────────────────────────────────────────────────────

export class ChronicleView {
  private root: HTMLElement;
  private app: App;
  private doc: ChronicleDoc;
  /** 目前展開嘅條目 id（DOM 焦點狀態；見 `b7-interface-contract.md` §2.2 B7-D1）。 */
  private expanded: string | null = null;
  /** 目前鍵盤 focus 嘅條目 index（扁平次序）。 */
  private focusIndex = -1;
  /** 捲動動效 handle（同一時間只可以有一個）。 */
  private scrollMotion: MotionHandle | null = null;
  private unsubscribe: (() => void) | null = null;
  /** 已解析嘅伏筆關係（每次 render 重算；1,320 條成本 <1 ms）。 */
  private relations: ForeshadowResolution = { pairs: [], dropped: [], rawEdges: 0 };
  /** 目前渲染用嘅扁平次序（`focusIndex` 同捲動都用佢做 index 空間）。 */
  private flat: ChronicleEntry[] = [];
  private onScroll: (() => void) | null = null;

  constructor(root: HTMLElement, app: App, doc: ChronicleDoc) {
    this.root = root;
    this.app = app;
    this.doc = doc;
    this.relations = resolveAllRelations(this.doc.entries ?? []);
    // 訂閱 store（規則 S1：狀態一變就重繪）。node 測試冇 store → 跳過。
    if (typeof this.app?.store?.subscribe === "function") {
      this.unsubscribe = this.app.store.subscribe(() => this.render());
    }
    this.render();
  }

  /** 解除訂閱 + 動效（測試／熱重載用，避免 listener 洩漏）。 */
  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.scrollMotion?.cancel();
    this.scrollMotion = null;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 衍生讀取（全部由快照 + doc 算，唔讀 DOM）
  // ───────────────────────────────────────────────────────────────────────

  private snapshot(): ChronicleSnapshot {
    return this.app ? storeSnapshot(this.app) : { chapter: null, query: "", focusId: null, compact: false };
  }

  /**
   * 條目嘅時期標籤（未判斷就回 `null`）。
   *
   * ⚠️ 邏輯已經搬入 `chronicle/period.ts` 嘅 `periodKeyOf()` —— 佢係
   * **唯一**判斷「有冇時期」嘅地方，並且接受 `llm_period` 同
   * `chapter_boundary` 兩個 source（`docs/CHRONICLE_DESIGN.md` §6.8 嘅 391 條陷阱）。
   */
  private periodOf(e: ChronicleEntry): string | null {
    const key = periodKeyOf(e);
    return key ? PERIOD_LABEL[key] : null;
  }

  /** 篩選後、已排序嘅條目（時期 → 章節 → 標題）。 */
  visibleEntries(): ChronicleEntry[] {
    const snap = this.snapshot();
    const list = (this.doc.entries ?? []).filter(
      (e) => matchesChapter(e, snap.chapter) && matchesQuery(e, snap.query),
    );
    return sortEntries(list);
  }

  /** 按時期分組（時期係編年史嘅骨幹）。 */
  grouped(): PeriodGroup[] {
    return groupByPeriod(this.visibleEntries());
  }

  // ───────────────────────────────────────────────────────────────────────
  // 純字串渲染（node 測試得到；唔摸 DOM）
  // ───────────────────────────────────────────────────────────────────────

  private esc(s: string): string {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 章節 chip 群。 */
  private renderChapterChips(item: ChronicleItem): string {
    if (item.chapters.length === 0) return "";
    const chips = item.chapters
      .map(
        (c) =>
          `<button type="button" class="chr-ch" data-ch="${c.chapter}"` +
          ` aria-label="${this.esc(ariaChapterChip(c.chapter))}"` +
          ` title="${this.esc(c.title)}">` +
          `ch${c.chapter}<span class="chr-ch-role">${this.esc(c.roleLabel)}</span></button>`,
      )
      .join("");
    return `<div class="chr-chapters">${chips}</div>`;
  }

  /** 伏筆／解答連結（只顯示**已驗證**嘅 pair）。 */
  private renderLinks(id: string): string {
    const byId = new Map((this.doc.entries ?? []).map((x) => [x.id, x]));
    const chip = (p: ForeshadowPair, cls: string, arrow: string, otherId: string) => {
      const other = byId.get(otherId);
      if (!other) return "";
      const title = other.title;
      return (
        `<button type="button" class="chr-link ${cls}" data-goto="${this.esc(otherId)}"` +
        ` title="${this.esc(title)}（相隔 ${p.gap} 章）"` +
        ` aria-label="${this.esc(ariaForeshadow(title, other.first_mention_chapter))}">` +
        `${arrow} ${this.esc(title.slice(0, 18))}` +
        `<span class="chr-link-gap">+${p.gap}` +
        `</span></button>`
      );
    };
    const po = paysOffOf(id, this.relations.pairs)
      .map((p) => chip(p, "is-po", "↩", p.toId))
      .join("");
    const fs = foreshadowsOf(id, this.relations.pairs)
      .map((p) => chip(p, "is-fs", "→", p.toId))
      .join("");
    if (!po && !fs) return "";
    return (
      `<div class="chr-links">` +
      (fs
        ? `<div class="chr-links-row"><span class="chr-links-label">→ 埋下伏筆</span>${fs}</div>`
        : "") +
      (po
        ? `<div class="chr-links-row"><span class="chr-links-label">↩ 解答咗</span>${po}</div>`
        : "") +
      `</div>`
    );
  }

  /**
   * 單條條目卡。
   *
   * ⚠️ 只 render「可見 + overscan」範圍 —— 呢個 function 唔可以自己決定
   * 要唔要 render（window 由 `computeWindow()` 決定，見 §4.3 契約）。
   */
  renderEntry(entry: ChronicleEntry, flatIndex: number): string {
    const item = toItem(entry, this.periodOf(entry));
    const isOpen = this.expanded === entry.id;
    const isFocused = this.focusIndex === flatIndex;
    const cls =
      "chr-entry" +
      (item.flashback ? " is-flashback" : "") +
      (isFocused ? " is-focused" : "");

    return (
      `<article class="${cls}" role="listitem" id="${this.esc(entryDomId(entry.id))}"` +
      ` data-entry-id="${this.esc(entry.id)}" data-flat-index="${flatIndex}"` +
      ` aria-expanded="${isOpen ? "true" : "false"}"` +
      ` aria-label="${this.esc(ariaEntry(item.title, item.firstMentionChapter))}">` +
      `<header class="chr-entry-head">` +
      `<span class="chr-mark" aria-hidden="true">${item.flashback ? "↩" : "●"}</span>` +
      `<h4 class="chr-entry-title" tabindex="-1">${this.esc(item.title)}</h4>` +
      `</header>` +
      `<div class="chr-entry-meta">` +
      (item.flashback
        ? `<span class="chr-flag">回帶 · 補完伏筆</span>`
        : "") +
      (item.locationName
        ? `<span class="chr-loc">${this.esc(item.locationName)}</span>`
        : "") +
      `<span class="chr-conf is-${item.confidence}">${this.esc(item.confidenceLabel)}</span>` +
      (item.needsReview ? `<span class="chr-review">待核</span>` : "") +
      `</div>` +
      this.renderChapterChips(item) +
      `<div id="${this.esc(entryBodyDomId(entry.id))}" class="chr-entry-body"${isOpen ? "" : " hidden"}>` +
      `<p class="chr-entry-summary">${this.esc(item.summary)}</p>` +
      this.renderLinks(entry.id) +
      `</div>` +
      `<button type="button" class="chr-btn chr-toggle" data-toggle="${this.esc(entry.id)}"` +
      ` aria-expanded="${isOpen ? "true" : "false"}"` +
      ` aria-controls="${this.esc(entryBodyDomId(entry.id))}"` +
      ` aria-label="${this.esc(ariaToggle(item.title, isOpen))}">` +
      `${icon(isOpen ? "ic-chevron-down" : "ic-chevron-right", { size: 14 })}` +
      `${isOpen ? "收起" : "展開"}</button>` +
      `</article>`
    );
  }

  /** 時期導覽（rail）：每期一粒，`aria-current` 標示目前所在。 */
  renderRail(groups: PeriodGroup[], activeKey: string | null): string {
    if (groups.length === 0) return "";
    const items = groups
      .map(
        (g) =>
          `<button type="button" class="chr-rail-item" data-rail="${this.esc(g.key)}"` +
          ` aria-current="${g.key === activeKey ? "true" : "false"}"` +
          ` aria-label="${this.esc(ariaPeriod(g.key, g.label, g.items.length))}">` +
          `<span>${this.esc(g.label)}</span>` +
          `<span class="chr-rail-count">${g.items.length}</span></button>`,
      )
      .join("");
    return `<nav class="chr-rail" aria-label="${this.esc(CHRONICLE_ARIA.periodNavLabel)}">${items}</nav>`;
  }

  /**
   * 條目流（已 virtualize）。
   *
   * 為何仍然分 `<section class="chr-period">`：時期係故事骨架，用戶要見到
   * 「呢段係大本營時期」。窗口化只影響**邊幾條 render**，唔影響分組結構。
   * 所以做法係：先 flatten（line: 見 `flat`），再用窗口取 slice，
   * 然後**按時期**把 slice 入面嘅條目分返組。
   */
  renderBody(groups: PeriodGroup[], flat: ChronicleEntry[], win: WindowRange): string {
    const slice = flat.slice(win.start, win.end);
    if (slice.length === 0) {
      return (
        `<div class="chronicle-body-wrap">` +
        `<p class="chronicle-empty">呢個篩選未有編年史條目。</p></div>`
      );
    }
    const indexOf = new Map(flat.map((e, i) => [e.id, i]));
    // 只保留 slice 入面有條目嘅時期。
    const sections: string[] = [];
    for (const g of groups) {
      const inWindow = g.items.filter((e) => {
        const i = indexOf.get(e.id);
        return i !== undefined && i >= win.start && i < win.end;
      });
      if (inWindow.length === 0) continue;
      const cards = inWindow
        .map((e) => this.renderEntry(e, indexOf.get(e.id)!))
        .join("");
      sections.push(
        `<section class="chr-period" data-period="${this.esc(g.key)}">` +
          `<h3 class="chr-period-title">` +
          `<span class="chr-period-line" aria-hidden="true"></span>` +
          `${this.esc(g.label)}` +
          `<span class="chr-period-count">${g.items.length}</span></h3>` +
          cards +
          `</section>`,
      );
    }
    return (
      `<div class="chronicle-body-wrap" tabindex="0" role="group"` +
      ` aria-label="${this.esc(CHRONICLE_ARIA.regionLabel)}">` +
      `<div class="chronicle-body">` +
      `<div class="chr-spacer" style="height:${win.padTop}px" aria-hidden="true"></div>` +
      sections.join("") +
      `<div class="chr-spacer" style="height:${win.padBottom}px" aria-hidden="true"></div>` +
      `</div></div>`
    );
  }

  /**
   * 完整視圖（純字串）。
   *
   * @param opts 可選：覆寫捲動位置同容器高度（測試用；browser 由 DOM 量）。
   */
  renderToString(opts?: { scrollTop?: number; viewportH?: number }): string {
    const snap = this.snapshot();
    const groups = this.grouped();
    const flat = groups.flatMap((g) => g.items);
    this.flat = flat;

    const total = flat.length;
    const win = computeWindow(
      total,
      opts?.scrollTop ?? this.currentScrollTop(),
      opts?.viewportH ?? this.currentViewportH(),
      OVERSCAN,
    );

    const filterLabel =
      snap.chapter === null ? "全部章節" : `第 ${snap.chapter} 章相關`;

    const activeKey = this.activePeriodKey(groups);

    return (
      `<div class="chronicle" data-state="ready">` +
      `<header class="chronicle-head">` +
      `<h2>第一季編年史</h2>` +
      `<p class="chronicle-sub">` +
      `按<strong>故事時間</strong>排列，唔係敍事次序。` +
      `<span class="chronicle-count" aria-live="polite" id="${CHRONICLE_ARIA.countLiveRegion}">` +
      `${total} 條 · ${this.esc(filterLabel)}</span></p>` +
      `<div class="chr-actions">` +
      `<label class="chr-search">` +
      `${icon("ic-search", { size: 14 })}` +
      `<input type="search" id="chr-search-input" value="${this.esc(snap.query)}"` +
      ` placeholder="喺編年史入面搵…" aria-label="${this.esc(CHRONICLE_ARIA.searchLabel)}">` +
      `</label>` +
      (snap.chapter !== null
        ? `<button type="button" class="chr-btn" id="chr-clear-filter">` +
          `${icon("ic-close", { size: 14 })}清除章節篩選</button>`
        : "") +
      `<button type="button" class="chr-btn" id="chr-export-json"` +
      ` aria-label="匯出目前檢視為 JSON">${icon("ic-export", { size: 14 })}JSON</button>` +
      `<button type="button" class="chr-btn" id="chr-back-map"` +
      ` aria-label="返去地圖視圖">${icon("ic-chevron-left", { size: 14 })}返地圖</button>` +
      `</div></header>` +
      this.renderRail(groups, activeKey) +
      this.renderBody(groups, flat, win) +
      `</div>`
    );
  }

  /** 目前所在時期（由 `pendingFocus` 或第一個可見條目推導）。 */
  private activePeriodKey(groups: PeriodGroup[]): string | null {
    if (groups.length === 0) return null;
    const snap = this.snapshot();
    if (snap.focusId) {
      for (const g of groups) {
        if (g.items.some((e) => e.id === snap.focusId)) return g.key;
      }
    }
    return groups[0].key;
  }

  /** 目前捲動位置（node 環境 → 0）。 */
  private currentScrollTop(): number {
    const wrap = this.root.querySelector<HTMLElement>(".chronicle-body-wrap");
    return wrap?.scrollTop ?? 0;
  }

  private currentViewportH(): number {
    const wrap = this.root.querySelector<HTMLElement>(".chronicle-body-wrap");
    return wrap?.clientHeight ?? ROW_H * 8;
  }

  // ───────────────────────────────────────────────────────────────────────
  // DOM
  // ───────────────────────────────────────────────────────────────────────

  render(): void {
    const scrollTop = this.currentScrollTop();
    this.root.innerHTML = this.renderToString({ scrollTop });
    this.bind();
  }

  private bind(): void {
    const wrap = this.root.querySelector<HTMLElement>(".chronicle-body-wrap");

    // 捲動 → 重算窗口（rAF coalesce：唔喺每個 scroll 事件即刻重繪）。
    if (wrap) {
      if (this.onScroll) wrap.removeEventListener("scroll", this.onScroll);
      let pending = false;
      this.onScroll = () => {
        if (pending) return;
        pending = true;
        const schedule =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : (cb: () => void) => setTimeout(cb, 16);
        schedule(() => {
          pending = false;
          this.updateWindow();
        });
      };
      wrap.addEventListener("scroll", this.onScroll, { passive: true });
    }

    // 章節 chip → 跳去該章（同時令地圖飛去）。
    this.root.querySelectorAll<HTMLElement>(".chr-ch").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const ch = Number(el.dataset.ch);
        if (Number.isFinite(ch) && ch > 0) this.goToChapter(ch);
      });
    });

    // 展開／收起。
    this.root.querySelectorAll<HTMLElement>("[data-toggle]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.toggleEntry(el.dataset.toggle!);
      });
    });

    // 伏筆／解答連結 → focus + 捲到目標條目。
    this.root.querySelectorAll<HTMLElement>("[data-goto]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.gotoEntry(el.dataset.goto!);
      });
    });

    // 時期 rail → 捲到該時期。
    this.root.querySelectorAll<HTMLElement>("[data-rail]").forEach((el) => {
      el.addEventListener("click", () => this.scrollToPeriod(el.dataset.rail!));
    });

    // 搜尋。
    const input = this.root.querySelector<HTMLInputElement>("#chr-search-input");
    input?.addEventListener("input", () => this.setQuery(input.value));
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.setQuery("");
      }
    });

    // 清除章節篩選。
    this.root
      .querySelector("#chr-clear-filter")
      ?.addEventListener("click", () => this.setChapterFilter(null));

    // 匯出。
    this.root
      .querySelector("#chr-export-json")
      ?.addEventListener("click", () => this.exportJson());

    // 返地圖。
    this.root.querySelector("#chr-back-map")?.addEventListener("click", () => {
      this.app?.store?.setView("map");
    });

    // 條目卡片鍵盤（focus 由 `handleKeydown` 統一處理）。
    this.root.querySelectorAll<HTMLElement>("[data-entry-id]").forEach((el) => {
      el.addEventListener("keydown", (e) => this.handleKeydown(e));
      el.addEventListener("focus", () => {
        const i = Number(el.dataset.flatIndex);
        if (Number.isFinite(i)) this.focusIndex = i;
      });
    });
  }

  /** 只更新窗口（唔重建 header / rail），減少捲動時嘅 DOM 變動。 */
  private updateWindow(): void {
    const win = computeWindow(this.flat.length, this.currentScrollTop(), this.currentViewportH(), OVERSCAN);
    const body = this.root.querySelector<HTMLElement>(".chronicle-body");
    if (!body) return;
    const top = body.querySelector<HTMLElement>(".chr-spacer");
    if (top) top.style.height = `${win.padTop}px`;
    const spacers = body.querySelectorAll<HTMLElement>(".chr-spacer");
    const bottom = spacers[spacers.length - 1];
    if (bottom && bottom !== top) bottom.style.height = `${win.padBottom}px`;
    // 追蹤目前所在時期（唔重建 DOM，只改 aria-current）。
    this.syncRail();
  }

  /** 更新 rail 嘅 `aria-current`（唔重繪整頁）。 */
  private syncRail(): void {
    const groups = this.grouped();
    const active = this.activePeriodKey(groups);
    this.root.querySelectorAll<HTMLElement>("[data-rail]").forEach((el) => {
      el.setAttribute("aria-current", el.dataset.rail === active ? "true" : "false");
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // 動作（全部經 store 或元件內 DOM 焦點狀態）
  // ───────────────────────────────────────────────────────────────────────

  /**
   * 章節篩選（**V1 相容簽名**；`src/app.ts` 會呼叫）。
   *
   * `null` → 保留現章但清篩選：做法係將 `filters.chapter` 設回 `null`。
   * ⚠️ 唔可以改 `app.ts`，所以簽名必須維持 `(ch: number | null) => void`。
   */
  setChapterFilter(ch: number | null): void {
    const store = this.app?.store;
    if (!store) {
      this.render();
      return;
    }
    const state = store.getState();
    const base =
      state.context.kind === "chronicle"
        ? { ...state.context.filters }
        : {
            chapter: null,
            period: null,
            zoneId: null,
            characterId: null,
            spoilerMax: state.spoilerMax,
            query: "",
          };
    // 規則 U5：狀態轉換（唔係用戶主動導航）→ replace。
    store.setContext({ kind: "chronicle", filters: { ...base, chapter: ch } });
  }

  /** 目前篩選章節（由 store 衍生，唔再係私有欄位）。 */
  getChapterFilter(): number | null {
    return this.snapshot().chapter;
  }

  /** 編年史內搜尋（經 store，令 URL `?q=` 同步）。 */
  setQuery(q: string): void {
    const store = this.app?.store;
    if (!store) return;
    const state = store.getState();
    const base =
      state.context.kind === "chronicle"
        ? { ...state.context.filters }
        : {
            chapter: null,
            period: null,
            zoneId: null,
            characterId: null,
            spoilerMax: state.spoilerMax,
            query: "",
          };
    if (base.query === q) return;
    store.setContext({ kind: "chronicle", filters: { ...base, query: q } });
  }

  /** 跳去某章（切回地圖 + 章節 context）。 */
  goToChapter(ch: number): void {
    const store = this.app?.store;
    if (!store) return;
    store.setView("map");
    store.setChapter(ch);
  }

  /** 展開／收起一條。 */
  toggleEntry(id: string): void {
    this.expanded = this.expanded === id ? null : id;
    const store = this.app?.store;
    if (store) store.setPendingFocus(id);
    this.render();
  }

  /**
   * 跳到目標條目：設 focus → 捲到 → 展開 → 聚焦。
   *
   * ⚠️ 用 `scrollElementTo()`（B1 motion，內建 reduced-motion 判斷），
   * **唔用** `scrollIntoView`（規則 C1；A7 P0-2 實測 smooth scroll 57 個值）。
   */
  gotoEntry(id: string): void {
    const store = this.app?.store;
    if (store) store.setPendingFocus(id);

    const flat = this.flat;
    const idx = indexOfEntry(flat, id);
    this.expanded = id;
    if (idx >= 0) this.focusIndex = idx;

    this.render();

    if (idx >= 0) this.scrollToOffset(offsetOf(idx));
    const el = this.root.querySelector<HTMLElement>(`[data-entry-id="${cssEscape(id)}"]`);
    el?.querySelector<HTMLElement>(".chr-entry-title")?.focus();
  }

  /** 捲到某個像素偏移（用 B1 motion；reduced-motion 之下即時跳）。 */
  private scrollToOffset(top: number): void {
    const wrap = this.root.querySelector<HTMLElement>(".chronicle-body-wrap");
    if (!wrap) return;
    this.scrollMotion?.cancel();
    this.scrollMotion = scrollElementTo(wrap, wrap.scrollLeft, top, DUR.normal);
  }

  /** 捲到某個時期嘅第一條。 */
  private scrollToPeriod(key: string): void {
    const groups = this.grouped();
    const g = groups.find((x) => x.key === key);
    if (!g || !g.items[0]) return;
    const idx = indexOfEntry(this.flat, g.items[0].id);
    if (idx < 0) return;
    this.scrollToOffset(offsetOf(idx));
    // 令 rail 即刻反映（唔等 scroll 事件）。
    this.root.querySelectorAll<HTMLElement>("[data-rail]").forEach((el) => {
      el.setAttribute("aria-current", el.dataset.rail === key ? "true" : "false");
    });
  }

  /**
   * 鍵盤處理（回傳 `true` = 已消費）。
   *
   * 契約（`chronicle/a11y.ts`）：
   *   ↑ / k、↓ / j、Home、End、Enter / Space
   *   ⚠️ **唔**處理 `Escape` —— `src/app.ts` 已經有全域處理，再攔會打架。
   */
  handleKeydown(e: KeyboardEvent): boolean {
    const action = keyAction(e.key);
    if (!action) return false;
    const el = e.target as HTMLElement | null;
    // 喺輸入框入面唔搶箭嘴鍵。
    const tag = el?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return false;

    if (action === "activate") {
      const id = el?.dataset?.entryId;
      if (id) {
        this.toggleEntry(id);
        return true;
      }
      return false;
    }

    const next = nextIndex(this.focusIndex, action, this.flat.length);
    if (next < 0 || next === this.focusIndex) return true;
    this.focusIndex = next;
    const target = this.flat[next];
    if (!target) return true;
    // 確保目標喺窗口入面（唔喺就先捲；`gotoEntry` 會重繪並聚焦）。
    this.gotoEntry(target.id);
    return true;
  }

  /**
   * 匯出目前檢視為 JSON。
   *
   * ⚠️ **版權紅線**（`AGENTS.md`）：只出經審閱嘅公開 metadata —— 條目 id /
   * 標題 / 摘要 / 章節參照 / 結構化關係。**唔含**任何小說原文段落。
   * 由 `chronicle/model.ts` 嘅 `toExported()` 保證欄位白名單。
   */
  exportJson(): void {
    const entries = this.visibleEntries();
    const items = entries.map((e) => toExported(e, this.periodOf(e)));
    const payload = {
      exported_at: new Date().toISOString(),
      filter_chapter: this.snapshot().chapter,
      count: items.length,
      entries: items,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = this.snapshot().chapter !== null ? `-ch${this.snapshot().chapter}` : "";
    a.download = `bing-gang-chronicle${suffix}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 內部工具
// ─────────────────────────────────────────────────────────────────────────────

/** CSS.escape 唔一定存在（node / 舊瀏覽器）→ 最小實作。 */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// 供測試引用嘅常數（唔改嚟源，只係 re-export 方便斷言）
// ─────────────────────────────────────────────────────────────────────────────

export {
  ACCEPTED_PERIOD_SOURCES,
  PERIOD_LABEL,
  PERIOD_ORDER,
  UNKNOWN_PERIOD_KEY,
  UNKNOWN_PERIOD_LABEL,
  labelForPeriodKey,
  ROW_H,
  OVERSCAN,
  WINDOW_MAX,
};
export type { PeriodGroup, ForeshadowPair, ForeshadowResolution };

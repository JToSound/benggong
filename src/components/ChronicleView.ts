/**
 * 編年史視圖 —— 以「故事世界嘅事件」為本，取代逐章展示。
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
 * 章節條嘅新角色
 * ==============
 * 用戶選擇「並存，編年史做預設，章節條保留做篩選器」。
 * 所以點章節條 = **篩選**該章相關嘅條目，唔再係「切換到嗰章」。
 */

import type { App } from "../app";

interface ChronicleChapterRef {
  chapter: number;
  role: "first_mention" | "reveal" | "flashback";
  note?: string;
}

interface ChronicleEntry {
  id: string;
  title: string;
  summary: string;
  story_time: { order: number | null; label: string; source: string };
  first_mention_chapter: number;
  chapters: ChronicleChapterRef[];
  foreshadows: string[];
  pays_off: string[];
  location_id: string | null;
  location_name: string | null;
  characters: string[];
  confidence: number;
  source_event_ids: string[];
  review_status: string;
  /** 由 LLM 判斷（階段 2）。 */
  flashback?: boolean;
  reviewed_by?: string;
}

interface ChronicleDoc {
  version: number;
  season: number;
  entries: ChronicleEntry[];
}

/** 故事時期 —— 由 LLM 判斷（`scripts/build_chronicle_llm.py`）。 */
const PERIOD_ORDER = [
  "pre_outbreak",
  "outbreak",
  "early",
  "basecamp",
  "lohas",
  "endgame",
];

const PERIOD_LABEL: Record<string, string> = {
  pre_outbreak: "爆發前",
  outbreak: "病毒爆發",
  early: "爆發初期",
  basecamp: "大本營時期",
  lohas: "康城時期",
  endgame: "終局",
};

const ROLE_LABEL: Record<string, string> = {
  first_mention: "首次提及",
  reveal: "補充揭示",
  flashback: "回帶",
};

export class ChronicleView {
  private root: HTMLElement;
  private app: App;
  private doc: ChronicleDoc;
  /** 目前篩選嘅章節（null = 唔篩選）。 */
  private filterChapter: number | null = null;
  /** 目前展開嘅條目。 */
  private expanded: string | null = null;

  constructor(root: HTMLElement, app: App, doc: ChronicleDoc) {
    this.root = root;
    this.app = app;
    this.doc = doc;
    this.render();
  }

  /**
   * 條目嘅時期標籤（未判斷就回 null）。
   *
   * ⚠️ **必須接受兩個來源**
   * ----------------------
   * - `llm_period` —— 階段 2 嘅 LLM 逐條判斷
   * - `chapter_boundary` —— 階段 3 嘅逐章邊界修正（391 條）
   *
   * 實測踩過**兩次**同一類 bug：只認 `llm_period` 會令
   *   - `prior_corrected` 條目顯示「未判定」
   *   - `chapter_boundary` 條目顯示「未判定」（391 條！）
   *
   * 明明有時期標籤卻唔顯示，**比唔修正更差** —— 因為用戶見到
   * 「未判定」會以為資料缺失。
   */
  private periodOf(e: ChronicleEntry): string | null {
    const src = e.story_time.source;
    return src === "llm_period" || src === "chapter_boundary"
      ? e.story_time.label
      : null;
  }

  /** 章節條點擊 → 篩選（唔再係切換章節）。 */
  setChapterFilter(ch: number | null): void {
    this.filterChapter = ch;
    this.expanded = null;
    this.render();
  }

  getChapterFilter(): number | null {
    return this.filterChapter;
  }

  /**
   * 目前要顯示嘅條目。
   *
   * 排序：先按故事時期（LLM 判斷），再按首次提及章節。
   * 冇時期判斷嘅就按章節排（階段 1 嘅 `story_time.order`）。
   */
  private visibleEntries(): ChronicleEntry[] {
    let list = this.doc.entries;
    if (this.filterChapter !== null) {
      const ch = this.filterChapter;
      list = list.filter((e) => e.chapters.some((c) => c.chapter === ch));
    }
    /*
     * 排序：先按故事時期，再按首次提及章節。
     *
     * ⚠️ 時期由 LLM 判斷（`story_time.source === "llm_period"`）。
     * 未判斷嘅條目排最後 —— 唔可以當成「爆發前」（咁會誤導）。
     */
    const periodIdx = (e: ChronicleEntry): number => {
      const label = this.periodOf(e);
      const key = Object.keys(PERIOD_LABEL).find((k) => PERIOD_LABEL[k] === label);
      return key ? PERIOD_ORDER.indexOf(key) : PERIOD_ORDER.length;
    };
    return [...list].sort(
      (a, b) =>
        periodIdx(a) - periodIdx(b) ||
        a.first_mention_chapter - b.first_mention_chapter ||
        a.title.localeCompare(b.title),
    );
  }

  /** 按時期分組（時期係編年史嘅骨幹）。 */
  private grouped(): Array<{ key: string; label: string; items: ChronicleEntry[] }> {
    const out: Array<{ key: string; label: string; items: ChronicleEntry[] }> = [];
    for (const key of PERIOD_ORDER) {
      const items = this.visibleEntries().filter(
        (e) => this.periodOf(e) === PERIOD_LABEL[key],
      );
      if (items.length) out.push({ key, label: PERIOD_LABEL[key], items });
    }
    const rest = this.visibleEntries().filter((e) => this.periodOf(e) === null);
    if (rest.length) out.push({ key: "_unknown", label: "時期未判定", items: rest });
    return out;
  }

  private esc(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private renderEntry(e: ChronicleEntry): string {
    const isFlashback = e.flashback ?? false;
    const isOpen = this.expanded === e.id;
    // 章節標籤：首次提及 + 其餘（補充／回帶）
    const badges = e.chapters
      .map(
        (c) =>
          `<button class="chr-ch" data-ch="${c.chapter}" title="${ROLE_LABEL[c.role]}">` +
          `ch${c.chapter}<span class="chr-ch-role">${ROLE_LABEL[c.role]}</span></button>`,
      )
      .join("");

    return `
      <article class="chr-entry${isFlashback ? " is-flashback" : ""}${isOpen ? " is-open" : ""}"
               data-entry-id="${e.id}">
        <header class="chr-entry-head">
          <span class="chr-mark" aria-hidden="true">${isFlashback ? "↩" : "●"}</span>
          <h4 class="chr-entry-title">${this.esc(e.title)}</h4>
        </header>
        <div class="chr-entry-meta">
          ${
            isFlashback
              ? `<span class="chr-flag" title="故事時間早過首次提及嘅章節">回帶 · 補完伏筆</span>`
              : ""
          }
          ${e.location_name ? `<span class="chr-loc">📍 ${this.esc(e.location_name)}</span>` : ""}
        </div>
        <div class="chr-chapters">${badges}</div>
        ${
          isOpen
            ? `<p class="chr-entry-summary">${this.esc(e.summary)}</p>` +
              this.renderLinks(e)
            : ""
        }
        <button class="chr-toggle" data-toggle="${e.id}">
          ${isOpen ? "收起" : "展開"}
        </button>
      </article>`;
  }

  /**
   * 匯出目前檢視為 JSON。
   *
   * ⚠️ 匯出嘅係**目前篩選後**嘅條目 —— 用戶篩選咗某章再匯出，
   * 應該只得到嗰章嘅資料（符合直覺）。
   */
  private exportJson(): void {
    const items = this.visibleEntries().map((e) => ({
      id: e.id,
      title: e.title,
      summary: e.summary,
      period: this.periodOf(e),
      first_mention_chapter: e.first_mention_chapter,
      chapters: e.chapters,
      flashback: e.flashback ?? false,
      location: e.location_name,
      foreshadows: e.foreshadows ?? [],
      pays_off: e.pays_off ?? [],
    }));
    const payload = {
      exported_at: new Date().toISOString(),
      filter_chapter: this.filterChapter,
      count: items.length,
      entries: items,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bing-gang-chronicle${this.filterChapter ? `-ch${this.filterChapter}` : ""}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * 橫向時間軸：每章一格，顏色代表時期。
   *
   * 為何用「章節格」而唔係「時間線」：小說冇明確日曆，章節號係唯一
   * 可靠嘅時序。一格 = 一章，顏色 = 該章所屬時期，高度 = 該章條目數。
   *
   * ⚠️ 為何要視覺化：用戶要嘅係**編年**感 —— 見到事件喺全書嘅分佈
   * （邊度密集、邊度稀疏、時期點轉換），比純列表直觀得多。
   */
  private renderTimeline(): string {
    // 每章：條目數 + 時期
    const perCh = new Map<number, { n: number; period: string | null }>();
    let maxCh = 0;
    for (const e of this.doc.entries) {
      const c = e.first_mention_chapter;
      maxCh = Math.max(maxCh, c);
      const cur = perCh.get(c) ?? { n: 0, period: null };
      cur.n++;
      // 用該章第一條有時期嘅條目做代表色
      if (!cur.period) cur.period = this.periodOf(e);
      perCh.set(c, cur);
    }
    if (!maxCh) return "";
    const maxN = Math.max(...Array.from(perCh.values(), (v) => v.n), 1);

    const bars: string[] = [];
    for (let c = 1; c <= maxCh; c++) {
      const v = perCh.get(c);
      const h = v ? Math.max(2, Math.round((v.n / maxN) * 100)) : 0;
      const key = Object.keys(PERIOD_LABEL).find(
        (k) => PERIOD_LABEL[k] === v?.period,
      );
      const cls = key ? ` is-${key}` : "";
      const title = `ch${c}${v ? `　${v.n} 條${v.period ? `　${v.period}` : ""}` : ""}`;
      bars.push(
        `<button class="chr-tl-bar${cls}" data-tl-ch="${c}" title="${title}" ` +
          `style="height:${h}%" aria-label="${title}"></button>`,
      );
    }
    return `
      <div class="chr-timeline" role="group" aria-label="章節時間軸">
        <div class="chr-tl-bars">${bars.join("")}</div>
        <div class="chr-tl-axis">
          <span>ch1</span><span>ch${Math.round(maxCh / 2)}</span><span>ch${maxCh}</span>
        </div>
      </div>`;
  }

  /**
   * 伏筆／解答連結。
   *
   * 用戶想要嘅「後續篇章回帶補完伏筆」效果 —— 呢個就係佢嘅呈現：
   * 一條條目可以標明「為 X 埋下伏筆」同「解答咗 Y」，而且**可點擊跳去**。
   *
   * ⚠️ 只顯示**已驗證**嘅關係（`scripts/apply_agent_analysis.py` 驗過：
   * id 存在、冇自我指向、伏筆章節唔遲過解答章節、冇循環）。
   */
  private renderLinks(e: ChronicleEntry): string {
    const byId = new Map(this.doc.entries.map((x) => [x.id, x]));
    const chip = (id: string, cls: string, arrow: string) => {
      const t = byId.get(id);
      if (!t) return "";
      return (
        `<button class="chr-link ${cls}" data-goto="${id}" title="ch${t.first_mention_chapter}">` +
        `${arrow} ${this.esc(t.title.slice(0, 18))}</button>`
      );
    };
    const fs = (e.foreshadows ?? []).map((id) => chip(id, "is-fs", "→")).join("");
    const po = (e.pays_off ?? []).map((id) => chip(id, "is-po", "↩")).join("");
    if (!fs && !po) return "";
    return `
      <div class="chr-links">
        ${po ? `<div class="chr-links-row"><span class="chr-links-label">↩ 解答咗</span>${po}</div>` : ""}
        ${fs ? `<div class="chr-links-row"><span class="chr-links-label">→ 埋下伏筆</span>${fs}</div>` : ""}
      </div>`;
  }

  render(): void {
    const groups = this.grouped();
    const total = this.visibleEntries().length;
    const filterLabel =
      this.filterChapter === null
        ? "全部章節"
        : `第 ${this.filterChapter} 章相關`;

    this.root.innerHTML = `
      <div class="chronicle">
        <header class="chronicle-head">
          <h2>第一季編年史</h2>
          <p class="chronicle-sub">
            按<strong>故事時間</strong>排列，唔係敍事次序。
            <span class="chronicle-count">${total} 條 · ${filterLabel}</span>
          </p>
          <div class="chr-actions">
            ${
              this.filterChapter !== null
                ? `<button id="chr-clear-filter" class="chr-clear">✕ 清除篩選</button>`
                : ""
            }
            <button id="chr-export-json" class="chr-clear" title="匯出目前檢視為 JSON">⬇ JSON</button>
          </div>
        </header>
        ${this.renderTimeline()}
        <div class="chronicle-body">
          ${
            groups.length === 0
              ? `<p class="chronicle-empty">呢個章節未有編年史條目。</p>`
              : groups
                  .map(
                    (g) => `
            <section class="chr-period" data-period="${g.key}">
              <h3 class="chr-period-title">
                <span class="chr-period-line" aria-hidden="true"></span>
                ${g.label}
                <span class="chr-period-count">${g.items.length}</span>
              </h3>
              ${g.items.map((e) => this.renderEntry(e)).join("")}
            </section>`,
                  )
                  .join("")
          }
        </div>
      </div>`;

    this.bind();
  }

  private bind(): void {
    // 章節標籤 → 跳去該章（同時令地圖飛去）
    this.root.querySelectorAll<HTMLElement>(".chr-ch").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const ch = Number(el.dataset.ch);
        if (ch) this.app.setChapter(ch);
      });
    });
    // 展開／收起
    this.root.querySelectorAll<HTMLElement>("[data-toggle]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = el.dataset.toggle!;
        this.expanded = this.expanded === id ? null : id;
        this.render();
      });
    });
    // 匯出 JSON（目前檢視：包含篩選後嘅條目）
    this.root
      .querySelector("#chr-export-json")
      ?.addEventListener("click", () => this.exportJson());
    // 時間軸：點一格 → 篩選該章
    this.root.querySelectorAll<HTMLElement>("[data-tl-ch]").forEach((el) => {
      el.addEventListener("click", () => {
        const ch = Number(el.dataset.tlCh);
        if (ch) this.setChapterFilter(ch);
      });
    });
    // 伏筆／解答連結 → 跳到對應條目並展開
    this.root.querySelectorAll<HTMLElement>("[data-goto]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = el.dataset.goto!;
        this.expanded = id;
        this.render();
        // 捲到該條目（用 scrollIntoView 令用戶見到）
        this.root
          .querySelector(`[data-entry-id="${id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    // 清除篩選
    this.root
      .querySelector("#chr-clear-filter")
      ?.addEventListener("click", () => this.setChapterFilter(null));
  }
}

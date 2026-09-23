/**
 * chronicle-view.test.ts — B7 編年史視圖契約（渲染 / 章節選擇 / store 同步）
 *
 * 為何要呢個檔
 * ============
 * V1 嘅編年史有三個結構問題（A3 §4.3 / A2 §8）：
 *   1. **私有 state**（`filterChapter` / `expanded`）→ 違反規則 S1；
 *   2. **1,320 條 eager render** → 規則 C1 要求 virtualized；
 *   3. 自己重複聲明 `ChronicleEntry`（同 `loadAllData` 有漂移風險）。
 *
 * 呢個檔逐條把關。⚠️ 最重要嘅一條係「391 條陷阱」：
 * 時期資料有兩個來源（`llm_period` 229 條 / `chapter_boundary` 391 條），
 * V1 只認前者 → 391 條明明有時期卻顯示「時期未判定」。呢個 bug 踩過兩次，
 * 所以要有一條測試**同時**餵兩個 source 並斷言兩者都出時期。
 *
 * ⚠️ 環境係 `node`（冇 DOM）。所以測試對象係純函數：
 *   · `renderToString()` —— state → HTML 字串；
 *   · `grouped()` / `visibleEntries()` —— 資料篩選；
 *   · `computeWindow()` —— 虛擬化窗口。
 * 事件綁定（`bind()`）唔喺呢度測（要 DOM）。
 */

import { describe, expect, it } from "vitest";

import {
  ACCEPTED_PERIOD_SOURCES,
  ChronicleView,
  OVERSCAN,
  PERIOD_LABEL,
  PERIOD_ORDER,
  ROW_H,
  UNKNOWN_PERIOD_KEY,
  UNKNOWN_PERIOD_LABEL,
  WINDOW_MAX,
} from "../src/components/ChronicleView";
import type { ChronicleDoc, ChronicleEntry } from "../src/data/loadAllData";
import { groupByPeriod, periodKeyOf, sortEntries } from "../src/components/chronicle/period";
import { computeWindow, indexOfEntry, offsetOf } from "../src/components/chronicle/virtual";
import {
  confidenceLevel,
  matchesChapter,
  matchesQuery,
  toItem,
} from "../src/components/chronicle/model";
import { snapshotOf } from "../src/components/ChronicleView";
import { createInitialState } from "../src/types/state";
import { createAppStore } from "../src/state";

/* ─────────────────────────────────────────────────────────────────────────
   合成資料
   ───────────────────────────────────────────────────────────────────────── */

function entry(over: Partial<ChronicleEntry> & { id: string }): ChronicleEntry {
  return {
    title: over.id,
    summary: `${over.id} 摘要`,
    story_time: { order: 1, label: PERIOD_LABEL.early, source: "llm_period" },
    first_mention_chapter: 1,
    chapters: [{ chapter: 1, role: "first_mention" }],
    foreshadows: [],
    pays_off: [],
    location_id: null,
    location_name: null,
    characters: [],
    confidence: 0.9,
    source_event_ids: [],
    review_status: "approved",
    flashback: false,
    ...over,
  };
}

/**
 * 造 N 條條目（分散喺 6 個時期）—— 用嚟測虛擬化。
 * 全部係 `llm_period`，確保有名有姓嘅時期。
 */
function manyEntries(n: number): ChronicleEntry[] {
  const periods = PERIOD_ORDER;
  return Array.from({ length: n }, (_, i) =>
    entry({
      id: `chr_${String(i).padStart(4, "0")}`,
      title: `條目 ${i}`,
      story_time: {
        order: i,
        label: PERIOD_LABEL[periods[i % periods.length]],
        source: "llm_period",
      },
      first_mention_chapter: 1 + (i % 60),
    }),
  );
}

/** 由一堆條目造 `ChronicleDoc`（虛擬化測試會用）。 */
function docOf(entries: ChronicleEntry[]): ChronicleDoc {
  return { version: 1, season: 1, generated_by: "test", entries };
}

/* ─────────────────────────────────────────────────────────────────────────
   1. 時期判斷（⚠️ 391 條陷阱）
   ───────────────────────────────────────────────────────────────────────── */

describe("時期判斷 —— 兩個 source 都要認", () => {
  it("接受 llm_period", () => {
    const e = entry({
      id: "a",
      story_time: { order: 1, label: PERIOD_LABEL.basecamp, source: "llm_period" },
    });
    expect(periodKeyOf(e)).toBe("basecamp");
  });

  it("接受 chapter_boundary（V1 漏咗呢個 → 391 條顯示未判定）", () => {
    const e = entry({
      id: "b",
      story_time: { order: 1, label: PERIOD_LABEL.lohas, source: "chapter_boundary" },
    });
    expect(periodKeyOf(e)).toBe("lohas");
  });

  it("ACCEPTED_PERIOD_SOURCES 恰好係 {llm_period, chapter_boundary}", () => {
    expect([...ACCEPTED_PERIOD_SOURCES].sort()).toEqual([
      "chapter_boundary",
      "llm_period",
    ]);
  });

  it("唔認識嘅 source → null（唔可以當成『爆發前』）", () => {
    const e = entry({
      id: "c",
      story_time: { order: null, label: PERIOD_LABEL.pre_outbreak, source: "mystery" },
    });
    expect(periodKeyOf(e)).toBeNull();
  });

  it("唔認識嘅 label → null（測試要紅，唔可以靜默歸類）", () => {
    const e = entry({
      id: "d",
      story_time: { order: 1, label: "未來新增嘅時期", source: "llm_period" },
    });
    expect(periodKeyOf(e)).toBeNull();
  });

  it("未知 source 嘅條目照樣 render（唔會消失），只係歸 _unknown", () => {
    const es = [
      entry({ id: "known" }),
      entry({
        id: "unknown",
        story_time: { order: null, label: "乜", source: "weird" },
      }),
    ];
    const groups = groupByPeriod(es);
    const unknown = groups.find((g) => g.key === UNKNOWN_PERIOD_KEY);
    expect(unknown?.label).toBe(UNKNOWN_PERIOD_LABEL);
    expect(unknown?.items.map((e) => e.id)).toEqual(["unknown"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   2. 分組 + 排序
   ───────────────────────────────────────────────────────────────────────── */

describe("時期分群", () => {
  it("按 PERIOD_ORDER 排序（唔係資料檔次序）", () => {
    const es = [
      entry({
        id: "late",
        story_time: { order: 5, label: PERIOD_LABEL.endgame, source: "llm_period" },
      }),
      entry({
        id: "early",
        story_time: { order: 1, label: PERIOD_LABEL.early, source: "llm_period" },
      }),
    ];
    const groups = groupByPeriod(es);
    expect(groups.map((g) => g.key)).toEqual(["early", "endgame"]);
  });

  it("空時期唔出 group", () => {
    const groups = groupByPeriod([entry({ id: "x" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("early");
  });

  it("同時期內按首次提及章節 → 再按標題（確定性）", () => {
    const es = [
      entry({ id: "b", title: "B", first_mention_chapter: 9 }),
      entry({ id: "a", title: "A", first_mention_chapter: 9 }),
      entry({ id: "c", title: "C", first_mention_chapter: 3 }),
    ];
    expect(sortEntries(es).map((e) => e.id)).toEqual(["c", "a", "b"]);
  });

  it("排序唔改輸入陣列（純函數）", () => {
    const es = [
      entry({ id: "z", first_mention_chapter: 9 }),
      entry({ id: "a", first_mention_chapter: 1 }),
    ];
    const before = es.map((e) => e.id);
    sortEntries(es);
    expect(es.map((e) => e.id)).toEqual(before);
  });

  it("未判定排最後", () => {
    const es = [
      entry({
        id: "u",
        story_time: { order: null, label: "?", source: "?" },
      }),
      entry({ id: "k" }),
    ];
    expect(groupByPeriod(es).at(-1)?.key).toBe(UNKNOWN_PERIOD_KEY);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   3. 章節篩選 + 搜尋（純函數層）
   ───────────────────────────────────────────────────────────────────────── */

describe("章節篩選同搜尋", () => {
  const e = entry({
    id: "e1",
    title: "大本營嘅建立",
    summary: "生還者佔據校園",
    first_mention_chapter: 2,
    chapters: [
      { chapter: 2, role: "first_mention" },
      { chapter: 18, role: "reveal" },
    ],
  });

  it("chapter=null → 全部通過", () => {
    expect(matchesChapter(e, null)).toBe(true);
  });

  it("首次提及章命中", () => {
    expect(matchesChapter(e, 2)).toBe(true);
  });

  it("補充章命中", () => {
    expect(matchesChapter(e, 18)).toBe(true);
  });

  it("無關章唔命中", () => {
    expect(matchesChapter(e, 55)).toBe(false);
  });

  it("空 query → 全部通過", () => {
    expect(matchesQuery(e, "")).toBe(true);
    expect(matchesQuery(e, "   ")).toBe(true);
  });

  it("query 命中標題（大小寫唔敏感）", () => {
    expect(matchesQuery(e, "大本營")).toBe(true);
  });

  it("query 命中摘要", () => {
    expect(matchesQuery(e, "校園")).toBe(true);
  });

  it("query 唔命中 → false", () => {
    expect(matchesQuery(e, "完全冇關係")).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   4. 虛擬化（規則 C1「必須 virtualized」）
   ───────────────────────────────────────────────────────────────────────── */

describe("虛擬化窗口", () => {
  it("1,320 條 @ scrollTop=0 → render 數量有硬上限", () => {
    const win = computeWindow(1320, 0, 600);
    expect(win.end - win.start).toBeLessThanOrEqual(WINDOW_MAX);
  });

  it("任何 scrollTop 都唔會超上限", () => {
    for (const top of [0, 100, 5000, 60_000, 121_440, 999_999]) {
      const win = computeWindow(1320, top, 600);
      expect(win.end - win.start).toBeLessThanOrEqual(WINDOW_MAX);
      expect(win.start).toBeGreaterThanOrEqual(0);
      expect(win.end).toBeLessThanOrEqual(1320);
      expect(win.start).toBeLessThanOrEqual(win.end);
    }
  });

  it("spacer 高度加起來 = 總高度（唔會令條目跳位）", () => {
    const win = computeWindow(1000, 20_000, 800);
    expect(win.padTop + (win.end - win.start) * ROW_H + win.padBottom).toBe(win.totalHeight);
  });

  it("空清單 → 零窗口", () => {
    const win = computeWindow(0, 0, 600);
    expect(win).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 });
  });

  it("viewportH 唔合理（0 / NaN）→ 用安全默認，唔會 crash", () => {
    expect(() => computeWindow(100, 0, 0)).not.toThrow();
    expect(() => computeWindow(100, NaN, NaN)).not.toThrow();
    expect(computeWindow(100, 0, NaN).end).toBeGreaterThan(0);
  });

  it("負 scrollTop → 當 0", () => {
    const a = computeWindow(100, -500, 600);
    const b = computeWindow(100, 0, 600);
    expect(a).toEqual(b);
  });

  it("overscan 可調；WINDOW_MAX 仍然係硬上限", () => {
    const win = computeWindow(1000, 0, 600, 999);
    expect(win.end - win.start).toBeLessThanOrEqual(WINDOW_MAX);
  });

  it("預設 overscan 大過 0（減少快速捲動空白）", () => {
    expect(OVERSCAN).toBeGreaterThan(0);
  });

  it("offsetOf / indexOfEntry 一致（跳轉用）", () => {
    const flat = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const i = indexOfEntry(flat, "c");
    expect(i).toBe(2);
    expect(offsetOf(i)).toBe(2 * ROW_H);
  });

  it("indexOfEntry 搵唔到 → -1", () => {
    expect(indexOfEntry([{ id: "a" }], "zzz")).toBe(-1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   5. snapshotOf（store → 視圖快照；規則 S1 嘅橋）
   ───────────────────────────────────────────────────────────────────────── */

describe("snapshotOf —— store state → 快照", () => {
  it("map view → 冇章節篩選、冇 query", () => {
    const s = createInitialState();
    expect(snapshotOf(s)).toMatchObject({ chapter: null, query: "", focusId: null });
  });

  it("chronicle context → 讀 filters", () => {
    const s = createInitialState({
      view: "chronicle",
      pendingFocus: "chr_1",
      context: {
        kind: "chronicle",
        filters: {
          chapter: 18,
          period: null,
          zoneId: null,
          characterId: null,
          spoilerMax: 1,
          query: "大本營",
        },
      },
    });
    expect(snapshotOf(s)).toMatchObject({
      chapter: 18,
      query: "大本營",
      focusId: "chr_1",
    });
  });

  it("non-chronicle context 但 view=chronicle → chapter 由 context 決定（唔會 crash）", () => {
    const s = createInitialState({ view: "chronicle" });
    expect(() => snapshotOf(s)).not.toThrow();
    expect(snapshotOf(s).chapter).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   6. 端到端字串渲染（`renderToString()`；node 冇 DOM 都測得到）
   ───────────────────────────────────────────────────────────────────────── */

/** `App` 嘅最小 stub（`ChronicleView` 只用到 `store`）。 */
type ViewApp = ConstructorParameters<typeof ChronicleView>[1];

/** 假 DOM root（`renderToString()` 唔會摸佢）。 */
function fakeRoot(): HTMLElement {
  return {
    querySelector: () => null,
    querySelectorAll: () => [],
    innerHTML: "",
  } as unknown as HTMLElement;
}

/** 由 state 造一個只提供 `store` 嘅 App stub。 */
function stubApp(state?: Parameters<typeof createInitialState>[0]): ViewApp {
  const store = createAppStore({ initial: createInitialState(state) });
  return { store } as unknown as ViewApp;
}

/** 建立視圖但唔 render 落 DOM。 */
function makeView(entries: ChronicleEntry[], state = createInitialState()): ChronicleView {
  return new ChronicleView(fakeRoot(), stubApp(state), docOf(entries));
}

describe("renderToString —— 端到端 HTML 產生", () => {
  it("空資料 → 有明確空狀態文案（唔會白畫面）", () => {
    const html = makeView([]).renderToString({ scrollTop: 0, viewportH: 600 });
    expect(html).toContain("chronicle-empty");
  });

  it("有條目 → 出到標題同時期標題", () => {
    const html = makeView([
      entry({
        id: "x",
        title: "大本營嘅建立",
        story_time: { order: 1, label: PERIOD_LABEL.basecamp, source: "llm_period" },
      }),
    ]).renderToString({ scrollTop: 0, viewportH: 600 });
    expect(html).toContain("大本營嘅建立");
    expect(html).toContain(PERIOD_LABEL.basecamp);
  });

  it("1,320 條之下 render 嘅 article 數 ≤ WINDOW_MAX（virtualization 生效）", () => {
    const html = makeView(manyEntries(1320)).renderToString({
      scrollTop: 0,
      viewportH: 600,
    });
    const n = (html.match(/<article /g) ?? []).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(WINDOW_MAX);
  });

  it("捲到中間，article 數仍然 ≤ WINDOW_MAX", () => {
    const html = makeView(manyEntries(1320)).renderToString({
      scrollTop: 1320 * ROW_H * 0.5,
      viewportH: 600,
    });
    const n = (html.match(/<article /g) ?? []).length;
    expect(n).toBeLessThanOrEqual(WINDOW_MAX);
  });

  it("spacer 有出（撐高度），而且係 aria-hidden", () => {
    const html = makeView(manyEntries(500)).renderToString({
      scrollTop: 20_000,
      viewportH: 600,
    });
    expect(html).toContain('class="chr-spacer"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("時期 rail 有出，且每粒有 aria-label", () => {
    const html = makeView(manyEntries(120)).renderToString({
      scrollTop: 0,
      viewportH: 600,
    });
    expect(html).toContain("chr-rail");
    expect(html).toContain("aria-current=");
    const rails = html.match(/data-rail="[^"]+"/g) ?? [];
    expect(rails.length).toBeGreaterThan(0);
  });

  it("章節篩選 label 反映喺 header", () => {
    const state = createInitialState({
      view: "chronicle",
      context: {
        kind: "chronicle",
        filters: {
          chapter: 18,
          period: null,
          zoneId: null,
          characterId: null,
          spoilerMax: 1,
          query: "",
        },
      },
    });
    const html = makeView(manyEntries(60), state).renderToString({
      scrollTop: 0,
      viewportH: 600,
    });
    expect(html).toContain("第 18 章相關");
    expect(html).toContain("chr-clear-filter");
  });

  it("HTML 有 escape（標題含 <script> 唔會被當 markup）", () => {
    const html = makeView([
      entry({ id: "x", title: "<script>alert(1)</script>" }),
    ]).renderToString({ scrollTop: 0, viewportH: 600 });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("所有互動 chip 都係 <button type=\"button\">（唔會意外 submit）", () => {
    const html = makeView(
      [
        entry({
          id: "a",
          first_mention_chapter: 3,
          chapters: [{ chapter: 3, role: "first_mention" }],
        }),
      ],
      createInitialState({
        view: "chronicle",
        context: {
          kind: "chronicle",
          filters: {
            chapter: null,
            period: null,
            zoneId: null,
            characterId: null,
            spoilerMax: 1,
            query: "",
          },
        },
      }),
    ).renderToString({ scrollTop: 0, viewportH: 600 });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b, `button 缺 type：${b}`).toContain('type="button"');
    }
  });

  it("每個 <button> 都有 aria-label（冇無標籤 emoji 掣）", () => {
    const html = makeView(manyEntries(40)).renderToString({
      scrollTop: 0,
      viewportH: 600,
    });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    for (const b of buttons) {
      expect(b, `button 缺 aria-label：${b}`).toContain("aria-label=");
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   7. store 同步（規則 S1：選中狀態必須經 store）
   ───────────────────────────────────────────────────────────────────────── */

describe("store 同步", () => {
  it("setChapterFilter(n) 寫入 context.filters.chapter", () => {
    const store = createAppStore({ initial: createInitialState({ view: "chronicle" }) });
    const app = { store } as unknown as ViewApp;
    const view = new ChronicleView(fakeRoot(), app, docOf(manyEntries(10)));

    view.setChapterFilter(42);
    const ctx = store.getState().context;
    expect(ctx.kind).toBe("chronicle");
    if (ctx.kind === "chronicle") expect(ctx.filters.chapter).toBe(42);
    expect(view.getChapterFilter()).toBe(42);
  });

  it("setChapterFilter(null) 清返 chapter", () => {
    const store = createAppStore({ initial: createInitialState({ view: "chronicle" }) });
    const app = { store } as unknown as ViewApp;
    const view = new ChronicleView(fakeRoot(), app, docOf(manyEntries(10)));

    view.setChapterFilter(7);
    view.setChapterFilter(null);
    expect(view.getChapterFilter()).toBeNull();
  });

  it("setQuery 寫入 filters.query", () => {
    const store = createAppStore({ initial: createInitialState({ view: "chronicle" }) });
    const app = { store } as unknown as ViewApp;
    const view = new ChronicleView(fakeRoot(), app, docOf(manyEntries(10)));

    view.setQuery("大本營");
    const ctx = store.getState().context;
    if (ctx.kind === "chronicle") expect(ctx.filters.query).toBe("大本營");
  });

  it("destroy() 解除訂閱（之後 store 變更唔會再 render）", () => {
    const store = createAppStore({ initial: createInitialState({ view: "chronicle" }) });
    let rendered = 0;
    const root = {
      querySelector: () => null,
      querySelectorAll: () => [],
      set innerHTML(_v: string) {
        rendered++;
      },
      get innerHTML() {
        return "";
      },
    } as unknown as HTMLElement;
    const app = { store } as unknown as ViewApp;
    const view = new ChronicleView(root, app, docOf(manyEntries(10)));
    const afterCtor = rendered;
    view.destroy();
    store.setChapter(5);
    expect(rendered).toBe(afterCtor);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   8. 真實資料（`data/public/chronicle.json`）
   ───────────────────────────────────────────────────────────────────────── */

describe("真實 chronicle.json", () => {
  it("1,320 條之中，兩個 source 全部認得（唔應該有一條誤判未判定）", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync("data/public/chronicle.json", "utf8");
    const parsed = JSON.parse(raw) as ChronicleDoc;
    expect(parsed.entries.length).toBeGreaterThan(1000);

    const sources = new Set(parsed.entries.map((e) => e.story_time.source));
    // 資料只可以有兩個 source；有第三個 → 前端白名單要更新（測試提醒）。
    expect([...sources].sort()).toEqual(["chapter_boundary", "llm_period"]);

    for (const e of parsed.entries) {
      expect(ACCEPTED_PERIOD_SOURCES.has(e.story_time.source)).toBe(true);
    }
  });

  it("兩個 source 嘅條目都拿得到時期鍵（＝ 冇『未判定』）", async () => {
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(
      readFileSync("data/public/chronicle.json", "utf8"),
    ) as ChronicleDoc;
    for (const e of parsed.entries) {
      expect(periodKeyOf(e)).not.toBeNull();
    }
  });

  it("群組總數 = 條目總數（冇條目喺分組過程中消失）", async () => {
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(
      readFileSync("data/public/chronicle.json", "utf8"),
    ) as ChronicleDoc;
    const sum = groupByPeriod(parsed.entries).reduce((n, g) => n + g.items.length, 0);
    expect(sum).toBe(parsed.entries.length);
  });

  it("真實資料下虛擬化窗口仍然 ≤ WINDOW_MAX", async () => {
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(
      readFileSync("data/public/chronicle.json", "utf8"),
    ) as ChronicleDoc;
    const total = parsed.entries.length;
    const win = computeWindow(total, total * ROW_H * 0.5, 800);
    expect(win.end - win.start).toBeLessThanOrEqual(WINDOW_MAX);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   7. View model（model.ts）
   ───────────────────────────────────────────────────────────────────────── */

describe("view model", () => {
  it("章節 chip 去重，保留最高優先 role", () => {
    const item = toItem(
      entry({
        id: "x",
        chapters: [
          { chapter: 5, role: "flashback" },
          { chapter: 5, role: "first_mention" },
        ],
      }),
    );
    expect(item.chapters).toHaveLength(1);
    expect(item.chapters[0].role).toBe("first_mention");
  });

  it("章節 chip 按章節號升序", () => {
    const item = toItem(
      entry({
        id: "x",
        chapters: [
          { chapter: 70, role: "flashback" },
          { chapter: 2, role: "first_mention" },
          { chapter: 18, role: "reveal" },
        ],
      }),
    );
    expect(item.chapters.map((c) => c.chapter)).toEqual([2, 18, 70]);
  });

  it("未知 role → 當 reveal（唔會 crash）", () => {
    const item = toItem(
      entry({
        id: "x",
        chapters: [{ chapter: 1, role: "something_new" as "reveal" }],
      }),
    );
    expect(item.chapters[0].role).toBe("reveal");
  });

  it("可信度分級：0.9 → high、0.6 → medium、0.3 → low、undefined → unknown", () => {
    expect(confidenceLevel(0.9)).toBe("high");
    expect(confidenceLevel(0.6)).toBe("medium");
    expect(confidenceLevel(0.3)).toBe("low");
    expect(confidenceLevel(undefined)).toBe("unknown");
    expect(confidenceLevel(NaN)).toBe("unknown");
  });

  it("review_status !== approved → needsReview", () => {
    expect(toItem(entry({ id: "a", review_status: "pending" })).needsReview).toBe(true);
    expect(toItem(entry({ id: "b", review_status: "approved" })).needsReview).toBe(false);
  });

  it("唔會出原始角色 id（只出數量）", () => {
    const item = toItem(entry({ id: "a", characters: ["ent_1", "ent_2"] }));
    expect(item.characterCount).toBe(2);
    expect(JSON.stringify(item)).not.toContain("ent_1");
  });
});

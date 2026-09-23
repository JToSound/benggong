/**
 * virtual.ts — 編年史條目窗口化渲染（virtualization）嘅數學（B7 純函數模組）。
 *
 * 為何一定要 virtualize（規則 C1 + A2 §8）
 * ====================================
 * 實測 1,320 條編年史條目全部 eager render → 1,320 個 `<article>`
 * （每個 327×115、radius 8px、統一 `--bg-elevated`）→ A2 判為
 * 「廉價 AI dashboard 卡片堆疊」命中項，同時係首屏最大嘅 DOM 成本。
 *
 * spec `component-state-contract.md` §3 對 `ChronicleView` 嘅備註係
 * **「必須 virtualized」** —— 呢個檔就係嗰個「必須」嘅實作。
 *
 * 為何用「固定高度估算」而唔係 `getBoundingClientRect()`
 * ----------------------------------------------------
 * 量真實高度要 layout，而 layout 喺捲動期間每 frame 發生 → forced
 * synchronous layout（layout thrash）。更嚴重嘅係：量完高度再改 spacer
 * 高度 → 再 layout → 高度又變 → 無限迴圈（實測會令長列表震動）。
 *
 * 所以：**高度係常數**。展開嘅條目用 CSS 加高，但**唔會回饋落估算模型**
 * —— 頂多令估算有少少偏差，而偏差只影響 spacer 高度（用戶感覺唔到）。
 *
 * 呢個檔**零 DOM 依賴**（`environment: node` 跑得）。
 */

/** 一條收起咗嘅條目嘅估算高度（px）。同 `chronicle.css` 嘅 row 高度對齊。 */
export const ROW_H = 92;

/** 上下各 render 多幾行（減少快速捲動時嘅空白）。 */
export const OVERSCAN = 6;

/** 一次最多 render 幾多條（硬上限；測試斷言用）。 */
export const WINDOW_MAX = 40;

export interface WindowRange {
  /** 由第幾條開始 render（含）。 */
  start: number;
  /** 到第幾條為止（**唔含**）。 */
  end: number;
  /** 頂部 spacer 高度（px）。 */
  padTop: number;
  /** 底部 spacer 高度（px）。 */
  padBottom: number;
  /** 總高度（px）= `total * ROW_H`。 */
  totalHeight: number;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  const n = Math.floor(v);
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * 計出目前要 render 嘅窗口。
 *
 * @param total     條目總數
 * @param scrollTop 容器目前 scrollTop（px）
 * @param viewportH 容器可見高度（px）
 * @param overscan  上下 buffer 行數（預設 `OVERSCAN`）
 *
 * **保證**：`end - start ≤ WINDOW_MAX`；`0 ≤ start ≤ end ≤ total`。
 * 呢兩條係硬性（唔可以因為極端輸入而 render 全量）。視窗太細（例如 0）
 * 都至少 render `WINDOW_MAX` 條以內嘅一個合理窗口，避免完全空白。
 */
export function computeWindow(
  total: number,
  scrollTop: number,
  viewportH: number,
  overscan: number = OVERSCAN,
): WindowRange {
  const n = clampInt(total, 0, Number.MAX_SAFE_INTEGER);
  const totalHeight = n * ROW_H;
  if (n === 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };
  }

  const vh = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : ROW_H * 8;
  const st = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const over = clampInt(overscan, 0, WINDOW_MAX);

  const firstVisible = Math.floor(st / ROW_H);
  const visibleCount = Math.ceil(vh / ROW_H) + 1;
  const rawStart = firstVisible - over;
  const rawEnd = firstVisible + visibleCount + over;

  let start = clampInt(rawStart, 0, n);
  let end = clampInt(rawEnd, start, n);

  // 硬上限：窗口唔可以大過 WINDOW_MAX。
  if (end - start > WINDOW_MAX) end = start + WINDOW_MAX;
  // 窗口太細（例如貼近頂／底）→ 向前借，令 render 量穩定，減少 reflow。
  if (end - start < Math.min(WINDOW_MAX, n) && start > 0) {
    const deficit = Math.min(WINDOW_MAX, n) - (end - start);
    start = clampInt(start - deficit, 0, start);
  }

  return {
    start,
    end,
    padTop: start * ROW_H,
    padBottom: (n - end) * ROW_H,
    totalHeight,
  };
}

/**
 * 條目 index → 頂部偏移（px）。
 * 跳轉（伏筆 chip / 時期 rail）用呢個值做 `scrollElementTo` 目標。
 */
export function offsetOf(index: number): number {
  return clampInt(index, 0, Number.MAX_SAFE_INTEGER) * ROW_H;
}

/**
 * 某條目喺**已 flatten 嘅顯示清單**入面嘅 index（搵唔到 → `-1`）。
 *
 * 為何要 flatten：分組之後條目散落喺唔同 `<section>`。要 support
 * 精確捲動 + 窗口化，必須有一個**扁平線性次序**做 index 空間。
 * `groupByPeriod()` 已經排好序，flatten 只係 `flat()`。
 */
export function indexOfEntry(
  flat: readonly { id: string }[],
  id: string,
): number {
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].id === id) return i;
  }
  return -1;
}

/** 將窗口區間套用到扁平清單 → 真正要 render 嘅 slice。 */
export function sliceWindow<T>(flat: readonly T[], range: WindowRange): T[] {
  return flat.slice(range.start, range.end);
}

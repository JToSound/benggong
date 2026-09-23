/**
 * motion.ts — CSS 同 JS **共用**嘅唯一動效入口（規則 M2）。
 *
 * 為何需要呢個檔（A7 P1）
 * ======================
 * 現況 CSS 層嘅 reduced-motion 有效（duration 由 0.52s → 1e-06s），
 * 但 **JS 層完全繞過** —— 實測 `reduce` 模式下 rAF `viewBox` 仍然有
 * **11 個相異值**、smooth scroll **57 個**，同 `no-preference` 一模一樣。
 *
 * V2 契約（spec §6）：
 *   `prefersReducedMotion()` 為真 → **同步一次跳終態**，唔開 rAF、唔插值。
 *
 * Duration / easing 一律由 `theme-tokens.ts`（即 `tokens.css` 嘅 mirror）讀取，
 * 確保 CSS 同 JS 唔會各自漂移出唔同嘅 scale。
 */

import { MOTION_TOKENS } from "./theme-tokens";

/** 地圖視域（同 `ViewBox` 同形狀）。 */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 可取消嘅動效 handle。 */
export interface MotionHandle {
  cancel(): void;
}

/** 3 級 duration（ms）；同 CSS `--dur-*` 完全一致。 */
export const DUR = {
  fast: MOTION_TOKENS.durFast,
  normal: MOTION_TOKENS.durNormal,
  slow: MOTION_TOKENS.durSlow,
} as const;

/** 2 條 easing（CSS 字串）；同 CSS `--ease-*` 完全一致。 */
export const EASE = {
  standard: MOTION_TOKENS.easeStandard,
  emphasis: MOTION_TOKENS.easeEmphasis,
} as const;

/* ─────────────────────────────────────────────────────────────────────────
   環境探測（node 測試環境冇 window / rAF → 安全默認，唔會 crash）
   ───────────────────────────────────────────────────────────────────────── */

const hasWindow = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function raf(cb: (t: number) => void): number {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(cb);
  }
  return globalThis.setTimeout(() => cb(now()), 16) as unknown as number;
}

function caf(id: number): void {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(id);
    return;
  }
  globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

/**
 * 用戶係咪要求減少動效。
 *
 * 冇 `window` / `matchMedia`（例如 node 測試）→ 回 `false`（安全默認：
 * 唔會因為探測失敗而 crash）。
 */
export function prefersReducedMotion(): boolean {
  if (!hasWindow()) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 訂閱 reduced-motion 變化；回傳取消訂閱函式。 */
export function onReducedMotionChange(
  cb: (reduced: boolean) => void,
): () => void {
  if (!hasWindow()) return () => {};
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (typeof mq.addEventListener !== "function") return () => {};
  const handler = (): void => cb(mq.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

/* ─────────────────────────────────────────────────────────────────────────
   Easing（同 CSS cubic-bezier 逐點一致）
   ───────────────────────────────────────────────────────────────────────── */

/** 解析 `cubic-bezier(x1, y1, x2, y2)` → 數值。 */
function parseBezier(s: string): [number, number, number, number] {
  const m = s.match(/cubic-bezier\(([^)]+)\)/);
  if (!m) return [0.2, 0, 0, 1];
  const p = m[1].split(",").map((x) => Number(x.trim()));
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 1, p[3] ?? 1];
}

/** 標準 cubic-bezier 求值器（牛頓法 + 邊界 clamp）。 */
function makeBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) break;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return sampleY(t);
  };
}

/** 數值 easing 函式（由 `EASE` 字串生成）。 */
export const EASE_FN: Readonly<{
  standard: (x: number) => number;
  emphasis: (x: number) => number;
}> = {
  standard: makeBezier(...parseBezier(EASE.standard)),
  emphasis: makeBezier(...parseBezier(EASE.emphasis)),
};

/* ─────────────────────────────────────────────────────────────────────────
   Tween 核心
   ───────────────────────────────────────────────────────────────────────── */

const NOOP_HANDLE: MotionHandle = { cancel: () => {} };

/**
 * 內部：跑一個 tween。
 *
 * - `prefersReducedMotion()` 為真，或 `dur <= 0` → **同步一次** `step(1)`
 *   （即終態），唔開 rAF。
 * - 否則逐 frame 用 `EASE_FN.standard` 插值，最後一 frame 精確落 `step(1)`。
 */
function runTween(
  dur: number,
  step: (progress: number) => void,
  onDone?: () => void,
): MotionHandle {
  if (prefersReducedMotion() || dur <= 0) {
    step(1);
    onDone?.();
    return NOOP_HANDLE;
  }
  const start = now();
  let id = 0;
  const frame = (): void => {
    const t = Math.min(1, (now() - start) / dur);
    step(EASE_FN.standard(t));
    if (t < 1) {
      id = raf(frame);
    } else {
      onDone?.();
    }
  };
  id = raf(frame);
  return {
    cancel: () => caf(id),
  };
}

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

/**
 * 地圖視域轉場。
 *
 * reduced-motion → 直接 `apply(to)` 一次，**唔插值**（spec §6 驗收 C7：
 * rAF viewBox 值序列長度 ≤2）。
 */
export function animateViewport(
  from: Viewport,
  to: Viewport,
  dur: number,
  apply: (v: Viewport) => void,
  onDone?: () => void,
): MotionHandle {
  return runTween(
    dur,
    (p) => {
      apply({
        x: lerp(from.x, to.x, p),
        y: lerp(from.y, to.y, p),
        w: lerp(from.w, to.w, p),
        h: lerp(from.h, to.h, p),
      });
    },
    onDone,
  );
}

/** 純數值 tween（opacity / 進度 / 度量用）。 */
export function animateNumber(
  from: number,
  to: number,
  dur: number,
  apply: (n: number) => void,
  onDone?: () => void,
): MotionHandle {
  return runTween(dur, (p) => apply(lerp(from, to, p)), onDone);
}

/**
 * 喺容器內捲到指定位置。
 *
 * ⚠️ **唔用** `scrollIntoView` —— 規則 C1：`ChapterStrip` 唔可以再
 * `scrollIntoView`（A7 P0-2）。改為直接設 `scrollLeft` / `scrollTop`；
 * reduced-motion 之下即時跳（唔做 smooth）。
 */
export function scrollElementTo(
  el: HTMLElement,
  left: number,
  top: number,
  dur: number,
): MotionHandle {
  const l0 = el.scrollLeft;
  const t0 = el.scrollTop;
  return runTween(dur, (p) => {
    el.scrollLeft = lerp(l0, left, p);
    el.scrollTop = lerp(t0, top, p);
  });
}

/** 取消一個動效。 */
export function cancelMotion(handle: MotionHandle): void {
  handle.cancel();
}

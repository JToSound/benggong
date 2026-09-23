/**
 * motion.test.ts — reduced-motion JS 契約（spec §6 / A7 P1）。
 *
 * 現況 bug：CSS 層嘅 reduced-motion 有效，但 JS 層繞過 —— `reduce` 模式下
 * rAF `viewBox` 仍有 11 個相異值、smooth scroll 57 個，同 no-preference 一樣。
 *
 * V2 契約：`prefersReducedMotion()` 為真 → 同步一次跳終態、唔開 rAF、唔插值。
 * 本測試用可控時鐘 + rAF stub 驗證，唔靠真實 timer。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  animateNumber,
  animateViewport,
  cancelMotion,
  DUR,
  EASE,
  EASE_FN,
  onReducedMotionChange,
  prefersReducedMotion,
  scrollElementTo,
  type Viewport,
} from "../src/motion";

/* ── 可控環境 ─────────────────────────────────────────────────────────── */

let frames = new Map<number, (t: number) => void>();
let nextId = 1;
let fakeTime = 0;
let mqListeners: Array<() => void> = [];

const ORIG = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  raf: Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame"),
  caf: Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame"),
  perf: Object.getOwnPropertyDescriptor(globalThis, "performance"),
};

function defineOrDelete(key: string, desc?: PropertyDescriptor): void {
  if (desc) Object.defineProperty(globalThis, key, desc);
  else Reflect.deleteProperty(globalThis, key);
}

function installEnv(reduced: boolean): void {
  frames = new Map();
  nextId = 1;
  fakeTime = 0;
  mqListeners = [];
  const win = {
    matchMedia: (q: string) => ({
      matches: reduced && q.includes("reduce"),
      media: q,
      addEventListener: (_t: string, cb: () => void) => {
        mqListeners.push(cb);
      },
      removeEventListener: (_t: string, cb: () => void) => {
        mqListeners = mqListeners.filter((x) => x !== cb);
      },
    }),
  };
  Object.defineProperty(globalThis, "window", {
    value: win,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (cb: (t: number) => void): number => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: (id: number): void => {
      frames.delete(id);
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "performance", {
    value: { now: () => fakeTime },
    configurable: true,
    writable: true,
  });
}

/** 手動推 n 個 frame（每個 frame 前進 dt 毫秒）。 */
function pump(steps: number, dt = 16): number {
  let ran = 0;
  for (let i = 0; i < steps; i++) {
    const it = frames.entries().next();
    if (it.done) break;
    const [id, cb] = it.value;
    frames.delete(id);
    fakeTime += dt;
    cb(fakeTime);
    ran++;
  }
  return ran;
}

afterEach(() => {
  defineOrDelete("window", ORIG.window);
  defineOrDelete("requestAnimationFrame", ORIG.raf);
  defineOrDelete("cancelAnimationFrame", ORIG.caf);
  defineOrDelete("performance", ORIG.perf);
});

/* ── Tests ────────────────────────────────────────────────────────────── */

describe("token 一致性（CSS ↔ JS 共用唯一入口，規則 M2）", () => {
  it("DUR 同 CSS --dur-* 一致（120 / 220 / 420）", () => {
    expect(DUR).toEqual({ fast: 120, normal: 220, slow: 420 });
  });

  it("EASE 同 CSS --ease-* 一致", () => {
    expect(EASE.standard).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(EASE.emphasis).toBe("cubic-bezier(0.3, 0, 0, 1.1)");
  });

  it("EASE_FN 邊界正確（0→0、1→1）且單調", () => {
    expect(EASE_FN.standard(0)).toBe(0);
    expect(EASE_FN.standard(1)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = EASE_FN.standard(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("prefersReducedMotion()", () => {
  it("冇 window（node）→ false（安全默認，唔 crash）", () => {
    defineOrDelete("window", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("matchMedia reduce → true", () => {
    installEnv(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it("no-preference → false", () => {
    installEnv(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("onReducedMotionChange 可訂閱 / 取消", () => {
    installEnv(true);
    const got: boolean[] = [];
    const off = onReducedMotionChange((r) => got.push(r));
    expect(mqListeners.length).toBe(1);
    mqListeners.forEach((f) => f());
    expect(got).toEqual([true]);
    off();
    expect(mqListeners.length).toBe(0);
  });
});

describe("reduce 模式：直接跳終態（唔做 rAF 插值）", () => {
  it("animateViewport 只 apply 一次終態、唔開 rAF", () => {
    installEnv(true);
    const seen: Viewport[] = [];
    let done = 0;
    const h = animateViewport(
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 10, y: 5, w: 2, h: 2 },
      DUR.normal,
      (v) => seen.push(v),
      () => {
        done++;
      },
    );
    expect(frames.size).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({ x: 10, y: 5, w: 2, h: 2 });
    expect(done).toBe(1);
    cancelMotion(h);
  });

  it("animateNumber 只 apply 一次終值", () => {
    installEnv(true);
    const seen: number[] = [];
    animateNumber(0, 1, DUR.slow, (n) => seen.push(n));
    expect(frames.size).toBe(0);
    expect(seen).toEqual([1]);
  });

  it("scrollElementTo 即時設 scrollLeft / scrollTop，唔開 rAF", () => {
    installEnv(true);
    const el = { scrollLeft: 0, scrollTop: 0 } as unknown as HTMLElement;
    scrollElementTo(el, 120, 40, DUR.slow);
    expect(el.scrollLeft).toBe(120);
    expect(el.scrollTop).toBe(40);
    expect(frames.size).toBe(0);
  });
});

describe("no-preference：逐 frame 插值", () => {
  it("animateViewport 產生 >2 個相異值，最後精確落終態", () => {
    installEnv(false);
    const xs: number[] = [];
    animateViewport(
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 100, y: 0, w: 1, h: 1 },
      DUR.normal,
      (v) => xs.push(v.x),
    );
    pump(40, 16);
    const distinct = new Set(xs.map((n) => Math.round(n * 1000))).size;
    expect(distinct).toBeGreaterThan(2);
    expect(xs[xs.length - 1]).toBe(100);
  });

  it("animateNumber 由 from 行到 to", () => {
    installEnv(false);
    const ns: number[] = [];
    animateNumber(0, 10, DUR.fast, (n) => ns.push(n));
    pump(20, 16);
    // 全部值都喺 [0,10] 之內（插值唔會 overshoot）
    expect(ns.every((n) => n >= 0 && n <= 10)).toBe(true);
    // 有值喺中段（證明係逐 frame 插值，唔係直接跳）
    expect(ns.some((n) => n > 2 && n < 8)).toBe(true);
    // 最後精確落終值
    expect(ns[ns.length - 1]).toBe(10);
  });

  it("cancelMotion 停止後續 frame", () => {
    installEnv(false);
    const ns: number[] = [];
    const h = animateNumber(0, 100, DUR.slow, (n) => ns.push(n));
    pump(2, 16);
    const before = ns.length;
    cancelMotion(h);
    pump(40, 16);
    expect(ns.length).toBe(before);
  });
});

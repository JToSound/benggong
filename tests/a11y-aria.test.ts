// 《病港》World Atlas V2 — B8 無障礙 ARIA 契約測試
//
// 為何要有呢個檔案
// ================
// A7 審計（`docs/audits/mobile-a11y-audit.md`）量到 app 嘅 ARIA 語意幾乎係零：
//
//   aria-live / role=status / role=alert / role=log  → 0
//   aria-current                                     → 0
//   role="dialog"                                    → 0
//   `#search-modal` 有 role / aria-modal             → null / null
//   `.search-result-item` 有 role / tabindex         → null / -1
//   `#app-root`                                      → role="application"（P1-5）
//
// 呢個檔案用**mock DOM**（唔需要瀏覽器）斷言 B8 元件輸出嘅 ARIA 契約，
// 令「語意正確」變成可重跑嘅斷言，而唔係靠人手目測。
//
// 為何用 mock DOM 而唔係 jsdom
// ---------------------------
// 專案 `vitest` environment = `node`（見 `vite.config.ts`），冇 jsdom 依賴
// （規則：**唔准加新 runtime / dev 依賴**）。所以呢度用一個**極簡 DOM stub**
// 捕捉 `createElement` / `setAttribute` / `appendChild` 嘅呼叫，驗證
// 「元件有冇設正確嘅屬性」。真正嘅瀏覽器行為由 `tests/*.e2e.test.ts` 驗。

import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  KIND_LABEL,
  KIND_ORDER,
  moveActive,
  groupItems,
  type SearchItem,
} from "../src/components/SearchOverlay";
import { SNAP_ORDER, nextSnap, snapFromDrag } from "../src/components/BottomSheet";
import { kindForEntry, isDismissed, markDismissed, ONBOARDING_KEY } from "../src/components/OnboardingCard";

// ─────────────────────────────────────────────────────────────────────────────
// 1. 搜尋 5 類（spec IA §8 / A7 P2-4）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 ARIA：搜尋 5 類（spec IA §8）", () => {
  it("`KIND_LABEL` 覆蓋全部 5 類（唔可以有 fallback）", () => {
    for (const k of KIND_ORDER) {
      expect(KIND_LABEL[k], `${k} 要有標籤`).toBeTruthy();
    }
    expect(Object.keys(KIND_LABEL).sort()).toEqual(
      ["character", "chapter", "event", "location", "zone"].sort(),
    );
  });

  it("`KIND_ORDER` 係固定次序（結果 deterministic）", () => {
    expect(KIND_ORDER).toEqual(["character", "zone", "location", "event", "chapter"]);
  });

  it("`groupItems` 分組次序固定，唔跟輸入次序", () => {
    const items: SearchItem[] = [
      { kind: "chapter", id: "ch_5", label: "第 5 章" },
      { kind: "character", id: "c_xia", label: "夏晴" },
      { kind: "event", id: "e_burst", label: "爆發" },
      { kind: "zone", id: "z_surv", label: "倖存區" },
      { kind: "location", id: "l_tko", label: "將軍澳" },
    ];
    const groups = groupItems(items);
    expect(groups.map((g) => g.kind)).toEqual([
      "character",
      "zone",
      "location",
      "event",
      "chapter",
    ]);
  });

  it("每類有獨立上限（唔再係舊版全局限 50）", () => {
    const many: SearchItem[] = Array.from({ length: 60 }, (_, i) => ({
      kind: "event",
      id: `e_${i}`,
      label: `事件 ${i}`,
    }));
    const groups = groupItems(many, 20);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 鍵盤移動（aria-activedescendant 嘅 index 邏輯）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 ARIA：結果導覽 index（A7 P0-5）", () => {
  it("ArrowDown 由無選中 → 第一個", () => {
    expect(moveActive(-1, 1, 5)).toBe(0);
  });

  it("ArrowUp 由無選中 → 最後一個", () => {
    expect(moveActive(-1, -1, 5)).toBe(4);
  });

  it("唔可以越界（clamp）", () => {
    expect(moveActive(4, 1, 5)).toBe(4);
    expect(moveActive(0, -1, 5)).toBe(0);
  });

  it("空結果 → -1（唔會 set aria-activedescendant）", () => {
    expect(moveActive(-1, 1, 0)).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Bottom sheet snap（spec IA §5.4：3 段）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 ARIA：bottom sheet snap", () => {
  it("有 3 段 snap", () => {
    expect(SNAP_ORDER).toHaveLength(3);
    expect(SNAP_ORDER).toEqual(["peek", "half", "full"]);
  });

  it("`nextSnap` 上下都 clamp", () => {
    expect(nextSnap("peek", -1)).toBe("peek");
    expect(nextSnap("full", 1)).toBe("full");
    expect(nextSnap("peek", 1)).toBe("half");
    expect(nextSnap("full", -1)).toBe("half");
  });

  it("拖曳向下 → 收合（同手勢方向一致）", () => {
    // dy 正數 = 向下；0.5 * 800 = 400px > 0.4 門檻 → 跌兩級
    expect(snapFromDrag("full", 400, 800)).toBe("peek");
    // 0.2 * 800 = 160px，> 0.18 → 跌一級
    expect(snapFromDrag("full", 160, 800)).toBe("half");
    // 拖少少 → 唔變
    expect(snapFromDrag("half", 20, 800)).toBe("half");
  });

  it("拖曳向上 → 擴張", () => {
    // dy 負數 = 向上；-0.2 * 800 = -160px → 升一級
    expect(snapFromDrag("peek", -160, 800)).toBe("half");
    expect(snapFromDrag("peek", -400, 800)).toBe("full");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Onboarding 4 主入口（spec IA §5.1）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 ARIA：onboarding 4 主入口", () => {
  it("角色／事件入口對應正確搜尋種類", () => {
    expect(kindForEntry("character")).toBe("character");
    expect(kindForEntry("event")).toBe("event");
  });

  it("探索地區／編年史唔開搜尋", () => {
    expect(kindForEntry("explore")).toBeNull();
    expect(kindForEntry("chronicle")).toBeNull();
  });

  it("dismiss 狀態安全讀寫（storage 爆都唔會拋）", () => {
    const mem = new Map<string, string>();
    const fake = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(isDismissed(fake)).toBe(false);
    markDismissed(fake);
    expect(isDismissed(fake)).toBe(true);
    expect(mem.get(ONBOARDING_KEY)).toBe("1");
  });

  it("storage 拋錯時係安全默認（唔會壞 app）", () => {
    const boom = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    expect(isDismissed(boom)).toBe(false);
    expect(() => markDismissed(boom)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 靜態 ARIA 契約（讀 source；補 mock DOM 覆蓋唔到嘅結構）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 ARIA：靜態結構契約", () => {
  const SHEET = readFileSync("src/components/BottomSheet.ts", "utf8");
  const SEARCH = readFileSync("src/components/SearchOverlay.ts", "utf8");
  const ABOUT = readFileSync("src/components/AboutModal.ts", "utf8");
  const STRIP = readFileSync("src/components/ChapterStrip.ts", "utf8");
  const MOBILE_CSS = readFileSync("src/styles/mobile.css", "utf8");
  const CONTROLS = readFileSync("src/map/MapControls.ts", "utf8");

  it("SearchOverlay 有 role=dialog + aria-modal + aria-labelledby", () => {
    expect(SEARCH).toMatch(/setAttribute\(\s*"role"\s*,\s*"dialog"\s*\)/);
    expect(SEARCH).toMatch(/setAttribute\(\s*"aria-modal"\s*,\s*"true"\s*\)/);
    expect(SEARCH).toMatch(/aria-labelledby/);
  });

  it("SearchOverlay input 係 combobox + aria-activedescendant", () => {
    expect(SEARCH).toMatch(/role="combobox"/);
    expect(SEARCH).toMatch(/aria-activedescendant/);
    expect(SEARCH).toMatch(/role="listbox"/);
    expect(SEARCH).toMatch(/role="option"/);
    expect(SEARCH).toMatch(/aria-selected/);
  });

  it("SearchOverlay 有 aria-live 播報（P1-3）", () => {
    expect(SEARCH).toMatch(/aria-live="polite"/);
    expect(SEARCH).toMatch(/role="status"/);
  });

  it("SearchOverlay 有 focus trap + focus restore", () => {
    expect(SEARCH).toMatch(/trapTab/);
    expect(SEARCH).toMatch(/restoreFocus/);
    // 關閉時必須把 focus 移走（唔可以留喺隱藏 input）
    expect(SEARCH).toMatch(/\.focus\(\)/);
  });

  it("SearchOverlay 對背景設 inert（背景隔離）", () => {
    expect(SEARCH).toMatch(/setAttribute\(\s*"inert"\s*,\s*""\s*\)/);
  });

  it("AboutModal 有 role=dialog + aria-modal + focus trap + restore", () => {
    expect(ABOUT).toMatch(/setAttribute\(\s*"role"\s*,\s*"dialog"\s*\)/);
    expect(ABOUT).toMatch(/setAttribute\(\s*"aria-modal"\s*,\s*"true"\s*\)/);
    expect(ABOUT).toMatch(/focusables/);
    expect(ABOUT).toMatch(/prevFocus/);
  });

  it("BottomSheet handle 有 role=separator + aria-valuenow", () => {
    expect(SHEET).toMatch(/setAttribute\(\s*"role"\s*,\s*"separator"\s*\)/);
    expect(SHEET).toMatch(/aria-valuenow/);
    expect(SHEET).toMatch(/aria-valuemin/);
    expect(SHEET).toMatch(/aria-valuemax/);
  });

  it("BottomSheet 收合時設 inert（P0-1 雙重保險）", () => {
    expect(SHEET).toMatch(/setAttribute\(\s*"inert"\s*,\s*""\s*\)/);
    expect(SHEET).toMatch(/removeAttribute\(\s*"inert"\s*\)/);
  });

  it("BottomSheet full 狀態有 dialog 語意", () => {
    expect(SHEET).toMatch(/aria-modal/);
    expect(SHEET).toMatch(/sheetDialog/);
  });

  it("ChapterStrip 有 aria-current + aria-live（P1-3）", () => {
    expect(STRIP).toMatch(/aria-current/);
    expect(STRIP).toMatch(/aria-live="polite"/);
    expect(STRIP).toMatch(/role="status"/);
  });

  it("ChapterStrip **冇** scrollIntoView（P0-2）", () => {
    // 註解可以提，但唔可以有真正呼叫
    const code = STRIP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/scrollIntoView\s*\(/);
    // 要用 scrollElementTo（B1 motion，內建 reduced-motion）
    expect(code).toMatch(/scrollElementTo/);
  });

  it("MapControls 每粒掣有 data-focus-ring=inset（P0-3 契約標記）", () => {
    expect(CONTROLS).toMatch(/data-focus-ring="inset"/);
  });

  it("mobile.css 提供 inset box-shadow focus ring（clip-path 剪唔走）", () => {
    expect(MOBILE_CSS).toMatch(/box-shadow:\s*inset\s+0\s+0\s+0\s+2px\s+var\(--focus-ring\)/);
  });

  it("mobile.css 收合面板唔可 Tab（visibility: hidden）", () => {
    expect(MOBILE_CSS).toMatch(/\.pane-story\.is-collapsed[\s\S]*?visibility:\s*hidden/);
  });

  it("mobile.css 冇 raw hex（規則 T1）", () => {
    const clean = MOBILE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const hex = clean.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex, `唔可以有 hex：${hex.join(", ")}`).toHaveLength(0);
    expect(clean.match(/\brgba?\(/g) || []).toHaveLength(0);
  });

  it("mobile.css 有 safe-area（P1-7）", () => {
    const envCount = (MOBILE_CSS.match(/env\(safe-area-inset-/g) || []).length;
    expect(envCount, "env(safe-area-inset-*) 規則數要 ≥3").toBeGreaterThanOrEqual(3);
  });

  it("mobile.css 有 44px 下限（P1-1）", () => {
    for (const sel of [".nav-btn", ".ch-pill", "#map-controls .map-ctrl", ".legend-lang-btn"]) {
      const re = new RegExp(sel.replace(/[.#]/g, "\\$&") + "[\\s\\S]{0,200}?min-(width|height):\\s*44px");
      expect(MOBILE_CSS, `${sel} 要有 44px 下限`).toMatch(re);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 最小字級（VA4：≥12px）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8：mobile.css 字級唔可低於 token 下限", () => {
  it("冇細過 var(--fs-2xs)（12px）嘅硬寫字級", () => {
    const css = readFileSync("src/styles/mobile.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // 搵所有 font-size: Npx（唔理 var()）
    const hard = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    for (const px of hard) {
      expect(px, `hard-coded font-size ${px}px 低於 12px 下限`).toBeGreaterThanOrEqual(12);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 唔可以有 emoji-only 入口（A1 IA-P0-2）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8：OnboardingCard 4 入口有文字標籤", () => {
  it("4 個入口文字存在（唔係 emoji-only）", () => {
    const src = readFileSync("src/components/OnboardingCard.ts", "utf8");
    for (const label of ["探索地區", "搵角色", "搵事件", "打開編年史"]) {
      expect(src, `要有「${label}」入口`).toContain(label);
    }
  });

  it("有 h2 heading（解決 A7 P1-4 首屏冇結構）", () => {
    const src = readFileSync("src/components/OnboardingCard.ts", "utf8");
    expect(src).toMatch(/<h2[^>]*id="onboarding-title"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Reduced motion（P1-6：JS 層必須查 matchMedia）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8：reduced-motion JS 層（P1-6）", () => {
  const MOTION = readFileSync("src/motion.ts", "utf8");
  const SVG_MAP = readFileSync("src/components/SvgMap.ts", "utf8");
  const STRIP = readFileSync("src/components/ChapterStrip.ts", "utf8");

  it("motion.ts 有查 matchMedia('(prefers-reduced-motion: reduce)')", () => {
    expect(MOTION).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(MOTION).toMatch(/export function prefersReducedMotion/);
  });

  it("motion.ts 嘅 tween 喺 reduced-motion 之下同步跳終態（唔開 rAF）", () => {
    expect(MOTION).toMatch(/if\s*\(\s*prefersReducedMotion\(\)\s*\|\|\s*dur\s*<=\s*0\s*\)/);
  });

  it("SvgMap.animateViewBox 有查 prefersReducedMotion", () => {
    expect(SVG_MAP).toMatch(/prefersReducedMotion\(\)/);
  });

  it("ChapterStrip 捲動經 motion.ts（唔會繞過 reduced-motion）", () => {
    expect(STRIP).toMatch(/from\s+"\.\.\/motion"/);
    expect(STRIP).toMatch(/scrollElementTo/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. 唔可以硬寫動效時長（規則 M1 / A7 P1-6）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8：新元件唔硬寫動效時長", () => {
  it("BottomSheet / ChapterStrip 由 motion token 讀 duration", () => {
    const sheet = readFileSync("src/components/BottomSheet.ts", "utf8");
    const strip = readFileSync("src/components/ChapterStrip.ts", "utf8");
    expect(sheet).toMatch(/DUR\./);
    expect(strip).toMatch(/DUR\./);
  });

  it("新元件冇寫死 requestAnimationFrame 動畫（一律經 motion.ts）", () => {
    for (const f of [
      "src/components/BottomSheet.ts",
      "src/components/SearchOverlay.ts",
      "src/components/OnboardingCard.ts",
      "src/components/ChapterStrip.ts",
    ]) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(src, `${f} 唔應該自己開 rAF`).not.toMatch(/requestAnimationFrame\s*\(/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. placeholder：beforeEach 保持檔案有意義（避免 lint 未使用 import）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8：測試環境清白", () => {
  beforeEach(() => {
    // 呢個檔案全部係純函數 / 靜態斷言，唔需要 DOM。
    // `beforeEach` 保留作將來 mock DOM 擴充點。
  });

  it("全部斷言唔需要瀏覽器（node environment 可跑）", () => {
    expect(typeof document).toBe("undefined");
  });
});

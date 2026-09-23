/**
 * chronicle-a11y.test.ts — B7 編年史無障礙契約（鍵盤 / ARIA / CSS token）
 *
 * 為何要呢個檔
 * ============
 * A7 P0-5 實測：V1 嘅編年史**完全冇** `role`、冇 `aria-label`、冇鍵盤導航
 * —— 用鍵盤嘅用戶入到編年史就係死路（1,320 條 `<article>` 全部係
 * 非互動 div／article，冇一個可以 focus）。
 *
 * 呢個檔把 spec 嘅三組硬性要求變成可重跑斷言：
 *   1. **ARIA**：每個互動元素有可讀 label；狀態用 `aria-*` 表達；
 *   2. **鍵盤**：↑↓/jk、Home/End、Enter/Space 有定義；Esc 唔搶（app.ts 有）；
 *   3. **CSS token（規則 T1 / T4 / M1）**：`chronicle.css` 零 raw hex、
 *      零 rgb()/hsl() literal、時長一律 `var(--dur-*)`。
 *
 * ⚠️ CSS 檢查用 regex 掃檔（唔需要 CSS parser）—— 掃到一個 hex 就紅，
 * 係刻意的（規則 T1：`tokens.css` 係**唯一** token 定義處）。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
} from "../src/components/chronicle/a11y";

const CSS_PATH = "src/styles/chronicle.css";
const css = (): string => readFileSync(CSS_PATH, "utf8");

/* ─────────────────────────────────────────────────────────────────────────
   1. ARIA 文案（粵文；每個互動元素都有可讀 label）
   ───────────────────────────────────────────────────────────────────────── */

describe("ARIA 文案", () => {
  it("容器 label 係粵文，唔係空字串", () => {
    for (const [k, v] of Object.entries(CHRONICLE_ARIA)) {
      expect(typeof v).toBe("string");
      expect(v.length, `CHRONICLE_ARIA.${k} 唔可以空`).toBeGreaterThan(0);
    }
  });

  it("區域 label 明確（唔可以係泛用 'list'）", () => {
    expect(CHRONICLE_ARIA.regionLabel).toBe("第一季編年史");
  });

  it("章節 chip label 含章節號", () => {
    const s = ariaChapterChip(42);
    expect(s).toContain("42");
  });

  it("展開 label 反映狀態（展開 / 收起唔同）", () => {
    expect(ariaToggle("大本營", false)).toContain("展開");
    expect(ariaToggle("大本營", true)).toContain("收起");
    expect(ariaToggle("大本營", true)).not.toBe(ariaToggle("大本營", false));
  });

  it("伏筆 chip label 含目標標題同章節", () => {
    const s = ariaForeshadow("病毒爆發", 7);
    expect(s).toContain("病毒爆發");
    expect(s).toContain("7");
  });

  it("時期 rail label 含時期名同條目數", () => {
    const s = ariaPeriod("basecamp", "大本營時期", 12);
    expect(s).toContain("大本營時期");
    expect(s).toContain("12");
  });

  it("條目 label 含標題同首次提及章節", () => {
    const s = ariaEntry("大本營嘅建立", 2);
    expect(s).toContain("大本營嘅建立");
    expect(s).toContain("2");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   2. 鍵盤契約
   ───────────────────────────────────────────────────────────────────────── */

describe("鍵盤動作映射", () => {
  it("↓ / j → next", () => {
    expect(keyAction("ArrowDown")).toBe("next");
    expect(keyAction("j")).toBe("next");
  });

  it("↑ / k → prev", () => {
    expect(keyAction("ArrowUp")).toBe("prev");
    expect(keyAction("k")).toBe("prev");
  });

  it("Home / End → first / last", () => {
    expect(keyAction("Home")).toBe("first");
    expect(keyAction("End")).toBe("last");
  });

  it("Enter / Space → activate", () => {
    expect(keyAction("Enter")).toBe("activate");
    expect(keyAction(" ")).toBe("activate");
  });

  it("⚠️ Escape 唔由編年史處理（app.ts 已經有全域 handler）", () => {
    expect(keyAction("Escape")).toBeNull();
  });

  it("無關按鍵 → null（唔會食咗瀏覽器快捷鍵）", () => {
    expect(keyAction("a")).toBeNull();
    expect(keyAction("F5")).toBeNull();
    expect(keyAction("Tab")).toBeNull();
  });
});

describe("focus index 計算", () => {
  it("next 唔會超出尾", () => {
    expect(nextIndex(9, "next", 10)).toBe(9);
  });

  it("prev 唔會低過 0", () => {
    expect(nextIndex(0, "prev", 10)).toBe(0);
  });

  it("first / last", () => {
    expect(nextIndex(5, "first", 10)).toBe(0);
    expect(nextIndex(5, "last", 10)).toBe(9);
  });

  it("冇 focus（-1）→ 按 ↓ 去第 0 條", () => {
    expect(nextIndex(-1, "next", 10)).toBe(0);
    expect(nextIndex(-1, "prev", 10)).toBe(0);
  });

  it("空清單 → -1", () => {
    expect(nextIndex(0, "next", 0)).toBe(-1);
    expect(nextIndex(-1, "last", 0)).toBe(-1);
  });

  it("activate 保留目前 index", () => {
    expect(nextIndex(3, "activate", 10)).toBe(3);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   3. DOM id（aria-controls / focus 目標）
   ───────────────────────────────────────────────────────────────────────── */

describe("DOM id 契約", () => {
  it("entry / body id 唔同（aria-controls 唔可以指返自己）", () => {
    expect(entryDomId("x")).not.toBe(entryBodyDomId("x"));
  });

  it("id 係確定性（同輸入 1:1）", () => {
    expect(entryDomId("chr_1")).toBe(entryDomId("chr_1"));
    expect(entryDomId("chr_1")).not.toBe(entryDomId("chr_2"));
  });

  it("id 只用安全字元（可以放入 querySelector）", () => {
    expect(entryDomId("chr_abc-123")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   4. CSS token 契約（規則 T1 / T4 / M1）
   ───────────────────────────────────────────────────────────────────────── */

describe("chronicle.css —— 零 raw hex（規則 T1）", () => {
  it("冇任何 #rgb / #rrggbb / #rrggbbaa 色值", () => {
    const text = css();
    const hits = text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hits, `發現 raw hex：${hits.join(", ")}`).toEqual([]);
  });

  it("冇 rgb() / rgba() / hsl() / hsla() literal", () => {
    const text = css();
    const hits = text.match(/\b(?:rgba?|hsla?)\s*\(/g) ?? [];
    expect(hits, `發現 literal 色函式：${hits.join(", ")}`).toEqual([]);
  });

  it("所有顏色都經 var(--token)", () => {
    // 每個 `color:` / `background` 聲明都應該有 var( 或者 none / transparent / inherit。
    const lines = css().split(/\r?\n/);
    const offenders: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*(color|background|background-color|border-color|outline-color)\s*:\s*(.+?);/);
      if (!m) continue;
      const value = m[2];
      const ok =
        value.includes("var(") ||
        value === "none" ||
        value === "transparent" ||
        value === "inherit" ||
        value === "currentColor";
      if (!ok) offenders.push(line.trim());
    }
    expect(offenders, `未經 token 嘅顏色聲明：\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("chronicle.css —— motion token（規則 M1）", () => {
  it("transition / animation 時長一律 var(--dur-*)", () => {
    const text = css();
    // 搵 duration 位置出現嘅硬寫時間值（例如 120ms / .3s）。
    const raw = text.match(/(?:^|[\s,(])(\d*\.?\d+)(ms|s)\b/g) ?? [];
    // 0s 容許（等同無動效）。
    const offenders = raw.filter((v) => !/[\s,(]0(s|ms)$/.test(v.trim()));
    expect(offenders, `發現硬寫時長：${offenders.join(", ")}`).toEqual([]);
  });

  it("有 transition 就一定用 var(--dur-*)（`transition: none` 例外）", () => {
    const text = css();
    const transitions = text.match(/transition\s*:[^;]+;/g) ?? [];
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      // `transition: none` = 明確關掉動效（reduced-motion 例外），唔算硬寫時長。
      if (/transition\s*:\s*none\s*;/.test(t)) continue;
      expect(t, `transition 冇用 dur token：${t}`).toMatch(/var\(--dur-/);
    }
  });

  it("唔會硬寫 easing curve（要用 var(--ease-*)）", () => {
    const text = css();
    const hits = text.match(/cubic-bezier\s*\(/g) ?? [];
    expect(hits, "easing 一定要經 var(--ease-*)").toEqual([]);
  });
});

describe("chronicle.css —— 可讀性同互動（spec §7.3 / 規則 C3）", () => {
  it("冇 font-size 細過 12px", () => {
    const text = css();
    const sizes = text.match(/font-size\s*:\s*([^;]+);/g) ?? [];
    expect(sizes.length).toBeGreaterThan(0);
    for (const decl of sizes) {
      // token 形式一律安全（tokens.css 已經保證 ≥12px）；硬寫 px 就要檢查。
      const px = decl.match(/(\d+(?:\.\d+)?)px/);
      if (px) {
        expect(Number(px[1]), `font-size 過細：${decl}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it("每個 font-size 都係 var(--fs-*) 或者 ≥12px", () => {
    const sizes = css().match(/font-size\s*:\s*([^;]+);/g) ?? [];
    for (const decl of sizes) {
      const isToken = decl.includes("var(--fs-");
      const px = decl.match(/(\d+(?:\.\d+)?)px/);
      expect(
        isToken || (px !== null && Number(px[1]) >= 12),
        `font-size 唔合規：${decl}`,
      ).toBe(true);
    }
  });

  it("互動目標（chip / button）有 44px 下限", () => {
    const text = css();
    // 至少要有 min-height: 44px 出現（tap target）。
    expect(text).toContain("min-height: 44px");
  });

  it("有 :focus-visible 而且用 --focus-ring", () => {
    const text = css();
    expect(text).toContain(":focus-visible");
    expect(text).toContain("var(--focus-ring)");
  });

  it("冇 clip-path（規則：focus ring 唔可以被剪）", () => {
    expect(css()).not.toContain("clip-path");
  });
});

describe("chronicle.css —— reduced motion", () => {
  it("有 prefers-reduced-motion 區塊", () => {
    expect(css()).toContain("prefers-reduced-motion: reduce");
  });

  it("唔用 animation-duration:0.001ms 強制跳終態（A10 實測會令光環消失）", () => {
    const text = css();
    expect(text).not.toMatch(/animation-duration\s*:\s*0?\.0*1ms/);
  });
});

// 地圖元素鍵盤導覽（P1-2 / A7 驗收矩陣 §10.9）
//
// 為何要呢個檔
// ============
// A7 `mobile-a11y-audit.md` P1-2 實測：地圖 19 個互動元素**全部
// `tabIndex = -1`**、冇 `role`、冇 `aria-label`，互動只靠單一 delegated
// `click` handler → **鍵盤可達 = 0/19**。
//
// 修法係 **roving tabindex**（WAI-ARIA 對「一組同性質項目」嘅標準做法）。
// 呢個檔守住三件最容易錯嘅事：
//   1. **`markInteractive()` 只可以設 `tabindex="-1"`** —— 如果直接設 `0`，
//      48 個 zone 就會變成 48 個 Tab stop（鍵盤用戶要 Tab 過百次才離開
//      地圖），而且會撞紅 `a11y-keyboard.e2e.test.ts` 嘅「全頁 Tab stop
//      < 600」同「頂欄導覽要喺 20 次 Tab 內到達」。
//   2. **任何時候只有一個 `tabindex="0"`**（由 `applyRovingTabindex()` 統一管）。
//   3. **`Enter` 一定要自己處理** —— SVG 元素唔似 `<button>`，唔會自動合成
//      `click`；方向鍵亦一定要 `preventDefault`，否則會捲動頁面。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAP_INTERACTIVE_SELECTOR,
  isNavigationAction,
  resolveMapKey,
  rovingIndex,
} from "../src/map/map-keyboard";

const SRC = readFileSync("src/components/SvgMap.ts", "utf-8");
const CSS = readFileSync("src/styles/map.css", "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// 按鍵映射
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveMapKey", () => {
  it("Enter / Space（兩種寫法）→ activate", () => {
    expect(resolveMapKey("Enter")).toBe("activate");
    expect(resolveMapKey(" ")).toBe("activate");
    // ⚠️ 舊 IE／部分瀏覽器嘅寫法，唔收就會有瀏覽器用唔到
    expect(resolveMapKey("Spacebar")).toBe("activate");
  });

  it("方向鍵 → next / prev（上下左右都要）", () => {
    expect(resolveMapKey("ArrowRight")).toBe("next");
    expect(resolveMapKey("ArrowDown")).toBe("next");
    expect(resolveMapKey("ArrowLeft")).toBe("prev");
    expect(resolveMapKey("ArrowUp")).toBe("prev");
  });

  it("Home / End / Escape", () => {
    expect(resolveMapKey("Home")).toBe("first");
    expect(resolveMapKey("End")).toBe("last");
    expect(resolveMapKey("Escape")).toBe("escape");
  });

  it("其他鍵 → none（唔可以攔截，否則 Tab 都行唔到）", () => {
    for (const k of ["Tab", "a", "F5", "Shift", "PageDown", ""]) {
      expect(resolveMapKey(k), `key=${k}`).toBe("none");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roving index
// ─────────────────────────────────────────────────────────────────────────────

describe("rovingIndex", () => {
  it("next / prev 會**環繞**", () => {
    expect(rovingIndex(0, "next", 3)).toBe(1);
    expect(rovingIndex(2, "next", 3)).toBe(0); // 尾 → 頭
    expect(rovingIndex(0, "prev", 3)).toBe(2); // 頭 → 尾
  });

  it("Home / End 跳去兩端", () => {
    expect(rovingIndex(2, "first", 5)).toBe(0);
    expect(rovingIndex(0, "last", 5)).toBe(4);
  });

  it("未有焦點（-1）→ next 由第一個開始", () => {
    expect(rovingIndex(-1, "next", 3)).toBe(0);
  });

  it("越界索引會被夾返範圍", () => {
    expect(rovingIndex(99, "activate", 3)).toBe(2);
    expect(rovingIndex(-99, "activate", 3)).toBe(0);
  });

  it("activate / escape / none 唔會移動索引", () => {
    for (const a of ["activate", "escape", "none"] as const) {
      expect(rovingIndex(1, a, 3), `action=${a}`).toBe(1);
    }
  });

  it("空組 → -1（唔會回 NaN）", () => {
    expect(rovingIndex(0, "next", 0)).toBe(-1);
    expect(rovingIndex(0, "first", 0)).toBe(-1);
  });
});

describe("isNavigationAction", () => {
  it("只有四個方向動作需要 preventDefault", () => {
    for (const a of ["next", "prev", "first", "last"] as const) {
      expect(isNavigationAction(a), `action=${a}`).toBe(true);
    }
    for (const a of ["activate", "escape", "none"] as const) {
      expect(isNavigationAction(a), `action=${a}`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 選擇器
// ─────────────────────────────────────────────────────────────────────────────

describe("MAP_INTERACTIVE_SELECTOR", () => {
  it("覆蓋 A7 實測到嘅五類互動元素", () => {
    for (const cls of [
      ".zone",
      ".route-line",
      ".location-marker",
      ".location-marker-cluster",
      ".event-marker",
    ]) {
      expect(MAP_INTERACTIVE_SELECTOR, `缺少 ${cls}`).toContain(cls);
    }
  });

  it("同 `resolveHit()` 嘅 HIT_SELECTORS 一致（唔可以漏咗可點元素）", () => {
    const INTERACTIONS = readFileSync("src/map/map-interactions.ts", "utf-8");
    for (const cls of [
      ".zone",
      ".route-line",
      ".location-marker",
      ".location-marker-cluster",
      ".event-marker",
    ]) {
      expect(INTERACTIONS, `HIT_SELECTORS 冇 ${cls}`).toContain(cls);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SvgMap 接線（靜態守門）
// ─────────────────────────────────────────────────────────────────────────────

describe("SvgMap 接線（靜態守門）", () => {
  it("⭐ `markInteractive()` 設 tabindex=-1 / role=button / aria-label", () => {
    const i = SRC.indexOf("private markInteractive(");
    expect(i, "搵唔到 markInteractive").toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 900);
    expect(body).toContain('setAttribute("tabindex", "-1")');
    expect(body).toContain('setAttribute("role", "button")');
    expect(body).toContain('setAttribute("aria-label", label)');
    // ⚠️ 唔可以喺呢度設 "0" —— 會令每個元素都變成 Tab stop
    expect(body).not.toContain('setAttribute("tabindex", "0")');
  });

  it("⭐ 五類元素都有呼叫 `markInteractive()`", () => {
    const calls = SRC.match(/this\.markInteractive\(/g) ?? [];
    // zone / route-line / location-marker / cluster / event-marker
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("⭐ `render()` 尾部會重新決定 roving tabindex", () => {
    const i = SRC.indexOf("render(): void {");
    expect(i, "搵唔到 render()").toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 60000);
    expect(body).toContain("this.applyRovingTabindex()");
  });

  it("⭐ `applyRovingTabindex()` 只會有一個 `tabindex=\"0\"`", () => {
    const i = SRC.indexOf("private applyRovingTabindex(");
    expect(i).toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 1200);
    // 條件式：i === idx ? "0" : "-1"
    expect(body).toMatch(/i === idx \? "0" : "-1"/);
  });

  it("⭐ 有 delegated keydown，而且用 `resolveMapKey` + `preventDefault`", () => {
    const i = SRC.indexOf("private bindMapKeyboard(");
    expect(i, "搵唔到 bindMapKeyboard").toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 2200);
    expect(body).toContain('addEventListener("keydown"');
    expect(body).toContain("resolveMapKey(e.key)");
    expect(body).toContain("e.preventDefault()");
    // 啟動一定要行同一條路徑（唔可以另寫一套）
    expect(body).toContain("this.handleHitAt(el)");
  });

  it("⭐ 有 delegated focusin 同步 roving（滑鼠點完再用鍵盤）", () => {
    const i = SRC.indexOf("private bindMapKeyboard(");
    const body = SRC.slice(i, i + 2600);
    expect(body).toContain('addEventListener("focusin"');
  });

  it("`handleHitAt()` 係共用方法（click / pointerup / 鍵盤同一條路徑）", () => {
    expect(SRC).toContain("private handleHitAt(");
    expect(SRC).toContain("this.handleHitAt(targetEl)");
  });

  it("`bindSvgDelegation()` 有呼叫 `bindMapKeyboard()`", () => {
    const i = SRC.indexOf("private bindSvgDelegation(");
    const body = SRC.slice(i, i + 700);
    expect(body).toContain("this.bindMapKeyboard()");
  });
});

describe("焦點環 CSS（靜態守門）", () => {
  it("⭐ 五類元素都有 :focus-visible 規則", () => {
    for (const cls of [
      ".zone",
      ".route-line",
      ".location-marker",
      ".location-marker-cluster",
      ".event-marker",
    ]) {
      expect(CSS, `缺少 ${cls}:focus-visible`).toContain(
        `#svg-map ${cls}:focus-visible`,
      );
    }
  });

  it("⭐ 唔用 `outline`，用 `drop-shadow`（SVG 冇 box model）", () => {
    const i = CSS.indexOf("P1-2：地圖元素鍵盤焦點環");
    expect(i, "搵唔到 P1-2 CSS 區塊").toBeGreaterThan(-1);
    const block = CSS.slice(i);
    expect(block).toContain("drop-shadow(");
    expect(block).toContain("var(--focus-ring)");
    expect(block).toContain("outline: none");
  });
});

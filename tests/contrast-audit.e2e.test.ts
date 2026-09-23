// P2-3：對比度驗證（真實瀏覽器，量 computed style）
//
// 為何要有呢個檔
// ============
// A7 P2-3 量到 dark 12 個、light 6 個文字節點對比 < 4.5:1。
// 修法係改 token 值（`--fg-muted` / `--hud-cyan` / `--accent-yellow` / `.skip-link` 背景）。
// 呢個測試喺**真實瀏覽器**量 computed style，程式化計 WCAG 對比 —— 唔靠人手目測。

import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

/** 喺頁面內計 WCAG 對比度（回傳 { sel, ratio, fg, bg }）。 */
const MEASURE = (selectors: string[]) => {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  /*
   * ⚠️ 只接受「接近實色」嘅背景（alpha ≥ 0.5）。
   *
   * 實測陷阱：`[data-theme="light"] .nav-btn` 嘅背景係
   * `rgba(31,39,51,0.035)`（幾乎全透明）。如果當佢係實色，就會得出
   * 「fg 同 bg 一樣 → 對比 1」嘅假陽性（實際背景係祖先嘅淺色）。
   */
  const parse = (s: string): [number, number, number] | null => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(s);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (a < 0.5) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const lum = (rgb: [number, number, number]): number =>
    0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (a: [number, number, number], b: [number, number, number]): number => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const out: { sel: string; ratio: number; fg: string; bg: string }[] = [];
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    // 背景可能係半透明 → 向上搵第一個「接近實色」嘅祖先（`parse` 已過濾 alpha）
    let bgEl: HTMLElement | null = el;
    let bg: [number, number, number] | null = null;
    while (bgEl && !bg) {
      bg = parse(getComputedStyle(bgEl).backgroundColor);
      bgEl = bgEl.parentElement;
    }
    if (!fg || !bg) continue;
    out.push({ sel, ratio: Math.round(ratio(fg, bg) * 100) / 100, fg: cs.color, bg: cs.backgroundColor });
  }
  return out;
};

describe("P2-3 對比度（WCAG 4.5:1）", () => {
  it("dark 主題：關鍵文字節點對比 ≥ 4.5", async () => {
    const browser = await chromium.launch({ args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
      // A7 量到違規嘅：ch-pill（4.22）、legend-lang-btn（3.93）
      const res = await page.evaluate(MEASURE, [".ch-pill", "#legend-lang-btn"]);
      for (const r of res) {
        expect(r.ratio, `${r.sel} 對比 ${r.ratio}（fg ${r.fg}）應該 ≥ 4.5`).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("light 主題：關鍵文字節點對比 ≥ 4.5", async () => {
    const browser = await chromium.launch({ args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2000);
      await page.click("#btn-theme"); // 切 light
      await page.waitForTimeout(1200);
      /*
       * ⚠️ 切主題之後一定要**移開滑鼠**。
       *
       * `page.click()` 會令滑鼠停留喺掣上 → `:hover` 生效 → 量到嘅係
       * hover 顏色而唔係靜態顏色（會誤判，實測 `#btn-theme` 量到 1.24）。
       */
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);

      // A7 量到違規嘅：btn-theme（3.67）、strip-current（3.25）、
      // strip-ch-num（3.06）、legend-title（4.38）、legend-lang-btn（3.47）
      const res = await page.evaluate(MEASURE, [
        "#btn-theme",
        ".strip-current",
        "#strip-ch-num",
        ".legend-title",
        "#legend-lang-btn",
      ]);
      for (const r of res) {
        expect(r.ratio, `${r.sel} 對比 ${r.ratio}（fg ${r.fg}）應該 ≥ 4.5`).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await browser.close();
    }
  }, 90_000);
});

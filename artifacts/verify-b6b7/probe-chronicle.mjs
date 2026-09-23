// 針對 chronicle 嘅聚焦驗證 v2 — 用真實 class (.chr-*)
import { chromium } from "@playwright/test";

const BASE = "http://localhost:5174/";
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#svg-map", { timeout: 30000 });
await page.waitForTimeout(1200);
await page.click("#btn-mode");
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const sample = (sel, props) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, exists: false };
    const c = getComputedStyle(el);
    const o = { sel, exists: true };
    for (const p of props) o[p] = c.getPropertyValue(p);
    return o;
  };
  return {
    counts: {
      entry: document.querySelectorAll(".chr-entry").length,
      period: document.querySelectorAll(".chr-period").length,
      rail: document.querySelectorAll(".chr-rail").length,
      btn: document.querySelectorAll(".chr-btn").length,
      bead: document.querySelectorAll(".chr-entry .chr-period").length,
    },
    style: [
      sample(".chronicle", ["display", "grid-template-columns", "background-color"]),
      sample(".chr-entry", ["position", "padding", "border-left-width", "border-left-color", "margin-bottom"]),
      sample(".chr-period", ["position", "font-weight", "font-size", "color"]),
      sample(".chr-rail", ["position", "gap", "overflow-y", "display"]),
      sample(".chr-btn", ["background-color", "border-radius", "min-height", "font-size", "cursor"]),
      sample(".chr-entry-title", ["font-size", "font-weight", "color"]),
      sample(".chr-ch", ["font-size", "background-color", "border-radius", "padding"]),
    ],
  };
});
console.log("=== counts ===");
console.log(JSON.stringify(info.counts, null, 2));
console.log("=== computed style ===");
console.log(JSON.stringify(info.style, null, 2));

// 對照實驗：停用 chronicle sheet
const contrast = await page.evaluate(async () => {
  const el = document.querySelector(".chr-entry");
  if (!el) return { ok: false, reason: "冇 .chr-entry" };
  const snap = (e) => {
    const c = getComputedStyle(e);
    return { pos: c.position, padT: c.paddingTop, borderL: c.borderLeftWidth, mb: c.marginBottom, w: c.width, h: c.height };
  };
  const before = snap(el);
  const disabled = [];
  for (const s of document.styleSheets) {
    try {
      if ([...s.cssRules].some(r => /chronicle-|\.chr-/.test(r.cssText || ""))) {
        s.disabled = true; disabled.push(s.href ? s.href.split("/").pop() : "inline");
      }
    } catch {}
  }
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  const after = snap(el);
  for (const s of document.styleSheets) { try { s.disabled = false; } catch {} }
  return { ok: true, disabled, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
});
console.log("=== 對照實驗：停用 chronicle sheet 後 computed style ===");
console.log(JSON.stringify(contrast, null, 2));

// 6. 掣尺寸（a11y）
const sizes = await page.evaluate(() =>
  [".chr-btn", ".chr-rail-item", ".chr-toggle"].map(sel => {
    const el = document.querySelector(sel);
    if (!el) return { sel, exists: false };
    const r = el.getBoundingClientRect();
    return { sel, w: Math.round(r.width), h: Math.round(r.height) };
  })
);
console.log("=== 掣尺寸 ===", JSON.stringify(sizes));

console.log("=== pageErrors ===", errs);
await browser.close();

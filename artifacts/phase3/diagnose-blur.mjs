/**
 * 緊急診斷：地圖「超級模糊」問題。
 *
 * 量關鍵元素嘅 filter / backdrop-filter / opacity / 尺寸 / transform，
 * 以及 canvas 有冇實際繪製（非全透明）。
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);

const report = await page.evaluate(() => {
  const sels = [
    "#svg-map",
    ".svg-map-wrap",
    "#map-overlay",
    "#map-legend",
    "#basemap-layer",
    "#map-controls",
    "#story-pane",
    "canvas",
  ];
  const out = [];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) {
      out.push({ sel, missing: true });
      continue;
    }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      sel,
      filter: cs.filter,
      backdrop: cs.backdropFilter,
      opacity: cs.opacity,
      transform: cs.transform,
      mixBlend: cs.mixBlendMode,
      w: Math.round(r.width),
      h: Math.round(r.height),
      vis: cs.visibility,
      disp: cs.display,
    });
  }
  // canvas 有冇實際繪製？
  const cv = document.querySelector("canvas");
  let canvasInfo = null;
  if (cv instanceof HTMLCanvasElement) {
    const ctx = cv.getContext("2d");
    canvasInfo = { w: cv.width, h: cv.height, hasCtx: !!ctx };
    if (ctx) {
      try {
        const d = ctx.getImageData(0, 0, Math.min(cv.width, 50), Math.min(cv.height, 50)).data;
        let nonTransparent = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonTransparent++;
        canvasInfo.nonTransparentTopLeft = nonTransparent;
      } catch (e) {
        canvasInfo.err = String(e);
      }
    }
  }
  return { els: out, canvasInfo, dpr: window.devicePixelRatio };
});

console.log("=== 元素 computed style ===");
for (const e of report.els) {
  if (e.missing) {
    console.log(`  ${e.sel}: 唔存在`);
    continue;
  }
  console.log(
    `  ${e.sel}: filter=${e.filter} backdrop=${e.backdrop} opacity=${e.opacity} ` +
      `mix=${e.mixBlend} ${e.w}×${e.h} vis=${e.vis} disp=${e.disp}`,
  );
}
console.log("\n=== canvas ===");
console.log(" ", JSON.stringify(report.canvasInfo));
console.log("  DPR:", report.dpr);
console.log("\n=== console errors ===");
console.log(errors.length ? errors.slice(0, 8).join("\n") : "  （冇）");

await browser.close();

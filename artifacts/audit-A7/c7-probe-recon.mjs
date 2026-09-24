/**
 * C7 偵察探測：地圖互動元素嘅組成、次序、可見性。
 *
 * 目的：先搞清楚「25」係咩，再設計敵意測試。
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-recon.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const SEL = ".zone, .route-line, .location-marker, .location-marker-cluster, .event-marker";

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map", { timeout: 20000 });
await page
  .waitForFunction(
    () => document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ?? false,
    null,
    { timeout: 20000 },
  )
  .catch(() => {});
await page.waitForTimeout(1500);
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
  await page.waitForTimeout(150);
}
await page.waitForTimeout(900);

const recon = await page.evaluate((SEL) => {
  const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
  const cls = (e) => (e.getAttribute("class") ?? "").split(/\s+/)[0];
  const typeCount = {};
  els.forEach((e) => {
    const c = cls(e);
    typeCount[c] = (typeCount[c] ?? 0) + 1;
  });
  // document order 前綴：由頭開始連續同一 class 有幾多個
  const firstRun = [];
  for (const e of els) {
    const c = cls(e);
    if (firstRun.length === 0 || firstRun[firstRun.length - 1].type === c) {
      if (firstRun.length === 0) firstRun.push({ type: c, n: 0 });
      firstRun[firstRun.length - 1].n++;
    } else break;
  }
  const svg = document.querySelector("#svg-map");
  const zoneCount = document.querySelectorAll("#zones-layer .zone").length;
  // 每個 type 第一同最後出現嘅 index
  const typeIndexRange = {};
  els.forEach((e, i) => {
    const c = cls(e);
    if (!typeIndexRange[c]) typeIndexRange[c] = { first: i, last: i, n: 0 };
    typeIndexRange[c].last = i;
    typeIndexRange[c].n++;
  });
  return {
    interactiveTotal: els.length,
    typeCount,
    firstRun,
    typeIndexRange,
    zoneLayerCount: zoneCount,
    order: els.map((e, i) => ({
      i,
      type: cls(e),
      id:
        e.getAttribute("data-zone-id") ??
        e.getAttribute("data-loc-id") ??
        e.getAttribute("data-event-id") ??
        e.getAttribute("data-route-id") ??
        "",
    })),
    svgTabindex: svg?.getAttribute("tabindex"),
    svgRole: svg?.getAttribute("role"),
    svgAriaLabel: svg?.getAttribute("aria-label"),
  };
}, SEL);

fs.writeFileSync("artifacts/audit-A7/c7-recon.json", JSON.stringify(recon, null, 2));
console.log(JSON.stringify({ ...recon, order: recon.order.slice(0, 80) }, null, 2));
await browser.close();

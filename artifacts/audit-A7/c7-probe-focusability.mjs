/**
 * C7 探測 B：逐個互動元素嘅**真實可聚焦性** + 診斷原因。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-focusability.mjs
 * 輸出：artifacts/audit-A7/c7-focusability.json
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const SEL =
  ".zone, .route-line, .location-marker, .location-marker-cluster, .event-marker";
const OUT = "artifacts/audit-A7/c7-focusability.json";
const log = (...a) => console.log("[focusability]", ...a);

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
log("goto");
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#svg-map", { state: "visible", timeout: 25000 });
await page.waitForTimeout(1500);
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
  await page.waitForTimeout(150);
}
await page.waitForTimeout(800);
log("loaded");

const res = await page.evaluate((SEL) => {
  const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
  const out = [];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const cls = (el.getAttribute("class") ?? "").split(/\s+/)[0];
    const id =
      el.getAttribute("data-zone-id") ??
      el.getAttribute("data-loc-id") ??
      el.getAttribute("data-event-id") ??
      el.getAttribute("data-route-id") ??
      "";
    // 試聚焦
    const before = document.activeElement;
    let focused = false;
    try {
      el.focus();
      focused = document.activeElement === el;
    } catch {
      focused = false;
    }
    if (before && before.blur) before.blur?.();
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.push({
      i,
      type: cls,
      id,
      tag: el.tagName,
      tabindex: el.getAttribute("tabindex"),
      role: el.getAttribute("role"),
      focusableByFocus: focused,
      bbox: { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) },
      display: cs.display,
      visibility: cs.visibility,
      pointerEvents: cs.pointerEvents,
      opacity: cs.opacity,
      fill: cs.fill,
      stroke: cs.stroke,
      parentDisplay: el.parentElement ? getComputedStyle(el.parentElement).display : null,
    });
  }
  return out;
}, SEL);

const byType = {};
for (const r of res) {
  byType[r.type] ??= { n: 0, focusable: 0, examples: [] };
  byType[r.type].n++;
  if (r.focusableByFocus) byType[r.type].focusable++;
  if (byType[r.type].examples.length < 2)
    byType[r.type].examples.push({
      id: r.id,
      tag: r.tag,
      focusable: r.focusableByFocus,
      bbox: r.bbox,
      display: r.display,
      visibility: r.visibility,
      pointerEvents: r.pointerEvents,
      opacity: r.opacity,
      fill: r.fill,
      stroke: r.stroke,
    });
}

const summary = {
  measuredAt: new Date().toISOString(),
  total: res.length,
  focusableCount: res.filter((r) => r.focusableByFocus).length,
  byType,
  nonFocusable: res
    .filter((r) => !r.focusableByFocus)
    .map((r) => ({
      i: r.i,
      type: r.type,
      id: r.id,
      tag: r.tag,
      bbox: r.bbox,
      display: r.display,
      visibility: r.visibility,
      pointerEvents: r.pointerEvents,
      opacity: r.opacity,
      fill: r.fill,
      stroke: r.stroke,
      parentDisplay: r.parentDisplay,
    })),
};
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close();

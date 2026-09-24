/**
 * C7 探測 A：無上限 roving 環繞 —— 係唔係全部互動元素都鍵盤到得到？
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-traversal.mjs
 * 輸出：artifacts/audit-A7/c7-traversal.json
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const SEL =
  ".zone, .route-line, .location-marker, .location-marker-cluster, .event-marker";
const OUT = "artifacts/audit-A7/c7-traversal.json";
const log = (...a) => console.log("[traversal]", ...a);

const IDENT = () => {
  const el = document.activeElement;
  if (!el || !el.getAttribute) return null;
  const id =
    el.getAttribute("data-zone-id") ??
    el.getAttribute("data-loc-id") ??
    el.getAttribute("data-event-id") ??
    el.getAttribute("data-route-id") ??
    "";
  const cls = (el.getAttribute("class") ?? "").split(/\s+/)[0];
  return `${cls}|${id}`;
};

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

const expected = await page.evaluate((SEL) => {
  const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
  return els.map((e) => {
    const id =
      e.getAttribute("data-zone-id") ??
      e.getAttribute("data-loc-id") ??
      e.getAttribute("data-event-id") ??
      e.getAttribute("data-route-id") ??
      "";
    const cls = (e.getAttribute("class") ?? "").split(/\s+/)[0];
    return `${cls}|${id}`;
  });
}, SEL);
const total = expected.length;
log("interactive total =", total);

await page.evaluate(() => {
  const s = document.querySelector("#svg-map");
  if (s && typeof s.focus === "function") s.focus();
});
await page.keyboard.press("Tab");
await page.waitForTimeout(250);
const seq = [await page.evaluate(IDENT)];
for (let i = 0; i < total + 6; i++) {
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(40);
  seq.push(await page.evaluate(IDENT));
}
log("traversed", seq.length, "steps");

const reached = new Set(seq.filter(Boolean));
const firstCycle = seq.slice(1, total + 1);
const wrapped = seq[total] === seq[0] || seq[total + 1] === seq[1];

const offscreen = await page.evaluate(
  ([SEL]) => {
    const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
    const out = [];
    els.forEach((e, i) => {
      const b = e.getBoundingClientRect();
      const visible =
        b.width > 0 &&
        b.height > 0 &&
        b.bottom > 0 &&
        b.right > 0 &&
        b.top < window.innerHeight &&
        b.left < window.innerWidth;
      if (!visible)
        out.push({ i, cls: (e.getAttribute("class") ?? "").split(/\s+/)[0] });
    });
    return { count: out.length, sample: out.slice(0, 10) };
  },
  [SEL],
);

const tabindexInvariant = await page.evaluate((SEL) => {
  const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
  return {
    zero: els.filter((e) => e.getAttribute("tabindex") === "0").length,
    minusOne: els.filter((e) => e.getAttribute("tabindex") === "-1").length,
  };
}, SEL);

const res = {
  measuredAt: new Date().toISOString(),
  expectedTotal: total,
  distinctReached: reached.size,
  allReachable: reached.size === total,
  firstCycleMatchesDocOrder:
    JSON.stringify(firstCycle) === JSON.stringify(expected),
  wrappedBackToStart: wrapped,
  seqHead: seq.slice(0, 30),
  seqTail: seq.slice(-8),
  neverReached: expected.filter((e) => !reached.has(e)),
  offscreenElements: offscreen,
  tabindexInvariant,
};
fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
await browser.close();

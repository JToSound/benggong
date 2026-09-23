/**
 * A7 補量測 #3c：focus ring 可見度 —— 每個元素用全新 page，消除 Tab 起始點污染。
 * 量測方式：鍵盤 Tab / Shift+Tab 到達目標 → 逐像素比對 focused/unfocused 截圖，
 * 分開計「ring 區（border box 以外）」同「內部」變化像素。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5190/";
const OUT = "artifacts/audit-A7";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });

async function diffPx(page, a64, b64, c) {
  return page.evaluate(async ({ a64, b64, ix0, iy0, ix1, iy1 }) => {
    const load = (s) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = "data:image/png;base64," + s; });
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    const cv = document.createElement("canvas"); cv.width = ia.width; cv.height = ia.height;
    const g = cv.getContext("2d");
    g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, cv.width, cv.height).data;
    g.clearRect(0, 0, cv.width, cv.height); g.drawImage(ib, 0, 0);
    const db = g.getImageData(0, 0, cv.width, cv.height).data;
    let ring = 0, inner = 0;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      if (Math.abs(da[i]-db[i]) + Math.abs(da[i+1]-db[i+1]) + Math.abs(da[i+2]-db[i+2]) < 12) continue;
      if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) inner++; else ring++;
    }
    return { ringChangedPx: ring, innerChangedPx: inner };
  }, { a64, b64, ix0: c.ix0, iy0: c.iy0, ix1: c.ix1, iy1: c.iy1 });
}

async function one(vp, selector, dir, killClipPath) {
  const ctx = await browser.newContext(vp);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1400);
  if (killClipPath) {
    await page.evaluate(() => { const s = document.createElement("style");
      s.textContent = "*,*::before,*::after{clip-path:none !important}"; document.head.appendChild(s); });
    await page.waitForTimeout(250);
  }
  const el = await page.$(selector);
  if (!el) { await ctx.close(); return { selector, exists: false }; }
  const box = await el.boundingBox();
  if (!box || box.width === 0) { await ctx.close(); return { selector, exists: true, box, note: "冇可見 box" }; }
  const pad = 14, cx = Math.max(0, Math.floor(box.x - pad)), cy = Math.max(0, Math.floor(box.y - pad));
  const clip = { x: cx, y: cy, width: Math.ceil(box.width + pad*2), height: Math.ceil(box.height + pad*2),
    ix0: Math.floor(box.x)-cx, iy0: Math.floor(box.y)-cy, ix1: Math.ceil(box.x+box.width)-cx, iy1: Math.ceil(box.y+box.height)-cy };
  const resetScroll = () => page.evaluate(() => { window.scrollTo(0,0);
    document.querySelectorAll("*").forEach((e) => { if (e.scrollLeft) e.scrollLeft = 0; if (e.scrollTop) e.scrollTop = 0; }); });
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await resetScroll(); await page.waitForTimeout(200);
  const before = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
  let reached = false, steps = 0;
  for (let i = 1; i <= 215; i++) {
    await page.keyboard.press(dir === "back" ? "Shift+Tab" : "Tab"); steps = i;
    if (await page.evaluate((s) => document.activeElement && document.activeElement.matches(s), selector)) { reached = true; break; }
  }
  if (!reached) { await ctx.close(); return { selector, exists: true, reachedByTab: false, steps, killClipPath: !!killClipPath }; }
  await resetScroll(); await page.waitForTimeout(220);
  const after = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
  const d = await diffPx(page, before.toString("base64"), after.toString("base64"), clip);
  const st = await page.evaluate((s) => { const e = document.querySelector(s); const cs = getComputedStyle(e);
    return { outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor, outlineOffset: cs.outlineOffset,
      focusVisibleMatched: e.matches(":focus-visible"), selfClipPath: cs.clipPath !== "none" ? cs.clipPath : null,
      borderBox: (() => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })() }; }, selector);
  await ctx.close();
  return { selector, exists: true, reachedByTab: true, steps, direction: dir, killClipPath: !!killClipPath, ...d, ringVisible: d.ringChangedPx > 20, ...st };
}

const VP = { mobile390: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
             desktop1440: { viewport: { width: 1440, height: 900 } } };
const TOPBAR = ["#btn-toggle-panel", "#btn-about", "#btn-help", "#btn-theme", "#btn-export", "#btn-share", "#btn-search", "#btn-mode"];
const FWD = ["#map-zoom-in", "#map-zoom-out", "#map-reset", "#legend-lang-btn", ".ch-pill"];

const out = { ranAt: new Date().toISOString(), baseUrl: BASE };
for (const [vk, vp] of Object.entries(VP)) {
  out[vk] = { withClipPath: [], withoutClipPath: [] };
  for (const sel of TOPBAR) out[vk].withClipPath.push(await one(vp, sel, "back", false));
  for (const sel of FWD) out[vk].withClipPath.push(await one(vp, sel, "fwd", false));
  for (const sel of ["#btn-mode", "#map-zoom-in", "#legend-lang-btn"]) out[vk].withoutClipPath.push(await one(vp, sel, sel === "#btn-mode" ? "back" : "fwd", true));
}
fs.writeFileSync(path.join(OUT, "a7-focus-ring.json"), JSON.stringify(out, null, 2));
for (const vk of Object.keys(VP)) {
  console.log("=== " + vk + " (with clip-path) ===");
  out[vk].withClipPath.forEach((r) => console.log("  ", r.selector, "reached=" + r.reachedByTab, "steps=" + r.steps, "ring=" + r.ringChangedPx, "inner=" + r.innerChangedPx, "visible=" + r.ringVisible, "selfClip=" + !!r.selfClipPath));
  console.log("=== " + vk + " (clip-path removed) ===");
  out[vk].withoutClipPath.forEach((r) => console.log("  ", r.selector, "reached=" + r.reachedByTab, "ring=" + r.ringChangedPx, "inner=" + r.innerChangedPx, "visible=" + r.ringVisible));
}
await browser.close();

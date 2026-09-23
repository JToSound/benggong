/**
 * A7 補量測 #3b：focus ring 可見度（乾淨量測）
 *
 * 上一版量測被 chapter strip 嘅自動捲動污染（Tab 途中 `scrollIntoView`
 * 令 clip 區內容改變 → 假陽性）。本版：
 *  1. runtime 暫時 `display:none` chapter strip（唔改檔）→ Tab 序變短而穩定
 *  2. 每次截圖前重置所有 scroll
 *  3. 逐像素比對 focused / unfocused 兩張圖，分開計「ring 區」同「內部」變化
 *  4. 再做一次「runtime 移除 clip-path」對照，證明 ring 係被 clip-path 剪走
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5190/";
const OUT = "artifacts/audit-A7";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });

async function pixelDiff(page, bufA, bufB, clip) {
  return page.evaluate(async ({ a64, b64, ix0, iy0, ix1, iy1 }) => {
    const load = (b64) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = "data:image/png;base64," + b64; });
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    const c = document.createElement("canvas"); c.width = ia.width; c.height = ia.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data;
    ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, c.width, c.height).data;
    let ring = 0, inner = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const d = Math.abs(da[i]-db[i]) + Math.abs(da[i+1]-db[i+1]) + Math.abs(da[i+2]-db[i+2]);
      if (d < 12) continue;
      if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) inner++; else ring++;
    }
    return { ringChangedPx: ring, innerChangedPx: inner };
  }, { a64: bufA.toString("base64"), b64: bufB.toString("base64"), ix0: clip.ix0, iy0: clip.iy0, ix1: clip.ix1, iy1: clip.iy1 });
}

async function measure(page, selector, dir) {
  const el = await page.$(selector);
  if (!el) return { selector, exists: false };
  const box = await el.boundingBox();
  if (!box || box.width === 0) return { selector, exists: true, box, note: "冇可見 box" };
  const pad = 14;
  const cx = Math.max(0, Math.floor(box.x - pad)), cy = Math.max(0, Math.floor(box.y - pad));
  const cw = Math.ceil(box.width + pad * 2), chh = Math.ceil(box.height + pad * 2);
  const clip = { x: cx, y: cy, width: cw, height: chh,
    ix0: Math.floor(box.x) - cx, iy0: Math.floor(box.y) - cy,
    ix1: Math.ceil(box.x + box.width) - cx, iy1: Math.ceil(box.y + box.height) - cy };
  const resetScroll = () => page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll("*").forEach((e) => { if (e.scrollLeft) e.scrollLeft = 0; if (e.scrollTop) e.scrollTop = 0; }); });
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await resetScroll(); await page.waitForTimeout(180);
  const before = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
  let reached = false, tabs = 0;
  for (let i = 1; i <= 60; i++) {
    await page.keyboard.press(dir === "back" ? "Shift+Tab" : "Tab"); tabs = i;
    if (await page.evaluate((s) => document.activeElement && document.activeElement.matches(s), selector)) { reached = true; break; }
  }
  if (!reached) return { selector, exists: true, reachedByTab: false, tabsUsed: tabs };
  await resetScroll(); await page.waitForTimeout(200);
  const after = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
  const diff = await pixelDiff(page, before, after, clip);
  const style = await page.evaluate((s) => {
    const el = document.querySelector(s); const cs = getComputedStyle(el);
    const clipAnc = []; let n = el, d = 0;
    while (n && n.nodeType === 1 && d < 40) {
      const p = getComputedStyle(n);
      const id = n.id ? "#" + n.id : "." + (n.getAttribute("class") || "").split(/\s+/)[0];
      if (p.clipPath && p.clipPath !== "none") clipAnc.push(id + "{clip-path}");
      if (p.overflow !== "visible" && n !== el) clipAnc.push(id + "{overflow:" + p.overflow + "}");
      n = n.parentElement; d++;
    }
    return { outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor,
      outlineOffset: cs.outlineOffset, focusVisibleMatched: el.matches(":focus-visible"),
      selfClipPath: cs.clipPath !== "none" ? cs.clipPath : null, clippingAncestors: clipAnc };
  }, selector);
  return { selector, exists: true, reachedByTab: true, tabsUsed: tabs,
    box: { x: +box.x.toFixed(1), y: +box.y.toFixed(1), w: +box.width.toFixed(1), h: +box.height.toFixed(1) },
    ...diff, ringVisible: diff.ringChangedPx > 20, ...style };
}

const out = { ranAt: new Date().toISOString(), baseUrl: BASE };

for (const [key, vp] of [["mobile390", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
                         ["desktop1440", { viewport: { width: 1440, height: 900 } }]]) {
  /* ── 乾淨情境：runtime 隱藏 chapter strip ── */
  {
    const ctx = await browser.newContext(vp);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector("#svg-map", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { document.querySelector("#chapter-strip-mount").style.display = "none"; });
    await page.waitForTimeout(300);
    const rings = [];
    for (const sel of ["#btn-toggle-panel", "#btn-about", "#btn-help", "#btn-theme", "#btn-export", "#btn-share", "#btn-search", "#btn-mode"]) {
      rings.push(await measure(page, sel, "back"));
    }
    for (const sel of ["#map-zoom-in", "#map-zoom-out", "#map-reset", "#legend-lang-btn"]) {
      rings.push(await measure(page, sel));
    }
    out[key] = { scenario: "chapter-strip hidden at runtime（Tab 序穩定）", rings };
    await ctx.close();
  }

  /* ── 對照：runtime 移除所有 clip-path（證明 ring 被 clip-path 剪走）── */
  {
    const ctx = await browser.newContext(vp);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector("#svg-map", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      document.querySelector("#chapter-strip-mount").style.display = "none";
      const st = document.createElement("style");
      st.textContent = "*, *::before, *::after { clip-path: none !important; }";
      document.head.appendChild(st);
    });
    await page.waitForTimeout(400);
    const rings = [];
    for (const sel of ["#btn-toggle-panel", "#btn-about", "#btn-mode", "#btn-search"]) rings.push(await measure(page, sel, "back"));
    for (const sel of ["#map-zoom-in", "#legend-lang-btn"]) rings.push(await measure(page, sel));
    out[key + "_noClipPath"] = { scenario: "chapter-strip hidden + 所有 clip-path 移除", rings };
    await ctx.close();
  }

  /* ── ch-pill：strip 保留，但 Tab 到目標後重置 scroll ── */
  {
    const ctx = await browser.newContext(vp);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector("#svg-map", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
    await page.waitForTimeout(1500);
    // 直接將起點放在第 1 粒 pill 之前：focus skip-link 再 blur
    await page.evaluate(() => { const s = document.querySelector(".skip-link"); s.focus(); s.blur(); });
    out[key + "_chPill"] = { rings: [await measure(page, ".ch-pill")] };
    await ctx.close();
  }
}

fs.writeFileSync(path.join(OUT, "a7-focus-ring.json"), JSON.stringify(out, null, 2));
for (const k of Object.keys(out)) if (out[k].rings) {
  console.log("==", k, "==");
  out[k].rings.forEach((r) => console.log("  ", r.selector, "ring=" + r.ringChangedPx, "inner=" + r.innerChangedPx, "visible=" + r.ringVisible, "tabs=" + r.tabsUsed, "fv=" + r.focusVisibleMatched, "selfClip=" + !!r.selfClipPath));
}
await browser.close();

/**
 * A7 補量測 #4：reduced-motion root cause
 *
 * CSS 層面已經有 `@media (prefers-reduced-motion: reduce)` 將
 * animation/transition-duration 降到 0.001ms —— 呢點已確認有效。
 * 但仲有兩類「JS 驅動」動態 CSS 媒體查詢管唔到：
 *   1. SvgMap.animateViewBox() 用 requestAnimationFrame + ease-in-out cubic
 *   2. ChapterStrip / ChronicleView 用 scrollIntoView({behavior:"smooth"})
 * 本腳本用「逐 frame 取樣」證明 reduce 模式下佢哋仍然運行。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5190/";
const OUT = "artifacts/audit-A7";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });

async function sample(reducedMotion) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1500);

  const pre = await page.evaluate(() => ({
    matchMediaReduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
    mapTransitionDuration: getComputedStyle(document.querySelector("#svg-map")).transitionDuration,
  }));

  // 開始逐 frame 取樣：viewBox + strip scrollLeft + pane transform
  await page.evaluate(() => {
    window.__samples = [];
    const svg = document.querySelector("#svg-map");
    const strip = document.querySelector("#strip-track");
    const pane = document.querySelector("#story-pane");
    const t0 = performance.now();
    const tick = () => {
      window.__samples.push({ t: +(performance.now() - t0).toFixed(0),
        viewBox: svg.getAttribute("viewBox"), stripScrollLeft: strip ? Math.round(strip.scrollLeft) : null,
        paneTransform: getComputedStyle(pane).transform });
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // 觸發：跳到第 100 章（用鍵盤快捷鍵，避免鼠標）
  await page.keyboard.press("End");   // setChapter(198) → flyToChapter
  await page.waitForTimeout(1600);

  const s = await page.evaluate(() => window.__samples);
  await ctx.close();

  const uniq = (arr) => [...new Set(arr)];
  const vb = uniq(s.map((x) => x.viewBox));
  const sl = uniq(s.map((x) => x.stripScrollLeft));
  const pt = uniq(s.map((x) => x.paneTransform));
  return { reducedMotion, pre,
    frames: s.length,
    viewBoxDistinct: vb.length, viewBoxFirst: s[0] && s[0].viewBox, viewBoxLast: s[s.length - 1] && s[s.length - 1].viewBox,
    stripScrollDistinct: sl.length, stripScrollFirst: sl[0], stripScrollLast: sl[sl.length - 1],
    paneTransformDistinct: pt.length,
    viewBoxAnimating: vb.length > 2, smoothScrollAnimating: sl.length > 2 };
}

const out = { ranAt: new Date().toISOString(), baseUrl: BASE,
  noPreference: await sample("no-preference"), reduce: await sample("reduce") };
fs.writeFileSync(path.join(OUT, "a7-motion-rootcause.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
await browser.close();

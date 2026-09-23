import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const out = { ranAt: new Date().toISOString(), baseUrl: BASE };
for (const [key, vp] of [["mobile390",{viewport:{width:390,height:844},hasTouch:true,isMobile:true}],["tablet768",{viewport:{width:768,height:1024},hasTouch:true}],["desktop1440",{viewport:{width:1440,height:900}}]]) {
  const ctx = await browser.newContext(vp);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  // 等 chronicle 真正 render
  await page.waitForFunction(() => document.querySelectorAll(".chr-toggle").length > 100, { timeout: 30000 }).catch(()=>{});
  await page.waitForTimeout(1200);
  out[key] = await page.evaluate(() => {
    const pane = document.querySelector("#story-pane");
    const SEL = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
    const all = Array.from(pane.querySelectorAll(SEL));
    const inViewport = all.filter((e) => { const r = e.getBoundingClientRect();
      return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; });
    const offscreenButTabbable = all.length - inViewport.length;
    const r = pane.getBoundingClientRect();
    const chron = document.querySelector(".chronicle");
    return {
      paneCollapsed: pane.classList.contains("is-collapsed"),
      paneAriaHidden: pane.getAttribute("aria-hidden"), paneInert: pane.hasAttribute("inert"),
      paneDisplay: getComputedStyle(pane).display, paneVisibility: getComputedStyle(pane).visibility,
      panePointerEvents: getComputedStyle(pane).pointerEvents, paneOverflow: getComputedStyle(pane).overflow,
      paneRect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      paneScrollHeight: pane.scrollHeight, paneClientHeight: pane.clientHeight,
      tabbableTotal: all.length, tabbableInViewport: inViewport.length, tabbableOffscreenButTabbable: offscreenButTabbable,
      chroniclePresent: !!chron, chronicleRect: chron ? (() => { const q = chron.getBoundingClientRect(); return { x:+q.x.toFixed(1), y:+q.y.toFixed(1), w:+q.width.toFixed(1), h:+q.height.toFixed(1) }; })() : null,
      chrToggleCount: document.querySelectorAll(".chr-toggle").length,
      chrChCount: document.querySelectorAll(".chr-ch").length,
      chrTlBarCount: document.querySelectorAll(".chr-tl-bar").length,
      chrMarkAriaHidden: document.querySelectorAll('span.chr-mark[aria-hidden="true"]').length,
      pageTabStops: document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])').length,
    };
  });
  await ctx.close();
}
fs.writeFileSync("artifacts/audit-A7/a7-collapsed-focus.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
await browser.close();

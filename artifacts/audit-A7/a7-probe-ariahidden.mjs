import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map", { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await page.waitForTimeout(1500);
const res = await page.evaluate(() => {
  const sel = (el) => el.id ? el.tagName.toLowerCase()+"#"+el.id : el.tagName.toLowerCase()+(typeof el.className==="string"&&el.className?"."+el.className.trim().split(/\s+/).slice(0,2).join("."):"");
  const bySel = {};
  document.querySelectorAll('[aria-hidden="true"]').forEach((e)=>{ const k=sel(e); bySel[k]=(bySel[k]||0)+1; });
  const storyPane = document.querySelector("#story-pane");
  const paneMap = document.querySelector(".pane-map");
  const desc = (el)=>{ if(!el) return null; const cs=getComputedStyle(el); const r=el.getBoundingClientRect();
    return { sel: sel(el), ariaHidden: el.getAttribute("aria-hidden"), inert: el.hasAttribute("inert"),
      display: cs.display, visibility: cs.visibility, overflow: cs.overflow, transform: cs.transform,
      rect:{x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)},
      scrollH: el.scrollHeight, clientH: el.clientHeight,
      tabbableInside: el.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])').length }; };
  return { ariaHiddenBySel: bySel,
    storyPane: desc(storyPane), paneMap: desc(paneMap),
    workspaceChildren: Array.from(document.querySelector(".workspace").children).map(desc) };
});
console.log(JSON.stringify(res,null,2));
await browser.close();

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
  const sel=(el)=>el.id?el.tagName.toLowerCase()+"#"+el.id:el.tagName.toLowerCase()+(typeof el.className==="string"&&el.className?"."+el.className.trim().split(/\s+/).slice(0,3).join("."):"");
  const inMap = Array.from(document.querySelectorAll("#svg-map *"));
  const hist={};
  inMap.forEach(e=>{const k=sel(e); hist[k]=(hist[k]||0)+1;});
  const top=Object.entries(hist).sort((a,b)=>b[1]-a[1]).slice(0,25);
  const interactives = inMap.filter(e=>e.tabIndex>=0 || e.getAttribute("role") || /marker|zone|route|event|location/.test(typeof e.className==="string"?e.className:""));
  const iv = interactives.slice(0,40).map(e=>({sel:sel(e),tabIndex:e.tabIndex,role:e.getAttribute("role"),ariaLabel:e.getAttribute("aria-label"),ariaHidden:e.getAttribute("aria-hidden"),tabindexAttr:e.getAttribute("tabindex"),w:+e.getBoundingClientRect().width.toFixed(1),h:+e.getBoundingClientRect().height.toFixed(1)}));
  return { totalInMap:inMap.length, tagHistogram:top,
    interactiveCount:interactives.length,
    tabbableInMap: inMap.filter(e=>e.tabIndex>=0).length,
    samples: iv };
});
console.log(JSON.stringify(res,null,2).slice(0,7000));
await browser.close();

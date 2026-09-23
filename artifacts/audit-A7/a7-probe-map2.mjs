import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map", { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await page.waitForTimeout(1500);
const res = await page.evaluate(() => {
  const cls=(el)=>el.getAttribute("class")||"";
  const sel=(el)=>el.id?el.tagName.toLowerCase()+"#"+el.id:el.tagName.toLowerCase()+(cls(el)?"."+cls(el).trim().split(/\s+/).slice(0,3).join("."):"");
  const PSEUDO=".zone, .zone-area, .zone-badge, .location-marker, .event-marker, .route-line, .location-marker-cluster, .zone-label, .map-ctrl, .ch-pill";
  const rows=[];
  for (const s of PSEUDO.split(",")) {
    const els=Array.from(document.querySelectorAll(s.trim()));
    if(!els.length){ rows.push({sel:s.trim(),count:0}); continue; }
    rows.push({sel:s.trim(),count:els.length,
      tabIndexProps:[...new Set(els.map(e=>e.tabIndex))],
      tabindexAttrs:[...new Set(els.map(e=>e.getAttribute("tabindex")))],
      roles:[...new Set(els.map(e=>e.getAttribute("role")))],
      ariaLabels:els.filter(e=>e.getAttribute("aria-label")).length,
      titles:els.filter(e=>e.querySelector(":scope > title")).length,
      pointerEvents:[...new Set(els.map(e=>getComputedStyle(e).pointerEvents))],
      sizeSample:els.slice(0,3).map(e=>{const r=e.getBoundingClientRect();return +r.width.toFixed(1)+"x"+ +r.height.toFixed(1);}),
      keyboardReachable: els.filter(e=>e.tabIndex>=0).length });
  }
  // 全域 SVG 元素 tabIndex 分佈
  const svgEls=Array.from(document.querySelectorAll("#svg-map *"));
  const tiDist={};
  svgEls.forEach(e=>{tiDist[String(e.tabIndex)]=(tiDist[String(e.tabIndex)]||0)+1;});
  return { pseudoRows: rows, svgTabIndexDistribution: tiDist,
    svgTotal: svgEls.length,
    svgWithRole: svgEls.filter(e=>e.getAttribute("role")).length,
    svgWithAriaLabel: svgEls.filter(e=>e.getAttribute("aria-label")).length };
});
fs.writeFileSync("artifacts/audit-A7/a7-probe-map2.json", JSON.stringify(res,null,2));
console.log(JSON.stringify(res,null,2));
await browser.close();

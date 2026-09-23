import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForSelector("#svg-map", { timeout: 20000 });
await p.waitForTimeout(2500);
const r = await p.evaluate(() => {
  const st = document.getElementById("b8-mobile-css");
  const mc = document.querySelector(".map-controls") || document.getElementById("map-controls");
  const sheet = document.querySelector("#story-pane");
  const legend = document.querySelector(".legend") || document.getElementById("legend");
  return {
    styleExists: !!st,
    styleLen: st?.textContent?.length ?? 0,
    styleOrder: st ? Array.from(document.head.children).indexOf(st) + "/" + document.head.children.length : "n/a",
    mapControlsCls: mc?.className ?? null,
    mapControlsBottom: mc ? getComputedStyle(mc).bottom : null,
    sheetCls: sheet?.className ?? null,
    sheetPos: sheet ? getComputedStyle(sheet).position : null,
    sheetSnap: sheet?.getAttribute("data-sheet-snap") ?? null,
    legendCls: legend?.className ?? null,
    legendRect: legend ? (() => { const r = legend.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; })() : null,
    vw: window.innerWidth, vh: window.innerHeight,
  };
});
console.log(JSON.stringify(r, null, 2));
await b.close();

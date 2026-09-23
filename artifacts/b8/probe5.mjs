import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForSelector("#svg-map", { timeout: 20000 });
await p.waitForTimeout(2500);
const r = await p.evaluate(() => {
  const el = document.querySelector(".skip-link");
  const cs = getComputedStyle(el);
  const rc = el.getBoundingClientRect();
  return {
    rect: { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height) },
    pos: cs.position, top: cs.top, left: cs.left, transform: cs.transform, clip: cs.clipPath,
    centerInViewport: (rc.left + rc.width/2) >= 0 && (rc.top + rc.height/2) >= 0,
    hitAtCenter: (() => { const h = document.elementFromPoint(rc.left + rc.width/2, rc.top + rc.height/2); return h ? (h === el || el.contains(h)) : false; })(),
    csText: cs.cssText,
  };
});
console.log(JSON.stringify(r, null, 2));
await b.close();

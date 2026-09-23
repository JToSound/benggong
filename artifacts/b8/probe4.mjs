import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForSelector("#svg-map", { timeout: 20000 });
await p.waitForTimeout(2500);
const r = await p.evaluate(() => {
  const el = document.getElementById("map-legend");
  const cs = getComputedStyle(el);
  const rc = el.getBoundingClientRect();
  return {
    cls: el.className,
    rect: { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height) },
    pctOfMap: +(rc.width * rc.height / (390*844) * 100).toFixed(1),
    pos: cs.position, bottom: cs.bottom, right: cs.right, maxW: cs.maxWidth, maxH: cs.maxHeight,
    childCount: el.children.length,
    // legend 內的按鈕
    btns: Array.from(el.querySelectorAll("button,[role=button],[tabindex]")).map(x => ({ cls: (x.className?.baseVal ?? x.className ?? "").toString().slice(0,40), id: x.id, txt: (x.textContent||"").slice(0,12) })),
    html: el.outerHTML.slice(0, 700),
  };
});
console.log(JSON.stringify(r, null, 2));
await b.close();

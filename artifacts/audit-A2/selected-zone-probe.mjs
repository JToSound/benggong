/**
 * A2 選中 zone 之後嘅地圖視覺反應探測（fly-to / soft-focus / 可見性）
 * 執行：node artifacts/audit-A2/selected-zone-probe.mjs
 */
import { chromium } from "playwright";

const b = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
await ctx.addInitScript(() => { try { localStorage.setItem("binggang-theme", "dark"); } catch {} });
const p = await ctx.newPage();
await p.goto("http://localhost:5180/", { waitUntil: "load" });
await p.waitForTimeout(2200);

// 未選中之前嘅 viewBox
const before = await p.evaluate(() => document.querySelector("#svg-map-mount svg").getAttribute("viewBox"));
// 強制選中
await p.evaluate(() => {
  const a = document.querySelector(".zone-area");
  a?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
});
await p.waitForTimeout(1500);
const after = await p.evaluate(() => {
  const svg = document.querySelector("#svg-map-mount svg");
  const mapRect = svg.getBoundingClientRect();
  const sel = document.querySelector(".zone.is-selected");
  const area = sel?.querySelector(".zone-area");
  const ar = area?.getBoundingClientRect();
  const others = Array.from(document.querySelectorAll(".zone:not(.is-selected)")).map((z) => {
    const a = z.querySelector(".zone-area");
    return { fillOpacity: getComputedStyle(a).fillOpacity, strokeOpacity: getComputedStyle(a).strokeOpacity };
  });
  const selArea = area ? { fillOpacity: getComputedStyle(area).fillOpacity, strokeOpacity: getComputedStyle(area).strokeOpacity, strokeWidth: area.getAttribute("stroke-width") } : null;
  return {
    viewBoxBefore: null,
    viewBoxAfter: svg.getAttribute("viewBox"),
    mapRect: { x: Math.round(mapRect.x), y: Math.round(mapRect.y), w: Math.round(mapRect.width), h: Math.round(mapRect.height) },
    selRect: ar ? { x: Math.round(ar.x), y: Math.round(ar.y), w: Math.round(ar.width), h: Math.round(ar.height) } : null,
    selVisibleInMap: ar ? !(ar.right < mapRect.left || ar.left > mapRect.right || ar.bottom < mapRect.top || ar.top > mapRect.bottom) : null,
    selArea,
    otherZones: others.length,
    url: location.href,
    // 其他圖層有冇被 dim
    layerOpacities: Array.from(document.querySelectorAll("#svg-map-mount svg g")).slice(0, 12).map((g) => ({ id: g.id || (typeof g.className === "string" ? g.className : g.className?.baseVal) || g.tagName, op: getComputedStyle(g).opacity })),
  };
});
console.log("viewBox before:", before);
console.log(JSON.stringify(after, null, 1));

// 再試 click 一個 event marker 睇下有冇 fly-to
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2200);
const vb1 = await p.evaluate(() => document.querySelector("#svg-map-mount svg").getAttribute("viewBox"));
const marker = await p.$(".event-marker");
if (marker) {
  await marker.click({ force: true }).catch(() => {});
  await p.waitForTimeout(1400);
  const vb2 = await p.evaluate(() => document.querySelector("#svg-map-mount svg").getAttribute("viewBox"));
  console.log("event marker click → viewBox:", vb1, "→", vb2, vb1 === vb2 ? "（冇 fly-to）" : "（有變）");
  console.log("URL:", await p.evaluate(() => location.href));
}
await b.close();

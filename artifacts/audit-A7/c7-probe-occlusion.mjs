/**
 * C7 探測 H：location-marker 焦點環「零像素變化」係唔係被遮蓋？
 * 檢查 marker 中心點嘅 topmost element（elementFromPoint）。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-occlusion.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const OUT = "artifacts/audit-A7/c7-occlusion.json";

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#svg-map", { state: "visible", timeout: 25000 });
await page.waitForTimeout(1500);
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
  await page.waitForTimeout(140);
}
await page.waitForTimeout(800);

const res = await page.evaluate(() => {
  const sel =
    "#svg-map .zone, #svg-map .route-line, #svg-map .location-marker, #svg-map .location-marker-cluster, #svg-map .event-marker";
  const els = Array.from(document.querySelectorAll(sel));
  const out = [];
  els.forEach((el, i) => {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/)[0];
    if (!cls.startsWith("location") && cls !== "event-marker") return;
    const b = el.getBoundingClientRect();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const top = document.elementFromPoint(cx, cy);
    out.push({
      i,
      cls,
      id:
        el.getAttribute("data-loc-id") ??
        el.getAttribute("data-event-id") ??
        el.getAttribute("data-zone-id") ??
        null,
      size: { w: Math.round(b.width), h: Math.round(b.height) },
      topmost:
        top === el
          ? "SELF"
          : `${top?.tagName}.${(top?.getAttribute?.("class") ?? "").split(/\s+/)[0]}`,
      isSelf: top === el,
      selfOrDescendant: el.contains(top),
    });
  });
  return out;
});

fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
await browser.close();

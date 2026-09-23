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
const cdp = await ctx.newCDPSession(page);
const vb = () => page.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));
const before = await vb();
// 真實 touch drag：由 (195,500) 拖到 (95,420)
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 500 }] });
for (let i = 1; i <= 10; i++) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195 - i * 10, y: 500 - i * 8 }] });
  await page.waitForTimeout(16);
}
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(600);
const after = await vb();
// 檢查地圖有冇 pointer/touch 監聽
const handlers = await page.evaluate(() => {
  const svg = document.querySelector("#svg-map");
  const wrap = document.querySelector(".svg-map-wrap");
  const cs = getComputedStyle(wrap);
  return { wrapTouchAction: cs.touchAction, svgTouchAction: getComputedStyle(svg).touchAction,
    wrapUserSelect: cs.userSelect, hasPointerDownAttr: !!svg.onpointerdown,
    dragHint: !!document.querySelector("[class*=drag-hint], .map-hint") };
});
fs.writeFileSync("artifacts/audit-A7/a7-touchpan.json", JSON.stringify({ before, after, panned: before !== after, handlers }, null, 2));
console.log(JSON.stringify({ before, after, panned: before !== after, handlers }, null, 1));
await browser.close();

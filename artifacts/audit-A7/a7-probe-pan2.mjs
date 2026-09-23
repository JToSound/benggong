import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const res = {};
const mk = async (vp) => { const c = await browser.newContext(vp); const p = await c.newPage();
  await p.goto(BASE, { waitUntil: "load" }); await p.waitForSelector("#svg-map", { timeout: 20000 });
  await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await p.waitForTimeout(1500); return { c, p }; };
const vb = (p) => p.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));

// 1. 滑鼠拖曳（desktop 情境）
{ const { c, p } = await mk({ viewport: { width: 1440, height: 900 } });
  for (let i=0;i<3;i++){ await p.click("#map-zoom-in"); await p.waitForTimeout(250); }
  const before = await vb(p);
  await p.mouse.move(500, 500); await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(500 - i * 12, 500 - i * 8); await p.waitForTimeout(16); }
  await p.mouse.up(); await p.waitForTimeout(500);
  res.mouseDragDesktop = { before, after: await vb(p), panned: before !== (await vb(p)) };
  await c.close(); }

// 2. 觸控拖曳（mobile 情境）—— 用 in-page 合成 TouchEvent
{ const { c, p } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await p.click("#map-zoom-in"); await p.waitForTimeout(300); await p.click("#map-zoom-in"); await p.waitForTimeout(300);
  const before = await vb(p);
  res.touchDragMobile = await p.evaluate(async (beforeVb) => {
    const svg = document.querySelector("#svg-map");
    const mkT = (x, y) => new Touch({ identifier: 1, target: svg, clientX: x, clientY: y, pageX: x, pageY: y });
    const fire = (type, x, y) => svg.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [mkT(x, y)], targetTouches: type === "touchend" ? [] : [mkT(x, y)], changedTouches: [mkT(x, y)] }));
    fire("touchstart", 195, 500);
    for (let i = 1; i <= 10; i++) { fire("touchmove", 195 - i * 10, 500 - i * 8); await new Promise((r) => setTimeout(r, 16)); }
    fire("touchend", 95, 420);
    await new Promise((r) => setTimeout(r, 400));
    const after = svg.getAttribute("viewBox");
    return { before: beforeVb, after, panned: beforeVb !== after };
  }, before);
  await c.close(); }

// 3. CDP 真實觸控（加 touch emulation）
{ const { c, p } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const cdp = await c.newCDPSession(p);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await p.click("#map-zoom-in"); await p.waitForTimeout(300); await p.click("#map-zoom-in"); await p.waitForTimeout(300);
  const before = await vb(p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 500, id: 1 }] });
  for (let i = 1; i <= 12; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195 - i * 10, y: 500 - i * 8, id: 1 }] }); await p.waitForTimeout(20); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await p.waitForTimeout(500);
  res.cdpTouchDrag = { before, after: await vb(p), panned: before !== (await vb(p)) };
  await c.close(); }

fs.writeFileSync("artifacts/audit-A7/a7-pan.json", JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 1));
await browser.close();

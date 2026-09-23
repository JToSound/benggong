/*
 * 因果證明：重現原始 bug 場景
 * --------------------------
 * B6 聲稱：mouseup 期間重建 #zones-layer → 瀏覽器唔合成 click。
 * 做法：喺頁面注入 monkey-patch，喺 mouseup 時強制 replaceChildren()，
 * 睇 click 會唔會消失。若消失 → 根因診斷成立（唔係靠推測）。
 */
import { chromium } from "@playwright/test";
const BASE = "http://localhost:5174/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#svg-map", { timeout: 30000 });
await page.waitForTimeout(1200);

// 攞最大 zone 中心
const t = await page.evaluate(() => {
  const zs = [...document.querySelectorAll("#svg-map .zone")].filter(g => {
    const r = g.getBoundingClientRect(); return r.width > 6 && r.top > 0;
  }).sort((a,b)=>{ const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect(); return rb.width*rb.height-ra.width*ra.height; });
  const g = zs[0], area = g.querySelector(".zone-area"), r = area.getBoundingClientRect();
  return { id: g.getAttribute("data-zone-id") ?? g.id, x: r.left+r.width/2, y: r.top+r.height/2 };
});

// 場景 A：正常（修復後行為）— 應該有 click
await page.evaluate(() => { window.__clicks = []; document.addEventListener("click", e => window.__clicks.push(e.target.getAttribute?.("class")), true); });
await page.mouse.move(t.x, t.y); await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(400);
const a = await page.evaluate(() => ({ clicks: window.__clicks, selected: document.querySelectorAll("#svg-map .zone.is-selected").length }));
console.log("A 修復後（正常路徑）:", JSON.stringify(a));

// 場景 B：強制重現 bug — 喺 mouseup 派發前重建 zones layer
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map", { timeout: 30000 });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  window.__clicks = [];
  document.addEventListener("click", e => window.__clicks.push(e.target.tagName + "." + (e.target.getAttribute?.("class")||"")), true);
  // 監聽 capture 階段嘅 mouseup，喺佢之後即刻清空 layer
  window.addEventListener("mouseup", () => {
    const layer = document.getElementById("zones-layer");
    if (layer) layer.replaceChildren();   // ← 重現 B6 描述嘅破壞行為
  }, true);
});
await page.mouse.move(t.x, t.y); await page.mouse.down();
// mouseup 由 window capture 攔截 → 清空 layer
await page.mouse.up();
await page.waitForTimeout(500);
const b = await page.evaluate(() => ({
  clicks: window.__clicks,
  selected: document.querySelectorAll("#svg-map .zone.is-selected").length,
  zonesLayerChildren: document.getElementById("zones-layer")?.children.length,
}));
console.log("B 強制重現 bug（mouseup 清空 layer）:", JSON.stringify(b));
console.log("");
console.log(b.clicks.length === 0
  ? "✅ 根因診斷成立：mouseup 期間清空 layer → click 完全唔派發（同 B6 描述一致）"
  : "❌ 根因診斷唔成立：清空 layer 後 click 仍然派發");
await browser.close();

/**
 * 緊急性能診斷：用戶報「非常 lag，並且會當機」。
 *
 * 量：
 *   ① DOM 節點數（SVG 太大會令 style/layout 爆）
 *   ② idle FPS（requestAnimationFrame 連續 2 秒）
 *   ③ longtask（PerformanceObserver，>50ms）
 *   ④ JS heap 大小
 *   ⑤ 關鍵操作耗時（點 zone / 縮放 / 平移 / 切主題）
 *   ⑥ 事件 listener 數量（用 CDP 唔得，改為量關鍵元素）
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";
// ⚠️ 支援環境變數：用戶可能係高 DPI / 大螢幕（canvas 像素 ×4~9）
const W = Number(process.env.VW || 1440);
const H = Number(process.env.VH || 900);
const DPR = Number(process.env.DPR || 1);
const browser = await chromium.launch({
  args: ["--no-proxy-server", "--enable-precise-memory-info"],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: DPR,
});
console.log(`【環境】viewport ${W}×${H} ｜ DPR ${DPR} ｜ canvas 像素 ≈ ${W * DPR}×${H * DPR}`);

// 由頁面一開就開始收集 longtask
await page.addInitScript(() => {
  window.__lt = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* 唔支援 */
  }
});

const t0 = Date.now();
await page.goto(BASE, { waitUntil: "networkidle" });
const loadMs = Date.now() - t0;
await page.waitForTimeout(4000);

const r = await page.evaluate(async () => {
  const countAll = () => document.getElementsByTagName("*").length;
  const svg = document.querySelector("#svg-map");

  // ① DOM 節點
  const nodes = {
    total: countAll(),
    svgTotal: svg ? svg.getElementsByTagName("*").length : 0,
    zones: document.querySelectorAll("#zones-layer .zone").length,
    zoneAreas: document.querySelectorAll(".zone-area").length,
    events: document.querySelectorAll(".event-marker").length,
    markers: document.querySelectorAll(".location-marker").length,
    routes: document.querySelectorAll(".route-path").length,
  };

  // ② idle FPS（2 秒）
  const fps = await new Promise((res) => {
    let n = 0;
    const start = performance.now();
    const tick = () => {
      n++;
      if (performance.now() - start < 2000) requestAnimationFrame(tick);
      else res(Math.round((n / (performance.now() - start)) * 1000 * 10) / 10);
    };
    requestAnimationFrame(tick);
  });

  // ④ 記憶體
  const mem = performance.memory
    ? {
        usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
        totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
        limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
      }
    : null;

  return { nodes, fps, mem, longtasks: window.__lt ?? [] };
});

console.log("=== ① DOM 節點 ===");
console.log(" ", JSON.stringify(r.nodes, null, 2).replace(/\n/g, "\n  "));
console.log("\n=== ② idle FPS（2 秒平均）===");
console.log(" ", r.fps, "fps");
console.log("\n=== ③ longtask（開頁至今）===");
console.log(" ", r.longtasks.length, "個", JSON.stringify(r.longtasks.slice(0, 12)));
const total = r.longtasks.reduce((a, b) => a + b, 0);
console.log("  合計", total, "ms ｜ 最長", Math.max(0, ...r.longtasks), "ms");
console.log("\n=== ④ JS heap ===");
console.log(" ", JSON.stringify(r.mem));
console.log("\n=== ⑤ 開頁耗時 ===");
console.log(" ", loadMs, "ms（goto networkidle）");

// ⑤ 關鍵操作耗時
console.log("\n=== ⑤ 關鍵操作 ===");
const ops = [];
async function timeIt(label, fn) {
  const s = Date.now();
  await fn();
  await page.waitForTimeout(500);
  ops.push(`${label}: ${Date.now() - s}ms`);
}
await timeIt("點 zoom-in ×3", async () => {
  for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
});
await timeIt("點 zoom-out ×3", async () => {
  for (let i = 0; i < 3; i++) await page.click("#map-zoom-out");
});
await timeIt("切主題", () => page.click("#btn-theme"));
await timeIt("摺疊圖例", () => page.click("#legend-toggle-btn"));
for (const o of ops) console.log(" ", o);

// ⑥ 開頁後 longtask 總數（再量一次）
const after = await page.evaluate(() => window.__lt ?? []);
console.log("\n=== ⑥ longtask（互動後累計）===");
console.log(" ", after.length, "個 ｜ 合計", after.reduce((a, b) => a + b, 0), "ms");

await browser.close();

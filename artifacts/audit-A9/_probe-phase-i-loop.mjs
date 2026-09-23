/**
 * A9 —— 複製 phase-i.e2e.test.ts「路線只畫短距離可信線段」嘅完整 198 章迴圈，量度耗時（只讀）
 * 執行：node artifacts/audit-A9/_probe-phase-i-loop.mjs
 */
import { chromium } from "playwright";
const BASE = "http://localhost:5180/";
const withNoProxy = process.argv.includes("--noproxy");
const browser = await chromium.launch({
  headless: true,
  args: withNoProxy ? ["--no-proxy-server"] : [],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, locale: "zh-HK", serviceWorkers: "block" });
const page = await ctx.newPage();
const t0 = Date.now();
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
console.log("goto+800ms:", Date.now() - t0, "ms  (noProxy=" + withNoProxy + ")");

const t1 = Date.now();
let totalSegments = 0;
for (let ch = 1; ch <= 198; ch++) {
  if (ch > 1) {
    await page.keyboard.press("k");
    await page.waitForTimeout(40);
  }
  const ds = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".route-line")).map((p) => p.getAttribute("d") || ""),
  );
  totalSegments += ds.length;
}
const dt = Date.now() - t1;
console.log(`198 章迴圈 = ${dt}ms（${(dt / 1000).toFixed(1)}s）→ ${(dt / 198).toFixed(0)}ms/章；route-line 累計 ${totalSegments}`);
console.log(dt > 120000 ? "❌ 超過測試 120s 逾時" : "✅ 未逾時");
await ctx.close();
await browser.close();

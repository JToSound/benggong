/**
 * A9 —— 量度章節切換成本（chronicle vs chapter 模式），解釋 phase-i e2e 逾時（只讀）
 * 執行：node artifacts/audit-A9/_probe-perf.mjs
 */
import { chromium } from "playwright";
const BASE = "http://localhost:5180/";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, locale: "zh-HK", serviceWorkers: "block" });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 });
await page.waitForTimeout(2000);

async function sweep(label, n) {
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("k");
    await page.waitForTimeout(40);
    await page.evaluate(() => document.querySelectorAll(".route-line").length);
  }
  const dt = Date.now() - t0;
  console.log(`${label}: ${n} 次切章 = ${dt}ms → 每章 ${(dt / n).toFixed(0)}ms；估算 198 章 = ${((dt / n) * 198 / 1000).toFixed(1)}s`);
  return dt;
}

const mode0 = await page.evaluate(() => document.querySelector("#btn-mode")?.textContent?.trim());
console.log("初始模式:", mode0);
await sweep("chronicle 模式", 20);

// 切到 chapter 模式
await page.evaluate(() => document.querySelector("#btn-mode").click());
await page.waitForTimeout(800);
const mode1 = await page.evaluate(() => document.querySelector("#btn-mode")?.textContent?.trim());
console.log("切換後模式:", mode1);
await sweep("chapter 模式", 20);

await ctx.close();
await browser.close();

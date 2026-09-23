/**
 * A8 — 精確初次載入時間線（無固定等待）
 *
 * baseline 嘅 `navigationToStableMs` 包含腳本注入嘅 1.5 秒 settle 等待，
 * 唔可以直接同 spec §7.4 嘅 3 秒目標比較。本腳本量度：
 *   - load event 時間
 *   - networkidle 時間（真正冇網絡活動）
 *   - 最後一個 resource responseEnd
 *   - 最後一個 longtask 結束時間（= 主線程空閒）
 *
 * 執行：node artifacts/audit-A8/measure-load-timeline.mjs
 * 輸出：artifacts/audit-A8/load-timeline.json
 */

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A8/load-timeline.json";

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK" });
await ctx.addInitScript(`
  window.__m = { longTasks: [], chrFirstMs: null };
  try { new PerformanceObserver((l)=>{for(const e of l.getEntries()) window.__m.longTasks.push({start:Math.round(e.startTime),dur:Math.round(e.duration)});}).observe({type:'longtask',buffered:true}); } catch(e){}
  const w = () => {
    const mo = new MutationObserver(() => {
      if (window.__m.chrFirstMs === null && document.querySelector('#story-panel-mount .chronicle')) window.__m.chrFirstMs = Math.round(performance.now());
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) w(); else document.addEventListener('DOMContentLoaded', w);
`);
const page = await ctx.newPage();
const t0 = Date.now();
await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
const tLoad = Date.now() - t0;
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
const tIdle = Date.now() - t0;
const info = await page.evaluate(() => {
  const res = performance.getEntriesByType("resource");
  const lastEnd = Math.max(0, ...res.map((r) => r.responseEnd));
  const nav = performance.getEntriesByType("navigation")[0];
  const lt = window.__m.longTasks;
  return {
    domInteractive: Math.round(nav.domInteractive),
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
    loadEventEnd: Math.round(nav.loadEventEnd),
    lastResourceResponseEnd: Math.round(lastEnd),
    longTasks: lt,
    longTaskTotalMs: lt.reduce((a, b) => a + b.dur, 0),
    lastLongTaskEnd: lt.length ? Math.round(Math.max(...lt.map((t) => t.start + t.dur))) : 0,
    chronicleFirstRenderMs: window.__m.chrFirstMs,
    chronicleEntries: document.querySelectorAll(".chr-entry").length,
  };
});

const report = {
  baseUrl: BASE,
  capturedAt: new Date().toISOString(),
  loadEventMs: tLoad,
  networkIdleMs: tIdle,
  note: "tLoadMs / networkIdleMs 由 Playwright 量度（無注入等待）；其餘係瀏覽器 performance API。",
  ...info,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log("→", OUT);
await browser.close();

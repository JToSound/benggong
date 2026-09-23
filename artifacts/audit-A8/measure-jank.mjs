/**
 * A8 — 互動期間主線程阻塞（longtask）實測
 *
 * 分別量度：pan 期間、冷 zoom（首次載入 LOD1/LOD2 + 圖磚）期間、
 * 暖 zoom 期間嘅 longtask 數量、總時長、最長時長。
 *
 * 執行：node artifacts/audit-A8/measure-jank.mjs
 * 輸出：artifacts/audit-A8/jank-longtasks.json
 */

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A8/jank-longtasks.json";

/** 可重置嘅 longtask 收集器。 */
const INIT = `
  window.__lt = { tasks: [], on: false };
  try {
    new PerformanceObserver((l) => {
      if (!window.__lt.on) return;
      for (const e of l.getEntries()) window.__lt.tasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: false });
  } catch (e) {}
`;

function stats(tasks) {
  const durs = tasks.map((t) => t.dur);
  return {
    count: tasks.length,
    totalMs: Math.round(durs.reduce((a, b) => a + b, 0)),
    maxMs: durs.length ? Math.round(Math.max(...durs)) : 0,
    over50ms: durs.filter((d) => d > 50).length,
    tasks: tasks.map((t) => ({ start: Math.round(t.start), dur: Math.round(t.dur) })),
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK" });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const result = {};

  // --- pan 期間 ---
  await page.evaluate(() => { window.__lt.tasks = []; window.__lt.on = true; });
  await page.evaluate(() => new Promise((resolve) => {
    const svg = document.querySelector("#svg-map");
    const rect = svg.getBoundingClientRect();
    const x0 = rect.left + rect.width / 2, y0 = rect.top + rect.height / 2;
    svg.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x0, clientY: y0 }));
    let i = 0;
    const step = () => {
      i++;
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x0 + i * 5, clientY: y0 + i * 2 }));
      if (i < 40) setTimeout(step, 16);
      else { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); setTimeout(resolve, 200); }
    };
    step();
  }));
  result.panLongTasks = stats(await page.evaluate(() => { window.__lt.on = false; return window.__lt.tasks; }));

  // --- 冷 zoom（首次 LOD1/LOD2 + 圖磚）---
  await page.evaluate(() => document.querySelector("#map-reset").click());
  await page.waitForTimeout(600);
  await page.evaluate(() => { window.__lt.tasks = []; window.__lt.on = true; });
  await page.evaluate(() => new Promise((resolve) => {
    const btn = document.querySelector("#map-zoom-in");
    let i = 0;
    const step = () => {
      i++;
      btn.click();
      if (i < 20) setTimeout(step, 60);
      else setTimeout(resolve, 2500);
    };
    step();
  }));
  result.coldZoomLongTasks = stats(await page.evaluate(() => { window.__lt.on = false; return window.__lt.tasks; }));
  result.afterColdZoom = await page.evaluate(() => ({
    level: document.querySelector("#basemap-canvas")?.dataset.basemapLevel,
    viewBox: document.querySelector("#svg-map")?.getAttribute("viewBox"),
  }));

  // --- 暖 zoom（圖磚已 cache）---
  await page.evaluate(() => { window.__lt.tasks = []; window.__lt.on = true; });
  await page.evaluate(() => new Promise((resolve) => {
    const inn = document.querySelector("#map-zoom-in");
    const out = document.querySelector("#map-zoom-out");
    let i = 0;
    const step = () => {
      i++;
      (i % 2 === 0 ? inn : out).click();
      if (i < 16) setTimeout(step, 60);
      else setTimeout(resolve, 300);
    };
    step();
  }));
  result.warmZoomLongTasks = stats(await page.evaluate(() => { window.__lt.on = false; return window.__lt.tasks; }));

  // --- 暖 pan（level 2 街道層）---
  await page.evaluate(() => { window.__lt.tasks = []; window.__lt.on = true; });
  await page.evaluate(() => new Promise((resolve) => {
    const svg = document.querySelector("#svg-map");
    const rect = svg.getBoundingClientRect();
    const x0 = rect.left + rect.width / 2, y0 = rect.top + rect.height / 2;
    svg.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x0, clientY: y0 }));
    let i = 0;
    const step = () => {
      i++;
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x0 + i * 3, clientY: y0 + i * 2 }));
      if (i < 40) setTimeout(step, 16);
      else { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); setTimeout(resolve, 200); }
    };
    step();
  }));
  result.level2PanLongTasks = stats(await page.evaluate(() => { window.__lt.on = false; return window.__lt.tasks; }));

  // --- chronicle 全量 render 期間 ---
  await page.evaluate(() => { window.__lt.tasks = []; window.__lt.on = true; });
  await page.evaluate(() => {
    document.querySelector('[data-tl-ch="1"]').click();
    document.querySelector("#chr-clear-filter").click();
  });
  await page.waitForTimeout(1200);
  result.chronicleFullRenderLongTasks = stats(await page.evaluate(() => { window.__lt.on = false; return window.__lt.tasks; }));

  // --- 初次載入（buffered longtask）---
  const fresh = await context.newPage();
  const loadTasks = [];
  await fresh.addInitScript(`
    window.__lt2 = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt2.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  `);
  const t0 = Date.now();
  await fresh.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await fresh.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await fresh.waitForTimeout(1500);
  result.loadToStableMs = Date.now() - t0;
  result.loadLongTasks = stats(await fresh.evaluate(() => window.__lt2));

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  await context.close();
  await browser.close();

  console.log("初次載入:", result.loadToStableMs, "ms →", JSON.stringify({ ...result.loadLongTasks, tasks: undefined }));
  console.log("pan:", JSON.stringify({ ...result.panLongTasks, tasks: undefined }));
  console.log("冷 zoom:", JSON.stringify({ ...result.coldZoomLongTasks, tasks: undefined }));
  console.log("  after:", JSON.stringify(result.afterColdZoom));
  console.log("暖 zoom:", JSON.stringify({ ...result.warmZoomLongTasks, tasks: undefined }));
  console.log("level2 pan:", JSON.stringify({ ...result.level2PanLongTasks, tasks: undefined }));
  console.log("chronicle 全量 render:", JSON.stringify({ ...result.chronicleFullRenderLongTasks, tasks: undefined }));
  console.log("→", OUT);
}

main().catch((e) => { console.error("失敗:", e); process.exit(1); });

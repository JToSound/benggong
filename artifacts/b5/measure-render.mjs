/**
 * B5 — 收尾量度腳本（冷 zoom 阻塞 / pan fps / max zoom 內容計數 / 建築對比 / label）
 *
 * 目的：用**同 A8 一樣嘅協定**重跑，令前後對比係同一個基準。
 *
 * 產出（全部寫入 artifacts/b5/）：
 *   cold-zoom.json     冷 zoom longtask + fps
 *   pan-fps.json       pan longtask + fps
 *   content-counts.json max zoom 內容計數（zone / event / location / label）
 *   building-contrast.json 建築對比（source 常數 + 實測 meanGrad）
 *   screenshots/*.png
 *
 * 執行：node artifacts/b5/measure-render.mjs
 * ⚠️ 必須用 http://localhost:5180/（vite preview 只綁 IPv6 [::1]）
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/b5";
const SHOTS = path.join(OUT, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const require = createRequire(import.meta.url);
const basemapCoords = require("../../public/assets/hk-basemap-coords.json");
const BBOX = basemapCoords.bbox;
const PROJ_COS = 0.9247;
const LON_SPAN = BBOX.lon_max - BBOX.lon_min;
const LAT_SPAN = BBOX.lat_max - BBOX.lat_min;
const BASE_H = LAT_SPAN / PROJ_COS;
const MAX_VIEW_W = LON_SPAN / 64;
const TKO = { lon: 114.262, lat: 22.31 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const yToLat = (y) => BBOX.lat_max - (y - BBOX.lat_min) * PROJ_COS;

/* ------------------------------------------------------------------ */
/* 頁面內注入：longtask 收集器 + rAF fps 取樣器                        */
/* ------------------------------------------------------------------ */
const INIT = `
  window.__lt = { tasks: [], on: false };
  try {
    new PerformanceObserver((l) => {
      if (!window.__lt.on) return;
      for (const e of l.getEntries()) window.__lt.tasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: false });
  } catch (e) {}

  window.__fps = { deltas: [], on: false, last: 0, raf: 0 };
  window.__startFps = () => {
    window.__fps.deltas = []; window.__fps.on = true; window.__fps.last = 0;
    const tick = (t) => {
      if (!window.__fps.on) return;
      if (window.__fps.last) window.__fps.deltas.push(t - window.__fps.last);
      window.__fps.last = t;
      window.__fps.raf = requestAnimationFrame(tick);
    };
    window.__fps.raf = requestAnimationFrame(tick);
  };
  window.__stopFps = () => {
    window.__fps.on = false; cancelAnimationFrame(window.__fps.raf);
    const d = window.__fps.deltas.slice().sort((a, b) => a - b);
    const n = d.length;
    const mean = n ? d.reduce((a, b) => a + b, 0) / n : 0;
    const p95 = n ? d[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
    return { frames: n, meanMs: +mean.toFixed(2), fps: mean ? +(1000 / mean).toFixed(1) : 0,
             p95Ms: +p95.toFixed(2), maxMs: n ? +d[n - 1].toFixed(2) : 0 };
  };
  window.__resetLt = () => { window.__lt.tasks = []; window.__lt.on = true; };
  window.__stopLt = () => { window.__lt.on = false; return window.__lt.tasks; };
`;

function ltStats(tasks) {
  const durs = tasks.map((t) => t.dur);
  return {
    count: tasks.length,
    totalMs: Math.round(durs.reduce((a, b) => a + b, 0)),
    maxMs: durs.length ? Math.round(Math.max(...durs)) : 0,
    over50ms: durs.filter((d) => d > 50).length,
    tasks: tasks.map((t) => ({ start: Math.round(t.start), dur: Math.round(t.dur) })),
  };
}

async function waitReady(page) {
  await page.waitForFunction(
    () => document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready"),
    { timeout: 30000 },
  );
}

async function viewBox(page) {
  const vb = await page.getAttribute("#svg-map", "viewBox");
  return (vb ?? "").split(/\s+/).map(Number);
}

async function clickN(page, sel, n) {
  for (let i = 0; i < n; i++) await page.click(sel);
  await page.waitForTimeout(400);
}

async function panTo(page, rect, target) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  for (let k = 0; k < 60; k++) {
    const [x, y, w, h] = await viewBox(page);
    const cLon = x + w / 2;
    const cLat = yToLat(y + h / 2);
    const dLon = target.lon - cLon;
    const dLat = target.lat - cLat;
    if (Math.abs(dLon) < w * 0.002 && Math.abs(dLat) < h * PROJ_COS * 0.002) {
      return { lon: cLon, lat: cLat };
    }
    const scale = Math.min(rect.w / w, rect.h / h);
    const dx = clamp(-dLon * scale, -280, 280);
    const dy = clamp((dLat / PROJ_COS) * scale, -280, 280);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(90);
  }
  const [x, y, w, h] = await viewBox(page);
  return { lon: x + w / 2, lat: yToLat(y + h / 2) };
}

/* ------------------------------------------------------------------ */
/* 1. 冷 zoom 阻塞（fresh page，首次由全港縮到街道層）                 */
/* ------------------------------------------------------------------ */
async function runColdZoom(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitReady(page);
  await page.waitForTimeout(1500);

  // 確保喺全港視圖（level 0）
  await page.evaluate(() => document.querySelector("#map-reset")?.click());
  await page.waitForTimeout(600);

  const startVB = await viewBox(page);
  const startLevel = await page.getAttribute("#basemap-canvas", "data-basemap-level");

  // 開始量度
  await page.evaluate(() => {
    window.__resetLt();
    window.__startFps();
  });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const btn = document.querySelector("#map-zoom-in");
        let i = 0;
        const step = () => {
          i++;
          btn.click();
          if (i < 20) setTimeout(step, 60);
          else setTimeout(resolve, 3000);
        };
        step();
      }),
  );
  const fps = await page.evaluate(() => window.__stopFps());
  const tasks = await page.evaluate(() => window.__stopLt());
  const endVB = await viewBox(page);
  const endLevel = await page.getAttribute("#basemap-canvas", "data-basemap-level");

  await page.screenshot({ path: path.join(SHOTS, "cold-zoom-after.png") });

  const result = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    viewport: "1440x900",
    dpr: 1,
    protocol: "fresh page → #map-reset → 20× #map-zoom-in（60ms 間隔）→ 等 3s",
    startViewBox: startVB,
    startLevel,
    endViewBox: endVB,
    endLevel,
    longTasks: ltStats(tasks),
    fps,
  };
  await context.close();
  return result;
}

/* ------------------------------------------------------------------ */
/* 2. pan fps（level 2 街道層）                                        */
/* ------------------------------------------------------------------ */
async function runPan(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitReady(page);
  await page.waitForTimeout(1000);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // 去將軍澳 max zoom（先 4 次 zoom-in → panTo → 再 14 次）
  await clickN(page, "#map-zoom-in", 4);
  await panTo(page, rect, TKO);
  await clickN(page, "#map-zoom-in", 14);
  await page.waitForTimeout(1500);

  const vb = await viewBox(page);
  const level = await page.getAttribute("#basemap-canvas", "data-basemap-level");
  await page.screenshot({ path: path.join(SHOTS, "max-zoom-tko.png") });

  // 開始量度 pan（一個連續拖曳手勢，~1.6s）
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  await page.evaluate(() => {
    window.__resetLt();
    window.__startFps();
  });
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) {
    await page.mouse.move(cx + i * 1.6, cy + i * 0.9);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  const fps = await page.evaluate(() => window.__stopFps());
  const tasks = await page.evaluate(() => window.__stopLt());

  await page.screenshot({ path: path.join(SHOTS, "pan-after.png") });

  const result = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    viewport: "1440x900",
    dpr: 1,
    protocol: "level 2 街道層連續拖曳 60 步（~16ms 間隔）",
    viewBox: vb,
    level,
    longTasks: ltStats(tasks),
    fps,
  };
  await context.close();
  return result;
}

/* ------------------------------------------------------------------ */
/* 3. max zoom 內容計數                                                */
/* ------------------------------------------------------------------ */
async function runContentCounts(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitReady(page);
  await page.waitForTimeout(800);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  await clickN(page, "#map-zoom-in", 4);
  await panTo(page, rect, TKO);
  await clickN(page, "#map-zoom-in", 14);
  await page.waitForTimeout(1500);

  const vb = await viewBox(page);
  const level = await page.getAttribute("#basemap-canvas", "data-basemap-level");
  const detailState = await page.getAttribute("#basemap-canvas", "data-detail-state");

  const countAll = () =>
    page.evaluate(() => {
      const vb2 = document
        .querySelector("#svg-map")
        .getAttribute("viewBox")
        .split(/\s+/)
        .map(Number);
      const [x, y, w, h] = vb2;
      const intersects = (el, cx, cy) => cx >= x && cx <= x + w && cy >= y && cy <= y + h;

      const zonesTotal = document.querySelectorAll(".zone-area").length;
      const zonesIntersecting = Array.from(document.querySelectorAll(".zone-area")).filter((el) => {
        const nums = (el.getAttribute("d").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        const xs = nums.filter((_, i) => i % 2 === 0);
        const ys = nums.filter((_, i) => i % 2 === 1);
        return (
          Math.min(...xs) <= x + w && Math.max(...xs) >= x &&
          Math.min(...ys) <= y + h && Math.max(...ys) >= y
        );
      }).length;

      const eventsTotal = document.querySelectorAll(".event-marker").length;
      const eventsInView = Array.from(document.querySelectorAll(".event-marker")).filter((el) =>
        intersects(el, Number(el.getAttribute("cx")), Number(el.getAttribute("cy"))),
      ).length;

      const locsTotal = document.querySelectorAll(
        ".location-marker, .location-marker-cluster",
      ).length;
      const locsInView = Array.from(
        document.querySelectorAll(".location-marker, .location-marker-cluster"),
      ).filter((el) => {
        const cx = Number(el.getAttribute("cx") ?? el.querySelector("circle")?.getAttribute("cx"));
        const cy = Number(el.getAttribute("cy") ?? el.querySelector("circle")?.getAttribute("cy"));
        return intersects(el, cx, cy);
      }).length;

      const zoneLabels = document.querySelectorAll(".zone-label").length;
      const canvas = document.querySelector("#basemap-canvas");
      return {
        zonesTotal,
        zonesIntersecting,
        eventsTotal,
        eventsInView,
        locsTotal,
        locsInView,
        zoneLabels,
        tilePoi: Number(canvas?.dataset.tilePoi ?? -1),
        detailState: canvas?.dataset.detailState ?? null,
        basemapLevel: canvas?.dataset.basemapLevel ?? null,
      };
    });

  const windowed = await countAll();
  await page.click("#map-show-all-events");
  await page.waitForTimeout(800);
  const all = await countAll();
  const pressed = await page.getAttribute("#map-show-all-events", "aria-pressed");
  await page.screenshot({ path: path.join(SHOTS, "content-max-zoom.png") });

  const result = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    viewport: "1440x900",
    dpr: 1,
    target: "TKO max zoom",
    viewBox: vb,
    level,
    detailState,
    defaultWindow: windowed,
    showAllEvents: { ...all, ariaPressed: pressed },
  };
  await context.close();
  return result;
}

/* ------------------------------------------------------------------ */
/* 4. label 數（tile POI 渲染前後）                                    */
/* ------------------------------------------------------------------ */
async function runLabelCounts(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitReady(page);
  await page.waitForTimeout(800);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  const snap = async (tag) => ({
    tag,
    viewBox: await viewBox(page),
    level: await page.getAttribute("#basemap-canvas", "data-basemap-level"),
    tilePoi: Number(await page.getAttribute("#basemap-canvas", "data-tile-poi")),
  });

  await clickN(page, "#map-zoom-in", 4);
  const atLevel1 = await snap("level1 (regional, tile POI 未納入)");

  await panTo(page, rect, TKO);
  await clickN(page, "#map-zoom-in", 14);
  await page.waitForTimeout(1500);
  const atLevel2 = await snap("level2 (detail, tile POI 納入)");

  const result = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    viewport: "1440x900",
    note: "tile POI（rank 5 街道級地標）只喺 detail tier 納入；level 2 為街道層",
    before: atLevel1,
    after: atLevel2,
  };
  await context.close();
  return result;
}

/* ------------------------------------------------------------------ */
/* 5. 建築對比（source 常數 + 實測 meanGrad）                          */
/* ------------------------------------------------------------------ */
async function runBuildingContrast(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitReady(page);
  await page.waitForTimeout(800);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  await clickN(page, "#map-zoom-in", 4);
  await panTo(page, rect, TKO);
  await clickN(page, "#map-zoom-in", 14);
  await page.waitForTimeout(1500);

  const grad = await page.evaluate(() => {
    const canvas = document.querySelector("#basemap-canvas");
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const d = ctx.getImageData(0, 0, W, H).data;
    const N = W * H;
    const lum = new Float32Array(N);
    for (let i = 0; i < N; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let sum = 0;
    let tot = 0;
    for (let y = 1; y < H - 1; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        const g = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + W] - lum[i - W]);
        sum += g;
        tot++;
      }
    }
    return { W, H, meanGrad: +(sum / tot).toFixed(3) };
  });

  const result = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    viewport: "1440x900",
    dpr: 1,
    target: "TKO max zoom",
    renderedMeanGrad: grad.meanGrad,
    a4BaselineMeanGrad: 9.12,
    note: "meanGrad = 全畫面局部亮度梯度平均（A4 同一協定）；越高 = 建築越可辨",
  };
  await context.close();
  return result;
}

/* ------------------------------------------------------------------ */
async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  try {
    const cold = await runColdZoom(browser);
    fs.writeFileSync(path.join(OUT, "cold-zoom.json"), JSON.stringify(cold, null, 2));
    console.log("[cold zoom]", JSON.stringify({ ...cold.longTasks, tasks: undefined }), "fps=", cold.fps);

    const pan = await runPan(browser);
    fs.writeFileSync(path.join(OUT, "pan-fps.json"), JSON.stringify(pan, null, 2));
    console.log("[pan]", JSON.stringify({ ...pan.longTasks, tasks: undefined }), "fps=", pan.fps);

    const content = await runContentCounts(browser);
    fs.writeFileSync(path.join(OUT, "content-counts.json"), JSON.stringify(content, null, 2));
    console.log("[content]", JSON.stringify(content.defaultWindow), "| showAll", JSON.stringify(content.showAllEvents));

    const labels = await runLabelCounts(browser);
    fs.writeFileSync(path.join(OUT, "label-counts.json"), JSON.stringify(labels, null, 2));
    console.log("[labels]", JSON.stringify(labels.before), "→", JSON.stringify(labels.after));

    const bld = await runBuildingContrast(browser);
    fs.writeFileSync(path.join(OUT, "building-contrast.json"), JSON.stringify(bld, null, 2));
    console.log("[building]", JSON.stringify(bld));
  } finally {
    await browser.close();
  }
  console.log("→ 全部寫入", OUT);
}

main().catch((e) => {
  console.error("量度失敗:", e);
  process.exit(1);
});

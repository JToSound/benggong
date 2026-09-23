/**
 * B5 — 穩健 pan fps 量度（多次試行取中位數）
 *
 * 為何要多次試行
 * ==============
 * 單次量度變異極大（同一協定量到 12.1 至 57.3 fps）—— headless Chromium
 * 嘅 GC／raster 時機令單次數字唔可靠。呢度跑 1 次暖身（丟棄）＋ 6 次
 * 正式試行，報告每次 + 中位數 + 平均。
 *
 * 產出：artifacts/b5/pan-robust.json
 */

import { chromium } from "playwright";
import fs from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/b5/pan-robust.json";
const TRIALS = 6;

const require = createRequire(import.meta.url);
const BBOX = require("../../public/assets/hk-basemap-coords.json").bbox;
const PROJ_COS = 0.9247;
const yToLat = (y) => BBOX.lat_max - (y - BBOX.lat_min) * PROJ_COS;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const TKO = { lon: 114.262, lat: 22.31 };

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

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(2);
};

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
    if (Math.abs(dLon) < w * 0.002 && Math.abs(dLat) < h * PROJ_COS * 0.002) return;
    const scale = Math.min(rect.w / w, rect.h / h);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + clamp(-dLon * scale, -280, 280), cy + clamp((dLat / PROJ_COS) * scale, -280, 280), { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(90);
  }
}
async function panInPage(page, steps) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const svg = document.querySelector("#svg-map");
        const rect = svg.getBoundingClientRect();
        const x0 = rect.left + rect.width / 2;
        const y0 = rect.top + rect.height / 2;
        svg.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x0, clientY: y0 }));
        let i = 0;
        const step = () => {
          i++;
          window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x0 + i * 3, clientY: y0 + i * 2 }));
          if (i < n) setTimeout(step, 16);
          else { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); setTimeout(resolve, 200); }
        };
        step();
      }),
    steps,
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK" });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitReady(page);
  await page.waitForTimeout(1200);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await clickN(page, "#map-zoom-in", 4);
  await panTo(page, rect, TKO);
  await clickN(page, "#map-zoom-in", 14);
  await page.waitForTimeout(2000);

  const trials = [];
  for (let i = 0; i < TRIALS + 1; i++) {
    await page.evaluate(() => { window.__resetLt(); window.__startFps(); });
    await panInPage(page, 50);
    const fps = await page.evaluate(() => window.__stopFps());
    const lt = await page.evaluate(() => window.__stopLt());
    const durs = lt.map((t) => t.dur);
    const entry = {
      trial: i,
      warmup: i === 0,
      ...fps,
      ltCount: lt.length,
      ltTotalMs: Math.round(durs.reduce((a, b) => a + b, 0)),
      ltMaxMs: durs.length ? Math.round(Math.max(...durs)) : 0,
    };
    trials.push(entry);
    await page.waitForTimeout(400);
  }

  const real = trials.filter((t) => !t.warmup);

  // idle 校準（放喺最後，避免影響 pan 量度）
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__startFps());
  await page.waitForTimeout(2000);
  const idleFps = await page.evaluate(() => window.__stopFps());

  const result = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    viewport: "1440x900",
    dpr: 1,
    protocol: "level 2 max zoom；in-page 派發 50 步 mousemove（16ms）；1 暖身 + 6 正式",
    level: await page.getAttribute("#basemap-canvas", "data-basemap-level"),
    viewBox: await viewBox(page),
    idleFps,
    trials,
    summary: {
      fpsMedian: median(real.map((t) => t.fps)),
      fpsMean: +(real.reduce((a, t) => a + t.fps, 0) / real.length).toFixed(1),
      fpsMin: Math.min(...real.map((t) => t.fps)),
      fpsMax: Math.max(...real.map((t) => t.fps)),
      p95Median: median(real.map((t) => t.p95Ms)),
      ltTotalMedian: median(real.map((t) => t.ltTotalMs)),
      ltCountMedian: median(real.map((t) => t.ltCount)),
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log("idle fps =", idleFps.fps);
  for (const t of trials) {
    console.log(
      `${t.warmup ? "[warm]" : "[t" + t.trial + "]"}`,
      `fps=${t.fps}`,
      `p95=${t.p95Ms}ms`,
      `lt=${t.ltCount}/${t.ltTotalMs}ms`,
    );
  }
  console.log("summary:", JSON.stringify(result.summary));
  console.log("→", OUT);

  await context.close();
  await browser.close();
}

main().catch((e) => { console.error("失敗:", e); process.exit(1); });

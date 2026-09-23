/**
 * B5 — pan 成本拆解探針
 *
 * 目的：pan fps 未達標時，搞清楚成本喺邊。逐項關閉去量 fps：
 *   A 正常（手勢期間 .zone-pulse 應該自動 display:none）
 *   B 將 .zone-pulse 由 DOM 移除
 *   C 隱藏 #zones-layer
 *   D 隱藏 #locations-layer + #events-layer + #routes-layer
 *
 * 同時驗證「手勢期間 pulse 暫停」有冇真正生效。
 *
 * 產出：artifacts/b5/pan-breakdown.json
 */

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/b5/pan-breakdown.json";

const INIT = `
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
  // 手勢期間嘅 DOM 快照
  window.__pulseProbe = { samples: [] };
  window.__startPulseProbe = () => {
    window.__pulseProbe.samples = [];
    const id = setInterval(() => {
      const all = document.querySelectorAll("#zones-layer .zone-pulse");
      const hidden = document.querySelectorAll('#zones-layer .zone-pulse[display="none"]').length;
      window.__pulseProbe.samples.push({ t: Math.round(performance.now()), total: all.length, hidden });
    }, 30);
    window.__pulseProbe._id = id;
  };
  window.__stopPulseProbe = () => { clearInterval(window.__pulseProbe._id); return window.__pulseProbe.samples; };
`;

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
const TKO = { lon: 114.262, lat: 22.31 };
const BBOX = (await import("node:module")).createRequire(import.meta.url)(
  "../../public/assets/hk-basemap-coords.json",
).bbox;
const PROJ_COS = 0.9247;
const yToLat = (y) => BBOX.lat_max - (y - BBOX.lat_min) * PROJ_COS;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

async function measurePan(page, steps = 50) {
  await page.evaluate(() => window.__startFps());
  await panInPage(page, steps);
  return page.evaluate(() => window.__stopFps());
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
  await page.waitForTimeout(1500);

  const result = { baseUrl: BASE, capturedAt: new Date().toISOString(), level: await page.getAttribute("#basemap-canvas", "data-basemap-level") };

  // ---- A：正常（手勢期間應該自動 suspend pulse）----
  await page.evaluate(() => window.__startPulseProbe());
  result.A_normal = await measurePan(page);
  const samples = await page.evaluate(() => window.__stopPulseProbe());
  const hiddenCounts = samples.map((s) => s.hidden);
  result.A_pulseProbe = {
    samples: samples.length,
    total: samples[0]?.total ?? 0,
    maxHidden: Math.max(0, ...hiddenCounts),
    minHidden: Math.min(...hiddenCounts),
    allHiddenDuringGesture: hiddenCounts.every((h) => h > 0),
  };
  await page.waitForTimeout(500);

  // ---- B：由 DOM 移除 .zone-pulse ----
  const removed = await page.evaluate(() => {
    const els = document.querySelectorAll("#zones-layer .zone-pulse");
    els.forEach((e) => e.remove());
    return els.length;
  });
  result.B_noPulseDom = await measurePan(page);
  result.B_removed = removed;
  await page.waitForTimeout(400);

  // ---- C：隱藏整個 #zones-layer ----
  await page.evaluate(() => { document.querySelector("#zones-layer").style.display = "none"; });
  result.C_noZoneLayer = await measurePan(page);
  await page.waitForTimeout(400);

  // ---- D：再隱藏 marker / route 層 ----
  await page.evaluate(() => {
    for (const id of ["#locations-layer", "#events-layer", "#routes-layer"]) {
      const el = document.querySelector(id);
      if (el) el.style.display = "none";
    }
  });
  result.D_noStoryLayers = await measurePan(page);

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log("A normal      :", JSON.stringify(result.A_normal));
  console.log("  pulseProbe  :", JSON.stringify(result.A_pulseProbe));
  console.log("B no pulse DOM:", JSON.stringify(result.B_noPulseDom), "removed=", result.B_removed);
  console.log("C no zoneLayer:", JSON.stringify(result.C_noZoneLayer));
  console.log("D no story    :", JSON.stringify(result.D_noStoryLayers));
  console.log("→", OUT);

  await context.close();
  await browser.close();
}

main().catch((e) => { console.error("失敗:", e); process.exit(1); });

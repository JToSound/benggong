/**
 * B5 — pan fps 深入量度 + 環境校準
 *
 * 為何要另開一個腳本
 * ================
 * 第一個腳本用 Playwright `page.mouse.move` 由 Node 端逐步驅動，事件
 * 到達率受 CDP 往返影響，唔同 A8 嘅 in-page `dispatchEvent` 協定。
 * 為咗同 baseline（A8）可比，呢度改用**完全一樣**嘅 in-page 派發。
 *
 * 另外量 idle fps 做**環境上限校準**：headless Chromium 未必真係 60 fps，
 * 冇校準就唔知 48 fps 係「未達標」定「已到環境上限」。
 *
 * 產出：artifacts/b5/pan-fps-detail.json
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/b5/pan-fps-detail.json";

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

const TKO = { lon: 114.262, lat: 22.31 };

async function panTo(page, rect, target) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const BBOX = (await import("node:module")).createRequire(import.meta.url)(
    "../../public/assets/hk-basemap-coords.json",
  ).bbox;
  const PROJ_COS = 0.9247;
  const yToLat = (y) => BBOX.lat_max - (y - BBOX.lat_min) * PROJ_COS;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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

/** in-page 派發嘅 pan（同 A8 measure-jank 完全一樣）。 */
async function panInPage(page, steps) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const svg = document.querySelector("#svg-map");
        const rect = svg.getBoundingClientRect();
        const x0 = rect.left + rect.width / 2;
        const y0 = rect.top + rect.height / 2;
        svg.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, clientX: x0, clientY: y0 }),
        );
        let i = 0;
        const step = () => {
          i++;
          window.dispatchEvent(
            new MouseEvent("mousemove", {
              bubbles: true,
              clientX: x0 + i * 3,
              clientY: y0 + i * 2,
            }),
          );
          if (i < n) setTimeout(step, 16);
          else {
            window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            setTimeout(resolve, 200);
          }
        };
        step();
      }),
    steps,
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
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

  const result = { baseUrl: BASE, capturedAt: new Date().toISOString() };

  // ---- 1. idle fps（環境上限校準）----
  await page.evaluate(() => window.__startFps());
  await page.waitForTimeout(2500);
  result.idleFps = await page.evaluate(() => window.__stopFps());

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // 去 TKO max zoom
  await clickN(page, "#map-zoom-in", 4);
  await panTo(page, rect, TKO);
  await clickN(page, "#map-zoom-in", 14);
  await page.waitForTimeout(1800);
  result.viewBox = await viewBox(page);
  result.level = await page.getAttribute("#basemap-canvas", "data-basemap-level");

  // ---- 2. pan fps（in-page 派發，level 2）----
  await page.evaluate(() => {
    window.__resetLt();
    window.__startFps();
  });
  await panInPage(page, 50);
  result.panFps = await page.evaluate(() => window.__stopFps());
  result.panLongTasks = ltStats(await page.evaluate(() => window.__stopLt()));

  // ---- 3. pan fps（強制關閉 .zone-pulse，隔離 CSS 動畫成本）----
  await page.evaluate(() => {
    document.querySelectorAll("#zones-layer .zone-pulse").forEach((p) => {
      p.setAttribute("display", "none");
    });
  });
  await page.evaluate(() => {
    window.__resetLt();
    window.__startFps();
  });
  await panInPage(page, 50);
  result.panFpsNoPulse = await page.evaluate(() => window.__stopFps());
  result.panLongTasksNoPulse = ltStats(await page.evaluate(() => window.__stopLt()));

  result.zonePulseCount = await page.evaluate(
    () => document.querySelectorAll("#zones-layer .zone-pulse").length,
  );

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log("[idle]", JSON.stringify(result.idleFps));
  console.log("[pan ]", JSON.stringify(result.panFps), JSON.stringify(result.panLongTasks));
  console.log("[pan-no-pulse]", JSON.stringify(result.panFpsNoPulse), JSON.stringify(result.panLongTasksNoPulse));
  console.log("zone-pulse count =", result.zonePulseCount, "level =", result.level);
  console.log("→", OUT);

  await context.close();
  await browser.close();
}

main().catch((e) => {
  console.error("量度失敗:", e);
  process.exit(1);
});

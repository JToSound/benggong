/**
 * B5 — 穩健冷 zoom 量度（3 次全新頁）+ CDP 主線程時間拆解
 *
 * 冷 zoom 定義：全新頁載入 → 首次由全港（level 0）縮到街道層（level 2）。
 *
 * 除咗 longtask 數／總時長／最長／fps，仲用 CDP `Performance.getMetrics`
 * 拎 ScriptDuration / LayoutDuration / RecalcStyleDuration 嘅增量，
 * 令「殘餘阻塞係邊嚟」有證據。
 *
 * 產出：artifacts/b5/cold-zoom-robust.json
 */

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/b5/cold-zoom-robust.json";
const TRIALS = 3;

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

async function cdpMetrics(client) {
  const { metrics } = await client.send("Performance.getMetrics");
  const out = {};
  for (const m of metrics) out[m.name] = m.value;
  return out;
}

const PICK = ["ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration", "Timestamp"];

async function oneTrial(browser, i) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Performance.enable");

  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitReady(page);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector("#map-reset")?.click());
  await page.waitForTimeout(700);

  const before = await cdpMetrics(client);
  await page.evaluate(() => { window.__resetLt(); window.__startFps(); });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const btn = document.querySelector("#map-zoom-in");
        let n = 0;
        const step = () => {
          n++;
          btn.click();
          if (n < 20) setTimeout(step, 60);
          else setTimeout(resolve, 3000);
        };
        step();
      }),
  );
  const fps = await page.evaluate(() => window.__stopFps());
  const tasks = await page.evaluate(() => window.__stopLt());
  const after = await cdpMetrics(client);

  const delta = {};
  for (const k of PICK) delta[k] = +((after[k] ?? 0) - (before[k] ?? 0)).toFixed(3);

  const result = {
    trial: i,
    longTasks: ltStats(tasks),
    fps,
    cdpDeltaSec: {
      ScriptDuration: delta.ScriptDuration,
      LayoutDuration: delta.LayoutDuration,
      RecalcStyleDuration: delta.RecalcStyleDuration,
      TaskDuration: delta.TaskDuration,
      wallSec: delta.Timestamp,
    },
    endLevel: await page.getAttribute("#basemap-canvas", "data-basemap-level"),
  };
  await context.close();
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const trials = [];
  for (let i = 0; i < TRIALS; i++) trials.push(await oneTrial(browser, i));
  await browser.close();

  const totals = trials.map((t) => t.longTasks.totalMs).sort((a, b) => a - b);
  const maxes = trials.map((t) => t.longTasks.maxMs).sort((a, b) => a - b);
  const fpss = trials.map((t) => t.fps.fps).sort((a, b) => a - b);
  const result = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    viewport: "1440x900",
    dpr: 1,
    protocol: "全新頁 → #map-reset → 20× #map-zoom-in（60ms）→ 等 3s",
    trials,
    summary: {
      longTaskTotalMs: totals,
      longTaskTotalMedianMs: totals[Math.floor(TRIALS / 2)],
      longTaskMaxMs: maxes,
      longTaskMaxMedianMs: maxes[Math.floor(TRIALS / 2)],
      fps: fpss,
      fpsMedian: fpss[Math.floor(TRIALS / 2)],
      scriptSecMedian: +trials.map((t) => t.cdpDeltaSec.ScriptDuration).sort((a, b) => a - b)[Math.floor(TRIALS / 2)].toFixed(3),
      layoutSecMedian: +trials.map((t) => t.cdpDeltaSec.LayoutDuration).sort((a, b) => a - b)[Math.floor(TRIALS / 2)].toFixed(3),
      recalcSecMedian: +trials.map((t) => t.cdpDeltaSec.RecalcStyleDuration).sort((a, b) => a - b)[Math.floor(TRIALS / 2)].toFixed(3),
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  for (const t of trials) {
    console.log(
      `[t${t.trial}] lt=${t.longTasks.count}/${t.longTasks.totalMs}ms max=${t.longTasks.maxMs}ms fps=${t.fps.fps}`,
      "script=" + t.cdpDeltaSec.ScriptDuration + "s layout=" + t.cdpDeltaSec.LayoutDuration + "s recalc=" + t.cdpDeltaSec.RecalcStyleDuration + "s",
    );
  }
  console.log("summary:", JSON.stringify(result.summary));
  console.log("→", OUT);
}

main().catch((e) => { console.error("失敗:", e); process.exit(1); });

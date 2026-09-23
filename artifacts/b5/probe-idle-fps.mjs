/**
 * B5 — idle fps 探針（.zone-pulse 成本）
 *
 * 為何要量：pan fps 量度發現「max zoom idle fps（20.2）竟然低過 pan fps（51）」。
 * 假設係 `.zone-pulse` 嘅 CSS 動畫（21 個病窩光環，同時動 opacity + transform）
 * 每幀重新光柵化帶描邊多邊形。呢度逐項驗證。
 *
 * 產出：artifacts/b5/idle-fps.json
 */

import { chromium } from "playwright";
import fs from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/b5/idle-fps.json";

const require = createRequire(import.meta.url);
const BBOX = require("../../public/assets/hk-basemap-coords.json").bbox;
const PROJ_COS = 0.9247;
const yToLat = (y) => BBOX.lat_max - (y - BBOX.lat_min) * PROJ_COS;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const TKO = { lon: 114.262, lat: 22.31 };

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
async function panTo(page, rect, target) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  for (let k = 0; k < 60; k++) {
    const [x, y, w, h] = await viewBox(page);
    const cLon = x + w / 2;
    const cLat = yToLat(y + h / 2);
    if (Math.abs(target.lon - cLon) < w * 0.002 && Math.abs(target.lat - cLat) < h * PROJ_COS * 0.002) return;
    const scale = Math.min(rect.w / w, rect.h / h);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + clamp(-(target.lon - cLon) * scale, -280, 280), cy + clamp(((target.lat - cLat) / PROJ_COS) * scale, -280, 280), { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(90);
  }
}
const idle = async (page, ms = 2500) => {
  await page.evaluate(() => window.__startFps());
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__stopFps());
};

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK" });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitReady(page);
  await page.waitForTimeout(1500);

  const result = { baseUrl: BASE, capturedAt: new Date().toISOString() };

  // 1. level 0（全港，cluster LOD，冇 .zone-pulse）
  result.level0 = {
    level: await page.getAttribute("#basemap-canvas", "data-basemap-level"),
    pulseCount: await page.evaluate(() => document.querySelectorAll(".zone-pulse").length),
    fps: await idle(page),
  };

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await clickN(page, "#map-zoom-in", 4);
  await panTo(page, rect, TKO);
  await clickN(page, "#map-zoom-in", 14);
  await page.waitForTimeout(2000);

  // 2. level 2（街道層，full LOD，有 .zone-pulse）
  result.level2WithPulse = {
    level: await page.getAttribute("#basemap-canvas", "data-basemap-level"),
    pulseCount: await page.evaluate(() => document.querySelectorAll(".zone-pulse").length),
    fps: await idle(page),
  };

  // 3. level 2，pulse display:none
  await page.evaluate(() => document.querySelectorAll("#zones-layer .zone-pulse").forEach((p) => p.setAttribute("display", "none")));
  await page.waitForTimeout(300);
  result.level2PulseHidden = {
    pulseCount: await page.evaluate(() => document.querySelectorAll(".zone-pulse").length),
    fps: await idle(page),
  };

  // 4. level 2，pulse 由 DOM 移除
  await page.evaluate(() => document.querySelectorAll("#zones-layer .zone-pulse").forEach((p) => p.remove()));
  await page.waitForTimeout(300);
  result.level2PulseRemoved = {
    pulseCount: await page.evaluate(() => document.querySelectorAll(".zone-pulse").length),
    fps: await idle(page),
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log("level0        :", JSON.stringify(result.level0));
  console.log("level2+pulse  :", JSON.stringify(result.level2WithPulse));
  console.log("level2 hidden :", JSON.stringify(result.level2PulseHidden));
  console.log("level2 removed:", JSON.stringify(result.level2PulseRemoved));
  console.log("→", OUT);

  await context.close();
  await browser.close();
}

main().catch((e) => { console.error("失敗:", e); process.exit(1); });

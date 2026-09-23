/**
 * #2 光圈漂移探測：full LOD 之下，量度 `.zone-pulse` 同 `.zone-area`
 * 嘅螢幕 bounding rect 差，以及 pan 途中嘅變化。
 *
 * 用法：node artifacts/phase3-resume/probe-pulse-drift.mjs
 * ⚠️ 需要 dist/；會自己起 vite preview（跑完關）。
 */

import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;
const INIT = `(() => { try { localStorage.setItem("binggang.onboarding.dismissed", "1"); } catch (e) {} })();`;

async function probe(url, ms = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}
async function ensureServer() {
  if (await probe(BASE)) return null;
  const s = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    if (await probe(BASE)) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("preview server 起唔到");
}

/** 量度 pulse 同 zone-area 嘅螢幕 rect（以及 pulse 嘅 display）。 */
const MEASURE = () => {
  const out = [];
  const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
  for (const z of zones) {
    const pulse = z.querySelector(".zone-pulse");
    const area = z.querySelector(".zone-area");
    if (!pulse || !area) continue;
    const pb = pulse.getBoundingClientRect();
    const ab = area.getBoundingClientRect();
    if (pb.width < 4 || ab.width < 4) continue;
    out.push({
      id: z.getAttribute("data-zone-id"),
      display: pulse.getAttribute("display"),
      pulseCx: +(pb.x + pb.width / 2).toFixed(2),
      pulseCy: +(pb.y + pb.height / 2).toFixed(2),
      areaCx: +(ab.x + ab.width / 2).toFixed(2),
      areaCy: +(ab.y + ab.height / 2).toFixed(2),
      dx: +(pb.x + pb.width / 2 - (ab.x + ab.width / 2)).toFixed(2),
      dy: +(pb.y + pb.height / 2 - (ab.y + ab.height / 2)).toFixed(2),
      pw: +pb.width.toFixed(1),
      aw: +ab.width.toFixed(1),
    });
    if (out.length >= 5) break;
  }
  return out;
};

const server = await ensureServer();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page
    .waitForFunction(
      () => document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ?? false,
      null,
      { timeout: 20000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);

  // 縮放到 full LOD（viewW ≤ 0.0219）
  for (let i = 0; i < 16; i++) await page.click("#map-zoom-in");
  await page.waitForTimeout(2500);

  const st = await page.evaluate(() => {
    const v = (document.querySelector("#svg-map")?.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    return {
      viewW: v[2],
      pulses: document.querySelectorAll(".zone-pulse").length,
      lod: document.querySelector("#zones-layer")?.getAttribute("data-zone-lod"),
      drawn: document.querySelectorAll("#zones-layer .zone[data-zone-lod]").length,
    };
  });
  console.log("狀態:", JSON.stringify(st));

  console.log("\n=== ① 靜止（animation 運行中）===");
  for (const r of await page.evaluate(MEASURE)) console.log(JSON.stringify(r));

  // ② 開始拖曳（pointer down，唔放開），途中量度
  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  console.log("\n=== ② 拖曳途中（pointer down + 移動）===");
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let k = 0; k < 6; k++) {
    await page.mouse.move(cx + (k + 1) * 40, cy, { steps: 4 });
    await page.waitForTimeout(120);
  }
  const mid = await page.evaluate(() => {
    const rows = [];
    const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
    for (const z of zones) {
      const pulse = z.querySelector(".zone-pulse");
      const area = z.querySelector(".zone-area");
      if (!pulse || !area) continue;
      const pb = pulse.getBoundingClientRect();
      const ab = area.getBoundingClientRect();
      if (pb.width < 4 || ab.width < 4) continue;
      rows.push({
        id: z.getAttribute("data-zone-id"),
        display: pulse.getAttribute("display"),
        dx: +(pb.x + pb.width / 2 - (ab.x + ab.width / 2)).toFixed(2),
        dy: +(pb.y + pb.height / 2 - (ab.y + ab.height / 2)).toFixed(2),
        pw: +pb.width.toFixed(1),
        aw: +ab.width.toFixed(1),
      });
      if (rows.length >= 5) break;
    }
    return { rows, viewBox: document.querySelector("#svg-map")?.getAttribute("viewBox") };
  });
  console.log("viewBox:", mid.viewBox);
  for (const r of mid.rows) console.log(JSON.stringify(r));
  await page.mouse.up();
} finally {
  await browser.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid);
    } catch {
      /* 已死 */
    }
  }
}

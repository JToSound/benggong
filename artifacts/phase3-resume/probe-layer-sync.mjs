/**
 * 圖層同步探測：量度「SVG viewBox 變更」到「canvas 底圖繪製」之間嘅時間差。
 *
 * 用戶報告（2026-09-24）
 * ====================
 * > 「移動嘅時候啲倖存區等等嘅光圈會漂移…『跟唔上』及移動時『同底圖分離』，
 * >   明顯提到係兩層嘢。」
 *
 * 假設：`applyViewBox()` 同步改 SVG viewBox（SVG 層即刻郁），而 canvas 底圖
 * 經 `scheduleDraw()` 排喺**下一個** rAF → 落後 1 個 frame。
 * 1 frame ≈ 16 ms；以 1000 px/s 拖曳 = **~16 px 位移** → 肉眼見到分離。
 *
 * 量度方法（唔靠肉眼）
 * ==================
 * · **SVG 層時間**：MutationObserver 監 `#svg-map` 嘅 `viewBox` 屬性
 *   → 每次變更記 `performance.now()`。
 * · **canvas 層時間**：patch `CanvasRenderingContext2D.prototype.setTransform`，
 *   只收「重設去螢幕空間」嗰次（`a ≈ dpr && e === 0`，即 `draw()` 開頭）
 *   → 每次繪製記 `performance.now()`。
 * · 配對之後：`Δ = drawTime − viewBoxChangeTime`。
 *   Δ ≈ 0 → 同幀；Δ ≈ 16 ms → 落後 1 frame（＝用戶見到嘅分離）。
 *
 * 用法：node artifacts/phase3-resume/probe-layer-sync.mjs [--drags=25]
 */

import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;
const drags = Number(process.argv.find((a) => a.startsWith("--drags="))?.slice(8) ?? 25);
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

const INSTALL = () => {
  const w = window;
  w.__vb = []; // viewBox 變更時間
  w.__draw = []; // canvas 繪製時間
  const svg = document.querySelector("#svg-map");
  new MutationObserver((recs) => {
    for (const r of recs) if (r.attributeName === "viewBox") w.__vb.push(performance.now());
  }).observe(svg, { attributes: true, attributeFilter: ["viewBox"] });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const orig = CanvasRenderingContext2D.prototype.setTransform;
  CanvasRenderingContext2D.prototype.setTransform = function (a, b, c, d, e, f) {
    // `draw()` 開頭嗰次：重設去螢幕空間（a = dpr, e = 0）
    if (Math.abs(a - dpr) < 1e-6 && e === 0) w.__draw.push(performance.now());
    return orig.call(this, a, b, c, d, e, f);
  };
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
  await page.waitForTimeout(1200);
  await page.evaluate(INSTALL);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  // 連續拖曳（每次 drag 分多步 move，令一個 drag 內有多個 frame）
  for (let k = 0; k < drags; k++) {
    const dx = k % 2 === 0 ? 150 : -150;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + 40, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);

  const res = await page.evaluate(() => {
    const vb = window.__vb.slice().sort((a, b) => a - b);
    const dr = window.__draw.slice().sort((a, b) => a - b);
    const deltas = [];
    for (const t of vb) {
      // 搵 t 之後第一個繪製
      const d = dr.find((x) => x >= t - 0.5);
      if (d !== undefined) deltas.push(d - t);
    }
    deltas.sort((a, b) => a - b);
    const med = deltas.length ? deltas[Math.floor(deltas.length / 2)] : -1;
    const p90 = deltas.length ? deltas[Math.floor(deltas.length * 0.9)] : -1;
    return {
      viewBoxChanges: vb.length,
      draws: dr.length,
      paired: deltas.length,
      medianMs: +med.toFixed(1),
      p90Ms: +p90.toFixed(1),
      maxMs: deltas.length ? +deltas[deltas.length - 1].toFixed(1) : -1,
      over8ms: deltas.filter((d) => d > 8).length,
    };
  });
  console.log("=== 圖層同步量度 ===");
  console.log(JSON.stringify(res, null, 1));
  console.log(
    `\n結論：中位落後 ${res.medianMs} ms；>8 ms（即跨咗一個 frame）嘅比例 ` +
      `${res.paired ? ((res.over8ms / res.paired) * 100).toFixed(0) : "-"}%`,
  );
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

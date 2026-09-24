/**
 * Canvas churn 探測：量度 pan 期間
 *   ① `#basemap-canvas` 嘅 `width`/`height` 被改幾多次（= backing store 重新分配）
 *   ② 有幾多個新 `<canvas>` 被建立（`layerCanvas` 快取失效？）
 *   ③ `#svg-map` / `.svg-map-wrap` 嘅 getBoundingClientRect 有幾多個**唔同**值
 *
 * 假設（用戶報告 renderer OOM，但 headless 重現唔到）：
 * 如果尺寸每幀抖動 → 每幀重新分配 ~3–12 MB canvas backing store。
 * headless 係軟件渲染（malloc/free 即時），真瀏覽器係 GPU／shared memory
 * （釋放慢）→ **正好解釋「headless 重現唔到」**。
 *
 * 用法：node artifacts/phase3-resume/probe-canvas-churn.mjs
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

/** 裝探針（喺 page 內）。 */
const INSTALL = () => {
  const w = window;
  w.__probe = { resizes: 0, newCanvas: 0, widths: new Set(), heights: new Set() };
  const orig = document.createElement.bind(document);
  document.createElement = function (tag, ...rest) {
    if (String(tag).toLowerCase() === "canvas") w.__probe.newCanvas++;
    return orig(tag, ...rest);
  };
  const c = document.querySelector("#basemap-canvas");
  if (c) {
    new MutationObserver((recs) => {
      for (const r of recs) if (r.attributeName === "width" || r.attributeName === "height") w.__probe.resizes++;
    }).observe(c, { attributes: true, attributeFilter: ["width", "height"] });
  }
  // 每次 rAF 記低 wrap 嘅 rect（睇下尺寸有冇抖動）
  const wrap = document.querySelector(".svg-map-wrap");
  const tick = () => {
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      w.__probe.widths.add(r.width);
      w.__probe.heights.add(r.height);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const READ = () => {
  const p = window.__probe;
  const c = document.querySelector("#basemap-canvas");
  return {
    resizes: p.resizes,
    newCanvas: p.newCanvas,
    distinctW: p.widths.size,
    distinctH: p.heights.size,
    sampleW: [...p.widths].slice(0, 6),
    canvasW: c?.width,
    canvasH: c?.height,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1,
  };
};

const server = await ensureServer();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("!! pageerror:", e.message.slice(0, 160)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page
    .waitForFunction(
      () => document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ?? false,
      null,
      { timeout: 20000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate(INSTALL);

  // 放大到 level 2（有圖磚）
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2000);

  const before = await page.evaluate(READ);
  console.log("開始:", JSON.stringify(before));

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  // 真·連續拖曳（細步、多步），模擬用戶「移動地圖」
  for (let k = 0; k < 15; k++) {
    const dx = k % 2 === 0 ? 90 : -90;
    const dy = k % 3 === 0 ? 60 : -30;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(600);

  const after = await page.evaluate(READ);
  console.log("拖曳後:", JSON.stringify(after));
  console.log(
    `\nΔ resize=${after.resizes - before.resizes}｜Δ newCanvas=${after.newCanvas - before.newCanvas}｜` +
      `distinctW=${after.distinctW}｜distinctH=${after.distinctH}`,
  );
  const vb = await page.evaluate(() => document.querySelector("#svg-map")?.getAttribute("viewBox"));
  console.log("viewBox:", vb);
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

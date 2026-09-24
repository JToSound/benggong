/**
 * 圖磚 404 重試風暴探測（renderer OOM 嘅假設根因）。
 *
 * 背景
 * ====
 * 圖磚格網係 10×14 = 140 格，但只有 **89 格**有檔案 —— 其餘全部喺 bbox
 * 上下邊緣（陸地之外，生成器冇出）。
 *
 * `ensureTiles()` 只檢查 `tilePoi` / `tilePending`；`loadTile` 失敗之後
 * `.catch()` 吞咗錯誤、`.finally()` 清走 `tilePending` → **下一個
 * `setView()`（每個 pan frame）會再試一次**。
 *
 * `clampView` 令視窗好容易停喺 bbox 邊緣 → 邊緣缺失格長期留在視窗內
 * → **每 frame 重試 404** → 每個失敗請求都加一筆 `PerformanceResourceTiming`
 * → 資源記錄無限增長 → renderer OOM。
 *
 * 用法：node artifacts/phase3-resume/probe-tile-404.mjs
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


const INSTALL = () => {
  const w = window;
  w.__badTiles = 0;
  w.__tileReq = 0;
  const of = window.fetch;
  window.fetch = function (...a) {
    const url = String(a[0]);
    const p = of.apply(this, a);
    if (/\/vector\/tiles\//.test(url)) {
      w.__tileReq++;
      return p.then((r) => {
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("json")) w.__badTiles++;
        return r;
      });
    }
    return p;
  };
};

const SAMPLE = () => {
  const tiles = performance.getEntriesByType("resource").filter((e) => /\/vector\/tiles\//.test(e.name));
  let ok = 0;
  let bad = 0;
  for (const e of tiles) {
    // `responseStatus` 係 0 = 網絡層失敗（404 會係 404）
    const st = e.responseStatus ?? 0;
    if (st >= 200 && st < 300) ok++;
    else bad++;
  }
  return {
    total: tiles.length,
    ok,
    bad,
    badTiles: window.__badTiles ?? -1,
    tileReq: window.__tileReq ?? -1,
    all: performance.getEntriesByType("resource").length,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1,
    vb: document.querySelector("#svg-map")?.getAttribute("viewBox"),
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
  await page.waitForTimeout(1000);
  await page.evaluate(INSTALL);

  // 縮放到 level 2
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
    await page.waitForTimeout(110);
  }
  await page.waitForTimeout(2500);

  // 焦點放喺 SVG root（令方向鍵可以平移）
  await page.evaluate(() => {
    const s = document.querySelector("#svg-map");
    if (s && typeof s.focus === "function") s.focus();
  });

  console.log("狀態\t資源條目\t非JSON圖磚(累計)\tfetch次數\t全部資源\theapMB\tviewBox.y");
  const rows = [];
  for (let i = 0; i <= 6; i++) {
    if (i > 0) {
      // 一直向北推（會撞到 bbox 上緣 = 缺失嘅 r00 行）
      for (let k = 0; k < 40; k++) await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(800);
    }
    const s = await page.evaluate(SAMPLE);
    rows.push(s);
    const y = (s.vb ?? "").split(/\s+/)[1];
    console.log(`${i}\t${s.total}\t${s.badTiles}\t${s.tileReq}\t${s.all}\t${s.heapMB}\t${y}`);
  }
  const a = rows[0];
  const b = rows[rows.length - 1];
  console.log(
    `\nΔ 資源條目 ${b.total - a.total}｜Δ 非JSON圖磚 ${b.badTiles - a.badTiles}｜` +
      `Δ fetch ${b.tileReq - a.tileReq}｜Δ 全部資源 ${b.all - a.all}｜Δ heap ${(b.heapMB - a.heapMB).toFixed(1)} MB`,
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

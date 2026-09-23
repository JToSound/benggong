/**
 * OOM / 記憶體探測：持續 pan 地圖，定期取樣 heap、DOM 節點、圖磚請求數。
 *
 * 用戶報告：開網頁移動地圖一段時間之後報 "out of memory"。
 *
 * 用法：node artifacts/phase3-resume/probe-memory.mjs [--rounds=40] [--url=""]
 * ⚠️ 需要 dist/；會自己起 vite preview（跑完關）。
 */

import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;
const rounds = Number(process.argv.find((a) => a.startsWith("--rounds="))?.slice(9) ?? 40);
const urlArg = process.argv.find((a) => a.startsWith("--url="))?.slice(6) ?? "";

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

const SAMPLE = () => {
  const m = performance.memory;
  const q = (s) => document.querySelectorAll(s).length;
  return {
    heapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : -1,
    totalMB: m ? +(m.totalJSHeapSize / 1048576).toFixed(1) : -1,
    dom: document.getElementsByTagName("*").length,
    zones: q("#zones-layer *"),
    locs: q("#locations-layer *"),
    events: q("#events-layer *"),
    routes: q("#routes-layer *"),
    pulse: q(".zone-pulse"),
    tileReq: performance.getEntriesByType("resource").filter((e) => /\/vector\/tiles\//.test(e.name)).length,
    resEntries: performance.getEntriesByType("resource").length,
    lon: +(document.querySelector("#svg-map")?.getAttribute("viewBox") ?? "0").split(/\s+/)[0],
  };
};

const server = await ensureServer();
const browser = await chromium.launch({
  args: ["--no-proxy-server", "--js-flags=--expose-gc"],
});
try {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on("crash", () => console.log("!! page crashed"));
  page.on("pageerror", (e) => console.log("!! pageerror:", e.message.slice(0, 200)));
  await page.goto(BASE + urlArg, { waitUntil: "networkidle" });
  await page
    .waitForFunction(
      () => document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ?? false,
      null,
      { timeout: 20000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);

  // ⚠️ 一定要放大到 level 2（viewW ≤ 0.05）才會有圖磚層 —— 圖磚 churn
  //    係 OOM 最可能嘅來源。0.7 / 1.3^16 ≈ 0.011 → level 2 而且 zoneLod = full（有 .zone-pulse）。
  for (let i = 0; i < 16; i++) await page.click("#map-zoom-in");
  await page.waitForTimeout(2500);

  const vb0 = await page.evaluate(() => {
    const v = (document.querySelector("#svg-map")?.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    return { w: v[2], lvl: document.querySelector("#basemap-canvas")?.getAttribute("data-basemap-level") };
  });
  console.log(`起始 viewW=${vb0.w?.toFixed(5)} basemapLevel=${vb0.lvl}`);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  // 焦點放喺 SVG root，令方向鍵可以平移（P0-7）
  await page.evaluate(() => {
    const svg = document.querySelector("#svg-map");
    if (svg && typeof svg.focus === "function") svg.focus();
  });

  console.log("round\theapMB\ttotalMB\tdom\tzones\tlocs\tevents\troutes\tpulse\ttileReq\tresEntries\tlon");
  const rows = [];
  for (let i = 0; i <= rounds; i++) {
    if (i > 0) {
      /*
       * ⚠️ 用**鍵盤方向鍵**平移（可靠）—— 實測 `page.mouse` 拖曳喺呢個
       * 版面之下唔會令 viewBox 改變（可能被 zone 命中／pointer capture
       * 干擾），令探測完全冇 exercise 到 pan 路徑。
       *
       * 每次 40 px；一輪做「右 10 → 左 20 → 上 10 → 下 20」令圖磚 churn。
       */
      const seq = [
        ...Array(10).fill("ArrowRight"),
        ...Array(20).fill("ArrowLeft"),
        ...Array(10).fill("ArrowDown"),
        ...Array(20).fill("ArrowUp"),
      ];
      for (const key of seq) {
        await page.keyboard.press(key);
      }
      await page.waitForTimeout(250);
    }
    if (i % 4 === 0 || i === rounds) {
      // 取樣前先 gc（`--js-flags=--expose-gc`）—— 區分「未回收垃圾」同「真洩漏」
      await page.evaluate(() => {
        if (typeof window.gc === "function") window.gc();
      });
      const s = await page.evaluate(SAMPLE);
      rows.push(s);
      console.log(
        `${i}\t${s.heapMB}\t${s.totalMB}\t${s.dom}\t${s.zones}\t${s.locs}\t${s.events}\t${s.routes}\t${s.pulse}\t${s.tileReq}\t${s.resEntries}\t${s.lon}`,
      );
    }
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  console.log(
    `\nΔ heap ${(last.heapMB - first.heapMB).toFixed(1)} MB｜Δ dom ${last.dom - first.dom}｜` +
      `Δ tileReq ${last.tileReq - first.tileReq}｜Δ pulse ${last.pulse - first.pulse}`,
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

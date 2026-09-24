/**
 * 原生記憶體探測：用 `performance.measureUserAgentSpecificMemory()`。
 *
 * ⚠️ 為何之前嘅探測睇唔到（2026-09-24 方法論修正）
 * ------------------------------------------------
 * 之前用 `performance.memory.usedJSHeapSize`（JS heap）→ 一路顯示平穩。
 * 但 **`Path2D`、canvas backing store、Skia 幾何**全部係**原生記憶體**，
 * 唔計入 JS heap。所以 JS heap 探針**結構上睇唔到**呢類洩漏。
 *
 * `measureUserAgentSpecificMemory()` 係唯一 web-exposed 嘅**總記憶體**
 * 量度（包含 canvas / DOM / JS / 其他），需要 **cross-origin isolated**
 * 環境 → 所以本腳本自己起一個帶 COOP/COEP header 嘅靜態伺服器
 * （唔會改 `vite.config.ts` 產品設定）。
 *
 * 用法：node artifacts/phase3-resume/probe-native-memory.mjs [--rounds=8]
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5175;
const BASE = `http://localhost:${PORT}/`;
const rounds = Number(process.argv.find((a) => a.startsWith("--rounds="))?.slice(9) ?? 8);
const DIST = join(process.cwd(), "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};


/**
 * OS 層量度：加總 Chromium 相關進程嘅 working set（KB）。
 *
 * ⚠️ 為何要呢個：`measureUserAgentSpecificMemory()` 喺 headless 之下
 * 被停用；而 `performance.memory` 只計 JS heap（睇唔到 Path2D／canvas
 * 嘅原生記憶體）。OS 層 RSS 係唯一一定睇得到嘅儀器。
 */
function osMem() {
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    let kb = 0;
    let n = 0;
    for (const line of out.split(/\r?\n/)) {
      if (!/chrome|headless_shell|chromium/i.test(line)) continue;
      const cols = line.split('","').map((c) => c.replace(/"/g, ""));
      const mem = cols[4] ?? "";
      const digits = mem.replace(/[^0-9]/g, "");
      if (!digits) continue;
      kb += Number(digits);
      n++;
    }
    return { mb: +(kb / 1024).toFixed(1), procs: n };
  } catch (e) {
    if (!osMem.logged) {
      console.log("osMem 失敗:", String(e && e.message ? e.message : e).slice(0, 200));
      osMem.logged = true;
    }
    return { mb: -1, procs: -1 };
  }
}

/** 帶 COOP/COEP 嘅靜態伺服器（令 `measureUserAgentSpecificMemory` 可用）。 */
async function startServer() {
  const srv = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
      if (p === "/" || p.endsWith("/")) p += "index.html";
      const file = join(DIST, normalize(p).replace(/^([/\\])+/, ""));
      const st = await stat(file);
      if (!st.isFile()) throw new Error("not a file");
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => srv.listen(PORT, r));
  return srv;
}

const MEASURE = async () => {
  if (typeof performance.measureUserAgentSpecificMemory !== "function") return null;
  try {
    const m = await performance.measureUserAgentSpecificMemory();
    const parts = {};
    for (const b of m.breakdown ?? []) {
      for (const t of b.types ?? ["?"]) parts[t] = (parts[t] ?? 0) + b.bytes;
    }
    const mb = (x) => +(x / 1048576).toFixed(1);
    return {
      totalMB: mb(m.bytes),
      byType: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, mb(v)])),
      dom: document.getElementsByTagName("*").length,
      pulses: document.querySelectorAll(".zone-pulse").length,
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
};

const srv = await startServer();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(
    `(() => { try { localStorage.setItem("binggang.onboarding.dismissed", "1"); } catch (e) {} })();`,
  );
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

  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  console.log("crossOriginIsolated =", isolated);
  const api = await page.evaluate(
    () => typeof performance.measureUserAgentSpecificMemory === "function",
  );
  console.log("measureUserAgentSpecificMemory 可用 =", api);

  // 縮放到 level 2
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  console.log("\n輪\tAPI MB\tOS MB\tOS procs\tbyType\tdom\tpulse");
  for (let i = 0; i <= rounds; i++) {
    if (i > 0) {
      // 一輪：跨圖磚拖曳 + 縮放循環（縮放會令 LOD 切換、圖磚載入／淘汰）
      for (let k = 0; k < 8; k++) {
        const dx = k % 2 === 0 ? 160 : -160;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + dx, cy + (k % 3 === 0 ? 90 : -60), { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(70);
      }
      for (let z = 0; z < 4; z++) {
        await page.evaluate(() => document.querySelector("#map-zoom-out")?.click());
        await page.waitForTimeout(150);
        await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(700);
    }
    const m = (await page.evaluate(MEASURE)) ?? { error: "no api" };
    const os1 = osMem();
    console.log(
      `${i}\t${m.error ? "-" : m.totalMB}\t${os1.mb}\t${os1.procs}\t` +
        `${m.error ? m.error.slice(0, 40) : JSON.stringify(m.byType)}\t${m.dom ?? "-"}\t${m.pulses ?? "-"}`,
    );
  }
} finally {
  await browser.close();
  srv.close();
}

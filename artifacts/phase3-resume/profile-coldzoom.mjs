/**
 * 冷 zoom（Q10）CPU profile 診斷。
 *
 * 目的：B9 Q10 要「20 次冷 zoom 嘅 longtask 合計 ≤ 300 ms」，實測 ~632 ms。
 * 喺改任何嘢之前，先用 CDP `Profiler` 量**邊個函數食時間**，唔靠猜。
 *
 * 協定同 B9 harness 一致（in-page `dispatchEvent` × 20、每下隔 80 ms、DPR1），
 * 咁數字才可以同 `zoom-quality-raw.json` 嘅 `coldZoom` 對照。
 *
 * 用法：
 *   node artifacts/phase3-resume/profile-coldzoom.mjs
 *   node artifacts/phase3-resume/profile-coldzoom.mjs --url "?chapter=1"
 *
 * ⚠️ 需要 `dist/`（先 `npm run build`）。腳本會自己起 `vite preview`。
 * ⚠️ 環境有 http_proxy → Chromium 要 `--no-proxy-server`，URL 要用 localhost。
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;
const urlArg = process.argv.find((a) => a.startsWith("--url="))?.slice(6) ?? "";

const INIT = `
(() => {
  try { localStorage.setItem("binggang.onboarding.dismissed", "1"); } catch (e) {}
  window.__lt = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}
})();
`;

async function probe(url, ms = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await probe(BASE)) {
    console.log("[server] 5174 已有 server —— 沿用（唔會關）");
    return null;
  }
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

/** profile → 按「自身時間」排序嘅函數表。 */
function topFunctions(profile, samplingUs, top = 25) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (const n of profile.nodes) {
    const f = n.callFrame;
    const name = `${f.functionName || "(anonymous)"} @ ${(f.url || "").split("/").slice(-1)[0]}:${f.lineNumber + 1}`;
    const t = (n.hitCount ?? 0) * samplingUs;
    self.set(name, (self.get(name) ?? 0) + t);
  }
  // 同時計「按檔案」總和，方便睇係邊個模組
  const byFile = new Map();
  for (const n of profile.nodes) {
    const url = (n.callFrame.url || "(native)").split("/").slice(-1)[0];
    byFile.set(url, (byFile.get(url) ?? 0) + (n.hitCount ?? 0) * samplingUs);
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  const files = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  void byId;
  return { rows, files };
}

const server = await ensureServer();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.goto(BASE + urlArg, { waitUntil: "networkidle" });
  await page
    .waitForFunction(
      () =>
        document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ??
        false,
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);

  const client = await ctx.newCDPSession(page);
  const SAMPLING_US = 200;
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", { interval: SAMPLING_US });
  await client.send("Profiler.start");

  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      document
        .querySelector("#map-zoom-in")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
    }
  }, 20);
  await page.waitForTimeout(2000);

  const { profile } = await client.send("Profiler.stop");
  const lt = await page.evaluate(() => window.__lt);
  const perf = await page.evaluate(() => window.__drawPerf ?? null);
  const totalMs = lt.reduce((a, e) => a + e.dur, 0);
  const maxMs = lt.length ? Math.max(...lt.map((e) => e.dur)) : 0;

  const { rows, files } = topFunctions(profile, SAMPLING_US);
  const fmt = (us) => `${(us / 1000).toFixed(1)} ms`;

  console.log(`\n=== longtask ===`);
  console.log(`個數 ${lt.length}｜合計 ${totalMs.toFixed(0)} ms｜最長 ${maxMs.toFixed(0)} ms`);
  for (const e of lt) console.log(`  ${e.start.toFixed(0)} ms  +${e.dur.toFixed(0)} ms`);

  if (perf) {
    console.log(`\n=== draw() 分層累計（${perf.frames} frames）===`);
    const keys = Object.keys(perf).filter((k) => k !== "frames");
    const sum = keys.reduce((a, k) => a + perf[k], 0);
    for (const k of keys.sort((a, b) => perf[b] - perf[a])) {
      const v = perf[k];
      console.log(
        `  ${v.toFixed(1).padStart(9)} ms  ${(v / perf.frames).toFixed(1).padStart(7)} ms/frame  ${k}`,
      );
    }
    console.log(`  ${sum.toFixed(1).padStart(9)} ms  合計（frames=${perf.frames}）`);
  }

  console.log(`\n=== 按函數（自身時間，抽樣 ${SAMPLING_US} µs）===`);
  for (const [n, t] of rows) console.log(`  ${fmt(t).padStart(9)}  ${n}`);

  console.log(`\n=== 按檔案 ===`);
  for (const [n, t] of files) console.log(`  ${fmt(t).padStart(9)}  ${n}`);

  writeFileSync(
    "artifacts/phase3-resume/coldzoom-profile.json",
    JSON.stringify({ longTasks: lt, totalMs, maxMs, rows, files }, null, 1),
    "utf-8",
  );
  console.log("\n寫入 artifacts/phase3-resume/coldzoom-profile.json");
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

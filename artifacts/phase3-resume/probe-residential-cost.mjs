/**
 * #14 評估探針 v2：把 `landuse=residential` 加入 `areas`（greenPath）嘅成本量測。
 *
 * ⚠️ v1 嘅缺陷（已修）
 * ------------------
 * v1 用 `performance.now()` 量單次 `ctx.fill()`，得出 **0.00 ms** —— 因為
 * canvas 2D 係**非同步／deferred**：`fill()` 只係入 command queue，
 * 真正光柵化喺 compositor。所以單次量度冇意義（典型「量度儀器唔配對問題」）。
 *
 * v2 修正
 * -------
 * 1. **建 Path2D**：仍然用 `performance.now()`（純 JS 幾何，同步，可量）。
 * 2. **光柵化**：改為「強制 flush」—— fill 之後呼叫 `getImageData(0,0,1,1)`，
 *    逼 compositor 完成。跑 N 次取**總時間／N**。
 * 3. **JSON parse**：分開量 `JSON.parse`（1 MB 級別嘅同步 parse 係冷 zoom
 *    阻塞已知主因之一）。
 * 4. **解碼**：量 `decodeDelta` 等價工作。
 */
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";

const INIT = "(() => { try { localStorage.setItem(\"binggang.onboarding.dismissed\",\"1\"); } catch(e){} })();";

const CANDIDATE = new URL("./residential-areas.json", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1");

let cand;
try {
  cand = JSON.parse(readFileSync(CANDIDATE, "utf-8"));
} catch {
  console.error("搵唔到候選環檔：" + CANDIDATE);
  process.exit(2);
}

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });

await withTeardown(browser, server, async () => {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const r = await page.evaluate(async (candRings) => {
    const q = 100000;
    const N = 10;

    function decodeDelta(arr) {
      const out = new Float64Array(arr.length);
      let px = 0, py = 0;
      for (let i = 0; i < arr.length; i += 2) {
        px += arr[i];
        py += arr[i + 1];
        out[i] = px / q;
        out[i + 1] = py / q;
      }
      return out;
    }

    function buildPath(list) {
      const p = new Path2D();
      for (const rec of list) {
        const pts = rec.__d ?? decodeDelta(rec.r ?? rec);
        const ring = new Path2D();
        for (let i = 0; i < pts.length; i += 2) {
          if (i === 0) ring.moveTo(pts[0], pts[1]);
          else ring.lineTo(pts[i], pts[i + 1]);
        }
        ring.closePath();
        p.addPath(ring);
      }
      return p;
    }

    function median(a) {
      const s = [...a].sort((x, y) => x - y);
      return s[s.length >> 1];
    }

    const areasText = await (await fetch("/assets/vector/areas.json")).text();

    // ---- 1. JSON.parse ----
    const parseBase = [];
    let areas = null;
    for (let k = 0; k < N; k++) {
      const s = performance.now();
      areas = JSON.parse(areasText);
      parseBase.push(performance.now() - s);
    }

    // 候選 JSON（模擬實際檔案會大 112%）
    const candJson = JSON.stringify(candRings);
    const parseCand = [];
    for (let k = 0; k < N; k++) {
      const s = performance.now();
      JSON.parse(candJson);
      parseCand.push(performance.now() - s);
    }

    // ---- 2. decodeDelta ----
    const decBase = [];
    for (let k = 0; k < N; k++) {
      const s = performance.now();
      for (const a of areas.areas) decodeDelta(a.r);
      decBase.push(performance.now() - s);
    }
    const decCand = [];
    for (let k = 0; k < N; k++) {
      const s = performance.now();
      for (const ring of candRings) decodeDelta(ring);
      decCand.push(performance.now() - s);
    }

    // ---- 3. 建 Path2D ----
    const pBase = [];
    let basePath = null;
    for (let k = 0; k < N; k++) {
      const s = performance.now();
      basePath = buildPath(areas.areas);
      pBase.push(performance.now() - s);
    }
    const merged = areas.areas.concat(candRings.map((ring) => ({ k: 2, r: ring })));
    const pMerged = [];
    let mergedPath = null;
    for (let k = 0; k < N; k++) {
      const s = performance.now();
      mergedPath = buildPath(merged);
      pMerged.push(performance.now() - s);
    }

    // ---- 4. 光柵化（強制 flush）----
    const cv = document.createElement("canvas");
    cv.width = 1440;
    cv.height = 900;
    const c2 = cv.getContext("2d", { willReadFrequently: false });
    function raster(path, times) {
      const out = [];
      for (let k = 0; k < times; k++) {
        c2.setTransform(1, 0, 0, 1, 0, 0);
        c2.clearRect(0, 0, 1440, 900);
        const s = performance.now();
        c2.fillStyle = "rgba(28,72,54,0.72)";
        c2.fill(path, "evenodd");
        c2.getImageData(0, 0, 1, 1); // 逼 flush
        out.push(performance.now() - s);
      }
      return out;
    }
    const rBase = raster(basePath, N);
    const rMerged = raster(mergedPath, N);

    return {
      parseBase: median(parseBase),
      parseCand: median(parseCand),
      decBase: median(decBase),
      decCand: median(decCand),
      pathBase: median(pBase),
      pathMerged: median(pMerged),
      rasterBase: median(rBase),
      rasterMerged: median(rMerged),
      baseRings: areas.areas.length,
      basePts: areas.areas.reduce((a, b) => a + b.r.length / 2, 0),
      candPts: candRings.reduce((a, b) => a + b.length / 2, 0),
      areasJsonKB: areasText.length / 1024,
      candJsonKB: candJson.length / 1024,
    };
  }, cand.rings);

  const f = (v) => v.toFixed(2);
  const d = (v) => (v >= 0 ? "+" : "") + v.toFixed(2);
  console.log("=== #14 residential 面層成本量測（v2，強制 flush）===");
  console.log(`  現有 ${r.baseRings} 環 / ${r.basePts} 點；候選 +${r.candPts} 點`);
  console.log(`  areas.json ${f(r.areasJsonKB)} KiB；候選 JSON ${f(r.candJsonKB)} KiB`);
  console.log(`  JSON.parse  ${f(r.parseBase)} → ${f(r.parseBase + r.parseCand)} ms（Δ ${d(r.parseCand)}）`);
  console.log(`  解碼        ${f(r.decBase)} → ${f(r.decBase + r.decCand)} ms（Δ ${d(r.decCand)}）`);
  console.log(`  建 Path2D   ${f(r.pathBase)} → ${f(r.pathMerged)} ms（Δ ${d(r.pathMerged - r.pathBase)}）`);
  console.log(`  光柵化 fill ${f(r.rasterBase)} → ${f(r.rasterMerged)} ms（Δ ${d(r.rasterMerged - r.rasterBase)}）`);
  console.log("");
  const total = r.parseCand + r.decCand + (r.pathMerged - r.pathBase);
  console.log(`  init 期增量合計 ≈ ${f(total)} ms（parse + 解碼 + 建 path）`);
  console.log(`  每次重繪增量 ≈ ${f(r.rasterMerged - r.rasterBase)} ms`);
  console.log(`  冷 zoom 單次最長預算 300 ms → ${total < 300 ? "✅ 遠低於預算" : "⚠️ 需再評估"}`);

  await ctx.close();
});

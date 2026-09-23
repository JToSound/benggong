/**
 * A8 — V2 效能預算自動驗收（可重跑、CI 可用）
 *
 * 讀取 A8 量測輸出，逐條檢查 V2 效能預算，印出 PASS/FAIL 表，
 * 有任何 FAIL 就 exit(1)。
 *
 * 先跑：
 *   node artifacts/audit-A8/measure-bundle.mjs
 *   node artifacts/audit-A8/measure-json-parse.mjs
 *   node artifacts/audit-A8/measure-algorithms.mjs
 *   node artifacts/audit-A8/measure-load-timeline.mjs
 *   node artifacts/audit-A8/measure-runtime.mjs
 *   node artifacts/audit-A8/measure-jank.mjs
 * 再跑：
 *   node artifacts/audit-A8/verify-budget.mjs
 *
 * 或直接：node artifacts/audit-A8/run-all.mjs
 */

import fs from "node:fs";

const A = "artifacts/audit-A8/";
const load = (f) => JSON.parse(fs.readFileSync(A + f, "utf8"));

const bundle = load("bundle-analysis.json");
const runtime = load("runtime-metrics.json");
const timeline = load("load-timeline.json");
const jank = load("jank-longtasks.json");
const algo = load("algorithm-cost.json");

const MB = (b) => b / 1048576;

/**
 * 預算表。每個項目：name / actual / budget / unit / pass / note
 * direction: "max" = actual 必須 <= budget；"min" = actual 必須 >= budget
 */
const checks = [];
function check(name, actual, budget, unit, direction = "max", note = "") {
  const pass = direction === "max" ? actual <= budget : actual >= budget;
  checks.push({ name, actual, budget, unit, direction, pass, note });
}

// ---- Bundle ----
check("JS bundle (gzip)", bundle.dist.activeJsGzip, 60 * 1024, "bytes", "max", "單一 entry bundle");
check("CSS bundle (gzip)", bundle.dist.activeCssGzip, 20 * 1024, "bytes", "max");
check("Deploy size（dist 總量）", MB(bundle.dist.totalBytes), 12, "MB", "max", "現況 53.6 MB");
check("死重資產", bundle.deadWeight.totalMB, 0, "MB", "max", "map-lod + basemap PNG + stale bundle");
check("Stale bundle", MB(bundle.dist.staleJsBytes + bundle.dist.staleCssBytes), 0, "MB", "max", "emptyOutDir:false 累積");
check("geojson 首屏傳輸（未壓縮）", MB(bundle.geojsonCompression.rawTotal), 0.4, "MB", "max", "gzip 後 ~0.35 MB");
check("vector/main 總量", MB(bundle.vector.mainTotalBytes), 1.5, "MB", "max");
check("vector/tiles 總量", MB(bundle.vector.tilesTotalBytes), 8, "MB", "max", "lazy，只喺 LOD2 載");

// ---- 初次載入 ----
check("首屏 networkidle", timeline.networkIdleMs, 1500, "ms", "max");
check("主線程阻塞總量（載入）", timeline.longTaskTotalMs, 300, "ms", "max");
check("主線程最後 longtask 結束", timeline.lastLongTaskEnd, 1000, "ms", "max");
check("首屏 DOM node 數", runtime.load.totalDomNodes, 4000, "nodes", "max", "現況 14,036");

// ---- Chronicle ----
check("Chronicle DOM 卡片數", runtime.chronicle.entriesAfterFullRender, 60, "cards", "max", "spec 禁止 eager render 全部");
check("Chronicle 全量 render + layout", runtime.chronicle.clearFilterToFullRenderMs.forcedLayoutMs, 250, "ms", "max");
check("Chronicle filter", runtime.chronicle.filterDenseMs, 250, "ms", "max", "spec §7.4");

// ---- Search ----
const worstSearch = Math.max(...Object.values(algo.search.perTermMs));
check("Search 最慢查詢", worstSearch, 150, "ms", "max", "spec §7.4");

// ---- Map ----
check("Marker click → 面板", runtime.map.markerClickMs?.withLayoutMs ?? 9999, 100, "ms", "max", "spec §7.4");
check("Pan FPS", runtime.map.pan.fps, 55, "fps", "min");
check("Pan p95 frame", runtime.map.pan.p95Ms, 20, "ms", "max");
check("Pan 超標 frame 數", jank.panLongTasks.count, 0, "count", "max", ">50ms longtask");
check("暖 Zoom FPS", runtime.map.zoomWarm.fps, 55, "fps", "min");
check("冷 Zoom FPS", runtime.map.zoom.fps, 50, "fps", "min", "首次 LOD1/LOD2 + 圖磚");
check("冷 Zoom 最長 frame", runtime.map.zoom.maxMs, 100, "ms", "max");
check("冷 Zoom 阻塞總量", jank.coldZoomLongTasks.totalMs, 300, "ms", "max", "現況 21,241 ms");
check("街道層 Pan FPS", runtime.map.zoomedPan.fps, 55, "fps", "min");

// ---- 輸出 ----
const failed = checks.filter((c) => !c.pass);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("項目", 32), pad("實測", 14), pad("預算", 12), pad("方向", 6), "結果");
console.log("-".repeat(80));
for (const c of checks) {
  const a = typeof c.actual === "number" ? Math.round(c.actual * 100) / 100 : c.actual;
  console.log(
    pad(c.name, 32),
    pad(`${a} ${c.unit}`, 14),
    pad(`${c.budget} ${c.unit}`, 12),
    pad(c.direction === "max" ? "<=" : ">=", 6),
    c.pass ? "PASS" : "FAIL",
  );
}
console.log("-".repeat(80));
console.log(`總計 ${checks.length} 項，PASS ${checks.length - failed.length}，FAIL ${failed.length}`);
if (failed.length) {
  console.log("\n未達標項目：");
  for (const f of failed) console.log(" -", f.name, `(${f.actual} vs ${f.budget} ${f.unit})`, f.note ? `— ${f.note}` : "");
  process.exit(1);
}

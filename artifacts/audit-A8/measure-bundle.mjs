/**
 * A8 — Bundle / deploy size 分析（純 node，可重跑）
 *
 * 量度：
 *   - dist/ 逐檔 size + gzip size
 *   - 單一 active bundle（index.html 引用嘅）vs stale bundle
 *   - public/ 各資產目錄 size
 *   - geojson 未壓縮 vs gzip 對比
 *   - 死重資產可回收 MB
 *
 * 執行：node artifacts/audit-A8/measure-bundle.mjs
 * 輸出：artifacts/audit-A8/bundle-analysis.json
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = "artifacts/audit-A8/bundle-analysis.json";

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function gzipSize(buf) {
  return zlib.gzipSync(buf, { level: 9 }).length;
}

function dirSize(dir) {
  return walk(dir).reduce((a, p) => a + fs.statSync(p).size, 0);
}

function fmtMB(b) {
  return Math.round((b / 1048576) * 100) / 100;
}

// ---------- 1. dist 逐檔 ----------
const distFiles = walk("dist").map((p) => {
  const buf = fs.readFileSync(p);
  const isText = /\.(js|css|html|json|geojson|webmanifest|svg)$/i.test(p);
  return {
    path: p.replace(/\\/g, "/"),
    bytes: buf.length,
    gzip: isText ? gzipSize(buf) : null,
  };
});

// index.html 引用嘅 active bundle
const indexHtml = fs.readFileSync("dist/index.html", "utf8");
const activeJs = (indexHtml.match(/assets\/(index-[\w-]+\.js)/) || [])[1] || null;
const activeCss = (indexHtml.match(/assets\/(index-[\w-]+\.css)/) || [])[1] || null;

const distJs = distFiles.filter((f) => f.path.endsWith(".js"));
const distCss = distFiles.filter((f) => f.path.endsWith(".css"));
const distPng = distFiles.filter((f) => f.path.endsWith(".png"));

const activeJsFile = distJs.find((f) => f.path.includes(activeJs));
const activeCssFile = distCss.find((f) => f.path.includes(activeCss));
const staleJs = distJs.filter((f) => !f.path.includes(activeJs));
const staleCss = distCss.filter((f) => !f.path.includes(activeCss));

// ---------- 2. public 資產目錄 ----------
const publicDirs = {};
for (const d of ["vector", "map-lod", "map-tiles", "markers", "ui", "generated", "attribution"]) {
  const p = path.join("public/assets", d);
  publicDirs[d] = fs.existsSync(p) ? { bytes: dirSize(p), files: walk(p).length } : null;
}
const publicTop = walk("public/assets")
  .filter((p) => path.dirname(p) === path.join("public/assets"))
  .map((p) => ({ path: p.replace(/\\/g, "/"), bytes: fs.statSync(p).size }));

// 空目錄
const emptyDirs = [];
for (const d of ["map-tiles", "markers", "ui", "generated", "attribution"]) {
  const p = path.join("public/assets", d);
  if (fs.existsSync(p) && walk(p).length === 0) emptyDirs.push(p.replace(/\\/g, "/"));
}

// ---------- 3. 向量資產明細 ----------
const vectorFiles = walk("public/assets/vector").map((p) => ({
  path: p.replace(/\\/g, "/"),
  bytes: fs.statSync(p).size,
}));
const vectorTiles = vectorFiles.filter((f) => f.path.includes("/tiles/"));
const vectorMain = vectorFiles.filter((f) => !f.path.includes("/tiles/"));

// ---------- 4. geojson gzip 對比 ----------
const geojson = ["events.geojson", "locations.geojson", "zones.geojson", "routes.geojson"].map((f) => {
  const buf = fs.readFileSync(path.join("data/public", f));
  return { file: f, raw: buf.length, gzip: gzipSize(buf) };
});

// ---------- 5. 死重可回收 ----------
const deadWeight = {
  mapLod: dirSize("public/assets/map-lod"),
  hkBasemapPng: fs.existsSync("public/assets/hk-basemap.png") ? fs.statSync("public/assets/hk-basemap.png").size : 0,
  hkBasemapLabelsPng: fs.existsSync("public/assets/hk-basemap-labels.png") ? fs.statSync("public/assets/hk-basemap-labels.png").size : 0,
  staleDistJs: staleJs.reduce((a, f) => a + f.bytes, 0),
  staleDistCss: staleCss.reduce((a, f) => a + f.bytes, 0),
  duplicatePngs: distPng.filter((f) => /hk-basemap.*-[A-Za-z0-9_-]{8}\.png$/.test(f.path)).reduce((a, f) => a + f.bytes, 0),
  emptyDirs: emptyDirs.length,
};

const report = {
  generatedAt: new Date().toISOString(),
  dist: {
    totalBytes: distFiles.reduce((a, f) => a + f.bytes, 0),
    totalMB: fmtMB(distFiles.reduce((a, f) => a + f.bytes, 0)),
    activeJs,
    activeCss,
    activeJsBytes: activeJsFile?.bytes ?? null,
    activeJsGzip: activeJsFile?.gzip ?? null,
    activeCssBytes: activeCssFile?.bytes ?? null,
    activeCssGzip: activeCssFile?.gzip ?? null,
    jsFileCount: distJs.length,
    cssFileCount: distCss.length,
    staleJsCount: staleJs.length,
    staleCssCount: staleCss.length,
    staleJsBytes: staleJs.reduce((a, f) => a + f.bytes, 0),
    staleCssBytes: staleCss.reduce((a, f) => a + f.bytes, 0),
    staleTotalMB: fmtMB(staleJs.reduce((a, f) => a + f.bytes, 0) + staleCss.reduce((a, f) => a + f.bytes, 0)),
    pngFiles: distPng.map((f) => ({ path: f.path, bytes: f.bytes })),
  },
  publicDirs,
  publicTop,
  emptyDirs,
  vector: {
    mainTotalBytes: vectorMain.reduce((a, f) => a + f.bytes, 0),
    mainFiles: vectorMain.sort((a, b) => b.bytes - a.bytes),
    tilesTotalBytes: vectorTiles.reduce((a, f) => a + f.bytes, 0),
    tilesCount: vectorTiles.length,
    tilesTotalMB: fmtMB(vectorTiles.reduce((a, f) => a + f.bytes, 0)),
  },
  geojsonCompression: {
    files: geojson,
    rawTotal: geojson.reduce((a, g) => a + g.raw, 0),
    gzipTotal: geojson.reduce((a, g) => a + g.gzip, 0),
    potentialSaving: geojson.reduce((a, g) => a + (g.raw - g.gzip), 0),
    potentialSavingMB: fmtMB(geojson.reduce((a, g) => a + (g.raw - g.gzip), 0)),
  },
  deadWeight: { ...deadWeight, totalMB: fmtMB(Object.entries(deadWeight).filter(([k]) => k !== "emptyDirs").reduce((a, [, v]) => a + v, 0)) },
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log("=== dist ===");
console.log("總大小:", report.dist.totalMB, "MB");
console.log("active JS:", activeJs, report.dist.activeJsBytes, "bytes / gzip", report.dist.activeJsGzip);
console.log("active CSS:", activeCss, report.dist.activeCssBytes, "bytes / gzip", report.dist.activeCssGzip);
console.log("JS 檔數:", report.dist.jsFileCount, "(stale", report.dist.staleJsCount, "=", fmtMB(report.dist.staleJsBytes), "MB)");
console.log("CSS 檔數:", report.dist.cssFileCount, "(stale", report.dist.staleCssCount, "=", fmtMB(report.dist.staleCssBytes), "MB)");
console.log("stale 合計:", report.dist.staleTotalMB, "MB");
console.log("dist PNG:", JSON.stringify(report.dist.pngFiles));
console.log("\n=== public/assets ===");
for (const [k, v] of Object.entries(publicDirs)) console.log(" ", k.padEnd(14), v ? (fmtMB(v.bytes) + " MB (" + v.files + " files)") : "(唔存在)");
console.log(" 空目錄:", emptyDirs.join(", ") || "(冇)");
console.log("\n=== vector ===");
console.log(" 主檔合計:", fmtMB(report.vector.mainTotalBytes), "MB");
for (const f of report.vector.mainFiles) console.log("   ", String(f.bytes).padStart(9), f.path);
console.log(" tiles:", report.vector.tilesCount, "個 =", report.vector.tilesTotalMB, "MB");
console.log("\n=== geojson 壓縮 ===");
for (const g of geojson) console.log(" ", g.file.padEnd(20), g.raw, "→ gzip", g.gzip, "(" + Math.round((g.gzip / g.raw) * 100) + "%)");
console.log(" 未壓縮合計:", fmtMB(report.geojsonCompression.rawTotal), "MB | 可省:", report.geojsonCompression.potentialSavingMB, "MB");
console.log("\n=== 死重 ===");
console.log(JSON.stringify(report.deadWeight, null, 1));
console.log("→", OUT);

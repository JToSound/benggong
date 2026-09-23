/**
 * A8 Data/Performance — JSON parse 成本量測（純 node，可重跑）
 *
 * 量度 `data/public/` 每個公開資料集：
 *   - 檔案大小
 *   - 冷 parse（第一次 JSON.parse）時間
 *   - 暖 parse（第二次）時間
 *   - 記錄條目數
 *
 * 執行：node artifacts/audit-A8/measure-json-parse.mjs
 * 輸出：artifacts/audit-A8/json-parse-cost.json
 */

import fs from "node:fs";
import path from "node:path";

const DIR = "data/public";
const OUT = "artifacts/audit-A8/json-parse-cost.json";

const FILES = [
  "map-config.json",
  "locations.geojson",
  "events.geojson",
  "routes.geojson",
  "timeline.json",
  "characters.json",
  "zones.geojson",
  "chronicle.json",
  "chapter-appearances.json",
  "chapter-summaries.json",
];

function countRecords(name, obj) {
  try {
    if (obj && Array.isArray(obj.features)) return obj.features.length;
    if (Array.isArray(obj)) return obj.length;
    if (obj && Array.isArray(obj.entries)) return obj.entries.length;
    if (obj && Array.isArray(obj.records)) return obj.records.length;
    if (obj && typeof obj === "object") return Object.keys(obj).length;
  } catch {
    /* ignore */
  }
  return null;
}

function timeParse(text) {
  const t0 = process.hrtime.bigint();
  const obj = JSON.parse(text);
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6, obj };
}

const rows = [];
let totalBytes = 0;
let totalCold = 0;
let totalWarm = 0;

for (const f of FILES) {
  const p = path.join(DIR, f);
  const text = fs.readFileSync(p, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  const cold = timeParse(text);
  const warm = timeParse(text);
  const records = countRecords(f, cold.obj);
  totalBytes += bytes;
  totalCold += cold.ms;
  totalWarm += warm.ms;
  rows.push({
    file: f,
    bytes,
    kb: Math.round((bytes / 1024) * 10) / 10,
    records,
    coldParseMs: Math.round(cold.ms * 100) / 100,
    warmParseMs: Math.round(warm.ms * 100) / 100,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  files: rows,
  totalBytes,
  totalMB: Math.round((totalBytes / 1048576) * 100) / 100,
  totalColdParseMs: Math.round(totalCold * 100) / 100,
  totalWarmParseMs: Math.round(totalWarm * 100) / 100,
};

fs.mkdirSync("artifacts/audit-A8", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log("file".padEnd(30), "KB".padStart(9), "records".padStart(8), "cold ms".padStart(9), "warm ms".padStart(9));
for (const r of rows) {
  console.log(
    r.file.padEnd(30),
    String(r.kb).padStart(9),
    String(r.records ?? "-").padStart(8),
    String(r.coldParseMs).padStart(9),
    String(r.warmParseMs).padStart(9),
  );
}
console.log("-".repeat(70));
console.log("TOTAL", String(report.totalMB).padStart(27) + " MB", "", String(report.totalColdParseMs).padStart(9), String(report.totalWarmParseMs).padStart(9));
console.log("→", OUT);

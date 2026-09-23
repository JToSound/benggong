/**
 * A4 —— 精確 max-zoom label 量測（唔做 zoom in/out 干擾）
 * 記錄 canvas fillText 呼叫、viewBox、level，並反推視窗經緯範圍。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = path.join(process.cwd(), "artifacts/audit-A4");
const PROJ_COS = 0.9247;
const BB = { lon_min: 113.79, lon_max: 114.49, lat_min: 22.11, lat_max: 22.61 };
const BV = { x: 113.79, y: 22.11, w: 0.7, h: (BB.lat_max - BB.lat_min) / PROJ_COS };

const HOOK = `
(() => {
  const P = CanvasRenderingContext2D.prototype;
  const rec = { labels: [], strokes: 0, fills: 0 };
  const of = P.fillText, os = P.stroke, oF = P.fill;
  P.fillText = function (t, x, y, ...r) { rec.labels.push({ t: String(t), x, y, size: this.font }); return of.call(this, t, x, y, ...r); };
  P.stroke = function (...a) { rec.strokes++; return os.apply(this, a); };
  P.fill = function (...a) { rec.fills++; return oF.apply(this, a); };
  window.__draw = rec;
  window.__reset = () => { rec.labels.length = 0; rec.strokes = 0; rec.fills = 0; };
})();
`;

function geo(v) {
  const fx0 = (v.x - BV.x) / BV.w, fx1 = (v.x + v.w - BV.x) / BV.w;
  const fy0 = (v.y - BV.y) / BV.h, fy1 = (v.y + v.h - BV.y) / BV.h;
  return {
    lon_min: BB.lon_min + fx0 * (BB.lon_max - BB.lon_min),
    lon_max: BB.lon_min + fx1 * (BB.lon_max - BB.lon_min),
    lat_max: BB.lat_max - fy0 * (BB.lat_max - BB.lat_min),
    lat_min: BB.lat_max - fy1 * (BB.lat_max - BB.lat_min),
  };
}

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK", timezoneId: "Asia/Hong_Kong" });
await ctx.addInitScript(HOOK);
const page = await ctx.newPage();

const out = [];
for (const ch of [1, 150]) {
  await page.goto(`${BASE}#ch=${ch}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // 先去到 step13，然後 reset 記錄器，再按最後一下 → 精確捕捉 max zoom 嘅一幀
  for (let i = 0; i < 13; i++) { await page.locator("#map-zoom-in").click({ force: true }).catch(() => {}); await page.waitForTimeout(90); }
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__reset());
  await page.locator("#map-zoom-in").click({ force: true }).catch(() => {});
  await page.waitForTimeout(2000);
  const r = await page.evaluate(() => {
    const svg = document.querySelector("#svg-map-mount svg");
    const c = document.querySelector("#svg-map-mount canvas");
    return {
      viewBox: svg.getAttribute("viewBox"),
      level: c.dataset.basemapLevel,
      labels: window.__draw.labels.map((l) => l.t),
      fonts: window.__draw.labels.reduce((a, l) => { a[l.size] = (a[l.size] || 0) + 1; return a; }, {}),
      strokes: window.__draw.strokes, fills: window.__draw.fills,
      svgCounts: {
        zones: svg.querySelectorAll(".zone").length, zoneLabels: svg.querySelectorAll(".zone-label").length,
        routes: svg.querySelectorAll(".route-line").length,
        locations: svg.querySelectorAll(".location-marker").length,
        clusters: svg.querySelectorAll(".location-marker-cluster").length,
        events: svg.querySelectorAll(".event-marker").length,
      },
    };
  });
  const [x, y, w, h] = r.viewBox.split(" ").map(Number);
  r.chapter = ch;
  r.geo = geo({ x, y, w, h });
  r.uniqueLabels = [...new Set(r.labels)];
  out.push(r);
  console.log(`\nch=${ch} level=${r.level} w=${w.toFixed(4)}`);
  console.log('  viewport geo:', JSON.stringify(r.geo));
  console.log('  canvas label draws:', r.labels.length, '| unique:', r.uniqueLabels.length);
  console.log('  fonts:', JSON.stringify(r.fonts));
  console.log('  svg:', JSON.stringify(r.svgCounts));
  console.log('  labels:', r.uniqueLabels.slice(0, 30).join(' / '));
}

await browser.close();
fs.writeFileSync(path.join(OUT, "label-probe.json"), JSON.stringify(out, null, 2));
console.log("\n已寫入 artifacts/audit-A4/label-probe.json");

/**
 * A4 —— Canvas draw-call 攔截：實測 max zoom 究竟畫咗幾多 label / 路 / 樓。
 *
 * 手法：喺 page init 階段 monkey-patch CanvasRenderingContext2D.prototype
 * （唔改 production code，只喺探針頁面注入），記錄 fillText / stroke / fill 呼叫。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = path.join(process.cwd(), "artifacts/audit-A4");

const HOOK = `
(() => {
  const P = CanvasRenderingContext2D.prototype;
  const rec = { labels: [], strokes: 0, fills: 0, drawFrames: 0 };
  const of = P.fillText, os = P.stroke, oF = P.fill;
  P.fillText = function (t, x, y, ...r) { rec.labels.push({ t: String(t), x: Math.round(x), y: Math.round(y), font: this.font }); return of.call(this, t, x, y, ...r); };
  P.stroke = function (...a) { rec.strokes++; return os.apply(this, a); };
  P.fill = function (...a) { rec.fills++; return oF.apply(this, a); };
  window.__draw = rec;
  window.__reset = () => { rec.labels.length = 0; rec.strokes = 0; rec.fills = 0; rec.drawFrames++; };
})();
`;

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK", timezoneId: "Asia/Hong_Kong" });
await ctx.addInitScript(HOOK);
const page = await ctx.newPage();

const out = [];
async function capture(tag) {
  // 強制一次重繪：改 view 觸發 scheduleDraw（用 zoom 再 zoom 返）
  await page.evaluate(() => window.__reset());
  // 觸發重繪：dispatch 一個微小 zoom（+1.3 再 1/1.3 會改 view 但視覺相同）
  await page.locator("#map-zoom-in").click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  await page.locator("#map-zoom-out").click({ force: true }).catch(() => {});
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const svg = document.querySelector("#svg-map-mount svg");
    const c = document.querySelector("#svg-map-mount canvas");
    const d = window.__draw;
    const labels = d.labels.map((x) => x.t);
    const fonts = {};
    for (const x of d.labels) fonts[x.font] = (fonts[x.font] || 0) + 1;
    return {
      viewBox: svg.getAttribute("viewBox"),
      level: c.dataset.basemapLevel,
      labelCalls: d.labels.length,
      uniqueLabels: [...new Set(labels)].length,
      strokes: d.strokes,
      fills: d.fills,
      sampleLabels: [...new Set(labels)].slice(0, 40),
      fonts,
      svgCounts: {
        zones: svg.querySelectorAll(".zone").length,
        routes: svg.querySelectorAll(".route-line").length,
        locations: svg.querySelectorAll(".location-marker").length,
        clusters: svg.querySelectorAll(".location-marker-cluster").length,
        events: svg.querySelectorAll(".event-marker").length,
        zoneLabels: svg.querySelectorAll(".zone-label").length,
      },
    };
  });
  r.tag = tag;
  out.push(r);
  console.log(tag, 'level', r.level, 'w', (+r.viewBox.split(' ')[2]).toFixed(4), '| canvasLabels', r.labelCalls, 'unique', r.uniqueLabels, '| strokes', r.strokes, 'fills', r.fills, '| svg', JSON.stringify(r.svgCounts));
  console.log('  labels:', r.sampleLabels.join(' / '));
}

await page.goto(`${BASE}#ch=1`, { waitUntil: "load", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
await capture("initial-ch1");

let clicks = 0;
for (const t of [4, 8, 12, 14]) {
  while (clicks < t) { await page.locator("#map-zoom-in").click({ force: true }).catch(() => {}); clicks++; await page.waitForTimeout(90); }
  await page.waitForTimeout(1400);
  await capture(`ch1-z${t}`);
}

await browser.close();
fs.writeFileSync(path.join(OUT, "drawcall-probe.json"), JSON.stringify(out, null, 2));
console.log("\n已寫入 artifacts/audit-A4/drawcall-probe.json");

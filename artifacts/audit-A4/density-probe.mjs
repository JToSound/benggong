/**
 * A4 —— 故事內容密度 + 空區量化探針
 *
 * 1) 掃章節（1/50/100/150/190）：數 SVG 圖層節點（zone/route/location/event）
 *    → 量度故事內容密度上限（唔係底圖）。
 * 2) max zoom 空區量化：flatRatio（局部梯度 < 4 嘅像素比例）、
 *    top-color 佔比、zone polygon 屏幕覆蓋率。
 *
 * 只寫 artifacts/audit-A4/。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = path.join(process.cwd(), "artifacts/audit-A4");

const ANALYZER = `
window.__a4b = {
  flat(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const d = ctx.getImageData(0,0,W,H).data;
    const N = W*H;
    const lum = new Float32Array(N);
    for (let i=0;i<N;i++) lum[i]=0.299*d[i*4]+0.587*d[i*4+1]+0.114*d[i*4+2];
    let flat=0, tot=0, veryFlat=0;
    for (let y=1;y<H-1;y++){
      const row=y*W;
      for (let x=1;x<W-1;x++){
        const i=row+x;
        const g=Math.abs(lum[i+1]-lum[i-1])+Math.abs(lum[i+W]-lum[i-W]);
        tot++;
        if (g<4) flat++;
        if (g<2) veryFlat++;
      }
    }
    return { W,H, flatRatio:+(flat/tot).toFixed(4), veryFlatRatio:+(veryFlat/tot).toFixed(4) };
  },
  zoneCoverage(svg) {
    // 用 getBoundingClientRect 近似 zone path 覆蓋（bbox 面積 ÷ viewport 面積）
    const rect = svg.getBoundingClientRect();
    const zones = [...svg.querySelectorAll('.zone-area')];
    let area = 0;
    for (const z of zones) { const b = z.getBoundingClientRect(); area += b.width*b.height; }
    return { viewport: Math.round(rect.width*rect.height), zoneBboxArea: Math.round(area), zoneCount: zones.length };
  },
};
`;

async function probePage(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const svg = document.querySelector("#svg-map-mount svg") || document.querySelector("#svg-map");
    const q = (s) => (svg ? svg.querySelectorAll(s).length : 0);
    const canvas = document.querySelector("#svg-map-mount canvas") || document.querySelector("#basemap-canvas");
    return {
      viewBox: svg?.getAttribute("viewBox") ?? null,
      level: canvas?.dataset?.basemapLevel ?? null,
      counts: {
        zones: q(".zone"), zoneLabels: q(".zone-label"), routes: q(".route-line"),
        locations: q(".location-marker"), clusters: q(".location-marker-cluster"),
        events: q(".event-marker"),
      },
      flat: canvas ? window.__a4b.flat(canvas) : null,
      zoneCoverage: svg ? window.__a4b.zoneCoverage(svg) : null,
    };
  });
}

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: "zh-HK",
  timezoneId: "Asia/Hong_Kong",
});
await ctx.addInitScript(ANALYZER);
const page = await ctx.newPage();

const chapters = [1, 50, 100, 150, 190];
const byChapter = [];
for (const ch of chapters) {
  const r = await probePage(page, `${BASE}#ch=${ch}`);
  r.chapter = ch;
  byChapter.push(r);
  console.log(`ch=${ch}`, JSON.stringify(r.counts), 'flat', r.flat?.flatRatio, 'zoneBbox/view', r.zoneCoverage ? (r.zoneCoverage.zoneBboxArea/r.zoneCoverage.viewport).toFixed(4) : null);
}

// max zoom 空區（ch=1 同 ch=150）
const maxZoom = [];
for (const ch of [1, 150]) {
  await probePage(page, `${BASE}#ch=${ch}`);
  for (let i = 0; i < 20; i++) {
    await page.locator("#map-zoom-in").click({ force: true }).catch(() => {});
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const svg = document.querySelector("#svg-map-mount svg");
    const canvas = document.querySelector("#svg-map-mount canvas");
    return {
      viewBox: svg?.getAttribute("viewBox"),
      level: canvas?.dataset?.basemapLevel,
      counts: {
        zones: svg.querySelectorAll(".zone").length,
        zoneLabels: svg.querySelectorAll(".zone-label").length,
        routes: svg.querySelectorAll(".route-line").length,
        locations: svg.querySelectorAll(".location-marker").length,
        clusters: svg.querySelectorAll(".location-marker-cluster").length,
        events: svg.querySelectorAll(".event-marker").length,
      },
      flat: window.__a4b.flat(canvas),
      zoneCoverage: window.__a4b.zoneCoverage(svg),
    };
  });
  r.chapter = ch;
  maxZoom.push(r);
  console.log(`maxzoom ch=${ch}`, JSON.stringify(r.counts), 'flat', r.flat.flatRatio, 'veryFlat', r.flat.veryFlatRatio);
}

await browser.close();
fs.writeFileSync(path.join(OUT, "density-probe.json"), JSON.stringify({ byChapter, maxZoom }, null, 2));
console.log("\n已寫入 artifacts/audit-A4/density-probe.json");

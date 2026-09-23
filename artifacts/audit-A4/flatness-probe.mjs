/**
 * A4 —— 空區曲線：flatRatio / meanGrad / edgeDensity vs zoom step
 * 證明「放大之後內容變稀疏」而唔係「變模糊」。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = path.join(process.cwd(), "artifacts/audit-A4");

const A = `
window.__c = {
  m(canvas){
    const ctx=canvas.getContext('2d');const W=canvas.width,H=canvas.height;
    const d=ctx.getImageData(0,0,W,H).data;const N=W*H;
    const lum=new Float32Array(N);
    for(let i=0;i<N;i++)lum[i]=0.299*d[i*4]+0.587*d[i*4+1]+0.114*d[i*4+2];
    let flat=0,veryFlat=0,tot=0,gs=0,edge=0;
    for(let y=1;y<H-1;y++){const r=y*W;for(let x=1;x<W-1;x++){const i=r+x;
      const g=Math.abs(lum[i+1]-lum[i-1])+Math.abs(lum[i+W]-lum[i-W]);
      tot++;gs+=g;if(g<4)flat++;if(g<2)veryFlat++;if(g>24)edge++;}}
    return {flatRatio:+(flat/tot).toFixed(4),veryFlatRatio:+(veryFlat/tot).toFixed(4),meanGrad:+(gs/tot).toFixed(2),edgeDensity:+(edge/tot).toFixed(4)};
  }
};`;

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK", timezoneId: "Asia/Hong_Kong" });
await ctx.addInitScript(A);
const page = await ctx.newPage();

const out = [];
for (const ch of [1, 150]) {
  await page.goto(`${BASE}#ch=${ch}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const row = { chapter: ch, steps: [] };
  const measure = async (step) => {
    const r = await page.evaluate(() => {
      const c = document.querySelector("#svg-map-mount canvas");
      const svg = document.querySelector("#svg-map-mount svg");
      return { vb: svg.getAttribute("viewBox"), level: c.dataset.basemapLevel, ...window.__c.m(c) };
    });
    r.step = step;
    row.steps.push(r);
  };
  await measure(0);
  let clicks = 0;
  for (const target of [2, 4, 6, 8, 10, 12, 14]) {
    while (clicks < target) { await page.locator("#map-zoom-in").click({ force: true }).catch(() => {}); clicks++; await page.waitForTimeout(90); }
    await page.waitForTimeout(1300);
    await measure(target);
  }
  out.push(row);
  console.log(`ch=${ch}`);
  for (const s of row.steps) console.log(`  step${String(s.step).padStart(2)} level${s.level} w=${(+s.vb.split(' ')[2]).toFixed(4)} flat=${s.flatRatio} veryFlat=${s.veryFlatRatio} meanGrad=${s.meanGrad} edge=${s.edgeDensity}`);
}

await browser.close();
fs.writeFileSync(path.join(OUT, "flatness-curve.json"), JSON.stringify(out, null, 2));
console.log("\n已寫入 artifacts/audit-A4/flatness-curve.json");

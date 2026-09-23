/** A4 —— level 2 首次進入時圖磚 pop-in 量測 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = path.join(process.cwd(), "artifacts/audit-A4");
const A = `window.__m={m(c){const x=c.getContext('2d');const W=c.width,H=c.height;const d=x.getImageData(0,0,W,H).data;const N=W*H;const L=new Float32Array(N);for(let i=0;i<N;i++)L[i]=0.299*d[i*4]+0.587*d[i*4+1]+0.114*d[i*4+2];let flat=0,gs=0,tot=0;for(let y=1;y<H-1;y++){const r=y*W;for(let x=1;x<W-1;x++){const i=r+x;const g=Math.abs(L[i+1]-L[i-1])+Math.abs(L[i+W]-L[i-W]);tot++;gs+=g;if(g<4)flat++;}}return{flatRatio:+(flat/tot).toFixed(4),meanGrad:+(gs/tot).toFixed(2)};}};`;
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK", timezoneId: "Asia/Hong_Kong" });
await ctx.addInitScript(A);
const page = await ctx.newPage();
const t0 = Date.now(); const tileTimes = [];
page.on("response", (r) => { if (/assets\/vector\/tiles\//.test(r.url())) tileTimes.push(Date.now() - t0); });
await page.goto(`${BASE}#ch=1`, { waitUntil: "load", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
// 到 step 10（level 1），然後 reset 時間基準
for (let i = 0; i < 10; i++) { await page.locator("#map-zoom-in").click({ force: true }).catch(() => {}); await page.waitForTimeout(90); }
await page.waitForTimeout(1200);
const base = Date.now(); tileTimes.length = 0;
await page.locator("#map-zoom-in").click({ force: true }).catch(() => {}); // → step 11, level 2
const snaps = [];
for (const ms of [150, 400, 800, 1500, 3000]) {
  const target = base + ms;
  const wait = target - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  const r = await page.evaluate(() => {
    const c = document.querySelector("#svg-map-mount canvas");
    const svg = document.querySelector("#svg-map-mount svg");
    return { level: c.dataset.basemapLevel, w: +svg.getAttribute("viewBox").split(" ")[2], ...window.__m.m(c) };
  });
  snaps.push({ ms, ...r });
  console.log(`+${ms}ms`, 'level', r.level, 'w', r.w.toFixed(4), 'flat', r.flatRatio, 'meanGrad', r.meanGrad);
}
console.log('tile response times (ms after reset):', tileTimes.map(t => t - (base - t0)).join(','));
await browser.close();
fs.writeFileSync(path.join(OUT, "popin-probe.json"), JSON.stringify({ snaps, tileTimes }, null, 2));

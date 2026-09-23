/**
 * A4 —— 主題（light/dark）對 max zoom 內容可見度嘅影響
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = path.join(process.cwd(), "artifacts/audit-A4");
const A = `window.__m={m(c){const x=c.getContext('2d');const W=c.width,H=c.height;const d=x.getImageData(0,0,W,H).data;const N=W*H;const L=new Float32Array(N);const h=new Uint32Array(4096);for(let i=0;i<N;i++){const r=d[i*4],g=d[i*4+1],b=d[i*4+2];L[i]=0.299*r+0.587*g+0.114*b;h[((r>>4)<<8)|((g>>4)<<4)|(b>>4)]++;}let uc=0;for(let i=0;i<4096;i++)if(h[i]>0)uc++;let flat=0,gs=0,tot=0;for(let y=1;y<H-1;y++){const r=y*W;for(let x=1;x<W-1;x++){const i=r+x;const g=Math.abs(L[i+1]-L[i-1])+Math.abs(L[i+W]-L[i-W]);tot++;gs+=g;if(g<4)flat++;}}return{flatRatio:+(flat/tot).toFixed(4),meanGrad:+(gs/tot).toFixed(2),uniqueColors:uc};}};`;
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK", timezoneId: "Asia/Hong_Kong" });
await ctx.addInitScript(A);
const page = await ctx.newPage();
await page.goto(`${BASE}#ch=1`, { waitUntil: "load", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
for (let i = 0; i < 14; i++) { await page.locator("#map-zoom-in").click({ force: true }).catch(() => {}); await page.waitForTimeout(80); }
await page.waitForTimeout(1500);
const out = [];
for (const theme of ["light", "dark"]) {
  await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); window.dispatchEvent(new Event("basemap-theme-change")); }, theme);
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const c = document.querySelector("#svg-map-mount canvas");
    return { theme: document.documentElement.getAttribute("data-theme"), ...window.__m.m(c) };
  });
  out.push(r);
  await page.screenshot({ path: path.join(OUT, "shots", `maxzoom-theme-${theme}.png`) });
  console.log(theme, JSON.stringify(r));
}
await browser.close();
fs.writeFileSync(path.join(OUT, "theme-probe.json"), JSON.stringify(out, null, 2));

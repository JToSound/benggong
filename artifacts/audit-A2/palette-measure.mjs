/**
 * A2 色彩客觀量度：由實際 canvas 底圖像素計算
 *   - 飽和度分佈（找「高飽和橙」是否視覺主導）
 *   - 色相直方圖
 *   - 亮度分佈（找「低對比」）
 *
 * 只讀 production，只寫 artifacts/audit-A2/。
 * 執行：node artifacts/audit-A2/palette-measure.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const b = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

const MEASURE = `(() => {
  const canvas = document.querySelector('#svg-map-mount canvas');
  if (!canvas) return { error: 'no canvas' };
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h).data;
  const total = w * h;
  const hueHist = new Array(36).fill(0);       // 每 10 度一格
  const satHist = new Array(10).fill(0);       // 每 0.1 一格
  const lumHist = new Array(10).fill(0);       // 每 0.1 一格
  let highSat = 0, midSat = 0, lowSat = 0, alpha0 = 0;
  for (let i = 0; i < img.length; i += 4) {
    const a = img[i + 3] / 255;
    if (a === 0) { alpha0++; continue; }
    const r = img[i] / 255, g = img[i + 1] / 255, bl = img[i + 2] / 255;
    const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let hh = 0;
    if (d !== 0) {
      if (max === r) hh = 60 * (((g - bl) / d) % 6);
      else if (max === g) hh = 60 * ((bl - r) / d + 2);
      else hh = 60 * ((r - g) / d + 4);
    }
    if (hh < 0) hh += 360;
    hueHist[Math.min(35, Math.floor(hh / 10))]++;
    satHist[Math.min(9, Math.floor(s * 10))]++;
    lumHist[Math.min(9, Math.floor(l * 10))]++;
    if (s > 0.6) highSat++; else if (s > 0.3) midSat++; else lowSat++;
  }
  const opaque = total - alpha0;
  const pct = (n) => +(n / opaque * 100).toFixed(2);
  return {
    canvas: { w, h, dpr: window.devicePixelRatio },
    opaquePixels: opaque,
    saturation: { high_gt60: pct(highSat), mid_30_60: pct(midSat), low_lt30: pct(lowSat) },
    hueHist: hueHist.map((n, i) => ({ range: i * 10 + '-' + (i * 10 + 10), pct: pct(n) })).filter((x) => x.pct > 0.5),
    satHist: satHist.map((n, i) => ({ range: (i / 10).toFixed(1) + '-' + ((i + 1) / 10).toFixed(1), pct: pct(n) })).filter((x) => x.pct > 1),
    lumHist: lumHist.map((n, i) => ({ range: (i / 10).toFixed(1) + '-' + ((i + 1) / 10).toFixed(1), pct: pct(n) })).filter((x) => x.pct > 1),
  };
})()`;

async function measure(theme) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  await ctx.addInitScript(([t]) => { try { localStorage.setItem("binggang-theme", t); } catch {} }, [theme]);
  const p = await ctx.newPage();
  await p.goto("http://localhost:5180/", { waitUntil: "load" });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(MEASURE);
  await ctx.close();
  return r;
}

const out = { dark: await measure("dark"), light: await measure("light") };
for (const [k, v] of Object.entries(out)) {
  console.log(`\n===== ${k} 底圖像素分析 =====`);
  console.log(`canvas ${v.canvas.w}×${v.canvas.h} (dpr ${v.canvas.dpr})`);
  console.log(`飽和度分佈: 高(>0.6) ${v.saturation.high_gt60}% | 中(0.3-0.6) ${v.saturation.mid_30_60}% | 低(<0.3) ${v.saturation.low_lt30}%`);
  console.log(`色相直方圖(>0.5%): ${JSON.stringify(v.hueHist)}`);
  console.log(`亮度直方圖(>1%): ${JSON.stringify(v.lumHist)}`);
}
fs.writeFileSync("artifacts/audit-A2/palette-measure.json", JSON.stringify(out, null, 2), "utf8");
console.log("\n寫入 artifacts/audit-A2/palette-measure.json");
await b.close();

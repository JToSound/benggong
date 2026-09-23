/**
 * A4 —— Playwright zoom quality 探針（實測）
 *
 * 量度：
 *  - 各 zoom step：viewBox / basemap level / canvas backing / DPR
 *  - SVG 圖層節點數（zone / route / location / event / zone-label）
 *  - Canvas 像素分析：inkRatio、edgeDensity、meanGrad、p99Grad、uniqueColors
 *  - Raster fallback 模擬：將 hk-basemap.png / tko-*.png 按實際放大率畫上
 *    canvas，用同一套指標比較 —— 量化「若 fallback 觸發會唔會起格」
 *
 * 只寫 artifacts/audit-A4/。
 * 執行：node artifacts/audit-A4/zoom-quality-probe.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = path.join(process.cwd(), "artifacts/audit-A4");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

/** 注入到頁面：canvas 影像分析。 */
const ANALYZER = `
window.__a4 = {
  analyze(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const data = ctx.getImageData(0, 0, W, H).data;
    const N = W * H;
    const lum = new Float32Array(N);
    const hist = new Uint32Array(4096); // 4-bit/channel 量化
    for (let i = 0; i < N; i++) {
      const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
      lum[i] = 0.299*r + 0.587*g + 0.114*b;
      hist[((r>>4)<<8) | ((g>>4)<<4) | (b>>4)]++;
    }
    let bgBin = 0, bgCount = 0;
    for (let i = 0; i < 4096; i++) if (hist[i] > bgCount) { bgCount = hist[i]; bgBin = i; }
    const bgR = ((bgBin>>8)&15)*17, bgG = ((bgBin>>4)&15)*17, bgB = (bgBin&15)*17;
    // unique colors（4-bit）非空 bin
    let uniqueColors = 0;
    for (let i = 0; i < 4096; i++) if (hist[i] > 0) uniqueColors++;
    // 背景佔比
    let ink = 0;
    for (let i = 0; i < N; i++) {
      const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
      if (Math.abs(r-bgR)+Math.abs(g-bgG)+Math.abs(b-bgB) > 30) ink++;
    }
    // 梯度（Sobel 近似）＋ 梯度直方圖
    const ghist = new Uint32Array(64); // 每 4 一 bin，上限 255
    let gradSum = 0, gradN = 0, edgeCount = 0;
    for (let y = 1; y < H-1; y += 1) {
      const row = y*W;
      for (let x = 1; x < W-1; x += 1) {
        const i = row + x;
        const gx = lum[i+1] - lum[i-1];
        const gy = lum[i+W] - lum[i-W];
        const g = Math.abs(gx) + Math.abs(gy);
        gradSum += g; gradN++;
        if (g > 24) edgeCount++;
        ghist[Math.min(63, g>>2)]++;
      }
    }
    // p99 梯度
    let acc = 0, p99 = 0; const target = gradN * 0.99;
    for (let i = 0; i < 64; i++) { acc += ghist[i]; if (acc >= target) { p99 = i*4; break; } }
    // 高頻能量：相鄰像素差（水平）平均值 —— 上採樣會拉低
    let hf = 0, hfN = 0;
    for (let y = 1; y < H-1; y += 3) {
      const row = y*W;
      for (let x = 1; x < W-2; x += 3) { hf += Math.abs(lum[row+x+1] - lum[row+x]); hfN++; }
    }
    return {
      W, H,
      inkRatio: +(ink/N).toFixed(4),
      edgeDensity: +(edgeCount/gradN).toFixed(4),
      meanGrad: +(gradSum/gradN).toFixed(2),
      p99Grad: p99,
      uniqueColors,
      hfEnergy: +(hf/hfN).toFixed(2),
      bg: 'rgb('+bgR+','+bgG+','+bgB+')',
    };
  },

  /**
   * Raster fallback 模擬：將一張圖以指定放大率畫上 canvas，再分析。
   * src：圖片 URL；cropFrac：由原圖裁幾多比例（= 視窗佔圖磚跨度比例）；
   * 輸出 canvas 尺寸 = 1060×752（CSS），DPR 由 backing 決定。
   */
  async rasterSim(src, cropFrac, cssW, cssH, dpr) {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    });
    const c = document.createElement('canvas');
    c.width = Math.round(cssW*dpr); c.height = Math.round(cssH*dpr);
    const cx = c.getContext('2d', { alpha: false });
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    const sw = img.naturalWidth * cropFrac;
    const sh = img.naturalHeight * cropFrac;
    const sx = (img.naturalWidth - sw) / 2;
    const sy = (img.naturalHeight - sh) / 2;
    cx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const stats = this.analyze(c);
    return { src, naturalW: img.naturalWidth, naturalH: img.naturalHeight, cropFrac, upscale: +(c.width/(sw)).toFixed(2), stats };
  },
};
`;

const VIEWS = [
  { step: 0, label: "initial" },
  { step: 4, label: "z4" },
  { step: 8, label: "z8" },
  { step: 12, label: "z12" },
  { step: 14, label: "z14-max" },
];

async function run(dpr) {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: dpr,
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
  });
  await ctx.addInitScript(ANALYZER);
  const page = await ctx.newPage();
  const tileReq = [];
  page.on("response", (r) => {
    const u = r.url();
    if (/assets\/(vector|map-lod)\//.test(u)) tileReq.push({ url: u.replace(BASE, ""), status: r.status() });
  });

  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const probe = async () => page.evaluate(() => {
    const svg = document.querySelector("#svg-map-mount svg") || document.querySelector("#svg-map");
    const canvas = document.querySelector("#svg-map-mount canvas") || document.querySelector("#basemap-canvas");
    const q = (s) => svg ? svg.querySelectorAll(s).length : 0;
    const stats = canvas ? window.__a4.analyze(canvas) : null;
    const imgs = [...document.querySelectorAll("img, image")].map((e) => ({
      tag: e.tagName,
      href: (e.getAttribute("href") || e.getAttribute("src") || "").slice(0, 80),
      nw: e.naturalWidth || null,
    })).filter((x) => x.href);
    return {
      viewBox: svg?.getAttribute("viewBox") ?? null,
      level: canvas?.dataset?.basemapLevel ?? null,
      canvasBacking: canvas ? { w: canvas.width, h: canvas.height } : null,
      canvasCss: canvas ? { w: Math.round(canvas.getBoundingClientRect().width), h: Math.round(canvas.getBoundingClientRect().height) } : null,
      dpr: window.devicePixelRatio,
      counts: {
        zones: q(".zone"),
        zoneLabels: q(".zone-label"),
        routes: q(".route-line"),
        locations: q(".location-marker"),
        clusters: q(".location-marker-cluster"),
        events: q(".event-marker"),
      },
      rasterImages: imgs,
      stats,
    };
  });

  const series = [];
  const results = { dpr, series };
  results.initial = await probe();
  await page.screenshot({ path: path.join(SHOTS, `zoom-dpr${dpr}-initial.png`) });

  let clicks = 0;
  for (const v of VIEWS) {
    if (v.step === 0) continue;
    while (clicks < v.step) {
      await page.locator("#map-zoom-in").click({ force: true }).catch(() => {});
      clicks++;
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(1200); // 等圖磚非同步載入
    const p = await probe();
    p.step = v.step; p.label = v.label;
    series.push(p);
    await page.screenshot({ path: path.join(SHOTS, `zoom-dpr${dpr}-${v.label}.png`) });
  }

  // Raster fallback 模擬（只做一次，用 DPR 同實際視窗）
  const cssW = results.initial.canvasCss?.w ?? 1060;
  const cssH = results.initial.canvasCss?.h ?? 752;
  results.rasterSim = await page.evaluate(
    async ({ cssW, cssH, dpr }) => {
      const out = [];
      // 全港 overview 圖磚（0.70° span）被要求覆蓋 0.02° 視窗 → 裁 2.86%
      out.push(await window.__a4.rasterSim("/assets/hk-basemap.png", 0.02/0.70, cssW, cssH, dpr));
      // 若覆蓋 TKO 最細層 tko-campus-core（0.026° span）
      out.push(await window.__a4.rasterSim("/assets/map-lod/tko-campus-core.png", 0.02/0.026, cssW, cssH, dpr));
      // 1:1 對照（裁 100%）
      out.push(await window.__a4.rasterSim("/assets/hk-basemap.png", 1.0, cssW, cssH, dpr));
      return out;
    },
    { cssW, cssH, dpr },
  );

  results.tileRequests = tileReq;
  await browser.close();
  return results;
}

const all = [];
for (const dpr of [1, 2]) {
  console.log(`\n=== DPR ${dpr} ===`);
  const r = await run(dpr);
  all.push(r);
  console.log(JSON.stringify(r, null, 2));
}

fs.writeFileSync(path.join(OUT, "zoom-probe.json"), JSON.stringify(all, null, 2));
console.log("\n已寫入 artifacts/audit-A4/zoom-probe.json");

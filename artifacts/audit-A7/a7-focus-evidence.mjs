/**
 * A7 決證探針：clip-path 對 focus ring 嘅影響。
 * 輸出：聚焦前後 crop PNG（artifacts/audit-A7/focus-*）+ 變化像素嘅分佈統計。
 *
 * 執行：node artifacts/audit-A7/a7-focus-evidence.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map");
await page.waitForTimeout(1800);
await page.addStyleTag({ content: "*,*::before,*::after{animation:none !important;transition:none !important}" });
await page.waitForTimeout(300);

const report = {};

async function analyse(selector, pad, tag) {
  const box = await page.evaluate(({ s, pad }) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)),
             width: Math.ceil(r.width + pad * 2), height: Math.ceil(r.height + pad * 2),
             innerX: Math.floor(r.x) - Math.max(0, Math.floor(r.x - pad)),
             innerY: Math.floor(r.y) - Math.max(0, Math.floor(r.y - pad)),
             innerW: Math.ceil(r.width), innerH: Math.ceil(r.height) };
  }, { s: selector, pad });
  if (!box) return null;
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.waitForTimeout(120);
  const before = (await page.screenshot({ clip: box })).toString("base64");
  await page.evaluate((s) => document.querySelector(s).focus(), selector);
  await page.waitForTimeout(150);
  const after = (await page.screenshot({ clip: box })).toString("base64");

  const stat = await page.evaluate(async ({ a, b, box }) => {
    async function decode(b64) {
      const res = await fetch("data:image/png;base64," + b64);
      const bmp = await createImageBitmap(await res.blob());
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height);
    }
    const A = await decode(a), B = await decode(b);
    const w = A.width, h = A.height;
    let ring = 0, inner = 0;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const changed = Math.abs(A.data[i] - B.data[i]) > 6 ||
                        Math.abs(A.data[i + 1] - B.data[i + 1]) > 6 ||
                        Math.abs(A.data[i + 2] - B.data[i + 2]) > 6;
        if (!changed) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        const inInner = x >= box.innerX && x < box.innerX + box.innerW &&
                        y >= box.innerY && y < box.innerY + box.innerH;
        if (inInner) inner++; else ring++;
      }
    }
    return { w, h, ring, inner,
      changedBBox: maxX < 0 ? null : { x: minX, y: minY, x2: maxX, y2: maxY },
      borderBoxInCrop: { x: box.innerX, y: box.innerY, w: box.innerW, h: box.innerH } };
  }, { a: before, b: after, box });

  fs.writeFileSync(path.join(OUT, `focus-${tag}-unfocused.png`), Buffer.from(before, "base64"));
  fs.writeFileSync(path.join(OUT, `focus-${tag}-focused.png`), Buffer.from(after, "base64"));
  return { selector, ...stat, ringVisible: stat.ring > 20 };
}

report["#btn-mode"] = await analyse("#btn-mode", 12, "btn-mode");
report["#map-zoom-in"] = await analyse("#map-zoom-in", 12, "map-zoom-in");

// 對照：移除 clip-path
await page.addStyleTag({ content: ".nav-btn,.map-ctrl,.legend-lang-btn{clip-path:none !important}" });
await page.waitForTimeout(300);
report["#btn-mode-noClip"] = await analyse("#btn-mode", 12, "btn-mode-noclip");
report["#map-zoom-in-noClip"] = await analyse("#map-zoom-in", 12, "map-zoom-in-noclip");

fs.writeFileSync(path.join(OUT, "a7-focus-evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();

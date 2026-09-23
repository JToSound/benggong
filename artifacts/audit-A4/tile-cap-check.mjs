/**
 * A4 —— 檢查 level 2 但 tile window > 16 格時會唔會靜默跳過圖磚。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = path.join(process.cwd(), "artifacts/audit-A4");
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-HK", timezoneId: "Asia/Hong_Kong" });
const page = await ctx.newPage();
const tiles = [];
page.on("response", (r) => { const u = r.url(); if (/assets\/vector\/tiles\//.test(u)) tiles.push(u.split("/").pop()); });

const out = [];
for (const ch of [1, 150]) {
  tiles.length = 0;
  await page.goto(`${BASE}#ch=${ch}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const r = await page.evaluate(() => {
    const svg = document.querySelector("#svg-map-mount svg");
    const c = document.querySelector("#svg-map-mount canvas");
    return { vb: svg.getAttribute("viewBox"), level: c.dataset.basemapLevel };
  });
  out.push({ ch, ...r, tilesLoaded: tiles.length, tiles: [...tiles].sort() });
  console.log(`ch=${ch} level=${r.level} vb=${r.vb} tiles=${tiles.length}`);
}
await browser.close();
fs.writeFileSync(path.join(OUT, "tile-cap-check.json"), JSON.stringify(out, null, 2));

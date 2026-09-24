/**
 * C7 探測 I：VA4 精確量度 —— 只計 **HTML** 文字（排除 #svg-map 內嘅 SVG 文字，
 * 佢哋嘅 computed px 係 userSpaceOnUse 縮放值，唔代表 UI 字級）。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-font.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const OUT = "artifacts/audit-A7/c7-font.json";

const MEASURE = () => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("#svg-map")) continue; // 排除 SVG 地圖文字
    let hasText = false;
    for (const n of el.childNodes)
      if (n.nodeType === 3 && (n.textContent ?? "").trim().length > 0) {
        hasText = true;
        break;
      }
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth)
      continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 2).join("."),
      fs: parseFloat(cs.fontSize),
      text: (el.textContent ?? "").trim().slice(0, 26),
    });
  }
  return out;
};

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const result = { measuredAt: new Date().toISOString(), baseUrl: BASE };

for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#svg-map", { state: "visible", timeout: 25000 });
  await page.waitForTimeout(1800);
  if (theme === "light")
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(600);
  const fonts = await page.evaluate(MEASURE);
  const under12 = fonts.filter((f) => f.fs < 12);
  result[theme] = {
    measured: fonts.length,
    under12Count: under12.length,
    min: fonts.length ? Math.min(...fonts.map((f) => f.fs)) : null,
    worst: under12.sort((a, b) => a.fs - b.fs).slice(0, 20),
  };
  console.log(`[font] ${theme} total=${fonts.length} under12=${under12.length} min=${result[theme].min}`);
  await ctx.close();
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();

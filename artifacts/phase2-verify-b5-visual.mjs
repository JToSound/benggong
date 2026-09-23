/**
 * B5 收尾視覺驗證（只讀 production，只寫 artifacts/）
 *
 * 用途：確認 B5 嘅四個 P0 修正（tile POI、建築對比、zone 永遠全 render、
 *      LOD Z 政策）喺 production build 真係生效。
 *
 * 執行：node artifacts/phase2-verify-b5-visual.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--no-proxy-server"],
});

const SNAP = () => {
  const svg = document.querySelector("#svg-map-mount svg");
  const wrap = document.querySelector(".svg-map-wrap");
  const r = wrap?.getBoundingClientRect();
  return {
    viewBox: svg?.getAttribute("viewBox") ?? null,
    wrapSize: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
    zones: document.querySelectorAll("#svg-map-mount .zone").length,
    zoneAreas: document.querySelectorAll("#svg-map-mount .zone-area").length,
    eventMarkers: document.querySelectorAll("#svg-map-mount .event-marker").length,
    labels: document.querySelectorAll("#svg-map-mount text").length,
    canvas: (() => {
      const c = document.querySelector("#svg-map-mount canvas");
      return c ? { w: c.width, h: c.height } : null;
    })(),
    images: [...document.querySelectorAll("img")].map((i) => i.getAttribute("src")),
    imageTags: document.querySelectorAll("image").length,
    theme: document.documentElement.getAttribute("data-theme"),
  };
};

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1800);

const initial = await page.evaluate(SNAP);
await page.screenshot({ path: `${OUT}/phase2-b5-world-view.png` });

// 縮到最大 zoom（14 次點擊達 0.02°；多點幾次確保 clamp）
const zoomBtn = page.locator("#map-zoom-in");
for (let i = 0; i < 16; i++) {
  if (!(await zoomBtn.count())) break;
  await zoomBtn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(260);
}
await page.waitForTimeout(1200);
const maxZoom = await page.evaluate(SNAP);
await page.screenshot({ path: `${OUT}/phase2-b5-max-zoom.png` });

// 開「顯示全部事件」（如有）
const showAll = page.locator("#toggle-show-all-events, [data-toggle='show-all-events']");
let showAllState = null;
if (await showAll.count()) {
  await showAll.first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(900);
  showAllState = await page.evaluate(SNAP);
  await page.screenshot({ path: `${OUT}/phase2-b5-max-zoom-showall.png` });
}

await ctx.close();
await browser.close();

const out = {
  baseUrl: BASE,
  capturedAt: new Date().toISOString(),
  initial,
  maxZoom,
  showAllState,
  pageErrors: errors.length,
  errorSample: errors.slice(0, 5),
};
fs.writeFileSync(
  "artifacts/phase2-b5-visual-summary.json",
  JSON.stringify(out, null, 2),
);
console.log(JSON.stringify(out, null, 2));

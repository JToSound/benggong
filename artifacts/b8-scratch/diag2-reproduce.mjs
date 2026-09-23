/**
 * 診斷 2：重現 `map-interaction.e2e.test.ts` 嘅確切流程，
 * 並測試 `#search-shell` 係否造成 `#app-root` 向左偏移（x = -393）。
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const measure = (label) =>
  page.evaluate((lbl) => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.x),
        w: Math.round(b.width),
        right: Math.round(b.right),
      };
    };
    const bodyCs = getComputedStyle(document.body);
    const htmlCs = getComputedStyle(document.documentElement);
    const svg = document.querySelector("#svg-map");
    return {
      label: lbl,
      body: {
        display: bodyCs.display,
        flexDirection: bodyCs.flexDirection,
        overflowX: bodyCs.overflowX,
        width: Math.round(document.body.getBoundingClientRect().width),
        scrollWidth: document.body.scrollWidth,
      },
      html: {
        overflowX: htmlCs.overflowX,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      appRoot: r("#app-root"),
      searchShell: r("#search-shell"),
      mapPane: r("#map-pane"),
      viewBox: svg?.getAttribute("viewBox"),
      childCount: document.body.children.length,
      children: Array.from(document.body.children).map((c) => c.id || c.tagName),
    };
  }, label);

console.log("=== ① 初始（未改任何嘢） ===");
console.log(JSON.stringify(await measure("initial"), null, 2));

// 重現測試流程：按 k 197 次
console.log("\n=== ② 按 k ×197 之後 ===");
for (let i = 0; i < 197; i++) await page.keyboard.press("k");
await page.waitForTimeout(1500);
console.log(JSON.stringify(await measure("afterK197"), null, 2));

// zoom 3 次
for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
await page.waitForTimeout(900);
console.log("\n=== ③ zoom ×3 之後（測試嘅確切狀態） ===");
console.log(JSON.stringify(await measure("afterZoom"), null, 2));

// 重現測試嘅 zone 揀選邏輯（第一個夠大嘅 zone）
const hit = await page.evaluate(() => {
  const svg = document.querySelector("#svg-map");
  const rect = svg.getBoundingClientRect();
  const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
  let checked = 0;
  const skipped = [];
  for (const z of zones) {
    const area = z.querySelector(".zone-area");
    if (!area) continue;
    const b = area.getBoundingClientRect();
    if (b.width < 12 || b.height < 12) {
      skipped.push({ w: Math.round(b.width), h: Math.round(b.height) });
      continue;
    }
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    checked++;
    if (cx < rect.x + 4 || cx > rect.right - 4) {
      skipped.push({ reason: "cx-out-svg", cx: Math.round(cx), svgX: Math.round(rect.x) });
      continue;
    }
    if (cy < rect.y + 4 || cy > rect.bottom - 4) {
      skipped.push({ reason: "cy-out-svg", cy: Math.round(cy) });
      continue;
    }
    const el = document.elementFromPoint(cx, cy);
    return {
      zoneId: z.getAttribute("data-zone-id"),
      cx: Math.round(cx),
      cy: Math.round(cy),
      inViewport: cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight,
      hitClass: el ? el.getAttribute("class") : null,
      hitTag: el ? el.tagName : null,
      checked,
      skippedCount: skipped.length,
      skippedSample: skipped.slice(0, 5),
    };
  }
  return { found: false, checked, skippedCount: skipped.length, skippedSample: skipped.slice(0, 8) };
});
console.log("\n=== ④ 測試邏輯嘅 zone 揀選結果 ===");
console.log(JSON.stringify(hit, null, 2));

// ⑤ 測試：如果移除 #search-shell，app-root.x 會唔會變返 0？
const afterRemove = await page.evaluate(() => {
  const sh = document.getElementById("search-shell");
  const before = Math.round(document.querySelector("#app-root").getBoundingClientRect().x);
  sh?.remove();
  const after = Math.round(document.querySelector("#app-root").getBoundingClientRect().x);
  return { before, after, removed: Boolean(sh) };
});
console.log("\n=== ⑤ 移除 #search-shell 前後 app-root.x ===");
console.log(JSON.stringify(afterRemove, null, 2));

await browser.close();

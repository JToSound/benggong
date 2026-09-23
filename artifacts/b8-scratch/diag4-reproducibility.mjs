/** 診斷 4：確認 `#app-root` x 偏移嘅可重現性（跑 3 次）。 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });

for (let run = 1; run <= 3; run++) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await page.waitForTimeout(1500);
  for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
  await page.waitForTimeout(900);

  const r = await page.evaluate(() => {
    const svg = document.querySelector("#svg-map");
    const rect = svg.getBoundingClientRect();
    const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
    let pick = null;
    for (const z of zones) {
      const area = z.querySelector(".zone-area");
      if (!area) continue;
      const b = area.getBoundingClientRect();
      if (b.width < 12 || b.height < 12) continue;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      if (cx < rect.x + 4 || cx > rect.right - 4) continue;
      if (cy < rect.y + 4 || cy > rect.bottom - 4) continue;
      const el = document.elementFromPoint(cx, cy);
      pick = {
        zoneId: z.getAttribute("data-zone-id"),
        cx: Math.round(cx),
        cy: Math.round(cy),
        hitTag: el ? el.tagName : null,
        hitClass: el ? el.getAttribute("class") : null,
      };
      break;
    }
    return {
      appX: Math.round(document.querySelector("#app-root").getBoundingClientRect().x),
      scrollX: window.scrollX,
      htmlSL: document.documentElement.scrollLeft,
      bodySL: document.body.scrollLeft,
      bodyScrollW: document.body.scrollWidth,
      viewBoxW: (svg.getAttribute("viewBox") || "").split(" ")[2],
      pick,
    };
  });
  console.log(`run${run}:`, JSON.stringify(r));
  await page.close();
}

await browser.close();

/**
 * 診斷：`elementFromPoint(zone 中心)` 返 null 嘅根因。
 *
 * 背景：B8 接線之後，`tests/map-interaction.e2e.test.ts` 嘅 P0-1 核心斷言由綠轉紅，
 * 錯誤訊息係「實際命中：null」——即係座標處冇任何元素。
 *
 * 呢個腳本喺真實 Chromium 量：viewport、各容器 rect、zone rect、
 * `elementFromPoint` 結果、以及 `#app-root` 有冇 inert。
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text());
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 重現測試流程：zoom in 3 次
for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
await page.waitForTimeout(900);

const diag = await page.evaluate(() => {
  const rectOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.width),
      h: Math.round(b.height),
      right: Math.round(b.right),
      bottom: Math.round(b.bottom),
      display: cs.display,
      visibility: cs.visibility,
      position: cs.position,
      zIndex: cs.zIndex,
      inert: el.hasAttribute("inert"),
    };
  };

  const vp = { w: innerWidth, h: innerHeight, scrollX, scrollY };

  const svg = document.querySelector("#svg-map");
  const svgRect = svg?.getBoundingClientRect();
  const viewBox = svg?.getAttribute("viewBox");

  // 搵最大嘅 zone（同測試同一邏輯）
  const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
  let best = null;
  for (const z of zones) {
    const area = z.querySelector(".zone-area");
    if (!area) continue;
    const b = area.getBoundingClientRect();
    if (b.width < 12 || b.height < 12) continue;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const inSvg =
      svgRect &&
      cx >= svgRect.x + 4 &&
      cx <= svgRect.right - 4 &&
      cy >= svgRect.y + 4 &&
      cy <= svgRect.bottom - 4;
    const inVp = cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight;
    if (!best || b.width * b.height > best.areaW * best.areaH) {
      const el = document.elementFromPoint(cx, cy);
      best = {
        zoneId: z.getAttribute("data-zone-id"),
        areaW: Math.round(b.width),
        areaH: Math.round(b.height),
        cx: Math.round(cx),
        cy: Math.round(cy),
        inSvgRect: Boolean(inSvg),
        inViewport: inVp,
        hitClass: el ? el.getAttribute("class") : null,
        hitTag: el ? el.tagName : null,
      };
    }
  }

  return {
    viewport: vp,
    svgRect: svgRect
      ? {
          x: Math.round(svgRect.x),
          y: Math.round(svgRect.y),
          w: Math.round(svgRect.width),
          h: Math.round(svgRect.height),
        }
      : null,
    viewBox,
    containers: {
      appRoot: rectOf("#app-root"),
      mapPane: rectOf("#map-pane"),
      storyPane: rectOf("#story-pane"),
      svgMapMount: rectOf("#svg-map-mount"),
      svgMap: rectOf("#svg-map"),
      zonesLayer: rectOf("#zones-layer"),
      onboarding: rectOf(".onboarding-card, #onboarding-card"),
      searchShell: rectOf("#search-shell"),
    },
    zoneCount: zones.length,
    best,
    // 額外：頂層遮蓋物
    topAtCenter: (() => {
      if (!best) return null;
      const els = document.elementsFromPoint(best.cx, best.cy);
      return els.slice(0, 6).map((e) => `${e.tagName}.${e.getAttribute("class") || ""}`);
    })(),
  };
});

console.log(JSON.stringify(diag, null, 2));

await browser.close();

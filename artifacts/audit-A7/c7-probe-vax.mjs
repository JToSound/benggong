/**
 * C7 探測 G：VA4（最小字級 ≥12px）、VA9（收合面板 Tab stop ≤300）、VA12（legend 三通道 + outpost）。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-vax.mjs
 * 輸出：artifacts/audit-A7/c7-vax.json
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const OUT = "artifacts/audit-A7/c7-vax.json";
const log = (...a) => console.log("[vax]", ...a);

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

const FONT_MEASURE = () => {
  const out = [];
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    // 只計有直接文字嘅元素
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && (n.textContent ?? "").trim().length > 0) {
        hasText = true;
        break;
      }
    }
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // 離屏過濾
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth)
      continue;
    const fs = parseFloat(cs.fontSize);
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 2).join("."),
      fs,
      text: (el.textContent ?? "").trim().slice(0, 24),
    });
  }
  return out;
};

const TABSTOP = () => {
  const sel =
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const els = Array.from(document.querySelectorAll(sel));
  return els.filter((e) => {
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = e.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }).length;
};

const result = { measuredAt: new Date().toISOString(), baseUrl: BASE };

// ── VA4 / VA12：desktop dark + light ──
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#svg-map", { state: "visible", timeout: 25000 });
  await page.waitForTimeout(1800);
  if (theme === "light")
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(600);
  const fonts = await page.evaluate(FONT_MEASURE);
  const under12 = fonts.filter((f) => f.fs < 12);
  result[`va4_${theme}`] = {
    measured: fonts.length,
    under12Count: under12.length,
    min: fonts.length ? Math.min(...fonts.map((f) => f.fs)) : null,
    worst: under12.sort((a, b) => a.fs - b.fs).slice(0, 15),
  };
  log("VA4", theme, "total", fonts.length, "under12", under12.length, "min", result[`va4_${theme}`].min);
  if (theme === "dark") {
    const legend = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("#map-legend .legend-item, .legend-item"));
      const outpost = items.find((i) => (i.textContent ?? "").includes("據點"));
      return {
        legendItemCount: items.length,
        hasOutpost: Boolean(outpost),
        outpostChannels: outpost
          ? {
              color: Boolean(outpost.querySelector(".area-outpost")),
              pattern: Boolean(outpost.querySelector(".legend-pattern")),
              glyph: Boolean(outpost.querySelector(".legend-glyph")),
              label: (outpost.textContent ?? "").trim(),
            }
          : null,
        zoneItemsWithPattern: items.filter((i) => i.querySelector(".legend-pattern")).length,
        zoneItemsWithGlyph: items.filter((i) => i.querySelector(".legend-glyph")).length,
      };
    });
    result.va12 = legend;
    log("VA12", JSON.stringify(legend));
  }
  await ctx.close();
}

// ── VA9：mobile 390×844 收合面板 Tab stop ──
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#svg-map", { state: "visible", timeout: 25000 });
  await page.waitForTimeout(2000);
  const r = await page.evaluate((TABSTOP_SRC) => {
    const TABSTOP = new Function("return (" + TABSTOP_SRC + ")()");
    const pane = document.querySelector("#story-pane");
    const sel =
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
    const inPane = pane ? Array.from(pane.querySelectorAll(sel)) : [];
    return {
      paneExists: Boolean(pane),
      paneSnap: pane?.getAttribute("data-sheet-snap") ?? null,
      paneVisible: pane
        ? (() => {
            const cs = getComputedStyle(pane);
            return cs.display !== "none" && cs.visibility !== "hidden";
          })()
        : false,
      tabStopsInPane: inPane.length,
      tabStopsInPaneFocusable: inPane.filter((e) => {
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const b = e.getBoundingClientRect();
        return b.width >= 1 && b.height >= 1;
      }).length,
      tabStopsTotal: TABSTOP(),
    };
  }, TABSTOP.toString());
  result.va9 = r;
  log("VA9", JSON.stringify(r));
  await ctx.close();
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();

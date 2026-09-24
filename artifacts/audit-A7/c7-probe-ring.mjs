/**
 * C7 探測 D：焦點環 dark / light 逐像素（zone 同 event-marker）。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-ring.mjs
 * 輸出：artifacts/audit-A7/c7-ring.json + c7-ring-*.png
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const OUT = "artifacts/audit-A7/c7-ring.json";
const log = (...a) => console.log("[ring]", ...a);

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

async function load(theme) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#svg-map", { state: "visible", timeout: 25000 });
  await page.waitForTimeout(1400);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
    await page.waitForTimeout(140);
  }
  await page.waitForTimeout(700);
  await page.evaluate((t) => {
    if (t === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }, theme);
  await page.waitForTimeout(500);
}

/** 由 index 0 用方向鍵行到 target index。 */
async function walkTo(idx, total) {
  await page.evaluate(() => {
    const s = document.querySelector("#svg-map");
    if (s && typeof s.focus === "function") s.focus();
  });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(220);
  if (idx <= Math.floor(total / 2)) {
    for (let i = 0; i < idx; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(35);
    }
  } else {
    for (let i = 0; i < total - idx; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(35);
    }
  }
}

const result = { measuredAt: new Date().toISOString(), baseUrl: BASE, byTheme: {} };

for (const theme of ["dark", "light"]) {
  await load(theme);
  const total = await page.evaluate(
    () =>
      document.querySelectorAll(
        "#svg-map .zone, #svg-map .route-line, #svg-map .location-marker, #svg-map .location-marker-cluster, #svg-map .event-marker",
      ).length,
  );
  const order = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "#svg-map .zone, #svg-map .route-line, #svg-map .location-marker, #svg-map .location-marker-cluster, #svg-map .event-marker",
      ),
    ).map((e) => (e.getAttribute("class") ?? "").split(/\s+/)[0]),
  );
  const themeRes = {};
  for (const type of ["zone", "location-marker", "event-marker"]) {
    const idx = order.indexOf(type);
    if (idx < 0) {
      themeRes[type] = { present: false };
      continue;
    }
    await load(theme);
    await walkTo(idx, total);
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.getAttribute) return null;
      const b = el.getBoundingClientRect();
      const pad = 14;
      const x = Math.max(0, Math.floor(b.x - pad));
      const y = Math.max(0, Math.floor(b.y - pad));
      const right = Math.min(window.innerWidth, Math.ceil(b.right + pad));
      const bottom = Math.min(window.innerHeight, Math.ceil(b.bottom + pad));
      return {
        cls: (el.getAttribute("class") ?? "").split(/\s+/)[0],
        id:
          el.getAttribute("data-zone-id") ??
          el.getAttribute("data-loc-id") ??
          el.getAttribute("data-event-id") ??
          null,
        filter: getComputedStyle(el).filter,
        clip:
          right - x >= 12 && bottom - y >= 12
            ? { x, y, width: right - x, height: bottom - y }
            : null,
      };
    });
    if (!active || !active.clip) {
      themeRes[type] = { present: true, measured: false, active };
      continue;
    }
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(260);
    const unfocused = await page.screenshot({ clip: active.clip });
    // 再聚焦（鍵盤）
    await load(theme);
    await walkTo(idx, total);
    await page.waitForTimeout(220);
    const focused = await page.screenshot({ clip: active.clip });
    const diff = Buffer.compare(unfocused, focused) !== 0;
    fs.writeFileSync(
      `artifacts/audit-A7/c7-ring-${theme}-${type}-focused.png`,
      focused,
    );
    fs.writeFileSync(
      `artifacts/audit-A7/c7-ring-${theme}-${type}-unfocused.png`,
      unfocused,
    );
    themeRes[type] = {
      present: true,
      measured: true,
      activeCls: active.cls,
      activeId: active.id,
      filterFocused: active.filter,
      ringPixelsChanged: diff,
    };
    log(theme, type, "diff", diff, "filter", active.filter);
  }
  result.byTheme[theme] = themeRes;
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();

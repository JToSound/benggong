/**
 * C7 探測 D2：焦點環 dark / light，**同一 session** 內 focused vs blurred。
 *
 * 為何重寫：前一版（c7-probe-ring.mjs）為咗攞 focused 圖而**重新載入**頁面，
 * 令 unfocused / focused 兩張圖可能來自唔同 map 位置 → 假陰性。今次：
 *   ① 鍵盤行到目標 → 截 focused
 *   ② 同頁 `blur()` → 截 unfocused
 * 並且同時記錄 data-theme 同 computed --focus-ring，確保真係量到對應主題。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-ring2.mjs
 * 輸出：artifacts/audit-A7/c7-ring2.json + c7-ring2-*.png
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const OUT = "artifacts/audit-A7/c7-ring2.json";
const log = (...a) => console.log("[ring2]", ...a);

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
  if (theme === "light") {
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
  } else {
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  }
  await page.waitForTimeout(600);
}

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
  const themeRes = {};
  for (const type of ["zone", "location-marker", "event-marker"]) {
    await load(theme);
    const info = await page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll(
          "#svg-map .zone, #svg-map .route-line, #svg-map .location-marker, #svg-map .location-marker-cluster, #svg-map .event-marker",
        ),
      );
      const types = els.map((e) => (e.getAttribute("class") ?? "").split(/\s+/)[0]);
      return {
        total: els.length,
        idxOf: (t) => types.indexOf(t),
        ring: getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim(),
        themeAttr: document.documentElement.getAttribute("data-theme"),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    const idx = await page.evaluate(
      (t) =>
        Array.from(
          document.querySelectorAll(
            "#svg-map .zone, #svg-map .route-line, #svg-map .location-marker, #svg-map .location-marker-cluster, #svg-map .event-marker",
          ),
        )
          .map((e) => (e.getAttribute("class") ?? "").split(/\s+/)[0])
          .indexOf(t),
      type,
    );
    if (idx < 0) {
      themeRes[type] = { present: false };
      continue;
    }
    await walkTo(idx, info.total);
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.getAttribute) return null;
      const b = el.getBoundingClientRect();
      const pad = 16;
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
        w: Math.round(b.width),
        h: Math.round(b.height),
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
    const focused = await page.screenshot({ clip: active.clip });
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(300);
    const unfocused = await page.screenshot({ clip: active.clip });
    const diff = Buffer.compare(unfocused, focused) !== 0;
    fs.writeFileSync(`artifacts/audit-A7/c7-ring2-${theme}-${type}-focused.png`, focused);
    fs.writeFileSync(`artifacts/audit-A7/c7-ring2-${theme}-${type}-unfocused.png`, unfocused);
    themeRes[type] = {
      present: true,
      measured: true,
      landed: active.cls,
      id: active.id,
      filter: active.filter,
      size: { w: active.w, h: active.h },
      ringToken: info.ring,
      themeAttr: info.themeAttr,
      ringPixelsChanged: diff,
    };
    log(theme, type, "diff", diff, "filter", active.filter, "ring", info.ring);
  }
  result.byTheme[theme] = themeRes;
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();

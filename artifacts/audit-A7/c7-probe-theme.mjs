/**
 * C7 探測 E：dark / light 主題下，地圖區域本身有冇變色？焦點環顏色對比？
 * 同時重測 light 主題 location-marker（換 marker / cluster）確認唔係偶發。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-theme.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const OUT = "artifacts/audit-A7/c7-theme.json";
const log = (...a) => console.log("[theme]", ...a);

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
  if (theme === "light")
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  else await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
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

const result = { measuredAt: new Date().toISOString(), baseUrl: BASE };

for (const theme of ["dark", "light"]) {
  await load(theme);
  const shot = await page.screenshot({ fullPage: false });
  fs.writeFileSync(`artifacts/audit-A7/c7-theme-${theme}.png`, shot);
  const info = await page.evaluate(() => {
    const mapWrap = document.querySelector(".svg-map-wrap");
    const cs = mapWrap ? getComputedStyle(mapWrap) : null;
    return {
      themeAttr: document.documentElement.getAttribute("data-theme"),
      focusRing: getComputedStyle(document.documentElement)
        .getPropertyValue("--focus-ring")
        .trim(),
      mapBg: cs?.backgroundColor ?? null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      zoneOpacitySample: (() => {
        const z = document.querySelector("#svg-map .zone-area");
        return z ? getComputedStyle(z).opacity : null;
      })(),
    };
  });
  result[theme] = { info };

  // 重測 location markers（多個）+ cluster
  const targets = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "#svg-map .zone, #svg-map .route-line, #svg-map .location-marker, #svg-map .location-marker-cluster, #svg-map .event-marker",
      ),
    )
      .map((e, i) => ({
        i,
        cls: (e.getAttribute("class") ?? "").split(/\s+/)[0],
        id:
          e.getAttribute("data-loc-id") ??
          e.getAttribute("data-zone-id") ??
          e.getAttribute("data-event-id") ??
          null,
        opacity: getComputedStyle(e).opacity,
        fill: getComputedStyle(e).fill,
      }))
      .filter((x) => x.cls.startsWith("location") || x.cls === "event-marker")
      .slice(0, 5),
  );
  const total = await page.evaluate(
    () =>
      document.querySelectorAll(
        "#svg-map .zone, #svg-map .route-line, #svg-map .location-marker, #svg-map .location-marker-cluster, #svg-map .event-marker",
      ).length,
  );
  const measured = [];
  for (const t of targets) {
    await load(theme);
    await walkTo(t.i, total);
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.getAttribute) return null;
      const b = el.getBoundingClientRect();
      const pad = 18;
      const x = Math.max(0, Math.floor(b.x - pad));
      const y = Math.max(0, Math.floor(b.y - pad));
      const right = Math.min(window.innerWidth, Math.ceil(b.right + pad));
      const bottom = Math.min(window.innerHeight, Math.ceil(b.bottom + pad));
      if (right - x < 12 || bottom - y < 12) return null;
      return {
        cls: (el.getAttribute("class") ?? "").split(/\s+/)[0],
        id:
          el.getAttribute("data-loc-id") ??
          el.getAttribute("data-zone-id") ??
          el.getAttribute("data-event-id") ??
          null,
        opacity: getComputedStyle(el).opacity,
        filter: getComputedStyle(el).filter,
        clip: { x, y, width: right - x, height: bottom - y },
      };
    });
    if (!active) {
      measured.push({ i: t.i, cls: t.cls, measured: false });
      continue;
    }
    const focused = await page.screenshot({ clip: active.clip });
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(300);
    const unfocused = await page.screenshot({ clip: active.clip });
    const diff = Buffer.compare(unfocused, focused) !== 0;
    fs.writeFileSync(
      `artifacts/audit-A7/c7-theme-${theme}-${t.cls}-${t.i}-focused.png`,
      focused,
    );
    measured.push({
      i: t.i,
      cls: active.cls,
      id: active.id,
      opacity: active.opacity,
      measured: true,
      ringPixelsChanged: diff,
    });
    log(theme, t.cls, t.i, "diff", diff, "opacity", active.opacity);
  }
  result[theme].markers = measured;
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();

/**
 * C7 探測 F：location-marker 焦點環「唔見」係唔係假陰性？
 *   - 檢查 activeElement.matches(':focus-visible')
 *   - 檢查焦點前後 bbox 有冇移動
 *   - 用大 clip（pad 40）再比一次
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-ring3.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const OUT = "artifacts/audit-A7/c7-ring3.json";
const log = (...a) => console.log("[ring3]", ...a);

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

const result = { measuredAt: new Date().toISOString(), baseUrl: BASE, runs: [] };

for (const theme of ["dark", "light"]) {
  for (const idx of [49, 50, 51, 52, 53, 61]) {
    await load(theme);
    const total = await page.evaluate(
      () =>
        document.querySelectorAll(
          "#svg-map .zone, #svg-map .route-line, #svg-map .location-marker, #svg-map .location-marker-cluster, #svg-map .event-marker",
        ).length,
    );
    await walkTo(idx, total);
    const before = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.getAttribute) return null;
      const b = el.getBoundingClientRect();
      return {
        cls: (el.getAttribute("class") ?? "").split(/\s+/)[0],
        id:
          el.getAttribute("data-loc-id") ??
          el.getAttribute("data-zone-id") ??
          el.getAttribute("data-event-id") ??
          null,
        focusVisible: el.matches?.(":focus-visible") ?? null,
        filter: getComputedStyle(el).filter,
        rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      };
    });
    if (!before) {
      result.runs.push({ theme, idx, reached: false });
      continue;
    }
    const pad = 40;
    const clip = {
      x: Math.max(0, Math.round(before.rect.x - pad)),
      y: Math.max(0, Math.round(before.rect.y - pad)),
      width: before.rect.w + pad * 2,
      height: before.rect.h + pad * 2,
    };
    const focused = await page.screenshot({ clip });
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(320);
    const afterBlur = await page.evaluate((bid) => {
      const el = document.querySelector(
        `[data-loc-id="${bid}"],[data-zone-id="${bid}"],[data-event-id="${bid}"]`,
      );
      const b = el?.getBoundingClientRect();
      return b
        ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
        : null;
    }, before.id);
    const unfocused = await page.screenshot({ clip });
    const diff = Buffer.compare(unfocused, focused) !== 0;
    fs.writeFileSync(`artifacts/audit-A7/c7-ring3-${theme}-${idx}-focused.png`, focused);
    result.runs.push({
      theme,
      idx,
      reached: true,
      cls: before.cls,
      id: before.id,
      focusVisible: before.focusVisible,
      filter: before.filter,
      rectBefore: before.rect,
      rectAfterBlur: afterBlur,
      moved: JSON.stringify(before.rect) !== JSON.stringify(afterBlur),
      ringPixelsChanged: diff,
    });
    log(theme, idx, before.cls, "focusVisible", before.focusVisible, "diff", diff, "moved", JSON.stringify(before.rect) !== JSON.stringify(afterBlur));
  }
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();

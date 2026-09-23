/**
 * A3 補充實測 —— state 擁有權 / DOM 散落 state / selection 序列化。
 * 只讀 production app；只寫 artifacts/audit-A3/。
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A3";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: "zh-HK",
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console:" + m.text());
});

const snap = () =>
  page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const pane = q("#story-pane");
    const doc = document.documentElement;
    return {
      hash: window.location.hash,
      theme: doc.getAttribute("data-theme"),
      paneCollapsedClass: pane?.classList.contains("is-collapsed") ?? null,
      dossierHiddenAttr: q("#zone-dossier-mount")?.hidden ?? null,
      panelHiddenAttr: q("#story-panel-mount")?.hidden ?? null,
      basemapLevel: q("#basemap-canvas")?.dataset?.basemapLevel ?? null,
      selectedZoneInDom: document.querySelectorAll(".zone.is-selected").length,
      selectedEventInDom: document.querySelectorAll(".event-marker").length,
      labelLayerOpacity: q("#label-detail-layer")?.getAttribute("opacity") ?? null,
      hasSpoilerControl: !!q(".bg-spoiler-btns, [data-spoiler], #spoiler"),
      hasLayerToggle: !!q("[data-layer-toggle], .layer-toggle, #layer-control"),
      localStorageKeys: Object.keys(localStorage),
    };
  });

await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1800);

const out = { baseUrl: BASE, capturedAt: new Date().toISOString(), steps: [] };
out.steps.push({ step: "initial", state: await snap() });

// 1) 切去章節模式（#btn-mode）
await page.locator("#btn-mode").click({ force: true });
await page.waitForTimeout(600);
out.steps.push({ step: "click #btn-mode", state: await snap() });

// 2) 點地點標記 → 應該寫 loc 落 hash
const marker = page.locator("#locations-layer .location-marker, #locations-layer .location-marker-cluster").first();
if (await marker.count()) {
  await marker.click({ force: true });
  await page.waitForTimeout(700);
  out.steps.push({ step: "click location marker", state: await snap() });
} else {
  out.steps.push({ step: "click location marker", note: "冇 marker（章節過濾後為空）" });
}

// 3) 點區域 → zone 有冇寫入 hash
const zone = page.locator("#zones-layer .zone").first();
if (await zone.count()) {
  await zone.click({ force: true });
  await page.waitForTimeout(700);
  out.steps.push({ step: "click zone", state: await snap() });
}

// 4) refresh → 睇邊啲 state 留低
await page.reload({ waitUntil: "load", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1800);
out.steps.push({ step: "after refresh", state: await snap() });

// 5) 窄螢幕 → panel collapse 係 DOM-only？
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(1800);
out.steps.push({ step: "mobile 390 initial", state: await snap() });

out.pageErrors = errors;
await ctx.close();
await browser.close();

fs.writeFileSync(OUT + "/state-ownership-audit.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

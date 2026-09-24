/**
 * C8 Hostile Product Review — 截圖 + DOM 證據收集腳本
 * 只讀，唔改任何 src/ data/。
 * 用法：node artifacts/audit-C8/capture.mjs
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:5176/";
const OUT = path.resolve("artifacts/audit-C8");
const RICH = "zone_200f5e8911"; // 皇室區（9/9 分節）
const THIN = "zone_8d2b97997f"; // 心朗村（0/9 分節）
const NEST = "zone_d9659abe0c"; // 靈實禮拜堂（0/9 分節）

const report = { console: [], requests: [], shots: [], dom: {} };

async function newPage(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: opts.dpr ?? 1,
    locale: "zh-HK",
    reducedMotion: opts.reducedMotion,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      report.console.push(`${m.type()}: ${m.text()}`.slice(0, 300));
  });
  page.on("pageerror", (e) => report.console.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on("request", (r) => report.requests.push(r.url()));
  return { ctx, page };
}

async function shot(page, name, full = false) {
  const f = path.join(OUT, name);
  await page.screenshot({ path: f, fullPage: full });
  report.shots.push(name);
  return f;
}

const browser = await chromium.launch();

// ── 1. 桌面首屏 1440×900 ────────────────────────────────────────────────
{
  const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot(page, "01-desktop-firstscreen-1440.png");

  // 首屏各區塊佔比 + 有咩喺畫面
  report.dom.firstscreen = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) };
    };
    const vw = innerWidth, vh = innerHeight;
    const area = (x) => (x ? (x.w * x.h) / (vw * vh) : 0);
    const map = r("#map-pane");
    const story = r("#story-pane");
    const strip = r(".chapter-strip");
    const ob = r(".onboarding-card");
    const legend = r("#map-legend");
    const layers = r("#layer-controls");
    return {
      viewport: { vw, vh },
      mapPane: map,
      mapAreaRatio: +area(map).toFixed(3),
      storyPane: story,
      storyAreaRatio: +area(story).toFixed(3),
      chapterStrip: strip,
      onboarding: ob,
      onboardingAreaRatio: +area(ob).toFixed(3),
      legend: legend,
      layerControls: layers,
      onboardingText: document.querySelector(".onboarding-card")?.innerText?.replace(/\s+/g, " ").slice(0, 300) ?? null,
      h1: document.querySelector("h1")?.textContent,
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).map((h) => h.textContent?.trim().slice(0, 40)),
      zoneRendered: document.querySelectorAll("#zones-layer .zone-area, #zones-layer .zone").length,
      locationMarkers: document.querySelectorAll("#locations-layer > *").length,
      eventMarkers: document.querySelectorAll("#events-layer > *").length,
      layerToggleLabels: Array.from(document.querySelectorAll("#layer-controls .layer-toggle")).map((b) => b.textContent),
      legendItems: Array.from(document.querySelectorAll("#map-legend .legend-item")).map((e) => e.innerText.replace(/\s+/g, " ").trim()),
    };
  });
  await ctx.close();
}

// ── 2. Zone dossier：富資料 zone（皇室區）───────────────────────────────
{
  const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
  await page.goto(`${BASE}?zone=${RICH}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await shot(page, "02-desktop-zone-rich-皇室區.png");
  report.dom.zoneRich = await page.evaluate(() => {
    const d = document.querySelector("#zone-dossier-mount");
    return {
      url: location.href,
      hidden: d?.hidden,
      title: d?.querySelector(".zd-name")?.textContent,
      sectionTitles: Array.from(d?.querySelectorAll(".zd-section-title") ?? []).map((e) => e.textContent?.trim()),
      sectionCount: d?.querySelectorAll(".zd-section").length,
      textLen: d?.innerText?.length,
      fullText: d?.innerText?.replace(/\s+/g, " ").slice(0, 2000),
      chips: Array.from(d?.querySelectorAll(".zd-chip") ?? []).slice(0, 12).map((e) => e.textContent),
      metrics: Array.from(d?.querySelectorAll(".zd-metric") ?? []).map((e) => e.innerText.replace(/\s+/g, " ")),
      auditList: Array.from(d?.querySelectorAll(".zd-audit li") ?? []).map((e) => e.innerText.replace(/\s+/g, " ")),
    };
  });
  await ctx.close();
}

// ── 3. Zone dossier：空洞 zone（心朗村 0 分節）─────────────────────────
{
  const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
  await page.goto(`${BASE}?zone=${THIN}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await shot(page, "03-desktop-zone-thin-心朗村.png");
  report.dom.zoneThin = await page.evaluate(() => {
    const d = document.querySelector("#zone-dossier-mount");
    return {
      url: location.href,
      title: d?.querySelector(".zd-name")?.textContent,
      sectionTitles: Array.from(d?.querySelectorAll(".zd-section-title") ?? []).map((e) => e.textContent?.trim()),
      sectionCount: d?.querySelectorAll(".zd-section").length,
      textLen: d?.innerText?.length,
      fullText: d?.innerText?.replace(/\s+/g, " ").slice(0, 2000),
      auditList: Array.from(d?.querySelectorAll(".zd-audit li") ?? []).map((e) => e.innerText.replace(/\s+/g, " ")),
    };
  });
  await ctx.close();
}

// ── 4. Chronic 編年史 ───────────────────────────────────────────────────
{
  const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
  await page.goto(`${BASE}?view=chronicle`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shot(page, "04-desktop-chronicle.png");
  report.dom.chronicle = await page.evaluate(() => {
    const pane = document.querySelector("#story-panel-mount");
    return {
      url: location.href,
      domNodes: document.querySelectorAll("*").length,
      paneNodes: pane?.querySelectorAll("*").length,
      entryCount: pane?.querySelectorAll(".chronicle-entry, .chr-entry, [data-entry-id]").length,
      filterControls: Array.from(pane?.querySelectorAll("button,select,input") ?? []).slice(0, 40).map((e) => (e.textContent || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "").trim().slice(0, 30)),
      textHead: pane?.innerText?.replace(/\s+/g, " ").slice(0, 800),
    };
  });
  await ctx.close();
}

// ── 5. 搜尋 overlay ─────────────────────────────────────────────────────
{
  const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.click("#btn-search");
  await page.waitForTimeout(600);
  await page.keyboard.type("病");
  await page.waitForTimeout(700);
  await shot(page, "05-desktop-search.png");
  report.dom.search = await page.evaluate(() => {
    const s = document.querySelector("#search-shell");
    return {
      open: !!s?.querySelector(".search-overlay"),
      text: s?.innerText?.replace(/\s+/g, " ").slice(0, 600),
      kinds: Array.from(s?.querySelectorAll("[data-kind],.search-kind,.search-tab") ?? []).map((e) => (e.textContent || "").trim().slice(0, 20)),
      resultCount: s?.querySelectorAll(".search-result,[role=option],li").length,
      activeDesc: document.querySelector("[aria-activedescendant]")?.getAttribute("aria-activedescendant"),
    };
  });
  await ctx.close();
}

// ── 6. 手機 390×844 ────────────────────────────────────────────────────
{
  const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot(page, "06-mobile-firstscreen-390.png");
  report.dom.mobile = await page.evaluate(() => {
    const map = document.querySelector("#map-pane")?.getBoundingClientRect();
    const sheet = document.querySelector("#story-pane")?.getBoundingClientRect();
    return {
      vw: innerWidth,
      vh: innerHeight,
      mapRect: map && { w: Math.round(map.width), h: Math.round(map.height), top: Math.round(map.top) },
      sheetRect: sheet && { w: Math.round(sheet.width), h: Math.round(sheet.height), top: Math.round(sheet.top) },
      sheetSnap: document.querySelector("#story-pane")?.getAttribute("data-sheet-snap"),
      scrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      onboardingText: document.querySelector(".onboarding-card")?.innerText?.replace(/\s+/g, " ").slice(0, 200) ?? null,
    };
  });
  // 手機選中 zone
  await page.goto(`${BASE}?zone=${RICH}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await shot(page, "07-mobile-zone-dossier.png");
  await ctx.close();
}

// ── 7. 全頁工程師式文案掃描（所有 zone）─────────────────────────────────
{
  const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const jargon = await page.evaluate(async () => {
    const pat = /(location_precision|coordinate_source|coordinate_review_status|coordinate_confidence|radius_source|zone_type|spatial_precision|review_status|needs_validation|auto_inferred|confidence_inputs|evidence_sources|danger_level|display_style|kind_votes|schema_version|A[0-9]\b|loc_\d+|zone_[0-9a-f]{6,}|dossier_[0-9a-f]{6,}|event_)/;
    const hits = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.children.length === 0) {
          const t = (el.textContent || "").trim();
          if (t && pat.test(t)) hits.push({ tag: el.tagName, cls: el.className?.toString?.().slice(0, 40), text: t.slice(0, 120) });
        }
      }
    };
    walk(document.body);
    return hits.slice(0, 40);
  });
  report.dom.jargonFirstScreen = jargon;
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log("=== SHOTS ===");
console.log(report.shots.join("\n"));
console.log("\n=== CONSOLE (errors/warnings) ===");
console.log([...new Set(report.console)].slice(0, 30).join("\n") || "(none)");
console.log("\n=== JARGON on first screen ===");
console.log(JSON.stringify(report.dom.jargonFirstScreen, null, 1));
await browser.close();

/**
 * C8 追加證據：互動後狀態、chronicle 版面量測、zone 選中回饋、地圖 cluster 密度
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:5176/";
const OUT = path.resolve("artifacts/audit-C8");
const report = {};

const browser = await chromium.launch();

// ── A. 桌面：click 一個 zone（唔用 deep link）→ 有冇回饋？map 有冇 focus/highlight？ ──
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  // 先關 onboarding（唔想遮住）
  const dismissed = await page.evaluate(() => {
    localStorage.setItem("binggang.onboarding.dismissed", "1");
    return true;
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, "08-desktop-nobanner.png") });

  // 量度 chronicle 之前，先量 zone 選中
  const before = await page.evaluate(() => location.href);
  // 揀第一個 zone-area
  const zoneInfo = await page.evaluate(() => {
    const zs = Array.from(document.querySelectorAll("#zones-layer .zone-area, #zones-layer .zone"));
    const first = zs[0];
    const b = first?.getBoundingClientRect();
    return {
      count: zs.length,
      firstTag: first?.tagName,
      firstClass: first?.getAttribute("class"),
      firstLabel: first?.getAttribute("aria-label"),
      firstDataId: first?.getAttribute("data-zone-id"),
      rect: b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    };
  });
  report.zoneEls = zoneInfo;
  // 用 data-zone-id 揀一個，然後用 JS click（rect 可能 0 大細）
  const clicked = await page.evaluate(() => {
    const zs = Array.from(document.querySelectorAll("#zones-layer .zone-area, #zones-layer .zone"));
    const target = zs.find((z) => {
      const b = z.getBoundingClientRect();
      return b.width > 3 && b.height > 3;
    });
    if (!target) return null;
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { id: target.getAttribute("data-zone-id"), label: target.getAttribute("aria-label") };
  });
  await page.waitForTimeout(700);
  report.zoneClick = {
    clicked,
    urlAfter: await page.evaluate(() => location.href),
    dossierHidden: await page.evaluate(() => document.querySelector("#zone-dossier-mount")?.hidden),
    dossierTitle: await page.evaluate(() => document.querySelector("#zone-dossier-mount .zd-name")?.textContent),
    selectedHighlighted: await page.evaluate(() => {
      const el = document.querySelector("#zones-layer .zone-area.is-selected, #zones-layer .zone.is-selected, #zones-layer .selected");
      return { found: !!el, cls: el?.getAttribute("class") };
    }),
    // map 有冇移動？比較 viewBox 前後
  };
  await page.screenshot({ path: path.join(OUT, "09-desktop-zone-clicked.png") });
  await ctx.close();
}

// ── B. 桌面：zoom 入 TKO 睇 48 zone cluster 密度 ──
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  // 點 zoom-in 掣 5 次（聚焦地圖中心）
  const vb = [];
  for (let i = 0; i < 6; i++) {
    await page.click("#map-zoom-in").catch(() => {});
    await page.waitForTimeout(250);
    vb.push(await page.evaluate(() => document.querySelector("#svg-map")?.getAttribute("viewBox")));
  }
  report.zoomViewBoxes = vb;
  await page.screenshot({ path: path.join(OUT, "10-desktop-zoomed.png") });
  report.zoomedDensity = await page.evaluate(() => ({
    zoneEls: document.querySelectorAll("#zones-layer > *").length,
    clusters: document.querySelectorAll("#zones-layer .zone-cluster").length,
    locs: document.querySelectorAll("#locations-layer > *").length,
    events: document.querySelectorAll("#events-layer > *").length,
  }));
  await ctx.close();
}

// ── C. chronicle 版面量測（係唔係被塞入 380px 側欄）──
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?view=chronicle`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  report.chronicleLayout = await page.evaluate(() => {
    const pane = document.querySelector("#story-pane");
    const pb = pane?.getBoundingClientRect();
    const inner = document.querySelector("#story-panel-mount");
    const ib = inner?.getBoundingClientRect();
    const entry = document.querySelector("#story-panel-mount .chronicle-entry, #story-panel-mount [data-entry-id], #story-panel-mount li");
    const eb = entry?.getBoundingClientRect();
    return {
      storyPaneW: pb && Math.round(pb.width),
      innerW: ib && Math.round(ib.width),
      innerScrollW: inner?.scrollWidth,
      innerClientW: inner?.clientWidth,
      horizontalScroll: (inner?.scrollWidth ?? 0) > (inner?.clientWidth ?? 0),
      firstEntryW: eb && Math.round(eb.width),
      entryTextWrapped: entry?.innerText?.replace(/\s+/g, " ").slice(0, 120),
      overflowX: getComputedStyle(inner ?? document.body).overflowX,
    };
  });
  await page.screenshot({ path: path.join(OUT, "11-desktop-chronicle-nobanner.png") });
  await ctx.close();
}

// ── D. 手機：tap zone → dossier 有冇出現？sheet snap？──
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-HK", hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const tap = await page.evaluate(() => {
    const zs = Array.from(document.querySelectorAll("#zones-layer .zone-area, #zones-layer .zone"));
    const t = zs.find((z) => {
      const b = z.getBoundingClientRect();
      return b.width > 3 && b.height > 3;
    });
    if (!t) return null;
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return t.getAttribute("data-zone-id");
  });
  await page.waitForTimeout(800);
  report.mobileZoneTap = {
    tapped: tap,
    url: await page.evaluate(() => location.href),
    sheetSnap: await page.evaluate(() => document.querySelector("#story-pane")?.getAttribute("data-sheet-snap")),
    sheetClass: await page.evaluate(() => document.querySelector("#story-pane")?.className),
    dossierHidden: await page.evaluate(() => document.querySelector("#zone-dossier-mount")?.hidden),
    dossierVisibleHeight: await page.evaluate(() => {
      const d = document.querySelector("#zone-dossier-mount");
      const b = d?.getBoundingClientRect();
      return b && { top: Math.round(b.top), h: Math.round(b.height), bottom: Math.round(b.bottom), vh: innerHeight };
    }),
  };
  await page.screenshot({ path: path.join(OUT, "12-mobile-zone-tapped.png") });
  await ctx.close();
}

// ── E. 掃描全 48 個 zone 嘅 dossier 實際字數（有幾空洞）──
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const zones = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#zones-layer .zone-area, #zones-layer .zone")).map((z) => ({
      id: z.getAttribute("data-zone-id"),
      label: z.getAttribute("aria-label"),
    })).filter((z) => z.id),
  );
  const uniq = [...new Map(zones.map((z) => [z.id, z])).values()];
  const rows = [];
  for (const z of uniq) {
    await page.goto(`${BASE}?zone=${z.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(220);
    const m = await page.evaluate(() => {
      const d = document.querySelector("#zone-dossier-mount");
      const sections = Array.from(d?.querySelectorAll(".zd-section-title") ?? []).map((e) => e.textContent?.trim());
      const contentSections = sections.filter((s) => !s.includes("資料來源") && !s.includes("出現章節"));
      return {
        name: d?.querySelector(".zd-name")?.textContent ?? null,
        kindLabel: d?.querySelector(".zd-kind-label")?.textContent ?? null,
        kindSub: d?.querySelector(".zd-kind-sub")?.textContent ?? null,
        contentSections: contentSections.length,
        contentTitles: contentSections,
        textLen: d?.innerText?.length ?? 0,
        hasSummary: !!d?.querySelector(".zd-summary"),
      };
    });
    rows.push({ id: z.id, ...m });
  }
  report.allZoneDossiers = rows;
  fs.writeFileSync(path.join(OUT, "all-zone-dossiers.json"), JSON.stringify(rows, null, 2));
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, "evidence2.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, allZoneDossiers: undefined }, null, 2).slice(0, 6000));
await browser.close();

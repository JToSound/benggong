/**
 * A9 QA Adversary —— 證據擷取（DOM node 統計 + screenshots，只讀）
 * 執行：node artifacts/audit-A9/a9-evidence.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:5180/";
const OUT = "artifacts/audit-A9";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const out = { base: BASE, capturedAt: new Date().toISOString() };

async function pageWith(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-HK",
    serviceWorkers: "block",
    ...opts,
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

// 1) 預設載入：DOM node 統計（證明 chronicle 冇 virtualization）
{
  const { ctx, page } = await pageWith();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 });
  await page.waitForTimeout(1800);
  out.defaultLoad = await page.evaluate(() => {
    const count = (sel) => document.querySelectorAll(sel).length;
    const subtree = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getElementsByTagName("*").length : 0;
    };
    return {
      totalNodes: document.getElementsByTagName("*").length,
      chronicleMountNodes: subtree("#story-panel-mount"),
      chronicleEntries: count("#story-panel-mount .chr-entry"),
      chronicleEntryNodes: subtree("#story-panel-mount .chronicle-body"),
      chapterPills: count("#chapter-strip-mount .ch-pill"),
      mapSvgNodes: subtree("#svg-map-mount svg"),
      bodyTextLen: (document.body.innerText || "").length,
    };
  });
  await page.screenshot({ path: path.join(OUT, "a9-evidence-default-chronicle.png") });
  await ctx.close();
  console.log("[defaultLoad]", JSON.stringify(out.defaultLoad));
}

// 2) Bug：zone dossier 開住時點 event marker（畫面無反應）
{
  const { ctx, page } = await pageWith();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector("#svg-map-mount .zone")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, "a9-bug-zone-then-event-1-zone.png") });
  const before = await page.evaluate(() => ({
    mode: document.querySelector("#btn-mode")?.textContent?.trim(),
    dossierVisible: (() => { const d = document.querySelector("#zone-dossier-mount"); const r = d.getBoundingClientRect(); return !d.hidden && r.width > 0; })(),
  }));
  await page.evaluate(() => document.querySelector("#svg-map-mount .event-marker")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, "a9-bug-zone-then-event-2-event.png") });
  const after = await page.evaluate(() => ({
    mode: document.querySelector("#btn-mode")?.textContent?.trim(),
    storyPanelHidden: document.querySelector("#story-panel-mount")?.hidden,
    storyPanelVisible: (() => { const p = document.querySelector("#story-panel-mount"); const r = p.getBoundingClientRect(); return !p.hidden && r.width > 0; })(),
    eventMetaInDom: document.querySelector("#story-panel-mount .event-meta")?.textContent?.trim() ?? null,
  }));
  out.zoneThenEvent = { before, after, visibleChange: JSON.stringify(before) !== JSON.stringify(after) };
  await ctx.close();
  console.log("[zoneThenEvent]", JSON.stringify(out.zoneThenEvent));
}

// 3) `?chapter=150` 被忽略 對比 `#ch=150` 生效
{
  const { ctx, page } = await pageWith();
  await page.goto(BASE + "?chapter=150", { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "a9-evidence-chapter-query-ignored.png") });
  out.chapterQueryIgnored = await page.evaluate(() => ({
    url: location.href,
    activeCh: document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch ?? null,
    chronicleCount: document.querySelector("#story-panel-mount .chronicle-count")?.textContent?.trim() ?? null,
  }));
  await ctx.close();
  console.log("[chapterQueryIgnored]", JSON.stringify(out.chapterQueryIgnored));
}

// 4) 390 寬 mobile（預設）
{
  const { ctx, page } = await pageWith({ viewport: { width: 390, height: 844 } });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "a9-evidence-mobile-390.png") });
  out.mobile390 = await page.evaluate(() => {
    const title = document.querySelector(".brand h1");
    const r = title.getBoundingClientRect();
    return {
      titleH: Math.round(r.height),
      titleW: Math.round(r.width),
      navBtnCount: document.querySelectorAll("#topbar .nav-btn").length,
      navRowH: Math.round(document.querySelector("#topbar nav")?.getBoundingClientRect().height ?? 0),
      horizOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      hasBottomSheet: !!document.querySelector("[class*=sheet], [class*=bottom]"),
    };
  });
  await ctx.close();
  console.log("[mobile390]", JSON.stringify(out.mobile390));
}

await browser.close();
fs.writeFileSync(path.join(OUT, "a9-evidence.json"), JSON.stringify(out, null, 2));
console.log("寫入", path.join(OUT, "a9-evidence.json"));

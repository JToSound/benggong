/**
 * A7 Tab 順序決證：由全新載入開始逐次 Tab，記錄 activeElement，
 * 並量度「要 Tab 幾多次才離開章節條 / 到達導覽 / 到達地圖 / 到達面板」。
 *
 * 執行：node artifacts/audit-A7/a7-taborder.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const out = {};

async function run(width, height, hasTouch, maxTabs) {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch, isMobile: hasTouch,
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1500);

  const totalFocusable = await page.evaluate(() =>
    document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])').length);

  const first = [];
  const counts = { chPill: 0, navBtn: 0, mapCtrl: 0, other: 0 };
  let firstNonChPill = null, firstNav = null, firstMapCtrl = null, firstPanelContent = null;
  const order = [];
  for (let i = 1; i <= maxTabs; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return null;
      const cls = typeof a.className === "string" ? a.className : "";
      const r = a.getBoundingClientRect();
      const region = a.closest("#topbar") ? "topbar"
        : a.closest("#chapter-strip-mount") ? "chapterStrip"
        : a.closest(".map-controls") ? "mapControls"
        : a.closest("#map-overlay") ? "mapLegend"
        : a.closest("#story-pane") ? "storyPane"
        : a.closest("#map-pane") ? "mapPane" : "other";
      return { tag: a.tagName.toLowerCase(), id: a.id || null, cls: cls.slice(0, 40),
        text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24),
        region, w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        offscreen: r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight };
    });
    order.push({ n: i, ...info });
    if (info.cls.includes("ch-pill")) counts.chPill++;
    else if (info.cls.includes("nav-btn")) counts.navBtn++;
    else if (info.cls.includes("map-ctrl")) counts.mapCtrl++;
    else counts.other++;
    if (!firstNonChPill && !info.cls.includes("ch-pill")) firstNonChPill = { n: i, ...info };
    if (!firstNav && info.region === "topbar") firstNav = { n: i, ...info };
    if (!firstMapCtrl && info.region === "mapControls") firstMapCtrl = { n: i, ...info };
    if (!firstPanelContent && info.region === "storyPane") firstPanelContent = { n: i, ...info };
    if (i <= 14) first.push({ n: i, tag: info.tag, id: info.id, cls: info.cls, region: info.region, text: info.text });
  }
  await context.close();
  return { totalFocusable, counts, firstNonChPill, firstNav, firstMapCtrl, firstPanelContent, first14: first, order };
}

out.mobile = await run(390, 844, true, 260);
out.desktop = await run(1440, 900, false, 260);

// 精簡輸出
const brief = {
  mobile: {
    totalFocusable: out.mobile.totalFocusable,
    counts: out.mobile.counts,
    firstNonChPill: out.mobile.firstNonChPill,
    firstNav: out.mobile.firstNav,
    firstMapCtrl: out.mobile.firstMapCtrl,
    firstPanelContent: out.mobile.firstPanelContent,
    first14: out.mobile.first14,
  },
  desktop: {
    totalFocusable: out.desktop.totalFocusable,
    counts: out.desktop.counts,
    firstNonChPill: out.desktop.firstNonChPill,
    firstNav: out.desktop.firstNav,
    firstMapCtrl: out.desktop.firstMapCtrl,
    firstPanelContent: out.desktop.firstPanelContent,
    first14: out.desktop.first14,
  },
};
fs.writeFileSync(path.join(OUT, "a7-taborder.json"), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(OUT, "a7-taborder-brief.json"), JSON.stringify(brief, null, 2));
console.log(JSON.stringify(brief, null, 2));
await browser.close();

/**
 * A1 第三輪：狀態同步（shared mount）、router query params 正確測試、
 * entry point 可發現性（accessible name / aria）。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A1";
const SHOTS = path.join(OUT, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
const out = { baseUrl: BASE, capturedAt: new Date().toISOString() };

async function ready(page) {
  await page.waitForSelector("#topbar", { timeout: 40000 });
  await page.waitForTimeout(1000);
}
async function fresh(page, suffix = "") {
  await page.goto(`${BASE}?t=${Date.now()}${suffix}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await ready(page);
}

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

// ===== 1. Shared mount 狀態同步：chronicle 模式點 event marker =====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);
  out.beforeEventClick = await page.evaluate(() => ({
    mode: document.querySelector("#btn-mode")?.textContent?.trim(),
    panelTitle: document.querySelector("#story-panel-mount h2")?.textContent?.trim(),
    chroniclePresent: !!document.querySelector("#story-panel-mount .chronicle"),
    chrEntries: document.querySelectorAll("#story-panel-mount .chr-entry").length,
  }));
  // 點一個 event marker
  const ev = page.locator("#events-layer .event-marker").first();
  await ev.click({ force: true }).catch((e) => (out.evClickError = String(e)));
  await page.waitForTimeout(700);
  out.afterEventClick = await page.evaluate(() => ({
    mode: document.querySelector("#btn-mode")?.textContent?.trim(),
    panelTitle: document.querySelector("#story-panel-mount h2")?.textContent?.trim(),
    chroniclePresent: !!document.querySelector("#story-panel-mount .chronicle"),
    chrEntries: document.querySelectorAll("#story-panel-mount .chr-entry").length,
    storyHeaderPresent: !!document.querySelector("#story-panel-mount .story-header"),
    hash: location.hash,
  }));
  await page.screenshot({ path: path.join(SHOTS, "a1-desktop-event-click-in-chronicle-mode.png") });
  await ctx.close();
}

// ===== 2. Router query params（正確格式）=====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  const cases = [
    { q: "?event=ev_0001", label: "?event=" },
    { q: "?zone=zone_d3f76d3c94", label: "?zone=" },
    { q: "?character=xxx", label: "?character=" },
    { q: "?chapter=50", label: "?chapter=" },
    { q: "?spoiler=0", label: "?spoiler=" },
    { q: "?layers=zones,events", label: "?layers=" },
    { q: "?view=chronicle", label: "?view=" },
    { q: "?location=loc_0001", label: "?location=" },
  ];
  out.routerQuery = [];
  for (const c of cases) {
    await fresh(page, "&" + c.q.slice(1));
    const st = await page.evaluate(() => ({
      chapter: document.querySelector("#strip-ch-num")?.textContent,
      mode: document.querySelector("#btn-mode")?.textContent?.trim(),
      dossier: !!document.querySelector("#zone-dossier-mount")?.innerText,
      chrEntries: document.querySelectorAll("#story-panel-mount .chr-entry").length,
      error: /載入失敗/.test(document.body.innerText),
    }));
    out.routerQuery.push({ label: c.label, result: st });
  }
  await ctx.close();
}

// ===== 3. Entry point 可發現性 =====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);
  out.a11y = await page.evaluate(() => {
    const qa = (s) => [...document.querySelectorAll(s)];
    return {
      navButtons: qa("#topbar .nav-btn").map((b) => ({
        id: b.id,
        visible: b.getBoundingClientRect().width > 0,
        text: (b.textContent || "").trim(),
        title: b.getAttribute("title"),
        ariaLabel: b.getAttribute("aria-label"),
        // 可存取名稱：text + title fallback
        accessibleName: (b.textContent || "").trim() || b.getAttribute("title") || b.getAttribute("aria-label"),
        hasOnlyEmoji: !/[\u4e00-\u9fffA-Za-z0-9]/.test((b.textContent || "").trim()),
      })),
      skipLink: !!document.querySelector(".skip-link"),
      mapRole: document.querySelector("#app-root")?.getAttribute("role"),
      mapAriaLabel: document.querySelector("#app-root")?.getAttribute("aria-label"),
      mapPaneAriaLabel: document.querySelector("#map-pane")?.getAttribute("aria-label"),
      svgAriaLabel: document.querySelector("#svg-map")?.getAttribute("aria-label"),
      svgRole: document.querySelector("#svg-map")?.getAttribute("role"),
      svgHasTitle: !!document.querySelector("#svg-map title"),
      zonesLayerAria: document.querySelector("#zones-layer")?.getAttribute("aria-label"),
      // heading 結構
      headings: qa("h1,h2,h3,h4").slice(0, 20).map((h) => `${h.tagName}:${(h.textContent || "").trim().slice(0, 30)}`),
    };
  });
  await ctx.close();
}

// ===== 4. 首屏 3 秒：可以做咩（主 context 判斷）=====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("#topbar", { timeout: 40000 });
  out.timeToTopbarMs = Date.now() - t0;
  await page.waitForTimeout(1000);
  out.firstScreen = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      // 首屏各區域佔比
      mapArea: (() => {
        const r = q("#map-pane")?.getBoundingClientRect();
        return r ? Math.round((r.width * r.height) / (window.innerWidth * window.innerHeight) * 100) : null;
      })(),
      panelArea: (() => {
        const r = q("#story-pane")?.getBoundingClientRect();
        return r ? Math.round((r.width * r.height) / (window.innerWidth * window.innerHeight) * 100) : null;
      })(),
      legendAreaOfMap: (() => {
        const l = q("#map-legend")?.getBoundingClientRect();
        const m = q("#map-pane")?.getBoundingClientRect();
        return l && m ? Math.round((l.width * l.height) / (m.width * m.height) * 100) : null;
      })(),
      firstVisibleHeading: q("#story-panel-mount h2")?.textContent?.trim(),
      mapHasAnyWorldTerritory: document.querySelectorAll("#zones-layer .zone").length,
      mapTextContent: (q("#map-pane")?.innerText || "").trim(),
      // 有冇「呢個係咩網站」嘅說明
      purposeStatement: (q("#topbar")?.innerText || "").trim(),
    };
  });
  await page.screenshot({ path: path.join(SHOTS, "a1-desktop-first-screen-3s.png") });
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, "ux-audit3-results.json"), JSON.stringify(out, null, 2));
await browser.close();
console.log(JSON.stringify(out, null, 2));

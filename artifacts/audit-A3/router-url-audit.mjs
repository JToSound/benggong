/**
 * A3 Front-end Architect —— Router / URL contract 只讀實測腳本。
 *
 * 目的：以 Playwright 實測 spec §5.1 要求嘅 URL 參數支援程度，
 *       以及 deep link、refresh、無效 ID 嘅行為。
 *
 * 只讀 production app；只寫 artifacts/audit-A3/。
 *
 * 執行：node artifacts/audit-A3/router-url-audit.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A3";
fs.mkdirSync(OUT, { recursive: true });

const results = [];

async function openPage(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
  });
  const consoleLines = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("console", (m) => consoleLines.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1800);
  return { context, page, consoleLines, pageErrors };
}

/** 讀取 app 目前狀態（由 DOM 反推，因為 App 唔喺 window 上）。 */
async function readState(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const num = q("#strip-ch-num")?.textContent?.trim() ?? null;
    const activePill = q(".ch-pill.active")?.getAttribute("data-ch") ?? null;
    const storyTitle = q(".story-title")?.textContent?.trim() ?? null;
    const dossierVisible = q("#zone-dossier-mount") && !q("#zone-dossier-mount").hidden;
    const panelVisible = q("#story-panel-mount") && !q("#story-panel-mount").hidden;
    const modeBtn = q("#btn-mode")?.textContent?.trim() ?? null;
    const zoneSelected = document.querySelectorAll("#zones-layer .zone.is-selected").length;
    const eventSelected = document.querySelectorAll("#events-layer .event-marker").length;
    return {
      hash: window.location.hash,
      search: window.location.search,
      href: window.location.href,
      stripNum: num,
      activePill,
      storyTitle,
      dossierVisible,
      panelVisible,
      modeBtn,
      zoneSelected,
      eventMarkerCount: eventSelected,
      hasMap: !!q("#svg-map"),
      hasCanvas: !!q("#basemap-canvas"),
    };
  });
}

async function record(browser, name, url, opts = {}) {
  const { click = null, afterMs = 400, screenshot = false } = opts;
  const rec = { name, url, steps: [] };
  let ctx;
  try {
    const { context, page, consoleLines, pageErrors } = await openPage(browser, url);
    ctx = context;
    rec.initialState = await readState(page);
    rec.initialConsoleErrors = consoleLines.filter(
      (l) => l.type === "error" || l.type === "warning",
    );
    rec.initialPageErrors = pageErrors.slice();

    if (click) {
      for (const sel of click) {
        const loc = page.locator(sel).first();
        const cnt = await loc.count();
        if (!cnt) {
          rec.steps.push({ selector: sel, found: false });
          continue;
        }
        await loc.click({ force: true }).catch((e) => {
          rec.steps.push({ selector: sel, clickError: String(e) });
        });
        await page.waitForTimeout(afterMs);
        rec.steps.push({ selector: sel, found: true, state: await readState(page) });
      }
    }

    // refresh 測試
    if (opts.refresh) {
      await page.reload({ waitUntil: "load", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1800);
      rec.afterRefresh = await readState(page);
      rec.afterRefreshConsoleErrors = consoleLines.filter((l) => l.type === "error");
      rec.afterRefreshPageErrors = pageErrors.slice();
    }

    if (screenshot) {
      const f = path.join(OUT, `router-${name}.png`);
      await page.screenshot({ path: f, fullPage: false });
      rec.screenshot = f;
    }
  } catch (e) {
    rec.error = String(e);
  } finally {
    if (ctx) await ctx.close();
  }
  results.push(rec);
  return rec;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

  // 1) Spec §5.1 URL 參數支援度（每個都試）
  const specParams = [
    { name: "spec-hash-location", url: BASE + "#location=loc_0545" },
    { name: "spec-query-event", url: BASE + "?event=bg_event_001" },
    { name: "spec-query-zone", url: BASE + "?zone=zone_51bf7d8190" },
    { name: "spec-query-character", url: BASE + "?character=陳小明" },
    { name: "spec-query-chapter", url: BASE + "?chapter=150" },
    { name: "spec-query-spoiler", url: BASE + "?spoiler=3" },
    { name: "spec-query-layers", url: BASE + "?layers=zones,events,routes" },
    { name: "spec-query-view", url: BASE + "?view=chronicle" },
  ];
  for (const p of specParams) await record(browser, p.name, p.url);

  // 2) 現行支援嘅 hash deep link
  await record(browser, "current-hash-ch", BASE + "#ch=150");
  await record(browser, "current-hash-ch-loc", BASE + "#ch=150&loc=loc_0545", {
    refresh: true,
  });

  // 3) 無效 ID / 邊界
  await record(browser, "invalid-ch-out-of-range", BASE + "#ch=9999");
  await record(browser, "invalid-ch-nonnum", BASE + "#ch=abc");
  await record(browser, "invalid-ch-zero", BASE + "#ch=0");
  await record(browser, "invalid-loc-nonexistent", BASE + "#ch=10&loc=loc_ZZZZ");
  await record(browser, "invalid-loc-empty", BASE + "#ch=10&loc=");

  // 4) 互動後 URL 是否更新（selection 是否序列化）
  await record(browser, "click-event-then-url", BASE, {
    click: ["#story-panel-mount .event-item", "#map-zoom-in"],
    refresh: true,
  });
  await record(browser, "click-zone-then-url", BASE, {
    click: ["#zones-layer .zone"],
    refresh: true,
  });
  await record(browser, "search-event-then-url", BASE, {
    click: ["#btn-search", "#search-input"],
    afterMs: 500,
  });

  await browser.close();

  const summary = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    resultCount: results.length,
    results,
  };
  fs.writeFileSync(path.join(OUT, "router-url-audit.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("router audit 失敗:", e);
  process.exit(1);
});

/**
 * A1 第二輪實測：修正第一輪嘅量測缺陷（hash-only goto 冇 reload、journeyE
 * 受前一狀態污染），並針對 zone 點擊、資訊密度、document 高度做精確量測。
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

async function fresh(page, hash = "") {
  const url = hash ? `${BASE}?t=${Date.now()}${hash}` : `${BASE}?t=${Date.now()}`;
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await ready(page);
}

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

// ===== 1. Zone 點擊：badge vs polygon =====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);

  // 用 elementFromPoint 檢查 zone 中心究竟命中邊個元素
  out.zoneHitTest = await page.evaluate(() => {
    const area = document.querySelector("#zones-layer .zone .zone-area");
    if (!area) return { error: "no zone-area" };
    const b = area.getBoundingClientRect();
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const glow = document.querySelector("#zones-layer .zone .zone-glow");
    const badge = document.querySelector("#zones-layer .zone .zone-badge circle");
    const br = badge?.getBoundingClientRect();
    const gr = glow?.getBoundingClientRect();
    const at = (x, y) => {
      const e = document.elementFromPoint(x, y);
      return e ? `${e.tagName}.${e.getAttribute("class") || e.id || ""}` : null;
    };
    return {
      areaCenter: { x: Math.round(cx), y: Math.round(cy), hit: hit ? `${hit.tagName}.${hit.getAttribute("class") || hit.id}` : null },
      areaComputedPointerEvents: getComputedStyle(area).pointerEvents,
      glowComputedPointerEvents: glow ? getComputedStyle(glow).pointerEvents : null,
      badgeRect: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
      badgeCenterHit: br ? at(br.left + br.width / 2, br.top + br.height / 2) : null,
      glowRect: gr ? { w: Math.round(gr.width), h: Math.round(gr.height) } : null,
    };
  });

  // 點 badge（正確目標）
  const badge = page.locator("#zones-layer .zone .zone-badge").first();
  if (await badge.count()) {
    await badge.click({ force: true }).catch((e) => (out.zoneBadgeClickError = String(e)));
    await page.waitForTimeout(700);
    out.afterBadgeClick = await page.evaluate(() => ({
      viewModeBtnText: document.querySelector("#btn-mode")?.textContent?.trim(),
      dossierTextLen: (document.querySelector("#zone-dossier-mount")?.innerText || "").length,
      dossierTitle: document.querySelector("#zone-dossier-mount h2")?.textContent?.trim() ?? null,
      hash: location.hash,
      storyPanelHidden: document.querySelector("#story-panel-mount")?.hidden ?? null,
      dossierSections: [...document.querySelectorAll("#zone-dossier-mount .zd-section-title")].map((e) => e.textContent.trim()),
      dossierHasEvidence: !!document.querySelector("#zone-dossier-mount .zd-evidence"),
    }));
    await page.screenshot({ path: path.join(SHOTS, "a1-desktop-zone-dossier-via-badge.png") });
  }

  // 點 polygon 內部（一般用戶會點嘅位置）
  const area = page.locator("#zones-layer .zone .zone-area").first();
  await area.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  out.afterPolygonClick = await page.evaluate(() => ({
    viewModeBtnText: document.querySelector("#btn-mode")?.textContent?.trim(),
    dossierTitle: document.querySelector("#zone-dossier-mount h2")?.textContent?.trim() ?? null,
  }));

  await ctx.close();
}

// ===== 2. 資訊密度 / document 高度 =====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);
  out.density = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const pane = q("#story-pane");
    const mount = q("#story-panel-mount");
    const cs = pane ? getComputedStyle(pane) : null;
    return {
      documentScrollHeight: document.documentElement.scrollHeight,
      documentClientHeight: document.documentElement.clientHeight,
      viewportHeightsOfDoc: Math.round(document.documentElement.scrollHeight / window.innerHeight * 10) / 10,
      storyPaneOverflowY: cs?.overflowY,
      storyPaneClientH: pane?.clientHeight,
      storyPaneScrollH: pane?.scrollHeight,
      storyPaneScrollable: pane ? pane.scrollHeight > pane.clientHeight + 5 : null,
      mountClientH: mount?.clientHeight,
      mountScrollH: mount?.scrollHeight,
      chronicleEntries: document.querySelectorAll("#story-panel-mount .chr-entry").length,
      chronicleChars: (mount?.innerText || "").length,
      mapPaneChars: (q("#map-pane")?.innerText || "").length,
      bodyChars: (document.body.innerText || "").length,
      // 有冇任何 onboarding / empty-context / 4 入口
      onboardingMatches: (document.body.innerText.match(/歡迎|第一次|開始探索|導覽|教學|探索地區|搵角色|搵事件|打開編年史/g) || []),
      // 地圖上第一眼見到嘅標記數
      eventMarkers: document.querySelectorAll("#events-layer .event-marker").length,
      locMarkers: document.querySelectorAll("#locations-layer .location-marker, #locations-layer .location-marker-cluster").length,
      zones: document.querySelectorAll("#zones-layer .zone").length,
      routes: document.querySelectorAll("#routes-layer .route-line").length,
    };
  });
  await ctx.close();
}

// ===== 3. Journey E：乾淨量測 =====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);
  out.journeyE = await page.evaluate(() => {
    const root = document.querySelector("#story-panel-mount");
    const qa = (s) => [...(root?.querySelectorAll(s) || [])];
    return {
      entriesRendered: qa(".chr-entry").length,
      periods: qa(".chr-period").map((p) => p.getAttribute("data-period")),
      periodCounts: qa(".chr-period").map((p) => ({
        period: p.getAttribute("data-period"),
        n: p.querySelector(".chr-period-count")?.textContent,
      })),
      timelineBars: qa(".chr-tl-bar").length,
      hasVirtualization: qa(".chr-entry").length < 1320,
      filterControls: {
        period: !!root?.querySelector("[data-filter-period]"),
        zone: !!root?.querySelector("[data-filter-zone]"),
        character: !!root?.querySelector("[data-filter-char]"),
        type: !!root?.querySelector("[data-filter-type]"),
        spoiler: !!root?.querySelector("[data-filter-spoiler]"),
        search: !!root?.querySelector("input[type=search], input[type=text]"),
      },
      actionButtons: qa(".chr-actions button").map((b) => b.textContent?.trim()),
      expansionMode: qa(".chr-entry.is-open").length,
      // progressive disclosure：預設展開幾多內容
      collapsedEntries: qa(".chr-entry:not(.is-open)").length,
      entrySummaryVisible: qa(".chr-entry .chr-entry-summary").length,
    };
  });
  // 匯出 JSON 內容檢查（唔會真下載，只檢查有冇按鈕）
  out.journeyE.exportButtonPresent = await page.locator("#chr-export-json").count();
  await ctx.close();
}

// ===== 4. Router（強制 reload）=====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  const cases = [
    { h: "#ch=1&loc=loc_0001", label: "loc" },
    { h: "#ch=1&zone=zone_d3f76d3c94", label: "zone" },
    { h: "?event=ev_0001", label: "event" },
    { h: "?character=xxx", label: "character" },
    { h: "?spoiler=0", label: "spoiler" },
    { h: "?layers=zones,events", label: "layers" },
    { h: "?view=map", label: "view" },
    { h: "#ch=999", label: "invalid-chapter" },
    { h: "#ch=1&loc=NOPE", label: "invalid-loc" },
  ];
  out.router = [];
  for (const c of cases) {
    await fresh(page, c.h);
    const st = await page.evaluate(() => ({
      hash: location.hash,
      search: location.search,
      chapter: document.querySelector("#strip-ch-num")?.textContent,
      zoneDossier: !!document.querySelector("#zone-dossier-mount")?.innerText,
      viewMode: document.querySelector("#btn-mode")?.textContent?.trim(),
      bodyHasError: /載入失敗|初始化失敗/.test(document.body.innerText),
    }));
    out.router.push({ label: c.label, input: c.h, result: st });
  }
  await ctx.close();
}

// ===== 5. 角色 journey C：兩次互動內開 dossier？ =====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);
  // 互動 1：開搜尋
  await page.click("#btn-search");
  await page.waitForTimeout(250);
  // 互動 2：輸入並揀第一個角色結果
  await page.fill("#search-input", "A隊");
  await page.waitForTimeout(400);
  const pick = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#search-results .search-result-item")];
    const idx = items.findIndex((i) => i.querySelector(".result-type")?.textContent === "角色");
    return { idx, count: items.length };
  });
  out.journeyC = { pick };
  if (pick.idx >= 0) {
    await page.locator("#search-results .search-result-item").nth(pick.idx).click();
    await page.waitForTimeout(900);
    out.journeyC.afterTwoInteractions = await page.evaluate(() => ({
      hash: location.hash,
      chapter: document.querySelector("#strip-ch-num")?.textContent,
      viewMode: document.querySelector("#btn-mode")?.textContent?.trim(),
      panelText: (document.querySelector("#story-panel-mount")?.innerText || "").slice(0, 200),
      hasCharDossier: /角色檔案|角色資料/.test(document.body.innerText),
      routeLines: document.querySelectorAll("#routes-layer .route-line").length,
      routesLayerChildren: document.querySelector("#routes-layer")?.children.length,
    }));
  }
  await page.screenshot({ path: path.join(SHOTS, "a1-desktop-char-two-interactions.png") });

  // 檢查 route 突出邏輯：chapter 模式有 route list，點落去會點？
  await page.evaluate(() => document.querySelector("#btn-mode")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(400);
  const routeItem = page.locator("#story-panel-mount .route-item").first();
  out.journeyC.routeItemCount = await page.locator("#story-panel-mount .route-item").count();
  if (await routeItem.count()) {
    await routeItem.click();
    await page.waitForTimeout(800);
    out.journeyC.afterRouteClick = await page.evaluate(() => ({
      hash: location.hash,
      chapter: document.querySelector("#strip-ch-num")?.textContent,
      routeLines: document.querySelectorAll("#routes-layer .route-line").length,
      onlyRelevantEmphasis: null,
    }));
  }
  await ctx.close();
}

// ===== 6. Journey D：quarantined / precision 顯示 =====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);
  out.journeyD = await page.evaluate(async () => {
    const r = await fetch("./data/public/locations.geojson");
    const d = await r.json();
    const prec = {};
    let quarantined = 0;
    let unknown = 0;
    for (const f of d.features) {
      prec[f.properties.location_precision] = (prec[f.properties.location_precision] || 0) + 1;
      if (f.properties.review_status === "quarantined") quarantined++;
      if (f.properties.location_precision === "unknown") unknown++;
    }
    const rv = {};
    for (const f of d.features) rv[f.properties.review_status] = (rv[f.properties.review_status] || 0) + 1;
    return { precisionDist: prec, reviewStatusDist: rv, quarantined, unknown };
  });
  // 搜尋一個「事件」結果 → 睇 detail 有咩
  await page.click("#btn-search");
  await page.waitForTimeout(200);
  await page.fill("#search-input", "爆發");
  await page.waitForTimeout(400);
  const evIdx = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#search-results .search-result-item")];
    return items.findIndex((i) => i.querySelector(".result-type")?.textContent === "事件");
  });
  if (evIdx >= 0) {
    await page.locator("#search-results .search-result-item").nth(evIdx).click();
    await page.waitForTimeout(900);
    out.journeyD.eventDetail = await page.evaluate(() => {
      const p = document.querySelector("#story-panel-mount");
      return {
        hash: location.hash,
        text: (p?.innerText || "").slice(0, 400),
        hasPrecisionField: /精度|precision|位置未能|未能可靠/.test(p?.innerText || ""),
        hasZoneRelation: /區域|zone/.test(p?.innerText || ""),
        hasSpoilerLevel: /🔒/.test(p?.innerText || ""),
      };
    });
  }
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, "ux-audit2-results.json"), JSON.stringify(out, null, 2));
await browser.close();
console.log(JSON.stringify(out, null, 2));

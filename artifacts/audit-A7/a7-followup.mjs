/**
 * A7 補充審計：skip link 行為、鍵盤 Journey C/D、focus-visible 實測、
 * 對比違規彙總、tablet 量測。只讀 production code。
 *
 * 執行：node artifacts/audit-A7/a7-followup.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const out = {};

async function freshPage(opts = {}) {
  const context = await browser.newContext({
    viewport: { width: opts.width || 390, height: opts.height || 844 },
    hasTouch: opts.hasTouch !== false,
    isMobile: opts.hasTouch !== false,
    reducedMotion: opts.reducedMotion || "no-preference",
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1200);
  return { context, page };
}

/* ---- 1. skip link：全新載入後第一次 Tab ---- */
{
  const { context, page } = await freshPage();
  // 保證 focus 喺 body
  await page.evaluate(() => { document.activeElement?.blur?.(); document.body.setAttribute("tabindex", "-1"); document.body.focus(); });
  const tabSeq = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    tabSeq.push(await page.evaluate(() => {
      const a = document.activeElement;
      const cs = a ? getComputedStyle(a) : null;
      const r = a ? a.getBoundingClientRect() : null;
      return { i: 0, tag: a?.tagName, id: a?.id || null,
        cls: typeof a?.className === "string" ? a.className.slice(0, 40) : null,
        text: (a?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20),
        top: r ? +r.top.toFixed(1) : null, h: r ? +r.height.toFixed(1) : null,
        w: r ? +r.width.toFixed(1) : null,
        outlineStyle: cs?.outlineStyle, outlineWidth: cs?.outlineWidth, outlineColor: cs?.outlineColor,
        boxShadow: cs?.boxShadow?.slice(0, 50) };
    }));
  }
  out.skipLinkTabSeq = tabSeq;
  // 直接 focus skip link 再按 Enter
  await page.evaluate(() => document.querySelector(".skip-link").focus());
  const skipFocused = await page.evaluate(() => {
    const el = document.querySelector(".skip-link");
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { top: cs.top, visibleTop: +r.top.toFixed(1), h: +r.height.toFixed(1),
      w: +r.width.toFixed(1), text: el.textContent.trim() };
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  out.skipLinkEnter = await page.evaluate(() => ({
    activeTag: document.activeElement?.tagName, activeId: document.activeElement?.id || null,
    mapPaneTabIndex: document.querySelector("#map-pane")?.getAttribute("tabindex"),
    mapPaneIsActive: document.activeElement === document.querySelector("#map-pane"),
    hash: location.hash,
  }));
  out.skipLinkFocusStyle = skipFocused;
  await context.close();
}

/* ---- 2. focus-visible：實測 outline 有冇出現 ---- */
{
  const { context, page } = await freshPage({ width: 1440, height: 900, hasTouch: false });
  const probes = [];
  for (const sel of ["#btn-mode", "#btn-search", ".ch-pill", "#map-zoom-in", "#legend-lang-btn",
                     "#btn-toggle-panel", ".map-ctrl"]) {
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { sel: s, exists: false };
      el.focus();
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { sel: s, exists: true, w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
        outlineOffset: cs.outlineOffset, boxShadow: cs.boxShadow.slice(0, 70),
        focusVisibleMatched: el.matches(":focus-visible") };
    }, sel);
    probes.push(r);
  }
  out.focusVisible = probes;
  await context.close();
}

/* ---- 3. Journey C / D 純鍵盤可行性 ---- */
{
  const { context, page } = await freshPage({ width: 1440, height: 900, hasTouch: false });
  // Journey D：搵事件。用 `/` 開搜尋 → 打「商場」→ 試 ArrowDown/Enter
  await page.keyboard.press("/");
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => document.querySelector("#search-modal")?.classList.contains("open"));
  await page.keyboard.type("商場");
  await page.waitForTimeout(500);
  const resCount = await page.evaluate(() => document.querySelectorAll(".search-result-item").length);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const afterEnter = await page.evaluate(() => ({
    modalOpen: document.querySelector("#search-modal")?.classList.contains("open"),
    activeTag: document.activeElement?.tagName, activeId: document.activeElement?.id || null,
    chapter: document.querySelector("#strip-ch-num")?.textContent,
  }));
  // 試用 Tab 進入結果
  await page.keyboard.press("Tab");
  const afterTab = await page.evaluate(() => ({
    activeTag: document.activeElement?.tagName,
    activeCls: typeof document.activeElement?.className === "string" ? document.activeElement.className.slice(0, 50) : null,
    isSearchResult: !!document.activeElement?.closest?.(".search-result-item"),
  }));
  // 試 Tab 幾多次都入唔到結果？
  let reachedResult = false, tabs = 0;
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab"); tabs++;
    const ok = await page.evaluate(() => !!document.activeElement?.closest?.(".search-result-item"));
    if (ok) { reachedResult = true; break; }
  }
  out.journeyD = { opened, resCount, afterEnter, afterTab, reachedResultByTab: reachedResult, tabsToReach: tabs };

  // Journey C：搵角色路線。搜尋角色名 → 有冇「開路線」入口？
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("/");
  await page.waitForTimeout(300);
  await page.keyboard.type("阿晴");
  await page.waitForTimeout(500);
  const charRes = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".search-result-item"));
    return { count: items.length,
      types: items.slice(0, 8).map((i) => i.querySelector(".result-type")?.textContent?.trim()),
      texts: items.slice(0, 5).map((i) => i.textContent.replace(/\s+/g, " ").trim().slice(0, 40)) };
  });
  // 有冇 route / 路線 UI？
  const routeUi = await page.evaluate(() => ({
    routeElements: document.querySelectorAll(".route-item, .route-list, [data-route-id]").length,
    routeLegend: !!document.querySelector(".route-legend"),
    anyRouteButton: Array.from(document.querySelectorAll("button, [role=button]"))
      .filter((b) => /路線|route/i.test(b.textContent || "")).length,
  }));
  out.journeyC = { charRes, routeUi };
  await context.close();
}

/* ---- 4. 對比違規彙總（按 selector 樣式分組） ---- */
{
  const contrastAll = JSON.parse(fs.readFileSync(path.join(OUT, "a7-audit-results.json"), "utf8")).contrast;
  const summary = {};
  for (const [key, v] of Object.entries(contrastAll)) {
    const groups = {};
    for (const f of v.failList) {
      const k = f.sel.split(" > ").pop().replace(/#.*/, "");
      if (!groups[k]) groups[k] = { count: 0, minRatio: 99, sample: f.text.slice(0, 30), color: f.color, bg: f.bg, fontSize: f.fontSize };
      groups[k].count++;
      groups[k].minRatio = Math.min(groups[k].minRatio, f.ratio);
    }
    summary[key] = {
      total: v.total, fails: v.fails,
      inViewportFails: v.failList.filter((f) => f.inViewport).length,
      groups: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].count - a[1].count).slice(0, 20)),
    };
  }
  out.contrastSummary = summary;
}

/* ---- 5. Tablet 768 詳細 ---- */
{
  const { context, page } = await freshPage({ width: 768, height: 1024, hasTouch: true });
  out.tablet = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const b = (s) => { const e = document.querySelector(s); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        areaPctOfViewport: +((r.width * r.height) / (vw * vh) * 100).toFixed(1) }; };
    const legend = document.querySelector("#map-overlay")?.getBoundingClientRect();
    const map = document.querySelector("#svg-map-mount")?.getBoundingClientRect();
    const legendOverlapOfMap = legend && map
      ? +((Math.max(0, Math.min(legend.right, map.right) - Math.max(legend.left, map.left)) *
          Math.max(0, Math.min(legend.bottom, map.bottom) - Math.max(legend.top, map.top))) /
         (map.width * map.height) * 100).toFixed(1)
      : null;
    return {
      viewport: { vw, vh },
      topbar: b("#topbar"), h1: b("#topbar h1"),
      titleLines: (() => { const h = document.querySelector("#topbar h1");
        if (!h) return null; const cs = getComputedStyle(h);
        const lh = cs.lineHeight === "normal" ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
        return Math.round(h.getBoundingClientRect().height / lh); })(),
      legend: b("#map-overlay"), legendAreaPctOfViewport: legend
        ? +((legend.width * legend.height) / (vw * vh) * 100).toFixed(1) : null,
      legendOverlapOfMapPct: legendOverlapOfMap,
      mapMount: b("#svg-map-mount"),
      paneStory: b("#story-pane"),
      paneStoryCollapsed: document.querySelector("#story-pane")?.classList.contains("is-collapsed"),
      panelToggleDisplay: getComputedStyle(document.querySelector("#btn-toggle-panel")).display,
      mapCtrls: Array.from(document.querySelectorAll(".map-ctrl")).map((e) => {
        const r = e.getBoundingClientRect(); return { id: e.id, w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; }),
      navBtns: Array.from(document.querySelectorAll("#topbar nav .nav-btn")).map((e) => {
        const r = e.getBoundingClientRect();
        return { id: e.id, w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; }),
      chPill: (() => { const e = document.querySelector(".ch-pill"); if (!e) return null;
        const r = e.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
      horizontalOverflow: document.documentElement.scrollWidth > vw + 1,
      docScrollWidth: document.documentElement.scrollWidth,
    };
  });
  await page.screenshot({ path: path.join(OUT, "a7-tablet-768-detail.png") });
  await context.close();
}

/* ---- 6. reduced-motion：JS 驅動動畫（scrollIntoView smooth / rAF） ---- */
{
  const { context, page } = await freshPage({ width: 390, height: 844, reducedMotion: "reduce" });
  const probe = await page.evaluate(() => {
    const el = document.querySelector("#strip-track");
    const before = el.scrollLeft;
    const pill = document.querySelector('.ch-pill[data-ch="120"]');
    if (pill) pill.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    return { before, requested: "smooth" };
  });
  await page.waitForTimeout(120);
  const mid = await page.evaluate(() => document.querySelector("#strip-track").scrollLeft);
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => document.querySelector("#strip-track").scrollLeft);
  out.reducedMotionSmoothScroll = { ...probe, mid, after, scrollBehavior: await page.evaluate(() => getComputedStyle(document.querySelector("#strip-track")).scrollBehavior) };
  await context.close();
}

/* ---- 7. role=application 影響 + 地圖可存取名稱 ---- */
{
  const { context, page } = await freshPage({ width: 1440, height: 900, hasTouch: false });
  out.semantics = await page.evaluate(() => {
    const root = document.querySelector("#app-root");
    const main = document.querySelector("#map-pane");
    const svg = document.querySelector("#svg-map");
    return {
      appRootRole: root?.getAttribute("role"),
      appRootAriaLabel: root?.getAttribute("aria-label"),
      mainAriaLabel: main?.getAttribute("aria-label"),
      mainAriaLabelledby: main?.getAttribute("aria-labelledby"),
      mainHasHeading: !!main?.querySelector("h1,h2,h3"),
      svgRole: svg?.getAttribute("role"),
      svgAriaLabel: svg?.getAttribute("aria-label"),
      svgTitleText: svg?.querySelector("title")?.textContent?.trim().slice(0, 60),
      mapMarkersKeyboardReachable: Array.from(document.querySelectorAll(".location-marker, .event-marker, .zone"))
        .filter((e) => e.tabIndex >= 0).length,
      mapMarkersTotal: document.querySelectorAll(".location-marker, .event-marker, .zone").length,
      asideLabel: document.querySelector("#story-pane")?.getAttribute("aria-label"),
      asideRole: document.querySelector("#story-pane")?.getAttribute("role"),
      navLabels: Array.from(document.querySelectorAll("#topbar nav .nav-btn")).map((b) => ({
        id: b.id, text: b.textContent.trim(), aria: b.getAttribute("aria-label"), title: b.getAttribute("title") })),
      ariaLiveCount: document.querySelectorAll("[aria-live]").length,
      roleAlertCount: document.querySelectorAll("[role=alert]").length,
      roleStatusCount: document.querySelectorAll("[role=status]").length,
      chPillAriaCurrent: document.querySelector(".ch-pill.active")?.getAttribute("aria-current"),
      chPillActiveClass: !!document.querySelector(".ch-pill.active"),
    };
  });
  await context.close();
}

fs.writeFileSync(path.join(OUT, "a7-followup.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();

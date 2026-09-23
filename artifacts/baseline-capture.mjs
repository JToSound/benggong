/**
 * 《病港》互動地圖 —— World Atlas V2 Phase 0 baseline 擷取腳本
 *
 * 用途：對「現行 production 版本」建立可稽核嘅 baseline 證據，供 A1–A10
 *      只讀審計子代理引用。本腳本**只讀** production code，只寫
 *      `artifacts/` 之下嘅檔案。
 *
 * 產出：
 *   artifacts/screenshots/baseline-*.png
 *   artifacts/network/baseline-*.json
 *   artifacts/perf/baseline-*.trace.zip
 *   artifacts/perf/baseline-*.metrics.json
 *   artifacts/console/baseline-*.log
 *
 * 執行：BASE_URL=http://127.0.0.1:5180/ node artifacts/baseline-capture.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

// ⚠️ 必須用 `localhost` 而唔係 `127.0.0.1`：vite preview 只綁 IPv6 `[::1]`。
const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT_SHOTS = "artifacts/screenshots";
const OUT_NET = "artifacts/network";
const OUT_PERF = "artifacts/perf";
const OUT_CON = "artifacts/console";

for (const d of [OUT_SHOTS, OUT_NET, OUT_PERF, OUT_CON]) {
  fs.mkdirSync(d, { recursive: true });
}

/** 規格 §4.1：1440×900、768×1024、390×844 */
const VIEWPORTS = [
  { id: "desktop", width: 1440, height: 900, tag: "1440" },
  { id: "tablet", width: 768, height: 1024, tag: "768" },
  { id: "mobile", width: 390, height: 844, tag: "390" },
];

/** 收集 LCP / CLS / 長任務 —— 必須喺 document 開始前注入。 */
const PERF_INIT = `
  window.__baseline = { lcp: null, cls: 0, longTasks: [], layoutShifts: 0 };
  try {
    new PerformanceObserver((l) => {
      const es = l.getEntries();
      window.__baseline.lcp = es[es.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (!e.hadRecentInput) { window.__baseline.cls += e.value; window.__baseline.layoutShifts++; }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__baseline.longTasks.push({ start: e.startTime, dur: e.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
`;

function isExternal(url) {
  try {
    const u = new URL(url);
    return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 擷取一個 viewport 嘅全套 baseline。
 */
async function captureViewport(browser, vp, opts = {}) {
  const { dpr = 1, zoomSteps = 0, suffix = "" } = opts;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: dpr,
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
    reducedMotion: "no-preference",
  });

  const consoleLines = [];
  const requests = [];
  const failures = [];

  await context.addInitScript(PERF_INIT);

  const page = await context.newPage();

  page.on("console", (msg) => {
    consoleLines.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
      ts: Date.now(),
    });
  });
  page.on("pageerror", (err) => {
    consoleLines.push({ type: "pageerror", text: String(err), ts: Date.now() });
  });
  page.on("requestfailed", (req) => {
    failures.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      failure: req.failure()?.errorText ?? null,
      external: isExternal(req.url()),
    });
  });
  page.on("response", async (res) => {
    const req = res.request();
    let sizes = null;
    try {
      sizes = await req.sizes();
    } catch {
      /* 已丟棄 */
    }
    const h = res.headers();
    requests.push({
      url: res.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      status: res.status(),
      ok: res.ok(),
      external: isExternal(res.url()),
      contentType: h["content-type"] ?? null,
      contentLength: h["content-length"] ? Number(h["content-length"]) : null,
      sizes,
    });
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  // 等首屏渲染、字體、底圖圖磚穩定
  await page.waitForTimeout(1500);
  const loadMs = Date.now() - t0;

  // ---- DOM / renderer 快照（供 A4 map rendering 審計）----
  const dom = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const svg = q("#svg-map-mount svg");
    const canvas = q("#svg-map-mount canvas");
    const mapEl = q("#map-pane") || q("#svg-map-mount");
    const r = mapEl?.getBoundingClientRect();
    return {
      title: document.title,
      lang: document.documentElement.lang,
      theme: document.documentElement.getAttribute("data-theme"),
      bodyClass: document.body.className,
      hasSvgMap: !!svg,
      svgViewBox: svg?.getAttribute("viewBox") ?? null,
      svgWidth: svg?.getAttribute("width") ?? null,
      svgHeight: svg?.getAttribute("height") ?? null,
      hasCanvas: !!canvas,
      canvasBacking: canvas ? { w: canvas.width, h: canvas.height } : null,
      canvasCss: canvas
        ? { w: canvas.getBoundingClientRect().width, h: canvas.getBoundingClientRect().height }
        : null,
      devicePixelRatio: window.devicePixelRatio,
      mapRect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      // 主要入口
      navButtons: [...document.querySelectorAll("#topbar .nav-btn")].map((b) => ({
        id: b.id,
        text: (b.textContent || "").trim(),
        ariaExpanded: b.getAttribute("aria-expanded"),
      })),
      hasSkipLink: !!q(".skip-link"),
      chapterStripPresent: !!q("#chapter-strip-mount")?.children.length,
      storyPanelPresent: !!q("#story-panel-mount")?.children.length,
      zoneDossierVisible: !!(q("#zone-dossier-mount") && !q("#zone-dossier-mount").hidden),
      // 文字節點數量（粗略資訊密度指標）
      textLength: (document.body.innerText || "").length,
      // 可見 raster <img> 及其自然尺寸（pixelation 診斷）
      images: [...document.querySelectorAll("img")].map((im) => ({
        src: im.getAttribute("src"),
        naturalW: im.naturalWidth,
        naturalH: im.naturalHeight,
        cssW: Math.round(im.getBoundingClientRect().width),
        cssH: Math.round(im.getBoundingClientRect().height),
      })),
      // inline background-image（raster 放大診斷）
      bgImages: [...document.querySelectorAll("*")]
        .map((el) => {
          const bg = getComputedStyle(el).backgroundImage;
          if (!bg || bg === "none") return null;
          const rr = el.getBoundingClientRect();
          return { bg: bg.slice(0, 200), w: Math.round(rr.width), h: Math.round(rr.height) };
        })
        .filter(Boolean)
        .slice(0, 20),
    };
  });

  // ---- Performance 指標 ----
  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint").map((p) => ({
      name: p.name,
      startTime: p.startTime,
    }));
    const res = performance.getEntriesByType("resource").map((r) => ({
      name: r.name,
      initiatorType: r.initiatorType,
      transferSize: r.transferSize,
      encodedBodySize: r.encodedBodySize,
      decodedBodySize: r.decodedBodySize,
      duration: Math.round(r.duration),
    }));
    return {
      navigation: nav
        ? {
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            loadEvent: Math.round(nav.loadEventEnd),
            domInteractive: Math.round(nav.domInteractive),
            transferSize: nav.transferSize,
            encodedBodySize: nav.encodedBodySize,
            decodedBodySize: nav.decodedBodySize,
          }
        : null,
      paints,
      lcp: window.__baseline?.lcp ?? null,
      cls: window.__baseline?.cls ?? null,
      longTasks: window.__baseline?.longTasks ?? [],
      resourceCount: res.length,
      resources: res,
      totalTransferSize: res.reduce((a, b) => a + (b.transferSize || 0), 0),
      memory: performance.memory
        ? { usedJSHeapSize: performance.memory.usedJSHeapSize }
        : null,
    };
  });

  const stem = `baseline-map-${vp.id}-${vp.tag}${suffix}`;
  await page.screenshot({ path: path.join(OUT_SHOTS, `${stem}.png`), fullPage: false });
  await page.screenshot({
    path: path.join(OUT_SHOTS, `${stem}-fullpage.png`),
    fullPage: true,
  });

  // ---- 最大 zoom 診斷（A4 pixelation root cause 用）----
  const zoomSeries = [];
  if (zoomSteps > 0) {
    const btn = page.locator("#map-zoom-in");
    for (let i = 1; i <= zoomSteps; i++) {
      if (!(await btn.count())) break;
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(420);
      const vb = await page.evaluate(
        () => document.querySelector("#svg-map-mount svg")?.getAttribute("viewBox") ?? null,
      );
      zoomSeries.push({ step: i, viewBox: vb });
      if ([1, 4, 8, 12, 14, 18, zoomSteps].includes(i)) {
        await page.screenshot({
          path: path.join(OUT_SHOTS, `baseline-zoom-${vp.id}-step${String(i).padStart(2, "0")}${suffix}.png`),
          fullPage: false,
        });
      }
    }
  }

  const domAfterZoom = zoomSteps
    ? await page.evaluate(() => {
        const svg = document.querySelector("#svg-map-mount svg");
        const canvas = document.querySelector("#svg-map-mount canvas");
        return {
          svgViewBox: svg?.getAttribute("viewBox") ?? null,
          hasCanvas: !!canvas,
          canvasBacking: canvas ? { w: canvas.width, h: canvas.height } : null,
          devicePixelRatio: window.devicePixelRatio,
          images: [...document.querySelectorAll("img")].map((im) => ({
            src: im.getAttribute("src"),
            naturalW: im.naturalWidth,
            naturalH: im.naturalHeight,
            cssW: Math.round(im.getBoundingClientRect().width),
            cssH: Math.round(im.getBoundingClientRect().height),
          })),
        };
      })
    : null;

  const tracePath = path.join(OUT_PERF, `${stem}.trace.zip`);
  await context.tracing.stop({ path: tracePath });

  const netSummary = {
    baseUrl: BASE,
    viewport: vp,
    deviceScaleFactor: dpr,
    capturedAt: new Date().toISOString(),
    requestCount: requests.length,
    externalRequestCount: requests.filter((r) => r.external).length,
    externalRequests: requests.filter((r) => r.external),
    failedRequestCount: failures.length,
    failedRequests: failures,
    totalTransferBytes: requests.reduce((a, b) => a + (b.sizes?.responseBodySize ?? 0), 0),
    byType: requests.reduce((acc, r) => {
      acc[r.resourceType] = (acc[r.resourceType] || 0) + 1;
      return acc;
    }, {}),
    mapAssetRequests: requests
      .filter((r) => /assets\/(vector|map-lod|map-tiles|markers|generated)\//.test(r.url))
      .map((r) => ({ url: r.url, status: r.status, bytes: r.sizes?.responseBodySize ?? null })),
    requests,
  };

  const perfOut = {
    baseUrl: BASE,
    viewport: vp,
    deviceScaleFactor: dpr,
    capturedAt: new Date().toISOString(),
    navigationToStableMs: loadMs,
    metrics: perf,
    dom,
    zoomSeries,
    domAfterZoom,
    traceFile: tracePath,
  };

  fs.writeFileSync(path.join(OUT_NET, `${stem}.json`), JSON.stringify(netSummary, null, 2));
  fs.writeFileSync(path.join(OUT_PERF, `${stem}.metrics.json`), JSON.stringify(perfOut, null, 2));
  fs.writeFileSync(
    path.join(OUT_CON, `${stem}.log`),
    consoleLines.map((l) => `[${l.type}] ${l.text}`).join("\n") + "\n",
  );

  await context.close();

  return {
    id: vp.id + suffix,
    requests: netSummary.requestCount,
    external: netSummary.externalRequestCount,
    consoleErrors: consoleLines.filter((l) => l.type === "error" || l.type === "pageerror").length,
    consoleWarnings: consoleLines.filter((l) => l.type === "warning").length,
    lcp: perf.lcp,
    cls: perf.cls,
    loadMs,
    stableMs: loadMs,
  };
}

async function main() {
  // ⚠️ `--no-proxy-server`：環境有 http_proxy，Chromium 若照用會連唔到本機 server。
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-proxy-server"],
  });
  const results = [];

  // 1) 三個規格 viewport，DPR 1
  for (const vp of VIEWPORTS) {
    results.push(await captureViewport(browser, vp));
  }

  // 2) Desktop DPR 2（retina 診斷）
  results.push(
    await captureViewport(browser, VIEWPORTS[0], { dpr: 2, suffix: "-dpr2" }),
  );

  // 3) Desktop 最大 zoom 序列（pixelation 證據）
  results.push(
    await captureViewport(browser, VIEWPORTS[0], { zoomSteps: 20, suffix: "-zoom" }),
  );

  // 4) Mobile 最大 zoom（touch 情境）
  results.push(
    await captureViewport(browser, VIEWPORTS[2], { zoomSteps: 20, suffix: "-zoom" }),
  );

  await browser.close();

  const report = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    runs: results,
  };
  fs.writeFileSync(
    "artifacts/baseline-summary.json",
    JSON.stringify(report, null, 2),
  );

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("baseline capture 失敗:", e);
  process.exit(1);
});

/**
 * A8 Data/Performance — 執行期效能實測（Playwright + CDP）
 *
 * 只讀 production build（preview server），只寫 artifacts/audit-A8/。
 * 全部量測程式化、可重跑；冇任何人手 DevTools 步驟。
 *
 * 量度：
 *   1. 初次載入：navigation timing / paint / LCP / CLS / longTasks / resource transferSize
 *   2. Chronicle：首次 render 時間、DOM node 數、全量 render vs 篩選 render、
 *      expand 重繪、scroll frame timing
 *   3. Search：常見字輸入 → 結果出現時間（同步量測）
 *   4. Map：pan frame timing、zoom frame timing、marker click → 面板更新時間
 *   5. 資料載入：request 清單、eager payload 總量
 *
 * 執行：node artifacts/audit-A8/measure-runtime.mjs
 * 輸出：artifacts/audit-A8/runtime-metrics.json
 */

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A8/runtime-metrics.json";
const OUTDIR = "artifacts/audit-A8";

/** 必須喺 document 開始前注入：LCP / CLS / longtask / chronicle 首現時間。 */
const PERF_INIT = `
  window.__a8 = { lcp: null, cls: 0, longTasks: [], chrFirstEntryMs: null, chrEntriesAtFirst: 0, chrPanelFirstMs: null };
  try {
    new PerformanceObserver((l) => { const es = l.getEntries(); window.__a8.lcp = es[es.length-1].startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__a8.cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__a8.longTasks.push({ start: e.startTime, dur: e.duration }); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) {}
  const watchChronicle = () => {
    const mo = new MutationObserver(() => {
      if (window.__a8.chrPanelFirstMs === null && document.querySelector('#story-panel-mount .chronicle')) {
        window.__a8.chrPanelFirstMs = performance.now();
      }
      const n = document.querySelectorAll('.chr-entry').length;
      if (n > 0 && window.__a8.chrFirstEntryMs === null) {
        window.__a8.chrFirstEntryMs = performance.now();
        window.__a8.chrEntriesAtFirst = n;
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) watchChronicle();
  else document.addEventListener('DOMContentLoaded', watchChronicle);
`;

function isExternal(url) {
  try {
    const u = new URL(url);
    return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** 同步量測：dispatch 一個會觸發同步 render 嘅動作，量度 handler 執行時間。 */
async function measureSync(page, expr) {
  return page.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("return (" + src + ")");
    const run = fn();
    const t0 = performance.now();
    run();
    const t1 = performance.now();
    return Math.round((t1 - t0) * 100) / 100;
  }, expr);
}

/** 量度 rAF frame 間隔（ms）＋統計。 */
function frameStats(frames) {
  const arr = frames.filter((x) => Number.isFinite(x) && x > 0);
  if (!arr.length) return { n: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);
  const avg = sum / arr.length;
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n: arr.length,
    avgMs: Math.round(avg * 100) / 100,
    fps: Math.round((1000 / avg) * 10) / 10,
    p50Ms: Math.round(p(0.5) * 100) / 100,
    p95Ms: Math.round(p(0.95) * 100) / 100,
    maxMs: Math.round(Math.max(...arr) * 100) / 100,
    over50ms: arr.filter((x) => x > 50).length,
  };
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
  });
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();

  const consoleErrors = [];
  const requests = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleErrors.push({ type: m.type(), text: m.text() });
  });
  page.on("pageerror", (e) => consoleErrors.push({ type: "pageerror", text: String(e) }));
  page.on("response", async (res) => {
    let sizes = null;
    try { sizes = await res.request().sizes(); } catch { /* ignore */ }
    requests.push({
      url: res.url(),
      type: res.request().resourceType(),
      status: res.status(),
      external: isExternal(res.url()),
      responseBodySize: sizes?.responseBodySize ?? null,
      headers: res.headers(),
    });
  });

  const cdp = await context.newCDPSession(page);

  // ---------- 1. 初次載入 ----------
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const loadToStableMs = Date.now() - t0;

  const loadMetrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint").map((p) => ({ name: p.name, startTime: Math.round(p.startTime) }));
    const res = performance.getEntriesByType("resource").map((r) => ({
      name: r.name,
      initiatorType: r.initiatorType,
      transferSize: r.transferSize,
      encodedBodySize: r.encodedBodySize,
      decodedBodySize: r.decodedBodySize,
      duration: Math.round(r.duration),
    }));
    const a8 = window.__a8;
    const all = document.getElementsByTagName("*").length;
    return {
      navigation: nav ? {
        domInteractive: Math.round(nav.domInteractive),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        loadEvent: Math.round(nav.loadEventEnd),
        responseEnd: Math.round(nav.responseEnd),
      } : null,
      paints,
      lcp: a8.lcp !== null ? Math.round(a8.lcp) : null,
      cls: Math.round(a8.cls * 10000) / 10000,
      longTasks: a8.longTasks.map((x) => ({ start: Math.round(x.start), dur: Math.round(x.dur) })),
      longTaskCount: a8.longTasks.length,
      longTaskTotalMs: Math.round(a8.longTasks.reduce((a, b) => a + b.dur, 0)),
      longTaskMaxMs: Math.round(Math.max(0, ...a8.longTasks.map((x) => x.dur))),
      chrPanelFirstMs: a8.chrPanelFirstMs !== null ? Math.round(a8.chrPanelFirstMs) : null,
      chrFirstEntryMs: a8.chrFirstEntryMs !== null ? Math.round(a8.chrFirstEntryMs) : null,
      chrEntriesAtFirst: a8.chrEntriesAtFirst,
      totalDomNodes: all,
      chronicleEntries: document.querySelectorAll(".chr-entry").length,
      chapterPills: document.querySelectorAll(".ch-pill").length,
      timelineBars: document.querySelectorAll(".chr-tl-bar").length,
      locationMarkers: document.querySelectorAll(".location-marker, .location-marker-cluster").length,
      eventMarkers: document.querySelectorAll(".event-marker").length,
      zoneEls: document.querySelectorAll(".zone").length,
      bodyTextLength: (document.body.innerText || "").length,
      resources: res,
      totalTransferSize: res.reduce((a, b) => a + (b.transferSize || 0), 0),
    };
  });

  const biggestResources = [...loadMetrics.resources]
    .sort((a, b) => b.transferSize - a.transferSize)
    .slice(0, 8)
    .map((r) => ({ name: r.name.replace(BASE, ""), transferSize: r.transferSize, decodedBodySize: r.decodedBodySize, type: r.initiatorType }));

  // ---------- 2. Chronicle 效能 ----------
  const chronicle = {};

  // 2z. Idle FPS 基準（校準 rAF 環境，唔係量度任何互動）
  chronicle.idleFrames = frameStats(
    await page.evaluate(() => new Promise((resolve) => {
      const frames = [];
      let last = performance.now();
      const t0 = performance.now();
      const tick = (now) => {
        frames.push(now - last);
        last = now;
        if (now - t0 < 1200) requestAnimationFrame(tick);
        else resolve(frames);
      };
      requestAnimationFrame(tick);
    })),
  );

  // 2a. 篩選一個章節（少量條目）—— 由全量狀態 → 篩選
  chronicle.filterCh1Ms = await measureSync(page, `() => { document.querySelector('[data-tl-ch="1"]').click(); }`);
  chronicle.entriesCh1 = await page.evaluate(() => document.querySelectorAll(".chr-entry").length);

  // 2b. 清除篩選 → 全量 render（1320 條），並強制 layout 計入真實成本
  chronicle.clearFilterToFullRenderMs = await page.evaluate(() => {
    const t0 = performance.now();
    document.querySelector("#chr-clear-filter").click();
    const t1 = performance.now();
    // 強制 layout / style recalculation（innerHTML 之後 layout 係 lazy 嘅）
    void document.querySelector("#story-panel-mount").scrollHeight;
    const t2 = performance.now();
    return {
      innerHtmlAndBindMs: Math.round((t1 - t0) * 100) / 100,
      forcedLayoutMs: Math.round((t2 - t0) * 100) / 100,
    };
  });
  chronicle.entriesAfterFullRender = await page.evaluate(() => document.querySelectorAll(".chr-entry").length);

  // 2c. 篩選一個高密度章節（用時間軸 bar 高度搵最密嗰章）
  const dense = await page.evaluate(() => {
    const bars = [...document.querySelectorAll(".chr-tl-bar")];
    let best = null, bestH = -1;
    for (const b of bars) {
      const h = parseFloat((b.getAttribute("style") || "").match(/height:\s*([\d.]+)%/)?.[1] || "0");
      if (h > bestH) { bestH = h; best = b; }
    }
    return { ch: best?.getAttribute("data-tl-ch"), h: bestH };
  });
  chronicle.denseChapter = dense.ch;
  chronicle.filterDenseMs = await measureSync(page, `() => { document.querySelector('[data-tl-ch="${dense.ch}"]').click(); }`);
  chronicle.entriesDense = await page.evaluate(() => document.querySelectorAll(".chr-entry").length);

  // 2c2. 清除 → 再全量，計內存
  await page.evaluate(() => document.querySelector("#chr-clear-filter").click());
  await page.waitForTimeout(300);
  chronicle.jsHeapMB = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null));

  // 2d. 回到全量 + expand 一條（觸發全量重繪）
  await page.evaluate(() => { const c = document.querySelector("#chr-clear-filter"); if (c) c.click(); });
  await page.waitForTimeout(200);
  chronicle.expandToggleFullRenderMs = await measureSync(
    page,
    `() => { const b = document.querySelector('.chr-toggle'); if (b) b.click(); }`,
  );
  chronicle.expandToggleFullRenderEntries = await page.evaluate(() => document.querySelectorAll(".chr-entry").length);

  // 2e. DOM node 數 + listener 估算（按鈕數量）
  chronicle.domNodesWithChronicle = await page.evaluate(() => document.getElementsByTagName("*").length);
  chronicle.boundButtons = await page.evaluate(() => ({
    chrToggle: document.querySelectorAll(".chr-toggle").length,
    chrCh: document.querySelectorAll(".chr-ch").length,
    tlBar: document.querySelectorAll(".chr-tl-bar").length,
  }));

  // 2f. Scroll frame timing（scroll 到最底）
  chronicle.scrollFrames = frameStats(
    await page.evaluate(() => new Promise((resolve) => {
      const frames = [];
      let last = performance.now();
      let running = true;
      const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const body = document.querySelector(".chronicle-body") || document.querySelector("#story-panel-mount");
      if (!body) { running = false; return resolve(frames); }
      let i = 0;
      const step = () => {
        i++;
        body.scrollTop = (body.scrollHeight / 20) * i;
        if (i < 20) setTimeout(step, 16);
        else { running = false; setTimeout(() => resolve(frames), 100); }
      };
      step();
    })),
  );

  // ---------- 3. Search 效能 ----------
  const search = {};
  await page.evaluate(() => document.querySelector("#btn-search").click());
  await page.waitForTimeout(150);
  const searchTerms = ["大本營", "陳", "將軍澳", "病", "a"];
  search.terms = [];
  for (const term of searchTerms) {
    const ms = await page.evaluate((q) => {
      const input = document.querySelector("#search-input");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const t0 = performance.now();
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const t1 = performance.now();
      const n = document.querySelectorAll(".search-result-item").length;
      const more = document.querySelector(".more")?.textContent || "";
      return { ms: Math.round((t1 - t0) * 100) / 100, results: n, more };
    }, term);
    search.terms.push({ term, ...ms });
  }
  // 逐字輸入（模擬打字）累積成本
  search.typing = await page.evaluate(() => {
    const input = document.querySelector("#search-input");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const word = "將軍澳大本營";
    const per = [];
    let acc = 0;
    for (let i = 1; i <= word.length; i++) {
      const t0 = performance.now();
      input.value = word.slice(0, i);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const dt = performance.now() - t0;
      acc += dt;
      per.push({ prefix: word.slice(0, i), ms: Math.round(dt * 100) / 100 });
    }
    return { perKeystroke: per, totalMs: Math.round(acc * 100) / 100, avgMs: Math.round((acc / word.length) * 100) / 100 };
  });
  await page.evaluate(() => document.querySelector("#search-close").click());
  await page.waitForTimeout(120);

  // ---------- 4. Map 互動效能 ----------
  const map = {};

  // 4a. Pan frame timing（合成 mousemove 序列）
  map.pan = frameStats(
    await page.evaluate(() => new Promise((resolve) => {
      const frames = [];
      let last = performance.now();
      let running = true;
      const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const svg = document.querySelector("#svg-map");
      const rect = svg.getBoundingClientRect();
      const x0 = rect.left + rect.width / 2;
      const y0 = rect.top + rect.height / 2;
      svg.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x0, clientY: y0 }));
      let i = 0;
      const step = () => {
        i++;
        window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x0 + i * 5, clientY: y0 + i * 2 }));
        if (i < 40) setTimeout(step, 16);
        else {
          window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          running = false;
          setTimeout(() => resolve(frames), 80);
        }
      };
      step();
    })),
  );

  // 4b. Zoom frame timing（連續點 zoom-in，直到 clamp）
  const zoomResult = await page.evaluate(() => new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    let running = true;
    const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const btn = document.querySelector("#map-zoom-in");
    const vbs = [];
    let i = 0;
    const step = () => {
      i++;
      btn.click();
      vbs.push(document.querySelector("#svg-map").getAttribute("viewBox"));
      if (i < 20) setTimeout(step, 60);
      else { running = false; setTimeout(() => resolve({ frames, vbs }), 120); }
    };
    step();
  }));
  map.zoom = frameStats(zoomResult.frames);
  map.zoomViewBoxes = zoomResult.vbs;
  map.basemapLevelAfterZoom = await page.evaluate(() => document.querySelector("#basemap-canvas")?.dataset.basemapLevel ?? null);
  map.tilesAfterZoom = await page.evaluate(() => document.querySelectorAll("#svg-map image").length);

  // 4b2. 暖機後再 zoom（圖磚已喺 LRU cache，排除網絡／首次 parse）
  await page.waitForTimeout(1500);
  map.zoomWarm = frameStats(
    await page.evaluate(() => new Promise((resolve) => {
      const frames = [];
      let last = performance.now();
      let running = true;
      const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const out = document.querySelector("#map-zoom-out");
      const inn = document.querySelector("#map-zoom-in");
      let i = 0;
      const step = () => {
        i++;
        (i % 2 === 0 ? inn : out).click();
        if (i < 16) setTimeout(step, 60);
        else { running = false; setTimeout(() => resolve(frames), 120); }
      };
      step();
    })),
  );

  // 重置視圖
  await page.evaluate(() => document.querySelector("#map-reset").click());
  await page.waitForTimeout(700);

  // 4c. Marker click → 面板更新時間（優先揀單一 location marker，其次 event marker）
  const markerInfo = await page.evaluate(() => {
    const loc = document.querySelector(".location-marker");
    const ev = document.querySelector(".event-marker");
    const cl = document.querySelector(".location-marker-cluster");
    const m = loc || ev || cl;
    return {
      found: !!m,
      kind: loc ? "location-marker" : ev ? "event-marker" : cl ? "cluster" : null,
      cls: m?.getAttribute("class") || null,
      id: m?.getAttribute("data-loc-id") || m?.getAttribute("data-event-id") || null,
    };
  });
  map.marker = markerInfo;
  if (markerInfo.found) {
    const sel = markerInfo.kind === "location-marker" ? ".location-marker" : markerInfo.kind === "event-marker" ? ".event-marker" : ".location-marker-cluster";
    map.markerClickMs = await page.evaluate((s) => {
      const m = document.querySelector(s);
      const panel = document.querySelector("#story-panel-mount");
      const before = panel.innerHTML.length;
      const t0 = performance.now();
      m.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const t1 = performance.now();
      void panel.scrollHeight; // 強制 layout
      const t2 = performance.now();
      return {
        handlerMs: Math.round((t1 - t0) * 100) / 100,
        withLayoutMs: Math.round((t2 - t0) * 100) / 100,
        panelChanged: panel.innerHTML.length !== before,
      };
    }, sel);
    map.panelAfterClick = await page.evaluate(() => ({
      storyPanelHasContent: (document.querySelector("#story-panel-mount")?.innerHTML || "").length > 0,
      zoneDossierVisible: !document.querySelector("#zone-dossier-mount")?.hidden,
      viewModeBtn: document.querySelector("#btn-mode")?.textContent,
    }));
  }

  // 4d. Zoom 後 pan（LOD level 2 情境，最重）
  await page.evaluate(() => { for (let i = 0; i < 14; i++) document.querySelector("#map-zoom-in").click(); });
  await page.waitForTimeout(1200);
  map.zoomedPan = frameStats(
    await page.evaluate(() => new Promise((resolve) => {
      const frames = [];
      let last = performance.now();
      let running = true;
      const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const svg = document.querySelector("#svg-map");
      const rect = svg.getBoundingClientRect();
      const x0 = rect.left + rect.width / 2;
      const y0 = rect.top + rect.height / 2;
      svg.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x0, clientY: y0 }));
      let i = 0;
      const step = () => {
        i++;
        window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x0 + i * 3, clientY: y0 + i * 2 }));
        if (i < 40) setTimeout(step, 16);
        else { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); running = false; setTimeout(() => resolve(frames), 80); }
      };
      step();
    })),
  );
  map.level2Tiles = await page.evaluate(() => ({
    level: document.querySelector("#basemap-canvas")?.dataset.basemapLevel ?? null,
    tileImages: document.querySelectorAll("#svg-map image").length,
  }));

  // ---------- 5. 資料載入策略 ----------
  const dataLoading = {
    requestCount: requests.length,
    externalCount: requests.filter((r) => r.external).length,
    fetchCount: requests.filter((r) => r.type === "fetch").length,
    jsonFetches: requests.filter((r) => r.type === "fetch" && /\.(json|geojson)/.test(r.url)).map((r) => ({
      path: r.url.replace(BASE, ""),
      responseBodySize: r.responseBodySize,
      contentEncoding: r.headers["content-encoding"] || "none",
      contentType: r.headers["content-type"] || null,
    })),
    assetFetches: requests.filter((r) => r.type === "fetch" && /assets\/(vector|map-lod)/.test(r.url)).map((r) => ({
      path: r.url.replace(BASE, ""),
      responseBodySize: r.responseBodySize,
    })),
    mapLodRequests: requests.filter((r) => /assets\/map-lod\//.test(r.url)).length,
  };

  // 向量標籤數量（每次 canvas draw 都會 sort 一次全部 label）
  let vectorLabels = null;
  try {
    const lbl = JSON.parse(fs.readFileSync("public/assets/vector/labels.json", "utf8"));
    vectorLabels = Array.isArray(lbl.labels) ? lbl.labels.length : null;
  } catch { /* ignore */ }

  const report = {
    baseUrl: BASE,
    capturedAt: new Date().toISOString(),
    node: process.version,
    viewport: { width: 1440, height: 900, dpr: 1 },
    vectorLabels,
    load: { loadToStableMs, ...loadMetrics, biggestResources },
    chronicle,
    search,
    map,
    dataLoading,
    consoleErrors,
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  await context.close();
  await browser.close();

  // 摘要輸出
  console.log("=== 初次載入 ===");
  console.log("load→stable:", loadMetrics.loadToStableMs ?? loadToStableMs, "ms | DCL:", loadMetrics.navigation.domContentLoaded, "| load:", loadMetrics.navigation.loadEvent, "| LCP:", loadMetrics.lcp, "| CLS:", loadMetrics.cls);
  console.log("longTasks:", loadMetrics.longTaskCount, "總計", loadMetrics.longTaskTotalMs, "ms 最大", loadMetrics.longTaskMaxMs, "ms");
  console.log("DOM nodes:", loadMetrics.totalDomNodes, "| chronicle entries:", loadMetrics.chronicleEntries, "| chapter pills:", loadMetrics.chapterPills);
  console.log("chronicle 首現:", loadMetrics.chrFirstEntryMs, "ms (panel:", loadMetrics.chrPanelFirstMs, "ms)");
  console.log("總 transfer:", (loadMetrics.totalTransferSize / 1048576).toFixed(2), "MB");
  console.log("\n=== 最大 resource (transferSize) ===");
  for (const r of biggestResources) console.log(" ", String(r.transferSize).padStart(9), r.name);
  console.log("\n=== Chronicle ===");
  console.log("idle FPS:", chronicle.idleFrames.fps, "| scroll FPS:", chronicle.scrollFrames.fps);
  console.log("全量 render(1320):", JSON.stringify(chronicle.clearFilterToFullRenderMs), "| 篩選 ch1:", chronicle.filterCh1Ms, "ms | 篩選最密章 ch" + chronicle.denseChapter + "(" + chronicle.entriesDense + "條):", chronicle.filterDenseMs, "ms");
  console.log("expand 全量重繪:", chronicle.expandToggleFullRenderMs, "ms | DOM:", chronicle.domNodesWithChronicle, "| toggle buttons:", chronicle.boundButtons.chrToggle, "| heap:", chronicle.jsHeapMB, "MB");
  console.log("\n=== Search ===");
  for (const t of search.terms) console.log("  「" + t.term + "」", t.ms, "ms,", t.results, "結果", t.more);
  console.log("逐字打「將軍澳大本營」:", search.typing.totalMs, "ms 總計 / 平均", search.typing.avgMs, "ms");
  console.log("\n=== Map ===");
  console.log("pan:", JSON.stringify(map.pan));
  console.log("zoom(冷):", JSON.stringify(map.zoom));
  console.log("zoom(暖):", JSON.stringify(map.zoomWarm));
  console.log("marker click:", JSON.stringify(map.markerClickMs), "kind:", map.marker.kind);
  console.log("zoomed pan:", JSON.stringify(map.zoomedPan));
  console.log("vector labels:", vectorLabels);
  console.log("\n=== 資料載入 ===");
  console.log("requests:", dataLoading.requestCount, "| external:", dataLoading.externalCount, "| fetch:", dataLoading.fetchCount, "| map-lod requests:", dataLoading.mapLodRequests);
  console.log("\nconsole errors/warnings:", consoleErrors.length);
  console.log("→", OUT);
}

main().catch((e) => { console.error("量測失敗:", e); process.exit(1); });

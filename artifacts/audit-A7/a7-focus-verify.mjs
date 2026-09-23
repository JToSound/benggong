/**
 * A7 驗證腳本：focus 指示器**實際可見性**（像素級）、touch target 間距、
 * legend 對地圖嘅遮蓋比例、safe-area 模擬。全部程式化，唔靠目測。
 *
 * 執行：node artifacts/audit-A7/a7-focus-verify.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const out = {};

async function fresh(opts = {}) {
  const context = await browser.newContext({
    viewport: { width: opts.width || 1440, height: opts.height || 900 },
    hasTouch: !!opts.hasTouch,
    isMobile: !!opts.hasTouch,
    deviceScaleFactor: opts.dpr || 1,
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

/**
 * 比較聚焦前後嘅像素差異，判斷 focus ring 有冇真正畫出嚟。
 *
 * 唔用外部 png 庫：將兩張 screenshot 傳入頁面，用 OffscreenCanvas 解碼後
 * 逐像素比較。ring 區域＝ bounding box 外圍 pad px 嘅環帶。
 */
async function focusRingPixels(page, selector, pad = 10) {
  const box = await page.evaluate(({ s, pad }) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)),
             width: Math.ceil(r.width + pad * 2), height: Math.ceil(r.height + pad * 2) };
  }, { s: selector, pad });
  if (!box) return { selector, exists: false };

  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.waitForTimeout(140);
  const beforeB64 = (await page.screenshot({ clip: box })).toString("base64");
  await page.evaluate((s) => document.querySelector(s).focus(), selector);
  await page.waitForTimeout(180);
  const matched = await page.evaluate((s) => document.querySelector(s).matches(":focus-visible"), selector);
  const afterB64 = (await page.screenshot({ clip: box })).toString("base64");

  const diff = await page.evaluate(async ({ a, b, pad }) => {
    async function decode(b64) {
      const res = await fetch("data:image/png;base64," + b64);
      const bmp = await createImageBitmap(await res.blob());
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height);
    }
    const A = await decode(a), B = await decode(b);
    const w = A.width, h = A.height;
    let ring = 0, inner = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const changed = Math.abs(A.data[i] - B.data[i]) > 6 ||
                        Math.abs(A.data[i + 1] - B.data[i + 1]) > 6 ||
                        Math.abs(A.data[i + 2] - B.data[i + 2]) > 6;
        if (!changed) continue;
        if (x < pad || y < pad || x >= w - pad || y >= h - pad) ring++; else inner++;
      }
    }
    return { w, h, ring, inner };
  }, { a: beforeB64, b: afterB64, pad });

  return { selector, exists: true, focusVisibleMatched: matched,
    ringRegionChangedPx: diff.ring, innerChangedPx: diff.inner,
    ringVisible: diff.ring > 20, box, pxSize: `${diff.w}x${diff.h}` };
}

/* ---- 1. Focus ring 像素級驗證（關掉所有 animation，做 A/B 對照） ---- */
{
  const { context, page } = await fresh({ width: 1440, height: 900 });
  // 關掉所有動效，令像素差異只可能來自 focus ring
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none !important;transition:none !important}" });
  await page.waitForTimeout(300);
  const probes = [];
  for (const sel of ["#btn-mode", "#btn-search", "#btn-about", "#btn-share", "#btn-theme", "#btn-help",
                     "#map-zoom-in", "#legend-lang-btn", ".ch-pill"]) {
    probes.push(await focusRingPixels(page, sel));
  }
  out.focusRingPixels = probes;
  // 對照組：暫時移除 clip-path，睇 focus ring 會唔會出現（證明 clip-path 係元兇）
  await page.addStyleTag({ content: ".nav-btn,.map-ctrl,.legend-lang-btn{clip-path:none !important}" });
  await page.waitForTimeout(300);
  const control = [];
  for (const sel of ["#btn-mode", "#btn-search", "#map-zoom-in", "#legend-lang-btn"]) {
    control.push(await focusRingPixels(page, sel));
  }
  out.focusRingPixelsWithoutClipPath = control;
  await context.close();
}

/* ---- 2. Touch target 間距（相鄰可點元素有幾近） ---- */
{
  const { context, page } = await fresh({ width: 390, height: 844, hasTouch: true });
  out.touchSpacing = await page.evaluate(() => {
    function gaps(sel) {
      const els = Array.from(document.querySelectorAll(sel)).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      });
      let minGap = Infinity, minPair = null;
      for (let i = 0; i < els.length - 1; i++) {
        const a = els[i].getBoundingClientRect(), b = els[i + 1].getBoundingClientRect();
        const gap = Math.max(b.left - a.right, 0);
        if (gap < minGap) { minGap = gap; minPair = [els[i].textContent.trim().slice(0, 6), els[i + 1].textContent.trim().slice(0, 6)]; }
      }
      return { count: els.length, minGapPx: isFinite(minGap) ? +minGap.toFixed(1) : null, minPair };
    }
    return {
      chapterPills: gaps(".ch-pill"),
      navButtons: gaps("#topbar nav .nav-btn"),
      mapCtrls: gaps(".map-ctrl"),
    };
  });
  // 44px target 需要幾多 px 間距（WCAG 2.5.8 Target Size (Minimum) 允許 24px 或足夠間距）
  await context.close();
}

/* ---- 3. Legend 對地圖嘅實際遮蓋 ---- */
{
  for (const vp of [{ id: "mobile-390", width: 390, height: 844, hasTouch: true },
                    { id: "tablet-768", width: 768, height: 1024, hasTouch: true },
                    { id: "desktop-1440", width: 1440, height: 900, hasTouch: false }]) {
    const { context, page } = await fresh(vp);
    out[`legend_${vp.id}`] = await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const map = document.querySelector("#svg-map-mount").getBoundingClientRect();
      const overlay = document.querySelector("#map-overlay").getBoundingClientRect();
      const legend = document.querySelector("#map-legend").getBoundingClientRect();
      const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
                             Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return {
        viewport: { vw, vh },
        map: { w: +map.width.toFixed(1), h: +map.height.toFixed(1) },
        overlay: { w: +overlay.width.toFixed(1), h: +overlay.height.toFixed(1),
          areaPctOfViewport: +((overlay.width * overlay.height) / (vw * vh) * 100).toFixed(1),
          areaPctOfMap: +((overlay.width * overlay.height) / (map.width * map.height) * 100).toFixed(1),
          widthPctOfMap: +(overlay.width / map.width * 100).toFixed(1),
          heightPctOfMap: +(overlay.height / map.height * 100).toFixed(1) },
        legend: { w: +legend.width.toFixed(1), h: +legend.height.toFixed(1),
          areaPctOfMap: +((legend.width * legend.height) / (map.width * map.height) * 100).toFixed(1) },
        overlayCoversMapPct: +(inter(overlay, map) / (map.width * map.height) * 100).toFixed(1),
        legendItemCount: document.querySelectorAll("#map-legend .legend-item").length,
        legendFontSize: getComputedStyle(document.querySelector("#map-legend")).fontSize,
        mapControlsCoverMapPct: (() => {
          const c = document.querySelector(".map-controls").getBoundingClientRect();
          return +(inter(c, map) / (map.width * map.height) * 100).toFixed(2);
        })(),
        /** 地圖實際可自由互動嘅面積（扣 legend + zoom 控制） */
        freeMapAreaPct: +((map.width * map.height
          - inter(document.querySelector("#map-overlay").getBoundingClientRect(), map)
          - inter(document.querySelector(".map-controls").getBoundingClientRect(), map))
          / (map.width * map.height) * 100).toFixed(1),
      };
    });
    await context.close();
  }
}

/* ---- 4. safe-area 模擬：viewport-fit=cover 之下嘅表現 ---- */
{
  const { context, page } = await fresh({ width: 390, height: 844, hasTouch: true });
  out.safeAreaSimulation = await page.evaluate(() => {
    // 讀 meta viewport
    const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content");
    // 檢查有冇任何元素用 env(safe-area-inset-*)
    let envRules = [];
    for (const ss of document.styleSheets) {
      let rules; try { rules = ss.cssRules; } catch (e) { continue; }
      const walk = (rs) => { for (const r of rs) {
        if (r.cssRules) walk(r.cssRules);
        if (r.cssText && /safe-area-inset/.test(r.cssText)) envRules.push(r.cssText.slice(0, 120));
      } };
      if (rules) walk(rules);
    }
    const c = document.querySelector(".map-controls").getBoundingClientRect();
    const p = document.querySelector("#btn-toggle-panel").getBoundingClientRect();
    const t = document.querySelector("#topbar").getBoundingClientRect();
    // 典型 iPhone 直立 safe area：top 47 / bottom 34 / left 0 / right 0
    const inset = { top: 47, bottom: 34, left: 0, right: 0 };
    return {
      viewportMeta: meta,
      hasViewportFitCover: /viewport-fit\s*=\s*cover/.test(meta || ""),
      envRulesCount: envRules.length,
      envRulesSample: envRules.slice(0, 5),
      mapControlsBottomGap: +(innerHeight - c.bottom).toFixed(1),
      mapControlsRightGap: +(innerWidth - c.right).toFixed(1),
      mapControlsInsideHomeIndicatorZone: (innerHeight - c.bottom) < inset.bottom,
      topbarTopGap: +t.top.toFixed(1),
      topbarInsideNotchZone: t.top < inset.top,
      panelToggleRightGap: +(innerWidth - p.right).toFixed(1),
      panelToggleTopGap: +p.top.toFixed(1),
      assumption: inset,
    };
  });
  await context.close();
}

/* ---- 5. 橫向 overflow：強制窄螢幕 320px ---- */
{
  const { context, page } = await fresh({ width: 320, height: 568, hasTouch: true });
  out.narrow320 = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    hasOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    topbarH: +document.querySelector("#topbar").getBoundingClientRect().height.toFixed(1),
    navBtnCount: document.querySelectorAll("#topbar nav .nav-btn").length,
    navRows: new Set(Array.from(document.querySelectorAll("#topbar nav .nav-btn"))
      .map((b) => Math.round(b.getBoundingClientRect().top))).size,
    h1: (() => { const r = document.querySelector("#topbar h1").getBoundingClientRect();
      return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
    legendAreaPctOfViewport: (() => { const r = document.querySelector("#map-overlay").getBoundingClientRect();
      return +((r.width * r.height) / (innerWidth * innerHeight) * 100).toFixed(1); })(),
    mapMountH: +document.querySelector("#svg-map-mount").getBoundingClientRect().height.toFixed(1),
  }));
  await page.screenshot({ path: path.join(OUT, "a7-mobile-320.png") });
  await context.close();
}

/* ---- 6. 觸控手勢：地圖單指平移是否可用（touch 實測） ---- */
{
  const { context, page } = await fresh({ width: 390, height: 844, hasTouch: true });
  const vb0 = await page.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));
  // 用 touchscreen 模擬單指拖拽（由地圖中央向下拖）
  await page.touchscreen.tap(200, 500);
  await page.waitForTimeout(100);
  const box = await page.evaluate(() => { const r = document.querySelector("#svg-map").getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; });
  // dispatch 合成 touch 事件
  const vb1 = await page.evaluate(async ({ cx, cy }) => {
    const svg = document.querySelector("#svg-map");
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 1, target: svg, clientX: x, clientY: y });
      return new TouchEvent(type, { touches: type === "touchend" ? [] : [t],
        targetTouches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true });
    };
    svg.dispatchEvent(mk("touchstart", cx, cy));
    svg.dispatchEvent(mk("touchmove", cx - 60, cy - 60));
    svg.dispatchEvent(mk("touchend", cx - 60, cy - 60));
    await new Promise((r) => setTimeout(r, 400));
    return svg.getAttribute("viewBox");
  }, box);
  out.touchPan = { before: vb0, after: vb1, works: vb0 !== vb1 };
  await context.close();
}

fs.writeFileSync(path.join(OUT, "a7-focus-verify.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();

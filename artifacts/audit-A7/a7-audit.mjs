/**
 * A7 Mobile / A11y Specialist —— 只讀審計腳本
 *
 * 用途：對現行 production 版本做**程式化**量測（mobile 390×844 / tablet 768 /
 *      desktop 1440），輸出可稽核 JSON + screenshot。本腳本只讀 production
 *      code，只寫 `artifacts/audit-A7/`。
 *
 * 執行：
 *   node artifacts/audit-A7/a7-audit.mjs
 *
 * 環境：
 *   - preview server 必須用 `localhost`（vite preview 只綁 IPv6 [::1]）
 *   - Chromium 要加 `--no-proxy-server`（環境有 http_proxy）
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

/* ══════════════════════════════════════════════════════════════════════
 * 頁面內注入嘅量測工具（所有量測必須程式化，唔可以人手目測）
 * ══════════════════════════════════════════════════════════════════════ */
const IN_PAGE = `
window.__a7 = {};

/* ---- 顏色工具：parse rgb/rgba、alpha 合成、relative luminance、contrast ---- */
window.__a7.parseColor = function (s) {
  if (!s) return null;
  s = String(s).trim();
  if (s === "transparent" || s === "none") return { r: 0, g: 0, b: 0, a: 0 };
  let m = s.match(/^rgba?\\(([^)]+)\\)$/i);
  if (m) {
    const p = m[1].split(/[,\\/]/).map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 6) h += "ff";
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  m = s.match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/i);
  if (m) {
    return { r: parseFloat(m[1]) * 255, g: parseFloat(m[2]) * 255, b: parseFloat(m[3]) * 255,
             a: m[4] === undefined ? 1 : parseFloat(m[4]) };
  }
  return null;
};
window.__a7.over = function (fg, bg) {   // fg 疊喺 bg 上面
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
};
window.__a7.lum = function (c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
window.__a7.ratio = function (c1, c2) {
  const L1 = window.__a7.lum(c1), L2 = window.__a7.lum(c2);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
};
/* 由元素向上累積背景（處理半透明背景 + background-image 視為不透明遮罩） */
window.__a7.effectiveBg = function (el) {
  const layers = [];
  let node = el;
  while (node && node.nodeType === 1) {
    const cs = getComputedStyle(node);
    const bg = window.__a7.parseColor(cs.backgroundColor);
    const hasImg = cs.backgroundImage && cs.backgroundImage !== "none";
    if (bg && bg.a > 0) layers.push(bg);
    // background-image（gradient）當作會蓋住底下 —— 用元素自身 backgroundColor
    // 之外，如果只有 gradient 就標記 uncertain
    if (bg && bg.a >= 0.999) break;
    if (hasImg && !bg) { layers.push({ r: 0, g: 0, b: 0, a: 0, uncertainImage: true }); }
    node = node.parentElement;
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 };   // 預設頁面底：白
  for (let i = layers.length - 1; i >= 0; i--) acc = window.__a7.over(layers[i], acc);
  return acc;
};
window.__a7.selector = function (el) {
  if (!el || el.nodeType !== 1) return "";
  const parts = [];
  let n = el, depth = 0;
  while (n && n.nodeType === 1 && depth < 4) {
    let s = n.tagName.toLowerCase();
    if (n.id) { s += "#" + n.id; parts.unshift(s); break; }
    if (n.classList && n.classList.length) s += "." + Array.from(n.classList).slice(0, 3).join(".");
    parts.unshift(s);
    n = n.parentElement; depth++;
  }
  return parts.join(" > ");
};
window.__a7.textOf = function (el) {
  let t = "";
  for (const c of el.childNodes) if (c.nodeType === 3) t += c.textContent;
  t = t.replace(/\\s+/g, " ").trim();
  return t;
};
window.__a7.visible = function (el) {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return true;
};

/* ---- 1. 佈局量測 ---- */
window.__a7.layout = function () {
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
             areaPct: +((b.width * b.height) / (vw * vh) * 100).toFixed(1) }; };
  const topbar = document.querySelector("#topbar");
  const h1 = document.querySelector("#topbar h1");
  let titleLines = null, titleLineHeight = null;
  if (h1) {
    const cs = getComputedStyle(h1);
    titleLineHeight = cs.lineHeight === "normal" ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
    titleLines = Math.round(h1.getBoundingClientRect().height / titleLineHeight);
  }
  // nav 按鈕分幾多行
  const navBtns = Array.from(document.querySelectorAll("#topbar nav .nav-btn"));
  const rows = new Set(navBtns.map((b) => Math.round(b.getBoundingClientRect().top)));
  const navBtnRects = navBtns.map((b) => {
    const bb = b.getBoundingClientRect();
    return { id: b.id, text: window.__a7.textOf(b), w: +bb.width.toFixed(1), h: +bb.height.toFixed(1),
             x: +bb.x.toFixed(1), y: +bb.y.toFixed(1) };
  });
  // 橫向 overflow：找出所有右邊超出 viewport 嘅元素
  const overflowers = [];
  document.querySelectorAll("body *").forEach((el) => {
    if (!window.__a7.visible(el)) return;
    const b = el.getBoundingClientRect();
    if (b.right > vw + 0.5 || b.left < -0.5) {
      overflowers.push({ sel: window.__a7.selector(el), left: +b.left.toFixed(1),
        right: +b.right.toFixed(1), w: +b.width.toFixed(1) });
    }
  });
  // 章節摘要截斷
  const sum = document.querySelector("#strip-summary");
  let summaryTrunc = null;
  if (sum) summaryTrunc = { scrollW: sum.scrollWidth, clientW: sum.clientWidth,
    truncated: sum.scrollWidth > sum.clientWidth + 1, text: (sum.textContent || "").slice(0, 80) };
  const strip = document.querySelector(".chapter-strip");
  const mapMount = document.querySelector("#svg-map-mount");
  const paneMap = document.querySelector(".pane-map");
  const paneStory = document.querySelector("#story-pane");
  const ctrls = document.querySelector(".map-controls");
  const ctrlBox = ctrls ? ctrls.getBoundingClientRect() : null;
  const legend = document.querySelector("#map-overlay");
  const legendBox = legend ? legend.getBoundingClientRect() : null;
  return {
    viewport: { w: vw, h: vh, dpr: window.devicePixelRatio },
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    hasHorizontalOverflow: document.documentElement.scrollWidth > vw + 1,
    topbar: r("#topbar"),
    h1: r("#topbar h1"), titleLines, titleLineHeight,
    navRows: rows.size, navBtnRects,
    chapterStrip: strip ? { h: +strip.getBoundingClientRect().height.toFixed(1) } : null,
    stripTrackScroll: (() => { const t = document.querySelector("#strip-track");
      return t ? { scrollW: t.scrollWidth, clientW: t.clientWidth } : null; })(),
    summaryTrunc,
    mapMount: r("#svg-map-mount"), paneMap: r(".pane-map"),
    paneStory: r("#story-pane"),
    paneStoryCollapsed: paneStory ? paneStory.classList.contains("is-collapsed") : null,
    paneStoryTransform: paneStory ? getComputedStyle(paneStory).transform : null,
    legend: legendBox ? { x: +legendBox.x.toFixed(1), y: +legendBox.y.toFixed(1),
      w: +legendBox.width.toFixed(1), h: +legendBox.height.toFixed(1),
      areaPct: +((legendBox.width * legendBox.height) / (vw * vh) * 100).toFixed(1) } : null,
    mapControls: ctrlBox ? { x: +ctrlBox.x.toFixed(1), y: +ctrlBox.y.toFixed(1),
      w: +ctrlBox.width.toFixed(1), h: +ctrlBox.height.toFixed(1),
      gapRight: +(vw - ctrlBox.right).toFixed(1), gapBottom: +(vh - ctrlBox.bottom).toFixed(1) } : null,
    overflowers: overflowers.slice(0, 40),
    safeAreaUsed: (() => {
      // 檢查 stylesheet 有冇用 env(safe-area-inset-*)
      let n = 0;
      for (const ss of document.styleSheets) {
        let rules; try { rules = ss.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.cssText && /env\\(\\s*safe-area-inset/.test(rule.cssText)) n++;
        }
      }
      return n;
    })(),
    viewportMeta: (() => { const m = document.querySelector('meta[name="viewport"]');
      return m ? m.getAttribute("content") : null; })(),
    zoomCtrlRects: Array.from(document.querySelectorAll(".map-ctrl")).map((b) => {
      const bb = b.getBoundingClientRect();
      return { id: b.id, w: +bb.width.toFixed(1), h: +bb.height.toFixed(1) };
    }),
    panelToggleVisible: (() => { const b = document.querySelector("#btn-toggle-panel");
      return b ? window.__a7.visible(b) : null; })(),
    panelToggleExpanded: (() => { const b = document.querySelector("#btn-toggle-panel");
      return b ? b.getAttribute("aria-expanded") : null; })(),
  };
};

/* ---- 2. Touch target 量測（全部可點擊元素，唔抽樣） ---- */
window.__a7.touchTargets = function () {
  const SEL = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="option"],' +
              ' input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const out = [];
  document.querySelectorAll(SEL).forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) return;
    out.push({
      sel: window.__a7.selector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: el.className && typeof el.className === "string" ? el.className : null,
      text: window.__a7.textOf(el).slice(0, 40),
      ariaLabel: el.getAttribute("aria-label"),
      title: el.getAttribute("title"),
      w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      x: +b.x.toFixed(1), y: +b.y.toFixed(1),
      inViewport: b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight,
      fail44: b.width < 44 || b.height < 44,
    });
  });
  // 有 click 語意但完全冇語意標記／冇 tabindex 嘅「假按鈕」
  const PSEUDO = '.event-item, .summary-loc, .char-chip, .route-item, .search-result-item,' +
                 ' .zone, .location-marker, .event-marker, .location-marker-cluster, .route-line, .back-btn';
  const pseudo = [];
  document.querySelectorAll(PSEUDO).forEach((el) => {
    const b = el.getBoundingClientRect();
    pseudo.push({
      sel: window.__a7.selector(el), tag: el.tagName.toLowerCase(),
      w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      tabindex: el.getAttribute("tabindex"), role: el.getAttribute("role"),
      keyboardReachable: el.tabIndex >= 0,
      text: window.__a7.textOf(el).slice(0, 30),
      inViewport: b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight,
    });
  });
  return { targets: out, pseudo };
};

/* ---- 3. ARIA / 語意 ---- */
window.__a7.aria = function () {
  const ariaAttrs = [];
  document.querySelectorAll("*").forEach((el) => {
    for (const a of el.attributes) {
      if (a.name === "role" || a.name.startsWith("aria-")) {
        ariaAttrs.push({ sel: window.__a7.selector(el), attr: a.name, value: a.value,
          text: window.__a7.textOf(el).slice(0, 30) });
      }
    }
  });
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => ({
    level: +h.tagName[1], text: window.__a7.textOf(h).slice(0, 50),
    sel: window.__a7.selector(h), visible: window.__a7.visible(h),
  }));
  const landmarks = Array.from(document.querySelectorAll(
    "header, nav, main, aside, footer, section[aria-label], form, [role=banner], [role=navigation]," +
    "[role=main], [role=complementary], [role=contentinfo], [role=application], [role=dialog], [role=alert]"
  )).map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"),
    label: el.getAttribute("aria-label"), sel: window.__a7.selector(el) }));
  const liveRegions = Array.from(document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]'))
    .map((el) => ({ sel: window.__a7.selector(el), live: el.getAttribute("aria-live"),
      role: el.getAttribute("role"), text: window.__a7.textOf(el).slice(0, 40) }));
  // heading 跳級
  const skips = [];
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level - headings[i - 1].level > 1)
      skips.push({ from: headings[i - 1], to: headings[i] });
  }
  // 圖片／SVG 可存取名稱
  const imgsNoAlt = Array.from(document.querySelectorAll("img")).filter((i) => !i.hasAttribute("alt"))
    .map((i) => window.__a7.selector(i));
  const svgs = Array.from(document.querySelectorAll("svg")).map((s) => ({
    sel: window.__a7.selector(s), role: s.getAttribute("role"),
    ariaLabel: s.getAttribute("aria-label"), ariaHidden: s.getAttribute("aria-hidden"),
    title: !!s.querySelector("title"), desc: !!s.querySelector("desc"),
  }));
  // 有 click 但冇鍵盤可達（語意缺口）
  const interactiveNoSemantics = [];
  document.querySelectorAll("li, span, div").forEach((el) => {
    if (el.getAttribute("role")) return;
    if (el.tabIndex >= 0) return;
    const cls = typeof el.className === "string" ? el.className : "";
    if (/event-item|summary-loc|char-chip|route-item|search-result-item|ch-pill|back-btn/.test(cls)) {
      interactiveNoSemantics.push({ sel: window.__a7.selector(el), cls, text: window.__a7.textOf(el).slice(0, 30) });
    }
  });
  // aria-expanded / aria-current 同步檢查
  const expanded = Array.from(document.querySelectorAll("[aria-expanded]")).map((el) => {
    const ctrl = el.getAttribute("aria-controls");
    const target = ctrl ? document.getElementById(ctrl) : null;
    return { sel: window.__a7.selector(el), expanded: el.getAttribute("aria-expanded"),
      controls: ctrl, targetCollapsed: target ? target.classList.contains("is-collapsed") : null,
      synced: target ? (el.getAttribute("aria-expanded") === String(!target.classList.contains("is-collapsed"))) : null };
  });
  const ariaCurrentCount = document.querySelectorAll("[aria-current]").length;
  const ariaCurrentStyledCount = document.querySelectorAll('.ch-pill[aria-current="true"]').length;
  return { ariaAttrs, headings, skips, landmarks, liveRegions, imgsNoAlt, svgs,
    interactiveNoSemantics: interactiveNoSemantics.slice(0, 30),
    expanded, ariaCurrentCount, ariaCurrentStyledCount,
    lang: document.documentElement.getAttribute("lang"),
    title: document.title };
};

/* ---- 4. Contrast（可見文字） ---- */
window.__a7.contrast = function () {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.replace(/\\s+/g, " ").trim();
    if (t.length === 0) continue;
    const el = node.parentElement;
    if (!el) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    if (b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) {
      // 螢幕外仍然量（但標記）
    }
    const fgRaw = window.__a7.parseColor(cs.color);
    if (!fgRaw) continue;
    const bg = window.__a7.effectiveBg(el);
    const fg = window.__a7.over(fgRaw, bg);
    const ratio = window.__a7.ratio(fg, bg);
    const fs = parseFloat(cs.fontSize);
    const fw = parseInt(cs.fontWeight, 10) || 400;
    const isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const need = isLarge ? 3 : 4.5;
    out.push({
      sel: window.__a7.selector(el), text: t.slice(0, 60),
      color: cs.color, bg: "rgb(" + [bg.r, bg.g, bg.b].map((v) => Math.round(v)).join(",") + ")",
      ratio: +ratio.toFixed(2), fontSize: fs, fontWeight: fw, isLarge, need,
      pass: ratio >= need,
      inViewport: b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth,
    });
  }
  return out;
};

/* ---- 5. Reduced motion：仲有幾多 animation / transition 喺跑 ---- */
window.__a7.motion = function () {
  const running = [];
  document.querySelectorAll("*").forEach((el) => {
    const cs = getComputedStyle(el);
    const an = cs.animationName;
    const hasAnim = an && an !== "none";
    const ad = parseFloat(cs.animationDuration) || 0;
    const ai = cs.animationIterationCount;
    const td = parseFloat(cs.transitionDuration) || 0;
    if (hasAnim && ad > 0.05) {
      running.push({ sel: window.__a7.selector(el), kind: "animation", name: an,
        duration: cs.animationDuration, iteration: ai });
    }
    if (td > 0.05) {
      running.push({ sel: window.__a7.selector(el), kind: "transition", duration: cs.transitionDuration });
    }
  });
  return {
    prefersReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    runningCount: running.length,
    animations: running.filter((r) => r.kind === "animation").length,
    transitions: running.filter((r) => r.kind === "transition").length,
    sample: running.slice(0, 60),
  };
};
`;

/* ══════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════ */

async function newPage(browser, { width, height, dpr = 1, hasTouch = false, reducedMotion, colorScheme } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    hasTouch,
    isMobile: hasTouch,
    reducedMotion: reducedMotion || "no-preference",
    colorScheme: colorScheme || "dark",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  return { context, page, consoleErrors };
}

async function waitReady(page) {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.addScriptTag({ content: IN_PAGE });
  await page.waitForTimeout(1200);
}

const results = {};

/* ---- 逐 viewport 佈局 + touch target + aria ---- */
const VIEWPORTS = [
  { id: "mobile-390", width: 390, height: 844, hasTouch: true },
  { id: "tablet-768", width: 768, height: 1024, hasTouch: true },
  { id: "desktop-1440", width: 1440, height: 900, hasTouch: false },
];

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

for (const vp of VIEWPORTS) {
  const { context, page, consoleErrors } = await newPage(browser, vp);
  await waitReady(page);
  const layout = await page.evaluate(() => window.__a7.layout());
  const touch = await page.evaluate(() => window.__a7.touchTargets());
  const aria = await page.evaluate(() => window.__a7.aria());
  await page.screenshot({ path: path.join(OUT, `a7-baseline-${vp.id}.png`) });
  results[vp.id] = {
    layout, touch, aria, consoleErrors,
    fail44: touch.targets.filter((t) => t.fail44),
    fail44Count: touch.targets.filter((t) => t.fail44).length,
    totalTargets: touch.targets.length,
  };
  await context.close();
}

/* ---- 主題 × contrast ---- */
const contrast = {};
for (const theme of ["dark", "light"]) {
  for (const vp of VIEWPORTS) {
    const { context, page } = await newPage(browser, vp);
    await waitReady(page);
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.waitForTimeout(600);
    const res = await page.evaluate(() => window.__a7.contrast());
    const fails = res.filter((r) => !r.pass);
    contrast[`${theme}-${vp.id}`] = { total: res.length, fails: fails.length, failList: fails,
      all: res.length <= 200 ? res : undefined };
    await page.screenshot({ path: path.join(OUT, `a7-contrast-${theme}-${vp.id}.png`) });
    await context.close();
  }
}
results.contrast = contrast;

/* ---- Reduced motion ---- */
const motion = {};
{
  const { context, page } = await newPage(browser, { width: 390, height: 844, hasTouch: true,
    reducedMotion: "reduce" });
  await waitReady(page);
  motion.mobileReduce = await page.evaluate(() => window.__a7.motion());
  // 亦檢查 StoryPanel 過場（切章）
  await page.evaluate(() => { const b = document.querySelector(".ch-pill"); if (b) b.click(); });
  await page.waitForTimeout(300);
  motion.mobileReduceAfterChapterSwitch = await page.evaluate(() => window.__a7.motion());
  await context.close();
}
{
  const { context, page } = await newPage(browser, { width: 390, height: 844, hasTouch: true });
  await waitReady(page);
  motion.mobileNoPreference = await page.evaluate(() => window.__a7.motion());
  await context.close();
}
{
  const { context, page } = await newPage(browser, { width: 1440, height: 900, reducedMotion: "reduce" });
  await waitReady(page);
  motion.desktopReduce = await page.evaluate(() => window.__a7.motion());
  await context.close();
}
results.motion = motion;

/* ---- Keyboard：Tab 順序 ---- */
const keyboard = {};
{
  const { context, page } = await newPage(browser, { width: 390, height: 844, hasTouch: true });
  await waitReady(page);
  await page.evaluate(() => document.body.focus());
  const seq = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return null;
      const b = a.getBoundingClientRect();
      const cs = getComputedStyle(a);
      return { tag: a.tagName.toLowerCase(), id: a.id || null,
        cls: typeof a.className === "string" ? a.className.slice(0, 60) : null,
        text: (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30),
        ariaLabel: a.getAttribute("aria-label"),
        w: +b.width.toFixed(1), h: +b.height.toFixed(1),
        x: +b.x.toFixed(1), y: +b.y.toFixed(1),
        outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor,
        boxShadow: cs.boxShadow.slice(0, 60),
        offscreen: b.width === 0 || b.height === 0 || b.right < 0 || b.bottom < 0 };
    });
    seq.push(info);
  }
  keyboard.mobileTabSeq = seq;

  // skip link 是否真係 work
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map");
  await page.addScriptTag({ content: IN_PAGE });
  await page.waitForTimeout(1000);
  const skip = await page.evaluate(() => {
    const el = document.querySelector(".skip-link");
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    return { exists: true, href: el.getAttribute("href"), top: cs.top, position: cs.position };
  });
  await page.keyboard.press("Tab");
  const afterFirstTab = await page.evaluate(() => ({ id: document.activeElement?.id,
    cls: document.activeElement?.className, text: document.activeElement?.textContent?.trim().slice(0, 20) }));
  const skipFocusedStyle = await page.evaluate(() => {
    const el = document.querySelector(".skip-link");
    return el ? { top: getComputedStyle(el).top, visible: el.getBoundingClientRect().top >= 0 } : null;
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const afterSkipEnter = await page.evaluate(() => ({
    activeId: document.activeElement?.id || null,
    activeTag: document.activeElement?.tagName,
    hash: location.hash,
    mapPaneTabIndex: document.querySelector("#map-pane")?.getAttribute("tabindex"),
    scrollY: window.scrollY,
  }));
  keyboard.skipLink = { skip, afterFirstTab, skipFocusedStyle, afterSkipEnter };

  // Esc 行為：開 search → Esc
  await page.evaluate(() => document.querySelector("#btn-search").click());
  await page.waitForTimeout(300);
  const searchOpen = await page.evaluate(() => ({
    open: document.querySelector("#search-modal")?.classList.contains("open"),
    activeId: document.activeElement?.id,
    role: document.querySelector("#search-modal .modal-content")?.getAttribute("role"),
    ariaModal: document.querySelector("#search-modal .modal-content")?.getAttribute("aria-modal"),
    ariaLabel: document.querySelector("#search-modal .modal-content")?.getAttribute("aria-label"),
    inputRole: document.querySelector("#search-input")?.getAttribute("role"),
    listboxRole: document.querySelector("#search-results")?.getAttribute("role"),
  }));
  // 打字搜尋，測鍵盤可唔可以揀結果
  await page.keyboard.type("將軍");
  await page.waitForTimeout(500);
  const searchResults = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".search-result-item"));
    return { count: items.length,
      firstItem: items[0] ? { tag: items[0].tagName, tabindex: items[0].getAttribute("tabindex"),
        role: items[0].getAttribute("role"), text: items[0].textContent.trim().slice(0, 40) } : null,
      firstThreeFocusable: items.slice(0, 3).map((i) => i.tabIndex) };
  });
  // 試 ArrowDown + Enter（搜尋結果鍵盤導航）
  await page.keyboard.press("ArrowDown");
  const afterArrowDown = await page.evaluate(() => ({ activeId: document.activeElement?.id,
    activeCls: document.activeElement?.className }));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const afterEsc = await page.evaluate(() => ({
    open: document.querySelector("#search-modal")?.classList.contains("open"),
    activeId: document.activeElement?.id || null,
    activeTag: document.activeElement?.tagName }));
  keyboard.search = { searchOpen, searchResults, afterArrowDown, afterEsc };

  // AboutModal focus 管理
  await page.evaluate(() => document.querySelector("#btn-about").click());
  await page.waitForTimeout(400);
  const aboutOpen = await page.evaluate(() => {
    const m = document.querySelector("#about-modal");
    const content = m?.querySelector(".modal-content");
    return { open: m?.classList.contains("open"),
      role: content?.getAttribute("role"), ariaModal: content?.getAttribute("aria-modal"),
      ariaLabelledby: content?.getAttribute("aria-labelledby"),
      activeTag: document.activeElement?.tagName, activeId: document.activeElement?.id,
      h2Count: m?.querySelectorAll("h2").length,
      focusInsideModal: m ? m.contains(document.activeElement) : null };
  });
  // 開住 modal 時 Tab 會唔會走出 modal（focus trap 測試）
  const trapSeq = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const m = document.querySelector("#about-modal");
      const a = document.activeElement;
      return { id: a?.id || null, tag: a?.tagName,
        insideModal: m ? m.contains(a) : false };
    });
    trapSeq.push(info);
  }
  keyboard.aboutModal = { aboutOpen, trapSeq,
    escaped: trapSeq.some((t) => !t.insideModal) };

  // 關 modal 後，關咗嘅 modal 仲可唔可以被 Tab 到？
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterCloseModal = await page.evaluate(() => ({
    open: document.querySelector("#about-modal")?.classList.contains("open"),
    stillInDom: !!document.querySelector("#about-modal"),
    closeBtnTabIndex: document.querySelector("#about-close")?.tabIndex,
    closeBtnVisible: (() => { const b = document.querySelector("#about-close");
      if (!b) return null; const r = b.getBoundingClientRect();
      return { w: r.width, h: r.height, opacity: getComputedStyle(b).opacity,
        pointerEvents: getComputedStyle(document.querySelector("#about-modal")).pointerEvents }; })(),
    activeId: document.activeElement?.id || null,
    activeTag: document.activeElement?.tagName,
  }));
  keyboard.aboutModal.afterClose = afterCloseModal;
  await context.close();
}

/* ---- Keyboard：desktop Tab 順序 ---- */
{
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await waitReady(page);
  const seq = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return null;
      return { tag: a.tagName.toLowerCase(), id: a.id || null,
        text: (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 24) };
    });
    seq.push(info);
  }
  keyboard.desktopTabSeq = seq;
  // 方向鍵：ArrowRight 應該改章節
  const before = await page.evaluate(() => document.querySelector("#strip-ch-num")?.textContent);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelector("#strip-ch-num")?.textContent);
  keyboard.arrowRightChangesChapter = { before, after, works: before !== after };
  await context.close();
}

results.keyboard = keyboard;

/* ---- Mobile：story panel 行為 / bottom sheet 評估 ---- */
const panel = {};
{
  const { context, page } = await newPage(browser, { width: 390, height: 844, hasTouch: true });
  await waitReady(page);
  panel.initial = await page.evaluate(() => {
    const p = document.querySelector("#story-pane");
    const r = p.getBoundingClientRect();
    return { collapsed: p.classList.contains("is-collapsed"),
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      position: getComputedStyle(p).position, transform: getComputedStyle(p).transform,
      width: getComputedStyle(p).width, top: getComputedStyle(p).top,
      bottom: getComputedStyle(p).bottom,
      hasDragHandle: !!document.querySelector("[class*=drag], [class*=sheet], [class*=grab]"),
      hasBottomSheetClass: !!document.querySelector(".bottom-sheet, [data-sheet]"),
      storyPaneRole: p.getAttribute("role"), storyPaneAriaLabel: p.getAttribute("aria-label"),
      ariaHidden: p.getAttribute("aria-hidden"),
      inert: p.hasAttribute("inert"),
      focusableWhenCollapsed: (() => {
        const f = p.querySelectorAll("button, a[href], input, [tabindex]");
        return Array.from(f).filter((e) => e.tabIndex >= 0).length;
      })(),
    };
  });
  // 開 panel
  await page.evaluate(() => document.querySelector("#btn-toggle-panel").click());
  await page.waitForTimeout(500);
  panel.afterOpen = await page.evaluate(() => {
    const p = document.querySelector("#story-pane");
    const r = p.getBoundingClientRect();
    const btn = document.querySelector("#btn-toggle-panel");
    return { collapsed: p.classList.contains("is-collapsed"),
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      ariaExpanded: btn.getAttribute("aria-expanded"),
      coversMapPct: +((r.width * r.height) / (innerWidth * innerHeight) * 100).toFixed(1),
      focusMovedIntoPanel: p.contains(document.activeElement) };
  });
  // Esc 關唔關到 panel？
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  panel.afterEsc = await page.evaluate(() => {
    const p = document.querySelector("#story-pane");
    return { collapsed: p.classList.contains("is-collapsed"),
      ariaExpanded: document.querySelector("#btn-toggle-panel").getAttribute("aria-expanded"),
      stillFocusable: Array.from(p.querySelectorAll("button, a[href], input, [tabindex]"))
        .filter((e) => e.tabIndex >= 0).length };
  });
  await context.close();
}
results.panel = panel;

/* ---- Zoom 控制 touch 行為（實測 tap） ---- */
const zoomTouch = {};
{
  const { context, page } = await newPage(browser, { width: 390, height: 844, hasTouch: true });
  await waitReady(page);
  const vb0 = await page.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));
  await page.tap("#map-zoom-in");
  await page.waitForTimeout(400);
  const vb1 = await page.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));
  zoomTouch.mobile = { before: vb0, afterTap: vb1, works: vb0 !== vb1 };
  // 目標尺寸
  zoomTouch.ctrlSizes = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".map-ctrl")).map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.id, w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    }));
  await context.close();
}
results.zoomTouch = zoomTouch;

/* ---- 輸出 ---- */
fs.writeFileSync(path.join(OUT, "a7-audit-results.json"), JSON.stringify(results, null, 2));

/* ---- 摘要 ---- */
const summary = {
  "mobile-390": {
    headerH: results["mobile-390"].layout.topbar?.h,
    titleLines: results["mobile-390"].layout.titleLines,
    navRows: results["mobile-390"].layout.navRows,
    horizontalOverflow: results["mobile-390"].layout.hasHorizontalOverflow,
    docScrollWidth: results["mobile-390"].layout.docScrollWidth,
    legendAreaPct: results["mobile-390"].layout.legend?.areaPct,
    legendBox: results["mobile-390"].layout.legend,
    mapMount: results["mobile-390"].layout.mapMount,
    mapControlsGapRight: results["mobile-390"].layout.mapControls?.gapRight,
    mapControlsGapBottom: results["mobile-390"].layout.mapControls?.gapBottom,
    safeAreaCssRuleCount: results["mobile-390"].layout.safeAreaUsed,
    viewportMeta: results["mobile-390"].layout.viewportMeta,
    overflowers: results["mobile-390"].layout.overflowers.length,
    totalTargets: results["mobile-390"].totalTargets,
    fail44Count: results["mobile-390"].fail44Count,
  },
  "tablet-768": {
    headerH: results["tablet-768"].layout.topbar?.h,
    titleLines: results["tablet-768"].layout.titleLines,
    navRows: results["tablet-768"].layout.navRows,
    horizontalOverflow: results["tablet-768"].layout.hasHorizontalOverflow,
    legendAreaPct: results["tablet-768"].layout.legend?.areaPct,
    mapMount: results["tablet-768"].layout.mapMount,
    totalTargets: results["tablet-768"].totalTargets,
    fail44Count: results["tablet-768"].fail44Count,
    paneStoryCollapsed: results["tablet-768"].layout.paneStoryCollapsed,
  },
  "desktop-1440": {
    legendAreaPct: results["desktop-1440"].layout.legend?.areaPct,
    mapMount: results["desktop-1440"].layout.mapMount,
    fail44Count: results["desktop-1440"].fail44Count,
    totalTargets: results["desktop-1440"].totalTargets,
  },
  contrast: Object.fromEntries(Object.entries(contrast).map(([k, v]) => [k, { total: v.total, fails: v.fails }])),
  motion: {
    mobileReduceRunning: motion.mobileReduce.runningCount,
    mobileReduceAnimations: motion.mobileReduce.animations,
    mobileReduceTransitions: motion.mobileReduce.transitions,
    desktopReduceRunning: motion.desktopReduce.runningCount,
    mobileNoPrefRunning: motion.mobileNoPreference.runningCount,
  },
  panel,
  zoomTouch,
};
fs.writeFileSync(path.join(OUT, "a7-audit-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

await browser.close();

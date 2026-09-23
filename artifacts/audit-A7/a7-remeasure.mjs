/**
 * A7 補量測 #2：嚴格重新量度（修正上一輪方法論缺陷）
 *
 * 修正點：
 *  A. Touch target —— 上一輪只檢查 display/visibility/opacity + 非零 box，
 *     冇檢查 (1) 元素中心點係唔係真喺 viewport 內、(2) 有冇被其他元素遮蓋。
 *     結果 2,721 個喺 collapsed story pane（transform 移出畫面）嘅 chronicle
 *     按鈕都被當成「可見 touch target」，令 fail44Count 由 24 暴漲到 3,131。
 *  B. Contrast —— 上一輪行 document.body 全部 text node，同樣包含
 *     160,405px 高、離屏嘅 chronicle 文字，令分母變成 8,423。
 *
 * 本腳本同時量：嚴格 touch target、contrast（分「畫面上」／「離屏」）、
 * Tab 順序首 20、ARIA/語意、reduced-motion、panel 行為。
 *
 * 執行：node artifacts/audit-A7/a7-remeasure.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5190/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

/* ══════════════ 注入用 helper ══════════════ */
const HELPERS = String.raw`
window.__r = {};
window.__r.sel = function (el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) return el.tagName.toLowerCase() + "#" + el.id;
  const cls = typeof el.className === "string" && el.className.trim()
    ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
  let s = el.tagName.toLowerCase() + cls;
  const p = el.parentElement;
  if (p && p.id) s = p.tagName.toLowerCase() + "#" + p.id + " > " + s;
  return s;
};
window.__r.text = function (el) {
  let t = "";
  for (const c of el.childNodes) if (c.nodeType === 3) t += c.textContent;
  return t.replace(/\s+/g, " ").trim();
};
window.__r.name = function (el) {
  const al = el.getAttribute && el.getAttribute("aria-label");
  if (al) return al;
  const t = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (t) return t.slice(0, 40);
  return (el.getAttribute && (el.getAttribute("title") || el.getAttribute("alt"))) || "";
};
/* 可見性 + 遮蓋 + 是否喺 viewport 內 */
window.__r.probe = function (el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const out = { display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
    w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.x.toFixed(1), y: +r.y.toFixed(1),
    inViewport: r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
    fullyInViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    centerInViewport: (r.x + r.width / 2) >= 0 && (r.x + r.width / 2) <= innerWidth &&
                      (r.y + r.height / 2) >= 0 && (r.y + r.height / 2) <= innerHeight,
    clippedByAncestor: null, ariaHiddenAncestor: null, inertAncestor: null, occludedBy: null };
  let n = el, d = 0;
  while (n && n.nodeType === 1 && d < 60) {
    const pcs = getComputedStyle(n);
    if (pcs.display === "none" || pcs.visibility === "hidden") out.display = "ancestor-hidden(" + window.__r.sel(n) + ")";
    if (!out.ariaHiddenAncestor && n.getAttribute && n.getAttribute("aria-hidden") === "true") out.ariaHiddenAncestor = window.__r.sel(n);
    if (!out.inertAncestor && n.hasAttribute && n.hasAttribute("inert")) out.inertAncestor = window.__r.sel(n);
    if (!out.clippedByAncestor && pcs.overflow !== "visible" && n !== el) {
      const pr = n.getBoundingClientRect();
      if (pr.right <= r.left + 0.5 || pr.left >= r.right - 0.5 || pr.bottom <= r.top + 0.5 || pr.top >= r.bottom - 0.5)
        out.clippedByAncestor = window.__r.sel(n) + "{overflow:" + pcs.overflow + "}";
    }
    n = n.parentElement; d++;
  }
  if (out.centerInViewport) {
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (top && !(top === el || el.contains(top))) out.occludedBy = window.__r.sel(top);
  }
  out.reallyVisible = out.display !== "none" && !String(out.display).startsWith("ancestor-hidden") &&
    out.visibility === "visible" && parseFloat(out.opacity) > 0 &&
    out.w > 0 && out.h > 0 && out.centerInViewport && !out.occludedBy &&
    !out.ariaHiddenAncestor && !out.inertAncestor && !out.clippedByAncestor;
  return out;
};
/* 顏色工具 */
window.__r.parse = function (s) {
  if (!s) return null; s = String(s).trim();
  if (s === "transparent" || s === "none") return { r: 0, g: 0, b: 0, a: 0 };
  let m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(/[,\/]/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) { let h = m[1]; if (h.length === 3) h = h.split("").map((c) => c + c).join(""); if (h.length === 6) h += "ff";
    return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16), a: parseInt(h.slice(6,8),16)/255 }; }
  m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i);
  if (m) return { r: +m[1]*255, g: +m[2]*255, b: +m[3]*255, a: m[4] === undefined ? 1 : +m[4] };
  return null;
};
window.__r.over = function (fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a); if (a === 0) return { r:0,g:0,b:0,a:0 };
  return { r: (fg.r*fg.a + bg.r*bg.a*(1-fg.a))/a, g: (fg.g*fg.a + bg.g*bg.a*(1-fg.a))/a,
           b: (fg.b*fg.a + bg.b*bg.a*(1-fg.a))/a, a };
};
window.__r.lum = function (c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b); };
window.__r.ratio = function (a, b) { const L1 = window.__r.lum(a), L2 = window.__r.lum(b);
  const hi = Math.max(L1,L2), lo = Math.min(L1,L2); return (hi+0.05)/(lo+0.05); };
/* 有效背景：向上累積不透明背景；有 gradient/圖就標 uncertain */
window.__r.bg = function (el) {
  const layers = []; let uncertain = false; let node = el, d = 0;
  while (node && node.nodeType === 1 && d < 60) {
    const cs = getComputedStyle(node);
    const c = window.__r.parse(cs.backgroundColor);
    const hasImg = cs.backgroundImage && cs.backgroundImage !== "none";
    if (c && c.a > 0) layers.push(c);
    if (hasImg && (!c || c.a < 0.999)) uncertain = true;
    if (c && c.a >= 0.999) break;
    node = node.parentElement; d++;
  }
  let acc = { r:255, g:255, b:255, a:1 };
  for (let i = layers.length - 1; i >= 0; i--) acc = window.__r.over(layers[i], acc);
  return { bg: acc, uncertain };
};
/* 真正可互動（排除 SVG 內部幾何） */
window.__r.isInteractive = function (el) {
  const tag = el.tagName.toLowerCase(), ns = el.namespaceURI;
  const role = (el.getAttribute("role") || "").toLowerCase();
  const svgGeom = ns === "http://www.w3.org/2000/svg" && tag !== "svg";
  const tags = ["button","a","input","select","textarea","summary"];
  const roles = ["button","link","tab","option","menuitem","menuitemcheckbox","menuitemradio",
    "checkbox","radio","switch","combobox","searchbox","textbox","slider","spinbutton"];
  if (tags.includes(tag)) {
    if (tag === "a" && !el.hasAttribute("href")) return { real:false, why:"a 冇 href" };
    if (tag === "input" && el.type === "hidden") return { real:false, why:"input[type=hidden]" };
    return { real:true, why:"語意 <" + tag + ">" };
  }
  if (roles.includes(role)) return { real:true, why:"role=" + role };
  if (el.hasAttribute("tabindex") && parseInt(el.getAttribute("tabindex"),10) >= 0)
    return svgGeom ? { real:false, why:"SVG 幾何 + tabindex" } : { real:true, why:"tabindex=" + el.getAttribute("tabindex") };
  return { real:false, why:"冇互動語意" };
};
/* 條例例外：正文內 inline link（WCAG 2.5.8 inline exception） */
window.__r.isInlineLink = function (el) {
  if (el.tagName.toLowerCase() !== "a") return false;
  const cs = getComputedStyle(el);
  if (cs.display !== "inline") return false;
  const p = el.parentElement;
  if (!p) return false;
  const pt = (p.textContent || "").trim().length;
  return pt > el.textContent.trim().length + 4;   // 同一段有更多文字 → 視為 inline
};
`;

/* ══════════════ 1. 嚴格 touch target ══════════════ */
const TOUCH_FN = String.raw`
window.__r.touch = function () {
  const SEL = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="option"],' +
    ' [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"],' +
    ' input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const raw = [], real = [], violations = [], inlineExceptions = [], occluded = [], offscreenReal = [];
  for (const el of document.querySelectorAll(SEL)) {
    const iv = window.__r.isInteractive(el);
    const p = window.__r.probe(el);
    const row = { sel: window.__r.sel(el), tag: el.tagName.toLowerCase(),
      name: window.__r.name(el), w: p.w, h: p.h, x: p.x, y: p.y,
      tabindex: el.getAttribute("tabindex"), role: el.getAttribute("role"),
      interactive: iv.real, why: iv.why,
      reallyVisible: p.reallyVisible, occludedBy: p.occludedBy, inViewport: p.inViewport,
      centerInViewport: p.centerInViewport, ariaHiddenAncestor: p.ariaHiddenAncestor,
      inertAncestor: p.inertAncestor, clippedByAncestor: p.clippedByAncestor };
    raw.push(row);
    if (!iv.real) continue;
    if (p.reallyVisible) {
      real.push(row);
      const small = p.w < 44 || p.h < 44;
      if (small) {
        if (window.__r.isInlineLink(el)) inlineExceptions.push(row);
        else violations.push(row);
      }
    } else if (iv.real && !p.ariaHiddenAncestor && !p.inertAncestor) {
      if (p.occludedBy) occluded.push(row); else offscreenReal.push(row);
    }
  }
  // WCAG 2.2 SC 2.5.8 (>=24x24 或足夠間距) —— 只針對真違規
  const tooSmall24 = violations.filter((v) => v.w < 24 || v.h < 24);
  return {
    rawCount: raw.length,
    realInteractiveVisibleCount: real.length,
    violationCount: violations.length,
    violations,
    inlineLinkExceptionCount: inlineExceptions.length,
    inlineLinkExceptions: inlineExceptions,
    occludedRealCount: occluded.length,
    occludedSample: occluded.slice(0, 20),
    offscreenRealCount: offscreenReal.length,
    offscreenRealSample: offscreenReal.slice(0, 10),
    wcag258TooSmall24Count: tooSmall24.length,
    wcag258TooSmall24: tooSmall24.map((v) => ({ sel: v.sel, name: v.name, w: v.w, h: v.h })),
    minSizes: {
      smallest: violations.slice().sort((a,b) => (a.w*a.h) - (b.w*b.h)).slice(0, 6).map((v) => v.sel + " " + v.w + "x" + v.h),
    },
  };
};
`;

/* ══════════════ 2. 嚴格 contrast ══════════════ */
const CONTRAST_FN = String.raw`
window.__r.contrast = function () {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const rows = [], seen = new Set(); let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.replace(/\s+/g, " ").trim();
    if (!t) continue;
    const el = node.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const p = window.__r.probe(el);
    if (p.display === "none" || p.visibility === "hidden" || parseFloat(p.opacity) === 0) continue;
    if (p.w === 0 || p.h === 0) continue;
    const cs = getComputedStyle(el);
    const fgRaw = window.__r.parse(cs.color); if (!fgRaw) continue;
    const b = window.__r.bg(el);
    const fg = window.__r.over(fgRaw, b.bg);
    const ratio = window.__r.ratio(fg, b.bg);
    const fs = parseFloat(cs.fontSize), fw = parseInt(cs.fontWeight, 10) || 400;
    const isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const need = isLarge ? 3 : 4.5;
    const row = { sel: window.__r.sel(el), text: t.slice(0, 50), color: cs.color,
      bg: "rgb(" + [b.bg.r,b.bg.b===undefined?0:b.bg.b].map(()=>0).join("") + ")", // placeholder
      bgStr: "rgb(" + [b.bg.r, b.bg.g, b.bg.b].map((v) => Math.round(v)).join(",") + ")",
      ratio: +ratio.toFixed(2), fontSize: fs, fontWeight: fw, isLarge, need,
      pass: ratio >= need, uncertainBg: b.uncertain,
      inViewport: p.inViewport, centerInViewport: p.centerInViewport,
      occludedBy: p.occludedBy, ariaHiddenAncestor: p.ariaHiddenAncestor, inertAncestor: p.inertAncestor,
      reallyVisible: p.reallyVisible };
    rows.push(row);
  }
  const onScreen = rows.filter((r) => r.centerInViewport && !r.occludedBy && !r.ariaHiddenAncestor && !r.inertAncestor);
  const offscreen = rows.filter((r) => !(r.centerInViewport && !r.occludedBy && !r.ariaHiddenAncestor && !r.inertAncestor));
  const fails = (a) => a.filter((r) => !r.pass);
  return {
    totalTextNodes: rows.length,
    onScreenCount: onScreen.length, onScreenFails: fails(onScreen).length,
    onScreenFailList: fails(onScreen),
    offscreenCount: offscreen.length, offscreenFails: fails(offscreen).length,
    offscreenFailSelSample: fails(offscreen).slice(0, 15).map((r) => r.sel + " | " + r.text.slice(0,20) + " | " + r.ratio),
    uncertainBgCount: rows.filter((r) => r.uncertainBg).length,
    uncertainBgFails: fails(rows).filter((r) => r.uncertainBg).length,
  };
};
`;

/* ══════════════ 3. ARIA / 語意 ══════════════ */
const ARIA_FN = String.raw`
window.__r.aria = function () {
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => ({
    level: +h.tagName[1], text: window.__r.text(h).slice(0, 50), sel: window.__r.sel(h),
    visible: window.__r.probe(h).reallyVisible, centerInViewport: window.__r.probe(h).centerInViewport }));
  const visibleHeadings = headings.filter((h) => h.centerInViewport);
  const skips = [];
  for (let i = 1; i < headings.length; i++) if (headings[i].level - headings[i-1].level > 1)
    skips.push({ from: headings[i-1].level + ":" + headings[i-1].text.slice(0,20), to: headings[i].level + ":" + headings[i].text.slice(0,20) });
  const landmarks = Array.from(document.querySelectorAll(
    "header, nav, main, aside, footer, form, [role=banner], [role=navigation], [role=main]," +
    "[role=complementary], [role=contentinfo], [role=application], [role=dialog], [role=region]"))
    .map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"),
      label: el.getAttribute("aria-label"), labelledby: el.getAttribute("aria-labelledby"),
      sel: window.__r.sel(el), centerInViewport: window.__r.probe(el).centerInViewport }));
  const live = Array.from(document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]'))
    .map((el) => ({ sel: window.__r.sel(el), live: el.getAttribute("aria-live"), role: el.getAttribute("role"),
      atomic: el.getAttribute("aria-atomic"), text: window.__r.text(el).slice(0, 40) }));
  const expanded = Array.from(document.querySelectorAll("[aria-expanded]")).map((el) => {
    const ctrl = el.getAttribute("aria-controls");
    const t = ctrl ? document.getElementById(ctrl) : null;
    return { sel: window.__r.sel(el), expanded: el.getAttribute("aria-expanded"), controls: ctrl,
      controlsExists: !!t,
      targetCollapsed: t ? t.classList.contains("is-collapsed") : null,
      synced: t ? (el.getAttribute("aria-expanded") === String(!t.classList.contains("is-collapsed"))) : null };
  });
  const ariaAttrs = [];
  document.querySelectorAll("*").forEach((el) => { for (const a of el.attributes)
    if (a.name === "role" || a.name.startsWith("aria-")) ariaAttrs.push({ sel: window.__r.sel(el), attr: a.name, value: a.value }); });
  const attrHistogram = {};
  ariaAttrs.forEach((a) => { attrHistogram[a.attr] = (attrHistogram[a.attr] || 0) + 1; });
  const roleHistogram = {};
  ariaAttrs.filter((a) => a.attr === "role").forEach((a) => { roleHistogram[a.value] = (roleHistogram[a.value] || 0) + 1; });
  // 互動但冇無障礙名稱
  const noName = [];
  document.querySelectorAll('button, a[href], [role="button"], [role="link"]').forEach((el) => {
    const nm = window.__r.name(el);
    if (!nm) noName.push({ sel: window.__r.sel(el), tag: el.tagName.toLowerCase() });
  });
  const imgsNoAlt = Array.from(document.querySelectorAll("img")).filter((i) => !i.hasAttribute("alt")).map((i) => window.__r.sel(i));
  const svgs = Array.from(document.querySelectorAll("svg")).map((s) => ({ sel: window.__r.sel(s),
    role: s.getAttribute("role"), ariaLabel: s.getAttribute("aria-label"),
    ariaHidden: s.getAttribute("aria-hidden"), hasTitle: !!s.querySelector("title") }));
  const svgNoName = svgs.filter((s) => !s.ariaLabel && !s.hasTitle && s.ariaHidden !== "true");
  const inputsNoLabel = Array.from(document.querySelectorAll("input, select, textarea")).map((el) => {
    const id = el.id; const lab = id ? document.querySelector('label[for="' + id + '"]') : null;
    return { sel: window.__r.sel(el), type: el.type, ariaLabel: el.getAttribute("aria-label"),
      labelledby: el.getAttribute("aria-labelledby"), placeholder: el.getAttribute("placeholder"),
      hasLabelEl: !!lab, title: el.getAttribute("title") };
  }).filter((r) => !r.ariaLabel && !r.labelledby && !r.hasLabelEl && !r.title);
  // click 但鍵盤不可達
  const clickNoKbd = [];
  document.querySelectorAll("li, span, div").forEach((el) => {
    if (el.getAttribute("role") || el.tabIndex >= 0) return;
    const cls = typeof el.className === "string" ? el.className : "";
    if (/event-item|summary-loc|char-chip|route-item|search-result-item|zone-area|location-marker|event-marker|route-line|back-btn|chr-card/.test(cls))
      clickNoKbd.push({ sel: window.__r.sel(el), cls: cls.slice(0, 60), text: window.__r.text(el).slice(0, 30) });
  });
  return { lang: document.documentElement.getAttribute("lang"), title: document.title,
    headings, visibleHeadings, headingSkips: skips, landmarks, liveRegions: live,
    expanded, attrHistogram, roleHistogram, interactiveNoAccessibleName: noName,
    imgsNoAlt, svgs, svgNoAccessibleName: svgNoName, inputsNoLabel,
    clickableButNotKeyboardReachable: clickNoKbd.slice(0, 40),
    clickableButNotKeyboardReachableCount: clickNoKbd.length,
    ariaCurrentCount: document.querySelectorAll("[aria-current]").length,
    ariaHiddenTrueCount: document.querySelectorAll('[aria-hidden="true"]').length,
    inertCount: document.querySelectorAll("[inert]").length,
    dialogCount: document.querySelectorAll('[role="dialog"]').length };
};
`;

/* ══════════════ 4. Motion ══════════════ */
const MOTION_FN = String.raw`
window.__r.motion = function () {
  const anim = [], trans = [];
  document.querySelectorAll("*").forEach((el) => {
    const cs = getComputedStyle(el);
    const an = cs.animationName, ad = parseFloat(cs.animationDuration) || 0;
    const td = parseFloat(cs.transitionDuration) || 0;
    if (an && an !== "none" && ad > 0.05)
      anim.push({ sel: window.__r.sel(el), name: an, duration: cs.animationDuration, iteration: cs.animationIterationCount });
    if (td > 0.05)
      trans.push({ sel: window.__r.sel(el), duration: cs.transitionDuration, prop: cs.transitionProperty });
  });
  const agg = (arr, k) => { const h = {}; for (const x of arr) { const key = x[k] + " | " + (x.name || x.prop || ""); h[key] = (h[key] || 0) + 1; } return h; };
  return { prefersReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    animationsCount: anim.length, transitionsCount: trans.length,
    animationHistogram: agg(anim, "duration"), transitionHistogram: agg(trans, "duration"),
    animationSample: anim.slice(0, 20), transitionSample: trans.slice(0, 20) };
};
`;

/* ══════════════ 主流程 ══════════════ */
async function newCtx(opts) {
  const context = await browser.newContext(Object.assign({ deviceScaleFactor: 1 }, opts));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1500);
  for (const fn of [HELPERS, TOUCH_FN, CONTRAST_FN, ARIA_FN, MOTION_FN]) await page.addScriptTag({ content: fn });
  return { context, page, consoleErrors };
}

const out = { ranAt: new Date().toISOString(), baseUrl: BASE };

/* ── mobile-390 ── */
{
  const { context, page, consoleErrors } = await newCtx({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  out.mobile390 = {
    viewport: { w: 390, h: 844 },
    touch: await page.evaluate(() => window.__r.touch()),
    contrastDark: null, contrastLight: null,
    aria: await page.evaluate(() => window.__r.aria()),
    motionNoPref: await page.evaluate(() => window.__r.motion()),
    consoleErrors,
  };
  // 主題切換（用 localStorage + reload 較穩定，但唔改檔 → 用 UI 按鈕）
  const themeBtn = await page.$("#btn-theme");
  if (themeBtn) { await themeBtn.click(); await page.waitForTimeout(900); }
  out.mobile390.themeAfterToggle = await page.evaluate(() => document.documentElement.getAttribute("data-theme") || document.documentElement.className);
  out.mobile390.contrastDark = await page.evaluate(() => window.__r.contrast());
  if (themeBtn) { await themeBtn.click(); await page.waitForTimeout(900); }
  out.mobile390.contrastLight = await page.evaluate(() => window.__r.contrast());
  await context.close();
}

/* ── reduced motion ── */
{
  const { context, page } = await newCtx({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  out.mobile390Reduce = await page.evaluate(() => window.__r.motion());
  await context.close();
}
{
  const { context, page } = await newCtx({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  out.desktop1440Reduce = await page.evaluate(() => window.__r.motion());
  await context.close();
}

/* ── tablet-768 / desktop-1440 touch + aria ── */
for (const [key, opts] of [["tablet768", { viewport: { width: 768, height: 1024 }, hasTouch: true }],
                           ["desktop1440", { viewport: { width: 1440, height: 900 } }]]) {
  const { context, page } = await newCtx(opts);
  out[key] = {
    touch: await page.evaluate(() => window.__r.touch()),
    aria: await page.evaluate(() => window.__r.aria()),
    motionNoPref: await page.evaluate(() => window.__r.motion()),
  };
  await context.close();
}

fs.writeFileSync(path.join(OUT, "a7-remeasure.json"), JSON.stringify(out, null, 2));

const brief = {};
for (const k of ["mobile390", "tablet768", "desktop1440"]) {
  const r = out[k];
  brief[k] = {
    rawTargets: r.touch.rawCount,
    realInteractiveVisible: r.touch.realInteractiveVisibleCount,
    violations: r.touch.violationCount,
    inlineLinkExceptions: r.touch.inlineLinkExceptionCount,
    occludedReal: r.touch.occludedRealCount,
    offscreenReal: r.touch.offscreenRealCount,
    wcag258TooSmall24: r.touch.wcag258TooSmall24Count,
    violationList: r.touch.violations.map((v) => v.sel + " [" + v.w + "x" + v.h + "] " + v.name),
  };
}
brief.mobile390.contrast = {
  dark: out.mobile390.contrastDark && { total: out.mobile390.contrastDark.totalTextNodes,
    onScreen: out.mobile390.contrastDark.onScreenCount, onScreenFails: out.mobile390.contrastDark.onScreenFails,
    offscreen: out.mobile390.contrastDark.offscreenCount, offscreenFails: out.mobile390.contrastDark.offscreenFails },
  light: out.mobile390.contrastLight && { total: out.mobile390.contrastLight.totalTextNodes,
    onScreen: out.mobile390.contrastLight.onScreenCount, onScreenFails: out.mobile390.contrastLight.onScreenFails,
    offscreen: out.mobile390.contrastLight.offscreenCount, offscreenFails: out.mobile390.contrastLight.offscreenFails },
  themeAfterToggle: out.mobile390.themeAfterToggle,
};
brief.mobile390.motion = { noPref: { anim: out.mobile390.motionNoPref.animationsCount, trans: out.mobile390.motionNoPref.transitionsCount },
  reduce: { anim: out.mobile390Reduce.animationsCount, trans: out.mobile390Reduce.transitionsCount } };
brief.desktop1440.motionReduce = { anim: out.desktop1440Reduce.animationsCount, trans: out.desktop1440Reduce.transitionsCount };

fs.writeFileSync(path.join(OUT, "a7-remeasure-brief.json"), JSON.stringify(brief, null, 2));
console.log(JSON.stringify(brief, null, 2));
await browser.close();

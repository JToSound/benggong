/**
 * A7 補量測 #1：核實 touch target 量測方法
 *
 * 目的：上一輪 a7-audit.mjs 用
 *   'button, a[href], [role=button], [role=link], [role=tab], [role=option],
 *    input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])'
 * 得到 totalTargets = 3131、fail44Count = 3131。
 *
 * 本腳本會：
 *  1. 列出原本 3131 個 match 究竟係咩（tag / class / tabindex / 命名空間 / 祖先）
 *  2. 用「真正可互動 + 可見 + 唔喺 aria-hidden/inert 內」嘅嚴格準則重新量度
 *  3. 分開輸出：真違規清單 vs 原方法高估來源
 *
 * 執行：node artifacts/audit-A7/a7-verify-targets.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5190/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

const HELPERS = `
window.__v = {};
window.__v.selector = function (el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) return el.tagName.toLowerCase() + "#" + el.id;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 3).join(".") : "";
  let s = el.tagName.toLowerCase() + (cls ? "." + cls : "");
  const p = el.parentElement;
  if (p && p.id) s = p.tagName.toLowerCase() + "#" + p.id + " > " + s;
  return s;
};
window.__v.chain = function (el, n) {
  const out = []; let c = el, i = 0;
  while (c && c.nodeType === 1 && i < (n || 5)) {
    out.unshift(c.tagName.toLowerCase() + (c.id ? "#" + c.id : (typeof c.className === "string" && c.className ? "." + c.className.trim().split(/\\s+/)[0] : "")));
    c = c.parentElement; i++;
  }
  return out.join(" > ");
};
window.__v.textOf = function (el) {
  let t = "";
  for (const c of el.childNodes) if (c.nodeType === 3) t += c.textContent;
  return t.replace(/\\s+/g, " ").trim();
};
window.__v.accName = function (el) {
  const al = el.getAttribute && el.getAttribute("aria-label");
  if (al) return al;
  const t = el.textContent ? el.textContent.replace(/\\s+/g, " ").trim() : "";
  if (t) return t.slice(0, 40);
  const ti = el.getAttribute && (el.getAttribute("title") || el.getAttribute("alt"));
  return ti || "";
};
/* 真正可見：計 layout box、祖先 opacity、clip、以及被 aria-hidden / inert 屏蔽 */
window.__v.visibleInfo = function (el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const reasons = [];
  if (cs.display === "none") reasons.push("display:none");
  if (cs.visibility === "hidden" || cs.visibility === "collapse") reasons.push("visibility:hidden");
  if (parseFloat(cs.opacity) === 0) reasons.push("opacity:0");
  if (r.width === 0 || r.height === 0) reasons.push("zero-box");
  // 祖先 display/visibility/opacity
  let n = el.parentElement, depth = 0;
  while (n && depth < 60) {
    const pcs = getComputedStyle(n);
    if (pcs.display === "none") { reasons.push("ancestor display:none (" + window.__v.selector(n) + ")"); break; }
    if (pcs.visibility === "hidden") { reasons.push("ancestor visibility:hidden (" + window.__v.selector(n) + ")"); break; }
    n = n.parentElement; depth++;
  }
  // aria-hidden / inert 祖先
  let ariaHiddenAnc = null, inertAnc = null;
  n = el; depth = 0;
  while (n && n.nodeType === 1 && depth < 60) {
    if (!ariaHiddenAnc && n.getAttribute && n.getAttribute("aria-hidden") === "true") ariaHiddenAnc = window.__v.selector(n);
    if (!inertAnc && n.hasAttribute && n.hasAttribute("inert")) inertAnc = window.__v.selector(n);
    n = n.parentElement; depth++;
  }
  // clip / clip-path 祖先
  let clippedAnc = null;
  n = el; depth = 0;
  while (n && n.nodeType === 1 && depth < 60) {
    const pcs = getComputedStyle(n);
    if (pcs.clipPath && pcs.clipPath !== "none") { clippedAnc = window.__v.selector(n) + " {clip-path:" + pcs.clipPath + "}"; break; }
    n = n.parentElement; depth++;
  }
  const pe = cs.pointerEvents;
  return { reasons, ariaHiddenAncestor: ariaHiddenAnc, inertAncestor: inertAnc, clippedAncestor: clippedAnc,
           pointerEvents: pe, w: +r.width.toFixed(1), h: +r.height.toFixed(1),
           x: +r.x.toFixed(1), y: +r.y.toFixed(1) };
};
window.__v.focusable = function (el) {
  // 用 tabIndex property：>=0 代表 Tab 可達；-1 代表程式可 focus 但唔喺 Tab 序
  const ti = el.tabIndex;
  const cs = getComputedStyle(el);
  const hidden = cs.display === "none" || cs.visibility === "hidden";
  return { tabIndexProp: ti, tabIndexAttr: el.getAttribute("tabindex"), hiddenByCSS: hidden };
};
`;

/* ── 原本方法（a7-audit.mjs 用嘅 SEL）── */
const ORIG_SEL = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="option"],' +
  ' input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/* ── 真正可互動準則 ──
 * 只計「語意上係控制項」或「有明確 tabindex>=0 且唔係裝飾」嘅元素。
 * 並且：可見（非 display:none/visibility:hidden/opacity:0/zero-box）、
 *       唔喺 aria-hidden=true 或 inert 祖先之下、
 *       唔係 SVG 內部幾何元素（SVGElement 唔屬互動語意，除非有 role/tabindex 且喺可聚焦容器）。
 */
const REAL_RULE = `
function isRealInteractive(el) {
  const tag = el.tagName.toLowerCase();
  const ns = el.namespaceURI;
  const role = (el.getAttribute("role") || "").toLowerCase();
  const isSvgGeom = ns === "http://www.w3.org/2000/svg" && tag !== "svg";
  const semanticTags = ["button", "a", "input", "select", "textarea", "summary", "details"];
  const semanticRoles = ["button", "link", "tab", "option", "menuitem", "menuitemcheckbox",
    "menuitemradio", "checkbox", "radio", "switch", "combobox", "searchbox", "textbox",
    "slider", "spinbutton", "dialog"];
  let real = false, why = "";
  if (semanticTags.includes(tag)) {
    if (tag === "a" && !el.hasAttribute("href")) { real = false; why = "a 冇 href"; }
    else if (tag === "input" && el.type === "hidden") { real = false; why = "input[type=hidden]"; }
    else { real = true; why = "語意標籤 <" + tag + ">"; }
  } else if (semanticRoles.includes(role)) {
    real = true; why = "role=" + role;
  } else if (el.hasAttribute("tabindex") && parseInt(el.getAttribute("tabindex"), 10) >= 0) {
    if (isSvgGeom) { real = false; why = "SVG 內部幾何 + tabindex（裝飾／非互動語意）"; }
    else { real = true; why = "tabindex=" + el.getAttribute("tabindex") + " 非 SVG"; }
  } else {
    real = false; why = "冇互動語意";
  }
  return { real, why, isSvgGeom, role, tag };
}
`;

async function audit(width, height, hasTouch, label) {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch, isMobile: hasTouch, deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.addScriptTag({ content: HELPERS });
  await page.addScriptTag({ content: REAL_RULE });

  const res = await page.evaluate((ORIG_SEL) => {
    const matches = Array.from(document.querySelectorAll(ORIG_SEL));
    const buckets = {};
    const origRows = [];
    for (const el of matches) {
      const info = window.__v.visibleInfo(el);
      const f = window.__v.focusable(el);
      const rule = isRealInteractive(el);
      const tag = el.tagName.toLowerCase();
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      const isSvgGeom = rule.isSvgGeom;
      const key = (isSvgGeom ? "SVG:" : "") + tag + (cls ? "." + cls : "") +
        (el.hasAttribute("tabindex") ? "[tabindex=" + el.getAttribute("tabindex") + "]" : "") +
        (el.getAttribute("role") ? "[role=" + el.getAttribute("role") + "]" : "");
      buckets[key] = buckets[key] || { key, count: 0, sample: window.__v.chain(el, 4), sampleW: info.w, sampleH: info.h, realCount: 0 };
      buckets[key].count++;
      if (rule.real) buckets[key].realCount++;
      origRows.push({
        sel: window.__v.selector(el), chain: window.__v.chain(el, 4),
        tag, cls, role: el.getAttribute("role"), tabindexAttr: el.getAttribute("tabindex"),
        isSvgGeom, isReal: rule.real, why: rule.why,
        accName: window.__v.accName(el).slice(0, 40),
        w: info.w, h: info.h, x: info.x, y: info.y,
        visibleReasons: info.reasons, ariaHiddenAncestor: info.ariaHiddenAncestor,
        inertAncestor: info.inertAncestor, clippedAncestor: info.clippedAncestor,
        pointerEvents: info.pointerEvents,
        fail44: info.w < 44 || info.h < 44,
      });
    }

    /* 嚴格「真互動 + 可見 + 未被 aria-hidden/inert 屏蔽」清單 */
    const real = origRows.filter((r) =>
      r.isReal && r.visibleReasons.length === 0 && !r.ariaHiddenAncestor && !r.inertAncestor);

    /* 真違規：真互動 + 可見，但 < 44×44 */
    const violations = real.filter((r) => r.fail44);

    /* 真互動但被隱藏／屏蔽（另外一類問題） */
    const realButHidden = origRows.filter((r) =>
      r.isReal && (r.visibleReasons.length > 0 || r.ariaHiddenAncestor || r.inertAncestor));

    /* 互動語意但唔可見且唔喺 aria-hidden —— 例如 collapsed panel */
    const realButHiddenNotAriaHidden = realButHidden.filter((r) => !r.ariaHiddenAncestor && !r.inertAncestor);

    return {
      label: "viewport",
      vw: window.innerWidth, vh: window.innerHeight,
      origMatchCount: matches.length,
      origFail44Count: origRows.filter((r) => r.fail44).length,
      origVisibleMatchCount: origRows.filter((r) => r.visibleReasons.length === 0).length,
      buckets: Object.values(buckets).sort((a, b) => b.count - a.count),
      realInteractiveCount: real.length,
      realInteractiveVisibleCount: real.length,
      realViolationCount: violations.length,
      violations,
      realButHiddenCount: realButHidden.length,
      realButHiddenSample: realButHidden.slice(0, 40),
      realButHiddenNotAriaHiddenCount: realButHiddenNotAriaHidden.length,
      realButHiddenNotAriaHiddenSample: realButHiddenNotAriaHidden.slice(0, 40),
      ariaHiddenTrueCount: document.querySelectorAll('[aria-hidden="true"]').length,
      inertCount: document.querySelectorAll("[inert]").length,
    };
  }, ORIG_SEL);

  res.label = label;
  res.viewport = { width, height, hasTouch };
  await context.close();
  return res;
}

const out = {
  ranAt: new Date().toISOString(),
  baseUrl: BASE,
  origSelector: ORIG_SEL,
  mobile390: await audit(390, 844, true, "mobile-390"),
  tablet768: await audit(768, 1024, true, "tablet-768"),
  desktop1440: await audit(1440, 900, false, "desktop-1440"),
};

fs.writeFileSync(path.join(OUT, "a7-verify-targets.json"), JSON.stringify(out, null, 2));

const s = (r) => ({
  label: r.label,
  origMatchCount: r.origMatchCount,
  origFail44Count: r.origFail44Count,
  origVisibleMatchCount: r.origVisibleMatchCount,
  realInteractiveCount: r.realInteractiveCount,
  realViolationCount: r.realViolationCount,
  realButHiddenCount: r.realButHiddenCount,
  realButHiddenNotAriaHiddenCount: r.realButHiddenNotAriaHiddenCount,
  ariaHiddenTrueCount: r.ariaHiddenTrueCount,
  inertCount: r.inertCount,
  topBuckets: r.buckets.slice(0, 12),
});
const brief = { mobile390: s(out.mobile390), tablet768: s(out.tablet768), desktop1440: s(out.desktop1440) };
fs.writeFileSync(path.join(OUT, "a7-verify-targets-brief.json"), JSON.stringify(brief, null, 2));
console.log(JSON.stringify(brief, null, 2));
await browser.close();

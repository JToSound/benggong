/**
 * A7 補量測 #1b：chronicle 按鈕（chr-ch / chr-toggle）究竟可唔可見？
 * 用多種程式化證據判定：computed style、rect、offsetParent、
 * elementFromPoint 命中測試、scroll 位置、祖先 hidden 屬性。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5190/";
const OUT = "artifacts/audit-A7";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map", { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await page.waitForTimeout(1500);

const res = await page.evaluate(() => {
  const sel = (el) => el.id ? el.tagName.toLowerCase() + "#" + el.id
    : el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0,2).join(".") : "");
  const desc = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { sel: sel(el), display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      position: cs.position, transform: cs.transform, rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      offsetParent: el.offsetParent ? sel(el.offsetParent) : null,
      clientRects: el.getClientRects().length,
      hiddenAttr: el.hasAttribute("hidden"), ariaHidden: el.getAttribute("aria-hidden"),
      inert: el.hasAttribute("inert"), tabIndexProp: el.tabIndex,
      parentChain: (() => { const out = []; let c = el; let i = 0; while (c && c.nodeType === 1 && i < 8) { out.unshift(sel(c)); c = c.parentElement; i++; } return out.join(" > "); })() };
  };
  const sampleChrCh = document.querySelector("button.chr-ch");
  const sampleToggle = document.querySelector("button.chr-toggle");
  const chrRoot = document.querySelector(".chronicle") || document.querySelector("#chronicle");
  const chrBody = document.querySelector(".chronicle-body");

  // elementFromPoint 命中測試：將元素中心點轉成 viewport 座標，睇下真正喺頂層嘅係邊個
  const hitTest = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return { inViewport: false, cx: +cx.toFixed(1), cy: +cy.toFixed(1) };
    const top = document.elementFromPoint(cx, cy);
    return { inViewport: true, cx: +cx.toFixed(1), cy: +cy.toFixed(1),
      topEl: top ? sel(top) : null, isSelfOrChild: top ? (top === el || el.contains(top) || top.contains(el)) : false };
  };

  // 統計：所有 chr-ch / chr-toggle 之中，有幾多個中心點命中自己
  const all = Array.from(document.querySelectorAll("button.chr-ch, button.chr-toggle"));
  let inViewport = 0, hitSelf = 0;
  const samples = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight) {
      inViewport++;
      const top = document.elementFromPoint(cx, cy);
      if (top && (top === el || el.contains(top))) hitSelf++;
      else if (samples.length < 5) samples.push({ el: sel(el), cx: +cx.toFixed(1), cy: +cy.toFixed(1), top: top ? sel(top) : null });
    }
  }

  return {
    chronicleRoot: desc(chrRoot),
    chronicleBody: desc(chrBody),
    sampleChrCh: desc(sampleChrCh),
    sampleToggle: desc(sampleToggle),
    hitTestChrCh: hitTest(sampleChrCh),
    hitTestToggle: hitTest(sampleToggle),
    counts: { total: all.length, inViewportCenters: inViewport, hitSelf, missedSamples: samples },
    appRootChildren: Array.from(document.querySelectorAll("#app-root > *")).map((c) => ({ sel: sel(c), display: getComputedStyle(c).display, hidden: c.hasAttribute("hidden"), ariaHidden: c.getAttribute("aria-hidden"), rect: (() => { const r = c.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })() })),
    ariaHiddenTrueElems: (() => {
      const els = Array.from(document.querySelectorAll('[aria-hidden="true"]'));
      const byTop = {};
      for (const e of els) {
        const top = e.closest("#app-root > *") || e;
        const k = sel(top);
        byTop[k] = (byTop[k] || 0) + 1;
      }
      return { total: els.length, byTopAncestor: byTop };
    })(),
  };
});
fs.writeFileSync(path.join(OUT, "a7-verify-chronicle.json"), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
await browser.close();

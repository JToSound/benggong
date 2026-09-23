/**
 * A9 QA Adversary —— mobile §7.2-9 / 鍵盤 §7.2-10 / storage / search §7.2-4（只讀）
 * 執行：node artifacts/audit-A9/a9-mobile-a11y-storage.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const out = { base: BASE, capturedAt: new Date().toISOString() };

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK", serviceWorkers: "block", ...opts });
  const page = await ctx.newPage();
  return { ctx, page };
}

// ---------- 1) Mobile 390×844：spec §7.2-9 ----------
{
  const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const base = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      horizOverflow: doc.scrollWidth > window.innerWidth + 2,
      scrollW: doc.scrollWidth,
      winW: window.innerWidth,
      safeAreaSupported: CSS.supports("padding-top: env(safe-area-inset-top)"),
      bottomSheetSelectors: Array.from(document.querySelectorAll("*"))
        .filter((e) => /sheet|bottom|drawer/i.test((e.className || "") + " " + (e.id || "")))
        .slice(0, 8)
        .map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 60), id: e.id })),
    };
  });
  // touch target 檢查（只計「喺 viewport 內可見」嘅互動元素）
  const small = await page.evaluate(() => {
    const sel = 'button, a, [role=button], input, select, [tabindex]:not([tabindex="-1"])';
    const vw = window.innerWidth, vh = window.innerHeight;
    const bad = [];
    let inViewport = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || cs.display === "none") continue;
      const intersects = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (!intersects) continue;
      inViewport++;
      if (r.height < 44 || r.width < 44) {
        bad.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), txt: (el.textContent || "").trim().slice(0, 18) });
      }
    }
    return { total: document.querySelectorAll(sel).length, inViewport, under44: bad.length, sample: bad.slice(0, 15) };
  });
  // 故事面板喺窄螢幕嘅呈現
  const panel = await page.evaluate(() => {
    const p = document.querySelector("#story-panel-mount");
    const pane = document.querySelector("#story-pane");
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    const pr = pane?.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      position: cs.position, transform: cs.transform, hidden: p.hidden,
      paneCollapsed: pane?.classList.contains("is-collapsed") ?? null,
      paneW: pr ? Math.round(pr.width) : null,
      panePos: pane ? getComputedStyle(pane).position : null,
      paneBottom: pane ? getComputedStyle(pane).bottom : null,
      toggleDisplay: document.querySelector("#btn-toggle-panel") ? getComputedStyle(document.querySelector("#btn-toggle-panel")).display : null,
      toggleBtnMinH: (() => { const b = document.querySelector("#btn-toggle-panel"); return b ? Math.round(b.getBoundingClientRect().height) : null; })(),
      navBtnMinH: (() => { const b = document.querySelector("#topbar .nav-btn"); return b ? Math.round(b.getBoundingClientRect().height) : null; })(),
      mapW: Math.round(document.querySelector("#svg-map")?.getBoundingClientRect().width ?? 0),
      vw: window.innerWidth,
    };
  });
  await page.screenshot({ path: path.join(OUT, "a9-gaps-mobile-390.png") });
  out.mobile390 = { base, touchTargets: small, storyPanel: panel };
  await ctx.close();
  console.log("[mobile390]", JSON.stringify({ horiz: base.horizOverflow, sheet: base.bottomSheetSelectors, under44: small.under44, panelPos: panel?.position }));
}

// ---------- 2) 鍵盤：Tab / focus visible / Esc / 快捷鍵 §7.2-10 ----------
{
  const { ctx, page } = await newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const seq = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    seq.push(
      await page.evaluate(() => {
        const a = document.activeElement;
        const cs = a ? getComputedStyle(a) : null;
        return { tag: a?.tagName, id: a?.id, cls: String(a?.className || "").slice(0, 30), outline: cs?.outlineStyle, outlineW: cs?.outlineWidth };
      }),
    );
  }
  // 快捷鍵測試（focus 喺 body）
  const chBefore = await page.evaluate(() => document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("k");
  await page.waitForTimeout(600);
  const chAfterK = await page.evaluate(() => document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch);
  await page.keyboard.press("?");
  await page.waitForTimeout(500);
  const helpOpen = await page.evaluate(() => !!document.querySelector("[class*=help], [id*=help], [class*=shortcut]"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const helpClosed = await page.evaluate(() => !!document.querySelector("[class*=help], [id*=help], [class*=shortcut]"));
  out.keyboard = { tabSeq: seq, focusVisible: seq.some((s) => s.outline && s.outline !== "none"), shortcutK: { before: chBefore, after: chAfterK, works: chBefore !== chAfterK }, helpShortcut: { opened: helpOpen, closedAfterEsc: !helpClosed } };
  await ctx.close();
  console.log("[keyboard]", JSON.stringify({ tabCount: seq.length, focusVisible: out.keyboard.focusVisible, kWorks: out.keyboard.shortcutK.works, helpOpen, helpClosed }));
}

// ---------- 3) Search 鍵盤導航 §7.2-4 ----------
{
  const { ctx, page } = await newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.click("#btn-search");
  await page.waitForTimeout(500);
  await page.keyboard.type("大本營");
  await page.waitForTimeout(800);
  const before = await page.evaluate(() => ({
    resultCount: document.querySelectorAll("#search-results .search-result-item").length,
    activeIdx: Array.from(document.querySelectorAll("#search-results .search-result-item")).findIndex((e) => /active|selected|focus/.test(e.className)),
    focused: document.activeElement?.id,
  }));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const afterDown = await page.evaluate(() => ({
    activeIdx: Array.from(document.querySelectorAll("#search-results .search-result-item")).findIndex((e) => /active|selected/.test(e.className)),
    focused: document.activeElement?.id,
    hasAriaActive: !!document.querySelector('#search-results [aria-selected="true"], #search-results .active'),
  }));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const afterEnter = await page.evaluate(() => ({
    modalOpen: !!document.querySelector("#search-modal.open"),
    url: location.href,
    storyTitle: document.querySelector("#story-panel-mount .story-title")?.textContent?.trim() || null,
  }));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterEsc = await page.evaluate(() => ({
    modalOpen: !!document.querySelector("#search-modal.open"),
    focused: document.activeElement?.id,
  }));
  out.searchKeyboard = { before, afterDown, afterEnter, afterEsc };
  await ctx.close();
  console.log("[searchKeyboard]", JSON.stringify(out.searchKeyboard));
}

// ---------- 4) localStorage 禁用：theme 切換 + reload ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK", serviceWorkers: "block" });
  const page = await ctx.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await page.addInitScript(() => {
    const boom = () => { throw new DOMException("localStorage disabled", "SecurityError"); };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, get length() { return boom(); } }; },
    });
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  let clickErr = null;
  try { await page.click("#btn-theme", { timeout: 5000 }); } catch (e) { clickErr = String(e).slice(0, 100); }
  await page.waitForTimeout(600);
  const t1 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const mapStillThere = await page.evaluate(() => !!document.querySelector("#svg-map-mount svg"));
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2000);
  const t2 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await ctx.close();
  out.lsDisabled = { theme0: t0, themeAfterToggle: t1, themeAfterReload: t2, mapStillThere, clickErr, pageErrors, consoleErrors: consoleErrors.slice(0, 4) };
  console.log("[lsDisabled]", JSON.stringify(out.lsDisabled));
}

await browser.close();
fs.writeFileSync(path.join(OUT, "a9-gaps-mobile-a11y.json"), JSON.stringify(out, null, 2));
console.log("寫入", path.join(OUT, "a9-gaps-mobile-a11y.json"));

/**
 * A7 補量測 #3：Keyboard 完整流程、Tab 順序、panel/bottom-sheet 行為、focus ring。
 *
 * 全部程式化：Tab 用 page.keyboard.press，focus ring 用「focused / unfocused
 * 兩張截圖逐像素比對」，唔涉及任何人手目測。
 *
 * 執行：node artifacts/audit-A7/a7-keyboard-journey.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5190/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

const ACTIVE = `(() => {
  const a = document.activeElement;
  if (!a) return null;
  const r = a.getBoundingClientRect();
  const cls = a.getAttribute ? (a.getAttribute("class") || "") : "";
  return { tag: a.tagName.toLowerCase(), id: a.id || null, cls: cls.slice(0, 50),
    text: (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30),
    role: a.getAttribute ? a.getAttribute("role") : null,
    tabindex: a.getAttribute ? a.getAttribute("tabindex") : null,
    region: a.closest("#topbar") ? "topbar" : a.closest("#chapter-strip-mount") ? "chapterStrip"
      : a.closest(".map-controls") ? "mapControls" : a.closest("#map-overlay") ? "mapLegend"
      : a.closest("#story-pane") ? "storyPane" : a.closest("#map-pane") ? "mapPane"
      : a.closest("#search-modal") ? "searchModal" : "other",
    w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.x.toFixed(1), y: +r.y.toFixed(1),
    inViewport: r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight };
})()`;

async function boot(opts) {
  const context = await browser.newContext(Object.assign({ deviceScaleFactor: 1 }, opts));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { context, page, consoleErrors };
}

const active = (page) => page.evaluate(ACTIVE);

/* ══════════ 像素比對：focus ring 可見度 ══════════ */
async function pixelDiff(page, bufA, bufB, clip) {
  const a64 = bufA.toString("base64"), b64 = bufB.toString("base64");
  return page.evaluate(async ({ a64, b64, clip }) => {
    const load = (b64) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = "data:image/png;base64," + b64; });
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    const c = document.createElement("canvas");
    c.width = ia.width; c.height = ia.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data;
    ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, c.width, c.height).data;
    // clip 係 viewport 座標；截圖係 clip 為準，所以要換算
    const ix0 = (clip.inner.x - clip.x), iy0 = (clip.inner.y - clip.y);
    const ix1 = ix0 + clip.inner.w, iy1 = iy0 + clip.inner.h;
    let ring = 0, inner = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i+1] - db[i+1]) + Math.abs(da[i+2] - db[i+2]);
        if (d < 12) continue;
        if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) inner++; else ring++;
      }
    }
    return { ringChangedPx: ring, innerChangedPx: inner, clipW: c.width, clipH: c.height };
  }, { a64, b64, clip });
}

async function measureRing(page, selector, maxTabs = 400) {
  const el = await page.$(selector);
  if (!el) return { selector, exists: false };
  const box = await el.boundingBox();
  if (!box) return { selector, exists: true, box: null, note: "冇 boundingBox（可能不可見）" };
  const pad = 12;
  const clip = {
    x: Math.max(0, Math.floor(box.x - pad)), y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.ceil(box.width + pad * 2), height: Math.ceil(box.height + pad * 2),
    inner: { x: Math.floor(box.x), y: Math.floor(box.y), w: Math.ceil(box.width), h: Math.ceil(box.height) },
  };
  // 1) 先量未 focus 狀態
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.waitForTimeout(120);
  const before = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
  // 2) 用鍵盤 Tab 逐次去到目標
  let reached = false, tabs = 0;
  for (let i = 1; i <= maxTabs; i++) {
    await page.keyboard.press("Tab");
    tabs = i;
    const ok = await page.evaluate((s) => { const a = document.activeElement; return !!a && a.matches(s); }, selector);
    if (ok) { reached = true; break; }
  }
  if (!reached) return { selector, exists: true, reachedByTab: false, tabsUsed: tabs, note: "Tab 400 次都到唔到（唔喺 Tab 序）" };
  await page.waitForTimeout(150);
  const after = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
  const diff = await pixelDiff(page, before, after, clip);
  const style = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const cs = getComputedStyle(el);
    const clipAnc = [];
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d < 40) {
      const pcs = getComputedStyle(n);
      if (pcs.clipPath && pcs.clipPath !== "none") clipAnc.push({ sel: n.id ? "#" + n.id : "." + (n.getAttribute("class") || "").split(/\s+/)[0], clipPath: pcs.clipPath });
      if (pcs.overflow !== "visible" && n !== el) clipAnc.push({ sel: n.id ? "#" + n.id : "." + (n.getAttribute("class") || "").split(/\s+/)[0], overflow: pcs.overflow });
      n = n.parentElement; d++;
    }
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
      outlineOffset: cs.outlineOffset, boxShadow: cs.boxShadow, focusVisibleMatched: el.matches(":focus-visible"),
      clippingAncestors: clipAnc.slice(0, 6) };
  }, selector);
  return { selector, exists: true, reachedByTab: true, tabsUsed: tabs, box: { x: +box.x.toFixed(1), y: +box.y.toFixed(1), w: +box.width.toFixed(1), h: +box.height.toFixed(1) },
    ringChangedPx: diff.ringChangedPx, innerChangedPx: diff.innerChangedPx,
    ringVisible: diff.ringChangedPx > 20, ...style };
}

const out = { ranAt: new Date().toISOString(), baseUrl: BASE };

/* ═══════════════ A. mobile-390 ═══════════════ */
{
  const { context, page, consoleErrors } = await boot({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  /* A1. Tab 順序首 25 */
  const tabOrder = [];
  for (let i = 1; i <= 25; i++) { await page.keyboard.press("Tab"); tabOrder.push({ n: i, ...(await active(page)) }); }
  out.mobileTabOrder = { first25: tabOrder,
    firstIsSkipLink: tabOrder[0] && tabOrder[0].cls.includes("skip-link"),
    firstNavIndex: (tabOrder.find((t) => t.region === "topbar") || {}).n || null,
    firstMapCtrlIndex: (tabOrder.find((t) => t.region === "mapControls") || {}).n || null,
    firstPanelIndex: (tabOrder.find((t) => t.region === "storyPane") || {}).n || null,
    offscreenStopsInFirst25: tabOrder.filter((t) => !t.inViewport).length };

  /* A2. skip link */
  await page.evaluate(() => { document.activeElement.blur(); document.body.focus(); });
  await page.keyboard.press("Tab");
  const skipActive = await active(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  out.mobileSkipLink = {
    firstTab: skipActive,
    afterEnter: await page.evaluate(() => {
      const a = document.activeElement;
      const main = document.querySelector("#map-pane");
      return { activeTag: a ? a.tagName.toLowerCase() : null, activeId: a ? a.id : null,
        hash: location.hash, mainTabIndex: main ? main.getAttribute("tabindex") : null,
        mainIsActive: a === main };
    }),
  };

  /* A3. Panel / bottom sheet 行為 */
  const panelState = () => page.evaluate(() => {
    const pane = document.querySelector("#story-pane");
    const btn = document.querySelector("#btn-toggle-panel");
    const r = pane.getBoundingClientRect();
    const map = document.querySelector("#map-pane").getBoundingClientRect();
    const cs = getComputedStyle(pane);
    const tabbable = pane.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])').length;
    const tabbableVisible = Array.from(pane.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')).filter((e) => {
      const b = e.getBoundingClientRect();
      return b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
    }).length;
    const overlap = Math.max(0, Math.min(r.right, map.right) - Math.max(r.left, map.left)) *
                    Math.max(0, Math.min(r.bottom, map.bottom) - Math.max(r.top, map.top));
    return { collapsed: pane.classList.contains("is-collapsed"),
      ariaExpanded: btn ? btn.getAttribute("aria-expanded") : null,
      paneRect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      paneTransform: cs.transform, panePosition: cs.position, panePointerEvents: cs.pointerEvents,
      paneAriaHidden: pane.getAttribute("aria-hidden"), paneInert: pane.hasAttribute("inert"),
      paneVisibility: cs.visibility, paneDisplay: cs.display,
      paneScrollHeight: pane.scrollHeight, paneClientHeight: pane.clientHeight,
      tabbableInside: tabbable, tabbableInsideViewport: tabbableVisible,
      coversMapPct: +((overlap / (map.width * map.height)) * 100).toFixed(1),
      hasDragHandle: !!document.querySelector(".sheet-handle, .drag-handle, [data-drag-handle], .sheet-grip"),
      hasBottomSheetClass: !!document.querySelector(".bottom-sheet, .sheet, [class*=bottom-sheet]"),
      hasSnapPoints: !!document.querySelector("[data-snap-points], .snap-points"),
      touchAction: cs.touchAction,
      btnRect: btn ? (() => { const b = btn.getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; })() : null,
    };
  });
  out.panel = { initial: await panelState() };

  // 開面板
  await page.click("#btn-toggle-panel");
  await page.waitForTimeout(700);
  out.panel.afterOpen = { ...(await panelState()), focusMovedIntoPanel: await page.evaluate(() => {
    const a = document.activeElement; const pane = document.querySelector("#story-pane");
    return !!a && pane.contains(a);
  }) };

  // Esc 收唔收面板？
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  out.panel.afterEsc = { ...(await panelState()), active: await active(page) };

  // 再按 Esc 一次
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  out.panel.afterEsc2 = { collapsed: (await panelState()).collapsed, active: await active(page) };

  // 收埋後，Tab 會唔會仍然入到面板？
  await page.click("#btn-toggle-panel"); await page.waitForTimeout(500); // 確保 collapsed
  const collapsedNow = (await panelState()).collapsed;
  await page.evaluate(() => { document.activeElement.blur(); document.body.focus(); });
  let firstStoryStop = null; const seq = [];
  for (let i = 1; i <= 60; i++) {
    await page.keyboard.press("Tab");
    const a = await active(page);
    seq.push({ n: i, tag: a.tag, id: a.id, cls: a.cls, region: a.region, inViewport: a.inViewport });
    if (!firstStoryStop && a.region === "storyPane") firstStoryStop = i;
  }
  out.panel.collapsedFocusReach = { collapsed: collapsedNow, firstStoryPaneTabStop: firstStoryStop,
    storyStopsWithin60: seq.filter((s) => s.region === "storyPane").length, sample: seq.slice(0, 12) };

  /* A4. Focus ring 可見度（鍵盤 Tab 到達後截圖逐像素比對） */
  out.mobileFocusRings = [];
  for (const sel of ["#btn-mode", "#btn-search", "#btn-toggle-panel", "#map-zoom-in", "#legend-lang-btn", ".ch-pill"]) {
    out.mobileFocusRings.push(await measureRing(page, sel));
  }

  out.mobileConsoleErrors = consoleErrors;
  await context.close();
}

/* ═══════════════ B. Search modal + Journey C/D（keyboard-only）═══════════════ */
{
  const { context, page } = await boot({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const j = {};

  /* B1. 用 `/` 開搜尋 */
  await page.keyboard.press("Tab");            // 先建立鍵盤互動上下文
  await page.keyboard.press("/");
  await page.waitForTimeout(600);
  j.openViaSlash = await page.evaluate(() => {
    const m = document.querySelector("#search-modal");
    const a = document.activeElement;
    return { modalExists: !!m, modalOpen: !!m && m.classList.contains("open"),
      activeId: a ? a.id : null, activeTag: a ? a.tagName.toLowerCase() : null,
      role: m ? m.getAttribute("role") : null, ariaModal: m ? m.getAttribute("aria-modal") : null,
      ariaLabelledby: m ? m.getAttribute("aria-labelledby") : null,
      contentRole: (document.querySelector(".search-content") || {}).getAttribute
        ? document.querySelector(".search-content").getAttribute("role") : null,
      appRootInert: document.querySelector("#app-root").hasAttribute("inert"),
      bodyOverflow: getComputedStyle(document.body).overflow,
      inputSize: (() => { const i = document.querySelector("#search-input"); if (!i) return null; const r = i.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
      closeBtnSize: (() => { const b = document.querySelector("#search-close"); if (!b) return null; const r = b.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
    };
  });

  /* B2. Focus trap：由 modal 內 Tab 會唔會走出去 */
  const trapSeq = [];
  for (let i = 1; i <= 8; i++) { await page.keyboard.press("Tab"); trapSeq.push(await page.evaluate(() => {
    const a = document.activeElement; const m = document.querySelector("#search-modal");
    return { tag: a ? a.tagName.toLowerCase() : null, id: a ? a.id : null,
      insideModal: !!a && !!m && m.contains(a) };
  })); }
  j.focusTrap = { seq: trapSeq, escaped: trapSeq.some((s) => !s.insideModal) };

  /* B3. 搜角色（Journey C 第一步） */
  await page.fill("#search-input", "夏晴");
  await page.waitForTimeout(500);
  const cBefore = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".search-result-item"));
    return { count: items.length,
      first: items[0] ? { text: items[0].textContent.replace(/\s+/g, " ").trim().slice(0, 40),
        tag: items[0].tagName.toLowerCase(), tabindex: items[0].getAttribute("tabindex"),
        role: items[0].getAttribute("role"), tabIndexProp: items[0].tabIndex,
        parentTag: items[0].parentElement.tagName.toLowerCase(),
        parentRole: items[0].parentElement.getAttribute("role") } : null,
      resultsContainerTabIndex: (() => { const r = document.querySelector("#search-results"); return r ? r.tabIndex : null; })() };
  });
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  const cAfterArrow = await page.evaluate(() => {
    const a = document.activeElement;
    return { activeTag: a ? a.tagName.toLowerCase() : null, activeId: a ? a.id : null,
      activeCls: a ? (a.getAttribute("class") || "") : null,
      activeIsResult: !!a && a.classList.contains("search-result-item"),
      anyAriaActiveDescendant: (() => { const i = document.querySelector("#search-input"); return i ? i.getAttribute("aria-activedescendant") : null; })(),
      resultListRole: (() => { const l = document.querySelector(".search-result-list"); return l ? l.getAttribute("role") : null; })() };
  });
  const chapterBefore = await page.evaluate(() => (document.querySelector(".ch-pill.active") || {}).textContent);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const cAfterEnter = await page.evaluate(() => ({
    modalOpen: (() => { const m = document.querySelector("#search-modal"); return !!m && m.classList.contains("open"); })(),
    activeId: document.activeElement ? document.activeElement.id : null,
    chapter: (document.querySelector(".ch-pill.active") || {}).textContent,
    hash: location.hash,
    storyPanelText: (document.querySelector("#story-panel-mount") || {}).textContent
      ? document.querySelector("#story-panel-mount").textContent.replace(/\s+/g, " ").trim().slice(0, 200) : null,
    hasCharacterDossier: !!document.querySelector(".character-dossier, .char-dossier, [data-character-dossier]"),
    hasRouteSection: !!document.querySelector(".story-routes"),
    routeItems: document.querySelectorAll(".route-item").length,
    waypointEls: document.querySelectorAll("[class*=waypoint]").length,
  }));
  j.journeyC = { query: "夏晴", resultsBefore: cBefore, afterArrowDown: cAfterArrow,
    chapterBefore, afterEnter: cAfterEnter,
    keyboardCanReachResult: cAfterArrow.activeIsResult,
    keyboardCanActivateResult: cAfterArrow.activeIsResult && !cAfterEnter.modalOpen };

  /* B4. Esc 關 modal 並還原 focus */
  await page.keyboard.press("/");
  await page.waitForTimeout(500);
  const focusBeforeEsc = await page.evaluate(() => document.activeElement ? document.activeElement.id : null);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  j.escSearch = { focusBeforeEsc, afterEsc: await page.evaluate(() => {
    const a = document.activeElement; const m = document.querySelector("#search-modal");
    return { modalOpen: !!m && m.classList.contains("open"), activeId: a ? a.id : null,
      activeTag: a ? a.tagName.toLowerCase() : null, hiddenStillFocusable: !!m && m.contains(a) };
  }) };

  /* B5. Journey D：搜事件 */
  await page.keyboard.press("/");
  await page.waitForTimeout(500);
  await page.fill("#search-input", "病腦");
  await page.waitForTimeout(500);
  const dBefore = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".search-result-item"));
    const types = {};
    items.forEach((i) => { const t = i.querySelector(".result-type"); if (t) types[t.textContent] = (types[t.textContent] || 0) + 1; });
    return { count: items.length, typeHistogram: types,
      hasZoneOrChapterType: /zone|章/.test(Array.from(document.querySelectorAll(".result-type")).map((e) => e.textContent).join("")) };
  });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const dAfterEnter = await page.evaluate(() => ({
    modalOpen: (() => { const m = document.querySelector("#search-modal"); return !!m && m.classList.contains("open"); })(),
    chapter: (document.querySelector(".ch-pill.active") || {}).textContent, hash: location.hash,
    selectedEventVisible: !!document.querySelector(".event-marker.is-selected, .event-item.is-selected"),
    detailPanel: (document.querySelector("#story-panel-mount") || {}).textContent
      ? document.querySelector("#story-panel-mount").textContent.replace(/\s+/g, " ").trim().slice(0, 160) : null,
  }));
  j.journeyD = { query: "病腦", resultsBefore: dBefore, afterEnter: dAfterEnter,
    keyboardCanComplete: false };

  /* B6. 快捷鍵 */
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const shortcut = {};
  const chBefore = await page.evaluate(() => (document.querySelector(".ch-pill.active") || {}).textContent);
  await page.keyboard.press("ArrowRight"); await page.waitForTimeout(400);
  shortcut.arrowRight = { before: chBefore, after: await page.evaluate(() => (document.querySelector(".ch-pill.active") || {}).textContent) };
  await page.keyboard.press("Shift+Slash"); await page.waitForTimeout(500);
  shortcut.shiftSlash_questionMark = await page.evaluate(() => {
    const m = document.querySelector("#about-modal, .about-modal");
    return { aboutOpen: !!m && (m.classList.contains("open") || m.offsetParent !== null) };
  });
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  await page.keyboard.press("/"); await page.waitForTimeout(400);
  shortcut.slash_opensSearch = await page.evaluate(() => { const m = document.querySelector("#search-modal"); return !!m && m.classList.contains("open"); });
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  j.shortcuts = shortcut;

  /* B7. 鍵盤可唔可以喺地圖選嘢 */
  j.mapKeyboard = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("#svg-map .zone, #svg-map .zone-area, #svg-map .location-marker, #svg-map .event-marker, #svg-map .route-line, #svg-map .location-marker-cluster"));
    return { total: els.length, keyboardReachable: els.filter((e) => e.tabIndex >= 0).length,
      withRole: els.filter((e) => e.getAttribute("role")).length,
      withAriaLabel: els.filter((e) => e.getAttribute("aria-label")).length,
      withTitle: els.filter((e) => e.querySelector(":scope > title")).length };
  });

  out.keyboard = j;
  await context.close();
}

/* ═══════════════ C. desktop-1440 Tab 順序（對照）═══════════════ */
{
  const { context, page } = await boot({ viewport: { width: 1440, height: 900 } });
  const order = [];
  for (let i = 1; i <= 20; i++) { await page.keyboard.press("Tab"); order.push({ n: i, ...(await active(page)) }); }
  out.desktopTabOrder = { first20: order,
    firstIsSkipLink: order[0] && order[0].cls.includes("skip-link"),
    firstNavIndex: (order.find((t) => t.region === "topbar") || {}).n || null };
  out.desktopFocusRings = [];
  for (const sel of ["#btn-mode", "#map-zoom-in", "#legend-lang-btn"]) out.desktopFocusRings.push(await measureRing(page, sel));
  await context.close();
}

fs.writeFileSync(path.join(OUT, "a7-keyboard-journey.json"), JSON.stringify(out, null, 2));
console.log("WROTE a7-keyboard-journey.json");
console.log(JSON.stringify({
  mobileTabOrderFirst10: out.mobileTabOrder.first25.slice(0, 10),
  mobileSkipLink: out.mobileSkipLink,
  panel: { initial: out.panel.initial, afterOpen: out.panel.afterOpen, afterEsc: { collapsed: out.panel.afterEsc.collapsed, activeId: out.panel.afterEsc.active && out.panel.afterEsc.active.id }, afterEsc2: out.panel.afterEsc2, collapsedFocusReach: out.panel.collapsedFocusReach },
  journeyC: out.keyboard.journeyC,
  journeyD: out.keyboard.journeyD,
  escSearch: out.keyboard.escSearch,
  focusTrap: out.keyboard.focusTrap,
  shortcuts: out.keyboard.shortcuts,
  mapKeyboard: out.keyboard.mapKeyboard,
  openViaSlash: out.keyboard.openViaSlash,
  rings: out.mobileFocusRings.map((r) => ({ sel: r.selector, ringVisible: r.ringVisible, ringChangedPx: r.ringChangedPx, reachedByTab: r.reachedByTab, clipping: r.clippingAncestors })),
}, null, 1));
await browser.close();

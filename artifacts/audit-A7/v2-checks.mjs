/**
 * World Atlas V2 —— A7 Mobile / A11y 驗收斷言（共用模組）
 *
 * 對應 spec §7.2 第 9、10、11 項。由以下兩處共用：
 *   - artifacts/audit-A7/v2-mobile-a11y-runner.mjs（獨立 runner，唔需要 test framework）
 *   - artifacts/audit-A7/v2-mobile-a11y.e2e.test.ts（vitest spec，可入 npm test）
 *
 * 每個 check：{ group, id, desc, fn(page) => { pass, detail, evidence } }
 */

export const INLINE_LINK_ALLOWLIST = [/\.link-to-loc$/];

/** 目標網址。預設跟專案 e2e 慣例（5174）；跑 baseline 時用 BASE_URL 覆蓋。 */
export const BASE = (typeof process !== "undefined" && process.env && process.env.BASE_URL) ||
  "http://localhost:5174/";

/** 每個 V2 斷言 */
export const checks = [];
function check(group, id, desc, fn) { checks.push({ group, id, desc, fn }); }

/** 導覽到目標頁並等 app 完成首次 render。 */
async function nav(p) {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map", { timeout: 20000 });
  await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await p.waitForTimeout(1400);
}
export { nav };

/* ══════════════════════════════════════════════════════════════════════════
 * 共用工具（注入頁面）
 * ══════════════════════════════════════════════════════════════════════════ */
export const HELPERS = `
window.__v2 = {};
window.__v2.interactive = function (root) {
  const SEL = 'button, a[href], [role="button"], [role="link"], [role="option"], [role="tab"],' +
              ' input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  return Array.from((root || document).querySelectorAll(SEL));
};
window.__v2.rect = function (el) { const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
window.__v2.visible = function (el) {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
window.__v2.label = function (el) {
  return (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
};
window.__v2.hasSafeArea = function () {
  let n = 0;
  for (const ss of document.styleSheets) {
    let rules; try { rules = ss.cssRules; } catch (e) { continue; }
    const walk = (rs) => { for (const r of rs) { if (r.cssRules) walk(r.cssRules);
      if (r.cssText && /env\\(\\s*safe-area-inset/.test(r.cssText)) n++; } };
    if (rules) walk(rules);
  }
  return n;
};
window.__v2.focusRingVisible = async function (el, pad) {
  const r = el.getBoundingClientRect();
  const clip = { x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)),
    width: Math.ceil(r.width + pad * 2), height: Math.ceil(r.height + pad * 2) };
  const inner = { x: Math.floor(r.x) - clip.x, y: Math.floor(r.y) - clip.y,
    w: Math.ceil(r.width), h: Math.ceil(r.height) };
  return { clip, inner };
};
`;

/* ══════════════════════════════════════════════════════════════════════════
 * 9. Mobile 390×844
 * ══════════════════════════════════════════════════════════════════════════ */
check("9-mobile", "9.1", "冇橫向 overflow（docScrollWidth <= viewport 闊度）", async (p) => {
  await nav(p);
  const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth }));
  return { pass: r.sw <= r.vw + 1, detail: `scrollWidth=${r.sw} viewport=${r.vw}` };
});

check("9-mobile", "9.2", "所有可見可點元素 >= 44x44 CSS px（inline link 除外）", async (p) => {
  await nav(p);
  const fails = await p.evaluate((allow) => {
    const re = allow.map((s) => new RegExp(s));
    return window.__v2.interactive().filter((el) => {
      if (!window.__v2.visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
      const cls = typeof el.className === "string" ? el.className : "";
      if (re.some((x) => x.test(cls))) return false;
      return r.width < 44 || r.height < 44;
    }).map((el) => ({ sel: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
      (typeof el.className === "string" && el.className ? "." + el.className.split(" ")[0] : ""),
      label: window.__v2.label(el), ...window.__v2.rect(el) }));
  }, INLINE_LINK_ALLOWLIST.map((r) => r.source));
  return { pass: fails.length === 0, detail: `${fails.length} 個元素 < 44px`, evidence: fails.slice(0, 30) };
});

check("9-mobile", "9.3", "有 bottom sheet（story panel 係 sheet 而唔係側邊抽屜）", async (p) => {
  await nav(p);
  const r = await p.evaluate(() => {
    const pane = document.querySelector("#story-pane");
    if (!pane) return { found: false };
    const cs = getComputedStyle(pane);
    return {
      found: true,
      isSheet: pane.matches("[data-sheet], .bottom-sheet, [role=dialog]") ||
               cs.bottom === "0px" && (cs.borderTopLeftRadius !== "0px" || cs.top !== "0px"),
      hasDragHandle: !!pane.querySelector("[data-sheet-handle], .sheet-handle, [class*=grab], [class*=drag]"),
      hasSnapPoints: !!pane.dataset.snap || !!pane.querySelector("[data-snap]"),
      position: cs.position, top: cs.top, bottom: cs.bottom, width: cs.width, height: cs.height,
      role: pane.getAttribute("role"), ariaModal: pane.getAttribute("aria-modal"),
      ariaLabel: pane.getAttribute("aria-label"),
      touchAction: cs.touchAction,
      paddingBottom: cs.paddingBottom,
      inertWhenCollapsed: pane.classList.contains("is-collapsed") ? pane.hasAttribute("inert") : null,
    };
  });
  const ok = r.found && r.isSheet && r.hasDragHandle && r.hasSnapPoints;
  return { pass: ok, detail: JSON.stringify(r), evidence: r };
});

check("9-mobile", "9.4", "safe area：meta viewport-fit=cover + 用到 env(safe-area-inset-*)", async (p) => {
  await nav(p);
  const r = await p.evaluate(() => ({
    meta: document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
    envCount: window.__v2.hasSafeArea(),
    ctrlBottomGap: (() => { const e = document.querySelector(".map-controls");
      if (!e) return null; return innerHeight - e.getBoundingClientRect().bottom; })(),
  }));
  const cover = /viewport-fit\s*=\s*cover/.test(r.meta || "");
  return { pass: cover && r.envCount > 0, detail: `viewport-fit=cover:${cover} env()規則:${r.envCount}`, evidence: r };
});

check("9-mobile", "9.5", "頂欄：標題 <= 2 行、導覽 <= 1 行、導覽按鈕 >= 44x44", async (p) => {
  await nav(p);
  const r = await p.evaluate(() => {
    const h1 = document.querySelector("#topbar h1");
    const cs = h1 ? getComputedStyle(h1) : null;
    const lh = cs ? (cs.lineHeight === "normal" ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight)) : 0;
    const lines = h1 && lh ? Math.round(h1.getBoundingClientRect().height / lh) : null;
    const btns = Array.from(document.querySelectorAll("#topbar nav .nav-btn"));
    const rows = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size;
    const tooSmall = btns.filter((b) => { const x = b.getBoundingClientRect(); return x.width < 44 || x.height < 44; }).length;
    return { titleLines: lines, navRows: rows, navBtnCount: btns.length, navBtnsTooSmall: tooSmall };
  });
  return { pass: r.titleLines <= 2 && r.navRows <= 1 && r.navBtnsTooSmall === 0, detail: JSON.stringify(r), evidence: r };
});

check("9-mobile", "9.6", "legend 遮蓋地圖 <= 15% 面積（或可摺疊）", async (p) => {
  await nav(p);
  const r = await p.evaluate(() => {
    const map = document.querySelector("#svg-map-mount").getBoundingClientRect();
    const ov = document.querySelector("#map-overlay");
    if (!ov) return { pct: 0, collapsible: false };
    const b = ov.getBoundingClientRect();
    const inter = Math.max(0, Math.min(b.right, map.right) - Math.max(b.left, map.left)) *
                  Math.max(0, Math.min(b.bottom, map.bottom) - Math.max(b.top, map.top));
    return { pct: +(inter / (map.width * map.height) * 100).toFixed(1),
      collapsible: !!ov.querySelector("[aria-expanded], details, button[aria-controls]") };
  });
  return { pass: r.pct <= 15 || r.collapsible, detail: `遮蓋 ${r.pct}% 地圖；可摺疊=${r.collapsible}`, evidence: r };
});

/* ══════════════════════════════════════════════════════════════════════════
 * 10. Keyboard
 * ══════════════════════════════════════════════════════════════════════════ */
check("10-keyboard", "10.1", "第一個 Tab stop 係 skip link，且 Enter 後 focus 真係移到 <main>", async (p) => {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(1200);
  await p.keyboard.press("Tab");
  const first = await p.evaluate(() => ({ cls: document.activeElement?.className,
    tag: document.activeElement?.tagName }));
  await p.keyboard.press("Enter");
  await p.waitForTimeout(400);
  const after = await p.evaluate(() => ({
    activeIsMain: document.activeElement === document.querySelector("#map-pane"),
    activeId: document.activeElement?.id || null,
    mainTabIndex: document.querySelector("#map-pane")?.getAttribute("tabindex"),
  }));
  const pass = String(first.cls).includes("skip-link") && after.activeIsMain;
  return { pass, detail: `firstTab=${first.tag}.${first.cls} → Enter 後 activeId=${after.activeId}（main tabindex=${after.mainTabIndex}）`,
    evidence: { first, after } };
});

check("10-keyboard", "10.2", "Tab 20 次內可以到達頂部導覽（搜尋／關於／面板）", async (p) => {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(1200);
  const seq = [];
  let hitNavAt = null;
  for (let i = 1; i <= 20; i++) {
    await p.keyboard.press("Tab");
    const r = await p.evaluate(() => ({ inTopbar: !!document.activeElement?.closest("#topbar"),
      id: document.activeElement?.id || null }));
    seq.push(r.id);
    if (r.inTopbar && hitNavAt === null) hitNavAt = i;
  }
  return { pass: hitNavAt !== null, detail: `首次到達導覽：Tab #${hitNavAt ?? ">20"}`,
    evidence: { first20: seq } };
});

check("10-keyboard", "10.3", "全頁 Tab stop 總數 <= 300（章節條／編年史必須 virtualize 或用 roving tabindex）", async (p) => {
  await nav(p);
  const n = await p.evaluate(() =>
    document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])').length);
  return { pass: n <= 300, detail: `focusable 元素總數 = ${n}`, evidence: { totalFocusable: n } };
});

check("10-keyboard", "10.4", "focus 指示器喺所有導覽／控制項都可見（冇被 clip-path 剪走）", async (p) => {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(1500);
  await p.addStyleTag({ content: "*,*::before,*::after{animation:none !important;transition:none !important}" });
  await p.waitForTimeout(250);
  const targets = ["#btn-mode", "#btn-search", "#btn-about", "#btn-toggle-panel",
                   "#map-zoom-in", "#map-zoom-out", "#map-reset", "#legend-lang-btn"];
  const results = [];
  for (const sel of targets) {
    const box = await p.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el || getComputedStyle(el).display === "none") return null;
      const r = el.getBoundingClientRect();
      const pad = 10;
      return { x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)),
        width: Math.ceil(r.width + pad * 2), height: Math.ceil(r.height + pad * 2),
        ix: Math.floor(r.x) - Math.max(0, Math.floor(r.x - pad)),
        iy: Math.floor(r.y) - Math.max(0, Math.floor(r.y - pad)),
        iw: Math.ceil(r.width), ih: Math.ceil(r.height) };
    }, sel);
    if (!box) { results.push({ sel, skipped: true }); continue; }
    await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await p.waitForTimeout(100);
    const a = (await p.screenshot({ clip: box })).toString("base64");
    await p.evaluate((s) => document.querySelector(s).focus(), sel);
    await p.waitForTimeout(140);
    const b = (await p.screenshot({ clip: box })).toString("base64");
    const stat = await p.evaluate(async ({ a, b, box }) => {
      const dec = async (x) => { const res = await fetch("data:image/png;base64," + x);
        const bmp = await createImageBitmap(await res.blob());
        const cv = new OffscreenCanvas(bmp.width, bmp.height); const c = cv.getContext("2d");
        c.drawImage(bmp, 0, 0); return c.getImageData(0, 0, bmp.width, bmp.height); };
      const A = await dec(a), B = await dec(b);
      let ring = 0;
      for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
        const i = (y * A.width + x) * 4;
        const inInner = x >= box.ix && x < box.ix + box.iw && y >= box.iy && y < box.iy + box.ih;
        if (inInner) continue;
        if (Math.abs(A.data[i] - B.data[i]) > 6 || Math.abs(A.data[i + 1] - B.data[i + 1]) > 6 ||
            Math.abs(A.data[i + 2] - B.data[i + 2]) > 6) ring++;
      }
      return ring;
    }, { a, b, box });
    results.push({ sel, ringPxOutside: stat, visible: stat > 20 });
  }
  const failed = results.filter((r) => r.skipped !== true && r.visible === false);
  return { pass: failed.length === 0,
    detail: failed.length ? `focus ring 不可見：${failed.map((f) => f.sel).join(", ")}` : "全部可見",
    evidence: results };
});

check("10-keyboard", "10.5", "Esc 關閉 modal / sheet，並將 focus 還原去觸發按鈕", async (p) => {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(1400);
  const out = {};
  // 搜尋 modal
  await p.evaluate(() => document.querySelector("#btn-search").focus());
  await p.evaluate(() => document.querySelector("#btn-search").click());
  await p.waitForTimeout(350);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(350);
  out.search = await p.evaluate(() => ({
    open: document.querySelector("#search-modal")?.classList.contains("open"),
    activeId: document.activeElement?.id || null,
  }));
  // 故事面板（mobile sheet）
  out.sheet = await p.evaluate(() => {
    const pane = document.querySelector("#story-pane");
    return { collapsedBefore: pane?.classList.contains("is-collapsed") };
  });
  await p.evaluate(() => document.querySelector("#btn-toggle-panel")?.click());
  await p.waitForTimeout(400);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  out.sheet.afterEscCollapsed = await p.evaluate(() =>
    document.querySelector("#story-pane")?.classList.contains("is-collapsed"));
  out.sheet.activeId = await p.evaluate(() => document.activeElement?.id || null);
  const pass = out.search.open === false && out.search.activeId === "btn-search" &&
               out.sheet.afterEscCollapsed === true;
  return { pass, detail: JSON.stringify(out), evidence: out };
});

check("10-keyboard", "10.6", "搜尋結果可以用方向鍵 + Enter 選取（Journey C/D 純鍵盤可行）", async (p) => {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(1400);
  await p.keyboard.press("/");
  await p.waitForTimeout(350);
  await p.keyboard.type("商場");
  await p.waitForTimeout(500);
  const before = await p.evaluate(() => ({
    count: document.querySelectorAll(".search-result-item").length,
    activeId: document.activeElement?.id,
    firstItemTabIndex: document.querySelector(".search-result-item")?.tabIndex,
  }));
  await p.keyboard.press("ArrowDown");
  await p.waitForTimeout(200);
  const afterArrow = await p.evaluate(() => ({
    activeIsResult: !!document.activeElement?.closest?.(".search-result-item"),
    activeRole: document.activeElement?.getAttribute?.("role"),
    activeId: document.activeElement?.id || null,
  }));
  await p.keyboard.press("Enter");
  await p.waitForTimeout(600);
  const afterEnter = await p.evaluate(() => ({
    modalOpen: document.querySelector("#search-modal")?.classList.contains("open"),
    chapter: document.querySelector("#strip-ch-num")?.textContent,
  }));
  const pass = before.count > 0 && afterArrow.activeIsResult && afterEnter.modalOpen === false;
  return { pass, detail: JSON.stringify({ before, afterArrow, afterEnter }),
    evidence: { before, afterArrow, afterEnter } };
});

check("10-keyboard", "10.7", "modal 有 role=dialog + aria-modal + focus trap + focus restore", async (p) => {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(1400);
  await p.evaluate(() => document.querySelector("#btn-about").focus());
  await p.evaluate(() => document.querySelector("#btn-about").click());
  await p.waitForTimeout(400);
  const open = await p.evaluate(() => {
    const c = document.querySelector("#about-modal .modal-content");
    return { role: c?.getAttribute("role"), ariaModal: c?.getAttribute("aria-modal"),
      ariaLabelledby: c?.getAttribute("aria-labelledby"),
      focusInside: !!document.querySelector("#about-modal")?.contains(document.activeElement),
      bgInert: document.querySelector("#app-root")?.hasAttribute("inert") };
  });
  let escaped = false;
  for (let i = 0; i < 12; i++) {
    await p.keyboard.press("Tab");
    const inside = await p.evaluate(() => !!document.querySelector("#about-modal")?.contains(document.activeElement));
    if (!inside) { escaped = true; break; }
  }
  await p.keyboard.press("Escape");
  await p.waitForTimeout(350);
  const closed = await p.evaluate(() => ({
    open: document.querySelector("#about-modal")?.classList.contains("open"),
    activeId: document.activeElement?.id || null,
    hiddenStillFocusable: document.querySelector("#about-modal:not(.open) #about-close")?.tabIndex === 0,
  }));
  const pass = open.role === "dialog" && open.ariaModal === "true" && open.focusInside &&
               !escaped && closed.open === false && closed.activeId === "btn-about" &&
               !closed.hiddenStillFocusable;
  return { pass, detail: JSON.stringify({ open, escaped, closed }), evidence: { open, escaped, closed } };
});

check("10-keyboard", "10.8", "快捷鍵仍然有效（←/→ 改章、/ 開搜尋、? 開幫助）", async (p) => {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(1400);
  const before = await p.evaluate(() => document.querySelector("#strip-ch-num")?.textContent);
  await p.keyboard.press("ArrowRight");
  await p.waitForTimeout(300);
  const afterRight = await p.evaluate(() => document.querySelector("#strip-ch-num")?.textContent);
  await p.keyboard.press("/");
  await p.waitForTimeout(300);
  const slash = await p.evaluate(() => document.querySelector("#search-modal")?.classList.contains("open"));
  await p.keyboard.press("Escape");
  await p.waitForTimeout(250);
  await p.keyboard.press("Shift+Slash");
  await p.waitForTimeout(300);
  const help = await p.evaluate(() => document.querySelector("#about-modal")?.classList.contains("open"));
  const pass = before !== afterRight && slash === true && help === true;
  return { pass, detail: `ch ${before}→${afterRight}; / →${slash}; ? →${help}`,
    evidence: { before, afterRight, slash, help } };
});

check("10-keyboard", "10.9", "地圖標記／區域可以用鍵盤選取（唔可以純滑鼠）", async (p) => {
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(1600);
  const r = await p.evaluate(() => {
    const all = document.querySelectorAll(".location-marker, .event-marker, .zone, .route-line");
    const reachable = Array.from(all).filter((e) => e.tabIndex >= 0 || e.getAttribute("role") === "button");
    return { total: all.length, keyboardReachable: reachable.length };
  });
  return { pass: r.total > 0 && r.keyboardReachable > 0,
    detail: `${r.keyboardReachable}/${r.total} 個地圖元素鍵盤可達`, evidence: r };
});

/* ══════════════════════════════════════════════════════════════════════════
 * 11. Local-only network
 * ══════════════════════════════════════════════════════════════════════════ */
check("11-network", "11.1", "零外部請求（唔可以有任何非 localhost host）", async (p) => {
  const external = [];
  const handler = (req) => {
    try { const u = new URL(req.url());
      if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) external.push(u.href);
    } catch { /* data: / blob: */ }
  };
  p.on("request", handler);
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(2500);
  // 觸發地圖互動，睇會唔會偷偷載 tile
  await p.evaluate(() => document.querySelector("#map-zoom-in")?.click());
  await p.waitForTimeout(1200);
  p.off("request", handler);
  return { pass: external.length === 0, detail: `${external.length} 個外部請求`, evidence: external.slice(0, 20) };
});

check("11-network", "11.2", "冇 map / tile / geocoder 相關外部 host（即使係 localhost 都要係本機檔案）", async (p) => {
  const banned = /(tile|mapbox|googleapis|openstreetmap|arcgis|bing|carto|esri|geocode)/i;
  const hits = [];
  const handler = (req) => { if (banned.test(req.url())) hits.push(req.url()); };
  p.on("request", handler);
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map");
  await p.waitForTimeout(2500);
  p.off("request", handler);
  return { pass: hits.length === 0, detail: `${hits.length} 個疑似 map/tile/geocoder 請求`, evidence: hits.slice(0, 20) };
});


/* ══════════════════════════════════════════════════════════════════════════
 * 共用執行器
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 用一個全新 390×844 touch context 跑單一 check。
 * @param {import('playwright').Browser} browser
 * @param {{group:string,id:string,desc:string,fn:Function}} c
 */
export async function runCheck(browser, c) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.addInitScript({ content: HELPERS });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  let res;
  try {
    res = await c.fn(page);
  } catch (e) {
    res = { pass: false, detail: "runner 例外：" + (e instanceof Error ? e.message : String(e)), evidence: null };
  }
  await context.close();
  return { group: c.group, id: c.id, desc: c.desc, ...res, consoleErrors };
}

/** 跑齊所有 check。 */
export async function runAll(browser) {
  const results = [];
  for (const c of checks) results.push(await runCheck(browser, c));
  return results;
}

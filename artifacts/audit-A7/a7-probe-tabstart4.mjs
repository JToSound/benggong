import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const res = {};
const A = async (p) => await p.evaluate(() => { const a = document.activeElement;
  if (!a) return "null"; return a.tagName + "." + ((a.getAttribute && a.getAttribute("class")) || "") + "#" + (a.id || ""); });
const mk = async (vp) => { const c = await browser.newContext(vp); const p = await c.newPage();
  await p.goto(BASE, { waitUntil: "load" }); await p.waitForSelector("#svg-map", { timeout: 20000 });
  await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await p.waitForTimeout(1500); return { c, p }; };

// F: 將 focus 序起點移到 skip-link（focus 完即 blur），再 Tab
{ const { c, p } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await p.evaluate(() => { const s = document.querySelector(".skip-link"); s.focus(); s.blur(); });
  const seq = []; for (let i = 0; i < 4; i++) { await p.keyboard.press("Tab"); seq.push(await A(p)); }
  res.F_afterSkipLinkFocusBlur = seq; await c.close(); }

// G: 長掃 —— Tab 350 次，搵 skip-link / 8 個 nav 按鈕第一次出現嘅位置
{ const { c, p } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const seen = {}; const order = [];
  for (let i = 1; i <= 350; i++) {
    await p.keyboard.press("Tab");
    const info = await p.evaluate(() => { const a = document.activeElement;
      return { key: a.tagName + "#" + (a.id || "") + "." + ((a.getAttribute && a.getAttribute("class")) || "").split(/\s+/)[0],
        id: a.id || null, cls: (a.getAttribute && a.getAttribute("class")) || "",
        region: a.closest("#topbar") ? "topbar" : a.closest("#chapter-strip-mount") ? "chapterStrip" : a.closest(".map-controls") ? "mapControls" : a.closest("#map-overlay") ? "mapLegend" : a.closest("#story-pane") ? "storyPane" : a.closest("#map-pane") ? "mapPane" : "other" }; });
    if (i <= 6) order.push({ n: i, key: info.key, region: info.region });
    if (!seen[info.key]) seen[info.key] = i;
    if (i === 350) res.G_last = info.key;
  }
  res.G_firstSeen = { "a.skip-link": seen["A#.skip-link"] || null,
    "button#btn-mode": seen["BUTTON#btn-mode.nav-btn"] || null,
    "button#btn-search": seen["BUTTON#btn-search.nav-btn"] || null,
    "button#btn-toggle-panel": seen["BUTTON#btn-toggle-panel.nav-btn"] || null,
    "button#legend-lang-btn": seen["BUTTON#legend-lang-btn.legend-lang-btn"] || null,
    "button#map-zoom-in": seen["BUTTON#map-zoom-in.map-ctrl"] || null,
    "button.chr-export-json": seen["BUTTON#chr-export-json.chr-clear"] || null };
  res.G_first6 = order;
  res.G_distinctKeys = Object.keys(seen).length;
  res.G_topbarStops = Object.entries(seen).filter(([k]) => k.includes("#btn-")).map(([k, v]) => k + "@" + v);
  await c.close(); }

console.log(JSON.stringify(res, null, 1));
await browser.close();

/**
 * A7 探測：地圖互動元素嘅**真正**鍵盤可選取性。
 *
 * ⚠️ 為何要重寫（2026-09-24）
 * ========================
 * 舊版只量 `els.filter(e => e.tabIndex >= 0).length` —— 即係「有冇
 * `tabindex`」。但 `tabindex="0"` **唔等於**真係可以用鍵盤揀到：
 *   · 元素可能離屏／被遮蓋（focus 到但用戶睇唔到）；
 *   · 可能冇 `keydown` 路徑（focus 到但 `Enter` 冇反應）；
 *   · roving tabindex 之下**只有一個** `tabindex="0"`，但全部元素
 *     都可以經方向鍵到達 —— 舊指標會報「1」，完全反映唔到實況。
 *
 * 新版量度方法（**真鍵盤驅動**，唔靠屬性推斷）
 * =========================================
 * 1. 焦點放 `#svg-map` → 按 `Tab` → 記低落到邊個地圖元素。
 * 2. 連按 `ArrowRight`（環繞），每次記低 `document.activeElement`
 *    → 數**唔同**元素嘅數目 = `keyboardReachable`。
 * 3. 揀一個元素按 `Enter` → 驗證真係觸發咗（`.zone.is-selected` 或 URL 帶 id）
 *    = `keyboardActivatable`。
 * 4. 同時報屬性覆蓋率（`role` / `aria-label`）同 roving 不變式
 *    （任何時候只有一個 `tabindex="0"`）。
 *
 * 用法：
 *   BASE_URL=http://localhost:5174/ node artifacts/audit-A7/a7-probe-map2.mjs
 * 輸出：artifacts/audit-A7/a7-probe-map2.json
 */

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5190/";
const OUT = "artifacts/audit-A7/a7-probe-map2.json";
const MAX_ARROW = 200;

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map", { timeout: 20000 });
await page
  .waitForFunction(
    () => document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ?? false,
    null,
    { timeout: 20000 },
  )
  .catch(() => {});
await page.waitForTimeout(1500);

// 縮放到睇得到 zone 嘅級別
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
  await page.waitForTimeout(150);
}
await page.waitForTimeout(900);

/** 元素身份（用嚟數「唔同元素」）。 */
const IDENTITY = () => {
  const el = document.activeElement;
  if (!el) return null;
  const id =
    el.getAttribute?.("data-zone-id") ??
    el.getAttribute?.("data-loc-id") ??
    el.getAttribute?.("data-event-id") ??
    el.getAttribute?.("data-route-id") ??
    "";
  const cls = (el.getAttribute?.("class") ?? "").split(/\s+/)[0];
  return `${cls}|${id}`;
};

// ---- 屬性覆蓋率 + roving 不變式 ----
const attrs = await page.evaluate(() => {
  const SEL = ".zone, .route-line, .location-marker, .location-marker-cluster, .event-marker";
  const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
  const zero = els.filter((e) => e.getAttribute("tabindex") === "0");
  const svgEls = Array.from(document.querySelectorAll("#svg-map *"));
  return {
    interactiveTotal: els.length,
    hasRole: els.filter((e) => e.getAttribute("role") === "button").length,
    hasAriaLabel: els.filter((e) => (e.getAttribute("aria-label") ?? "").length > 0).length,
    tabindexZeroCount: zero.length,
    tabindexMinusOneCount: els.filter((e) => e.getAttribute("tabindex") === "-1").length,
    oldMetricHasTabindexGE0: els.filter((e) => e.tabIndex >= 0).length,
    svgTotal: svgEls.length,
    svgWithRole: svgEls.filter((e) => e.getAttribute("role")).length,
    svgWithAriaLabel: svgEls.filter((e) => e.getAttribute("aria-label")).length,
  };
});

// ---- 真鍵盤：Tab 入地圖 ----
await page.evaluate(() => {
  const s = document.querySelector("#svg-map");
  if (s && typeof s.focus === "function") s.focus();
});
await page.keyboard.press("Tab");
await page.waitForTimeout(250);
const afterTab = await page.evaluate(IDENTITY);

// ---- 真鍵盤：方向鍵環繞，數唔同元素 ----
const reached = new Set();
if (afterTab) reached.add(afterTab);
for (let i = 0; i < MAX_ARROW; i++) {
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(60);
  const id = await page.evaluate(IDENTITY);
  if (id) reached.add(id);
}

// ---- 真鍵盤：Enter 啟動 ----
const before = await page.evaluate(() => ({
  sel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
  url: location.href,
}));
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
const after = await page.evaluate(() => ({
  sel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
  url: location.href,
}));
const activated = after.sel > 0 && after.url.includes("zone=");

// ---- 焦點環：focused vs unfocused 像素差 ----
let ringVisible = null;
const box = await page.evaluate(() => {
  const el = document.querySelector('#svg-map [tabindex="0"]');
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const pad = 8;
  const x = Math.max(0, Math.floor(b.x - pad));
  const y = Math.max(0, Math.floor(b.y - pad));
  const right = Math.min(window.innerWidth, Math.ceil(b.right + pad));
  const bottom = Math.min(window.innerHeight, Math.ceil(b.bottom + pad));
  if (right - x < 12 || bottom - y < 12) return null;
  return { x, y, width: right - x, height: bottom - y };
});
if (box) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(250);
  const unfocused = await page.screenshot({ clip: box });
  await page.evaluate(() => {
    const s = document.querySelector("#svg-map");
    if (s && typeof s.focus === "function") s.focus();
  });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(250);
  const focused = await page.screenshot({ clip: box });
  ringVisible = Buffer.compare(unfocused, focused) !== 0;
}

const res = {
  measuredAt: new Date().toISOString(),
  baseUrl: BASE,
  viewport: "1400x900",
  // 新指標（真鍵盤驅動）
  keyboardReachable: reached.size,
  keyboardReachableIds: [...reached].slice(0, 30),
  keyboardActivatable: activated,
  focusRingVisible: ringVisible,
  tabEnteredMap: afterTab !== null,
  // 舊指標（保留做對照）
  ...attrs,
  activationEvidence: { before, after },
};

fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
await browser.close();

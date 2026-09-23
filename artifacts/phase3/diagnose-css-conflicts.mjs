/**
 * 舊 CSS 遷移：量「衝突 class」嘅**實際 computed style**。
 *
 * 為何要呢個腳本
 * --------------
 * `analyze-css-conflicts.py` 只係**靜態分析**（睇 CSS 文字），會誤報
 * 「被 `!important` 覆蓋」或者「被後載入 CSS 覆蓋」嘅情況。
 * 呢個腳本喺**真實瀏覽器**量 computed style —— 只報「實際生效」嘅值。
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";

/** 衝突 class + 要量嘅屬性（同 analyze-css-conflicts.py 對應）。 */
const TARGETS = {
  ".basemap-canvas": ["z-index", "position"],
  ".ch-pill": ["height", "min-width"],
  ".chr-period-line": ["height", "width", "position", "top"],
  ".chronicle": ["display", "grid-template-columns"],
  ".map-legend": ["max-width", "z-index", "position"],
  ".strip-track": ["height", "z-index"],
  ".area": ["width", "height", "z-index"],
  ".dot": ["width", "height"],
  ".line": ["width", "height"],
  ".map-controls": ["bottom", "right"],
};

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);

const res = await page.evaluate((targets) => {
  const out = [];
  for (const [sel, props] of Object.entries(targets)) {
    const el = document.querySelector(sel);
    if (!el) {
      out.push({ sel, missing: true });
      continue;
    }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const vals = {};
    for (const p of props) vals[p] = cs.getPropertyValue(p);
    out.push({
      sel,
      vals,
      size: `${Math.round(r.width)}×${Math.round(r.height)}`,
      visible: cs.display !== "none" && cs.visibility !== "hidden",
    });
  }
  return out;
}, TARGETS);

console.log("=== 衝突 class 嘅實際 computed style ===");
for (const r of res) {
  if (r.missing) {
    console.log(`\n  ${r.sel}: 唔存在`);
    continue;
  }
  console.log(`\n  ${r.sel}  [${r.size}] visible=${r.visible}`);
  for (const [k, v] of Object.entries(r.vals)) console.log(`     ${k} = ${v}`);
}

// ---- Chronicle view（`.chronicle` / `.chr-period-line` 只喺呢度存在）----
const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await p2.goto(`${BASE}?view=chronicle`, { waitUntil: "networkidle" });
await p2.waitForTimeout(3500);
const res2 = await p2.evaluate(() => {
  const out = [];
  for (const sel of [".chronicle", ".chr-period-line", ".chr-entry", ".chr-links", ".chr-entry-head"]) {
    const el = document.querySelector(sel);
    if (!el) {
      out.push({ sel, missing: true });
      continue;
    }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      sel,
      display: cs.display,
      position: cs.position,
      top: cs.top,
      width: cs.width,
      height: cs.height,
      size: `${Math.round(r.width)}×${Math.round(r.height)}`,
    });
  }
  return out;
});
console.log("\n=== Chronicle view ===");
for (const r of res2) {
  if (r.missing) {
    console.log(`  ${r.sel}: 唔存在`);
    continue;
  }
  console.log(
    `  ${r.sel} [${r.size}] display=${r.display} position=${r.position} top=${r.top} ` +
      `w=${r.width} h=${r.height}`,
  );
}

await browser.close();

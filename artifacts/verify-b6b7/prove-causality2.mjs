/*
 * 因果證明 v2 — 精準撞擊「zone-area」
 * ----------------------------------
 * v1 錯在：揀「最大 .zone」但嗰點嘅 topmost 元素係 event-marker（event 疊喺其上）。
 * 修法：直接由 elementFromPoint 揀一個真正命中 .zone-area 嘅點。
 */
import { chromium } from "@playwright/test";
const BASE = "http://localhost:5174/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });

async function pickZoneCenter(page) {
  return page.evaluate(() => {
    const areas = [...document.querySelectorAll("#svg-map .zone-area")];
    for (const a of areas) {
      const r = a.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      // 一定要真正命中 .zone-area 本身（唔可以係 event marker / route 疊喺上）
      if (hit && hit.classList?.contains("zone-area")) {
        const g = a.closest(".zone");
        return { id: g?.getAttribute("data-zone-id") ?? g?.id, x, y, hitClass: hit.getAttribute("class") };
      }
    }
    return null;
  });
}

async function trial(page, breakIt) {
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("#svg-map", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const t = await pickZoneCenter(page);
  if (!t) return { error: "揀唔到命中 .zone-area 嘅點" };
  await page.evaluate((brk) => {
    window.__clicks = []; window.__md = []; window.__mu = [];
    document.addEventListener("click", e => window.__clicks.push(e.target?.getAttribute?.("class")), true);
    document.addEventListener("mousedown", e => window.__md.push(e.target?.getAttribute?.("class")), true);
    document.addEventListener("mouseup", e => window.__mu.push(e.target?.getAttribute?.("class")), true);
    if (brk) {
      // 喺 mouseup 之後、click 合成之前清空 zones layer
      window.addEventListener("mouseup", () => {
        document.getElementById("zones-layer")?.replaceChildren();
      }, true);
    }
  }, breakIt);
  await page.mouse.move(t.x, t.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => ({
    clicks: window.__clicks, md: window.__md, mu: window.__mu,
    selected: [...document.querySelectorAll("#svg-map .zone.is-selected")].map(e => e.getAttribute("data-zone-id")),
    url: location.search,
  }));
  return { target: t, ...r };
}

const p1 = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const normal = await trial(p1, false);
console.log("A 修復後（正常路徑，冇破壞）:");
console.log("  target =", JSON.stringify(normal.target));
console.log("  mousedown =", JSON.stringify(normal.md), " mouseup =", JSON.stringify(normal.mu));
console.log("  click =", JSON.stringify(normal.clicks));
console.log("  selected =", JSON.stringify(normal.selected), " url =", normal.url);

const p2 = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const broken = await trial(p2, true);
console.log("");
console.log("B 強制重現 bug（mouseup 期間清空 #zones-layer）:");
console.log("  target =", JSON.stringify(broken.target));
console.log("  mousedown =", JSON.stringify(broken.md), " mouseup =", JSON.stringify(broken.mu));
console.log("  click =", JSON.stringify(broken.clicks));
console.log("  selected =", JSON.stringify(broken.selected), " url =", broken.url);

console.log("");
console.log("=== 判定 ===");
console.log("正常路徑有 click:", normal.clicks.length > 0, "| 有選中:", normal.selected.length > 0);
console.log("破壞路徑 click 消失:", broken.clicks.length === 0);
console.log(broken.clicks.length === 0
  ? "✅ 根因成立：mouseup 換走 target → click 唔合成"
  : "❌ 根因唔成立：即使清空 layer，click 仍然派發 → B6 嘅根因解釋有誤");
await browser.close();

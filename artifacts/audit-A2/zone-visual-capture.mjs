/**
 * A2 補充擷取：zone 圖層視覺語言（放大後）、selected zone 狀態、chapter 視圖、
 * search modal、light 主題 zone 對照。
 *
 * 只讀 production，只寫 artifacts/audit-A2/。
 * 執行：node artifacts/audit-A2/zone-visual-capture.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:5180/";
const SHOTS = "artifacts/audit-A2/screenshots";
fs.mkdirSync(SHOTS, { recursive: true });

const b = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

async function page(theme, vp = { width: 1440, height: 900 }) {
  const ctx = await b.newContext({ viewport: vp, locale: "zh-HK", timezoneId: "Asia/Hong_Kong" });
  await ctx.addInitScript(([t]) => { try { localStorage.setItem("binggang-theme", t); } catch {} }, [theme]);
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForTimeout(2200);
  return { ctx, p };
}

// ---- 1) dark：放大令 zone 可見（唔選中）----
{
  const { ctx, p } = await page("dark");
  for (let i = 0; i < 10; i++) { const el = await p.$("#map-zoom-in"); if (!el) break; await el.click().catch(() => {}); await p.waitForTimeout(120); }
  await p.waitForTimeout(700);
  const info = await p.evaluate(() => {
    const z = document.querySelector(".zone");
    const a = z?.querySelector(".zone-area");
    const r = a?.getBoundingClientRect();
    return {
      zones: document.querySelectorAll(".zone").length,
      zoneLabels: document.querySelectorAll(".zone-label").length,
      areaRect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      pulse: document.querySelectorAll(".zone-pulse").length,
    };
  });
  console.log("dark zoom10 zone 可見性:", JSON.stringify(info));
  await p.screenshot({ path: `${SHOTS}/dark-desktop-zoom-zone-visible.png` });
  await ctx.close();
}

// ---- 2) dark：強制選中 zone（dispatch click 繞過 marker 遮擋）----
{
  const { ctx, p } = await page("dark");
  for (let i = 0; i < 10; i++) { const el = await p.$("#map-zoom-in"); if (!el) break; await el.click().catch(() => {}); await p.waitForTimeout(120); }
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const a = document.querySelector(".zone-area");
    a?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await p.waitForTimeout(1500);
  const info = await p.evaluate(() => ({
    selected: document.querySelectorAll(".zone.is-selected").length,
    dossierVisible: !document.querySelector("#zone-dossier-mount")?.hasAttribute("hidden"),
    dossierLen: (document.querySelector("#zone-dossier-mount")?.innerText || "").length,
    storyHidden: document.querySelector("#story-panel-mount")?.hasAttribute("hidden") ?? null,
    url: location.href,
  }));
  console.log("selected zone 狀態:", JSON.stringify(info));
  await p.screenshot({ path: `${SHOTS}/dark-desktop-zone-selected-dossier.png` });
  await ctx.close();
}

// ---- 3) light：同一 zone 狀態（對照 light 主題 zone 視覺）----
{
  const { ctx, p } = await page("light");
  for (let i = 0; i < 10; i++) { const el = await p.$("#map-zoom-in"); if (!el) break; await el.click().catch(() => {}); await p.waitForTimeout(120); }
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const a = document.querySelector(".zone-area");
    a?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await p.waitForTimeout(1400);
  const info = await p.evaluate(() => {
    const badge = document.querySelector(".zone-badge circle");
    const area = document.querySelector(".zone-area");
    return {
      badgeFill: badge ? getComputedStyle(badge).fill : null,
      areaFill: area ? getComputedStyle(area).fill : null,
      areaStroke: area ? getComputedStyle(area).stroke : null,
      labelStroke: (() => { const l = document.querySelector(".zone-label"); return l ? getComputedStyle(l).stroke : null; })(),
    };
  });
  console.log("light zone 視覺:", JSON.stringify(info));
  await p.screenshot({ path: `${SHOTS}/light-desktop-zone-selected-dossier.png` });
  await ctx.close();
}

// ---- 4) chapter 視圖（btn-mode 由 chronicle 切去 chapter）----
{
  const { ctx, p } = await page("dark");
  await p.click("#btn-mode").catch(() => {});
  await p.waitForTimeout(1500);
  const info = await p.evaluate(() => ({
    storyVisible: !document.querySelector("#story-panel-mount")?.hasAttribute("hidden"),
    text: (document.querySelector("#story-panel-mount")?.innerText || "").slice(0, 120),
  }));
  console.log("chapter 視圖:", JSON.stringify(info));
  await p.screenshot({ path: `${SHOTS}/dark-desktop-chapter-view.png` });
  await ctx.close();
}

// ---- 5) search modal ----
{
  const { ctx, p } = await page("dark");
  await p.click("#btn-search").catch(() => {});
  await p.waitForTimeout(1000);
  await p.fill("#search-input", "病").catch(() => {});
  await p.waitForTimeout(900);
  const info = await p.evaluate(() => ({
    modalOpen: !!document.querySelector(".modal-backdrop.open, .modal-backdrop"),
    results: document.querySelectorAll(".search-result-item").length,
  }));
  console.log("search modal:", JSON.stringify(info));
  await p.screenshot({ path: `${SHOTS}/dark-desktop-search.png` });
  await ctx.close();
}

// ---- 6) mobile：zone 可見 + dossier（bottom sheet 有冇）----
{
  const { ctx, p } = await page("dark", { width: 390, height: 844 });
  for (let i = 0; i < 10; i++) { const el = await p.$("#map-zoom-in"); if (!el) break; await el.click().catch(() => {}); await p.waitForTimeout(120); }
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const a = document.querySelector(".zone-area");
    a?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await p.waitForTimeout(1400);
  const info = await p.evaluate(() => {
    const m = document.querySelector("#zone-dossier-mount");
    const r = m?.getBoundingClientRect();
    return {
      dossierHidden: m?.hasAttribute("hidden"),
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      pos: m ? getComputedStyle(m.parentElement).position : null,
    };
  });
  console.log("mobile zone dossier:", JSON.stringify(info));
  await p.screenshot({ path: `${SHOTS}/dark-mobile-zone-dossier.png` });
  await ctx.close();
}

await b.close();
console.log("完成");

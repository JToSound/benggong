/**
 * A2 互動可達性探測：zone 點擊係唔係被 canvas 攔截？
 * 執行：node artifacts/audit-A2/hit-test-probe.mjs
 */
import { chromium } from "playwright";

const b = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
await ctx.addInitScript(() => { try { localStorage.setItem("binggang-theme", "dark"); } catch {} });
const p = await ctx.newPage();
await p.goto("http://localhost:5180/", { waitUntil: "load" });
await p.waitForTimeout(2500);

const r = await p.evaluate(() => {
  const z = document.querySelector(".zone");
  const area = z?.querySelector(".zone-area");
  const rect = area?.getBoundingClientRect();
  const cx = rect ? Math.round(rect.x + rect.width / 2) : 0;
  const cy = rect ? Math.round(rect.y + rect.height / 2) : 0;
  const hit = document.elementFromPoint(cx, cy);
  const stack = document.elementsFromPoint(cx, cy).slice(0, 6).map((e) => ({
    tag: e.tagName, cls: typeof e.className === "string" ? e.className : String(e.className?.baseVal ?? ""), id: e.id,
    pe: getComputedStyle(e).pointerEvents, z: getComputedStyle(e).zIndex, pos: getComputedStyle(e).position,
  }));
  const canvas = document.querySelector("#svg-map-mount canvas");
  const svg = document.querySelector("#svg-map-mount svg");
  const cRect = canvas?.getBoundingClientRect();
  const sRect = svg?.getBoundingClientRect();
  return {
    point: { cx, cy },
    hit: hit ? { tag: hit.tagName, cls: typeof hit.className === "string" ? hit.className : "", id: hit.id } : null,
    stack,
    canvas: cRect ? { x: Math.round(cRect.x), y: Math.round(cRect.y), w: Math.round(cRect.width), h: Math.round(cRect.height), pe: getComputedStyle(canvas).pointerEvents, z: getComputedStyle(canvas).zIndex, pos: getComputedStyle(canvas).position } : null,
    svg: sRect ? { x: Math.round(sRect.x), y: Math.round(sRect.y), w: Math.round(sRect.width), h: Math.round(sRect.height), pe: getComputedStyle(svg).pointerEvents, z: getComputedStyle(svg).zIndex, pos: getComputedStyle(svg).position } : null,
    zoneAreaRect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
  };
});
console.log(JSON.stringify(r, null, 1));

// 直接派發 click 到 zone-area（繞過 hit test），確認 handler 本身有冇問題
const direct = await p.evaluate(() => {
  const area = document.querySelector(".zone-area");
  area.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return true;
});
await p.waitForTimeout(1200);
const after = await p.evaluate(() => ({
  selected: document.querySelectorAll(".zone.is-selected").length,
  dossierHidden: document.querySelector("#zone-dossier-mount")?.hasAttribute("hidden"),
  dossierText: (document.querySelector("#zone-dossier-mount")?.innerText || "").slice(0, 200),
}));
console.log("direct dispatch →", JSON.stringify(after));
await p.screenshot({ path: "artifacts/audit-A2/screenshots/dark-desktop-zone-dossier.png" });
await b.close();

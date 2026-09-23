/**
 * A2 zone / legend / nav 互動探測（只讀）
 * 執行：node artifacts/audit-A2/zone-legend-probe.mjs
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5180/";
const b = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
await ctx.addInitScript(() => { try { localStorage.setItem("binggang-theme", "dark"); } catch {} });
const p = await ctx.newPage();
await p.goto(BASE, { waitUntil: "load" });
await p.waitForTimeout(2500);

const info = await p.evaluate(() => {
  const z = document.querySelector(".zone");
  if (!z) return { none: true };
  const a = z.querySelector(".zone-area");
  const r = a.getBoundingClientRect();
  return {
    zoneId: z.getAttribute("data-zone-id"),
    name: z.getAttribute("data-zone-name"),
    cls: z.getAttribute("class"),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    badgeFill: getComputedStyle(z.querySelector(".zone-badge circle")).fill,
    areaFill: getComputedStyle(a).fill,
    areaStroke: getComputedStyle(a).stroke,
    strokeW: a.getAttribute("stroke-width"),
    dash: a.getAttribute("stroke-dasharray"),
    fillOpacity: a.getAttribute("fill-opacity"),
  };
});
console.log("zone:", JSON.stringify(info));

if (!info.none) {
  await p.mouse.click(info.rect.x + info.rect.w / 2, info.rect.y + info.rect.h / 2);
  await p.waitForTimeout(1500);
  const after = await p.evaluate(() => ({
    selected: document.querySelectorAll(".zone.is-selected").length,
    dossierHidden: document.querySelector("#zone-dossier-mount")?.hasAttribute("hidden"),
    dossierText: (document.querySelector("#zone-dossier-mount")?.innerText || "").slice(0, 240),
    storyPanelDisplay: getComputedStyle(document.querySelector("#story-panel-mount")).display,
    url: location.href,
  }));
  console.log("after click:", JSON.stringify(after, null, 1));
  await p.screenshot({ path: "artifacts/audit-A2/screenshots/dark-desktop-zone-dossier.png" });
}

const nav = await p.evaluate(() =>
  Array.from(document.querySelectorAll("#topbar .nav-btn")).map((e) => {
    const r = e.getBoundingClientRect();
    return { t: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
  }),
);
console.log("nav:", JSON.stringify(nav));

const leg = await p.evaluate(() =>
  Array.from(document.querySelectorAll(".legend-item")).map((e) => {
    const s = e.querySelector(".dot,.area,.line");
    const cs = s ? getComputedStyle(s) : null;
    const r = s ? s.getBoundingClientRect() : null;
    return {
      t: e.textContent.trim(),
      cls: s ? s.className : null,
      color: cs ? cs.color : null,
      bc: cs ? cs.borderColor : null,
      bg: cs ? cs.backgroundColor : null,
      shape: r ? { w: Math.round(r.width), h: Math.round(r.height), br: cs.borderRadius, bs: cs.borderStyle } : null,
    };
  }),
);
console.log("legend:", JSON.stringify(leg, null, 1));

await b.close();

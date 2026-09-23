import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
const page = await ctx.newPage();
await page.goto("http://localhost:5180/", { waitUntil: "load" });
await page.waitForLoadState("networkidle").catch(()=>{});
await page.waitForTimeout(1800);
const r = await page.evaluate(() => {
  const out = {};
  out.markers = document.querySelectorAll("#locations-layer .location-marker").length;
  out.clusters = document.querySelectorAll("#locations-layer .location-marker-cluster").length;
  out.zones = document.querySelectorAll("#zones-layer .zone").length;
  out.events = document.querySelectorAll("#events-layer .event-marker").length;
  // 直接 JS 觸發 marker click
  const m = document.querySelector("#locations-layer .location-marker") || document.querySelector("#locations-layer .location-marker-cluster");
  if (m) { m.dispatchEvent(new MouseEvent("click", { bubbles: true })); out.markerClicked = true; }
  return out;
});
await page.waitForTimeout(600);
const afterMarker = await page.evaluate(() => ({ hash: location.hash }));
// 直接 JS 觸發 zone click
const z = await page.evaluate(() => {
  const el = document.querySelector("#zones-layer .zone");
  if (!el) return { zoneFound: false };
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return { zoneFound: true };
});
await page.waitForTimeout(700);
const afterZone = await page.evaluate(() => ({
  hash: location.hash,
  dossierHidden: document.querySelector("#zone-dossier-mount")?.hidden,
  selectedZone: document.querySelectorAll(".zone.is-selected").length,
}));
console.log(JSON.stringify({ ...r, ...z, afterMarker, afterZone }, null, 2));
await ctx.close(); await browser.close();

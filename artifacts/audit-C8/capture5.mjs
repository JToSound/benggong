import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const BASE = "http://localhost:5176/";
const OUT = path.resolve("artifacts/audit-C8");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const r = await page.evaluate(() => {
  const layer = document.querySelector("#zones-layer");
  const cls = {};
  for (const el of layer.querySelectorAll("*")) {
    const c = (el.getAttribute("class") || "").split(" ")[0] || el.tagName;
    cls[c] = (cls[c] || 0) + 1;
  }
  return {
    viewBox: document.querySelector("#svg-map").getAttribute("viewBox"),
    classCounts: cls,
    clusterCount: layer.querySelectorAll(".zone-cluster").length,
    clusterTexts: Array.from(layer.querySelectorAll(".zone-cluster-count")).map((e) => e.textContent),
    zoneNodes: layer.querySelectorAll(".zone").length,
    zoneAreaNodes: layer.querySelectorAll(".zone-area").length,
  };
});
fs.writeFileSync(path.join(OUT, "evidence5.json"), JSON.stringify(r, null, 2));
console.log(JSON.stringify(r, null, 2));
await browser.close();

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const BASE = "http://localhost:5176/";
const OUT = path.resolve("artifacts/audit-C8");
const browser = await chromium.launch();
const out = {};
for (const w of [1280, 1920, 2560]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.goto(`${BASE}?view=chronicle`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  out[w] = await page.evaluate(() => {
    const pane = document.querySelector("#story-pane").getBoundingClientRect();
    const e = document.querySelector(".chr-entry")?.getBoundingClientRect();
    const c = document.querySelector(".chronicle");
    return {
      storyPaneW: Math.round(pane.width),
      chrEntryW: e && Math.round(e.width),
      chronicleCols: c && getComputedStyle(c).gridTemplateColumns,
      mapPaneRatio: +(document.querySelector("#map-pane").getBoundingClientRect().width * document.querySelector("#map-pane").getBoundingClientRect().height / (innerWidth * innerHeight)).toFixed(3),
    };
  });
  if (w === 1920) await page.screenshot({ path: path.join(OUT, "16-desktop-1920-chronicle.png") });
  await ctx.close();
}
fs.writeFileSync(path.join(OUT, "evidence6.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();

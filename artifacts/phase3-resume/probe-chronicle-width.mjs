/** C8 P0 驗證：編年史條目卡寬度（修 container query 前後）。 */
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";

const INIT = `(() => { try { localStorage.setItem("binggang.onboarding.dismissed","1"); } catch(e){} })();`;

const MEASURE = () => {
  const q = (s) => document.querySelector(s);
  const w = (s) => { const e = q(s); return e ? +e.getBoundingClientRect().width.toFixed(1) : null; };
  const entries = Array.from(document.querySelectorAll(".chr-entry"));
  const widths = entries.slice(0, 5).map(e => +e.getBoundingClientRect().width.toFixed(1));
  const rail = q(".chr-rail");
  return {
    chronicleW: w(".chronicle"),
    railW: w(".chr-rail"),
    railDirection: rail ? getComputedStyle(rail).flexDirection : null,
    bodyWrapW: w(".chronicle-body-wrap"),
    entryCount: entries.length,
    entryWidths: widths,
    minEntryW: widths.length ? Math.min(...widths) : null,
  };
};

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
await withTeardown(browser, server, async () => {
  for (const vw of [1280, 1920]) {
    const ctx = await browser.newContext({ viewport: { width: vw, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector("#btn-mode")?.click());
    await page.waitForTimeout(2500);
    const m = await page.evaluate(MEASURE);
    console.log(`viewport ${vw}:`, JSON.stringify(m));
    await ctx.close();
  }
});

/** C8 P1-2 驗證：揀 zone 之後 viewBox 有冇變（fly-to）。 */
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";

const INIT = `(() => { try { localStorage.setItem("binggang.onboarding.dismissed","1"); } catch(e){} })();`;

const vb = () => document.querySelector("#svg-map")?.getAttribute("viewBox");

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
await withTeardown(browser, server, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const before = await page.evaluate(vb);
  const nZones = await page.evaluate(() => document.querySelectorAll("#zones-layer .zone").length);

  // 揀一個 zone（真滑鼠點擊其中心；離屏／被遮蓋就試下一個）
  const clicked = await page.evaluate(() => {
    const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
    for (const z of zones) {
      const r = z.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top && (top === z || z.contains(top))) {
        z.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: cx, clientY: cy }));
        return z.getAttribute("data-zone-id") || z.id || "(zone)";
      }
    }
    return null;
  });
  await page.waitForTimeout(2500);   // 等 fly 動畫（ease-in-out，~數百 ms）

  const after = await page.evaluate(vb);
  const url = page.url();
  console.log("zones 總數:", nZones);
  console.log("點擊:", clicked);
  console.log("viewBox before:", before);
  console.log("viewBox after :", after);
  console.log("viewBox 有變:", before !== after);
  console.log("URL 有 ?zone=:", /\?.*zone=/.test(url));
  await ctx.close();
});

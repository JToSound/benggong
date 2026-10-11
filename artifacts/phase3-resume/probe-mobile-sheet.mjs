/** C8 P1-3 驗證：手機 tap zone → 面板自動開（snap 由 peek 升）。 */
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";

const INIT = "(() => { try { localStorage.setItem(\"binggang.onboarding.dismissed\",\"1\"); } catch(e){} })();";

const SNAP = () => {
  const p = document.querySelector("#story-pane");
  const dz = document.querySelector("#zone-dossier-mount");
  const r = dz ? dz.getBoundingClientRect() : null;
  return {
    snap: p ? p.getAttribute("data-sheet-snap") : null,
    collapsed: p ? p.classList.contains("is-collapsed") : null,
    dossierTop: r ? Math.round(r.top) : null,
    dossierInView: r ? (r.height > 0 && r.top < innerHeight && r.bottom > 0) : null,
  };
};

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
await withTeardown(browser, server, async () => {
  const cases = [[390, 844, "手機 390x844"], [1440, 900, "桌面 1440x900"]];
  for (const c of cases) {
    const ctx = await browser.newContext({ viewport: { width: c[0], height: c[1] }, deviceScaleFactor: 1 });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const before = await page.evaluate(SNAP);
    const clicked = await page.evaluate(() => {
      const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
      for (const z of zones) {
        const r = z.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        const top = document.elementFromPoint(cx, cy);
        if (top && (top === z || z.contains(top))) {
          z.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: cx, clientY: cy }));
          return true;
        }
      }
      return false;
    });
    await page.waitForTimeout(1800);
    const after = await page.evaluate(SNAP);
    console.log(c[2] + " | 點擊 " + clicked + " | before " + JSON.stringify(before) + " | after " + JSON.stringify(after));
    await ctx.close();
  }
});

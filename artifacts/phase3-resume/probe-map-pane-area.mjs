/**
 * C8 P1-6：量測 `#map-pane` 佔首屏面積比例（spec 要 >=70%）。
 *
 * ⚠️ P1-6-8（2026-10-07）：收檔改用 `_probe-lib.mjs` 嘅
 * `withTeardown()` —— 原本用 `process.kill(-server.pid)`，喺 Windows
 * **冇效**（MEMORY E18）→ 會殘留 `vite preview` 佔住 5174 → 之後嘅 e2e
 * 連去舊 build（假綠）。
 *
 * 用法：node artifacts/phase3-resume/probe-map-pane-area.mjs
 */
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";

const INIT =
  '(() => { try { localStorage.setItem("binggang.onboarding.dismissed","1"); } catch(e){} })();';

const M = () => {
  const vw = innerWidth,
    vh = innerHeight;
  const mp = document.querySelector("#map-pane");
  const r = mp ? mp.getBoundingClientRect() : null;
  const top = document.querySelector("#topbar");
  const tr = top ? top.getBoundingClientRect() : null;
  const cs = document.querySelector(".chapter-strip");
  const cr = cs ? cs.getBoundingClientRect() : null;
  const sp = document.querySelector("#story-pane");
  const sr = sp ? sp.getBoundingClientRect() : null;
  return {
    viewport: vw + "x" + vh,
    mapPane: r ? Math.round(r.width) + "x" + Math.round(r.height) : null,
    areaPct: r ? +(((r.width * r.height) / (vw * vh)) * 100).toFixed(1) : null,
    topbarH: tr ? Math.round(tr.height) : null,
    chapterStripH: cr ? Math.round(cr.height) : null,
    storyPaneW: sr ? Math.round(sr.width) : null,
    storyCollapsed: sp ? sp.classList.contains("is-collapsed") : null,
  };
};

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
await withTeardown(browser, server, async () => {
  const cases = [
    [1440, 900],
    [1280, 800],
    [1920, 1080],
  ];
  for (const c of cases) {
    const ctx = await browser.newContext({
      viewport: { width: c[0], height: c[1] },
      deviceScaleFactor: 1,
    });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(2200);
    console.log(JSON.stringify(await page.evaluate(M)));
    await ctx.close();
  }
});

/** C8 P1-6：量測 `#map-pane` 佔首屏面積比例（spec 要 >=70%）。 */
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = "http://localhost:" + PORT + "/";
const INIT = "(() => { try { localStorage.setItem(\"binggang.onboarding.dismissed\",\"1\"); } catch(e){} })();";

async function ok(u, ms = 3000) {
  try { return (await fetch(u, { signal: AbortSignal.timeout(ms) })).ok; } catch { return false; }
}
async function ensure() {
  if (await ok(BASE)) return null;
  const s = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"],
    { cwd: process.cwd(), shell: true, stdio: "ignore", detached: true });
  for (let i = 0; i < 40; i++) { if (await ok(BASE)) return s; await new Promise(r => setTimeout(r, 500)); }
  throw new Error("server");
}

const M = () => {
  const vw = innerWidth, vh = innerHeight;
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

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const cases = [[1440, 900], [1280, 800], [1920, 1080]];
  for (const c of cases) {
    const ctx = await browser.newContext({ viewport: { width: c[0], height: c[1] }, deviceScaleFactor: 1 });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(2200);
    console.log(JSON.stringify(await page.evaluate(M)));
    await ctx.close();
  }
} finally {
  await browser.close();
  if (server && server.pid) { try { process.kill(-server.pid); } catch (e) {} }
}

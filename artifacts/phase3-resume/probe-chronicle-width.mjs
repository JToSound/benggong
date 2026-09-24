/** C8 P0 驗證：編年史條目卡寬度（修 container query 前後）。 */
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;
const INIT = `(() => { try { localStorage.setItem("binggang.onboarding.dismissed","1"); } catch(e){} })();`;

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

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
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
} finally {
  await browser.close();
  if (server?.pid) { try { process.kill(-server.pid); } catch {} }
}

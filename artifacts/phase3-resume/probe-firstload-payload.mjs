/** C8 P1-8：首屏 network payload 逐檔量測。 */
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

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const rows = [];
  page.on("response", async (r) => {
    try {
      const h = r.headers();
      const len = Number(h["content-length"] || 0);
      rows.push({ url: r.url().replace(BASE, ""), type: h["content-type"] || "", bytes: len });
    } catch (e) {}
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const data = rows.filter(r => r.url.startsWith("data/public/"));
  const total = data.reduce((a, b) => a + b.bytes, 0);
  console.log("=== 首屏 data/public 請求（" + data.length + " 個）===");
  for (const r of data.sort((a, b) => b.bytes - a.bytes)) {
    console.log("  " + (r.bytes / 1024).toFixed(0).padStart(6) + " KB  " + r.url);
  }
  console.log("  合計 " + (total / 1024 / 1024).toFixed(2) + " MB");
  const all = rows.reduce((a, b) => a + b.bytes, 0);
  console.log("全部請求合計 " + (all / 1024 / 1024).toFixed(2) + " MB（" + rows.length + " 個）");
  await ctx.close();
} finally {
  await browser.close();
  if (server && server.pid) { try { process.kill(-server.pid); } catch (e) {} }
}

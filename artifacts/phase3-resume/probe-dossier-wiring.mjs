/** C8 P1-4 + F6 驗證：zone dossier 有冇用 zone-dossiers.json + 誠實 badge。 */
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

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();

  const requests = [];
  page.on("request", (r) => { if (r.url().includes("zone-dossiers")) requests.push(r.url()); });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 揀一個 zone：直接按 URL（最確定）
  const zoneId = await page.evaluate(async () => {
    const r = await fetch("./data/public/zones.geojson");
    const j = await r.json();
    return j.features[0].properties.id;
  });
  await page.goto(`${BASE}?zone=${zoneId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  const m = await page.evaluate(() => {
    const zd = document.querySelector(".zd");
    return {
      dossierPanel: !!zd,
      sections: Array.from(document.querySelectorAll(".zd-section-title")).map(e => e.textContent.trim()),
      badges: Array.from(document.querySelectorAll(".zd-review")).map(e => e.textContent.trim()),
      hasOverview: !!document.querySelector(".zd-summary"),
      auditRows: document.querySelectorAll(".zd-audit li").length,
      kindSub: document.querySelector(".zd-kind-sub")?.textContent?.trim() ?? null,
      // P1-5：內部欄位要收喺 <details>（預設唔展開）
      metaIsDetails: document.querySelector(".zd-meta-details")?.tagName === "DETAILS",
      metaOpenByDefault: document.querySelector(".zd-meta-details")?.hasAttribute("open") ?? null,
      // P1-7：下一步 CTA
      actions: Array.from(document.querySelectorAll(".zd-action")).map(e => e.textContent.trim()),
      actionMinHeight: (() => {
        const a = document.querySelector(".zd-action");
        return a ? Math.round(a.getBoundingClientRect().height) : null;
      })(),
    };
  });
  console.log("zoneId:", zoneId);
  console.log("zone-dossiers.json 請求次數:", requests.length);
  console.log(JSON.stringify(m, null, 1));
  await ctx.close();
} finally {
  await browser.close();
  if (server?.pid) { try { process.kill(-server.pid); } catch {} }
}

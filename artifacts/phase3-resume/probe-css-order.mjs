/** D2-8：量度實際 stylesheet 載入次序（決定 `mobile.css` 係唔係最後）。 */
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = "http://localhost:" + PORT + "/";
const ok = async (u, ms = 3000) => {
  try {
    return (await fetch(u, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
};
async function ensure() {
  if (await ok(BASE)) return null;
  const s = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    if (await ok(BASE)) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("preview server 起唔到");
}

const ORDER = () => {
  const nodes = Array.from(document.head.querySelectorAll("style, link[rel=stylesheet]"));
  return nodes.map((el, i) => {
    const id = el.id || "(冇 id)";
    const tag = el.tagName.toLowerCase();
    let size = null;
    try {
      size = el.sheet ? el.sheet.cssRules.length : null;
    } catch {
      size = "CORS";
    }
    return { i, tag, id, rules: size, href: el.getAttribute("href") || null };
  });
};

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("binggang.onboarding.dismissed", "1");
    } catch {
      /* */
    }
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
    timeout: 20000,
  });
  await page.waitForTimeout(1000);
  const order = await page.evaluate(ORDER);
  console.log("=== document.head 內 stylesheet 次序 ===");
  for (const o of order) {
    console.log(`  [${o.i}] ${o.tag} id=${o.id} rules=${o.rules}${o.href ? " href=" + o.href : ""}`);
  }
  const ids = order.map((o) => o.id);
  console.log("\nmobile 係唔係最後？", ids[ids.length - 1] === "b8-mobile-css");
  console.log("map-v2-css index:", ids.indexOf("map-v2-css"), "｜b8-mobile-css index:", ids.indexOf("b8-mobile-css"));
} finally {
  await browser.close();
  if (server && server.pid) {
    try {
      process.kill(-server.pid);
    } catch {
      /* */
    }
  }
}

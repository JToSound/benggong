/** 診斷：P1-6 自動開 pane 為何冇生效。 */
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;
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

const dump = (page, tag) => page.evaluate((t) => {
  const p = document.querySelector("#story-pane");
  const cs = p ? getComputedStyle(p) : null;
  const r = p?.getBoundingClientRect();
  return {
    tag: t,
    snapAttr: p?.getAttribute("data-sheet-snap"),
    isCollapsed: p?.classList.contains("is-collapsed"),
    visibility: cs?.visibility,
    transform: cs?.transform,
    rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
    ariaExpanded: document.querySelector("#btn-toggle-panel")?.getAttribute("aria-expanded"),
    btnMode: document.querySelector("#btn-mode")?.textContent?.trim(),
    wsClasses: document.querySelector(".workspace")?.className,
    paneW: cs ? getComputedStyle(p).width : null,
    ctrlRight: (() => {
      const c = document.querySelector("#map-controls");
      return c ? getComputedStyle(c).right : null;
    })(),
    ctrlRect: (() => {
      const c = document.querySelector("#map-controls");
      const r = c?.getBoundingClientRect();
      return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null;
    })(),
    storyW: (() => {
      const s = document.querySelector("#story-panel-mount");
      const r = s?.getBoundingClientRect();
      return r ? [Math.round(r.x), Math.round(r.width)] : null;
    })(),
  };
}, tag);

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  console.log(JSON.stringify(await dump(page, "首屏"), null, 1));

  await page.locator("#btn-mode").click();
  await page.waitForTimeout(800);
  console.log(JSON.stringify(await dump(page, "撳咗 btn-mode"), null, 1));

  await page.locator("#btn-toggle-panel").click();
  await page.waitForTimeout(600);
  console.log(JSON.stringify(await dump(page, "手動撳面板"), null, 1));
} finally {
  await browser.close();
  if (server?.pid) { try { process.kill(-server.pid); } catch { /* */ } }
}

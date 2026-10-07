/**
 * D 階段 4 驗證：同一組 app 狀態嘅截圖（before / after 逐像素比對）。
 *
 * 為何要截圖比對
 * ==============
 * 「死 CSS」嘅定義係「嗰啲 class 永遠唔會出現喺 DOM」。如果真係死，
 * 移除佢哋嘅規則之後，畫面應該**逐像素一樣**。
 * 呢個係最強嘅驗證（比「測試全綠」強 —— 測試唔會覆蓋所有視覺）。
 *
 * 用法：node artifacts/phase3-resume/probe-dead-css-shots.mjs <outDir>
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = "http://localhost:" + PORT + "/";
const outDir = process.argv[2] || "artifacts/phase3-resume/shots-before";
mkdirSync(outDir, { recursive: true });

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

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
let n = 0;
async function shot(page, name) {
  // ⚠️ 關動畫／過場 → 避免時間差造成假差異
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false });
  n++;
  console.log(`  ${name}.png`);
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("binggang.onboarding.dismissed", "1");
      localStorage.setItem("binggang.theme", "dark");
    } catch {
      /* */
    }
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
    timeout: 20000,
  });
  await page.waitForTimeout(900);
  await shot(page, "01-desktop-default");

  await page.click("#btn-toggle-panel", { force: true, timeout: 15000 });
  await page.waitForTimeout(500);
  await shot(page, "02-desktop-pane-open");

  await page.keyboard.press("Escape");
  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await page.waitForTimeout(1400);
  await shot(page, "03-desktop-ch198");

  const z = await page.evaluate(() => {
    const el = document.querySelector("#zones-layer .zone");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (z) {
    await page.mouse.click(z.x, z.y);
    await page.waitForTimeout(1000);
    await shot(page, "04-desktop-zone-selected");
  }

  await page.click("#btn-mode", { force: true, timeout: 15000 });
  await page.waitForTimeout(1200);
  await shot(page, "05-desktop-chronicle");

  await page.keyboard.press("/");
  await page.waitForTimeout(700);
  await shot(page, "06-desktop-search-open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.close();

  const m = await browser.newPage({
    viewport: { width: 390, height: 844 },
    locale: "zh-HK",
    hasTouch: true,
    isMobile: true,
  });
  await m.goto(BASE, { waitUntil: "networkidle" });
  await m.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
    timeout: 20000,
  });
  await m.waitForTimeout(900);
  await shot(m, "07-mobile-default");
  await m.close();
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
console.log(`\n共 ${n} 張 → ${outDir}/`);

/**
 * D 階段 5：**確定性**截圖器（視覺回歸用）。
 *
 * 為何要另寫一個（唔用 `probe-dead-css-shots.mjs`）
 * ==============================================
 * 2026-10-07 D 階段 4 實測：舊探測**同一份程式碼跑兩次都 6/7 張唔同** ✗ ——
 * 根因係**地圖 `flyTo` 係 JS 動畫**，截圖截到中間狀態。
 * 用嗰種圖做回歸比對 = 將 flakiness 當成 regression ✗。
 *
 * 本檔嘅確定性措施：
 *   1. **停用 CSS 動畫／過場**（注入 `*{transition:none;animation:none}`）；
 *   2. **等 `document.fonts.ready`**（字體載入完成）；
 *   3. **等地圖 `viewBox` 穩定**（連續 2 次取樣相同，最多等 N ms）；
 *   4. **等 `requestAnimationFrame` 連續 2 帧**（令 canvas 重繪完成）；
 *   5. 每個狀態之間有固定 settle 時間。
 *
 * 用法：node artifacts/phase3-resume/visual-shots.mjs <outDir>
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = "http://localhost:" + PORT + "/";
const outDir = process.argv[2] || "artifacts/phase3-resume/visual-shots";
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

/** 等 app ready（章節條有 pill = 資料已載入）。 */
async function waitApp(page) {
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
    timeout: 25000,
  });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(600);
}

/**
 * 等「畫面穩定」：
 *   · `viewBox` 連續 2 次取樣相同（地圖動畫完）
 *   · 再等 2 帧 rAF（canvas 重繪完）
 */
async function waitStable(page, maxMs = 8000) {
  const t0 = Date.now();
  let prev = null;
  for (;;) {
    const vb = await page.evaluate(
      () => document.querySelector("#svg-map")?.getAttribute("viewBox") ?? "",
    );
    if (vb === prev && vb !== "") break;
    prev = vb;
    if (Date.now() - t0 > maxMs) break;
    await page.waitForTimeout(250);
  }
  await page.evaluate(
    () =>
      new Promise((res) =>
        requestAnimationFrame(() => requestAnimationFrame(() => res(null))),
      ),
  );
  await page.waitForTimeout(350);
}

const FREEZE = `*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}`;

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
let n = 0;
async function shot(page, name) {
  await page.addStyleTag({ content: FREEZE });
  await waitStable(page);
  await page.screenshot({ path: `${outDir}/${name}.png`, animations: "disabled" });
  n++;
  console.log(`  ${name}.png`);
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: "zh-HK",
    deviceScaleFactor: 1,
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("binggang.onboarding.dismissed", "1");
      localStorage.setItem("binggang.theme", "dark");
    } catch {
      /* */
    }
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await waitApp(page);
  await shot(page, "01-desktop-default");

  await page.click("#btn-toggle-panel", { force: true, timeout: 15000 });
  await shot(page, "02-desktop-pane-open");

  await page.keyboard.press("Escape");
  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await waitStable(page, 12000);
  await shot(page, "03-desktop-ch198");

  const z = await page.evaluate(() => {
    const el = document.querySelector("#zones-layer .zone");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (z) {
    await page.mouse.click(z.x, z.y);
    await shot(page, "04-desktop-zone-selected");
  }

  await page.click("#btn-mode", { force: true, timeout: 15000 });
  await shot(page, "05-desktop-chronicle");

  await page.keyboard.press("/");
  await shot(page, "06-desktop-search-open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.close();

  const m = await browser.newPage({
    viewport: { width: 390, height: 844 },
    locale: "zh-HK",
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  await m.goto(BASE, { waitUntil: "networkidle" });
  await waitApp(m);
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

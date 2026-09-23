/**
 * A10 pattern demo 截圖（只讀 + 寫 artifacts/audit-A10/）
 *
 * 驗證目標：
 *   1. pattern-demo.html 開 file:// 可以完整運作（零外部請求）
 *   2. dark / light 兩套 token 都 render 正常
 *   3. 灰度模式之下 legend 仍然可分辨（唔靠色）
 *   4. 390px mobile 版係 bottom sheet 而唔係縮細 desktop
 *   5. prefers-reduced-motion 之下動畫停、但元素仍然可見
 *
 * 用法：node artifacts/audit-A10/capture-demo.mjs
 */
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "shots");
mkdirSync(out, { recursive: true });

const demoUrl = pathToFileURL(join(here, "pattern-demo.html")).href;
const results = [];

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

async function run(name, opts, fn) {
  const ctx = await browser.newContext({
    viewport: opts.viewport,
    deviceScaleFactor: opts.dpr ?? 1,
    reducedMotion: opts.reducedMotion ?? "no-preference",
    colorScheme: opts.colorScheme ?? "dark",
  });
  const page = await ctx.newPage();

  const external = [];
  page.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith("file://") && !u.startsWith("data:") && !u.startsWith("blob:")) {
      external.push(u);
    }
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(demoUrl, { waitUntil: "load" });
  await page.waitForTimeout(900);
  if (fn) await fn(page);

  await page.screenshot({ path: join(out, `${name}.png`), fullPage: false });

  const motion = await page.evaluate(() => {
    const glow = document.querySelector(".zp-nest-glow");
    const ping = document.querySelector(".beacon-ping");
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      glowAnimation: cs(glow)?.animationName ?? null,
      glowStrokeOpacity: cs(glow)?.strokeOpacity ?? null,
      pingAnimation: cs(ping)?.animationName ?? null,
      pingOpacity: cs(ping)?.opacity ?? null,
      legendCount: document.querySelectorAll(".legend-item").length,
      zonesRendered: document.querySelectorAll(".zone").length,
      iconUseCount: document.querySelectorAll("svg use").length,
      buttonsWithoutName: [...document.querySelectorAll("button")].filter(
        (b) => !(b.getAttribute("aria-label") || b.textContent.trim()),
      ).length,
    };
  });

  results.push({ name, external, errors, ...motion });
  await ctx.close();
}

// 1. desktop dark（預設）
await run("demo-desktop-1440-dark", { viewport: { width: 1440, height: 900 } });

// 2. desktop light（切主題）
await run("demo-desktop-1440-light", { viewport: { width: 1440, height: 900 } }, async (p) => {
  await p.click("#btn-theme");
  await p.waitForTimeout(400);
});

// 3. 灰度模式 —— 驗證「唔靠色」
await run("demo-desktop-1440-grayscale", { viewport: { width: 1440, height: 900 } }, async (p) => {
  await p.click("#btn-gray");
  await p.waitForTimeout(300);
});

// 4. DPR 2
await run("demo-desktop-1440-dpr2", { viewport: { width: 1440, height: 900 }, dpr: 2 });

// 5. mobile 390
await run("demo-mobile-390", { viewport: { width: 390, height: 844 } });

// 6. reduced motion —— 動畫應停，元素仍可見
await run("demo-desktop-1440-reduced-motion", {
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});

// 7. 單獨驗證 layer cross-fade（關閉 route 層）
await run("demo-desktop-1440-layer-off", { viewport: { width: 1440, height: 900 } }, async (p) => {
  await p.click('[data-layer="layer-routes"]');
  await p.waitForTimeout(500);
});

await browser.close();

const totalExternal = results.reduce((n, r) => n + r.external.length, 0);
const totalErrors = results.reduce((n, r) => n + r.errors.length, 0);

console.log(JSON.stringify({ totalExternal, totalErrors, results }, null, 2));
if (totalExternal > 0 || totalErrors > 0) process.exitCode = 1;

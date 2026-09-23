/**
 * A7 modal / sheet 量測：搜尋 modal 喺 390px 會唔會超出 viewport、
 * focus 管理、背景內容可唔可以 Tab 到、Esc 行為。
 *
 * 執行：node artifacts/audit-A7/a7-modal.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const out = {};

for (const vp of [{ id: "mobile-390", w: 390, h: 844, touch: true },
                  { id: "desktop-1440", w: 1440, h: 900, touch: false }]) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch, isMobile: vp.touch });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForTimeout(1600);

  // 開搜尋
  await page.evaluate(() => document.querySelector("#btn-search").click());
  await page.waitForTimeout(400);
  const search = await page.evaluate(() => {
    const m = document.querySelector("#search-modal");
    const c = m.querySelector(".modal-content");
    const r = c.getBoundingClientRect();
    return {
      contentRect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      contentOverflowsViewportX: r.left < 0 || r.right > innerWidth,
      overflowPx: +Math.max(0, r.right - innerWidth, -r.left).toFixed(1),
      computedWidth: getComputedStyle(c).width,
      role: c.getAttribute("role"), ariaModal: c.getAttribute("aria-modal"),
      ariaLabel: c.getAttribute("aria-label"), ariaLabelledby: c.getAttribute("aria-labelledby"),
      backdropRole: m.getAttribute("role"),
      inputSize: (() => { const i = document.querySelector("#search-input"); const rr = i.getBoundingClientRect();
        return { w: +rr.width.toFixed(1), h: +rr.height.toFixed(1) }; })(),
      closeBtnSize: (() => { const i = document.querySelector("#search-close"); const rr = i.getBoundingClientRect();
        return { w: +rr.width.toFixed(1), h: +rr.height.toFixed(1) }; })(),
      docScrollWidth: document.documentElement.scrollWidth,
      hasHorizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  await page.screenshot({ path: path.join(OUT, `a7-search-modal-${vp.id}.png`) });

  // 背景內容可唔可以 Tab 到（有冇 inert / aria-hidden 隔離）
  await page.keyboard.type("商場");
  await page.waitForTimeout(500);
  const tabSeq = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    tabSeq.push(await page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a?.tagName, id: a?.id || null,
        cls: typeof a?.className === "string" ? a.className.slice(0, 30) : null,
        insideModal: !!a?.closest?.("#search-modal") };
    }));
  }
  const bgIsolation = await page.evaluate(() => ({
    appRootInert: document.querySelector("#app-root")?.hasAttribute("inert"),
    appRootAriaHidden: document.querySelector("#app-root")?.getAttribute("aria-hidden"),
    topbarAriaHidden: document.querySelector("#topbar")?.getAttribute("aria-hidden"),
    bodyOverflow: getComputedStyle(document.body).overflow,
  }));
  out[vp.id] = { search, tabSeq, bgIsolation };
  await context.close();
}

fs.writeFileSync(path.join(OUT, "a7-modal.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();

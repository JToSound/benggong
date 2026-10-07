/**
 * D2-8：量度實際 stylesheet 載入次序（決定 `mobile.css` 係唔係最後）。
 *
 * ⚠️ P1-6-8（2026-10-07）：收檔改用 `_probe-lib.mjs`（Windows 安全）。
 *
 * 用法：node artifacts/phase3-resume/probe-css-order.mjs
 */
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";

const ORDER = () => {
  const nodes = Array.from(
    document.head.querySelectorAll("style, link[rel=stylesheet]"),
  );
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

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
await withTeardown(browser, server, async () => {
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
  console.log(
    "map-v2-css index:",
    ids.indexOf("map-v2-css"),
    "｜b8-mobile-css index:",
    ids.indexOf("b8-mobile-css"),
  );
});

// 釐清 2.0a FAIL 係真失敗抑或 harness 導航方法錯
import { chromium } from "@playwright/test";
const BASE = "http://localhost:5174/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errs = []; page.on("pageerror", e => errs.push(String(e)));
await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#svg-map", { timeout: 30000 });
await page.waitForTimeout(1000);

const btn = await page.evaluate(() => {
  const b = document.querySelector("#btn-mode");
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { text: (b.textContent||"").trim(), aria: b.getAttribute("aria-label"), title: b.getAttribute("title"), w: Math.round(r.width), h: Math.round(r.height), visible: r.width>0&&r.height>0 };
});
console.log("btn-mode:", JSON.stringify(btn));

await page.click("#btn-mode");
await page.waitForTimeout(2000);
const after = await page.evaluate(() => ({
  url: location.href,
  chrEntries: document.querySelectorAll(".chr-entry").length,
  chronicleRoot: document.querySelectorAll(".chronicle").length,
  btnText: (document.querySelector("#btn-mode")?.textContent||"").trim(),
}));
console.log("click #btn-mode 之後:", JSON.stringify(after, null, 2));

// 再 click 一次（應該切返地圖）
await page.click("#btn-mode");
await page.waitForTimeout(1500);
const back = await page.evaluate(() => ({ url: location.href, svgMap: !!document.querySelector("#svg-map"), chrEntries: document.querySelectorAll(".chr-entry").length }));
console.log("再 click 一次:", JSON.stringify(back));
console.log("pageErrors:", JSON.stringify(errs));
await browser.close();

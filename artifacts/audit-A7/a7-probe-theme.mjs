import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map", { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await page.waitForTimeout(1200);
const snap = () => page.evaluate(() => ({
  dataTheme: document.documentElement.getAttribute("data-theme"),
  cls: document.documentElement.getAttribute("class"),
  bodyBg: getComputedStyle(document.body).backgroundColor,
  appRootBg: getComputedStyle(document.querySelector("#app-root")).backgroundColor,
  themeBtnText: document.querySelector("#btn-theme").textContent,
  stored: (() => { try { return JSON.stringify(Object.fromEntries(Object.entries(localStorage))).slice(0,200); } catch(e){ return null; } })(),
  prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
}));
const before = await snap();
await page.click("#btn-theme"); await page.waitForTimeout(800);
const after1 = await snap();
await page.click("#btn-theme"); await page.waitForTimeout(800);
const after2 = await snap();
console.log(JSON.stringify({before, after1, after2}, null, 1));
await browser.close();

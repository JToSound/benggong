/**
 * A9 QA Adversary —— Esc / focus 吞噬 probe（只讀）
 * 執行：node artifacts/audit-A9/_probe-focus.mjs
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5180/";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK", serviceWorkers: "block" });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const state = () =>
  page.evaluate(() => ({
    activeElement: document.activeElement?.id || document.activeElement?.tagName,
    storyTitle: document.querySelector("#story-panel-mount .story-title")?.textContent?.trim() ?? null,
    locMeta: document.querySelector("#story-panel-mount .loc-meta")?.textContent?.trim() ?? null,
    activeCh: document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch ?? null,
    modalOpen: !!document.querySelector("#search-modal.open"),
  }));

await page.goto(BASE + "#loc=loc_0029", { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 });
await page.waitForTimeout(1200);
console.log("A 初始:", JSON.stringify(await state()));

// 1) 直接 Esc（冇開 modal）→ 應該清 selection
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
console.log("B 直接 Esc 後:", JSON.stringify(await state()));

// 2) 重設
await page.goto(BASE + "#loc=loc_0029", { waitUntil: "load" });
await page.waitForTimeout(1500);
console.log("C 重設:", JSON.stringify(await state()));

// 3) 開 search → Esc 關 modal → 再 Esc（測 focus 有冇卡住）
await page.click("#btn-search");
await page.waitForTimeout(500);
console.log("D 開 search:", JSON.stringify(await state()));
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
console.log("E Esc#1（關 modal）:", JSON.stringify(await state()));
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
console.log("F Esc#2（應該清 selection）:", JSON.stringify(await state()));

// 4) 再試快捷鍵 k（應該切章）
const chBefore = (await state()).activeCh;
await page.keyboard.press("k");
await page.waitForTimeout(600);
console.log("G 按 k 之後:", JSON.stringify(await state()), "（之前 ch=" + chBefore + "）");

// 5) 用 / 開 search（focus 一樣入 input）→ Esc → k
await page.keyboard.press("/");
await page.waitForTimeout(500);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const chB2 = (await state()).activeCh;
await page.keyboard.press("k");
await page.waitForTimeout(600);
console.log("H 再試:", JSON.stringify(await state()), "（之前 ch=" + chB2 + "）");

console.log("pageErrors:", JSON.stringify(pageErrors));
await ctx.close();
await browser.close();

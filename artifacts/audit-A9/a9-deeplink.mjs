/**
 * A9 QA Adversary —— Deep link 完整性 + Search 鍵盤導航（只讀）
 *
 * 測：由 chronicle 卡片 / search 結果 / zone dossier 揀 item → URL 有冇更新；
 *     copy URL 去新 tab 能唔能夠重現；search 有冇 ↑↓ Enter 鍵盤導航。
 *
 * 執行：node artifacts/audit-A9/a9-deeplink.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";
fs.mkdirSync(OUT, { recursive: true });

async function ready(page) {
  await page
    .waitForFunction(() => document.querySelector("#svg-map-mount svg") || document.querySelector(".bg-error-panel"), { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(1000);
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const results = { base: BASE, capturedAt: new Date().toISOString(), cases: [] };

  // ---------- A. Chronicle 卡片 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);

    const url0 = page.url();
    // 1) 章節標籤（.chr-ch）
    const chInfo = await page.evaluate(() => {
      const b = document.querySelector("#story-panel-mount .chr-ch");
      if (!b) return null;
      const ch = b.dataset.ch;
      b.click();
      return { ch };
    });
    await page.waitForTimeout(700);
    const afterCh = { url: page.url(), activeCh: await page.evaluate(() => document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch ?? null), mode: await page.evaluate(() => document.querySelector("#btn-mode")?.textContent?.trim()) };

    // 2) 伏筆／解答連結（data-goto）— 要先展開一條目
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    const gotoInfo = await page.evaluate(() => {
      const toggle = document.querySelector("#story-panel-mount [data-toggle]");
      if (toggle) toggle.click();
      return true;
    });
    await page.waitForTimeout(500);
    const gotoLink = await page.evaluate(() => {
      const g = document.querySelector("#story-panel-mount [data-goto]");
      if (!g) return null;
      const id = g.dataset.goto;
      g.click();
      return { id };
    });
    await page.waitForTimeout(700);
    const afterGoto = { url: page.url() };
    await ctx.close();

    results.cases.push({
      id: "chronicle-chapter-badge",
      desc: "編年史卡片嘅章節標籤 → URL",
      clicked: chInfo,
      urlBefore: url0,
      after: afterCh,
      urlUpdated: afterCh.url !== url0,
      pageErrors,
    });
    results.cases.push({
      id: "chronicle-goto-link",
      desc: "編年史伏筆／解答連結 → URL",
      clicked: gotoLink,
      urlBefore: url0,
      after: afterGoto,
      urlUpdated: afterGoto.url !== url0,
    });
    console.log("[deeplink] chronicle-chapter-badge", JSON.stringify({ chInfo, afterCh, url0 }));
    console.log("[deeplink] chronicle-goto-link", JSON.stringify({ gotoLink, afterGoto }));
  }

  // ---------- B. Search 結果 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    const url0 = page.url();

    await page.click("#btn-search");
    await page.waitForSelector("#search-input", { timeout: 10000 });
    await page.fill("#search-input", "大本營");
    await page.waitForTimeout(600);
    const resultCount = await page.evaluate(() => document.querySelectorAll("#search-results .search-result-item").length);
    const first = await page.evaluate(() => {
      const el = document.querySelector("#search-results .search-result-item");
      if (!el) return null;
      const txt = el.textContent.trim();
      const type = el.querySelector(".result-type")?.textContent;
      el.click();
      return { txt, type };
    });
    await page.waitForTimeout(800);
    const after = {
      url: page.url(),
      activeCh: await page.evaluate(() => document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch ?? null),
      storyTitle: await page.evaluate(() => document.querySelector("#story-panel-mount .story-title")?.textContent?.trim() ?? null),
    };
    await ctx.close();
    results.cases.push({
      id: "search-result-click",
      desc: "Search 結果點擊 → URL",
      query: "大本營",
      resultCount,
      clicked: first,
      urlBefore: url0,
      after,
      urlUpdated: after.url !== url0,
    });
    console.log("[deeplink] search-result-click", JSON.stringify({ resultCount, first, after }));
  }

  // ---------- C. Zone dossier 章節 chip ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    const url0 = page.url();
    await page.evaluate(() => {
      const z = document.querySelector("#svg-map-mount .zone");
      z?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(700);
    const dossierName = await page.evaluate(() => document.querySelector("#zone-dossier-mount .zd-name")?.textContent?.trim() ?? null);
    const chip = await page.evaluate(() => {
      const b = document.querySelector("#zone-dossier-mount .zd-ch");
      if (!b) return null;
      const ch = b.dataset.ch;
      b.click();
      return { ch };
    });
    await page.waitForTimeout(700);
    const after = { url: page.url(), activeCh: await page.evaluate(() => document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch ?? null) };
    await ctx.close();
    results.cases.push({
      id: "zone-dossier-chapter-chip",
      desc: "Zone dossier 章節 chip → URL",
      dossierName,
      clicked: chip,
      urlBefore: url0,
      after,
      urlUpdated: after.url !== url0,
    });
    console.log("[deeplink] zone-dossier-chapter-chip", JSON.stringify({ dossierName, chip, after }));
  }

  // ---------- D. Search 鍵盤導航（spec §7.2-4）----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    await page.click("#btn-search");
    await page.waitForSelector("#search-input", { timeout: 10000 });
    await page.fill("#search-input", "大本營");
    await page.waitForTimeout(600);

    const kb = await page.evaluate(() => {
      const input = document.querySelector("#search-input");
      const before = {
        hasActiveClass: !!document.querySelector("#search-results .is-active, #search-results .active, #search-results [aria-selected='true']"),
        focusedTag: document.activeElement?.tagName,
      };
      const fire = (key) =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      fire("ArrowDown");
      fire("ArrowDown");
      const afterDown = {
        hasActiveClass: !!document.querySelector("#search-results .is-active, #search-results .active, #search-results [aria-selected='true']"),
        focusMoved: document.activeElement?.tagName !== "INPUT",
      };
      fire("Enter");
      return { before, afterDown, focusAfterEnter: document.activeElement?.tagName };
    });
    await page.waitForTimeout(600);
    const modalOpenAfterEnter = await page.evaluate(() => !!document.querySelector("#search-modal.open"));
    await ctx.close();
    results.cases.push({
      id: "search-keyboard-nav",
      desc: "Search ↑↓ Enter 鍵盤導航（spec §7.2-4）",
      detail: kb,
      modalStillOpenAfterEnter: modalOpenAfterEnter,
      supported: kb.afterDown.hasActiveClass || kb.afterDown.focusMoved,
    });
    console.log("[deeplink] search-keyboard-nav", JSON.stringify(kb), "modalOpenAfterEnter=", modalOpenAfterEnter);
  }

  // ---------- E. Copy URL → 新 tab 重現 ----------
  {
    // 由 chronicle 章節標籤產生 URL，然後開新 context 去嗰個 URL
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    await page.evaluate(() => {
      const b = document.querySelector("#story-panel-mount .chr-ch");
      b?.click();
    });
    await page.waitForTimeout(700);
    const sharedUrl = page.url();
    const beforeState = await page.evaluate(() => ({
      activeCh: document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch ?? null,
    }));
    await ctx.close();

    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
    const page2 = await ctx2.newPage();
    await page2.goto(sharedUrl, { waitUntil: "load" });
    await ready(page2);
    const afterState = await page2.evaluate(() => ({
      activeCh: document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch ?? null,
      chronicleCount: document.querySelector("#story-panel-mount .chronicle-count")?.textContent?.trim() ?? null,
    }));
    await ctx2.close();
    results.cases.push({
      id: "copy-url-new-tab",
      desc: "由 chronicle 產生嘅 URL → 新 tab 重現",
      sharedUrl,
      beforeState,
      afterState,
      reproduced: beforeState.activeCh === afterState.activeCh,
    });
    console.log("[deeplink] copy-url-new-tab", JSON.stringify({ sharedUrl, beforeState, afterState }));
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "a9-deeplink.json"), JSON.stringify(results, null, 2));
  console.log("\n寫入", path.join(OUT, "a9-deeplink.json"));
}

main().catch((e) => {
  console.error("A9 deeplink 測試失敗:", e);
  process.exit(1);
});

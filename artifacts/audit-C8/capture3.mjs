import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const BASE = "http://localhost:5176/";
const OUT = path.resolve("artifacts/audit-C8");
const report = {};
const browser = await chromium.launch();

// 1. 桌面：zone click → viewBox 有冇變（有冇 fly） + 選中 zone 同其他 zone 重疊
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const vbBefore = await page.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));
  await page.evaluate(() => {
    const zs = Array.from(document.querySelectorAll("#zones-layer .zone-area, #zones-layer .zone"));
    const t = zs.find((z) => { const b = z.getBoundingClientRect(); return b.width > 3 && b.height > 3; });
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(900);
  const vbAfter = await page.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));
  report.desktopZoneClick = {
    vbBefore, vbAfter, mapMoved: vbBefore !== vbAfter,
    selectedZoneRect: await page.evaluate(() => {
      const s = document.querySelector("#zones-layer .is-selected");
      const b = s?.getBoundingClientRect();
      return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    }),
    // 有幾多個 zone 嘅 rect 同選中 zone 重疊
    overlappingZones: await page.evaluate(() => {
      const s = document.querySelector("#zones-layer .is-selected");
      if (!s) return null;
      const sb = s.getBoundingClientRect();
      let n = 0;
      for (const z of document.querySelectorAll("#zones-layer > *")) {
        if (z === s) continue;
        const b = z.getBoundingClientRect();
        if (!(sb.right < b.left || b.right < sb.left || sb.bottom < b.top || b.bottom < sb.top)) n++;
      }
      return n;
    }),
    // 故事面板每行信心度 %
    confPctRows: await page.evaluate(() => Array.from(document.querySelectorAll(".summary-loc-conf")).map((e) => e.textContent).slice(0, 8)),
  };
  await ctx.close();
}

// 2. 手機：tap zone 之後，dossier 內容係唔係真係被 clip 喺 sheet 之外
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-HK", hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.goto(`${BASE}?zone=zone_200f5e8911`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  report.mobileDossierVisibility = await page.evaluate(() => {
    const name = document.querySelector("#zone-dossier-mount .zd-name");
    const sheet = document.querySelector("#story-pane");
    const nb = name?.getBoundingClientRect();
    const sb = sheet?.getBoundingClientRect();
    const sec = document.querySelector("#zone-dossier-mount .zd-section-title");
    const sebr = sec?.getBoundingClientRect();
    return {
      vh: innerHeight,
      sheet: sb && { top: Math.round(sb.top), bottom: Math.round(sb.bottom), h: Math.round(sb.height) },
      zdName: nb && { top: Math.round(nb.top), bottom: Math.round(nb.bottom) },
      zdNameInViewport: nb ? nb.top >= 0 && nb.bottom <= innerHeight : null,
      zdNameInsideSheet: nb && sb ? nb.top >= sb.top && nb.bottom <= sb.bottom : null,
      firstSectionTop: sebr && Math.round(sebr.top),
      sheetSnap: sheet?.getAttribute("data-sheet-snap"),
      sheetClass: sheet?.className,
      visibleTextInSheet: (() => {
        const el = document.elementFromPoint(195, 780);
        return el ? `${el.tagName}.${el.className}`.slice(0, 60) : null;
      })(),
    };
  });
  // 手動展開 sheet（拖 handle 向上）睇 dossier 是否正常
  const box = await page.locator(".sheet-handle, [data-sheet-handle]").first().boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, 200, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(700);
  } else {
    // fallback：按面板掣
    await page.click("#btn-toggle-panel").catch(() => {});
    await page.waitForTimeout(600);
  }
  report.mobileAfterExpand = await page.evaluate(() => ({
    sheetSnap: document.querySelector("#story-pane")?.getAttribute("data-sheet-snap"),
    sheetClass: document.querySelector("#story-pane")?.className,
    zdNameTop: (() => { const b = document.querySelector("#zone-dossier-mount .zd-name")?.getBoundingClientRect(); return b && Math.round(b.top); })(),
  }));
  await page.screenshot({ path: path.join(OUT, "13-mobile-zone-expanded.png") });
  await ctx.close();
}

// 3. 桌面：click 章節 pill 5 → 地圖/面板有咩變化（narrative 引導？）
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const vb0 = await page.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));
  await page.click('.ch-pill[data-ch="5"]');
  await page.waitForTimeout(1400);
  const vb1 = await page.evaluate(() => document.querySelector("#svg-map").getAttribute("viewBox"));
  report.chapterChange = {
    vb0, vb1, mapMoved: vb0 !== vb1,
    stripSummary: await page.evaluate(() => document.querySelector("#strip-summary")?.textContent),
    storyTitle: await page.evaluate(() => document.querySelector(".story-title")?.textContent),
    locMarkers: await page.evaluate(() => document.querySelectorAll("#locations-layer > *").length),
    eventMarkers: await page.evaluate(() => document.querySelectorAll("#events-layer > *").length),
  };
  await page.screenshot({ path: path.join(OUT, "14-desktop-chapter5.png") });
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, "evidence3.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const BASE = "http://localhost:5176/";
const OUT = path.resolve("artifacts/audit-C8");
const report = {};
const browser = await chromium.launch();

// A. 選中 zone 同幾多「唔同 zone」重疊（去重）
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  report.overlap = await page.evaluate(() => {
    // 每個 zone id 攞一個代表元素（優先 .zone-area 或 .zone）
    const byId = new Map();
    for (const z of document.querySelectorAll("#zones-layer > *")) {
      const id = z.getAttribute("data-zone-id");
      if (id && !byId.has(id)) byId.set(id, z);
    }
    const ids = [...byId.keys()];
    const rects = ids.map((id) => [id, byId.get(id).getBoundingClientRect()]);
    let pairs = 0;
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i][1], b = rects[j][1];
        if (!(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top)) pairs++;
      }
    // 揀一個 zone 做樣本，數佢同幾多個唔同 zone 重疊
    const pick = rects.find(([id, b]) => b.width > 3 && b.height > 3);
    let overlapDistinct = 0;
    if (pick) {
      const sb = pick[1];
      for (const [id, b] of rects) {
        if (id === pick[0]) continue;
        if (!(sb.right < b.left || b.right < sb.left || sb.bottom < b.top || b.bottom < sb.top)) overlapDistinct++;
      }
    }
    return {
      distinctZones: ids.length,
      renderedZoneNodes: document.querySelectorAll("#zones-layer > *").length,
      overlappingPairs: pairs,
      sampleZoneId: pick?.[0],
      sampleOverlapDistinct: overlapDistinct,
      zeroSizeZones: rects.filter(([, b]) => b.width < 2 || b.height < 2).length,
    };
  });
  // 首屏故事面板信心度
  report.firstScreenConfPct = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".summary-loc-conf")).map((e) => e.textContent),
  );
  report.firstScreenSummaryRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".summary-loc")).map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 60)),
  );
  await ctx.close();
}

// B. 手機：用「面板」掣展開 sheet，睇 dossier 展開後係唔係正常
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-HK", hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.goto(`${BASE}?zone=zone_200f5e8911`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.click("#btn-toggle-panel");
  await page.waitForTimeout(900);
  report.mobileExpanded = await page.evaluate(() => {
    const s = document.querySelector("#story-pane");
    const b = s?.getBoundingClientRect();
    const name = document.querySelector("#zone-dossier-mount .zd-name");
    const nb = name?.getBoundingClientRect();
    const sec = document.querySelector("#zone-dossier-mount .zd-section-title");
    const sb2 = sec?.getBoundingClientRect();
    return {
      sheetSnap: s?.getAttribute("data-sheet-snap"),
      sheetClass: s?.className,
      sheet: b && { top: Math.round(b.top), h: Math.round(b.height) },
      zdNameTop: nb && Math.round(nb.top),
      firstSectionTop: sb2 && Math.round(sb2.top),
      vh: innerHeight,
    };
  });
  await page.screenshot({ path: path.join(OUT, "15-mobile-zone-panel-open.png") });
  await ctx.close();
}

// C. chronicle：搵出 grid 容器寬度（證明 220px 側欄 + 剩下 = 條目欄）
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?view=chronicle`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => localStorage.setItem("binggang.onboarding.dismissed", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  report.chronicleGrid = await page.evaluate(() => {
    const host = document.querySelector("#story-panel-mount .chronicle, #story-panel-mount > *");
    const walk = (el, d = 0) => {
      if (!el || d > 4) return [];
      const cs = getComputedStyle(el);
      const out = [{ d, tag: el.tagName, cls: (el.className || "").toString().slice(0, 40), w: Math.round(el.getBoundingClientRect().width), display: cs.display, cols: cs.gridTemplateColumns }];
      for (const c of el.children) out.push(...walk(c, d + 1));
      return out;
    };
    return walk(host);
  });
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, "evidence4.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();

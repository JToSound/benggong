/**
 * A2 chronicle 卡片堆疊量度（eager render / 卡片尺寸 / 密度）
 * 執行：node artifacts/audit-A2/chronicle-probe.mjs
 */
import { chromium } from "playwright";

const b = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
await ctx.addInitScript(() => { try { localStorage.setItem("binggang-theme", "dark"); } catch {} });
const p = await ctx.newPage();
await p.goto("http://localhost:5180/", { waitUntil: "load" });
await p.waitForTimeout(2600);

const r = await p.evaluate(() => {
  const cards = document.querySelectorAll('[class*="chr-"]');
  const entry = document.querySelectorAll(".chr-entry, .chr-item, article");
  const pane = document.querySelector("#story-panel-mount");
  const first = document.querySelector('[class*="chr-"]');
  const cardLike = Array.from(document.querySelectorAll("li, article, div")).filter((e) => e.className && /chr-(entry|card|item)/.test(e.className));
  const sample = cardLike[0];
  const sr = sample?.getBoundingClientRect();
  const cs = sample ? getComputedStyle(sample) : null;
  const tagPills = document.querySelectorAll('[class*="chr-tag"], [class*="chr-chip"], [class*="chr-role"]');
  const bars = document.querySelectorAll(".chr-tl-bar");
  return {
    chrClassElements: cards.length,
    cardLikeCount: cardLike.length,
    articleCount: entry.length,
    paneScrollHeight: pane?.scrollHeight,
    paneClientHeight: pane?.clientHeight,
    paneScrollRatio: pane ? +(pane.scrollHeight / pane.clientHeight).toFixed(1) : null,
    sampleCard: sr ? { w: Math.round(sr.width), h: Math.round(sr.height), gap: cs.gap, padding: cs.padding, radius: cs.borderRadius, bg: cs.backgroundColor, border: cs.borderTopWidth + " " + cs.borderTopColor } : null,
    tagPillCount: tagPills.length,
    timelineBars: bars.length,
    sampleBarSize: (() => { const x = bars[0]; if (!x) return null; const q = x.getBoundingClientRect(); return { w: Math.round(q.width), h: Math.round(q.height) }; })(),
  };
});
console.log(JSON.stringify(r, null, 1));
await b.close();

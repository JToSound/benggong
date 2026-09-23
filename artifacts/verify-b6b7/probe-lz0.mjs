// L-Z0 badge 尺寸 + kind icon 詳細量測（對照 spec「直徑 8–12 px + kind icon + 數量」）
import { chromium } from "@playwright/test";
const BASE = "http://localhost:5174/";
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#svg-map", { timeout: 30000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const clusters = Array.from(document.querySelectorAll("#zones-layer .zone-cluster"));
  const detail = clusters.map((c) => {
    const ring = c.querySelector(".zone-cluster-ring, circle");
    const count = c.querySelector(".zone-cluster-count");
    const glyph = c.querySelector(".zone-cluster-glyph, use, path, image");
    const ringRect = ring?.getBoundingClientRect();
    const countRect = count?.getBoundingClientRect();
    return {
      text: (c.textContent || "").trim().slice(0, 20),
      ringDiameterPx: ringRect ? Math.round(ringRect.width * 10) / 10 : null,
      ringTag: ring?.tagName,
      countText: count?.textContent?.trim() ?? null,
      countFontPx: count ? getComputedStyle(count).fontSize : null,
      countRectW: countRect ? Math.round(countRect.width) : null,
      glyphTag: glyph?.tagName ?? null,
      glyphHref: glyph?.getAttribute?.("href") ?? null,
      childCount: c.children.length,
      childrenTags: Array.from(c.children).map((x) => x.tagName + "." + (x.getAttribute("class") || "")),
    };
  });
  return {
    viewW: Number(document.querySelector("#svg-map").getAttribute("viewBox").split(/\s+/)[2]),
    clusterCount: clusters.length,
    detail,
    // 有冇 symbol 定義 kind icon
    symbols: Array.from(document.querySelectorAll("symbol[id^='zone-glyph-']")).map((s) => s.id),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();

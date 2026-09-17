import { chromium } from "@playwright/test";

const OUT = "C:/Users/User/AppData/Local/Temp/benggong-phase-i-final";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto("http://localhost:5176/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const rect = await page.evaluate(() => {
  const r = document.querySelector("#svg-map").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, vh: innerHeight };
});
console.log(
  `SVG: ${Math.round(rect.w)}×${Math.round(rect.h)}  bottom=${Math.round(rect.bottom)}  viewport=${rect.vh}` +
    `  ${rect.bottom <= rect.vh + 1 ? "✅ 冇溢出" : "❌ 溢出"}`,
);

// 去到第 150 章（最多路線活躍）
for (let i = 0; i < 149; i++) await page.keyboard.press("k");
await page.waitForTimeout(1500);

const s = await page.evaluate(() => ({
  chapter: document.querySelector("#strip-ch-num")?.textContent?.trim(),
  routes: document.querySelectorAll(".route-line").length,
  markers: document.querySelectorAll(".location-marker").length,
  clusters: document.querySelectorAll(".location-marker-cluster").length,
  events: document.querySelectorAll(".event-marker").length,
}));
console.log(
  `第 ${s.chapter} 章：路線 ${s.routes}　標記 ${s.markers}　聚合 ${s.clusters}　事件 ${s.events}`,
);

await page.screenshot({ path: `${OUT}/final-verify.png` });
await browser.close();

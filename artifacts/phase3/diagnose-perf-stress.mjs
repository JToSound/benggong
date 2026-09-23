/**
 * 壓力測試：搵出「lag / 當機」嘅觸發條件。
 *
 * 場景：
 *   A. 全港視圖（zoom out 到底）—— 最多 element
 *   B. 拖曳平移（連續 mousemove）
 *   C. 快速 zoom in/out 20 次（冷 zoom）
 *   D. 切到 chronicle view（1320 條目）
 *   E. 搜尋（大結果集）
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";
const browser = await chromium.launch({
  args: ["--no-proxy-server", "--enable-precise-memory-info"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.addInitScript(() => {
  window.__lt = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
  } catch {}
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

const stats = async (label) => {
  const r = await page.evaluate(async () => {
    const fps = await new Promise((res) => {
      let n = 0;
      const s = performance.now();
      const tick = () => {
        n++;
        if (performance.now() - s < 1500) requestAnimationFrame(tick);
        else res(Math.round((n / (performance.now() - s)) * 1000 * 10) / 10);
      };
      requestAnimationFrame(tick);
    });
    return {
      fps,
      total: document.getElementsByTagName("*").length,
      svg: document.querySelector("#svg-map")?.getElementsByTagName("*").length ?? 0,
      events: document.querySelectorAll(".event-marker").length,
      markers: document.querySelectorAll(".location-marker").length,
      routes: document.querySelectorAll(".route-path").length,
      lt: (window.__lt ?? []).length,
      ltSum: (window.__lt ?? []).reduce((a, b) => a + b, 0),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
    };
  });
  console.log(
    `\n【${label}】\n  fps=${r.fps}  DOM=${r.total}(svg ${r.svg})  events=${r.events} ` +
      `markers=${r.markers} routes=${r.routes}\n  longtask=${r.lt}(${r.ltSum}ms)  heap=${r.heapMB}MB`,
  );
  return r;
};

await stats("A0. 初始（chapter=1，windowed）");

// A. 全港視圖：連撳 zoom-out 到底
for (let i = 0; i < 12; i++) await page.click("#map-zoom-out");
await page.waitForTimeout(1500);
await stats("A. 全港視圖（zoom-out 到底）");

// B. 拖曳平移（連續 mousemove）
const box = await page.locator("#svg-map").boundingBox();
if (box) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const s = Date.now();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(cx - i * 3, cy - i * 2, { steps: 2 });
  }
  await page.mouse.up();
  console.log(`\n  （拖曳 60 步耗時 ${Date.now() - s}ms）`);
}
await page.waitForTimeout(1200);
await stats("B. 拖曳之後");

// C. 快速 zoom in/out 20 次
const s2 = Date.now();
for (let i = 0; i < 10; i++) {
  await page.click("#map-zoom-in");
  await page.click("#map-zoom-out");
}
console.log(`\n  （20 次 zoom 耗時 ${Date.now() - s2}ms）`);
await page.waitForTimeout(1200);
await stats("C. 快速 zoom 20 次之後");

// D. chronicle view
const s3 = Date.now();
await page.goto(`${BASE}?view=chronicle`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);
console.log(`\n  （chronicle 載入耗時 ${Date.now() - s3}ms）`);
await stats("D. chronicle view");

await browser.close();

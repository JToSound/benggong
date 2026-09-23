/**
 * 診斷：Chromium launch/close 循環係否有累積效應。
 *
 * 背景：全套測試中 `reduced-motion.test.ts` 嘅 3 個瀏覽器測試卡死 90 秒，
 * 但單獨跑 22 秒就過。全套測試之前跑過 `map-interaction`（13 tests）+
 * `visual-smoke`（14 tests），每個測試都 `chromium.launch()` + `browser.close()`。
 *
 * 本腳本連續 launch/close 30 次，量每次耗時，睇後期係否暴增。
 */
import { chromium } from "playwright";

const N = 30;
const rows = [];

for (let i = 1; i <= N; i++) {
  const t0 = Date.now();
  let launchMs = -1;
  let pageMs = -1;
  let closeMs = -1;
  try {
    const b = await chromium.launch({ args: ["--no-proxy-server"] });
    launchMs = Date.now() - t0;
    const t1 = Date.now();
    const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
    pageMs = Date.now() - t1;
    const t2 = Date.now();
    await b.close();
    closeMs = Date.now() - t2;
  } catch (e) {
    console.log(`#${i} ERROR: ${e.message}`);
  }
  rows.push({ i, launchMs, pageMs, closeMs });
  // 每 5 次報一次
  if (i % 5 === 0 || i === N) {
    const recent = rows.slice(-5);
    const avgLaunch = Math.round(recent.reduce((s, r) => s + r.launchMs, 0) / recent.length);
    console.log(`#${i}: launch=${launchMs}ms page=${pageMs}ms close=${closeMs}ms  (近 5 次平均 launch=${avgLaunch}ms)`);
  }
}

const first5 = rows.slice(0, 5).reduce((s, r) => s + r.launchMs, 0) / 5;
const last5 = rows.slice(-5).reduce((s, r) => s + r.launchMs, 0) / 5;
console.log(`\n=== 總結 ===`);
console.log(`首 5 次平均 launch: ${Math.round(first5)} ms`);
console.log(`末 5 次平均 launch: ${Math.round(last5)} ms`);
console.log(`增幅: ${((last5 / first5 - 1) * 100).toFixed(1)}%`);
console.log(`最慢一次: ${Math.max(...rows.map((r) => r.launchMs))} ms`);

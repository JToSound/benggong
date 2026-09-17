import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto("http://localhost:5176/", { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const K = { lon: 103000, lat: 111000 };
let worst = { m: 0, ch: 0, d: "" };

for (let ch = 1; ch <= 198; ch++) {
  if (ch > 1) {
    await page.keyboard.press("k");
    await page.waitForTimeout(35);
  }
  const ds = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".route-line")).map((p) => ({
      d: p.getAttribute("d") || "",
      who: p.getAttribute("data-character-name") || "?",
    })),
  );
  for (const { d, who } of ds) {
    const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);
    for (let i = 0; i + 3 < nums.length; i += 4) {
      const m = Math.hypot(
        (nums[i + 2] - nums[i]) * K.lon,
        (nums[i + 3] - nums[i + 1]) * K.lat,
      );
      if (m > worst.m) {
        worst = {
          m,
          ch,
          d: `${who}: (${nums[i].toFixed(5)},${nums[i + 1].toFixed(5)}) → (${nums[i + 2].toFixed(5)},${nums[i + 3].toFixed(5)})`,
        };
      }
    }
  }
}

console.log(`最長線段 ${Math.round(worst.m)} m（第 ${worst.ch} 章）`);
console.log(`  ${worst.d}`);
await browser.close();

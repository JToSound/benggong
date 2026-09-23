// P1-8：圖例摺疊控制項（實瀏覽器）
//
// 為何要有呢個檔
// ============
// A7 P1-8 量到圖例遮蓋 24.3% 地圖（> 15% 門檻），而原本**冇任何摺疊方式**。
// B8 提供咗 CSS（`.map-overlay.is-legend-collapsed`），但控制項要喺 `SvgMap` 接。
// 呢個測試驗證：掣存在、aria-expanded 同步、撳咗真係隱藏圖例項目。

import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

describe("P1-8 圖例摺疊", () => {
  it("撳摺疊掣 → 隱藏圖例項目 + aria-expanded 同步", async () => {
    const browser = await chromium.launch({ args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);

      // ① 掣存在，初始展開
      const btn = page.locator("#legend-toggle-btn");
      expect(await btn.count(), "應該有一個摺疊掣").toBe(1);
      expect(await btn.getAttribute("aria-expanded"), "初始應該 aria-expanded=true").toBe("true");

      // ② 初始有可見嘅 .legend-item
      const visibleBefore = await page.locator(".legend-item:visible").count();
      expect(visibleBefore, "初始應該見到圖例項目").toBeGreaterThan(0);

      // ③ 撳摺疊掣
      await btn.click();
      await page.waitForTimeout(400);
      expect(await btn.getAttribute("aria-expanded"), "摺疊後應該 false").toBe("false");
      expect(
        await page.locator("#map-overlay").getAttribute("class"),
        "應該加上 is-legend-collapsed",
      ).toContain("is-legend-collapsed");
      expect(
        await page.locator(".legend-item:visible").count(),
        "摺疊後唔應該見到圖例項目",
      ).toBe(0);

      // ④ 再撳 → 復原
      await btn.click();
      await page.waitForTimeout(400);
      expect(await btn.getAttribute("aria-expanded"), "再撳應該返 true").toBe("true");
      expect(
        await page.locator(".legend-item:visible").count(),
        "復原後應該再見到圖例項目",
      ).toBe(visibleBefore);
    } finally {
      await browser.close();
    }
  }, 90_000);
});

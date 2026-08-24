// 《病港》— 動態網絡審計（Playwright）
// globalSetup 自動起 vite preview（port 5174），測完自動關。
// 首次需要：npx playwright install chromium

import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

describe("動態網絡審計（Playwright）", () => {
  it("載入主地圖＋時間軸＋搜尋互動，零 external request", async () => {
    let browser;
    try {
      browser = await chromium.launch();
    } catch {
      console.warn("[skip] Playwright chromium 未安裝：npx playwright install chromium");
      return;
    }

    const externalRequests: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("request", (req) => {
        const url = req.url();
        if (url.startsWith(BASE_URL) || url.startsWith("data:")) return;
        externalRequests.push(url);
      });

      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.keyboard.press("f");
      const searchInput = page.locator("#bg-search-input");
      if (await searchInput.count()) {
        await searchInput.fill("夏晴");
        await page.waitForTimeout(400);
        await searchInput.fill("");
      }
      await page.goto(`${BASE_URL}/timeline.html`, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);

      expect(externalRequests, `非本機 request：\n${externalRequests.join("\n")}`).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 90_000);
});

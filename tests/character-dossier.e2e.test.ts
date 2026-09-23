// P0-5：角色 dossier 測試（實瀏覽器）
//
// 為何要有呢個檔
// ============
// `StoryPanel.ts` 嘅 `.char-chip` click handler 原本係 `console.log` + TODO
// （A7 P0-5 / C8「dossier 係唔係空洞」）。呢個測試驗證佢真係顯示角色詳情。
//
// 用 `?location=loc_0004`（大本營）—— 佢有 20 個相關角色，`char-grid` 一定有嘢。

import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

describe("P0-5 角色 dossier", () => {
  it("點 .char-chip → 顯示角色詳情（.char-detail），可關閉", async () => {
    const browser = await chromium.launch({ args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      // 大本營（loc_0004）有 20 個相關角色
      await page.goto(`${BASE_URL}/?location=loc_0004`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);

      const chips = await page.locator(".char-chip").count();
      expect(chips, "大本營應該有 .char-chip").toBeGreaterThan(0);

      // 記住第一個 chip 嘅角色名，然後點佢
      const name = await page.locator(".char-chip").first().getAttribute("data-char-name");
      expect(name, ".char-chip 應該有 data-char-name").toBeTruthy();

      await page.locator(".char-chip").first().click();
      await page.waitForTimeout(400);

      // ① 應該出現角色詳情
      await expect.poll(() => page.locator(".char-detail").count(), {
        timeout: 5_000,
      }).toBe(1);

      // ② 詳情內容應該包含角色名
      const text = await page.locator(".char-detail").innerText();
      expect(text, "詳情應該顯示角色名").toContain(name!);

      // ③ 點第二個 chip 應該換走第一張卡（唔會疊）
      if (chips > 1) {
        await page.locator(".char-chip").nth(1).click();
        await page.waitForTimeout(300);
        expect(
          await page.locator(".char-detail").count(),
          "同時只應該有一張角色卡",
        ).toBe(1);
      }

      // ④ 關閉掣應該移除詳情
      await page.locator(".char-detail .close-btn").click();
      await page.waitForTimeout(300);
      expect(
        await page.locator(".char-detail").count(),
        "點關閉之後應該冇角色卡",
      ).toBe(0);
    } finally {
      await browser.close();
    }
  }, 90_000);
});

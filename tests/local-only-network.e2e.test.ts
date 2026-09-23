/**
 * local-only-network.e2e.test.ts — 驗收矩陣 §2-11（Local-only network）。
 *
 * 為何要有呢個檔
 * ==============
 * 驗收矩陣 §2-11：「intercept requests；assert no external request」。
 * `tests/network-audit.test.ts` 做**靜態**掃描（dist 檔內容），
 * `tests/network-dynamic.test.ts` 做**動態**攔截（載入 + 搜尋）。
 *
 * 本檔補一條**更長嘅旅程**：地圖縮放 / 平移 / 圖層切換 / chronicle /
 * 搜尋 overlay / 主題切換 / reload —— 因為「外部請求」通常係由某個
 * **互動**觸發（例如某個 lazy import 打去 remote API），只驗載入係唔夠。
 *
 * ⚠️ 只加新檔，唔改任何既有測試。
 */

import { chromium, type Browser } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

/** 本機請求嘅判定：同源 + data/blob + about。 */
function isLocal(url: string): boolean {
  return (
    url.startsWith(BASE_URL) ||
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("about:")
  );
}

describe("驗收矩陣 §2-11：local-only network", () => {
  it("完整旅程（載入 → 縮放 → 平移 → chronicle → 搜尋 → 主題 → reload）零外部請求", async () => {
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ args: ["--no-proxy-server"] });
    } catch {
      console.warn("[skip] Playwright chromium 未安裝");
      return;
    }

    const external: string[] = [];
    let total = 0;
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on("request", (req) => {
        total++;
        const u = req.url();
        if (!isLocal(u)) external.push(`${req.method()} ${u}`);
      });

      // 1) 初次入站
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);

      // 2) 地圖縮放（觸發 LOD1 / LOD2 + 圖磚 lazy load）
      for (let i = 0; i < 8; i++) {
        await page.locator("#map-zoom-in").click({ force: true }).catch(() => {});
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(800);

      // 3) 平移
      const box = await page.locator("#svg-map").boundingBox();
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx - 120, cy - 60, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(500);
      }

      // 4) 圖層切換（每個 toggle 都可能觸發 lazy 路徑）
      for (const id of [
        "#map-show-all-events",
        "#map-zoom-out",
        "#map-zoom-in",
        "#map-reset",
      ]) {
        await page.locator(id).click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }

      // 5) chronicle（?view=chronicle）
      await page.goto(`${BASE_URL}/?view=chronicle`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);

      // 6) 搜尋 overlay
      await page.locator("#btn-search").click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
      const input = page.locator("#search-input");
      if (await input.count()) {
        await input.fill("將").catch(() => {});
        await page.waitForTimeout(400);
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);

      // 7) 主題切換（Canvas palette 重新讀 token）
      await page.locator("#btn-theme").click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);

      // 8) reload（service worker 接管之後再行一次）
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(800);

      expect(total, "旅程應該真係有發請求（否則攔截器冇生效）").toBeGreaterThan(5);
      expect(
        external,
        `旅程期間出現外部請求（違反完全離線要求）：\n${external.join("\n")}`,
      ).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 180_000);
});

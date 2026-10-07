// D 階段 2（2026-10-07）—— 執行期 stylesheet 次序（**真瀏覽器**）
//
// 為何要有呢個檔
// ==============
// D 階段 2 移除咗 `mobile.css` 全部 `!important` → 佢嘅規則之所以仍然
// 蓋得過 `map.css` 同 bundled 嘅舊 CSS，**完全靠 `<head>` 內嘅載入次序**。
//
// `tests/style-sheet-order.test.ts` 只證明「原始碼有次序契約」；
// 本檔證明「真實瀏覽器之下次序真係咁」—— 兩者互補，缺一不可。
//
// ⚠️ CI（ubuntu-latest）冇裝 Playwright browser → 本檔會 skip
// （`launch()` 回 null）。所以靜態契約係 CI 唯一守衛。

import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";
const TIMEOUT = 90_000;

/** 期望嘅次序（由先到後）。bundled `<link>` 一定最先。 */
const EXPECTED = ["(bundle)", "map-v2-css", "b8-mobile-css"];

async function launch(): Promise<Browser | null> {
  try {
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

async function openPage(browser: Browser, vp: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport: vp, locale: "zh-HK" });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
    timeout: 20_000,
  });
  await page.waitForTimeout(600);
  return page;
}

const ORDER = () =>
  Array.from(document.head.querySelectorAll("style, link[rel=stylesheet]")).map(
    (el) => el.id || "(bundle)",
  );

describe("D 階段 2：真瀏覽器之下嘅 stylesheet 次序", () => {
  it(
    "⭐ `#b8-mobile-css` 係最後一個（mobile.css 冇 !important，全靠後載入）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        for (const vp of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          const page = await openPage(browser, vp);
          const order = await page.evaluate(ORDER);
          console.log(`[D2] ${vp.width}x${vp.height} head 次序：`, JSON.stringify(order));

          // 一定要有齊兩個執行期 stylesheet（否則呢個測試係空轉）
          expect(order, "要有 #map-v2-css").toContain("map-v2-css");
          expect(order, "要有 #b8-mobile-css").toContain("b8-mobile-css");
          // 次序：bundle → map → mobile
          expect(
            order,
            `head 次序應該係 ${EXPECTED.join(" → ")}，實際 ${order.join(" → ")}`,
          ).toEqual(EXPECTED);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it(
    "⭐ `mobile.css` 真係蓋得過 `map.css`（同特異度之下靠次序勝出）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openPage(browser, { width: 390, height: 844 });
        /*
         * 搵一個 **map.css 同 mobile.css 都有、而值唔同** 嘅宣告，
         * 確認實際生效嘅係 mobile.css 嗰個。
         *
         * `#map-controls .map-ctrl` 嘅 `min-height`：
         *   map.css   → 由 token 決定（實測 40px）
         *   mobile.css → 44px（P1-1 C3 觸控目標）
         * 兩者特異度相同 → 後載入者（mobile）勝。
         */
        const m = await page.evaluate(() => {
          const el = document.querySelector("#map-controls .map-ctrl") as HTMLElement | null;
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            minHeight: cs.minHeight,
            minWidth: cs.minWidth,
            // 同時確認兩個 stylesheet 都真係載入到
            sheets: Array.from(document.head.querySelectorAll("style[id]")).map((s) => s.id),
          };
        });
        expect(m, "搵唔到 #map-controls .map-ctrl").not.toBeNull();
        expect(m!.sheets).toContain("map-v2-css");
        expect(m!.sheets).toContain("b8-mobile-css");
        // mobile.css 嘅 44px 要勝出（唔靠 !important，靠次序）
        expect(
          m!.minHeight,
          `#map-controls .map-ctrl 嘅 min-height 應該係 mobile.css 嘅 44px（實際 ${m!.minHeight}）`,
        ).toBe("44px");
        expect(m!.minWidth).toBe("44px");
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});

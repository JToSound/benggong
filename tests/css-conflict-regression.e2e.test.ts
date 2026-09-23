// CSS 衝突回歸守門（實瀏覽器）
//
// 為何要有呢個檔
// ============
// 2026-09-23 用戶報「地圖加咗個超級模糊嘅濾鏡，完全睇唔到地圖」。
// 根因：`main.css` / `hud.css`（舊）同 `map.css`（V2）**同名 class 語義相反** ——
// `.map-overlay` 喺 V2 係「全尺寸透明定位容器」（`inset: 0`），
// 但舊 CSS 當佢係「玻璃面板」（`backdrop-filter: blur(10px)`）。
// 舊 CSS 後載入贏 → 1060×741 嘅容器帶 blur → 整個地圖被模糊。
//
// 呢個測試斷言**關鍵元素嘅 computed style 係「新值」** ——
// 將來如果有人改 CSS 令舊值贏返，就會變紅。
//
// ⚠️ 唔可以用「檢查 CSS 文字」代替 —— 因為覆蓋可能來自
// `!important`、後載入次序、或者更高特異度（靜態分析捉唔到）。

import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

describe("CSS 衝突回歸守門", () => {
  it("地圖容器唔應該被模糊（.map-overlay 必須係透明容器，唔係玻璃面板）", async () => {
    const browser = await chromium.launch({ args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);

      const r = await page.evaluate(() => {
        const cs = (s: string) => {
          const el = document.querySelector(s);
          return el ? getComputedStyle(el) : null;
        };
        const ov = cs("#map-overlay");
        const lg = cs("#map-legend");
        return {
          // 🔴 核心斷言：全尺寸容器唔可以有 backdrop-filter（會模糊底下成個地圖）
          overlayBackdrop: ov?.backdropFilter ?? "(missing)",
          overlayFilter: ov?.filter ?? "(missing)",
          overlayBg: ov?.backgroundColor ?? "(missing)",
          // 圖例面板（面積細）可以保留玻璃效果
          legendBackdrop: lg?.backdropFilter ?? "(missing)",
          legendMaxWidth: lg?.maxWidth ?? "(missing)",
        };
      });

      // 🔴 呢兩個係事故嘅核心 —— 一定要係 none
      expect(
        r.overlayBackdrop,
        "`.map-overlay` 係全尺寸容器（inset:0）—— 有 backdrop-filter 會模糊成個地圖",
      ).toBe("none");
      expect(r.overlayFilter, "`.map-overlay` 唔應該有 filter").toBe("none");

      // 圖例面板保留玻璃效果（面積細，唔影響地圖）
      expect(r.legendBackdrop, "`.map-legend` 應該保留 blur（細面板）").toContain("blur");
      // V2 值（`map.css`）—— 舊值係 56vw
      expect(r.legendMaxWidth, "`.map-legend` max-width 應該係 V2 嘅 260px").toBe("260px");
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("chronicle view 用 V2 嘅 grid 版面（唔係舊 CSS 嘅 flex）", async () => {
    const browser = await chromium.launch({ args: ["--no-proxy-server"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${BASE_URL}/?view=chronicle`, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);
      const display = await page.evaluate(
        () => getComputedStyle(document.querySelector(".chronicle")!).display,
      );
      expect(display, "`.chronicle` 應該係 V2 嘅 grid").toBe("grid");
    } finally {
      await browser.close();
    }
  }, 90_000);
});

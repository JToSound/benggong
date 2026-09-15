// 《病港》— Phase I 互動驗證（Playwright）
// globalSetup 自動起 vite preview（port 5174），測完自動關。
// 首次需要：npx playwright install chromium
//
// 驗證範圍：
// - 底圖 PNG 同獨立標籤圖層都有正確載入
// - `#label-detail-layer` 透明度按 viewScale 線性變化（label decluttering）
// - 縮放按鈕、重置視圖、flyToChapter 平滑轉場
// - 雙語圖例切換

import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import basemapCoords from "../public/assets/hk-basemap-coords.json";

const BASE_URL = "http://localhost:5174";

/** 全港視圖嘅經度跨度（由 render script 產生，唔應該喺測試寫死）。 */
const BASE_LON_SPAN =
  basemapCoords.bbox.lon_max - basemapCoords.bbox.lon_min;

/** 讀 `#label-detail-layer` 嘅 opacity attribute（number）。 */
async function labelOpacity(page: Page): Promise<number> {
  const v = await page.getAttribute("#label-detail-layer", "opacity");
  return v === null ? Number.NaN : parseFloat(v);
}

/** 讀目前 viewBox 嘅寬度（user unit；越細 = 放得越大）。 */
async function viewBoxWidth(page: Page): Promise<number> {
  const vb = await page.getAttribute("#svg-map", "viewBox");
  return parseFloat((vb ?? "").split(/\s+/)[2] ?? "NaN");
}

async function launch(): Promise<Browser | null> {
  try {
    return await chromium.launch();
  } catch {
    console.warn("[skip] Playwright chromium 未安裝：npx playwright install chromium");
    return null;
  }
}

describe("Phase I 互動驗證（Playwright）", () => {
  it("底圖 + 標籤圖層載入，且標籤透明度隨 zoom 變化", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage();
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      // 1) 底圖存在
      const baseHref = await page.getAttribute("#basemap-group", "href");
      expect(baseHref, "底圖 href 應該係 hk-basemap PNG").toContain("hk-basemap");
      expect(baseHref).not.toContain("labels");

      // 2) 獨立標籤圖層存在，且指向 label PNG
      const layerCount = await page.locator("#label-detail-layer").count();
      expect(layerCount, "#label-detail-layer 必須存在").toBe(1);
      const labelHref = await page.getAttribute(
        "#label-detail-layer image",
        "href",
      );
      expect(labelHref, "標籤圖層應該指向 hk-basemap-labels PNG").toContain(
        "hk-basemap-labels",
      );

      // 3) 初始（全港視圖，viewScale = 1.0）→ 透明度 = 0.5
      await expect
        .poll(() => labelOpacity(page), { timeout: 5_000 })
        .toBeCloseTo(0.5, 2);

      // 4) 放大 → viewScale 上升 → 透明度升至 1.0
      for (let i = 0; i < 3; i++) {
        await page.click("#map-zoom-in");
      }
      expect(await viewBoxWidth(page)).toBeLessThan(BASE_LON_SPAN * 0.5);
      await expect
        .poll(() => labelOpacity(page), { timeout: 5_000 })
        .toBeCloseTo(1.0, 2);

      // 5) 重置 → 動畫回到全港視圖，透明度回落 0.5
      await page.click("#map-reset");
      await expect
        .poll(() => viewBoxWidth(page), { timeout: 5_000 })
        .toBeCloseTo(BASE_LON_SPAN, 2);
      await expect
        .poll(() => labelOpacity(page), { timeout: 5_000 })
        .toBeCloseTo(0.5, 2);
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("flyToChapter 平滑轉場會縮到章節 bbox", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage();
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      const before = await viewBoxWidth(page);
      // 用鍵盤 k 推進章節 → app.setChapter() → svgMap.flyToChapter()
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("k");
      }
      // 等轉場完成（500ms）+ buffer
      await page.waitForTimeout(1_200);
      const after = await viewBoxWidth(page);

      expect(after, "flyToChapter 應該放大到章節 bbox").toBeLessThan(before);
      // 放大之後標籤圖層應該比全港視圖（0.5）更明顯
      // （實際值取決於章節 bbox 大小，所以只驗證方向，唔硬編 1.0）
      expect(await labelOpacity(page)).toBeGreaterThan(0.5);
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("雙語圖例切換（zh ↔ en）", async () => {    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage();
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      const title = page.locator('.legend-title[data-i18n="legend.title"]');
      expect(await title.textContent()).toContain("地圖標記");

      await page.click("#legend-lang-btn");
      expect(await title.textContent()).toContain("Map legend");
      expect(
        await page.locator('[data-i18n="legend.event-current"]').textContent(),
      ).toContain("Current-chapter event");
      expect(await page.textContent("#legend-lang-btn")).toContain("中文");

      // 路線圖例嘅誠實披露必須中英同步：中文講「僅真實地點之間」，
      // 英文必須有對應說明，唔可以只寫 "Character route"。
      expect(
        await page.locator('[data-i18n="legend.route"]').textContent(),
      ).toContain("real places only");

      // 再切一次應該回到中文
      await page.click("#legend-lang-btn");
      expect(await title.textContent()).toContain("地圖標記");
      expect(
        await page.locator('[data-i18n="legend.route"]').textContent(),
      ).toContain("角色路線");
      expect(
        await page.locator('[data-i18n="legend.route"]').textContent(),
      ).toContain("僅真實地點之間");

      // dot / line 樣本 span 必須保留（唔可以被文字替換清走）
      expect(await page.locator(".legend-item .dot").count()).toBeGreaterThan(0);
      expect(await page.locator(".legend-item .line.route-legend").count()).toBe(1);
    } finally {
      await browser.close();
    }
  }, 90_000);

  // ------------------------------------------------------------------
  // 路線誠實性
  //
  // 543/714 個 location 嘅 location_precision 係 fictional，座標為任意值。
  // 如果照樣連線，會出現跨區「假路徑」（實測最長 41.4 km）。以下斷言
  // 確保只會畫出短距離、可信嘅線段。
  // ------------------------------------------------------------------
  it("路線只畫短距離可信線段（唔會出現跨區假連線）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);

      // 1 viewBox 單位 ≈ 103 km（經度）／111 km（緯度）
      const K = { lon: 103_000, lat: 111_000 };
      const MAX_SEGMENT_M = 6_000; // 實測最長 3.4 km，留安全邊際

      let maxM = 0;
      let totalSegments = 0;

      for (let ch = 1; ch <= 198; ch++) {
        if (ch > 1) {
          await page.keyboard.press("k");
          await page.waitForTimeout(40);
        }
        const ds = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".route-line")).map(
            (p) => p.getAttribute("d") || "",
          ),
        );
        for (const d of ds) {
          const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);
          for (let i = 0; i + 3 < nums.length; i += 4) {
            totalSegments++;
            maxM = Math.max(
              maxM,
              Math.hypot(
                (nums[i + 2] - nums[i]) * K.lon,
                (nums[i + 3] - nums[i + 1]) * K.lat,
              ),
            );
          }
        }
      }

      expect(totalSegments, "應該有路線線段先有意義").toBeGreaterThan(0);
      expect(
        Math.round(maxM),
        `最長路線線段 ${Math.round(maxM)}m 超過 ${MAX_SEGMENT_M}m 上限`,
      ).toBeLessThan(MAX_SEGMENT_M);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("切換章節會重繪標記（flyToChapter 必須 render）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);

      const idsAt = async (): Promise<string> => {
        return page.evaluate(() =>
          Array.from(document.querySelectorAll(".location-marker"))
            .map((m) => m.getAttribute("data-loc-id") || "")
            .sort()
            .join(","),
        );
      };

      const ch1 = await idsAt();
      for (let i = 0; i < 59; i++) {
        await page.keyboard.press("k");
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(900);
      const ch60 = await idsAt();

      expect(ch1.length, "ch1 應該有 location markers").toBeGreaterThan(0);
      expect(ch60, "ch60 嘅 marker 集合應該同 ch1 唔同").not.toBe(ch1);
    } finally {
      await browser.close();
    }
  }, 120_000);
});

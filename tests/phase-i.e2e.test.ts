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
  it("向量底圖載入並跟住縮放重繪", async () => {
    /*
     * Phase L 之後，底圖由 raster LOD 改為**向量 canvas**
     * （見 `src/map/VectorBasemap.ts`）。
     *
     * 舊斷言「#basemap-group 嘅 href 應該係 hk-basemap PNG」已經過時 ——
     * raster 而家只做後備，預設冇 href（唔想為咗平時唔用嘅 2 MB PNG 付流量）。
     *
     * 新斷言要證明三件事：
     *   1. 向量 canvas 存在而且有尺寸
     *   2. 底圖真係 ready（`.basemap-vector-ready`）
     *   3. **縮放之後 canvas 內容真係變咗** —— 呢個係「有渲染但冇重繪」
     *      嘅唯一可靠檢查（一般「元素存在」嘅斷言捉唔到）
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage();
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      // 1) canvas 存在而且有實際尺寸
      const size = await page.evaluate(() => {
        const c = document.querySelector("#basemap-canvas") as HTMLCanvasElement | null;
        return c ? { w: c.width, h: c.height } : null;
      });
      expect(size, "#basemap-canvas 必須存在").not.toBeNull();
      expect(size!.w).toBeGreaterThan(200);
      expect(size!.h).toBeGreaterThan(200);

      // 2) 底圖 ready
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              document.querySelector(".svg-map-wrap")!.classList.contains("basemap-vector-ready"),
            ),
          { timeout: 15_000 },
        )
        .toBe(true);

      // 3) raster 後備圖層**唔應該**有 href（向量正常時唔會載入）
      const rasterHref = await page.getAttribute("#basemap-group", "href");
      expect(rasterHref, "向量底圖正常時 raster 後備唔應該載入").toBeNull();

      // 4) 初始視圖 = 全港（唔可以一開始就放大咗）
      expect(await viewBoxWidth(page)).toBeCloseTo(BASE_LON_SPAN, 2);

      // 5) 縮放 → canvas 像素內容改變
      const sample = () =>
        page.evaluate(() => {
          const c = document.querySelector("#basemap-canvas") as HTMLCanvasElement;
          const ctx = c.getContext("2d")!;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4013 * 4) sum = (sum + d[i] + d[i + 1] * 3) % 1e9;
          return sum;
        });
      const before = await sample();
      for (let i = 0; i < 4; i++) {
        await page.click("#map-zoom-in");
        await page.waitForTimeout(220);
      }
      await page.waitForTimeout(600);
      const after = await sample();
      expect(after, "縮放之後 canvas 內容必須改變（否則係冇重繪）").not.toBe(before);

      // 6) 層級屬性要跟住更新
      const lvl = await page.getAttribute("#basemap-canvas", "data-basemap-level");
      expect(lvl).not.toBeNull();
      expect(Number(lvl)).toBeGreaterThanOrEqual(1);
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

      /*
       * 標籤圖層嘅預期要跟 LOD 設計，唔可以硬編。
       *
       * 設計：**只有 overview 層**用獨立標籤圖層（`#label-detail-layer`）。
       * 將軍澳各層（tko-region / district / street / campus）嘅標籤已經
       * **烙入圖磚**，所以該層強制歸零 —— 否則兩套唔同比例嘅字會疊埋。
       *
       * 所以飛到第 9 章（將軍澳）之後，正確行為係：
       *   - 揀到 TKO 層 → `data-tier-label-layer="0"` → 獨立圖層關閉
       *   - 圖磚本身有標籤（睇截圖可見「調景嶺」「將軍澳」等地名）
       *
       * ⚠️ 原本嘅斷言係 `opacity > 0.5`，假設咗「放大 = 獨立圖層更明顯」。
       * 嗰個假設喺 TKO 分層出現之前成立，之後就唔再成立。
       */
      const tierLabelLayer = await page.getAttribute(
        "#label-detail-layer",
        "data-tier-label-layer",
      );
      if (tierLabelLayer === "0") {
        expect(
          await labelOpacity(page),
          "標籤已烙入圖磚時，獨立圖層必須歸零（否則雙重標籤）",
        ).toBe(0);
      } else {
        expect(
          await labelOpacity(page),
          "用 overview 層時，獨立圖層應該隨縮放顯示",
        ).toBeGreaterThan(0.5);
      }
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

      /*
       * viewBox 單位 → 米。
       *
       * x 軸 = 經度：1° ≈ 111,320 m × cos(22.36°) ≈ 102,940 m
       *
       * ⚠️ y 軸**唔係**緯度。`lonlatToViewbox()` 做咗 1/cos(φ₀) 校正：
       *     y = 22.11 + (22.61 − lat) × 1.0814
       * 所以 1 個 y 單位 ≈ 111,320 / 1.0814 ≈ 102,940 m，唔係 111,000 m。
       * 用 111,000 會高估緯度方向嘅距離最多 8.6%。
       */
      const K = { lon: 102_940, lat: 102_940 };
      const MAX_SEGMENT_M = 6_000; // 實測最長 3.99 km，留安全邊際

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
          // 用 [data-loc-id] 而唔係 .location-marker：聚合標記
          // （.location-marker-cluster）都帶 data-loc-id
          Array.from(document.querySelectorAll("[data-loc-id]"))
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

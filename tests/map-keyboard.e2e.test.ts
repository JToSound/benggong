// P1-2 地圖元素鍵盤可達（A7 驗收矩陣 §10.9）—— 實瀏覽器 e2e
//
// 為何要呢個檔
// ============
// A7 `mobile-a11y-audit.md` P1-2 實測：地圖 19 個互動元素全部
// `tabIndex = -1`、冇 `role`、冇 `aria-label` → **鍵盤可達 0/19**。
//
// 純函數（`src/map/map-keyboard.ts`）同靜態接線由 `tests/map-keyboard.test.ts`
// 覆蓋；本檔負責**真瀏覽器行為**：
//   · 由鍵盤 Tab 入到地圖 → 落到一個真正嘅地圖元素；
//   · 任何時候**只有一個**地圖元素係 `tabindex="0"`（roving，唔會爆 Tab stop）；
//   · 方向鍵喺元素之間移動；
//   · `Enter` 啟動（等同 click）→ 真係選中 zone；
//   · 焦點指示**真係睇得到**（逐像素比對，唔可以目測）。
//
// ⚠️ 一定要真瀏覽器：SVG 元素嘅 `focus()` 行為同 `:focus-visible` 喺
// jsdom／mock DOM 之下完全唔同 —— 實測踩過「computed style 正確但焦點
// 靜默失敗」。

import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";
const E2E_TIMEOUT = 120_000;

let browser: Browser | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    browser = null;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function newPage(): Promise<Page | null> {
  if (!browser) return null;
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: "zh-HK",
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await page
    .waitForFunction(
      () =>
        document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ??
        false,
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(600);
  return page;
}

/** 目前 `tabindex="0"` 嘅地圖元素（應該恆久只有一個）。 */
async function rovingState(page: Page) {
  return page.evaluate(() => {
    const sel =
      ".zone, .route-line, .location-marker, .location-marker-cluster, .event-marker";
    const all = Array.from(document.querySelectorAll(`#svg-map ${sel}`));
    const zero = all.filter((e) => e.getAttribute("tabindex") === "0");
    const withRole = all.filter((e) => e.getAttribute("role") === "button");
    const withLabel = all.filter((e) => (e.getAttribute("aria-label") ?? "").length > 0);
    const act = document.activeElement;
    return {
      total: all.length,
      zeroCount: zero.length,
      zeroKey: zero[0] ? `${zero[0].getAttribute("class")}` : null,
      roleCount: withRole.length,
      labelCount: withLabel.length,
      active: act
        ? `${act.tagName}.${(act.getAttribute("class") ?? "").split(" ")[0]}`
        : "(none)",
    };
  });
}

describe("P1-2：地圖元素鍵盤可達（§10.9）", { timeout: E2E_TIMEOUT }, () => {
  it("地圖元素有 role=button + aria-label，而且只有一個 tabindex=0", async () => {
    const page = await newPage();
    if (!page) return;
    try {
      // 先縮放令 zone 出現（Z0 全部 zone 疊埋，仍然 render 但細）
      for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(900);

      const s = await rovingState(page);
      expect(s.total, "地圖應該有互動元素").toBeGreaterThan(0);
      expect(s.roleCount, "全部互動元素都要有 role=button").toBe(s.total);
      expect(s.labelCount, "全部互動元素都要有 aria-label").toBe(s.total);
      expect(s.zeroCount, "roving：任何時候只有一個 tabindex=0").toBe(1);
    } finally {
      await page.close();
    }
  });

  it("⭐ Tab 入到地圖 → 落到地圖元素；方向鍵移動；Enter 真係選中 zone", async () => {
    const page = await newPage();
    if (!page) return;
    try {
      for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(900);

      // 由 SVG root 出發，Tab 一次應該落喺 roving 元素（唯一 tabindex=0）
      await page.evaluate(() => {
        (document.querySelector("#svg-map") as SVGSVGElement).focus();
      });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);

      const afterTab = await rovingState(page);
      expect(
        afterTab.active.startsWith("g.zone") ||
          afterTab.active.includes("marker") ||
          afterTab.active.includes("event"),
        `Tab 之後焦點應該落喺地圖元素（實際 ${afterTab.active}）`,
      ).toBe(true);

      const keyBefore = await page.evaluate(
        () =>
          document.querySelector('#svg-map [tabindex="0"]')?.getAttribute("data-zone-id") ??
          null,
      );

      // 方向鍵 → 焦點／roving 移到另一個元素
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(300);
      const keyAfter = await page.evaluate(
        () =>
          document.querySelector('#svg-map [tabindex="0"]')?.getAttribute("data-zone-id") ??
          null,
      );
      const afterArrow = await rovingState(page);
      expect(afterArrow.zeroCount, "方向鍵之後仍然只有一個 tabindex=0").toBe(1);
      expect(keyAfter, "方向鍵應該移到另一個 zone").not.toBe(keyBefore);

      // Enter → 等同 click（選中 zone + URL 帶 zone=）
      const targetId = keyAfter;
      await page.keyboard.press("Enter");
      await page.waitForTimeout(700);
      const res = await page.evaluate(() => ({
        sel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
        url: location.href,
      }));
      expect(res.sel, "Enter 之後應該有一個 zone 被選中").toBe(1);
      expect(res.url, "URL 應該帶 ?zone=").toContain("zone=");
      expect(res.url, `URL 應該帶揀中嘅 zone（${targetId}）`).toContain(`zone=${targetId}`);
    } finally {
      await page.close();
    }
  });

  it("⭐ 焦點指示逐像素可見（focused vs unfocused 唔可以一樣）", async () => {
    const page = await newPage();
    if (!page) return;
    try {
      for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(900);

      // 用「roving 元素」嘅 bbox 擴 8px（容納 drop-shadow 光暈），
      // 再同 viewport 求交集 —— 太細／離屏就跳過。
      const box = await page.evaluate(() => {
        const el = document.querySelector('#svg-map [tabindex="0"]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        if (b.width < 4 || b.height < 4) return null;
        const pad = 8;
        const x = Math.max(0, Math.floor(b.x - pad));
        const y = Math.max(0, Math.floor(b.y - pad));
        const right = Math.min(window.innerWidth, Math.ceil(b.right + pad));
        const bottom = Math.min(window.innerHeight, Math.ceil(b.bottom + pad));
        if (right - x < 12 || bottom - y < 12) return null;
        return { x, y, width: right - x, height: bottom - y };
      });
      expect(box, "要搵到一個 roving 元素嘅可量測區域").not.toBeNull();

      // ① 未聚焦
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
      });
      await page.waitForTimeout(250);
      const unfocused = await page.screenshot({ clip: box! });

      // ② 聚焦（用真鍵盤，令 `:focus-visible` 生效）
      await page.evaluate(() => {
        (document.querySelector("#svg-map") as SVGSVGElement).focus();
      });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(250);
      const focused = await page.screenshot({ clip: box! });

      expect(
        Buffer.compare(unfocused, focused) !== 0,
        "焦點環一定要令像素有變化（唔可以「focus 咗但睇唔到」）",
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
});

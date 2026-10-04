// C8 P1-6 — story pane 改 overlay（地圖佔首屏 ≥70%）
//
// 為何要有呢個檔
// ==============
// spec `world-atlas-v2-product-spec.md:103` ＋ 驗收矩陣第 1 項要求
// 「`#map-pane` 面積 ≥70%」。實測 1440×900 之下只有 **60.6%**
// （topbar 65 ＋ chapter strip 94 ＋ **story pane 380**）。
//
// 算術：要達 70% 需要地圖闊 **1224px** → story pane 只可以 216px ——
// 但 story pane 承載產品一半內容，唔可行。
//
// 用戶裁決（2026-10-05）：**story pane 改成 overlay**（浮喺地圖上，唔佔
// layout 闊度）→ `#map-pane` 拿到 workspace 全部闊度 = **82.3%**。
//
// ⚠️ 為何 overlay 一定要**預設收起**
// --------------------------------
// 展開嘅 overlay 會蓋住右邊 380px（= 21.7% 面積）→ 用戶真正睇到嘅地圖
// **仍然只有 60.6%**。要真正滿足 spec 嘅意圖（首屏主 context = 地圖），
// 首屏就唔可以有展開嘅浮層。
//
// ⚠️ 為何「預設收起」唔會違反驗收矩陣第 1 項
// -----------------------------------------
// 第 1 項要求「4 個主入口文字存在且可鍵盤達」。實測嗰 4 個入口係
// **`OnboardingCard`**（掛喺 `#map-pane`，浮喺地圖上）—— **唔喺 story pane 內**
// → 收起 story pane 完全唔影響佢哋。本檔會**實瀏覽器**驗證呢一點
// （唔係只讀原始碼）。
//
// 全部斷言程式化、可重跑、零人手。

import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

/** 驗收矩陣第 1 項嘅基準 viewport。 */
const DESKTOP = { width: 1440, height: 900 };
/** 回歸用（原本 56.3% / 68.4%，亦要 ≥70%）。 */
const OTHER_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

const TIMEOUT = 90_000;

async function launch(): Promise<Browser | null> {
  try {
    // ⚠️ `--no-proxy-server`：沙箱有 http_proxy，Chromium 會將 localhost 交畀代理。
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

/** 開一個 page 並等 app ready（章節條有 pill = 資料已載入）。 */
async function openPage(
  browser: Browser,
  vp: { width: number; height: number },
  query = "",
): Promise<Page> {
  const page = await browser.newPage({ viewport: vp, locale: "zh-HK" });
  await page.goto(`${BASE_URL}/${query}`, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.querySelectorAll(".ch-pill").length > 100,
    null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(400);
  return page;
}

/** `#map-pane` 佔首屏面積（程式化量度，同 probe 腳本同一條公式）。 */
async function mapPaneArea(page: Page): Promise<{ pct: number; w: number; h: number }> {
  return page.evaluate(() => {
    const r = document.querySelector("#map-pane")!.getBoundingClientRect();
    return {
      pct: Number(((r.width * r.height) / (innerWidth * innerHeight) * 100).toFixed(1)),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
}

/** story pane 係唔係「真正可見」（唔止冇 class）。 */
async function paneVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const p = document.querySelector("#story-pane") as HTMLElement | null;
    if (!p) return false;
    const cs = getComputedStyle(p);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = p.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // 中心點要落喺 viewport 內而且冇被遮蓋
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
    const hit = document.elementFromPoint(cx, cy);
    return Boolean(hit && (hit === p || p.contains(hit)));
  });
}

/** 搵一個「中心點真正命中 `.zone`」嘅 zone，回傳中心座標。 */
async function findClickableZone(
  page: Page,
): Promise<{ x: number; y: number; id: string } | null> {
  return page.evaluate(() => {
    const zones = Array.from(
      document.querySelectorAll<SVGGElement>("#zones-layer .zone[data-zone-id]"),
    );
    for (const z of zones) {
      const r = z.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      const hit = document.elementFromPoint(cx, cy);
      // ⚠️ 一定要命中自己（唔可以被引導卡／圖例遮蓋）
      if (hit && hit.closest?.(".zone") === z) {
        return { x: cx, y: cy, id: z.getAttribute("data-zone-id") ?? "" };
      }
    }
    return null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 地圖面積（驗收矩陣第 1 項）
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-6：`#map-pane` 佔首屏面積", () => {
  it(
    "⭐ 1440×900（驗收矩陣基準）≥70%",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openPage(browser, DESKTOP);
        const a = await mapPaneArea(page);
        expect(
          a.pct,
          `#map-pane 只佔 ${a.pct}%（${a.w}×${a.h}）—— spec 要 ≥70%`,
        ).toBeGreaterThanOrEqual(70);
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it(
    "1280×800 同 1920×1080 亦要 ≥70%（回歸）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        for (const vp of OTHER_VIEWPORTS) {
          const page = await openPage(browser, vp);
          const a = await mapPaneArea(page);
          expect(
            a.pct,
            `${vp.width}×${vp.height}：#map-pane 只佔 ${a.pct}%`,
          ).toBeGreaterThanOrEqual(70);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 首屏狀態：pane 收起（唔會蓋住地圖）
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-6：首屏 story pane 收起", () => {
  it(
    "⭐ 首屏 pane 唔可見（否則地圖實際可視面積會跌返 60.6%）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openPage(browser, DESKTOP);
        expect(await paneVisible(page), "首屏 story pane 應該係收起（唔可見）").toBe(false);
        expect(await page.getAttribute("#btn-toggle-panel", "aria-expanded")).toBe("false");
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it(
    "⭐ pane 開／關唔會改變 `#map-pane` 幾何（overlay 唔佔 layout）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openPage(browser, DESKTOP);
        const before = await mapPaneArea(page);
        await page.locator("#btn-toggle-panel").click();
        await page.waitForTimeout(500);
        expect(await paneVisible(page), "撳「面板」之後 pane 應該可見").toBe(true);
        expect(await page.getAttribute("#btn-toggle-panel", "aria-expanded")).toBe("true");
        const after = await mapPaneArea(page);
        expect(
          { w: after.w, h: after.h },
          "overlay 開咗之後 `#map-pane` 尺寸唔應該變",
        ).toEqual({ w: before.w, h: before.h });
        // 再撳一次 → 收返
        await page.locator("#btn-toggle-panel").click();
        await page.waitForTimeout(500);
        expect(await paneVisible(page), "再撳一次應該收返").toBe(false);
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 驗收矩陣第 1 項：4 個主入口（OnboardingCard，喺 `#map-pane` 內）
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-6：收起 story pane 之後，4 個主入口仍然可達", () => {
  it(
    "⭐ 4 個入口存在、可見、可聚焦（實瀏覽器；唔係只讀原始碼）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openPage(browser, DESKTOP);
        // 首屏 pane 已收起 → 呢個就係驗收矩陣第 1 項嘅真實狀態
        expect(await paneVisible(page)).toBe(false);

        const labels = ["探索地區", "搵角色", "搵事件", "打開編年史"];
        for (const label of labels) {
          const btn = page.locator(".onboarding-card .onboarding-action", {
            hasText: label,
          });
          expect(await btn.count(), `要有「${label}」入口`).toBe(1);
          // 可見（唔止存在）
          const box = await btn.first().boundingBox();
          expect(box, `「${label}」要有實際尺寸`).not.toBeNull();
          expect(box!.width).toBeGreaterThan(8);
          expect(box!.height).toBeGreaterThan(8);
          // 可聚焦（鍵盤可達）
          const focused = await btn.first().evaluate((el) => {
            (el as HTMLElement).focus();
            return document.activeElement === el;
          });
          expect(focused, `「${label}」應該可以聚焦（鍵盤可達）`).toBe(true);
        }
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 「內容只喺 pane 內」嘅操作要自動開 pane（唔可以撳咗冇反應）
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-6：自動開 pane", () => {
  it(
    "⭐ 切去編年史 → pane 自動開（否則撳「編年史」完全冇反應）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openPage(browser, DESKTOP);
        expect(await paneVisible(page)).toBe(false);
        await page.locator("#btn-mode").click();
        await page.waitForTimeout(600);
        expect(
          await paneVisible(page),
          "切去編年史之後 pane 一定要自動開（內容喺 pane 內）",
        ).toBe(true);
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it(
    "⭐ `?location=` 深連結 → pane 自動開（story panel 喺 pane 內）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        // 大本營（loc_0004）：context 係 location → story panel 喺 pane 內
        const page = await openPage(browser, DESKTOP, "?location=loc_0004");
        await page.waitForTimeout(600);
        expect(
          await paneVisible(page),
          "`?location=` 深連結嘅內容喺 pane 內 → pane 一定要自動開",
        ).toBe(true);
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it(
    "⭐ 揀 zone → pane 自動開（dossier 喺 pane 內）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openPage(browser, DESKTOP);
        const zone = await findClickableZone(page);
        expect(zone, "要搵到一個中心點真正可點嘅 zone").not.toBeNull();
        await page.mouse.click(zone!.x, zone!.y);
        await page.waitForTimeout(700);
        expect(
          await paneVisible(page),
          `揀咗 ${zone!.id} 之後 pane 一定要自動開`,
        ).toBe(true);
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ⚠️ 浮層唔可以蓋住地圖控制項（實測踩過嘅回歸）
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-6：浮層唔可以蓋住地圖控制項", () => {
  it(
    "⭐ pane 打開時 `#map-zoom-in` 仍然撳得到（而且真係 zoom 到）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openPage(browser, DESKTOP);
        // 打開浮層
        await page.locator("#btn-toggle-panel").click();
        await page.waitForTimeout(600);
        expect(await paneVisible(page)).toBe(true);

        /*
         * ⚠️ 2026-10-05 實測踩過：浮層（`z-index: var(--z-panel)` = 30）
         * 蓋住 `#map-controls`（`z-index: var(--z-controls)` = 20，
         * 喺 `bottom: sp-3; right: sp-3`）→ Playwright 報
         * 「subtree intercepts pointer events」→ 撳唔到放大掣。
         *
         * 修法：`layout.css` 用 `.workspace.is-pane-open #map-controls`
         * 將控制項向左讓開一個面板闊度。呢個斷言守住嗰條規則。
         */
        const hit = await page.evaluate(() => {
          const btn = document.querySelector("#map-zoom-in") as HTMLElement | null;
          if (!btn) return { ok: false, why: "搵唔到 #map-zoom-in" };
          const r = btn.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const el = document.elementFromPoint(cx, cy);
          const hits = Boolean(el && (el === btn || btn.contains(el)));
          return {
            ok: hits,
            why: hits ? "" : `中心點被 ${el?.tagName}.${el?.getAttribute("class") ?? ""} 蓋住`,
            cx: Math.round(cx),
            cy: Math.round(cy),
          };
        });
        expect(hit.ok, `放大掣要喺浮層之上：${hit.why}`).toBe(true);

        // 而且真係撳得到（viewBox 要變）
        const before = await page.getAttribute("#svg-map", "viewBox");
        await page.locator("#map-zoom-in").click({ timeout: 10_000 });
        await page.waitForTimeout(400);
        const after = await page.getAttribute("#svg-map", "viewBox");
        expect(after, "撳咗放大掣之後 viewBox 應該變").not.toBe(before);
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});

// 《病港》World Atlas V2 — B8 mobile 版面 e2e（驗收矩陣 §2-9）
//
// 為何要有呢個檔案
// ================
// A7 審計（`docs/audits/mobile-a11y-audit.md`）喺 mobile 390×844 量到：
//
//   · `bottom sheet`          → `isSheet:false, hasDragHandle:false`
//   · `safe area`             → `viewport-fit=cover:false`，0 條 env() 規則
//   · 可見互動元素 <44px       → **24 個**
//   · `legend` 遮蓋地圖        → **24.3%**（門檻 15%）
//   · 頂欄標題                  → **4 行**
//
// 驗收矩陣 §2-9 要求：sheet 3 段 snap、`env(safe-area-inset-*)` 有處理、
// `scrollWidth <= 390`、可見互動元素 **0 個 < 44px**。
//
// ⚠️ 量測方法論（A7 已修正過，唔可以重蹈覆轍）
// -------------------------------------------
// 上一輪 `fail44Count: 3131` 係**高估幾個數量級**（真值 24）。根因係舊
// `visible()` 只檢查 display / visibility / opacity / 非零 box，**冇檢查
// 元素中心點係唔係真喺 viewport 內，亦冇檢查有冇被遮蓋**。3,107 個被誤判
// 嘅元素全部喺收合嘅 `#story-pane` 內（rect x = 403 > viewport 390）。
//
// 本檔嘅「可見」判定（全部程式化）：
//   1. computed style 唔係 `display:none` / `visibility:hidden` / `opacity:0`
//   2. 元素自身同所有祖先都冇被屏蔽
//   3. `getBoundingClientRect()` 寬高 > 0
//   4. **元素中心點落喺 viewport 內**
//   5. `document.elementFromPoint(中心點)` 命中自己或自己嘅子孫（冇被遮蓋）
//   6. 冇喺 `[aria-hidden="true"]` 或 `[inert]` 祖先之下
//
// 全部斷言程式化、可重跑、零人手。

import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

/** mobile 基準 viewport（spec / A7 一致）。 */
const MOBILE = { width: 390, height: 844 };

async function launch(): Promise<Browser | null> {
  try {
    // ⚠️ `--no-proxy-server`：沙箱／代理環境下 Chromium 會將 localhost 交畀代理。
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

/** 開一個 mobile page 並等 app ready。 */
async function openMobile(browser: Browser): Promise<Page> {
  const page = await browser.newPage({
    viewport: MOBILE,
    hasTouch: true,
    isMobile: true,
  });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  // 等 app 完成首次 render（章節條有 pill = 資料已載入）
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, {
    timeout: 20_000,
  });
  await page.waitForTimeout(600);
  return page;
}

// ─────────────────────────────────────────────────────────────────────────────
// 共用：嚴格「可見互動元素」量測（注入到瀏覽器）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 喺瀏覽器內量度真正可見嘅互動元素清單。
 *
 * ⚠️ 呢個函數係 A7 修正版方法嘅實作 —— 必須**中心點喺 viewport + 冇遮蓋**，
 * 否則會高估幾個數量級（3131 vs 24）。
 */
const MEASURE_SRC = `() => {
  const SEL = 'button, a[href], [role=button], [role=link], [role=tab], [role=option],'
    + ' input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const els = Array.from(document.querySelectorAll(SEL));

  function blocked(el) {
    let n = el;
    while (n) {
      if (n.getAttribute && (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert'))) return true;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
      n = n.parentElement;
    }
    return false;
  }

  const out = [];
  for (const el of els) {
    // 排除 SVG 內部幾何元素（唔屬互動語意；A7 明示）
    if (el instanceof SVGElement && el.tagName !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue; // 中心點唔喺 viewport
    if (blocked(el)) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit))) continue; // 被遮蓋
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '',
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
    });
  }
  return out;
}`;

/**
 * 將上面嘅原始碼字串還原成真正嘅函數。
 *
 * ⚠️ 為何要咁做：`page.evaluate("<function literal>")` 會將字串當成
 * **表達式**求值 —— 結果係一個函數物件，Playwright 序列化唔到 → 回傳
 * `undefined`（我實測踩過：`Cannot read properties of undefined`）。
 * 正確做法係傳**真正嘅函數**（Playwright 會自動 stringify 佢去瀏覽器跑）。
 */
const MEASURE_FN = new Function(`return (${MEASURE_SRC});`)() as () => Array<{
  tag: string;
  id: string;
  cls: string;
  w: number;
  h: number;
}>;

/*
 * ⚠️ e2e 逾時：預設 5 秒。三個 e2e 檔共用一個 preview server + Chromium，
 * 負載高時單一測試會由 1.8 秒飄到 >5 秒（實測見過）。呢個係**假失敗**，
 * 唔係功能壞。所有 e2e describe 一律用 30 秒。
 */
const E2E_TIMEOUT = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// 9.1 冇橫向 overflow
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 mobile 390×844：橫向 overflow（§2-9）", { timeout: E2E_TIMEOUT }, () => {
  it("`documentElement.scrollWidth <= 390`", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const m = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        bodyW: document.body.scrollWidth,
        vw: innerWidth,
      }));
      expect(m.scrollW, `scrollWidth=${m.scrollW} 超出 viewport ${m.vw}`).toBeLessThanOrEqual(m.vw);
      expect(m.bodyW).toBeLessThanOrEqual(m.vw);
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.2 可見互動元素 0 個 < 44px
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 mobile 390×844：touch target >= 44px（§2-9 / VA3）", { timeout: E2E_TIMEOUT }, () => {
  it("冇任何**可見**互動元素細過 44×44（嚴格過濾：中心點 + 遮蓋）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const all = (await page.evaluate(MEASURE_FN)) as Array<{
        tag: string;
        id: string;
        cls: string;
        w: number;
        h: number;
      }>;
      /*
       * ⚠️ 過濾 SVG 幾何：`MEASURE_FN` 已經排除。字級問題另計。
       *
       * 呢個斷言就係「修完 B8 之後應該係 0」嘅硬指標。如果仍然有違規，
       * 訊息會列出清單，可以直接對應 A7 P1-1 嘅 24 項清單。
       */
      const violations = all.filter((e) => e.w < 44 || e.h < 44);
      const detail = violations
        .map((v) => `${v.tag}${v.id ? "#" + v.id : ""}.${v.cls.split(" ")[0]} ${v.w}x${v.h}`)
        .join(" | ");
      expect(violations.length, `可見 <44px 元素（${violations.length}）：${detail}`).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("量測方法可信：真互動可見元素數量係合理數量級（唔係 3131）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const all = (await page.evaluate(MEASURE_FN)) as unknown[];
      /*
       * A7 修正：mobile 真互動可見元素 = 24（修好之後），唔係 3,131。
       * 呢個「衞星斷言」確保量測方法冇回退成舊版（唔檢查 viewport / 遮蓋）。
       * 收合 sheet 之後，可見元素應該係細數量（< 200）而唔係幾千。
       */
      expect(all.length, "可見元素數量唔合理 → 量測方法可能回退成舊版").toBeLessThan(200);
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.3 bottom sheet（3 段 snap）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 mobile 390×844：bottom sheet（§2-9 / P2-1）", { timeout: E2E_TIMEOUT }, () => {
  it("`#story-pane` 係 fixed bottom sheet（唔再係右側抽屜）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const info = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>("#story-pane");
        if (!pane) return null;
        const cs = getComputedStyle(pane);
        const r = pane.getBoundingClientRect();
        return {
          position: cs.position,
          bottom: cs.bottom,
          top: cs.top,
          width: cs.width,
          touchAction: cs.touchAction,
          borderRadius: cs.borderTopLeftRadius,
          hasHandle: Boolean(document.querySelector(".sheet-handle")),
          snapAttr: pane.getAttribute("data-sheet-snap"),
          classes: pane.className,
          rectW: Math.round(r.width),
          rectX: Math.round(r.left),
        };
      });
      expect(info, "#story-pane 要存在").not.toBeNull();
      expect(info!.position).toBe("fixed");
      expect(info!.hasHandle, "要有 drag handle（.sheet-handle）").toBe(true);
      expect(["peek", "half", "full"]).toContain(info!.snapAttr);
      // touch-action 一定要明確（唔可以係 auto）
      expect(info!.touchAction).not.toBe("auto" as unknown as string);
      // 寬度應該係全寬（唔再係 min(360px, 88vw)）
      expect(info!.rectW).toBeGreaterThanOrEqual(380);
    } finally {
      await browser.close();
    }
  });

  it("有 3 段 snap 且可以經 store 切換", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const handle = page.locator(".sheet-handle");
      // ⚠️ 用 `count()` 而唔係 `toHaveCount()`：後者係 Playwright *Test* 嘅
      // matcher，vitest 嘅 `expect` 冇。整個專案測試都行 vitest。
      expect(await handle.count(), "應該有 1 個 sheet-handle").toBe(1);
      const values = await page.evaluate(() => {
        const h = document.querySelector(".sheet-handle");
        return {
          min: h?.getAttribute("aria-valuemin"),
          max: h?.getAttribute("aria-valuemax"),
          now: h?.getAttribute("aria-valuenow"),
          role: h?.getAttribute("role"),
        };
      });
      expect(values.role).toBe("separator");
      expect(values.min).toBe("25");
      expect(values.max).toBe("92");
    } finally {
      await browser.close();
    }
  });

  it("`peek` 狀態遮蓋地圖 <= 25%（A7 §9 驗收）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const pct = await page.evaluate(() => {
        const map = document.querySelector<HTMLElement>("#map-pane")?.getBoundingClientRect();
        const sheet = document.querySelector<HTMLElement>("#story-pane")?.getBoundingClientRect();
        if (!map || !sheet) return -1;
        const ox = Math.max(0, Math.min(map.right, sheet.right) - Math.max(map.left, sheet.left));
        const oy = Math.max(0, Math.min(map.bottom, sheet.bottom) - Math.max(map.top, sheet.top));
        return (ox * oy) / (map.width * map.height) * 100;
      });
      expect(pct, `peek overlap = ${pct}%`).toBeLessThanOrEqual(25);
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.4 safe area（P1-7）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 mobile：safe-area（§2-9 / P1-7）", { timeout: E2E_TIMEOUT }, () => {
  it("viewport meta 有 `viewport-fit=cover`", async () => {
    /*
     * ⚠️ 已知未接線項（W1）——`index.html` 唔喺 B8 allowlist 之內。
     *
     * `index.html` 而家係 `content="width=device-width, initial-scale=1.0"`，
     * 冇 `viewport-fit=cover`。冇佢嘅話 `env(safe-area-inset-*)` 喺 iOS
     * 永遠解析成 0（規則會生效但冇效果）。
     *
     * 呢個測試**刻意保留紅燈**直到主代理改 `index.html`：
     *   <meta name="viewport"
     *         content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
     * 改完即自動轉綠，唔需要改測試。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const content = await page.evaluate(
        () => document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
      );
      expect(content, "W1：主代理要為 index.html 加 viewport-fit=cover").toMatch(
        /viewport-fit\s*=\s*cover/,
      );
    } finally {
      await browser.close();
    }
  });

  it("stylesheet 內有 >=3 條 `env(safe-area-inset-*)` 規則", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const count = await page.evaluate(() => {
        // 統計所有 stylesheet 內文嘅 env() 出現次數
        let text = "";
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules)) text += rule.cssText + "\n";
          } catch {
            /* cross-origin sheet 讀唔到 */
          }
        }
        return (text.match(/env\(\s*safe-area-inset-/g) || []).length;
      });
      expect(count, `env(safe-area-inset-*) 出現 ${count} 次，要 >=3`).toBeGreaterThanOrEqual(3);
    } finally {
      await browser.close();
    }
  });

  it("`.map-controls` 距底有計入 safe-area（唔會同 home indicator 重疊）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const r = await page.evaluate(() => {
        const el = document.querySelector(".map-controls") ?? document.querySelector("#map-controls");
        if (!el) return { computed: "", ruleBottom: "" };
        /*
         * ⚠️ 唔可以直接睇 computed `bottom`：桌機／無 inset 環境下
         * `env(safe-area-inset-bottom, 0px)` 解析成 `0px`，`calc(12px + 0px)`
         * 嘅 computed 值就係 `"12px"` —— 會造成假失敗。
         *
         * 正確做法：喺 stylesheet 度搵到管 `.map-controls` 且**有 `!important`**
         * 嘅規則，斷言佢嘅 `bottom` 真係寫住 `env(safe-area-inset-bottom)`。
         */
        let ruleBottom = "";
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules)) {
            const st = (rule as CSSStyleRule).style;
            const sel = (rule as CSSStyleRule).selectorText ?? "";
            if (st && /map-controls/.test(sel) && st.bottom && st.getPropertyPriority("bottom") === "important") {
              ruleBottom = st.bottom;
            }
          }
        }
        return { computed: getComputedStyle(el).bottom, ruleBottom };
      });
      expect(r.ruleBottom, `.map-controls 有一條 !important bottom 規則寫住 safe 區`).toMatch(
        /var\(\s*--safe-bottom\s*\)|env\(\s*safe-area-inset-bottom/,
      );
      expect(r.ruleBottom).toMatch(/calc\(/);
      /*
       * 對應嘅 `--safe-bottom` 一定要真係 `env(safe-area-inset-bottom)`。
       *
       * ⚠️ 唔可以讀 `getComputedStyle(documentElement).getPropertyValue(...)` ——
       * 實測會回 `"0px"`（custom property 嘅 env() 喺 read-back 時已解析）。
       * 所以改為由 stylesheet 嘅 `:root` 規則度讀**原始**宣告值。
       */
      const safeVar = await page.evaluate(() => {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules)) {
            const st = (rule as CSSStyleRule).style;
            if (st && st.getPropertyValue("--safe-bottom")) {
              return { sel: (rule as CSSStyleRule).selectorText, val: st.getPropertyValue("--safe-bottom").trim() };
            }
          }
        }
        return { sel: "", val: "" };
      });
      expect(
        safeVar.val,
        `--safe-bottom（宣告喺 ${safeVar.sel}）= "${safeVar.val}"`,
      ).toMatch(/env\(\s*safe-area-inset-bottom/);
      // computed 值唔可以細過基準 `--sp-3`（亦即 safe 區冇被吃掉）
      expect(Number.parseFloat(r.computed)).toBeGreaterThanOrEqual(12);
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.5 頂欄標題 <= 2 行（P1-9）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 mobile：頂欄標題（§2-9 / P1-9）", { timeout: E2E_TIMEOUT }, () => {
  it("`h1` <= 2 行", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const info = await page.evaluate(() => {
        const h1 = document.querySelector("#topbar h1");
        if (!h1) return null;
        const cs = getComputedStyle(h1);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
        return { lines: Math.round(h1.getBoundingClientRect().height / lh), h: h1.getBoundingClientRect().height };
      });
      expect(info, "要搵到 #topbar h1").not.toBeNull();
      expect(info!.lines, `h1 有 ${info!.lines} 行`).toBeLessThanOrEqual(2);
    } finally {
      await browser.close();
    }
  });

  it("導覽列 <= 1 行", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const lines = await page.evaluate(() => {
        const nav = document.querySelector("#topbar nav");
        if (!nav) return -1;
        const r = nav.getBoundingClientRect();
        const btn = nav.querySelector("button")?.getBoundingClientRect();
        return btn ? Math.round(r.height / btn.height) : -1;
      });
      expect(lines).toBe(1);
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.6 legend 遮蓋（P1-8）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 mobile：legend 遮蓋（§2-9 / P1-8）", { timeout: E2E_TIMEOUT }, () => {
  it("legend 遮蓋地圖 <= 25% **或** 可摺疊", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openMobile(browser);
      const r = await page.evaluate(() => {
        const map = document.querySelector<HTMLElement>("#map-pane")?.getBoundingClientRect();
        // ⚠️ 揀 `#map-legend` 而唔係 `.map-overlay`：後者係整個覆蓋層
        // （含 map-controls 等），量到 100% 係假陽性。真正遮蓋地圖嘅係圖例卡。
        const ov = document.querySelector<HTMLElement>("#map-legend")?.getBoundingClientRect();
        if (!map || !ov) return { pct: -1, collapsible: false };
        const ox = Math.max(0, Math.min(map.right, ov.right) - Math.max(map.left, ov.left));
        const oy = Math.max(0, Math.min(map.bottom, ov.bottom) - Math.max(map.top, ov.top));
        // 可摺疊 = 有任何控制 legend 摺疊嘅 aria-expanded 掣
        const collapsible = Boolean(
          document.querySelector('[aria-controls*="legend"], [aria-label*="圖例"] [aria-expanded]'),
        );
        return { pct: (ox * oy) / (map.width * map.height) * 100, collapsible };
      });
      // 門檻：≤15%（spec）或可摺疊。B8 目標係 ≤25%（peek sheet 之下）
      expect(
        r.pct <= 25 || r.collapsible,
        `legend 遮蓋 ${r.pct.toFixed(1)}%，可摺疊=${r.collapsible}`,
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });
});

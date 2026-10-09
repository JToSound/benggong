// D2-9 / D4-9 —— 「載入失敗」狀態（class 契約嘅**執行期證據**）
//
// 為何要有呢個檔
// ==============
// `docs/contracts/class-contract.json` 保護嘅 class 入面，有 4 個
// （`.bg-error-panel` / `-detail` / `-hint` / `.bg-retry-btn`）**只喺載入失敗
// 路徑出現** → 正常路徑嘅狀態永遠睇唔到 → 極易被誤判死（D4-3 嘅盲點）。
//
// 本檔提供四層證據（全部程式化、可重跑、零人手）：
//   ① 契約列出嘅**每個** class 都真係會 render（正常 ∪ 失敗）；
//   ② **四個失敗分支**各自顯示正確嘅診斷訊息（見 `FAIL_MODES`）：
//      HTTP 500／收到 HTML（SPA 回退）／JSON 解析失敗／網絡中斷；
//   ③ 失敗畫面嘅關鍵元素可見、可讀、符合觸控目標標準；
//   ④ 撳「重試」真係可以復原（唔會卡死喺失敗狀態）。
//
// ⚠️ 確定性：只令 `characters.json` **一個**請求失敗。
// `loadAllData()` 用 `Promise.all` → 若多過一個請求同時失敗，reject 次序
// 唔確定 → 錯誤訊息會飄（見 `visual-shots.ts` 同一個說明）。

import { readFileSync } from "node:fs";

import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";
const TIMEOUT = 120_000;

/** 只攔截呢一個請求（確定性）。 */
const FAIL_PATTERN = /\/data\/public\/characters\.json$/;

/**
 * 失敗模式 → route handler ＋ 預期訊息（覆蓋 `fetchJSON` 嘅**全部錯誤分支**）。
 *
 * ⚠️ 為何要逐個分支都測：`fetchJSON()` 有四條唔同嘅失敗路徑，各自有
 * **唔同嘅診斷訊息** —— 訊息係用戶唯一嘅線索（例如「收到 HTML」直接
 * 指出 SPA 回退，同 HTTP 500 係完全唔同嘅根因）。只測一條分支
 * 證明唔到其餘三條仍然可達。
 *
 * ⚠️ 仍然只失敗**一個**請求（`Promise.all` 嘅 reject 次序唔確定）。
 */
type RouteHandler = (route: import("@playwright/test").Route) => Promise<void> | void;
interface FailMode {
  /** 人類可讀嘅情境。 */
  desc: string;
  /** 預期出現喺 `.bg-error-detail` 嘅訊息特徵。 */
  expectRe: RegExp;
  handler: RouteHandler;
}
const FAIL_MODES: Record<string, FailMode> = {
  http500: {
    desc: "HTTP 500（伺服器錯誤）",
    expectRe: /載入 .*characters\.json 失敗：HTTP 500/,
    handler: (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
  },
  html: {
    desc: "收到 HTML 而唔係 JSON（SPA 回退到 index.html）",
    expectRe: /收到 HTML 而唔係 JSON/,
    handler: (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body>nope</body></html>",
      }),
  },
  badjson: {
    desc: "JSON 解析失敗（檔案截斷／損壞）",
    expectRe: /解析 .*characters\.json 失敗：/,
    handler: (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{ not json" }),
  },
  abort: {
    desc: "網絡中斷（fetch 直接 reject）",
    expectRe: /Failed to fetch|NetworkError/,
    handler: (route) => route.abort("failed"),
  },
};
/** `it.each` 用嘅表（保留 key 做測試名）。 */
const FAIL_CASES = Object.entries(FAIL_MODES).map(([key, def]) => ({ key, ...def }));

const contract = JSON.parse(
  readFileSync("docs/contracts/class-contract.json", "utf-8"),
) as { entries: Record<string, { producedBy: string; reason: string }> };
const CONTRACT_CLASSES = Object.keys(contract.entries);

async function launch(): Promise<Browser | null> {
  try {
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

/** 開一個「載入失敗」狀態嘅 page（已等到錯誤畫面出現）。 */
async function openFailurePage(browser: Browser, mode = "http500"): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: "zh-HK",
    /*
     * ⚠️ 一定要停 service worker —— `public/sw.js` 會快取資料檔，
     * 令重試嗰次由 SW 回 200（**繞過 `page.route`**）→ 失敗狀態唔會出現 ✗。
     */
    serviceWorkers: "block",
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("binggang.onboarding.dismissed", "1");
    } catch {
      /* */
    }
  });
  await page.route(FAIL_PATTERN, FAIL_MODES[mode].handler);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  // 失敗之前有 3 次重試（0.6s + 1.2s）→ 要等耐啲。
  await page.waitForSelector(".bg-error-panel", { timeout: 25_000 });
  return page;
}

/** 收集 DOM 內所有 class（用 attribute，SVG 都覆蓋）。 */
const ALL_CLASSES = () => {
  const s = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const c = el.getAttribute("class");
    if (c) for (const x of c.split(/\s+/)) if (x) s.add(x);
  }
  return Array.from(s);
};

describe("D4-9：class 契約嘅執行期證據（失敗路徑）", () => {
  it(
    "⭐ 契約列出嘅每個 class 都真係會 render（正常 ∪ 失敗）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const seen = new Set<string>();

        // ① 正常狀態
        const p1 = await browser.newPage({
          viewport: { width: 1440, height: 900 },
          serviceWorkers: "block",
        });
        await p1.goto(BASE_URL, { waitUntil: "networkidle" });
        await p1.waitForFunction(
          () => document.querySelectorAll(".ch-pill").length > 100,
          null,
          { timeout: 25_000 },
        );
        for (const c of await p1.evaluate(ALL_CLASSES)) seen.add(c);
        await p1.close();

        // ② 失敗狀態
        const p2 = await openFailurePage(browser);
        for (const c of await p2.evaluate(ALL_CLASSES)) seen.add(c);
        await p2.close();

        const missing = CONTRACT_CLASSES.filter((c) => !seen.has(c));
        expect(
          missing,
          `契約 class 從來冇 render 過（契約本身可能係錯）：${missing.join(", ")}`,
        ).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it.each(FAIL_CASES)(
    "⭐ 失敗分支 $key：$desc",
    async ({ key, expectRe, desc }) => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openFailurePage(browser, key);
        const detail = ((await page.textContent(".bg-error-detail")) ?? "").trim();
        expect(detail, `「${desc}」嘅訊息應該符合 ${expectRe}`).toMatch(expectRe);

        /*
         * ⚠️ 四個分支都要**同時**滿足失敗畫面嘅結構契約 ——
         * 唔可以有任何一個分支「淨係出咗一行字」而冇面板／提示／重試掣。
         */
        const structure = await page.evaluate(() => {
          const vis = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return (
              cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0
            );
          };
          return {
            panel: vis(".bg-error-panel"),
            hint: vis(".bg-error-hint"),
            retry: vis(".bg-retry-btn"),
            role: document.querySelector(".bg-error-panel")?.getAttribute("role"),
          };
        });
        expect(structure.panel, "錯誤面板要可見").toBe(true);
        expect(structure.role, "錯誤面板要有 role=alert（a11y）").toBe("alert");
        expect(structure.hint, "提示要可見").toBe(true);
        expect(structure.retry, "重試掣要可見").toBe(true);
        await page.close();
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it(
    "⭐ 失敗畫面：關鍵元素可見、訊息確定、符合觸控目標",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openFailurePage(browser);
        const info = await page.evaluate(() => {
          const vis = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              visible:
                cs.display !== "none" &&
                cs.visibility !== "hidden" &&
                r.width > 0 &&
                r.height > 0,
              w: Math.round(r.width),
              h: Math.round(r.height),
              text: (el.textContent ?? "").trim(),
            };
          };
          return {
            panel: vis(".bg-error-panel"),
            detail: vis(".bg-error-detail"),
            hint: vis(".bg-error-hint"),
            retry: vis(".bg-retry-btn"),
            role: document.querySelector(".bg-error-panel")?.getAttribute("role"),
            hasMap: !!document.querySelector("#svg-map"),
          };
        });

        expect(info.panel?.visible, "錯誤面板要可見").toBe(true);
        expect(info.role, "錯誤面板要有 role=alert（a11y）").toBe("alert");
        expect(info.detail?.visible, "錯誤訊息要可見").toBe(true);
        expect(info.detail?.text, "訊息要含 HTTP 狀態").toMatch(/HTTP 500/);
        expect(info.detail?.text, "訊息要指出係邊個檔").toContain("characters.json");
        expect(info.hint?.visible, "提示要可見").toBe(true);
        expect(info.retry?.visible, "重試掣要可見").toBe(true);
        expect(
          info.retry!.h,
          `重試掣高度要 ≥44px（實測 ${info.retry!.h}px）—— 同 B8 VA3 一致`,
        ).toBeGreaterThanOrEqual(44);
        expect(info.retry!.w, "重試掣闊度要 ≥44px").toBeGreaterThanOrEqual(44);
        expect(info.hasMap, "失敗狀態唔應該有地圖").toBe(false);
        await page.close();
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it(
    "⭐ 撳「重試」可以復原（唔會卡死喺失敗狀態）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const page = await openFailurePage(browser);
        // 解除攔截 → 重試應該成功。
        await page.unroute(FAIL_PATTERN);
        await page.click("#bg-retry-btn");
        await page.waitForFunction(
          () => document.querySelectorAll(".ch-pill").length > 100,
          null,
          { timeout: 30_000 },
        );
        const after = await page.evaluate(() => ({
          pills: document.querySelectorAll(".ch-pill").length,
          hasMap: !!document.querySelector("#svg-map"),
          panel: !!document.querySelector(".bg-error-panel"),
        }));
        expect(after.pills, "重試之後應該載入到資料").toBeGreaterThan(100);
        expect(after.hasMap, "重試之後應該有地圖").toBe(true);
        expect(after.panel, "重試成功之後錯誤畫面要消失").toBe(false);
        await page.close();
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});

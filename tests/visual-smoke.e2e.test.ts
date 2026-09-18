// 《病港》視覺煙霧測試（Visual smoke test）
//
// 為何要有呢個檔案
// ================
// Phase J 第十二輪發現四個缺陷，**冇一個會令任何閘門變紅**：
//
//   1. 前端讀到 12 日前嘅舊資料（驗證器只檢查來源，唔檢查複本）
//   2. 硬編碼錨點蓋過已核實座標（前端邏輯正確，只係優先級錯）
//   3. `vite build` 靜默失敗（錯誤訊息被 tail 截走）
//   4. 地圖 SVG 溢出 viewport（冇測試量度實際渲染尺寸）
//
// 共通點：**自動化閘門綠燈，但成品係壞嘅**。
//
// 所以呢個測試**唔檢查程式碼邏輯**，而係檢查**實際渲染出嚟嘅成品**：
//   - 有冇 console error／失敗請求
//   - SVG 有冇超出 viewport（量實際尺寸）
//   - 地圖、標記、區域、路線有冇真正畫出嚟
//   - 前端讀到嘅資料同來源一唔一致
//
// 跑法：`npm test`（跟其他測試一齊跑）

import { chromium, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

const VIEWPORTS = [
  { w: 1280, h: 800 },
  { w: 1400, h: 900 },
  { w: 1920, h: 1080 },
];

async function launch(): Promise<Browser | null> {
  try {
    return await chromium.launch();
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

/** 收集頁面錯誤（console error + 失敗請求）。 */
function watch(page: Page): { errors: string[]; failed: string[] } {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("requestfailed", (r) =>
    failed.push(`${r.url()} :: ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  return { errors, failed };
}

describe("視覺煙霧測試", () => {
  it("地圖 SVG 喺任何 viewport 都唔會溢出（唔可以有黑邊或者被切）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      for (const vp of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
        await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
        await page.waitForTimeout(800);

        const m = await page.evaluate(() => {
          const svg = document.querySelector("#svg-map")!.getBoundingClientRect();
          return {
            bottom: Math.round(svg.bottom),
            top: Math.round(svg.top),
            h: Math.round(svg.height),
            vh: innerHeight,
            scrollH: document.documentElement.scrollHeight,
          };
        });

        // 底邊唔可以超出 viewport（容許 1 px 捨入）
        expect(
          m.bottom,
          `${vp.w}×${vp.h}：SVG 底邊 ${m.bottom} 超出 viewport ${m.vh}` +
            `（高度 ${m.h}）—— 典型成因係父層 height:auto，令 SVG 用內在長寬比定高`,
        ).toBeLessThanOrEqual(m.vh + 1);
        // 亦唔可以矮太多（會留黑邊）
        expect(
          m.bottom,
          `${vp.w}×${vp.h}：SVG 底邊 ${m.bottom} 距 viewport ${m.vh} 太遠（有黑邊）`,
        ).toBeGreaterThanOrEqual(m.vh - 4);
        // 頁面唔應該出現滾動
        expect(m.scrollH, `${vp.w}×${vp.h}：頁面有滾動`).toBeLessThanOrEqual(m.vh + 1);

        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("載入零 console error、零失敗請求", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const { errors, failed } = watch(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      // 唔可以有「初始化失敗」
      const body = await page.evaluate(() => document.body.innerText || "");
      expect(body, `頁面顯示初始化失敗：${body.slice(0, 200)}`).not.toContain(
        "初始化失敗",
      );

      expect(errors, `console error：\n${errors.join("\n")}`).toEqual([]);
      expect(failed, `失敗請求：\n${failed.join("\n")}`).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("前端讀到嘅資料同來源一致（防「驗證綠燈但成品係舊嘅」）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);

      // 由瀏覽器實際 fetch 一次，同磁碟上嘅來源比對
      const served = await page.evaluate(async () => {
        const r = await fetch("./data/public/asset-manifest.json");
        return await r.json();
      });
      const onDisk = JSON.parse(
        readFileSync("data/public/asset-manifest.json", "utf-8"),
      );
      expect(
        served.counts,
        "前端讀到嘅 asset-manifest 同 data/public/ 唔一致 —— 請跑 npm run sync-data",
      ).toEqual(onDisk.counts);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("章節跳轉後標記唔會過大（唔可以蓋住地圖）", async () => {
    /*
     * 為何要驗證呢個
     * --------------
     * 實測踩過：`flyToChapter` 喺動畫**之前**就 render，嗰時
     * `this.view` 仍然係舊值（全港 0.70），`viewScale` = 1 ——
     * 標記用咗「全港視圖」嘅尺寸畫。而 `animateViewBox` 只改 SVG
     * viewBox，唔會重建標記，所以動畫完之後冇人再更新。
     *
     * 結果：飛到第 150 章（span 0.0414°）之後，事件標記半徑
     * 0.008 user unit = **畫面寬度嘅 38.7%**，成個地圖被圓圈蓋住。
     *
     * 呢個係「有渲染但渲染錯」——一般「有冇元素」嘅測試捉唔到。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);

      for (const target of [60, 150, 198]) {
        const cur = await page.evaluate(() =>
          Number(document.querySelector("#strip-ch-num")?.textContent || 1),
        );
        for (let i = cur; i < target; i++) await page.keyboard.press("k");
        await page.waitForTimeout(1300);

        const worst = await page.evaluate(() => {
          const vb = document
            .querySelector("#svg-map")!
            .getAttribute("viewBox")!
            .split(/\s+/)
            .map(Number);
          const span = vb[2];
          let maxPct = 0;
          let who = "";
          const check = (sel: string, kind: string) => {
            document.querySelectorAll(sel).forEach((el) => {
              const r = Number(
                el.getAttribute("r") ||
                  el.querySelector("circle")?.getAttribute("r") ||
                  0,
              );
              if (r > 0 && (r * 2) / span > maxPct) {
                maxPct = (r * 2) / span;
                who = kind;
              }
            });
          };
          // ⚠️ 只檢查**標記**（event／cluster）。區域（zone）唔可以
          // 用同一個門檻 —— 區域係按**真實地理尺寸**畫（例如坑口大病窩
          // 半徑 800 m），視圖縮到 5.6 km 闊時佢佔 28.7% 係**正確**嘅，
          // 唔係 bug。標記就唔同：佢哋嘅半徑應該同縮放無關（屏幕尺寸
          // 恆定），所以過大就代表 markerR 冇生效。
          check(".event-marker", "event");
          check(".location-marker-cluster circle", "cluster");
          return { span, maxPct, who };
        });

        expect(
          worst.maxPct,
          `第 ${target} 章（span ${worst.span.toFixed(4)}°）：最大嘅 ${worst.who} ` +
            `圓形佔畫面寬度 ${(worst.maxPct * 100).toFixed(1)}% —— 標記半徑冇跟隨縮放`,
        ).toBeLessThan(0.25);
      }
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("區域有常駐標籤（唔止 tooltip）", async () => {
    /*
     * 為何：只有 tooltip 唔夠 —— 用戶要 hover 才知係咩區域，一眼睇唔到
     * 「邊度安全、邊度危險」。所以區域要喺畫面上夠大時顯示常駐標籤。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await page.waitForTimeout(1500);
      for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(900);

      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".zone-label")).map(
          (t) => t.textContent || "",
        ),
      );
      expect(labels.length, "放大之後應該有區域標籤").toBeGreaterThan(0);
      expect(labels.join(""), "標籤應該係區域名").toMatch(/倖存區|病窩|巢穴|據點/);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("窄螢幕：故事面板變抽屜，唔會霸住地圖", async () => {
    /*
     * 為何：原本完全冇 media query —— 1280px 以下嘅螢幕，380px 面板
     * 佔咗成個畫面三分之一，地圖剩返好窄。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      // 闊螢幕：面板內嵌，冇切換鈕
      const wide = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      await wide.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await wide.waitForTimeout(900);
      const w = await wide.evaluate(() => ({
        pane: document.querySelector("#story-pane")!.getBoundingClientRect().width,
        toggle: getComputedStyle(document.querySelector("#btn-toggle-panel")!).display,
        mapW: document.querySelector("#svg-map")!.getBoundingClientRect().width,
      }));
      expect(w.pane, "闊螢幕面板應該內嵌").toBeGreaterThan(300);
      expect(w.toggle, "闊螢幕唔需要切換鈕").toBe("none");
      await wide.close();

      // 窄螢幕：面板收起，地圖用盡闊度
      const narrow = await browser.newPage({ viewport: { width: 900, height: 700 } });
      await narrow.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await narrow.waitForTimeout(900);
      const n = await narrow.evaluate(() => ({
        collapsed: document
          .querySelector("#story-pane")!
          .classList.contains("is-collapsed"),
        toggle: getComputedStyle(document.querySelector("#btn-toggle-panel")!).display,
        mapW: document.querySelector("#svg-map")!.getBoundingClientRect().width,
        vw: innerWidth,
      }));
      expect(n.toggle, "窄螢幕應該有切換鈕").not.toBe("none");
      expect(n.collapsed, "窄螢幕預設應該收起面板").toBe(true);
      expect(
        n.mapW / n.vw,
        `窄螢幕地圖應該用盡闊度（實際 ${Math.round((n.mapW / n.vw) * 100)}%）`,
      ).toBeGreaterThan(0.9);
      await narrow.close();
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("`?` 開快捷鍵提示，`Esc` 關", async () => {
    /*
     * 為何要驗 Esc：實測踩過 —— Esc 原本只清地圖選擇，唔會關浮層，
     * 令開咗嘅提示按 Esc 冇反應。優先次序應該係「先關浮層，再清選擇」。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(900);

      await page.keyboard.press("?");
      await page.waitForTimeout(500);
      let st = await page.evaluate(() =>
        document.querySelector("#about-modal")?.classList.contains("open"),
      );
      expect(st, "按 ? 應該開提示").toBe(true);
      const kbd = await page.evaluate(
        () => document.querySelectorAll("#about-modal kbd").length,
      );
      expect(kbd, "提示應該列出快捷鍵").toBeGreaterThan(3);

      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      st = await page.evaluate(() =>
        document.querySelector("#about-modal")?.classList.contains("open"),
      );
      expect(st, "按 Esc 應該關提示").toBe(false);
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("地圖有真正渲染：標記、區域、事件", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);

      // 第 1 章：應該有標記同事件
      const ch1 = await page.evaluate(() => ({
        markers: document.querySelectorAll("[data-loc-id]").length,
        events: document.querySelectorAll(".event-marker").length,
      }));
      expect(ch1.markers, "第 1 章應該有地點標記").toBeGreaterThan(0);
      expect(ch1.events, "第 1 章應該有事件標記").toBeGreaterThan(0);

      // 去到第 198 章：應該有區域（倖存區／病窩）
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await page.waitForTimeout(1500);

      const ch198 = await page.evaluate(() => {
        const zones = Array.from(document.querySelectorAll(".zone-area"));
        return {
          chapter: document.querySelector("#strip-ch-num")?.textContent?.trim(),
          zones: zones.length,
          kinds: zones.map((z) => z.getAttribute("fill")),
          hasLegend: Boolean(document.querySelector(".area-survivor")),
        };
      });
      expect(ch198.chapter).toBe("198");
      expect(ch198.zones, "第 198 章應該有區域（倖存區／病窩）").toBeGreaterThan(0);
      // 安全區同危險區要用唔同顏色
      expect(
        new Set(ch198.kinds).size,
        `區域顏色應該有區分（安全 vs 危險），實際：${[...new Set(ch198.kinds)]}`,
      ).toBeGreaterThan(1);
      expect(ch198.hasLegend, "圖例應該有區域項").toBe(true);
    } finally {
      await browser.close();
    }
  }, 120_000);
});

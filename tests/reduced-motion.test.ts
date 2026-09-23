// 《病港》World Atlas V2 — B8 reduced-motion 雙層契約測試（A7 P1-6 / VA7）
//
// 為何要有呢個檔案
// ================
// A7 審計發現 reduced-motion **只做一半**：
//
//   CSS 層有效 ✅   `main.css:1107` / `base.css:170` 將 3,157 個 transition 歸零
//   JS 層無效 ❌    `reduce` 模式下 rAF `viewBox` 仍然有 **11 個相異值**、
//                  `#strip-track.scrollLeft` **57 個**，同 `no-preference`
//                  **完全一樣**（逐 frame 取樣 1.5 秒實測）
//
// 根因係兩處 JS 動畫繞過咗媒體查詢：
//   1. `SvgMap.animateViewBox()`（rAF 插值）
//   2. `scrollIntoView({ behavior: "smooth" })`（`ChapterStrip` / `ChronicleView`）
//
// spec §6 要求 **CSS + JS 雙層**；驗收（VA7 / C7）係
// 「以 `reducedMotion: 'reduce'` 開 context，斷言 rAF viewBox 值序列長度 ≤2」。
//
// 本檔做兩件事：
//   ① **靜態契約**（node）：斷言 `src/` 冇任何 JS 動畫繞過 `motion.ts`；
//   ② **實瀏覽器行為**（Playwright）：用 `reducedMotion: "reduce"` 開 context，
//      量度 `viewBox` / `scrollLeft` 嘅相異值數量 ≤2。
//
// 全部斷言程式化、可重跑、零人手。

import { chromium, type Browser } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const BASE_URL = "http://localhost:5174";

/**
 * 診斷用 step log（只在 `RM_DEBUG=1` 之下輸出）。
 *
 * 背景：全套測試中本檔 3 個瀏覽器測試卡死 90 秒，但單獨跑／跑全部 e2e 都過。
 * 要精確定位卡喺邊一步（launch / newContext / newPage / goto / evaluate）。
 * ⚠️ 定位完成之後應該移除或者保留（`RM_DEBUG` 未設時零輸出、零開銷）。
 */
const dbg = (msg: string): void => {
  if (process.env.RM_DEBUG) console.log(`[rm-debug] ${msg}`);
};

async function launch(): Promise<Browser | null> {
  try {
    // ⚠️ `--no-proxy-server`：沙箱／代理環境下 Chromium 會將 localhost 交畀代理。
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 靜態契約：src/ 冇 JS 動畫繞過 motion.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 列出 `src/` 之下所有 `.ts`。
 *
 * ⚠️ 唔可以用 `git ls-files` —— 佢只列**已追蹤**檔案，會漏咗 B1–B8 啲
 * 未 commit 嘅新檔（實測只搵到 17 個，實際 >40 個）。所以用檔案系統遞歸。
 */
function listSrcTs(dir = "src", acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) listSrcTs(p, acc);
    else if (entry.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

describe("B8 reduced-motion：靜態契約（JS 層唔可以繞過）", () => {
  const files = listSrcTs();

  it("搵到 src 之下嘅 TS 檔（前置檢查）", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("`scrollIntoView` 只准出現喺註解（唔可以有真正呼叫）", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      // 剝走註解（block + line）之後再搵
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      if (/\.scrollIntoView\s*\(/.test(code)) offenders.push(f);
    }
    expect(offenders, `呢啲檔仍然呼叫 scrollIntoView：${offenders.join(", ")}`).toEqual([]);
  });

  it("`requestAnimationFrame` 動畫一律經 motion.ts（例外：需求驅動嘅渲染／frame 合併）", () => {
    /*
     * 允許例外（全部經 B8 逐個核對，唔係「見到就放行」）：
     *   · `src/motion.ts` 自己 —— tween 核心，內建 reduced-motion 判斷。
     *   · `src/map/VectorBasemap.ts` —— canvas **需求驅動**重繪（`scheduleDraw()`），
     *     唔係「動效」而係「渲染」。A2 實測冇 GPU 空轉，屬正面發現。
     *   · `src/components/SvgMap.ts` —— `animateViewBox` 已查
     *     `prefersReducedMotion()`（見下面斷言）。
     *   · `src/map/map-camera.ts` —— `flyTo()` **第一行**就係
     *     `if (reduced || durMs <= 0) { apply(to); return }`；rAF 分支根本
     *     唔會喺 reduce 模式下執行（下面有靜態斷言把關）。
     *   · `src/map/MapViewport.ts` —— `queue()` 只係**同一 frame 內合併**
     *     多次 pan／zoom 通知，唔做插值（`immediate` 路徑會同步 `flush()`）。
     *     呢個係「避免重複渲染」，唔係「動畫」。
     */
    const allow = new Set([
      "src/motion.ts",
      "src/map/VectorBasemap.ts",
      "src/components/SvgMap.ts",
      "src/map/map-camera.ts",
      "src/map/MapViewport.ts",
    ]);
    const offenders: string[] = [];
    for (const f of files) {
      if (allow.has(f)) continue;
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      if (/requestAnimationFrame\s*\(/.test(code)) offenders.push(f);
    }
    expect(offenders, `呢啲檔自己開 rAF（要改為經 motion.ts）：${offenders.join(", ")}`).toEqual([]);
  });

  it("允許清單嘅 rAF 檔都有 reduced-motion 把關（唔可以係空頭承諾）", () => {
    // `map-camera.ts`：reduce → 同步套用終態，唔開 rAF。
    const cam = readFileSync("src/map/map-camera.ts", "utf8");
    expect(cam).toMatch(/if\s*\(\s*reduced\s*\|\|\s*durMs\s*<=\s*0\s*\)/);
    // `VectorBasemap`：需求驅動重繪。
    const basemap = readFileSync("src/map/VectorBasemap.ts", "utf8");
    expect(basemap).toMatch(/scheduleDraw/);
  });

  it("`SvgMap.animateViewBox` 有 reduced-motion 分支", () => {
    const src = readFileSync("src/components/SvgMap.ts", "utf8");
    expect(src).toMatch(/prefersReducedMotion\(\)/);
    // 同步跳終態（shell.setView(..., "set")）而非開 rAF
    expect(src).toMatch(/prefersReducedMotion\(\)\s*\|\|\s*durationMs\s*<=\s*0/);
  });

  it("`motion.ts` 係唯一 duration / easing 來源（冇其他檔硬寫 ms 動效）", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f === "src/motion.ts" || f === "src/theme-tokens.ts") continue;
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      // transition / animation 硬寫 ms（唔准）
      if (/(transition|animation)[^;]*\d{2,4}ms/.test(code)) offenders.push(f);
    }
    expect(offenders, `硬寫動效時長：${offenders.join(", ")}`).toEqual([]);
  });

  it("`bottomSheet` / `chapterStrip` 唔硬寫動效時長（用 DUR token）", () => {
    for (const f of ["src/components/BottomSheet.ts", "src/components/ChapterStrip.ts"]) {
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      expect(code, `${f} 唔應該硬寫 ms`).not.toMatch(/\b\d{2,4}\s*ms\b/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 行為契約：真瀏覽器 + reducedMotion: "reduce"
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 reduced-motion：實瀏覽器行為（VA7 / C7）", () => {
  it("reduce 模式下，改章唔會產生 rAF viewBox 插值序列（相異值 ≤2）", async () => {
    dbg("① launch 開始");
    const browser = await launch();
    dbg("① launch 完成");
    if (!browser) return;
    try {
      dbg("② newContext 開始");
      const ctx = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        reducedMotion: "reduce",
      });
      dbg("② newContext 完成");
      dbg("③ newPage 開始");
      const page = await ctx.newPage();
      dbg("③ newPage 完成");
      dbg("④ goto(networkidle) 開始");
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      dbg("④ goto 完成");
      await page.waitForTimeout(1500);
      dbg("⑤ evaluate 開始");

      const result = await page.evaluate(async () => {
        const svg = document.querySelector("#svg-map");
        const seen = new Set<string>();
        if (!svg) return { distinct: -1, reduced: false };
        // 逐 frame 取樣 1.2 秒
        const t0 = performance.now();
        while (performance.now() - t0 < 1200) {
          seen.add(svg.getAttribute("viewBox") ?? "");
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
        return {
          distinct: seen.size,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        };
      });

      expect(result.reduced, "context 應該係 reduce").toBe(true);
      expect(result.distinct, `viewBox 相異值應該 ≤2（實測 ${result.distinct}）`).toBeLessThanOrEqual(2);
      await ctx.close();
    } finally {
      await browser.close();
    }
    /*
     * ⚠️ 為何要明確 timeout（2026-09-23 修）
     * ------------------------------------
     * 本測試內容 = `goto(networkidle)` + `waitForTimeout(1500)` +
     * **逐 frame 取樣 1.2 秒** ≈ 3.5–4.5 秒。實測 3,922 ms。
     * Vitest 預設 timeout 係 **5,000 ms** —— 只差 1 秒，任何環境波動
     * （CPU 負載、冷啟動 Chromium）都會令佢逾時，屬**脆弱測試**。
     * 其他 e2e（`map-interaction` / `a11y-keyboard`）一直都有 `90_000`。
     */
  }, 90_000);

  it("reduce 模式下，章節條唔會做 smooth 捲動（scrollLeft 相異值 ≤2）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      // 跳去第 150 章（觸發捲動）
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>(".ch-pill").forEach((p) => {
          if (p.textContent?.trim() === "150") p.click();
        });
      });

      const result = await page.evaluate(async () => {
        const track = document.querySelector("#strip-track");
        const seen = new Set<number>();
        if (!track) return { distinct: -1, reduced: false };
        const t0 = performance.now();
        while (performance.now() - t0 < 1000) {
          seen.add(Math.round(track.scrollLeft));
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
        return {
          distinct: seen.size,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        };
      });

      expect(result.reduced).toBe(true);
      expect(result.distinct, `scrollLeft 相異值應該 ≤2（實測 ${result.distinct}）`).toBeLessThanOrEqual(2);
      await ctx.close();
    } finally {
      await browser.close();
    }
    // ⚠️ 同上面一樣：取樣 1.0 秒 + goto + 1500ms，實測 3,795 ms 貼近 5,000 ms 預設上限。
  }, 90_000);

  it("CSS 層仍然有效（transition-duration 歸零）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const ctx = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const dur = await page.evaluate(() => {
        const el = document.querySelector(".ch-pill");
        return el ? getComputedStyle(el).transitionDuration : "";
      });
      // 全域 kill 會令佢變成 0.01ms（雖然 CSS 層有效，但值唔會係 0）
      expect(/^(0s|0\.01ms|0\.00001s|1e-05s|1e-06s)$/.test(dur) || parseFloat(dur) < 0.001).toBe(true);
      await ctx.close();
    } finally {
      await browser.close();
    }
    // ⚠️ 同屬 e2e（開 Chromium + goto + 1200ms），統一加 timeout 保持穩健。
  }, 90_000);
});

// D 階段 5 —— 視覺回歸（真瀏覽器，逐像素比對 7 個 canonical 狀態）
//
// 為何要有呢個檔
// ==============
// V2 大改版（B1–B9）＋ 本輪 P1-6（story pane 改浮層）、P1-1（zone 圖騰）、
// D 階段 2（移除 46 條 `!important`）、D 階段 4（剪 31 個死 class）
// —— 全部係**視覺改動**，但一直**冇**視覺回歸保護 ✗。
//
// `tests/visual-smoke.e2e.test.ts` 驗嘅係**行為**（溢出、console error、
// 資料一致、PWA…），唔係「畫面變成點」。
//
// 確定性（⚠️ 最關鍵）
// ==================
// D 階段 4 實測：**同一份程式碼跑兩次，7 張有 6 張唔同** ✗ ——
// 根因係地圖 `flyTo` 係 JS 動畫，截圖截到中間狀態。
// 本檔用 `tests/helpers/visual-shots.ts` 嘅四重確定性措施
// （停動畫／等字體／等 `viewBox` 穩定／等 2 帧 rAF），
// **實測雜訊底線：全 7 張合計 7 個像素差、每通道差 1** ✓。
//
// 比對方式
// ========
// PNG 解碼／降採樣（50%）／逐像素比對**全部喺瀏覽器 canvas 內做**
// —— Node 側冇 PNG decoder，加依賴又要 CI 裝 ✗。
//
// 更新基線：
//   UPDATE_VISUAL_BASELINE=1 npx vitest run tests/visual-regression.e2e.test.ts
//
// ⚠️ 已知限制
// ==========
// · **基線係機器相關**（字體光柵化／DPR）→ 換機可能要重生基線。
// · CI（ubuntu-latest）冇裝 Playwright browser → 本檔會 skip ✓
//   （所以唔會喺 CI 假紅；但亦代表 CI 冇視覺守衛 ✗）。

import { readdirSync, statSync } from "node:fs";

import { chromium, type Browser } from "@playwright/test";
import { describe, expect, it } from "vitest";

import {
  comparePng,
  MAX_DELTA,
  MAX_DIFF_PCT,
  openShotPage,
  readBaseline,
  shoot,
  STATES,
  waitApp,
  writeBaseline,
  writeDiffArtifacts,
} from "./helpers/visual-shots";

const BASE_URL = "http://localhost:5174";
const TIMEOUT = 240_000;
const UPDATE = process.env.UPDATE_VISUAL_BASELINE === "1";

/** `dist/assets/` 內最新嘅 CSS 檔名（殘留 server 守衛用）。 */
function latestCssFile(): string {
  const dir = "dist/assets";
  const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
  // 只有一個 CSS bundle（Vite 會 hash）；有多個就取最新 mtime
  return files
    .map((f) => ({ f, m: statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0].f;
}

async function launch(): Promise<Browser | null> {
  try {
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

describe("D 階段 5：視覺回歸", () => {
  it(
    `⭐ ${STATES.length} 個 canonical 狀態逐像素比對（容忍 ≤${MAX_DIFF_PCT}% / Δ≤${MAX_DELTA}）`,
    async () => {
      const browser = await launch();
      if (!browser) return;
      const report: string[] = [];
      try {
        for (const st of STATES) {
          const page = await openShotPage(browser, st);
          try {
            await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
            await waitApp(page);

            /*
             * ⚠️ 殘留 server 守衛（雙重保險，2026-10-07）
             * ----------------------------------------
             * `e2e.global-setup.ts` 已經會核對「server 服務緊當前 dist/」，
             * 但呢度再驗一次：**頁面實際載入嘅 CSS 檔名**要等於
             * `dist/assets/` 內最新嗰個。
             * 冇呢層嘅話，萬一 setup 邏輯有漏洞，守衛會比對
             * 「舊 build vs 舊基線」→ **假綠** ✗✗（比假紅危險得多）。
             */
            const loadedCss = await page.evaluate(
              () =>
                document.querySelector('link[rel="stylesheet"]')?.getAttribute("href") ?? "",
            );
            expect(
              loadedCss,
              "頁面載入嘅 CSS 唔係 dist/ 最新嗰個 → 5174 有殘留舊 server ✗",
            ).toContain(latestCssFile());

            /*
             * ⚠️ 殘留 server 守衛（2026-10-07 實測踩過）
             * ----------------------------------------
             * `e2e.global-setup.ts` 會**沿用**已存在嘅 5174 server（只出 warning）。
             * 如果嗰個 server 係**改動之前**起嘅，佢可能服務舊 `dist/` →
             * 視覺守衛會**假綠**（比對「舊 build vs 舊基線」）✗。
             * 所以每次都核對：頁面載入嘅 CSS 檔名 = `dist/assets/` 內最新嗰個。
             */
            const href = await page.evaluate(
              () =>
                document.querySelector('link[rel="stylesheet"]')?.getAttribute("href") ?? "",
            );
            expect(
              href,
              "頁面載入嘅 CSS 唔係 dist/ 最新嗰個 → 5174 有**殘留舊 server** ✗\n" +
                "（跑視覺回歸之前一定要清 5174；見 README／本檔註解）",
            ).toContain(latestCssFile());
            if (st.act) {
              await st.act(page);
              await page.waitForTimeout(400);
            }
            const shot = await shoot(page);

            if (UPDATE) {
              await writeBaseline(page, st.name, shot);
              report.push(`  ♻️ ${st.name}：已更新基線`);
              continue;
            }

            const baseline = readBaseline(st.name);
            expect(
              baseline,
              `冇基線：tests/baselines/visual/${st.name}.png\n` +
                "（首次請跑 UPDATE_VISUAL_BASELINE=1 npx vitest run tests/visual-regression.e2e.test.ts）",
            ).not.toBeNull();

            const cur = `data:image/png;base64,${shot.toString("base64")}`;
            const r = await comparePng(page, baseline!, cur);
            // ⚠️ 一定要**喺斷言之前** push 落報告 —— 否則失敗時睇唔到尺寸／差異 ✗
            const line =
              `  ${r.diffPct <= MAX_DIFF_PCT && r.maxDelta <= MAX_DELTA ? "✅" : "❌"} ` +
              `${st.name}：差異 ${r.diffPct.toFixed(4)}%（${r.diffPixels}/${r.total} px）` +
              `｜最大 Δ ${r.maxDelta}｜尺寸 ${r.aSize} vs ${r.bSize}`;
            report.push(line);
            console.log(`[D5] ${line.trim()}`);
            const failed = r.diffPct > MAX_DIFF_PCT || r.maxDelta > MAX_DELTA;
            if (failed) {
              /*
               * D5-9：失敗時寫低診斷圖（baseline｜current｜差異熱圖）——
               * 冇嘅話淨係得「差異 X%」，唔知**邊度**變 ✗。
               */
              const files = await writeDiffArtifacts(page, st.name, baseline!, cur);
              console.log(`[D5] 🔍 診斷圖：${files.join("、")}`);
            }
            expect(
              r.diffPct,
              `${st.name} 有 ${r.diffPct.toFixed(4)}% 像素唔同（上限 ${MAX_DIFF_PCT}%）` +
                `｜診斷圖喺 artifacts/visual-diff/${st.name}-*.png`,
            ).toBeLessThanOrEqual(MAX_DIFF_PCT);
            expect(
              r.maxDelta,
              `${st.name} 最大通道差 Δ${r.maxDelta}（上限 ${MAX_DELTA}）` +
                `｜診斷圖喺 artifacts/visual-diff/${st.name}-*.png`,
            ).toBeLessThanOrEqual(MAX_DELTA);
          } finally {
            await page.close();
          }
        }
      } finally {
        await browser.close();
      }
      console.log(
        `\n[D5] 視覺回歸${UPDATE ? "（更新基線）" : ""}：\n${report.join("\n")}\n`,
      );
    },
    TIMEOUT,
  );
});

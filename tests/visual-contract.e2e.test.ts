// D2-9 —— 視覺契約快照守衛（**唔用像素**，用 computed style ＋ 幾何）
//
// 為何要有呢個檔
// ==============
// D 階段 5 已經有**像素**守衛（`visual-regression.e2e.test.ts`）。佢證明
// 「畫面一模一樣」，但係黑盒：失敗時只知「幾多像素差」，唔知**邊個屬性**變 ✗。
//
// 本檔用 `tests/helpers/style-snapshot.ts` 抽「關鍵元素嘅 computed style ＋
// 幾何」成 JSON 快照（`tests/baselines/style-contract.json`）→ 失敗時
// **逐個屬性**睇「邊個由 X 變 Y」✓。
//
// 覆蓋（D2-7 要求擴到嘅狀態）
// ==========================
// 直接沿用 `tests/helpers/visual-shots.ts` 嘅 `STATES`（**單一來源**）——
// 包括搜尋 overlay（`06`）、編年史（`05`／`09`）、dossier 展開
// （`04-desktop-zone-selected`）、淺色主題（`08`／`09`）、三種 viewport。
//
// 更新基線：
//   UPDATE_STYLE_BASELINE=1 npx vitest run tests/visual-contract.e2e.test.ts
//
// ⚠️ 已知限制（誠實記錄）
// ======================
// · 快照**係機器相關**（字體光柵化／DPR）→ 已用「容器為主 ＋ 幾何容差
//   ±2px ＋ 顏色正規化」降低敏感度，但換機仍可能要重生基線。
// · CI 冇 Playwright browser → 本檔 **skip**（同像素守衛一致）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { chromium, type Browser } from "@playwright/test";
import { describe, expect, it } from "vitest";

import {
  collectSnapshot,
  diffSnapshots,
  type StateSnapshot,
} from "./helpers/style-snapshot";
import { openShotPage, STATES, waitApp, waitStable } from "./helpers/visual-shots";

const BASE_URL = "http://localhost:5174";
const TIMEOUT = 240_000;
const BASELINE = "tests/baselines/style-contract.json";
const UPDATE = process.env.UPDATE_STYLE_BASELINE === "1";

async function launch(): Promise<Browser | null> {
  try {
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

/** 收集**所有** STATES 嘅快照（真瀏覽器）。 */
async function collectAll(): Promise<StateSnapshot[]> {
  const browser = await launch();
  if (!browser) return [];
  try {
    const out: StateSnapshot[] = [];
    for (const st of STATES) {
      const page = await openShotPage(browser, st);
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await waitApp(page);
      if (st.act) await st.act(page);
      await waitStable(page);
      out.push(
        await collectSnapshot(
          page,
          st.name,
          `${st.viewport.width}x${st.viewport.height}${st.theme ? `/${st.theme}` : ""}`,
        ),
      );
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

describe("D2-9：視覺契約快照（computed style ＋ 幾何）", () => {
  it(
    "⭐ 所有 canonical 狀態嘅樣式指紋同基線一致",
    async () => {
      const shots = await collectAll();
      if (shots.length === 0) return; // 冇 browser → skip（CI）

      if (UPDATE || !existsSync(BASELINE)) {
        mkdirSync(dirname(BASELINE), { recursive: true });
        writeFileSync(BASELINE, JSON.stringify(shots, null, 1) + "\n", "utf-8");
        console.log(
          `[style-contract] 已寫基線（${shots.length} 個狀態）→ ${BASELINE}`,
        );
        return;
      }

      const baseline = JSON.parse(
        readFileSync(BASELINE, "utf-8"),
      ) as StateSnapshot[];
      const byName = new Map(baseline.map((s) => [s.state, s]));

      const problems: string[] = [];
      for (const cur of shots) {
        const base = byName.get(cur.state);
        if (!base) {
          problems.push(`${cur.state}: 基線冇呢個狀態（新增狀態要重生基線）`);
          continue;
        }
        const { diffs } = diffSnapshots(base, cur);
        problems.push(...diffs);
      }

      expect(
        problems,
        "視覺契約快照有差異（逐個屬性）：\n" +
          problems.join("\n") +
          "\n（若係有意改動，用 UPDATE_STYLE_BASELINE=1 重生基線）",
      ).toEqual([]);
    },
    TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 關鍵不變式（即使重生基線都要守住嘅**語意**契約）
// ─────────────────────────────────────────────────────────────────────────────

describe("D2-9：關鍵樣式不變式（語意契約）", () => {
  it(
    "⭐ 首屏 `#map-pane` 面積 ≥70%（1440×900）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const st = STATES.find((s) => s.name === "01-desktop-default")!;
        const page = await openShotPage(browser, st);
        await page.goto(BASE_URL, { waitUntil: "networkidle" });
        await waitApp(page);
        await waitStable(page);
        const pct = await page.evaluate(() => {
          const r = document.querySelector("#map-pane")?.getBoundingClientRect();
          if (!r) return 0;
          return (100 * (r.width * r.height)) / (innerWidth * innerHeight);
        });
        expect(pct, `#map-pane 面積 ${pct.toFixed(1)}% 應該 ≥70%`).toBeGreaterThanOrEqual(70);
        await page.close();
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );

  it(
    "⭐ 淺色主題係獨立視覺路徑（`--bg-base` computed 值同深色唔同）",
    async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const read = async (theme: "dark" | "light") => {
          const st = STATES.find(
            (s) => s.name === (theme === "dark" ? "01-desktop-default" : "08-desktop-light-default"),
          )!;
          const page = await openShotPage(browser, st);
          await page.goto(BASE_URL, { waitUntil: "networkidle" });
          await waitApp(page);
          await waitStable(page);
          const v = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim(),
          );
          await page.close();
          return v;
        };
        const dark = await read("dark");
        const light = await read("light");
        expect(dark, "深色 --bg-base 應該有值").not.toBe("");
        expect(light, "淺色 --bg-base 應該有值").not.toBe("");
        expect(light, "淺色同深色嘅 --bg-base 應該唔同（否則主題冇切換）").not.toBe(dark);
      } finally {
        await browser.close();
      }
    },
    TIMEOUT,
  );
});

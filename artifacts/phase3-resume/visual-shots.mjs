/**
 * D 階段 5 探測：**確定性**截圖（視覺回歸用）。
 *
 * ⚠️ D5-10（2026-10-07）：狀態定義、等待、截圖邏輯嘅**唯一來源**係
 * `tests/helpers/visual-shots.ts`。本檔只做兩件事：
 *   1. 起 preview server（共用 `_probe-lib.mjs`，Windows 安全收檔）；
 *   2. 逐個 `STATES` 開 page → `goto` → `waitApp` → `act` → `shoot` → 寫檔。
 *
 * 之前本檔**自己抄咗一份** 7 個狀態同等待邏輯 → 同 helper（11 個狀態）
 * 唔一致（D5-10 要修嘅問題）。Node 22 可以直接 import `.ts`（type stripping），
 * 所以唔需要再抄。
 *
 * 用法：node artifacts/phase3-resume/visual-shots.mjs <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";
import { STATES, bootShotPage, shoot } from "../../tests/helpers/visual-shots.ts";

const outDir = process.argv[2] || "artifacts/phase3-resume/visual-shots";
mkdirSync(outDir, { recursive: true });

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });

let n = 0;
await withTeardown(browser, server, async () => {
  for (const st of STATES) {
    const page = await bootShotPage(browser, st, BASE);
    const buf = await shoot(page);
    writeFileSync(`${outDir}/${st.name}.png`, buf);
    n++;
    console.log(`  ${st.name}.png`);
    await page.close();
  }
});

console.log(`\n共 ${n} 張 → ${outDir}/（狀態來源：tests/helpers/visual-shots.ts）`);

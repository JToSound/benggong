// P1-6-8 / D5-10 —— 探測腳本收檔衛生契約（棘輪式）
//
// 為何要有呢個檔
// ==============
// ⚠️ `process.kill(-pid)` 喺 Windows **冇效**（專案 MEMORY E18）→ 探測腳本
// 會殘留 `vite preview`，佔住 5174 → 之後嘅 e2e／視覺守衛連去**舊 build**
// → 比對「舊 vs 舊」→ **假綠**（比假紅危險）。
//
// 正確做法係 `artifacts/phase3-resume/_probe-lib.mjs` 嘅
// `stopPreviewServer()`（Windows 用 `taskkill /PID /T /F`）。
//
// ⚠️ 為何用「棘輪（ratchet）」而唔係一刀切
// --------------------------------------
// 仍有 ~18 個歷史探測腳本用舊模式。一次過全改風險高、又同今次目標無關。
// 棘輪嘅意思：
//   · 已知遺留 → 列喺 `LEGACY` 清單（容忍）；
//   · **唔可以再加新嘅**（新檔一用舊模式就變紅）；
//   · 已遷移嘅自然離開清單（子集檢查容忍）。
//
// ⚠️ 檢查前一定要**剝走 `/* */` 註解** —— 否則「解釋為何唔用
// `process.kill(-pid)`」嘅註解本身會被當成違規（實測踩過：
// `probe-map-pane-area.mjs` 嘅檔頭註解就係咁）。

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "artifacts/phase3-resume";
const LIB = `${DIR}/_probe-lib.mjs`;

/** 剝走區塊註解（保留其餘內容；唔處理行註解以免誤中 URL）。 */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 已知仍用 `process.kill(-pid)` 嘅歷史腳本（唔可以再加新嘅）。 */
const LEGACY = new Set<string>([
  "probe-canvas-churn.mjs",
  "probe-chronicle-width.mjs",
  "probe-colocated-clickable.mjs",
  "probe-css-important.mjs",
  "probe-d5-diag.mjs",
  "probe-dossier-wiring.mjs",
  "probe-firstload-payload.mjs",
  "probe-layer-sync.mjs",
  "probe-marker-collapse.mjs",
  "probe-memory.mjs",
  "probe-mobile-sheet.mjs",
  "probe-p12.mjs",
  "probe-panel-autopen.mjs",
  "probe-pulse-drift.mjs",
  "probe-tile-404.mjs",
  "probe-zone-crowding.mjs",
  "probe-zone-flyto.mjs",
  "profile-coldzoom.mjs",
]);

const BROKEN = /process\.kill\(\s*-/;

describe("P1-6-8：探測腳本收檔衛生（棘輪）", () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".mjs") && f !== "_probe-lib.mjs")
    .sort();

  it("⭐ 冇新腳本用 `process.kill(-pid)`（Windows 冇效）", () => {
    const offenders = files.filter((f) =>
      BROKEN.test(stripBlockComments(readFileSync(`${DIR}/${f}`, "utf-8"))),
    );
    const newOnes = offenders.filter((f) => !LEGACY.has(f));
    expect(
      newOnes,
      "以下探測腳本用咗 `process.kill(-pid)`（Windows 冇效，會殘留 server）—— " +
        "請改用 `_probe-lib.mjs` 嘅 `withTeardown()`：\n" +
        newOnes.join("\n"),
    ).toEqual([]);
  });

  it("`_probe-lib.mjs` 存在並提供 Windows 安全嘅收檔", () => {
    const lib = readFileSync(LIB, "utf-8");
    expect(lib).toMatch(/export async function ensurePreviewServer/);
    expect(lib).toMatch(/export function stopPreviewServer/);
    expect(lib).toMatch(/export async function withTeardown/);
    // Windows 一定要用 taskkill（`/T` 連子孫）
    expect(lib, "要喺 win32 用 taskkill /T /F").toMatch(/taskkill/);
  });

  it("已遷移嘅關鍵探測腳本都經 `_probe-lib.mjs` 收檔", () => {
    for (const f of [
      "visual-shots.mjs",
      "probe-map-pane-area.mjs",
      "probe-css-order.mjs",
      "probe-dead-css.mjs",
      "probe-dead-css-shots.mjs",
      "probe-style-contract.mjs",
    ]) {
      const src = readFileSync(`${DIR}/${f}`, "utf-8");
      expect(src, `${f} 應該 import _probe-lib.mjs`).toMatch(/_probe-lib\.mjs/);
      expect(src, `${f} 唔應該再自己寫 server bootstrap`).not.toMatch(
        /spawn\(\s*"npx"/,
      );
    }
  });

  it("D5-10：`visual-shots.mjs` 由 TS helper 讀狀態（唯一來源）", () => {
    const src = readFileSync(`${DIR}/visual-shots.mjs`, "utf-8");
    expect(src, "狀態要由 tests/helpers/visual-shots.ts 提供").toMatch(
      /tests\/helpers\/visual-shots\.ts/,
    );
    expect(src, "唔應該自己再抄一份 STATES").not.toMatch(/name:\s*"\d\d-/);
  });
});

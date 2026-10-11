// P1-6-8 / D5-10 —— 探測腳本收檔衛生契約
//
// 為何要有呢個檔
// ==============
// ⚠️ `process.kill(-pid)` 喺 Windows **冇效**（專案 MEMORY E18）→ 探測腳本
// 會殘留 `vite preview`，佔住 5174 → 之後嘅 e2e／視覺守衛連去**舊 build**
// → 比對「舊 vs 舊」→ **假綠**（比假紅危險）。
//
// 正確做法係 `artifacts/phase3-resume/_probe-lib.mjs` 嘅
// `withTeardown()`（Windows 用 `taskkill /PID /T /F`）。
//
// ⚠️ 由「棘輪」升級為「**零容忍**」（2026-10-11）
// --------------------------------------------
// 原本仍有 18 個歷史腳本用舊模式，所以用棘輪（列 `LEGACY` 容忍、
// 只禁止新增）。2026-10-11 已**全部遷移** → 清單清空 → 改成硬性斷言：
// **任何** `.mjs` 都唔准再用 `process.kill(-pid)`。
//
// ⚠️ 檢查前一定要**剝走區塊註解** —— 否則「解釋為何唔用
// `process.kill(-pid)`」嘅註解本身會被當成違規（實測踩過：
// `probe-map-pane-area.mjs` 嘅檔頭註解就係咁）。

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "artifacts/phase3-resume";
const LIB = `${DIR}/_probe-lib.mjs`;

/**
 * 豁免：自己起**帶 COOP/COEP header 嘅靜態伺服器**（唔係 `vite preview`，
 * 亦唔用 5174）—— 因為 `measureUserAgentSpecificMemory()` 需要
 * cross-origin isolated 環境。佢冇 `spawn`、冇 `process.kill`。
 */
const EXEMPT = new Set<string>(["probe-native-memory.mjs"]);

/** 剝走區塊註解（保留其餘內容；唔處理行註解以免誤中 URL）。 */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".mjs") && f !== "_probe-lib.mjs")
  .sort();

/** 未剝註解嘅原文（用嚟檢查 import）。 */
const raw = (f: string) => readFileSync(`${DIR}/${f}`, "utf-8");
/** 已剝註解嘅原文（用嚟檢查代碼）。 */
const code = (f: string) => stripBlockComments(raw(f));

describe("P1-6-8：探測腳本收檔衛生（零容忍）", () => {
  it("⭐ 冇任何腳本用 `process.kill(-pid)`（Windows 冇效）", () => {
    const offenders = files.filter((f) => /process\.kill\(\s*-/.test(code(f)));
    expect(
      offenders,
      "以下探測腳本用咗 `process.kill(-pid)`（Windows 冇效，會殘留 server）—— " +
        "請改用 `_probe-lib.mjs` 嘅 `withTeardown()`：\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("⭐ 所有腳本都經 `_probe-lib.mjs` 收檔（唯一豁免：自帶 COOP/COEP server）", () => {
    const missing = files
      .filter((f) => !EXEMPT.has(f))
      .filter((f) => !raw(f).includes("_probe-lib.mjs"));
    expect(
      missing,
      "以下腳本冇用 `_probe-lib.mjs`（會自己抄一份 bootstrap → 收檔行為唔一致）：\n" +
        missing.join("\n"),
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

  it("用咗 `withTeardown` 嘅腳本唔應該再自己寫 server bootstrap", () => {
    const offenders = files.filter((f) => /spawn\(\s*"npx"/.test(code(f)));
    expect(offenders, `以下腳本仍然自己 spawn npx：${offenders.join(", ")}`).toEqual([]);
  });

  it("D5-10：`visual-shots.mjs` 由 TS helper 讀狀態（唯一來源）", () => {
    const src = raw("visual-shots.mjs");
    expect(src, "狀態要由 tests/helpers/visual-shots.ts 提供").toMatch(
      /tests\/helpers\/visual-shots\.ts/,
    );
    expect(src, "唔應該自己再抄一份 STATES").not.toMatch(/name:\s*"\d\d-/);
  });

  it("D4-1：`probe-dead-css.mjs` 由 `STATES` 讀狀態（唔可以自己抄一份）", () => {
    /*
     * ⚠️ 為何一定要守住：本檔係「執行期判準（C）」嘅唯一來源。
     * 佢之前寫死 7 個狀態 → 新增「載入失敗」狀態之後自動漏咗 ——
     * 而嗰個狀態正正含 `class-contract.json` 保護嘅 `.bg-error-panel`
     * 等 class → 會令契約 class 被誤判死 ✗。
     */
    const src = raw("probe-dead-css.mjs");
    expect(src, "狀態要由 tests/helpers/visual-shots.ts 提供").toMatch(
      /tests\/helpers\/visual-shots\.ts/,
    );
    expect(src, "要用 bootShotPage（共用開頁程序）").toMatch(/bootShotPage/);
    expect(src, "唔應該自己寫死狀態名").not.toMatch(/"(desktop|mobile)-[a-z0-9-]+"/);
  });
});

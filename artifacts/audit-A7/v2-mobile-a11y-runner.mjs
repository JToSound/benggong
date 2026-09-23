/**
 * World Atlas V2 —— A7 Mobile / A11y 驗收 runner（獨立，唔需要 vitest）
 * ============================================================================
 * 對應 spec §7.2 第 9、10、11 項。斷言定義喺 `v2-checks.mjs`（同 vitest spec 共用）。
 *
 * 跑法：
 *   node artifacts/audit-A7/v2-mobile-a11y-runner.mjs
 *   BASE_URL=http://localhost:5180/ node artifacts/audit-A7/v2-mobile-a11y-runner.mjs
 *
 * 輸出：
 *   - console PASS/FAIL 矩陣
 *   - artifacts/audit-A7/v2-mobile-a11y-result.json（機讀）
 *
 * 註：呢個 runner 對**現行 production 版本**跑，預期大量 FAIL —— 佢係 V2 嘅
 *     驗收標準，唔係現狀描述。B8（Mobile + A11y）完成後應該全綠。
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { BASE, runAll } from "./v2-checks.mjs";

const OUT = "artifacts/audit-A7";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const results = await runAll(browser);
await browser.close();

const passed = results.filter((r) => r.pass).length;
const summary = {
  baseUrl: BASE,
  ranAt: new Date().toISOString(),
  total: results.length,
  passed,
  failed: results.length - passed,
  results,
};
fs.writeFileSync(path.join(OUT, "v2-mobile-a11y-result.json"), JSON.stringify(summary, null, 2));

const W = 78;
console.log("\n" + "═".repeat(W));
console.log("World Atlas V2 — A7 Mobile / A11y 驗收（spec §7.2 第 9/10/11 項）");
console.log("BASE_URL:", BASE);
console.log("═".repeat(W));
for (const g of ["9-mobile", "10-keyboard", "11-network"]) {
  console.log("\n── " + g + " ──");
  for (const r of results.filter((x) => x.group === g)) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(5)} ${r.desc}`);
    if (!r.pass) console.log(`         └─ ${String(r.detail).slice(0, 220)}`);
  }
}
console.log("\n" + "═".repeat(W));
console.log(`總計：${passed}/${results.length} PASS，${results.length - passed} FAIL`);
console.log("═".repeat(W) + "\n");

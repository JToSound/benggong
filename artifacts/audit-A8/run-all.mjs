/**
 * A8 — 一鍵重跑全部量測（可重跑、確定性）
 *
 * 需要 preview server 已經喺 http://localhost:5180/ 運行：
 *   npx vite preview --port 5180
 *
 * 執行：node artifacts/audit-A8/run-all.mjs
 */

import { spawnSync } from "node:child_process";

const SCRIPTS = [
  "measure-bundle.mjs",
  "measure-json-parse.mjs",
  "measure-algorithms.mjs",
  "measure-load-timeline.mjs",
  "measure-runtime.mjs",
  "measure-jank.mjs",
];

for (const s of SCRIPTS) {
  console.log(`\n########## ${s} ##########`);
  const r = spawnSync(process.execPath, [`artifacts/audit-A8/${s}`], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${s} 失敗（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
}

console.log("\n########## verify-budget.mjs ##########");
const v = spawnSync(process.execPath, ["artifacts/audit-A8/verify-budget.mjs"], { stdio: "inherit" });
process.exit(v.status ?? 1);

/**
 * D 階段 4 工具：執行期收集「實際出現過嘅 class 名」（第三重判準）。
 *
 * 為何要有
 * ========
 * 靜態分析（`scripts/audit_dead_css.py`）只可以證明「語料內冇字面引用」，
 * 但 class 可能由**執行期**拼出（例如由資料驅動）。所以要用真瀏覽器
 * 行多個 app 狀態，收集 `document.querySelectorAll("*")` 嘅 class 集合 ——
 * 有出現過就唔係死。
 *
 * ⚠️ 呢個係**抽樣**（唔可能窮舉所有狀態）→ 只可以否證「死」，
 *    唔可以單憑佢判定「死」。所以三重判準缺一不可。
 *
 * ⚠️ P1-6-8（2026-10-07）：收檔改用 `_probe-lib.mjs`（Windows 安全）。
 *
 * ⚠️ 2026-10-10（D4-1 教訓）：**狀態清單唔可以自己抄一份**。
 * 原本本檔寫死 7 個狀態 → 新增「載入失敗」狀態之後就**自動漏咗**
 * —— 而嗰個狀態正正含 `docs/contracts/class-contract.json` 保護嘅
 * `.bg-error-panel` 等 class → 會令契約 class 被誤判死 ✗。
 * 現在直接讀 `tests/helpers/visual-shots.ts` 嘅 `STATES`（唯一來源）
 * ＋ `bootShotPage()`（共用開頁程序）→ 狀態數自動跟（現時 **12** 個，
 * 包括 `12-desktop-load-failure`）。
 *
 * 用法：node artifacts/phase3-resume/probe-dead-css.mjs <out.json>
 */
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";
import { STATES, bootShotPage } from "../../tests/helpers/visual-shots.ts";

/** 收集 DOM 內所有 class（用 attribute，SVG 都覆蓋）。 */
const CLASSES = () => {
  const set = new Set();
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const cls = el.getAttribute("class");
    if (!cls) continue;
    for (const c of cls.split(/\s+/)) if (c) set.add(c);
    // SVG 用 className 可能係 SVGAnimatedString —— 上面已用 attribute 覆蓋
  }
  return Array.from(set).sort();
};

const states = {};

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });

await withTeardown(browser, server, async () => {
  for (const st of STATES) {
    const page = await bootShotPage(browser, st, BASE);
    const classes = await page.evaluate(CLASSES);
    states[st.name] = { n: classes.length, classes };
    console.log(`  ${st.name}: ${classes.length} 個 class`);
    await page.close();
  }
});

const all = new Set();
for (const s of Object.values(states)) for (const c of s.classes) all.add(c);
const out = process.argv[2] || "artifacts/phase3-resume/dead-css-runtime.json";
writeFileSync(
  out,
  JSON.stringify({ nStates: Object.keys(states).length, union: all.size, states }, null, 1),
  "utf-8",
);
console.log(`\n已寫入 ${out}（${Object.keys(states).length} 個狀態、聯集 ${all.size} 個 class）`);

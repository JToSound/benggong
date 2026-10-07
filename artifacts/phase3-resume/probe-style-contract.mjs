/**
 * D2-7 —— 樣式契約探測（computed style ＋ 幾何，**唔用像素**）。
 *
 * 為何要有
 * ========
 * `probe-css-order.mjs` 只量「stylesheet 次序」。D2-7 要求將量度**擴到**
 * 搜尋 overlay／編年史／dossier 展開等狀態 —— 呢個探測就係做嗰件事：
 * 逐個 canonical 狀態抽關鍵元素嘅 computed style ＋ 幾何。
 *
 * ⚠️ 狀態定義同抽取邏輯嘅**唯一來源**係
 * `tests/helpers/visual-shots.ts`（STATES）＋
 * `tests/helpers/style-snapshot.ts`（collectSnapshot）。
 * 本檔唔自己抄一份。
 *
 * 用法：
 *   node artifacts/phase3-resume/probe-style-contract.mjs
 *       → 逐個狀態印出關鍵元素嘅指紋
 *   node artifacts/phase3-resume/probe-style-contract.mjs --write-baseline
 *       → 另外寫入 tests/baselines/style-contract.json（等同 e2e 重生基線）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";
import { STATES, openShotPage, waitApp, waitStable } from "../../tests/helpers/visual-shots.ts";
import { collectSnapshot } from "../../tests/helpers/style-snapshot.ts";

const WRITE = process.argv.includes("--write-baseline");
const BASELINE = "tests/baselines/style-contract.json";

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });

const all = [];
await withTeardown(browser, server, async () => {
  for (const st of STATES) {
    const page = await openShotPage(browser, st);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await waitApp(page);
    if (st.act) await st.act(page);
    await waitStable(page);
    const snap = await collectSnapshot(
      page,
      st.name,
      `${st.viewport.width}x${st.viewport.height}${st.theme ? `/${st.theme}` : ""}`,
    );
    all.push(snap);
    // 摘要：邊幾個元素喺呢個狀態存在，同 topbar／map-pane 嘅幾何
    const present = Object.entries(snap.elements)
      .filter(([, v]) => v !== null)
      .map(([k]) => k);
    const mp = snap.elements["#map-pane"];
    const tb = snap.elements["#topbar"];
    console.log(
      `\n[${st.name}] viewport=${snap.viewport}\n` +
        `  map-pane=${mp ? `${mp.rect.w}x${mp.rect.h}` : "無"}  ` +
        `topbar.h=${tb ? tb.rect.h : "無"}  ` +
        `存在元素=${present.length}/${Object.keys(snap.elements).length}`,
    );
    console.log(`  存在：${present.join(", ")}`);
    await page.close();
  }
});

if (WRITE) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(all, null, 1) + "\n", "utf-8");
  console.log(`\n已寫基線 → ${BASELINE}（${all.length} 個狀態）`);
} else {
  console.log(`\n共 ${all.length} 個狀態（加 --write-baseline 可寫入 ${BASELINE}）`);
}

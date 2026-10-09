/**
 * D 階段 4／5 驗證：同一組 app 狀態嘅截圖（before / after 逐像素比對）。
 *
 * 為何要截圖比對
 * ==============
 * 「死 CSS」嘅定義係「嗰啲 class 永遠唔會出現喺 DOM」。如果真係死，
 * 移除佢哋嘅規則之後，畫面應該**逐像素一樣**。
 *
 * ⚠️ D4-6（2026-10-07）：本腳本以前有兩個會令結論失真嘅問題 ——
 *   1. **冇等動畫定咗** → 地圖 `flyTo` 截到中間狀態 → 同一份程式碼
 *      兩次都唔同（D 階段 4 實測 6/7 張唔同）✗；
 *   2. **冇量雜訊底線** → 見到「有差異」都唔知係真回歸定係雜訊 ✗。
 * 修法：狀態／等待／截圖邏輯一律用 `tests/helpers/visual-shots.ts`
 * （`shoot()` 已做「停動畫 ＋ 等 viewBox 連續 2 次相同 ＋ 2 帧 rAF」）；
 * `--compare` 模式**先報雜訊底線**（同一個狀態連影兩次）才比對 A/B。
 *
 * 用法：
 *   node artifacts/phase3-resume/probe-dead-css-shots.mjs <outDir>
 *       → 影一組圖（已等動畫定咗）
 *   node artifacts/phase3-resume/probe-dead-css-shots.mjs --compare <dirA> <dirB>
 *       → 逐像素比對兩個目錄（**先**報雜訊底線）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";
import {
  STATES,
  bootShotPage,
  comparePng,
  shoot,
} from "../../tests/helpers/visual-shots.ts";

/** 影一張指定狀態（真瀏覽器，已等穩定）。 */
async function capture(browser, st) {
  const page = await bootShotPage(browser, st, BASE);
  const buf = await shoot(page);
  return { page, buf };
}

async function shootAll(browser, outDir, quiet = false) {
  mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const st of STATES) {
    const { page, buf } = await capture(browser, st);
    writeFileSync(`${outDir}/${st.name}.png`, buf);
    if (!quiet) console.log(`  ${st.name}.png`);
    await page.close();
    n++;
  }
  return n;
}

const pngDataUrl = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;

/** 逐個狀態比對兩個目錄，回傳每個狀態嘅 diff。 */
async function comparePairs(browser, dirA, dirB) {
  const page = await browser.newPage();
  const per = {};
  for (const st of STATES) {
    per[st.name] = await comparePng(
      page,
      pngDataUrl(`${dirA}/${st.name}.png`),
      pngDataUrl(`${dirB}/${st.name}.png`),
    );
  }
  await page.close();
  return per;
}

async function compareDirs(browser, dirA, dirB) {
  const missing = [];
  for (const st of STATES) {
    if (!existsSync(`${dirA}/${st.name}.png`)) missing.push(`${dirA}/${st.name}.png`);
    if (!existsSync(`${dirB}/${st.name}.png`)) missing.push(`${dirB}/${st.name}.png`);
  }
  if (missing.length) {
    console.error("缺少截圖：\n" + missing.join("\n"));
    process.exitCode = 1;
    return;
  }

  // ── ① 先量雜訊底線 ──
  //
  // ⚠️ 一定要量**跨 run** 雜訊，唔可以只量「同一頁連影兩次」。
  //    實測（2026-10-07）：同一頁連影兩次 = **0 px**（因為 `waitStable`
  //    之後畫面真係完全靜止）；但**兩次獨立 run** 之間，地圖 `flyTo`
  //    會 settle 到略有差異嘅子像素狀態 → 實測最大 51 px／Δ12。
  //    用 0 做底線會**誤報**「超出雜訊」✗。
  //    做法：用**同一份 build** 影兩次（t1／t2）→ 佢哋之間嘅差異 = 底線。
  const t1 = "artifacts/phase3-resume/_noise-t1";
  const t2 = "artifacts/phase3-resume/_noise-t2";
  console.log("=== 雜訊底線（同一份 build 獨立影兩次）===");
  await shootAll(browser, t1, true);
  await shootAll(browser, t2, true);
  const noise = await comparePairs(browser, t1, t2);
  let noisePx = 0;
  let noiseMax = 0;
  for (const st of STATES) {
    noisePx += noise[st.name].diffPixels;
    noiseMax = Math.max(noiseMax, noise[st.name].maxDelta);
    console.log(
      `  ${st.name}: ${noise[st.name].diffPixels} px（Δ${noise[st.name].maxDelta}）`,
    );
  }
  console.log(`  → 合計 ${noisePx} px、最大 Δ${noiseMax}\n`);

  // ── ② 再比對 A vs B ──
  console.log(`=== 比對 ${dirA} vs ${dirB} ===`);
  const ab = await comparePairs(browser, dirA, dirB);
  let totalPx = 0;
  let flagged = 0;
  for (const st of STATES) {
    const r = ab[st.name];
    totalPx += r.diffPixels;
    // 超出「跨 run 底線」**同**一個絕對下限才算真差異
    const over = r.diffPixels > noise[st.name].diffPixels && r.maxDelta > noiseMax;
    if (over) flagged++;
    console.log(
      `  ${st.name}: ${r.diffPixels}/${r.total} px（${r.diffPct.toFixed(4)}%）` +
        `最大 Δ${r.maxDelta}（底線 ${noise[st.name].diffPixels}px/Δ${noise[st.name].maxDelta}）` +
        (over ? "  ⚠️ 超出底線" : ""),
    );
  }
  console.log(
    `  → 合計 ${totalPx} px（底線 ${noisePx} px）｜` +
      (flagged === 0
        ? "✓ 冇狀態超出跨 run 底線"
        : `⚠️ ${flagged} 個狀態超出底線（可能係真回歸）`),
  );
}

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });

await withTeardown(browser, server, async () => {
  const args = process.argv.slice(2);
  if (args[0] === "--compare") {
    const [, dirA, dirB] = args;
    if (!dirA || !dirB) {
      console.error("用法：--compare <dirA> <dirB>");
      process.exitCode = 1;
      return;
    }
    await compareDirs(browser, dirA, dirB);
  } else {
    const outDir = args[0] || "artifacts/phase3-resume/shots-before";
    const n = await shootAll(browser, outDir);
    console.log(`\n共 ${n} 張 → ${outDir}/（狀態來源：tests/helpers/visual-shots.ts）`);
  }
});

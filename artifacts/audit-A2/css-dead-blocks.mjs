/**
 * A2 CSS 死碼區塊級量化（唔用行級 heuristic，避免把 token 定義／註解誤判）
 *
 * 方法：
 *   1. 移除 CSS 註解。
 *   2. 以 `}` 切出規則區塊，取 `{` 之前嘅 selector。
 *   3. 由 selector 抽出 class（`.foo`）／id（`#foo`）token，**排除 hex 顏色**。
 *   4. 若 selector 內所有 class/id token 都唔喺 runtime live 集合 → 該區塊算「死」。
 *   5. 累加死區塊所佔行數。
 *
 * 執行：node artifacts/audit-A2/css-dead-blocks.mjs
 */
import fs from "node:fs";

const d = JSON.parse(fs.readFileSync("artifacts/audit-A2/dead-css.json", "utf8"));
const live = new Set([...d.chronicleMode.liveCls, ...d.chapterModeLive]);
const liveIds = new Set(d.chronicleMode.liveIds);

const FILES = ["src/styles/main.css", "src/styles/hud.css", "src/styles/timeline.css"];
const HEX = /^#?[0-9a-fA-F]{3,8}$/;

function analyze(file) {
  const raw = fs.readFileSync(file, "utf8");
  const noComment = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const lines = noComment.split("\n");

  // 用括號配對找規則區塊（處理 @media 嵌套）
  let depth = 0;
  let selStart = 0;
  let selText = "";
  let blockStartLine = 0;
  const blocks = [];
  for (let i = 0; i < noComment.length; i++) {
    const ch = noComment[i];
    if (ch === "{") {
      if (depth === 0) { blockStartLine = noComment.slice(0, i).split("\n").length; }
      depth++;
      if (depth === 1) selText = noComment.slice(selStart, i).trim();
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const endLine = noComment.slice(0, i).split("\n").length;
        blocks.push({ selector: selText, start: blockStartLine, end: endLine, lines: endLine - blockStartLine + 1 });
        selStart = i + 1;
      }
    }
  }

  const atRule = (sel) => /^@/.test(sel);
  let deadBlocks = 0, deadLines = 0, liveBlocks = 0, liveLines = 0, atBlocks = 0;
  const deadSelectors = [];
  for (const b of blocks) {
    if (atRule(b.selector)) { atBlocks++; continue; }
    const tokens = [...b.selector.matchAll(/[.#]([A-Za-z_][\w-]*)/g)].map((m) => m[1]).filter((t) => !HEX.test(t));
    if (!tokens.length) { atBlocks++; continue; }
    const isLive = tokens.some((t) => live.has(t) || liveIds.has(t));
    if (isLive) { liveBlocks++; liveLines += b.lines; }
    else { deadBlocks++; deadLines += b.lines; deadSelectors.push(b.selector.replace(/\s+/g, " ").slice(0, 70)); }
  }
  return { file, totalLines: raw.split("\n").length, blocks: blocks.length, atBlocks, liveBlocks, liveLines, deadBlocks, deadLines, deadSelectors };
}

const out = FILES.map(analyze);
let td = 0, tl = 0, tlb = 0;
for (const r of out) {
  td += r.deadLines; tl += r.totalLines; tlb += r.liveLines;
  console.log(`\n=== ${r.file} ===`);
  console.log(`  總行 ${r.totalLines} | 規則區塊 ${r.blocks}（@-rule ${r.atBlocks}）`);
  console.log(`  live 區塊 ${r.liveBlocks}（${r.liveLines} 行） | dead 區塊 ${r.deadBlocks}（${r.deadLines} 行）`);
  console.log(`  dead selector 樣本: ${JSON.stringify(r.deadSelectors.slice(0, 18))}`);
}
console.log(`\n===== 合計 =====`);
console.log(`三份 CSS 總行: ${tl}`);
console.log(`可對應 live 元素嘅規則行: ${tlb}（${((tlb / tl) * 100).toFixed(1)}%）`);
console.log(`冇任何 live 元素匹配嘅規則行: ${td}（${((td / tl) * 100).toFixed(1)}%）`);

fs.writeFileSync("artifacts/audit-A2/css-dead-blocks.json", JSON.stringify(out, null, 2), "utf8");
console.log("寫入 artifacts/audit-A2/css-dead-blocks.json");

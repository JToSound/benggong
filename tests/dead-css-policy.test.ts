// D 階段 4（2026-10-07）—— 死 CSS 契約（防止回流）
//
// 為何要有呢個檔
// ==============
// D 階段 4 由 `legacy-migrated.css` 剪除咗 **31 個零引用 class**（49 條規則）。
// 判準係**三重保守**（見 `scripts/audit_dead_css.py`）：
//   A. 使用語料（`src/`、`tests/`、`scripts/`、`index.html`、`public/`）內
//      **冇**該 class 嘅完整字面；
//   B. 語料內**冇**任何係該 class 前綴嘅字串（防止 `"zd-" + kind` 之類拼接）；
//   C. 真瀏覽器 7 個 app 狀態之下**從未出現**（`probe-dead-css.mjs`）。
//
// 而 `docs/` **唔計入**使用語料 —— 2026-10-07 實測：`docs/` 提及過
// `chr-tl-bar`（D 遷移報告），令佢被誤判「有引用」，掩蓋咗「V1 時間軸已死」。
//
// 驗證強度（由弱至強）：
//   1. 三重靜態／執行期判準 ✓
//   2. 剪除前後**逐像素**比對 7 個狀態 → 差異 10/1,296,000 像素（最大強度差 3/765）
//      = 亞像素雜訊 ✓
//   3. 全套 vitest／pytest ✓
//
// 維護方式（將來想再剪）：
//   C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/audit_dead_css.py \
//     --json artifacts/phase3-resume/dead-css-final.json \
//     --runtime artifacts/phase3-resume/dead-css-runtime.json
//   node artifacts/phase3-resume/probe-dead-css.mjs artifacts/phase3-resume/dead-css-runtime.json
//   python scripts/prune_dead_css.py --analysis <json> [--apply]

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LEGACY = readFileSync("src/styles/legacy-migrated.css", "utf-8");

/** D 階段 4 已剪除嘅 31 個死 class（2026-10-07）。 */
const PRUNED = [
  // V1 sidebar / about
  "bg-about-inner",
  "bg-char-list",
  "bg-detail-actions",
  "bg-hint",
  "bg-sidebar-inner",
  // V1 search
  "bg-search",
  "bg-search-results",
  "bg-search-sub",
  // V1 map extras
  "bg-dot",
  "bg-marker",
  "bg-meta",
  "bg-measure-btn",
  "bg-measure-tip",
  "bg-provisional-banner",
  "bg-spoiler-btns",
  // 錯誤畫面（live 嘅係 .bg-error-panel／-detail／-hint）
  "bg-error",
  // V1 時間軸
  "tl-chapter",
  "tl-date",
  "tl-desc",
  "tl-filter",
  "tl-highlight",
  "tl-item",
  "tl-list",
  "tl-marker",
  "tl-meta",
  "tl-spoiler",
  // V1 時間軸時期顏色（掛喺 .chr-tl-bar，而 .chr-tl-bar 本身已死）
  "is-basecamp",
  "is-early",
  "is-endgame",
  "is-lohas",
  "is-outbreak",
] as const;

describe("D 階段 4：死 CSS 契約", () => {
  it("⭐ 已剪除嘅 31 個 class 唔可以回流", () => {
    const back: string[] = [];
    for (const c of PRUNED) {
      // 用選擇器邊界匹配（`.cls` 後面唔可以再接 `-`／英數 → 唔會誤中 `.bg-error-panel`）
      const re = new RegExp(`\\.${c}(?![\\w-])`);
      if (re.test(LEGACY)) back.push(c);
    }
    expect(
      back,
      `以下 class 已經剪除（零引用）但又回流咗：${back.join(", ")}\n` +
        "（如果係有意加返，要同時喺 `scripts/audit_dead_css.py` 嘅判準下重新論證）",
    ).toEqual([]);
  });

  it("live 嘅同名前綴 class 唔可以被誤刪（`.bg-error-panel` 等）", () => {
    /*
     * `.bg-error` 係死嘅，但 `.bg-error-panel` / `-detail` / `-hint` 係
     * **載入失敗畫面**（`src/main.ts`）用嘅 —— 剪除一定要分辨得到。
     */
    for (const c of ["bg-error-panel", "bg-error-detail", "bg-error-hint"]) {
      expect(LEGACY, `.${c} 唔應該被刪（live）`).toMatch(new RegExp(`\\.${c}\\b`));
    }
  });

  it("CSS 結構完好（括號平衡、冇殘留孤兒規則）", () => {
    const code = LEGACY.replace(/\/\*[\s\S]*?\*\//g, "");
    const open = (code.match(/\{/g) ?? []).length;
    const close = (code.match(/\}/g) ?? []).length;
    expect(open, `大括號要平衡（open=${open} close=${close}）`).toBe(close);
    // 唔可以有「選擇器後面直接接 }」嘅空規則（剪除後遺症）
    expect(code).not.toMatch(/\{\s*\}/);
  });

  it("分析／剪除工具仍然存在（可重跑）", () => {
    for (const f of [
      "scripts/audit_dead_css.py",
      "scripts/prune_dead_css.py",
      "artifacts/phase3-resume/probe-dead-css.mjs",
      "artifacts/phase3-resume/probe-dead-css-shots.mjs",
    ]) {
      expect(existsSync(f), `${f} 應該存在（D 階段 4 嘅可重跑工具）`).toBe(true);
    }
  });
});

// D 階段 2（2026-10-07）—— 執行期 stylesheet 次序契約（**靜態**，CI 都跑到）
//
// 為何要有呢個檔
// ==============
// D 階段 2 移除咗 `mobile.css` / `layout.css` 全部 46 條「為蓋過舊 CSS 而加」
// 嘅 `!important`（實測 0/153、0/127 個 computed value 有變）。
// 移除之後，`mobile.css` 嘅規則之所以仍然生效，**完全靠「最後載入」**
// （同特異度之下後者勝）。
//
// ⚠️ 如果呢個次序係隱式（取決於建構先後），任何人加一個新嘅執行期
// stylesheet 就會令 `mobile.css` **靜默**輸 → 手機版面／safe-area 無聲壞掉，
// 而且冇 `!important` 擋住。
//
// 所以次序由 `src/ui/inject-style-sheet.ts` 嘅 `RUNTIME_STYLE_ORDER` 明確聲明，
// 本檔把「兩個注入點都要行呢條路」變成可重跑斷言。
//
// ⚠️ 本檔係**靜態原始碼契約**。真瀏覽器嘅實際 `<head>` 次序由
// `tests/style-sheet-order.e2e.test.ts` 覆蓋（⚠️ CI 冇裝 Playwright
// browser → e2e 會 skip，所以本檔係 CI 唯一嘅守衛）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HELPER = readFileSync("src/ui/inject-style-sheet.ts", "utf-8");
const BOTTOM_SHEET = readFileSync("src/components/BottomSheet.ts", "utf-8");
const SVG_MAP = readFileSync("src/components/SvgMap.ts", "utf-8");

describe("D 階段 2：執行期 stylesheet 次序契約", () => {
  it("⭐ `RUNTIME_STYLE_ORDER` 存在，而且 `b8-mobile-css` 排最後", () => {
    const m = /RUNTIME_STYLE_ORDER[^=]*=\s*\[([^\]]*)\]/.exec(HELPER);
    expect(m, "搵唔到 RUNTIME_STYLE_ORDER 宣告").not.toBeNull();
    const ids = m![1]
      .split(",")
      .map((s) => s.trim().replace(/["']/g, ""))
      .filter(Boolean);
    expect(ids, "次序表唔應該係空").not.toHaveLength(0);
    expect(
      ids[ids.length - 1],
      "`b8-mobile-css`（mobile.css）一定要最後 —— 佢冇 `!important` 擋住，全靠後載入",
    ).toBe("b8-mobile-css");
    expect(ids, "`map-v2-css` 亦要喺表內（同 mobile 嘅相對次序要明確）").toContain(
      "map-v2-css",
    );
  });

  it("⭐ 兩個注入點都行 `injectStyleSheet()`（唔可以自己 appendChild）", () => {
    for (const [name, src, id] of [
      ["BottomSheet.ts", BOTTOM_SHEET, "b8-mobile-css"],
      ["SvgMap.ts", SVG_MAP, "map-v2-css"],
    ] as const) {
      expect(src, `${name} 應該 import injectStyleSheet`).toContain("injectStyleSheet");
      expect(src, `${name} 應該用 ${id} 做 id 呼叫 injectStyleSheet`).toMatch(
        new RegExp(`injectStyleSheet\\(\\s*"${id}"`),
      );
      /*
       * 唔可以再有「自己 createElement("style") + head.appendChild」——
       * 嗰樣會繞過次序契約。
       */
      expect(
        src,
        `${name} 唔應該自己 appendChild 一個 <style>（會繞過次序契約）`,
      ).not.toMatch(/createElement\(\s*["']style["']\s*\)/);
    }
  });

  it("`injectStyleSheet()` 真係有重新排位邏輯（唔係只 append）", () => {
    expect(HELPER, "要有 insertBefore（插喺次序更後嘅 style 之前）").toContain(
      "insertBefore",
    );
    expect(HELPER, "冇更後嘅 style 時要 appendChild（移到最尾）").toContain(
      "appendChild",
    );
    // 只可以理 `style[id]` —— bundled <link> 要留喺最前
    expect(HELPER).toContain('querySelectorAll("style[id]")');
  });

  it("`mobile.css` / `layout.css` 冇殘留嘅 `!important`（reduced-motion 除外）", () => {
    for (const f of ["src/styles/mobile.css", "src/styles/layout.css"]) {
      const raw = readFileSync(f, "utf-8");
      // 去註解（註解提及 `!important` 唔算）
      let code = raw.replace(/\/\*[\s\S]*?\*\//g, "");
      /*
       * ⚠️ `@media (prefers-reduced-motion: reduce)` 之下嘅 `!important`
       * 係**正當**用法（要蓋過任意 transition／animation，特異度代替唔到）
       * → 由 `docs/contracts/css-important-allowlist.json` 登記，本檔豁免。
       * 呢度用括號配對把嗰個 media block 整段剔走。
       */
      code = removeMediaBlock(code, "prefers-reduced-motion");
      const n = (code.match(/!important/g) ?? []).length;
      expect(
        n,
        `${f} 應該冇 !important（reduced-motion 除外；實測移除係行為中性）`,
      ).toBe(0);
    }
  });
});

/** 由 CSS 字串剔走某個 `@media (...)` 條件嘅整個 block（括號配對，逐個掃）。 */
function removeMediaBlock(css: string, condition: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    const open = css.indexOf("{", at);
    if (open < 0) {
      out += css.slice(i);
      break;
    }
    let depth = 0;
    let end = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) {
      out += css.slice(i);
      break;
    }
    const head = css.slice(at, open);
    out += css.slice(i, at);
    // 唔匹配 → 原樣保留；匹配 → 整段剔走
    if (!head.includes(condition)) out += css.slice(at, end + 1);
    i = end + 1;
  }
  return out;
}

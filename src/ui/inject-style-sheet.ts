/**
 * 執行期 stylesheet 注入（**次序即 cascade 優先級**）。
 *
 * 為何要有呢個模組
 * ================
 * D 階段 2（2026-10-07）移除咗 `mobile.css` / `layout.css` 全部 46 條
 * 「為蓋過舊 CSS 而加」嘅 `!important`。移除之後，嗰啲規則之所以仍然生效，
 * 係因為 **`b8-mobile-css` 係最後載入**（同特異度之下「後者勝」）。
 *
 * ⚠️ 但「最後載入」原本係**隱式**嘅 —— 取決於 `SvgMap.init()` 同
 * `BottomSheet` 建構嘅先後。任何人加一個新嘅執行期 stylesheet、
 * 或者改動建構次序，就會令 `mobile.css` **靜默**輸 → 手機版面／safe-area
 * 無聲壞掉（而且冇任何 `!important` 擋住）。
 *
 * 所以次序要由**程式碼**保證（唔係靠慣例）：本模組用
 * `RUNTIME_STYLE_ORDER` 明確聲明次序，`injectStyleSheet()` 每次呼叫都
 * 會將 `<style>` 重新排到正確位置 —— **唔受呼叫次序影響**。
 *
 * 對應守衛：
 *   · `tests/style-sheet-order.test.ts`（靜態：兩個注入點都用本模組）
 *   · `tests/style-sheet-order.e2e.test.ts`（真瀏覽器：實際 head 次序）
 */

/**
 * 執行期注入嘅 stylesheet 次序（**由先到後**）。
 *
 * ⚠️ `b8-mobile-css` 一定要最後 —— `mobile.css` 內大量規則同
 * `map.css`（`#map-v2-css`）同特異度，靠「後載入」勝出。
 */
export const RUNTIME_STYLE_ORDER: readonly string[] = ["map-v2-css", "b8-mobile-css"];

function rankOf(el: Element): number {
  const i = RUNTIME_STYLE_ORDER.indexOf(el.id);
  return i < 0 ? -1 : i;
}

/**
 * 注入（或更新）一個執行期 `<style>`，並確保佢喺
 * `RUNTIME_STYLE_ORDER` 指定嘅位置。
 *
 * 冪等：重複呼叫只會更新內容同重新排位。
 */
export function injectStyleSheet(id: string, css: string): void {
  if (typeof document === "undefined") return;
  const head = document.head;
  if (!head) return;

  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;

  /*
   * 重新排位：搵第一個「次序更後」嘅 runtime `<style>`，插喺佢前面。
   * 冇更後嘅 → 放到最尾（`appendChild` 會移動既有節點）。
   *
   * ⚠️ 只理 `style[id]` —— bundled 嘅 `<link>` 一定要留喺最前
   * （tokens / base / legacy-migrated / layout 全部喺嗰個 bundle 內）。
   */
  const myRank = rankOf(el);
  let anchor: Element | null = null;
  for (const node of Array.from(head.querySelectorAll("style[id]"))) {
    if (node === el) continue;
    if (rankOf(node) > myRank) {
      anchor = node;
      break;
    }
  }
  if (anchor) {
    if (el.nextElementSibling !== anchor) head.insertBefore(el, anchor);
  } else if (head.lastElementChild !== el) {
    head.appendChild(el);
  }
}

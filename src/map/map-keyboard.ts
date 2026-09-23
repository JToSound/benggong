/**
 * map-keyboard.ts — 地圖元素嘅鍵盤導覽（P1-2 / 驗收矩陣 §10.9）。
 *
 * 問題（A7 `mobile-a11y-audit.md` P1-2）
 * ===================================
 * 地圖 19 個互動元素（zone / location marker / cluster / event marker /
 * route line）**全部 `tabIndex = -1`**、冇 `role`、冇 `aria-label`，
 * 而互動綁定係單一 delegated `click` handler → **鍵盤可達 = 0/19**。
 * 18 個元素有 SVG `<title>`（tooltip），但因為唔可聚焦，螢幕閱讀器同
 * 鍵盤都用唔到。
 *
 * 設計：**roving tabindex**
 * =======================
 * ⚠️ 為何唔可以逐個元素 `tabindex="0"`
 * ----------------------------------
 * 地圖一次可以 render **48 個 zone** ＋ 多個 location／event marker。
 * 全部變成 Tab stop 會令鍵盤用戶要 Tab 過百次才離開地圖；而且
 * `tests/a11y-keyboard.e2e.test.ts` 有「全頁 Tab stop < 600」同
 * 「頂欄導覽要喺 20 次 Tab 內到達」嘅斷言 —— 大量新增 Tab stop 會直接
 * 撞紅嗰兩條（呢個就係「之前加 tabindex 令 e2e fail」嘅根因）。
 *
 * 所以：**任何時候只有 1 個地圖元素 `tabindex="0"`**，其餘 `-1`；
 * `Tab` 入到地圖就落喺嗰個元素，方向鍵喺組內移動，`Enter` / `Space`
 * 啟動（等同 click）。呢個係 WAI-ARIA 對「一組同性質項目」嘅標準做法。
 */

/** 地圖內可聚焦嘅互動元素（document order = 視覺／邏輯順序）。 */
export const MAP_INTERACTIVE_SELECTOR = [
  ".zone",
  ".route-line",
  ".location-marker",
  ".location-marker-cluster",
  ".event-marker",
].join(", ");

/** 按鍵 → 動作。 */
export type MapKeyAction =
  | "activate"
  | "next"
  | "prev"
  | "first"
  | "last"
  | "escape"
  | "none";

/**
 * 將 `KeyboardEvent.key` 映射成動作。
 *
 * ⚠️ `" "`（Space）同 `"Spacebar"`（舊 IE／部分瀏覽器）都要收；
 * `Enter` 喺 SVG 元素上**唔會**自動合成 `click`（唔似 `<button>`），
 * 所以一定要自己處理。
 */
export function resolveMapKey(key: string): MapKeyAction {
  switch (key) {
    case "Enter":
    case " ":
    case "Spacebar":
      return "activate";
    case "ArrowRight":
    case "ArrowDown":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Escape":
      return "escape";
    default:
      return "none";
  }
}

/**
 * roving tabindex：由 `current` 移動去目標索引（**環繞**）。
 *
 * @param current 目前索引（`-1` = 未有焦點 → 當 0）
 * @param action  方向鍵動作（`activate` / `escape` / `none` 會回原索引）
 * @param len     組內元素數
 * @returns 目標索引（`len <= 0` → `-1`）
 */
export function rovingIndex(
  current: number,
  action: MapKeyAction,
  len: number,
): number {
  if (len <= 0) return -1;
  /*
   * 未有焦點（-1）→ 任何動作都落喺**第一個**。
   *
   * ⚠️ 為何唔可以「夾成 0 再 +1」：咁會令 next 跳去索引 1，
   * 即係「第一次按 → 跳過第一個元素」。實務上 keydown handler 只會喺
   * 有元素聚焦時行，所以 `current` 唔會係 -1；但呢個函數係純函數，
   * 要有明確語義。
   */
  if (current < 0) return 0;
  if (action === "first") return 0;
  if (action === "last") return len - 1;
  const clamped = Math.max(0, Math.min(len - 1, current));
  if (action === "next") return (clamped + 1) % len;
  if (action === "prev") return (clamped - 1 + len) % len;
  return clamped;
}

/**
 * 呢個動作係唔係「導覽動作」（需要 `preventDefault`）。
 *
 * ⚠️ 唔 `preventDefault` 嘅話，方向鍵會**捲動頁面**，`Space` 亦會捲頁
 * —— 用戶會覺得地圖「唔聽話」。
 */
export function isNavigationAction(action: MapKeyAction): boolean {
  return (
    action === "next" ||
    action === "prev" ||
    action === "first" ||
    action === "last"
  );
}

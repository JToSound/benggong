/**
 * a11y.ts — 編年史嘅 ARIA / 鍵盤契約（B7 純函數模組）。
 *
 * 為何要集中
 * ==========
 * V1 嘅編年史完全冇 `role`、冇 `aria-label`、冇鍵盤導航（A7 P0-5）。
 * ARIA 屬性散落喺 template string 最易漏（漏一個就係 a11y regression），
 * 所以集中喺呢度 + 由 `tests/chronicle-a11y.test.ts` 逐個斷言。
 *
 * 呢個檔**零 DOM 依賴**（`environment: node` 跑得）。
 */

/** 編年史容器嘅 ARIA 屬性（`aria-label` 係粵文）。 */
export const CHRONICLE_ARIA = {
  regionLabel: "第一季編年史",
  periodNavLabel: "故事時期",
  timelineLabel: "章節時間軸",
  searchLabel: "喺編年史入面搵",
  countLiveRegion: "chronicle-count",
} as const;

/** 互動元素嘅 `aria-label` 產生器（單一來源，唔喺 template 內手寫）。 */
export function ariaChapterChip(chapter: number): string {
  return `第 ${chapter} 章相關嘅編年史條目`;
}

export function ariaToggle(title: string, expanded: boolean): string {
  return `${expanded ? "收起" : "展開"}「${title}」`;
}

export function ariaForeshadow(targetTitle: string, chapter: number): string {
  return `跳去「${targetTitle}」（第 ${chapter} 章）`;
}

export function ariaPeriod(key: string, label: string, count: number): string {
  return `跳去${label}（${count} 條）[${key}]`;
}

export function ariaEntry(title: string, chapter: number): string {
  return `${title}（首次提及：第 ${chapter} 章）`;
}

/**
 * 編年史支援嘅鍵盤動作。
 *
 * ⚠️ `Escape` **唔**喺呢度 —— `src/app.ts` 已經有全域 `Escape` 處理
 * （先關浮層，再 `setContext({kind:'explore'})`）。編年史再攔一次會打架。
 */
export type ChronleKeyAction = "next" | "prev" | "first" | "last" | "activate";

/**
 * 將 `KeyboardEvent.key` 對應到動作。
 *
 * 為何同時支援 `j` / `k`：同 `app.ts` 嘅章節快捷鍵一致（V1 已有），
 * 唔加嘅話用戶會以為編年史唔食快捷鍵。
 */
export function keyAction(key: string): ChronleKeyAction | null {
  switch (key) {
    case "ArrowDown":
    case "j":
      return "next";
    case "ArrowUp":
    case "k":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
    case " ":
      return "activate";
    default:
      return null;
  }
}

/** 由目前 index + 動作 → 新 index（clamp；空清單 → `-1`）。 */
export function nextIndex(
  current: number,
  action: ChronleKeyAction,
  total: number,
): number {
  if (total <= 0) return -1;
  switch (action) {
    case "first":
      return 0;
    case "last":
      return total - 1;
    case "next":
      return Math.min(total - 1, Math.max(0, current < 0 ? 0 : current + 1));
    case "prev":
      return Math.max(0, current < 0 ? 0 : current - 1);
    default:
      return current < 0 ? 0 : current;
  }
}

/** 條目元素嘅 DOM id（`aria-controls` / `focus()` 用）。 */
export function entryDomId(id: string): string {
  return `chr-entry-${id}`;
}

/** 展開區嘅 DOM id（`aria-controls` 目標）。 */
export function entryBodyDomId(id: string): string {
  return `chr-body-${id}`;
}

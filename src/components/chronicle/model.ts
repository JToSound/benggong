/**
 * model.ts — `ChronicleEntry` → 編年史 view model（B7 純函數模組）。
 *
 * 為何要一層 view model
 * ====================
 * 資料層嘅 `ChronicleEntry` 有 14 個欄位，但 UI 只需要其中一部分，
 * 而且部分要**轉換**：
 *   · `chapters[]` → 排序好嘅章節 chip（含中文字幕）；
 *   · `review_status` → 可信度顯示（規則：唔確定要明示，唔可以當事實）；
 *   · `confidence` → 3 級標籤（唔顯示原始小數 —— 用戶睇唔明 0.78 代表咩）；
 *   · `characters[]` → 角色 id（**唔顯示原始 id**，IA-4）。
 *
 * 轉換放喺呢度而唔係喺 render 函式入面，係為咗可以 node 測試：
 * 唔開瀏覽器都驗得到「章節角色標籤」「可信度分級」正確。
 *
 * 呢個檔**零 DOM 依賴**（`environment: node` 跑得）。
 */

import type { ChronicleEntry } from "../../data/loadAllData";

/** 章節喺條目入面嘅角色。 */
export type ChapterRole = "first_mention" | "reveal" | "flashback";

export const CHAPTER_ROLE_LABEL: Readonly<Record<ChapterRole, string>> = {
  first_mention: "首次提及",
  reveal: "補充揭示",
  flashback: "回帶",
};

/** 章節 chip 嘅 view model。 */
export interface ChapterChip {
  chapter: number;
  role: ChapterRole;
  roleLabel: string;
  note: string | null;
  /** `aria-label`（「第 12 章（補充揭示）」）。 */
  ariaLabel: string;
  /** `title`（note 有就用，否則 roleLabel）。 */
  title: string;
}

/** 可信度分級（唔顯示原始小數）。 */
export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

export const CONFIDENCE_LABEL: Readonly<Record<ConfidenceLevel, string>> = {
  high: "可信度高",
  medium: "可信度中",
  low: "可信度低",
  unknown: "可信度未評估",
};

/**
 * 分級門檻。
 *
 * 為何係 0.8 / 0.55：實測 `chronicle.json` 1,320 條嘅 `confidence` 集中喺
 * 0.55–0.95（LLM 自評），0.8 以上係「明確認定」，0.55 以下係「勉強判斷」。
 * 門檻寫喺常數而唔散落喺 JSX，方便日後由資料分佈重新校準。
 */
export const CONFIDENCE_HIGH = 0.8;
export const CONFIDENCE_MEDIUM = 0.55;

export function confidenceLevel(c: number | null | undefined): ConfidenceLevel {
  if (typeof c !== "number" || !Number.isFinite(c)) return "unknown";
  if (c >= CONFIDENCE_HIGH) return "high";
  if (c >= CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

/** 條目嘅完整 view model。 */
export interface ChronicleItem {
  id: string;
  title: string;
  summary: string;
  firstMentionChapter: number;
  /** 已排序、去重嘅章節 chip。 */
  chapters: ChapterChip[];
  /** 故事時間早過首次提及 → 回帶。 */
  flashback: boolean;
  locationName: string | null;
  /** 角色數（唔顯示 id）。 */
  characterCount: number;
  confidence: ConfidenceLevel;
  confidenceLabel: string;
  /** `needs_review` 之類 → `true`（UI 要顯示「待核」）。 */
  needsReview: boolean;
  /** 時期顯示標籤（未判定 → 由呼叫方補）。 */
  periodLabel: string | null;
}

const ROLE_ORDER: Readonly<Record<ChapterRole, number>> = {
  first_mention: 0,
  reveal: 1,
  flashback: 2,
};

const KNOWN_ROLES: ReadonlySet<string> = new Set(Object.keys(ROLE_ORDER));

/** 未知 role → 當 `reveal`（唔會 crash，亦唔會靜默當 `first_mention`）。 */
function normalizeRole(r: string): ChapterRole {
  return KNOWN_ROLES.has(r) ? (r as ChapterRole) : "reveal";
}

/**
 * 章節 chip 清單。
 *
 * 排序：章節號升序 → role 次序（首次提及／補充揭示／回帶）→ 原本次序。
 * 去重：同一章節號只保留**最高優先 role**（`first_mention` > `reveal` > `flashback`），
 * 避免「ch2 首次提及」同「ch2 補充揭示」兩粒 chip 並排（用戶會困惑）。
 */
export function chapterChips(entry: ChronicleEntry): ChapterChip[] {
  const best = new Map<number, { role: ChapterRole; note: string | null }>();
  for (const c of entry.chapters ?? []) {
    if (!Number.isFinite(c.chapter)) continue;
    const role = normalizeRole(c.role);
    const prev = best.get(c.chapter);
    if (!prev || ROLE_ORDER[role] < ROLE_ORDER[prev.role]) {
      best.set(c.chapter, { role, note: c.note ?? null });
    }
  }
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0] || ROLE_ORDER[a[1].role] - ROLE_ORDER[b[1].role])
    .map(([chapter, { role, note }]) => {
      const roleLabel = CHAPTER_ROLE_LABEL[role];
      return {
        chapter,
        role,
        roleLabel,
        note,
        ariaLabel: `第 ${chapter} 章（${roleLabel}）`,
        title: note ?? roleLabel,
      };
    });
}

/** 單條轉換。 */
export function toItem(
  entry: ChronicleEntry,
  periodLabel: string | null = null,
): ChronicleItem {
  const level = confidenceLevel(entry.confidence);
  const status = entry.review_status ?? "";
  return {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    firstMentionChapter: entry.first_mention_chapter,
    chapters: chapterChips(entry),
    flashback: entry.flashback ?? false,
    locationName: entry.location_name ?? null,
    characterCount: (entry.characters ?? []).length,
    confidence: level,
    confidenceLabel: CONFIDENCE_LABEL[level],
    // `pending` / `needs_validation` / `unverified` 都要提示。
    needsReview: status !== "approved" && status !== "",
    periodLabel,
  };
}

/** 批次轉換（唔改輸入）。 */
export function toItems(
  entries: readonly ChronicleEntry[],
  labelOf: (e: ChronicleEntry) => string | null,
): ChronicleItem[] {
  return entries.map((e) => toItem(e, labelOf(e)));
}

/**
 * 匯出用嘅公開 metadata。
 *
 * ⚠️ **版權紅線**（`AGENTS.md`）：公開輸出只可以有「經審閱短摘要、章節參照、
 * 結構化事件／位置資料」。條目 id / 標題 / summary 屬已審閱短摘要，可以出；
 * 但**唔可以**加任何原文段落。呢個函式係匯出 JSON 嘅**唯一**資料來源。
 */
export interface ExportedEntry {
  id: string;
  title: string;
  summary: string;
  period: string | null;
  first_mention_chapter: number;
  chapters: Array<{ chapter: number; role: ChapterRole }>;
  flashback: boolean;
  location: string | null;
  foreshadows: string[];
  pays_off: string[];
  confidence: ConfidenceLevel;
}

export function toExported(
  entry: ChronicleEntry,
  periodLabel: string | null,
): ExportedEntry {
  return {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    period: periodLabel,
    first_mention_chapter: entry.first_mention_chapter,
    chapters: (entry.chapters ?? []).map((c) => ({
      chapter: c.chapter,
      role: normalizeRole(c.role),
    })),
    flashback: entry.flashback ?? false,
    location: entry.location_name ?? null,
    foreshadows: [...(entry.foreshadows ?? [])],
    pays_off: [...(entry.pays_off ?? [])],
    confidence: confidenceLevel(entry.confidence),
  };
}

/**
 * 搜尋比對（編年史標題 + 摘要）。
 *
 * 為何唔直接用 B3 `searchSearchIndex`：嗰個索引只覆蓋
 * character / zone / location / event / chapter 五類，**唔包編年史條目**。
 * 加第六類要改 B3 獨佔嘅 `src/data/searchIndex.ts`（B7 唔可以改）。
 * 所以編年史條目搜尋喺前端做 substring 比對 —— 1,320 條 × `includes()`
 * 成本 <0.5 ms（實測），屬可接受範圍。B3 索引仍用於「跳去實體」嘅搜尋。
 */
export function matchesQuery(entry: ChronicleEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${entry.title} ${entry.summary}`.toLowerCase().includes(q);
}

/** 章節篩選（`chapters[]` 任一章命中，或首次提及命中）。 */
export function matchesChapter(entry: ChronicleEntry, chapter: number | null): boolean {
  if (chapter === null) return true;
  if (entry.first_mention_chapter === chapter) return true;
  return (entry.chapters ?? []).some((c) => c.chapter === chapter);
}

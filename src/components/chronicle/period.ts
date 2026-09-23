/**
 * period.ts — 編年史「時期」定義同分群（B7 純函數模組）。
 *
 * 為何要獨立出嚟
 * ==============
 * V1 將時期邏輯寫死喺 `ChronicleView.ts` 嘅 `periodOf()` / `grouped()` 入面，
 * 令兩件事冇得獨立測試：
 *   1. 「邊個 `story_time.source` 算有時期」；
 *   2. 「點按時期排序同分群」。
 *
 * ⚠️ 為何「有時期」必須接受**兩個** source（`docs/CHRONICLE_DESIGN.md` §6.8）
 * -------------------------------------------------------------------------
 * 時期資料有兩個產生階段：
 *   · 階段 2 —— LLM 逐條判斷 → `story_time.source === "llm_period"`（929 條）
 *   · 階段 3 —— 逐章邊界修正 → `story_time.source === "chapter_boundary"`（391 條）
 *
 * V1 只認 `llm_period`，結果 391 條明明有時期標籤卻顯示「時期未判定」。
 * 呢個 bug **踩過兩次**（第一次係 `prior_corrected` → `chapter_order`）。
 *
 * 所以 B7 用**單一來源** `ACCEPTED_PERIOD_SOURCES`，任何新 source 值只可以
 * 喺呢一個地方加；資料層測試（`tests/test_chronicle.py`）同前端測試
 * （`tests/chronicle-view.test.ts`）兩邊都斷言同一個集合，令唔一致即刻紅。
 *
 * 呢個檔**零 DOM 依賴**（`environment: node` 跑得）。
 */

import type { ChronicleEntry } from "../../data/loadAllData";

/** 故事時期鍵（同 `docs/CHRONICLE_DESIGN.md` §8 嘅建議分期一致）。 */
export type PeriodKey =
  | "pre_outbreak"
  | "outbreak"
  | "early"
  | "basecamp"
  | "lohas"
  | "endgame";

/** 時期未判定（資料冇 label，或 source 唔認）。 */
export const UNKNOWN_PERIOD_KEY = "_unknown";

/**
 * 時期顯示次序 = **故事內時間次序**（唔係敍事次序）。
 * 呢個陣列係唯一排序權威 —— 唔依賴 `Map` 嘅插入次序（嗰個係實作細節）。
 */
export const PERIOD_ORDER: readonly PeriodKey[] = [
  "pre_outbreak",
  "outbreak",
  "early",
  "basecamp",
  "lohas",
  "endgame",
];

/** 時期粵文標籤。 */
export const PERIOD_LABEL: Readonly<Record<PeriodKey, string>> = {
  pre_outbreak: "爆發前",
  outbreak: "病毒爆發",
  early: "爆發初期",
  basecamp: "大本營時期",
  lohas: "康城時期",
  endgame: "終局",
};

/** 時期未判定嘅顯示標籤。 */
export const UNKNOWN_PERIOD_LABEL = "時期未判定";

/**
 * 可以信賴嘅 `story_time.source` 值。
 *
 * ⚠️ 加新 source 一定要喺**呢一個地方**加，唔可以喺元件內另開白名單。
 */
export const ACCEPTED_PERIOD_SOURCES: ReadonlySet<string> = new Set([
  "llm_period",
  "chapter_boundary",
]);

/** label → period key（label 唔識 → null）。 */
const LABEL_TO_KEY: ReadonlyMap<string, PeriodKey> = new Map(
  PERIOD_ORDER.map((k) => [PERIOD_LABEL[k], k] as const),
);

/**
 * 條目嘅時期鍵。
 *
 * - `story_time.source` 唔喺 `ACCEPTED_PERIOD_SOURCES` → `null`（**唔可以當成
 *   「爆發前」**，咁會誤導用戶，比顯示「未判定」更差）。
 * - label 唔認識 → `null`（資料新增咗時期但前端未跟 → 應該紅測試，唔應該靜默歸類）。
 */
export function periodKeyOf(entry: ChronicleEntry): PeriodKey | null {
  const st = entry.story_time;
  if (!st || !ACCEPTED_PERIOD_SOURCES.has(st.source)) return null;
  return LABEL_TO_KEY.get(st.label) ?? null;
}

/** 條目嘅時期顯示標籤（未判定 → `null`，由呼叫方決定顯示咩）。 */
export function periodLabelOf(entry: ChronicleEntry): string | null {
  const key = periodKeyOf(entry);
  return key ? PERIOD_LABEL[key] : null;
}

/** 排序用：時期次序 index（未判定 → 排最後）。 */
export function periodRank(entry: ChronicleEntry): number {
  const key = periodKeyOf(entry);
  return key ? PERIOD_ORDER.indexOf(key) : PERIOD_ORDER.length;
}

/** 一個時期分群。 */
export interface PeriodGroup {
  /** 時期鍵，或 `UNKNOWN_PERIOD_KEY`。 */
  key: PeriodKey | typeof UNKNOWN_PERIOD_KEY;
  /** 顯示標籤。 */
  label: string;
  /** 該期條目（已按 `sortEntries` 排好）。 */
  items: ChronicleEntry[];
}

/**
 * 條目排序：先時期 → 再首次提及章節 → 再標題。
 *
 * 用 `localeCompare` 排標題係為咗**確定性**（同章同時期嘅條目次序唔可以
 * 隨資料檔次序浮動，否則快照式測試會隨機紅）。
 */
export function sortEntries(entries: readonly ChronicleEntry[]): ChronicleEntry[] {
  return [...entries].sort(
    (a, b) =>
      periodRank(a) - periodRank(b) ||
      a.first_mention_chapter - b.first_mention_chapter ||
      a.title.localeCompare(b.title),
  );
}

/**
 * 按時期分群（空時期唔出 group）。
 *
 * 時期未判定嘅條目一律歸 `_unknown` 且排最後 —— 同 V1 一致。
 */
export function groupByPeriod(entries: readonly ChronicleEntry[]): PeriodGroup[] {
  const sorted = sortEntries(entries);
  const buckets = new Map<string, ChronicleEntry[]>();
  for (const e of sorted) {
    const key = periodKeyOf(e) ?? UNKNOWN_PERIOD_KEY;
    const list = buckets.get(key);
    if (list) list.push(e);
    else buckets.set(key, [e]);
  }

  const out: PeriodGroup[] = [];
  for (const key of PERIOD_ORDER) {
    const items = buckets.get(key);
    if (items?.length) out.push({ key, label: PERIOD_LABEL[key], items });
  }
  const rest = buckets.get(UNKNOWN_PERIOD_KEY);
  if (rest?.length) {
    out.push({ key: UNKNOWN_PERIOD_KEY, label: UNKNOWN_PERIOD_LABEL, items: rest });
  }
  return out;
}

/** 顯示標籤（`_unknown` 都支援）。 */
export function labelForPeriodKey(key: string): string {
  if (key === UNKNOWN_PERIOD_KEY) return UNKNOWN_PERIOD_LABEL;
  return PERIOD_LABEL[key as PeriodKey] ?? UNKNOWN_PERIOD_LABEL;
}

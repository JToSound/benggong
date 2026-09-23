/**
 * B3 Data Adapter — 搜尋索引（`src/data/searchIndex.ts`）
 *
 * 對應 IA §8：**5 類**（character / zone / location / event / chapter）、
 * **移除硬上限 50**、響應時間 **≤150 ms**（rendering spec §6.2）。
 *
 * 為何係「倒排」而唔係線性掃描
 * ---------------------------
 * A8 P2 實測：線性掃 330 角色 + 1,796 event + 704 location 每查詢 0.55–0.92 ms，
 * 遠低於 150 ms。但 spec §2.3 要求**建立索引**（唔可以 component 每次掃 raw array），
 * 而且資料會增長。所以呢度建**單字倒排索引**：
 *
 *   postings: Map<單字, entry index[]>      ← CJK 字 / ASCII 小寫字母數字
 *
 * 查詢流程：揀 query 之中**最稀有**嘅字攞 posting 做候選 → 套 kind 過濾 →
 * `String.includes()` 覆核。覆核保證**正確性**（倒排只係加速，唔會漏）。
 *
 * 為何唔用 bigram：實測 text 合計 ~53 萬字元，bigram postings 會多一個數量級
 * （~10–20 MB heap），而單字倒排已經足夠（見交付報告實測延遲）。
 */

import type { SearchEntry, SearchKind, SearchResult } from "../types/state";
import type {
  ChapterSummaries,
  CharacterRecord,
  EventFeature,
  LocationFeature,
  ZoneFeature,
} from "../types/dataset";
import { zoneTypeOf, ZONE_TYPE_LABEL } from "./adapter/normalize";

export interface SearchIndexData {
  /** 扁平、穩定次序（character → zone → location → event → chapter）。 */
  entries: SearchEntry[];
  /** kind → `entries` 嘅 index 清單（升序）。 */
  byKind: ReadonlyMap<SearchKind, readonly number[]>;
  /** 單字倒排：CJK 字／ASCII 小寫字母數字 → `entries` 嘅 index 清單（升序）。 */
  postings: ReadonlyMap<string, readonly number[]>;
  /** 建構時間（ms）。 */
  buildMs: number;
}

export interface SearchIndexInput {
  zones: ZoneFeature[];
  events: EventFeature[];
  locations: LocationFeature[];
  characters: CharacterRecord[];
  chapterSummaries: ChapterSummaries;
}

/** 由字串抽出「可索引嘅單字」：CJK 字逐個、ASCII 字母數字逐個（已 lowercase）。 */
function indexableChars(text: string): Set<string> {
  const out = new Set<string>();
  for (const ch of text) {
    // 只索引「有意義」嘅字：CJK、拉丁字母、數字。標點／空白唔索引（慳位）。
    if (/[\p{Script=Han}\p{L}\p{N}]/u.test(ch)) out.add(ch);
  }
  return out;
}

/**
 * 建搜尋索引（純函數；`performance.now()` 量度建構時間）。
 */
export function buildSearchIndex(input: SearchIndexInput): SearchIndexData {
  const t0 = performance.now();
  const entries: SearchEntry[] = [];

  for (const c of input.characters) {
    entries.push({
      kind: "character",
      id: c.id,
      label: c.name,
      sublabel: c.role,
      text: `${c.name} ${(c.aliases ?? []).join(" ")} ${c.role} ${c.description}`.toLowerCase(),
    });
  }
  for (const z of input.zones) {
    const t = zoneTypeOf(z);
    const label = ZONE_TYPE_LABEL[t];
    entries.push({
      kind: "zone",
      id: z.properties.id,
      label: z.properties.name,
      sublabel: label,
      text: `${z.properties.name} ${(z.properties.aliases ?? []).join(" ")} ${label}`.toLowerCase(),
    });
  }
  for (const l of input.locations) {
    entries.push({
      kind: "location",
      id: l.properties.id,
      label: l.properties.display_name || l.properties.name,
      sublabel: l.properties.location_type,
      text: `${l.properties.name} ${l.properties.display_name} ${l.properties.location_type} ${l.properties.description}`.toLowerCase(),
    });
  }
  for (const e of input.events) {
    entries.push({
      kind: "event",
      id: e.properties.id,
      label: e.properties.title,
      sublabel: `第 ${e.properties.chapter} 章`,
      text: `${e.properties.title} ${e.properties.description}`.toLowerCase(),
    });
  }
  const summaries = input.chapterSummaries ?? {};
  for (const key of Object.keys(summaries)) {
    const n = Number.parseInt(key, 10);
    if (!Number.isFinite(n)) continue;
    const first = summaries[n]?.locations?.[0];
    entries.push({
      kind: "chapter",
      id: `ch_${n}`,
      label: `第 ${n} 章`,
      sublabel: first?.name ?? "",
      text: `第 ${n} 章 ${first?.name ?? ""} ${first?.summary ?? ""}`.toLowerCase(),
    });
  }

  // ── byKind（升序 index 清單） ──
  const byKind = new Map<SearchKind, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const k = entries[i].kind;
    const list = byKind.get(k);
    if (list) list.push(i);
    else byKind.set(k, [i]);
  }

  // ── 單字倒排（升序 index 清單） ──
  const postings = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i++) {
    for (const ch of indexableChars(entries[i].text)) {
      const list = postings.get(ch);
      if (list) list.push(i);
      else postings.set(ch, [i]);
    }
  }

  return { entries, byKind, postings, buildMs: performance.now() - t0 };
}

/**
 * 5 類搜尋。**冇硬上限**。
 *
 * 演算法：揀 query 之中最稀有嘅字攞 posting 做候選 → 套 kind 過濾 →
 * `includes()` 覆核。結果次序 = `entries` 次序（穩定、確定性）。
 */
export function searchSearchIndex(
  index: SearchIndexData,
  kind: SearchKind | null,
  query: string,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const kindIndices = kind ? index.byKind.get(kind) : undefined;
  if (kind && !kindIndices) return [];

  // 揀最稀有嘅字（posting 最短）；有任何一個字唔存在 → 冇任何 entry 可能命中。
  let rare: readonly number[] | null = null;
  for (const ch of new Set(q)) {
    if (!/[\p{Script=Han}\p{L}\p{N}]/u.test(ch)) continue; // 標點／空白唔喺倒排
    const posting = index.postings.get(ch);
    if (!posting) return [];
    if (!rare || posting.length < rare.length) rare = posting;
  }
  if (!rare) return []; // query 只有標點／空白

  let pool: readonly number[];
  let kindSet: Set<number> | null = null;
  if (kindIndices && kindIndices.length <= rare.length) {
    pool = kindIndices;
  } else {
    pool = rare;
    if (kindIndices) kindSet = new Set(kindIndices);
  }

  const out: SearchResult[] = [];
  for (const i of pool) {
    if (kindSet && !kindSet.has(i)) continue;
    const e = index.entries[i];
    if (!e.text.includes(q)) continue;
    out.push({ kind: e.kind, id: e.id, label: e.label, sublabel: e.sublabel });
  }
  return out;
}

/** 空索引（載入失敗降級 / 測試用）。 */
export function createEmptySearchIndex(): SearchIndexData {
  return { entries: [], byKind: new Map(), postings: new Map(), buildMs: 0 };
}

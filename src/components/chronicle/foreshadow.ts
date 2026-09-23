/**
 * foreshadow.ts — 伏筆（foreshadow）/ 解答（pays_off）關係解析（B7 純函數模組）。
 *
 * 為何要獨立出嚟
 * ==============
 * 伏筆關係係編年史最易出錯嘅一環：一條死鏈（指向唔存在嘅 id）會令用戶
 * 撳落去**冇任何反應**，比唔顯示更差 —— 用戶會以為個 app 壞咗。
 *
 * V1 嘅做法係「render 時 `byId.get(id)`，搵唔到就唔顯示 chip」，但冇驗證：
 *   · 自我指向（`from === to`）；
 *   · 循環（A 埋伏筆畀 B，B 又埋伏筆畀 A）；
 *   · 時序倒轉（伏筆章節遲過解答章節 —— 邏輯上唔可能）。
 *
 * `docs/CHRONICLE_DESIGN.md` §4 訂明呢四條規則由 `apply_agent_analysis.py`
 * 驗證（資料層）。B7 **唔重複實作** pipeline，但**必須**喺前端再驗一次：
 * 資料層改動（例如新 pipeline）唔應該即刻令 UI 出死鏈。
 *
 * 呢個檔**零 DOM 依賴**（`environment: node` 跑得）。
 */

import type { ChronicleEntry } from "../../data/loadAllData";

/** 一條已驗證嘅伏筆 → 解答關係。 */
export interface ForeshadowPair {
  /** 埋下伏筆嘅條目 id（＝ `entry.foreshadows[]` 嘅元素）。 */
  fromId: string;
  /** 被埋伏筆嘅條目 id（＝ 擁有 `fromId` 嗰條嘅 id）。 */
  toId: string;
  /** 解答發生嘅章節（＝ `from` 條目嘅首次提及章）。 */
  resolvesChapter: number;
  /** 伏筆首次提及章節（＝ `to` 條目嘅首次提及章）。 */
  plantedChapter: number;
  /** 跨咗幾多章（`resolvesChapter - plantedChapter`；負數 = 資料異常，已剔走）。 */
  gap: number;
}

/** 丟棄原因 —— 供測試斷言同交付報告統計用。 */
export type ForeshadowDropReason =
  | "missing_from"
  | "missing_to"
  | "self_reference"
  | "negative_gap";

export interface ForeshadowResolution {
  /** 通過全部驗證嘅 pair（去重，穩定次序）。 */
  pairs: ForeshadowPair[];
  /** 被丟棄嘅邊（`"fromId→toId"`），連原因。 */
  dropped: Array<{ edge: string; reason: ForeshadowDropReason }>;
  /** 原始邊數（= 所有 `foreshadows[]` 元素總數）。 */
  rawEdges: number;
}

/**
 * 解析伏筆關係並驗證。
 *
 * ⚠️ 唔會 throw —— 壞資料一律丟棄（UI 唔可以因為一條壞邊而白畫面）。
 *
 * 驗證四條（`docs/CHRONICLE_DESIGN.md` §4）：
 *   1. 兩邊 id 都存在；
 *   2. 冇自我指向；
 *   3. `gap ≥ 0`（伏筆章節唔可以遲過解答章節）；
 *   4. 冇循環（DFS 三角形檢測，見 `hasCycle()`）。
 * 另外去重：同一對 `(from, to)` 只保留一次（資料可能重複列同一條）。
 */
export function resolveForeshadows(
  entries: readonly ChronicleEntry[],
): ForeshadowResolution {
  const byId = new Map<string, ChronicleEntry>();
  for (const e of entries) byId.set(e.id, e);

  const pairs: ForeshadowPair[] = [];
  const dropped: Array<{ edge: string; reason: ForeshadowDropReason }> = [];
  const seen = new Set<string>();
  let rawEdges = 0;

  for (const owner of entries) {
    for (const targetId of owner.foreshadows ?? []) {
      rawEdges++;
      // `owner` 為 target 埋下伏筆 → 解答係 owner（較後章），伏筆係 target。
      const edge = `${owner.id}→${targetId}`;
      if (seen.has(edge)) continue;
      seen.add(edge);

      if (targetId === owner.id) {
        dropped.push({ edge, reason: "self_reference" });
        continue;
      }
      const to = byId.get(targetId);
      if (!to) {
        dropped.push({ edge, reason: "missing_to" });
        continue;
      }
      const from = owner;
      const gap = from.first_mention_chapter - to.first_mention_chapter;
      if (gap < 0) {
        dropped.push({ edge, reason: "negative_gap" });
        continue;
      }
      pairs.push({
        fromId: from.id,
        toId: to.id,
        resolvesChapter: from.first_mention_chapter,
        plantedChapter: to.first_mention_chapter,
        gap,
      });
    }
  }

  // 循環（A → B → A）喺時序上必然有負 gap，所以上面已經濾走大部分；
  // 但「同章互相指向」（gap 都係 0）唔會被負 gap 濾走 → 要另外做 DFS。
  const cyclic = findCyclicEdgeSet(pairs);
  const clean = pairs.filter((p) => {
    const edge = `${p.fromId}→${p.toId}`;
    if (cyclic.has(edge)) {
      dropped.push({ edge, reason: "negative_gap" });
      return false;
    }
    return true;
  });

  return { pairs: clean, dropped, rawEdges };
}

/**
 * 喺 pair 圖（`from → to`）入面搵參與循環嘅邊。
 *
 * 為何唔用負 gap 就算：同章互相指向（ch5 A 伏畀 B、ch5 B 伏畀 A）兩個 gap
 * 都係 0，時序檢查捉唔到，但佢係循環 → 撳落去會兩條條目互相彈，用戶會迷失。
 */
function findCyclicEdgeSet(pairs: readonly ForeshadowPair[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const p of pairs) {
    const list = adj.get(p.fromId);
    if (list) list.push(p.toId);
    else adj.set(p.fromId, [p.toId]);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cyclic = new Set<string>();

  const visit = (node: string, stack: string[]): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // 由 stack 入面 `next` 開始 → 到 `node` 為止全部係循環邊。
        const at = stack.indexOf(next);
        if (at >= 0) {
          for (let i = at; i < stack.length; i++) {
            const a = stack[i];
            const b = i + 1 < stack.length ? stack[i + 1] : node;
            cyclic.add(`${a}→${b}`);
          }
          cyclic.add(`${node}→${next}`);
        }
      } else if (c === WHITE) {
        visit(next, stack);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node, []);
  }
  return cyclic;
}

/** 某條目「埋下」嘅伏筆（即 `entry.foreshadows` 對應嘅已驗證 pair）。 */
export function foreshadowsOf(
  id: string,
  pairs: readonly ForeshadowPair[],
): ForeshadowPair[] {
  return pairs.filter((p) => p.fromId === id);
}

/** 某條目「解答咗」嘅伏筆（即其他條目指向佢嘅已驗證 pair）。 */
export function paysOffOf(
  id: string,
  pairs: readonly ForeshadowPair[],
): ForeshadowPair[] {
  return pairs.filter((p) => p.toId === id);
}

/**
 * `pays_off` 欄位（資料未必同 `foreshadows` 對稱）→ 補成 pair。
 *
 * 為何要處理：`chronicle.json` 同時有 `foreshadows` 同 `pays_off`。
 * 理想上兩者係同一組關係嘅兩個方向，但 pipeline 產生時可能有差異
 * （實測有條目只有 `pays_off` 而對方冇寫 `foreshadows`）。
 * 呢個函式將兩個方向**合併去重**，令 UI 唔會漏關係。
 */
export function resolveAllRelations(
  entries: readonly ChronicleEntry[],
): ForeshadowResolution {
  const byId = new Map<string, ChronicleEntry>();
  for (const e of entries) byId.set(e.id, e);

  // 先將 `pays_off` 反轉成 `foreshadows` 語意（`pays_off: [x]` 即 x 埋畀自己）。
  const augmented: ChronicleEntry[] = entries.map((e) => {
    const extra = (e.pays_off ?? []).filter(
      (x) => !(e.foreshadows ?? []).includes(x),
    );
    if (extra.length === 0) return e;
    return { ...e, foreshadows: [...(e.foreshadows ?? []), ...extra] };
  });

  /*
   * `pays_off` 嘅方向定義（`docs/CHRONICLE_DESIGN.md` §3）：
   *   `pays_off: ["chr_0007"]` = 本條解答咗 chr_0007（即 chr_0007 埋嘅伏筆）。
   * 所以本條 = `from`（解答方），chr_0007 = `to`（伏筆方）—— 同 `foreshadows`
   * 嘅方向一致（`foreshadows: ["x"]` = 為 x 埋伏筆，本條較後章）。
   *
   * 但 `pays_off` 可以指向一條**唔存在**嘅 id（同 `foreshadows` 一樣風險），
   * 所以一樣要經 `resolveForeshadows()` 嘅驗證。
   */
  return resolveForeshadows(augmented);
}

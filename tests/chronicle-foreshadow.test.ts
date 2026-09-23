/**
 * chronicle-foreshadow.test.ts — B7 伏筆（foreshadow）關係解析契約
 *
 * 為何要呢個檔
 * ============
 * 伏筆關係係編年史最易出錯嘅一環。一條**死鏈**（指向唔存在嘅 id）會令
 * 用戶撳落去冇反應 —— 比唔顯示更差（用戶會以為 app 壞咗）。
 *
 * `docs/CHRONICLE_DESIGN.md` §4 訂咗四條治理規則（由 pipeline 驗）：
 *   1. id 存在；2. 冇自我指向；3. 伏筆章節唔遲過解答章節；4. 冇循環。
 *
 * B7 喺前端**再驗一次**：資料層改動（新 pipeline）唔應該即刻令 UI 出死鏈。
 * 呢個檔就係嗰個「再驗」嘅規格。
 *
 * ⚠️ 全部係純函數 → `environment: node` 直接測得到。
 */

import { describe, expect, it } from "vitest";

import {
  foreshadowsOf,
  paysOffOf,
  resolveAllRelations,
  resolveForeshadows,
} from "../src/components/chronicle/foreshadow";
import type { ChronicleEntry, ChronicleDoc } from "../src/data/loadAllData";

function entry(over: Partial<ChronicleEntry> & { id: string }): ChronicleEntry {
  return {
    title: over.id,
    summary: "",
    story_time: { order: 1, label: "爆發初期", source: "llm_period" },
    first_mention_chapter: 1,
    chapters: [{ chapter: over.first_mention_chapter ?? 1, role: "first_mention" }],
    foreshadows: [],
    pays_off: [],
    location_id: null,
    location_name: null,
    characters: [],
    confidence: 0.8,
    source_event_ids: [],
    review_status: "approved",
    ...over,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   1. 四條驗證規則
   ───────────────────────────────────────────────────────────────────────── */

describe("伏筆關係驗證（四條治理規則）", () => {
  it("正常 pair 保留，gap 計得正確", () => {
    const entries = [
      entry({ id: "early", first_mention_chapter: 5 }),
      entry({ id: "late", first_mention_chapter: 40, foreshadows: ["early"] }),
    ];
    const { pairs } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      fromId: "late",
      toId: "early",
      plantedChapter: 5,
      resolvesChapter: 40,
      gap: 35,
    });
  });

  it("規則 1a：from 唔存在 → 丟棄（missing_to 由 owner 角度）", () => {
    const entries = [entry({ id: "solo" })];
    const { pairs, dropped } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(0);
    expect(dropped).toHaveLength(0); // solo 冇 foreshadows 邊
  });

  it("規則 1b：目標唔存在 → 丟棄，原因 missing_to", () => {
    const entries = [entry({ id: "a", foreshadows: ["ghost"] })];
    const { pairs, dropped } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(0);
    expect(dropped).toEqual([{ edge: "a→ghost", reason: "missing_to" }]);
  });

  it("規則 2：自我指向 → 丟棄，原因 self_reference", () => {
    const entries = [entry({ id: "a", foreshadows: ["a"] })];
    const { pairs, dropped } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(0);
    expect(dropped).toEqual([{ edge: "a→a", reason: "self_reference" }]);
  });

  it("規則 3：負 gap（伏筆章節遲過解答章節）→ 丟棄", () => {
    const entries = [
      entry({ id: "early", first_mention_chapter: 10, foreshadows: ["late"] }),
      entry({ id: "late", first_mention_chapter: 50 }),
    ];
    const { pairs, dropped } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(0);
    expect(dropped[0].reason).toBe("negative_gap");
  });

  it("規則 3：gap === 0（同章）→ 保留（唔係負數）", () => {
    const entries = [
      entry({ id: "a", first_mention_chapter: 7, foreshadows: ["b"] }),
      entry({ id: "b", first_mention_chapter: 7 }),
    ];
    const { pairs } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].gap).toBe(0);
  });

  it("規則 4：兩條互相指向（2-循環）→ 全部丟棄", () => {
    const entries = [
      entry({ id: "a", first_mention_chapter: 8, foreshadows: ["b"] }),
      entry({ id: "b", first_mention_chapter: 8, foreshadows: ["a"] }),
    ];
    const { pairs, dropped } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(0);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
  });

  it("規則 4：3-循環 → 全部丟棄", () => {
    const entries = [
      entry({ id: "a", first_mention_chapter: 3, foreshadows: ["b"] }),
      entry({ id: "b", first_mention_chapter: 3, foreshadows: ["c"] }),
      entry({ id: "c", first_mention_chapter: 3, foreshadows: ["a"] }),
    ];
    const { pairs } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(0);
  });

  it("冇循環嘅鏈（A→B→C）全部保留", () => {
    const entries = [
      entry({ id: "a", first_mention_chapter: 30, foreshadows: ["b"] }),
      entry({ id: "b", first_mention_chapter: 20, foreshadows: ["c"] }),
      entry({ id: "c", first_mention_chapter: 10 }),
    ];
    const { pairs } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(2);
  });

  it("重複邊去重", () => {
    const entries = [
      entry({ id: "a", first_mention_chapter: 5, foreshadows: ["b", "b"] }),
      entry({ id: "b", first_mention_chapter: 1 }),
    ];
    const { pairs, rawEdges } = resolveForeshadows(entries);
    expect(pairs).toHaveLength(1);
    expect(rawEdges).toBe(2);
  });

  it("pair 數永遠 ≤ 原始邊數（唔可以無中生有）", () => {
    const entries = [
      entry({ id: "a", first_mention_chapter: 5, foreshadows: ["b", "ghost", "a"] }),
      entry({ id: "b", first_mention_chapter: 1 }),
    ];
    const { pairs, rawEdges } = resolveForeshadows(entries);
    expect(pairs.length).toBeLessThanOrEqual(rawEdges);
    expect(rawEdges).toBe(3);
    expect(pairs).toHaveLength(1);
  });

  it("空輸入 → 空結果（唔會 throw）", () => {
    expect(() => resolveForeshadows([])).not.toThrow();
    expect(resolveForeshadows([]).pairs).toEqual([]);
  });

  it("壞資料（undefined foreshadows）唔會 throw", () => {
    const bad = { ...entry({ id: "a" }), foreshadows: undefined } as unknown as ChronicleEntry;
    expect(() => resolveForeshadows([bad])).not.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   2. 查詢方向（foreshadowsOf / paysOffOf）
   ───────────────────────────────────────────────────────────────────────── */

describe("伏筆方向查詢", () => {
  const entries = [
    entry({ id: "plant", first_mention_chapter: 2 }),
    entry({ id: "resolve", first_mention_chapter: 42, foreshadows: ["plant"] }),
  ];
  const { pairs } = resolveForeshadows(entries);

  it("foreshadowsOf(resolve) → 一條（呢條埋下伏筆）", () => {
    expect(foreshadowsOf("resolve", pairs)).toHaveLength(1);
    expect(foreshadowsOf("resolve", pairs)[0].toId).toBe("plant");
  });

  it("foreshadowsOf(plant) → 冇（plant 冇埋任何伏筆）", () => {
    expect(foreshadowsOf("plant", pairs)).toHaveLength(0);
  });

  it("paysOffOf(plant) → 一條（呢條被解答）", () => {
    expect(paysOffOf("plant", pairs)).toHaveLength(1);
    expect(paysOffOf("plant", pairs)[0].fromId).toBe("resolve");
  });

  it("paysOffOf(resolve) → 冇", () => {
    expect(paysOffOf("resolve", pairs)).toHaveLength(0);
  });

  it("唔存在嘅 id → 空（唔會 throw）", () => {
    expect(foreshadowsOf("nope", pairs)).toEqual([]);
    expect(paysOffOf("nope", pairs)).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   3. resolveAllRelations（foreshadows + pays_off 合併）
   ───────────────────────────────────────────────────────────────────────── */

describe("resolveAllRelations —— 合併 foreshadows 同 pays_off", () => {
  it("只有 pays_off 嘅關係都會被捕捉", () => {
    const entries = [
      entry({ id: "plant", first_mention_chapter: 3 }),
      entry({ id: "resolve", first_mention_chapter: 30, pays_off: ["plant"] }),
    ];
    const { pairs } = resolveAllRelations(entries);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ fromId: "resolve", toId: "plant", gap: 27 });
  });

  it("兩邊都寫同一關係 → 唔會重複", () => {
    const entries = [
      entry({ id: "plant", first_mention_chapter: 3 }),
      entry({
        id: "resolve",
        first_mention_chapter: 30,
        foreshadows: ["plant"],
        pays_off: ["plant"],
      }),
    ];
    const { pairs } = resolveAllRelations(entries);
    expect(pairs).toHaveLength(1);
  });

  it("pays_off 指向唔存在 id → 丟棄", () => {
    const entries = [entry({ id: "a", pays_off: ["ghost"] })];
    const { pairs, dropped } = resolveAllRelations(entries);
    expect(pairs).toHaveLength(0);
    expect(dropped.some((d) => d.reason === "missing_to")).toBe(true);
  });

  it("唔改輸入物件（純函數）", () => {
    const entries = [
      entry({ id: "a", first_mention_chapter: 20, pays_off: ["b"] }),
      entry({ id: "b", first_mention_chapter: 1 }),
    ];
    const before = JSON.stringify(entries);
    resolveAllRelations(entries);
    expect(JSON.stringify(entries)).toBe(before);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   4. 真實資料（`data/public/chronicle.json`）
   ───────────────────────────────────────────────────────────────────────── */

describe("真實 chronicle.json 嘅伏筆", () => {
  async function load(): Promise<ChronicleDoc> {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync("data/public/chronicle.json", "utf8")) as ChronicleDoc;
  }

  it("解析唔會 throw，而且每一條 pair 都指向真實條目", async () => {
    const doc = await load();
    const { pairs } = resolveAllRelations(doc.entries);
    const ids = new Set(doc.entries.map((e) => e.id));
    for (const p of pairs) {
      expect(ids.has(p.fromId)).toBe(true);
      expect(ids.has(p.toId)).toBe(true);
      expect(p.fromId).not.toBe(p.toId);
      expect(p.gap).toBeGreaterThanOrEqual(0);
    }
  });

  it("原始邊數等於資料檔嘅 foreshadows + 獨有 pays_off 邊數", async () => {
    const doc = await load();
    const { rawEdges } = resolveAllRelations(doc.entries);
    let expected = 0;
    for (const e of doc.entries) {
      expected += (e.foreshadows ?? []).length;
      expected += (e.pays_off ?? []).filter(
        (x) => !(e.foreshadows ?? []).includes(x),
      ).length;
    }
    expect(rawEdges).toBe(expected);
  });

  it("pair 數 ≤ 原始邊數", async () => {
    const doc = await load();
    const { pairs, rawEdges } = resolveAllRelations(doc.entries);
    expect(pairs.length).toBeLessThanOrEqual(rawEdges);
  });
});

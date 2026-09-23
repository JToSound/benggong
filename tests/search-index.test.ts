/**
 * B3 Data Adapter — 搜尋索引測試（IA §8）
 *
 * 覆蓋：
 *  - 5 個 kind 全部有結果（character / zone / location / event / chapter）
 *  - **冇硬上限 50**（回傳全部符合項）
 *  - 倒排結果同線性掃描**逐個比對**（正確性證明）
 *  - 響應時間 **≤150 ms**（benchmark，唔靠人手量度）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadWorldData, type World } from "../src/data/adapter";
import { searchSearchIndex, type SearchIndexData } from "../src/data/searchIndex";
import type { SearchKind } from "../src/types/state";

const DATA_DIR = join(__dirname, "..", "public", "data", "public");

function recordingFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const file = url.split("/").pop() ?? "";
    const body = readFileSync(join(DATA_DIR, file));
    const ct = file.endsWith(".geojson") ? "application/geo+json" : "application/json";
    return new Response(body, { status: 200, headers: { "content-type": ct } });
  }) as unknown as typeof fetch;
}

/** 線性掃描（ground truth）。 */
function bruteForce(index: SearchIndexData, kind: SearchKind | null, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return index.entries
    .filter((e) => (!kind || e.kind === kind) && e.text.includes(q))
    .map((e) => e.id);
}

const KINDS: SearchKind[] = ["character", "zone", "location", "event", "chapter"];
const QUERIES = ["病", "大本營", "將軍澳", "商場", "病毒", "第 1 章", "夏晴", "A隊", "TKO", "地鐵"];

describe("B3 searchIndex：結構", () => {
  let world: World;
  beforeAll(async () => {
    world = await loadWorldData({ fetchImpl: recordingFetch() });
  });

  it("entries = 330 + 48 + 704 + 1796 + 195 = 3,073；次序穩定", () => {
    const idx = world.indexes.search;
    expect(idx.entries).toHaveLength(3073);
    // 次序：character → zone → location → event → chapter
    const seen: string[] = [];
    for (const e of idx.entries) if (seen[seen.length - 1] !== e.kind) seen.push(e.kind);
    expect(seen).toEqual(["character", "zone", "location", "event", "chapter"]);
  });

  it("byKind 5 類齊全，size 正確", () => {
    const idx = world.indexes.search;
    expect([...idx.byKind.keys()].sort()).toEqual([...KINDS].sort());
    expect(idx.byKind.get("character")).toHaveLength(330);
    expect(idx.byKind.get("zone")).toHaveLength(48);
    expect(idx.byKind.get("location")).toHaveLength(704);
    expect(idx.byKind.get("event")).toHaveLength(1796);
    expect(idx.byKind.get("chapter")).toHaveLength(195);
  });

  it("倒排 postings 真係亞線性（罕見字嘅 posting 遠短過 entries）", () => {
    const idx = world.indexes.search;
    const rare = idx.postings.get("巢");
    expect(rare, "『巢』應該喺倒排").toBeTruthy();
    expect(rare!.length).toBeLessThan(idx.entries.length / 10);
    expect(idx.buildMs).toBeGreaterThanOrEqual(0);
  });
});

describe("B3 searchIndex：5 類都有結果", () => {
  let idx: SearchIndexData;
  beforeAll(async () => {
    const world = await loadWorldData({ fetchImpl: recordingFetch() });
    idx = world.indexes.search;
  });

  it("每個 kind：用該類第一筆嘅 label 查，命中且 kind 正確", () => {
    for (const kind of KINDS) {
      const first = idx.entries.find((e) => e.kind === kind)!;
      expect(first, `${kind} 應該有 entry`).toBeTruthy();
      const q = first.label.slice(0, 2);
      const results = searchSearchIndex(idx, kind, q);
      expect(results.length, `${kind} 查「${q}」應該有結果`).toBeGreaterThan(0);
      expect(results.every((r) => r.kind === kind)).toBe(true);
      expect(results.some((r) => r.id === first.id), `${kind} 應命中 ${first.id}`).toBe(true);
    }
  });

  it("zone kind 命中『大本營』", () => {
    const results = searchSearchIndex(idx, "zone", "大本營");
    expect(results.map((r) => r.label)).toContain("大本營");
    expect(results.every((r) => r.kind === "zone")).toBe(true);
  });

  it("chapter kind 命中『第 1 章』", () => {
    const results = searchSearchIndex(idx, "chapter", "第 1 章");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("ch_1");
  });

  it("空 query → []", () => {
    expect(searchSearchIndex(idx, null, "")).toEqual([]);
    expect(searchSearchIndex(idx, null, "   ")).toEqual([]);
  });

  it("唔存在嘅字 → []", () => {
    expect(searchSearchIndex(idx, null, "𠮷𠮷")).toEqual([]);
  });
});

describe("B3 searchIndex：冇硬上限 50", () => {
  let idx: SearchIndexData;
  beforeAll(async () => {
    const world = await loadWorldData({ fetchImpl: recordingFetch() });
    idx = world.indexes.search;
  });

  it("查『病』回傳 >50 條（舊版硬上限係 50）", () => {
    const results = searchSearchIndex(idx, null, "病");
    expect(results.length).toBeGreaterThan(50);
    expect(results.length).toBe(bruteForce(idx, null, "病").length);
  });

  it("查『病』(event) 回傳 >50 條", () => {
    const results = searchSearchIndex(idx, "event", "病");
    expect(results.length).toBeGreaterThan(50);
  });
});

describe("B3 searchIndex：正確性（同線性掃描逐個比對）", () => {
  let idx: SearchIndexData;
  beforeAll(async () => {
    const world = await loadWorldData({ fetchImpl: recordingFetch() });
    idx = world.indexes.search;
  });

  it("10 條 query × 6 個 kind 組合，id 序列完全一致", () => {
    for (const q of QUERIES) {
      expect(searchSearchIndex(idx, null, q).map((r) => r.id), `all:「${q}」`).toEqual(bruteForce(idx, null, q));
      for (const kind of KINDS) {
        expect(searchSearchIndex(idx, kind, q).map((r) => r.id), `${kind}:「${q}」`).toEqual(
          bruteForce(idx, kind, q),
        );
      }
    }
  });

  it("label / sublabel 由 entry 原樣帶出", () => {
    const results = searchSearchIndex(idx, "zone", "大本營");
    for (const r of results) {
      const e = idx.entries.find((x) => x.kind === r.kind && x.id === r.id)!;
      expect(r.label).toBe(e.label);
      expect(r.sublabel).toBe(e.sublabel);
    }
  });
});

describe("B3 searchIndex：響應時間 ≤150 ms（benchmark）", () => {
  let idx: SearchIndexData;
  beforeAll(async () => {
    const world = await loadWorldData({ fetchImpl: recordingFetch() });
    idx = world.indexes.search;
  });

  it("每次查詢（最壞情況取最大值）≤150 ms", () => {
    let maxMs = 0;
    let worst = "";
    // 熱身
    for (const q of QUERIES) searchSearchIndex(idx, null, q);
    for (let i = 0; i < 20; i++) {
      for (const q of QUERIES) {
        const t0 = performance.now();
        searchSearchIndex(idx, null, q);
        const dt = performance.now() - t0;
        if (dt > maxMs) {
          maxMs = dt;
          worst = q;
        }
      }
    }
    console.log(`[B3] search 最慢單次查詢 = ${maxMs.toFixed(3)} ms（「${worst}」，200 次取最大）`);
    expect(maxMs).toBeLessThanOrEqual(150);
  });

  it("最壞情況（posting 最長嘅單字）單次查詢 ≤150 ms", () => {
    // 由索引本身揀出「倒排最長」嘅字 —— 呢個係演算法嘅 worst case（候選最多）。
    let worstChar = "";
    let worstLen = 0;
    for (const [ch, list] of idx.postings) {
      if (list.length > worstLen) {
        worstLen = list.length;
        worstChar = ch;
      }
    }
    expect(worstChar).not.toBe("");
    let maxMs = 0;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = searchSearchIndex(idx, null, worstChar);
      maxMs = Math.max(maxMs, performance.now() - t0);
      expect(r.length).toBe(bruteForce(idx, null, worstChar).length);
    }
    console.log(
      `[B3] search worst case「${worstChar}」(posting=${worstLen}) 最慢 = ${maxMs.toFixed(3)} ms`,
    );
    expect(maxMs).toBeLessThanOrEqual(150);
  });

  it("逐字打『將軍澳大本營』6 個 keystroke 合計 ≤150 ms", () => {
    const q = "將軍澳大本營";
    const t0 = performance.now();
    for (let i = 1; i <= q.length; i++) searchSearchIndex(idx, null, q.slice(0, i));
    const total = performance.now() - t0;
    console.log(`[B3] 逐字打「${q}」6 keystroke 合計 = ${total.toFixed(3)} ms`);
    expect(total).toBeLessThanOrEqual(150);
  });
});

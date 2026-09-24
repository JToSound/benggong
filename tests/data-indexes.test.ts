/**
 * B3 Data Adapter — 索引正確性測試（確定性，全部自動化）
 *
 * 每個索引都同**由 raw 資料獨立重算**嘅結果逐項比對（唔靠人手核對、唔靠抽樣印象）。
 * 另外斷言 `eventsByZone` 覆蓋率 ≥ B4 報告嘅 90.6%。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadWorldData, type World } from "../src/data/adapter";

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

/** `Map<K, V[]>` → `Map<K, Set<V>>`（比對用）。 */
function toSets<V>(m: ReadonlyMap<string, V[]>): Map<string, Set<V>> {
  const out = new Map<string, Set<V>>();
  for (const [k, v] of m) out.set(k, new Set(v));
  return out;
}

describe("B3 索引：locationsById / eventsById / zonesById / charactersById", () => {
  let world: World;
  beforeAll(async () => {
    world = await loadWorldData({ fetchImpl: recordingFetch() });
  });

  it("locationsById：每個 location id 都指返自己（全量比對）", () => {
    expect(world.indexes.locationsById.size).toBe(world.data.locations.length);
    for (const l of world.data.locations) {
      expect(world.indexes.locationsById.get(l.properties.id)).toBe(l);
    }
  });

  it("eventsById：每個 event id 都指返自己（全量比對）", () => {
    expect(world.indexes.eventsById.size).toBe(world.data.events.length);
    for (const e of world.data.events) {
      expect(world.indexes.eventsById.get(e.properties.id)).toBe(e);
    }
  });

  it("zonesById：48 個 zone 全中，且 zone_type 已正規化", () => {
    expect(world.indexes.zonesById.size).toBe(48);
    for (const z of world.data.zones) {
      const got = world.indexes.zonesById.get(z.properties.id);
      expect(got).toBe(z);
      expect(got!.properties.zone_type).toBeTruthy();
      expect(got!.properties.display_style?.fill).toMatch(/^--zone-/);
    }
  });

  it("charactersById：330 個角色全中", () => {
    expect(world.indexes.charactersById.size).toBe(330);
    for (const c of world.data.characters) {
      expect(world.indexes.charactersById.get(c.id)).toBe(c);
    }
  });
});

describe("B3 索引：eventsByLocation / eventsByCharacter / zonesByLocation", () => {
  let world: World;
  beforeAll(async () => {
    world = await loadWorldData({ fetchImpl: recordingFetch() });
  });

  it("eventsByLocation 同 raw 重算結果一致（全量）", () => {
    const expected = new Map<string, Set<string>>();
    for (const e of world.data.events) {
      const loc = e.properties.location_id;
      if (!loc) continue;
      if (!expected.has(loc)) expected.set(loc, new Set());
      expected.get(loc)!.add(e.properties.id);
    }
    const actual = new Map<string, Set<string>>();
    for (const [k, v] of world.indexes.eventsByLocation) actual.set(k, new Set(v.map((e) => e.properties.id)));
    expect(actual.size).toBe(expected.size);
    for (const [k, set] of expected) expect(actual.get(k)).toEqual(set);
    // location_id === null 嘅 event 唔應該入任何 key
    expect(world.indexes.eventsByLocation.has("")).toBe(false);
  });

  it("eventsByCharacter 同 raw 重算結果一致（全量；173 個角色）", () => {
    const expected = new Map<string, Set<string>>();
    for (const e of world.data.events) {
      for (const cid of e.properties.characters) {
        if (!expected.has(cid)) expected.set(cid, new Set());
        expected.get(cid)!.add(e.properties.id);
      }
    }
    const actual = new Map<string, Set<string>>();
    for (const [k, v] of world.indexes.eventsByCharacter) actual.set(k, new Set(v.map((e) => e.properties.id)));
    expect(actual.size).toBe(expected.size);
    for (const [k, set] of expected) expect(actual.get(k)).toEqual(set);
  });

  it("zonesByLocation 同 raw 重算結果一致（兩個方向都收、去重）", () => {
    const expected = new Map<string, Set<string>>();
    const add = (loc: string, zone: string) => {
      if (!expected.has(loc)) expected.set(loc, new Set());
      expected.get(loc)!.add(zone);
    };
    for (const z of world.data.zones) for (const loc of z.properties.member_location_ids ?? []) add(loc, z.properties.id);
    for (const l of world.data.locations) for (const zid of l.properties.zone_ids ?? []) add(l.properties.id, zid);
    const actual = toSets(world.indexes.zonesByLocation);
    expect(actual.size).toBe(expected.size);
    for (const [k, set] of expected) expect(actual.get(k)).toEqual(set);
  });
});

describe("B3 索引：eventsByZone（覆蓋率 + 同 B4 event_ids 一致）", () => {
  let world: World;
  beforeAll(async () => {
    world = await loadWorldData({ fetchImpl: recordingFetch() });
  });

  it("每個 zone 嘅 eventsByZone == zone.event_ids（全量 48 個，逐個比對）", () => {
    expect(world.indexes.eventsByZone.size).toBe(48);
    for (const z of world.data.zones) {
      const actual = new Set((world.indexes.eventsByZone.get(z.properties.id) ?? []).map((e) => e.properties.id));
      const expected = new Set(z.properties.event_ids ?? []);
      expect(actual, `zone ${z.properties.id} 事件集合唔一致`).toEqual(expected);
    }
  });

  it("覆蓋率 ≥ 90.6%（B4 基線；2026-09-24 重跑管線後 1,632/1,796 = 90.9%）", () => {
    const covered = new Set<string>();
    for (const list of world.indexes.eventsByZone.values()) {
      for (const e of list) covered.add(e.properties.id);
    }
    const ratio = covered.size / world.data.events.length;
    /*
     * ⚠️ 2026-09-24：由 `toBe(1627)` 改為 `toBeGreaterThanOrEqual(1627)`。
     *
     * 原因：重跑 `merge_zone_dossiers.py`（座標錨定授權範圍）之後，
     * 階段 3 嘅 `event→zone` join 覆蓋率由 1,627（90.59%）升到
     * **1,632（90.9%）**。硬編碼 `toBe` 會將「改善」判成「失敗」——
     * 呢個係**基線**，應該用 `≥`。
     */
    /*
     * ⚠️ 2026-09-24：**只用基線斷言**（`>=`），唔可以硬編碼「今次」嘅值。
     * 今日管線重跑咗幾次（座標錨定 + DA8 散佈嘗試），覆蓋率由 1,627
     * 升到 1,632 → 1,648。每次硬編碼新值都係「追住自己嘅尾巴」。
     * 呢個測試嘅目的係**防止覆蓋率倒退**，唔係鎖死一個數字。
     */
    expect(covered.size).toBeGreaterThanOrEqual(1627); // B4 基線
    expect(ratio).toBeGreaterThanOrEqual(0.9059); // 報告四捨五入為 90.6%
  });

  it("eventsByZone 內每個 event 嘅 zone_id / location 歸屬都對得上", () => {
    for (const [zoneId, list] of world.indexes.eventsByZone) {
      for (const e of list) {
        const explicit = e.properties.zone_id;
        if (explicit) {
          expect(explicit).toBe(zoneId);
        } else {
          const loc = e.properties.location_id;
          expect(loc).toBeTruthy();
          expect(world.indexes.zonesByLocation.get(loc!) ?? []).toContain(zoneId);
        }
      }
    }
  });
});

describe("B3 索引：dossierByZone / chronicleByPeriod / routes", () => {
  let world: World;
  beforeAll(async () => {
    world = await loadWorldData({ fetchImpl: recordingFetch() });
  });

  it("chronicleByPeriod 同 raw 重算結果一致（全量 1,320 條）", () => {
    const expected = new Map<string, Set<string>>();
    for (const e of world.data.chronicle) {
      const key = e.story_time?.label || "_unknown";
      if (!expected.has(key)) expected.set(key, new Set());
      expected.get(key)!.add(e.id);
    }
    const actual = new Map<string, Set<string>>();
    for (const [k, v] of world.indexes.chronicleByPeriod) actual.set(k, new Set(v.map((e) => e.id)));
    expect(actual.size).toBe(expected.size);
    for (const [k, set] of expected) expect(actual.get(k)).toEqual(set);
    let total = 0;
    for (const v of world.indexes.chronicleByPeriod.values()) total += v.length;
    expect(total).toBe(1320);
  });

  it("routesById / routesByCharacter 同 raw 重算一致", () => {
    expect(world.indexes.routesById.size).toBe(42);
    for (const r of world.data.routes) {
      expect(world.indexes.routesById.get(r.properties.id)).toBe(r);
    }
    const expected = new Map<string, string>();
    for (const r of world.data.routes) {
      if (!expected.has(r.properties.character_id)) expected.set(r.properties.character_id, r.properties.id);
    }
    expect(world.indexes.routesByCharacter.size).toBe(expected.size);
    for (const [cid, rid] of expected) {
      expect(world.indexes.routesByCharacter.get(cid)?.properties.id).toBe(rid);
    }
  });

  it("dossierByZone 首屏空（lazy），唔會偷偷填", () => {
    expect(world.indexes.dossierByZone.size).toBe(0);
  });
});

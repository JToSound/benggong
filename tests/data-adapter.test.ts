/**
 * B3 Data Adapter — 契約測試
 *
 * 覆蓋：
 *  - `loadWorldData()` fetch 清單（**唔含** `timeline.json` / `zone-dossiers.json`）
 *  - `dossierByZone` **確實 lazy**（首屏唔載入；載入後就地填充）
 *  - `toWorldIndex()` 滿足 B2 `WorldIndex` 契約
 *  - `normalize.ts` 規則 D4（`resolveCoord` / `hasEvidence`）+ zone v2 fallback
 *  - `AppData` / `loadAllData()` **不變**（靜態斷言，唔靠人手覆核）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadWorldData,
  loadDossiers,
  loadTimeline,
  toWorldIndex,
  selectDossier,
  type World,
} from "../src/data/adapter";
import {
  hasEvidence,
  resolveCoord,
  zoneTypeOf,
  normalizeZone,
  normalizeEvent,
  normalizeLocation,
} from "../src/data/adapter/normalize";
import { resolveMapConfig, DEFAULT_MAP_RUNTIME_CONFIG } from "../src/data/adapter/config";
import type { ZoneFeature } from "../src/types/dataset";

const DATA_DIR = join(__dirname, "..", "public", "data", "public");

/** 記錄請求檔名嘅注入式 fetch（讀真實資料檔，零網絡）。 */
function recordingFetch(): { fetchImpl: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const file = url.split("/").pop() ?? "";
    requested.push(file);
    const body = readFileSync(join(DATA_DIR, file));
    const ct = file.endsWith(".geojson") ? "application/geo+json" : "application/json";
    return new Response(body, { status: 200, headers: { "content-type": ct } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requested };
}

describe("B3 adapter：loadWorldData 契約", () => {
  let world: World;
  let requested: string[];

  beforeAll(async () => {
    const rf = recordingFetch();
    requested = rf.requested;
    world = await loadWorldData({ fetchImpl: rf.fetchImpl });
  });

  it("fetch 清單 = 9 個檔（唔含 timeline.json / zone-dossiers.json）", () => {
    expect([...requested].sort()).toEqual(
      [
        "chapter-appearances.json",
        "chapter-summaries.json",
        "characters.json",
        "chronicle.json",
        "events.geojson",
        "locations.geojson",
        "map-config.json",
        "routes.geojson",
        "zones.geojson",
      ].sort(),
    );
    expect(requested).not.toContain("timeline.json");
    expect(requested).not.toContain("zone-dossiers.json");
  });

  it("正規化後嘅資料集齊全（數量同 asset-manifest 一致）", () => {
    expect(world.data.locations.length).toBe(704);
    expect(world.data.events.length).toBe(1796);
    expect(world.data.routes.length).toBe(42);
    expect(world.data.zones.length).toBe(48);
    expect(world.data.characters.length).toBe(330);
    expect(world.data.chronicle.length).toBe(1320);
    expect(Object.keys(world.data.chapterSummaries).length).toBe(195);
  });

  it("runtime config 由 raw map-config 抽出（唔再由 renderer 自己解析）", () => {
    expect(world.data.runtime.chapterTotal).toBe(198);
    expect(world.data.runtime.coordinateSystem).toBe("EPSG:4326");
    expect(world.data.runtime.projection).toBe("equirectangular");
    expect(world.data.runtime.assetPaths.lodManifest).toBe("assets/map-lod/manifest.json");
  });

  it("索引建構時間有量度（每項 ≥0、總時間 >0、sizes 對得上）", () => {
    const { perIndex, totalMs, sizes } = world.metrics;
    expect(totalMs).toBeGreaterThan(0);
    for (const [name, ms] of Object.entries(perIndex)) {
      expect(ms, `${name} 建構時間`).toBeGreaterThanOrEqual(0);
    }
    expect(sizes.locationsById).toBe(world.indexes.locationsById.size);
    expect(sizes.eventsById).toBe(world.indexes.eventsById.size);
    expect(sizes.zonesById).toBe(48);
    expect(sizes.search).toBe(world.indexes.search.entries.length);

    const rows = Object.entries(perIndex)
      .map(([n, ms]) => `${n}=${ms.toFixed(2)}ms`)
      .join(" ");
    console.log(`[B3] 索引建構：total=${totalMs.toFixed(2)}ms | ${rows}`);
  });
});

describe("B3 adapter：dossierByZone 必須 lazy", () => {
  it("首屏唔載入 dossier：size=0、loaded=false、fetch 清單冇 zone-dossiers.json", async () => {
    const rf = recordingFetch();
    const world = await loadWorldData({ fetchImpl: rf.fetchImpl });
    expect(world.indexes.dossierByZone.size).toBe(0);
    expect(world.dossiers.loaded).toBe(false);
    expect(world.dossiers.loading).toBeNull();
    expect(rf.requested).not.toContain("zone-dossiers.json");
  });

  it("loadDossiers() 之後就地填充同一個 Map（48 個），並 memoize", async () => {
    const rf = recordingFetch();
    const world = await loadWorldData({ fetchImpl: rf.fetchImpl });
    const liveMap = world.indexes.dossierByZone;
    const p1 = loadDossiers(world);
    const p2 = loadDossiers(world);
    expect(p1).toBe(p2); // memoized：同一 Promise
    const byZone = await p1;
    expect(byZone).toBe(liveMap); // 同一個 reference
    expect(byZone.size).toBe(48);
    expect(world.dossiers.loaded).toBe(true);
    expect(rf.requested.filter((f) => f === "zone-dossiers.json")).toHaveLength(1);

    // join key：zone.dossier_id ↔ dossier.id、dossier.zone_id ↔ zone.id
    for (const z of world.data.zones) {
      const d = selectDossier(world, z.properties.id);
      expect(d, `zone ${z.properties.id} 應有 dossier`).not.toBeNull();
      expect(d!.zone_id).toBe(z.properties.id);
      expect(d!.id).toBe(z.properties.dossier_id);
    }
  });

  it("loadTimeline() 按需載入（1,796 條）", async () => {
    const rf = recordingFetch();
    const world = await loadWorldData({ fetchImpl: rf.fetchImpl });
    expect(rf.requested).not.toContain("timeline.json");
    const rows = await loadTimeline(world);
    expect(rows.length).toBe(1796);
    expect(rf.requested).toContain("timeline.json");
  });
});

describe("B3 adapter：toWorldIndex 滿足 B2 契約", () => {
  it("全部必要 key 齊全、map 有值、chapterTotal 正確", async () => {
    const rf = recordingFetch();
    const world = await loadWorldData({ fetchImpl: rf.fetchImpl });
    const wi = toWorldIndex(world);

    expect(wi.chapterTotal).toBe(198);
    expect(wi.zones).toHaveLength(48);
    expect(wi.events).toHaveLength(1796);
    expect(wi.locations).toHaveLength(704);
    expect(wi.routes).toHaveLength(42);
    expect(wi.characters).toHaveLength(330);
    expect(wi.chronicle).toHaveLength(1320);

    expect(wi.zonesById.size).toBe(48);
    expect(wi.eventsById.size).toBe(1796);
    expect(wi.locationsById.size).toBe(704);
    expect(wi.charactersById.size).toBe(330);
    expect(wi.routesById.size).toBe(42);
    expect(wi.routesByCharacter.size).toBeGreaterThan(0);
    expect(wi.eventsByZone.size).toBe(48);
    expect(wi.zonesByLocation.size).toBeGreaterThan(0);
    expect(wi.dossierByZone.size).toBe(0); // lazy
    expect(wi.searchIndex).toHaveLength(330 + 48 + 704 + 1796 + 195);

    // 同一個 reference：B2 selectDossier 唔使改簽名都食到 lazy 結果
    expect(wi.dossierByZone).toBe(world.indexes.dossierByZone);
  });
});

describe("B3 normalize：規則 D4 與 zone v2 fallback", () => {
  it("hasEvidence 認 inferred_from 或 position_source", () => {
    expect(hasEvidence({ inferred_from: "x" })).toBe(true);
    expect(hasEvidence({ position_source: "人手修正" })).toBe(true);
    expect(hasEvidence({})).toBe(false);
  });

  it("resolveCoord 四層：有證據 → raw；人手錨點 → fallback；OSM → full-hk", () => {
    expect(resolveCoord("任何名", 1, 2, { evidenceBacked: true })).toEqual({ lon: 1, lat: 2, source: "raw" });
    expect(resolveCoord("大本營", 1, 2).source).toBe("fallback");
    expect(resolveCoord("大本營", 1, 2)).toEqual({ lon: 114.265, lat: 22.315, source: "fallback" });
    const osm = resolveCoord("又一城 Festival Walk", 1, 2);
    expect(osm.source).toBe("full-hk");
    expect(resolveCoord("完全唔存在嘅名", 9, 8)).toEqual({ lon: 9, lat: 8, source: "raw" });
  });

  it("zone v2：zone_type 缺失時由 kind 確定性推導 + display_style 查表", () => {
    const v1 = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [] },
      properties: { id: "zone_x", name: "測試", kind: "nest", chapters: [3], radius_m: 100, radius_source: "default", source: "bing_gang" },
    } as unknown as ZoneFeature;
    const n = normalizeZone(v1);
    expect(n.properties.zone_type).toBe("infected_nest");
    expect(zoneTypeOf(n)).toBe("infected_nest");
    expect(n.properties.display_style).toEqual({ fill: "--zone-nest", pattern: "hatch", icon: "virus" });
    expect(n.properties.danger_level).toBeNull();
    expect(n.properties.event_ids).toEqual([]);
    expect(n.properties.dossier_id).toBeNull();
    expect(n.properties.zone_review_status).toBe("needs_validation");
    // 唔 mutate 輸入
    expect((v1.properties as { zone_type?: string }).zone_type).toBeUndefined();
  });

  it("event：zone_id 補 null；location：zone_ids 補 []", () => {
    const ev = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { id: "e", title: "t", description: "d", chapter: 1, characters: [], event_type: "minor", spoiler_level: 1, location_id: null, confidence: 1, review_status: "reviewed", source: "bing_gang" },
    } as unknown as Parameters<typeof normalizeEvent>[0];
    expect(normalizeEvent(ev).properties.zone_id).toBeNull();
    const loc = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { id: "l", name: "n", display_name: "d", location_type: "district", fictional: false, location_precision: "exact", story_position: { x: 0, y: 0 }, description: "", first_appearance: 1, chapters: [], characters: [], confidence: 1, review_status: "reviewed", source: "bing_gang" },
    } as unknown as Parameters<typeof normalizeLocation>[0];
    expect(normalizeLocation(loc).properties.zone_ids).toEqual([]);
  });

  it("resolveMapConfig：缺失值全部有 fallback，唔會 throw", () => {
    expect(resolveMapConfig(null)).toBe(DEFAULT_MAP_RUNTIME_CONFIG);
    const r = resolveMapConfig({} as never);
    expect(r.chapterTotal).toBe(198);
    expect(r.assetPaths.basemapPng).toBeNull();
    expect(r.provisional.enabled).toBe(false);
  });
});

describe("B3 相容性：loadAllData() / AppData 不變（靜態斷言）", () => {
  const src = readFileSync(join(__dirname, "..", "src", "data", "loadAllData.ts"), "utf-8");

  it("簽名不變：export async function loadAllData(): Promise<AppData>", () => {
    expect(src).toMatch(/export async function loadAllData\(\): Promise<AppData>/);
  });

  it("AppData 欄位一個都冇少（14 個）", () => {
    const block = src.match(/export interface AppData \{([\s\S]*?)\n\}/);
    expect(block, "AppData interface 必須存在").toBeTruthy();
    const body = block![1];
    const fields = [
      "config",
      "locations",
      "events",
      "routes",
      "timeline",
      "characters",
      "zones",
      "chronicle",
      "chapterAppearances",
      "chapterSummaries",
      "locationsById",
      "charactersByName",
      "eventsByChapter",
      "routesByChapter",
    ];
    for (const f of fields) {
      expect(body, `AppData 缺少欄位 ${f}`).toMatch(new RegExp(`\\b${f}:`));
    }
  });

  it("timeline 唔再 eager fetch，但欄位保留（值 = 空陣列）", () => {
    // 只可以喺註解提 timeline.json；唔可以有任何 fetch 路徑。
    expect(src).not.toMatch(/base \+ "timeline\.json"/);
    expect(src).not.toMatch(/fetchJSON<[^>]*>\(base \+ "timeline/);
    expect(src).toMatch(/const timeline: TimelineRecord\[\] = \[\];/);
  });

  it("現有 4 個 index 嘅建構規則仍然存在", () => {
    for (const m of [
      "const locationsById = new Map<string, LocationFeature>()",
      "const charactersByName = new Map<",
      "const eventsByChapter = new Map<number, EventFeature[]>()",
      "const routesByChapter = new Map<number, RouteFeature[]>()",
    ]) {
      expect(src, m).toContain(m);
    }
  });
});

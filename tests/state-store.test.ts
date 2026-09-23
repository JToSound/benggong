/**
 * B2 — Store + Selector 契約測試
 *
 * 覆蓋：
 *   - 規則 S1–S4（唯一來源 / DOM 無關 / 只經 action / URL 係投影）
 *   - D2 硬性：`selectVisibleZones` **唔受 chapter 過濾**（48 個 zone 永遠全部）
 *   - emphasis 受 chapter 影響
 *   - spoiler clamp + 持久化（含 localStorage 被停用情境）
 *   - layer flags / error / hydrate 行為
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorldIndex,
  createAppStore,
  createInitialState,
  readSpoilerMax,
  selectChroniclePage,
  selectDossier,
  selectEmphasisZoneIds,
  selectHiddenCount,
  selectRelatedCharacters,
  selectRelatedEvents,
  selectSearchResults,
  selectVisibleEvents,
  selectVisibleZones,
  selectWaypoints,
  writeSpoilerMax,
  type AppState,
  type ChronicleEntry,
  type WorldIndex,
  type WorldSourceData,
} from "../src/state";

// ─────────────────────────────────────────────────────────────────────────────
// 合成世界（48 zone，符合 D2 嘅數量）
// ─────────────────────────────────────────────────────────────────────────────

function makeSource(): WorldSourceData {
  const zones = Array.from({ length: 48 }, (_, i) => {
    const kind = i < 11 ? "survivor" : i < 32 ? "nest" : "outpost";
    return {
      type: "Feature" as const,
      geometry: { type: "Polygon" as const, coordinates: [] },
      properties: {
        id: `z${i}`,
        name: `Zone ${i}`,
        kind: kind as "survivor" | "nest" | "outpost",
        chapters: [((i % 5) + 1) * 10],
        first_appearance: 1,
        radius_m: 100,
        radius_source: "default" as const,
        source: "bing_gang" as const,
      },
    };
  });

  const events = [
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [0, 0] as [number, number] },
      properties: {
        id: "e1",
        title: "事件一",
        description: "描述",
        chapter: 10,
        chapter_name: "第十章",
        chapter_refs: [10],
        characters: ["甲"],
        event_type: "minor" as const,
        spoiler_level: 0 as const,
        location_id: "l1",
        confidence: 1,
        review_status: "verified" as const,
        source: "bing_gang" as const,
      },
    },
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [1, 1] as [number, number] },
      properties: {
        id: "e2",
        title: "事件二",
        description: "高階劇透",
        chapter: 50,
        chapter_name: "第五十章",
        chapter_refs: [50],
        characters: ["乙"],
        event_type: "major" as const,
        spoiler_level: 2 as const,
        location_id: "l2",
        confidence: 1,
        review_status: "verified" as const,
        source: "bing_gang" as const,
      },
    },
  ];

  const locations = [
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [0, 0] as [number, number] },
      properties: {
        id: "l1",
        name: "地點一",
        display_name: "地點一",
        location_type: "district" as const,
        fictional: false,
        location_precision: "district" as const,
        story_position: { x: 0, y: 0 },
        description: "描述",
        first_appearance: 1,
        chapters: [10],
        characters: ["甲"],
        confidence: 1,
        review_status: "verified" as const,
        source: "bing_gang" as const,
        zone_ids: ["z0"],
      },
    },
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [1, 1] as [number, number] },
      properties: {
        id: "l2",
        name: "地點二",
        display_name: "地點二",
        location_type: "district" as const,
        fictional: false,
        location_precision: "district" as const,
        story_position: { x: 1, y: 1 },
        description: "描述",
        first_appearance: 1,
        chapters: [50],
        characters: ["乙"],
        confidence: 1,
        review_status: "verified" as const,
        source: "bing_gang" as const,
        zone_ids: ["z1"],
      },
    },
  ];

  const characters = [
    {
      id: "c1",
      name: "甲",
      aliases: ["A"],
      role: "main" as const,
      color: "#fff",
      first_appearance: 1,
      chapter_refs: [10],
      spoiler_level: 0 as const,
      description: "角色甲",
      confidence: 1,
      review_status: "verified" as const,
      portrait_asset_id: null,
    },
  ];

  const routes = [
    {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [0, 0],
          [1, 1],
        ] as [number, number][],
      },
      properties: {
        id: "r1",
        character_id: "c1",
        character_name: "甲",
        color: "#fff",
        chapters_span: [10, 50] as [number, number],
        precision: "approximate" as const,
        waypoints: [{ location_id: "l1", chapter: 10, note: "起點", confidence: 1 }],
        source: "bing_gang" as const,
        review_status: "verified" as const,
      },
    },
  ];

  const entries: ChronicleEntry[] = Array.from({ length: 60 }, (_, i) => ({
    id: `ce${i}`,
    title: `編年史 ${i}`,
    summary: `摘要 ${i}`,
    story_time: { order: i, label: `時期 ${i}`, source: "ch" },
    first_mention_chapter: i + 1,
    chapters: [{ chapter: i + 1, role: "first_mention" }],
    foreshadows: [],
    pays_off: [],
    location_id: i % 2 === 0 ? "l1" : "l2",
    location_name: i % 2 === 0 ? "地點一" : "地點二",
    characters: ["甲"],
    confidence: 1,
    source_event_ids: ["e1"],
    review_status: "verified",
  }));

  return {
    zones: { type: "FeatureCollection", features: zones },
    events: { type: "FeatureCollection", features: events },
    routes: { type: "FeatureCollection", features: routes },
    locations: { type: "FeatureCollection", features: locations },
    characters,
    chronicle: { entries },
    chapterSummaries: {
      1: { locations: [{ id: "l1", name: "地點一", summary: "第一章摘要", confidence: 1 }] },
      2: { locations: [{ id: "l2", name: "地點二", summary: "第二章摘要", confidence: 1 }] },
    },
    config: { chapters: { total: 198 } },
  };
}

function makeWorld(): WorldIndex {
  return buildWorldIndex(makeSource());
}

// ─────────────────────────────────────────────────────────────────────────────
// localStorage 假物
// ─────────────────────────────────────────────────────────────────────────────

function stubLocalStorage(mode: "ok" | "disabled"): Map<string, string> {
  const bag = new Map<string, string>();
  const impl =
    mode === "ok"
      ? {
          getItem: (k: string) => bag.get(k) ?? null,
          setItem: (k: string, v: string) => {
            bag.set(k, v);
          },
          removeItem: (k: string) => {
            bag.delete(k);
          },
          clear: () => bag.clear(),
          key: () => null,
          length: 0,
        }
      : {
          getItem: () => {
            throw new Error("storage disabled");
          },
          setItem: () => {
            throw new Error("storage disabled");
          },
          removeItem: () => {
            throw new Error("storage disabled");
          },
          clear: () => {
            throw new Error("storage disabled");
          },
          key: () => {
            throw new Error("storage disabled");
          },
          length: 0,
        };
  vi.stubGlobal("localStorage", impl);
  return bag;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

describe("Store — 規則 S1 / S3（唯一來源、只經 action）", () => {
  it("初始 state 符合 spec 預設（D1 / D3 / D4）", () => {
    const store = createAppStore();
    const s = store.getState();
    expect(s.context).toEqual({ kind: "explore" });
    expect(s.chapter).toBe(1);
    expect(s.spoilerMax).toBe(1);
    expect(s.theme).toBe("dark");
    expect(s.view).toBe("map");
    expect(s.sheetSnap).toBe("half");
    expect(s.errors).toEqual([]);
  });

  it("getState() 回傳 frozen 物件（唔可以外部直改）", () => {
    const store = createAppStore();
    const s = store.getState();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.layers)).toBe(true);
    const before = s.chapter;
    try {
      (s as unknown as { chapter: number }).chapter = 999;
    } catch {
      /* strict mode 會 throw —— 兩者都可以接受 */
    }
    expect(store.getState().chapter).toBe(before);
  });

  it("subscribe 收到 (next, prev)，unsubscribe 之後唔再收", () => {
    const store = createAppStore();
    const seen: number[] = [];
    const off = store.subscribe((next) => seen.push(next.chapter));
    store.setChapter(5);
    expect(seen).toEqual([5]);
    off();
    store.setChapter(9);
    expect(seen).toEqual([5]);
  });

  it("訂閱者拋錯唔會拖死其他訂閱者", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createAppStore();
    const seen: number[] = [];
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe((s) => seen.push(s.chapter));
    expect(() => store.setChapter(3)).not.toThrow();
    expect(seen).toEqual([3]);
  });
});

describe("Store — context / chapter / view", () => {
  it("setChapter：clamp 1..chapterTotal，並將 explore 轉做 chapter context", () => {
    const store = createAppStore({ chapterTotal: 198 });
    store.setChapter(150);
    expect(store.getState().chapter).toBe(150);
    expect(store.getState().context).toEqual({ kind: "chapter", issueIndex: 150 });

    store.setChapter(9999);
    expect(store.getState().chapter).toBe(198);
    store.setChapter(-3);
    expect(store.getState().chapter).toBe(1);
  });

  it("setChapter 唔會清走 zone context（dossier 保留）", () => {
    const store = createAppStore();
    store.setContext({ kind: "zone", zoneId: "z1" });
    store.setChapter(50);
    expect(store.getState().context).toEqual({ kind: "zone", zoneId: "z1" });
    expect(store.getState().chapter).toBe(50);
  });

  it("setContext：chronicle → view chronicle；其他 → view map", () => {
    const store = createAppStore();
    store.setContext({ kind: "zone", zoneId: "z1" });
    expect(store.getState().view).toBe("map");

    store.setContext({
      kind: "chronicle",
      filters: {
        chapter: null,
        period: null,
        zoneId: null,
        characterId: null,
        spoilerMax: 1,
        query: "",
      },
    });
    expect(store.getState().view).toBe("chronicle");

    store.setContext({ kind: "event", eventId: "e1" });
    expect(store.getState().view).toBe("map");
  });

  it("setView('chronicle') 令 context 轉做 chronicle；setView('map') 轉返 explore", () => {
    const store = createAppStore();
    store.setView("chronicle");
    expect(store.getState().context.kind).toBe("chronicle");
    store.setView("map");
    expect(store.getState().context.kind).toBe("explore");
  });
});

describe("Store — URL 投影（規則 S4 / U5）", () => {
  it("setContext 用 replace；navigate 用 push", () => {
    const projectUrl = vi.fn();
    const store = createAppStore({ effects: { projectUrl } });

    store.setContext({ kind: "zone", zoneId: "z1" });
    expect(projectUrl).toHaveBeenCalledTimes(1);
    expect(projectUrl.mock.calls[0][1]).toBe("replace");

    store.navigate({ kind: "event", eventId: "e1" });
    expect(projectUrl).toHaveBeenCalledTimes(2);
    expect(projectUrl.mock.calls[1][1]).toBe("push");
  });

  it("setViewport / setSheetSnap / setTheme **唔會**寫 URL", () => {
    const projectUrl = vi.fn();
    const onThemeChange = vi.fn();
    const store = createAppStore({ effects: { projectUrl, onThemeChange } });

    store.setViewport({ x: 1, y: 2, w: 3, h: 4 });
    store.setSheetSnap("peek");
    store.setTheme("light");

    expect(projectUrl).not.toHaveBeenCalled();
    expect(onThemeChange).toHaveBeenCalledWith("light");
    expect(store.getState().theme).toBe("light");
  });

  it("toggleLayer 會寫 URL，且只列非預設值", () => {
    const projectUrl = vi.fn();
    const store = createAppStore({ effects: { projectUrl } });
    store.toggleLayer("routes");
    expect(store.getState().layers.routes).toBe(true);
    expect(projectUrl).toHaveBeenCalledTimes(1);
    store.toggleLayer("events");
    expect(store.getState().layers.events).toBe(false);
    expect(projectUrl).toHaveBeenCalledTimes(2);
  });
});

describe("Store — spoiler 持久化（含 localStorage 被停用）", () => {
  it("setSpoilerMax clamp + 寫入 localStorage", () => {
    const bag = stubLocalStorage("ok");
    const store = createAppStore();
    store.setSpoilerMax(3);
    expect(store.getState().spoilerMax).toBe(3);
    expect(bag.get("binggang-spoiler-max")).toBe("3");

    // 越界值：runtime clamp（型別上唔應該傳，但防禦性處理必須存在）
    store.setSpoilerMax(99 as unknown as 0);
    expect(store.getState().spoilerMax).toBe(3);
    store.setSpoilerMax(-1 as unknown as 0);
    expect(store.getState().spoilerMax).toBe(0);
  });

  it("readSpoilerMax 讀得返持久化值；壞值落回 1", () => {
    const bag = stubLocalStorage("ok");
    bag.set("binggang-spoiler-max", "2");
    expect(readSpoilerMax()).toBe(2);
    bag.set("binggang-spoiler-max", "abc");
    expect(readSpoilerMax()).toBe(1);
    bag.set("binggang-spoiler-max", "9");
    expect(readSpoilerMax()).toBe(1);
  });

  it("localStorage 被停用 → 讀寫都唔會 throw，state 仍然有效", () => {
    stubLocalStorage("disabled");
    expect(() => readSpoilerMax()).not.toThrow();
    expect(readSpoilerMax()).toBe(1);
    expect(() => writeSpoilerMax(3)).not.toThrow();

    const store = createAppStore();
    expect(() => store.setSpoilerMax(2)).not.toThrow();
    expect(store.getState().spoilerMax).toBe(2);
  });
});

describe("Store — errors / hydrate", () => {
  it("pushError 同 code 只保留最新一筆；clearError 清得乾淨", () => {
    const store = createAppStore();
    store.pushError({ code: "basemap-404", message: "底圖載入失敗", retryable: true });
    store.pushError({ code: "basemap-404", message: "底圖載入失敗（重試）" });
    expect(store.getState().errors).toHaveLength(1);
    expect(store.getState().errors[0].message).toContain("重試");

    store.pushError({ code: "data-timeout", message: "資料逾時" });
    expect(store.getState().errors).toHaveLength(2);

    store.clearError("basemap-404");
    expect(store.getState().errors.map((e) => e.code)).toEqual(["data-timeout"]);
    store.clearError();
    expect(store.getState().errors).toEqual([]);
  });

  it("hydrateFromUrl 由 URL 還原 context / chapter / spoiler / layers / view", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectUrl = vi.fn();
    const store = createAppStore({ effects: { projectUrl } });

    const s = store.hydrateFromUrl(
      new URL("http://localhost/?zone=z1&chapter=150&spoiler=0&layers=routes&view=map"),
    );
    expect(s.context).toEqual({ kind: "zone", zoneId: "z1" });
    expect(s.chapter).toBe(150);
    expect(s.spoilerMax).toBe(0);
    expect(s.layers.routes).toBe(true);
    expect(projectUrl).toHaveBeenCalledWith(expect.anything(), "replace");
  });

  it("hydrateFromUrl 接受 legacy #ch= 並 canonicalize", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectUrl = vi.fn();
    const store = createAppStore({ effects: { projectUrl } });
    const s = store.hydrateFromUrl(new URL("http://localhost/#ch=150"));
    expect(s.chapter).toBe(150);
    expect(s.context).toEqual({ kind: "chapter", issueIndex: 150 });
  });

  it("hydrateFromUrl 唔會 throw（極端輸入）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createAppStore();
    for (const raw of ["?chapter=99999", "?spoiler=99", "?view=xyz", "?event=%00", "?zone="]) {
      expect(() => store.hydrateFromUrl(new URL(`http://localhost/${raw}`))).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Selectors
// ─────────────────────────────────────────────────────────────────────────────

describe("Selector — D2 硬性：48 個 zone 永遠全部 render", () => {
  const world = makeWorld();

  it("預設 layers 之下回傳全部 48 個 zone", () => {
    const store = createAppStore();
    expect(selectVisibleZones(store.getState(), world)).toHaveLength(48);
  });

  it("chapter 由 1 掃到 198，長度恆等於 48（唔受 chapter 過濾）", () => {
    const store = createAppStore();
    for (const ch of [1, 2, 50, 100, 150, 197, 198]) {
      store.setChapter(ch);
      const visible = selectVisibleZones(store.getState(), world);
      expect(visible.length, `chapter=${ch} 時應該仍然 48 個`).toBe(48);
    }
  });

  it("layer flags 關掉一層才會減少（zones = 11 個倖存區）", () => {
    const store = createAppStore();
    store.toggleLayer("zones");
    expect(selectVisibleZones(store.getState(), world)).toHaveLength(37);
    store.toggleLayer("nests");
    expect(selectVisibleZones(store.getState(), world)).toHaveLength(16);
    store.toggleLayer("outposts");
    expect(selectVisibleZones(store.getState(), world)).toHaveLength(0);
  });
});

describe("Selector — emphasis / events / hidden count", () => {
  const world = makeWorld();

  it("selectEmphasisZoneIds 受 chapter 影響（唔係 filter）", () => {
    const store = createAppStore();
    store.setChapter(10);
    expect(selectEmphasisZoneIds(store.getState(), world).size).toBe(10);
    store.setChapter(11);
    expect(selectEmphasisZoneIds(store.getState(), world).size).toBe(0);
    store.setChapter(50);
    expect(selectEmphasisZoneIds(store.getState(), world).size).toBe(9);
  });

  it("selectVisibleEvents 受 spoilerMax + chapter 窗口限制", () => {
    const store = createAppStore();
    store.setChapter(10);
    expect(selectVisibleEvents(store.getState(), world).map((e) => e.properties.id)).toEqual([
      "e1",
    ]);
    store.setChapter(50);
    // e2 喺窗口內但 spoiler 2 > 預設 1 → 唔顯示
    expect(selectVisibleEvents(store.getState(), world)).toHaveLength(0);
    store.setSpoilerMax(2);
    expect(selectVisibleEvents(store.getState(), world).map((e) => e.properties.id)).toEqual([
      "e2",
    ]);
  });

  it("selectHiddenCount = spoiler level 高過上限嘅事件數", () => {
    const store = createAppStore();
    expect(selectHiddenCount(store.getState(), world)).toBe(1);
    store.setSpoilerMax(2);
    expect(selectHiddenCount(store.getState(), world)).toBe(0);
    store.setSpoilerMax(0);
    // e1 level 0 唔算「高過 0」；只有 e2（level 2）被隱藏
    expect(selectHiddenCount(store.getState(), world)).toBe(1);
  });
});

describe("Selector — dossier / route / relation / chronicle / search", () => {
  const world = makeWorld();
  const state: AppState = createInitialState();

  it("selectDossier 冇資料回 null（唔會造假）", () => {
    expect(selectDossier("z0", world)).toBeNull();
  });

  it("selectWaypoints 帶地點名（唔顯示原始 id）", () => {
    const wps = selectWaypoints("r1", world);
    expect(wps).toHaveLength(1);
    expect(wps[0].locationName).toBe("地點一");
    expect(selectWaypoints("nope", world)).toEqual([]);
  });

  it("selectRelatedEvents / selectRelatedCharacters 由 zone 反查", () => {
    expect(selectRelatedEvents("z0", world).map((e) => e.properties.id)).toEqual(["e1"]);
    expect(selectRelatedCharacters("z0", world).map((c) => c.id)).toEqual(["c1"]);
    expect(selectRelatedEvents("z99", world)).toEqual([]);
  });

  it("selectChroniclePage 分頁（PAGE_SIZE = 50）", () => {
    const filters = {
      chapter: null,
      period: null,
      zoneId: null,
      characterId: null,
      spoilerMax: 3 as const,
      query: "",
    };
    const page0 = selectChroniclePage(filters, 0, world);
    expect(page0.total).toBe(60);
    expect(page0.items).toHaveLength(50);
    expect(page0.nextCursor).toBe(50);

    const page1 = selectChroniclePage(filters, page0.nextCursor!, world);
    expect(page1.items).toHaveLength(10);
    expect(page1.nextCursor).toBeNull();
  });

  it("selectChroniclePage 支援 chapter / character / zone filter", () => {
    const base = {
      chapter: null,
      period: null,
      zoneId: null,
      characterId: null,
      spoilerMax: 3 as const,
      query: "",
    };
    expect(selectChroniclePage({ ...base, chapter: 1 }, 0, world).total).toBe(1);
    expect(selectChroniclePage({ ...base, characterId: "甲" }, 0, world).total).toBe(60);
    expect(selectChroniclePage({ ...base, characterId: "冇" }, 0, world).total).toBe(0);
    expect(selectChroniclePage({ ...base, zoneId: "z0" }, 0, world).total).toBe(30);
  });

  it("selectSearchResults 5 類、冇硬上限、空 query 回空", () => {
    expect(selectSearchResults(null, "", world)).toEqual([]);
    expect(selectSearchResults("zone", "zone 47", world)).toHaveLength(1);
    expect(selectSearchResults("character", "甲", world)).toHaveLength(1);
    expect(selectSearchResults("event", "事件二", world)).toHaveLength(1);
    expect(selectSearchResults("location", "地點一", world)).toHaveLength(1);
    expect(selectSearchResults("chapter", "第 2 章", world)).toHaveLength(1);
    // kind = null → 跨類
    expect(selectSearchResults(null, "地點一", world).length).toBeGreaterThanOrEqual(2);
  });

  it("state 本身唔會被 selector 改到（純函數）", () => {
    const before = JSON.stringify(state);
    selectVisibleZones(state, world);
    selectEmphasisZoneIds(state, world);
    selectVisibleEvents(state, world);
    selectHiddenCount(state, world);
    expect(JSON.stringify(state)).toBe(before);
  });
});

// 《病港》— 搜尋模組測試
import { describe, expect, it, beforeEach } from "vitest";
import { buildSearchIndex, search } from "../src/lib/search";
import type { BingGangDataset } from "../src/types/dataset";

const mockDataset: BingGangDataset = {
  meta: null,
  locations: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [114.272, 22.332] },
      properties: {
        id: "tko_reference",
        name: "將軍澳",
        display_name: "將軍澳（參考位置）",
        location_type: "district",
        fictional: false,
        location_precision: "district",
        story_position: { x: 0.78, y: 0.55 },
        description: "測試描述",
        first_appearance: 11,
        chapters: [11],
        characters: [],
        confidence: 0.7,
        review_status: "needs_review",
        source: "bing_gang",
      },
    },
  ],
  events: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [114.272, 22.37] },
      properties: {
        id: "bg_event_001",
        title: "被困一年，決意走出住所",
        description: "主角決定離開。",
        chapter: 1,
        chapter_name: "０１",
        chapter_refs: [1],
        characters: ["M"],
        event_type: "major",
        spoiler_level: 0,
        location_id: null,
        confidence: 0.85,
        review_status: "needs_review",
        source: "bing_gang",
      },
    },
  ],
  routes: [],
  timeline: [
    {
      id: "tl_001",
      date_label: "按章節先後",
      date_sort: "ch001",
      chapter: 1,
      location_id: null,
      characters: [],
      type: "major",
      spoiler_level: 0,
      description: "x",
      confidence: 0.8,
      review_status: "needs_review",
      event_id: "bg_event_001",
    },
  ],
  characters: [
    {
      id: "ha_ching",
      name: "夏晴",
      aliases: ["阿晴"],
      role: "main",
      color: "#3498DB",
      first_appearance: 1,
      chapter_refs: [1],
      spoiler_level: 1,
      description: "x",
      confidence: 0.9,
      review_status: "needs_review",
      portrait_asset_id: null,
    },
  ],
};

describe("search module", () => {
  beforeEach(() => {
    buildSearchIndex(mockDataset);
  });

  it("空查詢回空", () => {
    expect(search("")).toEqual([]);
    expect(search("   ")).toEqual([]);
  });

  it("搵到角色（中文名）", () => {
    const hits = search("夏晴");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].kind).toBe("character");
    expect(hits[0].title).toBe("夏晴");
  });

  it("alias 都搜尋得到", () => {
    const hits = search("阿晴");
    expect(hits.some((h) => h.title === "夏晴")).toBe(true);
  });

  it("搵到事件標題關鍵字", () => {
    const hits = search("走出住所");
    expect(hits.some((h) => h.id === "bg_event_001")).toBe(true);
  });

  it("搵到地點", () => {
    const hits = search("將軍澳");
    expect(hits.some((h) => h.kind === "location" && h.title.includes("將軍澳"))).toBe(true);
  });

  it("搵到章節編號", () => {
    const hits = search("第1章");
    expect(hits.some((h) => h.kind === "chapter")).toBe(true);
  });

  it("多詞 AND 過濾：唔相關組合回空", () => {
    expect(search("夏晴 將軍澳")).toEqual([]);
  });

  it("結果帶 deep link href", () => {
    const hits = search("夏晴");
    expect(hits[0].href).toContain("#character=");
  });
});

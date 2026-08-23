// 《病港》Phase B — 資料模型測試
// 驗證 src/types/dataset.ts 型別契約同 sample dataset 嘅一致性。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHARACTER_COLORS,
  FALLBACK_PALETTE,
  type BingGangDataset,
  type EventFeature,
  type LocationFeature,
} from "../src/types/dataset";

const __dirname_current = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname_current, "..", "data", "public");

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(PUBLIC, name), "utf-8"));
}

describe("provisional sample dataset", () => {
  const locations = loadJson("locations.geojson") as { features: LocationFeature[] };
  const events = loadJson("events.geojson") as { features: EventFeature[] };
  const routes = loadJson("routes.geojson") as { features: BingGangDataset["routes"] };
  const timeline = loadJson("timeline.json") as BingGangDataset["timeline"];
  const characters = loadJson("characters.json") as BingGangDataset["characters"];

  it("全部記錄係 needs_review（provisional 要求）", () => {
    for (const f of locations.features) expect(f.properties.review_status).toBe("needs_review");
    for (const f of events.features) expect(f.properties.review_status).toBe("needs_review");
    for (const f of routes.features) expect(f.properties.review_status).toBe("needs_review");
    for (const t of timeline) expect(t.review_status).toBe("needs_review");
    for (const c of characters) expect(c.review_status).toBe("needs_review");
  });

  it("source 只用 bing_gang（《病港2》零內容）", () => {
    for (const f of [...locations.features, ...events.features]) {
      expect(f.properties.source).toBe("bing_gang");
    }
  });

  it("事件摘要唔超過 200 字上限", () => {
    for (const f of events.features) {
      expect(f.properties.description.length).toBeLessThanOrEqual(200);
    }
    for (const f of locations.features) {
      expect(f.properties.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("story_position 喺 normalized 0–1 範圍", () => {
    for (const f of locations.features) {
      expect(f.properties.story_position.x).toBeGreaterThanOrEqual(0);
      expect(f.properties.story_position.x).toBeLessThanOrEqual(1);
      expect(f.properties.story_position.y).toBeGreaterThanOrEqual(0);
      expect(f.properties.story_position.y).toBeLessThanOrEqual(1);
    }
  });

  it("spoiler_level 喺 0–3", () => {
    for (const f of events.features) {
      expect([0, 1, 2, 3]).toContain(f.properties.spoiler_level);
    }
  });

  it("timeline 無可靠日期時 date_label 係「按章節先後」", () => {
    for (const t of timeline) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(t.date_sort)) {
        expect(t.date_label).toBe("按章節先後");
        expect(t.date_sort).toMatch(/^ch\d{3}$/);
      }
    }
  });
});

describe("角色配色契約", () => {
  it("預設配色符合 master prompt §7.7", () => {
    expect(CHARACTER_COLORS.protagonist).toBe("#E74C3C");
    expect(CHARACTER_COLORS.ha_ching).toBe("#3498DB");
    expect(CHARACTER_COLORS.a_ming).toBe("#2ECC71");
    expect(FALLBACK_PALETTE).toEqual(["#F39C12", "#9B59B6", "#1ABC9C", "#E67E22"]);
  });

  it("sample characters 用色符合 palette 或預設色", () => {
    const allowed = new Set([...Object.values(CHARACTER_COLORS), ...FALLBACK_PALETTE]);
    const chars = loadJson("characters.json") as BingGangDataset["characters"];
    for (const c of chars) {
      if (c.id in CHARACTER_COLORS) {
        expect(c.color).toBe(CHARACTER_COLORS[c.id]);
      }
      expect(allowed.has(c.color)).toBe(true);
    }
  });
});

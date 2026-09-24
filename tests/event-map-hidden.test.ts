// `map_hidden` 嘅 location 所連 event 唔可以喺地圖畫點
//
// 用戶報告（2026-09-24）
// ====================
// > 「第一章有個標記去咗旺角，應該係錯誤，第一章嘅內容應該係喺將軍澳。」
//
// 根因
// ====
// `map_hidden` 嘅語義（`SvgMap.render()` 嘅註釋）係「資料保留喺面板度，
// 但唔喺地圖標一個**誤導性嘅點**」。但**事件標記之前冇跟呢個規則**：
// `loc_0014`（「香港」，`map_hidden: true`、座標 `114.1694, 22.3193` = 旺角）
// 連住 **4 個第一章事件** → 第一章喺旺角出現 4 個標記。
//
// 實測數據（`data/public/`）：
//   · 第一章 event 共 6 個；其中 4 個連去 `loc_0014`（全部喺旺角）
//   · 呢 4 個都冇 `zone_id` → 冇更好嘅 fallback 座標 → 只可以唔畫

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/components/SvgMap.ts", "utf-8");
const LOC = JSON.parse(readFileSync("data/public/locations.geojson", "utf-8")) as {
  features: Array<{
    geometry: { coordinates: [number, number] };
    properties: { id: string; name: string; map_hidden?: boolean; first_appearance?: number };
  }>;
};
const EV = JSON.parse(readFileSync("data/public/events.geojson", "utf-8")) as {
  features: Array<{
    geometry: { coordinates: [number, number] };
    properties: { chapter?: number; title?: string; location_id?: string | null };
  }>;
};

describe("event 標記 × map_hidden location", () => {
  it("⭐ 繪製迴圈用 `eventsToPlot`（唔可以再用 `eventsToShow`）", () => {
    expect(SRC).toContain("const eventsToPlot = eventsToShow.filter(");
    expect(SRC).toMatch(/for \(const ev of eventsToPlot\) \{/);
    // 繪製迴圈唔可以直接用未過濾嘅清單
    expect(SRC).not.toMatch(/for \(const ev of eventsToShow\) \{/);
  });

  it("⭐ 過濾條件係「location 有 `map_hidden`」", () => {
    const i = SRC.indexOf("const hiddenLocIds = new Set(");
    expect(i, "搵唔到 hiddenLocIds").toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 500);
    expect(body).toContain("l.properties.map_hidden");
    expect(body).toContain("hiddenLocIds.has(e.properties.location_id");
  });

  it("資料層：確實存在「連去 map_hidden location」嘅 event（記錄呢個事實）", () => {
    const hidden = new Set(
      LOC.features.filter((l) => l.properties.map_hidden).map((l) => l.properties.id),
    );
    const linked = EV.features.filter((e) => hidden.has(e.properties.location_id ?? ""));
    expect(hidden.size, "map_hidden location 數").toBeGreaterThan(0);
    expect(linked.length, "連去 map_hidden location 嘅 event 數").toBeGreaterThan(0);
  });

  it("⭐ 第一章唔應該再有離將軍澳 >4 km 嘅**可繪製** event", () => {
    const hidden = new Set(
      LOC.features.filter((l) => l.properties.map_hidden).map((l) => l.properties.id),
    );
    const M_LON = 111320 * Math.cos((22.36 * Math.PI) / 180);
    const M_LAT = 110570;
    const TKO: [number, number] = [114.262, 22.31];
    const km = (c: [number, number]): number =>
      Math.hypot((c[0] - TKO[0]) * M_LON, (c[1] - TKO[1]) * M_LAT) / 1000;

    const ch1 = EV.features.filter((e) => e.properties.chapter === 1);
    const plottable = ch1.filter((e) => !hidden.has(e.properties.location_id ?? ""));
    const far = plottable.filter((e) => km(e.geometry.coordinates) > 4);
    expect(
      far.map((e) => `${e.properties.title} @ ${e.geometry.coordinates}`),
      "第一章可繪製嘅 event 全部應該喺將軍澳一帶",
    ).toEqual([]);
  });
});

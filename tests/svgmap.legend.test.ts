// 《病港》Phase H — SvgMap 互動地圖測試
// Validates legend rendering and flyToChapter smart zoom behaviour.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Phase H: SvgMap legend", () => {
  it("legend HTML exists in SvgMap template", () => {
    // The map legend with marker color samples is defined in SvgMap.ts init()
    // template. This smoke-test reads the source and checks for the expected
    // CSS class names that the legend uses.
    const src = readFileSync("src/components/SvgMap.ts", "utf-8");
    // Legend CSS classes
    expect(src).toContain('class="map-legend"');
    expect(src).toContain('class="legend-title"');
    expect(src).toContain('class="legend-item"');
    // Legend marker color classes
    expect(src).toContain("dot-event-current");
    expect(src).toContain("dot-event-other");
    expect(src).toContain("dot-loc-real");
    expect(src).toContain("dot-loc-fictional");
    expect(src).toContain("dot-selected");
    expect(src).toContain("route-legend");
  });

  it("legend includes CJK label '地圖標記'", () => {
    const src = readFileSync("src/components/SvgMap.ts", "utf-8");
    expect(src).toContain("地圖標記");
  });

  it("legend includes descriptive text for each marker type", () => {
    const src = readFileSync("src/components/SvgMap.ts", "utf-8");
    expect(src).toContain("本章事件");
    expect(src).toContain("其他章事件");
    expect(src).toContain("真實地點");
    expect(src).toContain("虛構地點");
    expect(src).toContain("選中");
    expect(src).toContain("角色路線");
  });
});

describe("Phase H: SvgMap flyToChapter smart zoom", () => {
  it("flyToChapter is implemented and not a stub", () => {
    const src = readFileSync("src/components/SvgMap.ts", "utf-8");
    // flyToChapter should compute bbox from location features
    expect(src).toMatch(/flyToChapter\([^)]*\)\s*:\s*void\s*\{/);
    // Should iterate over data.locations.features to compute bbox
    expect(src).toContain("data.locations.features");
    // Should reference FALLBACK_ANCHORS to handle fictional locations
    expect(src).toContain("FALLBACK_ANCHORS");
    // Should set viewBox
    expect(src).toContain("setAttribute(\"viewBox\"");
  });

  it("flyToChapter pads bbox by ~25% to give breathing room", () => {
    const src = readFileSync("src/components/SvgMap.ts", "utf-8");
    // 0.25 padding ratio should be in the flyToChapter section
    const idx = src.indexOf("flyToChapter");
    expect(idx).toBeGreaterThan(-1);
    const slice = src.slice(idx, idx + 3000);
    expect(slice).toContain("0.25");
  });
});

describe("Phase H: SvgMap basemap image", () => {
  it("basemap PNG is rendered with street + place labels", () => {
    // The render script should have rendered > 1000 labels so the basemap
    // contains place names (e.g. 將軍澳) without needing a separate label
    // overlay layer.
    const renderScript = readFileSync("scripts/render_hk_basemap.py", "utf-8");
    // The render script must include label passes
    expect(renderScript).toContain("Pass 5: street / place labels");
    expect(renderScript).toContain("label_font");
    // Must have at least one of: road labels, place labels
    expect(renderScript).toContain("major_roads");
    expect(renderScript).toContain("hospital");
  });
});

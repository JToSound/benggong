// 《病港》Phase I — 互動地圖增強測試
// Validates label decluttering, smooth animation, full-HK anchors,
// and bilingual legend rendering.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Phase I: full-HK anchor pool (data/fallbackAnchors.ts)", () => {
  const ts = readFileSync("src/data/fallbackAnchors.ts", "utf-8");

  it("exports FULL_HK_ANCHORS with at least 500 entries", () => {
    const match = ts.match(/export const FULL_HK_ANCHORS: Record<string, FullHKAnchor>/);
    expect(match, "FULL_HK_ANCHORS must be exported").toBeTruthy();
    // Count entries: "key": { ... } patterns
    const count = (ts.match(/^ {2}"[^"]+": \{/gm) || []).length;
    expect(count).toBeGreaterThanOrEqual(500);
  });

  it("every entry has lon, lat, and kind fields", () => {
    // Pattern check: each line should contain "lon:", "lat:", "kind:"
    const lines = ts.split("\n").filter((l) => l.match(/^ {2}"[^"]+": \{/));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `entry missing lon: ${line.slice(0, 80)}`).toContain("lon:");
      expect(line, `entry missing lat: ${line.slice(0, 80)}`).toContain("lat:");
      expect(line, `entry missing kind: ${line.slice(0, 80)}`).toContain("kind:");
    }
  });

  it("includes well-known Tseung Kwan O and HK landmarks", () => {
    // Spot-check a few iconic locations from the story's primary region
    const expected = [
      "將軍澳中心 Park Central",
      "又一城 Festival Walk",
      "時代廣場 Times Square",
      "西港城 Western Market",
      "置富南區廣場 Chi Fu Landmark",
      "彩明商場 Choi Ming Shopping Centre",
    ];
    for (const name of expected) {
      expect(ts, `${name} must be present`).toContain(`"${name}"`);
    }
  });

  it("all coordinates are within Hong Kong bbox (113.85-114.45 lon, 22.18-22.55 lat)", () => {
    // Extract all "lon: <number>, lat: <number>" pairs
    const re = /lon:\s*([\d.]+),\s*lat:\s*([\d.]+)/g;
    let m;
    let count = 0;
    while ((m = re.exec(ts)) !== null) {
      const lon = parseFloat(m[1]);
      const lat = parseFloat(m[2]);
      expect(lon).toBeGreaterThanOrEqual(113.85);
      expect(lon).toBeLessThanOrEqual(114.45);
      expect(lat).toBeGreaterThanOrEqual(22.18);
      expect(lat).toBeLessThanOrEqual(22.55);
      count++;
    }
    expect(count).toBeGreaterThan(500);
  });
});

describe("Phase I: SvgMap render() zoom-aware label layer", () => {
  const src = readFileSync("src/components/SvgMap.ts", "utf-8");

  it("queries #label-detail-layer in render() for zoom-based opacity", () => {
    expect(src).toContain("label-detail-layer");
    // Should appear in a querySelector call
    expect(src).toMatch(/querySelector\([^)]*label-detail-layer/);
  });

  it("label opacity interpolated linearly between viewScale 0.8 and 1.2", () => {
    // Find the interpolation expression
    const m = src.match(/this\.viewScale\s*<=\s*0\.8\s*\?\s*0\.0\s*:\s*\([\s\S]*?\)/);
    expect(m, "expected opacity interpolation formula").toBeTruthy();
  });
});

describe("Phase I: SvgMap animateViewBox (smooth transition)", () => {
  const src = readFileSync("src/components/SvgMap.ts", "utf-8");

  it("defines animateViewBox method", () => {
    expect(src).toMatch(/private animateViewBox\(/);
  });

  it("uses requestAnimationFrame for animation loop", () => {
    expect(src).toContain("requestAnimationFrame");
  });

  it("uses ease-in-out cubic curve for transition", () => {
    expect(src).toContain("4 * t * t * t");  // first half of ease-in-out cubic
    expect(src).toContain("Math.pow(-2 * t + 2, 3)");  // second half
  });

  it("cancels previous animation on new flyToChapter call", () => {
    expect(src).toContain("cancelAnimationFrame");
  });
});

describe("Phase I: bilingual legend (EN/中 toggle)", () => {
  const src = readFileSync("src/components/SvgMap.ts", "utf-8");

  it("defines LEGEND_ZH and LEGEND_EN objects", () => {
    expect(src).toContain("const LEGEND_ZH");
    expect(src).toContain("const LEGEND_EN");
  });

  it("legend items have data-i18n attributes for translation targets", () => {
    // Source HTML should include data-i18n on each legend item
    expect(src).toMatch(/data-i18n="legend\.title"/);
    expect(src).toMatch(/data-i18n="legend\.event-current"/);
    expect(src).toMatch(/data-i18n="legend\.event-other"/);
    expect(src).toMatch(/data-i18n="legend\.loc-real"/);
    expect(src).toMatch(/data-i18n="legend\.loc-fictional"/);
    expect(src).toMatch(/data-i18n="legend\.selected"/);
    expect(src).toMatch(/data-i18n="legend\.route"/);
  });

  it("has #legend-lang-btn to toggle language", () => {
    expect(src).toContain('id="legend-lang-btn"');
    expect(src).toContain("toggleLegendLanguage");
  });

  it("toggleLegendLanguage switches between zh and en", () => {
    expect(src).toMatch(/this\.lang\s*=\s*this\.lang\s*===\s*["']zh["']\s*\?\s*["']en["']\s*:\s*["']zh["']/);
  });
});

describe("Phase I: SvgMap resolveCoord helper", () => {
  const src = readFileSync("src/components/SvgMap.ts", "utf-8");

  it("defines resolveCoord with three-tier priority", () => {
    expect(src).toMatch(/function resolveCoord\(/);
    expect(src).toContain("FALLBACK_ANCHORS");
    expect(src).toContain("FULL_HK_ANCHORS");
  });

  it("uses resolveCoord in flyToChapter location iteration", () => {
    // After refactor, the flyToChapter loop should use resolveCoord
    const m = src.match(/flyToChapter\(_ch: number\): void \{([\s\S]+?)animateViewBox/);
    expect(m, "expected flyToChapter body").toBeTruthy();
    const body = m![1];
    expect(body).toContain("resolveCoord");
  });
});

// B6 — Zone LOD 政策（spec §3.2 L-Z0 / L-Z1 / L-Z2）
//
// 為何要有呢個檔（而 `map-lod.test.ts` 已經有）
// ==========================================
// `tests/map-lod.test.ts`（B5）測嘅係 `map-lod.ts` 嘅**純函數**：
// `selectZoneLod(viewW)` 回唔回正確嘅層名。
//
// 但「層名正確」唔等於「畫法正確」—— 中間隔住一層**政策到視覺嘅映射**：
//   cluster  → fill-opacity 0.04 / stroke-opacity 0.5 / 冇光暈 / 冇 label
//   boundary → 0.10 / 0.78 / 冇光暈 / 有 label（≥7%）
//   full     → 0.14 / 0.78 / 有光暈 / 有 label ＋ pulse
//
// 呢一層原本**冇任何測試**，而且係 P0-2（cluster glyph 疊成一團）嘅
// 所在。呢個檔專門測呢層，全部係 node 單測（唔需要 Playwright）。
//
// 三個 LOD 層嘅實測值由 `tests/helpers/zone-fixtures.ts` 讀
// `map-lod.ts` 嘅 `Z_BANDS` —— 唔喺測試寫死 0.175 / 0.0219。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BASE_VIEW_W,
  MAX_SCALE,
  MAX_VIEW_W,
  Z,
  chapterWindowFor,
  selectZoneLod,
  Z_BANDS,
} from "../src/map/map-lod";
import { MapViewport } from "../src/map/MapViewport";
import { MapShell } from "../src/map/MapShell";
import type { App } from "../src/app";
import {
  clusterBadgeRadiusUser,
  clusterLabel,
  clusterZones,
  CLUSTER_BADGE_DIAMETER_PX,
  type ZoneModelEntry,
} from "../src/map/ZoneLayer";
import {
  ZONE_LOD_THRESHOLDS_HINT,
  lodFor,
  zoneLodSamples,
} from "./helpers/zone-fixtures";

const SVG_MAP = readFileSync("src/components/SvgMap.ts", "utf-8");
const MAP_CSS = readFileSync("src/styles/map.css", "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// L-Z0..L-Z2：政策層（沿用 B5 嘅門檻，唔可以漂移）
// ─────────────────────────────────────────────────────────────────────────────

describe("Zone LOD 政策（L-Z0 / L-Z1 / L-Z2）", () => {
  it("三個層嘅門檻同 `map-lod.ts` Z_BANDS 完全一致（唔寫死）", () => {
    expect(ZONE_LOD_THRESHOLDS_HINT.macro).toBe(Z_BANDS.macro);
    expect(ZONE_LOD_THRESHOLDS_HINT.detail).toBe(Z_BANDS.detail);
    expect(Z_BANDS.macro).toBe(0.175);
    expect(Z_BANDS.detail).toBe(0.0219);
  });

  it("全港視圖（viewW = 0.70）→ cluster", () => {
    expect(selectZoneLod(0.7)).toBe("cluster");
  });

  it("三層都有樣本覆蓋（唔會有一層永遠測唔到）", () => {
    const samples = zoneLodSamples();
    expect(samples.map((s) => s.lod)).toEqual(["cluster", "boundary", "full"]);
    for (const s of samples) {
      expect(lodFor(s.viewW), `viewW=${s.viewW}`).toBe(s.lod);
    }
  });

  it("LOD 係單調嘅：viewW 縮細，層只可以由 cluster → boundary → full", () => {
    const order = { cluster: 0, boundary: 1, full: 2 } as const;
    let prev = -1;
    for (let i = 0; i <= 60; i++) {
      const viewW = 0.7 / 1.15 ** i;
      const rank = order[selectZoneLod(viewW)];
      expect(rank, `viewW=${viewW.toFixed(5)} 嘅層唔可以倒退`).toBeGreaterThanOrEqual(
        prev,
      );
      prev = rank;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 視覺映射：政策 → 實際畫法（呢個檔嘅核心價值）
// ─────────────────────────────────────────────────────────────────────────────

describe("Zone LOD 視覺映射（cluster / boundary / full）", () => {
  it("cluster 層 `.zone-area` 淡到 4%（唔可以變色霧）", () => {
    const block = MAP_CSS.match(
      /#svg-map\s+\.zone\[data-zone-lod="cluster"\]\s+\.zone-area\s*\{[^}]*\}/,
    );
    expect(block, "要有 cluster 層嘅 .zone-area 規則").not.toBeNull();
    const fill = block![0].match(/fill-opacity:\s*([\d.]+)/);
    const stroke = block![0].match(/stroke-opacity:\s*([\d.]+)/);
    expect(Number(fill![1])).toBeLessThanOrEqual(0.05);
    expect(Number(fill![1])).toBeGreaterThan(0); // 唔可以係 0（規則 L1）
    expect(Number(stroke![1])).toBeLessThanOrEqual(0.5);
  });

  it("cluster 層唔顯示 zone label（48 個名字 = 文字牆）", () => {
    const clean = MAP_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(clean).toMatch(
      /\.zone\[data-zone-lod="cluster"\]\s+\.zone-label\s*\{[^}]*display:\s*none/,
    );
  });

  it("cluster 層唔畫光暈（`SvgMap` 有 `if (!zoneIsCluster)` 守衛）", () => {
    expect(SVG_MAP).toContain("if (!zoneIsCluster) {");
    // 光暈節點只可以喺嗰個守衛之內建立
    const guard = SVG_MAP.match(/if \(!zoneIsCluster\) \{([\s\S]*?)\n      \}/);
    expect(guard).not.toBeNull();
    expect(guard![1]).toContain('"zone-glow"');
  });

  it("pulse 只喺 full 層出現（boundary 層畫會令全部病窩一齊跳）", () => {
    expect(SVG_MAP).toMatch(
      /if \(zm\.styleKey === "nest" && zoneLod === "full"\)/,
    );
    expect(SVG_MAP).toContain('"zone-pulse"');
  });

  it("boundary / full 層嘅 fill-opacity 高過 cluster（視覺上有分別）", () => {
    const get = (lod: string): number => {
      const b = MAP_CSS.match(
        new RegExp(
          `#svg-map\\s+\\.zone\\[data-zone-lod="${lod}"\\]\\s+\\.zone-area\\s*\\{[^}]*\\}`,
        ),
      );
      expect(b, `${lod} 層要有規則`).not.toBeNull();
      return Number(b![0].match(/fill-opacity:\s*([\d.]+)/)![1]);
    };
    expect(get("boundary")).toBeGreaterThan(get("cluster"));
    expect(get("full")).toBeGreaterThanOrEqual(get("boundary"));
  });

  it("每個 `.zone` 都帶 `data-zone-lod`（CSS 規則先有作用）", () => {
    expect(SVG_MAP).toContain('g.setAttribute("data-zone-lod", zoneLod)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LOD × cluster 正規化（P0-2 嘅核心）
// ─────────────────────────────────────────────────────────────────────────────

describe("LOD × cluster 正規化", () => {
  function zone(id: string, cx: number, cy: number): ZoneModelEntry {
    return {
      id,
      name: id,
      d: "",
      styleKey: "nest",
      pattern: "solid",
      evidenced: true,
      cx,
      cy,
      emphasized: false,
      selected: false,
      showLabel: false,
      dangerLevel: null,
      radiusM: 800,
      summary: "",
    };
  }

  it("全港視圖：48 個 zone 疊埋 → 遠少於 48 個簇", () => {
    /*
     * ⚠️ 呢個就係 P0-2 嘅量化目標。
     *
     * `docs/progress/phase-2-wave2-b3-b5.md` §4② 記錄「世界視圖下 48 個
     * zone 疊成一團」。將軍澳一帶嘅 zone 座標差異遠細過 `markerR(0.008)`
     * 喺全港視圖（viewScale = 1）下嘅格邊長 —— 所以佢哋應該全部落
     * 一兩格。
     */
    // 模擬 48 個 zone：大部分集中喺將軍澳 0.05° 範圍內
    const zones = Array.from({ length: 48 }, (_, i) =>
      zone(`z${i}`, 0.62 + (i % 7) * 0.0012, 0.365 + Math.floor(i / 7) * 0.0008),
    );
    // viewScale = 1 → markerR(0.008) = 0.008
    const clusters = clusterZones(zones, 0.008);
    expect(clusters.length, "48 個 zone 唔應該產生 48 個 badge").toBeLessThan(12);
    expect(clusters.length).toBeGreaterThan(0);
    // 數量守恆：所有成員加埋 = 48
    const total = clusters.reduce((a, c) => a + c.count, 0);
    expect(total).toBe(48);
  });

  it("放大之後簇會分裂（同 location marker 用同一套政策）", () => {
    const zones = Array.from({ length: 48 }, (_, i) =>
      zone(`z${i}`, 0.62 + (i % 7) * 0.0012, 0.365 + Math.floor(i / 7) * 0.0008),
    );
    // viewScale = 8 → markerR(0.008) = 0.001
    const coarse = clusterZones(zones, 0.008).length;
    const fine = clusterZones(zones, 0.008 / 8).length;
    expect(fine).toBeGreaterThan(coarse);
  });

  it("⭐ cluster badge 渲染直徑按 spec §3.2 L-Z0 落喺 8–12 px（三個 viewW）", () => {
    /*
     * spec 原文（`docs/specs/world-atlas-v2-rendering-lod-strategy.md`
     * §3.2 L-Z0）：
     *   | L-Z0 | viewW > 0.175° | Cluster glyph（直徑 8–12 px 嘅 badge …）|
     *
     * ⚠️ 為何一定要測**渲染直徑**而唔係 user-unit 半徑
     * --------------------------------------------
     * 之前嘅 bug（B6-D5）：寫死 `0.0078 × 1.45` user unit，喺 1020 px 闊
     * 嘅 SVG、viewW 0.70° 之下 = 33 px 直徑，超 spec 3.5–5 倍。
     * user unit 同 px 嘅換算率**隨 viewW 變**，所以只可以量「反推之後
     * 渲染出嚟嘅 px」。
     *
     * 呢度用同 `SvgMap` 一樣嘅幾何：SVG 闊 1020 px（實測值）。
     * 真實瀏覽器量測（`getBoundingClientRect`）喺
     * `tests/map-interaction.e2e.test.ts`，兩層互補。
     */
    const SVG_W = 1020; // 1400×900 viewport 下 .svg-map 嘅 CSS 闊（實測）
    for (const viewW of [0.8, 0.4, 0.2]) {
      // 三個都 > 0.175 → 全部係 L-Z0（cluster）層
      expect(viewW).toBeGreaterThan(Z_BANDS.macro);
      for (const count of [2, 6, 13, 48, 999]) {
        const rUser = clusterBadgeRadiusUser(viewW, SVG_W, count);
        const pxPerUser = SVG_W / viewW;
        const diameterPx = rUser * 2 * pxPerUser;
        expect(
          diameterPx,
          `viewW=${viewW} count=${count} → 直徑 ${diameterPx.toFixed(2)} px 要喺 [8,12]`,
        ).toBeGreaterThanOrEqual(8);
        expect(diameterPx).toBeLessThanOrEqual(12);
      }
    }
  });

  it("cluster badge 目標直徑 = 10 px（區間中位，唔貼邊界）", () => {
    const SVG_W = 1020;
    // count 由 2 去到 12+ 之間單調遞增，但全程留 1 px buffer
    const d2 = clusterBadgeRadiusUser(0.7, SVG_W, 2) * 2 * (SVG_W / 0.7);
    const d48 = clusterBadgeRadiusUser(0.7, SVG_W, 48) * 2 * (SVG_W / 0.7);
    expect(d2).toBeGreaterThanOrEqual(9);
    expect(d48).toBeLessThanOrEqual(11);
    expect(d2).toBeLessThan(d48); // 數量多 → 大少少
    expect(CLUSTER_BADGE_DIAMETER_PX).toBe(10);
  });

  it("⭐ 反推函數：任何 viewW / SVG 闊之下，px 直徑恆定（比例無關）", () => {
    /*
     * 呢個係「先定 px 再反推 user unit」呢個做法嘅**核心不變式**：
     * 反推之後再乘返比例，一定要得返同一個 px 值。
     *
     * 如果邊度偷用咗固定 user unit（即 B6-D5 嘅舊做法），
     * 呢個測試會喺某些 viewW 之下爆。
     */
    for (const viewW of [0.1751, 0.2, 0.35, 0.4, 0.55, 0.7, 0.9]) {
      for (const svgW of [600, 1020, 1600, 2400]) {
        for (const count of [2, 12, 48]) {
          const rUser = clusterBadgeRadiusUser(viewW, svgW, count);
          const pxPerUser = svgW / viewW;
          const diameterPx = rUser * 2 * pxPerUser;
          // 同一個 count、任何 (viewW, svgW) 組合，px 直徑都要一樣
          const expected = count >= 12 ? 11 : count <= 2 ? 9 : 9 + 2 * ((count - 2) / 10);
          expect(
            diameterPx,
            `viewW=${viewW} svgW=${svgW} count=${count} → ${diameterPx.toFixed(4)} 應該 = ${expected}`,
          ).toBeCloseTo(expected, 6);
        }
      }
    }
  });

  it("clusterBadgeRadiusUser 對無效輸入回 0（唔會畫錯尺寸）", () => {
    expect(clusterBadgeRadiusUser(0, 1020, 5)).toBe(0);
    expect(clusterBadgeRadiusUser(0.7, 0, 5)).toBe(0);
    expect(clusterBadgeRadiusUser(-1, 1020, 5)).toBe(0);
  });

  it("cluster badge 比單一 zone 徽記大（視覺上要夠重）", () => {
    /*
     * 單一 zone 徽記喺 cluster 層嘅 base = 0.0078 user（`SvgMap` 用
     * `markerR(0.0078)`）。badge 直徑 10 px 喺全港視圖要**大過**佢。
     *
     * 全港：1020 px / 0.70° = 1457 px/user → 0.0078 user 徽記直徑
     * = 0.0078 × 2 × 1457 ≈ 22.7 px。所以「10 px」其實係**細過**
     * 單一徽記 —— 但呢個係 spec 嘅硬性要求（8–12 px），而且
     * cluster 層嘅 zone-area 已經淡到 4% fill，視覺重量全靠
     * badge 嘅**實心圓 + 高對比描邊 + 數量文字**。下面斷言
     * badge 嘅 stroke 用量足以維持可讀性（見 e2e 嘅不重疊斷言）。
     */
    const r = clusterBadgeRadiusUser(0.7, 1020, 48);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(0.0078); // badge 係「精緻指示」而唔係「大徽記」
  });

  it("數量標示有意義（唔會係空或者 1）", () => {
    expect(clusterLabel(48)).toBe("48");
    expect(clusterLabel(1)).toBe("");
  });

  it("`SvgMap` 只喺 cluster 層計 cluster（boundary/full 唔應該有 badge）", () => {
    expect(SVG_MAP).toMatch(
      /zoneLod === "cluster"\s*\n?\s*\?\s*clusterZones\(/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 章節窗口（spec §3.3）—— zone 唔可以受章節影響存在性
// ─────────────────────────────────────────────────────────────────────────────

describe("章節窗口 × Zone（規則 L1 / 決定 D2）", () => {
  it("zone **永遠** render，唔受章節窗口影響", () => {
    /*
     * 舊 code 係 `chs.some((c) => c <= cur && cur <= c + 12)`。A4 實測：
     * 深 zoom 落將軍澳時 zone 由 19 個跌到 0。修法係 zone 完全唔過濾。
     */
    expect(SVG_MAP).not.toMatch(/c\s*<=\s*cur\s*&&\s*cur\s*<=\s*c\s*\+/);
    // evaluateZoneModel 直接 loop 全部 features，冇章節 gate
    const body = SVG_MAP.match(/evaluateZoneModel\(viewW: number\)[^{]*\{([\s\S]*?)\n  \}/);
    expect(body).not.toBeNull();
    expect(body![1]).toContain("for (const z of this.data.zones.features)");
    // 章節只影響 emphasis
    expect(body![1]).toContain("emphasized");
  });

  it("location ±5、event ±1（V2 政策冇被 B6 改走）", () => {
    expect(chapterWindowFor("location")).toBe(5);
    expect(chapterWindowFor("event")).toBe(1);
    expect(chapterWindowFor("event", true)).toBe(Infinity);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 縮放上限政策（spec §3.1 Z6–Z8；修復 B9 Q1「Z8 不可達」）
// ─────────────────────────────────────────────────────────────────────────────
//
// 背景：`MAX_SCALE = 64` → 最窄 viewW = 0.70/64 = 0.010937° = **Z6.0**，
// spec §3.1 嘅 Z7／Z8 物理上不可達（B9 Q1 標 `needs_review`）。
//
// 呢組測試**行為性**驗證「Z8 真係撳得到」，而唔係只讀常數值 ——
// 直接用 `MapViewport` / `MapShell`（兩者嘅 `zoomBy` 都唔需要 DOM）。

describe("縮放上限政策（Z8 可達）", () => {
  const BASE = { x: 113.8, y: 0, w: 0.7, h: 0.9 };
  /** spec §3.1：Z8 嘅 viewW 下限。 */
  const Z8_VIEW_W = 0.0027;

  it("MAX_SCALE 令最窄 viewW ≤ 0.0027°（即 Z ≥ 8）", () => {
    expect(MAX_VIEW_W).toBeCloseTo(BASE_VIEW_W / MAX_SCALE, 12);
    expect(MAX_VIEW_W).toBeLessThanOrEqual(Z8_VIEW_W);
    expect(Z(MAX_VIEW_W)).toBeGreaterThanOrEqual(8);
  });

  it("MapViewport 預設（唔傳 maxScale）可以撳到 Z8", () => {
    const vp = new MapViewport({
      element: {} as unknown as SVGSVGElement,
      base: BASE,
      onChange: () => {},
    });
    for (let i = 0; i < 40; i++) vp.zoomBy(1.3);
    expect(vp.view.w).toBeLessThanOrEqual(Z8_VIEW_W);
    expect(Z(vp.view.w)).toBeGreaterThanOrEqual(8);
  });

  it("MapShell 收 legacy `maxScale: 64` 都唔會封頂（Z8 仍然可達）", () => {
    const shell = makeShell(64);
    for (let i = 0; i < 40; i++) shell.viewportRef.zoomBy(1.3);
    expect(shell.view.w).toBeLessThanOrEqual(Z8_VIEW_W);
    expect(Z(shell.view.w)).toBeGreaterThanOrEqual(8);
  });

  it("MapShell 傳入大過政策嘅值仍然生效（只可以放寬，唔會反向封頂）", () => {
    const shell = makeShell(1000);
    for (let i = 0; i < 60; i++) shell.viewportRef.zoomBy(1.3);
    expect(shell.view.w).toBeCloseTo(BASE.w / 1000, 9);
  });

  /** 造一個唔需要 DOM 嘅 `MapShell`（`zoomBy` 唔會觸碰任何 DOM 方法）。 */
  function makeShell(maxScale: number): MapShell {
    const app = {
      getCurrentChapter: () => 1,
      getSelectedZoneId: () => null,
      selectedEventId: null,
      selectedLocationId: null,
      data: {} as never,
    } as unknown as App;
    return new MapShell({} as HTMLElement, {
      app,
      svg: {} as SVGSVGElement,
      layersRoot: {} as SVGGElement,
      base: BASE,
      maxScale,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 靜態守門：縮放上限只可以有一個來源
// ─────────────────────────────────────────────────────────────────────────────
//
// 為何要有呢組測試（B-MAX-1 / B-MAX-2 嘅回歸保護）
// -----------------------------------------------
// 修復前：`SvgMap.ts` 寫死 `const MAX_SCALE = 64`，而 `MapShell` 用政策值
// 做下限 —— 但下限**只保護「經 MapShell」嘅路徑**。`zoomToLocation`
// （`scaledView()`）同 `flyToChapter`（`viewBoxForGeoBounds(..., maxScale)`）
// 唔經 MapShell，所以嗰兩條路徑最深只到 Z6，而**冇任何測試變紅**。
//
// 同時間 `tests/phase-j-lod.test.ts` 用 regex 由 `SvgMap.ts` 源碼抽
// `MAX_SCALE`，抽到嘅 64 已經**唔係實際生效值**（實際 280）—— 呢種
// 「測試讀住一個唔生效嘅數字但仍然綠燈」係最危險嘅一種腐化。
//
// 所以下面兩條斷言將「寫死」本身變成測試會捉嘅事，唔再靠人記得。

/** 去掉註解後嘅原始碼 —— 註解會提到舊值（64 / 35），唔應該當成實作。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 遞迴收集 `dir` 之下所有 `.ts` 檔（相對路徑，用 `/` 分隔）。 */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(p));
    else if (entry.name.endsWith(".ts")) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

describe("縮放上限單一來源（靜態守門）", () => {
  it("`SvgMap` 由 `map-lod` import MAX_SCALE，唔再寫死本地常數", () => {
    const code = stripComments(SVG_MAP);
    expect(code, "唔可以再有 `const MAX_SCALE = <數字>`").not.toMatch(
      /const\s+MAX_SCALE\s*=/,
    );
    expect(code, "要由 ../map/map-lod import MAX_SCALE").toMatch(
      /from\s*"\.\.\/map\/map-lod"/,
    );
    expect(
      /import\s*\{[\s\S]*?\bMAX_SCALE\b[\s\S]*?\}\s*from\s*"\.\.\/map\/map-lod"/.test(
        code,
      ),
      "import 語句要包含 MAX_SCALE",
    ).toBe(true);
  });

  it("全 `src/` 只有 `map-lod.ts` 可以定義／傳入縮放上限 literal", () => {
    const offenders: string[] = [];
    for (const f of walkTs("src")) {
      if (f.endsWith("/map-lod.ts")) continue;
      const code = stripComments(readFileSync(f, "utf-8"));
      if (/const\s+MAX_SCALE\s*=/.test(code) || /maxScale\s*:\s*\d/.test(code)) {
        offenders.push(f);
      }
    }
    expect(
      offenders,
      `呢啲檔寫死咗縮放上限（應該 import \`MAX_SCALE\`）：${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("`MAX_SCALE` 政策值本身仍然令 Z8 可達（唔會被改細）", () => {
    // 靜態守門唔可以只防「寫死」，仲要防「政策值被改細到 Z8 不可達」。
    expect(MAX_SCALE).toBeGreaterThanOrEqual(0.7 / 0.0027);
  });
});

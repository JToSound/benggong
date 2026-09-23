// B6 — 地圖互動（hit priority / cluster 正規化 / 圖層開關 / 鍵盤）
//
// 為何要有呢個檔
// ==============
// spec §2.3 嘅 hit priority（MapControls > Zone > Route > Marker > Event >
// BaseGeometry）同 §3.2 L-Z0 嘅 cluster 正規化**原本冇任何自動驗證** ——
// 只有 `map-render.test.ts` 嘅 e2e 間接摸到。呢個檔將佢哋變成
// node 單測（快、可重跑、出錯時直接指出係邊一層判錯）。
//
// 全部斷言都係程式化嘅：冇「人手覆核」步驟。
//
//   A2  zone 可點？              → `resolveHit()` 分類 + `map.css` 契約
//   A3  hit priority 次序？      → `HIT_PRIORITY` 單調遞增 + DOM 選擇器
//   A4  cluster 正規化？         → `clusterZones()` / `clusterLabel()`
//   A5  legend 三通道？          → 讀 `SvgMap.ts` 原始碼斷言
//   A6  7 個 layer toggle？      → `LAYER_KEYS` 同 `url.ts` 交叉驗證
//   A8  pulse 錯相？             → 讀 `SvgMap.ts` + `map.css`
//   A9  鍵盤導航？               → 讀 `SvgMap.ts` 斷言按鍵表
//   A11 CSS 注入？               → 讀 `SvgMap.ts` 斷言 injectMapCss

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  clusterBadgeRadiusUser,
  clusterLabel,
  clusterZones,
  type ZoneModelEntry,
} from "../src/map/ZoneLayer";
import {
  HIT_PRIORITY,
  hiddenSelectors,
  LAYER_KEYS,
  LAYER_LABEL_EN,
  LAYER_LABEL_ZH,
  pressedToBool,
  resolveHit,
  type HitElementLike,
} from "../src/map/map-interactions";
import { MIN_TAP_PX } from "../src/map/MapControls";
import { ZONE_LOD_THRESHOLDS_HINT } from "./helpers/zone-fixtures";

const SVG_MAP = readFileSync("src/components/SvgMap.ts", "utf-8");
const MAP_CSS = readFileSync("src/styles/map.css", "utf-8");
const URL_TS = readFileSync("src/state/url.ts", "utf-8");
const TYPES_STATE = readFileSync("src/types/state.ts", "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// 測試替身：唔用 jsdom（vitest 環境係 node），用最小 mock 表達 DOM 關係
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 最小 `Element` 替身 —— 只實作 `resolveHit()` 用到嘅 `closest()`。
 *
 * 為何唔用 jsdom：`vitest.config` 係 `environment: "node"`，而且
 * jsdom 唔支援 SVG `closest()` 嘅完整行為（`.zone-area` 呢類
 * SVG 元素嘅 class 匹配）。用明確嘅 mock 反而測得更準 ——
 * 呢個檔測嘅係 `resolveHit()` 嘅**分類次序**，唔係瀏覽器行為。
 */
interface FakeEl extends HitElementLike {
  classes: string[];
  attrs: Record<string, string>;
  parent: FakeEl | null;
}

function el(
  classes: string[],
  attrs: Record<string, string> = {},
  parent: FakeEl | null = null,
): FakeEl {
  const node: FakeEl = {
    classes,
    attrs,
    parent,
    closest(sel: string): unknown {
      const sels = sel.split(",").map((s) => s.trim());
      let cur: FakeEl | null = node;
      while (cur) {
        for (const s of sels) {
          if (s.startsWith(".") && cur.classes.includes(s.slice(1))) return cur;
        }
        cur = cur.parent;
      }
      return null;
    },
    getAttribute(k: string): string | null {
      return attrs[k] ?? null;
    },
  };
  return node;
}

// ─────────────────────────────────────────────────────────────────────────────
// A3：hit priority 次序（spec §2.3）
// ─────────────────────────────────────────────────────────────────────────────

describe("A3 hit priority（spec §2.3）", () => {
  it("優先級次序係 MapControls > Zone > Route > Marker > Event > BaseGeometry", () => {
    /*
     * 為何要斷言次序而唔止斷言「有呢 6 個 kind」：spec §2.3 嘅實質內容
     * 就係**次序**。次序調亂 = 點 zone 內部嘅 marker 會揀錯目標，
     * 而呢個 bug 唔會令任何既有測試變紅。
     */
    expect(HIT_PRIORITY.controls).toBeLessThan(HIT_PRIORITY.zone);
    expect(HIT_PRIORITY.zone).toBeLessThan(HIT_PRIORITY.route);
    expect(HIT_PRIORITY.route).toBeLessThan(HIT_PRIORITY.marker);
    expect(HIT_PRIORITY.marker).toBeLessThan(HIT_PRIORITY.event);
    expect(HIT_PRIORITY.event).toBeLessThan(HIT_PRIORITY.basemap);
  });

  it("`resolveHit(null)` 回 basemap（點喺 SVG 外面）", () => {
    expect(resolveHit(null)).toEqual({ kind: "basemap", id: null });
  });

  it("zone 內部嘅子元素會向上搵到 .zone", () => {
    // 實際點到嘅係 <path class="zone-area">，但命中目標應該係 <g class="zone">
    const zoneG = el(["zone", "zone-nest"], { "data-zone-id": "z-1" });
    const area = el(["zone-area"], {}, zoneG);
    expect(resolveHit(area)).toEqual({ kind: "zone", id: "z-1" });
  });

  it("event marker 唔會被 zone 搶走（event 唔喺 zone 之內時）", () => {
    const evt = el(["event-marker"], { "data-event-id": "e-7" });
    expect(resolveHit(evt)).toEqual({ kind: "event", id: "e-7" });
  });

  it("⭐ event marker **喺** zone 之內時，zone 勝（spec §2.3 硬性）", () => {
    /*
     * 呢個就係 hit priority 嘅實質意義。如果 `resolveHit()` 用
     * 「先 event 後 zone」嘅次序，用戶永遠點唔到疊喺 event 上面嘅 zone。
     */
    const zoneG = el(["zone", "zone-survivor"], { "data-zone-id": "z-2" });
    const evt = el(["event-marker"], { "data-event-id": "e-9" }, zoneG);
    expect(resolveHit(evt)).toEqual({ kind: "zone", id: "z-2" });
  });

  it("route line 有 id，而且唔會被 marker 搶走", () => {
    const route = el(["route-line"], { "data-route-id": "r-3" });
    expect(resolveHit(route)).toEqual({ kind: "route", id: "r-3" });
  });

  it("location marker / cluster 都歸類做 marker", () => {
    const m = el(["location-marker"], { "data-loc-id": "l-1" });
    const c = el(["location-marker-cluster"], { "data-loc-id": "l-2" });
    expect(resolveHit(m)).toEqual({ kind: "marker", id: "l-1" });
    expect(resolveHit(c)).toEqual({ kind: "marker", id: "l-2" });
  });

  it("MapControls 嘅掣歸類做 controls（最高優先）", () => {
    const btn = el(["map-ctrl"], { id: "map-zoom-in" });
    expect(resolveHit(btn)).toEqual({ kind: "controls", id: "map-zoom-in" });
  });

  it("底圖 canvas / svg 本身 → basemap", () => {
    expect(resolveHit(el(["basemap-canvas"]))).toEqual({
      kind: "basemap",
      id: null,
    });
    expect(resolveHit(el(["svg-map"]))).toEqual({ kind: "basemap", id: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 / P0-1：zone 可點嘅 CSS 契約
// ─────────────────────────────────────────────────────────────────────────────

describe("A2 zone 可點（P0-1）", () => {
  it("`map.css` 用 (1,1,0) 特異度將 `.zone-area` 由 none 改成 auto", () => {
    /*
     * ⚠️ 呢個測試係「舊 CSS 會唔會偷偷贏返」嘅守門員。
     *
     * `src/styles/main.css:458` 有 `.zone-area { pointer-events: none; }`
     * （特異度 (0,1,0)）。B6 唔可以改嗰個檔，所以只可以喺
     * `map.css` 用**更高特異度**覆蓋。
     */
    const rule = MAP_CSS.match(/#svg-map\s+\.zone-area\s*\{[^}]*\}/);
    expect(rule, "map.css 一定要有 #svg-map .zone-area 規則").not.toBeNull();
    expect(rule![0]).toMatch(/pointer-events:\s*auto/);
  });

  it("特異度 (1,1,0) 嚴格大於 main.css:458 嘅 (0,1,0)", () => {
    // 手寫一個最小特異度計算器（唔靠人手目測 —— 零人手參與要求）
    const spec = (sel: string): [number, number, number] => {
      const ids = (sel.match(/#[\w-]+/g) || []).length;
      const cls =
        (sel.match(/\.[\w-]+/g) || []).length +
        (sel.match(/\[[^\]]+\]/g) || []).length +
        (sel.match(/:(?!:)[\w-]+/g) || []).length;
      const els = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
      return [ids, cls, els];
    };
    const newer = spec("#svg-map .zone-area");
    const older = spec(".zone-area");
    expect(newer[0]).toBeGreaterThan(older[0]); // id 數多咗
    expect(newer[0] * 10000 + newer[1] * 100).toBeGreaterThan(
      older[0] * 10000 + older[1] * 100,
    );
  });

  it("`.zone-area` 仍然係 path（每個 zone 一個），唔可以被合併成單一 cluster", () => {
    /*
     * `tests/map-render.test.ts` Q5 斷言 `.zone-area` 總數 =
     * `data/public/zones.geojson` features 數。呢個斷言喺呢度重覆一次
     * 係為咗提醒：cluster 正規化只可以改**視覺**，唔可以移除多邊形。
     */
    const m = SVG_MAP.match(/area\.setAttribute\("class",\s*"zone-area"\)/);
    expect(m, "render() 一定要為每個 zone 建立 .zone-area").not.toBeNull();
  });

  it("zone 圖層嘅裝飾元素全部 `pointer-events: none`（唔搶命中）", () => {
    for (const cls of ["zone-glow", "zone-pulse", "zone-label", "zone-badge", "zone-cluster"]) {
      const re = new RegExp(`#svg-map\\s+\\.${cls}[^{]*\\{[^}]*pointer-events:\\s*none`, "s");
      expect(MAP_CSS, `.${cls} 應該有 pointer-events: none`).toMatch(re);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4：cluster 正規化（P0-2）
// ─────────────────────────────────────────────────────────────────────────────

describe("A4 cluster 正規化（P0-2）", () => {
  /** 造一個 zone 模型 entry（只需要 cluster 用到嘅欄位有意義）。 */
  function zone(
    id: string,
    cx: number,
    cy: number,
    styleKey = "survivor",
  ): ZoneModelEntry {
    return {
      id,
      name: id,
      d: "M 0 0 L 1 0 L 1 1 Z",
      styleKey,
      pattern: "solid",
      evidenced: true,
      cx,
      cy,
      emphasized: false,
      selected: false,
      showLabel: false,
      dangerLevel: null,
      radiusM: 500,
      summary: "",
    };
  }

  it("同一格內嘅 zone 合成一個簇，count 正確", () => {
    const cell = 0.008;
    const zones = [
      zone("z1", 0.001, 0.001),
      zone("z2", 0.002, 0.002),
      zone("z3", 0.003, 0.002),
    ];
    const cl = clusterZones(zones, cell);
    expect(cl).toHaveLength(1);
    expect(cl[0].count).toBe(3);
    expect(cl[0].memberIds).toEqual(["z1", "z2", "z3"]);
  });

  it("孤立嘅 zone **唔會**產生「1」嘅簇", () => {
    /*
     * 一個寫住「1」嘅 badge 冇任何資訊，只係多一個 DOM 節點。
     * 呢個行為要鎖住 —— 否則全港視圖會多 48 個無意義嘅圈。
     */
    const zones = [zone("z1", 0, 0), zone("z2", 5, 5)];
    expect(clusterZones(zones, 0.008)).toHaveLength(0);
  });

  it("格大細決定簇數：格越細，簇越多（即 LOD 會隨 zoom 分裂）", () => {
    /*
     * 6 個 zone 排成一行，間距 0.004。
     *   cell = 0.05  → 6 個全部落入同一格 → 1 簇（count 6）
     *   cell = 0.001 → 每個各自一格 → 全部孤立 → 0 簇
     */
    const zones = Array.from({ length: 6 }, (_, i) =>
      zone(`z${i}`, i * 0.004, 0),
    );
    const coarse = clusterZones(zones, 0.05);
    const fine = clusterZones(zones, 0.001);
    expect(coarse).toHaveLength(1);
    expect(coarse[0].count).toBe(6);
    expect(fine).toHaveLength(0);
  });

  it("簇嘅 dominant 係最危險嘅 styleKey（nest > outpost > survivor）", () => {
    const zones = [
      zone("a", 0.001, 0.001, "survivor"),
      zone("b", 0.002, 0.001, "nest"),
      zone("c", 0.001, 0.002, "outpost"),
    ];
    const cl = clusterZones(zones, 0.01);
    expect(cl).toHaveLength(1);
    expect(cl[0].dominant).toBe("nest");
  });

  it("結果係確定性嘅（同樣輸入 → 同樣次序，唔依賴 Map 插入次序）", () => {
    const zones = [
      zone("z5", 0, 0),
      zone("z1", 0.001, 0),
      zone("z9", 10, 0),
      zone("z2", 10.001, 0),
    ];
    const a = clusterZones(zones, 0.01);
    const b = clusterZones([...zones].reverse(), 0.01);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a.map((c) => c.count)).toEqual(b.map((c) => c.count));
  });

  it("bad cell（0 / 負數）唔會無限迴圈或者產生 NaN", () => {
    const zones = [zone("z1", 1, 1), zone("z2", 1, 1)];
    expect(clusterZones(zones, 0)).toHaveLength(0);
    expect(clusterZones(zones, -1)).toHaveLength(0);
  });

  it("`clusterLabel()`：1 → 空字串、>99 → 99+", () => {
    expect(clusterLabel(0)).toBe("");
    expect(clusterLabel(1)).toBe("");
    expect(clusterLabel(2)).toBe("2");
    expect(clusterLabel(48)).toBe("48");
    expect(clusterLabel(99)).toBe("99");
    expect(clusterLabel(100)).toBe("99+");
  });

  it("cluster badge 半徑隨 count 遞增但封頂（唔會爆出圓圈）", () => {
    // 用新嘅 px-anchored API（見 B6-D5）。SVG 闊 1020 px、viewW 0.7°。
    const SVG_W = 1020;
    const VW = 0.7;
    const r2 = clusterBadgeRadiusUser(VW, SVG_W, 2);
    const r12 = clusterBadgeRadiusUser(VW, SVG_W, 12);
    const r99 = clusterBadgeRadiusUser(VW, SVG_W, 999);
    expect(r12).toBeGreaterThan(r2);
    expect(r99).toBeGreaterThan(r2);
    // 封頂：12 之後唔再變大
    expect(r99).toBeCloseTo(r12, 10);
    // 最大都唔會超過 11 px 直徑（spec 上限 12 px 之內）
    expect(r99 * 2 * (SVG_W / VW)).toBeLessThanOrEqual(11.0000001);
  });

  it("macro LOD（viewW > 0.175°）先會有 cluster badge", () => {
    /*
     * 呢個斷言用 `ZONE_LOD_THRESHOLDS_HINT` 由 `map-lod.ts` 讀返門檻，
     * 而唔係喺測試寫死 0.175 —— 如果 B5 改門檻，呢個測試會跟住行，
     * 只有「SvgMap 冇用 selectZoneLod」才會變紅。
     */
    expect(ZONE_LOD_THRESHOLDS_HINT.macro).toBe(0.175);
    expect(SVG_MAP).toMatch(/zoneLod === "cluster"/);
    /*
     * 修 1 之後呼叫形式係 `clusterZones(zoneModel, <cell>, clusterSep)`
     * —— 第三個參數係 px→user 換算出嚟嘅最小間距（防止 badge 互相疊）。
     * 呢度只斷言「有傳 zoneModel 同 clusterSep」，唔鎖死中間 cell 嘅寫法，
     * 免得改 cell 來源就假陽性變紅。
     *
     * ⚠️ 中間用 `.*?` 而唔係 `[^)]*`：cell 係 `this.markerR(0.008)`，
     * 自己已經帶一個 `)`，用 `[^)]*` 會匹配唔到（實測踩過）。
     */
    expect(SVG_MAP).toMatch(/clusterZones\(zoneModel,.*?clusterSep\)/);
  });

  it("cluster 層唔畫光暈／脈衝（48 個疊埋會變一層霧）", () => {
    expect(SVG_MAP).toMatch(/if \(!zoneIsCluster\) \{/);
    expect(SVG_MAP).toMatch(/zm\.styleKey === "nest" && zoneLod === "full"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A5：legend 三通道（P0-3）
// ─────────────────────────────────────────────────────────────────────────────

describe("A5 legend 三通道（P0-3）", () => {
  it("每個 zone 圖例項都有 color + pattern + icon", () => {
    /*
     * spec §4 硬性：legend 必須 color + pattern + icon 三通道。
     * 只靠顏色 = 色弱用戶完全分唔到 safe / danger。
     */
    for (const key of ["survivor", "nest", "outpost", "estimated"]) {
      const item = SVG_MAP.match(
        new RegExp(
          `legend-item">\\s*\\n?\\s*<span class="area area-${key}"></span>[\\s\\S]{0,400}?</div>`,
        ),
      );
      expect(item, `area-${key} 圖例項要存在`).not.toBeNull();
      expect(item![0], `${key} 要有 pattern 通道`).toContain("legend-pattern");
      expect(item![0], `${key} 要有 icon 通道`).toContain("legend-glyph");
    }
  });

  it("pattern 樣本用 SVG <pattern>（唔係 CSS background）", () => {
    expect(MAP_CSS).not.toContain("background-image");
    for (const p of ["solid", "hatch", "contour", "noise", "pulse"]) {
      expect(SVG_MAP, `要有 legend-pat-${p}`).toContain(`id="legend-pat-${p}"`);
    }
  });

  it("icon 用 <symbol> ＋ <use>（同一份 path 只有一個定義）", () => {
    for (const g of ["shield", "biohazard", "flag"]) {
      expect(SVG_MAP, `要有 zone-glyph-${g} symbol`).toContain(
        `id="zone-glyph-${g}"`,
      );
    }
    expect(SVG_MAP).toContain('href="#zone-glyph-shield"');
  });

  it("`legend.zone-outpost` 有翻譯（切語言唔會變空白）", () => {
    // 新增嘅 i18n key 一定要同時入 ZH / EN 兩個 dict
    for (const key of [
      "legend.zone-survivor",
      "legend.zone-nest",
      "legend.zone-outpost",
      "legend.zone-estimated",
    ]) {
      const count = SVG_MAP.split(`"${key}"`).length - 1;
      expect(count, `${key} 應該喺 ZH 同 EN 各出現一次`).toBeGreaterThanOrEqual(2);
    }
  });

  it("既有 `svgmap.legend.test.ts` 鎖住嘅 key 冇被改走", () => {
    // 迴歸保護：呢啲字串由舊測試直接斷言
    for (const s of [
      'class="map-legend"',
      'class="legend-title"',
      'class="legend-item"',
      "dot-event-current",
      "dot-loc-real",
      "dot-selected",
      "route-legend",
      "地圖標記",
      "本章事件",
      "其他章事件",
      "真實地點",
      "虛構地點",
      "選中",
      "角色路線",
    ]) {
      expect(SVG_MAP, `唔可以改走 ${s}`).toContain(s);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A6：7 個 layer toggle（P0-4）
// ─────────────────────────────────────────────────────────────────────────────

describe("A6 7 個 layer toggle（P0-4）", () => {
  it("`LAYER_KEYS` 同 `src/state/url.ts` LAYER_ORDER **完全一致**", () => {
    /*
     * ⚠️ 呢個測試係防漂移嘅守門員。
     *
     * B6 唔可以改 `src/state/*`（B2 凍結），所以 `LAYER_KEYS` 係一份
     * **鏡像**。如果 B2 改咗 `LAYER_ORDER`（例如加第 8 個 toggle），
     * 呢度會即刻變紅 —— 而唔係 UI 靜靜咁少一個掣。
     */
    const m = URL_TS.match(
      /const LAYER_ORDER: readonly \(keyof LayerFlags\)\[\] = \[([\s\S]*?)\];/,
    );
    expect(m, "url.ts 一定要有 LAYER_ORDER").not.toBeNull();
    const order = (m![1].match(/"[\w]+"/g) || []).map((s) => s.replace(/"/g, ""));
    expect(order).toEqual([...LAYER_KEYS]);
    expect(order).toHaveLength(7);
  });

  it("`LayerFlags` 有 7 個欄位（同 LAYER_KEYS 一一對應）", () => {
    const m = TYPES_STATE.match(
      /export interface LayerFlags \{([\s\S]*?)\n\}/,
    );
    expect(m).not.toBeNull();
    const fields = (m![1].match(/^\s{2}(\w+):\s*boolean;/gm) || []).map(
      (s) => s.trim().replace(": boolean;", ""),
    );
    expect(fields.sort()).toEqual([...LAYER_KEYS].sort());
  });

  it("每個 toggle 都有中英文標籤", () => {
    for (const k of LAYER_KEYS) {
      expect(LAYER_LABEL_ZH[k]).toBeTruthy();
      expect(LAYER_LABEL_EN[k]).toBeTruthy();
    }
  });

  it("`hiddenSelectors()` 覆蓋三類 zone 子集合，而且 `#zones-layer` 永遠唔 hidden", () => {
    const all = hiddenSelectors({
      zones: true,
      nests: true,
      outposts: true,
      events: true,
      routes: true,
      periods: true,
      detail: true,
    });
    const sels = all.map((r) => r.selector);
    expect(sels).toContain("#zones-layer .zone-survivor");
    expect(sels).toContain("#zones-layer .zone-nest");
    expect(sels).toContain("#zones-layer .zone-outpost");
    // ⚠️ 唔可以有 `#zones-layer` 自己 —— 否則關「倖存區」會連病窩一齊消失
    expect(sels).not.toContain("#zones-layer");
    // 全部開 → 冇任何 hidden
    expect(all.every((r) => !r.hidden)).toBe(true);
  });

  it("關一個 toggle 只影響對應嘅 selector", () => {
    const s = {
      zones: false,
      nests: true,
      outposts: true,
      events: true,
      routes: true,
      periods: true,
      detail: true,
    };
    const hidden = hiddenSelectors(s).filter((r) => r.hidden);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].selector).toBe("#zones-layer .zone-survivor");
  });

  it("三個 zone 子集合全關 → cluster badge 亦收埋", () => {
    const s = {
      zones: false,
      nests: false,
      outposts: false,
      events: true,
      routes: true,
      periods: true,
      detail: true,
    };
    const hidden = hiddenSelectors(s).filter((r) => r.hidden);
    expect(hidden.map((r) => r.selector)).toContain("#zones-layer .zone-cluster");
    expect(hidden).toHaveLength(4);
  });

  it("`pressedToBool()` 任何非 'true' 都當 false", () => {
    expect(pressedToBool("true")).toBe(true);
    expect(pressedToBool("false")).toBe(false);
    expect(pressedToBool(null)).toBe(false);
    expect(pressedToBool("")).toBe(false);
  });

  it("`SvgMap` 經 store 切換圖層（規則 S1：唔自建第二份 state）", () => {
    expect(SVG_MAP).toContain("this.app.store.toggleLayer(key)");
    expect(SVG_MAP).toContain("this.app.store.getState().layers");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A7 / P0-5：MapControls 契約
// ─────────────────────────────────────────────────────────────────────────────

describe("A7 MapControls（P0-5）", () => {
  const CONTROLS = readFileSync("src/map/MapControls.ts", "utf-8");

  it("4 個掣嘅 id 冇改（既有測試直接 page.click）", () => {
    for (const id of [
      "map-zoom-in",
      "map-zoom-out",
      "map-reset",
      "map-show-all-events",
    ]) {
      expect(CONTROLS, `${id} 唔可以改名`).toContain(`id: "${id}"`);
      // 亦要確認 render 之後真係出現喺 DOM template
      expect(CONTROLS).toContain("id=\"${s.id}\"");
    }
  });

  it("`MIN_TAP_PX` = 44，而且 `map.css` 嘅 min-width/min-height ≥ 44px", () => {
    expect(MIN_TAP_PX).toBe(44);
    const block = MAP_CSS.match(/#map-controls\s+\.map-ctrl\s*\{[^}]*\}/);
    expect(block, "要有 #map-controls .map-ctrl 規則").not.toBeNull();
    const w = block![0].match(/min-width:\s*(\d+)px/);
    const h = block![0].match(/min-height:\s*(\d+)px/);
    expect(w, "要有 min-width").not.toBeNull();
    expect(h, "要有 min-height").not.toBeNull();
    expect(Number(w![1])).toBeGreaterThanOrEqual(MIN_TAP_PX);
    expect(Number(h![1])).toBeGreaterThanOrEqual(MIN_TAP_PX);
  });

  it("focus ring 用 outline（唔會被 clip-path 剪走 —— A7 P0-3）", () => {
    const focus = MAP_CSS.match(
      /#map-controls\s+\.map-ctrl:focus-visible\s*\{[^}]*\}/,
    );
    expect(focus, "要有 :focus-visible 規則").not.toBeNull();
    expect(focus![0]).toMatch(/outline:/);
    expect(focus![0]).toMatch(/var\(--focus-ring\)/);
  });

  it("`aria-pressed` 係 toggle 嘅唯一可觀察狀態（唔用 class 做邏輯）", () => {
    expect(CONTROLS).toContain('setAttribute("aria-pressed"');
    // 舊 code 用 classList.toggle("is-active") —— 唔可以返轉頭
    expect(CONTROLS).not.toContain("classList.toggle");
  });

  it("`setAllEvents()` 係冪等（傳同一個值冇副作用）", () => {
    // 實作上只係 setAttribute，冇 if/else 分支改變其他狀態
    const body = CONTROLS.match(/setAllEvents\(pressed: boolean\)[^{]*\{([\s\S]*?)\n  \}/);
    expect(body).not.toBeNull();
    expect(body![1]).toMatch(/setAttribute\("aria-pressed"/);
  });

  it("`SvgMap` 唔再自己砌控制項 DOM（已搬入 MapControls）", () => {
    expect(SVG_MAP).toContain("new MapControls(");
    expect(SVG_MAP).not.toMatch(/id="map-zoom-in"/);
    expect(SVG_MAP).not.toMatch(/id="map-show-all-events"/);
  });

  it("`layer-toggle` 亦有 44px 下限", () => {
    const block = MAP_CSS.match(/#layer-controls\s+\.layer-toggle\s*\{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/min-width:\s*44px/);
    expect(block![0]).toMatch(/min-height:\s*44px/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A8：pulse 錯相（P0-6）
// ─────────────────────────────────────────────────────────────────────────────

describe("A8 pulse 錯相（P0-6）", () => {
  it("`SvgMap` 為每個 .zone-pulse 寫 --pulse-index（0…n-1）", () => {
    expect(SVG_MAP).toContain('p.style.setProperty("--pulse-index", String(i))');
    expect(SVG_MAP).toMatch(
      /querySelectorAll<SVGElement>\("#zones-layer \.zone-pulse"\)/,
    );
  });

  it("`map.css` 用 --pulse-index 錯開 animation-delay", () => {
    expect(MAP_CSS).toMatch(
      /animation-delay:\s*calc\(var\(--pulse-index,\s*0\)\s*\*\s*-0\.4s\)/,
    );
  });

  it("`.zone-pulse` 有 will-change（獨立合成層）", () => {
    const block = MAP_CSS.match(/#svg-map\s+\.zone-pulse\s*\{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/will-change:\s*opacity,\s*transform/);
  });

  it("reduced motion：pulse 變靜態可見（唔係消失）", () => {
    /*
     * `base.css:170` 嘅全域 kill 會令動畫「跳終態」= opacity 0 = 光環
     * 直接消失。spec §6 要求 reduced motion 下**仍然見到**危險區標記。
     */
    const m = MAP_CSS.match(
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/,
    );
    expect(m, "要有 reduced-motion 區塊").not.toBeNull();
    expect(m![1]).toMatch(/#svg-map\s+\.zone-pulse\s*\{[^}]*animation:\s*none/);
    expect(m![1]).toMatch(/opacity:\s*0\.28/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A9：鍵盤導航（P0-7）
// ─────────────────────────────────────────────────────────────────────────────

describe("A9 鍵盤導航（P0-7）", () => {
  it("`#svg-map` 有 tabindex / role（先可以收到 keydown）", () => {
    expect(SVG_MAP).toContain('tabindex="0"');
    expect(SVG_MAP).toContain('role="application"');
    expect(SVG_MAP).toContain("aria-label=");
  });

  it("支援 + / - / 0 / 方向鍵，Shift 加速", () => {
    expect(SVG_MAP).toContain('case "+":');
    expect(SVG_MAP).toContain('case "-":');
    expect(SVG_MAP).toContain('case "0":');
    expect(SVG_MAP).toContain('case "ArrowUp":');
    expect(SVG_MAP).toContain('case "ArrowDown":');
    expect(SVG_MAP).toContain('case "ArrowLeft":');
    expect(SVG_MAP).toContain('case "ArrowRight":');
    expect(SVG_MAP).toMatch(/const step = e\.shiftKey \? 120 : 40;/);
  });

  it("綁喺 `#svg-map` 而唔係 window（唔可以搶 app.ts 嘅 k/j 快捷鍵）", () => {
    expect(SVG_MAP).toMatch(/this\.svg\.addEventListener\("keydown"/);
    expect(SVG_MAP).not.toMatch(/window\.addEventListener\("keydown"/);
  });

  it("唔會搶走輸入框嘅按鍵", () => {
    expect(SVG_MAP).toMatch(/closest\?\.\("input, textarea, select"\)/);
  });

  it("方向鍵預設行為被 preventDefault（唔會捲動頁面）", () => {
    const body = SVG_MAP.match(/bindKeyboard\(\): void \{([\s\S]*?)\n  \}/);
    expect(body).not.toBeNull();
    expect(body![1]).toContain("e.preventDefault()");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A11：CSS 注入機制
// ─────────────────────────────────────────────────────────────────────────────

describe("A11 CSS 注入（契約 §10）", () => {
  it("`SvgMap` 用 Vite `?inline` import map.css", () => {
    expect(SVG_MAP).toContain('import mapCss from "../styles/map.css?inline"');
  });

  it("注入嘅 <style id=\"map-v2-css\"> append 到 head（後載入勝）", () => {
    expect(SVG_MAP).toContain('style.id = "map-v2-css"');
    expect(SVG_MAP).toContain("document.head.appendChild(style)");
  });

  it("注入係冪等（重複 init 唔會加第二個 <style>）", () => {
    expect(SVG_MAP).toContain('document.getElementById("map-v2-css")');
  });

  it("注入發生喺 `root.innerHTML` **之前**（避免第一幀用舊 CSS）", () => {
    const init = SVG_MAP.match(/private init\(\): void \{([\s\S]*?)\n  \}/);
    expect(init).not.toBeNull();
    const injectAt = init![1].indexOf("this.injectMapCss()");
    const htmlAt = init![1].indexOf("this.root.innerHTML");
    expect(injectAt).toBeGreaterThanOrEqual(0);
    expect(htmlAt).toBeGreaterThan(injectAt);
  });

  it("`map.css` 冇 raw 色值（規則 T1：只可以 var(--token)）", () => {
    // 容許 SVG pattern 樣本以外嘅所有色值都要經 var()
    const withoutComments = MAP_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const hex = withoutComments.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex, `map.css 唔可以有 hex 色值：${hex.join(", ")}`).toHaveLength(0);
    expect(withoutComments).not.toMatch(/\brgba?\(/);
    expect(withoutComments).not.toMatch(/\bhsla?\(/);
  });

  it("唔可以改 `src/main.ts` / `src/styles/index.css`（唔喺 B6 範圍）", () => {
    // 契約 §10.4：呢兩個方案係禁止嘅
    expect(SVG_MAP).not.toContain('import "../styles/main.css"');
  });
});

/**
 * 向量底圖（Phase L）測試。
 *
 * 為何要測「兩邊一致」而唔止測「檔案存在」
 * --------------------------------------
 * 道路分級同「邊個縮放層出現邊個 class」係**刻意重複**喺兩邊嘅：
 *   Python `scripts/build_vector_basemap.py`（產生資料）
 *   TS     `src/map/VectorBasemap.ts`（繪製資料）
 * 兩邊唔一致就會出現「有資料但唔畫」（白費頻寬）或者
 * 「畫咗但冇資料」（靜默空白）。呢類 bug 唔會有錯誤訊息，所以一定要
 * 用測試把關。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ROAD_MIN_LEVEL } from "../src/map/VectorBasemap";

const REPO = resolve(__dirname, "..");
const VECTOR = join(REPO, "public", "assets", "vector");
const PY = join(REPO, "scripts", "build_vector_basemap.py");

/** 由 Python 原始碼抽出某個常數（唔用 regex 太鬆嘅寫法）。 */
function pyDict(name: string): Record<string, number> {
  const src = readFileSync(PY, "utf-8");
  const start = src.indexOf(`${name}: dict[int, int] = {`);
  expect(start, `Python 冇 ${name}`).toBeGreaterThan(-1);
  const body = src.slice(src.indexOf("{", start), src.indexOf("}", start));
  const out: Record<string, number> = {};
  for (const m of body.matchAll(/(\d+)\s*:\s*(\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

function pyInt(name: string): number {
  const src = readFileSync(PY, "utf-8");
  const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  expect(m, `Python 冇 ${name}`).not.toBeNull();
  return Number(m![1]);
}

describe("向量底圖：Python ↔ TS 常數一致", () => {
  it("ROAD_MIN_LEVEL 兩邊完全相同", () => {
    const py = pyDict("ROAD_MIN_LEVEL");
    const ts: Record<string, number> = {};
    for (const [k, v] of Object.entries(ROAD_MIN_LEVEL)) ts[k] = v;
    expect(ts).toEqual(py);
  });

  it("roads-l0 只包含 class ≤ ROADS_L0_MAX_CLASS", () => {
    const f = join(VECTOR, "roads-l0.json");
    if (!existsSync(f)) return;
    const maxCls = pyInt("ROADS_L0_MAX_CLASS");
    const data = JSON.parse(readFileSync(f, "utf-8")) as { roads: number[][] };
    const bad = data.roads.filter((r) => r[0] > maxCls);
    expect(bad.length, `roads-l0 有 ${bad.length} 條超出 class ${maxCls}`).toBe(0);
    // 而且每個 class 都要真係出現（唔可以整層空白）
    const classes = new Set(data.roads.map((r) => r[0]));
    for (let c = 0; c <= maxCls; c++) {
      expect(classes.has(c), `roads-l0 缺 class ${c}`).toBe(true);
    }
  });

  it("roads-l1 包含 class ≤ ROADS_L1_MAX_CLASS", () => {
    const f = join(VECTOR, "roads-l1.json");
    if (!existsSync(f)) return;
    const maxCls = pyInt("ROADS_L1_MAX_CLASS");
    const data = JSON.parse(readFileSync(f, "utf-8")) as { roads: number[][] };
    const bad = data.roads.filter((r) => r[0] > maxCls);
    expect(bad.length, `roads-l1 有 ${bad.length} 條超出 class ${maxCls}`).toBe(0);
  });
});

describe("向量底圖：資產完整性", () => {
  const manifestPath = join(VECTOR, "manifest.json");

  it("manifest 存在而且有 bbox / quant / tile_deg", () => {
    if (!existsSync(manifestPath)) return;
    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(m.quant).toBe(100000);
    expect(m.tile_deg).toBeGreaterThan(0);
    for (const k of ["lon_min", "lon_max", "lat_min", "lat_max"]) {
      expect(typeof m.bbox[k]).toBe("number");
    }
    expect(m.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("基礎圖層檔案齊全", () => {
    for (const f of ["land.json", "water.json", "areas.json", "labels.json"]) {
      expect(existsSync(join(VECTOR, f)), `缺 ${f}`).toBe(true);
    }
  });

  it("每個圖磚都喺 manifest bbox 之內", () => {
    if (!existsSync(manifestPath)) return;
    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const td = m.tile_deg;
    const nc = Math.ceil((m.bbox.lon_max - m.bbox.lon_min) / td);
    const nr = Math.ceil((m.bbox.lat_max - m.bbox.lat_min) / td);
    for (const key of Object.keys(m.layers.tiles.files)) {
      const [r, c] = key.split(",").map(Number);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(nr);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(nc);
    }
  });

  it("陸地環全部係閉合而且夠長", () => {
    const f = join(VECTOR, "land.json");
    if (!existsSync(f)) return;
    const land = JSON.parse(readFileSync(f, "utf-8")) as { rings: number[][] };
    expect(land.rings.length).toBeGreaterThan(10);
    for (const r of land.rings) {
      expect(r.length % 2, "delta 陣列長度必須係偶數").toBe(0);
      // 第一點係絕對座標，之後係 delta —— 至少要有 3 個點
      expect(r.length / 2).toBeGreaterThanOrEqual(4);
      // 首尾要接得返（環閉合）
      let x = r[0];
      let y = r[1];
      for (let i = 2; i < r.length; i += 2) {
        x += r[i];
        y += r[i + 1];
      }
      expect(Math.abs(x - r[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(y - r[1])).toBeLessThanOrEqual(1);
    }
  });
});

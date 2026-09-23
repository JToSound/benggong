// BaseGeometryLayer.addTileChunked —— 圖磚分片處理（B9 Q10 冷 zoom 阻塞）
//
// 為何要呢個檔
// ============
// CDP profile 實測：一格圖磚（~4,500 幢建築）嘅「`decodeDelta` +
// `Path2D` 建立」要 **~59 ms**，一次過做就係一個 59 ms 嘅 longtask。
// `addTileChunked` 將 `Path2D` 建立分片，每片之間 `await` 讓出主線程。
//
// 呢個檔守住三件容易錯嘅事：
//   1. **分片數同讓出次數**：N 片應該有 N−1 次讓出（最後一片唔需要）。
//   2. **結果等同同步版**：分片之後嘅 `tileCount` / `buildingCount` /
//      分桶結果要同 `addTile` 完全一致。
//   3. **讓出必須係 macrotask**：`VectorBasemap` 傳入嘅 `yieldToEventLoop`
//      唔可以用 microtask（`Promise.resolve()`）—— microtask 唔會讓出
//      rendering，分片就冇意義。呢點喺原始碼層面鎖住。

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 極簡 `Path2D` stub —— node 環境冇 `Path2D`（只有瀏覽器有）。 */
class FakePath2D {
  calls = 0;
  moveTo(): void {
    this.calls++;
  }
  lineTo(): void {
    this.calls++;
  }
  closePath(): void {
    this.calls++;
  }
  addPath(): void {
    this.calls++;
  }
}

const SRC = readFileSync("src/map/VectorBasemap.ts", "utf-8");

beforeEach(() => {
  (globalThis as unknown as { Path2D: unknown }).Path2D = FakePath2D;
});

/** 動態 import：一定要喺 Path2D stub 之後（模組載入時唔會用 Path2D，但保險）。 */
async function loadLayer() {
  const mod = await import("../src/map/BaseGeometryLayer");
  return mod;
}

function bld(n: number, levels = 3) {
  // 一個 3 點三角形（唔重複最後一點）
  const pts = new Float64Array([0, 0, 1, 0, 1, 1]);
  return Array.from({ length: n }, () => ({ pts, levels }));
}

/** 一個以 `(cx, cy)` 為**精確質心**嘅正方形（4 點，唔重複最後一點）。 */
function boxAt(cx: number, cy: number, d = 0.001, levels = 3) {
  return {
    pts: new Float64Array([cx - d, cy - d, cx + d, cy - d, cx + d, cy + d, cx - d, cy + d]),
    levels,
  };
}

describe("addTileChunked — 分片 + 讓出", () => {
  it("⭐ 每片之間讓出一次（N 片 = N−1 次讓出）", async () => {
    const { BaseGeometryLayer } = await loadLayer();
    const geom = new BaseGeometryLayer();
    let yields = 0;
    await geom.addTileChunked(
      "4,6",
      { roads: [], bld: bld(2500) },
      async () => {
        yields++;
      },
      600,
    );
    // ceil(2500 / 600) = 5 片 → 4 次讓出
    expect(yields).toBe(4);
  });

  it("讓出次數隨分片大細改變（同一批資料）", async () => {
    const { BaseGeometryLayer } = await loadLayer();
    // 1000 幢：yields = ceil(1000 / chunk) − 1
    const sizes: Array<[number, number]> = [
      [100, 9], // 10 片 → 9
      [400, 2], // 3 片 → 2
      [1000, 0], // 1 片 → 0
      [3000, 0], // 1 片 → 0
    ];
    for (const [chunk, expected] of sizes) {
      const geom = new BaseGeometryLayer();
      let yields = 0;
      await geom.addTileChunked(
        "0,0",
        { roads: [], bld: bld(1000) },
        async () => {
          yields++;
        },
        chunk,
      );
      expect(yields, `chunk=${chunk}`).toBe(expected);
    }
  });

  it("⭐ 結果同同步版 `addTile` 一致（分片唔可以改語義）", async () => {
    const { BaseGeometryLayer } = await loadLayer();
    const roads = [
      { cls: 3, flags: 0, pts: new Float64Array([0, 0, 1, 1]) },
      { cls: 5, flags: 0, pts: new Float64Array([0, 1, 1, 0]) },
    ];
    const buildings = bld(137, 3);

    const sync = new BaseGeometryLayer();
    sync.addTile("4,6", { roads, bld: buildings });

    const chunked = new BaseGeometryLayer();
    await chunked.addTileChunked("4,6", { roads, bld: buildings }, async () => {}, 25);

    expect(chunked.tileCount).toBe(sync.tileCount);
    expect(chunked.buildingCount).toBe(sync.buildingCount);
    expect(chunked.buildingCount).toBe(137);
  });

  it("空圖磚：唔會讓出，仍然登記為一格", async () => {
    const { BaseGeometryLayer } = await loadLayer();
    const geom = new BaseGeometryLayer();
    let yields = 0;
    await geom.addTileChunked(
      "1,2",
      { roads: [], bld: [] },
      async () => {
        yields++;
      },
      600,
    );
    expect(yields).toBe(0);
    expect(geom.tileCount).toBe(1);
    expect(geom.buildingCount).toBe(0);
  });

  it("同一格重複加入唔會累加（先 removeTile）", async () => {
    const { BaseGeometryLayer } = await loadLayer();
    const geom = new BaseGeometryLayer();
    await geom.addTileChunked("4,6", { roads: [], bld: bld(50) }, async () => {}, 20);
    await geom.addTileChunked("4,6", { roads: [], bld: bld(50) }, async () => {}, 20);
    expect(geom.tileCount).toBe(1);
    expect(geom.buildingCount).toBe(50);
  });

  it("讓出函數會被 `await`（唔係 fire-and-forget）", async () => {
    const { BaseGeometryLayer } = await loadLayer();
    const geom = new BaseGeometryLayer();
    const order: string[] = [];
    const spy = vi.fn(async () => {
      order.push("yield");
    });
    await geom.addTileChunked("4,6", { roads: [], bld: bld(120) }, spy, 50);
    order.push("done");
    // ceil(120 / 50) = 3 片 → 2 次讓出，而且全部喺完成之前
    expect(spy).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["yield", "yield", "done"]);
  });
});

describe("視窗內建築數（B9 RC-NOFAKEZOOM-ACCUM）", () => {
  it("⭐ 只計視窗內嘅建築（唔可以跨圖磚累加）", async () => {
    /*
     * 原本嘅 bug：`lowDensity` 用 `tileBuildingCount`（**跨已載入圖磚累加**），
     * LRU 上限 24 格 → 先睇過密集區再去稀疏區會誤報 `ok`，唔顯示
     * 「此區未有細節資料」。
     */
    const { BaseGeometryLayer } = await loadLayer();
    const geom = new BaseGeometryLayer();
    const dense = Array.from({ length: 10 }, (_, i) => boxAt(0.001 + i * 0.001, 0.001));
    const sparse = [boxAt(1.001, 1.001)];
    await geom.addTileChunked("dense", { roads: [], bld: dense }, async () => {}, 4);
    await geom.addTileChunked("sparse", { roads: [], bld: sparse }, async () => {}, 4);

    // 累加值（舊行為）：11 —— 稀疏視窗會誤報「唔稀疏」
    expect(geom.buildingCount).toBe(11);
    // 視窗內（新行為）：稀疏格只有 1 幢
    expect(geom.countBuildingsInView(1.0, 1.01, 1.0, 1.01)).toBe(1);
    expect(geom.countBuildingsInView(0.0, 0.02, 0.0, 0.02)).toBe(10);
    // 視窗外
    expect(geom.countBuildingsInView(5, 6, 5, 6)).toBe(0);
  });

  it("視窗邊界係包含式（`>=` / `<=`）", async () => {
    const { BaseGeometryLayer } = await loadLayer();
    const geom = new BaseGeometryLayer();
    await geom.addTileChunked(
      "t",
      { roads: [], bld: [boxAt(0.5, 0.5)] },
      async () => {},
      4,
    );
    expect(geom.countBuildingsInView(0.5, 0.5, 0.5, 0.5)).toBe(1);
    expect(geom.countBuildingsInView(0.51, 0.6, 0.51, 0.6)).toBe(0);
  });

  it("質心計算：正方形質心 = 中心點", async () => {
    const { centroidsOf } = await loadLayer();
    const c = centroidsOf([boxAt(0.25, -0.75), boxAt(1.5, 2.25)]);
    expect(c.length).toBe(4);
    expect(c[0]).toBeCloseTo(0.25, 12);
    expect(c[1]).toBeCloseTo(-0.75, 12);
    expect(c[2]).toBeCloseTo(1.5, 12);
    expect(c[3]).toBeCloseTo(2.25, 12);
  });

  it("移除圖磚之後唔再計入視窗數", async () => {
    const { BaseGeometryLayer } = await loadLayer();
    const geom = new BaseGeometryLayer();
    await geom.addTileChunked("a", { roads: [], bld: [boxAt(0.1, 0.1)] }, async () => {}, 4);
    await geom.addTileChunked("b", { roads: [], bld: [boxAt(0.1, 0.1)] }, async () => {}, 4);
    expect(geom.countBuildingsInView(0, 1, 0, 1)).toBe(2);
    geom.removeTile("a");
    expect(geom.countBuildingsInView(0, 1, 0, 1)).toBe(1);
    geom.clearTiles();
    expect(geom.countBuildingsInView(0, 1, 0, 1)).toBe(0);
  });

  it("空幾何唔會污染質心（避免 NaN）", async () => {
    const { centroidsOf } = await loadLayer();
    const c = centroidsOf([{ pts: new Float64Array([]) }]);
    expect(Number.isNaN(c[0])).toBe(false);
    expect(c[0]).toBe(0);
    expect(c[1]).toBe(0);
  });
});

describe("讓出必須係 macrotask（原始碼守門）", () => {
  it("⭐ `yieldToEventLoop` 用 `setTimeout` 而唔係 `Promise.resolve`", () => {
    /*
     * microtask（`Promise.resolve()` / `queueMicrotask`）**唔會**讓出
     * rendering 或者輸入處理 —— 分片之後仍然係同一個 task，longtask
     * 唔會消失。所以呢個一定要係 macrotask。
     */
    const i = SRC.indexOf("const yieldToEventLoop");
    expect(i, "搵唔到 yieldToEventLoop 定義").toBeGreaterThan(-1);
    const def = SRC.slice(i, i + 260);
    expect(def).toContain("setTimeout");
    expect(def).not.toMatch(/Promise\.resolve\(\)|queueMicrotask/);
  });

  it("圖磚建築有分片（唔可以一次過 map 全部）", () => {
    expect(SRC).toContain("addTileChunked(");
    // 分片解碼：迴圈用 TILE_CHUNK
    expect(SRC).toMatch(/for \(let i = 0; i < rawBld\.length; i \+= TILE_CHUNK\)/);
  });

  it("分片大細落到 longtask 門檻之下（≤ 1000 幢／片）", () => {
    const m = SRC.match(/const TILE_CHUNK = (\d+)/);
    expect(m, "搵唔到 TILE_CHUNK").not.toBeNull();
    const chunk = Number(m![1]);
    // 實測 4,500 幢 ≈ 59 ms → 每 1,000 幢 ≈ 13 ms；留安全邊際
    expect(chunk).toBeLessThanOrEqual(1000);
    expect(chunk).toBeGreaterThan(100);
  });
});

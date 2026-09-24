// 圖磚負快取（`tileMissing`）—— 用戶報告 renderer OOM 嘅直接成因
//
// 背景
// ====
// 圖磚格網係 `10×14 = 140` 格，但只有 **89 格**有檔案 —— 其餘 51 格全部
// 喺 bbox 上下邊緣（陸地之外，生成器冇出）。
//
// 原本 `ensureTiles()` 只檢查 `tilePoi` / `tilePending`，而失敗路徑係
// `.catch(() => {})` + `.finally(() => tilePending.delete(k))` → 失敗嘅格
// **兩個集合都唔在** → 下一個 `setView()`（**每個 pan frame**）會再試。
// `clampView()` 令視窗好容易停喺 bbox 邊緣 → 邊緣缺失格長期留在視窗內
// → **每 frame 重試**。
//
// 實測（`artifacts/phase3-resume/probe-tile-404.mjs`）：
//   · 修復前：向北推 6 次 → 非 JSON 圖磚回應 0 → **26**，新增 fetch 全部失敗
//   · 修復後：**0 → 2**，第 5 步之後唔再增長
//
// ⚠️ 為何要靜態守門：`VectorBasemap` 要 canvas + DOM 才可以 instantiate，
// 而呢個不變式（「失敗嘅格一定要記住」）係**純結構性**嘅 —— 一旦有人
// 喺 `.catch` 入面移除 `tileMissing.add(k)`，就會靜靜回復重試風暴。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/map/VectorBasemap.ts", "utf-8");

describe("圖磚負快取（tileMissing）", () => {
  it("有宣告 `tileMissing` 集合", () => {
    expect(SRC).toMatch(/private readonly tileMissing = new Set<string>\(\)/);
  });

  it("⭐ `ensureTiles()` 一定要檢查 `tileMissing`（唔可以只查 poi／pending）", () => {
    const i = SRC.indexOf("private ensureTiles(");
    expect(i, "搵唔到 ensureTiles").toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 1200);
    expect(body).toMatch(/tilePoi\.has\(k\)\s*\|\|\s*this\.tilePending\.has\(k\)\s*\|\|\s*this\.tileMissing\.has\(k\)/);
  });

  it("⭐ 失敗路徑一定要 `tileMissing.add(k)`（唔可以靜靜吞咗）", () => {
    const i = SRC.indexOf("private ensureTiles(");
    const body = SRC.slice(i, i + 8000);
    const catchIdx = body.indexOf(".catch(");
    expect(catchIdx, "搵唔到 .catch").toBeGreaterThan(-1);
    const catchBody = body.slice(catchIdx, catchIdx + 700);
    expect(catchBody).toContain("this.tileMissing.add(k)");
  });

  it("⭐ 層級改變時清空 `tileMissing`（換層值得重試一次）", () => {
    const i = SRC.indexOf("setView(view: ViewBox");
    expect(i, "搵唔到 setView").toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 1400);
    expect(body).toContain("this.tileMissing.clear()");
  });

  it("`fetchJSON` 會拒絕 HTML 回應（SPA fallback 唔可以被當成有效圖磚）", () => {
    const i = SRC.indexOf("private async fetchJSON(");
    expect(i).toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 800);
    expect(body).toContain("text/html");
    expect(body).toContain("throw");
  });

  it("負快取係 per-instance（唔可以係 module-level 共用）", () => {
    // module-level 集合會令多次 instantiate 之間互相污染
    expect(SRC).not.toMatch(/^const tileMissing/m);
  });
});

describe("圖磚格網完整性（資料不變式）", () => {
  it("manifest 嘅 bbox／tile_deg 同實際 tile 檔數目一致（記錄已知缺口）", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const m = JSON.parse(
      await readFile("public/assets/vector/manifest.json", "utf-8"),
    ) as { bbox: { lon_min: number; lon_max: number; lat_min: number; lat_max: number }; tile_deg: number };
    const have = new Set(await readdir("public/assets/vector/tiles"));
    const nc = Math.ceil((m.bbox.lon_max - m.bbox.lon_min) / m.tile_deg);
    const nr = Math.ceil((m.bbox.lat_max - m.bbox.lat_min) / m.tile_deg);
    const missing: string[] = [];
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) {
        const k = `r${String(r).padStart(2, "0")}c${String(c).padStart(2, "0")}.json`;
        if (!have.has(k)) missing.push(k);
      }
    }
    // 缺口係**預期**（陸地之外），但一定要有負快取擋住重試風暴。
    expect(missing.length, "格網缺口數（預期 ~51）").toBeGreaterThan(0);
    expect(missing.length).toBeLessThan(nr * nc);
    // 頭尾兩行（緯度邊緣）一定係缺 —— 如果唔係，缺口假設要重新檢查
    expect(missing.some((k) => k.startsWith("r00"))).toBe(true);
  });
});

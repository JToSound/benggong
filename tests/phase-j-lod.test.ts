// 《病港》Phase J — LOD 縮放與投影對齊回歸測試
//
// 呢個檔案保護三個今次修正嘅嚴重缺陷，避免日後回退：
//
// 1. **底圖垂直拉伸 1.622 倍**（投影錯配）
//    舊底圖係 2048×2048 正方形但覆蓋 0.6°×0.37°，再配
//    `preserveAspectRatio="slice"` 放入同比例嘅框，結果底圖相對標記
//    座標系被垂直拉伸 1.622 倍（以中心為軸），邊緣偏差 ±0.115°≈12.8 km。
//
// 2. **平移速度錯 1.24 倍**
//    `<svg>` 用 `preserveAspectRatio="meet"`，實際比例係
//    `min(rectW/view.w, rectH/view.h)`；舊寫法假設兩軸獨立。
//
// 3. **標記喺深縮放時過大**
//    標記半徑寫死 user unit，街道級（view 寬 0.058°）時佔畫面 27%。

import { readFileSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { describe, expect, it } from "vitest";

import basemapCoords from "../public/assets/hk-basemap-coords.json";
import lodManifest from "../public/assets/map-lod/manifest.json";
// ⚠️ MAX_SCALE 由政策模組 import，唔再由 `SvgMap.ts` 源碼 regex 抽。
//    `SvgMap.ts` 已改為 import 同一個政策值（唔再寫死 64），舊 regex
//    `/const MAX_SCALE = (\d+)/` 會捉唔到 —— 即使加返 fallback 都會
//    靜默讀到一個**唔生效**嘅數字（B-MAX-2）。
import { MAX_SCALE } from "../src/map/map-lod";

const BASE_URL = "http://localhost:5174";
const SRC_RAW = readFileSync("src/components/SvgMap.ts", "utf-8");

/** 去掉註解後嘅原始碼 —— 註解會提到舊有錯誤寫法，唔應該當成實作。 */
const SRC = SRC_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const BBOX = basemapCoords.bbox;
const LON_SPAN = BBOX.lon_max - BBOX.lon_min;
const LAT_SPAN = BBOX.lat_max - BBOX.lat_min;

describe("Phase J: 投影對齊（底圖 ↔ 標記座標系）", () => {
  it("底圖 bbox 同 metadata 一致，而且唔係正方形", () => {
    expect(basemapCoords.canvas.width).toBeGreaterThan(0);
    expect(basemapCoords.canvas.height).toBeGreaterThan(0);
    // 正方形 = 垂直被拉伸（香港 bbox 長寬比約 1.4，唔可能係 1.0）
    expect(basemapCoords.canvas.width).not.toBe(basemapCoords.canvas.height);
  });

  it("畫布長寬比 = 經度跨度 ÷ (緯度跨度 ÷ cos φ₀)", () => {
    const lat0 = basemapCoords.standard_parallel;
    const expected = LON_SPAN / (LAT_SPAN / Math.cos((lat0 * Math.PI) / 180));
    const actual = basemapCoords.canvas.width / basemapCoords.canvas.height;
    expect(actual).toBeCloseTo(expected, 3);
  });

  it("SVG BASE_VIEW 由底圖 bbox 推導，唔會寫死舊數值", () => {
    // 舊版寫死 { x: 113.85, y: 22.18, w: 0.6, h: 0.37 } —— 呢個係 1.622 拉伸嘅來源
    expect(SRC).not.toMatch(/BASE_VIEW\s*=\s*\{\s*x:\s*113\.85/);
    expect(SRC).toContain("BASEMAP_BBOX.lon_min");
    expect(SRC).toContain("PROJ_COS");
  });

  it("垂直方向有做 1/cos(φ₀) 校正", () => {
    expect(SRC).toMatch(/h:\s*\(BASEMAP_BBOX\.lat_max\s*-\s*BASEMAP_BBOX\.lat_min\)\s*\/\s*PROJ_COS/);
  });

  it("圖磚用 preserveAspectRatio=\"none\" 精確貼合經緯矩形", () => {
    // slice 會裁切並造成拉伸；none 才可以令圖磚 ↔ 經緯完全線性對應
    expect(SRC).not.toContain('preserveAspectRatio="xMidYMid slice"');
    const matches = SRC.match(/preserveAspectRatio="none"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Phase J: LOD 圖磚 manifest", () => {
  const tiers = lodManifest.tiers;

  it("至少有 overview 同一個細節層", () => {
    expect(tiers.length).toBeGreaterThanOrEqual(2);
    expect(tiers.some((t) => t.id === "overview")).toBe(true);
  });

  it("每層都有 bbox、輸出尺寸同圖檔路徑", () => {
    for (const t of tiers) {
      expect(t.bbox, `${t.id} 缺 bbox`).toBeTruthy();
      expect(t.output_size[0]).toBeGreaterThan(0);
      expect(t.output_size[1]).toBeGreaterThan(0);
      expect(t.image).toMatch(/\.png$/);
    }
  });

  it("總覽層最闊，其餘層都比佢窄", () => {
    // 注意：層級之間**唔一定**嚴格遞減。同一個 zoom 級別可以有多個
    // 「兄弟層」覆蓋唔同地區（例如 tko-campus 同 tko-north 都係街道級，
    // 但針對唔同叢集）。所以只可以要求「總覽層最闊」。
    const ov = tiers.find((t) => t.id === "overview")!;
    const ovSpan = ov.bbox.lon_max - ov.bbox.lon_min;
    for (const t of tiers) {
      if (t.id === "overview") continue;
      const span = t.bbox.lon_max - t.bbox.lon_min;
      expect(span, `${t.id} 應該比 overview 窄`).toBeLessThan(ovSpan);
    }
    expect(ovSpan).toBe(Math.max(...tiers.map((t) => t.bbox.lon_max - t.bbox.lon_min)));
  });

  it("冇兩個圖磚有完全相同嘅 bbox", () => {
    const keys = tiers.map(
      (t) => `${t.bbox.lon_min},${t.bbox.lon_max},${t.bbox.lat_min},${t.bbox.lat_max}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("所有層級 bbox 都喺全港底圖 bbox 之內", () => {
    for (const t of tiers) {
      expect(t.bbox.lon_min).toBeGreaterThanOrEqual(BBOX.lon_min - 1e-9);
      expect(t.bbox.lon_max).toBeLessThanOrEqual(BBOX.lon_max + 1e-9);
      expect(t.bbox.lat_min).toBeGreaterThanOrEqual(BBOX.lat_min - 1e-9);
      expect(t.bbox.lat_max).toBeLessThanOrEqual(BBOX.lat_max + 1e-9);
    }
  });

  it("細節層有開道路；建築只喺夠解析度嘅層級開", () => {
    const ov = tiers.find((t) => t.id === "overview")!;
    expect(ov.lod_layers.roads).toBe(false);
    expect(ov.lod_layers.buildings).toBe(false);

    const detail = tiers.filter((t) => t.id !== "overview");
    expect(detail.length).toBeGreaterThan(0);
    for (const t of detail) {
      expect(t.lod_layers.roads, `${t.id} 應該有道路圖層`).toBe(true);
    }

    // 建築只喺 district / street（約 ≤7 m/px）開；region 層建築只有 1.5 px，
    // 畫出嚟只係污點。
    const withBuildings = detail.filter((t) => t.lod_layers.buildings);
    expect(withBuildings.length).toBeGreaterThan(0);
    for (const t of withBuildings) {
      expect(t.lod, `${t.id} 開建築圖層應該係 district 或 street`).toMatch(
        /district|street/,
      );
    }
  });

  it("最窄圖磚跨度 ≥ 視窗最窄可能寬度（否則永遠揀唔到）", () => {
    // 揀層規則係「最窄但仍然完全覆蓋視窗」。如果某個圖磚跨度細過
    // 視窗最窄可能寬度（= BASE_VIEW.w / MAX_SCALE），佢就**永遠**
    // 覆蓋唔到視窗，即係永遠唔會被揀到 —— 白白多咗資產。
    //
    // 實測踩過：MAX_SCALE = 12 → 最窄視窗 0.0583°；而 tko-campus
    // 跨度只有 0.036°、tko-north 只有 0.068°，兩者幾乎永遠用唔到。
    //
    // ⚠️ MAX_SCALE 由 `src/map/map-lod.ts` import（見檔頭註釋）。
    const minViewSpan = LON_SPAN / MAX_SCALE;

    const narrowest = Math.min(...tiers.map((t) => t.bbox.lon_max - t.bbox.lon_min));
    expect(
      narrowest,
      `最窄圖磚跨度 ${narrowest.toFixed(4)}° 細過視窗最窄寬度 ` +
        `${minViewSpan.toFixed(4)}°（MAX_SCALE=${MAX_SCALE}）→ 永遠揀唔到`,
    ).toBeGreaterThanOrEqual(minViewSpan * 0.95);
  });

  it("每個圖磚都至少喺某個縮放級別可達", () => {
    const minViewSpan = LON_SPAN / MAX_SCALE;
    for (const t of tiers) {
      const span = t.bbox.lon_max - t.bbox.lon_min;
      expect(
        span,
        `${t.id}（跨度 ${span.toFixed(4)}°）永遠唔會覆蓋到最窄視窗`,
      ).toBeGreaterThanOrEqual(minViewSpan * 0.95);
    }
  });

  it("只有總覽層提供獨立標籤圖層", () => {
    const ov = tiers.find((t) => t.id === "overview")!;
    expect(ov.label_layer, "總覽層應該有 label_layer").toBeTruthy();
    for (const t of tiers.filter((x) => x.id !== "overview")) {
      expect(t.label_layer, `${t.id} 唔應該有 label_layer`).toBeUndefined();
    }
  });
});

describe("Phase J: SvgMap 縮放相關實作", () => {
  it("有 LOD 揀層邏輯，而且要求「完全覆蓋視窗」", () => {
    expect(SRC).toMatch(/private pickTier\(/);
    expect(SRC).toContain("covers");
  });

  it("平移用 min(rectW/view.w, rectH/view.h) 換算，唔係兩軸獨立", () => {
    expect(SRC).toMatch(/private pxToUserUnits\(/);
    expect(SRC).toMatch(/Math\.min\(rectW\s*\/\s*this\.view\.w,\s*rectH\s*\/\s*this\.view\.h\)/);
    // 舊寫法唔應該再出現
    expect(SRC).not.toMatch(/const ux = this\.view\.w \/ rect\.width/);
  });

  it("標記半徑有按縮放補償", () => {
    expect(SRC).toMatch(/private markerR\(/);
    const uses = SRC.match(/this\.markerR\(/g) ?? [];
    // 位置標記、事件標記、兩處 stroke-width、路線線寬
    expect(uses.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 端對端：實際拖到將軍澳再逐級放大，確認圖磚跟住換
// ---------------------------------------------------------------------------
async function launch(): Promise<Browser | null> {
  try {
    return await chromium.launch();
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

describe("Phase J: LOD 縮放端對端", () => {
  it("由全港總覽拖到將軍澳並放大，圖磚逐級切換到 street", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      const rect = await page.evaluate(() => {
        const r = document.querySelector("#svg-map")!.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const PROJ_COS = lodManifest.projection_cos;

      async function viewBox() {
        return (await page.getAttribute("#svg-map", "viewBox"))!
          .split(/\s+/)
          .map(Number);
      }
      /*
       * ⚠️ 舊版有個 `tier()` 讀 `#basemap-group` 嘅 href 嚟判斷 raster
       * 圖磚。Phase L 之後 raster 只做後備、預設冇 href，所以呢個
       * helper 已經冇用 —— 改用 `data-basemap-level`。
       */
      async function drag(dLon: number, dLatRaw: number) {
        const vb = await viewBox();
        const scale = Math.min(rect.w / vb[2], rect.h / vb[3]);
        const cap = 300;
        const dx = Math.max(-cap, Math.min(cap, -dLon * scale));
        const dy = Math.max(-cap, Math.min(cap, (dLatRaw / PROJ_COS) * scale));
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + dx, cy + dy, { steps: 20 });
        await page.mouse.up();
        await page.waitForTimeout(150);
      }
      async function centreOn(tLon: number, tLat: number) {
        for (let k = 0; k < 30; k++) {
          const vb = await viewBox();
          const lonMin = vb[0];
          const lonMax = vb[0] + vb[2];
          const latMax = BBOX.lat_max - ((vb[1] - BBOX.lat_min) / (LAT_SPAN / PROJ_COS)) * LAT_SPAN;
          const latMin = latMax - (vb[3] / (LAT_SPAN / PROJ_COS)) * LAT_SPAN;
          const dLon = tLon - (lonMin + lonMax) / 2;
          const dLat = tLat - (latMin + latMax) / 2;
          if (Math.abs(dLon) < vb[2] * 0.004 && Math.abs(dLat) < (latMax - latMin) * 0.004) break;
          await drag(dLon, dLat);
        }
      }
      async function zoom(n: number) {
        for (let i = 0; i < n; i++) await page.click("#map-zoom-in");
        await page.waitForTimeout(300);
      }

      /*
       * Phase L 之後，底圖係**向量 canvas**，唔再係 raster LOD 圖磚。
       *
       * 舊斷言「tier() 由 hk-basemap 變成 tko-*」已經過時 —— raster
       * 而家只做後備，冇 href。
       *
       * 新斷言用 `data-basemap-level`（VectorBasemap 對外暴露嘅 hook）：
       *   0 = 總覽（主幹道）  1 = 分區（全部道路）  2 = 街道（＋建築）
       * 呢個係「層級有冇跟住縮放切換」唯一可自動化嘅檢查。
       */
      async function level(): Promise<number> {
        const v = await page.getAttribute("#basemap-canvas", "data-basemap-level");
        return Number(v ?? "-1");
      }
      async function pixels(): Promise<number> {
        return page.evaluate(() => {
          const c = document.querySelector("#basemap-canvas") as HTMLCanvasElement;
          const ctx = c.getContext("2d")!;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4013 * 4) sum = (sum + d[i] + d[i + 1] * 3) % 1e9;
          return sum;
        });
      }

      // 等向量底圖 ready
      for (let i = 0; i < 40; i++) {
        if (
          await page.evaluate(() =>
            document.querySelector(".svg-map-wrap")!.classList.contains("basemap-vector-ready"),
          )
        ) {
          break;
        }
        await page.waitForTimeout(250);
      }

      // 1) 初始 = 總覽層
      expect(await level(), "全港視圖應該係層級 0").toBe(0);
      const px0 = await pixels();

      // 2) 放大到分區 → 層級升到 1
      await zoom(5);
      await centreOn(114.262, 22.31);
      await zoom(2);
      await centreOn(114.262, 22.31);
      await page.waitForTimeout(600);
      const lvl1 = await level();
      expect(lvl1, "放大到分區應該升到層級 1 或以上").toBeGreaterThanOrEqual(1);

      // 3) 再放大到街道 → 層級 2（有建築）
      await zoom(6);
      await centreOn(114.262, 22.31);
      await page.waitForTimeout(900);
      expect(await level(), "街道級應該係層級 2").toBe(2);
      const span2 = (await viewBox())[2];
      expect(span2).toBeLessThan(LON_SPAN * 0.05);

      // 4) canvas 內容一定要變（證明真係重繪，唔止改屬性）
      expect(await pixels(), "縮放之後 canvas 內容必須改變").not.toBe(px0);

      // 5) 重置 → 回到總覽層
      await page.click("#map-reset");
      await page.waitForTimeout(1200);
      expect(await level(), "重置之後應該返到層級 0").toBe(0);
    } finally {
      await browser.close();
    }
  }, 120_000);
});

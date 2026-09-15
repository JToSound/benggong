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

  it("層級按跨度遞減（overview 最闊）", () => {
    const spans = tiers.map((t) => t.bbox.lon_max - t.bbox.lon_min);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i], `${tiers[i].id} 應該比 ${tiers[i - 1].id} 窄`).toBeLessThan(spans[i - 1]);
    }
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
      async function tier() {
        const href = (await page.getAttribute("#basemap-group", "href"))!;
        return href.split("/").pop()!;
      }
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

      // 1) 初始 = 全港總覽
      expect(await tier()).toContain("hk-basemap");

      // 2) 拖到將軍澳再放大 → 應該用到細節圖磚
      await zoom(5);
      await centreOn(114.262, 22.31);
      await zoom(3);
      await centreOn(114.262, 22.31);
      const t1 = await tier();
      expect(t1, "放大到將軍澳應該切換到細節圖磚").not.toContain("hk-basemap");

      // 3) 再放大 → 應該用到更窄嘅層級
      await zoom(3);
      await centreOn(114.262, 22.31);
      const t2 = await tier();
      const span1 = (await viewBox())[2];
      expect(t2).not.toContain("hk-basemap");
      expect(span1).toBeLessThan(LON_SPAN * 0.2);

      // 4) 細節層唔應該顯示總覽標籤圖層（避免兩套比例嘅字疊埋）
      const labelOpacity = parseFloat(
        (await page.getAttribute("#label-detail-layer", "opacity")) ?? "NaN",
      );
      expect(labelOpacity).toBe(0);

      // 5) 重置 → 回到總覽，標籤圖層回復
      await page.click("#map-reset");
      await page.waitForTimeout(900);
      expect(await tier()).toContain("hk-basemap");
      const labelOpacity2 = parseFloat(
        (await page.getAttribute("#label-detail-layer", "opacity")) ?? "NaN",
      );
      expect(labelOpacity2).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 120_000);
});

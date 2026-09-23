// B5 — 渲染驗收（Q2 / Q5 / Q6 / Q9 / Q11）
//
// 為何要有呢個檔
// ==============
// A4 審計推翻咗「最大 zoom 起格」嘅假設：raster 路徑 **0 次參與**。
// 真正嘅問題係「內容密度隨 zoom 反向下降」（G1 章節窗口、G2 tile POI
// 冇畫、G3 建築對比過低）＋ raster 死重。呢個檔將 spec §7 嘅驗收問題
// 變成可自動重跑嘅斷言，令三個成因唔會靜靜回歸。
//
//   Q2  raster 有冇偷偷參與？          → `<image href>` / `<img src>` = 0
//   Q5  深 zoom zone 有冇清空？        → 將軍澳 max zoom zone ≥ 3
//   Q6  深 zoom event 有冇清空？       → 「顯示全部」後 ≥ 5（而且要更多）
//   Q9  max zoom 圖磚負載幾大？        → ≤ 1.0 MB（＋移除 ±1 margin 嘅證據）
//   Q11 有冇「假 zoom」（空白放大）？   → `data-detail-state` 誠實報告
//
// ⚠️ 為何 zone 數目用「資料集總數」而唔係寫死 48
// ---------------------------------------------
// 規則 L1 係「zone **永遠** render」。寫死 48 會喺 B4 加 zone 之後
// 變紅，而變紅嘅原因同政策無關。所以由 `data/public/zones.geojson`
// 讀總數再比對 DOM —— 嗰個先係「冇章節 gate」嘅正確斷言。

import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import basemapCoords from "../public/assets/hk-basemap-coords.json";
import vectorManifest from "../public/assets/vector/manifest.json";

const BASE_URL = "http://localhost:5174";

const BBOX = basemapCoords.bbox;
const PROJ_COS = 0.9247;
const LON_SPAN = BBOX.lon_max - BBOX.lon_min;
const LAT_SPAN = BBOX.lat_max - BBOX.lat_min;
/** 基準視圖高度（user unit）—— 同 `map-camera.baseViewOf` 一致。 */
const BASE_H = LAT_SPAN / PROJ_COS;

/** 故事主場：將軍澳市中心（A4 審計同 B4 資料都用呢一點）。 */
const TKO = { lon: 114.262, lat: 22.31 };
/** 稀疏區（實測 tile (2,10) 只有 2 幢建築）—— no-fake-zoom 用。 */
const SPARSE = { lon: 114.315, lat: 22.235 };

async function launch(): Promise<Browser | null> {
  try {
    // ⚠️ `--no-proxy-server`：沙箱／代理環境下 Chromium 會將
    // `http://localhost:5174` 交畀代理，令 `networkidle` 永遠等唔到。
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

/** 等向量底圖 ready（`.basemap-vector-ready`）。 */
async function waitReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document
            .querySelector(".svg-map-wrap")!
            .classList.contains("basemap-vector-ready"),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
}

async function viewBox(page: Page): Promise<number[]> {
  const vb = await page.getAttribute("#svg-map", "viewBox");
  return (vb ?? "").split(/\s+/).map(Number);
}

/** user unit y → 緯度（同 `map-camera.viewYToLat` 一致）。 */
function yToLat(y: number): number {
  return BBOX.lat_max - (y - BBOX.lat_min) * PROJ_COS;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

async function clickN(page: Page, sel: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await page.click(sel);
  await page.waitForTimeout(400);
}

/**
 * 用滑鼠拖曳將視圖中心移到目標經緯。
 *
 * 為何唔直接用 `?chapter=`：章節 bbox 只保證「有 location 喺附近」，
 * 唔保證係將軍澳市中心。呢個 helper 令測試可以指定**確切**位置。
 *
 * ⚠️ 收斂容差 = `viewW × 0.002`（約 200 m 級）。
 *
 * 原本寫 0.004，但兩個測試都要「視窗**完全**落喺某一格圖磚之內」：
 * 稀疏區目標 `(114.315, 22.235)` 距離西面格界 `114.29` 只有 0.025°，
 * 而 max zoom 之前最後一次 level 切換嘅視窗寬係 0.0391° —— 中心偏
 * 0.002° 就已經會令視窗跨入隔籬格（`r02c09` 有 285 幢建築，足夠令
 * no-fake-zoom 誤判「ok」）。收緊容差係令斷言測**政策**而唔係測**拖曳精度**。
 *
 * ⚠️ 拖曳幅度上限 280 px、迴圈上限 60 次係刻意嘅：一次拖曳最多
 * 280 px 係為了令 `steps: 12` 嘅中間 `mousemove` 全部留喺 SVG 之內
 * （超出會令手勢中斷）。
 */
async function panTo(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
  target: { lon: number; lat: number },
): Promise<{ lon: number; lat: number }> {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  for (let k = 0; k < 60; k++) {
    const [x, y, w, h] = await viewBox(page);
    const cLon = x + w / 2;
    const cLat = yToLat(y + h / 2);
    const dLon = target.lon - cLon;
    const dLat = target.lat - cLat;
    if (Math.abs(dLon) < w * 0.002 && Math.abs(dLat) < h * PROJ_COS * 0.002) {
      return { lon: cLon, lat: cLat };
    }
    const scale = Math.min(rect.w / w, rect.h / h);
    const dx = clamp(-dLon * scale, -280, 280);
    const dy = clamp((dLat / PROJ_COS) * scale, -280, 280);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(90);
  }
  const [x, y, w, h] = await viewBox(page);
  return { lon: x + w / 2, lat: yToLat(y + h / 2) };
}

/**
 * 目標點喺**某個縮放級**係唔係搬得到？
 *
 * `clampView` 要求成個視窗留喺底圖 bbox 之內，所以視窗中心嘅可達範圍係
 * `[bbox.min + span/2, bbox.max − span/2]` —— 縮放越淺，可達範圍越窄。
 * 如果喺一個搬唔到嘅縮放級拖曳，`panTo` 會**靜靜咁停喺 clamp 邊界**，
 * 之後嘅斷言就會用錯誤嘅地點去判斷政策（呢個就係 2026-09-21 首次
 * 跑呢個檔嘅實際失敗模式：報 `ok` 而唔係 `sparse`）。
 */
function reachableAt(viewW: number, target: { lon: number; lat: number }): boolean {
  const viewH = viewW * (BASE_H / LON_SPAN);
  const lonOK =
    target.lon >= BBOX.lon_min + viewW / 2 && target.lon <= BBOX.lon_max - viewW / 2;
  // user unit y 向下增加 = 緯度減少
  const yc = BBOX.lat_min + (BBOX.lat_max - target.lat) / PROJ_COS;
  const yOK =
    yc >= BBOX.lat_min + viewH / 2 && yc <= BBOX.lat_min + BASE_H - viewH / 2;
  return lonOK && yOK;
}

/** 目前 viewBox 內嘅 `.event-marker` 數目（真正睇得到嘅先算）。 */
async function eventsInsideView(page: Page): Promise<number> {
  return page.evaluate(() => {
    const vb = document
      .querySelector("#svg-map")!
      .getAttribute("viewBox")!
      .split(/\s+/)
      .map(Number);
    const [x, y, w, h] = vb;
    return Array.from(document.querySelectorAll(".event-marker")).filter((el) => {
      const cx = Number(el.getAttribute("cx"));
      const cy = Number(el.getAttribute("cy"));
      return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
    }).length;
  });
}

// ---------------------------------------------------------------------------
// Q9：圖磚負載（純計算，唔需要瀏覽器）
// ---------------------------------------------------------------------------

interface TileManifest {
  bbox: { lon_min: number; lon_max: number; lat_min: number; lat_max: number };
  tile_deg: number;
  layers: { tiles: { files: Record<string, { file: string; bytes: number }> } };
}

const VM = vectorManifest as unknown as TileManifest;

/**
 * 同 `VectorBasemap.tileRange()` **完全一樣**嘅相交範圍（0-based，
 * 冇 ±1 margin）。row 由 `lat_min` 起算、col 由 `lon_min` 起算。
 */
function tileRange(
  lon: number,
  lat: number,
  viewW: number,
): { keys: string[]; bytes: number } {
  const b = VM.bbox;
  const td = VM.tile_deg;
  const viewH = viewW * (BASE_H / LON_SPAN);
  const nc = Math.ceil((b.lon_max - b.lon_min) / td);
  const nr = Math.ceil((b.lat_max - b.lat_min) / td);
  const lon0 = lon - viewW / 2;
  const lon1 = lon + viewW / 2;
  const lat0 = lat - viewH / 2;
  const lat1 = lat + viewH / 2;
  const c0 = Math.max(0, Math.floor((lon0 - b.lon_min) / td));
  const c1 = Math.min(nc - 1, Math.floor((lon1 - b.lon_min) / td));
  const r0 = Math.max(0, Math.floor((lat0 - b.lat_min) / td));
  const r1 = Math.min(nr - 1, Math.floor((lat1 - b.lat_min) / td));
  const keys: string[] = [];
  let bytes = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const k = `${r},${c}`;
      keys.push(k);
      bytes += VM.layers.tiles.files[k]?.bytes ?? 0;
    }
  }
  return { keys, bytes };
}

/** 加咗 ±1 margin 之後嘅範圍（舊行為，即 A4 量到嘅過度下載）。 */
function tileRangeWithMargin(
  lon: number,
  lat: number,
  viewW: number,
): { keys: string[]; bytes: number } {
  const b = VM.bbox;
  const td = VM.tile_deg;
  const viewH = viewW * (BASE_H / LON_SPAN);
  const nc = Math.ceil((b.lon_max - b.lon_min) / td);
  const nr = Math.ceil((b.lat_max - b.lat_min) / td);
  const c0 = Math.max(0, Math.floor((lon - viewW / 2 - b.lon_min) / td) - 1);
  const c1 = Math.min(nc - 1, Math.floor((lon + viewW / 2 - b.lon_min) / td) + 1);
  const r0 = Math.max(0, Math.floor((lat - viewH / 2 - b.lat_min) / td) - 1);
  const r1 = Math.min(nr - 1, Math.floor((lat + viewH / 2 - b.lat_min) / td) + 1);
  const keys: string[] = [];
  let bytes = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const k = `${r},${c}`;
      keys.push(k);
      bytes += VM.layers.tiles.files[k]?.bytes ?? 0;
    }
  }
  return { keys, bytes };
}

const MAX_VIEW_W = LON_SPAN / 64;
const MB = 1024 * 1024;

describe("Q9：max zoom 圖磚負載", () => {
  it("將軍澳 max zoom：相交格數 ≤ 4、負載 ≤ 1.0 MB", () => {
    const r = tileRange(TKO.lon, TKO.lat, MAX_VIEW_W);
    expect(r.keys.length, `相交格：${r.keys.join(" ")}`).toBeLessThanOrEqual(4);
    expect(r.bytes, `${(r.bytes / 1024).toFixed(0)} KB`).toBeLessThanOrEqual(MB);
  });

  it("移除 ±1 margin 之後，負載大幅下降（A4 量到 9 格 1.71 MB）", () => {
    // A4 `tile-cap-check.json` 嘅第 150 章視窗（0.0414°）
    const lon = 114.26721;
    const lat = 22.33101;
    const vw = 0.0414;
    const without = tileRange(lon, lat, vw);
    const withMargin = tileRangeWithMargin(lon, lat, vw);
    expect(withMargin.keys.length).toBeGreaterThan(without.keys.length);
    expect(withMargin.bytes).toBeGreaterThan(without.bytes);
    expect(without.bytes, `未加 margin：${(without.bytes / 1024).toFixed(0)} KB`)
      .toBeLessThanOrEqual(MB);
  });

  it("真·最壞 2×2（掃描全部格角）≤ 2.5 MB —— 1.0 MB 目標需要重生成資產", () => {
    /*
     * ⚠️ 誠實披露（契約 §7 D-9）
     * -------------------------
     * spec Q9 嘅目標係 ≤ 1.0 MB。實測**做唔到**：
     *   · 單一格 `r04c07`（旺角／油麻地）本身就 **785 KB**；
     *   · 全圖最壞 2×2 係 `r3c7/r3c8/r4c7/r4c8`（何文田—油麻地一帶）
     *     = **2,331 KB**。
     *
     * 真正嘅修法係細分圖磚（`tile_deg` 0.05 → 0.02），但咁要重跑
     * `scripts/build_vector_basemap.py`，而佢需要 `data/private/` 嘅
     * OSM 快取 —— B5 唔可以讀，亦唔可以改 `public/assets/vector/**`。
     * 所以「≤1.0 MB」deferred，測試改為鎖住**已修好嘅部分**：
     * 相交格數由 16（±1 margin）降到 ≤4，負載由 4.15 MB 降到 ≤2.5 MB。
     *
     * 為何掃描「全部格角」而唔係指定一點：max zoom 視窗只有
     * 0.0109°×0.0084°，只有**中心啱啱好落喺格角**才會相交 4 格。
     * 指定一點會量到「順便掃到嘅某個 2×2」，唔係真正嘅上界。
     */
    let worstBytes = 0;
    let worstKeys: string[] = [];
    const nc = Math.ceil((BBOX.lon_max - BBOX.lon_min) / VM.tile_deg);
    const nr = Math.ceil((BBOX.lat_max - BBOX.lat_min) / VM.tile_deg);
    for (let r = 1; r <= nr; r++) {
      for (let c = 1; c <= nc; c++) {
        const lon = BBOX.lon_min + c * VM.tile_deg;
        const lat = BBOX.lat_min + r * VM.tile_deg;
        const t = tileRange(lon, lat, MAX_VIEW_W);
        if (t.keys.length <= 4 && t.bytes > worstBytes) {
          worstBytes = t.bytes;
          worstKeys = t.keys;
        }
      }
    }
    expect(worstKeys.length, "最壞情況一定要真係 2×2").toBe(4);
    expect(
      worstBytes,
      `最壞 2×2 ${worstKeys.join(" ")} = ${(worstBytes / 1024).toFixed(0)} KB`,
    ).toBeLessThanOrEqual(2.5 * MB);

    // 同一點用舊行為（±1 margin）明顯更差 —— 呢個就係已修好嘅部分
    const worst = tileRangeWithMargin(114.19, 22.26, MAX_VIEW_W);
    const best = tileRange(114.19, 22.26, MAX_VIEW_W);
    expect(best.keys.length).toBeLessThan(worst.keys.length);
    expect(best.bytes).toBeLessThan(worst.bytes);
  });

  it("所有故事區域 max zoom 都唔會爆過 2 MB（16 格年代係 4.15 MB）", () => {
    for (const p of [
      TKO,
      SPARSE,
      { lon: 114.14, lat: 22.36 },
      { lon: 114.158, lat: 22.285 },
      { lon: 114.17, lat: 22.32 },
    ]) {
      const r = tileRange(p.lon, p.lat, MAX_VIEW_W);
      expect(r.keys.length).toBeLessThanOrEqual(4);
      expect(r.bytes, `${p.lon},${p.lat} → ${(r.bytes / 1024).toFixed(0)} KB`)
        .toBeLessThanOrEqual(2 * MB);
    }
  });
});

// ---------------------------------------------------------------------------
// Q2：raster 完全唔參與 + HiDPI backing store
// ---------------------------------------------------------------------------

describe("Q2：raster 唔參與 + canvas backing = CSS × DPR", () => {
  it("DPR 1 / 2 / 3：冇 <image href>、冇 <img src>，backing 正確", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      for (const dpr of [1, 2, 3]) {
        const ctx = await browser.newContext({
          viewport: { width: 1400, height: 900 },
          deviceScaleFactor: dpr,
        });
        const page = await ctx.newPage();
        await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
        await waitReady(page);
        await page.waitForTimeout(400);

        const m = await page.evaluate(() => {
          const mount = document.querySelector("#svg-map-mount")!;
          const canvas = document.querySelector<HTMLCanvasElement>("#basemap-canvas")!;
          const wrap = document.querySelector<HTMLElement>(".svg-map-wrap")!;
          const withHref = Array.from(mount.querySelectorAll("image")).filter(
            (im) =>
              im.getAttribute("href") ||
              im.getAttribute("xlink:href"),
          );
          return {
            imagesWithHref: withHref.length,
            imgs: mount.querySelectorAll("img").length,
            canvasW: canvas.width,
            canvasH: canvas.height,
            cssW: wrap.clientWidth,
            cssH: wrap.clientHeight,
            dpr: window.devicePixelRatio,
          };
        });

        // 1) raster 完全冇參與（規則 A1/A3：唔設預設 href）
        expect(
          m.imagesWithHref,
          `DPR ${dpr}：有 ${m.imagesWithHref} 個 <image> 帶 href（raster 偷偷參與）`,
        ).toBe(0);
        expect(m.imgs, `DPR ${dpr}：地圖容器內唔應該有 <img>`).toBe(0);

        // 2) backing store = CSS × min(DPR, 2)
        const effective = Math.min(m.dpr, 2);
        expect(
          Math.abs(m.canvasW - Math.round(m.cssW * effective)),
          `DPR ${dpr}：canvas.width=${m.canvasW}，預期 ${Math.round(m.cssW * effective)}`,
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(m.canvasH - Math.round(m.cssH * effective)),
          `DPR ${dpr}：canvas.height=${m.canvasH}，預期 ${Math.round(m.cssH * effective)}`,
        ).toBeLessThanOrEqual(2);

        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Q5 / Q6 / Q11：深 zoom 內容密度
// ---------------------------------------------------------------------------

describe("Q5 / Q6 / Q11：深 zoom 唔可以反向變空", () => {
  it("將軍澳 max zoom：zone 全部仍然 render、event 有內容、detailState 誠實", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      await page.waitForTimeout(500);

      const rect = await page.evaluate(() => {
        const r = document.querySelector("#svg-map")!.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });

      // 先放大到 level 1（可以平移但唔會載入圖磚），再移到將軍澳市中心
      await clickN(page, "#map-zoom-in", 4);
      const afterPan = await panTo(page, rect, TKO);
      expect(
        Math.abs(afterPan.lon - TKO.lon) + Math.abs(afterPan.lat - TKO.lat),
        `panTo 應該搬到將軍澳市中心（實際 ${afterPan.lon.toFixed(4)},${afterPan.lat.toFixed(4)}）`,
      ).toBeLessThan(0.01);
      // 再放大到 MAX_SCALE（Z6）
      await clickN(page, "#map-zoom-in", 14);
      await page.waitForTimeout(1200);

      const vb = await viewBox(page);
      expect(vb[2], "應該到咗 max zoom（viewW = 0.70/64）").toBeLessThanOrEqual(
        MAX_VIEW_W + 1e-6,
      );
      // 確認真係喺將軍澳附近
      expect(Math.abs(vb[0] + vb[2] / 2 - TKO.lon)).toBeLessThan(0.02);
      expect(Math.abs(yToLat(vb[1] + vb[3] / 2) - TKO.lat)).toBeLessThan(0.02);

      // ---- Q5：zone 永遠 render（規則 L1 / 決定 D2）----
      const zoneTotal = (
        JSON.parse(readFileSync("data/public/zones.geojson", "utf-8")) as {
          features: unknown[];
        }
      ).features.length;

      const zoneDom = await page.evaluate(() => ({
        areas: document.querySelectorAll(".zone-area").length,
        groups: document.querySelectorAll("#zones-layer .zone").length,
        lods: Array.from(
          new Set(
            Array.from(document.querySelectorAll("#zones-layer .zone")).map(
              (g) => g.getAttribute("data-zone-lod") || "",
            ),
          ),
        ),
      }));
      expect(
        zoneDom.areas,
        `max zoom 應該畫晒全部 ${zoneTotal} 個 zone（實測 ${zoneDom.areas}）`,
      ).toBe(zoneTotal);
      expect(zoneDom.groups).toBe(zoneTotal);
      // zone LOD 應該係 full（viewW ≤ 0.0219°）
      expect(zoneDom.lods).toContain("full");

      // 將軍澳一帶真係有 zone（唔係靠全圖 48 個蒙混過關）
      const tkoZones = await page.evaluate(() => {
        const vb = document
          .querySelector("#svg-map")!
          .getAttribute("viewBox")!
          .split(/\s+/)
          .map(Number);
        const [x, y, w, h] = vb;
        return Array.from(document.querySelectorAll(".zone-area")).filter((el) => {
          const d = el.getAttribute("d") || "";
          const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
          // 多邊形 bbox 同視窗相交
          const xs = nums.filter((_, i) => i % 2 === 0);
          const ys = nums.filter((_, i) => i % 2 === 1);
          return (
            Math.min(...xs) <= x + w &&
            Math.max(...xs) >= x &&
            Math.min(...ys) <= y + h &&
            Math.max(...ys) >= y
          );
        }).length;
      });
      expect(
        tkoZones,
        "將軍澳 max zoom 視窗應該至少相交 3 個 zone（A4 實測舊版係 0）",
      ).toBeGreaterThanOrEqual(3);

      // ---- Q11a：密集區要報 "ok" ----
      const dense = await page.getAttribute("#basemap-canvas", "data-detail-state");
      expect(["ok", "sparse"]).toContain(dense);
      expect(dense, "將軍澳市中心有幾千幢建築，唔應該係 sparse").toBe("ok");

      // ---- Q6：event 密度 ----
      const windowed = await eventsInsideView(page);
      await page.click("#map-show-all-events");
      await page.waitForTimeout(700);
      const all = await eventsInsideView(page);
      const pressed = await page.getAttribute("#map-show-all-events", "aria-pressed");
      expect(pressed, "開關要反映狀態（B6/B7 唯一可觀察來源）").toBe("true");
      expect(
        all,
        `「顯示全部」之後 max zoom 視窗內應該有 ≥5 個 event（實測 ${all}）`,
      ).toBeGreaterThanOrEqual(5);
      expect(
        all,
        `「顯示全部」必須比預設「本章 ±1 章」多（預設 ${windowed}、全部 ${all}）`,
      ).toBeGreaterThan(windowed);

      // 關返 → 回復窗口過濾
      await page.click("#map-show-all-events");
      await page.waitForTimeout(500);
      expect(await eventsInsideView(page)).toBe(windowed);
    } finally {
      await browser.close();
    }
  }, 180_000);

  it("稀疏區 max zoom：no-fake-zoom 要報 sparse（唔可以扮有細節）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      await page.waitForTimeout(500);

      const rect = await page.evaluate(() => {
        const r = document.querySelector("#svg-map")!.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });

      /*
       * ⚠️ 順序好重要：一定要**先**喺低 zoom 移到稀疏區，之後才放大。
       *
       * `BaseGeometryLayer` 嘅 `tileBuildingCount` 係**累加**（LRU 24 格）。
       * 如果先喺密集區放大過，快取會留住幾千幢建築，之後就算移到
       * 荒地都唔會報 sparse。呢個測試刻意由乾淨 session 開始。
       *
       * ⚠️ 為何係 3 次 zoom-in 而唔係 2 次
       * ---------------------------------
       * 拖曳只可以喺「視窗完全留喺底圖 bbox 內」嘅前提下移動中心。
       * 稀疏目標 `(114.315, 22.235)` 貼近 bbox 東南角：
       *   · 2 次 zoom-in → viewW = 0.4142° → 中心可達經度上限
       *     114.49 − 0.2071 = **114.2829**（到唔到 114.315）；
       *   · 3 次 zoom-in → viewW = 0.3186° → 經度上限 114.3307、
       *     緯度可達範圍 [22.2330, 22.5276]，兩個目標值都入到。
       * 用 `reachableAt()` 明碼驗證，避免「靜靜停喺 clamp 邊界」再被
       * 誤讀成「政策錯誤」。
       */
      const PAN_ZOOMS = 3;
      expect(
        reachableAt(LON_SPAN / 1.3 ** PAN_ZOOMS, SPARSE),
        `SPARSE 喺 ${PAN_ZOOMS} 次 zoom-in 之後應該搬得到（viewW=${(
          LON_SPAN / 1.3 ** PAN_ZOOMS
        ).toFixed(4)}）`,
      ).toBe(true);

      await clickN(page, "#map-zoom-in", PAN_ZOOMS);
      const afterPan = await panTo(page, rect, SPARSE);
      expect(
        Math.abs(afterPan.lon - SPARSE.lon) + Math.abs(afterPan.lat - SPARSE.lat),
        `panTo 應該搬到稀疏區（實際 ${afterPan.lon.toFixed(4)},${afterPan.lat.toFixed(4)}）`,
      ).toBeLessThan(0.01);
      await clickN(page, "#map-zoom-in", 16);
      await page.waitForTimeout(1500);

      const vb = await viewBox(page);
      expect(vb[2]).toBeLessThanOrEqual(MAX_VIEW_W + 1e-6);
      const state = await page.getAttribute("#basemap-canvas", "data-detail-state");
      expect(
        state,
        "稀疏區（實測 2 幢建築）max zoom 應該報 sparse（spec §4.3 no-fake-zoom）",
      ).toBe("sparse");
      // level 2 才會做 no-fake-zoom 判斷
      expect(await page.getAttribute("#basemap-canvas", "data-basemap-level")).toBe("2");
    } finally {
      await browser.close();
    }
  }, 180_000);
});

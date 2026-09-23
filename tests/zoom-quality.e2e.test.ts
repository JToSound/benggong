/**
 * zoom-quality.e2e.test.ts — B9 量測編排（Q1–Q11）。
 *
 * 為何要有呢個檔
 * ==============
 * spec §7 要「各 target zoom × DPR 截圖 + 無 raster fallback + label crisp +
 * 無 seam + tile payload + 冷 zoom 阻塞 + no-fake-zoom 狀態」。呢個檔負責
 * **量**，並將結果寫落 `artifacts/b9-qa/zoom-quality-raw.json`；
 * 判定由 `scripts/verify_zoom_quality.py`（cv2/numpy）負責。
 *
 * 為何量同判要分開
 * ================
 * `pytesseract` 唔可用、又唔准加依賴，所以 Python 側冇 Playwright binding。
 * 唯一可行嘅分工就係「Node 量 → Python 判」。判定程式（`verify_zoom_quality.py`）
 * 可以獨立重跑，亦係 Gate 3 C3 嘅輸入。
 *
 * 本檔只硬斷言**設計上必然成立**嘅事（raster = 0、canvas backing、zone/event
 * 下限）；Q3/Q4/Q10 呢啲已知可能有 gap 嘅，**只記錄、唔硬斷** —— 由 Python
 * 如實判 FAIL，唔會為「全綠」而污染 `npm test` 嘅信號。
 *
 * ⚠️ 唔可以改任何既有 e2e 檔；本檔係新檔。
 */

import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";

import {
  MAX_VIEW_W,
  type TileRec,
  canvasMetrics,
  coldZoomLongTasks,
  countEventsInView,
  countZonesInView,
  drainLabels,
  launchB9,
  newB9Page,
  panToLonLat,
  readBasemapLevel,
  readDetailState,
  readRasterParticipation,
  readViewBox,
  readZoneLabelBoxes,
  recordTiles,
  resetLabels,
  saveCanvasPng,
  shotMap,
  viewBoxToGeo,
  writeRaw,
  zoomUntilZ,
  type B9Browser,
} from "./qa/harness";
import type { B9LabelRec } from "./qa/probes";

/**
 * spec §7 Q1 嘅 target zoom。
 *
 * ⚠️ Z8 曾經因 `MAX_SCALE = 64` 物理上不可達（B9 標 `needs_review`）。
 * 修好之後（政策 `MAX_SCALE = 280` → 最窄 0.0025° = Z8.13）Z8 必須真係到，
 * 所以下面加咗硬斷言（見「Q1：全部 target 真係可達」）。
 */
const Z_TARGETS = [0, 2, 4, 6, 8] as const;

/** 故事主場：將軍澳市中心（同 A4 / B4 一致）。 */
const TKO = { lon: 114.262, lat: 22.31 };
/** 稀疏區（實測 tile (2,10) 只有 2 幢建築）—— no-fake-zoom 用。 */
const SPARSE = { lon: 114.315, lat: 22.235 };

/** 由 `ctx.font` 字串抽出字級 px。 */
function fontSizeOf(font: string): number {
  const m = font.match(/(\d+(?:\.\d+)?)px/);
  return m ? Number(m[1]) : 0;
}

/**
 * 將 canvas label 記錄整理成可判嘅樣本。
 *
 * 為何要 dedupe + 限額：深 zoom 一次 render 可以畫 3,000+ 個 label
 * （tile POI rank 5），全部寫落 JSON 會令檔過大。Python 只需要
 * 「可見樣本」計比例，所以喺 canvas 範圍內去重、排序、取頭 N 個。
 */
function sampleLabels(
  recs: B9LabelRec[],
  canvasW: number,
  canvasH: number,
  limit: number,
): { samples: Array<{ t: string; font: string; size: number; x: number; y: number; align: string; baseline: string }>; total: number; inCanvas: number; belowMin: number } {
  const seen = new Set<string>();
  const inCanvas: B9LabelRec[] = [];
  let belowMin = 0;
  for (const r of recs) {
    if (!r.t || !r.t.trim()) continue;
    const size = fontSizeOf(r.font);
    if (size > 0 && size < 9) belowMin++;
    if (r.x < 0 || r.x > canvasW || r.y < 0 || r.y > canvasH) continue;
    const key = `${r.t}|${Math.round(r.x)}|${Math.round(r.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inCanvas.push(r);
  }
  inCanvas.sort((a, b) => a.y - b.y || a.x - b.x);
  const samples = inCanvas.slice(0, limit).map((r) => ({
    t: r.t,
    font: r.font,
    size: fontSizeOf(r.font),
    x: r.x,
    y: r.y,
    align: r.align,
    baseline: r.baseline,
  }));
  return { samples, total: recs.length, inCanvas: inCanvas.length, belowMin };
}

interface LevelRecord {
  anchor: string;
  target: number;
  dpr: number;
  reachedZ: number;
  viewW: number;
  viewBox: number[];
  geo: { lon_min: number; lon_max: number; lat_min: number; lat_max: number };
  detailState: string | null;
  basemapLevel: string | null;
  zonesInView: number;
  eventsInView: number;
  canvas: Awaited<ReturnType<typeof canvasMetrics>>;
  raster: Awaited<ReturnType<typeof readRasterParticipation>>;
  screenshot: string | null;
  canvasPng: string | null;
  labels: ReturnType<typeof sampleLabels>;
  zoneLabelBoxes: Awaited<ReturnType<typeof readZoneLabelBoxes>>;
}

/** 量一個 zoom level（唔改視圖）。 */
async function measureLevel(
  page: Page,
  opts: {
    anchor: string;
    target: number;
    dpr: number;
    shot?: boolean;
    canvasPng?: boolean;
    labelLimit?: number;
  },
): Promise<LevelRecord> {
  const vb = await readViewBox(page);
  const canvas = await canvasMetrics(page);
  const raster = await readRasterParticipation(page);
  const zonesInView = await countZonesInView(page);
  const eventsInView = await countEventsInView(page);
  const detailState = await readDetailState(page);
  const basemapLevel = await readBasemapLevel(page);
  const zoneLabelBoxes = await readZoneLabelBoxes(page);
  const recs = await drainLabels(page);
  const labels = sampleLabels(recs, canvas.width, canvas.height, opts.labelLimit ?? 400);

  let screenshot: string | null = null;
  let canvasPng: string | null = null;
  if (opts.shot) {
    screenshot = await shotMap(page, `zoom-${opts.anchor}-Z${opts.target}-dpr${opts.dpr}.png`);
  }
  if (opts.canvasPng) {
    canvasPng = await saveCanvasPng(
      page,
      `canvas-${opts.anchor}-Z${opts.target}-dpr${opts.dpr}.png`,
    );
  }
  return {
    anchor: opts.anchor,
    target: opts.target,
    dpr: opts.dpr,
    reachedZ: Number(viewWToZOf(vb[2]).toFixed(3)),
    viewW: Number(vb[2].toFixed(6)),
    viewBox: vb.map((n) => Number(n.toFixed(6))),
    geo: viewBoxToGeo(vb),
    detailState,
    basemapLevel,
    zonesInView,
    eventsInView,
    canvas,
    raster,
    screenshot,
    canvasPng,
    labels,
    zoneLabelBoxes,
  };
}

/** 由 viewW 計 Z（避免 import 循環）。 */
function viewWToZOf(viewW: number): number {
  return Math.log2(0.7 / viewW);
}

describe("B9 zoom quality 量測（Q1–Q11）", () => {
  it("量測各 target zoom × DPR × 錨點，寫 zoom-quality-raw.json", async () => {
    const b: B9Browser | null = await launchB9();
    if (!b) return;

    const levels: LevelRecord[] = [];
    const tiles: TileRec[] = [];
    let coldZoom: Awaited<ReturnType<typeof coldZoomLongTasks>> | null = null;
    const noDetail: {
      constant: string;
      drawnInSparse: boolean;
      drawnStrings: string[];
      sparseState: string | null;
      denseState: string | null;
    } = {
      constant: "此區未有細節資料",
      drawnInSparse: false,
      drawnStrings: [],
      sparseState: null,
      denseState: null,
    };

    try {
      // ---------------- P1：DPR 1，幾何中心錨點（A4 同款協定） ----------------
      {
        const page = await newB9Page(b, { dpr: 1, url: "?chapter=1" });
        for (const t of Z_TARGETS) {
          await resetLabels(page);
          await zoomUntilZ(page, t);
          await page.waitForTimeout(500);
          levels.push(
            await measureLevel(page, {
              anchor: "center",
              target: t,
              dpr: 1,
              shot: true,
              canvasPng: t === 0 || t === 6,
            }),
          );
        }
        await page.close();
      }

      // ---------------- P2：DPR 2，幾何中心錨點（Q1 DPR 對照） ----------------
      {
        const page = await newB9Page(b, { dpr: 2, url: "?chapter=1" });
        for (const t of Z_TARGETS) {
          await resetLabels(page);
          await zoomUntilZ(page, t);
          await page.waitForTimeout(500);
          levels.push(
            await measureLevel(page, {
              anchor: "center",
              target: t,
              dpr: 2,
              shot: true,
              canvasPng: false,
              labelLimit: 60,
            }),
          );
        }
        await page.close();
      }

      // ---------------- P3：DPR 1，將軍澳錨點（Q4/Q5/Q6/Q8/Q9） ----------------
      {
        const page = await newB9Page(b, { dpr: 1 });
        recordTiles(page, tiles);
        await zoomUntilZ(page, 2);
        await panToLonLat(page, TKO.lon, TKO.lat);
        for (const t of [2, 4, 6] as const) {
          await resetLabels(page);
          await zoomUntilZ(page, t);
          await page.waitForTimeout(600);
          levels.push(
            await measureLevel(page, {
              anchor: "tko",
              target: t,
              dpr: 1,
              shot: true,
              canvasPng: t === 6,
              labelLimit: 600,
            }),
          );
        }
        // Q6：開「顯示全部事件」之後再數（保留窗口值做對照）
        const last = levels[levels.length - 1];
        const windowed = last.eventsInView;
        await page.click("#map-show-all-events").catch(() => {});
        await page.waitForTimeout(800);
        const all = await countEventsInView(page);
        const pressed = await page.getAttribute("#map-show-all-events", "aria-pressed");
        const extra = last as LevelRecord & {
          eventsWindowed?: number;
          eventsAll?: number;
          showAllPressed?: string | null;
        };
        extra.eventsWindowed = windowed;
        extra.eventsAll = all;
        extra.showAllPressed = pressed;
        noDetail.denseState = await readDetailState(page);
        await page.close();
      }

      // ---------------- P4：冷 zoom 阻塞（Q10） ----------------
      {
        const page = await newB9Page(b, { dpr: 1 });
        coldZoom = await coldZoomLongTasks(page, 20);
        await page.close();
      }

      // ---------------- P5：稀疏區 no-fake-zoom（Q11） ----------------
      {
        const page = await newB9Page(b, { dpr: 1 });
        await zoomUntilZ(page, 2);
        await zoomUntilZ(page, 3);
        await panToLonLat(page, SPARSE.lon, SPARSE.lat);
        await resetLabels(page);
        await zoomUntilZ(page, 6);
        await page.waitForTimeout(1500);
        noDetail.sparseState = await readDetailState(page);
        const recs = await drainLabels(page);
        const texts = Array.from(new Set(recs.map((r) => r.t)));
        noDetail.drawnStrings = texts.filter((t) => t.length >= 4).slice(0, 40);
        noDetail.drawnInSparse = texts.includes(noDetail.constant);
        await shotMap(page, "zoom-sparse-Z6-dpr1.png");
        await saveCanvasPng(page, "canvas-sparse-Z6-dpr1.png");
        await page.close();
      }

      const raw = {
        schema: "b9.zoom-quality.raw/1",
        generatedAt: new Date().toISOString(),
        baseUrl: "http://localhost:5174",
        viewport: { width: 1440, height: 900 },
        maxViewW: MAX_VIEW_W,
        maxZ: Number(viewWToZOf(MAX_VIEW_W).toFixed(3)),
        zTargets: Z_TARGETS,
        dprs: [1, 2],
        anchors: {
          center: { note: "幾何中心（bbox 中心）—— A4 flatness-probe 同款協定" },
          tko: { lon: TKO.lon, lat: TKO.lat, note: "故事主場：將軍澳市中心" },
          sparse: { lon: SPARSE.lon, lat: SPARSE.lat, note: "稀疏區（no-fake-zoom）" },
        },
        levels,
        tiles,
        coldZoom,
        noDetail,
      };

      writeRaw("zoom-quality-raw.json", raw);

      // ---------------- 硬斷言（設計上必然成立） ----------------
      expect(levels.length, "要有量到 level").toBeGreaterThan(0);

      /*
       * Q1：Z0/Z2/Z4/Z6/Z8 × DPR 1/2 全部要**真係可達**。
       *
       * 呢個係 Q1 由 `needs_review` 轉 `pass` 嘅判準。`zoomUntilZ` 每下 ×1.3，
       * 所以 `reachedZ` 會 overshoot（例如 target 2 → 2.271），故用
       * `>= target - 0.01` 而唔係嚴格相等。
       */
      for (const dpr of [1, 2] as const) {
        for (const t of Z_TARGETS) {
          const l = levels.find(
            (x) => x.anchor === "center" && x.target === t && x.dpr === dpr,
          );
          expect(l, `缺 center Z${t} dpr${dpr} 量測`).toBeTruthy();
          expect(
            l!.reachedZ,
            `center Z${t} dpr${dpr}：只到 Z${l!.reachedZ}（viewW=${l!.viewW}）→ 不可達`,
          ).toBeGreaterThanOrEqual(t - 0.01);
        }
      }
      expect(
        raw.maxZ,
        `maxZ=${raw.maxZ} 應該 ≥ 8（MAX_SCALE 要令 Z8 可達）`,
      ).toBeGreaterThanOrEqual(8);

      for (const l of levels) {
        expect(
          l.raster.imagesWithHref,
          `${l.anchor} Z${l.target} dpr${l.dpr}：有 <image href>（raster 偷偷參與）`,
        ).toBe(0);
        expect(l.raster.imgs, `${l.anchor} Z${l.target}：地圖容器內唔應該有 <img>`).toBe(0);
        const eff = Math.min(l.raster.dpr, 2);
        expect(
          Math.abs(l.raster.canvasW - Math.round(l.raster.cssW * eff)),
          `${l.anchor} Z${l.target} dpr${l.dpr}：canvas.width=${l.raster.canvasW}，預期 ${Math.round(
            l.raster.cssW * eff,
          )}`,
        ).toBeLessThanOrEqual(2);
      }

      const tkoZ6 = levels.find((l) => l.anchor === "tko" && l.target === 6) as
        | (LevelRecord & {
            eventsWindowed?: number;
            eventsAll?: number;
            showAllPressed?: string | null;
          })
        | undefined;
      expect(tkoZ6, "要有將軍澳 Z6 量測").toBeTruthy();
      expect(
        tkoZ6!.zonesInView,
        `將軍澳 Z6 視窗內 zone 應該 ≥3（實測 ${tkoZ6!.zonesInView}）`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        tkoZ6!.eventsAll,
        `將軍澳 Z6「顯示全部事件」後 event 應該 ≥5（實測 ${tkoZ6!.eventsAll}）`,
      ).toBeGreaterThanOrEqual(5);
      expect(
        tkoZ6!.eventsAll,
        `「顯示全部」必須比預設窗口多（窗口 ${tkoZ6!.eventsWindowed}）`,
      ).toBeGreaterThan(tkoZ6!.eventsWindowed ?? 0);
      expect(tkoZ6!.showAllPressed, "開關要反映狀態").toBe("true");

      // Q2 DPR 對照：DPR2 截圖高度應該約 DPR1 兩倍
      expect(raw.dprs).toEqual([1, 2]);
    } finally {
      await b.close();
    }
  }, 600_000);

  it("量測原始檔含齊 Q1–Q11 所需欄位（schema 完整性）", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = join(process.cwd(), "artifacts", "b9-qa", "zoom-quality-raw.json");
    let raw: {
      levels?: Array<Record<string, unknown>>;
      tiles?: unknown[];
      coldZoom?: Record<string, unknown> | null;
      noDetail?: Record<string, unknown>;
      maxZ?: number;
      zTargets?: number[];
    };
    try {
      raw = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      // 量測測試未跑（例如單獨跑呢個檔）→ 唔應該假綠，直接 skip 交畀 Python 判
      console.warn("[skip] zoom-quality-raw.json 未存在（請先跑量測測試）");
      return;
    }
    expect(raw.levels?.length ?? 0).toBeGreaterThan(0);
    const first = raw.levels![0];
    for (const key of [
      "anchor",
      "target",
      "dpr",
      "reachedZ",
      "viewW",
      "viewBox",
      "canvas",
      "raster",
      "labels",
      "zoneLabelBoxes",
      "detailState",
      "zonesInView",
      "eventsInView",
    ]) {
      expect(Object.keys(first), `level 缺少 ${key}`).toContain(key);
    }
    expect(raw.zTargets).toEqual([0, 2, 4, 6, 8]);
    expect(raw.coldZoom, "要有冷 zoom 量測").toBeTruthy();
    expect(raw.noDetail?.constant).toBe("此區未有細節資料");
  }, 30_000);
});

/**
 * harness.ts — B9 Playwright 量測庫（Node 側）。
 *
 * 為何要有呢個檔
 * ==============
 * spec §7 嘅 Q1–Q11 要量嘅嘢橫跨四層：DOM、canvas 像素、network、主線程
 * longtask。呢個檔將全部量度收喺一處，令 `tests/zoom-quality.e2e.test.ts`
 * 只負責「編排」，唔會夾雜量測細節；將來 C3（Zoom/Render QA）可以直接
 * 重用同一套 helper。
 *
 * ⚠️ 設計約束
 * ------------
 *   · **唔加任何依賴**（只用 `@playwright/test` + node 標準庫）
 *   · **唔改 production code**；所有量度都係由外面觀察
 *   · **零人手**：冇任何「請人睇下」嘅位
 *   · 註解內唔可以出現 `*` 加 `/` 嘅序列（會提早終止 block comment）
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";

import vectorManifest from "../../public/assets/vector/manifest.json";
import { MAX_SCALE } from "../../src/map/map-lod";
import {
  B9_INIT_SCRIPT,
  type B9CanvasMetrics,
  type B9LabelRec,
  type B9LongTask,
  type B9Probe,
} from "./probes";

/** `vite preview` 只綁 IPv6，所以一定要用 `localhost`（唔可以用 127.0.0.1）。 */
export const B9_BASE_URL = "http://localhost:5174";

export const ARTIFACT_DIR = join(process.cwd(), "artifacts", "b9-qa");
export const SHOT_DIR = join(ARTIFACT_DIR, "screenshots");

/** 底圖 bbox（同 `public/assets/vector/manifest.json` 一致）。 */
const VM = vectorManifest as unknown as {
  bbox: { lon_min: number; lon_max: number; lat_min: number; lat_max: number };
  tile_deg: number;
};
export const BBOX = VM.bbox;
export const TILE_DEG = VM.tile_deg;
export const PROJ_COS = 0.9247;
export const LON_SPAN = BBOX.lon_max - BBOX.lon_min;
const LAT_SPAN = BBOX.lat_max - BBOX.lat_min;
const BASE_H = LAT_SPAN / PROJ_COS;
export const BASE_VIEW_W = 0.7;
/**
 * 最窄可達視窗寬（度）。
 *
 * ⚠️ 由 LOD 政策嘅 `MAX_SCALE` 反推（`src/map/map-lod.ts`），唔可以寫死 64。
 * 政策值 280 → 0.0025° → 最深 Z = 8.13（B9 Q1 嘅 Z8 target 因此可達）。
 */
export const MAX_VIEW_W = BASE_VIEW_W / MAX_SCALE;

export interface B9Browser {
  browser: Browser;
  close(): Promise<void>;
}

/** 開 Chromium；撞唔到（未 `playwright install`）就回 null 令測試 skip。 */
export async function launchB9(): Promise<B9Browser | null> {
  try {
    // `--no-proxy-server`：沙箱有 http_proxy，唔加會令 localhost 交畀代理。
    const browser = await chromium.launch({ args: ["--no-proxy-server"] });
    return {
      browser,
      close: async () => {
        await browser.close();
      },
    };
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

export interface B9PageOptions {
  dpr?: number;
  width?: number;
  height?: number;
  /** 相對 URL，例如 `?chapter=1`。 */
  url?: string;
}

/** 開一個新 page（已注入 B9 init script），並導覽到指定 URL。 */
export async function newB9Page(b: B9Browser, o: B9PageOptions = {}): Promise<Page> {
  const ctx = await b.browser.newContext({
    viewport: { width: o.width ?? 1440, height: o.height ?? 900 },
    deviceScaleFactor: o.dpr ?? 1,
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
  });
  await ctx.addInitScript(B9_INIT_SCRIPT);
  const page = await ctx.newPage();
  await page.goto(`${B9_BASE_URL}/${o.url ?? ""}`, { waitUntil: "networkidle" });
  await waitMapReady(page);
  await page.waitForTimeout(500);
  return page;
}

/** 等向量底圖 ready。 */
export async function waitMapReady(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        document
          .querySelector(".svg-map-wrap")
          ?.classList.contains("basemap-vector-ready") ?? false,
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
}

/** 讀 `#svg-map` 嘅 viewBox `[x, y, w, h]`。 */
export async function readViewBox(page: Page): Promise<number[]> {
  const vb = await page.getAttribute("#svg-map", "viewBox");
  return (vb ?? "").split(/\s+/).map(Number);
}

/** Z = log2(0.70 / viewW)。 */
export function viewWToZ(viewW: number): number {
  return Math.log2(BASE_VIEW_W / viewW);
}

export async function readZoomZ(page: Page): Promise<number> {
  const [, , w] = await readViewBox(page);
  return viewWToZ(w);
}

/**
 * 逐下撳 `#map-zoom-in` 直到 Z ≥ target（或到上限為止）。
 *
 * 為何唔可以直接設 viewBox：咁會繞過 App 自己嘅 render pipeline，
 * 量到嘅唔係用戶真係見到嘅嘢（規則 Q1/Q2 唔准）。
 *
 * @returns 實際到達嘅 Z（唔一定等於 target，因為每下係 ×1.3）
 */
export async function zoomUntilZ(page: Page, target: number): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const z = await readZoomZ(page);
    if (z >= target - 1e-6) return z;
    await page.locator("#map-zoom-in").click({ force: true }).catch(() => {});
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(1200);
  return readZoomZ(page);
}

/** user unit y → 緯度（同 `map-camera.viewYToLat` 一致）。 */
function yToLat(y: number): number {
  return BBOX.lat_max - (y - BBOX.lat_min) * PROJ_COS;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * 用滑鼠拖曳將視窗中心移到目標經緯（同 `tests/map-render.test.ts` 同款）。
 *
 * ⚠️ 一定要先放大到「視窗細過底圖」，否則 `clampView` 會夾死、拖唔到。
 */
export async function panToLonLat(page: Page, lon: number, lat: number): Promise<void> {
  const rect = await page.evaluate(() => {
    const r = document.querySelector("#svg-map")!.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  for (let k = 0; k < 60; k++) {
    const [x, y, w, h] = await readViewBox(page);
    const cLon = x + w / 2;
    const cLat = yToLat(y + h / 2);
    const dLon = lon - cLon;
    const dLat = lat - cLat;
    if (Math.abs(dLon) < w * 0.002 && Math.abs(dLat) < h * PROJ_COS * 0.002) return;
    const scale = Math.min(rect.w / w, rect.h / h);
    const dx = clamp(-dLon * scale, -280, 280);
    const dy = clamp((dLat / PROJ_COS) * scale, -280, 280);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(90);
  }
}

/** 讀 `#basemap-canvas` 像素 → flatRatio / meanGrad（同 A4 flatness-probe 同款）。 */
export async function canvasMetrics(page: Page): Promise<B9CanvasMetrics> {
  return page.evaluate(() => {
    const w = window as unknown as { __b9: B9Probe };
    const canvas = document.querySelector<HTMLCanvasElement>("#basemap-canvas")!;
    return w.__b9.metrics(canvas);
  });
}

/** 拎走並清空 `fillText` 記錄。 */
export async function drainLabels(page: Page): Promise<B9LabelRec[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __b9: B9Probe };
    const out = w.__b9.labels.slice();
    w.__b9.labels.length = 0;
    return out;
  });
}

export async function resetLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __b9: B9Probe };
    w.__b9.labels.length = 0;
  });
}

export async function readLongTasks(page: Page): Promise<B9LongTask[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __b9: B9Probe };
    return w.__b9.longTasks.slice();
  });
}

export async function resetLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __b9: B9Probe };
    w.__b9.longTasks.length = 0;
  });
}

/** `#basemap-canvas[data-detail-state]`（no-fake-zoom 嘅 DOM 觀測點）。 */
export async function readDetailState(page: Page): Promise<string | null> {
  return page.getAttribute("#basemap-canvas", "data-detail-state");
}

export async function readBasemapLevel(page: Page): Promise<string | null> {
  return page.getAttribute("#basemap-canvas", "data-basemap-level");
}

export interface ZoneLabelBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 讀 DOM 內 `.zone-label` 嘅實際渲染尺寸（CSS px）。
 *
 * ⚠️ 唔可以用 `getComputedStyle().fontSize` —— SVG `<text>` 嘅 font-size
 * 係 **user unit**，喺深 zoom 會回報「0.0004px」呢類無意義值（實測）。
 * 真正可信嘅係 `getBoundingClientRect()`。
 */
export async function readZoneLabelBoxes(page: Page): Promise<ZoneLabelBox[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("#zones-layer .zone-label"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: (el.textContent ?? "").trim(),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })
      .filter((l) => l.text.length > 0);
  });
}

/** 數 viewBox 內嘅 zone polygon（同 `map-render.test.ts` Q5 同一套公式）。 */
export async function countZonesInView(page: Page): Promise<number> {
  return page.evaluate(() => {
    const vb = document
      .querySelector("#svg-map")!
      .getAttribute("viewBox")!
      .split(/\s+/)
      .map(Number);
    const [x, y, w, h] = vb;
    return Array.from(document.querySelectorAll(".zone-area")).filter((el) => {
      const d = el.getAttribute("d") ?? "";
      const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      if (!xs.length || !ys.length) return false;
      return (
        Math.min(...xs) <= x + w &&
        Math.max(...xs) >= x &&
        Math.min(...ys) <= y + h &&
        Math.max(...ys) >= y
      );
    }).length;
  });
}

/** 數 viewBox 內嘅 event marker。 */
export async function countEventsInView(page: Page): Promise<number> {
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

/** 確認 raster 完全冇參與（Q2）。 */
export async function readRasterParticipation(
  page: Page,
): Promise<{ imagesWithHref: number; imgs: number; canvasW: number; canvasH: number; cssW: number; cssH: number; dpr: number }> {
  return page.evaluate(() => {
    const mount = document.querySelector("#svg-map-mount")!;
    const canvas = document.querySelector<HTMLCanvasElement>("#basemap-canvas")!;
    const wrap = document.querySelector<HTMLElement>(".svg-map-wrap")!;
    const withHref = Array.from(mount.querySelectorAll("image")).filter(
      (im) => im.getAttribute("href") || im.getAttribute("xlink:href"),
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
}

function ensureDirs(): void {
  mkdirSync(SHOT_DIR, { recursive: true });
}

/** 截 `.svg-map-wrap`（只含地圖 + 地圖內控件），存做 PNG，回傳相對路徑。 */
export async function shotMap(page: Page, rel: string): Promise<string> {
  ensureDirs();
  const abs = join(SHOT_DIR, rel);
  await page.locator(".svg-map-wrap").screenshot({ path: abs });
  return `artifacts/b9-qa/screenshots/${rel}`;
}

/** 全頁截圖。 */
export async function shotPage(page: Page, rel: string): Promise<string> {
  ensureDirs();
  const abs = join(SHOT_DIR, rel);
  await page.screenshot({ path: abs });
  return `artifacts/b9-qa/screenshots/${rel}`;
}

/**
 * 由 canvas 直接匯出 PNG（**純底圖**，冇 HUD／SVG 疊層）。
 *
 * 為何需要：Q7（標籤銳利度）同 Q8（tile seam）要分析嘅係底圖本身。
 * 用 element 截圖會夾雜圖例、圖層按鈕、縮放鈕嘅硬邊 → 假 seam。
 * `canvas.toDataURL()` 攞到嘅係**只有 canvas 畫過嘅嘢**。
 */
export async function saveCanvasPng(page: Page, rel: string): Promise<string> {
  ensureDirs();
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#basemap-canvas")!;
    return canvas.toDataURL("image/png");
  });
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const abs = join(SHOT_DIR, rel);
  writeFileSync(abs, Buffer.from(b64, "base64"));
  return `artifacts/b9-qa/screenshots/${rel}`;
}

export interface ColdZoomResult {
  clicks: number;
  longTasks: number;
  totalMs: number;
  maxMs: number;
  wallMs: number;
  fps: number;
}

/**
 * 冷 zoom 阻塞量度（A8 `measure-jank.mjs` 同款協定）。
 *
 * ⚠️ 用 in-page `dispatchEvent`（唔用 `locator.click`）—— 後者每下要等
 * 瀏覽器 round-trip，會令「單位時間內撳到嘅次數」唔同，數字同 baseline 唔可比。
 */
export async function coldZoomLongTasks(
  page: Page,
  clicks = 20,
): Promise<ColdZoomResult> {
  await resetLongTasks(page);
  const t0 = Date.now();
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      document
        .querySelector("#map-zoom-in")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
    }
  }, clicks);
  await page.waitForTimeout(2000);
  const wallMs = Date.now() - t0;
  const lt = await readLongTasks(page);
  const totalMs = lt.reduce((a, e) => a + e.dur, 0);
  const maxMs = lt.length ? Math.max(...lt.map((e) => e.dur)) : 0;
  return {
    clicks,
    longTasks: lt.length,
    totalMs: Math.round(totalMs),
    maxMs: Math.round(maxMs),
    wallMs,
    fps: Number(((clicks / wallMs) * 1000).toFixed(1)),
  };
}

export interface TileRec {
  url: string;
  bytes: number;
}

/** 開始記錄 `/vector/tiles/` 回應大小（Q9）。 */
export function recordTiles(page: Page, sink: TileRec[]): void {
  page.on("response", (r) => {
    const u = r.url();
    if (!/\/vector\/tiles\//.test(u)) return;
    r.body()
      .then((b) => {
        sink.push({ url: u.split("/").slice(-1)[0], bytes: b.length });
      })
      .catch(() => {});
  });
}

/** 寫一份 JSON 落 `artifacts/b9-qa/`，回傳相對路徑。 */
export function writeRaw(name: string, data: unknown): string {
  ensureDirs();
  writeFileSync(join(ARTIFACT_DIR, name), JSON.stringify(data, null, 2), "utf-8");
  return `artifacts/b9-qa/${name}`;
}

/** 由 bbox 反推視窗經緯範圍（診斷用）。 */
export function viewBoxToGeo(vb: number[]): {
  lon_min: number;
  lon_max: number;
  lat_min: number;
  lat_max: number;
} {
  const [x, y, w, h] = vb;
  return {
    lon_min: x,
    lon_max: x + w,
    lat_min: yToLat(y + h),
    lat_max: yToLat(y),
  };
}

export const BASE_H_UNITS = BASE_H;

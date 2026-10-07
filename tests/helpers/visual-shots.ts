// D 階段 5 —— 視覺回歸共用工具（確定性截圖 + 瀏覽器內比對）
//
// 為何要有呢個 helper
// ==================
// 2026-10-07 D 階段 4 實測：**同一份程式碼跑兩次，7 張截圖有 6 張唔同** ✗
// —— 根因係地圖 `flyTo` 係 JS 動畫，截圖截到中間狀態。
// 用嗰種圖做回歸比對 = 將 flakiness 當成 regression ✗。
//
// 所以本 helper 做齊四件事：
//   1. **確定性**：停用 CSS 動畫／過場、等字體、等 `viewBox` 穩定、
//      等 2 帧 rAF；
//   2. **降採樣比對**（50%）：亞像素反鋸齒雜訊會被平均掉
//      （實測底線：同一份程式碼兩次跑，全 7 張合計 7 個像素差、每通道差 1）；
//   3. **零新依賴**：PNG 解碼／比對喺**瀏覽器 canvas** 做
//      （Node 側冇 PNG decoder，加依賴又要 CI 裝）。
//   4. **可更新基線**：`UPDATE_VISUAL_BASELINE=1` 會重寫基線。
//
// 基線位置：`tests/baselines/visual/<name>.png`（50% 降採樣，~190 KB/張）

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";

/** 基線目錄。 */
export const BASELINE_DIR = "tests/baselines/visual";

/** 降採樣比例（比對同儲存都用呢個）。 */
export const DOWNSCALE = 0.5;

/**
 * 比對容忍度（**實測校準**，唔係隨意定）
 * =====================================
 * 雜訊底線（同一份程式碼跑兩次）：全 7 張合計 **7 個像素**、每通道最大差 **1**。
 * 所以：
 *   · `MAX_DIFF_PCT = 0.1%` —— 比底線闊 ~200 倍，但仍然捉得到「一個元件移位／變色」
 *     （1440×900 嘅 0.1% ≈ 1,296 px，即一個 ~36×36 嘅區域）。
 *   · `MAX_DELTA = 32/255` —— 比底線闊 32 倍；單一像素嘅小變化唔會誤報，
 *     但任何肉眼可見嘅色差都會中。
 */
export const MAX_DIFF_PCT = 0.1;
export const MAX_DELTA = 32;

export interface ShotState {
  name: string;
  viewport: { width: number; height: number };
  isMobile?: boolean;
  /** 喺 `goto` 之後、截圖之前做嘅事（例如撳掣／轉章節）。 */
  act?: (page: Page) => Promise<void>;
}

const FREEZE =
  "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}";

/** 等 app ready（章節條有 pill = 資料已載入）＋字體。 */
export async function waitApp(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
    timeout: 25_000,
  });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(600);
}

/**
 * 等畫面穩定：`viewBox` 連續 2 次取樣相同 ＋ 2 帧 rAF ＋ 固定 settle。
 *
 * ⚠️ 冇呢步嘅話，地圖 `flyTo` 動畫會令同一份程式碼都截到唔同圖 ✗
 */
export async function waitStable(page: Page, maxMs = 10_000): Promise<void> {
  const t0 = Date.now();
  let prev: string | null = null;
  for (;;) {
    const vb = await page.evaluate(
      () => document.querySelector("#svg-map")?.getAttribute("viewBox") ?? "",
    );
    if (vb === prev && vb !== "") break;
    prev = vb;
    if (Date.now() - t0 > maxMs) break;
    await page.waitForTimeout(250);
  }
  await page.evaluate(
    () =>
      new Promise((res) =>
        requestAnimationFrame(() => requestAnimationFrame(() => res(null))),
      ),
  );
  await page.waitForTimeout(350);
}

export interface CompareResult {
  total: number;
  diffPixels: number;
  diffPct: number;
  maxDelta: number;
  aSize: string;
  bSize: string;
}

/**
 * 比對兩張 PNG（**全部喺瀏覽器 canvas 內做**）。
 *
 * ⚠️ 為何唔可以「先喺頁面讀 ImageData 再傳返 Node」
 * --------------------------------------------------
 * 720×450 RGBA = 1,296,000 個數字 ✗ → `page.evaluate` 要序列化 ~10 MB JSON
 * → 實測**失敗**（回傳 undefined → 長度唔匹配 → 誤報「100% 唔同」）。
 * 所以降採樣、逐像素比對、統計**全部喺同一個 evaluate 內完成**，
 * 只回傳一個細嘅摘要物件 ✓。
 */
export async function comparePng(
  page: Page,
  aDataUrl: string,
  bDataUrl: string,
): Promise<CompareResult> {
  return page.evaluate(
    async ([ua, ub, scale]) => {
      const decode = async (url: string): Promise<HTMLImageElement> => {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      };
      const toData = (img: HTMLImageElement, w: number, h: number): ImageData => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
      };
      /*
       * ⚠️ 基線已經係**降採樣過**（`writeBaseline` 用 DOWNSCALE 存）→
       * 唔可以再縮一次 ✗（實測：720×450 再 ×0.5 = 360×225 → 同當前圖
       * 720×450 尺寸唔匹配 → 誤報「100% 唔同」）。
       * 所以：**以基線嘅尺寸為準**，將當前圖縮到同一尺寸再比 ✓。
       */
      const A0 = await decode(ua as string);
      // ⚠️ 用基線嘅**原生尺寸**（唔再乘 scale）—— 基線本身已經係 DOWNSCALE
      // 過嘅 50%，再縮一次會變 25% → 細節太少，捉唔到細元件嘅回歸 ✗
      const w = Math.max(1, A0.width);
      const h = Math.max(1, A0.height);
      void scale;
      const A = toData(A0, w, h);
      const B0 = await decode(ub as string);
      const B = toData(B0, w, h);
      const size = (d: ImageData) => `${d.width}x${d.height}`;
      if (A.data.length !== B.data.length) {
        return {
          total: Math.max(A.data.length, B.data.length) / 4,
          diffPixels: Number.POSITIVE_INFINITY,
          diffPct: 100,
          maxDelta: 255,
          aSize: size(A),
          bSize: size(B),
        };
      }
      let diffPixels = 0;
      let maxDelta = 0;
      const a = A.data;
      const b = B.data;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(
          Math.abs(a[i] - b[i]),
          Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2]),
        );
        if (d > 0) diffPixels++;
        if (d > maxDelta) maxDelta = d;
      }
      const total = a.length / 4;
      return {
        total,
        diffPixels,
        diffPct: (100 * diffPixels) / total,
        maxDelta,
        aSize: size(A),
        bSize: size(B),
      };
    },
    [aDataUrl, bDataUrl, DOWNSCALE] as const,
  );
}

/** 讀基線（PNG → data URL）。唔存在回 `null`。 */
export function readBaseline(name: string): string | null {
  const p = join(BASELINE_DIR, `${name}.png`);
  if (!existsSync(p)) return null;
  return `data:image/png;base64,${readFileSync(p).toString("base64")}`;
}

/** 寫基線（由截圖 buffer 降採樣之後存 PNG）。 */
export async function writeBaseline(page: Page, name: string, pngBuffer: Buffer): Promise<void> {
  const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  const scaled = await page.evaluate(
    async ([url, scale]) => {
      const img = new Image();
      img.src = url as string;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * (scale as number)));
      c.height = Math.max(1, Math.round(img.height * (scale as number)));
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    },
    [dataUrl, DOWNSCALE] as const,
  );
  const b64 = scaled.replace(/^data:image\/png;base64,/, "");
  mkdirSync(dirname(join(BASELINE_DIR, `${name}.png`)), { recursive: true });
  writeFileSync(join(BASELINE_DIR, `${name}.png`), Buffer.from(b64, "base64"));
}

/**
 * 7 個 canonical 狀態（同 `probe-dead-css-shots.mjs` 一致）。
 *
 * 選擇理由：覆蓋三個主要 surface（地圖／故事面板／編年史／搜尋）＋
 * 兩種 viewport（1440×900 桌面、390×844 手機）＋「有揀中 zone」嘅狀態。
 */
export const STATES: ShotState[] = [
  { name: "01-desktop-default", viewport: { width: 1440, height: 900 } },
  {
    name: "02-desktop-pane-open",
    viewport: { width: 1440, height: 900 },
    act: async (page) => {
      await page.click("#btn-toggle-panel", { force: true, timeout: 15_000 });
    },
  },
  {
    name: "03-desktop-ch198",
    viewport: { width: 1440, height: 900 },
    act: async (page) => {
      await page.keyboard.press("Escape");
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
    },
  },
  {
    name: "04-desktop-zone-selected",
    viewport: { width: 1440, height: 900 },
    act: async (page) => {
      await page.keyboard.press("Escape");
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await waitStable(page, 12_000);
      const z = await page.evaluate(() => {
        const el = document.querySelector("#zones-layer .zone");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (z) await page.mouse.click(z.x, z.y);
    },
  },
  {
    name: "05-desktop-chronicle",
    viewport: { width: 1440, height: 900 },
    act: async (page) => {
      await page.keyboard.press("Escape");
      await page.click("#btn-mode", { force: true, timeout: 15_000 });
    },
  },
  {
    name: "06-desktop-search-open",
    viewport: { width: 1440, height: 900 },
    act: async (page) => {
      await page.keyboard.press("/");
    },
  },
  { name: "07-mobile-default", viewport: { width: 390, height: 844 }, isMobile: true },
];

/** 開一個 page（已套好 localStorage 同 locale）。 */
export async function openShotPage(
  browser: import("@playwright/test").Browser,
  st: ShotState,
): Promise<Page> {
  const page = await browser.newPage({
    viewport: st.viewport,
    locale: "zh-HK",
    deviceScaleFactor: 1,
    hasTouch: st.isMobile,
    isMobile: st.isMobile,
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("binggang.onboarding.dismissed", "1");
      localStorage.setItem("binggang.theme", "dark");
    } catch {
      /* */
    }
  });
  return page;
}

/** 影一張（已停動畫 + 等穩定）。 */
export async function shoot(page: Page): Promise<Buffer> {
  await page.addStyleTag({ content: FREEZE });
  await waitStable(page);
  return page.screenshot({ animations: "disabled" });
}

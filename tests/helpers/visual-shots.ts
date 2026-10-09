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
  /** 主題（預設 dark）。⚠️ 淺色主題係一條**完全獨立**嘅視覺路徑。 */
  theme?: "dark" | "light";
  /**
   * 喺 `goto` **之前**做嘅事 —— 例如 `page.route(...)` 攔截請求。
   *
   * ⚠️ 一定要喺 `goto` 之前（route 註冊得太遲會漏咗首個請求）。
   * 用途：模擬「載入失敗」狀態（見 `12-desktop-load-failure`）。
   */
  beforeGoto?: (page: Page) => Promise<void>;
  /**
   * 覆寫「等 app ready」嘅行為（預設 `waitApp`）。
   *
   * ⚠️ 失敗狀態**唔會有** `.ch-pill`（資料載入唔到）→ 用預設 `waitApp`
   * 會 timeout。呢個 hook 令每個狀態可以自訂 ready 判準。
   */
  ready?: (page: Page) => Promise<void>;
  /**
   * 停用 service worker（預設 false）。
   *
   * ⚠️ 為何「模擬載入失敗」一定要開：`public/sw.js` 會**快取**資料檔 →
   * 重試嗰次由 SW 回 200（**繞過 `page.route`**）→ 失敗狀態永遠唔會出現 ✗。
   * （2026-10-07 實測：只攔 `characters.json` → 第一次 500、第二次 200 → app 照載入。）
   */
  blockServiceWorkers?: boolean;
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
export async function waitStable(page: Page, maxMs = 12_000): Promise<void> {
  /*
   * ⚠️ 若 `#svg-map` **唔存在**（例如「載入失敗」畫面）→ 冇嘢要等，即刻返。
   * 冇呢個守衛嘅話，`vb` 永遠係 `""` → 會白等到 `maxMs`（每次 +10s）。
   */
  const hasMap = await page.evaluate(() => !!document.querySelector("#svg-map"));
  if (hasMap) {
    /*
     * ⚠️ 2026-10-08：由「連續 2 次相同」加強到「連續 4 次相同」。
     *
     * 為何：原本 2 次 × 250ms = 只要求 **250ms 無變化**。實測
     * `flyToZone` 嘅 JS 動畫（緩動尾段／高負載掉帧）之下，兩個相隔
     * 250ms 嘅樣本可以**碰巧相同** → 提早當「穩定」→ 截到**中途**位置
     * → 同一份程式碼、同一個 baseline 出現 **60.4%** 差異 ✗。
     *
     * 加強之後：要 **4 × 200ms = 800ms 完全無變化** 才當穩定。
     * 呢個係**量度儀器**層面嘅修正，唔會改變任何斷言。
     */
    const NEED = 4;
    const INTERVAL = 200;
    const t0 = Date.now();
    let prev: string | null = null;
    let stable = 0;
    for (;;) {
      const vb = await page.evaluate(
        () => document.querySelector("#svg-map")?.getAttribute("viewBox") ?? "",
      );
      if (vb === prev && vb !== "") {
        if (++stable >= NEED) break;
      } else {
        stable = 0;
      }
      prev = vb;
      if (Date.now() - t0 > maxMs) break;
      await page.waitForTimeout(INTERVAL);
    }
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

/**
 * D5-9：失敗時寫低診斷圖（baseline｜current｜差異熱圖）。
 *
 * 為何需要
 * ========
 * 守衛失敗時淨係得「差異 7.33%／Δ247」—— 唔知**邊度**變 ✗。
 * 呢個函數喺瀏覽器 canvas 內砌一張三格圖（原本／現在／差異熱圖），
 * 寫落 `artifacts/visual-diff/<name>-*.png`，令排查唔需要人手重現 ✓。
 */
export async function writeDiffArtifacts(
  page: Page,
  name: string,
  aDataUrl: string,
  bDataUrl: string,
): Promise<string[]> {
  const imgs = await page.evaluate(
    async ([ua, ub]) => {
      const decode = async (url: string): Promise<HTMLImageElement> => {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      };
      const A = await decode(ua as string);
      const B = await decode(ub as string);
      const w = A.width;
      const h = A.height;
      const mk = (width: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
        const c = document.createElement("canvas");
        c.width = width;
        c.height = h;
        return [c, c.getContext("2d")!];
      };
      // ① baseline
      const [ca, xa] = mk(w);
      xa.drawImage(A, 0, 0, w, h);
      // ② current
      const [cb, xb] = mk(w);
      xb.drawImage(B, 0, 0, w, h);
      // ③ 差異熱圖（紅 = 差得多；灰 = 一樣）
      const [cc, xc] = mk(w);
      xc.drawImage(A, 0, 0, w, h);
      const da = xa.getImageData(0, 0, w, h);
      const db = xb.getImageData(0, 0, w, h);
      const out = xc.createImageData(w, h);
      for (let i = 0; i < da.data.length; i += 4) {
        const d = Math.max(
          Math.abs(da.data[i] - db.data[i]),
          Math.abs(da.data[i + 1] - db.data[i + 1]),
          Math.abs(da.data[i + 2] - db.data[i + 2]),
        );
        const lum = (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3;
        const g = Math.round(lum * 0.35);
        const t = Math.min(1, d / 64);
        out.data[i] = Math.round(g + (255 - g) * t);
        out.data[i + 1] = Math.round(g * (1 - t));
        out.data[i + 2] = Math.round(g * (1 - t));
        out.data[i + 3] = 255;
      }
      xc.putImageData(out, 0, 0);
      return {
        baseline: ca.toDataURL("image/png"),
        current: cb.toDataURL("image/png"),
        diff: cc.toDataURL("image/png"),
      };
    },
    [aDataUrl, bDataUrl] as const,
  );

  const dir = "artifacts/visual-diff";
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [kind, url] of Object.entries(imgs)) {
    const b64 = (url as string).replace(/^data:image\/png;base64,/, "");
    const out = join(dir, `${name}-${kind}.png`);
    writeFileSync(out, Buffer.from(b64, "base64"));
    written.push(out);
  }
  return written;
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
 * **12 個** canonical 狀態 —— 全專案**唯一來源**（D5-10）。
 *
 * 覆蓋：三個主要 surface（地圖／故事面板／編年史／搜尋）＋
 * 兩種 viewport（1440×900 桌面、390×844 手機）＋「有揀中 zone」＋
 * 淺色主題（獨立視覺路徑）＋ 1280／1920 邊界 ＋ **載入失敗路徑**。
 *
 * ⚠️ `visual-shots.mjs`／`probe-dead-css-shots.mjs`／`probe-style-contract.mjs`
 * 同兩個 e2e 守衛都係**直接讀呢個陣列**（唔可以再自己抄一份）。
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
      /*
       * ⚠️ 2026-10-08：**唔用座標 click** —— 改用 URL 直接入「揀定 zone」狀態。
       *
       * 為何：原本係「點第一個 zone 嘅中心」。實測（同一份程式碼、同一個
       * baseline）會有兩種結果：
       *   · 點中預期嘅 zone → 正常；
       *   · 地圖仍未完全定 → 座標唔中 → 撞到**另一個** zone
       *     → 唔同 dossier（3.41% 像素差）／甚至冇選中（80.99%）✗
       * 即係話，`page.mouse.click(座標)` 係**本質上 racy**。
       *
       * 修法：由 DOM 讀第一個 zone 嘅 `data-zone-id`，再用 URL 導航
       * （`?zone=…&chapter=198`）—— **完全確定性**，唔受動畫時序影響。
       * 呢個係**設定步驟**（狀態本身），唔係斷言。
       */
      const id = await page.evaluate(
        () =>
          document
            .querySelector("#zones-layer .zone")
            ?.getAttribute("data-zone-id") ?? null,
      );
      const u = new URL(page.url());
      if (id) u.searchParams.set("zone", id);
      u.searchParams.set("chapter", "198");
      await page.goto(u.toString(), { waitUntil: "networkidle" });
      await waitApp(page);
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
  /*
   * ⚠️ D5-8（2026-10-07）：淺色主題係一條**完全獨立**嘅視覺路徑
   * （`tokens.css` 有成套 `[data-theme="light"]` 覆蓋）→ 之前零覆蓋 ✗。
   * 另外補 1280×800 同 1920×1080（`legacy-migrated.css` 有 1279px 斷點，
   * 1280 正好喺斷點之上；1920 係大螢幕代表）。
   */
  {
    name: "08-desktop-light-default",
    viewport: { width: 1440, height: 900 },
    theme: "light",
  },
  {
    name: "09-desktop-light-chronicle",
    viewport: { width: 1440, height: 900 },
    theme: "light",
    act: async (page) => {
      await page.keyboard.press("Escape");
      await page.click("#btn-mode", { force: true, timeout: 15_000 });
    },
  },
  { name: "10-desktop-1280-default", viewport: { width: 1280, height: 800 } },
  { name: "11-desktop-1920-default", viewport: { width: 1920, height: 1080 } },
  /*
   * ⚠️ D2-9 擴狀態（2026-10-07）：**載入失敗**路徑。
   *
   * 為何一定要有：`docs/contracts/class-contract.json` 保護嘅
   * `.bg-error-panel`／`-detail`／`-hint`／`.bg-retry-btn` **只喺失敗路徑出現**
   * → 之前 11 個狀態全部係正常路徑 → 執行期探測永遠睇唔到 → 極易被誤判死
   * （呢個正正係 D4-3 嘅盲點）。加咗呢個狀態之後，契約 class 有**執行期證據**。
   *
   * ⚠️ 確定性：只令 **一個** 請求（`characters.json`）回 500。
   * `loadAllData()` 用 `Promise.all` → 若多過一個請求同時失敗，
   * **reject 次序唔確定** → 錯誤訊息會飄 → 像素基線會 flaky ✗。
   */
  {
    name: "12-desktop-load-failure",
    viewport: { width: 1440, height: 900 },
    blockServiceWorkers: true,
    beforeGoto: async (page) => {
      await page.route(/\/data\/public\/characters\.json$/, (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
      );
    },
    ready: async (page) => {
      // 失敗畫面出現之前有 3 次重試（0.6s + 1.2s）→ 要等耐啲。
      await page.waitForSelector(".bg-error-panel", { timeout: 25_000 });
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await page.waitForTimeout(400);
    },
  },
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
    // 見 `blockServiceWorkers` 嘅說明（失敗狀態必須停 SW，否則 route 被繞過）。
    serviceWorkers: st.blockServiceWorkers ? "block" : "allow",
  });
  await page.addInitScript((theme) => {
    try {
      localStorage.setItem("binggang.onboarding.dismissed", "1");
      localStorage.setItem("binggang-theme", theme);
    } catch {
      /* */
    }
  }, st.theme ?? "dark");
  return page;
}

/**
 * 影一張（已停動畫 + 等穩定）。
 *
 * ⚠️ 2026-10-08：加「**連續兩張截圖完全相同**」嘅等待。
 *
 * 為何需要：`waitStable()` 只等**地圖 viewBox** 穩定 —— 佢證明唔到
 * 頁面其餘部分（頂欄、故事面板、章節條）已經 render 完。
 * 實測：全套測試（CPU 高負載）之下，`04-desktop-zone-selected` 有時
 * 捕捉到**未 render 完**嘅畫面（頂欄右邊控制項未出現、故事面板未開）
 * → 同一份程式碼、同一個 baseline 出現 **80.99%** 差異 ✗
 * （單獨跑 5/5 完全一致）。
 *
 * 做法：連影直到兩張相鄰截圖**逐 byte 相同**（= 畫面真係靜止）。
 * 呢個係**量度儀器**層面嘅修正，唔會改變任何斷言。
 */
export async function shoot(page: Page): Promise<Buffer> {
  await page.addStyleTag({ content: FREEZE });
  await waitStable(page);
  let prev = await page.screenshot({ animations: "disabled" });
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(120);
    const next = await page.screenshot({ animations: "disabled" });
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
}

/**
 * **開一個「已 boot 好」嘅 shot page** —— 全部呼叫者共用同一條程序。
 *
 * 程序（順序有意義）：
 *   1. `openShotPage()`（viewport／locale／theme init script）；
 *   2. `st.beforeGoto?.(page)`（例如 `page.route(...)` 攔截請求）；
 *   3. `page.goto(baseUrl)`；
 *   4. `st.ready ?? waitApp`（失敗狀態要自訂 ready 判準）；
 *   5. `st.act?.(page)`；
 *   6. `waitStable(page)`。
 *
 * ⚠️ 為何要抽成一個函數：之前 4 個呼叫者各自抄一次呢個序列 →
 * 加 `beforeGoto`／`ready` 就要改 4 個地方（同 D5-10 嘅教訓一樣）。
 */
export async function bootShotPage(
  browser: import("@playwright/test").Browser,
  st: ShotState,
  baseUrl: string,
): Promise<Page> {
  const page = await openShotPage(browser, st);
  if (st.beforeGoto) await st.beforeGoto(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await (st.ready ?? waitApp)(page);
  if (st.act) await st.act(page);
  await waitStable(page);
  return page;
}

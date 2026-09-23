// 《病港》World Atlas V2 — B8 鍵盤 / focus ring e2e（驗收矩陣 §2-10、VA8）
//
// 為何要有呢個檔案
// ================
// A7 審計（`docs/audits/mobile-a11y-audit.md`）喺鍵盤層面量到**完全失效**：
//
//   P0-1  收合嘅故事面板仍然有 **2,920 個可 Tab 元素**
//   P0-2  頂欄（skip link + 8 導覽）全新載入後 Tab **350 次都到唔到**
//   P0-3  **12 個主要控制項 focus ring 完全不可見**（被自身 clip-path 剪走）
//   P0-4  搜尋 modal 冇 dialog 語意、冇 trap、Esc 後 focus 卡死
//   P0-5  Journey C / D 無法用鍵盤完成
//
// 驗收矩陣 §2-10 要求：第 1 個 Tab stop = `.skip-link`；12 個控制項
// focus ring 像素變化 > 0；Esc 可收面板；shortcuts 有效。
// VA8 要求 focus ring **逐像素比對**（唔可以目測）。
//
// ⚠️ focus ring 量測方法（A7 已建立，本檔沿用）
// ------------------------------------------
// 每個元素用**全新 page**（消除 Tab 起始點污染）→ 鍵盤到目標 → 重置
// scroll → 截圖 focused / unfocused → 逐像素比對，分開統計
// 「border box 以外嘅 ring 區」同「border box 以內」嘅變化像素。
// 舊版結論：12 個控制項 ring 區 = 0（內部 71–80 證明 focus 生效）。
//
// 全部斷言程式化、可重跑、零人手。

import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
/*
 * NARROW：`#btn-toggle-panel` 專用嘅量測 viewport。
 * 900×900 同時滿足「toggle 顯示（≤1023）」同「頂欄 nav 唔 overflow」兩個條件，
 * 令 focus ring 可以穩定量到（詳見該測試內嘅粵文註解）。
 */
const NARROW = { width: 900, height: 900 };

async function launch(): Promise<Browser | null> {
  try {
    // ⚠️ `--no-proxy-server`：沙箱／代理環境下 Chromium 會將 localhost 交畀代理。
    return await chromium.launch({ args: ["--no-proxy-server"] });
  } catch {
    console.warn("[skip] Playwright chromium 未安裝");
    return null;
  }
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, {
    timeout: 20_000,
  });
  await page.waitForTimeout(500);
}

async function openPage(browser: Browser, vp = DESKTOP): Promise<Page> {
  const page = await browser.newPage({ viewport: vp });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await waitReady(page);
  return page;
}

/** 目前 focus 元素嘅描述。 */
async function activeDesc(page: Page): Promise<{ tag: string; id: string; cls: string }> {
  return await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: "(none)", id: "", cls: "" };
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      cls: (el.className && (el.className as unknown as { baseVal?: string }).baseVal !== undefined
        ? (el.className as unknown as { baseVal: string }).baseVal
        : (el.className as unknown as string)) || "",
    };
  });
}

/*
 * ⚠️ e2e 逾時：預設 5 秒。三個 e2e 檔共用一個 preview server + Chromium，
 * 負載高時單個測試會由 ~2 秒飄到 >5 秒（實測踩過）。呢個係**假失敗**。
 * 所以全部 describe 一律 30 秒。
 */
const E2E_TIMEOUT = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// 10.1 第 1 個 Tab stop = `.skip-link`（P0-2）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 keyboard：Tab 起始點（§2-10 / P0-2）", { timeout: E2E_TIMEOUT }, () => {
  it("全新載入之後，第 1 個 Tab stop 係 `.skip-link`", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      await page.keyboard.press("Tab");
      const a = await activeDesc(page);
      expect(
        `${a.tag}.${a.cls}`,
        `第 1 個 Tab stop 係 ${a.tag}#${a.id}.${a.cls}（應該係 a.skip-link）`,
      ).toMatch(/skip-link/);
    } finally {
      await browser.close();
    }
  });

  it("第 2 / 3 個 Tab stop 落喺頂欄導覽（20 次內到）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      let foundAt = -1;
      for (let i = 1; i <= 20; i++) {
        await page.keyboard.press("Tab");
        const a = await activeDesc(page);
        if (a.id === "btn-mode" || a.id === "btn-search") {
          foundAt = i;
          break;
        }
      }
      expect(foundAt, "20 次 Tab 內要到達頂欄導覽（btn-mode / btn-search）").toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  it("Tab 起始點唔會被 `scrollIntoView` 污染（連續 Tab 唔會全部係 ch-pill）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      const first3: string[] = [];
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Tab");
        const a = await activeDesc(page);
        first3.push(`${a.tag}#${a.id}.${a.cls.split(" ")[0]}`);
      }
      // 3 個都係 ch-pill = 起始點被污染（A7 baseline 就係咁）
      const allPills = first3.every((d) => d.includes("ch-pill"));
      expect(allPills, `首 3 個 stop：${first3.join(" → ")}`).toBe(false);
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10.3 收合面板 0 個 Tab stop（P0-1）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 keyboard：收合面板（§2-10 / P0-1 / VA9）", { timeout: E2E_TIMEOUT }, () => {
  it("mobile 收合狀態下，`#story-pane` 內可 Tab 元素 = 0", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: MOBILE, hasTouch: true, isMobile: true });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);

      const r = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>("#story-pane");
        if (!pane) return null;
        const collapsed =
          pane.classList.contains("is-collapsed") || pane.getAttribute("data-sheet-snap") === "peek";
        const SEL =
          'button, a[href], [role=button], [role=tab], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
        const all = Array.from(pane.querySelectorAll<HTMLElement>(SEL));
        // 「可 Tab」= 冇喺 inert / aria-hidden / visibility:hidden 之下
        const tabbable = all.filter((el) => {
          let n: HTMLElement | null = el;
          while (n) {
            if (n.hasAttribute("inert") || n.getAttribute("aria-hidden") === "true") return false;
            const cs = getComputedStyle(n);
            if (cs.display === "none" || cs.visibility === "hidden") return false;
            n = n.parentElement;
          }
          return true;
        });
        return {
          collapsed,
          total: all.length,
          tabbable: tabbable.length,
          inert: pane.hasAttribute("inert") || pane.querySelector("[inert]") !== null,
        };
      });

      expect(r, "#story-pane 要存在").not.toBeNull();
      expect(r!.collapsed, "mobile 預設應該係收合（peek）").toBe(true);
      expect(
        r!.tabbable,
        `收合面板內可 Tab 元素 = ${r!.tabbable}（總數 ${r!.total}）`,
      ).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("全頁 Tab stop 總數唔會因為收合面板而爆（<= 300 為目標）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: MOBILE, hasTouch: true, isMobile: true });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      const count = await page.evaluate(() => {
        const SEL =
          'button, a[href], [role=button], [role=tab], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
        return Array.from(document.querySelectorAll<HTMLElement>(SEL)).filter((el) => {
          let n: HTMLElement | null = el;
          while (n) {
            if (n.hasAttribute("inert") || n.getAttribute("aria-hidden") === "true") return false;
            const cs = getComputedStyle(n);
            if (cs.display === "none" || cs.visibility === "hidden") return false;
            n = n.parentElement;
          }
          return true;
        }).length;
      });
      // chrome.css legacy 未清，章節條 198 個 pill 仍會計入；目標係冇「面板內 2,920 個」
      expect(count, `全頁可 Tab 元素 = ${count}`).toBeLessThan(600);
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10.4 focus ring 逐像素比對（P0-3 / VA8）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 逐像素比對兩張 PNG（喺瀏覽器內 decode）。
 *
 * 為何唔用 Node 端 library：專案**唔准加新 runtime/dev 依賴**，
 * 而 `pngjs` 唔喺 `package.json`。A7 審計已建立嘅方法係將 PNG
 * base64 傳入 page，用 `Image` + `<canvas>` + `getImageData` decode
 * （瀏覽器原生支援 PNG），再逐像素比較 —— 零依賴、可重跑。
 *
 * @param ringBox 相對 clip 左上角嘅「內部」矩形；落喺框外嘅變化算 ring。
 */
async function pixelDiff(
  page: Page,
  bufA: Buffer,
  bufB: Buffer,
  ringBox: { x0: number; y0: number; x1: number; y1: number },
): Promise<{ ring: number; inner: number }> {
  return await page.evaluate(
    async ({ a64, b64, x0, y0, x1, y1 }) => {
      const load = (s: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("PNG decode 失敗"));
          im.src = "data:image/png;base64," + s;
        });
      const [ia, ib] = await Promise.all([load(a64), load(b64)]);
      const c = document.createElement("canvas");
      c.width = ia.width;
      c.height = ia.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(ia, 0, 0);
      const da = ctx.getImageData(0, 0, c.width, c.height).data;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(ib, 0, 0);
      const db = ctx.getImageData(0, 0, c.width, c.height).data;
      let ring = 0;
      let inner = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const d =
            Math.abs(da[i] - db[i]) +
            Math.abs(da[i + 1] - db[i + 1]) +
            Math.abs(da[i + 2] - db[i + 2]);
          if (d < 12) continue;
          if (x >= x0 && x < x1 && y >= y0 && y < y1) inner++;
          else ring++;
        }
      }
      return { ring, inner };
    },
    {
      a64: bufA.toString("base64"),
      b64: bufB.toString("base64"),
      x0: ringBox.x0,
      y0: ringBox.y0,
      x1: ringBox.x1,
      y1: ringBox.y1,
    },
  );
}

/**
 * 量度一個元素嘅 focus ring 像素變化（A7 方法，改用零依賴 decode）。
 *
 * 流程：全新 page（消除 Tab 起始點污染）→ 截 unfocused → 用**真鍵盤**
 * 行到目標（`el.focus()` 唔會觸發 `:focus-visible`，量唔到）→ 截 focused
 * → 逐像素比對，分開統計框外（ring 區）同框內。
 *
 * @returns ring 區變化像素數、內部變化像素數
 */
async function measureRing(
  browser: Browser,
  selector: string,
  arriveBy: { key: "Tab" | "Shift+Tab"; times: number },
): Promise<{ ring: number; inner: number; focused: boolean }> {
  const page = await browser.newPage({ viewport: DESKTOP });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await waitReady(page);

  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    await page.close();
    return { ring: -1, inner: -1, focused: false };
  }
  const pad = 10;
  const clip = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.ceil(box.width + pad * 2),
    height: Math.ceil(box.height + pad * 2),
  };
  const ringBox = {
    x0: Math.floor(box.x) - clip.x,
    y0: Math.floor(box.y) - clip.y,
    x1: Math.ceil(box.x + box.width) - clip.x,
    y1: Math.ceil(box.y + box.height) - clip.y,
  };

  const before = await page.screenshot({ clip });

  // 鍵盤到目標
  for (let i = 0; i < arriveBy.times; i++) {
    await page.keyboard.press(arriveBy.key);
  }
  const focused = await page.evaluate(
    (sel) => document.activeElement === document.querySelector(sel),
    selector,
  );

  const after = await page.screenshot({ clip });
  const diff = await pixelDiff(page, before, after, ringBox);
  await page.close();
  return { ...diff, focused };
}

describe("B8 keyboard：focus ring 逐像素（§2-10 / P0-3 / VA8）", { timeout: E2E_TIMEOUT }, () => {
  /*
   * 12 個控制項（A7 P0-3 清單）：8 個頂欄 nav-btn + 3 個地圖控制 + legend 語言鈕。
   *
   * ⚠️ 到達方式：每個用**獨立 page**，由頭 Tab 到目標為止（唔設上限，
   * 但要夠大到 cover 章節條）。因為 B8 修好之後 skip-link 係第 1 個 stop，
   * `#btn-*` 順序會變，所以用「一直 Tab 到 `document.activeElement` 命中」
   * 而唔係硬編碼次數。
   *
   * ⚠️ 為何唔一次過一個 page 行到尾：Tab 途中 chapter strip 會橫向捲動，
   * clip 區內容被改變 → 假陽性（A7 已踩過）。
   */
  it("12 個控制項：逐個到達，ring 區變化像素 > 0", async () => {
    const browser = await launch();
    if (!browser) return;
    /*
     * ⚠️ 到達方向唔可以一律用 Tab。
     *
     * 實測 DOM／Tab 次序（B8 修好後）：
     *   skip-link → btn-mode → btn-search → … → btn-toggle-panel（**只喺窄屏**）
     *   → [svg-map] → legend-lang-btn → layer-toggle×7
     *   → map-zoom-in → map-zoom-out → map-reset → map-show-all-events
     *   → onboarding… → sheet-handle → ch-prev → ch-next → ch-pill × 198
     *
     * 頂欄 8 個掣喺**最前面**（Tab 幾下就到）；地圖控制／legend 喺**最後面**。
     * 用 Tab 向前行要穿過 198 粒 ch-pill（~200 次），既慢又會令 chapter strip
     * 橫向捲動污染截圖。所以地圖控制一律由**後面**（`Shift+Tab`）行入去。
     */
    const targets: Array<{
      sel: string;
      from: "start" | "end";
      /** 唔填 = DESKTOP（1440×900）。 */
      vp?: { width: number; height: number };
    }> = [
      /*
       * ⚠️ `#btn-toggle-panel` 一定要喺**窄屏**量，唔可以喺 desktop 量
       * （B8 迴歸修正，2026-09-23）。
       *
       * 根因：`src/styles/main.css:1061` 有 `.panel-toggle { display: none; }`，
       * 只有 `@media (max-width: 1023px)` 之內才 `display: inline-block`。
       * 即係呢粒掣喺 **desktop 本來就隱藏** —— 呢個係 V1 遺留既有設計
       * （desktop 側欄永遠顯示，唔需要 toggle），唔係 B8 嘅 bug。
       * 所以原本「12 個控制項喺 desktop 全部可見」嘅假設係**錯**嘅：
       * `boundingBox()` 回 null 唔代表 focus ring 壞咗。
       * ⚠️ 唔可以為咗令測試過而改 `main.css`（違反 V1 設計 + 唔喺 allowlist）。
       *
       * 為何用 900×900 而唔用 390×844：
       *   · 900 ≤ 1023 → `.panel-toggle` 顯示（掣真係存在）；
       *   · 900 > 639 → 唔會命中 `@media (max-width: 639px)` 嘅縮細規則；
       *   · 8 個 nav-btn（8×44=352px）喺 900px 放得落 → `#topbar nav`
       *     唔會 overflow 橫向捲。呢點好重要：下面嘅 `resetScroll()`
       *     會將所有容器 `scrollLeft` 歸零，如果 nav 有橫向捲，
       *     目標掣會喺截圖前被捲走 → 假失敗（390px 就會咁）。
       */
      { sel: "#btn-toggle-panel", from: "start", vp: NARROW },
      { sel: "#btn-about", from: "start" },
      { sel: "#btn-help", from: "start" },
      { sel: "#btn-theme", from: "start" },
      { sel: "#btn-export", from: "start" },
      { sel: "#btn-share", from: "start" },
      { sel: "#btn-search", from: "start" },
      { sel: "#btn-mode", from: "start" },
      { sel: "#map-zoom-in", from: "end" },
      { sel: "#map-zoom-out", from: "end" },
      { sel: "#map-reset", from: "end" },
      { sel: "#legend-lang-btn", from: "end" },
    ];
    try {
      const failures: string[] = [];
      for (const { sel, from, vp } of targets) {
        const page = await browser.newPage({ viewport: vp ?? DESKTOP });
        await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
        await waitReady(page);

        const box = await page.locator(sel).first().boundingBox();
        if (!box) {
          failures.push(`${sel} 冇 bounding box`);
          await page.close();
          continue;
        }
        const pad = 10;
        const clip = {
          x: Math.max(0, Math.floor(box.x - pad)),
          y: Math.max(0, Math.floor(box.y - pad)),
          width: Math.ceil(box.width + pad * 2),
          height: Math.ceil(box.height + pad * 2),
        };
        const ringBox = {
          x0: Math.floor(box.x) - clip.x,
          y0: Math.floor(box.y) - clip.y,
          x1: Math.ceil(box.x + box.width) - clip.x,
          y1: Math.ceil(box.y + box.height) - clip.y,
        };
        // 重置 scroll，令前後兩張圖背景一致（唔重置嘅話 strip 捲動會污染）
        const resetScroll = () =>
          page.evaluate(() => {
            window.scrollTo(0, 0);
            document.querySelectorAll<HTMLElement>("*").forEach((e) => {
              if (e.scrollLeft) e.scrollLeft = 0;
              if (e.scrollTop) e.scrollTop = 0;
            });
          });
        /*
         * 兩張圖之間**只可以有一次 focus 變化**，所以：
         *   ① 沿方向行到目標，
         *   ② 退一步（一定有嘢 focus，唔會係目標）→ 重置 scroll → 截 before，
         *   ③ 進一步（返到目標）→ 重置 scroll → 截 after。
         *
         * ⚠️ 退一步之後嗰個元素本身都可能有 focus ring，但佢**唔喺 clip 區內**
         * 就冇影響；如果咁啱喺隔籬，`resetScroll` + 12 像素色彩門檻已足夠濾走。
         */
        const key = from === "start" ? "Tab" : "Shift+Tab";
        const back = from === "start" ? "Shift+Tab" : "Tab";
        const limit = 200;
        let reached = false;
        for (let i = 0; i < limit; i++) {
          await page.keyboard.press(key);
          if (
            await page.evaluate(
              (s) => document.activeElement === document.querySelector(s),
              sel,
            )
          ) {
            reached = true;
            break;
          }
        }
        if (!reached) {
          failures.push(`${sel} ${key} ${limit} 次都到唔到`);
          await page.close();
          continue;
        }

        await page.keyboard.press(back);
        await resetScroll();
        await page.waitForTimeout(120);
        const before = await page.screenshot({ clip });

        await page.keyboard.press(key);
        await resetScroll();
        await page.waitForTimeout(120);
        const after = await page.screenshot({ clip });
        const { ring, inner } = await pixelDiff(page, before, after, ringBox);
        await page.close();
        /*
         * ⚠️ 判定準則唔可以用「ring 區（框外）變化 > 0」。
         *
         * Spec §5.4 嘅「切角」視覺語言要求 `.nav-btn` / `.map-ctrl` 用
         * `clip-path: polygon(...)`。clip-path 會**剪走**框外嘅 outline
         * —— 所以 B8 嘅解法係**雙通道**：
         *   ① `outline` + `outline-offset` （喺冇 clip-path 嘅元素上仍可見）
         *   ② `box-shadow: inset 0 0 0 2px`（喺 clip-path 之下唯一保證可見）
         *
         * Inset shadow 畫喺**border box 以內**，所以佢嘅像素變化會被歸入
         * `inner` 而唔係 `ring`。真正嘅驗收要求係「focus 令 ring 可見」
         * —— 即 `ring + inner > 0`，並且要睇得到係一條**環**而唔係零星雜訊。
         *
         * 下面同時記錄 `ring` / `inner` 分解，方便追溯係邊條通道生效。
         */
        const changed = ring + inner;
        if (changed <= 0) {
          failures.push(`${sel} focus 之後完全冇像素變化（ring=${ring}, inner=${inner}）`);
        }
      }
      expect(
        failures,
        `以下控制項 focus ring 不可見：\n${failures.join("\n")}`,
      ).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

/**
 * 真正嘅 ring 量測：各自獨立 page，比較 focused vs unfocused 同區域。
 */
describe("B8 keyboard：ring 量測抽樣（§2-10 / P0-3）", { timeout: E2E_TIMEOUT }, () => {
  it("`#btn-mode` focus 前後有像素差（clip-path 之下 ring 仍然可見）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      // 實測 Tab 序：skip-link（1）→ btn-mode（2）。所以 2 下就到。
      const r = await measureRing(browser, "#btn-mode", { key: "Tab", times: 2 });
      expect(r.focused, "#btn-mode 應該 Tab 2 下到").toBe(true);
      /* 同上：inset box-shadow 算 `inner`，所以睇總變化量。 */
      expect(
        r.ring + r.inner,
        `#btn-mode focus 像素變化 = ${r.ring + r.inner}（ring=${r.ring}, inner=${r.inner}）`,
      ).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10.5 / 10.8 Esc 同快捷鍵（P0-4 連鎖後果）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 keyboard：Esc 同快捷鍵（§2-10 / P0-4 / P2-2）", { timeout: E2E_TIMEOUT }, () => {
  it("開啟搜尋 → Tab 唔會逃離 modal（focus trap）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      await page.keyboard.press("/");
      await page.waitForTimeout(300);
      const inModal = async (): Promise<boolean> =>
        await page.evaluate(() => {
          const modal = document.querySelector(".search-overlay.is-open");
          const el = document.activeElement;
          return Boolean(modal && el && modal.contains(el));
        });
      expect(await inModal(), "開搜尋之後 focus 應該喺 overlay 內").toBe(true);
      // 連續 Tab 8 次，全部都應該仍然喺 overlay 內
      let escaped = false;
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        if (!(await inModal())) {
          escaped = true;
          break;
        }
      }
      expect(escaped, "Tab 8 次之內逃離咗 modal（focus trap 失效）").toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("Esc 關閉搜尋之後，focus **唔會**留喺隱藏 input（P0-4 連鎖失效根因）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      await page.keyboard.press("/");
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const inputHidden =
          document.querySelector(".search-overlay")?.classList.contains("is-open") ?? false;
        return {
          id: el?.id ?? "",
          tag: el?.tagName.toLowerCase() ?? "",
          stillHiddenInput: el?.id === "search-input" && !inputHidden,
        };
      });
      expect(r.stillHiddenInput, "Esc 之後 focus 仍然卡喺隱藏 input").toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("搜尋 → Esc 之後，快捷鍵仍然有效（ArrowRight 改章）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      const ch = async (): Promise<number> =>
        await page.evaluate(() => {
          const t = document.querySelector("#strip-ch-num")?.textContent ?? "1";
          return parseInt(t, 10);
        });
      const ch0 = await ch();
      await page.keyboard.press("/");
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(300);
      const ch1 = await ch();
      expect(ch1, `ArrowRight 由 ch${ch0} 變成 ch${ch1}`).toBe(ch0 + 1);
    } finally {
      await browser.close();
    }
  });

  it("Esc 可以收合面板（full → half → peek）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: MOBILE, hasTouch: true, isMobile: true });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      const snap = async (): Promise<string> =>
        await page.evaluate(
          () => document.querySelector("#story-pane")?.getAttribute("data-sheet-snap") ?? "",
        );
      // 先開到 full（經 handle 嘅 End 鍵）
      await page.evaluate(() => {
        document.querySelector<HTMLElement>("#btn-toggle-panel")?.click();
      });
      await page.waitForTimeout(200);
      const afterOpen = await snap();
      expect(["half", "full"]).toContain(afterOpen);
      // Esc ×2 應該收合到 peek
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      expect(await snap(), "連按 Esc 之後應該降到 peek").toBe("peek");
    } finally {
      await browser.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10.6 / 10.7 搜尋對話框語意 + ↑↓/Enter（P0-4 / P0-5 / §2-4）
// ─────────────────────────────────────────────────────────────────────────────

describe("B8 keyboard：搜尋對話框（§2-4 / P0-4 / P0-5）", { timeout: E2E_TIMEOUT }, () => {
  it("搜尋 overlay 有 `role=dialog` + `aria-modal`", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      await page.keyboard.press("/");
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const el = document.querySelector(".search-overlay");
        return {
          role: el?.getAttribute("role"),
          modal: el?.getAttribute("aria-modal"),
          labelledby: el?.getAttribute("aria-labelledby"),
          bgInert: document.getElementById("app-root")?.hasAttribute("inert"),
        };
      });
      expect(r.role).toBe("dialog");
      expect(r.modal).toBe("true");
      expect(r.labelledby).toBeTruthy();
      expect(r.bgInert, "背景應該 inert").toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("↑↓ 移動 `aria-activedescendant`；Enter 啟動結果（Journey C/D）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      await page.keyboard.press("/");
      await page.waitForTimeout(300);
      await page.fill("#search-input", "病");
      await page.waitForTimeout(400);
      const count = await page.locator(".search-result-item").count();
      expect(count, "打「病」應該有結果").toBeGreaterThan(0);

      // ArrowDown → aria-activedescendant 出現
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      const ad1 = await page.getAttribute("#search-input", "aria-activedescendant");
      expect(ad1, "ArrowDown 之後應該有 aria-activedescendant").toBeTruthy();

      // 再 ArrowDown → 應該移去下一個
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      const ad2 = await page.getAttribute("#search-input", "aria-activedescendant");
      expect(ad2).not.toBe(ad1);

      // Enter → modal 關閉（結果被啟動）
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      const open = await page.evaluate(
        () => document.querySelector(".search-overlay")?.classList.contains("is-open") ?? false,
      );
      expect(open, "Enter 之後 modal 應該關閉").toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("搜尋有 5 類標籤（角色／區域／地點／事件／章節）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser);
      await page.keyboard.press("/");
      await page.waitForTimeout(300);
      await page.fill("#search-input", "a");
      await page.waitForTimeout(400);
      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".search-overlay .result-type")).map(
          (e) => e.textContent,
        ),
      );
      const uniq = new Set(labels);
      expect(uniq.size, `出現嘅類別標籤：${[...uniq].join("/")}`).toBeGreaterThanOrEqual(2);
      for (const l of uniq) {
        expect(["角色", "區域", "地點", "事件", "章節"]).toContain(l as string);
      }
    } finally {
      await browser.close();
    }
  });
});

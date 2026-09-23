// B6 — Zone 可點嘅**實瀏覽器**驗證（P0-1 嘅最終證據）
//
// 為何要有呢個檔（node 單測唔夠）
// ============================
// `tests/map-css-contract.test.ts` 證明咗「`map.css` 有 (1,1,0) 嘅
// `pointer-events: auto`」。但嗰個係**靜態字串斷言** —— 佢證明唔到：
//
//   ① 個 CSS 真係載入到（`SvgMap` 注入機制有冇喺 production build 生效）；
//   ② cascade 順序真係令嗰條規則贏（`main.css:458` 唔會反勝）；
//   ③ `document.elementFromPoint(zone 中心)` 真係命中 `.zone`；
//   ④ click 之後 `store.selectedZoneId` 真係變成非空。
//
// 呢四樣一定要喺真 Chromium 度驗。呢個檔就係嗰層。
//
// 全部斷言都係程式化、可重跑（冇人手目測／抽樣）。

import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:5174";

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

/** 等到向量底圖 ready（同 `map-render.test.ts` 一致）。 */
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

interface ZonePick {
  cx: number;
  cy: number;
  id: string | null;
  /** 中心點實際命中嘅元素 class（診斷用）。 */
  hitClass: string | null;
}

/**
 * 揀「第一個**真正可點**嘅 zone」。
 *
 * 為何唔可以淨係揀「第一個夠大嘅 zone」（B8 迴歸修正，2026-09-23）
 * -------------------------------------------------------------
 * 原本三個呼叫點都只篩「bounding box 夠大 + 中心點喺 SVG 範圍內」，
 * 但**冇檢查中心點有冇被其他元素遮蓋**。實測（`artifacts/b8-scratch/
 * diag4-reproducibility.mjs`，3 次 100% 重現）：`zone_2a22537f9c`
 * 嘅中心 (686, 192) 被初次入站引導卡 `.onboarding-card` 蓋住 →
 * `elementFromPoint(686, 192)` 命中卡片內嘅 `H2` 而唔係 `.zone`
 * → 「zone 中心應該命中 .zone」斷言假失敗。
 *
 * 「可點」嘅唯一可靠定義係 `elementFromPoint(中心點)` 命中 `.zone`
 * 或其後代。呢個 helper 由**第一個夠大**改成**第一個真正可點**，
 * 同時保留原本嘅尺寸／邊界過濾（太細或貼邊會 flaky）。
 *
 * ⚠️ 呢個係測試側嘅修正，唔可以代替產品側修正 ——
 * `.onboarding-card` 嘅遮蓋問題已喺 `mobile.css` 修好（見該檔 §9）。
 */
async function pickClickableZone(
  page: Page,
  opts: { minSize?: number; margin?: number } = {},
): Promise<ZonePick | null> {
  const minSize = opts.minSize ?? 16;
  const margin = opts.margin ?? 8;
  return page.evaluate(
    ({ minSize, margin }) => {
      const svg = document.querySelector("#svg-map") as SVGSVGElement;
      const r = svg.getBoundingClientRect();
      for (const z of Array.from(document.querySelectorAll("#zones-layer .zone"))) {
        const a = z.querySelector(".zone-area") as SVGPathElement | null;
        if (!a) continue;
        const b = a.getBoundingClientRect();
        if (b.width < minSize || b.height < minSize) continue;
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        if (cx < r.x + margin || cx > r.right - margin) continue;
        if (cy < r.y + margin || cy > r.bottom - margin) continue;
        // ⚠️ 核心：中心點一定要真正命中 .zone 或其後代（唔可以被引導卡等遮蓋）
        const el = document.elementFromPoint(cx, cy) as Element | null;
        const hitsZone =
          Boolean(el?.closest?.(".zone")) ||
          el?.classList.contains("zone-area") === true ||
          el?.classList.contains("zone") === true;
        if (!hitsZone) continue;
        return {
          cx,
          cy,
          id: z.getAttribute("data-zone-id"),
          hitClass: el?.getAttribute("class") ?? null,
        };
      }
      return null;
    },
    { minSize, margin },
  );
}

describe("P0-1 zone 可點（實瀏覽器）", () => {
  it("B6 CSS 有注入到（<style id=\"map-v2-css\">）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);

      const info = await page.evaluate(() => {
        const style = document.getElementById("map-v2-css");
        return {
          exists: Boolean(style),
          text: style?.textContent ?? "",
          // 喺 head 入面排第幾？
          order: style
            ? Array.from(document.head.children).indexOf(style)
            : -1,
          total: document.head.children.length,
        };
      });
      expect(info.exists, "SvgMap 應該注入 map-v2-css").toBe(true);
      expect(info.text).toContain("#svg-map .zone-area");
      /*
       * ⚠️ 次序係關鍵：注入嘅 <style> 一定要幾乎喺最後，否則
       * `main.css:458` 會喺同等特異度下反勝（雖然 (1,1,0) 已經贏，
       * 但次序係「雙重保險」）。
       */
      expect(info.order, "注入嘅 style 應該喺 head 最後").toBeGreaterThanOrEqual(
        info.total - 2,
      );
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("⭐ zone 中心 click → store.selectedZoneId 非空（P0-1 核心斷言）", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      await page.waitForTimeout(800);

      // 去到第 198 章（zone 最齊）再放大，令 zone 有足夠屏幕面積可點
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await page.waitForTimeout(1500);
      for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(900);

      // ---- ① `elementFromPoint(zone 中心)` 真係命中 .zone ----
      const hit = await pickClickableZone(page, { minSize: 12, margin: 4 });

      expect(
        hit,
        "應該至少有一個**真正可點**嘅 zone（中心點 elementFromPoint 命中 .zone 或其後代）",
      ).not.toBeNull();
      expect(
        hit!.hitClass,
        `zone 中心 elementFromPoint 應該命中 .zone，實際命中：${hit!.hitClass}`,
      ).toBeTruthy();

      // ---- ② 真 click → store.selectedZoneId 非空 ----
      await page.mouse.click(hit!.cx, hit!.cy);
      await page.waitForTimeout(400);

      const selected = await page.evaluate(() => {
        // 選中之後 .zone 會有 .is-selected（SvgMap.render() 產生）
        const sel = document.querySelector("#zones-layer .zone.is-selected");
        return {
          hasSelectedClass: Boolean(sel),
          selectedId: sel?.getAttribute("data-zone-id") ?? null,
        };
      });
      expect(
        selected.hasSelectedClass,
        "click 之後應該有一個 .zone.is-selected（證明 store 收到）",
      ).toBe(true);
      expect(selected.selectedId, "selectedZoneId 唔可以係空").toBeTruthy();
    } finally {
      await browser.close();
    }
  }, 180_000);

  it("迴歸：輕觸要選中、拖曳要平移（tap 唔可以被 re-render 吞咗）", async () => {
    /*
     * 呢個測試鎖住一個**實測踩過**嘅 bug（2026-09-22）。
     *
     * 症狀：zone 中心 `elementFromPoint()` 命中 `.zone-area`、CSS
     * `pointer-events` 亦係 `auto`，但真滑鼠 click **完全冇反應** ——
     * 連 `click` 事件都冇派發過。
     *
     * 根因：`MapViewport.onMouseUp()` 無條件 `settle()` → `SvgMap.render()`
     * → `#zones-layer.replaceChildren()`。`mouseup` 係喺 `click` 合成**之前**
     * 派發嘅，所以 mousedown 嗰個 `.zone-area` 喺 mouseup 期間被換走；
     * 依 DOM 規範，mousedown／mouseup 嘅 target 唔再同一條 ancestor 鏈時，
     * 瀏覽器就**唔會**合成 `click`。
     *
     * 修法：`onMouseUp()`／`onTouchEnd()` 加守衛 —— 冇真正拖曳過就唔
     * `settle()`（亦慳返一次無謂嘅全圖重建）。
     *
     * 本測試同時驗兩邊，確保修 tap 冇搞壞 drag：
     *   ① 輕觸（冇移動）→ 選中 zone；
     *   ② 拖曳（有移動）→ 平移生效（viewBox 有變）。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      await page.waitForTimeout(800);
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await page.waitForTimeout(1500);
      for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(900);

      const pick = (): Promise<ZonePick | null> =>
        pickClickableZone(page, { minSize: 16, margin: 8 });

      // ---- ① 輕觸 ----
      const t1 = await pick();
      expect(t1, "要有夠大嘅 zone 可以點").not.toBeNull();
      await page.mouse.click(t1!.cx, t1!.cy);
      await page.waitForTimeout(600);
      const tapped = await page.evaluate(() => ({
        sel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
        url: location.href,
      }));
      expect(tapped.sel, "輕觸之後應該有一個 zone 被選中（click 有派發）").toBe(1);
      expect(tapped.url, "URL 應該帶 ?zone=").toContain("zone=");

      // ---- ② 拖曳（要 reset 返先，因為選中會改 context） ----
      await page.keyboard.press("0");
      await page.waitForTimeout(1000);
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await page.waitForTimeout(1200);
      for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(900);

      const t2 = await pick();
      expect(t2, "拖曳測試都要有 zone 座標").not.toBeNull();
      const xBefore = await page.evaluate(() =>
        (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[0],
      );
      await page.mouse.move(t2!.cx, t2!.cy);
      await page.mouse.down();
      await page.mouse.move(t2!.cx + 90, t2!.cy + 50, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(700);
      const xAfter = await page.evaluate(() =>
        (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[0],
      );
      expect(xAfter, "拖曳之後 viewBox x 應該有變（平移仍然生效）").not.toBe(xBefore);
    } finally {
      await browser.close();
    }
  }, 240_000);

  it("zone 嘅填充色仍然係 inline `fill` attribute（視覺契約冇被改壞）", async () => {
    /*
     * `tests/visual-smoke.e2e.test.ts:606` 讀 `z.getAttribute("fill")`
     * 去斷言「安全區同危險區用唔同顏色」。如果 B6 將填充色改為
     * CSS `fill: var(--zone-*)`，嗰個 attribute 就會變 null → 嗰個測試
     * 變紅。呢個斷言係 B6 嗰邊嘅迴歸保護。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await page.waitForTimeout(1500);

      const fills = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".zone-area")).map((a) =>
          a.getAttribute("fill"),
        ),
      );
      expect(fills.length).toBeGreaterThan(0);
      expect(fills.every((f) => f !== null), "每個 .zone-area 都要有 fill attribute").toBe(
        true,
      );
      expect(new Set(fills).size, "要有 >1 種顏色（安全 vs 危險）").toBeGreaterThan(1);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("macro LOD：cluster badge 出現，而且 `.zone-area` 總數唔變（規則 L1）", async () => {
    /*
     * P0-2 嘅驗收：cluster 正規化**只可以改視覺**。
     * `tests/map-render.test.ts` 斷言 `.zone-area` 總數 = 資料集 features 數，
     * 所以 cluster 層一定要保留全部多邊形。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      // 初始 = 全港視圖（viewW 0.70 > 0.175）→ cluster 層
      const macro = await page.evaluate(() => {
        const vb = (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number);
        const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
        return {
          viewW: vb[2],
          lods: Array.from(
            new Set(zones.map((z) => z.getAttribute("data-zone-lod"))),
          ),
          areas: document.querySelectorAll(".zone-area").length,
          clusters: document.querySelectorAll("#zones-layer .zone-cluster").length,
          clusterCountAttr: document
            .querySelector("#zones-layer")
            ?.getAttribute("data-zone-cluster-count"),
          labels: document.querySelectorAll(".zone-label").length,
        };
      });

      expect(macro.viewW, "初始視圖應該係全港").toBeGreaterThan(0.175);
      expect(macro.lods, "macro LOD 應該係 cluster").toEqual(["cluster"]);
      expect(macro.areas, "規則 L1：cluster 層仍然畫晒全部 zone-area").toBeGreaterThan(
        0,
      );
      /*
       * ⚠️ 呢個就係 P0-2 嘅證據：48 個 zone 疊埋 → cluster badge 數量
       * **遠少於** zone 數。如果 clusterZones() 冇生效，呢個會相等。
       */
      expect(
        macro.clusters,
        `cluster badge 應該少過 zone 數（zone=${macro.areas}、cluster=${macro.clusters}）`,
      ).toBeLessThan(macro.areas);
      expect(macro.clusters, "全港視圖應該至少有一個 cluster").toBeGreaterThan(0);
      expect(Number(macro.clusterCountAttr)).toBe(macro.clusters);
      // cluster 層唔應該有 zone label（48 個名字 = 文字牆）
      expect(macro.labels, "cluster 層唔應該顯示 zone label").toBe(0);

      // ---- 放大之後 cluster 消失、進入更細嘅層 ----
      for (let i = 0; i < 6; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(1200);
      const zoomed = await page.evaluate(() => ({
        lods: Array.from(
          new Set(
            Array.from(document.querySelectorAll("#zones-layer .zone")).map((z) =>
              z.getAttribute("data-zone-lod"),
            ),
          ),
        ),
        clusters: document.querySelectorAll("#zones-layer .zone-cluster").length,
        areas: document.querySelectorAll(".zone-area").length,
      }));
      expect(zoomed.lods).not.toContain("cluster");
      expect(zoomed.clusters, "非 cluster 層唔應該有 cluster badge").toBe(0);
      expect(zoomed.areas, "規則 L1：無論邊層，zone-area 總數不變").toBe(macro.areas);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("圖例三通道（color + pattern + icon）真係 render 到", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);

      const legend = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll(".map-legend .legend-item"));
        return {
          total: items.length,
          withArea: items.filter((i) => i.querySelector(".area")).length,
          withPattern: items.filter((i) => i.querySelector(".legend-pattern")).length,
          withGlyph: items.filter((i) => i.querySelector(".legend-glyph")).length,
          // pattern 樣本真係引用 <pattern>（唔係空白 rect）
          patternHrefs: Array.from(
            document.querySelectorAll(".legend-pattern rect"),
          ).map((r) => r.getAttribute("fill")),
          glyphHrefs: Array.from(document.querySelectorAll(".legend-glyph use")).map(
            (u) => u.getAttribute("href"),
          ),
          // symbol 定義存在
          symbols: Array.from(document.querySelectorAll("symbol[id^='zone-glyph-']")).map(
            (s) => s.id,
          ),
        };
      });

      expect(legend.withArea, "zone 圖例項要有 color 通道").toBeGreaterThanOrEqual(4);
      expect(legend.withPattern, "zone 圖例項要有 pattern 通道").toBeGreaterThanOrEqual(4);
      expect(legend.withGlyph, "zone 圖例項要有 icon 通道").toBeGreaterThanOrEqual(4);
      for (const h of legend.patternHrefs) {
        expect(h, "pattern 樣本要引用 url(#legend-pat-*)").toMatch(
          /^url\(#legend-pat-/,
        );
      }
      for (const h of legend.glyphHrefs) {
        expect(h, "icon 樣本要引用 #zone-glyph-*").toMatch(/^#zone-glyph-/);
      }
      expect(legend.symbols.length, "要有 3 個 zone glyph symbol").toBe(3);
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("7 個 layer toggle：點擊反轉 aria-pressed 而且真係隱藏對應圖層", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);

      const btns = await page.$$("#layer-controls .layer-toggle");
      expect(btns.length, "應該有 7 個 layer toggle").toBe(7);

      const keys = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#layer-controls [data-layer]")).map((b) =>
          b.getAttribute("data-layer"),
        ),
      );
      expect(keys).toEqual([
        "zones",
        "nests",
        "outposts",
        "events",
        "routes",
        "periods",
        "detail",
      ]);

      // 初始：zones 開（DEFAULT_LAYERS）
      expect(
        await page.getAttribute('[data-layer="zones"]', "aria-pressed"),
      ).toBe("true");

      // 點一下 → 關
      await page.click('[data-layer="zones"]');
      await page.waitForTimeout(500);
      const off = await page.evaluate(() => {
        const hiddenCount = document.querySelectorAll(
          "#zones-layer .zone-survivor[hidden]",
        ).length;
        const totalSurvivor = document.querySelectorAll(
          "#zones-layer .zone-survivor",
        ).length;
        return {
          pressed: document
            .querySelector('[data-layer="zones"]')!
            .getAttribute("aria-pressed"),
          hiddenCount,
          totalSurvivor,
        };
      });
      expect(off.pressed, "click 之後 aria-pressed 應該反轉").toBe("false");
      expect(off.totalSurvivor, "要有倖存區可以隱藏").toBeGreaterThan(0);
      expect(off.hiddenCount, "全部倖存區都應該 hidden").toBe(off.totalSurvivor);

      // 再點一下 → 開返
      await page.click('[data-layer="zones"]');
      await page.waitForTimeout(500);
      expect(
        await page.getAttribute('[data-layer="zones"]', "aria-pressed"),
      ).toBe("true");
      const back = await page.evaluate(
        () => document.querySelectorAll("#zones-layer .zone-survivor[hidden]").length,
      );
      expect(back, "開返之後唔應該再有 hidden").toBe(0);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("MapControls：44px 命中區 + 4 個掣 id 冇變 + 鍵盤導航", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      await page.waitForTimeout(800);

      // ---- 尺寸 ----
      const sizes = await page.evaluate(() =>
        ["map-zoom-in", "map-zoom-out", "map-reset", "map-show-all-events"].map((id) => {
          const el = document.getElementById(id);
          const r = el?.getBoundingClientRect();
          return { id, w: r?.width ?? 0, h: r?.height ?? 0 };
        }),
      );
      for (const s of sizes) {
        expect(s.w, `${s.id} 寬度要 ≥44`).toBeGreaterThanOrEqual(44);
        expect(s.h, `${s.id} 高度要 ≥44`).toBeGreaterThanOrEqual(44);
      }

      // ---- 鍵盤：焦點 #svg-map → `+` 縮放 ----
      const before = await page.evaluate(() =>
        (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[2],
      );
      await page.focus("#svg-map");
      await page.keyboard.press("+");
      await page.waitForTimeout(400);
      const afterZoom = await page.evaluate(() =>
        (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[2],
      );
      expect(afterZoom, "`+` 應該縮窄 viewBox").toBeLessThan(before);

      // ---- 鍵盤：ArrowRight 平移 ----
      const xBefore = await page.evaluate(() =>
        (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[0],
      );
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(400);
      const xAfter = await page.evaluate(() =>
        (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[0],
      );
      expect(xAfter, "ArrowRight 應該令 x 增大（視圖向東移）").toBeGreaterThan(xBefore);

      // ---- 鍵盤：0 重置 ----
      await page.keyboard.press("0");
      await page.waitForTimeout(900);
      const reset = await page.evaluate(() =>
        (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[2],
      );
      expect(reset, "`0` 應該回到全港視圖（viewW = 0.70）").toBeCloseTo(0.7, 2);
    } finally {
      await browser.close();
    }
  }, 150_000);

  it("pulse 錯相：每個 .zone-pulse 有唔同 --pulse-index", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      // 深 zoom 令病窩進入 full 層（先有 pulse）
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await page.waitForTimeout(1500);
      for (let i = 0; i < 10; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(1200);

      const idx = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#zones-layer .zone-pulse")).map((p) =>
          (p as SVGElement).style.getPropertyValue("--pulse-index"),
        ),
      );
      expect(idx.length, "full 層應該有病窩 pulse").toBeGreaterThan(0);
      // 每個都應該有值，而且全部唔同（錯相）
      expect(idx.every((v) => v !== ""), "每個 pulse 都要有 --pulse-index").toBe(true);
      expect(new Set(idx).size, "index 應該互異（錯開相位）").toBe(idx.length);
    } finally {
      await browser.close();
    }
  }, 150_000);

  it("⭐ cluster badge 渲染直徑 ∈ [8,12] px（三個 viewW，實瀏覽器量度）", async () => {
    /*
     * spec `docs/specs/world-atlas-v2-rendering-lod-strategy.md` §3.2
     * L-Z0 硬性要求：「直徑 8–12 px 嘅 badge」。
     *
     * 為何一定要喺**真瀏覽器**量
     * ------------------------
     * node 單測（`map-lod-zone.test.ts`）驗嘅係 `clusterBadgeRadiusUser()`
     * 嘅數學。但佢證明唔到：
     *   ① `SvgMap` 有冇真係用嗰個函數（而唔係淨低嘅舊 path）；
     *   ② `preserveAspectRatio="meet"` 之下實際 px/user 比例係咩；
     *   ③ DPR / CSS transform 有冇再放大。
     * 所以呢度直接量 `getBoundingClientRect()` 嘅寬度 —— 即最終渲染值。
     *
     * 修正前（B6-D5）：實測 29.7–41.2 px，超 spec 3.5–5 倍。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      /*
       * 三個 viewW 都 > 0.175（L-Z0 層）：
       *   0.70 = 初始全港視圖（唔使 zoom）
       *   0.40 / 0.20 = 用 zoom-in 掣逐步縮到（每次 1.3 倍）
       * 由大至細量，避免重建 page。
       */
      const measured: Array<{
        targetViewW: number;
        actualViewW: number;
        lod: string;
        count: number;
        diameters: number[];
      }> = [];

      const readBadges = () =>
        page.evaluate(() => {
          const vb = (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
            .split(/\s+/)
            .map(Number);
          const lods = Array.from(
            new Set(
              Array.from(document.querySelectorAll("#zones-layer .zone")).map((z) =>
                z.getAttribute("data-zone-lod"),
              ),
            ),
          );
          const diameters = Array.from(
            document.querySelectorAll("#zones-layer .zone-cluster-ring"),
          ).map((c) => (c as SVGCircleElement).getBoundingClientRect().width);
          return { viewW: vb[2], lods, diameters };
        });

      /*
       * 三個目標 viewW 全部要 > Z_BANDS.macro (0.175) —— 即 L-Z0 層。
       * ⚠️ 唔可以「按固定次數 zoom-in」：每次 1.3 倍，3 次之後會由
       * 0.70 跌到 0.319，再 3 次就跌到 0.145 → 過咗 boundary 門檻，
       * badge 就冇咗。所以要**逐步 zoom 直到落入目標區間**（用實際
       * viewBox 讀數判斷，唔靠猜）。
       */
      const zoomUntilBelow = async (target: number) => {
        for (let i = 0; i < 12; i++) {
          const w = await page.evaluate(() =>
            Number(
              (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
                .split(/\s+/)[2],
            ),
          );
          if (w <= target) return w;
          await page.click("#map-zoom-in");
          await page.waitForTimeout(400);
        }
        return page.evaluate(() =>
          Number(
            (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "").split(/\s+/)[2],
          ),
        );
      };

      // --- 0.70（初始全港）---
      let m = await readBadges();
      measured.push({
        targetViewW: 0.7,
        actualViewW: m.viewW,
        lod: m.lods.join(","),
        count: m.diameters.length,
        diameters: m.diameters,
      });

      // --- 縮到 ~0.40（仍然 > 0.175 → 依然係 cluster 層）---
      await zoomUntilBelow(0.4);
      await page.waitForTimeout(700);
      m = await readBadges();
      measured.push({
        targetViewW: 0.4,
        actualViewW: m.viewW,
        lod: m.lods.join(","),
        count: m.diameters.length,
        diameters: m.diameters,
      });

      // --- 縮到 ~0.20（仍然 > 0.175 → 依然係 cluster 層）---
      await zoomUntilBelow(0.2);
      await page.waitForTimeout(700);
      m = await readBadges();
      measured.push({
        targetViewW: 0.2,
        actualViewW: m.viewW,
        lod: m.lods.join(","),
        count: m.diameters.length,
        diameters: m.diameters,
      });

      // 印出實測值，方便報告引用（唔參與斷言）
      console.log(
        "[B6] cluster badge 實測直徑：",
        JSON.stringify(
          measured.map((x) => ({
            viewW: Number(x.actualViewW.toFixed(3)),
            lod: x.lod,
            badges: x.count,
            minPx: Number(Math.min(...x.diameters).toFixed(2)),
            maxPx: Number(Math.max(...x.diameters).toFixed(2)),
          })),
        ),
      );

      for (const x of measured) {
        expect(x.lod, `viewW≈${x.targetViewW} 應該係 cluster 層`).toBe("cluster");
        expect(x.count, `viewW≈${x.targetViewW} 應該有 cluster badge`).toBeGreaterThan(0);
        for (const d of x.diameters) {
          expect(
            d,
            `viewW≈${x.actualViewW.toFixed(3)} 嘅 badge 直徑 ${d.toFixed(2)} px 要 ≥8`,
          ).toBeGreaterThanOrEqual(8);
          expect(
            d,
            `viewW≈${x.actualViewW.toFixed(3)} 嘅 badge 直徑 ${d.toFixed(2)} px 要 ≤12`,
          ).toBeLessThanOrEqual(12);
        }
      }
    } finally {
      await browser.close();
    }
  }, 150_000);

  it("cluster badge 之間唔重疊（bounding rect 兩兩唔相交）", async () => {
    /*
     * badge 嘅**存在目的**係解決「48 個 glyph 疊成一團」。
     * 如果 badge 自己都疊，就等於冇解決原問題 —— 所以唔重疊係
     * 修 1 嘅必要配套斷言。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      const res = await page.evaluate(() => {
        const rects = Array.from(
          document.querySelectorAll("#zones-layer .zone-cluster-ring"),
        ).map((c) => (c as SVGCircleElement).getBoundingClientRect());
        const overlaps: Array<[number, number]> = [];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i];
            const b = rects[j];
            const separated =
              a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
            if (!separated) overlaps.push([i, j]);
          }
        }
        return { total: rects.length, overlaps };
      });

      console.log(
        "[B6] cluster badge 重疊檢查：",
        JSON.stringify({ badges: res.total, overlaps: res.overlaps.length }),
      );
      expect(res.total, "全港視圖應該有多過一個 badge").toBeGreaterThan(1);
      expect(
        res.overlaps.length,
        `badge bounding rect 唔應該相交，實際重疊對數 = ${res.overlaps.length}：${JSON.stringify(res.overlaps)}`,
      ).toBe(0);
    } finally {
      await browser.close();
    }
  }, 150_000);

  it("⭐ 微拖門檻：位移 2 px → 觸發選中；位移 50 px → 當平移、唔選中", async () => {
    /*
     * 迴歸測試（B6-D6）。原本 `onMouseMove()` 一收到 mousemove 就
     * `movedDuringPan = true`，1 px 抖動就當拖曳 → zone 點唔到。
     * 加咗 `PAN_THRESHOLD_PX = 4` 之後：
     *   2 px  < 4 → 當輕觸 → click 要正常派發 → 選中
     *   50 px ≥ 4 → 當平移 → 唔應該選中，但 view 要真係移咗
     *
     * ⚠️ 兩個情境要用**唔同 page**，因為情境 ① 會改咗 URL/context。
     */
    const browser = await launch();
    if (!browser) return;

    const pickZone = (page: Page): Promise<ZonePick | null> =>
      pickClickableZone(page, { minSize: 20, margin: 12 });

    const prep = async (page: Page) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      await page.waitForTimeout(700);
      for (let i = 0; i < 197; i++) await page.keyboard.press("k");
      await page.waitForTimeout(1500);
      for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
      await page.waitForTimeout(900);
    };

    try {
      // ---------- ① 2 px 微拖 → 仍然當輕觸 → 要選中 ----------
      const p1 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await prep(p1);
      const z1 = await pickZone(p1);
      expect(z1, "要有夠大嘅 zone 可以點").not.toBeNull();
      await p1.mouse.move(z1!.cx, z1!.cy);
      await p1.mouse.down();
      // 只移 2 px（< 4 px 門檻）
      await p1.mouse.move(z1!.cx + 2, z1!.cy, { steps: 1 });
      await p1.mouse.up();
      /*
       * ⚠️ 用 `expect.poll` 而唔係「等 700ms 然後量一次」。
       *
       * 實測：全套測試（35 檔、9 分鐘、CPU 高負載）之下，Chromium 嘅 `click`
       * 合成會被延遲 → 呢個斷言間歇性 fail（但單獨跑 13/13 pass）。
       * Poll 令測試等 state **真正**變化，唔會因為機器慢而假失敗。
       *
       * ⚠️ 呢個唔係「放寬門檻」—— 斷言仍然係 `toBe(1)`（2px 微拖必須選中一個 zone），
       * 只係唔再假設「700ms 內一定完成」。
       */
      await expect
        .poll(
          () =>
            p1.evaluate(
              () => document.querySelectorAll("#zones-layer .zone.is-selected").length,
            ),
          {
            timeout: 5_000,
            message: "2 px 位移（< 門檻 4）應該當輕觸，要選中一個 zone",
          },
        )
        .toBe(1);
      const r1 = await p1.evaluate(() => ({ url: location.href }));
      console.log("[B6] 2px 微拖 →", JSON.stringify(r1));
      expect(r1.url).toContain("zone=");
      await p1.close();

      // ---------- ② 50 px 拖曳 → 當平移 → 唔應該選中 ----------
      const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await prep(p2);
      const z2 = await pickZone(p2);
      expect(z2, "拖曳測試都要有 zone 座標").not.toBeNull();
      const xBefore = await p2.evaluate(() =>
        (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[0],
      );
      await p2.mouse.move(z2!.cx, z2!.cy);
      await p2.mouse.down();
      await p2.mouse.move(z2!.cx + 50, z2!.cy, { steps: 8 });
      await p2.mouse.up();
      await p2.waitForTimeout(700);
      const r2 = await p2.evaluate(() => ({
        sel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
        url: location.href,
        x: (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number)[0],
      }));
      console.log(
        "[B6] 50px 拖曳 →",
        JSON.stringify({ sel: r2.sel, panned: r2.x !== xBefore, dx: r2.x - xBefore }),
      );
      expect(r2.sel, "50 px 拖曳應該當平移，唔應該選中任何 zone").toBe(0);
      expect(r2.url).not.toContain("zone=");
      expect(r2.x, "拖曳之後 viewBox x 要有變（真平移）").not.toBe(xBefore);
      await p2.close();
    } finally {
      await browser.close();
    }
  }, 240_000);

  it("⭐ P0-1 行為證據：computed `pointer-events === auto`（真瀏覽器 cascade 結果）", async () => {
    /*
     * `tests/map-css-contract.test.ts` 係**靜態讀檔**（`readFileSync`）——
     * 佢只證明 `map.css` 原始碼有嗰條規則、特異度計出 (1,1,0)。
     * 但證明唔到瀏覽器**實際應用**咗邊條。
     *
     * 呢個測試量 `getComputedStyle()` —— 即 cascade 真正結算之後嘅值。
     * 係 P0-1 嘅行為層證據（同 `map-css-contract.test.ts` 互補，
     * 衝突時以本檔為準）。
     *
     * ⚠️ `.zone-glow` 只喺 **non-cluster 層**（`boundary` / `full`）先會畫
     * （`SvgMap.ts` 嘅 zone render 段有 `if (!zoneIsCluster)` 守衛）。
     * 初始全港視圖係 cluster 層，嗰陣 `.zone-glow` 根本冇元素 ——
     * 所以量 glow 之前一定要先 zoom 入去，否則會攞到 `(冇元素)`。
     * 呢個唔係測試放寬：冇元素本身就證明「冇裝飾層搶 hit」，
     * 但有元素嗰陣嘅 computed 值先係真正需要驗嘅證據。
     */
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await waitReady(page);
      await page.waitForTimeout(800);

      /*
       * 由 cluster 層（全港）逐步 zoom 入到 boundary 層（viewW ≤ 0.175）。
       * 用實際 viewBox 讀數判斷，唔靠猜次數。
       */
      for (let i = 0; i < 12; i++) {
        const w = await page.evaluate(() =>
          Number(
            (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "").split(/\s+/)[2],
          ),
        );
        if (w <= 0.175) break;
        await page.click("#map-zoom-in");
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(800);

      const cs = await page.evaluate(() => {
        const q = (sel: string) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el).pointerEvents : "(冇元素)";
        };
        return {
          viewW: Number(
            (document.querySelector("#svg-map")!.getAttribute("viewBox") ?? "").split(/\s+/)[2],
          ),
          lods: Array.from(
            new Set(
              Array.from(document.querySelectorAll("#zones-layer .zone")).map((z) =>
                getComputedStyle(z).pointerEvents,
              ),
            ),
          ),
          zoneLods: Array.from(
            new Set(
              Array.from(document.querySelectorAll("#zones-layer .zone")).map(
                (z) => z.getAttribute("data-zone-lod") ?? "",
              ),
            ),
          ),
          area: q("#zones-layer .zone .zone-area"),
          glow: q("#zones-layer .zone .zone-glow"),
          label: q("#zones-layer .zone .zone-label"),
          badge: q("#zones-layer .zone .zone-badge"),
          route: q("#routes-layer .route-line"),
          marker: q(".location-marker, .location-marker-cluster"),
          event: q("#events-layer .event-marker"),
        };
      });
      console.log("[B6] computed pointer-events →", JSON.stringify(cs));

      /*
       * 前提：要真係入咗 non-cluster 層，`.zone-glow` 先會有元素。
       * 如果冇入到，glow 斷言就係空驗 —— 所以先斷言 layer。
       */
      expect(
        cs.zoneLods.some((l) => l !== "cluster"),
        `應該要 zoom 入 non-cluster 層，實際 lods = ${JSON.stringify(cs.zoneLods)} (viewW=${cs.viewW})`,
      ).toBe(true);

      // 核心：zone-area 一定要 auto（(1,1,0) 贏咗 (0,1,0)）
      expect(cs.area, "`.zone-area` computed pointer-events 一定要係 auto").toBe("auto");
      // 裝飾元素唔可以搶命中
      expect(cs.glow, ".zone-glow 喺 non-cluster 層一定要有元素，而且唔應該搶 hit").toBe("none");
      expect(cs.label, ".zone-label 唔應該搶 hit").toBe("none");
      expect(cs.badge, ".zone-badge 唔應該搶 hit").toBe("none");
      // 其他層嘅可點元素
      if (cs.route !== "(冇元素)") expect(cs.route, "route 用 stroke 命中").toBe("stroke");
      if (cs.marker !== "(冇元素)") expect(cs.marker).toBe("auto");
      if (cs.event !== "(冇元素)") expect(cs.event).toBe("auto");
    } finally {
      await browser.close();
    }
  }, 120_000);
});

// C8 P1-2 / P1-3：揀 zone 要 fly-to；手機 tap zone 要自動開面板
//
// 背景（C8 敵意產品審查 2026-09-25）
// =================================
// P1-2：揀 zone 之後地圖**完全唔動**。而 48 個 zone 喺世界視圖擠成一坨
//       （實測 559/1128 對視覺重疊，抽樣 zone 同 **35 個**其他 zone 嘅 rect
//       重疊）→ 用戶睇唔出「我揀咗邊個」。
// P1-3：手機 tap zone 之後 dossier 面板**唔會自動開**。實測 dossier 內容
//       top = 1187px 而 viewport 高只有 844px → 用戶見到「冇反應」。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MAP_TS = readFileSync("src/components/SvgMap.ts", "utf-8");
const APP_TS = readFileSync("src/app.ts", "utf-8");

describe("C8 P1-2：zone fly-to", () => {
  it("⭐ `SvgMap` 有 `flyToZone()`", () => {
    expect(MAP_TS).toMatch(/flyToZone\(zoneId: string\): void \{/);
  });

  it("⭐ 一定要用共用嘅 `viewBoxForGeoBounds`（唔可以自己寫投影）", () => {
    const i = MAP_TS.indexOf("flyToZone(zoneId: string)");
    expect(i).toBeGreaterThan(-1);
    const body = MAP_TS.slice(i, i + 3000);
    expect(body, "要共用 helper，否則會再踩 1/cos(φ₀) 漂移").toContain("viewBoxForGeoBounds");
    expect(body).toContain("animateViewBox");
    // ⚠️ 唔可以自己計投影
    expect(body).not.toContain("M_PER_DEG_LAT");
  });

  it("⭐ 兩種 polygon 都要處理", () => {
    const i = MAP_TS.indexOf("flyToZone(zoneId: string)");
    const body = MAP_TS.slice(i, i + 3000);
    expect(body).toContain('"Polygon"');
    expect(body).toContain('"MultiPolygon"');
  });

  it("⭐ `app.ts` 喺 zone 改變時呼叫（而且唔可以喺首次載入飛）", () => {
    expect(APP_TS).toContain("this.svgMap.flyToZone(");
    // 要有 `!first` 守衛
    expect(APP_TS).toMatch(/zoneChanged\s*=\s*!first/);
    // 同章節飛行要互斥（兩個動畫唔可以打架）
    expect(APP_TS).toMatch(/\}\s*else if \(zoneChanged && newZone\)/);
  });
});

describe("C8 P1-3 / P1-6：內容喺 pane 內就自動開面板", () => {
  it("⭐ 準則係「內容只喺 pane 內」，唔再按螢幕闊度", () => {
    /*
     * ⚠️ 2026-10-05 P1-6 改動：story pane 由「側欄」變「**預設收起嘅浮層**」
     * （`src/styles/layout.css`）。原本 P1-3 嘅自動開 pane 只喺
     * `max-width: 1023px` 生效（因為桌面版 pane 係側欄、改 snap 會改高度）。
     *
     * 浮層化之後：**所有闊度行為一致** → 判斷準則改為
     * 「內容係唔係只喺 pane 內」：
     *   ① context 係 zone（dossier 喺 pane 內）
     *   ② context 係 location（story panel 喺 pane 內，含 `?location=` 深連結）
     *   ③ view 係 chronicle（整個 view 喺 pane 內）
     * ⚠️ 唔包純 chapter context —— 首屏要保持「地圖主導」。
     */
    const i = APP_TS.indexOf("this.svgMap.flyToZone(");
    expect(i).toBeGreaterThan(-1);
    // 由 `flyToZone` 到自動開 pane 區塊之後嘅 `svgMap.render()` —— 取一段緊嘅窗
    const j = APP_TS.indexOf(
      "if (chapterChanged || contextChanged) this.svgMap.render();",
      i,
    );
    expect(j, "搵唔到自動開 pane 區塊嘅結尾").toBeGreaterThan(i);
    const body = APP_TS.slice(i, j);

    expect(body, "要自動開 pane").toContain("setSheetSnap(EXPANDED_SNAP)");
    expect(body, "只喺收埋狀態下自動開（唔應該搶走用戶已展開嘅狀態）").toContain(
      "sheetSnap === COLLAPSED_SNAP",
    );
    expect(body, "① zone context 要自動開").toContain('ctxKind === "zone"');
    expect(body, "② location context 要自動開（含深連結）").toContain(
      'ctxKind === "location"',
    );
    expect(body, "③ 編年史要自動開").toContain('s.view === "chronicle"');
    expect(body, "⚠️ 唔應該再按螢幕闊度判斷（浮層喺所有闊度行為一致）").not.toContain(
      'matchMedia?.("(max-width: 1023px)")',
    );
  });

  it("`mobile.css` 嘅 sheet 斷點同程式判斷一致（1023px）", () => {
    const css = readFileSync("src/styles/mobile.css", "utf-8");
    expect(css).toContain("max-width: 1023px");
  });
});

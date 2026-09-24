// B6 — V2 CSS 契約（`pointer-events` / 特異度 / token 衛生）
//
// 為何要有呢個檔
// ==============
// P0-1 嘅根因係 `src/styles/main.css:458` 嘅 `.zone-area { pointer-events:
// none; }`。B6 **唔可以改** 嗰個檔（唔喺 allowlist），所以只可以喺
// `src/styles/map.css` 用**更高特異度**覆蓋。
//
// 「更高特異度」係一個**可以被程式驗證**嘅性質 —— 唔應該靠人手目測
// 或者 Playwright 撞彩。呢個檔讀兩個 CSS 檔嘅原始碼，計特異度再比較，
// 所以：
//   · 將來有人加 `.zones-layer .zone-area { pointer-events: none }`（(0,2,0)）
//     → 呢個測試仍然綠（(1,1,0) 贏）；
//   · 有人「簡化」成 `.zone-area { pointer-events: auto }` → **變紅**。
//
// 全部斷言都係程式化、可重跑；冇人手抽樣。
//
// ⚠️⚠️ 重要：呢個檔係「靜態原始碼契約」，唔係「瀏覽器行為證據」
// ============================================================
// 本檔全部斷言都係 `readFileSync()` 讀 CSS 字串再自己正則解析。
// 佢證明嘅係：
//   「map.css 原始碼內有一條 `#svg-map .zone-area { pointer-events: auto }`，
//    而佢計出嘅特異度 (1,1,0) > 舊規則 (0,1,0)」
//
// 佢**證明唔到**（以下 4 項）：
//   ① 嗰條 CSS 真係載入到 production（Vite 有冇 tree-shake 走？注入機制
//      喺 build 之後仲有冇效？）；
//   ② cascade 真正結算結果（有冇更高特異度規則、`@layer`、inline style 蓋過）；
//   ③ `document.elementFromPoint()` 真命中 `.zone-area`；
//   ④ click 真派發得到。
//
// 呢 4 項由 `tests/map-interaction.e2e.test.ts`（真 Chromium，
// 量 `getComputedStyle()` / `getBoundingClientRect()` / 真 click）覆蓋。
//
// 👉 **兩者衝突時，一律以 e2e 為準。**
//    唔可以單憑本檔 19 個綠燈就宣稱「P0-1 已修」——
//    2026-09-22 實測就係咁樣踩過：本檔全綠，但真 click 完全冇反應
//    （根因喺 `MapViewport.onMouseUp()`，見 B6-D7 / B6-D5）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MAP_CSS = readFileSync("src/styles/map.css", "utf-8");
/*
 * ⚠️ 2026-09-24（D 舊 CSS 遷移）：`src/styles/main.css` / `hud.css` /
 * `timeline.css` 已經刪除 —— 佢哋嘅**原文**整段搬入 `legacy-migrated.css`
 * （由 `scripts/migrate_legacy_css.py` 自動產生，可從 git 歷史重跑）。
 *
 * 所以本檔嘅 `MAIN_CSS` 讀 `legacy-migrated.css`：
 * 內容係三個舊檔嘅超集，原本嘅斷言（特異度、覆蓋、`.zone:hover .zone-area`）
 * 全部仍然有意義。
 */
const LEGACY_CSS = readFileSync("src/styles/legacy-migrated.css", "utf-8");
const MAIN_CSS = LEGACY_CSS;
const TOKENS_CSS = readFileSync("src/styles/tokens.css", "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// CSS 解析小工具（純函數）
// ─────────────────────────────────────────────────────────────────────────────

/** 移除註解 —— 註解入面嘅 selector 唔應該被當成規則。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 計 CSS 特異度（a,b,c）。
 *
 * 規則（CSS Selectors Level 4 簡化版，足夠處理本專案嘅選擇器）：
 *   a = #id 數量
 *   b = .class + [attr] + :pseudo-class 數量（唔計 ::pseudo-element）
 *   c = 元素名 + ::pseudo-element 數量
 *
 * ⚠️ 唔支援 `:is()` / `:not()` 嘅「取最特異參數」語義 —— 本專案冇用。
 * 如果將來用咗，呢個函數要擴充（而唔係改測試期望值）。
 */
export function specificity(selector: string): [number, number, number] {
  const s = selector.trim();
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes =
    (s.match(/\.[\w-]+/g) || []).length +
    (s.match(/\[[^\]]*\]/g) || []).length +
    (s.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
  const pseudoEls = (s.match(/::[\w-]+/g) || []).length;
  // 元素名：只計真正嘅 tag（排除 . / # / : 開頭，同 > + ~ 之後嘅 tag）
  const tags = (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  void pseudoEls; // 融入 c 嘅討論見上；現階段等價於 tags（本專案冇 ::）
  return [ids, classes, tags];
}

/** 比較兩個特異度：(a,b,c) 字典序。 */
export function specCompare(
  x: [number, number, number],
  y: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/**
 * 抽出一條選擇器喺某個 CSS 檔內嘅**所有**宣告（合併多個 block）。
 *
 * ⚠️ 一定要支援**多行選擇器群組**：
 *     #svg-map .location-marker,
 *     #svg-map .location-marker-cluster {
 *       pointer-events: auto;
 *     }
 * 呢種寫法對「同一組規則」係正確嘅 CSS，但天真嘅 `selector\s*\{` regex
 * 會搵唔到（中間有 `,\n`）。做法係先將整個 CSS 嘅「選擇器列表 →
 * block」拆開，再逐個選擇器比對（正規化空白）。
 */
export function declarationsFor(css: string, selector: string): string[] {
  const clean = stripComments(css);
  const target = selector.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  // 逐個 block 掃：selector-list { body }
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const sels = m[1]
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (sels.includes(target)) out.push(m[2]);
  }
  return out;
}

/** 一條規則嘅「真正 keys」—— 一個 selector 對應嘅所有宣告合併。 */
export function mergedDecl(css: string, selector: string, prop: string): string | null {
  const values = declarationsFor(css, selector)
    .map((b) => propValue(b, prop))
    .filter((v): v is string => v !== null);
  return values.length > 0 ? values[values.length - 1] : null;
}


/** 喺一個宣告 block 入面搵屬性值（最後一個為準）。 */
export function propValue(block: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "gi");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) last = m[1].trim();
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. `.zone-area` 命中契約（D 舊 CSS 遷移之後，2026-09-24）
//
// ⚠️ 原本呢一節係「舊 CSS 障礙（紀錄）」—— 斷言 `main.css` 有
// `.zone-area { pointer-events: none }`、而 `hud.css` 冇。佢嘅註釋已經預告：
// 「如果將來 Gate 2 刪咗舊 CSS，呢個測試會變紅 —— 嗰時就應該刪埋呢個測試」。
//
// D 遷移已經發生（三個舊檔嘅原文整段搬入 `legacy-migrated.css`），所以呢一節
// 改寫成**遷移後嘅不變式**：舊層仍然有嗰條規則（唔可以靜默消失），而
// `map.css` 用 id 特異度覆蓋佢（zone 要可點）。
// ─────────────────────────────────────────────────────────────────────────────

describe("CSS 契約：`.zone-area` 命中（D 遷移後）", () => {
  it("舊層（`legacy-migrated.css`）仍然有 `.zone-area { pointer-events: none }`", () => {
    const values = declarationsFor(MAIN_CSS, ".zone-area")
      .map((b) => propValue(b, "pointer-events"))
      .filter((v): v is string => v !== null);
    expect(values, "舊層應該仍然有 pointer-events: none（唔可以靜默消失）").toContain("none");
  });

  it("`map.css` 用 `#svg-map .zone-area`（特異度 (1,1,0)）覆蓋 → zone 可點", () => {
    const values = declarationsFor(MAP_CSS, "#svg-map .zone-area")
      .map((b) => propValue(b, "pointer-events"))
      .filter((v): v is string => v !== null);
    expect(values, "map.css 要用 id 特異度蓋過舊層").toContain("auto");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. P0-1：覆蓋規則嘅特異度必須贏
// ─────────────────────────────────────────────────────────────────────────────

describe("CSS 契約：zone 可點（P0-1）", () => {
  const OVERRIDE_SEL = "#svg-map .zone-area";

  it("`map.css` 有一條 `#svg-map .zone-area { pointer-events: auto }`", () => {
    const decls = declarationsFor(MAP_CSS, OVERRIDE_SEL);
    expect(decls.length, `${OVERRIDE_SEL} 規則要存在`).toBeGreaterThan(0);
    const values = decls
      .map((b) => propValue(b, "pointer-events"))
      .filter((v): v is string => v !== null);
    // 最後一個宣告為準
    expect(values[values.length - 1]).toBe("auto");
  });

  it("特異度 (1,1,0) 嚴格大於舊規則 (0,1,0)", () => {
    const older = specificity(".zone-area");
    const newer = specificity(OVERRIDE_SEL);
    expect(specCompare(newer, older)).toBeGreaterThan(0);
    expect(newer[0]).toBeGreaterThanOrEqual(1); // 有 id
    expect(older[0]).toBe(0);
  });

  it("唔可以只寫 `.zone-area { pointer-events: auto }`（同特異度會輸）", () => {
    /*
     * 呢個係**反向**斷言：確認 `map.css` 冇一條咁樣嘅規則。
     * 如果有，會令人誤以為已經修好，但實際舊 CSS 仍然贏（視乎次序）。
     */
    const decls = declarationsFor(MAP_CSS, ".zone-area");
    const standalone = decls
      .map((b) => propValue(b, "pointer-events"))
      .filter((v): v is string => v !== null);
    expect(
      standalone,
      "唔可以有裸 .zone-area { pointer-events: ... } —— 特異度不足",
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. hit priority 嘅 pointer-events 表（spec §2.3）
// ─────────────────────────────────────────────────────────────────────────────

describe("CSS 契約：hit priority pointer-events 表", () => {
  const NONE = ["zone-glow", "zone-pulse", "zone-label", "zone-badge", "zone-cluster"];

  it("zone 圖層嘅裝飾元素全部 none（唔搶命中）", () => {
    for (const cls of NONE) {
      const v = mergedDecl(MAP_CSS, `#svg-map .${cls}`, "pointer-events");
      expect(v, `.${cls} 應該係 none`).toBe("none");
    }
  });

  it("route 用 `stroke`（唔係 `auto`）—— 唔可以食線外空白", () => {
    expect(mergedDecl(MAP_CSS, "#svg-map .route-line", "pointer-events")).toBe(
      "stroke",
    );
  });

  it("marker / event 係 auto（低於 zone，但高於背景）", () => {
    for (const cls of ["location-marker", "location-marker-cluster", "event-marker"]) {
      expect(mergedDecl(MAP_CSS, `#svg-map .${cls}`, "pointer-events"), `.${cls}`).toBe(
        "auto",
      );
    }
  });

  it("`hidden` 屬性要令元素唔參與命中（display: none）", () => {
    const clean = stripComments(MAP_CSS);
    expect(clean).toMatch(/#svg-map\s+\[hidden\]\s*\{[^}]*display:\s*none/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. P0-5：互動尺寸 / focus ring
// ─────────────────────────────────────────────────────────────────────────────

describe("CSS 契約：互動目標（C3 / A7）", () => {
  it("`#map-controls .map-ctrl` ≥ 44×44", () => {
    const decls = declarationsFor(MAP_CSS, "#map-controls .map-ctrl");
    const w = decls
      .map((b) => propValue(b, "min-width"))
      .filter((v): v is string => v !== null)
      .pop();
    const h = decls
      .map((b) => propValue(b, "min-height"))
      .filter((v): v is string => v !== null)
      .pop();
    expect(Number((w || "").replace("px", ""))).toBeGreaterThanOrEqual(44);
    expect(Number((h || "").replace("px", ""))).toBeGreaterThanOrEqual(44);
  });

  it("`#map-controls .map-ctrl` 有完整 box model（Gate 2 後唔會解體）", () => {
    /*
     * 舊 CSS 有 `.map-ctrl { border-radius / background / border }`。
     * Gate 2 刪走之後，`map.css` 必須自己提供 —— 否則掣會變成裸文字。
     */
    const decls = declarationsFor(MAP_CSS, "#map-controls .map-ctrl");
    const joined = decls.join(";");
    for (const prop of [
      "border",
      "border-radius",
      "background",
      "cursor",
      "padding",
    ]) {
      expect(joined, `map-ctrl 需要 ${prop}`).toMatch(new RegExp(prop + "\\s*:"));
    }
  });

  it("focus ring 用 outline（clip-path 剪唔走）", () => {
    const decls = declarationsFor(MAP_CSS, "#map-controls .map-ctrl:focus-visible");
    const joined = decls.join(";");
    expect(joined).toMatch(/outline\s*:/);
    expect(joined).toMatch(/var\(--focus-ring\)/);
    // ⚠️ 唔可以用 box-shadow 做 focus —— clip-path 會剪走
    expect(joined).not.toMatch(/box-shadow\s*:/);
  });

  it("`layer-toggle` 亦 ≥ 44×44 兼有 focus ring", () => {
    const decls = declarationsFor(MAP_CSS, "#layer-controls .layer-toggle");
    const joined = decls.join(";");
    expect(joined).toMatch(/min-width:\s*44px/);
    expect(joined).toMatch(/min-height:\s*44px/);
    const focus = declarationsFor(
      MAP_CSS,
      "#layer-controls .layer-toggle:focus-visible",
    ).join(";");
    expect(focus).toMatch(/outline\s*:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 規則 T1：token 衛生
// ─────────────────────────────────────────────────────────────────────────────

describe("CSS 契約：token 衛生（規則 T1）", () => {
  it("`map.css` 冇 raw hex / rgb() / hsl()", () => {
    const clean = stripComments(MAP_CSS);
    const hex = clean.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex, `唔可以有 hex 色值：${hex.join(", ")}`).toHaveLength(0);
    expect(clean.match(/\brgba?\(/g) || []).toHaveLength(0);
    expect(clean.match(/\bhsla?\(/g) || []).toHaveLength(0);
  });

  it("`map.css` 用到嘅每一個 var(--x) 都喺 tokens.css 定義", () => {
    /*
     * 為何重要：`var(--typo)` 拼錯係**靜默失敗** —— 屬性會 fallback 到
     * 初始值（例如 `background: transparent`），睇落好似「設計就係咁」。
     * 呢個斷言令拼錯即刻變紅。
     */
    const clean = stripComments(MAP_CSS);
    const used = new Set(
      (clean.match(/var\((--[\w-]+)/g) || []).map((s) =>
        s.replace("var(", ""),
      ),
    );
    const defined = new Set(
      (stripComments(TOKENS_CSS).match(/(--[\w-]+)\s*:/g) || []).map((s) =>
        s.replace(/\s*:$/, ""),
      ),
    );
    /*
     * ⚠️ 本地自訂屬性（例如 --pulse-index）唔喺 tokens.css 度係**正確**嘅
     * —— 佢係元件自己嘅狀態通道，唔係設計 token。所以只驗證
     * 「唔係本檔自己宣告嘅」嗰批。
     */
    const localProps = new Set(
      (clean.match(/(--[\w-]+)\s*:/g) || []).map((s) => s.replace(/\s*:$/, "")),
    );
    const missing = [...used].filter(
      (v) => !defined.has(v) && !localProps.has(v),
    );
    expect(missing, `map.css 用咗未定義嘅 token：${missing.join(", ")}`).toHaveLength(
      0,
    );
  });

  it("`map.css` 只准用 3 個 duration + 2 個 easing token（規則 M1）", () => {
    const clean = stripComments(MAP_CSS);
    const durations = new Set(
      (clean.match(/var\(--dur-[\w-]+\)/g) || []).slice(),
    );
    const easings = new Set(clean.match(/var\(--ease-[\w-]+\)/g) || []);
    for (const d of durations) {
      expect(
        ["var(--dur-fast)", "var(--dur-normal)", "var(--dur-slow)"],
        `${d} 唔喺白名單`,
      ).toContain(d);
    }
    for (const e of easings) {
      expect(["var(--ease-standard)", "var(--ease-emphasis)"], `${e} 唔喺白名單`).toContain(
        e,
      );
    }
    // 冇 raw ms / s 時間值（animation-delay 嘅 calc 除外）
    const rawTime = clean
      .split("\n")
      .filter((l) => /:\s*[\d.]+m?s\s*;/.test(l) && !l.includes("--pulse-index"));
    expect(rawTime, `唔可以寫死時間值：${rawTime.join(" | ")}`).toHaveLength(0);
  });

  it("所有文字 ≥ 12px（spec §7.3 硬下限）", () => {
    const clean = stripComments(MAP_CSS);
    const sizes = (clean.match(/font-size:\s*([\d.]+)px/g) || []).map((s) =>
      Number(s.replace(/[^\d.]/g, "")),
    );
    for (const px of sizes) {
      expect(px, "map.css 唔可以出現 < 12px 嘅字").toBeGreaterThanOrEqual(12);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 唔可以改到唔應該改嘅檔（守門）
// ─────────────────────────────────────────────────────────────────────────────

describe("CSS 契約：範圍守門", () => {
  it("`main.css` / `hud.css` 嘅 zone 規則冇被 B6 改走（只可以覆蓋）", () => {
    /*
     * B6 唔可以改舊 CSS。呢個斷言確認舊規則**原封不動** ——
     * 如果有人（包括我）手多多改咗，測試會變紅，迫佢改返轉頭。
     */
    const mainZone = declarationsFor(MAIN_CSS, ".zone-area").join(";");
    expect(mainZone).toMatch(/transition\s*:/);
    // main.css 嘅 hover 規則仲喺度
    expect(stripComments(MAIN_CSS)).toMatch(/\.zone:hover\s+\.zone-area\s*\{/);
  });

  it("`map.css` 冇 import 任何其他 CSS（避免循環／次序問題）", () => {
    expect(stripComments(MAP_CSS)).not.toMatch(/@import/);
  });
});

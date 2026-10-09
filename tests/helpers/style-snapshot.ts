// D2-9 —— 視覺契約快照（**唔用像素**，用 computed style ＋ 幾何）
//
// 為何要有呢個（同 `visual-shots.ts` 嘅像素守衛互補）
// ==================================================
// 像素守衛（`visual-regression.e2e.test.ts`）證明「畫面一模一樣」，
// 但係**黑盒**：失敗時只知「有幾多像素差」，唔知**邊個屬性**變咗 ✗。
//
// 本 helper 抽「關鍵元素嘅 computed style ＋ 幾何」成一個**可讀嘅 JSON
// 快照** → 失敗時可以逐個屬性睇「邊個由 X 變 Y」✓。
//
// ⚠️ 為何要**正規化**（唔可以照抄 `getComputedStyle` 嘅字串）
// ----------------------------------------------------------
//   · 顏色：`rgb(11, 15, 20)` vs `rgba(11, 15, 20, 1)` vs `#0b0f14`
//     → 一律正規化成 `rgb(r, g, b)`（alpha=0 變 `transparent`）。
//   · 幾何：`getBoundingClientRect()` 有分數 px（DPR／子像素）
//     → 一律 `Math.round()` 到整數 px。
//   · 兩者令快照**跨機器／跨 run 穩定**，同時仍然捉得到真回歸。
//
// ⚠️ 已知限制
// ==========
// · 快照**係機器相關**（字體光柵化會影響 text 元素嘅 rect）→ 所以
//   `SNAPSHOT_SELECTORS` 刻意**只揀容器／控制項**，唔揀純文字節點。
// · CI 冇 Playwright browser → 本快照守衛喺 CI **skip**（同像素守衛一致）。

import type { Page } from "@playwright/test";

/** 每個元素要抽嘅 computed 屬性（刻意揀穩定、同視覺契約相關嘅）。 */
export const FINGERPRINT_PROPS: string[] = [
  "display",
  "position",
  "z-index",
  "pointer-events",
  "visibility",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "border-top-width",
  "border-top-color",
  "overflow",
];

/**
 * 要抽快照嘅元素（**容器／控制項**為主，避免文字 metrics 帶嚟跨機差異）。
 *
 * 覆蓋：頂欄、地圖容器、地圖控制項、故事面板、章節條、圖例、
 * 搜尋 overlay（連面板）、引導卡、**載入失敗畫面**（D2-9 擴狀態）。
 *
 * ⚠️ 失敗畫面嗰兩個 selector 只喺 `12-desktop-load-failure` 存在
 * —— 其餘狀態會記錄 `null`（同樣係契約一部分：唔應該無端出現）。
 */
export const SNAPSHOT_SELECTORS: string[] = [
  "#topbar",
  "#map-pane",
  "#map-controls",
  "#story-pane",
  ".chapter-strip",
  ".map-legend",
  "#btn-toggle-panel",
  "#search-overlay",
  "#search-overlay .search-panel",
  ".onboarding-card",
  ".bg-error-panel",
  ".bg-retry-btn",
];

export interface ElementFingerprint {
  rect: { x: number; y: number; w: number; h: number };
  props: Record<string, string>;
}

export interface StateSnapshot {
  state: string;
  viewport: string;
  /** selector → 指紋（元素唔存在時為 `null`）。 */
  elements: Record<string, ElementFingerprint | null>;
}

/**
 * 喺**瀏覽器內**收集一個狀態嘅快照。
 *
 * ⚠️ 全部抽取邏輯喺**同一個 `evaluate`** 內完成 —— 唔可以「逐個屬性
 * round-trip 返 Node」（N 個元素 × M 個屬性 = 幾百次 round-trip，
 * 又慢又易錯）。
 */
export async function collectSnapshot(
  page: Page,
  state: string,
  viewport: string,
  selectors: string[] = SNAPSHOT_SELECTORS,
): Promise<StateSnapshot> {
  const elements = await page.evaluate(
    ({ sels, props }: { sels: string[]; props: string[] }) => {
      /** 顏色正規化：rgb/rgba → `rgb(r, g, b)`；alpha=0 → `transparent`。 */
      const normColor = (v: string): string => {
        const m = v.match(/^rgba?\(([^)]+)\)$/);
        if (!m) return v;
        const parts = m[1].split(",").map((s) => s.trim());
        const alpha = parts[3] !== undefined ? Number(parts[3]) : 1;
        if (alpha === 0) return "transparent";
        return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
      };
      const out: Record<
        string,
        {
          rect: { x: number; y: number; w: number; h: number };
          props: Record<string, string>;
        } | null
      > = {};
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) {
          out[sel] = null;
          continue;
        }
        const cs = getComputedStyle(el);
        const p: Record<string, string> = {};
        for (const prop of props) {
          let v = cs.getPropertyValue(prop);
          if (prop.endsWith("color")) v = normColor(v);
          p[prop] = v;
        }
        const r = el.getBoundingClientRect();
        out[sel] = {
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
          props: p,
        };
      }
      return out;
    },
    { sels: [...selectors], props: [...FINGERPRINT_PROPS] },
  );
  return { state, viewport, elements };
}

/** 幾何容差（px）：容許子像素／環境差異，但仍然捉得到「真嘅移位」。 */
export const RECT_TOLERANCE_PX = 2;

export interface SnapshotDiff {
  /** 人類可讀嘅差異描述（空 = 一致）。 */
  diffs: string[];
}

/** 比較兩個快照，回傳所有差異（含路徑同前後值）。 */
export function diffSnapshots(
  baseline: StateSnapshot,
  current: StateSnapshot,
): SnapshotDiff {
  const diffs: string[] = [];
  const keys = new Set([
    ...Object.keys(baseline.elements),
    ...Object.keys(current.elements),
  ]);
  for (const sel of [...keys].sort()) {
    const b = baseline.elements[sel] ?? null;
    const c = current.elements[sel] ?? null;
    const where = `${baseline.state} › ${sel}`;
    if (b === null && c === null) continue;
    if (b === null || c === null) {
      diffs.push(`${where}: 元素存在性改變（baseline=${b === null ? "無" : "有"}, current=${c === null ? "無" : "有"}）`);
      continue;
    }
    // 幾何（含容差）
    for (const k of ["x", "y", "w", "h"] as const) {
      const dv = Math.abs(b.rect[k] - c.rect[k]);
      if (dv > RECT_TOLERANCE_PX) {
        diffs.push(`${where}: rect.${k} ${b.rect[k]} → ${c.rect[k]}（差 ${dv}px > ${RECT_TOLERANCE_PX}）`);
      }
    }
    // computed 屬性（精確比對）
    const propKeys = new Set([...Object.keys(b.props), ...Object.keys(c.props)]);
    for (const pk of [...propKeys].sort()) {
      if (b.props[pk] !== c.props[pk]) {
        diffs.push(`${where}: ${pk} 「${b.props[pk] ?? "(無)"}」→「${c.props[pk] ?? "(無)"}」`);
      }
    }
  }
  return { diffs };
}

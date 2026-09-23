/**
 * map-interactions.ts — B6 地圖互動嘅**純函數**核心。
 *
 * 為何要抽做獨立模組
 * ================
 * `SvgMap.ts` 已經 1,840 行。互動邏輯（「點到呢個係咩？」）如果留喺
 * `bindEvents()` 嘅 click handler 內部，就**冇辦法單測** —— 只可以靠
 * Playwright e2e，而 e2e 跑一次要幾十秒，出錯時又睇唔到係邊一層判錯。
 *
 * 所以呢度只做兩件事，而且兩件都係 `input → output`：
 *
 *   1. `resolveHit()`          — 由 DOM 元素判斷命中目標（spec §2.3）
 *   2. `toggleLayerKey()` 等   — 圖層開關嘅狀態轉移（搭配 B2 `LayerFlags`）
 *
 * ⚠️ 本檔**唔** 讀 `document`、**唔**寫任何 DOM。呼叫者負責傳入
 * `Element`；測試可以直接餵 CSS 選擇器字串產生嘅元素（Playwright 內）
 * 或 `null`（node 單測）。
 */

import type { LayerFlags } from "../types/state";

// ─────────────────────────────────────────────────────────────────────────────
// hit priority（spec §2.3）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 命中目標種類，由**高優先**至**低優先**排列。
 *
 * spec §2.3 原文：
 *   MapControls > ZoneLayer > RouteLayer > MarkerLayer > EventLayer >
 *   BaseGeometryLayer
 *
 * ⚠️ 次序唔可以改。改咗會令「喺 zone 內部嘅 event marker」無法點到
 * （或者反過來），亦即 spec 明確要求避免嘅行為。
 */
export type HitTargetKind =
  | "controls"
  | "zone"
  | "route"
  | "marker"
  | "event"
  | "basemap";

/** 優先級數字（細 = 優先）。方便測試斷言次序。 */
export const HIT_PRIORITY: Record<HitTargetKind, number> = {
  controls: 0,
  zone: 1,
  route: 2,
  marker: 3,
  event: 4,
  basemap: 5,
};

export interface HitTarget {
  kind: HitTargetKind;
  /** zone id / route id / loc id / event id；`controls` 用掣嘅 id；`basemap` 為 null。 */
  id: string | null;
}

/**
 * 由內至外搵嘅選擇器表（**次序即優先級**）。
 *
 * 為何用 `closest()` 而唔係 `classList.contains()`
 * ----------------------------------------------
 * 實際點到嘅唔一定係帶 class 嗰個元素：`.zone-badge` 內部有 `<circle>`
 * 同 `<path>`、`.location-marker-cluster` 內部有 `<circle>` 同 `<text>`。
 * 用 `closest()` 由被點嘅元素向上搵，一次過覆蓋「點到子元素」嘅情況。
 *
 * ⚠️ `.zone-badge` 雖然喺 `.zone` 之內，但佢自己嘅 `pointer-events` 係
 * `none`（見 `map.css`）—— 所以命中永遠落喺 `.zone-area` 或者 `<g class="zone">`
 * 本身，`closest(".zone")` 兩者都搵得到。
 */
const HIT_SELECTORS: ReadonlyArray<{
  kind: HitTargetKind;
  selector: string;
  idAttr: string | null;
}> = [
  { kind: "controls", selector: ".map-ctrl", idAttr: "id" },
  { kind: "zone", selector: ".zone", idAttr: "data-zone-id" },
  { kind: "route", selector: ".route-line", idAttr: "data-route-id" },
  {
    kind: "marker",
    selector: ".location-marker, .location-marker-cluster",
    idAttr: "data-loc-id",
  },
  { kind: "event", selector: ".event-marker", idAttr: "data-event-id" },
];

/**
 * `resolveHit()` 需要嘅**最小**元素介面（結構型別）。
 *
 * 為何唔直接用 `Element`
 * --------------------
 * `resolveHit()` 只用到 `closest()` 同 `getAttribute()` 兩個方法。
 * 如果參數型別寫死 `Element`，測試就一定要起一個完整嘅 DOM 實作
 * （jsdom）—— 而 jsdom 唔支援 SVG 元素嘅 `closest()` class 匹配。
 *
 * 用結構型別之後：
 *   · 真瀏覽器傳 `Element` 完全冇問題（`Element` 有齊呢兩個方法）；
 *   · node 單測可以傳一個 8 行嘅替身，測得更準而且快 1000 倍。
 *
 * 呢個唔係「為測試而鬆懈型別」—— 而係將函數嘅**真實依賴**寫出嚟。
 */
export interface HitElementLike {
  closest(selector: string): unknown;
  getAttribute(name: string): string | null;
}

/**
 * 判斷命中目標。
 *
 * @param el 由 `document.elementFromPoint()` 或者 `event.target` 攞到嘅元素。
 *           `null`（點喺 SVG 外面／超出文件）一律當 `basemap`。
 *
 * ⚠️ `elementFromPoint()` 只會回傳**最頂**而且**有 pointer-events** 嘅元素。
 * 所以 `pointer-events: none` 嘅 `.zone-glow` / `.zone-pulse` /
 * `.zone-label` / `.zone-badge` **唔會**出現喺呢度 —— 呢個就係 spec §2.3
 * 所講「hit priority 由各 layer 嘅 pointer-events 決定」嘅意思。
 */
export function resolveHit(el: Element | HitElementLike | null): HitTarget {
  if (!el) return { kind: "basemap", id: null };
  // `closest` 喺非 Element（例如純文字節點）上唔存在 —— 加防禦。
  if (typeof el.closest !== "function") return { kind: "basemap", id: null };

  for (const rule of HIT_SELECTORS) {
    const found = el.closest(rule.selector) as HitElementLike | null;
    if (!found) continue;
    const id = rule.idAttr ? found.getAttribute(rule.idAttr) : null;
    return { kind: rule.kind, id };
  }
  return { kind: "basemap", id: null };
}

/**
 * 將 `resolveHit()` 嘅結果交畀 `App` 嘅對應 action。
 *
 * 回傳值 = 有冇處理到（`basemap` 回傳 `false`，令呼叫者可以決定
 * 「點空白 = 取消選中」之類嘅行為）。
 *
 * ⚠️ 呢度只係**分派**，唔做任何判斷。判斷全部喺 `resolveHit()` 做完
 * —— 咁樣分派嘅正確性可以靠 `resolveHit()` 嘅單測覆蓋。
 */
export interface HitHandlers {
  onZone(id: string): void;
  onRoute(id: string): void;
  onMarker(id: string): void;
  onEvent(id: string): void;
}

export function dispatchHit(target: HitTarget, h: HitHandlers): boolean {
  switch (target.kind) {
    case "zone":
      if (!target.id) return false;
      h.onZone(target.id);
      return true;
    case "route":
      if (!target.id) return false;
      h.onRoute(target.id);
      return true;
    case "marker":
      if (!target.id) return false;
      h.onMarker(target.id);
      return true;
    case "event":
      if (!target.id) return false;
      h.onEvent(target.id);
      return true;
    default:
      // controls 由按鈕自己嘅 click listener 處理（唔經 SVG delegation）；
      // basemap 冇 action。
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 圖層開關（B2 `LayerFlags` 嘅 7 個 key）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 7 個 toggle 嘅次序 —— **必須**同 `src/state/url.ts:69 LAYER_ORDER` 一致。
 *
 * 為何要喺度再寫一次而唔 import
 * ----------------------------
 * `LAYER_ORDER` 喺 `src/state/url.ts` 係 `const`（未 export）。B6 唔可以
 * 改 `src/state/*`（B2 凍結），所以呢度寫一份**鏡像**，並由
 * `tests/map-interaction.test.ts` 讀 `url.ts` 原始碼交叉驗證兩者一致
 * —— 若 B2 改咗次序，測試會變紅而唔係靜靜漂移。
 */
export const LAYER_KEYS: readonly (keyof LayerFlags)[] = [
  "zones",
  "nests",
  "outposts",
  "events",
  "routes",
  "periods",
  "detail",
] as const;

/** 每個 toggle 嘅中文標籤（`data-i18n` key 用 `layer.<key>`）。 */
export const LAYER_LABEL_ZH: Record<keyof LayerFlags, string> = {
  zones: "倖存區",
  nests: "病窩",
  outposts: "據點",
  events: "事件",
  routes: "路線",
  periods: "時期",
  detail: "地點",
};

export const LAYER_LABEL_EN: Record<keyof LayerFlags, string> = {
  zones: "Safe zones",
  nests: "Nests",
  outposts: "Outposts",
  events: "Events",
  routes: "Routes",
  periods: "Periods",
  detail: "Places",
};

/** 由 `aria-pressed` 字串還原布林（任何非 `"true"` 都當 false）。 */
export function pressedToBool(v: string | null): boolean {
  return v === "true";
}

/**
 * 由圖層開關狀態計出**每個 `<g>` 要唔要 `hidden`**（`true` = 收埋）。
 *
 * 為何唔係一對一
 * -------------
 * `zones` / `nests` / `outposts` 三個 key 都係 zone 圖層嘅**子集合**
 * （按 `styleKey` 分）。而 `#zones-layer` 本身唔應該被 `hidden`
 * —— 否則 `nests` 開、`zones` 關嘅時候會連病窩都消失。
 *
 * 所以 `#zones-layer` **永遠唔 hidden**；由每個 `.zone` 個別 `hidden`。
 * 呢個亦係唯讀 `hidden` 而唔重建 DOM 就可以即時生效嘅原因。
 *
 * @returns 每個 selector 對應嘅 `hidden` 值。
 */
export function hiddenSelectors(s: LayerFlags): Array<{
  /** CSS 選擇器（`querySelectorAll` 用）。 */
  selector: string;
  hidden: boolean;
}> {
  return [
    // zone 子集合：note 用 hidden 而唔用 display:none，令 :hover 等
    // 既有規則唔需要重寫。
    { selector: "#zones-layer .zone-survivor", hidden: !s.zones },
    { selector: "#zones-layer .zone-nest", hidden: !s.nests },
    { selector: "#zones-layer .zone-outpost", hidden: !s.outposts },
    // 冇細分種類嘅裝飾（cluster badge / 光環）跟 overall zone 開關
    {
      selector: "#zones-layer .zone-cluster",
      hidden: !(s.zones || s.nests || s.outposts),
    },
    { selector: "#events-layer", hidden: !s.events },
    { selector: "#routes-layer", hidden: !s.routes },
    // `periods`：時期分層尚未實作（B3/B7），SVG 側最接近嘅係 zone 標籤
    { selector: "#zones-layer .zone-label", hidden: !s.periods },
    // `detail`：tile POI / 地點標記（canvas 側道路樓宇另有 API）
    { selector: "#locations-layer", hidden: !s.detail },
  ];
}

/** 將 selector 表反轉成「有幾多個 selector 受影響」（測試／除錯用）。 */
export function hiddenSelectorCount(s: LayerFlags): number {
  return hiddenSelectors(s).filter((r) => r.hidden).length;
}

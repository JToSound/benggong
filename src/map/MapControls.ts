/**
 * MapControls.ts — 地圖控制項（縮放／重置／層級開關／圖例開關）。
 *
 * 為何要由 `SvgMap` 抽出
 * ====================
 * B5 嘅 `SvgMap.init()` 用一大段 `root.innerHTML = \`…\`` 一次過砌好
 * 控制項、圖例、SVG。問題有三個：
 *
 *   1. **唔可以獨立測** —— 要起整個 `SvgMap`（連 app、連 canvas）才驗到
 *      「放大掣係唔係 44px」。
 *   2. **`#map-show-all-events` 借住咗**（B5 §7 D-5）：嗰個掣係 B6 嘅嘢，
 *      但暫時放喺 `SvgMap`。呢個檔就係「直接搬」嘅目的地。
 *   3. **狀態同 DOM 撈埋一齊** —— 舊 code 用 `this.showAllEvents` 記
 *      開關狀態。V2 要求控制項係**無狀態**嘅：狀態由呼叫者（`SvgMap`）
 *      經 `setAllEvents()` 寫入，掣只反映。
 *
 * 契約（見 `docs/contracts/b6-interface-contract.md` §6）
 * -----------------------------------------------
 *   · `id` **唔可以改**：`#map-zoom-in` / `#map-zoom-out` / `#map-reset` /
 *     `#map-show-all-events` —— `tests/map-render.test.ts:493` 同
 *     `tests/visual-smoke.e2e.test.ts:233` 直接 `page.click()` 佢哋。
 *   · 每個掣 ≥ 44×44 px（spec §3 C3）＋ 可見 focus ring（A7 P0-3）。
 *   · `aria-pressed` 係 toggle 嘅**唯一**可觀察狀態（B5 §7 D-5）。
 *
 * B8（2026-09-22）改動
 * -------------------
 * A7 P0-3 實測：`#map-zoom-in` / `#map-zoom-out` / `#map-reset` 嘅 focus ring
 * 區變化像素 = **0**（內部變化 78px 證明 focus 生效）。根因係 `.map-ctrl`
 * 有 `clip-path: var(--hud-clip-sm)`（`hud.css:209`），而 `outline` 畫喺
 * border box 之外 → 被剪走。
 *
 * 修法（兩處，互補）：
 *   1. `mobile.css` 對 `#map-controls .map-ctrl:focus-visible` 加
 *      `box-shadow: inset 0 0 0 2px var(--focus-ring)`（inset 描邊喺
 *      border box 內，clip-path 剪唔走）。
 *   2. 本檔喺 render() 為每個掣寫入 `data-focus-ring="inset"` 標記，
 *      令「ring 用 inset 通道」呢個契約可以**單測**（唔需要起瀏覽器）。
 *
 * ⚠️ 唔可以移除 `clip-path` —— 切角係 spec §5.4 明文嘅視覺語言。
 */

/**
 * 最小互動尺寸（px）—— spec §3 C3 / `map.css` 嘅 `min-width` 契約。
 *
 * ⚠️ 呢個常數同時被 `tests/map-css-contract.test.ts` 讀取去斷言
 * `map.css` 嘅數值唔低於佢。所以**唔可以**淨係改 CSS 唔改呢度。
 */
export const MIN_TAP_PX = 44;

export interface MapControlHandlers {
  onZoomIn(): void;
  onZoomOut(): void;
  onReset(): void;
  onToggleAllEvents(): void;
}

/** 一個掣嘅規格（`render()` 靠呢個表砌 DOM，令 id／class 只有一份來源）。 */
interface CtrlSpec {
  id: string;
  cls: string;
  /** `aria-label`（掣嘅無障礙名；`title` 只係滑鼠提示）。 */
  label: string;
  /** 可見內容。 */
  glyph: string;
  title: string;
  handler: keyof MapControlHandlers;
  toggle?: boolean;
}

const CTRL_SPECS: readonly CtrlSpec[] = [
  {
    id: "map-zoom-in",
    cls: "map-ctrl",
    label: "放大",
    glyph: "+",
    title: "放大",
    handler: "onZoomIn",
  },
  {
    id: "map-zoom-out",
    cls: "map-ctrl",
    label: "縮小",
    glyph: "−",
    title: "縮小",
    handler: "onZoomOut",
  },
  {
    id: "map-reset",
    cls: "map-ctrl",
    label: "重置視圖",
    glyph: "⌂",
    title: "重置視圖",
    handler: "onReset",
  },
  {
    /*
     * 「顯示全部事件」開關（spec §3.3）。
     *
     * 預設關：event 只畫「本章 ± 1 章」。深 zoom 落將軍澳時 176 個事件
     * 會疊成一大坨，但用戶有時的確想睇全部 —— 所以唔係靜靜咁丟棄，
     * 而係提供一個明確開關。
     *
     * ⚠️ `aria-pressed` 係唯一可觀察狀態：`tests/map-render.test.ts:496`
     * 直接斷言佢係 `"true"`。呢個掣嘅狀態**唔**入 store（`LayerFlags`
     * 冇對應 key，而 B2 已凍結）—— 由 `SvgMap.showAllEvents` 持有，
     * 經 `setAllEvents()` 寫入 DOM。
     */
    id: "map-show-all-events",
    cls: "map-ctrl map-ctrl-wide",
    label: "顯示全部章節嘅事件",
    glyph: "全部事件",
    title: "顯示全部章節嘅事件",
    handler: "onToggleAllEvents",
    toggle: true,
  },
];

export class MapControls {
  private root: HTMLElement;
  private handlers: MapControlHandlers;
  /** 已綁定嘅 listener，`dispose()` 要逐個拆（唔可以 `innerHTML = ""` 就算）。 */
  private bound: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

  constructor(root: HTMLElement, handlers: MapControlHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.render();
    this.bind();
  }

  /** 砌 DOM —— 全部靠 `CTRL_SPECS`，令 id 同名只有一處。 */
  private render(): void {
    const btns = CTRL_SPECS.map(
      (s) =>
        `<button id="${s.id}" class="${s.cls}" type="button"` +
        /*
         * B8 / A7 P0-3：`data-focus-ring="inset"` 係**契約標記** ——
         * 表示呢粒掣嘅 focus ring 用 inset box-shadow 通道（因為
         * `clip-path` 會剪走 outline）。`mobile.css` 對應規則把關，
         * `tests/a11y-aria.test.ts` 斷言呢個標記存在。
         */
        ` data-focus-ring="inset"` +
        (s.toggle ? ` aria-pressed="false" aria-label="${s.label}"` : "") +
        ` title="${s.title}" aria-label="${s.toggle ? "" : s.label}">${s.glyph}</button>`,
    ).join("");
    this.root.innerHTML = btns;
  }

  private bind(): void {
    for (const s of CTRL_SPECS) {
      const el = this.root.querySelector<HTMLElement>(`#${s.id}`);
      if (!el) continue;
      const fn: EventListener = () => this.handlers[s.handler]();
      el.addEventListener("click", fn);
      this.bound.push({ el, type: "click", fn });
    }
  }

  /**
   * 寫入「全部事件」嘅 `aria-pressed`。
   *
   * ⚠️ 唔喺度切換狀態 —— 狀態由 `SvgMap` 持有。呢個方法係**冪等**嘅：
   * 傳同一個值唔會產生副作用（舊 code 用 class 切換，令
   * 「重新 render 之後掣同實際過濾唔一致」）。
   */
  setAllEvents(pressed: boolean): void {
    const el = this.root.querySelector<HTMLElement>("#map-show-all-events");
    if (!el) return;
    el.setAttribute("aria-pressed", String(pressed));
  }

  /** 讀返目前 `aria-pressed`（測試／除錯用）。 */
  get allEventsPressed(): boolean {
    return (
      this.root.querySelector("#map-show-all-events")?.getAttribute("aria-pressed") ===
      "true"
    );
  }

  dispose(): void {
    for (const { el, type, fn } of this.bound) el.removeEventListener(type, fn);
    this.bound = [];
  }
}

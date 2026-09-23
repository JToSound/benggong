/**
 * BottomSheet.ts — mobile 3 段 snap bottom sheet（B8）
 *
 * 為何要呢個檔（A7 P2-1 / P0-1 / P1-6 / P1-7）
 * ==========================================
 * 現況（A7 實測）故事面板係 `position: absolute; top:0; bottom:0;
 * width: min(360px, 88vw)` 嘅**右側抽屜**：
 *
 *   · 唔係 bottom sheet（`hasBottomSheetClass: false`）
 *   · 冇 drag handle、冇 snap points（`hasSnapPoints: false`）
 *   · `touch-action: auto`（垂直拖曳會變成頁面滾動）
 *   · 開啟後遮蓋 **88%** 地圖面積
 *   · 收合之後**仍然有 2,920 個 Tab stop**（`transform` 唔會離 Tab 序）
 *   · 冇 safe-area（底部被 home indicator 蓋）
 *
 * 本檔負責 sheet 嘅**行為層**（DOM 結構 / ARIA / 手勢 / 鍵盤 / focus）；
 * 視覺層（高度、snap、safe-area）由 `src/styles/mobile.css` 負責。
 *
 * 契約（見 `docs/contracts/b8-interface-contract.md` §5）
 * ------------------------------------------------
 *   · `sheetSnap` 嘅**唯一來源**係 store（規則 S1）。本元件唔持有 snap state，
 *     只係經 `getSnap()` 讀、`setSnap()` 寫。
 *   · DOM class / `data-sheet-snap` / `aria-*` 只係**衍生輸出**（規則 S2）。
 *   · 動效一律經 `src/motion.ts`（規則 M2）；reduced-motion → 即時跳終態。
 *   · `peek` 時 overlap ÷ 地圖必須 ≤ 25%（A7 §9 驗收）。
 */

import { DUR } from "../motion";
/*
 * B8 元件 CSS（`?inline` 變成字串）。
 *
 * 為何要注入而唔係 `import "./styles/mobile.css"`
 * ----------------------------------------------
 * mobile.css **必須後載入** legacy `main.css` / `timeline.css` / `hud.css`
 * 才蓋得過佢哋（`.nav-btn { clip-path }`、`.ch-pill { height: 24px }`、
 * `.pane-story.is-collapsed { transform }` 全部喺嗰三隻檔）。
 * 但 `src/main.ts` 同 `src/styles/index.css` **兩者都唔喺 B8 可寫範圍**。
 *
 * 注入嘅 `<style>` append 到 `<head>` **最後** → 同等特異度下一定勝過舊
 * CSS（後載入者勝）。呢個係 B6 `map.css` 已經用嘅同一個機制
 * （`SvgMap.injectMapCss()`），零新 runtime 依賴（Vite 內建 `?inline`）。
 *
 * Gate 2 刪走舊 CSS 之後，改為喺 `main.ts` 直接 `import` 就可以移除呢段。
 */
import mobileCss from "../styles/mobile.css?inline";

/** 3 段 snap（同 `AppState.sheetSnap` 一致）。 */
export type SheetSnap = "peek" | "half" | "full";

/** snap 由低到高（做 clamp / 方向鍵用）。 */
export const SNAP_ORDER: readonly SheetSnap[] = ["peek", "half", "full"] as const;

export interface BottomSheetOptions {
  /** sheet 外層（`#story-pane`；本元件會喺入面插 handle + 標題）。 */
  root: HTMLElement;
  /** 由 store 讀當前 snap（唯一狀態來源）。 */
  getSnap(): SheetSnap;
  /** 寫入 snap（store action）。 */
  setSnap(s: SheetSnap): void;
  /** sheet 標題（`h2`；亦係 `aria-labelledby` 目標）。 */
  title: string;
  /** 內部內容容器（StoryPanel / ChronicleView 嘅 mount 點）。 */
  content: HTMLElement;
}

/** `aria-valuenow` 用人讀得明嘅百分比（唔係 snap 名）。 */
const SNAP_PCT: Record<SheetSnap, number> = { peek: 25, half: 55, full: 92 };

/**
 * 下一個 snap（方向鍵用）。
 *
 * @param dir `+1` = 升（peek→half→full）、`-1` = 降。
 */
export function nextSnap(cur: SheetSnap, dir: number): SheetSnap {
  const i = SNAP_ORDER.indexOf(cur);
  const j = Math.min(SNAP_ORDER.length - 1, Math.max(0, i + dir));
  return SNAP_ORDER[j];
}

/**
 * 拖曳位移 → 落喺邊個 snap。
 *
 * 為何要抽做純函數：手勢行為要可以**單測**（唔需要真觸控）。
 *
 * @param startSnap 拖曳開始時嘅 snap
 * @param dy 由起點嘅垂直位移（**正數 = 向下 = 收合**）
 * @param viewportH 視窗高度（px；用嚟計門檻比例）
 */
export function snapFromDrag(
  startSnap: SheetSnap,
  dy: number,
  viewportH: number,
): SheetSnap {
  // 拖曳距離佔視窗高度嘅比例（向下為正）
  const ratio = viewportH > 0 ? dy / viewportH : 0;
  const i = SNAP_ORDER.indexOf(startSnap);
  if (ratio > 0.18) {
    // 向下拖過 18% → 落一級（或兩級，如果拖得好遠）
    const steps = ratio > 0.4 ? 2 : 1;
    return SNAP_ORDER[Math.max(0, i - steps)];
  }
  if (ratio < -0.12) {
    // 向上拖過 12% → 升一級
    const steps = ratio < -0.3 ? 2 : 1;
    return SNAP_ORDER[Math.min(SNAP_ORDER.length - 1, i + steps)];
  }
  return startSnap;
}

/**
 * 注入 B8 mobile CSS（`?inline` 字串 → `<style id="b8-mobile-css">`）。
 *
 * 幂等：已經注入就唔重複（多個 `BottomSheet` 實例唔會疊）。
 */
export function injectMobileCss(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("b8-mobile-css")) return;
  const style = document.createElement("style");
  style.id = "b8-mobile-css";
  style.textContent = mobileCss;
  document.head.appendChild(style);
}

export class BottomSheet {
  private root: HTMLElement;
  private content: HTMLElement;
  private handle: HTMLButtonElement | null = null;
  private titleId: string;
  private getSnap: () => SheetSnap;
  private setSnap: (s: SheetSnap) => void;

  /** 綁定咗嘅 listener（`destroy()` 要逐個拆，唔可以 `innerHTML = ""` 就算）。 */
  private bound: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];

  /** 拖曳狀態（本地 UI，唔入 store —— 規則 C2）。 */
  private dragStartY = 0;
  private dragStartSnap: SheetSnap = "peek";
  private dragging = false;

  constructor(opts: BottomSheetOptions) {
    this.root = opts.root;
    this.content = opts.content;
    this.getSnap = opts.getSnap;
    this.setSnap = opts.setSnap;
    this.titleId = "sheet-title";
    injectMobileCss();
    this.mount(opts.title);
    this.bind();
    this.render(this.getSnap());
  }

  /** 砌 handle + 標題（內容本身由外部 mount，唔碰）。 */
  private mount(title: string): void {
    // 避免重複 mount（熱重載 / 重複呼叫）
    this.root.querySelector(".sheet-handle")?.remove();
    this.root.querySelector(".sheet-title")?.remove();

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "sheet-handle";
    /*
     * `role="separator"` + `aria-valuenow` 係 spec §5.4 明文要求嘅 ARIA 模式：
     * 螢幕閱讀器會當佢係一個「可調整大小嘅分隔器」，方向鍵可以改值。
     */
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "拖曳或按方向鍵調整面板高度");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-valuemin", "25");
    handle.setAttribute("aria-valuemax", "92");
    handle.setAttribute("aria-valuenow", String(SNAP_PCT[this.getSnap()]));

    const h = document.createElement("h2");
    h.className = "sheet-title";
    h.id = this.titleId;
    h.textContent = title;

    this.root.insertBefore(h, this.root.firstChild);
    this.root.insertBefore(handle, this.root.firstChild);
    this.handle = handle;

    // sheet 本體嘅 dialog 語意（`full` 時等同 modal，見 render()）
    this.root.setAttribute("aria-labelledby", this.titleId);
  }

  private bind(): void {
    const on = (el: EventTarget, type: string, fn: EventListener): void => {
      el.addEventListener(type, fn);
      this.bound.push({ el, type, fn });
    };

    // ── 指標拖曳（handle）─────────────────────────────────────────────
    if (this.handle) {
      on(this.handle, "pointerdown", ((e: PointerEvent) => {
        this.dragging = true;
        this.dragStartY = e.clientY;
        this.dragStartSnap = this.getSnap();
        this.handle?.setPointerCapture(e.pointerId);
      }) as EventListener);

      on(this.handle, "pointermove", ((e: PointerEvent) => {
        if (!this.dragging) return;
        // 拖曳期間只做即時預覽（加 class），吸附喺 pointerup 才落實
        const dy = e.clientY - this.dragStartY;
        if (Math.abs(dy) > 8) this.root.classList.add("is-dragging");
      }) as EventListener);

      const endDrag = (e: PointerEvent): void => {
        if (!this.dragging) return;
        this.dragging = false;
        this.root.classList.remove("is-dragging");
        try {
          this.handle?.releasePointerCapture(e.pointerId);
        } catch {
          /* 已經釋放 */
        }
        const dy = e.clientY - this.dragStartY;
        const vh = typeof window !== "undefined" ? window.innerHeight : 800;
        this.setSnap(snapFromDrag(this.dragStartSnap, dy, vh));
      };
      on(this.handle, "pointerup", endDrag as unknown as EventListener);
      on(this.handle, "pointercancel", endDrag as unknown as EventListener);

      // ── 鍵盤（方向鍵改 snap；Enter/Space 切換 peek ↔ full）──────────
      on(this.handle, "keydown", ((e: KeyboardEvent) => {
        let consumed = true;
        switch (e.key) {
          case "ArrowUp":
            this.setSnap(nextSnap(this.getSnap(), 1));
            break;
          case "ArrowDown":
            this.setSnap(nextSnap(this.getSnap(), -1));
            break;
          case "Home":
            this.setSnap("peek");
            break;
          case "End":
            this.setSnap("full");
            break;
          case "Enter":
          case " ":
            this.setSnap(this.getSnap() === "full" ? "peek" : "full");
            break;
          default:
            consumed = false;
        }
        if (consumed) e.preventDefault();
      }) as EventListener);
    }

    /*
     * 內容區域由 peek 向上拖 = 擴張 sheet（spec §5.4 手勢表）。
     * 只有喺內容滾到頂（scrollTop === 0）時才接管 —— 否則會同內部滾動打架。
     */
    on(this.content, "pointerdown", ((e: PointerEvent) => {
      if (this.content.scrollTop > 0) return;
      this.dragging = true;
      this.dragStartY = e.clientY;
      this.dragStartSnap = this.getSnap();
    }) as EventListener);

    on(this.content, "pointerup", ((e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      const dy = e.clientY - this.dragStartY;
      const vh = typeof window !== "undefined" ? window.innerHeight : 800;
      const next = snapFromDrag(this.dragStartSnap, dy, vh);
      if (next !== this.dragStartSnap) this.setSnap(next);
    }) as EventListener);
  }

  /**
   * store 變更 → 更新衍生 DOM（規則 S2）。
   *
   * 呢個方法係**冪等**嘅：同一個 snap 呼叫兩次唔會有副作用。
   */
  render(snap: SheetSnap): void {
    const collapsed = snap === "peek";

    // class 只係衍生輸出（唔再係 state 本身）
    this.root.classList.toggle("is-collapsed", collapsed);
    this.root.classList.toggle("is-peek", snap === "peek");
    this.root.classList.toggle("is-half", snap === "half");
    this.root.classList.toggle("is-full", snap === "full");
    this.root.setAttribute("data-sheet-snap", snap);

    /*
     * P0-1：收合時令 sheet 內容唔可 Tab / 唔入 accessibility tree。
     *
     * CSS 層（`mobile.css` 嘅 `visibility: hidden`）已經處理咗；呢度加
     * `inert` 做**雙重保險**（inert 同時阻擋 Tab 序 + AT 互動）。
     * Chromium 102+ / Safari 15.5+ / Firefox 112+ 全支援，唔需要 polyfill。
     */
    if (collapsed) this.root.setAttribute("inert", "");
    else this.root.removeAttribute("inert");

    /*
     * `full` 狀態 = 等同 modal（spec IA §5.4 / A7 §7）→ 加 dialog 語意 +
     * 對地圖加 `inert`，令 focus 唔會跑去地圖。
     * `peek` / `half` **唔做** focus trap（用戶要 Tab 返地圖）。
     */
    if (snap === "full") {
      this.root.setAttribute("role", "dialog");
      this.root.setAttribute("aria-modal", "true");
      this.root.dataset.sheetDialog = "true";
    } else {
      this.root.removeAttribute("role");
      this.root.removeAttribute("aria-modal");
      delete this.root.dataset.sheetDialog;
    }

    // 地圖 inert 由 syncMapInert() 處理（要同 #map-pane 溝通）
    this.syncMapInert(snap === "full");

    if (this.handle) {
      this.handle.setAttribute("aria-valuenow", String(SNAP_PCT[snap]));
    }
  }

  /**
   * `full` 時令地圖唔可 Tab（背景隔離）。
   *
   * ⚠️ 只處理 `#map-pane`；`#story-pane` 自己嘅 inert 由 `render()` 處理。
   */
  private syncMapInert(inert: boolean): void {
    const mapPane = document.getElementById("map-pane");
    if (!mapPane) return;
    if (inert) mapPane.setAttribute("inert", "");
    else mapPane.removeAttribute("inert");
  }

  /**
   * Esc 處理（優先次序：full → half → peek）。
   *
   * 為何要回傳 boolean：`app.ts` 嘅全域 Esc handler **唔喺 B8 allowlist**，
   * 所以 B8 唔可以改佢個次序。回傳 `true` 表示「我消費咗呢個 Esc」，
   * 令呼叫者知道唔應該再清 context。
   *
   * @returns 有冇消費事件（`false` = 已經喺 peek，交返畀 app.ts）
   */
  handleEsc(): boolean {
    const cur = this.getSnap();
    if (cur === "peek") return false;
    // full → half，half → peek（唔會直接由 full 跳 peek）
    this.setSnap(nextSnap(cur, -1));
    return true;
  }

  /** 目前嘅 snap（測試用）。 */
  get currentSnap(): SheetSnap {
    return this.getSnap();
  }

  /** 拖曳動效時長（由 token 讀，唔硬寫）。 */
  get transitionMs(): number {
    return DUR.normal;
  }

  destroy(): void {
    for (const { el, type, fn } of this.bound) el.removeEventListener(type, fn);
    this.bound = [];
    this.root.removeAttribute("inert");
    this.root.removeAttribute("role");
    this.root.removeAttribute("aria-modal");
    this.root.removeAttribute("data-sheet-snap");
  }
}

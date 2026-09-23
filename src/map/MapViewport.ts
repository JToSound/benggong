/**
 * MapViewport.ts — viewBox / pan / zoom / **rAF coalesce**（spec §2.2）。
 *
 * 為何要獨立一層
 * ==============
 * A8 P1-1 實測：pan 期間 34 個 longtask、合計 1,886 ms、**28.9–30.9 fps**
 * （idle 基準 60.2 fps）。根因係 `SvgMap.ts` 嘅 `window.mousemove` 每個
 * 事件都即刻 `applyViewBox()` → 改 `<svg viewBox>`（觸發全部 SVG 內容
 * 重繪）＋ `updateBasemapTier()` ＋ `updateLabelLayerOpacity()` ＋
 * `syncBasemapView()`。一個 16.7 ms frame 內可以收到 3–5 個 mousemove，
 * 即係做咗 3–5 倍無謂工作。
 *
 * 本層嘅契約：**手勢事件只累積，唔即刻套用**。每 frame 最多一次
 * `onChange`。手勢結束（mouseup / touchend / wheel idle）一定要 flush
 * 未套用嘅 pending view，令最終位置同手指一致 —— 否則 `touchend` 之後
 * 讀 `viewBox` 會攞到中間值（`tests/visual-smoke.e2e.test.ts` 依賴呢點）。
 */

import {
  clampView,
  pxToUserUnits,
  scaleView,
  type ViewBox,
} from "./map-camera";
import { MAX_SCALE } from "./map-lod";

export interface ViewportChange {
  view: ViewBox;
  /** "pan" = 只改位置（唔需要重排 label）；"zoom" = 尺度改變；"set" = 程式指定。 */
  kind: "pan" | "zoom" | "set";
}

export interface MapViewportOptions {
  /** pan / zoom 嘅宿主（通常係 `#svg-map`）。 */
  element: SVGSVGElement | HTMLElement;
  base: ViewBox;
  minScale?: number;
  maxScale?: number;
  /** 每次 view 真正改變（已經 rAF coalesce）時呼叫。 */
  onChange: (c: ViewportChange) => void;
  /** 手勢結束時呼叫（可以喺度做全量重繪）。 */
  onSettle?: (view: ViewBox) => void;
  /** mousedown 係唔係喺可 pan 嘅目標上。預設：一律可以。 */
  isPanTarget?: (target: Element) => boolean;
  /** wheel 之後幾多 ms 當手勢結束。預設 140。 */
  wheelSettleMs?: number;
  /**
   * 判定「真正拖曳」嘅最低累計位移（px）。預設 `PAN_THRESHOLD_PX`。
   * 低於門檻嘅抖動當「輕觸」，唔會影響 click 合成。見 `onMouseMove()`。
   */
  panThresholdPx?: number;
}

/**
 * 「真正拖曳」嘅最低累計位移（px）—— 滑鼠用。
 *
 * 為何係 4
 * --------
 * 業界慣例（Leaflet `dragging` 用 3）＋ 手指抖動比滑鼠大，
 * 所以喺 3–5 px 之間取中位 4 px。太低 → 手震令 zone 點唔到；
 * 太高 → 用戶明明想拖少少但當咗輕觸。
 *
 * ⚠️ 觸控同滑鼠唔同門檻：手指抖動明顯大過滑鼠（實測約 6–10 px）。
 * 但 `touch` 唔應該用同一個值 —— 見 `TOUCH_PAN_THRESHOLD_PX`。
 */
export const PAN_THRESHOLD_PX = 4;

/** 觸控版門檻（手指抖動比滑鼠大，用 8 px 避免「想點但當咗拖」）。 */
export const TOUCH_PAN_THRESHOLD_PX = 8;

export class MapViewport {
  private readonly el: SVGSVGElement | HTMLElement;
  private readonly base: ViewBox;
  private readonly minScale: number;
  private readonly maxScale: number;
  private readonly onChange: (c: ViewportChange) => void;
  private readonly onSettle?: (view: ViewBox) => void;
  private readonly isPanTarget: (target: Element) => boolean;
  private readonly wheelSettleMs: number;
  private readonly panThresholdPx: number;
  /** 觸控專用門檻（同 `panThresholdPx` 分開，見常數說明）。 */
  private readonly touchPanThresholdPx: number;

  private current: ViewBox;
  private pending: ViewportChange | null = null;
  private rafId = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;

  private attached = false;
  private isPanning = false;
  /** 今次手勢有冇真正移動過（見 `onMouseUp()` 嘅守衛說明）。 */
  private movedDuringPan = false;

  /**
   * 最近一次手勢係否「真正拖曳」（累計位移 ≥ 門檻）。
   *
   * ⚠️ 為何要暴露：`SvgMap` 嘅 `pointerup` 處理要跳過真正拖曳
   * （見 `bindSvgDelegation()`）—— 因為瀏覽器**可能唔合成 `click`**
   * （實測：全套測試 CPU 高負載之下，2px 微拖唔合成 `click` → 點唔到 zone），
   * 所以要自己喺 `pointerup` 判斷。
   *
   * ⚠️ 時序：`pointerup` **先於** `mouseup`（Pointer Events 規範），
   * 而 `movedDuringPan` 喺 `onMouseDown` 才重置 → `pointerup` 時讀到嘅係
   * 今次手勢嘅正確值。
   */
  get didJustPan(): boolean {
    return this.movedDuringPan;
  }
  private panStartX = 0;
  private panStartY = 0;
  private panStartView: ViewBox;

  private pinchStartDist = 0;
  private pinchStartView: ViewBox;

  constructor(opts: MapViewportOptions) {
    this.el = opts.element;
    this.base = opts.base;
    this.minScale = opts.minScale ?? 1;
    // ⚠️ 預設係 LOD 政策嘅 `MAX_SCALE`（spec §3.1：Z8 必須可達），
    // 唔再係舊值 64（0.70/64 = 0.0109° = Z6.0 → Z7／Z8 不可達）。
    this.maxScale = opts.maxScale ?? MAX_SCALE;
    this.onChange = opts.onChange;
    this.onSettle = opts.onSettle;
    this.isPanTarget = opts.isPanTarget ?? (() => true);
    this.wheelSettleMs = opts.wheelSettleMs ?? 140;
    this.panThresholdPx = opts.panThresholdPx ?? PAN_THRESHOLD_PX;
    this.touchPanThresholdPx = TOUCH_PAN_THRESHOLD_PX;
    this.current = { ...opts.base };
    this.panStartView = { ...opts.base };
    this.pinchStartView = { ...opts.base };
  }

  get view(): ViewBox {
    return this.pending ? { ...this.pending.view } : { ...this.current };
  }

  /** 相對基準嘅縮放倍率（1 = 全港）。 */
  get scale(): number {
    return this.base.w / this.view.w;
  }

  /** 直接設（唔動畫）。 */
  setView(view: ViewBox, kind: ViewportChange["kind"] = "set"): void {
    this.queue({ view: clampView(view, this.base), kind }, true);
  }

  /** 以視圖中心縮放。 */
  zoomBy(factor: number): void {
    this.queue(
      {
        view: scaleView(this.view, this.base, factor, {
          maxScale: this.maxScale,
          minScale: this.minScale,
        }),
        kind: "zoom",
      },
      true,
    );
  }

  /** 以畫面某點（0–1 比例）為錨縮放 —— 雙指縮放用。 */
  zoomByAt(factor: number, anchorFrac: { fx: number; fy: number }): void {
    this.queue(
      {
        view: scaleView(this.view, this.base, factor, {
          maxScale: this.maxScale,
          minScale: this.minScale,
          anchorFrac,
        }),
        kind: "zoom",
      },
      true,
    );
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.el.addEventListener("mousedown", this.onMouseDown as EventListener);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.el.addEventListener("wheel", this.onWheel as EventListener, { passive: false });
    this.el.addEventListener("touchstart", this.onTouchStart as EventListener, { passive: true });
    this.el.addEventListener("touchmove", this.onTouchMove as EventListener, { passive: true });
    this.el.addEventListener("touchend", this.onTouchEnd as EventListener, { passive: true });
    this.el.addEventListener("touchcancel", this.onTouchEnd as EventListener, { passive: true });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.el.removeEventListener("mousedown", this.onMouseDown as EventListener);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.el.removeEventListener("wheel", this.onWheel as EventListener);
    this.el.removeEventListener("touchstart", this.onTouchStart as EventListener);
    this.el.removeEventListener("touchmove", this.onTouchMove as EventListener);
    this.el.removeEventListener("touchend", this.onTouchEnd as EventListener);
    this.el.removeEventListener("touchcancel", this.onTouchEnd as EventListener);
  }

  dispose(): void {
    this.detach();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.pending = null;
  }

  // ------------------------------------------------------------------
  // rAF coalesce
  // ------------------------------------------------------------------

  /**
   * 累積一次變更。
   *
   * @param immediate true = 即刻套用（程式呼叫，例如 `#map-zoom-in` 按鈕、
   *                  flyTo 完成）；false = 等下一個 frame（手勢事件）。
   */
  private queue(c: ViewportChange, immediate: boolean): void {
    if (this.pending && this.pending.kind !== c.kind) {
      // 同一 frame 內同時 pan 同 zoom → 當 zoom（下游要重排 label）
      if (c.kind !== "pan") this.pending = { view: c.view, kind: c.kind };
      else this.pending = { view: c.view, kind: "zoom" };
    } else {
      this.pending = { view: c.view, kind: c.kind };
    }
    if (immediate) {
      this.flush();
      return;
    }
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.flush();
    });
  }

  /** 套用 pending（如果有）。 */
  private flush(): void {
    if (!this.pending) return;
    const c = this.pending;
    this.pending = null;
    this.current = c.view;
    this.onChange(c);
  }

  private settle(): void {
    this.flush();
    this.onSettle?.(this.current);
  }

  // ------------------------------------------------------------------
  // 手勢
  // ------------------------------------------------------------------

  private rect(): DOMRect {
    return this.el.getBoundingClientRect();
  }

  private onMouseDown = (e: MouseEvent): void => {
    const t = e.target as Element | null;
    if (!t || !this.isPanTarget(t)) return;
    this.isPanning = true;
    this.movedDuringPan = false;
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;
    this.panStartView = this.view;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isPanning) return;
    const r = this.rect();
    if (r.width === 0 || r.height === 0) return;
    /*
     * ⚠️ 要**累計位移**超過門檻才算拖曳（唔係「一有 mousemove 就算」）。
     *
     * 為何需要門檻（B6 修正，2026-09-22）
     * --------------------------------
     * 原本一收 mousemove 就 `movedDuringPan = true`。但滑鼠係有抖動嘅
     * （高 DPI 滑鼠、手震、觸控板誤觸），1 px 位移就足以令
     * `onMouseUp()` 唔早退 → 照 `settle()` → 重建 layer → click 消失
     * → 用戶「點極都點唔中」。業界慣例（Leaflet `dragging`）係 3–5 px。
     *
     * 計法用「起點到當前」嘅歐氏距離 —— 來回抖動唔會累加成大位移
     * （用 path length 會，反而更容易誤判）。
     */
    const dx = e.clientX - this.panStartX;
    const dy = e.clientY - this.panStartY;
    if (Math.hypot(dx, dy) < this.panThresholdPx) return;
    this.movedDuringPan = true;
    const u = pxToUserUnits(this.panStartView, r.width, r.height);
    this.queue(
      {
        view: clampView(
          {
            ...this.panStartView,
            x: this.panStartView.x - (e.clientX - this.panStartX) * u,
            y: this.panStartView.y - (e.clientY - this.panStartY) * u,
          },
          this.base,
        ),
        kind: "pan",
      },
      false,
    );
  };

  private onMouseUp = (): void => {
    if (!this.isPanning) return;
    this.isPanning = false;
    /*
     * ⚠️ 只有真正拖曳過（`pending` 或者 `current` 有變）才 settle。
     *
     * 為何要呢個守衛（B6 實測踩過）
     * ---------------------------
     * `settle()` → `onSettle()` → `SvgMap.render()` → `#zones-layer`
     * `replaceChildren()`。mouseup 係喺 **click 合成之前** 派發嘅 —— 如果
     * mouseup 期間就重建咗個 layer，mousedown 嗰個 `.zone-area` 會被換走，
     * 瀏覽器就**唔會**再合成 `click`（DOM 規範：mousedown 同 mouseup 嘅
     * target 唔再係同一條 ancestor 鏈）。結果：zone 完全點唔到，
     * 即使 CSS `pointer-events: auto` 同 `elementFromPoint()` 命中都正常。
     *
     * 守衛之後：純粹「按下冇拖」→ 唔重建 → click 正常派發 → zone 可選中；
     * 真正拖曳過 → 照樣 settle（唔會漏 update）。
     */
    if (!this.pending && !this.movedDuringPan) return;
    this.settle();
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.queue(
      {
        view: scaleView(this.view, this.base, e.deltaY > 0 ? 0.9 : 1.1, {
          maxScale: this.maxScale,
          minScale: this.minScale,
        }),
        kind: "zoom",
      },
      false,
    );
    // 滾輪冇「結束」事件 → 用 debounce 當手勢結束
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      this.settle();
    }, this.wheelSettleMs);
  };

  private onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length === 1) {
      this.isPanning = true;
      this.movedDuringPan = false;
      this.panStartX = e.touches[0].clientX;
      this.panStartY = e.touches[0].clientY;
      this.panStartView = this.view;
    } else if (e.touches.length === 2) {
      this.isPanning = false;
      this.pinchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      this.pinchStartView = this.view;
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (e.touches.length === 1 && this.isPanning) {
      const r = this.rect();
      if (r.width === 0 || r.height === 0) return;
      // 同滑鼠一樣要累計位移門檻（觸控用較大值，見常數說明）
      const dx = e.touches[0].clientX - this.panStartX;
      const dy = e.touches[0].clientY - this.panStartY;
      if (Math.hypot(dx, dy) < this.touchPanThresholdPx) return;
      this.movedDuringPan = true;
      const u = pxToUserUnits(this.panStartView, r.width, r.height);
      this.queue(
        {
          view: clampView(
            {
              ...this.panStartView,
              x: this.panStartView.x - (e.touches[0].clientX - this.panStartX) * u,
              y: this.panStartView.y - (e.touches[0].clientY - this.panStartY) * u,
            },
            this.base,
          ),
          kind: "pan",
        },
        false,
      );
      return;
    }
    if (e.touches.length === 2 && this.pinchStartDist > 0) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      const factor = dist / this.pinchStartDist;
      const r = this.rect();
      let anchorFrac: { fx: number; fy: number } | undefined;
      if (r.width > 0 && r.height > 0) {
        /*
         * 以**雙指中點**為錨，而唔係視圖中心。
         * 用戶捏兩隻手指嘅位置就係佢想放大嘅位置；以視圖中心縮放會令
         * 手指以外嘅內容移走，感覺「唔跟手」。
         */
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        anchorFrac = {
          fx: (midX - r.left) / r.width,
          fy: (midY - r.top) / r.height,
        };
      }
      this.queue(
        {
          view: scaleView(this.pinchStartView, this.base, factor, {
            maxScale: this.maxScale,
            minScale: this.minScale,
            anchorFrac,
          }),
          kind: "zoom",
        },
        false,
      );
    }
  };

  private onTouchEnd = (): void => {
    const hadPan = this.isPanning && this.movedDuringPan;
    const hadPinch = this.pinchStartDist > 0;
    this.isPanning = false;
    this.movedDuringPan = false;
    this.pinchStartDist = 0;
    /*
     * ⚠️ 同一守衛理由（見 `onMouseUp()`）：純輕觸唔可以重建圖層，
     * 否則 `touchend` 之後合成嘅 `click` 會因為 target 被換走而消失
     * （手機上 zone 會點唔到）。
     */
    if (!this.pending && !hadPan && !hadPinch) return;
    this.settle();
  };
}

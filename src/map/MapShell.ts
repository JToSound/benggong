/**
 * MapShell.ts — 容器、生命週期同 **layer 註冊介面**（spec §2.2）。
 *
 * 為何要有呢一層
 * ==============
 * V2 嘅目標架構係 12 個模組（spec §2.2），其中 5 個係 layer
 * （`ZoneLayer` / `EventLayer` / `RouteLayer` / `MarkerLayer` / `LabelLayer`），
 * 由 **B6** 擁有。但 B6 唔應該改 `SvgMap.ts` 嘅 1,646 行巨石 —— 佢需要
 * 一個穩定嘅插入點。
 *
 * 本檔就係嗰個插入點：
 *   · `Layer` 介面（`mount` / `update` / `dispose`）；
 *   · z-order 由 `priority` 決定（spec §2.3 hit priority）；
 *   · 每個 layer 一個 `<g data-layer="<id>">`，唔會互相污染；
 *   · `LayerContext` 已經算好 `tier` / `zoneLod` / `chapterWindow`，
 *     所以 layer 唔需要自己知 `map-lod.ts` 嘅門檻。
 *
 * 規則 R3（spec §2.2）：layer 更新**必須** incremental —— `update()` 收
 * `LayerPatch`，layer 應該只喺相關欄位變咗時才重建自己嘅 DOM。
 */

import type { App } from "../app";
import type { AppData } from "../data/loadAllData";
import {
  CHAPTER_WINDOW,
  MAX_SCALE,
  selectTier,
  selectZoneLod,
  type LodTier,
  type ZoneLod,
} from "./map-lod";
import { MapViewport } from "./MapViewport";
import type { ViewBox } from "./map-camera";

/** 每次 layer 更新時傳入嘅唯讀快照。 */
export interface LayerContext {
  /** layer 掛載用嘅 `<g>`（由 MapShell 建，帶 `data-layer="<id>"`）。 */
  group: SVGGElement;
  view: ViewBox;
  /** viewBox 寬（度）—— LOD 政策嘅唯一輸入。 */
  viewW: number;
  /** `selectTier(viewW)` 嘅結果。 */
  tier: LodTier;
  /** `selectZoneLod(viewW)` 嘅結果。 */
  zoneLod: ZoneLod;
  /** 目前章節（1-based）。 */
  chapter: number;
  selected: {
    zoneId: string | null;
    eventId: string | null;
    locationId: string | null;
    routeId: string | null;
  };
  /** 章節窗口政策（spec §3.3）。 */
  chapterWindow: { location: number; event: number; showAll: boolean };
  /** 唯讀資料（B3 保證 `AppData` shape 不變）。 */
  data: AppData;
}

/** 局部更新（唔傳嘅欄位代表「冇變」）。 */
export interface LayerPatch {
  view?: ViewBox;
  chapter?: number;
  selected?: Partial<LayerContext["selected"]>;
  chapterWindow?: Partial<LayerContext["chapterWindow"]>;
  /** `true` = 強制全量重建。 */
  force?: boolean;
}

export interface MapLayer {
  /** 唯一 id（會成為 `data-layer`）。 */
  readonly id: string;
  /** hit priority：數字越大越上層（spec §2.3）。 */
  readonly priority?: number;
  /** 可選：自己提供掛載點（例如 `SvgMap` 嘅 `#map-content`）。 */
  readonly group?: SVGGElement;
  mount(ctx: LayerContext): void;
  update(ctx: LayerContext, patch: LayerPatch): void;
  dispose(): void;
}

export type SimpleLayerRenderer = (ctx: LayerContext, patch: LayerPatch) => void;

export interface MapShellOptions {
  app: App;
  svg: SVGSVGElement;
  /** layer 掛載點（`SvgMap` 傳 `#map-content`）。 */
  layersRoot: SVGGElement;
  base: ViewBox;
  minScale?: number;
  /**
   * 縮放上限提示。
   *
   * ⚠️ 只可以**再放寬**，唔可以收窄過 LOD 政策嘅 `MAX_SCALE`（見下方
   * `Math.max(...)` 嘅說明）。`SvgMap` 仍傳入 legacy 值 64，會被下限擋住。
   */
  maxScale?: number;
  onChange?: (patch: LayerPatch) => void;
  onSettle?: (view: ViewBox) => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export class MapShell {
  private readonly app: App;
  private readonly svg: SVGSVGElement;
  private readonly layersRoot: SVGGElement;
  private readonly registry = new Map<string, MapLayer>();
  private readonly groups = new Map<string, SVGGElement>();
  private readonly onChange?: (patch: LayerPatch) => void;
  private readonly onSettle?: (view: ViewBox) => void;

  private showAllEvents = false;
  private routeId: string | null = null;
  private readonly viewport: MapViewport;
  private disposed = false;

  constructor(root: HTMLElement, opts: MapShellOptions) {
    void root;
    this.app = opts.app;
    this.svg = opts.svg;
    this.layersRoot = opts.layersRoot;
    this.onChange = opts.onChange;
    this.onSettle = opts.onSettle;
    /*
     * ⚠️ 縮放上限：以 LOD 政策嘅 `MAX_SCALE` 做**下限**，唔可以收窄。
     *
     * `SvgMap` 仍然硬寫 `MAX_SCALE = 64` 並傳入（該檔唔喺本 pass 可寫
     * 範圍）。若原封不動轉發，最窄 viewW = 0.70 / 64 = 0.0109° = Z6.0
     * → spec §3.1 嘅 Z7／Z8 物理上不可達（B9 Q1 `needs_review`）。
     *
     * 所以呢度計 `max(傳入值, MAX_SCALE)`：
     *   · 傳入 64（legacy）→ 用政策值 280（最窄 0.0025° = Z8.13）；
     *   · 傳入更大嘅值（例如測試想再深）→ 照用，唔會封頂。
     * `MapShell` 係 viewport 政策嘅唯一出口，所以呢個下限喺度落最合適。
     */
    this.viewport = new MapViewport({
      element: opts.svg,
      base: opts.base,
      minScale: opts.minScale,
      maxScale: Math.max(opts.maxScale ?? MAX_SCALE, MAX_SCALE),
      onChange: (c) => this.onChange?.({ view: c.view }),
      onSettle: (v) => this.onSettle?.(v),
    });
  }

  // ------------------------------------------------------------------
  // Layer 註冊
  // ------------------------------------------------------------------

  /** 註冊 layer；回傳解除註冊函式。同 id 重複註冊 → 舊嘅先 dispose。 */
  register(layer: MapLayer): () => void {
    if (this.registry.has(layer.id)) this.unregister(layer.id);
    this.registry.set(layer.id, layer);
    const ctx = this.contextFor(layer);
    layer.mount(ctx);
    return () => this.unregister(layer.id);
  }

  /** 便利版：直接用 renderer 函數註冊。 */
  registerRenderer(
    id: string,
    priority: number,
    render: SimpleLayerRenderer,
    group?: SVGGElement,
  ): () => void {
    let mounted = false;
    const layer: MapLayer = {
      id,
      priority,
      group,
      mount: (ctx) => {
        mounted = true;
        render(ctx, { force: true });
      },
      update: (ctx, patch) => {
        if (mounted) render(ctx, patch);
      },
      dispose: () => {
        mounted = false;
      },
    };
    return this.register(layer);
  }

  unregister(id: string): void {
    const layer = this.registry.get(id);
    if (!layer) return;
    layer.dispose();
    this.registry.delete(id);
    const g = this.groups.get(id);
    if (g) {
      g.replaceChildren();
      if (!layer.group) g.remove();
      this.groups.delete(id);
    }
  }

  /** 目前註冊嘅 layer（按 priority 升序 = 繪製次序）。 */
  get layers(): readonly MapLayer[] {
    return [...this.registry.values()].sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
    );
  }

  /** 建／取 layer 嘅 `<g>`。 */
  groupFor(id: string, external?: SVGGElement): SVGGElement {
    if (external) {
      this.groups.set(id, external);
      return external;
    }
    const existing = this.groups.get(id);
    if (existing) return existing;
    const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
    g.setAttribute("class", `map-layer map-layer-${id}`);
    g.setAttribute("data-layer", id);
    this.layersRoot.appendChild(g);
    this.groups.set(id, g);
    return g;
  }

  clearLayer(id: string): void {
    this.groups.get(id)?.replaceChildren();
  }

  // ------------------------------------------------------------------
  // 更新
  // ------------------------------------------------------------------

  setShowAllEvents(showAll: boolean): void {
    this.showAllEvents = showAll;
  }

  get showAllEventsEnabled(): boolean {
    return this.showAllEvents;
  }

  setSelectedRoute(routeId: string | null): void {
    this.routeId = routeId;
  }

  private contextFor(layer: MapLayer): LayerContext {
    const view = this.viewport.view;
    const viewW = view.w;
    return {
      group: this.groupFor(layer.id, layer.group),
      view,
      viewW,
      tier: selectTier(viewW),
      zoneLod: selectZoneLod(viewW),
      chapter: this.app.getCurrentChapter(),
      selected: {
        zoneId: this.app.getSelectedZoneId(),
        eventId: this.app.selectedEventId,
        locationId: this.app.selectedLocationId,
        routeId: this.routeId,
      },
      chapterWindow: {
        location: CHAPTER_WINDOW.location,
        event: CHAPTER_WINDOW.event,
        showAll: this.showAllEvents,
      },
      data: this.app.data,
    };
  }

  /** 更新所有 layer。`patch` 為 undefined = 全量。 */
  update(patch?: LayerPatch): void {
    if (this.disposed) return;
    for (const layer of this.layers) {
      layer.update(this.contextFor(layer), patch ?? {});
    }
  }

  // ------------------------------------------------------------------
  // 相機
  // ------------------------------------------------------------------

  get view(): ViewBox {
    return this.viewport.view;
  }

  setView(view: ViewBox, kind: "pan" | "zoom" | "set" = "set"): void {
    this.viewport.setView(view, kind);
  }

  get viewportRef(): MapViewport {
    return this.viewport;
  }

  attach(): void {
    this.viewport.attach();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const layer of this.layers) layer.dispose();
    this.registry.clear();
    this.viewport.dispose();
    for (const [id, g] of this.groups) {
      if (!this.registry.has(id)) g.replaceChildren();
    }
    this.groups.clear();
    this.svg.dataset.mapShellDisposed = "1";
  }
}

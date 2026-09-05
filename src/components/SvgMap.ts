/**
 * SvgMap: 將軍澳 SVG basemap + markers for events/locations + routes.
 * 互動:
 * - Hover marker → tooltip
 * - Click marker → select, open detail panel
 * - Drag to pan
 * - Wheel to zoom
 */

import type { App } from "../app";
import type { AppData, RouteFeature, EventFeature } from "../data/loadAllData";
import basemapSvgRaw from "../../public/assets/tseung-kwan-o-basemap.svg?raw";

const VIEWBOX = "113.85 22.18 0.60 0.37";

/**
 * Extract inner content of <svg>...</svg> 嘅 SVG markup。
 * Phase E：inline 載入 basemap，避免 <image href> CORS / path 問題。
 */
function extractBasemapInner(svg: string): string {
  // Skip XML declaration
  const s = svg.replace(/<\?xml[^?]*\?>/g, "");
  // 抽出 <svg ...> 開 tag 嘅 inner content
  const openMatch = s.match(/<svg[^>]*>/i);
  if (!openMatch) return "";
  const closeIdx = s.lastIndexOf("</svg>");
  if (closeIdx < 0) return "";
  return s.slice(openMatch.index! + openMatch[0].length, closeIdx);
}

export class SvgMap {
  root: HTMLElement;
  app: App;
  data: AppData;
  svg!: SVGSVGElement;

  // Map state
  viewX = 0;
  viewY = 0;
  viewScale = 1.0;

  constructor(root: HTMLElement, app: App) {
    this.root = root;
    this.app = app;
    this.data = app.data;
    this.init();
  }

  private init(): void {
    this.root.innerHTML = `
      <div class="svg-map-wrap">
        <svg id="svg-map" class="svg-map" viewBox="${VIEWBOX}" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="markerGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="0.0015" result="blur"/>
              <feMerge>
                <feMergeNode in="blur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
            <pattern id="paperTexture" width="0.02" height="0.02" patternUnits="userSpaceOnUse">
              <circle cx="0.005" cy="0.005" r="0.0005" fill="#a8c8e8" opacity="0.15"/>
              <circle cx="0.015" cy="0.012" r="0.0005" fill="#88a8c8" opacity="0.15"/>
            </pattern>
          </defs>
          <g id="map-content"></g>
        </svg>
        <div class="map-overlay" id="map-overlay"></div>
        <div class="map-controls">
          <button id="map-zoom-in" class="map-ctrl" title="放大">+</button>
          <button id="map-zoom-out" class="map-ctrl" title="縮小">−</button>
          <button id="map-reset" class="map-ctrl" title="重置視圖">⌂</button>
        </div>
      </div>
    `;
    this.svg = this.root.querySelector("#svg-map")!;
    this.bindEvents();
    this.render();
  }

  private bindEvents(): void {
    this.root.querySelector("#map-zoom-in")!.addEventListener("click", () => {
      this.viewScale = Math.min(4, this.viewScale * 1.3);
      this.render();
    });
    this.root.querySelector("#map-zoom-out")!.addEventListener("click", () => {
      this.viewScale = Math.max(0.5, this.viewScale / 1.3);
      this.render();
    });
    this.root.querySelector("#map-reset")!.addEventListener("click", () => {
      this.viewScale = 1.0;
      this.viewX = 0;
      this.viewY = 0;
      this.render();
    });

    // Marker click delegation
    this.svg.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.classList.contains("event-marker")) {
        const id = t.getAttribute("data-event-id");
        if (id) this.app.setSelectedEvent(id);
      } else if (t.classList.contains("location-marker")) {
        const id = t.getAttribute("data-loc-id");
        if (id) this.app.setSelectedLocation(id);
      } else if (t.classList.contains("route-line")) {
        const id = t.getAttribute("data-route-id");
        if (id) {
          const route = this.data.routes.features.find((f) => f.properties.id === id);
          if (route) this.app.setChapter(route.properties.chapters_span[0]);
        }
      }
    });

    // Pan
    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    this.svg.addEventListener("mousedown", (e) => {
      if ((e.target as Element).tagName === "svg" || (e.target as Element).id === "basemap-group") {
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (!isPanning) return;
      const dx = (e.clientX - panStartX) / 400 * 0.3;
      const dy = (e.clientY - panStartY) / 400 * 0.2;
      this.viewX = dx;
      this.viewY = -dy;
      this.render();
    });
    window.addEventListener("mouseup", () => { isPanning = false; });

    // Wheel zoom
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.viewScale = Math.max(0.5, Math.min(4, this.viewScale * factor));
      this.render();
          }, { passive: false });
        }

        render(): void {
    const content = this.svg.querySelector("#map-content")!;
    const cur = this.app.getCurrentChapter();

    // Apply viewBox transform
    const [vx, vy, vw, vh] = VIEWBOX.split(" ").map(parseFloat);
    const cx = vx + vw / 2 - this.viewX;
    const cy = vy + vh / 2 - this.viewY;
    const newW = vw / this.viewScale;
    const newH = vh / this.viewScale;
    this.svg.setAttribute("viewBox", `${cx - newW/2} ${cy - newH/2} ${newW} ${newH}`);

    // Inline the basemap SVG content (Vite ?raw import - extract <g id="basemap-content">)
    const basemapInner = extractBasemapInner(basemapSvgRaw);

    // Active character routes (show routes for current chapter)
    const activeRoutes = (this.data.routesByChapter.get(cur) || []).filter((r: RouteFeature) => {
      const span = r.properties.chapters_span;
      return span && cur >= span[0] && cur <= span[1];
    });

    // Active locations (Phase E: 只顯示 current chapter ± 3 嘅 locations，避免大 cluster)
    const locationsToShow = this.data.locations.features.filter((l) => {
      const fp = l.properties.first_appearance;
      const chs = l.properties.chapters || [fp];
      return chs.some((c: number) => Math.abs(c - cur) <= 3) || fp === cur;
    });

    // Active events (current chapter + 1-2 surrounding for context)
    const eventsToShow: EventFeature[] = [];
    for (let d = -1; d <= 1; d++) {
      const ch = cur + d;
      const evs = this.data.eventsByChapter.get(ch) || [];
      eventsToShow.push(...evs);
    }

    content.innerHTML = `
      <g id="basemap-group" class="basemap-layer">${basemapInner}</g>
      <g id="routes-layer" class="routes-layer"></g>
      <g id="locations-layer" class="locations-layer"></g>
      <g id="events-layer" class="events-layer"></g>
    `;

    // Render routes
    const routesLayer = content.querySelector("#routes-layer")!;
    for (const route of activeRoutes) {
      const coords = route.geometry.coordinates as [number, number][];
      if (coords.length < 2) continue;
      const d = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c[0]} ${c[1]}`).join(" ");
      const span = route.properties.chapters_span;
      const opacity = cur >= span[0] && cur <= span[1] ? 0.7 : 0.2;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
      el.setAttribute("d", d);
      el.setAttribute("class", "route-line");
      el.setAttribute("stroke", route.properties.color || "#F39C12");
      el.setAttribute("stroke-width", "0.0015");
      el.setAttribute("fill", "none");
      el.setAttribute("opacity", String(opacity));
      el.setAttribute("data-route-id", route.properties.id);
      el.setAttribute("data-character-name", route.properties.character_name);
      const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
      titleEl.textContent = `${route.properties.character_name} 路線 (ch${span[0]}-${span[1]})`;
      el.appendChild(titleEl);
      routesLayer.appendChild(el);
    }

    // Render locations (only those in current chapter area)
    const locLayer = content.querySelector("#locations-layer")!;
    for (const loc of locationsToShow) {
      const coords = loc.geometry.coordinates as [number, number];
      const props = loc.properties;
      const active = props.chapters.includes(cur) || (props.first_appearance <= cur && cur < props.first_appearance + 5);
      const isSelected = this.app.selectedLocationId === props.id;
      const r = active ? 0.005 : 0.002;
      const fill = isSelected ? "#ffeb3b" : (props.fictional ? "#9b59b6" : "#e67e22");
      const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      el.setAttribute("cx", String(coords[0]));
      el.setAttribute("cy", String(coords[1]));
      el.setAttribute("r", String(r));
      el.setAttribute("class", "location-marker");
      el.setAttribute("fill", fill);
      el.setAttribute("stroke", "#fff");
      el.setAttribute("stroke-width", "0.0008");
      el.setAttribute("opacity", String(active ? 0.9 : 0.45));
      el.setAttribute("data-loc-id", props.id);
      el.setAttribute("data-loc-name", props.name);
      const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
      titleEl.textContent = `${props.name}（ch${props.first_appearance}）`;
      el.appendChild(titleEl);
      locLayer.appendChild(el);
    }

    // Render events (current chapter prominent)
    const evLayer = content.querySelector("#events-layer")!;
    for (const ev of eventsToShow) {
      const coords = ev.geometry.coordinates as [number, number];
      const props = ev.properties;
      const isCurrent = props.chapter === cur;
      const isSelected = this.app.selectedEventId === props.id;
      const r = isCurrent ? 0.008 : 0.005;
      const fill = isSelected ? "#ff5252" : (isCurrent ? "#e74c3c" : "#f39c12");
      const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      el.setAttribute("cx", String(coords[0]));
      el.setAttribute("cy", String(coords[1]));
      el.setAttribute("r", String(r));
      el.setAttribute("class", "event-marker");
      el.setAttribute("fill", fill);
      el.setAttribute("stroke", "#fff");
      el.setAttribute("stroke-width", "0.001");
      el.setAttribute("opacity", String(isCurrent ? 1.0 : 0.6));
      el.setAttribute("data-event-id", props.id);
      el.setAttribute("data-event-title", props.title);
      const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
      titleEl.textContent = `[ch${props.chapter}] ${props.title}`;
      el.appendChild(titleEl);
      evLayer.appendChild(el);
    }
  }

  flyToChapter(_ch: number): void {
    // Optional: pan slightly to focus events of this chapter
    this.render();
  }
}

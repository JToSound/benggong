/**
 * SvgMap: HK territory OSM basemap (PNG) + markers for events/locations + routes.
 * 互動:
 * - Hover marker → tooltip
 * - Click marker → select, open detail panel
 * - Drag to pan
 * - Wheel to zoom
 *
 * Phase G: basemap is generated procedurally from OpenStreetMap vector
 * data via scripts/render_hk_basemap.py. PNG image covers full HK bbox
 * 113.85-114.45 lon, 22.18-22.55 lat. Markers are positioned by direct
 * lon/lat → SVG-coordinate projection.
 */

import type { App } from "../app";
import type { AppData, RouteFeature, EventFeature } from "../data/loadAllData";
import basemapPngUrl from "../../public/assets/hk-basemap.png?url";
import basemapCoords from "../../public/assets/hk-basemap-coords.json";

const VIEWBOX = "113.85 22.18 0.60 0.37";

// Basemap image (PNG, OSM-derived, dark game-style) covers the same
// bbox as VIEWBOX, so we render the image as <image x=113.85 y=22.18
// width=0.60 height=0.37> in SVG user units. Coords metadata for front-end.
const BASEMAP_PNG = basemapPngUrl;
const BASEMAP_BBOX = (basemapCoords as { bbox: { lon_min: number; lon_max: number; lat_min: number; lat_max: number } }).bbox;

// Locations whose dataset lon/lat falls outside HK bbox get a curated
// fallback (some story locations are fictional, e.g. 艾寶琳倖存區 /
// 病者之都, and OSM has no record for those).
const FALLBACK_ANCHORS: Record<string, { lon: number; lat: number }> = {
  // Tseung Kwan O fictional / off-grid
  "艾寶琳倖存區": { lon: 114.27, lat: 22.31 },
  "艾寶琳":        { lon: 114.27, lat: 22.31 },
  "寶琳倖存區":    { lon: 114.27, lat: 22.31 },
  "病者之都":      { lon: 114.20, lat: 22.30 },
  "病者平權組織":  { lon: 114.27, lat: 22.32 },
  "不良人":        { lon: 114.30, lat: 22.30 },
  "大本營":        { lon: 114.265, lat: 22.315 },
  "大本營市集":    { lon: 114.265, lat: 22.318 },
  "將軍澳地鐵站":  { lon: 114.260, lat: 22.318 },
  "坑口地鐵站":    { lon: 114.265, lat: 22.316 },
  "調景嶺地鐵站":  { lon: 114.255, lat: 22.305 },
  "寶琳地鐵站":    { lon: 114.255, lat: 22.320 },
  "日出康城地鐵站":{ lon: 114.275, lat: 22.295 },
  "康城":          { lon: 114.275, lat: 22.295 },
  "將軍澳醫院":    { lon: 114.250, lat: 22.320 },
  "調景嶺體育館":  { lon: 114.255, lat: 22.310 },
  "香港知專設計學院": { lon: 114.262, lat: 22.314 },
  "TKO Spot":      { lon: 114.260, lat: 22.310 },
  "寶盈花園":      { lon: 114.262, lat: 22.317 },
  "將軍澳中心":    { lon: 114.265, lat: 22.318 },
  "東港城":        { lon: 114.265, lat: 22.317 },
  "PopCorn":       { lon: 114.265, lat: 22.317 },
  "MCP":           { lon: 114.265, lat: 22.318 },
  "尚德":          { lon: 114.262, lat: 22.318 },
  "彩明":          { lon: 114.265, lat: 22.316 },
  "厚德":          { lon: 114.262, lat: 22.318 },
  "唐明":          { lon: 114.265, lat: 22.316 },
  "富康":          { lon: 114.262, lat: 22.318 },
  "英明":          { lon: 114.265, lat: 22.316 },
  "廣明":          { lon: 114.265, lat: 22.316 },
  "景明":          { lon: 114.265, lat: 22.316 },
  "港澳碼頭":      { lon: 114.150, lat: 22.290 },
  "中環碼頭":      { lon: 114.158, lat: 22.285 },
  "尖沙咀碼頭":    { lon: 114.170, lat: 22.295 },
};

function lonlatToViewbox(lon: number, lat: number): { x: number; y: number } {
  // Direct linear projection: bbox spans VIEWBOX exactly. If lon/lat is
  // outside the bbox, the result is clamped to the viewbox edge.
  //
  // Note on axis: the SVG viewBox maps to (113.85, 22.18) at top-left and
  // (114.45, 22.55) at bottom-right, so the SVG y-axis points DOWN. But
  // geographic latitude points UP (larger lat = further north). Therefore
  // we invert the y fraction so that lat_max (northernmost) lines up with
  // the viewbox TOP (smaller y).
  const x = Math.max(
    BASEMAP_BBOX.lon_min,
    Math.min(BASEMAP_BBOX.lon_max, lon),
  );
  const y = Math.max(
    BASEMAP_BBOX.lat_min,
    Math.min(BASEMAP_BBOX.lat_max, lat),
  );
  const fx = (x - BASEMAP_BBOX.lon_min) / (BASEMAP_BBOX.lon_max - BASEMAP_BBOX.lon_min);
  const fy = (BASEMAP_BBOX.lat_max - y) / (BASEMAP_BBOX.lat_max - BASEMAP_BBOX.lat_min);
  return {
    x: 113.85 + fx * 0.60,
    y: 22.18 + fy * 0.37,
  };
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
      <image id="basemap-group" class="basemap-layer" href="${BASEMAP_PNG}" x="113.85" y="22.18" width="0.60" height="0.37" preserveAspectRatio="xMidYMid slice" />
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
      const props = loc.properties;
      // Project lon/lat → viewbox coords. Locations outside the basemap
      // bbox (e.g. fictional 艾寶琳倖存區) fall back to curated coords.
      const raw = loc.geometry.coordinates as [number, number];
      const fallback = FALLBACK_ANCHORS[props.name];
      const lon = fallback ? fallback.lon : raw[0];
      const lat = fallback ? fallback.lat : raw[1];
      const { x, y } = lonlatToViewbox(lon, lat);
      const active = props.chapters.includes(cur) || (props.first_appearance <= cur && cur < props.first_appearance + 5);
      const isSelected = this.app.selectedLocationId === props.id;
      const r = active ? 0.005 : 0.002;
      const fill = isSelected ? "#ffeb3b" : (props.fictional ? "#9b59b6" : "#e67e22");
      const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      el.setAttribute("cx", String(x));
      el.setAttribute("cy", String(y));
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
      const props = ev.properties;
      const raw = ev.geometry.coordinates as [number, number];
      // For events, also check if their location has a curated anchor;
      // otherwise use the event's own lon/lat.
      const loc = props.location_id
        ? this.data.locations.features.find((l) => l.properties.id === props.location_id)
        : undefined;
      const fb = loc ? FALLBACK_ANCHORS[loc.properties.name] : undefined;
      const lon = fb ? fb.lon : raw[0];
      const lat = fb ? fb.lat : raw[1];
      const { x, y } = lonlatToViewbox(lon, lat);
      const isCurrent = props.chapter === cur;
      const isSelected = this.app.selectedEventId === props.id;
      const r = isCurrent ? 0.008 : 0.005;
      const fill = isSelected ? "#ff5252" : (isCurrent ? "#e74c3c" : "#f39c12");
      const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      el.setAttribute("cx", String(x));
      el.setAttribute("cy", String(y));
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

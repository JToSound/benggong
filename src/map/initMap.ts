// 《病港》主地圖 — Leaflet + 本機 story_position 投影
// Phase C 前暫用純色圓點 markers；tiles 到位後換 story-cartography 圖層。
// 網絡紅線：零外部 tile/CDN 請求。

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  filterFeaturesBySpoiler,
  loadDataset,
  type LoadResult,
} from "../data/loadDataset";
import type { EventFeature } from "../types/dataset";

const STORY_BOUNDS: L.LatLngBoundsExpression = [
  [22.15, 113.8],
  [22.5, 114.4],
];

/** story_position (0–1) → Leaflet LatLng（等比投影到香港範圍附近；非真實坐標） */
export function storyToLatLng(sp: { x: number; y: number }): L.LatLng {
  const lat = 22.15 + sp.y * 0.35;
  const lng = 113.8 + sp.x * 0.6;
  return L.latLng(lat, lng);
}

function eventIcon(eventType: string): L.DivIcon {
  const color =
    {
      major: "#E74C3C",
      battle: "#C0392B",
      death: "#7F1D1D",
      discovery: "#F39C12",
      reunion: "#2ECC71",
      travel: "#3498DB",
      landmark: "#9B59B6",
    }[eventType] ?? "#95A5A6"; // minor / unknown
  return L.divIcon({
    className: "bg-marker",
    html: `<span class="bg-dot" style="background:${color}" role="img" aria-label="事件標記 ${eventType}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

export async function initMap(rootId = "map-root"): Promise<void> {
  const root = document.getElementById(rootId);
  if (!root) throw new Error(`搵唔到 #${rootId}`);

  let loaded: LoadResult;
  try {
    loaded = await loadDataset();
  } catch (e) {
    root.innerHTML = `<p class="bg-error">資料載入失敗：${String(e)}。請重新整理，或檢查 data/public/ 是否完整。</p>`;
    return;
  }
  const { dataset, config } = loaded;

  // ---- provisional banner ----
  if (dataset.meta) {
    const banner = document.createElement("div");
    banner.className = "bg-provisional-banner";
    banner.setAttribute("role", "note");
    banner.textContent = dataset.meta.banner;
    document.body.prepend(banner);
  }

  root.innerHTML = "";

  // ---- 地圖初始化（本機 only）----
  const map = L.map(root, {
    center: storyToLatLng({
      x: config.map.initial_view.center_story_position[0],
      y: config.map.initial_view.center_story_position[1],
    }),
    zoom: config.map.initial_view.zoom,
    minZoom: config.map.zoom_range[0],
    maxZoom: config.map.zoom_range[1],
    maxBounds: STORY_BOUNDS,
    attributionControl: false,
  });

  // 暫用素色底（Phase C 換本機 tiles）；深色呼應小說基調
  map.createPane("base");
  map.getPane("base")!.style.background = "var(--color-surface, #1A252F)";

  // ---- 劇透控制 ----
  // events 有 spoiler_level；locations 無此欄位（永遠顯示）
  const maxSpoiler = config.spoiler.default_max_level ?? 1;
  const visibleEvents = filterFeaturesBySpoiler<EventFeature>(dataset.events, maxSpoiler);
  const visibleLocations = dataset.locations;

  const locIds = new Set(visibleLocations.map((f) => f.properties.id));

  // ---- location markers ----
  for (const loc of visibleLocations) {
    const ll = storyToLatLng(loc.properties.story_position);
    L.circleMarker(ll, {
      radius: 6,
      color: "#2C3E50",
      weight: 1,
      fillColor: loc.properties.fictional ? "#16A085" : "#7F8C8D",
      fillOpacity: 0.9,
    })
      .bindTooltip(
        `${loc.properties.display_name}（${loc.properties.location_precision}）`,
        { direction: "top" },
      )
      .addTo(map);
  }

  // ---- event markers ----
  for (const ev of visibleEvents) {
    const loc = dataset.locations.find((f) => f.properties.id === ev.properties.location_id);
    const sp = loc?.properties.story_position ?? {
      x: 0.68,
      y: 0.48,
    };
    L.marker(storyToLatLng(sp), { icon: eventIcon(ev.properties.event_type) })
      .bindTooltip(`${ev.properties.title}（第${ev.properties.chapter}章）`, { direction: "top" })
      .on("click", () => showEventDetail(dataset, ev.properties.id))
      .addTo(map);
  }

  // ---- 頂欄資料版本提示 ----
  const label = document.getElementById("data-version-label");
  if (label) {
    label.textContent = `資料版本：provisional（${visibleEvents.length} 事件／${locIds.size} 位置可見｜劇透 ≤${maxSpoiler}）`;
  }
}

function showEventDetail(dataset: import("../types/dataset").BingGangDataset, eventId: string): void {
  let panel = document.getElementById("bg-event-panel");
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = "bg-event-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "事件詳情");
    document.body.appendChild(panel);
  }
  const ev = dataset.events.find((f) => f.properties.id === eventId);
  if (!ev) return;
  const p = ev.properties;
  const chars = p.characters.map((c) => `@${c}`).join(" ");
  panel.innerHTML = `
    <h2>${escapeHtml(p.title)}</h2>
    <p class="bg-meta">第${p.chapter}章 · ${p.event_type} · 劇透 ${p.spoiler_level} · confidence ${p.confidence}</p>
    <p>${escapeHtml(p.description)}</p>
    <p class="bg-meta">${escapeHtml(chars)}</p>
    <button type="button" id="bg-close-detail">關閉</button>
  `;
  panel.querySelector("#bg-close-detail")?.addEventListener("click", () => panel!.remove());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

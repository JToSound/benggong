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
import { buildSearchIndex, search } from "../lib/search";
import { mountSidebar } from "./sidebar";
import { MeasureTool } from "./measure";
import { mountAbout } from "./about";

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

  // ---- 搜尋 + deep link + 鍵盤 ----
  buildSearchIndex(dataset);
  mountSearchBox(dataset, map);
  handleDeepLinks(dataset, map);
  mountAbout();

  // ---- Sidebar（劇透／角色）----
  let currentMarkers: L.Layer[] = [];
  const rerenderEvents = (maxLevel: number): void => {
    for (const m of currentMarkers) map.removeLayer(m);
    currentMarkers = [];
    const evs = filterFeaturesBySpoiler<EventFeature>(dataset.events, maxLevel);
    for (const ev of evs) {
      const loc = dataset.locations.find((f) => f.properties.id === ev.properties.location_id);
      const sp = loc?.properties.story_position ?? { x: 0.68, y: 0.48 };
      const marker = L.marker(storyToLatLng(sp), { icon: eventIcon(ev.properties.event_type) })
        .bindTooltip(`${ev.properties.title}（第${ev.properties.chapter}章）`, { direction: "top" })
        .on("click", () => showEventDetail(dataset, ev.properties.id, map))
        .addTo(map);
      currentMarkers.push(marker);
    }
    if (label) {
      label.textContent = `資料版本：provisional（${evs.length} 事件／${locIds.size} 位置可見｜劇透 ≤${maxLevel}）`;
    }
  };

  mountSidebar(dataset, {
    onSpoilerChange: rerenderEvents,
    onSelectCharacter: () => {
      /* 路線顯示待全書抽取後啟用 */
    },
  });
  rerenderEvents(maxSpoiler);

  // ---- 距離量度工具（M 快速鍵）----
  const scaleMeters = config.scale_profile.meters_per_map_unit;
  const measureTool = new MeasureTool(map, (result) => {
    if (result) {
      window.alert(`量度結果：${result.label}`);
    }
  }, scaleMeters);
  const measureBtn = document.createElement("button");
  measureBtn.id = "bg-measure-btn";
  measureBtn.type = "button";
  measureBtn.textContent = "📏 量度距離（M）";
  measureBtn.className = "bg-measure-btn";
  measureBtn.addEventListener("click", () => {
    measureTool.start();
    measureBtn.disabled = true;
    setTimeout(() => (measureBtn.disabled = false), 500);
  });
  root.appendChild(measureBtn);

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      measureBtn.click();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      document.getElementById("bg-search-input")?.focus();
    } else if (e.key === "Escape") {
      document.getElementById("bg-event-panel")?.remove();
      document.getElementById("bg-search-results")?.remove();
    } else if (e.key === "t" || e.key === "T") {
      window.location.href = "./timeline.html";
    }
  });
}

/** deep links：?event=<id> 同 #location=<id> */
function handleDeepLinks(
  dataset: import("../types/dataset").BingGangDataset,
  map: L.Map,
): void {
  const params = new URLSearchParams(window.location.search);
  const eventId = params.get("event");
  if (eventId) {
    showEventDetail(dataset, eventId, map);
  }

  const flyToStory = (sp: { x: number; y: number }, zoom = 13): void => {
    map.flyTo(storyToLatLng(sp), zoom, { duration: 0.8 });
  };

  const applyHash = (): void => {
    const m = window.location.hash.match(/^#location=(.+)$/);
    if (m) {
      const loc = dataset.locations.find((f) => f.properties.id === decodeURIComponent(m[1]));
      if (loc) flyToStory(loc.properties.story_position);
    }
  };
  applyHash();
  window.addEventListener("hashchange", applyHash);
}

/** 搜尋框 + 結果下拉 */
function mountSearchBox(
  dataset: import("../types/dataset").BingGangDataset,
  map: L.Map,
): void {
  const header = document.querySelector("header#topbar");
  if (!header) return;

  header.insertAdjacentHTML(
    "beforeend",
    `
    <div class="bg-search" role="search">
      <input id="bg-search-input" type="search" placeholder="搵角色／事件／地點／章節（F）"
             aria-label="搜尋" autocomplete="off" />
      <ul id="bg-search-results" class="bg-search-results" role="listbox" hidden></ul>
    </div>
  `,
  );

  const input = header.querySelector<HTMLInputElement>("#bg-search-input")!;
  const resultsEl = header.querySelector<HTMLUListElement>("#bg-search-results")!;

  const render = (): void => {
    const hits = search(input.value);
    resultsEl.innerHTML = hits
      .map(
        (h) =>
          `<li role="option"><a href="${escapeHtml(h.href)}" data-kind="${h.kind}">
             <strong>${escapeHtml(h.title)}</strong>
             <span class="bg-search-sub">${escapeHtml(h.subtitle)}</span></a></li>`,
      )
      .join("");
    resultsEl.hidden = hits.length === 0;
    for (const a of Array.from(resultsEl.querySelectorAll("a"))) {
      a.addEventListener("click", () => {
        resultsEl.hidden = true;
        input.value = "";
      });
    }
  };

  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      resultsEl.hidden = true;
      input.blur();
    }
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".bg-search")) resultsEl.hidden = true;
  });

  // 點 location 結果時飛過去（hash 變化由 hashchange handler 處理）
  resultsEl.addEventListener("click", (e) => {
    const href = (e.target as HTMLElement).closest("a")?.getAttribute("href") ?? "";
    const m = href.match(/^#location=(.+)$/);
    if (m) {
      const loc = dataset.locations.find(
        (f) => f.properties.id === decodeURIComponent(m[1]),
      );
      if (loc) map.flyTo(storyToLatLng(loc.properties.story_position), 13);
    }
  });
}

function showEventDetail(
  dataset: import("../types/dataset").BingGangDataset,
  eventId: string,
  map?: L.Map,
): void {
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
  const loc =
    p.location_id != null
      ? dataset.locations.find((f) => f.properties.id === p.location_id)
      : undefined;

  panel.innerHTML = `
    <h2>${escapeHtml(p.title)}</h2>
    <p class="bg-meta">第${p.chapter}章 · ${p.event_type} · 劇透 ${p.spoiler_level} · confidence ${p.confidence}</p>
    <p>${escapeHtml(p.description)}</p>
    ${loc ? `<p class="bg-meta">📍 ${escapeHtml(loc.properties.display_name)}（${loc.properties.location_precision}）</p>` : ""}
    <p class="bg-meta">${escapeHtml(chars)}</p>
    <div class="bg-detail-actions">
      ${loc ? `<button type="button" id="bg-fly-loc">飛去位置</button>` : ""}
      <a href="./timeline.html?event=${encodeURIComponent(p.id)}" id="bg-to-timeline">喺時間軸睇</a>
      <button type="button" id="bg-close-detail">關閉</button>
    </div>
  `;

  panel.querySelector("#bg-close-detail")?.addEventListener("click", () => {
    window.history.replaceState(null, "", "./index.html");
    panel!.remove();
  });
  panel.querySelector("#bg-fly-loc")?.addEventListener("click", () => {
    if (loc && map) {
      map.flyTo(storyToLatLng(loc.properties.story_position), 13, { duration: 0.8 });
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

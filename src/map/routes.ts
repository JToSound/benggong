// 《病港》— Routes 圖層（master prompt §10.4）
// 正式路線需人手審閱後先啟用；此模組處理渲染邏輯：
// - 虛線 polyline（原始 waypoint 為準；平滑僅視覺）
// - 角色顏色 + spoiler 過濾
// - 點擊顯示路線資訊

import L from "leaflet";
import type { RouteFeature } from "../types/dataset";

const ROUTE_STYLE: Record<string, { dash: string; weight: number }> = {
  travel: { dash: "8,6", weight: 3 },
  chase: { dash: "2,8", weight: 4 },
  patrol: { dash: "12,8", weight: 2 },
  escape: { dash: "4,10", weight: 4 },
};

export class RouteLayer {
  private group = L.layerGroup();
  private onSelect: ((r: RouteFeature) => void) | null = null;

  constructor(private map: L.Map) {}

  setOnSelect(fn: (r: RouteFeature) => void): void {
    this.onSelect = fn;
  }

  /** 渲染符合劇透上限嘅 routes；回傳可見數量 */
  render(routes: RouteFeature[], maxSpoiler: number, charColor: (id: string) => string | undefined): number {
    this.group.clearLayers();
    let shown = 0;
    for (const route of routes) {
      if (route.properties.spoiler_level > maxSpoiler) continue;
      const latlngs = route.geometry.coordinates.map(
        ([lng, lat]) => [lat, lng] as L.LatLngTuple,
      );
      const style = ROUTE_STYLE[route.properties.route_type] ?? { dash: "6,6", weight: 3 };
      const color =
        charColor(route.properties.character_ids[0] ?? "") ?? "#3498DB";
      const line = L.polyline(latlngs, {
        color,
        opacity: 0.75,
        dashArray: style.dash,
        weight: style.weight,
      });
      line.bindTooltip(
        `${route.properties.display_name}（${route.properties.route_type}）`,
        { sticky: true },
      );
      line.on("click", () => this.onSelect?.(route));
      this.group.addLayer(line);
      shown++;
    }
    return shown;
  }

  addToMap(): void {
    this.group.addTo(this.map);
  }

  removeFromMap(): void {
    this.group.remove();
  }
}

// 《病港》— Routes 圖層（master prompt §10.4）
// 正式路線需人手審閱後先啟用；此模組處理渲染邏輯：
// - 虛線 polyline（原始 waypoint 為準；平滑僅視覺）
// - 角色顏色；點擊顯示路線資訊

import L from "leaflet";
import type { RouteFeature } from "../types/dataset";

export class RouteLayer {
  private group = L.layerGroup();
  private onSelect: ((r: RouteFeature) => void) | null = null;

  constructor(private map: L.Map) {}

  setOnSelect(fn: (r: RouteFeature) => void): void {
    this.onSelect = fn;
  }

  /** 渲染全部 routes（routes 無 spoiler_level，跟隨角色章節）；回傳可見數量 */
  render(routes: RouteFeature[], _maxSpoiler: number, charColor: (id: string) => string | undefined): number {
    this.group.clearLayers();
    let shown = 0;
    for (const route of routes) {
      const latlngs = route.geometry.coordinates.map(
        ([lng, lat]) => [lat, lng] as L.LatLngTuple,
      );
      const color =
        charColor(route.properties.character_id) ?? route.properties.color ?? "#3498DB";
      const line = L.polyline(latlngs, {
        color,
        opacity: 0.75,
        dashArray: "8,6",
        weight: 3,
      });
      line.bindTooltip(
        `${route.properties.character_name}路線（第${route.properties.chapters_span[0]}–${route.properties.chapters_span[1]}章）`,
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

// 《病港》— 距離量度工具（master prompt §10.5）
// 兩點直線距離＋多點路徑；經 scale_profile 換算，精度不足顯示「估算距離／地圖單位」。
// 原始點距離為準；平滑路徑只係視覺效果。

import L from "leaflet";

export interface MeasureResult {
  points: L.LatLng[];
  /** 地圖單位總長（story units, 0–1 normalized × 100） */
  storyUnits: number;
  /** 換算 km（scale 可靠先有值，否則 null） */
  km: number | null;
  label: string;
}

/** story_position 網格距離：0–1 normalized 空間嘅歐氏距離 ×100 = 「故事網格單位」 */
function distStoryUnits(a: L.LatLng, b: LatLngLike): number {
  const ax = (a.lng - 113.8) / 0.6;
  const ay = (a.lat - 22.15) / 0.35;
  const bx = (b.lng - 113.8) / 0.6;
  const by = (b.lat - 22.15) / 0.35;
  return Math.hypot(bx - ax, by - ay) * 100;
}

type LatLngLike = { lat: number; lng: number };

export function computeMeasure(points: L.LatLng[], scaleMetersPerUnit: number | null): MeasureResult {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distStoryUnits(points[i - 1], points[i]);
  }
  const km =
    scaleMetersPerUnit != null && scaleMetersPerUnit > 0
      ? (total * scaleMetersPerUnit) / 1000
      : null;
  const label = km != null ? `${km.toFixed(2)} km（估算距離）` : `${total.toFixed(1)} 故事單位`;
  return { points, storyUnits: total, km, label };
}

/** 量度工具控制器：點地圖加點、雙擊結束、Esc 取消。 */
export class MeasureTool {
  private map: L.Map;
  private points: L.LatLng[] = [];
  private line: L.Polyline | null = null;
  private markers: L.CircleMarker[] = [];
  private tip: L.Tooltip | null = null;
  private active = false;
  private onDone: (r: MeasureResult | null) => void;

  constructor(map: L.Map, onDone: (r: MeasureResult | null) => void, private scaleMeters: number | null) {
    this.map = map;
    this.onDone = onDone;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.points = [];
    this.map.getContainer().style.cursor = "crosshair";
    this.map.on("click", this.addPoint);
    this.map.on("dblclick", this.finish);
    document.addEventListener("keydown", this.cancelOnEsc);
  }

  private addPoint = (e: L.LeafletMouseEvent): void => {
    this.points.push(e.latlng);
    const marker = L.circleMarker(e.latlng, { radius: 4, color: "#F39C12", fillOpacity: 1 }).addTo(this.map);
    this.markers.push(marker);
    if (this.line) this.line.remove();
    this.line = L.polyline(this.points, {
      color: "#F39C12",
      dashArray: "10,5",
      weight: 3,
    }).addTo(this.map);
    const result = computeMeasure(this.points, this.scaleMeters);
    if (!this.tip || !this.map.hasLayer(this.tip)) {
      this.tip = L.tooltip({ permanent: true, direction: "top", className: "bg-measure-tip" })
        .setLatLng(e.latlng)
        .addTo(this.map);
    }
    this.tip.setContent(`${result.label}（雙擊結束／Esc 取消）`);
  };

  private finish = (): void => {
    const result = this.points.length >= 2 ? computeMeasure(this.points, this.scaleMeters) : null;
    this.cleanup();
    this.onDone(result);
  };

  private cancelOnEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      this.cleanup();
      this.onDone(null);
    }
  };

  private cleanup(): void {
    this.active = false;
    this.map.getContainer().style.cursor = "";
    this.map.off("click", this.addPoint);
    this.map.off("dblclick", this.finish);
    document.removeEventListener("keydown", this.cancelOnEsc);
    for (const m of this.markers) m.remove();
    this.markers = [];
    if (this.line) this.line.remove();
    this.line = null;
    if (this.tip && this.map.hasLayer(this.tip)) this.tip.remove();
    this.tip = null;
  }
}

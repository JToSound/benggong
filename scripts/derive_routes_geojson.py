#!/usr/bin/env python3
"""《病港》— Phase D routes geojson generator（master prompt §10.4）。

讀 data/private/review/character-routes.json（人手已審 alias 合併版）
+ data/public/locations.geojson（取每個 waypoint 嘅 story_position x/y → 投影到香港座標）
→ 輸出 data/public/routes.geojson

每條 route 包含：
- character（取自 character-routes.json）
- chapters_covered [first, last]
- waypoints 對應嘅座標
- LineString geometry 將 waypoints 順序連起來
- review_status: reviewed（conf-based gate 已過，Phase C 完成）
- source: bing_gang

用法：python scripts/derive_routes_geojson.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from collections import defaultdict

REPO = Path(__file__).resolve().parent.parent
PRIVATE_ROUTES = REPO / "data/private/review/character-routes.json"
PUBLIC_LOC = REPO / "data/public/locations.geojson"
PUBLIC_ROUTES = REPO / "data/public/routes.geojson"

# 同 build_public_dataset.py 一致：fictional 投影到香港範圍附近
def story_pos_to_lonlat(x: float, y: float) -> list[float]:
    """0-1 normalized → EPSG:4326 投影（僅供 render 顯示，唔代表真實位置）"""
    return [113.80 + x * 0.60, 22.15 + y * 0.35]


def load_location_coords() -> dict[str, list[float]]:
    """location name → [lon, lat]。Fictional 用 story_position；district 用真實中心。"""
    if not PUBLIC_LOC.exists():
        return {}
    doc = json.loads(PUBLIC_LOC.read_text(encoding="utf-8"))
    coords: dict[str, list[float]] = {}
    for feat in doc.get("features", []):
        p = feat.get("properties", {})
        name = p.get("name", "")
        if not name:
            continue
        geom = feat.get("geometry", {}).get("coordinates", [None, None])
        if geom and len(geom) == 2:
            coords[name] = list(geom)
    return coords


def build_routes(char_routes: list[dict], loc_coords: dict[str, list[float]]) -> dict:
    features = []
    skipped_no_coords = []
    skipped_short = []
    for r in char_routes:
        waypoints = r.get("waypoints", [])
        if len(waypoints) < 2:
            skipped_short.append(r["character"])
            continue
        # 將 waypoints 轉座標
        line_coords = []
        missing = []
        for w in waypoints:
            loc = w.get("location")
            coord = loc_coords.get(loc)
            if coord is None:
                missing.append(loc)
                continue
            line_coords.append(coord)
        if len(line_coords) < 2:
            skipped_no_coords.append((r["character"], missing))
            continue
        # chapters
        chapters_seen = sorted({w["chapter"] for w in waypoints if w.get("chapter") is not None})
        feat = {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": line_coords,
            },
            "properties": {
                "id": f"rt_{len(features) + 1:03d}",
                "character": r["character"],
                "chapters_covered": r.get("chapters_covered", [chapters_seen[0], chapters_seen[-1]] if chapters_seen else [0, 0]),
                "chapters": chapters_seen[:50],
                "waypoint_count": len(waypoints),
                "missing_waypoint_locations": missing if missing else None,
                "review_status": "reviewed",  # Phase C conf-based gate 已過（routes 由 ≥ 0.7 conf 嘅 location candidates 推導）
                "provenance": "character-routes.json → derive_routes_geojson.py",
                "source": "bing_gang",
            },
        }
        features.append(feat)
    return {
        "type": "FeatureCollection",
        "features": features,
        "_meta": {
            "skipped_short": skipped_short,
            "skipped_no_coords": skipped_no_coords,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase D routes geojson generator")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not PRIVATE_ROUTES.exists():
        print(f"[blocked] {PRIVATE_ROUTES} 不存在")
        return 2
    char_routes = json.loads(PRIVATE_ROUTES.read_text(encoding="utf-8"))
    print(f"讀取 {len(char_routes)} 條 character-routes（人手審閱版）")

    loc_coords = load_location_coords()
    print(f"讀取 {len(loc_coords)} 個 location 座標")

    fc = build_routes(char_routes, loc_coords)
    n_feats = len(fc["features"])
    n_short = len(fc["_meta"]["skipped_short"])
    n_no = len(fc["_meta"]["skipped_no_coords"])

    print(f"\n產生 {n_feats} 條 routes")
    if n_short:
        print(f"  跳過（waypoints<2）：{n_short} 個 character：{fc['_meta']['skipped_short'][:5]}")
    if n_no:
        print(f"  跳過（座標缺）：{n_no} 個 character")
        for char, missing in fc["_meta"]["skipped_no_coords"][:5]:
            print(f"    {char}: missing {missing[:3]}")

    if args.dry_run:
        print(f"\n[dry-run] 未寫入 {PUBLIC_ROUTES}")
        return 0

    # 寫公開 routes.geojson（移除 _meta）
    public_doc = {
        "type": "FeatureCollection",
        "features": fc["features"],
    }
    PUBLIC_ROUTES.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_ROUTES.write_text(json.dumps(public_doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✅ 寫入 {PUBLIC_ROUTES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

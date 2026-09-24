#!/usr/bin/env python3
"""將地點座標傳播到 events / timeline / routes。

為何要獨立一步
==============
`apply_place_inferences.py` 本身有傳播邏輯，但佢跑喺**管線第 3 步**，
而 `anchor_fictional_locations`（第 4 步）同 `apply_location_corrections`
（第 5 步）之後仲會改座標 —— 所以事件／路線嘅座標會停留喺舊值。

實測踩過：`test_event_coords_match_location` 報「event 'bg_event_950'
嘅 coords 同 location 唔一致」—— 地點移動咗，但事件冇跟。

所以喺**所有改座標嘅步驟之後**加呢一步做最終傳播。
"""

from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"


def main() -> int:
    locs = json.loads((PUBLIC / "locations.geojson").read_text(encoding="utf-8"))["features"]
    xy = {f["properties"]["id"]: f["geometry"]["coordinates"] for f in locs}

    # events.geojson
    ev_path = PUBLIC / "events.geojson"
    ev = json.loads(ev_path.read_text(encoding="utf-8"))
    n_ev = 0
    for f in ev["features"]:
        lid = f["properties"].get("location_id")
        if lid and lid in xy and f["geometry"]["coordinates"] != xy[lid]:
            f["geometry"]["coordinates"] = list(xy[lid])
            n_ev += 1
    ev_path.write_text(json.dumps(ev, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # timeline.json
    tl_path = PUBLIC / "timeline.json"
    tl = json.loads(tl_path.read_text(encoding="utf-8"))
    n_tl = 0
    for t in tl:
        lid = t.get("location_id")
        if lid and lid in xy and t.get("coords") != xy[lid]:
            t["coords"] = list(xy[lid])
            n_tl += 1
    tl_path.write_text(json.dumps(tl, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # routes.geojson：waypoint 座標
    rt_path = PUBLIC / "routes.geojson"
    rt = json.loads(rt_path.read_text(encoding="utf-8"))
    n_rt = 0
    for f in rt["features"]:
        wps = f["properties"].get("waypoints") or []
        coords = f["geometry"]["coordinates"]
        for i, w in enumerate(wps):
            lid = w.get("location_id")
            if lid and lid in xy and i < len(coords) and coords[i] != xy[lid]:
                coords[i] = list(xy[lid])
                n_rt += 1
    rt_path.write_text(json.dumps(rt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"座標傳播：events {n_ev}／timeline {n_tl}／routes {n_rt}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

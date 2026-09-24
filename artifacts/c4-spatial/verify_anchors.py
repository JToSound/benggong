#!/usr/bin/env python3
"""C4 獨立錨定驗證：對每個 text_landmark 錨，喺 OSM 快取搵返該地標嘅真實元素。

只讀。輸出 JSON 到 artifacts/c4-spatial/anchor-osm-verify.json。

用法：python artifacts/c4-spatial/verify_anchors.py
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OSM = REPO / "data" / "private" / "cache" / "osm-hk.json"
LOC = REPO / "data" / "public" / "locations.geojson"
OUT = REPO / "artifacts" / "c4-spatial" / "anchor-osm-verify.json"

M_LON = 111320 * math.cos(math.radians(22.36))
M_LAT = 110570


def centroid(e):
    g = [(p["lon"], p["lat"]) for p in (e.get("geometry") or []) if p.get("lon") is not None]
    if not g:
        return None
    return (sum(p[0] for p in g) / len(g), sum(p[1] for p in g) / len(g))


def dist(a, b):
    return math.hypot((a[0] - b[0]) * M_LON, (a[1] - b[1]) * M_LAT)


def main():
    print("load osm ...", flush=True)
    els = json.loads(OSM.read_text(encoding="utf-8"))["elements"]
    print(f"osm elements={len(els)}", flush=True)

    locs = json.loads(LOC.read_text(encoding="utf-8"))["features"]
    tl = [f for f in locs if f["properties"].get("coordinate_source") == "text_landmark"]
    anchors = sorted({f["properties"]["coordinate_anchor"]["name"] for f in tl})

    # 額外：想知呢啲名有冇喺 OSM 出現（例如真實學校）
    extra = ["梁潔華小學", "寶康公園", "彩明苑", "慧安園", "將軍澳中心", "燒烤區", "將軍澳廣場"]
    targets = sorted(set(anchors + extra))

    report = {"anchors": {}, "elements_scanned": len(els)}

    for nm in targets:
        hits = []
        for e in els:
            t = e.get("tags") or {}
            names = [t.get("name:zh"), t.get("name"), t.get("name:en"), t.get("official_name"), t.get("alt_name")]
            if nm not in [n for n in names if n]:
                continue
            c = centroid(e)
            kind = {k: t.get(k) for k in
                    ("amenity", "shop", "railway", "station", "leisure", "tourism",
                     "historic", "landuse", "man_made", "place", "building",
                     "addr:street", "addr:housenumber", "addr:city") if t.get(k)}
            hits.append({
                "osm_type": e.get("type"), "osm_id": e.get("id"),
                "name": t.get("name"), "name_zh": t.get("name:zh"),
                "kind": kind, "centroid": [round(c[0], 6), round(c[1], 6)] if c else None,
            })
        report["anchors"][nm] = {"n_hits": len(hits), "hits": hits[:12]}

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    for nm in targets:
        r = report["anchors"][nm]
        print(f"\n### {nm}  ({r['n_hits']} hits)")
        for h in r["hits"]:
            print(f"   {h['osm_type']}/{h['osm_id']}  name={h['name']!r} zh={h['name_zh']!r}")
            print(f"      kind={h['kind']}  centroid={h['centroid']}")
    print(f"\n-> {OUT}")


if __name__ == "__main__":
    sys.exit(main())

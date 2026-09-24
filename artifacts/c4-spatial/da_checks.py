#!/usr/bin/env python3
"""C4 獨立 DA1–DA8 資料檢查 + 新發現探測。只讀 data/public。

用法：python artifacts/c4-spatial/da_checks.py
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PUB = REPO / "data" / "public"
OUT = REPO / "artifacts" / "c4-spatial" / "da-checks.json"

M_LON = 111320 * math.cos(math.radians(22.36))
M_LAT = 110570


def load(n):
    return json.loads((PUB / n).read_text(encoding="utf-8"))


def fc(n):
    return load(n)["features"]


def d(a, b):
    return math.hypot((b[0] - a[0]) * M_LON, (b[1] - a[1]) * M_LAT)


loc = fc("locations.geojson")
ev = fc("events.geojson")
rt = fc("routes.geojson")
zn = fc("zones.geojson")
dos = load("zone-dossiers.json")["dossiers"]

R = {}

# ---------- DA1 ----------
def cover(feats, keys):
    n = len(feats)
    out = {}
    for k in keys:
        present = sum(1 for f in feats if k in f["properties"])
        nonnull = sum(1 for f in feats if f["properties"].get(k) is not None)
        out[k] = {"present": present, "non_null": nonnull, "total": n}
    return out


R["DA1"] = {
    "locations": cover(loc, ["coordinate_source", "coordinate_review_status", "coordinate_confidence"]),
    "events": cover(ev, ["coordinate_source", "coordinate_review_status", "coordinate_confidence"]),
    "routes": cover(rt, ["coordinate_source", "coordinate_review_status", "coordinate_confidence"]),
    "zones": cover(zn, ["coordinate_source", "coordinate_review_status", "coordinate_confidence"]),
}
R["DA1"]["loc_confidence_null_ids"] = [
    f["properties"]["id"] for f in loc if f["properties"].get("coordinate_confidence") is None
]
R["DA1"]["loc_source_null_ids"] = [
    f["properties"]["id"] for f in loc if f["properties"].get("coordinate_source") is None
]
R["DA1"]["loc_review_null_ids"] = [
    f["properties"]["id"] for f in loc if f["properties"].get("coordinate_review_status") is None
]

# ---------- DA2 ----------
R["DA2"] = {
    "zone_type_counts": dict(Counter(f["properties"].get("zone_type") for f in zn)),
    "n_zones": len(zn),
}

# ---------- DA3 ----------
withzone = sum(1 for f in ev if f["properties"].get("zone_id"))
R["DA3"] = {
    "events": len(ev),
    "with_zone_id": withzone,
    "ratio": round(withzone / len(ev), 4),
    "target": 0.85,
    "met": withzone / len(ev) >= 0.85,
}

# ---------- DA4 ----------
dids = {x["id"] for x in dos}
zids = {f["properties"]["id"] for f in zn}
R["DA4"] = {
    "n_zones": len(zn),
    "n_dossiers": len(dos),
    "zones_without_dossier_id": [f["properties"]["id"] for f in zn if not f["properties"].get("dossier_id")],
    "zone_dossier_id_unresolved": [
        f["properties"]["id"] for f in zn if f["properties"].get("dossier_id") not in dids
    ],
    "dossiers_orphan": [x["id"] for x in dos if x.get("zone_id") not in zids],
}

# ---------- DA5 ----------
by_zone = {x["zone_id"]: x for x in dos}
bad5 = []
for f in zn:
    p = f["properties"]
    dz = by_zone.get(p["id"], {})
    if p.get("zone_type") == "infected_nest":
        if "nest_profile" not in dz:
            bad5.append((p["name"], "缺 nest_profile"))
        for k in ("governance", "society", "infrastructure"):
            if k in dz:
                bad5.append((p["name"], f"有 {k}"))
R["DA5"] = {"violations": bad5, "n_infected_nest": sum(1 for f in zn if f["properties"].get("zone_type") == "infected_nest")}

# ---------- DA6 ----------
NOVEL = re.compile(r"原文\s*[：:「]|ch\s*\d+\s*原文")
hits6 = []
for path in sorted(PUB.glob("*.json")) + sorted(PUB.glob("*.geojson")):
    t = path.read_text(encoding="utf-8")
    for m in NOVEL.finditer(t):
        hits6.append((path.name, m.group(0)))
R["DA6"] = {
    "novel_quote_hits": hits6[:10],
    "n_novel_quote_hits": len(hits6),
    "zones_with_evidence_field": [f["properties"]["id"] for f in zn if "evidence" in f["properties"]],
}

# ---------- DA8 塌縮 ----------
bycoord = defaultdict(list)
for f in loc:
    p = f["properties"]
    c = f["geometry"]["coordinates"]
    bycoord[(round(c[0], 9), round(c[1], 9))].append(f)

clusters_all = {k: v for k, v in bycoord.items() if len(v) >= 2}
clusters5 = {k: v for k, v in bycoord.items() if len(v) >= 5}
clusters20 = {k: v for k, v in bycoord.items() if len(v) >= 21}
# 非推斷
clusters5_noninfer = {
    k: [f for f in v if not f["properties"].get("inferred_from")]
    for k, v in clusters5.items()
}
R["DA8"] = {
    "n_unique_coords": len(bycoord),
    "n_locations": len(loc),
    "clusters_ge2": len(clusters_all),
    "clusters_ge5": len(clusters5),
    "clusters_ge5_noninfer_members": {
        f"{k[0]},{k[1]}": [f["properties"]["name"] for f in v]
        for k, v in clusters5_noninfer.items() if v
    },
    "clusters_ge21_noninfer": {f"{k[0]},{k[1]}": len(v) for k, v in clusters20.items()},
    "max_cluster_size": max((len(v) for v in bycoord.values()), default=0),
}

# ---------- 新發現 A：text_landmark 造成嘅塌縮 ----------
tl = [f for f in loc if f["properties"].get("coordinate_source") == "text_landmark"]
tl_by_coord = defaultdict(list)
for f in tl:
    c = f["geometry"]["coordinates"]
    tl_by_coord[(round(c[0], 6), round(c[1], 6))].append(f["properties"]["name"])
R["NEW_anchor_collapse"] = {
    "n_text_landmark": len(tl),
    "groups_sharing_exact_coord": {
        f"{k[0]},{k[1]}": v for k, v in tl_by_coord.items() if len(v) > 1
    },
}

# ---------- 新發現 B：text_landmark vs 其 zone 幾何 ----------
ring_of = {f["properties"]["id"]: f["geometry"]["coordinates"][0] for f in zn}
def ring_centroid(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
findingsB = []
for f in tl:
    p = f["properties"]
    c = f["geometry"]["coordinates"]
    for zid in p.get("zone_ids") or []:
        ring = ring_of.get(zid)
        if not ring:
            continue
        zc = ring_centroid(ring)
        findingsB.append({
            "loc": p["name"], "zone": zid,
            "dist_to_zone_centroid_m": round(d((c[0], c[1]), zc), 1),
        })
R["NEW_anchor_vs_zone"] = findingsB

# ---------- 新發現 C：事件同所屬 zone 幾何中心距離 ----------
ev_by_zone = defaultdict(list)
for f in ev:
    z = f["properties"].get("zone_id")
    if z:
        ev_by_zone[z].append(f)
findingsC = []
for zid, feats in ev_by_zone.items():
    ring = ring_of.get(zid)
    if not ring:
        continue
    zc = ring_centroid(ring)
    far = [
        (f["properties"]["id"], round(d((f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1]), zc), 1))
        for f in feats
    ]
    far = [x for x in far if x[1] > 3000]
    if far:
        findingsC.append({"zone": zid, "n_events": len(feats), "far_events": sorted(far, key=lambda x: -x[1])[:5]})
R["NEW_event_zone_distance"] = sorted(findingsC, key=lambda x: -x["far_events"][0][1])[:15]

# ---------- 新發現 D：同名但座標分散（>2km）----------
byname = defaultdict(list)
for f in loc:
    byname[f["properties"]["name"]].append(f)
findingsD = []
for nm, fs in byname.items():
    if len(fs) < 2:
        continue
    cs = [(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1]) for f in fs]
    mx = max(d(a, b) for i, a in enumerate(cs) for b in cs[i + 1:]) if len(cs) > 1 else 0
    if mx > 2000:
        findingsD.append({"name": nm, "n": len(fs), "max_spread_m": round(mx, 1),
                          "ids": [f["properties"]["id"] for f in fs]})
R["NEW_same_name_spread"] = sorted(findingsD, key=lambda x: -x["max_spread_m"])[:20]

# ---------- 新發現 E：map_hidden ----------
hidden = [f for f in loc if f["properties"].get("map_hidden")]
hidden_ids = {f["properties"]["id"] for f in hidden}
ev_hidden = [f for f in ev if f["properties"].get("location_id") in hidden_ids]
R["NEW_map_hidden"] = {
    "n_hidden_locations": len(hidden),
    "hidden_names": [f["properties"]["name"] for f in hidden],
    "n_events_linked_to_hidden": len(ev_hidden),
    "hidden_event_chapters": dict(Counter(f["properties"].get("chapter") for f in ev_hidden)),
    "hidden_coords": {f["properties"]["name"]: f["geometry"]["coordinates"] for f in hidden},
}

OUT.write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")

print("=== DA1 覆蓋率 ===")
for k, v in R["DA1"].items():
    if isinstance(v, dict):
        print(f"  {k}: " + ", ".join(f"{kk}={vv['non_null']}/{vv['total']}" for kk, vv in v.items()))
print(f"  loc coordinate_confidence=null: {len(R['DA1']['loc_confidence_null_ids'])} 個 "
      f"{R['DA1']['loc_confidence_null_ids'][:12]}")
print(f"  loc coordinate_source=null: {len(R['DA1']['loc_source_null_ids'])}")
print(f"  loc coordinate_review_status=null: {len(R['DA1']['loc_review_null_ids'])}")

print("\n=== DA2 zone_type ===", R["DA2"])
print("=== DA3 event.zone_id ===", R["DA3"])
print("=== DA4 dossier join ===", {k: (len(v) if isinstance(v, list) else v) for k, v in R["DA4"].items()})
print("=== DA5 infected_nest governance 違規 ===", R["DA5"])
print("=== DA6 novel quotes ===", R["DA6"]["n_novel_quote_hits"], R["DA6"]["novel_quote_hits"][:3],
      "| evidence field:", R["DA6"]["zones_with_evidence_field"])
print("=== DA8 塌縮 ===")
print(f"  clusters>=2: {R['DA8']['clusters_ge2']}  clusters>=5: {R['DA8']['clusters_ge5']}  "
      f"max={R['DA8']['max_cluster_size']}")
print(f"  clusters>=5 非推斷: {R['DA8']['clusters_ge5_noninfer_members']}")
print(f"  clusters>=21 非推斷: {R['DA8']['clusters_ge21_noninfer']}")

print("\n=== NEW A: text_landmark 塌縮 ===", json.dumps(R["NEW_anchor_collapse"], ensure_ascii=False))
print("\n=== NEW B: 錨定 vs zone 中心 ===")
for x in R["NEW_anchor_vs_zone"]:
    print(f"  {x['loc']:22} {x['dist_to_zone_centroid_m']:8.0f} m  {x['zone']}")
print("\n=== NEW C: event 離 zone 中心 >3km ===")
for x in R["NEW_event_zone_distance"]:
    print(f"  {x['zone']} n={x['n_events']} far={x['far_events']}")
print("\n=== NEW D: 同名座標分散 >2km ===")
for x in R["NEW_same_name_spread"]:
    print(f"  {x['name']:22} n={x['n']} spread={x['max_spread_m']:.0f} m {x['ids']}")
print("\n=== NEW E: map_hidden ===", json.dumps(R["NEW_map_hidden"], ensure_ascii=False))
print(f"\n-> {OUT}")

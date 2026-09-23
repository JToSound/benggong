#!/usr/bin/env python3
"""A5 Spatial Data Auditor —— 確定性、可重跑嘅空間完整性審計。

只讀 `data/public/` 同 `data/schemas/`。
**唔會讀 `data/private/`，唔會改任何 production 檔案。**

輸出：`artifacts/audit-A5/spatial-audit.json`（完整候選清單）＋ stdout 摘要。

覆蓋 spec §2.2 嘅 8 條規則：
  R1 Geometry validity
  R2 Bounds
  R3 Zone membership
  R4 Route continuity
  R5 Event-location coherence
  R6 Duplicate / near-duplicate
  R7 Narrative temporal coherence
  R8 Unknown over hallucination

用法：
    python artifacts/audit-A5/spatial_audit.py
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PUBLIC = REPO / "data" / "public"
SCHEMAS = REPO / "data" / "schemas"
OUT = Path(__file__).resolve().parent / "spatial-audit.json"

# ---- 地理常數（同 scripts/build_vector_basemap.py 一致）----
M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570

#: base-map 可視世界 bbox（spec §2.2 規則 2；同 build_vector_basemap.BBOX 一致）
BASE_BBOX = {"lon_min": 113.79, "lon_max": 114.49, "lat_min": 22.11, "lat_max": 22.61}

#: 故事舞台 bbox（同 scripts/audit_location_coords.STORY_BBOX 一致）
STORY_BBOX = {"lon_min": 114.14, "lon_max": 114.36, "lat_min": 22.22, "lat_max": 22.36}

# ---- 門檻（全部寫死，可稽核）----
NEAR_DUP_M = 50.0            # R6 非常近 marker
ROUTE_JUMP_M = 5000.0        # R4 相鄰 waypoint 跳躍門檻（硬）
ROUTE_JUMP_WARN_M = 2000.0   # R4 警告級跳躍門檻
ROUTE_JUMP_TIGHT_CH = 2      # R4 章節差 ≤ 2 仍然跳 > 門檻 = 高可疑
ZONE_OUTSIDE_M = 400.0       # R3 落喺 polygon 外幾多米算 warning
ZONE_QUARANTINE_M = 1500.0   # R3 落喺 polygon 外幾多米算 quarantine
ZONE_AREA_MAX_KM2 = 6.0      # R6/zone 品質：過大
ZONE_AREA_MIN_KM2 = 0.05     # 過細
ZONE_RADIUS_TOL = 0.35       # radius_m 同 polygon 幾何半徑嘅相對容差

# ---- spec §2.2 要求嘅欄位 ----
REQUIRED_SPATIAL_FIELDS = [
    "location_precision",
    "coordinate_confidence",
    "coordinate_source",
    "coordinate_review_status",
    "zone_id",
    "chapter_refs",
    "spatial_evidence_count",
]

_NORM = {"邨": "村", "嘅": "的", "「": "", "」": ""}


def norm(s: str) -> str:
    out = (s or "").strip()
    for a, b in _NORM.items():
        out = out.replace(a, b)
    return re.sub(r"\s+", "", out)


def dist_m(a, b) -> float:
    return math.hypot((b[0] - a[0]) * M_PER_DEG_LON, (b[1] - a[1]) * M_PER_DEG_LAT)


def in_bbox(c, bb) -> bool:
    return bb["lon_min"] <= c[0] <= bb["lon_max"] and bb["lat_min"] <= c[1] <= bb["lat_max"]


def load(name: str):
    return json.loads((PUBLIC / name).read_text(encoding="utf-8"))


# ================= R1 Geometry validity =================

def _seg_intersect(p1, p2, p3, p4) -> bool:
    def ccw(a, b, c):
        return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])

    d1, d2 = ccw(p3, p4, p1), ccw(p3, p4, p2)
    d3, d4 = ccw(p1, p2, p3), ccw(p1, p2, p4)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def polygon_self_intersects(ring) -> bool:
    n = len(ring) - 1  # 閉合環，最後一點 = 第一點
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue  # 共用端點
            if _seg_intersect(ring[i], ring[i + 1], ring[j], ring[j + 1]):
                return True
    return False


def check_geometry(loc_f, ev_f, rt_f, zone_f) -> dict:
    bad_coords: list[dict] = []
    dup_vertices: list[dict] = []
    self_int: list[dict] = []
    unclosed_rings: list[dict] = []
    ring_too_short: list[dict] = []
    dup_points: list[dict] = []

    def coord_ok(c) -> bool:
        return (
            isinstance(c, list) and len(c) == 2
            and all(isinstance(x, (int, float)) and not math.isnan(x) and not math.isinf(x) for x in c)
        )

    for f in loc_f:
        c = f["geometry"]["coordinates"]
        if not coord_ok(c):
            bad_coords.append({"kind": "location", "id": f["properties"]["id"], "coords": c})
    for f in ev_f:
        c = f["geometry"]["coordinates"]
        if not coord_ok(c):
            bad_coords.append({"kind": "event", "id": f["properties"]["id"], "coords": c})
    for f in rt_f:
        cs = f["geometry"]["coordinates"]
        for i, c in enumerate(cs):
            if not coord_ok(c):
                bad_coords.append({"kind": "route", "id": f["properties"]["id"], "idx": i, "coords": c})
        for i in range(len(cs) - 1):
            if cs[i] == cs[i + 1]:
                dup_vertices.append({"kind": "route", "id": f["properties"]["id"], "idx": i})
    for f in zone_f:
        ring = f["geometry"]["coordinates"][0]
        zid = f["properties"]["id"]
        if len(ring) < 4:
            ring_too_short.append({"id": zid, "n": len(ring)})
        if ring and ring[0] != ring[-1]:
            unclosed_rings.append({"id": zid})
        # ⚠️ GeoJSON 閉合環嘅最後一點**必然**等於第一點 —— 唔算重複。
        seen = set()
        for i, v in enumerate(ring[:-1] if len(ring) > 1 else ring):
            t = (round(v[0], 9), round(v[1], 9))
            if t in seen:
                dup_vertices.append({"kind": "zone", "id": zid, "idx": i})
            seen.add(t)
        if len(ring) >= 4 and polygon_self_intersects(ring):
            self_int.append({"id": zid})

    # 完全相同座標（跨 feature）
    seen: dict[tuple, list[str]] = defaultdict(list)
    for f in loc_f:
        c = f["geometry"]["coordinates"]
        seen[(round(c[0], 9), round(c[1], 9))].append(f["properties"]["id"])
    for k, ids in seen.items():
        if len(ids) > 1:
            dup_points.append({"coords": list(k), "ids": ids})

    return {
        "bad_coords": bad_coords,
        "duplicate_vertices": dup_vertices,
        "self_intersecting_polygons": self_int,
        "unclosed_rings": unclosed_rings,
        "ring_too_short": ring_too_short,
        "identical_coordinate_groups": dup_points,
    }


# ================= R2 Bounds =================

def check_bounds(loc_f, ev_f, rt_f, zone_f) -> dict:
    out_base, out_story = [], []
    loc_by_id = {f["properties"]["id"]: f["geometry"]["coordinates"] for f in loc_f}

    def add(kind, fid, c, extra=None):
        if not (isinstance(c, list) and len(c) == 2):
            return
        rec = {"kind": kind, "id": fid, "coords": [round(c[0], 6), round(c[1], 6)]}
        if extra:
            rec.update(extra)
        if not in_bbox(c, BASE_BBOX):
            out_base.append(rec)
        if not in_bbox(c, STORY_BBOX):
            out_story.append(rec)

    for f in loc_f:
        p = f["properties"]
        add("location", p["id"], f["geometry"]["coordinates"],
            {"precision": p.get("location_precision"), "map_hidden": bool(p.get("map_hidden"))})
    for f in ev_f:
        add("event", f["properties"]["id"], f["geometry"]["coordinates"],
            {"location_id": f["properties"].get("location_id")})
    for f in rt_f:
        for i, c in enumerate(f["geometry"]["coordinates"]):
            add("route_waypoint", f["properties"]["id"], c, {"idx": i})
    for f in zone_f:
        ring = f["geometry"]["coordinates"][0]
        cx = sum(v[0] for v in ring) / len(ring)
        cy = sum(v[1] for v in ring) / len(ring)
        add("zone_centroid", f["properties"]["id"], [cx, cy])
        for v in ring:
            if not in_bbox(v, BASE_BBOX):
                out_base.append({"kind": "zone_vertex", "id": f["properties"]["id"],
                                 "coords": [round(v[0], 6), round(v[1], 6)]})
                break

    # 事件 vs 地點座標一致性（bounds 之外嘅 coherence 檢查）
    return {
        "outside_base_bbox": out_base,
        "outside_story_bbox": out_story,
        "n_location_outside_story": sum(1 for r in out_story if r["kind"] == "location"),
        "n_location_outside_story_visible": sum(
            1 for r in out_story if r["kind"] == "location" and not r.get("map_hidden")
        ),
        "_loc_by_id": loc_by_id,
    }


# ================= R3 Zone membership =================

def point_in_ring(pt, ring) -> bool:
    x, y = pt
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def dist_point_to_ring(pt, ring) -> float:
    """點到 polygon 邊嘅最短距離（米）。點喺內部回 0。"""
    if point_in_ring(pt, ring):
        return 0.0
    best = float("inf")
    for i in range(len(ring) - 1):
        a, b = ring[i], ring[i + 1]
        ax, ay = a
        bx, by = b
        dx, dy = (bx - ax) * M_PER_DEG_LON, (by - ay) * M_PER_DEG_LAT
        px, py = (pt[0] - ax) * M_PER_DEG_LON, (pt[1] - ay) * M_PER_DEG_LAT
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, (px * dx + py * dy) / L2))
        cx, cy = ax * 1 + dx * t / M_PER_DEG_LON, ay + dy * t / M_PER_DEG_LAT
        best = min(best, dist_m(pt, (cx, cy)))
    return best


def check_zone_membership(loc_f, ev_f, zone_f) -> dict:
    zone_by_id = {f["properties"]["id"]: f for f in zone_f}
    ring_of = {zid: f["geometry"]["coordinates"][0] for zid, f in zone_by_id.items()}

    linked = [f for f in loc_f if f["properties"].get("zone_ids")]
    inside, outside = [], []
    for f in loc_f:
        p = f["properties"]
        for zid in p.get("zone_ids") or []:
            ring = ring_of.get(zid)
            if ring is None:
                outside.append({"location_id": p["id"], "zone_id": zid, "reason": "zone_id 唔存在"})
                continue
            c = f["geometry"]["coordinates"]
            d = dist_point_to_ring(c, ring)
            if d == 0.0:
                inside.append({"location_id": p["id"], "zone_id": zid})
            else:
                outside.append({
                    "location_id": p["id"], "zone_id": zid,
                    "distance_m": round(d, 1),
                    "coords": [round(c[0], 6), round(c[1], 6)],
                    "precision": p.get("location_precision"),
                })

    # 事件 → zone（經 location_id 反查）
    loc_zone = {f["properties"]["id"]: f["properties"].get("zone_ids") or [] for f in loc_f}
    ev_no_zone = sum(1 for f in ev_f if not loc_zone.get(f["properties"].get("location_id") or "", []))
    ev_null_loc = sum(1 for f in ev_f if not f["properties"].get("location_id"))

    # 反向：location 有 zone_ids 但 zone 冇 member_location_ids（schema 要求一致）
    zone_member_field = sum(1 for f in zone_f if "member_location_ids" in f["properties"])

    return {
        "n_locations_with_zone": len(linked),
        "n_zone_links": sum(len(f["properties"].get("zone_ids") or []) for f in loc_f),
        "n_inside": len(inside),
        "n_outside": len(outside),
        "outside": sorted(outside, key=lambda r: -(r.get("distance_m") or 0)),
        "outside_over_400m": [r for r in outside if (r.get("distance_m") or 0) > ZONE_OUTSIDE_M],
        "outside_over_1500m": [r for r in outside if (r.get("distance_m") or 0) > ZONE_QUARANTINE_M],
        "n_events_without_zone": ev_no_zone,
        "n_events_null_location": ev_null_loc,
        "zones_with_member_location_ids_field": zone_member_field,
    }


# ================= R4 Route continuity =================

def check_routes(rt_f) -> dict:
    jumps, warns, non_mono_ch, ch_gaps = [], [], [], []
    all_d = []
    per_route = []
    for f in rt_f:
        p = f["properties"]
        wps = p["waypoints"]
        cs = f["geometry"]["coordinates"]
        dists = []
        for i in range(min(len(wps), len(cs)) - 1):
            d = dist_m(cs[i], cs[i + 1])
            dists.append(d)
            all_d.append(d)
            ch_gap = wps[i + 1]["chapter"] - wps[i]["chapter"]
            ch_gaps.append(ch_gap)
            rec = {
                "route_id": p["id"], "character": p["character_name"],
                "from_wp": wps[i]["location_id"], "to_wp": wps[i + 1]["location_id"],
                "from_ch": wps[i]["chapter"], "to_ch": wps[i + 1]["chapter"],
                "distance_m": round(d, 1), "chapter_gap": ch_gap,
                "tight_gap": ch_gap <= ROUTE_JUMP_TIGHT_CH,
                "wp_confidence": [wps[i].get("confidence"), wps[i + 1].get("confidence")],
            }
            if d > ROUTE_JUMP_M:
                jumps.append(rec)
            if d > ROUTE_JUMP_WARN_M:
                warns.append(rec)
        for i in range(len(wps) - 1):
            if wps[i + 1]["chapter"] < wps[i]["chapter"]:
                non_mono_ch.append({
                    "route_id": p["id"], "idx": i,
                    "ch": [wps[i]["chapter"], wps[i + 1]["chapter"]],
                })
        # waypoint vs geometry 長度
        len_mismatch = len(wps) != len(cs)
        per_route.append({
            "route_id": p["id"], "character": p["character_name"],
            "n_wp": len(wps), "n_coord": len(cs),
            "max_step_m": round(max(dists), 1) if dists else 0,
            "total_m": round(sum(dists), 1),
            "len_mismatch": len_mismatch,
            "real_waypoint_fraction": p.get("real_waypoint_fraction"),
        })

    all_d_sorted = sorted(all_d)
    n = len(all_d_sorted)

    def pct(q):
        return round(all_d_sorted[min(n - 1, int(q * n))], 1) if n else 0

    return {
        "n_routes": len(rt_f),
        "n_steps": n,
        "distance_quantiles_m": {
            "p50": pct(0.5), "p90": pct(0.9), "p95": pct(0.95), "p99": pct(0.99),
            "max": round(all_d_sorted[-1], 1) if n else 0,
        },
        "jumps_over_5km": jumps,
        "n_jumps_over_5km": len(jumps),
        "n_jumps_tight_chapter_gap": sum(1 for j in jumps if j["tight_gap"]),
        "jumps_over_2km": sorted(warns, key=lambda r: -r["distance_m"]),
        "n_jumps_over_2km": len(warns),
        "n_jumps_over_2km_tight_gap": sum(1 for j in warns if j["tight_gap"]),
        "chapter_gap_quantiles": {
            "p50": sorted(ch_gaps)[len(ch_gaps) // 2] if ch_gaps else 0,
            "p90": sorted(ch_gaps)[int(0.9 * len(ch_gaps))] if ch_gaps else 0,
            "max": max(ch_gaps) if ch_gaps else 0,
        },
        "non_monotonic_chapters": non_mono_ch,
        "waypoint_coord_length_mismatch": [r for r in per_route if r["len_mismatch"]],
        "per_route": sorted(per_route, key=lambda r: -r["max_step_m"]),
    }


# ================= R5 Event-location coherence =================

def check_event_location(ev_f, loc_f) -> dict:
    loc_by_id = {f["properties"]["id"]: f for f in loc_f}
    name_mismatch, coord_mismatch, dangling = [], [], []
    null_loc = 0
    for f in ev_f:
        p = f["properties"]
        lid = p.get("location_id")
        if not lid:
            null_loc += 1
            continue
        loc = loc_by_id.get(lid)
        if loc is None:
            dangling.append({"event_id": p["id"], "location_id": lid})
            continue
        lname = loc["properties"]["name"]
        ename = p.get("location_name")
        if ename and norm(ename) != norm(lname):
            name_mismatch.append({
                "event_id": p["id"], "event_location_name": ename,
                "location_name": lname, "location_id": lid,
                "chapter": p.get("chapter"),
            })
        ec = f["geometry"]["coordinates"]
        lc = loc["geometry"]["coordinates"]
        if abs(ec[0] - lc[0]) > 1e-4 or abs(ec[1] - lc[1]) > 1e-4:
            coord_mismatch.append({
                "event_id": p["id"], "location_id": lid,
                "event_coords": ec, "loc_coords": lc,
                "delta_m": round(dist_m(ec, lc), 1),
            })
    return {
        "n_events": len(ev_f),
        "n_null_location_id": null_loc,
        "null_location_ratio": round(null_loc / len(ev_f), 4),
        "dangling_location_id": dangling,
        "name_mismatch": name_mismatch,
        "n_name_mismatch": len(name_mismatch),
        "coord_mismatch": coord_mismatch,
        "n_coord_mismatch": len(coord_mismatch),
    }


# ================= R6 Duplicate / near-duplicate =================

def check_duplicates(loc_f, zone_f) -> dict:
    by_name: dict[str, list] = defaultdict(list)
    for f in loc_f:
        by_name[norm(f["properties"]["name"])].append(f)

    same_name = []
    type_conflict = []
    for nm, fs in by_name.items():
        if len(fs) > 1:
            types = Counter(f["properties"].get("location_type") for f in fs)
            rec = {
                "name": nm, "n": len(fs),
                "ids": [f["properties"]["id"] for f in fs],
                "types": dict(types),
                "precisions": [f["properties"].get("location_precision") for f in fs],
                "coords": [f["geometry"]["coordinates"] for f in fs],
            }
            same_name.append(rec)
            if len(types) > 1:
                type_conflict.append(rec)

    # 非常近 marker（< 50 m）
    near = []
    fs = [(f["properties"]["id"], f["properties"]["name"], f["geometry"]["coordinates"],
           f["properties"].get("location_type")) for f in loc_f]
    for i in range(len(fs)):
        for j in range(i + 1, len(fs)):
            d = dist_m(fs[i][2], fs[j][2])
            if d < NEAR_DUP_M:
                near.append({
                    "a": fs[i][0], "b": fs[j][0],
                    "a_name": fs[i][1], "b_name": fs[j][1],
                    "distance_m": round(d, 2),
                    "same_name": norm(fs[i][1]) == norm(fs[j][1]),
                    "types": [fs[i][3], fs[j][3]],
                })

    # zone 同名
    znames: dict[str, list] = defaultdict(list)
    for f in zone_f:
        znames[norm(f["properties"]["name"])].append(f["properties"]["id"])
    zone_dup = {k: v for k, v in znames.items() if len(v) > 1}

    # marker 塌縮簇：完全同一座標、成員 ≥ 5
    by_coord: dict[tuple, list] = defaultdict(list)
    for f in loc_f:
        c = f["geometry"]["coordinates"]
        by_coord[(round(c[0], 9), round(c[1], 9))].append(f)
    clusters = []
    for k, fs in by_coord.items():
        if len(fs) >= 5:
            clusters.append({
                "coords": list(k), "n": len(fs),
                "ids": [f["properties"]["id"] for f in fs],
                "names": [f["properties"]["name"] for f in fs][:12],
                "precisions": dict(Counter(f["properties"].get("location_precision") for f in fs)),
                "n_with_zone": sum(1 for f in fs if f["properties"].get("zone_ids")),
            })
    clusters.sort(key=lambda r: -r["n"])

    return {
        "marker_collapse_clusters": clusters,
        "n_collapse_clusters": len(clusters),
        "n_locations_in_collapse_clusters": sum(c["n"] for c in clusters),
        "same_name_location_groups": sorted(same_name, key=lambda r: -r["n"]),
        "n_same_name_groups": len(same_name),
        "n_locations_in_same_name_groups": sum(r["n"] for r in same_name),
        "type_conflict_groups": type_conflict,
        # 15,946 pair 大部分係塌縮簇內部組合；明細截斷至最近 3,000 條避免 artifact 過大。
        # 完整數字仍然準確（n_near_duplicates）。
        "near_duplicates_under_50m": sorted(near, key=lambda r: r["distance_m"])[:3000],
        "near_duplicates_truncated": len(near) > 3000,
        "n_near_duplicates": len(near),
        "n_near_duplicates_same_name": sum(1 for r in near if r["same_name"]),
        "zone_duplicate_names": zone_dup,
    }


# ================= R7 Narrative temporal coherence =================

def check_temporal(rt_f, chronicle) -> dict:
    entries = chronicle["entries"]
    fb = [e for e in entries if e.get("flashback")]
    non_fb = [e for e in entries if not e.get("flashback")]

    # flashback 標記但 chapters[].role 唔一致
    fb_role_inconsistent = []
    for e in entries:
        roles = {c.get("role") for c in (e.get("chapters") or []) if isinstance(c, dict)}
        if e.get("flashback") and "flashback" not in roles:
            fb_role_inconsistent.append({"id": e["id"], "title": e.get("title")})
        if not e.get("flashback") and "flashback" in roles:
            fb_role_inconsistent.append({"id": e["id"], "title": e.get("title"), "note": "role=flashback 但 flag=false"})

    # story_time.order vs first_mention_chapter 單調性（只用非回帶）
    inversions = []
    seq = sorted(
        [e for e in non_fb if e.get("story_time", {}).get("order") is not None
         and e.get("first_mention_chapter")],
        key=lambda e: e["first_mention_chapter"],
    )
    max_order = -1
    for e in seq:
        o = e["story_time"]["order"]
        if o < max_order:
            inversions.append({
                "id": e["id"], "first_mention_chapter": e["first_mention_chapter"],
                "story_order": o, "prev_max_order": max_order,
            })
        max_order = max(max_order, o)

    # route waypoint chapter 同 location 章節證據嘅落差
    route_ch_unsupported = []
    for f in rt_f:
        wps = f["properties"]["waypoints"]
        for w in wps:
            if w.get("confidence") is not None and w["confidence"] < 0.5:
                route_ch_unsupported.append({
                    "route_id": f["properties"]["id"], "location_id": w["location_id"],
                    "chapter": w["chapter"], "confidence": w["confidence"],
                })

    return {
        "n_entries": len(entries),
        "n_flashback": len(fb),
        "flashback_ratio": round(len(fb) / len(entries), 4),
        "flashback_flag_role_inconsistent": fb_role_inconsistent,
        "n_flashback_flag_role_inconsistent": len(fb_role_inconsistent),
        "story_order_inversions_non_flashback": inversions,
        "n_story_order_inversions": len(inversions),
        "low_confidence_waypoints": route_ch_unsupported,
        "n_low_confidence_waypoints": len(route_ch_unsupported),
    }


# ================= R8 Unknown over hallucination =================

def check_unknown(loc_f, ev_f) -> dict:
    no_evidence = []
    for f in loc_f:
        p = f["properties"]
        prec = p.get("location_precision")
        has_src = bool(p.get("position_source"))
        has_inf = bool(p.get("inferred_from"))
        if prec in ("approximate", "fictional") and not has_src and not has_inf:
            no_evidence.append({
                "id": p["id"], "name": p["name"], "precision": prec,
                "fictional": p.get("fictional"),
                "coords": f["geometry"]["coordinates"],
                "confidence": p.get("confidence"),
                "review_status": p.get("review_status"),
                "map_hidden": bool(p.get("map_hidden")),
            })

    # 事件無 location 但仍有座標（= 座標無來源）
    ev_null_with_coord = sum(1 for f in ev_f if not f["properties"].get("location_id"))

    # position_source 值分佈（歸類）
    src_kind = Counter()
    for f in loc_f:
        ps = f["properties"].get("position_source") or ""
        if not ps:
            src_kind["(冇)"] += 1
        elif "程式化座標校正" in ps:
            src_kind["程式化座標校正"] += 1
        elif "依附於" in ps:
            src_kind["依附父項"] += 1
        elif "質心" in ps:
            src_kind["同章質心錨定"] += 1
        elif "故事主場景" in ps:
            src_kind["後備主場景"] += 1
        else:
            src_kind["其他"] += 1

    return {
        "approximate_or_fictional_without_evidence": no_evidence,
        "n_without_evidence": len(no_evidence),
        "n_without_evidence_visible": sum(1 for r in no_evidence if not r["map_hidden"]),
        "position_source_kind": dict(src_kind),
        "events_null_location_still_have_coord": ev_null_with_coord,
    }


# ================= Fictional 座標分析 =================

def check_fictional(loc_f) -> dict:
    fic = [f for f in loc_f if f["properties"].get("fictional")]
    inferred = [f for f in loc_f if f["properties"].get("inferred_from")]
    corrected = [f for f in loc_f if f["properties"].get("coord_corrected")]

    fic_with_src = [f for f in fic if f["properties"].get("position_source")]
    fic_no_src = [f for f in fic if not f["properties"].get("position_source")]

    def src_of(f):
        ps = f["properties"].get("position_source") or ""
        if "依附於" in ps:
            return "依附父項"
        if "質心" in ps:
            return "同章質心錨定"
        if "程式化座標校正" in ps:
            return "程式化座標校正"
        if "故事主場景" in ps:
            return "後備主場景"
        if not ps:
            return "(冇)"
        return "其他"

    # 虛構地點係唔係喺故事區（將軍澳）內
    def in_story(c):
        return (114.225 <= c[0] <= 114.310) and (22.265 <= c[1] <= 22.350)

    fic_in_story = sum(1 for f in fic if in_story(f["geometry"]["coordinates"]))

    return {
        "n_fictional": len(fic),
        "n_inferred_from": len(inferred),
        "n_coord_corrected": len(corrected),
        "n_fictional_with_position_source": len(fic_with_src),
        "n_fictional_without_position_source": len(fic_no_src),
        "fictional_position_source_kind": dict(Counter(src_of(f) for f in fic)),
        "inferred_position_source_kind": dict(Counter(src_of(f) for f in inferred)),
        "fictional_in_story_region": fic_in_story,
        "fictional_outside_story_region": len(fic) - fic_in_story,
        "fictional_no_source_sample": [
            {"id": f["properties"]["id"], "name": f["properties"]["name"],
             "coords": f["geometry"]["coordinates"], "confidence": f["properties"].get("confidence")}
            for f in fic_no_src[:20]
        ],
        "inferred_from_kind": dict(Counter(f["properties"].get("location_type") for f in inferred)),
    }


# ================= Zone polygon 品質 =================

def ring_area_m2(ring) -> float:
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        a += (x1 * y2 - x2 * y1)
    return abs(a) / 2.0 * M_PER_DEG_LON * M_PER_DEG_LAT


def check_zone_quality(zone_f) -> dict:
    rows = []
    for f in zone_f:
        p = f["properties"]
        ring = f["geometry"]["coordinates"][0]
        cx = sum(v[0] for v in ring) / len(ring)
        cy = sum(v[1] for v in ring) / len(ring)
        geom_r = max(dist_m((cx, cy), v) for v in ring)
        area_km2 = ring_area_m2(ring) / 1e6
        r = p.get("radius_m") or 0
        rel = abs(geom_r - r) / r if r else None
        rows.append({
            "id": p["id"], "name": p["name"], "kind": p.get("kind"),
            "radius_m": r, "geom_radius_m": round(geom_r, 1),
            "area_km2": round(area_km2, 4),
            "n_vertices": len(ring),
            "radius_source": p.get("radius_source"),
            "coords_source": p.get("coords_source"),
            "radius_geom_rel_diff": round(rel, 3) if rel is not None else None,
            "radius_inconsistent": bool(rel is not None and rel > ZONE_RADIUS_TOL),
        })
    areas = sorted(r["area_km2"] for r in rows)

    # 精確重疊：任何一方嘅頂點落入另一方 → 確認重疊（確定性、唔靠採樣）。
    rings = {f["properties"]["id"]: f["geometry"]["coordinates"][0] for f in zone_f}
    name_of = {f["properties"]["id"]: f["properties"]["name"] for f in zone_f}
    overlaps, contains = [], []
    zids = sorted(rings)
    for i in range(len(zids)):
        for j in range(i + 1, len(zids)):
            za, zb = zids[i], zids[j]
            ra, rb = rings[za], rings[zb]
            # bbox 快速排除
            ax = [v[0] for v in ra]; ay = [v[1] for v in ra]
            bx = [v[0] for v in rb]; by = [v[1] for v in rb]
            if max(ax) < min(bx) or max(bx) < min(ax) or max(ay) < min(by) or max(by) < min(ay):
                continue
            ca = (sum(ax) / len(ra), sum(ay) / len(ra))
            cb = (sum(bx) / len(rb), sum(by) / len(rb))
            a_in_b = any(point_in_ring(v, rb) for v in ra[:-1])
            b_in_a = any(point_in_ring(v, ra) for v in rb[:-1])
            if a_in_b or b_in_a:
                rec = {
                    "a": name_of[za], "b": name_of[zb],
                    "centroid_dist_m": round(dist_m(ca, cb), 1),
                }
                overlaps.append(rec)
                # 包含關係：一方全部頂點落入另一方
                if all(point_in_ring(v, rb) for v in ra[:-1]) or all(point_in_ring(v, ra) for v in rb[:-1]):
                    contains.append(rec)
    return {
        "n_zones": len(rows),
        "area_km2_quantiles": {
            "min": areas[0] if areas else 0,
            "p25": areas[len(areas) // 4] if areas else 0,
            "p50": areas[len(areas) // 2] if areas else 0,
            "p75": areas[3 * len(areas) // 4] if areas else 0,
            "max": areas[-1] if areas else 0,
        },
        "oversized": [r for r in rows if r["area_km2"] > ZONE_AREA_MAX_KM2],
        "undersized": [r for r in rows if r["area_km2"] < ZONE_AREA_MIN_KM2],
        "radius_inconsistent": [r for r in rows if r["radius_inconsistent"]],
        "n_radius_inconsistent": sum(1 for r in rows if r["radius_inconsistent"]),
        "overlapping_zone_pairs": overlaps,
        "n_overlapping_zone_pairs": len(overlaps),
        "nested_zone_pairs": contains,
        "n_nested_zone_pairs": len(contains),
        "rows": sorted(rows, key=lambda r: -r["area_km2"]),
    }


# ================= 座標來源分類（provenance）=================

def check_provenance(loc_f) -> dict:
    """把 704 個地點嘅座標分成「有真實地理證據」同「合成」兩類。"""
    real, synthetic, unknown = [], [], []
    for f in loc_f:
        p = f["properties"]
        prec = p.get("location_precision")
        src = p.get("position_source") or ""
        inf = p.get("inferred_from")
        rec = {"id": p["id"], "name": p["name"], "precision": prec}
        if inf:
            real.append({**rec, "why": "inferred_from（地點推斷，OSM／語意錨定）"})
        elif "程式化座標校正" in src:
            real.append({**rec, "why": "地名重配校正（OSM／策展地名）"})
        elif prec in ("exact", "district") and not src:
            real.append({**rec, "why": "抽取階段已有 exact／district 座標"})
        elif "依附父項" in src:
            synthetic.append({**rec, "why": "依附父項 + id hash 偏移"})
        elif "同章質心" in src:
            synthetic.append({**rec, "why": "同章質心 + id hash 環形偏移"})
        elif "故事主場景" in src:
            synthetic.append({**rec, "why": "後備主場景（將軍澳校園）"})
        elif not src:
            unknown.append({**rec, "why": "冇 position_source（座標來源不明）"})
        else:
            synthetic.append({**rec, "why": f"其他：{src[:40]}"})
    n = len(loc_f)
    return {
        "n_real_evidence": len(real),
        "n_synthetic": len(synthetic),
        "n_unknown_source": len(unknown),
        "real_ratio": round(len(real) / n, 4),
        "synthetic_ratio": round(len(synthetic) / n, 4),
        "unknown_ratio": round(len(unknown) / n, 4),
        "synthetic_why": dict(Counter(r["why"] for r in synthetic)),
        "real_why": dict(Counter(r["why"] for r in real)),
        "unknown_sample": unknown[:20],
    }


# ================= Schema 落差 =================

def schema_gap(loc_f, ev_f, rt_f, zone_f) -> dict:
    def keys_of(feats):
        return {k for f in feats for k in f["properties"]}

    lk, ek, rk, zk = keys_of(loc_f), keys_of(ev_f), keys_of(rt_f), keys_of(zone_f)
    wp_keys = {k for f in rt_f for w in f["properties"]["waypoints"] for k in w}

    spec_fields = {
        "location_precision": "locations",
        "coordinate_confidence": "all",
        "coordinate_source": "all",
        "coordinate_review_status": "all",
        "zone_id": "events",
        "chapter_refs": "all",
        "spatial_evidence_count": "all",
    }

    def status(field, keys):
        if field in keys:
            return "已有"
        # 等價欄位
        alias = {
            "coordinate_source": ["position_source", "inferred_from", "coords_source", "provenance"],
            "coordinate_review_status": ["review_status", "coord_corrected"],
            "chapter_refs": ["chapters", "chapter", "chapters_span", "chapters_span"],
            "zone_id": ["zone_ids"],
            "location_precision": ["precision", "spatial_precision"],
        }.get(field, [])
        hit = [a for a in alias if a in keys]
        return f"部分有（等價：{', '.join(hit)}）" if hit else "冇"

    table = []
    for f, scope in spec_fields.items():
        row = {"field": f, "scope": scope}
        if scope in ("locations", "all"):
            row["locations"] = status(f, lk)
        if scope in ("events", "all"):
            row["events"] = status(f, ek)
        if scope == "all":
            row["routes"] = status(f, rk)
            row["route_waypoint"] = status(f, wp_keys)
            row["zones"] = status(f, zk)
        table.append(row)

    return {
        "location_property_keys": sorted(lk),
        "event_property_keys": sorted(ek),
        "route_property_keys": sorted(rk),
        "route_waypoint_keys": sorted(wp_keys),
        "zone_property_keys": sorted(zk),
        "spec_field_table": table,
    }


# ================= main =================

def main() -> int:
    loc = load("locations.geojson")["features"]
    ev = load("events.geojson")["features"]
    rt = load("routes.geojson")["features"]
    zn = load("zones.geojson")["features"]
    chronicle = load("chronicle.json")

    report = {
        "note": "A5 程式化空間審計。只讀 data/public。可重跑、確定性。",
        "counts": {"locations": len(loc), "events": len(ev), "routes": len(rt), "zones": len(zn)},
        "thresholds": {
            "base_bbox": BASE_BBOX, "story_bbox": STORY_BBOX,
            "near_dup_m": NEAR_DUP_M, "route_jump_m": ROUTE_JUMP_M,
            "zone_outside_m": ZONE_OUTSIDE_M, "zone_quarantine_m": ZONE_QUARANTINE_M,
        },
        "schema_gap": schema_gap(loc, ev, rt, zn),
        "R1_geometry": check_geometry(loc, ev, rt, zn),
        "R2_bounds": {k: v for k, v in check_bounds(loc, ev, rt, zn).items() if not k.startswith("_")},
        "R3_zone_membership": check_zone_membership(loc, ev, zn),
        "R4_route_continuity": check_routes(rt),
        "R5_event_location_coherence": check_event_location(ev, loc),
        "R6_duplicates": check_duplicates(loc, zn),
        "R7_temporal": check_temporal(rt, chronicle),
        "R8_unknown": check_unknown(loc, ev),
        "fictional": check_fictional(loc),
        "provenance": check_provenance(loc),
        "zone_quality": check_zone_quality(zn),
    }

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"=== A5 空間審計 ===")
    print(f"locations={len(loc)} events={len(ev)} routes={len(rt)} zones={len(zn)}")
    print(f"\nR1 geometry: bad_coords={len(report['R1_geometry']['bad_coords'])} "
          f"self_int={len(report['R1_geometry']['self_intersecting_polygons'])} "
          f"dup_vertices={len(report['R1_geometry']['duplicate_vertices'])} "
          f"identical_groups={len(report['R1_geometry']['identical_coordinate_groups'])}")
    print(f"R2 bounds: outside_base={len(report['R2_bounds']['outside_base_bbox'])} "
          f"outside_story={len(report['R2_bounds']['outside_story_bbox'])}")
    r3 = report["R3_zone_membership"]
    print(f"R3 zone: links={r3['n_zone_links']} inside={r3['n_inside']} outside={r3['n_outside']} "
          f">400m={len(r3['outside_over_400m'])} >1500m={len(r3['outside_over_1500m'])}")
    r4 = report["R4_route_continuity"]
    print(f"R4 route: steps={r4['n_steps']} jumps>5km={r4['n_jumps_over_5km']} "
          f"tight={r4['n_jumps_tight_chapter_gap']} quantiles={r4['distance_quantiles_m']}")
    r5 = report["R5_event_location_coherence"]
    print(f"R5 coherence: name_mismatch={r5['n_name_mismatch']} coord_mismatch={r5['n_coord_mismatch']} "
          f"null_loc={r5['n_null_location_id']}")
    r6 = report["R6_duplicates"]
    print(f"R6 dup: same_name_groups={r6['n_same_name_groups']} "
          f"near<50m={r6['n_near_duplicates']} type_conflict={len(r6['type_conflict_groups'])} "
          f"collapse_clusters={r6['n_collapse_clusters']}({r6['n_locations_in_collapse_clusters']} pts)")
    print(f"   jumps>2km={r4['n_jumps_over_2km']} tight={r4['n_jumps_over_2km_tight_gap']}")
    pv = report["provenance"]
    print(f"provenance: real={pv['n_real_evidence']}({pv['real_ratio']:.0%}) "
          f"synthetic={pv['n_synthetic']}({pv['synthetic_ratio']:.0%}) "
          f"unknown={pv['n_unknown_source']}({pv['unknown_ratio']:.0%})")
    r7 = report["R7_temporal"]
    print(f"R7 temporal: flashback={r7['n_flashback']} flag_role_inconsistent={r7['n_flashback_flag_role_inconsistent']} "
          f"order_inversions={r7['n_story_order_inversions']}")
    r8 = report["R8_unknown"]
    print(f"R8 unknown: no_evidence={r8['n_without_evidence']} visible={r8['n_without_evidence_visible']}")
    fic = report["fictional"]
    print(f"fictional: {fic['n_fictional']} (no_source={fic['n_fictional_without_position_source']}) "
          f"inferred_from={fic['n_inferred_from']} coord_corrected={fic['n_coord_corrected']}")
    zq = report["zone_quality"]
    print(f"zone quality: oversized={len(zq['oversized'])} undersized={len(zq['undersized'])} "
          f"radius_inconsistent={zq['n_radius_inconsistent']} overlaps={zq['n_overlapping_zone_pairs']}")
    print(f"\n報告 → {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

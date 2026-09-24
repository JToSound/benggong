#!/usr/bin/env python3
"""B4 —— 座標完整性審計（spec §2.2 / §4 嘅 R1–R8 八條規則）。

來源
====
搬 `artifacts/audit-A5/spatial_audit.py`（A5 Spatial Data Auditor）做基礎，
按 spatial-data-contract §4 嘅實作契約重整：
  - 每條規則嘅輸出**必須**含 `feature_id` / `rule` / `severity` / `evidence`
    （結構化，唔可以係自由文字）—— 規則 V2。
  - Threshold 全部 deterministic、可重跑、可稽核 —— 規則 V3。

八條規則
========
  R1 Geometry validity          R5 Event-location coherence
  R2 Bounds                     R6 Duplicate / near-duplicate
  R3 Zone membership            R7 Narrative temporal coherence
  R4 Route continuity           R8 Unknown over hallucination

**只讀 `data/public/`。唔會讀 `data/private/`，唔會改任何 production 檔案。**

輸出：`artifacts/b4/coordinate-audit.json`（完整 findings）＋ stdout 摘要。

用法：
    python scripts/audit_coordinate_integrity.py
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
ARTIFACTS = REPO / "artifacts" / "b4"

SCHEMA_VERSION = 2

M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570

#: base-map 可視世界 bbox（同 scripts/build_vector_basemap.py 一致）
BASE_BBOX = {"lon_min": 113.79, "lon_max": 114.49, "lat_min": 22.11, "lat_max": 22.61}
#: 故事舞台 bbox（同 scripts/audit_location_coords.py 一致）
STORY_BBOX = {"lon_min": 114.14, "lon_max": 114.36, "lat_min": 22.22, "lat_max": 22.36}

#: 全部 threshold 寫死，可稽核（規則 V3）
THRESHOLDS = {
    "marker_collapse_max_members": 20,   # 同一像素 > 20 個**非推斷** marker = fail
    "near_dup_m": 50.0,                  # spec 規則 6
    "route_jump_m": 5000.0,              # 相鄰 waypoint 硬上限
    "route_jump_warn_m": 2000.0,         # 警告級
    "route_jump_tight_ch": 2,            # 章節差 ≤ 2 仍然跳 > 門檻 = 高可疑
    "zone_valid_mult": 1.5,              # 距離 > 1.5 × radius_m = warning
    "zone_quarantine_mult": 3.0,         # 距離 > 3 × radius_m = quarantine
    "max_event_name_mismatch_ratio": 0.02,
    "max_unknown_ratio": 0.05,
}

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


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load(name: str) -> Any:
    return json.loads((PUBLIC / name).read_text(encoding="utf-8"))


def load_fc(name: str) -> list[dict]:
    return load(name)["features"]


def finding(feature_id: str, rule: str, severity: str, evidence: dict) -> dict:
    """規則 V2：findings 必須有呢四個 key。"""
    return {
        "feature_id": feature_id,
        "rule": rule,
        "severity": severity,
        "evidence": evidence,
    }


def point_in_ring(pt, ring) -> bool:
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def dist_point_to_ring(pt, ring) -> float:
    if point_in_ring(pt, ring):
        return 0.0
    best = float("inf")
    for i in range(len(ring) - 1):
        ax, ay = ring[i]
        bx, by = ring[i + 1]
        dx, dy = (bx - ax) * M_PER_DEG_LON, (by - ay) * M_PER_DEG_LAT
        px, py = (pt[0] - ax) * M_PER_DEG_LON, (pt[1] - ay) * M_PER_DEG_LAT
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, (px * dx + py * dy) / L2))
        cx = ax + dx * t / M_PER_DEG_LON
        cy = ay + dy * t / M_PER_DEG_LAT
        best = min(best, dist_m(pt, (cx, cy)))
    return best


def _seg_intersect(p1, p2, p3, p4) -> bool:
    def ccw(a, b, c):
        return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])

    d1, d2 = ccw(p3, p4, p1), ccw(p3, p4, p2)
    d3, d4 = ccw(p1, p2, p3), ccw(p1, p2, p4)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def polygon_self_intersects(ring) -> bool:
    n = len(ring) - 1
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if _seg_intersect(ring[i], ring[i + 1], ring[j], ring[j + 1]):
                return True
    return False


# =====================================================================
# R1 Geometry validity
# =====================================================================


def rule_r1(loc, ev, rt, zn) -> dict:
    out: list[dict] = []

    def coord_ok(c) -> bool:
        return (
            isinstance(c, list) and len(c) == 2
            and all(isinstance(x, (int, float)) and not math.isnan(x) and not math.isinf(x) for x in c)
        )

    for kind, feats in (("location", loc), ("event", ev)):
        for f in feats:
            c = f["geometry"]["coordinates"]
            if not coord_ok(c):
                out.append(finding(f["properties"]["id"], "R1_GEOMETRY", "fail",
                                   {"kind": kind, "coords": c, "reason": "非法／NaN 座標"}))
    for f in rt:
        cs = f["geometry"]["coordinates"]
        rid = f["properties"]["id"]
        for i, c in enumerate(cs):
            if not coord_ok(c):
                out.append(finding(rid, "R1_GEOMETRY", "fail",
                                   {"kind": "route", "idx": i, "coords": c, "reason": "非法座標"}))
        degen = [i for i in range(len(cs) - 1) if cs[i] == cs[i + 1]]
        if degen:
            # P2（A5 已分級「可暫緩」）：幾何退化段唔阻塞交付，只記錄。
            out.append(finding(rid, "R1_GEOMETRY", "info",
                               {"kind": "route", "n_degenerate_segments": len(degen),
                                "first_idx": degen[0], "reason": "相鄰重複頂點（P2）"}))
    for f in zn:
        zid = f["properties"]["id"]
        ring = f["geometry"]["coordinates"][0]
        if len(ring) < 4:
            out.append(finding(zid, "R1_GEOMETRY", "fail", {"reason": "環頂點 < 4", "n": len(ring)}))
        if ring and ring[0] != ring[-1]:
            out.append(finding(zid, "R1_GEOMETRY", "fail", {"reason": "環未閉合"}))
        if len(ring) >= 4 and polygon_self_intersects(ring):
            out.append(finding(zid, "R1_GEOMETRY", "fail", {"reason": "polygon 自交"}))

    identical: dict[tuple, list[str]] = defaultdict(list)
    for f in loc:
        c = f["geometry"]["coordinates"]
        identical[(round(c[0], 9), round(c[1], 9))].append(f["properties"]["id"])
    groups = {k: v for k, v in identical.items() if len(v) > 1}
    for k, ids in sorted(groups.items()):
        out.append(finding(ids[0], "R1_GEOMETRY", "info",
                           {"coords": list(k), "n_members": len(ids), "ids": ids[:10],
                            "reason": "完全相同座標（詳見 R6 標記塌縮）"}))

    n_fail = sum(1 for o in out if o["severity"] == "fail")
    return {
        "rule": "R1_GEOMETRY",
        "description": "座標合法性、環閉合、自交、route 退化段",
        "n_findings": len(out),
        "n_fail": n_fail,
        "status": "fail" if n_fail else "pass",
        "summary": {
            "identical_coordinate_groups": len(groups),
            "identical_coordinate_members": sum(len(v) for v in groups.values()),
        },
        "findings": out,
    }


# =====================================================================
# R2 Bounds
# =====================================================================


def rule_r2(loc, ev, rt, zn) -> dict:
    out: list[dict] = []

    def check(kind, fid, c, extra=None):
        if not (isinstance(c, list) and len(c) == 2):
            return
        evd = {"kind": kind, "coords": [round(c[0], 6), round(c[1], 6)]}
        if extra:
            evd.update(extra)
        if not in_bbox(c, BASE_BBOX):
            out.append(finding(fid, "R2_BOUNDS", "fail", {**evd, "reason": "越出 base-map bbox"}))
        elif not in_bbox(c, STORY_BBOX):
            out.append(finding(fid, "R2_BOUNDS", "warning", {**evd, "reason": "越出故事舞台 bbox"}))

    for f in loc:
        check("location", f["properties"]["id"], f["geometry"]["coordinates"],
              {"precision": f["properties"].get("location_precision")})
    for f in ev:
        check("event", f["properties"]["id"], f["geometry"]["coordinates"])
    for f in rt:
        for c in f["geometry"]["coordinates"]:
            check("route_waypoint", f["properties"]["id"], c)
    for f in zn:
        for v in f["geometry"]["coordinates"][0]:
            if not in_bbox(v, BASE_BBOX):
                out.append(finding(f["properties"]["id"], "R2_BOUNDS", "fail",
                                   {"kind": "zone_vertex",
                                    "coords": [round(v[0], 6), round(v[1], 6)],
                                    "reason": "zone 頂點越出 base-map bbox"}))
                break

    n_fail = sum(1 for o in out if o["severity"] == "fail")
    return {
        "rule": "R2_BOUNDS",
        "description": "全部座標必須落喺 base-map bbox / 故事舞台 bbox",
        "n_findings": len(out),
        "n_fail": n_fail,
        "status": "fail" if n_fail else "pass",
        "summary": {"base_bbox": BASE_BBOX, "story_bbox": STORY_BBOX},
        "findings": out,
    }


# =====================================================================
# R3 Zone membership
# =====================================================================


def rule_r3(loc, ev, zn) -> dict:
    out: list[dict] = []
    ring_of = {f["properties"]["id"]: f["geometry"]["coordinates"][0] for f in zn}
    radius_of = {f["properties"]["id"]: float(f["properties"].get("radius_m") or 300.0) for f in zn}

    inside = 0
    for f in loc:
        p = f["properties"]
        c = f["geometry"]["coordinates"]
        for zid in p.get("zone_ids") or []:
            ring = ring_of.get(zid)
            if ring is None:
                out.append(finding(p["id"], "R3_ZONE_MEMBERSHIP", "fail",
                                   {"zone_id": zid, "reason": "zone_id 唔存在"}))
                continue
            d = dist_point_to_ring(c, ring)
            r = radius_of[zid]
            if d == 0.0:
                inside += 1
            elif d > THRESHOLDS["zone_quarantine_mult"] * r:
                out.append(finding(p["id"], "R3_ZONE_MEMBERSHIP", "quarantine",
                                   {"zone_id": zid, "distance_m": round(d, 1),
                                    "limit_m": round(THRESHOLDS["zone_quarantine_mult"] * r, 1),
                                    "reason": "落喺 polygon 外過遠"}))
            elif d > THRESHOLDS["zone_valid_mult"] * r:
                out.append(finding(p["id"], "R3_ZONE_MEMBERSHIP", "warning",
                                   {"zone_id": zid, "distance_m": round(d, 1),
                                    "limit_m": round(THRESHOLDS["zone_valid_mult"] * r, 1),
                                    "reason": "落喺 polygon 外（warning 級）"}))

    loc_zone = {f["properties"]["id"]: f["properties"].get("zone_ids") or [] for f in loc}
    ev_no_zone = sum(1 for f in ev if not loc_zone.get(f["properties"].get("location_id") or "", []))
    ev_null = sum(1 for f in ev if not f["properties"].get("location_id"))
    for f in ev:
        p = f["properties"]
        if p.get("location_id") and not p.get("zone_id"):
            out.append(finding(p["id"], "R3_ZONE_MEMBERSHIP", "info",
                               {"location_id": p["location_id"],
                                "reason": "地點冇 zone 歸屬 → event.zone_id = null"}))
    zones_missing_members = [f["properties"]["id"] for f in zn
                             if "member_location_ids" not in f["properties"]]

    n_fail = sum(1 for o in out if o["severity"] == "fail")
    n_quar = sum(1 for o in out if o["severity"] == "quarantine")
    return {
        "rule": "R3_ZONE_MEMBERSHIP",
        "description": "location.zone_ids 必須落喺對應 polygon 內或合理接近",
        "n_findings": len(out),
        "n_fail": n_fail,
        "n_quarantine": n_quar,
        "status": "fail" if (n_fail or n_quar) else "pass",
        "summary": {
            "n_links": sum(len(v) for v in loc_zone.values()),
            "n_inside": inside,
            "n_locations_with_zone": sum(1 for v in loc_zone.values() if v),
            "n_events_without_zone": ev_no_zone,
            "n_events_null_location": ev_null,
            "zones_missing_member_location_ids": zones_missing_members,
        },
        "findings": out,
    }


# =====================================================================
# R4 Route continuity
# =====================================================================


def rule_r4(rt) -> dict:
    out: list[dict] = []
    all_d: list[float] = []
    for f in rt:
        p = f["properties"]
        wps = p.get("waypoints") or []
        cs = f["geometry"]["coordinates"]
        for i in range(min(len(wps), len(cs)) - 1):
            d = dist_m(cs[i], cs[i + 1])
            all_d.append(d)
            gap = wps[i + 1]["chapter"] - wps[i]["chapter"]
            evd = {"route_id": p["id"], "character": p.get("character_name"),
                   "from": wps[i]["location_id"], "to": wps[i + 1]["location_id"],
                   "distance_m": round(d, 1), "chapter_gap": gap}
            if d > THRESHOLDS["route_jump_m"]:
                out.append(finding(p["id"], "R4_ROUTE_CONTINUITY", "fail",
                                   {**evd, "reason": "相鄰 waypoint 硬跳躍 > 5 km"}))
            elif d > THRESHOLDS["route_jump_warn_m"] and gap <= THRESHOLDS["route_jump_tight_ch"]:
                out.append(finding(p["id"], "R4_ROUTE_CONTINUITY", "warning",
                                   {**evd, "reason": "> 2 km 且章節差 ≤ 2（高可疑）"}))
        for i in range(len(wps) - 1):
            if wps[i + 1]["chapter"] < wps[i]["chapter"]:
                out.append(finding(p["id"], "R4_ROUTE_CONTINUITY", "fail",
                                   {"idx": i, "chapters": [wps[i]["chapter"], wps[i + 1]["chapter"]],
                                    "reason": "waypoint 章節非單調"}))

    ds = sorted(all_d)
    n = len(ds)

    def pct(q):
        return round(ds[min(n - 1, int(q * n))], 1) if n else 0

    n_fail = sum(1 for o in out if o["severity"] == "fail")
    return {
        "rule": "R4_ROUTE_CONTINUITY",
        "description": "route 相鄰 waypoint 距離 / 章節單調性",
        "n_findings": len(out),
        "n_fail": n_fail,
        "status": "fail" if n_fail else "pass",
        "summary": {
            "n_steps": n,
            "distance_quantiles_m": {"p50": pct(0.5), "p90": pct(0.9), "p95": pct(0.95),
                                     "p99": pct(0.99), "max": round(ds[-1], 1) if n else 0},
            "n_jumps_over_5km": sum(1 for o in out if o["severity"] == "fail"
                                    and "硬跳躍" in o["evidence"].get("reason", "")),
            "n_jumps_over_2km_tight": sum(1 for o in out if o["severity"] == "warning"),
        },
        "findings": out,
    }


# =====================================================================
# R5 Event-location coherence
# =====================================================================


def rule_r5(ev, loc) -> dict:
    out: list[dict] = []
    loc_by_id = {f["properties"]["id"]: f for f in loc}
    n_mismatch = 0
    for f in ev:
        p = f["properties"]
        lid = p.get("location_id")
        if not lid:
            continue
        lf = loc_by_id.get(lid)
        if lf is None:
            out.append(finding(p["id"], "R5_EVENT_LOCATION", "fail",
                               {"location_id": lid, "reason": "懸空 location_id"}))
            continue
        lname = lf["properties"]["name"]
        ename = p.get("location_name")
        if ename and norm(ename) != norm(lname):
            n_mismatch += 1
            out.append(finding(p["id"], "R5_EVENT_LOCATION", "warning",
                               {"event_location_name": ename, "location_name": lname,
                                "location_id": lid, "chapter": p.get("chapter"),
                                "reason": "location_name 同 location.name 正規化後唔一致"}))
        ec, lc = f["geometry"]["coordinates"], lf["geometry"]["coordinates"]
        if abs(ec[0] - lc[0]) > 1e-4 or abs(ec[1] - lc[1]) > 1e-4:
            out.append(finding(p["id"], "R5_EVENT_LOCATION", "fail",
                               {"location_id": lid, "event_coords": ec, "loc_coords": lc,
                                "delta_m": round(dist_m(ec, lc), 1),
                                "reason": "event coords ≠ location coords"}))

    ratio = n_mismatch / len(ev) if ev else 0.0
    if ratio > THRESHOLDS["max_event_name_mismatch_ratio"]:
        out.append(finding("(aggregate)", "R5_EVENT_LOCATION", "fail",
                           {"n_mismatch": n_mismatch, "ratio": round(ratio, 4),
                            "limit": THRESHOLDS["max_event_name_mismatch_ratio"],
                            "reason": "name mismatch 比例超標"}))

    n_fail = sum(1 for o in out if o["severity"] == "fail")
    return {
        "rule": "R5_EVENT_LOCATION",
        "description": "event.location_id / location_name / coords 同 location 一致",
        "n_findings": len(out),
        "n_fail": n_fail,
        "status": "fail" if n_fail else "pass",
        "summary": {"n_events": len(ev), "n_name_mismatch": n_mismatch,
                    "name_mismatch_ratio": round(ratio, 4),
                    "n_null_location_id": sum(1 for f in ev if not f["properties"].get("location_id"))},
        "findings": out,
    }


# =====================================================================
# R6 Duplicate / near-duplicate
# =====================================================================


def rule_r6(loc, zn) -> dict:
    out: list[dict] = []

    by_coord: dict[tuple, list[dict]] = defaultdict(list)
    for f in loc:
        c = f["geometry"]["coordinates"]
        by_coord[(round(c[0], 9), round(c[1], 9))].append(f)

    for k in sorted(by_coord):
        feats = by_coord[k]
        if len(feats) < 5:
            continue
        movable = [f for f in feats if not f["properties"].get("inferred_from")]
        locked = len(feats) - len(movable)
        evd = {"coords": [k[0], k[1]], "n_members": len(feats),
               "n_non_inferred": len(movable), "n_locked_inferred": locked,
               "sample": [f["properties"]["name"] for f in feats[:6]]}
        if len(movable) > THRESHOLDS["marker_collapse_max_members"]:
            out.append(finding(movable[0]["properties"]["id"], "R6_DUPLICATE", "fail",
                               {**evd, "reason": "非推斷 marker 塌縮 > 20 個"}))
        elif locked:
            # inferred_from 座標被上游推斷記錄鎖定（規則 C2）→ B4 唔可以移動。
            out.append(finding(feats[0]["properties"]["id"], "R6_DUPLICATE", "warning",
                               {**evd, "reason": "塌縮成員全部／大部分帶 inferred_from，"
                                                 "座標被上游推斷記錄鎖定（需上游 re-inference）"}))
        else:
            # ⚠️ 2026-09-24（C4 對抗驗收）：原本報 `info` → 太容易被忽略。
            # 實測有 **10 個 ≥5 成員嘅簇（171 個 location 完全同座標）**，
            # 而 `fail` 門檻係 >20 → 所有 gate 綠燈但實際疊埋 = **靜默**。
            # 改成 `warning`：唔會令 gate FAIL，但會出現喺審計報告。
            out.append(finding(feats[0]["properties"]["id"], "R6_DUPLICATE", "warning",
                               {**evd, "reason": f"重合群 {len(feats)} 個成員"
                                                 "（全部可移動，未達 fail 門檻 20）"
                                                 " —— 標記會疊埋，建議加偏移"}))

    by_name: dict[str, list] = defaultdict(list)
    for f in loc:
        by_name[norm(f["properties"]["name"])].append(f)
    for nm, fs in sorted(by_name.items()):
        if len(fs) > 1:
            types = Counter(f["properties"].get("location_type") for f in fs)
            if len(types) > 1:
                out.append(finding(fs[0]["properties"]["id"], "R6_DUPLICATE", "fail",
                                   {"name": nm, "ids": [f["properties"]["id"] for f in fs],
                                    "types": dict(types), "reason": "同名但 location_type 衝突"}))

    n_fail = sum(1 for o in out if o["severity"] == "fail")
    return {
        "rule": "R6_DUPLICATE",
        "description": "標記塌縮 / 同名衝突 / 近重複",
        "n_findings": len(out),
        "n_fail": n_fail,
        "status": "fail" if n_fail else "pass",
        "summary": {
            "n_unique_coords": len(by_coord),
            "n_locations": len(loc),
            "n_collapse_clusters": sum(1 for v in by_coord.values() if len(v) >= 5),
            "n_locations_in_clusters": sum(len(v) for v in by_coord.values() if len(v) >= 5),
            "marker_collapse_max_members": THRESHOLDS["marker_collapse_max_members"],
        },
        "findings": out,
    }


# =====================================================================
# R7 Narrative temporal coherence
# =====================================================================


def rule_r7(rt, chronicle) -> dict:
    out: list[dict] = []
    entries = chronicle.get("entries", [])
    for e in entries:
        roles = {c.get("role") for c in (e.get("chapters") or []) if isinstance(c, dict)}
        if bool(e.get("flashback")) != ("flashback" in roles):
            out.append(finding(e["id"], "R7_TEMPORAL", "fail",
                               {"flashback": bool(e.get("flashback")), "roles": sorted(roles),
                                "reason": "flashback flag 同 chapters[].role 唔一致"}))

    non_fb = [e for e in entries if not e.get("flashback")]
    seq = sorted(
        [e for e in non_fb if e.get("story_time", {}).get("order") is not None
         and e.get("first_mention_chapter")],
        key=lambda e: e["first_mention_chapter"],
    )
    max_order = -1
    for e in seq:
        o = e["story_time"]["order"]
        if o < max_order:
            out.append(finding(e["id"], "R7_TEMPORAL", "warning",
                               {"first_mention_chapter": e["first_mention_chapter"],
                                "story_order": o, "prev_max_order": max_order,
                                "reason": "非回帶條目嘅 story_time.order 逆序"}))
        max_order = max(max_order, o)

    for f in rt:
        for w in f["properties"].get("waypoints") or []:
            if w.get("confidence") is not None and w["confidence"] < 0.5:
                out.append(finding(f["properties"]["id"], "R7_TEMPORAL", "warning",
                                   {"location_id": w["location_id"], "chapter": w["chapter"],
                                    "confidence": w["confidence"],
                                    "reason": "waypoint confidence < 0.5"}))

    n_fail = sum(1 for o in out if o["severity"] == "fail")
    return {
        "rule": "R7_TEMPORAL",
        "description": "flashback 豁免 / 章節順序一致性",
        "n_findings": len(out),
        "n_fail": n_fail,
        "status": "fail" if n_fail else "pass",
        "summary": {"n_entries": len(entries),
                    "n_flashback": sum(1 for e in entries if e.get("flashback")),
                    "n_flashback_flag_inconsistent": n_fail},
        "findings": out,
    }


# =====================================================================
# R8 Unknown over hallucination
# =====================================================================


def rule_r8(loc) -> dict:
    """規則 8：無法證明嘅座標**必須**標 `needs_validation`，唔可以假裝已驗證。

    B4 嘅確定性回填（`coordinate_review_status = needs_validation`）就係呢條
    規則嘅修復；所以違規 = 「冇證據但**冇**標 needs_validation」。
    """
    out: list[dict] = []
    n_no_evidence = 0
    for f in loc:
        p = f["properties"]
        prec = p.get("location_precision")
        has_src = bool(p.get("position_source"))
        has_inf = bool(p.get("inferred_from"))
        # 2026-09-24：由故事文字錨定（`coordinate_anchor`）**都係證據** ——
        # 佢記錄咗地標名、規則（A/B/C）同距離，比 `position_source` 更具體。
        has_anchor = bool(p.get("coordinate_anchor"))
        if prec in ("approximate", "fictional") and not has_src and not has_inf and not has_anchor:
            n_no_evidence += 1
            if p.get("coordinate_review_status") != "needs_validation":
                out.append(finding(p["id"], "R8_UNKNOWN", "fail",
                                   {"precision": prec, "confidence": p.get("confidence"),
                                    "coordinate_review_status": p.get("coordinate_review_status"),
                                    "reason": "冇座標證據但未標 needs_validation"}))
        if p.get("coordinate_confidence") == 0.0 and prec not in (None, "unknown"):
            out.append(finding(p["id"], "R8_UNKNOWN", "warning",
                               {"precision": prec, "coordinate_confidence": 0.0,
                                "reason": "confidence 0 但 precision 非 unknown（應顯示精度）"}))

    ratio = n_no_evidence / len(loc) if loc else 0.0
    n_fail = sum(1 for o in out if o["severity"] == "fail")
    return {
        "rule": "R8_UNKNOWN",
        "description": "無法證明 → unknown/approximate + needs_validation",
        "n_findings": len(out),
        "n_fail": n_fail,
        "status": "fail" if n_fail else "pass",
        "summary": {"n_locations": len(loc),
                    "n_approx_or_fictional_without_evidence": n_no_evidence,
                    "ratio": round(ratio, 4),
                    "max_ratio": THRESHOLDS["max_unknown_ratio"]},
        "findings": out,
    }


# =====================================================================
# run
# =====================================================================


def run_all_rules() -> dict:
    loc = load_fc("locations.geojson")
    ev = load_fc("events.geojson")
    rt = load_fc("routes.geojson")
    zn = load_fc("zones.geojson")
    chronicle = load("chronicle.json")

    rules = {
        "R1_geometry_validity": rule_r1(loc, ev, rt, zn),
        "R2_bounds": rule_r2(loc, ev, rt, zn),
        "R3_zone_membership": rule_r3(loc, ev, zn),
        "R4_route_continuity": rule_r4(rt),
        "R5_event_location_coherence": rule_r5(ev, loc),
        "R6_duplicate_near_duplicate": rule_r6(loc, zn),
        "R7_narrative_temporal": rule_r7(rt, chronicle),
        "R8_unknown_over_hallucination": rule_r8(loc),
    }

    by_sev: Counter = Counter()
    for r in rules.values():
        for f in r["findings"]:
            by_sev[f["severity"]] += 1

    return {
        "schema_version": SCHEMA_VERSION,
        "note": "B4 程式化座標完整性審計（R1–R8）。只讀 data/public。可重跑、確定性。",
        "inputs": {
            n: sha256(PUBLIC / n) for n in
            ("locations.geojson", "events.geojson", "routes.geojson",
             "zones.geojson", "chronicle.json")
        },
        "counts": {"locations": len(loc), "events": len(ev), "routes": len(rt), "zones": len(zn)},
        "thresholds": THRESHOLDS,
        "rules": rules,
        "summary": {
            "n_findings": sum(by_sev.values()),
            "by_severity": dict(sorted(by_sev.items())),
            "rules_failed": sorted(k for k, r in rules.items() if r["status"] == "fail"),
            "all_pass": all(r["status"] != "fail" for r in rules.values()),
        },
    }


def main() -> int:
    report = run_all_rules()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "coordinate-audit.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print("=== B4 座標完整性審計（R1–R8）===")
    print(f"locations={report['counts']['locations']} events={report['counts']['events']} "
          f"routes={report['counts']['routes']} zones={report['counts']['zones']}")
    for key, r in report["rules"].items():
        mark = {"pass": "✅", "fail": "❌"}[r["status"]]
        print(f"  {mark} {key:34s} findings={r['n_findings']:4d} fail={r['n_fail']}")
    print(f"\nseverity 分佈：{report['summary']['by_severity']}")
    print(f"失敗規則：{report['summary']['rules_failed'] or '（無）'}")
    print(f"報告 → {ARTIFACTS / 'coordinate-audit.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

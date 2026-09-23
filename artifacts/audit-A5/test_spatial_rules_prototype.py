"""A5 —— spec §2.2 八條自動檢查規則嘅**可重跑 pytest prototype**。

呢個檔案係**設計樣板**，唔屬於 `tests/`（唔可以改 production test）。
目的：示範每條規則嘅輸入、演算法、threshold、輸出格式同 pytest 斷言方式，
令 B4 可以照抄成 `scripts/audit_coordinate_integrity.py` + `tests/test_spatial_integrity.py`。

只讀 `data/public/`。唔讀 `data/private/`。

用法：
    pytest artifacts/audit-A5/test_spatial_rules_prototype.py -v
"""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PUBLIC = REPO / "data" / "public"

M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570
BASE_BBOX = {"lon_min": 113.79, "lon_max": 114.49, "lat_min": 22.11, "lat_max": 22.61}

#: 每個 threshold 都要有理由（可稽核）。B4 要保留呢個表。
THRESHOLDS = {
    "marker_collapse_max_members": 20,   # 同一像素 > 20 個 marker = 不可接受
    "near_dup_m": 50.0,                  # spec 規則 6
    "route_jump_m": 5000.0,              # 相鄰 waypoint 硬上限
    "route_jump_tight_ch": 2,            # 章節差 ≤ 2 就跳 > 上限 = 高可疑
    "zone_outside_m": 400.0,             # 落喺 polygon 外 = warning
    "zone_quarantine_m": 1500.0,         # 落喺 polygon 外 = quarantine
    "max_event_name_mismatch_ratio": 0.02,
    "max_unknown_ratio": 0.05,           # 冇證據座標佔比上限
}


def load(name):
    return json.loads((PUBLIC / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def loc():
    return load("locations.geojson")["features"]


@pytest.fixture(scope="module")
def ev():
    return load("events.geojson")["features"]


@pytest.fixture(scope="module")
def rt():
    return load("routes.geojson")["features"]


@pytest.fixture(scope="module")
def zn():
    return load("zones.geojson")["features"]


def dist_m(a, b):
    return math.hypot((b[0] - a[0]) * M_PER_DEG_LON, (b[1] - a[1]) * M_PER_DEG_LAT)


def in_bbox(c, bb=BASE_BBOX):
    return bb["lon_min"] <= c[0] <= bb["lon_max"] and bb["lat_min"] <= c[1] <= bb["lat_max"]


def point_in_ring(pt, ring):
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


# ---------- R1 Geometry validity ----------

def test_r1_geometry_is_finite_and_in_range(loc, ev, rt, zn):
    """所有座標必須係有限數字、lon∈[-180,180]、lat∈[-90,90]。"""
    bad = []
    for f in loc:
        c = f["geometry"]["coordinates"]
        if len(c) != 2 or any(math.isnan(v) or math.isinf(v) for v in c):
            bad.append(f["properties"]["id"])
        elif not (-180 <= c[0] <= 180 and -90 <= c[1] <= 90):
            bad.append(f["properties"]["id"])
    assert not bad, f"非法座標：{bad[:10]}"


def test_r1_polygon_rings_closed_and_min_vertices(zn):
    bad = [f["properties"]["id"] for f in zn
           if len(f["geometry"]["coordinates"][0]) < 4
           or f["geometry"]["coordinates"][0][0] != f["geometry"]["coordinates"][0][-1]]
    assert not bad, f"polygon 未閉合或頂點不足：{bad}"


def test_r1_no_consecutive_duplicate_vertices(rt, zn):
    """LineString 相鄰重複點 = 幾何退化。"""
    bad = []
    for f in rt:
        cs = f["geometry"]["coordinates"]
        if any(cs[i] == cs[i + 1] for i in range(len(cs) - 1)):
            bad.append(f["properties"]["id"])
    assert not bad, f"route 有相鄰重複頂點：{bad}"


# ---------- R2 Bounds ----------

def test_r2_all_points_inside_basemap_bbox(loc, ev, rt, zn):
    """spec 規則 2：任何 marker 都唔可以落喺 base-map 可視世界之外。"""
    out = []
    for f in loc:
        if not in_bbox(f["geometry"]["coordinates"]):
            out.append(("location", f["properties"]["id"], f["geometry"]["coordinates"]))
    for f in ev:
        if not in_bbox(f["geometry"]["coordinates"]):
            out.append(("event", f["properties"]["id"], f["geometry"]["coordinates"]))
    for f in rt:
        for c in f["geometry"]["coordinates"]:
            if not in_bbox(c):
                out.append(("route", f["properties"]["id"], c))
    for f in zn:
        for c in f["geometry"]["coordinates"][0]:
            if not in_bbox(c):
                out.append(("zone", f["properties"]["id"], c))
                break
    assert not out, f"{len(out)} 個座標越出 base-map bbox：{out[:5]}"


# ---------- R3 Zone membership ----------

def test_r3_zone_linked_locations_are_inside_or_near_polygon(loc, zn):
    """spec 規則 3：有 zone_ids 嘅 location 必須落喺 polygon 內或合理接近。

    超過 quarantine 門檻 → fail（要 quarantine 或改 zone_ids）。
    """
    ring = {f["properties"]["id"]: f["geometry"]["coordinates"][0] for f in zn}
    far = []
    for f in loc:
        for zid in f["properties"].get("zone_ids") or []:
            r = ring.get(zid)
            if r is None or point_in_ring(f["geometry"]["coordinates"], r):
                continue
            # 用頂點最近距離做 proxy（同 spatial_audit.py 一致）
            d = min(dist_m(f["geometry"]["coordinates"], v) for v in r)
            if d > THRESHOLDS["zone_quarantine_m"]:
                far.append((f["properties"]["id"], zid, round(d, 1)))
    assert not far, f"{len(far)} 個 location 遠離其 zone polygon（> {THRESHOLDS['zone_quarantine_m']}m）：{far[:5]}"


def test_r3_events_have_resolvable_zone_or_null(loc, ev):
    """每個 event 嘅 location_id 必須存在，或 null（未指派）。"""
    loc_ids = {f["properties"]["id"] for f in loc}
    dangling = [f["properties"]["id"] for f in ev
                if f["properties"]["location_id"] not in (None, *loc_ids)]
    assert not dangling, f"event 引用唔存在 location：{dangling[:5]}"


# ---------- R4 Route continuity ----------

def test_r4_no_hard_route_jump(rt):
    """spec 規則 4：相鄰 waypoint 唔可以出現 > 5 km 硬跳躍（除非有跨區 evidence）。

    呢個係 hard gate；warning 級（>2km 且章節差 ≤2）由 audit 報告列出，
    要 B4 用 chapter gap + 交通 evidence 逐條判。
    """
    jumps = []
    for f in rt:
        p = f["properties"]
        cs = f["geometry"]["coordinates"]
        for i in range(len(cs) - 1):
            d = dist_m(cs[i], cs[i + 1])
            if d > THRESHOLDS["route_jump_m"]:
                jumps.append((p["id"], round(d, 1)))
    assert not jumps, f"{len(jumps)} 個 route 硬跳躍：{jumps[:5]}"


def test_r4_waypoint_chapters_monotonic(rt):
    """waypoint 章節必須單調不減（時間順序）。"""
    bad = []
    for f in rt:
        wps = f["properties"]["waypoints"]
        if any(wps[i + 1]["chapter"] < wps[i]["chapter"] for i in range(len(wps) - 1)):
            bad.append(f["properties"]["id"])
    assert not bad, f"route waypoint 章節非單調：{bad}"


# ---------- R5 Event-location coherence ----------

def test_r5_event_name_matches_location(loc, ev):
    """spec 規則 5：event.location_name 必須同 location.name 一致（正規化後）。"""
    name = {f["properties"]["id"]: f["properties"]["name"] for f in loc}
    mismatch = []
    for f in ev:
        p = f["properties"]
        lid, en = p.get("location_id"), p.get("location_name")
        if lid in name and en and en.replace("的", "") != name[lid].replace("的", ""):
            mismatch.append((p["id"], en, name[lid]))
    ratio = len(mismatch) / len(ev)
    assert ratio <= THRESHOLDS["max_event_name_mismatch_ratio"], (
        f"{len(mismatch)}/{len(ev)} ({ratio:.1%}) event location_name 同 location 名唔一致：{mismatch[:5]}"
    )


# ---------- R6 Duplicate / near-duplicate ----------

def test_r6_no_marker_collapse(loc):
    """spec 規則 6：非常近 marker 必須 resolve 或 cluster。

    同一座標塞 > N 個 marker = 地圖上完全分唔開 → fail。
    """
    by = defaultdict(list)
    for f in loc:
        c = f["geometry"]["coordinates"]
        by[(round(c[0], 9), round(c[1], 9))].append(f["properties"]["id"])
    big = {k: v for k, v in by.items() if len(v) > THRESHOLDS["marker_collapse_max_members"]}
    assert not big, (
        f"{len(big)} 個座標點塞咗 > {THRESHOLDS['marker_collapse_max_members']} 個 marker："
        f"{[(k, len(v)) for k, v in list(big.items())[:3]]}"
    )


def test_r6_no_conflicting_type_same_name(loc):
    """同名 location 唔可以有衝突 location_type。"""
    by = defaultdict(set)
    for f in loc:
        by[f["properties"]["name"]].add(f["properties"]["location_type"])
    conflict = {k: v for k, v in by.items() if len(v) > 1}
    assert not conflict, f"同名但 type 衝突：{conflict}"


# ---------- R7 Narrative temporal coherence ----------

def test_r7_flashback_flag_consistent_with_role():
    """spec 規則 7：chronicle `flashback` flag 必須同 chapters[].role 一致。"""
    entries = load("chronicle.json")["entries"]
    bad = []
    for e in entries:
        roles = {c.get("role") for c in (e.get("chapters") or []) if isinstance(c, dict)}
        if bool(e.get("flashback")) != ("flashback" in roles):
            bad.append(e["id"])
    assert not bad, f"{len(bad)} 條 chronicle flashback flag 同 role 唔一致：{bad[:5]}"


# ---------- R8 Unknown over hallucination ----------

def test_r8_no_unsourced_approximate_coordinates(loc):
    """spec 規則 8：approximate／fictional 座標必須有來源證據（position_source 或 inferred_from）。

    冇證據就應該降級為 unknown，唔可以假裝 approximate。
    """
    bad = []
    for f in loc:
        p = f["properties"]
        if p.get("location_precision") in ("approximate", "fictional") \
                and not p.get("position_source") and not p.get("inferred_from"):
            bad.append(p["id"])
    ratio = len(bad) / len(loc)
    assert ratio <= THRESHOLDS["max_unknown_ratio"], (
        f"{len(bad)}/{len(loc)} ({ratio:.1%}) 條 approximate／fictional 冇座標來源證據"
        f"（> {THRESHOLDS['max_unknown_ratio']:.0%}）：{bad[:8]}"
    )

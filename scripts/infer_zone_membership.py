#!/usr/bin/env python3
"""B4 —— Zone ↔ Location ↔ Event ↔ Character 三層 join + 座標完整性回填。

為何要獨立一支腳本
==================
v1 嘅 zone↔location 關聯只靠「location 名 **完全等於** zone 名或 alias」
（`merge_zone_dossiers.py` 舊寫法）→ 只有 **88/704（12.5%）** 地點有
`zone_ids`，令事件↔zone 覆蓋率只有 **674/1796（37.5%）**。後果係
「睇相關事件」journey 空洞，而 12 條明顯錯配（最遠 3,036.9 m）冇人捉到。

做法（全部確定性、可重跑、零人手）
==================================
三層 join（spec §4.2 / spatial-data-contract §6）：

    Layer 3（幾何，優先）point-in-polygon（ray casting）
            命中多個 → 取面積最小者
    Layer 2（名稱）zone.name / zone.aliases ⊂ location.name（正規化子字串）
    Layer 1（既有）location.zone_ids（legacy 名相等配對）
            無幾何命中 → 用 Layer2 ∪ Layer1，按「點到 polygon 邊距離」分級：
              d ≤ 1.5 × radius_m  → validated
              1.5× < d ≤ 3×        → needs_validation（保留）
              d > 3×               → quarantined（剔除）

另加兩件事（同一次 run 完成，因為佢哋都要改座標）：
  1. **標記塌縮修復**：完全相同座標、成員 ≥5 嘅簇 → deterministic 環形散佈。
     ⚠️ **跳過 `inferred_from` 非空嘅地點** —— 佢哋嘅座標被上游推斷記錄
     （`data/private/review/place-inference.jsonl`）鎖定，移動會破壞
     `test_applied_coordinates_match_inference`（規則 C2）。
  2. **`coordinate_*` 回填**（spec §2.2）：`coordinate_confidence` /
     `coordinate_source` / `coordinate_review_status` / `spatial_evidence_count`。

**只讀／只寫 `data/public/`。唔會讀 `data/private/`。**

用法：
    python scripts/infer_zone_membership.py --dry-run
    python scripts/infer_zone_membership.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
ARTIFACTS = REPO / "artifacts" / "b4"

SCHEMA_VERSION = 2

M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570

#: `location_precision` → `coordinate_confidence`（spec §2.2）
PRECISION_CONFIDENCE: dict[str, float] = {
    "exact": 0.95,
    "verified": 0.95,
    "district": 0.8,
    "approximate": 0.55,
    "fictional": 0.35,
    "unknown": 0.0,
}

#: 標記塌縮：完全同座標、成員 ≥ 呢個數 = 一個塌縮簇。
COLLAPSE_MIN_MEMBERS = 5
#: 環形散佈半徑 = clamp(BASE × √n, MIN, MAX)（米）。由簇大小推導（確定性，
#: 唔依賴 zone，避免「改地點 → 改 zone → 再改地點」嘅循環）。
COLLAPSE_RADIUS_BASE = 18.0
COLLAPSE_RADIUS_MIN = 40.0
COLLAPSE_RADIUS_MAX = 160.0

#: 距離分級（spec §4 R3）
ZONE_VALID_MULT = 1.5
ZONE_QUARANTINE_MULT = 3.0

#: **Gate 1 實測 baseline**（A5 `docs/audits/spatial-integrity-audit.md`，B4 之前）。
#: 寫死做常數而唔係每次重算 —— 因為 join 一寫入 `zone_ids`，「before」就會
#: 等於上一次嘅「after」，令 artifact 唔再 byte-stable（idempotency 硬性要求）。
#:   - `zone_event_linked`  = 674 / 1796 = 37.5%
#:   - `location_with_zone` = 88 / 704  = 12.5%
LEGACY_ZONE_EVENT_LINKED = 674
LEGACY_LOCATION_WITH_ZONE = 88

_NORM_MAP = {"邨": "村", "嘅": "的", "「": "", "」": ""}


def norm(name: str) -> str:
    s = (name or "").strip()
    for a, b in _NORM_MAP.items():
        s = s.replace(a, b)
    return re.sub(r"\s+", "", s)


def dist_m(a, b) -> float:
    return math.hypot((b[0] - a[0]) * M_PER_DEG_LON, (b[1] - a[1]) * M_PER_DEG_LAT)


def ring_area_m2(ring: list[list[float]]) -> float:
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0 * M_PER_DEG_LON * M_PER_DEG_LAT


def point_in_ring(pt, ring) -> bool:
    """Ray casting（spec §4 R3）。"""
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
    """點到 polygon 邊嘅最短距離（米）。點喺內部回 0。"""
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


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load(name: str) -> Any:
    return json.loads((PUBLIC / name).read_text(encoding="utf-8"))


def dump(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_fc(name: str) -> list[dict]:
    return load(name)["features"]


# =====================================================================
# 1. 標記塌縮修復
# =====================================================================


def fix_marker_collapse(locations: list[dict]) -> dict:
    """對「完全相同座標、成員 ≥ COLLAPSE_MIN_MEMBERS」嘅簇做確定性環形散佈。

    ⚠️ 跳過 `inferred_from` 非空嘅地點（座標被上游推斷記錄鎖定）。
    回傳報告（唔會寫檔）。
    """
    by_coord: dict[tuple, list[dict]] = defaultdict(list)
    for f in locations:
        c = f["geometry"]["coordinates"]
        by_coord[(round(c[0], 9), round(c[1], 9))].append(f)

    moved: list[dict] = []
    locked_clusters: list[dict] = []

    for key in sorted(by_coord):
        feats = by_coord[key]
        if len(feats) < COLLAPSE_MIN_MEMBERS:
            continue
        movable = sorted(
            (f for f in feats if not f["properties"].get("inferred_from")),
            key=lambda f: f["properties"]["id"],
        )
        locked = [f for f in feats if f["properties"].get("inferred_from")]
        if locked:
            locked_clusters.append({
                "coords": [key[0], key[1]],
                "n_members": len(feats),
                "n_locked_inferred": len(locked),
                "n_movable": len(movable),
                "sample": [f["properties"]["name"] for f in feats[:5]],
            })
        if len(movable) < 2:
            continue

        n = len(movable)
        radius = min(
            COLLAPSE_RADIUS_MAX,
            max(COLLAPSE_RADIUS_MIN, COLLAPSE_RADIUS_BASE * math.sqrt(n)),
        )
        # 確定性相位（由簇座標 hash 決定，唔用 random）
        h = int(hashlib.sha1(f"{key[0]:.9f},{key[1]:.9f}".encode()).hexdigest(), 16)
        phase = (h % 3600) / 3600.0 * 2 * math.pi
        for i, f in enumerate(movable):
            ang = phase + 2 * math.pi * i / n
            lon = key[0] + radius * math.cos(ang) / M_PER_DEG_LON
            lat = key[1] + radius * math.sin(ang) / M_PER_DEG_LAT
            f["geometry"]["coordinates"] = [round(lon, 6), round(lat, 6)]
            moved.append({
                "id": f["properties"]["id"],
                "name": f["properties"]["name"],
                "from": [key[0], key[1]],
                "to": f["geometry"]["coordinates"],
            })

    return {
        "threshold_members": COLLAPSE_MIN_MEMBERS,
        "radius_formula": f"clamp({COLLAPSE_RADIUS_BASE}*sqrt(n), {COLLAPSE_RADIUS_MIN}, {COLLAPSE_RADIUS_MAX})",
        "n_clusters_ge_threshold": sum(1 for v in by_coord.values() if len(v) >= COLLAPSE_MIN_MEMBERS),
        "n_moved": len(moved),
        "moved": moved,
        "locked_clusters": locked_clusters,
        "note": "inferred_from 非空嘅地點座標被上游推斷記錄鎖定，B4 唔可以移動（規則 C2）。",
    }


def propagate_coordinates(locations: list[dict], events: list[dict],
                          timeline: list[dict], routes: list[dict]) -> dict:
    """將 location 座標傳播到 events / timeline / routes waypoints。

    為何必須：移動地點之後如果唔傳播，`test_event_coords_match_location` 會失敗。
    """
    xy = {f["properties"]["id"]: f["geometry"]["coordinates"] for f in locations}
    n_ev = n_tl = n_rt = 0
    for f in events:
        lid = f["properties"].get("location_id")
        if lid and lid in xy and f["geometry"]["coordinates"] != xy[lid]:
            f["geometry"]["coordinates"] = list(xy[lid])
            n_ev += 1
    for t in timeline:
        lid = t.get("location_id")
        if lid and lid in xy and t.get("coords") != xy[lid]:
            t["coords"] = list(xy[lid])
            n_tl += 1
    for f in routes:
        wps = f["properties"].get("waypoints") or []
        coords = f["geometry"]["coordinates"]
        for i, w in enumerate(wps):
            lid = w.get("location_id")
            if lid and lid in xy and i < len(coords) and coords[i] != xy[lid]:
                coords[i] = list(xy[lid])
                n_rt += 1
    return {"events": n_ev, "timeline": n_tl, "route_waypoints": n_rt}


# =====================================================================
# 2. 三層 join
# =====================================================================


def build_zone_index(zones: list[dict]) -> list[dict]:
    out = []
    for f in zones:
        p = f["properties"]
        ring = f["geometry"]["coordinates"][0]
        out.append({
            "id": p["id"],
            "name": p["name"],
            "aliases": p.get("aliases") or [],
            "chapters": sorted(p.get("chapters") or []),
            "radius_m": float(p.get("radius_m") or 0.0),
            "ring": ring,
            "area_m2": ring_area_m2(ring),
        })
    out.sort(key=lambda z: z["id"])
    return out


def join_membership(locations: list[dict], zones: list[dict]) -> tuple[dict, list[dict]]:
    """回傳 (loc_id → membership, audit rows)。確定性、無副作用。"""
    zi = build_zone_index(zones)
    zone_by_id = {z["id"]: z for z in zi}

    name_map: dict[str, list[str]] = defaultdict(list)
    for z in zi:
        for nm in [z["name"], *z["aliases"]]:
            k = norm(nm)
            if len(k) >= 2:
                name_map[k].append(z["id"])

    membership: dict[str, dict] = {}
    audit: list[dict] = []

    for f in locations:
        p = f["properties"]
        lid = p["id"]
        c = f["geometry"]["coordinates"]

        geom = [z for z in zi if point_in_ring(c, z["ring"])]
        if geom:
            geom.sort(key=lambda z: (z["area_m2"], z["id"]))
            primary = geom[0]
            membership[lid] = {
                "zone_ids": [primary["id"]],
                "source": "geometry",
                "review_status": "validated",
            }
            if len(geom) > 1:
                audit.append({
                    "feature_id": lid,
                    "rule": "Z-JOIN-OVERLAP",
                    "severity": "info",
                    "evidence": {
                        "chosen": primary["id"],
                        "alternatives": [z["id"] for z in geom[1:]],
                        "reason": "命中多個 polygon → 取面積最小者",
                    },
                })
            continue

        nm = norm(p["name"])
        cand_src: dict[str, str] = {}
        for k, zids in name_map.items():
            if k in nm:
                for zid in zids:
                    cand_src.setdefault(zid, "name")
        for zid in p.get("zone_ids") or []:
            if zid in zone_by_id:
                cand_src.setdefault(zid, "legacy")

        if not cand_src:
            membership[lid] = {
                "zone_ids": [], "source": None, "review_status": "needs_validation",
            }
            continue

        keep: list[str] = []
        quarantined: list[str] = []
        flagged = False
        for zid in sorted(cand_src):
            z = zone_by_id[zid]
            d = dist_point_to_ring(c, z["ring"])
            r = z["radius_m"] or 300.0
            if d <= ZONE_VALID_MULT * r:
                keep.append(zid)
            elif d <= ZONE_QUARANTINE_MULT * r:
                keep.append(zid)
                flagged = True
                audit.append({
                    "feature_id": lid, "rule": "R3_ZONE_MEMBERSHIP",
                    "severity": "warning",
                    "evidence": {"zone_id": zid, "distance_m": round(d, 1),
                                 "limit_m": round(ZONE_VALID_MULT * r, 1),
                                 "source": cand_src[zid]},
                })
            else:
                quarantined.append(zid)
                flagged = True
                audit.append({
                    "feature_id": lid, "rule": "R3_ZONE_MEMBERSHIP",
                    "severity": "quarantine",
                    "evidence": {"zone_id": zid, "distance_m": round(d, 1),
                                 "limit_m": round(ZONE_QUARANTINE_MULT * r, 1),
                                 "source": cand_src[zid],
                                 "reason": "名相等硬連但幾何距離過遠 → 剔除"},
                })

        if not keep:
            membership[lid] = {
                "zone_ids": [], "source": None, "review_status": "quarantined",
            }
            continue

        rank = {"geometry": 3, "name": 2, "legacy": 1}
        best = max((cand_src[z] for z in keep), key=lambda s: rank[s])
        membership[lid] = {
            "zone_ids": sorted(keep),
            "source": best,
            "review_status": "needs_validation" if flagged else "validated",
        }

    return membership, audit


# =====================================================================
# 3. Zone 連結（event_ids / character_ids / member_location_ids）
# =====================================================================


def compute_zone_links(locations: list[dict], zones: list[dict],
                       events: list[dict], routes: list[dict],
                       characters: list[dict],
                       membership: dict) -> dict:
    """回傳 zone_id → {member_location_ids, event_ids, character_ids}。"""
    zi = {z["id"]: z for z in build_zone_index(zones)}
    valid_char = {c["id"] for c in characters}

    members: dict[str, list[str]] = defaultdict(list)
    for f in locations:
        for zid in membership.get(f["properties"]["id"], {}).get("zone_ids", []):
            if zid in zi:
                members[zid].append(f["properties"]["id"])

    event_ids: dict[str, list[str]] = defaultdict(list)
    event_zone: dict[str, str] = {}
    for e in events:
        lid = e["properties"].get("location_id")
        zids = membership.get(lid or "", {}).get("zone_ids", [])
        if not zids:
            continue
        zids = [z for z in zids if z in zi]
        if not zids:
            continue
        primary = min(zids, key=lambda z: (zi[z]["area_m2"], z))
        event_ids[primary].append(e["properties"]["id"])
        event_zone[e["properties"]["id"]] = primary

    chars: dict[str, set] = defaultdict(set)
    for e in events:
        zid = event_zone.get(e["properties"]["id"])
        if not zid:
            continue
        for cid in e["properties"].get("characters") or []:
            if cid in valid_char:
                chars[zid].add(cid)
    for f in routes:
        for w in f["properties"].get("waypoints") or []:
            for zid in membership.get(w.get("location_id") or "", {}).get("zone_ids", []):
                if zid in zi:
                    cid = f["properties"].get("character_id")
                    if cid in valid_char:
                        chars[zid].add(cid)

    out = {}
    for zid in zi:
        out[zid] = {
            "member_location_ids": sorted(members.get(zid, [])),
            "event_ids": sorted(event_ids.get(zid, [])),
            "character_ids": sorted(chars.get(zid, [])),
        }
    return {"zones": out, "event_zone": event_zone}


# =====================================================================
# 4. coordinate_* 回填
# =====================================================================


def _confidence_of_precision(precision: str | None) -> float:
    return PRECISION_CONFIDENCE.get(precision or "unknown", 0.0)


def _chapter_overlap(chapters: list, zone_chapters: list) -> int:
    if not zone_chapters:
        return 0
    return len(set(chapters or []) & set(zone_chapters))


def backfill_locations(locations: list[dict], zones: list[dict],
                       membership: dict) -> None:
    zi = {z["id"]: z for z in build_zone_index(zones)}
    for f in locations:
        p = f["properties"]
        lid = p["id"]
        m = membership.get(lid, {})
        zids = sorted(z for z in m.get("zone_ids", []) if z in zi)
        zchapters = sorted({c for z in zids for c in zi[z]["chapters"]})

        if zids:
            p["zone_ids"] = zids
        else:
            p.pop("zone_ids", None)

        if p.get("inferred_from"):
            p["coordinate_source"] = "cross_chapter_evidence"
        elif "校正" in (p.get("position_source") or ""):
            p["coordinate_source"] = "manual_geometry"
        else:
            p["coordinate_source"] = "legacy"

        p["coordinate_review_status"] = (
            "auto_corrected" if p.get("coord_corrected") else "needs_validation"
        )
        p["coordinate_confidence"] = _confidence_of_precision(p.get("location_precision"))
        p["spatial_evidence_count"] = _chapter_overlap(p.get("chapters") or [], zchapters)
        p["zone_membership_source"] = m.get("source")
        p["zone_membership_review_status"] = m.get("review_status", "needs_validation")


def backfill_events(events: list[dict], loc_by_id: dict, event_zone: dict,
                    zones: list[dict]) -> None:
    zi = {z["id"]: z for z in build_zone_index(zones)}
    for f in events:
        p = f["properties"]
        lid = p.get("location_id")
        loc = loc_by_id.get(lid) if lid else None
        zid = event_zone.get(p["id"])
        p["zone_id"] = zid
        if loc is None:
            p["coordinate_source"] = "legacy"
            p["coordinate_review_status"] = "needs_validation"
            p["coordinate_confidence"] = 0.0
            p["spatial_evidence_count"] = 0
        else:
            lp = loc["properties"]
            p["coordinate_source"] = lp.get("coordinate_source", "legacy")
            p["coordinate_review_status"] = lp.get("coordinate_review_status", "needs_validation")
            p["coordinate_confidence"] = _confidence_of_precision(lp.get("location_precision"))
            zch = sorted(zi[zid]["chapters"]) if zid in zi else []
            p["spatial_evidence_count"] = _chapter_overlap(p.get("chapter_refs") or [], zch)


def backfill_routes(routes: list[dict], loc_by_id: dict, membership: dict,
                    zones: list[dict]) -> None:
    zi = {z["id"]: z for z in build_zone_index(zones)}
    for f in routes:
        for w in f["properties"].get("waypoints") or []:
            lid = w.get("location_id")
            loc = loc_by_id.get(lid) if lid else None
            if loc is None:
                w["coordinate_source"] = "legacy"
                w["coordinate_review_status"] = "needs_validation"
                w["coordinate_confidence"] = 0.0
                w["spatial_evidence_count"] = 0
                continue
            lp = loc["properties"]
            w["coordinate_source"] = lp.get("coordinate_source", "legacy")
            w["coordinate_review_status"] = lp.get("coordinate_review_status", "needs_validation")
            w["coordinate_confidence"] = _confidence_of_precision(lp.get("location_precision"))
            zids = [z for z in membership.get(lid, {}).get("zone_ids", []) if z in zi]
            zch = sorted({c for z in zids for c in zi[z]["chapters"]})
            w["spatial_evidence_count"] = _chapter_overlap([w.get("chapter")], zch)


def backfill_zones(zones: list[dict], links: dict, event_chapter: dict) -> None:
    for f in zones:
        p = f["properties"]
        zid = p["id"]
        zl = links["zones"].get(zid, {})
        radius_source = p.get("radius_source")
        coords_source = p.get("coords_source")
        if radius_source == "members":
            p["coordinate_source"] = "cross_chapter_evidence"
            p["coordinate_review_status"] = "auto_corrected"
            p["coordinate_confidence"] = 0.95
        elif coords_source and coords_source != "unknown":
            p["coordinate_source"] = "zone_inference"
            p["coordinate_review_status"] = "needs_validation"
            p["coordinate_confidence"] = 0.55
        else:
            p["coordinate_source"] = "legacy"
            p["coordinate_review_status"] = "needs_validation"
            p["coordinate_confidence"] = 0.0
        chapters = set(p.get("chapters") or [])
        p["spatial_evidence_count"] = sum(
            1 for eid in zl.get("event_ids", []) if event_chapter.get(eid) in chapters
        )


# =====================================================================
# 5. run
# =====================================================================


def collapse_state(locations: list[dict]) -> dict:
    """**狀態**報告（唔係動作記錄）—— 跑幾多次都一樣，可以做 idempotency 比對。

    分別好重要：
      - 動作記錄（「今次移動咗 18 個」）第一次跑係 18、第二次係 0 → 唔穩定。
      - 狀態報告（「而家仲有幾多個塌縮簇、幾多個被 inferred_from 鎖住」）
        散佈完成之後就固定 → 穩定。
    """
    by_coord: dict[tuple, list[dict]] = defaultdict(list)
    for f in locations:
        c = f["geometry"]["coordinates"]
        by_coord[(round(c[0], 9), round(c[1], 9))].append(f)

    clusters = []
    for key in sorted(by_coord):
        feats = by_coord[key]
        if len(feats) < COLLAPSE_MIN_MEMBERS:
            continue
        locked = [f for f in feats if f["properties"].get("inferred_from")]
        movable = [f for f in feats if not f["properties"].get("inferred_from")]
        clusters.append({
            "coords": [key[0], key[1]],
            "n_members": len(feats),
            "n_locked_inferred": len(locked),
            "n_movable": len(movable),
            "sample": sorted(f["properties"]["name"] for f in feats)[:5],
        })
    return {
        "threshold_members": COLLAPSE_MIN_MEMBERS,
        "radius_formula": f"clamp({COLLAPSE_RADIUS_BASE}*sqrt(n), {COLLAPSE_RADIUS_MIN}, {COLLAPSE_RADIUS_MAX})",
        "n_clusters_ge_threshold": len(clusters),
        "n_members_in_clusters": sum(c["n_members"] for c in clusters),
        "n_locked_inferred": sum(c["n_locked_inferred"] for c in clusters),
        "n_movable_remaining": sum(c["n_movable"] for c in clusters),
        "clusters": clusters,
        "note": "inferred_from 非空嘅地點座標被上游推斷記錄鎖定，B4 唔可以移動（規則 C2）。"
                "剩餘塌縮簇要等上游 re-inference 才能解，唔當 fail。",
    }


def fix_marker_collapse_and_propagate(write: bool = True) -> dict:
    """獨立一步：標記塌縮修復 + 座標傳播。

    為何要喺 zone 幾何計算**之前**做：zone polygon 係由成員地點座標推導
    （凸包 + 外擴），如果成員仲喺塌縮狀態，zone 幾何會退化；先散佈再算
    幾何，重跑結果才穩定（idempotent）。

    ⚠️ 回傳值係**動作記錄**（「今次移動咗幾個」），第一次跑會係 18、之後係 0，
    所以**唔會**寫入 artifact —— 穩定嘅狀態報告由 `collapse_state()` 提供，
    並收錄喺 `artifacts/b4/zone-membership.json`。
    """
    loc_fc = load("locations.geojson")
    ev_fc = load("events.geojson")
    rt_fc = load("routes.geojson")
    tl = load("timeline.json")

    collapse = fix_marker_collapse(loc_fc["features"])
    prop = propagate_coordinates(loc_fc["features"], ev_fc["features"], tl, rt_fc["features"])

    if write:
        dump(PUBLIC / "locations.geojson", loc_fc)
        dump(PUBLIC / "events.geojson", ev_fc)
        dump(PUBLIC / "routes.geojson", rt_fc)
        dump(PUBLIC / "timeline.json", tl)
    return {"marker_collapse": collapse, "propagation": prop}


def run(write: bool = True) -> dict:
    """三層 join + `coordinate_*` 回填。

    ⚠️ **唔會**做標記塌縮修復 —— 塌縮必須先跑（見
    `fix_marker_collapse_and_propagate()`），因為 zone 幾何由成員座標推導，
    次序顛倒會令 pipeline 非冪等（第一次跑 zone 用舊座標、第二次用新座標）。
    """
    loc_fc = load("locations.geojson")
    ev_fc = load("events.geojson")
    rt_fc = load("routes.geojson")
    zn_fc = load("zones.geojson")
    timeline = load("timeline.json")
    characters = load("characters.json")

    locations = loc_fc["features"]
    events = ev_fc["features"]
    routes = rt_fc["features"]
    zones = zn_fc["features"]

    inputs = {
        "locations.geojson": sha256(PUBLIC / "locations.geojson"),
        "events.geojson": sha256(PUBLIC / "events.geojson"),
        "routes.geojson": sha256(PUBLIC / "routes.geojson"),
        "zones.geojson": sha256(PUBLIC / "zones.geojson"),
    }

    membership, join_audit = join_membership(locations, zones)
    links = compute_zone_links(locations, zones, events, routes, characters, membership)

    loc_by_id = {f["properties"]["id"]: f for f in locations}
    event_chapter = {e["properties"]["id"]: e["properties"].get("chapter") for e in events}

    backfill_locations(locations, zones, membership)
    backfill_events(events, loc_by_id, links["event_zone"], zones)
    backfill_routes(routes, loc_by_id, membership, zones)
    backfill_zones(zones, links, event_chapter)

    # ⚠️ 「before」唔可以即時計 —— join 寫入 `zone_ids` 之後，重跑時
    # 「before」會等於上一次嘅「after」，artifact 就唔會 byte-stable。
    # 所以 legacy baseline 係 **Gate 1 實測常數**（A5 審計），唔係每次重算。
    after_cov = sum(1 for e in events if e["properties"].get("zone_id"))
    loc_cov = sum(1 for f in locations if f["properties"].get("zone_ids"))

    report = {
        "schema_version": SCHEMA_VERSION,
        "inputs": inputs,
        "counts": {
            "locations": len(locations),
            "events": len(events),
            "routes": len(routes),
            "zones": len(zones),
        },
        "legacy_baseline": {
            "note": "B4 之前（v1，Gate 1 實測）嘅覆蓋率；寫死做常數，令 artifact byte-stable。",
            "zone_event_linked": LEGACY_ZONE_EVENT_LINKED,
            "zone_event_ratio": round(LEGACY_ZONE_EVENT_LINKED / len(events), 4),
            "location_with_zone": LEGACY_LOCATION_WITH_ZONE,
            "location_ratio": round(LEGACY_LOCATION_WITH_ZONE / len(locations), 4),
        },
        "zone_event_coverage": {
            "after": after_cov,
            "after_ratio": round(after_cov / len(events), 4),
            "target_ratio": 0.85,
            "target_met": (after_cov / len(events)) >= 0.85,
            "unresolved": len(events) - after_cov,
            "delta_vs_legacy": after_cov - LEGACY_ZONE_EVENT_LINKED,
        },
        "location_zone_coverage": {
            "after": loc_cov,
            "after_ratio": round(loc_cov / len(locations), 4),
            "delta_vs_legacy": loc_cov - LEGACY_LOCATION_WITH_ZONE,
        },
        "membership_source": dict(
            sorted(
                {
                    s: sum(1 for m in membership.values() if m.get("source") == s)
                    for s in ("geometry", "name", "legacy", None)
                }.items(),
                key=lambda kv: str(kv[0]),
            )
        ),
        "membership_review_status": dict(
            sorted(
                {
                    s: sum(1 for m in membership.values() if m.get("review_status") == s)
                    for s in ("validated", "needs_validation", "quarantined")
                }.items()
            )
        ),
        "marker_collapse_state": collapse_state(locations),
        "join_audit": join_audit,
    }

    if write:
        dump(PUBLIC / "locations.geojson", loc_fc)
        dump(PUBLIC / "events.geojson", ev_fc)
        dump(PUBLIC / "routes.geojson", rt_fc)
        dump(PUBLIC / "timeline.json", timeline)
        # ⚠️ zones.geojson 都要寫：`backfill_zones()` 加咗 `coordinate_*`，
        # 下游 `build_zone_dossiers.py` 係由**檔案**讀（唔係由記憶體傳），
        # 唔寫嘅話 4 個 zone 座標欄位會靜默消失。
        # 呢個係 v1 基礎欄位 + `coordinate_*`；v2 遷移係下一個階段嘅事。
        dump(PUBLIC / "zones.geojson", zn_fc)
        dump(ARTIFACTS / "zone-membership.json", report)

    return report


def main() -> int:
    ap = argparse.ArgumentParser(description="zone 三層 join + 座標回填")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--phase",
        choices=("collapse", "join", "all"),
        default="all",
        help="collapse = 只做標記塌縮修復；join = 只做三層 join（假設已散佈）；"
             "all = 兩者順序跑（塌縮一定要先）",
    )
    args = ap.parse_args()

    write = not args.dry_run
    collapse_report = None
    if args.phase in ("collapse", "all"):
        collapse_report = fix_marker_collapse_and_propagate(write=write)

    if args.phase == "collapse":
        mc = collapse_report["marker_collapse"]
        print("=== B4 標記塌縮修復 ===")
        print(f"簇 {mc['n_clusters_ge_threshold']} 個 → 散佈 {mc['n_moved']} 個地點"
              f"；鎖定（inferred_from）簇 {len(mc['locked_clusters'])} 個")
        print(f"座標傳播：{collapse_report['propagation']}")
        if args.dry_run:
            print("（--dry-run：冇寫入）")
        return 0

    report = run(write=write)
    cov = report["zone_event_coverage"]
    lcov = report["location_zone_coverage"]
    lb = report["legacy_baseline"]
    print("=== B4 zone↔event 三層 join ===")
    print(f"location→zone：{lb['location_with_zone']}（{lb['location_ratio']:.1%}）→ "
          f"{lcov['after']}（{lcov['after_ratio']:.1%}）")
    print(f"event→zone：{lb['zone_event_linked']}（{lb['zone_event_ratio']:.1%}）→ "
          f"{cov['after']}（{cov['after_ratio']:.1%}）  目標 85% "
          f"{'✅' if cov['target_met'] else '❌'}")
    print(f"join 來源：{report['membership_source']}")
    print(f"join 狀態：{report['membership_review_status']}")
    if collapse_report is not None:
        mc = collapse_report["marker_collapse"]
        print(f"塌縮修復：簇 {mc['n_clusters_ge_threshold']} 個 → 散佈 {mc['n_moved']} 個地點"
              f"；鎖定（inferred_from）簇 {len(mc['locked_clusters'])} 個")
        print(f"座標傳播：{collapse_report['propagation']}")
    if args.dry_run:
        print("（--dry-run：冇寫入）")
    else:
        print(f"報告 → {ARTIFACTS / 'zone-membership.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

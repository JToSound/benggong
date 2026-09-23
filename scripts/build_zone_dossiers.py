#!/usr/bin/env python3
"""B4 —— zone v2 確定性遷移 + 獨立 `zone-dossiers.json` 產生器。

背景（A6 實測）
==============
v1 嘅 `zones.geojson` 內容豐富但 schema 落後：spec §2.4 要求嘅
`zone_type` / `status` / `danger_level` / `spatial_precision` /
`display_style` / `event_ids` / `character_ids` / `dossier_id` /
`review_status` **全部冇**；dossier 內容 inline 喺 properties；而
`evidence` 欄位 48/48 含 `chN 原文：「…」`（**版權紅線**）。

做法
====
1. **v2 遷移**（確定性、idempotent，規則 Z1）：由 `kind` 映射 `zone_type`，
   由 `chapters` / `kind_votes` / `radius_source` / `coords_source` 推導
   `status` / `danger_level` / `spatial_precision` / `review_status` /
   `confidence`（公式見 A6 §3.6c）。
2. **移除 `evidence`**（版權紅線）：原文只可留 private；衍生內容
   （government / social_structure / … / summary）保留。
3. **獨立 `data/public/zone-dossiers.json`**（方案 B）：由 **public** 資料
   （`zones.geojson` inline 欄位 + `chapter-summaries.json` + `events.geojson`
   + `timeline.json`）程式化生成。`infected_nest` 用 `nest_profile` 代替
   `governance` / `society`（規則 DS2）。
4. **六欄全空**嘅 zone 標 `needs_validation`，**唔可以**補寫 fiction（規則 DS1）。

**只讀／只寫 `data/public/`。唔會讀 `data/private/`。冇 timestamp（保證 idempotent）。**

用法：
    python scripts/build_zone_dossiers.py --dry-run
    python scripts/build_zone_dossiers.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from infer_zone_membership import (  # noqa: E402
    build_zone_index,
    join_membership,
    load,
    load_fc,
    norm,
    sha256,
)

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
ARTIFACTS = REPO / "artifacts" / "b4"

SCHEMA_VERSION = 2

#: `kind` → `zone_type`（spec §5.2，確定性映射，唔捏造）
KIND_TO_ZONE_TYPE = {
    "survivor": "survivor_zone",
    "nest": "infected_nest",
    "outpost": "contested",
}

#: `zone_type` → `danger_level`（spec §5.2；`unknown` 必須係 `null`）
ZONE_TYPE_DANGER = {
    "survivor_zone": 1,
    "contested": 3,
    "infected_nest": 4,
    "quarantine": 4,
    "transit": 2,
    "unknown": None,
}

#: `zone_type` → display_style（fill 係 **B1 token 名**，唔存 raw hex）
ZONE_TYPE_DISPLAY = {
    "survivor_zone": {"fill": "--zone-survivor", "pattern": "contour", "icon": "shield"},
    "infected_nest": {"fill": "--zone-nest", "pattern": "hatch", "icon": "virus"},
    "quarantine": {"fill": "--zone-quarantine", "pattern": "hatch", "icon": "gate"},
    "contested": {"fill": "--zone-contested", "pattern": "contour", "icon": "crossed-swords"},
    "transit": {"fill": "--zone-unknown", "pattern": "solid", "icon": "route"},
    "unknown": {"fill": "--zone-unknown", "pattern": "noise", "icon": "question"},
}

#: 故事最後章（《病港》第一季）。
LAST_CHAPTER = 198

#: 「已毀」類字眼 → `status: collapsed`（spec §5.2）
COLLAPSED_WORDS = ("已毀", "毀滅", "淪陷", "瓦解", "崩潰", "覆滅", "全毀")

CORE_FIELDS = ("government", "social_structure", "economy", "defense", "population", "culture")
NEST_FIELDS = ("threats", "notable_features", "summary")

EMPTY = {"", "unknown", "未知", "n/a", "na", "none", "null", "-", "—", "不詳", "待定"}

#: zone properties 輸出鍵序（固定 → 保證 byte-stable idempotency）
ZONE_KEY_ORDER = [
    "id", "name", "kind", "kind_votes",
    "zone_type", "status", "danger_level", "spatial_precision", "display_style",
    "chapter_refs", "event_ids", "character_ids", "member_location_ids",
    "dossier_id", "confidence", "confidence_inputs",
    "review_status", "zone_review_status", "schema_version",
    "aliases", "chapters", "first_appearance", "location_hint",
    "government", "leadership", "social_structure", "economy", "defense",
    "population", "culture", "notable_features", "threats", "summary",
    "radius_m", "radius_source", "coords_source", "coords_evidence", "range_evidence",
    "coordinate_confidence", "coordinate_source", "coordinate_review_status",
    "spatial_evidence_count",
    "sources", "source",
]


def has_evidence(v: Any, *, min_len: int = 4, min_items: int = 1) -> bool:
    """A6 §3.6a：字串 ≥ min_len 且唔係空值；陣列 ≥ min_items 項。"""
    if v is None:
        return False
    if isinstance(v, str):
        s = v.strip()
        return s.lower() not in EMPTY and len(s) >= min_len
    if isinstance(v, list):
        return len([x for x in v if isinstance(x, str) and len(x.strip()) >= 2]) >= min_items
    return False


def truncate_cjk(text: str, limit: int = 180) -> str:
    """截到 ≤ limit 字，盡量喺標點斷開（唔會製造長 CJK run）。"""
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    cut = s[:limit]
    best = max(cut.rfind(p) for p in "。，、；！？：")
    if best >= limit // 2:
        return cut[: best + 1]
    return cut


def kind_score(kind_votes: dict) -> float:
    votes = {k: v for k, v in (kind_votes or {}).items() if isinstance(v, int)}
    total = sum(votes.values())
    if not total:
        return 1.0
    return max(votes.values()) / total


def coord_score(radius_source: str | None, coords_source: str | None) -> float:
    if radius_source == "members":
        return 1.0
    if coords_source and coords_source != "unknown":
        return 0.5
    return 0.0


def dossier_score(props: dict, zone_type: str) -> float:
    fields = NEST_FIELDS if zone_type == "infected_nest" else CORE_FIELDS
    filled = sum(1 for k in fields if has_evidence(props.get(k)))
    return filled / len(fields)


def derive_status(props: dict) -> str:
    chapters = props.get("chapters") or []
    if LAST_CHAPTER in chapters:
        return "active"
    texts = []
    for k in (*CORE_FIELDS, "summary", "threats", "notable_features", "government"):
        v = props.get(k)
        if isinstance(v, str):
            texts.append(v)
        elif isinstance(v, list):
            texts.extend(x for x in v if isinstance(x, str))
    if any(w in t for t in texts for w in COLLAPSED_WORDS):
        return "collapsed"
    return "unknown"


def derive_review_status(props: dict, zone_type: str) -> str:
    votes = props.get("kind_votes") or {}
    total = sum(v for v in votes.values() if isinstance(v, int))
    divergent = bool(total) and max(votes.values()) < total
    # 「六欄全空」一律用核心六欄判定（唔可以用病窩替代欄位蓋過缺口）——
    # spec §6.3：寶翠公園、靈實禮拜堂等連 chapter 摘要／event 都冇，
    # 必須標 needs_validation，唔可以因為 threats 有值就當有證據。
    n_filled = sum(1 for k in CORE_FIELDS if has_evidence(props.get(k)))
    if divergent or n_filled == 0:
        return "needs_validation"
    if (
        props.get("coords_source") == "locations"
        and props.get("radius_source") == "members"
        and n_filled >= 4
    ):
        return "validated"
    return "auto_inferred"


def derive_spatial_precision(props: dict) -> str:
    if props.get("radius_source") == "members":
        return "verified"
    if props.get("coords_source") and props["coords_source"] != "unknown":
        return "approximate"
    return "unknown"


# =====================================================================
# v2 遷移
# =====================================================================


def migrate_zones(zones: list[dict], links: dict) -> None:
    for f in zones:
        p = f["properties"]
        zone_type = KIND_TO_ZONE_TYPE.get(p.get("kind"), "unknown")
        zl = links.get(p["id"], {})

        conf = round(
            0.40 * coord_score(p.get("radius_source"), p.get("coords_source"))
            + 0.40 * dossier_score(p, zone_type)
            + 0.20 * kind_score(p.get("kind_votes")),
            2,
        )
        review = derive_review_status(p, zone_type)

        new_props: dict[str, Any] = {}
        for key in ZONE_KEY_ORDER:
            if key == "zone_type":
                new_props[key] = zone_type
            elif key == "status":
                new_props[key] = derive_status(p)
            elif key == "danger_level":
                new_props[key] = ZONE_TYPE_DANGER.get(zone_type)
            elif key == "spatial_precision":
                new_props[key] = derive_spatial_precision(p)
            elif key == "display_style":
                new_props[key] = dict(ZONE_TYPE_DISPLAY.get(zone_type, ZONE_TYPE_DISPLAY["unknown"]))
            elif key == "chapter_refs":
                new_props[key] = sorted(p.get("chapters") or [])
            elif key == "event_ids":
                new_props[key] = list(zl.get("event_ids", []))
            elif key == "character_ids":
                new_props[key] = list(zl.get("character_ids", []))
            elif key == "member_location_ids":
                new_props[key] = list(zl.get("member_location_ids", []))
            elif key == "dossier_id":
                new_props[key] = "dossier_" + p["id"][len("zone_"):]
            elif key == "confidence":
                new_props[key] = conf
            elif key == "confidence_inputs":
                new_props[key] = {
                    "coord_score": coord_score(p.get("radius_source"), p.get("coords_source")),
                    "dossier_score": round(dossier_score(p, zone_type), 4),
                    "kind_score": round(kind_score(p.get("kind_votes")), 4),
                }
            elif key in ("review_status", "zone_review_status"):
                new_props[key] = review
            elif key == "schema_version":
                new_props[key] = SCHEMA_VERSION
            elif key in p:
                new_props[key] = p[key]
        # `evidence` 唔喺 ZONE_KEY_ORDER → 自動被移除（版權紅線）
        f["properties"] = new_props


# =====================================================================
# dossier
# =====================================================================


def _chapter_summary_counts(summaries: dict) -> dict[str, int]:
    """location_id → 出現喺 chapter-summaries 嘅次數。"""
    counts: dict[str, int] = {}
    for _ch, val in summaries.items():
        for entry in (val or {}).get("locations", []):
            lid = entry.get("id")
            if lid:
                counts[lid] = counts.get(lid, 0) + 1
    return counts


def build_dossier(props: dict, zone_type: str, key_chars: list[str],
                  summary_hits: int, event_count: int) -> dict:
    overview = truncate_cjk(props.get("summary") or "", 180)
    if not has_evidence(overview, min_len=8):
        overview = "unknown"

    danger = ZONE_TYPE_DANGER.get(zone_type)
    threats = [t for t in (props.get("threats") or []) if isinstance(t, str) and t.strip()]

    d: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "id": props["dossier_id"],
        "zone_id": props["id"],
        "overview": overview,
    }

    if zone_type == "infected_nest":
        # 規則 DS2：病窩用 nest_profile 代替 governance / society
        chapters = sorted(props.get("chapters") or [])
        span = f"ch{chapters[0]}–ch{chapters[-1]}" if chapters else "unknown"
        d["nest_profile"] = {
            "threat_signature": truncate_cjk("；".join(threats), 180) if threats else "unknown",
            "activity_pattern": (
                f"活躍章節 {span}；區內事件 {event_count} 條" if chapters else "unknown"
            ),
            "affected_radius": (
                f"半徑約 {props.get('radius_m')} m（來源：{props.get('radius_source')}）"
            ),
        }
    else:
        d["governance"] = {
            "system": (props.get("government") or "unknown") if has_evidence(props.get("government"), min_len=8) else "unknown",
            "authority": "、".join(props.get("leadership") or []) if has_evidence(props.get("leadership")) else "unknown",
            "legitimacy": "unknown",  # 冇獨立來源（A6 §3.3）
        }
        d["society"] = {
            "population_structure": (props.get("social_structure") or "unknown") if has_evidence(props.get("social_structure"), min_len=8) else "unknown",
            "daily_life": (props.get("population") or "unknown") if has_evidence(props.get("population")) else "unknown",
            "culture": (props.get("culture") or "unknown") if has_evidence(props.get("culture"), min_len=8) else "unknown",
        }
        d["infrastructure"] = {
            "security": (props.get("defense") or "unknown") if has_evidence(props.get("defense"), min_len=8) else "unknown",
            "resources": (props.get("economy") or "unknown") if has_evidence(props.get("economy"), min_len=8) else "unknown",
            "mobility": "unknown",  # 冇獨立來源（A6 §3.3）
        }

    d["risk_profile"] = {"threats": threats, "danger_level": danger}

    sources = []
    if any(has_evidence(props.get(k)) for k in (*CORE_FIELDS, *NEST_FIELDS)):
        sources.append("zones-inline")
    if summary_hits:
        sources.append("chapter-summaries")
    if event_count:
        sources.append("events")

    d["key_characters"] = key_chars
    d["chapter_refs"] = sorted(props.get("chapters") or [])
    d["evidence_sources"] = sorted(sources)
    d["confidence"] = props.get("confidence") or 0.0
    d["review_status"] = props.get("review_status", "needs_validation")
    return d


# =====================================================================
# run
# =====================================================================


def run(write: bool = True) -> dict:
    zn_fc = load("zones.geojson")
    zones = zn_fc["features"]
    locations = load_fc("locations.geojson")
    events = load_fc("events.geojson")
    timeline = load("timeline.json")
    characters = load("characters.json")
    summaries = load("chapter-summaries.json")

    membership, _audit = join_membership(locations, zones)
    # 由 membership 重建 zone links（同 infer_zone_membership.compute_zone_links 一致，
    # 保證 `zone.event_ids` ↔ `event.zone_id` 雙向一致）
    from infer_zone_membership import compute_zone_links

    links = compute_zone_links(
        locations, zones, events, load_fc("routes.geojson"), characters, membership
    )["zones"]

    migrate_zones(zones, links)

    zn_fc["schema_version"] = SCHEMA_VERSION

    if write:
        (PUBLIC / "zones.geojson").write_text(
            json.dumps(zn_fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    # 寫完 zones.geojson 之後才 hash（保證 idempotent：輸入 = 上一次輸出）
    zones_hash = sha256(PUBLIC / "zones.geojson") if write else "dry-run"

    summary_counts = _chapter_summary_counts(summaries)
    char_name = {c["id"]: c["name"] for c in characters}
    tl_event_ids = {t.get("event_id") for t in timeline if t.get("event_id")}

    dossiers = []
    for f in zones:
        p = f["properties"]
        zone_type = p["zone_type"]
        summary_hits = sum(summary_counts.get(lid, 0) for lid in p["member_location_ids"])
        event_count = len(p["event_ids"])
        key_chars = sorted(char_name[cid] for cid in p["character_ids"] if cid in char_name)
        dossiers.append(build_dossier(p, zone_type, key_chars, summary_hits, event_count))

    dossiers.sort(key=lambda d: d["zone_id"])
    doc = {
        "schema_version": SCHEMA_VERSION,
        "generated_from": {
            "zones": zones_hash,
            "chapter_summaries": sha256(PUBLIC / "chapter-summaries.json"),
            "events": sha256(PUBLIC / "events.geojson"),
            "timeline": sha256(PUBLIC / "timeline.json"),
        },
        "dossiers": dossiers,
    }

    if write:
        (PUBLIC / "zone-dossiers.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    # 統計
    filled = {k: 0 for k in CORE_FIELDS}
    for d in dossiers:
        gov = d.get("governance") or {}
        soc = d.get("society") or {}
        inf = d.get("infrastructure") or {}
        vals = {
            "government": gov.get("system"),
            "social_structure": soc.get("population_structure"),
            "economy": inf.get("resources"),
            "defense": inf.get("security"),
            "population": soc.get("daily_life"),
            "culture": soc.get("culture"),
        }
        for k, v in vals.items():
            if has_evidence(v, min_len=8):
                filled[k] += 1

    review: dict[str, int] = {}
    for d in dossiers:
        review[d["review_status"]] = review.get(d["review_status"], 0) + 1

    status_dist: dict[str, int] = {}
    type_dist: dict[str, int] = {}
    for f in zones:
        p = f["properties"]
        status_dist[p["status"]] = status_dist.get(p["status"], 0) + 1
        type_dist[p["zone_type"]] = type_dist.get(p["zone_type"], 0) + 1

    return {
        "schema_version": SCHEMA_VERSION,
        "n_zones": len(zones),
        "n_dossiers": len(dossiers),
        "core_field_fill": filled,
        "review_status": dict(sorted(review.items())),
        "status": dict(sorted(status_dist.items())),
        "zone_type": dict(sorted(type_dist.items())),
        "nest_profile_count": sum(1 for d in dossiers if "nest_profile" in d),
        "zones_hash": zones_hash,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="zone v2 遷移 + zone-dossiers.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    st = run(write=not args.dry_run)
    print("=== B4 zone v2 遷移 + dossier ===")
    print(f"zone {st['n_zones']} → dossier {st['n_dossiers']}（nest_profile {st['nest_profile_count']}）")
    print(f"zone_type：{st['zone_type']}")
    print(f"status：{st['status']}")
    print(f"review_status：{st['review_status']}")
    print(f"核心六欄填充：{st['core_field_fill']}")
    if args.dry_run:
        print("（--dry-run：冇寫入）")
    else:
        print(f"zones.geojson sha256 = {st['zones_hash']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

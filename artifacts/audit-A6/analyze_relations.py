#!/usr/bin/env python3
"""A6 只讀審計：zone ↔ location ↔ event ↔ character 關聯覆蓋率。

join 路徑（全部由 public data 反推，唔改任何 data）：
  zone  ──(name/alias 精確配對)──> location.zone_ids   [已存在，由 merge_zone_dossiers 產生]
  zone  <──(location.zone_ids)──── location
  location ──(event.location_id)──> event
  event ──(event.characters[])────> character
  zone  ──(location.zone_ids 反查)──> event / character
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
PUB = REPO / "data" / "public"
OUT = Path(__file__).resolve().parent


def load_fc(name):
    return json.loads((PUB / name).read_text(encoding="utf-8"))["features"]


def main() -> None:
    zones = load_fc("zones.geojson")
    locs = load_fc("locations.geojson")
    events = load_fc("events.geojson")
    chars = json.loads((PUB / "characters.json").read_text(encoding="utf-8"))

    zone_ids = {f["properties"]["id"] for f in zones}

    # ---- 1. locations.zone_ids 覆蓋率 ----
    loc_with_zone = [f for f in locs if f["properties"].get("zone_ids")]
    loc_zone_coverage = round(100 * len(loc_with_zone) / len(locs), 1)

    # 每個 zone 有幾多 location 連到
    zone_to_locs: dict[str, list[str]] = defaultdict(list)
    for f in locs:
        for zid in f["properties"].get("zone_ids", []):
            zone_to_locs[zid].append(f["properties"]["id"])
    zones_with_locs = sum(1 for z in zone_ids if zone_to_locs.get(z))
    orphan_zones = sorted(zone_ids - set(zone_to_locs))

    # ---- 2. events 反推 zone ----
    loc_zone = {f["properties"]["id"]: f["properties"].get("zone_ids", []) for f in locs}
    event_no_loc = 0
    event_with_zone = 0
    event_loc_but_no_zone = 0
    zone_to_events: dict[str, int] = defaultdict(int)
    for e in events:
        p = e["properties"]
        lid = p.get("location_id")
        if not lid:
            event_no_loc += 1
            continue
        zids = loc_zone.get(lid, [])
        if zids:
            event_with_zone += 1
            for z in zids:
                zone_to_events[z] += 1
        else:
            event_loc_but_no_zone += 1

    # ---- 3. characters 反推 zone（經 event.characters）----
    char_to_zone: dict[str, set] = defaultdict(set)
    zone_to_chars: dict[str, set] = defaultdict(set)
    for e in events:
        p = e["properties"]
        lid = p.get("location_id")
        if not lid:
            continue
        zids = loc_zone.get(lid, [])
        for cid in p.get("characters", []) or []:
            for z in zids:
                char_to_zone[cid].add(z)
                zone_to_chars[z].add(cid)

    # characters.json 入面有幾多角色連到 zone
    char_ids = {c["id"] for c in chars}
    chars_linked = sum(1 for c in char_ids if char_to_zone.get(c))
    chars_in_events = set()
    for e in events:
        for cid in e["properties"].get("characters", []) or []:
            chars_in_events.add(cid)

    # ---- 4. zones 有 chapter_refs 但冇 event_ids/character_ids ----
    zone_chapters_filled = sum(1 for f in zones if f["properties"].get("chapters"))

    # ---- 5. 每個 zone 嘅關聯完整度 ----
    per_zone = []
    for f in zones:
        p = f["properties"]
        zid = p["id"]
        per_zone.append({
            "id": zid,
            "name": p["name"],
            "kind": p["kind"],
            "n_locations": len(zone_to_locs.get(zid, [])),
            "n_events": zone_to_events.get(zid, 0),
            "n_characters": len(zone_to_chars.get(zid, set())),
        })
    zones_no_event = [z for z in per_zone if z["n_events"] == 0]

    result = {
        "totals": {
            "zones": len(zones), "locations": len(locs),
            "events": len(events), "characters": len(chars),
        },
        "location_zone_coverage_pct": loc_zone_coverage,
        "locations_with_zone": len(loc_with_zone),
        "zones_with_locations": zones_with_locs,
        "orphan_zones": orphan_zones,
        "event_zone": {
            "no_location_id": event_no_loc,
            "with_zone": event_with_zone,
            "location_but_no_zone": event_loc_but_no_zone,
            "with_zone_pct": round(100 * event_with_zone / len(events), 1),
        },
        "character_zone": {
            "chars_in_events": len(chars_in_events),
            "chars_linked_to_zone": chars_linked,
            "link_pct": round(100 * chars_linked / max(1, len(chars_in_events)), 1),
            "zones_with_characters": sum(1 for z in zone_ids if zone_to_chars.get(z)),
        },
        "zone_chapters_filled": zone_chapters_filled,
        "per_zone": per_zone,
        "zones_no_event": zones_no_event,
    }

    (OUT / "zone-relation-stats.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("=== Zone ↔ Location ↔ Event ↔ Character 關聯 ===")
    print(f"zones {len(zones)}／locations {len(locs)}／events {len(events)}／characters {len(chars)}")
    print(f"\nlocations 有 zone_ids：{len(loc_with_zone)}／{len(locs)}（{loc_zone_coverage}%）")
    print(f"zones 有 location 連到：{zones_with_locs}／{len(zones)}")
    if orphan_zones:
        print(f"⚠️ 冇任何 location 連到嘅 zone（{len(orphan_zones)}）：{orphan_zones}")
    print(f"\nevents：冇 location_id {event_no_loc}；有 location 但 zone 空 {event_loc_but_no_zone}；")
    print(f"        經 location 反推到 zone {event_with_zone}（{result['event_zone']['with_zone_pct']}%）")
    print(f"\ncharacters 出現在 events：{len(chars_in_events)}；可連到 zone：{chars_linked}（{result['character_zone']['link_pct']}%）")
    print(f"zones 有 character 連到：{result['character_zone']['zones_with_characters']}／{len(zones)}")
    print(f"\n⚠️ 冇任何 event 連到嘅 zone（{len(zones_no_event)}）：")
    for z in zones_no_event:
        print(f"  - {z['name']} [{z['kind']}] loc={z['n_locations']} char={z['n_characters']}")


if __name__ == "__main__":
    main()

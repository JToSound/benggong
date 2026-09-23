#!/usr/bin/env python3
"""A6：評估「可程式化重建 dossier」嘅證據來源覆蓋率。

來源（全部 public）：
  A. zones.geojson inline dossier 欄位（現有）
  B. chapter-summaries.json[chapter].locations[] → 經 location.zone_ids join zone
  C. events.geojson（location_id → zone）標題／描述
  D. characters.json chapter_refs → 經 zone.chapters 交集
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
PUB = REPO / "data" / "public"
OUT = Path(__file__).resolve().parent


def load_fc(n):
    return json.loads((PUB / n).read_text(encoding="utf-8"))["features"]


def main():
    zones = load_fc("zones.geojson")
    locs = load_fc("locations.geojson")
    events = load_fc("events.geojson")
    chars = json.loads((PUB / "characters.json").read_text(encoding="utf-8"))
    chap_sum = json.loads((PUB / "chapter-summaries.json").read_text(encoding="utf-8"))

    loc_zone = {f["properties"]["id"]: f["properties"].get("zone_ids", []) for f in locs}
    zone_ids = {f["properties"]["id"]: f["properties"] for f in zones}

    # B. chapter-summaries → zone
    zone_chap_loc_summaries: dict[str, int] = defaultdict(int)
    total_loc_summaries = 0
    for ch, val in chap_sum.items():
        if not isinstance(val, dict):
            continue
        for l in val.get("locations", []) or []:
            total_loc_summaries += 1
            for zid in loc_zone.get(l.get("id"), []):
                zone_chap_loc_summaries[zid] += 1

    # C. events → zone（標題/描述非空）
    zone_events: dict[str, int] = defaultdict(int)
    for e in events:
        lid = e["properties"].get("location_id")
        for zid in loc_zone.get(lid, []):
            zone_events[zid] += 1

    # D. characters → zone（用 chapter_refs ∩ zone.chapters）
    zone_chapters = {zid: set(p.get("chapters") or []) for zid, p in zone_ids.items()}
    zone_chars: dict[str, set] = defaultdict(set)
    for c in chars:
        cref = set(c.get("chapter_refs") or [])
        if not cref:
            continue
        for zid, chs in zone_chapters.items():
            if cref & chs:
                zone_chars[zid].add(c["id"])

    # 逐 zone 總結可用證據來源
    rows = []
    for zid, p in zone_ids.items():
        rows.append({
            "id": zid, "name": p["name"], "kind": p["kind"],
            "src_inline_gov_soc": sum(1 for k in ["government", "social_structure", "economy",
                                                  "defense", "population", "culture"]
                                      if p.get(k)),
            "src_chap_loc_summaries": zone_chap_loc_summaries.get(zid, 0),
            "src_events": zone_events.get(zid, 0),
            "src_chars_chapterref": len(zone_chars.get(zid, set())),
        })

    # 覆蓋率
    n = len(zone_ids)
    cov = {
        "total_loc_summaries_in_dataset": total_loc_summaries,
        "zones_with_chap_loc_summaries": sum(1 for r in rows if r["src_chap_loc_summaries"] > 0),
        "zones_with_events": sum(1 for r in rows if r["src_events"] > 0),
        "zones_with_char_chapterref": sum(1 for r in rows if r["src_chars_chapterref"] > 0),
        "zones_with_no_source_at_all": sum(
            1 for r in rows
            if r["src_inline_gov_soc"] == 0 and r["src_chap_loc_summaries"] == 0
            and r["src_events"] == 0
        ),
    }

    (OUT / "zone-evidence-source-stats.json").write_text(
        json.dumps({"coverage": cov, "per_zone": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("=== 可程式化 dossier 證據來源覆蓋率（分母 48 zone）===")
    print(f"chapter-summaries 內 location 摘要總數：{total_loc_summaries}")
    print(f"有 chapter-location 摘要可 join 到嘅 zone：{cov['zones_with_chap_loc_summaries']}/48")
    print(f"有 event 可 join 到嘅 zone：{cov['zones_with_events']}/48")
    print(f"有 character（chapter_refs ∩ zone.chapters）可 join 到嘅 zone：{cov['zones_with_char_chapterref']}/48")
    print(f"⚠️ 三種來源全部空嘅 zone：{cov['zones_with_no_source_at_all']}/48")
    print()
    print(f"{'zone':<26}{'kind':<9}{'inline':>7}{'chapLoc':>9}{'events':>8}{'chars':>7}")
    for r in sorted(rows, key=lambda x: (x["src_events"] + x["src_chap_loc_summaries"])):
        print(f"{r['name'][:24]:<26}{r['kind']:<9}{r['src_inline_gov_soc']:>7}"
              f"{r['src_chap_loc_summaries']:>9}{r['src_events']:>8}{r['src_chars_chapterref']:>7}")


if __name__ == "__main__":
    main()

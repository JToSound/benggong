#!/usr/bin/env python3
"""B4 —— 空間敘事一致性驗證（R1–R8 全跑 + R5/R7 敘事層加強）。

規格
====
- spatial-data-contract §4 規則 V1：「8 條規則全部要寫入
  `scripts/validate_spatial_narrative.py`，並有對應 pytest」。
- §7 工作包：`audit_coordinate_integrity.py` 係 R1–R8 **主檢查**；
  本腳本負責**敘事一致性**（R5 / R7）＋ zone↔event↔location 雙向一致。

做法：直接 import `audit_coordinate_integrity.run_all_rules()` 跑齊 8 條，
再加敘事層斷言。Exit code：0 = 全過；1 = 有 fail。

**只讀 `data/public/`。唔會讀 `data/private/`。**

用法：
    python scripts/validate_spatial_narrative.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit_coordinate_integrity import load, load_fc, run_all_rules  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"


def check_zone_event_bidirectional(loc, ev, zn) -> list[str]:
    """`zone.event_ids` ↔ `event.zone_id` 必須雙向一致。"""
    errors: list[str] = []
    zone_event_ids = {f["properties"]["id"]: set(f["properties"].get("event_ids") or []) for f in zn}
    event_zone = {f["properties"]["id"]: f["properties"].get("zone_id") for f in ev}
    for zid, eids in zone_event_ids.items():
        for eid in eids:
            if event_zone.get(eid) != zid:
                errors.append(f"zone {zid} 聲稱包含 event {eid}，但 event.zone_id = {event_zone.get(eid)}")
    for eid, zid in event_zone.items():
        if zid and eid not in zone_event_ids.get(zid, set()):
            errors.append(f"event {eid} 指向 zone {zid}，但該 zone 嘅 event_ids 唔包含佢")
    return errors


def check_zone_location_bidirectional(loc, zn) -> list[str]:
    """`location.zone_ids` ↔ `zone.member_location_ids` 必須雙向一致。"""
    errors: list[str] = []
    loc_zones = {f["properties"]["id"]: set(f["properties"].get("zone_ids") or []) for f in loc}
    zone_members = {f["properties"]["id"]: set(f["properties"].get("member_location_ids") or []) for f in zn}
    for lid, zids in loc_zones.items():
        for zid in zids:
            if lid not in zone_members.get(zid, set()):
                errors.append(f"location {lid} 指向 zone {zid}，但該 zone 嘅 member_location_ids 唔包含佢")
    for zid, members in zone_members.items():
        for lid in members:
            if zid not in loc_zones.get(lid, set()):
                errors.append(f"zone {zid} 聲稱包含 location {lid}，但 location.zone_ids 唔包含佢")
    return errors


def check_dossier_refs(zn, dossiers_doc) -> list[str]:
    """`zone.dossier_id` ↔ dossier 必須互相對應。"""
    errors: list[str] = []
    by_id = {d["id"]: d for d in dossiers_doc.get("dossiers", [])}
    for f in zn:
        p = f["properties"]
        did = p.get("dossier_id")
        if not did:
            errors.append(f"zone {p['id']} 缺 dossier_id")
            continue
        d = by_id.get(did)
        if d is None:
            errors.append(f"zone {p['id']} 嘅 dossier_id {did} 唔存在於 zone-dossiers.json")
        elif d["zone_id"] != p["id"]:
            errors.append(f"dossier {did} 嘅 zone_id {d['zone_id']} 同 zone {p['id']} 唔一致")
    zone_ids = {f["properties"]["id"] for f in zn}
    for d in dossiers_doc.get("dossiers", []):
        if d["zone_id"] not in zone_ids:
            errors.append(f"dossier {d['id']} 指向唔存在嘅 zone {d['zone_id']}")
    return errors


def check_copyright(zn) -> list[str]:
    """規則 DS4：public zone 資料唔可以有 `chN 原文：「…」`。"""
    import re

    pat = re.compile(r"原文\s*[：:「]|ch\s*\d+\s*原文")
    errors: list[str] = []
    for f in zn:
        for k, v in f["properties"].items():
            if isinstance(v, str) and pat.search(v):
                errors.append(f"zone {f['properties']['id']}.{k} 含小說原文引用（版權紅線）")
    return errors


def main() -> int:
    report = run_all_rules()
    loc = load_fc("locations.geojson")
    ev = load_fc("events.geojson")
    zn = load_fc("zones.geojson")
    dossier_path = PUBLIC / "zone-dossiers.json"
    dossiers_doc = json.loads(dossier_path.read_text(encoding="utf-8")) if dossier_path.exists() else {"dossiers": []}

    narrative_errors = []
    narrative_errors += check_zone_event_bidirectional(loc, ev, zn)
    narrative_errors += check_zone_location_bidirectional(loc, zn)
    narrative_errors += check_dossier_refs(zn, dossiers_doc)
    narrative_errors += check_copyright(zn)

    print("=== B4 空間敘事一致性驗證 ===")
    for key, r in report["rules"].items():
        mark = {"pass": "✅", "fail": "❌"}[r["status"]]
        print(f"  {mark} {key:34s} fail={r['n_fail']}")
    print(f"  {'✅' if not narrative_errors else '❌'} 敘事層雙向一致 / dossier 引用 / 版權掃描"
          f"（{len(narrative_errors)} 個問題）")

    if report["summary"]["rules_failed"] or narrative_errors:
        print("\n❌ 驗證失敗：")
        for k in report["summary"]["rules_failed"]:
            r = report["rules"][k]
            for f in [x for x in r["findings"] if x["severity"] == "fail"][:5]:
                print(f"  - [{k}] {f['feature_id']}: {f['evidence'].get('reason')}")
        for e in narrative_errors[:10]:
            print(f"  - {e}")
        return 1
    print("\n✅ 全部通過（R1–R8 + 敘事層一致性）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

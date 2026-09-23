#!/usr/bin/env python3
"""A6：抽樣睇 zone 實際內容（唔印小說正文，只印結構化欄位）。"""
from __future__ import annotations
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
PUB = REPO / "data" / "public"


def main():
    zones = json.loads((PUB / "zones.geojson").read_text(encoding="utf-8"))["features"]
    locs = json.loads((PUB / "locations.geojson").read_text(encoding="utf-8"))["features"]
    loc_by_id = {f["properties"]["id"]: f["properties"] for f in locs}

    by_id = {f["properties"]["id"]: f["properties"] for f in zones}

    # orphan zones
    print("=== 2 個 orphan zone（冇 location 連到）===")
    for zid in ["zone_401442fd69", "zone_71906d0c3d"]:
        p = by_id[zid]
        print(f"\n{zid} | {p['name']} | kind={p['kind']} | aliases={p.get('aliases')}")
        print(f"  chapters={p.get('chapters')[:10]}...")
        print(f"  coords_source={p.get('coords_source')} radius_source={p.get('radius_source')}")
        print(f"  coords_evidence={p.get('coords_evidence')}")

    # survivor zone 範例（完整 dossier）
    print("\n\n=== survivor zone 完整範例（頭 2 個）===")
    surv = [f["properties"] for f in zones if f["properties"]["kind"] == "survivor"]
    for p in surv[:2]:
        print(f"\n--- {p['name']} [{p['kind']}] conf={p.get('confidence')} ---")
        for k in ["government", "leadership", "social_structure", "economy", "defense",
                  "population", "culture", "notable_features", "threats", "summary"]:
            v = p.get(k)
            vs = str(v)
            print(f"  {k}: {vs[:90]}")

    # nest 範例（病窩）
    print("\n\n=== nest zone 範例（頭 2 個）===")
    nests = [f["properties"] for f in zones if f["properties"]["kind"] == "nest"]
    for p in nests[:2]:
        print(f"\n--- {p['name']} [{p['kind']}] conf={p.get('confidence')} ---")
        for k in ["threats", "notable_features", "government", "population", "summary"]:
            v = p.get(k)
            print(f"  {k}: {str(v)[:110]}")

    # outpost 範例
    print("\n\n=== outpost zone 範例（頭 2 個）===")
    outs = [f["properties"] for f in zones if f["properties"]["kind"] == "outpost"]
    for p in outs[:2]:
        print(f"\n--- {p['name']} [{p['kind']}] conf={p.get('confidence')} ---")
        for k in ["government", "threats", "notable_features", "summary"]:
            print(f"  {k}: {str(p.get(k))[:110]}")

    # kind_votes 有分歧嘅 zone
    print("\n\n=== kind_votes 有分歧嘅 zone ===")
    for f in zones:
        p = f["properties"]
        kv = p.get("kind_votes") or {}
        if len(kv) > 1:
            print(f"  {p['name']:<24} kind={p['kind']:<9} votes={kv}")

    # zone name 長度
    print("\n=== zone 名（用嚟睇 41/48 嘅原因）===")
    short = [f["properties"]["name"] for f in zones if len(f["properties"]["name"]) < 4]
    print(f"  短名（<4字）：{short}")

    # evidence / coords_evidence 樣本
    print("\n=== evidence / coords_evidence 樣本 ===")
    for p in [surv[0]["properties"] if False else surv[0]]:
        pass
    p = surv[0]
    print(f"  coords_evidence: {p.get('coords_evidence')}")
    print(f"  range_evidence: {p.get('range_evidence')}")
    print(f"  evidence[:200]: {str(p.get('evidence'))[:200]}")


if __name__ == "__main__":
    main()

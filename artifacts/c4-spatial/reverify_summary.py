#!/usr/bin/env python3
"""C4 修復後重驗（DA9 冪等 + DA8 塌縮）—— 只讀，輸出 artifacts/c4-spatial/reverify-summary.json。

用法：python artifacts/c4-spatial/reverify_summary.py
"""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ART = REPO / "artifacts" / "c4-spatial"
PUB = REPO / "data" / "public"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load_hashes(tag: str, i: int) -> dict:
    return json.loads((ART / f"da9-{tag}-h{i}.json").read_text(encoding="utf-8"))


def main() -> int:
    out: dict = {"generated_from": str(REPO)}

    # ---- 現況快照 ----
    snap = {}
    for f in ("zones.geojson", "zone-dossiers.json", "locations.geojson",
              "events.geojson", "routes.geojson", "timeline.json"):
        snap[f] = sha(PUB / f)
    zm = REPO / "artifacts" / "b4" / "zone-membership.json"
    snap["artifacts/b4/zone-membership.json"] = sha(zm) if zm.exists() else None
    out["repo_snapshot_sha256"] = snap

    # ---- DA9：三組沙盒冪等實驗 ----
    da9 = {}
    for tag, desc in (("head", "由 git HEAD 嘅 data/public（未收斂、未修復前）"),
                      ("work", "由當時工作區 data/public"),
                      ("repo", "由真實 repo 狀態（data/public + zm）")):
        try:
            a, b = load_hashes(tag, 1), load_hashes(tag, 2)
        except FileNotFoundError:
            continue
        diff = {k: [a[k][:12], b[k][:12]] for k in a if a[k] != b[k]}
        da9[tag] = {"desc": desc, "n_outputs": len(a), "run1_eq_run2": not diff, "diff": diff}
    out["da9_idempotency"] = da9

    # ---- DA8：塌縮 ----
    feats = json.loads((PUB / "locations.geojson").read_text(encoding="utf-8"))["features"]
    by: dict[tuple, list[dict]] = defaultdict(list)
    for f in feats:
        c = f["geometry"]["coordinates"]
        by[(round(c[0], 6), round(c[1], 6))].append(f)
    cl5 = {k: v for k, v in by.items() if len(v) >= 5}
    locked5 = {k: v for k, v in cl5.items()
               if all(f["properties"].get("inferred_from") for f in v)}
    out["da8_collapse"] = {
        "n_locations": len(feats),
        "n_inferred_from": sum(1 for f in feats if f["properties"].get("inferred_from")),
        "clusters_ge5": len(cl5),
        "clusters_ge5_members": sum(len(v) for v in cl5.values()),
        "clusters_ge5_all_inferred_locked": len(locked5),
        "clusters_ge5_all_inferred_locked_members": sum(len(v) for v in locked5.values()),
        "r6_gate_fail_noninferred_gt20": sum(
            1 for v in by.values()
            if sum(1 for f in v if not f["properties"].get("inferred_from")) > 20),
    }

    # ---- 錨定 metadata（from 退化）----
    tl = [f for f in feats if f["properties"].get("coordinate_source") == "text_landmark"]
    degen = [
        f["properties"]["id"] for f in tl
        if (f["properties"].get("coordinate_anchor") or {}).get("from")
        == (f["properties"].get("coordinate_anchor") or {}).get("coord")
        == f["geometry"]["coordinates"]
    ]
    out["anchoring"] = {
        "n_text_landmark": len(tl),
        "n_with_coordinate_anchor": sum(1 for f in feats if f["properties"].get("coordinate_anchor")),
        "n_inferred_xor_anchor_violations": sum(
            1 for f in feats
            if f["properties"].get("inferred_from") and f["properties"].get("coordinate_anchor")),
        "n_from_equals_coord_degenerate": len(degen),
        "degenerate_ids": degen,
    }

    (ART / "reverify-summary.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print("=== 現況快照 ===")
    for k, v in snap.items():
        print(f"  {k:38} {(v or '')[:16]}")
    print("\n=== DA9 冪等（run1 vs run2，7 個輸出）===")
    for tag, r in da9.items():
        print(f"  [{tag:4}] {r['desc']}: "
              + ("✅ 一致" if r["run1_eq_run2"] else f"❌ 唔一致 {r['diff']}"))
    print("\n=== DA8 塌縮 ===")
    d = out["da8_collapse"]
    print(f"  ≥5 成員簇 {d['clusters_ge5']} 個 / {d['clusters_ge5_members']} 個 location"
          f"（全 inferred_from 鎖死 {d['clusters_ge5_all_inferred_locked']} 簇 / "
          f"{d['clusters_ge5_all_inferred_locked_members']} 個）；"
          f"R6 gate fail={d['r6_gate_fail_noninferred_gt20']}")
    print("\n=== 錨定 metadata ===")
    a = out["anchoring"]
    print(f"  text_landmark={a['n_text_landmark']}  coordinate_anchor={a['n_with_coordinate_anchor']}"
          f"  互斥違規={a['n_inferred_xor_anchor_violations']}"
          f"  from==coord 退化={a['n_from_equals_coord_degenerate']}")
    print(f"\n-> {ART / 'reverify-summary.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

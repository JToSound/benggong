#!/usr/bin/env python3
"""C4 §4.11 證據：`inferred_from` 鎖死令塌縮機制失效（DA8）。

只讀 data/public/locations.geojson。輸出 JSON 到 artifacts/c4-spatial/collapse-locked.json。

用法：python artifacts/c4-spatial/collapse_locked.py
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# 可用第 1 個位置參數覆寫（例如指向沙盒輸出）
LOC = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "data" / "public" / "locations.geojson"
OUT = REPO / "artifacts" / "c4-spatial" / (os.environ.get("COLLAPSE_OUT") or "collapse-locked.json")


def main() -> int:
    feats = json.loads(LOC.read_text(encoding="utf-8"))["features"]

    inf = [f for f in feats if f["properties"].get("inferred_from")]
    inf_with_anchor = [f for f in inf if f["properties"].get("coordinate_anchor")]

    by = defaultdict(list)
    for f in feats:
        c = f["geometry"]["coordinates"]
        by[(round(c[0], 9), round(c[1], 9))].append(f)

    clusters2 = {k: v for k, v in by.items() if len(v) >= 2}
    clusters5 = {k: v for k, v in by.items() if len(v) >= 5}
    locked5 = {k: v for k, v in clusters5.items()
               if all(f["properties"].get("inferred_from") for f in v)}
    r6_fail = [k for k, v in by.items()
               if sum(1 for f in v if not f["properties"].get("inferred_from")) > 20]

    report = {
        "n_locations": len(feats),
        "n_inferred_from": len(inf),
        "n_inferred_from_with_coordinate_anchor": len(inf_with_anchor),
        "invariant_inferred_xor_anchor_holds": len(inf_with_anchor) == 0,
        "clusters_ge2": len(clusters2),
        "clusters_ge5": len(clusters5),
        "clusters_ge5_members": sum(len(v) for v in clusters5.values()),
        "clusters_ge5_all_inferred_locked": len(locked5),
        "clusters_ge5_all_inferred_locked_members": sum(len(v) for v in locked5.values()),
        "r6_fail_clusters_noninferred_gt20": len(r6_fail),
        "ge5_clusters": [
            {
                "coord": [k[0], k[1]],
                "n_members": len(v),
                "n_non_inferred": sum(1 for f in v if not f["properties"].get("inferred_from")),
                "all_inferred_locked": all(f["properties"].get("inferred_from") for f in v),
                "sample_names": [f["properties"]["name"] for f in v[:5]],
            }
            for k, v in sorted(clusters5.items(), key=lambda x: -len(x[1]))
        ],
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    print("=== DA8 塌縮（矩陣判準：≥5 成員簇要散佈）===")
    print(f"locations={report['n_locations']}  inferred_from={report['n_inferred_from']}")
    print(f"  inferred_from ∩ coordinate_anchor = {report['n_inferred_from_with_coordinate_anchor']} "
          f"（互斥不變式 {'成立' if report['invariant_inferred_xor_anchor_holds'] else '唔成立'}）")
    print(f"≥5 成員簇：{report['clusters_ge5']} 個，共 {report['clusters_ge5_members']} 個 location")
    print(f"  其中全部 inferred_from（永久鎖死）：{report['clusters_ge5_all_inferred_locked']} 簇，"
          f"{report['clusters_ge5_all_inferred_locked_members']} 個 location")
    print(f"R6 門檻（非推斷 >20）fail 簇：{report['r6_fail_clusters_noninferred_gt20']}  ← gate 綠燈")
    print()
    for c in report["ge5_clusters"]:
        lock = "鎖死" if c["all_inferred_locked"] else "混合"
        print(f"  {c['coord']}  n={c['n_members']:3d}  非推斷={c['n_non_inferred']}  [{lock}]  {c['sample_names']}")
    print(f"\n-> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

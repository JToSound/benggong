#!/usr/bin/env python3
"""量度 `landuse=residential` 面層嘅實際規模（#14 評估用）。

目的
====
`build_areas()` 目前**唔收** `landuse=residential`。要決定係「實作」定
「有理由咁延後」，必須先量度以下數字，唔可以靠估：

  1. 全港 `landuse=residential` 面總數、其中有名字嘅幾多。
  2. 面積分佈 —— 過 `MIN_AREA_M2`（4000 m²）嘅有幾多。
  3. 加入之後 `areas.json` 會膨脹幾多（用同一套簡化參數真實編碼）。
  4. 分區／縮放層面嘅影響：每個簡化環嘅點數 → 前端建 `Path2D` 嘅成本。

⚠️ 為何要分「有名字」同「冇名字」
--------------------------------
`build_pois()` 只收有名字嘅 residential（做 `estate` 標籤）。`build_areas()`
完全唔收。所以「有名字」嗰批已經間接有覆蓋（以標籤形式），真正嘅空白係
**冇名字**嗰 11,398 個 —— 亦係本項要評估嘅對象。

用法
====
    python scripts/measure_residential_areas.py
    python scripts/measure_residential_areas.py --json artifacts/residential.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

# 重用產生器嘅幾何工具（唯一實作，避免兩套定義漂移）
from build_vector_basemap import (  # noqa: E402
    MIN_AREA_M2,
    SIMPLIFY_TOL,
    encode_delta,
    geom_of,
    ring_area_m2,
    simplify_ring,
)

OSM_CACHE = REPO / "data" / "private" / "cache" / "osm-hk.json"


def percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def main() -> int:
    ap = argparse.ArgumentParser(description="量度 residential 面層規模")
    ap.add_argument("--json", default="", help="輸出 JSON 報告路徑")
    ap.add_argument(
        "--emit-rings",
        default="",
        help="輸出候選環（delta 編碼，同 areas.json 同格式）供成本探針使用",
    )
    args = ap.parse_args()

    if not OSM_CACHE.exists():
        print(f"搵唔到 OSM 快取：{OSM_CACHE}", file=sys.stderr)
        return 2

    print(f"讀取 {OSM_CACHE.name} …", flush=True)
    els = json.loads(OSM_CACHE.read_text(encoding="utf-8"))["elements"]
    print(f"  {len(els):,} 個元素")

    res = [
        e for e in els
        if (e.get("tags") or {}).get("landuse") == "residential"
    ]
    named = [e for e in res if (e.get("tags") or {}).get("name")]
    unnamed = [e for e in res if not (e.get("tags") or {}).get("name")]

    print("\n【總數】")
    print(f"  landuse=residential 元素      ：{len(res):,}")
    print(f"    其中有名字（已被 POI 收）   ：{len(named):,}")
    print(f"    其中冇名字（目前完全空白）  ：{len(unnamed):,}")

    # ---- 面積分佈（原始幾何）----
    raw_areas: list[float] = []
    for e in res:
        g = geom_of(e)
        if len(g) >= 3:
            raw_areas.append(ring_area_m2(g))
    raw_areas.sort()

    print("\n【原始面積分佈（m²），n=" + f"{len(raw_areas):,}】")
    for p in (0.0, 0.25, 0.5, 0.75, 0.9, 0.99, 1.0):
        print(f"  p{p * 100:>5.1f}：{percentile(raw_areas, p):>14,.0f}")

    over = [a for a in raw_areas if a >= MIN_AREA_M2]
    print(f"\n  面積 ≥ MIN_AREA_M2（{MIN_AREA_M2:,.0f} m²）：{len(over):,}"
          f"（{len(over) / max(1, len(raw_areas)) * 100:.1f}%）")

    # ---- 真實編碼（同一套簡化參數）----
    kept: list[dict] = []
    rings: list[list[int]] = []
    for e in res:
        s = simplify_ring(geom_of(e), SIMPLIFY_TOL["area"], MIN_AREA_M2)
        if s:
            kept.append({"n_pts": len(s), "area": ring_area_m2(s)})
            rings.append(encode_delta(s, closed=True))

    print("\n【簡化後保留】")
    print(f"  環數：{len(kept):,}")
    total_pts = sum(k["n_pts"] for k in kept)
    print(f"  總點數：{total_pts:,}")
    if kept:
        print(f"  平均每環點數：{total_pts / len(kept):.1f}")
        print(f"  最大單環點數：{max(k['n_pts'] for k in kept):,}")
        areas_sorted = sorted(k["area"] for k in kept)
        for p in (0.5, 0.9, 0.99, 1.0):
            print(f"  p{p * 100:>5.1f} 面積：{percentile(areas_sorted, p):>14,.0f} m²")

    # 每點約 6 bytes（整數 delta，產生器 docstring 已載明）＋ JSON 分隔符約 1 byte
    est_bytes = total_pts * 7
    print(f"\n【估算體積】")
    print(f"  以每點 ~7 bytes（含 JSON 分隔）計：約 {est_bytes / 1024:.0f} KiB"
          f"（{est_bytes / 1024 / 1024:.2f} MiB）")

    # ---- 現有 areas.json 對照 ----
    existing = REPO / "public" / "assets" / "vector" / "areas.json"
    if existing.exists():
        cur = existing.stat().st_size
        cur_obj = json.loads(existing.read_text(encoding="utf-8"))
        cur_n = len(cur_obj.get("areas", []))
        print(f"\n【現有 areas.json】")
        print(f"  檔案：{cur / 1024:.0f} KiB，{cur_n:,} 個面")
        if cur:
            print(f"  加入 residential 後 → 約 {(cur + est_bytes) / 1024:.0f} KiB"
                  f"（+{est_bytes / cur * 100:.0f}%）")

    report = {
        "total": len(res),
        "named": len(named),
        "unnamed": len(unnamed),
        "raw_area_m2": {
            "count": len(raw_areas),
            "p50": percentile(raw_areas, 0.5),
            "p90": percentile(raw_areas, 0.9),
            "max": raw_areas[-1] if raw_areas else 0.0,
        },
        "over_min_area": len(over),
        "kept_rings": len(kept),
        "kept_points": total_pts,
        "max_ring_points": max((k["n_pts"] for k in kept), default=0),
        "est_bytes": est_bytes,
    }
    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"\n報告寫入 {out}")
    if args.emit_rings:
        out = Path(args.emit_rings)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps({"rings": rings}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        print(f"候選環寫入 {out}（{len(rings):,} 環）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

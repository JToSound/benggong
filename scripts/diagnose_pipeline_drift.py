#!/usr/bin/env python3
"""診斷：完整管線重跑時，`locations.geojson` 邊啲 feature 漂移、點解。

為何需要
========
`tests/test_apply_inferences.py::test_pipeline_is_idempotent` 係目前唯一紅
gate。已知根因係「推斷反饋迴圈」，但需要**逐個 feature** 睇邊啲動、帶咩
`position_source` / `inferred_from`，才可以設計到真正收斂嘅修法。

⚠️ 本腳本會跑**完整管線**（會改寫 `data/public/**` 同 `public/data/public/**`）。
所以：
  · 開頭快照兩個目錄；
  · 無論成功失敗都用 `finally` 還原；
  · **唔會**留低任何改動。

用法
====
    python scripts/diagnose_pipeline_drift.py            # 跑 3 輪
    python scripts/diagnose_pipeline_drift.py --runs 2
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PIPELINE = REPO / "scripts" / "run_pipeline.py"
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
JSONL = REPO / "data" / "private" / "review" / "place-inference.jsonl"
ROOTS = (REPO / "data" / "public", REPO / "public" / "data" / "public")

M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570


def load() -> dict[str, dict]:
    fc = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    return {f["properties"]["id"]: f for f in fc["features"]}


def load_patterns() -> dict[str, str]:
    """`inference_id` → `pattern`（由 JSONL；睇邊條規則產生該座標）。"""
    out: dict[str, str] = {}
    if not JSONL.exists():
        return out
    for line in JSONL.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        out[r["inference_id"]] = r.get("pattern") or "?"
    return out


def dist_m(a: list[float], b: list[float]) -> float:
    dx = (a[0] - b[0]) * M_PER_DEG_LON
    dy = (a[1] - b[1]) * M_PER_DEG_LAT
    return math.hypot(dx, dy)


def short(s: object, n: int = 42) -> str:
    t = str(s or "").replace("\n", " ")
    return t if len(t) <= n else t[: n - 1] + "…"


def main() -> int:
    ap = argparse.ArgumentParser(description="診斷管線漂移")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--top", type=int, default=25, help="每輪最多列幾多個")
    ap.add_argument(
        "--converge",
        action="store_true",
        help="跑到固定點為止並**保留**結果（唔還原）；用嚟產生可 commit 嘅狀態",
    )
    ap.add_argument("--max-iter", type=int, default=10, help="--converge 最多跑幾多輪")
    args = ap.parse_args()

    runs = args.max_iter if args.converge else args.runs
    snapshot = {
        p: p.read_bytes() for root in ROOTS for p in sorted(root.rglob("*")) if p.is_file()
    }
    try:
        prev = load()
        for run in range(1, runs + 1):
            r = subprocess.run(
                [sys.executable, str(PIPELINE)],
                cwd=str(REPO),
                capture_output=True,
                text=True,
            )
            if r.returncode != 0:
                print(f"⚠️ 管線 exit {r.returncode}：{(r.stderr or r.stdout)[-400:]}")
                return 1
            cur = load()
            pats = load_patterns()
            moved = []
            for k, f in cur.items():
                g = prev.get(k)
                if g is None:
                    moved.append((k, f, None, None))
                    continue
                a = f["geometry"]["coordinates"]
                b = g["geometry"]["coordinates"]
                if abs(a[0] - b[0]) > 1e-9 or abs(a[1] - b[1]) > 1e-9:
                    moved.append((k, f, b, dist_m(a, b)))
            print(f"\n=== 第 {run} 輪：{len(moved)} 個 feature 座標改變 ===")
            if not moved:
                print("  ✅ 已收斂（同上一輪完全相同）")
                if args.converge:
                    print("  → 已保留此狀態（--converge）")
                break
            moved.sort(key=lambda t: -(t[3] or 0))
            for k, f, old, d in moved[: args.top]:
                p = f["properties"]
                pat = pats.get(str(p.get("inferred_from") or ""), "?")
                print(
                    f"  {k}  {short(p.get('name'), 16):18} "
                    f"{'新增' if d is None else f'{d:6.2f} m':>8}  "
                    f"prec={short(p.get('location_precision'), 11):12} "
                    f"cs={short(p.get('coordinate_source'), 22):24} "
                    f"pat={short(pat, 22)}"
                )
            if len(moved) > args.top:
                print(f"  …其餘 {len(moved) - args.top} 個")

            # 按**推斷規則**分類統計（睇迴圈喺邊條規則）
            buckets: dict[str, int] = {}
            cs_buckets: dict[str, int] = {}
            for _k, f, _old, _d in moved:
                p = f["properties"]
                key = pats.get(str(p.get("inferred_from") or ""), "(冇 JSONL 記錄)")
                buckets[key] = buckets.get(key, 0) + 1
                cs = str(p.get("coordinate_source") or "(空)")
                cs_buckets[cs] = cs_buckets.get(cs, 0) + 1
            print("     ── 按推斷規則（pattern）──")
            for key, n in sorted(buckets.items(), key=lambda kv: -kv[1]):
                print(f"     {n:5}  {key}")
            print("     ── 按 coordinate_source ──")
            for key, n in sorted(cs_buckets.items(), key=lambda kv: -kv[1]):
                print(f"     {n:5}  {key}")
            prev = cur
        else:
            if args.converge:
                print(f"\n⚠️ 跑咗 {runs} 輪仍未收斂")
                return 1
    finally:
        if args.converge:
            print("\n（--converge：**保留**改動）")
        else:
            for path, data in snapshot.items():
                if path.exists() and path.read_bytes() != data:
                    path.write_bytes(data)
            print("\n（已還原 data/public 同 public/data/public）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

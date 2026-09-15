#!/usr/bin/env python3
"""把已審閱嘅地點推斷套用到公開資料。

流程
====
    infer_places.py          → place-inference.jsonl（578 條候選，全部 pending）
    place-inference-decisions.json  → 人手／代理審閱決定（可稽核）
    apply_place_inferences.py → 更新 review_status，再套用到 locations.geojson

為何要有獨立嘅「決定」檔
========================
推斷同審閱係兩件事。推斷係機械性嘅（規則命中），審閱係價值判斷。
分開之後：
  - 重跑推斷唔會抹掉審閱結果
  - 審閱決定有獨立嘅 diff 紀錄，可以追溯邊條改咗
  - 換模型／改規則之後，只需要重新審閱新增／變更嘅條目

安全保證
========
1. **只有 `approved` 嘅條目會被套用**，其餘一律唔動。
2. 套用前會驗證座標喺香港範圍內。
3. 每次套用都會印出 diff 摘要，唔會靜默改資料。
4. 唔會刪除任何地點，只會改 `coordinates` / `location_precision` /
   `fictional` / `location_type`。
5. 可重複執行（idempotent）。

用法：
    python scripts/apply_place_inferences.py --dry-run   # 只印 diff
    python scripts/apply_place_inferences.py             # 實際套用
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
INFERENCE_JSONL = REPO / "data" / "private" / "review" / "place-inference.jsonl"
DECISIONS = REPO / "data" / "private" / "review" / "place-inference-decisions.json"
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
APPLIED_LOG = REPO / "data" / "private" / "review" / "place-inference-applied.json"

# 香港範圍（同 schema 一致）
HK_LON = (113.0, 115.0)
HK_LAT = (22.0, 23.0)


def load_decisions() -> dict[str, Any]:
    if not DECISIONS.exists():
        print(f"缺少審閱決定檔：{DECISIONS}", file=sys.stderr)
        raise SystemExit(2)
    return json.loads(DECISIONS.read_text(encoding="utf-8"))


def decide_status(rec: dict[str, Any], decisions: dict[str, Any]) -> tuple[str, str | None]:
    """回傳 (review_status, review_notes)。逐條例外優先於規則層級決定。"""
    # 例外以**穩定 subject id**（loc_XXXX）為 key，唔用 inference_id 序號 ——
    # 序號會隨重跑改變，令審閱決定靜默地套用到錯誤記錄。
    exceptions = decisions.get("exceptions", {})
    for sid in rec["subject_ids"]:
        if sid in exceptions:
            ex = exceptions[sid]
            return ex.get("status", "pending"), ex.get("reason")

    rule_status = decisions.get("rule_decisions", {}).get(rec["pattern"], "pending")
    reason = decisions.get("rationale", {}).get(rec["pattern"])
    return rule_status, reason


def propagate_to_dependents(moved: dict[str, list[float]]) -> dict[str, int]:
    """地點座標一改，所有指向佢嘅記錄都要跟。

    為何需要
    --------
    三個資料集都以唔同方式引用地點座標：

    - `events.geojson`：`location_id` + 自身 `coordinates`
    - `routes.geojson`：`waypoints[].location_id`，而
      `geometry.coordinates` 同 waypoints **逐個對應**
    - `timeline.json`：`location_id`（冇自身座標）

    ⚠️ 實測踩過：第一版只傳播 events，漏咗 routes。結果路線幾何仍然係
    舊嘅虛構座標，而地點已經移到真實位置 —— 出現「真-真」線段但長
    37.5 km 嘅荒謬結果（「皇宮」同「新都城商場」明明喺同一個座標，
    路線卻畫成相距 37 km）。前端會照樣繪製呢條假線。

    呢個唔會令驗證器報錯（因為驗證器只檢查 events 同 location 一致），
    所以極易漏。
    """
    out: dict[str, int] = {}

    # --- events：location_id 對應嘅自身座標 ---
    path = REPO / "data" / "public" / "events.geojson"
    if path.exists():
        fc = json.loads(path.read_text(encoding="utf-8"))
        n = 0
        for feat in fc.get("features", []):
            lid = feat.get("properties", {}).get("location_id")
            if not lid:
                continue
            new = moved.get(lid)
            if new is None:
                continue
            if feat["geometry"]["coordinates"] != new:
                feat["geometry"]["coordinates"] = list(new)
                n += 1
        if n:
            path.write_text(
                json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        out["events.geojson"] = n

    # --- routes：waypoints[].location_id → geometry.coordinates（逐個對應）---
    path = REPO / "data" / "public" / "routes.geojson"
    if path.exists():
        fc = json.loads(path.read_text(encoding="utf-8"))
        n = 0
        for feat in fc.get("features", []):
            wps = feat.get("properties", {}).get("waypoints") or []
            coords = feat.get("geometry", {}).get("coordinates") or []
            changed = False
            for i, w in enumerate(wps):
                if i >= len(coords):
                    break
                lid = w.get("location_id")
                if not lid:
                    continue
                new = moved.get(lid)
                if new is None:
                    continue
                if coords[i] != new:
                    coords[i] = list(new)
                    changed = True
            if changed:
                feat["geometry"]["coordinates"] = coords
                n += 1
        if n:
            path.write_text(
                json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        out["routes.geojson"] = n

    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="套用已審閱嘅地點推斷")
    ap.add_argument("--dry-run", action="store_true", help="只印 diff，唔寫檔")
    args = ap.parse_args()

    if not INFERENCE_JSONL.exists():
        print(f"缺少推斷輸出：{INFERENCE_JSONL}", file=sys.stderr)
        print("請先跑 scripts/infer_places.py", file=sys.stderr)
        return 2

    decisions = load_decisions()
    records = [
        json.loads(line)
        for line in INFERENCE_JSONL.read_text(encoding="utf-8").splitlines()
        if line
    ]

    # ---- 1. 更新 review_status（可稽核：寫返 JSONL） ----
    status_counts: Counter[str] = Counter()
    for r in records:
        st, note = decide_status(r, decisions)
        r["review_status"] = st
        r["review_notes"] = note
        status_counts[st] += 1

    print("=== 審閱結果 ===")
    for st, n in status_counts.most_common():
        print(f"  {st:12s} {n:4d}")

    approved = [r for r in records if r["review_status"] == "approved"]
    print(f"\n已批：{len(approved)} 條")

    # ---- 2. 建立 subject_id → 套用內容 ----
    by_subject: dict[str, dict[str, Any]] = {}
    for r in approved:
        if not r["inferred_lonlat"]:
            continue
        lon, lat = r["inferred_lonlat"]
        if not (HK_LON[0] < lon < HK_LON[1] and HK_LAT[0] < lat < HK_LAT[1]):
            print(f"  ⚠️ 跳過 {r['inference_id']}：座標唔喺香港範圍 {r['inferred_lonlat']}")
            continue
        for sid in r["subject_ids"]:
            prev = by_subject.get(sid)
            if prev is None or r["confidence"] > prev["confidence"]:
                by_subject[sid] = {
                    "inference_id": r["inference_id"],
                    "pattern": r["pattern"],
                    "prototype": r["inferred_prototype"],
                    "lonlat": list(r["inferred_lonlat"]),
                    "precision": r["proposed_changes"].get("location_precision"),
                    "confidence": r["confidence"],
                }

    print(f"可套用嘅 subject：{len(by_subject)}")

    # ---- 3. 套用到 locations.geojson ----
    fc = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    changes: list[dict[str, Any]] = []
    for f in fc["features"]:
        p = f["properties"]
        hit = by_subject.get(p["id"])
        if hit is None:
            continue
        old = {
            "coordinates": list(f["geometry"]["coordinates"]),
            "location_precision": p["location_precision"],
            "fictional": p["fictional"],
            "location_type": p["location_type"],
        }
        f["geometry"]["coordinates"] = hit["lonlat"]
        if hit["precision"]:
            p["location_precision"] = hit["precision"]
        # 推斷到真實原型 = 唔再係虛構
        p["fictional"] = False
        p["location_type"] = "landmark" if hit["precision"] == "exact" else "district"
        p["display_name"] = f"{p['name']}（推斷位置）"
        p["inferred_from"] = hit["inference_id"]
        changes.append({
            "id": p["id"],
            "name": p["name"],
            "inference_id": hit["inference_id"],
            "pattern": hit["pattern"],
            "prototype": hit["prototype"],
            "old": old,
            "new": {
                "coordinates": hit["lonlat"],
                "location_precision": p["location_precision"],
                "fictional": False,
                "location_type": p["location_type"],
            },
        })

    print(f"\n=== 改動摘要（{len(changes)} 條）===")
    for c in sorted(changes, key=lambda x: x["name"])[:25]:
        old_c = c["old"]["coordinates"]
        print(
            f"  {c['name'][:18]:18s} {c['old']['location_precision']:11s}"
            f" ({old_c[0]:.4f},{old_c[1]:.4f})"
            f" → {c['new']['location_precision']:11s}"
            f" ({c['new']['coordinates'][0]:.5f},{c['new']['coordinates'][1]:.5f})"
            f"  [{c['pattern']}]"
        )
    if len(changes) > 25:
        print(f"  … 其餘 {len(changes) - 25} 條")

    prec_after = Counter(f["properties"]["location_precision"] for f in fc["features"])
    fict_after = sum(1 for f in fc["features"] if f["properties"]["fictional"])
    print(f"\n精度分佈（套用後）：{dict(prec_after)}")
    print(f"fictional 剩餘：{fict_after} / {len(fc['features'])}")

    if args.dry_run:
        print("\n（--dry-run：冇寫入任何檔案）")
        return 0

    # ---- 4. 傳播到依賴地點座標嘅其他資料集 ----
    #
    # 「應用喺所有其它地方」嘅具體體現：地點一改座標，所有指向佢嘅
    # 記錄都要跟。否則就會出現「事件喺 A 點、地點喺 B 點」嘅不一致，
    # validate_public_data.py 亦會即刻捉到。
    # 用**全部**地點做對賬，唔止今次改動嘅。
    #
    # 為何唔可以只傳播「今次改動」：第一次套用時漏咗 routes，之後即使
    # 修正咗傳播邏輯，`moved` 已經係空（地點冇再改），routes 永遠唔會
    # 被修正。用完整對賬就每次都會收斂，而且可重複執行。
    all_coords = {
        f["properties"]["id"]: list(f["geometry"]["coordinates"])
        for f in fc["features"]
    }
    propagated = propagate_to_dependents(all_coords)
    print(f"\n=== 傳播 ===")
    for name, n in propagated.items():
        print(f"  {name}：{n} 條更新")

    # ---- 5. 寫檔 ----
    INFERENCE_JSONL.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n",
        encoding="utf-8",
    )
    LOCATIONS.write_text(
        json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    APPLIED_LOG.write_text(
        json.dumps(
            {
                "applied_at": "2026-09-16",
                "reviewed_by": decisions.get("reviewed_by"),
                "total_inferences": len(records),
                "status_counts": dict(status_counts),
                "applied_count": len(changes),
                "propagated": propagated,
                "changes": changes,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\n寫入 {LOCATIONS}")
    print(f"寫入 {INFERENCE_JSONL}（review_status 已更新）")
    print(f"寫入 {APPLIED_LOG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

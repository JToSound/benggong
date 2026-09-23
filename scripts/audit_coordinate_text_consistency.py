#!/usr/bin/env python3
"""座標 × 故事文字一致性審計（A7 座標錯誤嘅系統化檢查）。

問題（用戶 2026-09-24 報告）
==========================
> 「標記地方仍然有錯，例如寶林倖存區應該喺寶林，故事內容當中應該有描述
>   相關地方喺現實嘅位置或地標，好似皇室區噉應該有講過。」

實例：`皇室區` 嘅 dossier 明寫「位於**寶琳地鐵站上蓋**及商場…皇宮即
**新都城二期商場**」，但 `zones.geojson` 嘅幾何中心係 `(114.2369, 22.3302)`
—— 距離寶琳站約 **1.5 km**（山邊）。即係**文字有講現實地標，但座標冇跟**。

做法（確定性、可重跑、零人手）
============================
1. 由 `data/private/cache/osm-hk.json` 建**地標名 → 座標**索引
   （只收「可以錨定位置」嘅類別：地鐵站、商場、醫院、學校、公園、
   屋邨、教堂、歷史建築…）。
2. 逐個 location 掃 `description`；逐個 zone 掃 dossier `overview`。
3. 文字提到嘅地標 → 計佢同該 feature 座標嘅距離。
4. 判定：
   · **PASS**     —— 距離 ≤ `MATCH_TOLERANCE_M`
   · **MISMATCH** —— 文字**只**提到 1 個地標，而且距離 > 容差
                     → 座標同文字矛盾（可以自動改錨去地標）
   · **AMBIGUOUS**—— 提到 ≥2 個地標（唔可以自動決定邊個才係錨）
   · **NO_TEXT**  —— 文字冇提到任何已知地標（冇文字證據可用）

⚠️ 呢個腳本**只讀不寫**（唔會改 `data/public/**`）—— 改資料一定要經
pipeline。輸出係 JSON + 粵文摘要，用嚟驅動下一步嘅自動修正。

用法
====
    python scripts/audit_coordinate_text_consistency.py
    python scripts/audit_coordinate_text_consistency.py --json artifacts/coord-text.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
OSM_CACHE = REPO / "data" / "private" / "cache" / "osm-hk.json"
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
ZONES = REPO / "data" / "public" / "zones.geojson"
DOSSIERS = REPO / "data" / "public" / "zone-dossiers.json"

#: 經度／緯度 1 度 ≈ 幾多米（北緯 22.36）。
M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570

#: 距離容差（米）—— 超過就當「文字同座標矛盾」。
MATCH_TOLERANCE_M = 400.0

#: 只收「可以錨定位置」嘅 OSM 類別（避免「茶餐廳」之類嘅泛稱）。
ANCHOR_TAGS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("railway", ("station", "halt")),
    ("station", ("subway", "light_rail")),
    ("shop", ("mall", "department_store", "supermarket")),
    ("amenity", ("hospital", "school", "university", "college", "marketplace")),
    ("leisure", ("park", "nature_reserve", "sports_centre", "stadium")),
    ("tourism", ("hotel", "attraction", "museum")),
    ("historic", ("monument", "temple", "ruins", "building")),
    ("landuse", ("residential", "cemetery", "industrial")),
    ("man_made", ("bridge", "tower")),
)

#: 太短／太泛嘅名唔可以做錨（避免「商場」「公園」命中一大堆）。
MIN_NAME_LEN = 3

#: 一個名如果係 ≥ 咁多個其他錨名嘅子字串 → 當佢係地區／泛稱，唔可以做錨。
DISTRICT_SUBSTR_MIN = 5
GENERIC_NAMES = {
    "商場", "公園", "學校", "醫院", "車站", "廣場", "大廈", "中心",
    "海濱", "花園", "遊樂場", "停車場", "街市", "市集", "球場",
}


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    dx = (a[0] - b[0]) * M_PER_DEG_LON
    dy = (a[1] - b[1]) * M_PER_DEG_LAT
    return math.hypot(dx, dy)


def build_landmark_index() -> dict[str, tuple[float, float]]:
    """地標名 → 座標。同名多筆 → 取面積最大（代表性最高）嗰筆。

    ⚠️ **地區名唔可以做錨**（2026-09-24 實測修正）
    ------------------------------------------
    第一版將所有符合類別嘅名都收做錨，結果「將軍澳」呢個**地鐵站名**
    令 30+ 個 `將軍澳*` 地點全部誤報 MISMATCH —— 因為文字提到「將軍澳」
    時多數係指**地區**（半徑幾公里），唔係指「將軍澳站」嗰一點。

    所以：先由 OSM 收集所有 `place=*`（suburb／town／village／
    neighbourhood…）嘅名，將佢哋**排除**出錨索引。地區名唔可能驗證一個點。
    """
    if not OSM_CACHE.exists():
        raise SystemExit(
            f"搵唔到 OSM 快取：{OSM_CACHE}\n"
            "呢個腳本要 `data/private/cache/osm-hk.json`（私有、唔會 commit）。"
        )
    els = json.loads(OSM_CACHE.read_text(encoding="utf-8"))["elements"]

    # ① 先收集地區名（唔可以做錨）
    place_names: set[str] = set()
    for e in els:
        t = e.get("tags") or {}
        if t.get("place"):
            nm = t.get("name:zh") or t.get("name")
            if nm:
                place_names.add(nm)

    # ①b ⚠️ 資料驅動規則：一個名如果係 **≥ `DISTRICT_SUBSTR_MIN` 個其他
    #     錨名**嘅子字串，佢就係地區／泛稱（例如「將軍澳」出現喺
    #     「將軍澳商場」「將軍澳墳場」「將軍澳游泳池」…）。呢類名唔可以
    #     用嚟驗證一個點 —— 文字提到「將軍澳」時指嘅係地區。
    #     （Overpass 匯出冇收 `place` node，所以唔可以靠 tag。）
    raw_names: list[str] = []
    for e in els:
        t = e.get("tags") or {}
        if not any(t.get(k) in vals for k, vals in ANCHOR_TAGS):
            continue
        nm = t.get("name:zh") or t.get("name")
        if nm and len(nm) >= MIN_NAME_LEN and nm not in GENERIC_NAMES:
            raw_names.append(nm)
    uniq = sorted(set(raw_names))
    district_names: set[str] = set()
    for a in uniq:
        if a in place_names:
            continue
        cnt = sum(1 for b in uniq if b != a and a in b)
        if cnt >= DISTRICT_SUBSTR_MIN:
            district_names.add(a)

    best: dict[str, tuple[float, float, float]] = {}
    for e in els:
        t = e.get("tags") or {}
        kind_ok = any(t.get(k) in vals for k, vals in ANCHOR_TAGS)
        if not kind_ok:
            continue
        name = t.get("name:zh") or t.get("name")
        if not name or len(name) < MIN_NAME_LEN or name in GENERIC_NAMES:
            continue
        if name in place_names or name in district_names:
            continue  # 地區／泛稱 → 唔係點錨
        g = [
            (p["lon"], p["lat"])
            for p in (e.get("geometry") or [])
            if p.get("lon") is not None
        ]
        if not g:
            continue
        cx = sum(p[0] for p in g) / len(g)
        cy = sum(p[1] for p in g) / len(g)
        xs = [p[0] for p in g]
        ys = [p[1] for p in g]
        area = (max(xs) - min(xs)) * (max(ys) - min(ys)) * M_PER_DEG_LON * M_PER_DEG_LAT
        prev = best.get(name)
        if prev is None or area > prev[2]:
            best[name] = (cx, cy, area)
    return {k: (v[0], v[1]) for k, v in best.items()}


def ring_centroid(coords: Any) -> tuple[float, float]:
    ring = coords[0] if isinstance(coords[0][0], list) else coords
    return (
        sum(p[0] for p in ring) / len(ring),
        sum(p[1] for p in ring) / len(ring),
    )


def classify(
    text: str, coord: tuple[float, float], index: dict[str, tuple[float, float]]
) -> dict[str, Any]:
    hits = [
        (name, index[name], dist_m(coord, index[name]))
        for name in index
        if name in text
    ]
    hits.sort(key=lambda h: h[2])
    if not hits:
        return {"status": "NO_TEXT", "hits": []}
    near = [h for h in hits if h[2] <= MATCH_TOLERANCE_M]
    if near:
        return {
            "status": "PASS",
            "nearest": near[0][0],
            "distanceM": round(near[0][2], 1),
            "hits": [(n, round(d, 1)) for n, _, d in hits[:5]],
        }
    if len(hits) >= 2:
        return {
            "status": "AMBIGUOUS",
            "hits": [(n, round(d, 1)) for n, _, d in hits[:5]],
        }
    name, c, d = hits[0]
    return {
        "status": "MISMATCH",
        "anchor": name,
        "anchorCoord": [round(c[0], 6), round(c[1], 6)],
        "distanceM": round(d, 1),
        "hits": [(name, round(d, 1))],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="座標 × 故事文字一致性審計")
    ap.add_argument("--json", default="", help="額外寫一份 JSON 報告")
    args = ap.parse_args()

    print("建立地標索引 …", flush=True)
    index = build_landmark_index()
    print(f"地標索引：{len(index):,} 個名\n", flush=True)

    locs = json.loads(LOCATIONS.read_text(encoding="utf-8"))["features"]
    zones = json.loads(ZONES.read_text(encoding="utf-8"))["features"]
    dossiers = {
        d["zone_id"]: d
        for d in json.loads(DOSSIERS.read_text(encoding="utf-8"))["dossiers"]
    }

    report: dict[str, Any] = {"landmarks": len(index), "locations": [], "zones": []}

    print("=== Locations ===")
    tally: dict[str, int] = {}
    for f in locs:
        p = f["properties"]
        text = f"{p.get('description') or ''} {p.get('name') or ''}"
        coord = (f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1])
        r = classify(text, coord, index)
        tally[r["status"]] = tally.get(r["status"], 0) + 1
        if r["status"] == "MISMATCH":
            report["locations"].append(
                {
                    "id": p["id"],
                    "name": p["name"],
                    "coord": [round(coord[0], 6), round(coord[1], 6)],
                    "first_appearance": p.get("first_appearance"),
                    "precision": p.get("location_precision"),
                    "coord_source": p.get("coordinate_source"),
                    **r,
                }
            )
    for k, v in sorted(tally.items()):
        print(f"  {v:5d}  {k}")

    print("\n=== Zones（用 dossier overview）===")
    ztally: dict[str, int] = {}
    for f in zones:
        p = f["properties"]
        zid = p.get("id")
        dz = dossiers.get(zid) or {}
        text = f"{dz.get('overview') or ''} {p.get('name') or ''}"
        coord = ring_centroid(f["geometry"]["coordinates"])
        r = classify(text, coord, index)
        ztally[r["status"]] = ztally.get(r["status"], 0) + 1
        if r["status"] == "MISMATCH":
            report["zones"].append(
                {
                    "id": zid,
                    "name": p.get("name"),
                    "coord": [round(coord[0], 6), round(coord[1], 6)],
                    **r,
                }
            )
    for k, v in sorted(ztally.items()):
        print(f"  {v:5d}  {k}")

    print("\n=== MISMATCH：文字提到嘅地標同座標差好遠 ===")
    print(f"（locations {len(report['locations'])} 個、zones {len(report['zones'])} 個）")
    for r in sorted(report["zones"], key=lambda x: -x["distanceM"]):
        print(f"  [zone] {r['name']:20} {r['distanceM']:7.0f} m → {r['anchor']}")
    for r in sorted(report["locations"], key=lambda x: -x["distanceM"])[:25]:
        print(
            f"  [loc ] {r['name']:20} {r['distanceM']:7.0f} m → {r['anchor']}"
            f"（ch{r.get('first_appearance')}、{r.get('coord_source')}）"
        )

    report["tally"] = {"locations": tally, "zones": ztally}
    if args.json:
        p = Path(args.json)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n寫入 {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

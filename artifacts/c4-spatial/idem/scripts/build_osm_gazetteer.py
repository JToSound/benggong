#!/usr/bin/env python3
"""由本機 OSM 快取建立「地名 → 座標」索引（gazetteer）。

為何需要
========
《病港》係以真實香港為舞台嘅小說，但地點資料有 **84%** 嘅座標係
「同章質心 + id hash 環形偏移」隨機生成（`location_precision: approximate`）。
呢個做法令「醫療室」可能落喺屯門、「主角嘅安全屋」可能落喺西環，
而故事明明全部喺將軍澳 —— 呢個就係用戶報告嘅「座標標錯」。

要修，就要有一個**可稽核嘅真實地名對照表**。OSM 快取入面有 89,153 個
有名地物，正正就係呢個對照表。

輸出
====
`data/private/cache/gazetteer.json`（**私有**，唔 commit、唔部署）

為何唔放公開資料
----------------
呢個索引係 OSM（ODbL）嘅衍生資料，雖然可以發佈，但佢係**原始資料**
而唔係經審閱嘅公開內容。專案紅線係「公開網站只可以有經審閱短摘要、
章節參照、結構化事件／位置資料」——所以索引只作離線用途，
座標會**烘焙入**公開資料集。

用法
====
    python scripts/build_osm_gazetteer.py
    python scripts/build_osm_gazetteer.py --min-priority 2
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
OSM_CACHE = REPO / "data" / "private" / "cache" / "osm-hk.json"
OUT = REPO / "data" / "private" / "cache" / "gazetteer.json"

#: 只有涵蓋故事舞台（將軍澳／西貢／九龍東）嘅地物才值得入索引。
#: 索引太闊會令「商場」呢類通用名撞到全港幾十個結果。
STORY_BBOX = {
    "lon_min": 114.14,
    "lon_max": 114.36,
    "lat_min": 22.22,
    "lat_max": 22.36,
}

#: 地物優先級（數字越細越可信）。
#: 用嚟喺多個同名結果之中揀最合理嘅一個。
PRIORITY: list[tuple[str, int]] = [
    ("amenity:university", 0),
    ("amenity:college", 0),
    ("amenity:hospital", 0),
    ("amenity:school", 1),
    ("amenity:place_of_worship", 2),
    ("amenity:community_centre", 2),
    ("leisure:park", 2),
    ("leisure:sports_centre", 2),
    ("landuse:residential", 2),
    ("building:yes", 3),
    ("shop:mall", 1),
    ("amenity:library", 2),
    ("amenity:police", 2),
    ("amenity:fire_station", 2),
    ("amenity:marketplace", 2),
    ("amenity:bus_station", 2),
    ("railway:station", 1),
    ("highway:bus_stop", 4),
    ("place:neighbourhood", 2),
    ("place:suburb", 2),
    ("place:village", 2),
    ("place:quarter", 2),
]

#: 太通用嘅名唔應該做索引 key（會亂配）。
TOO_GENERIC = {
    "商場", "大廈", "花園", "中心", "廣場", "學校", "公園", "停車場",
    "小學", "中學", "醫院", "教堂", "街市", "球場", "游泳池", "平台",
}


def geom_of(el: dict[str, Any]) -> list[tuple[float, float]]:
    g = el.get("geometry") or []
    return [(p["lon"], p["lat"]) for p in g if p.get("lon") is not None]


def centroid(pts: list[tuple[float, float]]) -> tuple[float, float]:
    return (
        sum(p[0] for p in pts) / len(pts),
        sum(p[1] for p in pts) / len(pts),
    )


def polygon_area_m2(pts: list[tuple[float, float]]) -> float:
    if len(pts) < 3:
        return 0.0
    s = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2 * 111320 * math.cos(math.radians(22.36)) * 110570


def priority_of(tags: dict[str, Any]) -> int | None:
    for key, pri in PRIORITY:
        k, _, v = key.partition(":")
        if tags.get(k) == v:
            return pri
    if tags.get("building") and tags.get("name"):
        return 3
    return None


#: OSM 嘅 `name` 好常見係「中文 English」連寫（例如
#: 「靈實醫院 Haven of Hope Hospital」）。唔拆開嘅話，用中文名查
#: 永遠查唔到 —— 實測 17 個故事關鍵地名有 8 個中招。
_CJK = r"\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef"
_SPLIT_MIXED = re.compile(rf"^([{_CJK}][{_CJK}\s]*?)\s+[A-Za-z]")
_SPLIT_PAREN = re.compile(rf"^([{_CJK}][{_CJK}\s]{{1,14}}?)[（(]")


def names_of(tags: dict[str, Any]) -> list[str]:
    """抽出所有可能用嘅名（中文優先，並拆開中英連寫）。"""
    out: list[str] = []
    for k in (
        "name:zh", "name", "official_name:zh", "official_name",
        "short_name:zh", "short_name", "alt_name:zh", "alt_name", "loc_name",
    ):
        v = tags.get(k)
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
    for v in list(out):
        m = _SPLIT_MIXED.match(v)
        if m:
            out.append(m.group(1).strip())
        m = _SPLIT_PAREN.match(v)
        if m:
            out.append(m.group(1).strip())
        # 「X（Y）」→ 亦註冊 Y（例如「尚德邨（尚德商場）」）
        m = re.match(r"^[^（(]{2,14}[（(]([^）)]{2,14})[）)]", v)
        if m:
            out.append(m.group(1).strip())
    return list(dict.fromkeys(x for x in out if x))


def main() -> int:
    ap = argparse.ArgumentParser(description="建立 OSM 地名索引")
    ap.add_argument("--min-priority", type=int, default=4)
    args = ap.parse_args()

    if not OSM_CACHE.exists():
        raise SystemExit(f"搵唔到 OSM 快取：{OSM_CACHE}")
    print(f"讀取 {OSM_CACHE.name} …", flush=True)
    els = json.loads(OSM_CACHE.read_text(encoding="utf-8"))["elements"]

    b = STORY_BBOX
    index: dict[str, list[dict[str, Any]]] = defaultdict(list)
    n_used = 0

    for el in els:
        t = el.get("tags") or {}
        if not t:
            continue
        pri = priority_of(t)
        if pri is None or pri > args.min_priority:
            continue
        pts = geom_of(el)
        if not pts:
            continue
        cx, cy = centroid(pts)
        if not (b["lon_min"] <= cx <= b["lon_max"] and b["lat_min"] <= cy <= b["lat_max"]):
            continue
        area = polygon_area_m2(pts) if len(pts) >= 3 else 0.0
        for nm in names_of(t):
            if len(nm) < 2 or nm in TOO_GENERIC:
                continue
            index[nm].append({
                "lon": round(cx, 6),
                "lat": round(cy, 6),
                "pri": pri,
                "area": round(area, 1),
                "kind": next(
                    (f"{k}={t.get(k)}" for k in ("amenity", "leisure", "landuse", "shop", "railway", "place", "building") if t.get(k)),
                    "?",
                ),
                "osm": el.get("id"),
            })
        n_used += 1

    # 每個名只保留最可信（pri 最細、面積最大）嘅頭 4 個
    for nm in list(index):
        lst = index[nm]
        lst.sort(key=lambda x: (x["pri"], -x["area"]))
        index[nm] = lst[:4]

    print(f"用到 {n_used:,} 個地物 → {len(index):,} 個名")
    OUT.write_text(
        json.dumps(
            {
                "note": "由 data/private/cache/osm-hk.json 衍生，僅供離線對照。唔可以 commit／部署。",
                "source": "OpenStreetMap contributors (ODbL)",
                "bbox": STORY_BBOX,
                "entries": index,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"寫入 {OUT}（{OUT.stat().st_size / 1024:.0f} KiB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

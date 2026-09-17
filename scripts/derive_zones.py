#!/usr/bin/env python3
"""由地點資料推導「區域」（倖存區／病窩）→ `data/public/zones.geojson`。

為何要獨立一支腳本
==================
地點係「點」，區域係「面」。地圖上要表達「呢一帶係安全區」或者
「呢度係病窩」，需要一個有**範圍**嘅圖層，唔可以只靠點標記。

範圍從何而來（重要）
====================
**唔可以憑感覺訂半徑。** 分兩種來源，全部可稽核：

1. **`members`** — 由區域嘅**成員地點實際分佈**推導。
   例如「艾寶琳倖存區」有 4 個成員（邊境圍牆、主街道、地鐵站、本體），
   佢哋嘅座標跨度就係 1,024 m —— 呢個係**證據**，唔係估算。

2. **`default`** — 只有一個成員（冇分佈可言）時，用**按類型嘅預設半徑**。
   呢個係估算，所以 `radius_source` 會標明，前端可以顯示為「示意範圍」。

另外有一批區域係**文中明文描述**但冇對應地點（例如「坑口這個大病窩」），
以策展清單形式加入，每條都附章節引用。

用法：
    python scripts/derive_zones.py --dry-run
    python scripts/derive_zones.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
OUT = REPO / "data" / "public" / "zones.geojson"
SCHEMA = REPO / "data" / "schemas" / "zone.schema.json"

#: 區域詞 → 類型。`survivor` = 人類聚居；`nest` = 病者巢穴。
#:
#: 為何「據點」歸 nest：文中「不良人據點」係敵對組織嘅控制區，
#: 對倖存者而言係危險區，用同一個危險色系表達。
ZONE_WORDS: list[tuple[str, str]] = [
    ("倖存區", "survivor"),
    ("安全區", "survivor"),
    ("病窩", "nest"),
    ("巢穴", "nest"),
    ("據點", "nest"),
    ("根據地", "nest"),
]

#: 按類型嘅預設半徑（米）。**只喺冇成員分佈可用時才用**。
DEFAULT_RADIUS_M = {
    "survivor": 300.0,
    "nest": 200.0,
    "nest_large": 800.0,
}

#: 半徑上下限。太細嘅話地圖上睇唔到；太大嘅話會蓋過其他區域。
MIN_RADIUS_M = 80.0
MAX_RADIUS_M = 2000.0

#: 策展區域：文中**明文描述**但冇對應地點。
#:
#: 每條都要有 `evidence`（章節 + 原文片段），否則唔應該加入。
CURATED_ZONES: list[dict[str, Any]] = [
    {
        "name": "坑口大病窩",
        "kind": "nest",
        "kind_detail": "nest_large",
        "lonlat": [114.2729, 22.3166],
        "radius_m": 800.0,
        "evidence": (
            "ch199 原文：「在半空觀視**坑口這個大病窩**，有著獨特的感覺。」"
            "另有 ch198：「像興建更大的病窩般，兩橦原本毫不關聯的大廈，都會"
            "透過那些建築而連接起來」、ch199：「利用本身病窩把一切建築物都"
            "連成一體的特性，通往到政府綜合大樓」。"
            "即係整個坑口區被病窩網絡覆蓋。"
        ),
        "chapters": [198, 199, 203],
    },
]


def haversine_m(a: list[float], b: list[float]) -> float:
    """兩點距離（米）。用等距圓柱近似（同前端一致）。"""
    return math.hypot(
        (b[0] - a[0]) * 111320 * math.cos(math.radians(22.36)),
        (b[1] - a[1]) * 110570,
    )


def zone_kind(name: str) -> tuple[str, str] | None:
    """由名稱判斷 (kind, kind_detail)。唔係區域就 None。"""
    for word, kind in ZONE_WORDS:
        if word in name:
            return kind, kind
    return None


#: 方位詞。括號內含呢啲字 = 位置修飾（「…內」「…裡」），唔係區域名。
LOCATIVE = ("內", "裡", "中", "上", "下", "旁", "外")


def zone_word_in_locative(name: str) -> bool:
    """區域詞係唔係喺**方位括號**之內。

    分辨兩種括號（實測）：
      「商場（病腦嘅病窩）」      → 括號係**描述**（呢座商場就係病窩）→ 係區域
      「地鐵站（艾寶琳倖存區內）」 → 括號係**位置**（地鐵站喺區內）→ 係成員
    """
    m = re.search(r"[（(]([^）)]*)[）)]", name)
    if not m:
        return False
    inner = m.group(1)
    if not any(w in inner for w, _ in ZONE_WORDS):
        return False
    return any(loc in inner for loc in LOCATIVE)


def zone_seed(name: str) -> str | None:
    """如果呢個名本身係一個**區域**，回傳核心名；否則 None。

    「艾寶琳倖存區」          → 「艾寶琳倖存區」
    「艾寶琳倖存區邊境圍牆」   → 「艾寶琳倖存區」（前綴匹配）
    「地鐵站（艾寶琳倖存區內）」→ None（係成員）
    「倖存區」                → None（純通用詞）
    """
    if zone_word_in_locative(name):
        return None
    for word, _ in ZONE_WORDS:
        i = name.find(word)
        if i < 0:
            continue
        core = name[: i + len(word)]
        # 純通用詞唔算區域（要有識別性前綴）
        if len(core) <= len(word) + 1:
            return None
        return core
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="推導區域（倖存區／病窩）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    locs = json.loads(LOCATIONS.read_text(encoding="utf-8"))["features"]
    by_id = {f["properties"]["id"]: f for f in locs}

    # ---- 1. 分組：先搵區域種子，再按「名包含核心名」分配成員 ----
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in locs:
        seed = zone_seed(f["properties"]["name"])
        if seed:
            groups[seed].append(f)  # 種子自己都係成員
    # 成員分配：名包含核心名（但唔包括已屬其他區域嘅）
    for f in locs:
        nm = f["properties"]["name"]
        if zone_seed(nm):
            continue
        for seed in groups:
            if seed in nm:
                groups[seed].append(f)
                break

    zones: list[dict[str, Any]] = []
    for core, members in groups.items():
        # 只保留「有真實座標」嘅成員做範圍推導
        pts = [
            m["geometry"]["coordinates"]
            for m in members
            if m["properties"]["location_precision"] != "fictional"
        ]
        all_pts = [m["geometry"]["coordinates"] for m in members]
        kind, detail = zone_kind(core) or ("nest", "nest")

        if len(pts) >= 2:
            # 由成員分佈推導（證據）
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            radius = max(haversine_m([cx, cy], p) for p in pts)
            # 加 15% 餘裕：成員通常係區內設施，唔會啱啱好到邊界
            radius *= 1.15
            source = "members"
        elif all_pts:
            # 只有一個點 → 用預設半徑（估算）
            cx, cy = all_pts[0]
            radius = DEFAULT_RADIUS_M.get(detail, 200.0)
            source = "default"
        else:
            continue

        radius = max(MIN_RADIUS_M, min(MAX_RADIUS_M, radius))

        # 章節聯集
        chapters = sorted({c for m in members for c in m["properties"]["chapters"]})
        # 描述取本體（名最短嘅成員）嘅
        body = min(members, key=lambda m: len(m["properties"]["name"]))
        sig = hashlib.sha1(core.encode("utf-8")).hexdigest()[:10]

        zones.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(cx, 6), round(cy, 6)]},
            "properties": {
                "id": f"zone_{sig}",
                "name": core,
                "kind": kind,
                "radius_m": round(radius, 1),
                "radius_source": source,
                "member_location_ids": [m["properties"]["id"] for m in members],
                "chapters": chapters[:50],
                "first_appearance": chapters[0] if chapters else None,
                "description": body["properties"]["description"],
                "evidence": (
                    f"由 {len(pts)} 個有真實座標嘅成員地點分佈推導（跨距 "
                    f"{max(haversine_m([cx, cy], p) for p in pts):.0f} m，"
                    f"加 15% 餘裕）"
                    if source == "members"
                    else f"只有 {len(all_pts)} 個成員點，用按類型嘅預設半徑（估算）"
                ),
                "source": "bing_gang",
            },
        })

    # ---- 2. 策展區域 ----
    for c in CURATED_ZONES:
        sig = hashlib.sha1(c["name"].encode("utf-8")).hexdigest()[:10]
        zones.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": c["lonlat"]},
            "properties": {
                "id": f"zone_{sig}",
                "name": c["name"],
                "kind": c["kind"],
                "radius_m": c["radius_m"],
                "radius_source": "curated",
                "member_location_ids": [],
                "chapters": c["chapters"],
                "first_appearance": c["chapters"][0] if c["chapters"] else None,
                "description": c["evidence"][:100],
                "evidence": c["evidence"],
                "source": "bing_gang",
            },
        })

    # 排序：先按首次出現章節，再按名
    zones.sort(key=lambda z: (z["properties"]["first_appearance"] or 999, z["properties"]["name"]))

    n_members = sum(1 for z in zones if z["properties"]["radius_source"] == "members")
    n_default = sum(1 for z in zones if z["properties"]["radius_source"] == "default")
    n_curated = sum(1 for z in zones if z["properties"]["radius_source"] == "curated")
    kinds: dict[str, int] = defaultdict(int)
    for z in zones:
        kinds[z["properties"]["kind"]] += 1

    print(f"區域總數：{len(zones)}")
    print(f"  範圍來源：成員分佈 {n_members}／預設半徑 {n_default}／策展 {n_curated}")
    print(f"  類型：{dict(kinds)}")
    print("\n最闊嘅 8 個區域：")
    for z in sorted(zones, key=lambda z: -z["properties"]["radius_m"])[:8]:
        p = z["properties"]
        print(
            f"  {p['name'][:20]:20s} {p['radius_m']:7.0f} m  [{p['kind']:8s}/"
            f"{p['radius_source']:8s}] ch{p['first_appearance']}"
        )

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
        return 0

    OUT.write_text(
        json.dumps({"type": "FeatureCollection", "features": zones}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"\n寫入 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

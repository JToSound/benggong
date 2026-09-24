#!/usr/bin/env python3
"""將「虛構精度」地點錨定到同章已解析地點附近。

問題
====
327 個 `location_precision=fictional` 嘅地點，座標散落全港
（實測經度 113.894–114.309、緯度 22.204–22.447）。用戶喺地圖上見到
標記出現喺屯門、大嶼山等地方，同故事設定（第一季集中喺將軍澳）
完全唔符。

**根因**：呢啲座標係抽取階段由 `story_position`（一個 0–1 嘅虛構版面
座標）線性映射到香港 bbox 得出 —— 即係**任意**嘅真實經緯度，冇任何
地理意義。

修正原則
========
虛構地點**唔應該**放喺任意真實座標。但完全隱藏又會令用戶喺地圖上
搵唔到佢。所以：

  **錨定到同章已解析地點嘅質心附近** —— 即係「呢件事發生喺將軍澳
  一帶」，但唔聲稱係邊一幢樓。

- `location_precision` 保持 `fictional`（誠實：唔係真實位置）
- 新增 `position_source` 欄位講明座標係點嚟（可稽核）
- 偏移量由 id 嘅 hash 決定（deterministic、可重跑、唔會每次唔同）

用法：
    python scripts/anchor_fictional_locations.py --dry-run
    python scripts/anchor_fictional_locations.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOCATIONS = REPO / "data" / "public" / "locations.geojson"

#: 錨定圓環嘅半徑（米）。太細會疊埋一齊，太大會離開該區。
RING_RADIUS_M = 420.0

#: 冇任何同章錨點時嘅後備：故事主場景（將軍澳校園一帶）。
FALLBACK_CENTRE = [114.25344, 22.30578]

#: 故事設定區域（將軍澳）。**錨點必須落喺呢度**。
#:
#: ⚠️ 為何要限制錨點範圍
#: --------------------
#: 實測：ch139 嘅唯一已解析錨點係「香港中文大學專業進修學院」
#: (114.165, 22.318) —— 即係**旺角**。結果「翠林倖存區（翠林邨）」
#: 「血酒工廠（頂樓）」「心朗村」全部被拉到旺角，但佢哋明顯喺將軍澳
#: （翠林邨實際喺 114.248, 22.323）。
#:
#: 單一偏遠錨點會污染整個質心。所以只准用**落喺故事區域內**嘅錨點；
#: 一個都冇就用後備中心。
STORY_REGION = {"lon": (114.225, 114.310), "lat": (22.265, 22.350)}


def in_story_region(c: list[float]) -> bool:
    return (
        STORY_REGION["lon"][0] <= c[0] <= STORY_REGION["lon"][1]
        and STORY_REGION["lat"][0] <= c[1] <= STORY_REGION["lat"][1]
    )

#: 米 → 度
M_PER_DEG_LON = 111320 * math.cos(math.radians(22.36))
M_PER_DEG_LAT = 110570

#: 組織／群體後綴 —— 唔可以當父項（同 infer_places.py 一致）
ORG_SUFFIX = ("人", "幫", "會", "團", "隊", "軍", "黨", "社", "派")

#: 方位／包含詞。2 字父項必須喺呢啲詞前後 6 字之內才算「容器」。
CONTAIN_WORDS = ("內", "中", "裡", "入面", "裡面", "之下", "上面", "旁邊")


def offset_for(loc_id: str, ring: float = RING_RADIUS_M) -> tuple[float, float]:
    """由 id 決定一個 deterministic 嘅環形偏移（米）。

    用 hash 而唔用 `random` —— 保證可重跑（每次執行結果一樣），
    呢個係 pipeline 嘅硬性要求。
    """
    h = int(hashlib.sha1(loc_id.encode("utf-8")).hexdigest()[:8], 16)
    angle = (h % 3600) / 3600 * 2 * math.pi
    # 半徑都有變化，避免全部喺同一個圓周上
    r = ring * (0.45 + 0.55 * ((h >> 12) % 1000) / 1000)
    return r * math.cos(angle), r * math.sin(angle)


def main() -> int:
    ap = argparse.ArgumentParser(description="錨定虛構地點")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    fc = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    feats = fc["features"]

    # 每章嘅已解析地點座標
    by_ch: dict[int, list[list[float]]] = defaultdict(list)
    # 已解析地點名 → 座標（用嚟做「父項優先」錨定）
    parent_xy: dict[str, list[float]] = {}
    parent_props: dict[str, dict] = {}
    for f in feats:
        p = f["properties"]
        if p["location_precision"] == "fictional":
            continue
        for ch in p["chapters"]:
            by_ch[ch].append(f["geometry"]["coordinates"])
        nm = p["name"]
        if len(nm) >= 2 and not nm.endswith(ORG_SUFFIX):
            parent_xy.setdefault(nm, f["geometry"]["coordinates"])
            parent_props.setdefault(nm, p)
    # 兩份名單：
    #   `parent_names`      —— 名路徑用，要 ≥3 字（2 字名做前綴會誤配）
    #   `parent_names_desc` —— 描述路徑用，包括 2 字（配合方位詞約束）
    parent_names = sorted(
        (n for n in parent_xy if len(n) >= 3), key=len, reverse=True
    )
    parent_names_desc = sorted(parent_xy.keys(), key=len, reverse=True)

    moved = 0
    no_anchor = 0
    anchored_to_parent = 0
    for f in feats:
        p = f["properties"]
        if p["location_precision"] != "fictional":
            continue

        # ---- 錨點優先次序 ----
        #
        # 1. **名含已解析地點名** → 直接用父項座標（最準）
        #    例：「七樓圖書館」→「圖書館」；「圖書館４號會議室」→「圖書館」
        # 2. **描述含已解析地點名** → 用該地點座標
        # 3. 同章已解析地點質心（原本做法）
        #
        # 為何要分優先次序：同章質心可能離實際位置幾百米（同章跨越多個
        # 地點）。有名稱父項嘅話，父項座標就係最準嘅已知值。
        nm = p["name"]
        desc = p["description"] or ""
        parent = next(
            (x for x in parent_names if x != nm and x in nm),
            None,
        )
        via = "名"
        if parent is None:
            # 描述路徑：**≥3 字父項**直接可用；**2 字父項**必須喺方位詞附近。
            #
            # 為何要分開對待：
            #   2 字地點名（商場、廣場、宿舍、醫院）雖然有識別性，
            #   但佢哋喺描述入面出現嘅頻率極高，而且唔一定係「容器」。
            #   實測錯配：「幼稚園」嘅描述提到「天台」（另一個已解析地點）
            #   → 被錨定到嗰個天台；「大型活動室」配到「八樓」。
            #
            #   但「商場**內**一間寵物店」「廣場**中的**UNIQLO」就係
            #   明確嘅包含關係。所以要求 2 字父項必須喺方位詞附近。
            for x in parent_names_desc:
                idx = desc.find(x)
                if idx < 0:
                    continue
                if len(x) >= 3:
                    parent = x
                    break
                window = desc[max(0, idx - 6) : idx + len(x) + 6]
                if any(w in window for w in CONTAIN_WORDS):
                    parent = x
                    break
            via = "描述"

        if parent is not None:
            base = parent_xy[parent]
            dx0, dy0 = offset_for(p["id"], ring=90.0)  # 父項附近小偏移
            lon = round(base[0] + dx0 / M_PER_DEG_LON, 6)
            lat = round(base[1] + dy0 / M_PER_DEG_LAT, 6)
            f["geometry"]["coordinates"] = [lon, lat]

            # ⚠️ **精度升級**：由 `fictional` 改為父項嘅精度。
            #
            # 為何合理：子項嘅聲明係「喺父項之內」。父項嘅座標係最佳已知
            # 值，所以子項嘅位置準確度**同父項一樣** —— 唔應該繼續標
            # `fictional`（嗰個意思係「完全唔知喺邊」）。
            #
            # 唔可以升級到比父項更準：子項係父項內部嘅一個房間，
            # 唔會比父項本身更準確。
            pp = parent_props[parent]
            p["location_precision"] = pp["location_precision"]
            p["fictional"] = False
            p["position_source"] = (
                f"依附於「{parent}」（由{via}配對）；"
                f"精度繼承自父項（{pp['location_precision']}）"
            )
            anchored_to_parent += 1
            moved += 1
            continue

        # 只准用落喺故事區域內嘅錨點（單一偏遠錨點會污染質心）
        pts: list[list[float]] = []
        skipped = 0
        for ch in p["chapters"]:
            for q in by_ch.get(ch, []):
                if in_story_region(q):
                    pts.append(q)
                else:
                    skipped += 1

        if pts:
            cx = sum(q[0] for q in pts) / len(pts)
            cy = sum(q[1] for q in pts) / len(pts)
            src = (
                f"同章（{p['chapters'][:3]}）嘅 {len(pts)} 個已解析地點質心"
                f"附近（環形偏移，id hash 決定）"
            )
            if skipped:
                src += f"；已排除 {skipped} 個區域外錨點"
        else:
            cx, cy = FALLBACK_CENTRE
            src = "冇同章（區內）錨點，用故事主場景（將軍澳校園一帶）"
            no_anchor += 1

        dx, dy = offset_for(p["id"])
        lon = round(cx + dx / M_PER_DEG_LON, 6)
        lat = round(cy + dy / M_PER_DEG_LAT, 6)

        old = f["geometry"]["coordinates"]
        if abs(old[0] - lon) > 1e-6 or abs(old[1] - lat) > 1e-6:
            moved += 1
        f["geometry"]["coordinates"] = [lon, lat]
        p["position_source"] = src

    in_tko = sum(
        1
        for f in feats
        if f["properties"]["location_precision"] == "fictional"
        and 114.225 <= f["geometry"]["coordinates"][0] <= 114.310
        and 22.265 <= f["geometry"]["coordinates"][1] <= 22.350
    )
    total_fic = sum(
        1 for f in feats if f["properties"]["location_precision"] == "fictional"
    )
    print(f"虛構地點：{total_fic}")
    print(f"  位置有改動：{moved}（其中依附父項：{anchored_to_parent}）")
    print(f"  冇同章錨點（用後備）：{no_anchor}")
    print(f"  錨定後喺將軍澳範圍內：{in_tko} / {total_fic}")

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
        return 0

    LOCATIONS.write_text(
        json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"\n寫入 {LOCATIONS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

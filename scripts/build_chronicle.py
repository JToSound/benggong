#!/usr/bin/env python3
"""建置《病港》第一季編年史（`data/public/chronicle.json`）。

設計理念
========
現時 `events.geojson` 係**嚴格逐章**（1,796 條，`chapter_refs` 全部單章）。
但小說係非線性敍事：ch5 嘅伏筆可能到 ch40 才解釋。逐章展示答唔到
「呢件事係咩、幾時發生、邊幾章講過」。

編年史條目 = **故事世界入面嘅一件事**，並區分：
  - `story_time`            —— 件事幾時發生（故事內時間）
  - `first_mention_chapter` —— 讀者幾時第一次知

階段
====
**階段 A（本腳本）**：確定性合併，零成本、可重跑
  1. 同章同名重複 → 合併（實測 60 組，係抽取冗餘）
  2. 同名跨章且章節相近 → 合併（實測 4 組）
  3. 故事時間排序（用章節次序做初始值）

**階段 B（未做）**：LLM 語意聚合
  實測確定性信號太弱（同名跨章只 4 組），跨章事件識別需要語意理解。
  候選由確定性信號篩出，再交 LLM 判斷「係唔係同一件事」。

⚠️ 誠實嘅限制
=============
1. `story_time` 只能由章節次序推斷 —— 小說冇明確日期。
   所以 `source` 標 `chapter_order`，唔可以當成精確時間。
2. 階段 A 之後仍然係「一條事件 = 一個章節」為主（因為跨章信號弱）。
   真正嘅編年史效果要階段 B 才出到。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
EVENTS = REPO / "data" / "public" / "events.geojson"
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
OUT = REPO / "data" / "public" / "chronicle.json"

#: 同名跨章合併嘅最大章節距離。
#:
#: 為何設上限：同名但相隔 100 章嘅事件，好可能係唔同事（例如兩次「搜查」）。
#: 實測同名跨章只有 4 組，全部距離 ≤3，所以呢個上限唔會誤傷。
MAX_CROSS_CHAPTER_GAP = 5

#: 同章同名去重時，描述相似度門檻（字元集合 Jaccard）。
SAME_CHAPTER_SIM = 0.55


def sig(title: str) -> str:
    """由標題產生穩定 id（唔用序號 —— 序號會令 id 每次重跑都變）。"""
    return hashlib.sha1(title.encode("utf-8")).hexdigest()[:10]


def jaccard(a: str, b: str) -> float:
    """字元集合 Jaccard 相似度（中文用字元，唔用詞）。"""
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def main() -> int:
    ap = argparse.ArgumentParser(description="建置第一季編年史")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    evs = json.loads(EVENTS.read_text(encoding="utf-8"))["features"]
    locs = {f["properties"]["id"]: f["properties"]["name"]
            for f in json.loads(LOCATIONS.read_text(encoding="utf-8"))["features"]}

    # ---- 1. 同章同名去重 ----
    #
    # 抽取階段產生咗一批同章同名嘅重複（實測 60 組，例如「三人合照」×4）。
    # 佢哋唔係唔同事 —— 係同一次抽取嘅冗餘。
    groups: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    for f in evs:
        p = f["properties"]
        groups[(p["chapter"], p["title"])].append(p)

    merged_events: list[dict[str, Any]] = []
    deduped = 0
    for (_ch, _title), items in groups.items():
        if len(items) == 1:
            merged_events.append(items[0])
            continue
        # 取描述最長嘅做代表（資訊最多）
        items.sort(key=lambda p: -len(p.get("description") or ""))
        keep = dict(items[0])
        keep["_merged_from"] = [p["id"] for p in items]
        # 合併角色聯集
        chars: set[str] = set()
        for p in items:
            chars.update(p.get("characters") or [])
        keep["characters"] = sorted(chars)
        merged_events.append(keep)
        deduped += len(items) - 1

    # ---- 2. 同名跨章合併 ----
    by_title: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for p in merged_events:
        by_title[p["title"]].append(p)

    entries: list[dict[str, Any]] = []
    cross_merged = 0
    for title, items in by_title.items():
        items.sort(key=lambda p: p["chapter"])
        # 按章節距離分群
        cluster = [items[0]]
        clusters: list[list[dict[str, Any]]] = []
        for p in items[1:]:
            if p["chapter"] - cluster[-1]["chapter"] <= MAX_CROSS_CHAPTER_GAP:
                cluster.append(p)
            else:
                clusters.append(cluster)
                cluster = [p]
        clusters.append(cluster)

        for cl in clusters:
            if len(cl) > 1:
                cross_merged += len(cl) - 1
            body = max(cl, key=lambda p: len(p.get("description") or ""))
            first = cl[0]["chapter"]
            chapters = []
            for p in cl:
                role = "first_mention" if p["chapter"] == first else "reveal"
                ch: dict[str, Any] = {"chapter": p["chapter"], "role": role}
                note = (p.get("description") or "")[:60]
                if note:
                    ch["note"] = note
                chapters.append(ch)
            src_ids: list[str] = []
            for p in cl:
                src_ids.extend(p.get("_merged_from") or [p["id"]])

            loc_id = body.get("location_id")
            entries.append({
                "id": f"chr_{sig(title)}",
                "title": title,
                "summary": (body.get("description") or "")[:400],
                "story_time": {
                    "order": first,
                    "label": f"第 {first} 章前後",
                    "source": "chapter_order",
                },
                "first_mention_chapter": first,
                "chapters": chapters,
                "foreshadows": [],
                "pays_off": [],
                "location_id": loc_id,
                "location_name": locs.get(loc_id) if loc_id else None,
                "characters": body.get("characters") or [],
                "confidence": 0.9 if len(cl) > 1 else 0.75,
                "source_event_ids": sorted(set(src_ids)),
                "review_status": "pending",
            })

    entries.sort(key=lambda e: (e["first_mention_chapter"], e["title"]))

    multi = sum(1 for e in entries if len(e["chapters"]) > 1)
    print(f"原始事件：{len(evs)}")
    print(f"  同章同名去重：-{deduped}")
    print(f"  同名跨章合併：-{cross_merged}")
    print(f"  編年史條目：{len(entries)}")
    print(f"  其中跨章（≥2 章）：{multi}")

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
        return 0

    OUT.write_text(
        json.dumps({
            "version": 1,
            "season": 1,
            "generated_by": "scripts/build_chronicle.py",
            "entries": entries,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\n寫入 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

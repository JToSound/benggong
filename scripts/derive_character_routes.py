#!/usr/bin/env python3
"""《病港》— 角色移動路線推導（master prompt §10.4 routes）。

由 candidates 推導角色出現位置嘅時間序列：
- location candidates 提供「該章存在邊啲地點」
- character claims 內文提及地點名 → 該章該角色所在

規則（保守）：
- 角色名與地名相同時唔推導（自證問題）
- 長地名優先匹配（大本營市集 ≠ 大本營）
- 同一位置連續章節去重，只留首末
- 少於 MIN_CHAPTERS 章或無位置變化 → 唔產生 route
- 全部標 provisional + needs_review；waypoint 保留原始章節座標

輸出：data/private/review/character-routes.json（私有，供人手審閱後先入公開 routes.geojson）
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent if "__file__" in globals() else Path.cwd()
CANDIDATES = REPO / "data/private/evidence/candidates.jsonl"
OUT = REPO / "data/private/review/character-routes.json"

MIN_CHAPTERS = 5


def load_candidates() -> list[dict]:
    if not CANDIDATES.exists():
        return []
    rows = []
    for line in CANDIDATES.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def derive(rows: list[dict]) -> list[dict]:
    # 每章存在嘅地名清單（長名優先排序）
    locs_by_chapter: dict[int, list[str]] = defaultdict(list)
    for r in rows:
        if r.get("entity_kind") == "location":
            name = (r.get("name") or "").strip()
            if name:
                locs_by_chapter[r["chapter"]].append(name)
    all_locs = sorted({n for names in locs_by_chapter.values() for n in names}, key=len, reverse=True)

    # 角色 → 章 → 提及嘅地名
    char_ch_loc: dict[str, dict[int, str]] = defaultdict(dict)

    def find_location(claim: str, char_name: str) -> str | None:
        """喺 claim 入面搵最長地名；排除與角色名相同／互相包含造成嘅自證。"""
        for loc in all_locs:
            if loc == char_name:
                continue  # 角色名＝地名：唔算
            if loc in claim:
                # 避開「角色名+地名」黏埋嘅假匹配已由長名優先處理：
                # 更長嘅名會先被測試到
                return loc
        return None

    for r in rows:
        if r.get("entity_kind") != "character":
            continue
        name = (r.get("name") or "").strip()
        if not name:
            continue
        claim = r.get("claim") or ""
        chapter = r["chapter"]
        if name in {l for l in all_locs}:
            # 角色名本身係地名（如「公仔」）：完全跳過呢個角色
            continue
        loc = find_location(claim, name)
        if loc and chapter not in char_ch_loc[name]:
            char_ch_loc[name][chapter] = loc

    routes = []
    for name in sorted(char_ch_loc):
        ch_map = char_ch_loc[name]
        chapters = sorted(ch_map)
        if len(chapters) < MIN_CHAPTERS:
            continue
        # 時序壓縮：連續同一位置只留區間端點
        waypoints = []
        prev = None
        for i, ch in enumerate(chapters):
            loc = ch_map[ch]
            is_last = i == len(chapters) - 1
            next_loc = ch_map[chapters[i + 1]] if not is_last else None
            if loc != prev or next_loc != loc or is_last:
                waypoints.append({"chapter": ch, "location": loc})
            prev = loc

        distinct = len({w["location"] for w in waypoints})
        if distinct < 2:
            continue  # 冇移動 → 無 route

        routes.append(
            {
                "character": name,
                "chapters_covered": [chapters[0], chapters[-1]],
                "waypoints": waypoints,
                "provisional": True,
                "review_status": "needs_review",
                "note": "由 LLM candidates 自動推導；未經人手審閱前唔入公開資料。",
            }
        )
    return routes


def main() -> int:
    rows = load_candidates()
    if not rows:
        print(f"[blocked] {CANDIDATES} 不存在或空")
        return 2
    routes = derive(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(routes, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"推導出 {len(routes)} 條角色路線 → {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

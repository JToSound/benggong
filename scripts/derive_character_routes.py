#!/usr/bin/env python3
"""《病港》— 角色移動路線推導（provisional）。

由 character candidate 嘅 claim 文本抽取地點關鍵詞，配合章節順序，
為每個主要角色建立「章節→出現位置」序列；連續唔同位置構成 movement route。

方法（保守、deterministic）：
1. 只處理 chapter_refs >= MIN_CHAPTERS 嘅角色
2. claim 入面出現嘅已知 location 名（來自 location candidates 正規化清單）
   先算「該角色喺該章嘅位置」；一個 claim 多個地名時取最先出現
3. 連續相同位置去重；無法定位嘅章節跳過
4. 全部標 provisional + needs_review——只係審閱輔助，唔直接入 public dataset

輸出：data/private/review/character-routes.json
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CANDIDATES = REPO / "data/private/evidence/candidates.jsonl"
OUT = REPO / "data/private/review/character-routes.json"

MIN_CHAPTERS = 5


def main() -> int:
    if not CANDIDATES.exists():
        print("[blocked] 無 candidates 檔")
        return 2

    loc_names: set[str] = set()
    char_ch_claims: dict[str, dict[int, list[str]]] = defaultdict(lambda: defaultdict(list))

    for line in CANDIDATES.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        kind = r.get("entity_kind")
        ch = r.get("chapter")
        name = r.get("name") or ""
        if not ch or not name:
            continue
        if kind == "location":
            if name and len(name) >= 2:
                loc_names.add(name)
        elif kind == "character":
            claim = r.get("claim") or ""
            if claim:
                char_ch_claims[name][ch].append(claim)

    # 名長優先匹配（「大本營市集」先過「大本營」）
    sorted_locs = sorted(loc_names, key=len, reverse=True)

    routes: list[dict] = []
    for name, ch_map in sorted(char_ch_claims.items()):
        chapters = sorted(ch_map.keys())
        if len(chapters) < MIN_CHAPTERS:
            continue
        seq: list[dict] = []
        last_loc: str | None = None
        for ch in chapters:
            found: str | None = None
            for claim in ch_map[ch]:
                for loc in sorted_locs:
                    if loc in claim or loc in name:
                        found = loc
                        break
                if found:
                    break
            # 角色名同地名同名（例如「公仔」類）唔算移動證據
            if found and found != last_loc and found not in name:
                seq.append({"chapter": ch, "location": found})
                last_loc = found
        if len(seq) >= 2:
            routes.append({
                "character": name,
                "chapters_covered": len(chapters),
                "waypoints": seq,
                "provisional": True,
                "review_status": "needs_review",
            })

    routes.sort(key=lambda r: -r["chapters_covered"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(routes, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"角色移動路線：{len(routes)} 條（>= {MIN_CHAPTERS} 章）｜已知地名 {len(sorted_locs)} 個")
    for r in routes[:10]:
        wps = " → ".join(f"ch{w['chapter']}:{w['location']}" for w in r["waypoints"][:5])
        print(f"  {r['character']}（{r['chapters_covered']}章）：{wps}{' …' if len(r['waypoints'])>5 else ''}")
    print(f"輸出：{OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

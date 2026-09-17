#!/usr/bin/env python3
"""填充 `events.characters` 同 `timeline.characters`。

背景
====
實測 `events.geojson` 嘅 `characters` 欄位 **1,796 條全部係空陣列**，
`timeline.json` 亦係 0/1,796。即係事件／時間線同角色之間**完全冇連結** ——
「某角色喺邊幾章出現過邊啲事件」呢類查詢做唔到。

證據來源
========
1. **名稱提及**：事件嘅 `title` + `description` 提及角色名或別名
2. **章節一致性**：該角色嘅 `chapter_refs` 必須包含事件嘅章節

為何兩者都要
------------
單靠名稱提及會有假陽性 —— 短別名（例如「國王」「天使」）可能出現喺
無關句子。加章節一致性過濾之後，只有「喺該章出現過、而且被提及」嘅
角色才會入選。實測：只用提及 → 1,674 條命中；加章節過濾 → 1,485 條。

其他防護
--------
- **最長匹配優先**：如果「夏晴」同「晴」都係某角色嘅名，只算長嘅
- **排除代名詞同單字別名**：「我」「你」「佢」呢類唔係識別性稱呼
- **唔捏造**：冇命中就保持空陣列，唔會用「該章所有角色」填數

用法：
    python scripts/link_event_characters.py --dry-run
    python scripts/link_event_characters.py
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
LOG = REPO / "data" / "private" / "review" / "event-character-links.json"

#: 唔可以當識別性稱呼嘅名／別名。
#:
#: 代名詞（我／你／佢）同角色類型詞（主角／敘事者）喺文中出現嘅頻率
#: 極高但冇識別性 —— 用佢哋比對會令幾乎每條事件都「命中」。
STOPWORDS = {
    "我", "你", "他", "她", "佢", "它", "我們", "你們", "他們", "大家",
    "自己", "主角", "敘事者", "旁白", "老師", "醫生", "護士",
}


def build_index(chars: list[dict[str, Any]]) -> dict[str, set[str]]:
    """名稱／別名 → 角色 id 集合。"""
    idx: dict[str, set[str]] = {}
    for c in chars:
        for n in [c["name"], *(c.get("aliases") or [])]:
            n = (n or "").strip()
            if len(n) < 2 or n in STOPWORDS:
                continue
            idx.setdefault(n, set()).add(c["id"])
    return idx


def match_characters(
    text: str,
    chapter: int | None,
    idx: dict[str, set[str]],
    chapters_by_id: dict[str, set[int]],
) -> dict[str, str]:
    """回傳 {角色 id: 命中嘅名}。

    最長匹配優先：按名稱長度由長到短掃，令「夏晴」贏過「晴」。
    之後再過濾章節一致性。
    """
    hits: dict[str, str] = {}
    for n in sorted(idx, key=len, reverse=True):
        if n not in text:
            continue
        for cid in idx[n]:
            hits.setdefault(cid, n)
    if chapter is None:
        return hits
    return {cid: n for cid, n in hits.items() if chapter in chapters_by_id.get(cid, set())}


def main() -> int:
    ap = argparse.ArgumentParser(description="填充事件／時間線嘅角色連結")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    chars = json.loads((PUBLIC / "characters.json").read_text(encoding="utf-8"))
    idx = build_index(chars)
    chapters_by_id = {c["id"]: set(c.get("chapter_refs") or []) for c in chars}
    print(f"角色 {len(chars)} 個；可用名稱／別名 {len(idx)} 個")

    stats: dict[str, Any] = {}

    # ---- events ----
    ev_path = PUBLIC / "events.geojson"
    events = json.loads(ev_path.read_text(encoding="utf-8"))
    dist: Counter[int] = Counter()
    n_linked = 0
    for f in events["features"]:
        p = f["properties"]
        text = (p.get("title") or "") + " " + (p.get("description") or "")
        r = match_characters(text, p.get("chapter"), idx, chapters_by_id)
        p["characters"] = sorted(r)
        dist[min(len(r), 5)] += 1
        if r:
            n_linked += 1
    print(f"\n=== events ===")
    print(f"  有角色連結：{n_linked} / {len(events['features'])}"
          f"（{n_linked / len(events['features']) * 100:.1f}%）")
    print(f"  每個事件嘅角色數分佈（5 = 5+）：{dict(sorted(dist.items()))}")
    stats["events"] = {"linked": n_linked, "total": len(events["features"]),
                       "distribution": {str(k): v for k, v in sorted(dist.items())}}

    # ---- timeline ----
    tl_path = PUBLIC / "timeline.json"
    tl = json.loads(tl_path.read_text(encoding="utf-8"))
    dist2: Counter[int] = Counter()
    n_linked2 = 0
    for t in tl:
        text = (t.get("title") or "") + " " + (t.get("description") or "")
        r = match_characters(text, t.get("chapter"), idx, chapters_by_id)
        t["characters"] = sorted(r)
        dist2[min(len(r), 5)] += 1
        if r:
            n_linked2 += 1
    print(f"\n=== timeline ===")
    print(f"  有角色連結：{n_linked2} / {len(tl)}"
          f"（{n_linked2 / len(tl) * 100:.1f}%）")
    stats["timeline"] = {"linked": n_linked2, "total": len(tl),
                         "distribution": {str(k): v for k, v in sorted(dist2.items())}}

    # ---- 一致性：timeline 同 events 應該一致 ----
    ev_by_id = {f["properties"]["id"]: f["properties"] for f in events["features"]}
    mismatch = [
        t["id"]
        for t in tl
        if t.get("event_id") in ev_by_id
        and set(t.get("characters") or []) != set(ev_by_id[t["event_id"]].get("characters") or [])
    ]
    print(f"\n=== 一致性 ===")
    print(f"  timeline 同 events 角色唔一致：{len(mismatch)}")
    stats["mismatch"] = len(mismatch)

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
        return 0

    ev_path.write_text(json.dumps(events, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tl_path.write_text(json.dumps(tl, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    LOG.write_text(
        json.dumps({"applied_at": "2026-09-16", **stats}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\n寫入 {ev_path}")
    print(f"寫入 {tl_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

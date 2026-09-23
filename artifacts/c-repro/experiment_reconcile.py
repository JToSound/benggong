#!/usr/bin/env python3
"""C 項實驗：測試「將產生器輸出對齊現況凍結 registry」嘅唔同策略，
睇下邊個可以令 id 集合 hash 同 FROZEN 一致。只讀、唔寫 data/。"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "artifacts" / "c-repro"))

from analyze_repro import regenerated_ids  # noqa: E402

FROZEN = "834b42f97bc675a063003904e723a9d0b2fc015ecc4c956c7cd525e3cdebeaf1"


def h(ids):
    return hashlib.sha256("\n".join(sorted(ids)).encode("utf-8")).hexdigest()


def main() -> int:
    char_res, _ = regenerated_ids()
    cur = json.loads((REPO / "data/public/characters.json").read_text(encoding="utf-8"))
    frozen_ids = {c["id"] for c in cur}

    frozen_key = {}
    for c in cur:
        frozen_key[c["name"]] = c["id"]
        for a in (c.get("aliases") or []):
            frozen_key.setdefault(a, c["id"])

    # 候選名稱 → 凍結 id
    def match_by_names(names):
        hits = {frozen_key[n] for n in names if n in frozen_key}
        return hits

    stratA_unmatched = []
    stratB_unmatched = []
    for cid, rec in char_res.items():
        # A: canonical display_name
        if match_by_names({rec["display_name"]}):
            continue
        stratA_unmatched.append((cid, rec["display_name"]))

        member_names = set()
        for m in rec["members"]:
            member_names.add(m.get("name"))
            member_names.update(m.get("aliases") or [])
        if match_by_names(member_names):
            continue
        stratB_unmatched.append((cid, rec["display_name"], sorted(x for x in member_names if x)[:6]))

    print(f"provisional groups: {len(char_res)}")
    print(f"strategy A (canonical name match) unmatched: {len(stratA_unmatched)}")
    for cid, nm in sorted(stratA_unmatched, key=lambda x: x[1]):
        print(f"    {cid:18s} {nm}")
    print(f"strategy B (member name/alias match) unmatched: {len(stratB_unmatched)}")
    for cid, nm, sample in sorted(stratB_unmatched, key=lambda x: x[1]):
        print(f"    {cid:18s} {nm}   members_sample={sample}")

    for label, unmatched in (("A", stratA_unmatched), ("B", stratB_unmatched)):
        out = frozen_ids | {cid for cid, *_ in unmatched}
        print(f"strategy {label}: output ids={len(out)} hash={h(out)[:16]} match_frozen={h(out) == FROZEN}")

    # 若策略 B unmatched 為 0 → 輸出 = 凍結集
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

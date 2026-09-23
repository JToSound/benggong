#!/usr/bin/env python3
"""Gate 2 探測 2：驗證「gen(build_public_dataset) → merge_characters 決定」
可否精確重現現有 data/public/characters.json（只差 description 文案）。

全部寫入 artifacts/gate2/，唔碰 data/public 或 data/private。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import build_public_dataset as bpd  # noqa: E402

TMP = HERE / "probe_out"
TMP_PRIV = HERE / "probe_priv"
TMP.mkdir(parents=True, exist_ok=True)
TMP_PRIV.mkdir(parents=True, exist_ok=True)
bpd.OUT_DIR = TMP
bpd.PRIVATE_REVIEW = TMP_PRIV
bpd.main()

gen = json.loads((TMP / "characters.json").read_text(encoding="utf-8"))
cur = json.loads((REPO / "data/public/characters.json").read_text(encoding="utf-8"))

# --- 模擬 merge_characters：由 gen 輸出套用 decisions ---
decisions = json.loads(
    (REPO / "data/private/review/character-merge-decisions.json").read_text(encoding="utf-8")
)
by_name = {c["name"]: c for c in gen}
direct: dict[str, str] = {}
for m in decisions.get("merges", []):
    canon = by_name.get(m["into"])
    if canon is None:
        continue
    for src_name in m["from"]:
        src = by_name.get(src_name)
        if src is None or src["id"] == canon["id"]:
            continue
        direct[src["id"]] = canon["id"]
resolved: dict[str, str] = {}
for sid in direct:
    seen, cur_id = {sid}, direct[sid]
    while cur_id in direct and cur_id not in seen:
        seen.add(cur_id)
        cur_id = direct[cur_id]
    resolved[sid] = cur_id
resolved = {k: v for k, v in resolved.items() if k != v}
print(f"merge map: {len(resolved)} 個角色會被合併")

gen_by_id = {c["id"]: c for c in gen}
for sid, dst in resolved.items():
    canon = gen_by_id[dst]
    for nm in (gen_by_id[sid]["name"], *(gen_by_id[sid].get("aliases") or [])):
        if nm and nm != canon["name"] and nm not in canon["aliases"]:
            canon["aliases"].append(nm)
    canon["chapter_refs"] = sorted(
        set(canon.get("chapter_refs") or []) | set(gen_by_id[sid].get("chapter_refs") or [])
    )
merged = [c for c in gen if c["id"] not in resolved]
print(f"gen {len(gen)} → merge 後 {len(merged)}；現有 {len(cur)}")

# --- 比較（忽略 description 文案差異）---
LEGACY = "詳情待人手審閱。"


def norm(c: dict) -> dict:
    d = dict(c)
    d["description"] = d.get("description", "").replace(LEGACY, "<DESC>")
    return d


m_by_id = {c["id"]: norm(c) for c in merged}
c_by_id = {c["id"]: norm(c) for c in cur}
print(f"id 只喺 merge: {sorted(set(m_by_id) - set(c_by_id))[:6]}")
print(f"id 只喺 現有:  {sorted(set(c_by_id) - set(m_by_id))[:6]}")

diff_fields: dict[str, int] = {}
sample = None
for cid in set(m_by_id) & set(c_by_id):
    a, b = m_by_id[cid], c_by_id[cid]
    for k in set(a) | set(b):
        if a.get(k) != b.get(k):
            diff_fields[k] = diff_fields.get(k, 0) + 1
            if sample is None:
                sample = (cid, k, a.get(k), b.get(k))
print(f"共同 id 欄位差異: {diff_fields}")
if sample:
    print("樣本:", sample[0], sample[1])
    print("  merge:", str(sample[2])[:200])
    print("  現有: ", str(sample[3])[:200])
else:
    print("✅ merge 重現完全一致（除 description 文案）")

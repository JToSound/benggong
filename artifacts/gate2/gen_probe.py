#!/usr/bin/env python3
"""Gate 2 探測：將 build_public_dataset 產生嘅輸出寫入臨時目錄，
再同現有 data/public 比較，確認「現有 characters.json 係唔係由呢支腳本產生」。

唔會寫入 data/public 或 data/private（全部 monkeypatch 去 artifacts/gate2/）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import build_public_dataset as bpd  # noqa: E402

TMP = Path(__file__).resolve().parent / "probe_out"
TMP_PRIV = Path(__file__).resolve().parent / "probe_priv"
TMP.mkdir(parents=True, exist_ok=True)
TMP_PRIV.mkdir(parents=True, exist_ok=True)

# 關鍵：redirect 輸出，避免覆蓋真實 data/public 與 data/private
bpd.OUT_DIR = TMP
bpd.PRIVATE_REVIEW = TMP_PRIV

rc = bpd.main()
print(f"build_public_dataset.main() rc={rc}")

# 比較 characters.json
cur = REPO / "data/public/characters.json"
new = TMP / "characters.json"
cur_doc = json.loads(cur.read_text(encoding="utf-8"))
new_doc = json.loads(new.read_text(encoding="utf-8"))
print(f"現有 characters: {len(cur_doc)}　新產生: {len(new_doc)}")

cur_by_id = {c["id"]: c for c in cur_doc}
new_by_id = {c["id"]: c for c in new_doc}
print(f"現有 id 數: {len(cur_by_id)}　新 id 數: {len(new_by_id)}")
only_cur = sorted(set(cur_by_id) - set(new_by_id))
only_new = sorted(set(new_by_id) - set(cur_by_id))
print(f"只喺現有: {len(only_cur)} {only_cur[:5]}")
print(f"只喺新:   {len(only_new)} {only_new[:5]}")

# 逐欄比較共同 id
diff_fields: dict[str, int] = {}
for cid in set(cur_by_id) & set(new_by_id):
    a, b = cur_by_id[cid], new_by_id[cid]
    for k in set(a) | set(b):
        if a.get(k) != b.get(k):
            diff_fields[k] = diff_fields.get(k, 0) + 1
print(f"共同 id 欄位差異: {diff_fields}")

# 抽一個例子
for cid in sorted(set(cur_by_id) & set(new_by_id)):
    a, b = cur_by_id[cid], new_by_id[cid]
    if a != b:
        print("例子 id:", cid)
        print("  現有:", json.dumps(a, ensure_ascii=False)[:300])
        print("  新:  ", json.dumps(b, ensure_ascii=False)[:300])
        break

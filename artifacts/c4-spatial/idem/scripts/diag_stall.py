#!/usr/bin/env python3
"""診斷 3：檢查 ch97 段落嘅 cache 記錄同 prompt hash。"""
import json, sys, hashlib
sys.path.insert(0, 'scripts')
from extraction_core import (
    load_env, require_api_key, load_cleaned_rows,
    build_system_prompt, build_user_prompt, ExtractionCache, CACHE_DIR,
)

env = load_env()
key = require_api_key(env)
rows = load_cleaned_rows()
row97 = next((r for r in rows if r["issue_index"] == 97), None)
if row97 is None:
    print("ch97 唔存在？")
    raise SystemExit(1)

system_prompt = build_system_prompt()
user_prompt = build_user_prompt(row97)
cache_key = hashlib.sha256(
    (system_prompt + user_prompt).encode("utf-8")
).hexdigest()[:24]

print("ch97:0 prompt chars:", len(system_prompt), "+", len(user_prompt))
print("cache_key:", cache_key)
cache = ExtractionCache(run_id="diag")
hit = cache.get(cache_key)
if hit is None:
    print("cache：無記錄")
else:
    print("cache 記錄 keys:", sorted(hit.keys()))
    print("_valid:", hit.get("_valid"))
    resp = hit.get("raw_response") or hit.get("response") or ""
    print("raw_response 長度:", len(str(resp)))
    print("頭 200 字:", str(resp)[:200])

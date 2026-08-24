#!/usr/bin/env python3
"""診斷 2：直接睇模型 raw 回應，判斷 JSON malformed 嘅具體形態。

唔會將正文印出；只印回應結構特徵同頭尾少量字符。
"""

import json
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, "scripts")
from extraction_core import load_env, require_api_key, build_segments, EXTRACTION_TEMPERATURE  # noqa: E402
from extraction_prompts import EXTRACTION_SYSTEM_PROMPT, EXTRACTION_USER_TEMPLATE  # noqa: E402
from novel_lib import parse_jsonl  # noqa: E402


def main() -> int:
    rows = parse_jsonl("data/private/cleaned/bing-gang.clean.jsonl")
    ch1 = next(r for r in rows if r["issue_index"] == 1)
    segs = build_segments(1, ch1["content"])
    seg = segs[0]
    user_prompt = EXTRACTION_USER_TEMPLATE.format(
        chapter=1,
        chapter_num=ch1["chapter_num"],
        segment_index=0,
        segment_total=len(segs),
        text=seg.text,
    )

    key, base = require_api_key()
    payload = {
        "model": "stealth/ox-alpha",
        "messages": [
            {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": EXTRACTION_TEMPERATURE,
        "max_tokens": 16000,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    for attempt in range(1, 7):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.loads(r.read().decode())
            break
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:120]
            print(f"attempt {attempt}: HTTP {e.code}，等 30s 再試…")
            time.sleep(30)
    else:
        print("6 次都失敗")
        return 1
    dt = time.time() - t0

    ch = data["choices"][0]
    msg = ch["message"]
    content = msg.get("content") or ""
    usage = data.get("usage", {})
    print(f"耗時 {dt:.1f}s | finish={ch.get('finish_reason')} | completion_tokens={usage.get('completion_tokens')}")
    print(f"content 長度: {len(content)}")

    # 結構特徵
    print("頭 60 字:", repr(content[:60]))
    print("尾 60 字:", repr(content[-60:]))
    print(f"有 ``` fence: {'```' in content}")
    print(f"花括號計: {{={content.count('{')} }}={content.count('}')}")

    try:
        parsed = json.loads(content)
        cands = parsed.get("candidates", [])
        print(f"✅ 直接 parse 成功：{len(cands)} candidates")
    except json.JSONDecodeError as e:
        print(f"❌ 直接 parse 失敗：{e}")
        # 試剝 fence
        stripped = content.strip()
        for label, candidate in [
            ("剝```fence", stripped.removeprefix("```json").removeprefix("```").removesuffix("```").strip()),
            ("搵首個{到尾個}", content[content.find("{") : content.rfind("}") + 1]),
        ]:
            try:
                parsed = json.loads(candidate)
                cands = parsed.get("candidates", [])
                print(f"✅ {label} 後 parse 成功：{len(cands)} candidates")
                return 0
            except (json.JSONDecodeError, ValueError) as e2:
                print(f"❌ {label} 都失敗：{e2}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

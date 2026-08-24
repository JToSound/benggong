#!/usr/bin/env python3
"""探測 OpenRouter rate-limit 重置時間（只讀 headers，唔消耗配額）。"""

import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "scripts")
from extraction_core import require_api_key  # noqa: E402


def main() -> int:
    key, base = require_api_key()
    payload = {
        "model": "stealth/ox-alpha",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            print("HTTP", resp.status, "— 配額已恢復！")
            for h in ("X-RateLimit-Remaining", "X-RateLimit-Limit"):
                print(f"{h}: {resp.headers.get(h)}")
            return 0
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}")
        for h in ("X-RateLimit-Remaining", "X-RateLimit-Limit", "X-RateLimit-Reset"):
            v = e.headers.get(h)
            if v:
                print(f"{h}: {v}")
        body = e.read().decode("utf-8", errors="replace")[:400]
        print(body)
        return 1


if __name__ == "__main__":
    sys.exit(main())

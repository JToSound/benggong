#!/usr/bin/env python3
"""真實細請求測試：確認免費配額係咪真已恢復（1 token 請求，成本近零）。"""

import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "scripts")
from extraction_core import load_env, require_api_key  # noqa: E402


def main() -> int:
    key, base = require_api_key()
    env = load_env()
    model = env.get("OPENROUTER_EXTRACTION_MODEL", "stealth/ox-alpha")
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "回覆一個字：好"}],
        "max_tokens": 2000,
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
            content = data["choices"][0]["message"]["content"]
            print(f"✅ 配額可用！模型回應 {len(content or '')} 字符")
            return 0
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:150]
        print(f"❌ HTTP {e.code}：{body}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

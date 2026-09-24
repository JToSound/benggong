"""對比免費模型（速度 + 質素），揀最適合編年史時期判斷嘅一個。

為何要對比而唔係直接揀
====================
「免費」唔等於「可用」—— 免費模型嘅**共享額度池**會令延遲波動極大。
實測 `deepseek-v4-flash-0731:free` 單次 11.4s，但背景連續跑變成
5.5 分鐘／批（30 倍差距）。

所以要量度嘅係**連續多次呼叫嘅實際吞吐**，唔係單次延遲。
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from extraction_core import load_env, require_api_key  # noqa: E402

ROUNDS = 3
BATCH = 12

SYSTEM = (
    "你係《病港》小說嘅編年史編輯。時期只可以係："
    "pre_outbreak/outbreak/early/basecamp/lohas/endgame。只回覆 JSON。"
)


def build_user(entries: list[dict]) -> str:
    lines = [
        f"[{i}] 第{e['first_mention_chapter']}章《{e['title']}》 {e['summary'][:90]}"
        for i, e in enumerate(entries)
    ]
    return (
        "判斷每條事件嘅時期同係否回帶。\n"
        + "\n".join(lines)
        + '\n回覆 {"results":[{"index":0,"period":"basecamp","flashback":false}]}'
    )


def run(model: str, user: str, key: str, base: str) -> dict:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": 16000,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.loads(r.read())
            c = d["choices"][0]["message"].get("content") or ""
            dt = time.time() - t0
            try:
                j = json.loads(c)
                res = j.get("results") or []
                return {
                    "ok": True,
                    "dt": dt,
                    "n": len(res),
                    "periods": [x.get("period") for x in res],
                    "flash": sum(1 for x in res if x.get("flashback")),
                }
            except json.JSONDecodeError as ex:
                return {"ok": False, "dt": dt, "err": f"JSON 格式錯：{ex}"}
    except urllib.error.HTTPError as e:
        return {"ok": False, "dt": time.time() - t0, "err": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "dt": time.time() - t0, "err": f"{type(e).__name__}"}


def main() -> int:
    env = load_env(REPO)
    key, base = require_api_key()
    entries = json.loads(
        (REPO / "data" / "public" / "chronicle.json").read_text(encoding="utf-8")
    )["entries"][:BATCH]
    user = build_user(entries)

    candidates = [
        "deepseek/deepseek-v4-flash-0731:free",
        "qwen/qwen3.8-27b:free",
        "z-ai/glm-5.2:free",
    ]
    print(f"每批 {BATCH} 條，每個模型跑 {ROUNDS} 次\n")
    for m in candidates:
        times, oks, errs = [], 0, []
        for i in range(ROUNDS):
            r = run(m, user, key, base)
            if r["ok"]:
                times.append(r["dt"])
                oks += 1
                if i == 0:
                    print(f"  {m}\n    首次：{r['dt']:.1f}s 條數={r['n']}/{BATCH} "
                          f"回帶={r['flash']} 時期={r['periods'][:5]}")
            else:
                errs.append(r["err"])
            time.sleep(1)
        if times:
            avg = sum(times) / len(times)
            print(f"    → 成功 {oks}/{ROUNDS}　平均 {avg:.1f}s／批"
                  f"　估計全量 1,032 條需 {avg * (1032 / BATCH) / 60:.0f} 分鐘")
        else:
            print(f"    → ❌ 全部失敗：{errs[:2]}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

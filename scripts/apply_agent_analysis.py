#!/usr/bin/env python3
"""套用子代理嘅編年史分析結果（跨章合併 / 伏筆關係 / 時期邊界）。

為何要獨立腳本 + 嚴格驗證
=========================
子代理嘅輸出係**文字**，可能：
  - 漏答、打錯 id
  - 用咗唔存在嘅 id（幻覺）
  - 產生**循環關係**（A 伏筆 B、B 伏筆 A）
  - 一條 id 出現喺多個合併組

直接寫入會**靜默污染**資料集 —— 而且因為格式「看似」正確，好難察覺。

⚠️ 呢個腳本只做**驗證 + 報告**，唔會自動改 `chronicle.json`。
   要套用要另外經 `build_chronicle.py`（保持單一寫入路徑）。

用法：
    python scripts/apply_agent_analysis.py --kind merge <json檔案...>
    python scripts/apply_agent_analysis.py --kind foreshadow <json檔案...>
    python scripts/apply_agent_analysis.py --kind boundary <json檔案...>
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CHRONICLE = REPO / "data" / "public" / "chronicle.json"
OUT_DIR = REPO / "data" / "private" / "review"

PERIODS = {"pre_outbreak", "outbreak", "early", "basecamp", "lohas", "endgame"}


def extract_json(text: str):
    """由任意文字抽取第一個合法嘅 JSON 值（物件或陣列）。

    子代理可能加解釋文字或 markdown fence，所以唔可以 `json.loads` 直上。
    """
    text = re.sub(r"```(?:json)?", "", text)
    for open_ch, close_ch in (("[", "]"), ("{", "}")):
        start = text.find(open_ch)
        if start < 0:
            continue
        depth = 0
        for i in range(start, len(text)):
            if text[i] == open_ch:
                depth += 1
            elif text[i] == close_ch:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break
    return None


def load_entries() -> dict[str, dict]:
    return {
        e["id"]: e
        for e in json.loads(CHRONICLE.read_text(encoding="utf-8"))["entries"]
    }


def do_merge(files: list[str], entries: dict[str, dict]) -> int:
    """驗證跨章合併建議。"""
    groups: list[dict] = []
    for fn in files:
        data = extract_json(Path(fn).read_text(encoding="utf-8"))
        if isinstance(data, list):
            groups.extend(data)

    seen: dict[str, str] = {}   # id → 所屬組
    problems: list[str] = []
    ok_groups = 0
    total_ids = 0
    for g in groups:
        ids = g.get("ids") or []
        if len(ids) < 2:
            problems.append(f"組只有 {len(ids)} 條：{g.get('event')}")
            continue
        bad = [i for i in ids if i not in entries]
        if bad:
            problems.append(f"組含唔存在 id：{bad}")
            continue
        # ⚠️ 一條 id 唔可以出現喺多個組（否則合併邏輯有歧義）
        dup = [i for i in ids if i in seen]
        if dup:
            problems.append(f"id 重複出現喺多組：{dup}")
            continue
        # ⚠️ 合併組內嘅章節應該相近（相隔太遠好可能唔係同一件事）
        chs = sorted(entries[i]["first_mention_chapter"] for i in ids)
        if chs[-1] - chs[0] > 40:
            problems.append(
                f"組內章節相距太遠（ch{chs[0]}–ch{chs[-1]}）：{g.get('event')}"
            )
            continue
        for i in ids:
            seen[i] = g.get("event", "")
        ok_groups += 1
        total_ids += len(ids)

    print(f"合併組：{len(groups)} 組 → 有效 {ok_groups} 組（涉及 {total_ids} 條）")
    if problems:
        print(f"⚠️ 問題 {len(problems)} 項：")
        for p in problems[:10]:
            print(f"  - {p}")

    # ⚠️ **寫入全部建議，唔可以按當前狀態過濾**。
    #
    # 實測踩過：呢個腳本原本只寫「id 存在於當前 chronicle.json」嘅組。
    # 但 `build_chronicle.py` 係由**原始事件重建**條目（唔係增量），
    # 所以「已合併走嘅 id」喺重建後**會再出現**。
    #
    # 後果：第二次跑嘅時候，之前已套用嘅組合被當成「id 唔存在」而濾走，
    # 令合併效果**倒退**（實測 1,480 → 1,556，即少合併咗 76 條）。
    #
    # 正確做法：呢度只做**格式層面**嘅去重（同一組唔好重複），
    # 存在性檢查留返 `build_chronicle.py`（佢先係對住重建後嘅條目）。
    seen_sig: set[tuple[str, ...]] = set()
    deduped: list[dict] = []
    for g in groups:
        sig = tuple(sorted(g.get("ids") or []))
        if len(sig) < 2 or sig in seen_sig:
            continue
        seen_sig.add(sig)
        deduped.append(g)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "chronicle-merge-suggestions.json"
    out.write_text(
        json.dumps(deduped, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"寫入 {out}（{len(deduped)} 組，已去重；存在性檢查由 build_chronicle 做）")
    return 0


def do_foreshadow(files: list[str], entries: dict[str, dict]) -> int:
    """驗證伏筆關係。"""
    pairs: list[dict] = []
    for fn in files:
        data = extract_json(Path(fn).read_text(encoding="utf-8"))
        if isinstance(data, list):
            pairs.extend(data)

    valid: list[dict] = []
    problems: list[str] = []
    for p in pairs:
        a, b = p.get("foreshadows"), p.get("pays_off")
        if a not in entries or b not in entries:
            # ⚠️ 唔可以因為「當前唔存在」就丟棄 —— 跨章合併會令 id 消失，
            # 但 `build_chronicle.py` 會用**合併映射**重定向到存活嘅條目。
            # 呢度只記錄，唔過濾（否則重跑會令伏筆數量倒退）。
            problems.append(f"id 唔存在（可能已被合併）：{a} / {b}")
            continue
        if a == b:
            problems.append(f"自我指向：{a}")
            continue
        ca, cb = entries[a]["first_mention_chapter"], entries[b]["first_mention_chapter"]
        # ⚠️ 伏筆應該喺解答**之前**（或者同一章）
        if ca > cb:
            problems.append(f"伏筆章節（ch{ca}）遲過解答（ch{cb}）：{a} → {b}")
            continue
        valid.append({**p, "_ca": ca, "_cb": cb})

    # ⚠️ 循環關係：A 伏筆 B、B 伏筆 A
    edges = {(p["foreshadows"], p["pays_off"]) for p in valid}
    cycles = [(a, b) for (a, b) in edges if (b, a) in edges]

    print(f"伏筆關係：{len(pairs)} 對 → 有效 {len(valid)} 對")
    if cycles:
        print(f"⚠️ 循環關係 {len(cycles)} 對（會移除）")
    if problems:
        print(f"⚠️ 問題 {len(problems)} 項：")
        for p in problems[:10]:
            print(f"  - {p}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "chronicle-foreshadow.json"
    out.write_text(
        json.dumps(
            [{"foreshadows": p["foreshadows"], "pays_off": p["pays_off"],
              "reason": p.get("reason", "")}
             for p in valid if (p["foreshadows"], p["pays_off"]) not in cycles]
            + [{"foreshadows": p["foreshadows"], "pays_off": p["pays_off"],
                "reason": p.get("reason", "")}
               for p in pairs
               if (p.get("foreshadows") not in entries or p.get("pays_off") not in entries)],
            ensure_ascii=False, indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    print(f"寫入 {out}")
    return 0


def do_boundary(files: list[str], entries: dict[str, dict]) -> int:
    """驗證時期邊界。"""
    for fn in files:
        data = extract_json(Path(fn).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            print(f"  {fn}：唔係 JSON 物件")
            continue
        bs = data.get("boundaries") or []
        print(f"  {fn}：{len(bs)} 個時期")
        prev_to = 0
        for b in bs:
            pid, f, t = b.get("period"), b.get("from"), b.get("to")
            mark = "✓"
            if pid not in PERIODS:
                mark = "✗ 時期值唔合法"
            elif not isinstance(f, int) or not isinstance(t, int):
                mark = "✗ 範圍唔係整數"
            elif f > t:
                mark = "✗ from > to"
            elif f < prev_to:
                mark = "⚠️ 同前一個時期重疊"
            else:
                prev_to = t
            print(f"    {pid:14s} {f}–{t}  {mark}  {b.get('evidence','')[:40]}")
        if data.get("notes"):
            print(f"    備註：{data['notes'][:120]}")

        # 對照現況：每個時期實際嘅章節分佈
        print("    === 對照現時判斷 ===")
        cur: dict[str, list[int]] = defaultdict(list)
        for e in entries.values():
            if e["story_time"]["source"] == "llm_period":
                cur[e["story_time"]["label"]].append(e["first_mention_chapter"])
        for b in bs:
            label = {
                "pre_outbreak": "爆發前", "outbreak": "病毒爆發",
                "early": "爆發初期", "basecamp": "大本營時期",
                "lohas": "康城時期", "endgame": "終局",
            }.get(b.get("period"), "")
            chs = sorted(cur.get(label, []))
            if chs:
                inrange = sum(1 for c in chs if b.get("from", 0) <= c <= b.get("to", 999))
                print(f"    {label:8s} 現有 {len(chs):4d} 條，"
                      f"{inrange:4d} 條落喺建議範圍（{inrange/len(chs)*100:.0f}%）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="驗證子代理分析結果")
    ap.add_argument("--kind", required=True, choices=["merge", "foreshadow", "boundary"])
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    entries = load_entries()
    if args.kind == "merge":
        return do_merge(args.files, entries)
    if args.kind == "foreshadow":
        return do_foreshadow(args.files, entries)
    return do_boundary(args.files, entries)


if __name__ == "__main__":
    raise SystemExit(main())

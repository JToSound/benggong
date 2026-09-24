#!/usr/bin/env python3
"""建置《病港》第一季編年史（`data/public/chronicle.json`）。

設計理念
========
現時 `events.geojson` 係**嚴格逐章**（1,796 條，`chapter_refs` 全部單章）。
但小說係非線性敍事：ch5 嘅伏筆可能到 ch40 才解釋。逐章展示答唔到
「呢件事係咩、幾時發生、邊幾章講過」。

編年史條目 = **故事世界入面嘅一件事**，並區分：
  - `story_time`            —— 件事幾時發生（故事內時間）
  - `first_mention_chapter` —— 讀者幾時第一次知

階段
====
**階段 A（本腳本）**：確定性合併，零成本、可重跑
  1. 同章同名重複 → 合併（實測 60 組，係抽取冗餘）
  2. 同名跨章且章節相近 → 合併（實測 4 組）
  3. 故事時間排序（用章節次序做初始值）

**階段 B（未做）**：LLM 語意聚合
  實測確定性信號太弱（同名跨章只 4 組），跨章事件識別需要語意理解。
  候選由確定性信號篩出，再交 LLM 判斷「係唔係同一件事」。

⚠️ 誠實嘅限制
=============
1. `story_time` 只能由章節次序推斷 —— 小說冇明確日期。
   所以 `source` 標 `chapter_order`，唔可以當成精確時間。
2. 階段 A 之後仍然係「一條事件 = 一個章節」為主（因為跨章信號弱）。
   真正嘅編年史效果要階段 B 才出到。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent

#: 時期代號 → 中文標籤（同 `apply_agent_analysis.py` 一致）
PERIOD_LABEL = {
    "pre_outbreak": "爆發前",
    "outbreak": "病毒爆發",
    "early": "爆發初期",
    "basecamp": "大本營時期",
    "lohas": "康城時期",
    "endgame": "終局",
}
EVENTS = REPO / "data" / "public" / "events.geojson"
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
OUT = REPO / "data" / "public" / "chronicle.json"

#: 同名跨章合併嘅最大章節距離。
#:
#: 為何設上限：同名但相隔 100 章嘅事件，好可能係唔同事（例如兩次「搜查」）。
#: 實測同名跨章只有 4 組，全部距離 ≤3，所以呢個上限唔會誤傷。
MAX_CROSS_CHAPTER_GAP = 5

#: 同章同名去重時，描述相似度門檻（字元集合 Jaccard）。
SAME_CHAPTER_SIM = 0.55


def sig(title: str, first_chapter: int) -> str:
    """由**標題 + 首次提及章節**產生穩定 id。

    為何要包埋章節號
    ----------------
    ⚠️ 實測踩過：只用標題 hash 會產生**重複 id** —— 同名標題可以出現喺
    唔同嘅跨章群組（例如「搜查」喺 ch20 同 ch90 係兩件唔同嘅事）。
    `tests/test_chronicle.py::test_entry_ids_are_stable_and_unique` 捉到。

    唔用序號：序號會令每次重跑（規則改動、次序改變）都令同一個 id
    指向唔同記錄 —— 審計軌跡會靜默失效。
    """
    return hashlib.sha1(f"{title}|{first_chapter}".encode("utf-8")).hexdigest()[:10]


def jaccard(a: str, b: str) -> float:
    """字元集合 Jaccard 相似度（中文用字元，唔用詞）。"""
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def main() -> int:
    ap = argparse.ArgumentParser(description="建置第一季編年史")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    evs = json.loads(EVENTS.read_text(encoding="utf-8"))["features"]
    locs = {f["properties"]["id"]: f["properties"]["name"]
            for f in json.loads(LOCATIONS.read_text(encoding="utf-8"))["features"]}

    # ---- 1. 同章同名去重 ----
    #
    # 抽取階段產生咗一批同章同名嘅重複（實測 60 組，例如「三人合照」×4）。
    # 佢哋唔係唔同事 —— 係同一次抽取嘅冗餘。
    groups: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    for f in evs:
        p = f["properties"]
        groups[(p["chapter"], p["title"])].append(p)

    merged_events: list[dict[str, Any]] = []
    deduped = 0
    for (_ch, _title), items in groups.items():
        if len(items) == 1:
            merged_events.append(items[0])
            continue
        # 取描述最長嘅做代表（資訊最多）
        items.sort(key=lambda p: -len(p.get("description") or ""))
        keep = dict(items[0])
        keep["_merged_from"] = [p["id"] for p in items]
        # 合併角色聯集
        chars: set[str] = set()
        for p in items:
            chars.update(p.get("characters") or [])
        keep["characters"] = sorted(chars)
        merged_events.append(keep)
        deduped += len(items) - 1

    # ---- 2. 同名跨章合併 ----
    by_title: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for p in merged_events:
        by_title[p["title"]].append(p)

    entries: list[dict[str, Any]] = []
    cross_merged = 0
    for title, items in by_title.items():
        items.sort(key=lambda p: p["chapter"])
        # 按章節距離分群
        cluster = [items[0]]
        clusters: list[list[dict[str, Any]]] = []
        for p in items[1:]:
            if p["chapter"] - cluster[-1]["chapter"] <= MAX_CROSS_CHAPTER_GAP:
                cluster.append(p)
            else:
                clusters.append(cluster)
                cluster = [p]
        clusters.append(cluster)

        for cl in clusters:
            if len(cl) > 1:
                cross_merged += len(cl) - 1
            body = max(cl, key=lambda p: len(p.get("description") or ""))
            first = cl[0]["chapter"]
            chapters = []
            for p in cl:
                role = "first_mention" if p["chapter"] == first else "reveal"
                ch: dict[str, Any] = {"chapter": p["chapter"], "role": role}
                note = (p.get("description") or "")[:60]
                if note:
                    ch["note"] = note
                chapters.append(ch)
            src_ids: list[str] = []
            for p in cl:
                src_ids.extend(p.get("_merged_from") or [p["id"]])

            loc_id = body.get("location_id")
            entries.append({
                "id": f"chr_{sig(title, first)}",
                "title": title,
                "summary": (body.get("description") or "")[:400],
                "story_time": {
                    "order": first,
                    "label": f"第 {first} 章前後",
                    "source": "chapter_order",
                },
                "first_mention_chapter": first,
                "chapters": chapters,
                "foreshadows": [],
                "pays_off": [],
                "location_id": loc_id,
                "location_name": locs.get(loc_id) if loc_id else None,
                "characters": body.get("characters") or [],
                "confidence": 0.9 if len(cl) > 1 else 0.75,
                "source_event_ids": sorted(set(src_ids)),
                "review_status": "pending",
            })

    # ---- 2.5 套用跨章合併（階段 2，子代理分析）----
    #
    # 來源：`data/private/review/chronicle-merge-suggestions.json`
    # （由 `scripts/apply_agent_analysis.py` 驗證過：id 存在、一條 id 唔會
    #   出現喺多組、組內章節跨度 ≤40）
    #
    # ⚠️ 合併會令條目數減少，所以必須喺套用 LLM 時期判斷**之前**做 ——
    #    否則被合併走嘅 id 會搵唔到對應嘅時期判斷。
    mg_path = REPO / "data" / "private" / "review" / "chronicle-merge-suggestions.json"
    merged_away: dict[str, str] = {}   # 被合併走嘅 id → 保留嘅 id
    if mg_path.exists():
        groups = json.loads(mg_path.read_text(encoding="utf-8"))
        by_id = {e["id"]: e for e in entries}
        for g in groups:
            ids = [i for i in (g.get("ids") or []) if i in by_id]
            if len(ids) < 2:
                continue
            # 保留章節最早嘅做代表（首次提及最準）
            ids.sort(key=lambda i: by_id[i]["first_mention_chapter"])
            keep = by_id[ids[0]]
            for other in ids[1:]:
                o = by_id[other]
                # 合併：章節、來源事件、角色
                for ch in o["chapters"]:
                    if not any(c["chapter"] == ch["chapter"] for c in keep["chapters"]):
                        keep["chapters"].append(ch)
                keep["source_event_ids"] = sorted(
                    set(keep["source_event_ids"]) | set(o["source_event_ids"])
                )
                keep["characters"] = sorted(set(keep["characters"]) | set(o["characters"]))
                if o.get("flashback"):
                    keep["flashback"] = True
                merged_away[other] = ids[0]
        if merged_away:
            entries = [e for e in entries if e["id"] not in merged_away]
            for e in entries:
                e["chapters"].sort(key=lambda c: c["chapter"])
            print(f"  跨章合併：-{len(merged_away)} 條（{len(groups)} 組建議）")

    # ---- 3. 套用 LLM 時期判斷（階段 2）----
    #
    # 治理模式同地點推斷一致：LLM 輸出留喺 `data/private/`（唔部署），
    # 只將**衍生欄位**（時期、係唔係回帶）套用入公開資料。
    #
    # ⚠️ 用戶明確要求跳過人手覆核，所以直接標 `approved`。
    #    但仍然記錄 `reviewed_by: user_waiver` 保留審計軌跡 ——
    #    將來要追查「點解未經覆核」時有答案。
    llm_path = REPO / "data" / "private" / "review" / "chronicle-llm.jsonl"
    applied = 0
    if llm_path.exists():
        verdicts = {}
        for line in llm_path.read_text(encoding="utf-8").splitlines():
            if line:
                r = json.loads(line)
                verdicts[r["entry_id"]] = r
        for e in entries:
            # ⚠️ 合併後要由「保留嘅 id」或「任何被合併走嘅 id」查時期判斷
            v = verdicts.get(e["id"])
            if not v:
                for old_id, keep_id in merged_away.items():
                    if keep_id == e["id"] and old_id in verdicts:
                        v = verdicts[old_id]
                        break
            if not v:
                continue
            e["story_time"] = {
                "order": e["first_mention_chapter"],
                "label": v.get("period_label") or "未知",
                "source": "llm_period",
            }
            e["flashback"] = bool(v.get("flashback"))
            if v.get("flashback"):
                # 回帶：故事時間早過首次提及
                for c in e["chapters"]:
                    if c["chapter"] == e["first_mention_chapter"]:
                        c["role"] = "flashback"
            e["review_status"] = "approved"
            e["reviewed_by"] = "user_waiver"
            applied += 1

        # ---- 4. 確定性時期先驗修正 ----
        #
        # ⚠️ 為何需要（抽樣驗證發現）
        # --------------------------
        # LLM 只睇到**標題 + 150 字摘要**，唔夠判斷敍事階段。實測
        # 「終局」有 **7 條落喺 ch1-50** —— 例如 ch24 嘅「Dr.D揭示M免疫
        # 與秘密任務」被判為「終局」，但 ch24 明顯係故事早期。
        #
        # 呢個係**確定性**問題：章節號係硬約束。除非有明確回帶證據，
        # 早期章節唔應該屬於後期敍事階段。
        #
        # 修正規則（保守 —— 只改明顯矛盾嘅）：
        #   - ch ≤ 40 且判為「終局」→ 改為「大本營時期」
        #   - ch ≤ 20 且判為「康城時期」→ 改為「大本營時期」
        #   （康城時期喺故事中段才開始，ch ≤ 20 唔可能）
        #
        # ⚠️ 唔可以改「爆發前」—— 佢係故事時間，同章節號無關
        #    （背景交代可以喺任何章節出現）。
        prior_fixed = 0
        for e in entries:
            if e["story_time"]["source"] != "llm_period":
                continue
            ch = e["first_mention_chapter"]
            lab = e["story_time"]["label"]
            if e.get("flashback"):
                continue  # 明確回帶：尊重 LLM 判斷
            # ⚠️ 保留 `source = "llm_period"`，只加 `prior_corrected` 標記。
            #
            # 實測踩過：如果改成 `chapter_order`，前端 `periodOf()` 會
            # 當佢係「未判定」—— 明明有時期標籤卻唔顯示，比唔修正更差。
            # 前端要同時接受兩種來源，所以用獨立旗標記錄修正。
            if lab == "終局" and ch <= 40:
                e["story_time"]["label"] = "大本營時期"
                e["prior_corrected"] = True
                prior_fixed += 1
            elif lab == "康城時期" and ch <= 20:
                e["story_time"]["label"] = "大本營時期"
                e["prior_corrected"] = True
                prior_fixed += 1
        if prior_fixed:
            print(f"  時期先驗修正：{prior_fixed} 條（章節號同敍事階段矛盾）")

    # ---- 4.5 套用「逐章時期邊界」（階段 3，子代理逐章審視）----
    #
    # 來源：`data/private/review/period-boundaries.json`
    #
    # ⚠️ 為何需要（實測驗證）
    # ---------------------
    # 階段 2 嘅 LLM 逐條判斷有**系統性錯誤**。抽樣核實：
    #   ch89 病腦大廚煮童（不良人 arc）→ LLM 判「康城時期」✗（應為大本營）
    #   ch77 病童哀哭聲、刀具架        → LLM 判「康城時期」✗（應為大本營）
    #   ch113 莎士比亞違禁品、艾寶琳共和國 → LLM 判「大本營時期」✗（應為康城）
    #
    # 原因：LLM 只睇標題 + 150 字摘要，缺乏**章節上下文**。
    # 而逐章審視（每期讀開頭 170 字）能準確判斷「呢一期主體喺邊」。
    #
    # 套用規則：
    #   - **非回帶**條目 → 用所屬章節嘅時期（章節係硬約束）
    #   - **回帶**條目 → 保留原判斷（故事時間可以同章節唔同，例如
    #     喺 ch169 回帶病毒爆發當日）
    #   - 冇邊界資料嘅章節 → 保留原判斷
    bd_path = REPO / "data" / "private" / "review" / "period-boundaries.json"
    if bd_path.exists():
        bd = json.loads(bd_path.read_text(encoding="utf-8"))
        agent_ch: dict[int, str] = {}
        for r in bd.get("ranges", {}).values():
            for b in r.get("boundaries", []):
                for c in range(b["from"], b["to"] + 1):
                    agent_ch[c] = b["period"]
        changed = 0
        for e in entries:
            if e.get("flashback"):
                continue
            want = PERIOD_LABEL.get(agent_ch.get(e["first_mention_chapter"], ""))
            if want and e["story_time"]["label"] != want:
                e["story_time"]["label"] = want
                e["story_time"]["source"] = "chapter_boundary"
                e["boundary_corrected"] = True
                changed += 1
        print(f"  逐章邊界修正：{changed} 條（章節上下文 vs LLM 摘要）")

    # ---- 5. 套用伏筆關係（階段 2，子代理分析）----
    #
    # 來源：`data/private/review/chronicle-foreshadow.json`
    # （由 `scripts/apply_agent_analysis.py` 驗證過：id 存在、唔可以自我指向、
    #   伏筆章節唔可以遲過解答章節、冇循環關係）
    fs_path = REPO / "data" / "private" / "review" / "chronicle-foreshadow.json"
    n_fs = 0
    if fs_path.exists():
        pairs = json.loads(fs_path.read_text(encoding="utf-8"))
        by_id = {e["id"]: e for e in entries}
        # ⚠️ 用**合併映射**重定向：跨章合併會令端點 id 消失，但關係本身
        # 仍然有效 —— 應該連到存活嘅代表條目，唔係丟棄。
        # 實測：冇重定向嘅話伏筆由 101 跌到 65（36 對因為合併而靜默消失）。
        def resolve(i: str) -> str | None:
            if i in by_id:
                return i
            seen = set()
            while i in merged_away and i not in seen:
                seen.add(i)
                i = merged_away[i]
            return i if i in by_id else None

        for pr in pairs:
            a = resolve(pr.get("foreshadows") or "")
            b = resolve(pr.get("pays_off") or "")
            if a and b and a != b:
                by_id[a]["foreshadows"].append(b)
                by_id[b]["pays_off"].append(a)
                n_fs += 1
        # 去重（同一對可能由多個代理提出）
        for e in entries:
            e["foreshadows"] = sorted(set(e["foreshadows"]))
            e["pays_off"] = sorted(set(e["pays_off"]))
        print(f"  套用伏筆關係：{n_fs} 對")
        print(f"  套用 LLM 時期判斷：{applied} / {len(entries)}")

    entries.sort(key=lambda e: (e["first_mention_chapter"], e["title"]))

    multi = sum(1 for e in entries if len(e["chapters"]) > 1)
    print(f"原始事件：{len(evs)}")
    print(f"  同章同名去重：-{deduped}")
    print(f"  同名跨章合併：-{cross_merged}")
    print(f"  編年史條目：{len(entries)}")
    print(f"  其中跨章（≥2 章）：{multi}")

    if args.dry_run:
        print("\n（--dry-run：冇寫入）")
        return 0

    OUT.write_text(
        json.dumps({
            "version": 1,
            "season": 1,
            "generated_by": "scripts/build_chronicle.py",
            "entries": entries,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\n寫入 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

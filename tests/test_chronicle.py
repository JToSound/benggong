"""編年史資料集測試。

為何要測
========
編年史係「跨章聚合」嘅新資料集 —— 佢將逐章事件合併成「故事世界嘅事」。
一旦合併邏輯出錯（例如合併咗唔同事、或者章節角色標錯），用戶會見到
**錯誤嘅故事時序**，比單純缺少資料更危險。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CHR = REPO / "data" / "public" / "chronicle.json"
EVENTS = REPO / "data" / "public" / "events.geojson"


def load() -> dict:
    return json.loads(CHR.read_text(encoding="utf-8"))


def test_chronicle_exists_and_shaped() -> None:
    doc = load()
    assert doc["version"] == 1
    assert doc["season"] == 1
    assert doc["entries"], "編年史唔可以係空"


def test_entry_ids_are_stable_and_unique() -> None:
    """id 必須唯一，而且係由標題衍生（唔可以係序號）。

    為何：序號會令每次重跑（規則改動、次序改變）都令同一個 id 指向
    唔同記錄 —— 審計軌跡會靜默失效。
    """
    entries = load()["entries"]
    ids = [e["id"] for e in entries]
    assert len(ids) == len(set(ids)), "有重複 id"
    for i in ids:
        assert re.match(r"^chr_[0-9a-f]{10}$", i), f"id 格式唔對：{i}"


def test_every_entry_has_valid_chapters() -> None:
    for e in load()["entries"]:
        assert e["chapters"], f"{e['title']} 冇章節參照"
        for c in e["chapters"]:
            assert 1 <= c["chapter"] <= 210, f"{e['title']} 章節號越界：{c['chapter']}"
            assert c["role"] in ("first_mention", "reveal", "flashback")


def test_first_mention_is_earliest_chapter() -> None:
    """`first_mention_chapter` 必須係最細嘅章節號。

    否則「首次提及」嘅語意就錯 —— 用戶會以為件事喺後期才出現。
    """
    for e in load()["entries"]:
        chs = [c["chapter"] for c in e["chapters"]]
        assert e["first_mention_chapter"] == min(chs), (
            f"{e['title']}：first_mention_chapter={e['first_mention_chapter']} "
            f"但最細章節係 {min(chs)}"
        )


def test_source_events_exist() -> None:
    """`source_event_ids` 必須全部指向真實存在嘅事件（可追溯）。"""
    ev_ids = {
        f["properties"]["id"]
        for f in json.loads(EVENTS.read_text(encoding="utf-8"))["features"]
    }
    missing = []
    for e in load()["entries"]:
        for sid in e["source_event_ids"]:
            if sid not in ev_ids:
                missing.append((e["title"], sid))
    assert not missing, f"{len(missing)} 個來源事件唔存在：{missing[:3]}"


def test_no_duplicate_source_events_across_entries() -> None:
    """一個原始事件唔應該出現喺多過一條編年史條目。

    否則代表合併邏輯有漏洞（同一件事被拆成兩條）。
    """
    seen: dict[str, str] = {}
    dupes = []
    for e in load()["entries"]:
        for sid in e["source_event_ids"]:
            if sid in seen:
                dupes.append((sid, seen[sid], e["title"]))
            seen[sid] = e["title"]
    assert not dupes, f"{len(dupes)} 個事件被重複使用：{dupes[:3]}"


def test_flashback_entries_marked_in_chapters() -> None:
    """標咗 `flashback` 嘅條目，其首次提及章節嘅 role 亦要係 flashback。

    否則 UI 顯示會唔一致（卡片話回帶，但章節標籤話首次提及）。
    """
    for e in load()["entries"]:
        if not e.get("flashback"):
            continue
        first = next(
            (c for c in e["chapters"] if c["chapter"] == e["first_mention_chapter"]),
            None,
        )
        assert first is not None
        assert first["role"] == "flashback", (
            f"{e['title']} 標咗回帶，但 ch{first['chapter']} 嘅 role 係 {first['role']}"
        )


def test_review_status_and_provenance() -> None:
    """每個條目都要有 review_status；經 LLM 判斷嘅要有 reviewed_by。"""
    for e in load()["entries"]:
        assert e["review_status"] in ("pending", "approved", "rejected")
        if e["story_time"]["source"] == "llm_period":
            assert e.get("reviewed_by"), (
                f"{e['title']} 用咗 LLM 判斷但冇 reviewed_by —— 審計軌跡唔完整"
            )

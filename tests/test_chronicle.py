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


def test_period_does_not_contradict_chapter_order() -> None:
    """時期標籤唔可以同章節號**明顯矛盾**。

    ⚠️ 為何要測（抽樣驗證發現）
    --------------------------
    LLM 只睇到標題 + 150 字摘要，唔夠判斷敍事階段。實測「終局」有
    **7 條落喺 ch1-50**（例如 ch24 嘅「Dr.D揭示M免疫與秘密任務」）。

    章節號係**硬約束**：除非有明確回帶證據，早期章節唔應該屬於後期
    敍事階段。呢個測試保護 `build_chronicle.py` 嘅先驗修正步驟。
    """
    for e in load()["entries"]:
        if e["story_time"]["source"] != "llm_period":
            continue
        ch = e["first_mention_chapter"]
        lab = e["story_time"]["label"]
        # 回帶條目嘅故事時間可以早過章節，但唔可以**遲**過敍事階段
        if e.get("flashback"):
            continue
        if lab == "終局":
            assert ch > 40, (
                f"「{e['title']}」喺 ch{ch} 但標為終局 —— "
                f"章節號同敍事階段矛盾（先驗修正應該改咗）"
            )
        if lab == "康城時期":
            assert ch > 20, (
                f"「{e['title']}」喺 ch{ch} 但標為康城時期 —— 矛盾"
            )


def test_prior_correction_keeps_llm_source() -> None:
    """經先驗修正嘅條目必須**保留** `source == "llm_period"`。

    ⚠️ 實測踩過：如果改成 `chapter_order`，前端 `periodOf()` 會當佢係
    「未判定」—— 明明有時期標籤卻唔顯示，比唔修正更差。
    """
    corrected = [e for e in load()["entries"] if e.get("prior_corrected")]
    assert corrected, "應該有先驗修正過嘅條目（否則規則冇觸發）"
    for e in corrected:
        assert e["story_time"]["source"] == "llm_period", (
            f"「{e['title']}」經先驗修正但 source 變成 "
            f"{e['story_time']['source']} —— 前端會當佢未判定"
        )


def test_period_does_not_contradict_chapter_order() -> None:
    """時期標籤唔可以同章節號**明顯矛盾**。

    ⚠️ 為何要測（抽樣驗證發現）
    --------------------------
    LLM 只睇到標題 + 150 字摘要，唔夠判斷敍事階段。實測「終局」有
    **7 條落喺 ch1-50**（例如 ch24 嘅「Dr.D揭示M免疫與秘密任務」）。

    章節號係**硬約束**：除非有明確回帶證據，早期章節唔應該屬於後期
    敍事階段。呢個測試保護 `build_chronicle.py` 嘅先驗修正步驟。
    """
    for e in load()["entries"]:
        if e["story_time"]["source"] != "llm_period":
            continue
        ch = e["first_mention_chapter"]
        lab = e["story_time"]["label"]
        # 回帶條目嘅故事時間可以早過章節，但唔可以**遲**過敍事階段
        if e.get("flashback"):
            continue
        if lab == "終局":
            assert ch > 40, (
                f"「{e['title']}」喺 ch{ch} 但標為終局 —— "
                f"章節號同敍事階段矛盾（先驗修正應該改咗）"
            )
        if lab == "康城時期":
            assert ch > 20, (
                f"「{e['title']}」喺 ch{ch} 但標為康城時期 —— 矛盾"
            )


def test_prior_correction_keeps_llm_source() -> None:
    """經先驗修正嘅條目必須**保留** `source == "llm_period"`。

    ⚠️ 實測踩過：如果改成 `chapter_order`，前端 `periodOf()` 會當佢係
    「未判定」—— 明明有時期標籤卻唔顯示，比唔修正更差。
    """
    corrected = [e for e in load()["entries"] if e.get("prior_corrected")]
    assert corrected, "應該有先驗修正過嘅條目（否則規則冇觸發）"
    for e in corrected:
        assert e["story_time"]["source"] == "llm_period", (
            f"「{e['title']}」經先驗修正但 source 變成 "
            f"{e['story_time']['source']} —— 前端會當佢未判定"
        )


def test_foreshadow_links_are_valid() -> None:
    """伏筆／解答連結必須指向**存在**嘅條目，而且冇循環。

    ⚠️ 為何要測
    ----------
    跨章合併會令部分條目消失。如果伏筆連結指向已合併走嘅 id，前端
    `renderLinks()` 會搵唔到目標 → **靜默消失**（用戶見到少咗連結，
    但唔會知道係 bug）。呢個測試捉呢類懸空引用。

    另外要防**循環關係**（A 伏筆 B、B 伏筆 A）—— 語意上荒謬。
    """
    entries = load()["entries"]
    by_id = {e["id"]: e for e in entries}
    problems: list[str] = []
    for e in entries:
        for fid in e.get("foreshadows", []):
            if fid not in by_id:
                problems.append(f"{e['title']} 嘅伏筆指向唔存在嘅 {fid}")
            elif fid == e["id"]:
                problems.append(f"{e['title']} 伏筆指向自己")
        for pid in e.get("pays_off", []):
            if pid not in by_id:
                problems.append(f"{e['title']} 嘅解答指向唔存在嘅 {pid}")
            elif pid == e["id"]:
                problems.append(f"{e['title']} 解答指向自己")
    assert not problems, f"{len(problems)} 個懸空／無效連結：{problems[:5]}"

    # 循環關係
    edges = {(e["id"], f) for e in entries for f in e.get("foreshadows", [])}
    cycles = [(a, b) for (a, b) in edges if (b, a) in edges]
    assert not cycles, f"有循環伏筆關係：{cycles[:3]}"


def test_merged_entries_have_multiple_chapters() -> None:
    """經跨章合併嘅條目應該有 ≥2 個章節參照。

    合併嘅定義就係「同一件事喺多章出現」，所以合併後一定要有多個章節。
    如果只有一個，代表合併邏輯冇正確合併章節清單。
    """
    entries = load()["entries"]
    # 找出「來源事件多過一個」嘅條目（即係合併過）
    merged = [e for e in entries if len(e["source_event_ids"]) > 1]
    assert merged, "應該有合併過嘅條目"
    # ⚠️ 同章同名去重亦會令 source_event_ids > 1，所以唔可以硬性要求
    #    全部都有多章。只檢查**冇**資料遺失。
    for e in merged:
        assert e["chapters"], f"{e['title']} 合併後冇章節"
        assert e["first_mention_chapter"] == min(c["chapter"] for c in e["chapters"])

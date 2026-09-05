"""《病港》Phase B — 公開資料 schema 與治理測試。

涵蓋：
- data/schemas/*.json 本身係有效 JSON Schema
- provisional sample dataset 全部通過對應 schema
- 治理規則：長 CJK run、雜訊、secret pattern 偵測
- 引用一致性（location_id / event_id）
- extraction run ledger / candidate schema 結構
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

REPO = Path(__file__).resolve().parent.parent
SCHEMAS = REPO / "data/schemas"
PUBLIC = REPO / "data/public"
PRIVATE_REVIEW = REPO / "data/private/review"

sys.path.insert(0, str(REPO / "scripts"))
from validate_public_data import FORBIDDEN_PATTERNS, LONG_CJK_RUN, check_text_governance  # noqa: E402


def load(p: Path):
    return json.loads(open(p, encoding="utf-8").read())


# ---- schemas 本身有效 ----


@pytest.mark.parametrize(
    "name",
    [
        "event.schema.json",
        "location.schema.json",
        "route.schema.json",
        "timeline.schema.json",
        "character.schema.json",
        "evidence-candidate.schema.json",
        "extraction-run.schema.json",
    ],
)
def test_schema_files_are_valid(name):
    schema = load(SCHEMAS / name)
    Draft202012Validator.check_schema(schema)


@pytest.mark.parametrize(
    "schema_name,data_name,is_fc",
    [
        ("location.schema.json", "locations.geojson", True),
        ("event.schema.json", "events.geojson", True),
        ("route.schema.json", "routes.geojson", True),
        ("timeline.schema.json", "timeline.json", False),
        ("character.schema.json", "characters.json", False),
    ],
)
def test_public_data_validates(schema_name, data_name, is_fc):
    validator = Draft202012Validator(load(SCHEMAS / schema_name))
    doc = load(PUBLIC / data_name)
    items = doc["features"] if is_fc else doc
    for i, item in enumerate(items):
        errors = list(validator.iter_errors(item))
        assert not errors, f"{data_name}[{i}]: {[e.message for e in errors]}"


# ---- 治理規則單元測試 ----


class TestGovernance:
    def test_long_cjk_run_detected(self):
        bad = (
            "這是一段非常長嘅連續中文文本沒有任何標點或者空白中斷就這樣一直延續下去"
            "超過一百個字符以上肯定會被偵測到因為它就是小說原文段落不應該出現在公開資料裡面"
            "繼續延續延續再延續直到超過門檻為止還要再多寫幾十個字符確保長度足夠觸發規則"
        )
        assert len(bad) > 100
        errs = check_text_governance({"description": bad}, "t")
        assert any("小說文本" in e for e in errs)

    def test_short_summary_allowed(self):
        ok = "主角到達大本營，見識倖存者生活。"
        assert check_text_governance({"description": ok}, "t") == []

    def test_penana_noise_detected(self):
        for s in ("No Plagiarism!abc", "1234 copyright protection5", "ＰＥＮＡＮＡxyz"):
            hits = [n for n, p in FORBIDDEN_PATTERNS.items() if p.search(s)]
            assert hits, s

    def test_secret_pattern_detected(self):
        hits = [n for n, p in FORBIDDEN_PATTERNS.items() if p.search("sk-abc12345678901234567890")]
        assert "ip_or_secret" in hits

    def test_ip_in_public_detected(self):
        errs = check_text_governance({"note": "伺服器 192.168.1.1 記錄"}, "t")
        assert any("禁止內容" in e for e in errs)


# ---- 引用一致性 ----


def test_event_location_refs_resolve():
    """location_id 只可以係存在嘅 location 或 null（未指派）；空字串/懸空引用都係 fail。"""
    loc_ids = {f["properties"]["id"] for f in load(PUBLIC / "locations.geojson")["features"]}
    for f in load(PUBLIC / "events.geojson")["features"]:
        lid = f["properties"]["location_id"]
        if lid is not None:
            assert lid in loc_ids, f"event {f['properties']['id']} 引用唔存在嘅 location '{lid}'"


def test_route_waypoints_resolve():
    loc_ids = {f["properties"]["id"] for f in load(PUBLIC / "locations.geojson")["features"]}
    for f in load(PUBLIC / "routes.geojson")["features"]:
        for wp in f["properties"]["waypoints"]:
            assert wp["location_id"] in loc_ids


def test_timeline_event_links_resolve():
    ev_ids = {f["properties"]["id"] for f in load(PUBLIC / "events.geojson")["features"]}
    for rec in load(PUBLIC / "timeline.json"):
        if rec.get("event_id"):
            assert rec["event_id"] in ev_ids


# ---- provisional gate ----
# 0903 Phase C：provisional mode 改為可選，conf ≥ 0.7 嘅記錄已通過人手 alias override 批閱
# conf < 0.7 仍標 needs_review，要求 banner
def test_provisional_gate_low_confidence_with_banner():
    """conf < 0.7 嘅 needs_review 記錄仍受 provisional gate 保護：必須有 banner。"""
    mc = load(PUBLIC / "map-config.json")
    has_banner = bool(mc.get("provisional_mode", {}).get("banner"))
    # 兩種合法狀態：
    # A) provisional 仍開：一定要有 banner
    # B) provisional 已關：conf < 0.7 嘅記錄唔應該出現喺公開 dataset
    docs = [
        load(PUBLIC / "locations.geojson"),
        load(PUBLIC / "events.geojson"),
        load(PUBLIC / "routes.geojson"),
    ]
    char_doc = load(PUBLIC / "characters.json")
    low_conf_needs_review = 0
    for doc in docs:
        for f in doc.get("features", []):
            if (f.get("properties", {}).get("review_status") == "needs_review"
                and (f.get("properties", {}).get("confidence") or 0) < 0.7):
                low_conf_needs_review += 1
    for c in char_doc:
        if (c.get("review_status") == "needs_review"
            and (c.get("confidence") or 0) < 0.7):
            low_conf_needs_review += 1
    if low_conf_needs_review > 0:
        # 仲有低 conf 未批：provisional 必須開
        assert mc["provisional_mode"]["enabled"] is True, (
            f"有 {low_conf_needs_review} 條 low-conf needs_review 但 provisional_mode 已關"
        )
        assert has_banner, "有 low-conf needs_review 但缺少 banner"


def test_manifest_counts_match():
    mf = load(PUBLIC / "asset-manifest.json")
    counts = {
        "location": len(load(PUBLIC / "locations.geojson")["features"]),
        "event": len(load(PUBLIC / "events.geojson")["features"]),
        "route": len(load(PUBLIC / "routes.geojson")["features"]),
        "timeline": len(load(PUBLIC / "timeline.json")),
        "character": len(load(PUBLIC / "characters.json")),
        "chapter_summary": len(load(PUBLIC / "chapter-summaries.json")),
    }
    assert mf["counts"] == counts


# ---- 私有 schema 結構（用合成樣本驗證，唔需要真 LLM run）----


def test_extraction_run_ledger_sample():
    validator = Draft202012Validator(load(SCHEMAS / "extraction-run.schema.json"))
    record = {
        "run_id": "r_001",
        "timestamp": "2026-08-24T00:00:00Z",
        "model_id": "test/model",
        "temperature": 0.1,
        "prompt_hash": "a" * 64,
        "schema_version": "1.0.0",
        "chapter": 1,
        "attempt": 1,
        "status": "ok",
    }
    assert not list(validator.iter_errors(record))


def test_evidence_candidate_sample_and_private_guard():
    schema = load(SCHEMAS / "evidence-candidate.schema.json")
    validator = Draft202012Validator(schema)
    cand = {
        "candidate_id": "c_0001",
        "run_id": "r_001",
        "chapter": 3,
        "entity_kind": "location",
        "name": "大本營",
        "evidence_excerpt": "大本營入面圖書館光線充足。（私有摘錄）",
        "claim": "大本營設有圖書館。",
        "confidence": 0.8,
        "model_meta": {
            "model_id": "test/model",
            "temperature": 0.1,
            "prompt_hash": "b" * 64,
            "schema_version": "1.0.0",
        },
    }
    assert not list(validator.iter_errors(cand))

    # 治理：candidate 唔可以出現喺任何 data/public 檔案
    pub_text = "".join(
        open(p, encoding="utf-8").read() for p in PUBLIC.glob("*.json*")
    )
    assert "evidence_excerpt" not in pub_text


# ---- Phase E: structured chapter summaries + alias override + event coords ----


def test_chapter_summaries_schema_is_valid():
    """Phase E: chapter-summaries.schema.json 必須係有效 JSON Schema。"""
    schema = load(SCHEMAS / "chapter-summaries.schema.json")
    Draft202012Validator.check_schema(schema)


def test_chapter_summaries_structure():
    """Phase E: chapter-summaries.json 結構應為 {chapter: {locations: [...]}}。"""
    data = load(PUBLIC / "chapter-summaries.json")
    assert isinstance(data, dict), "chapter-summaries.json top-level 必須係 object"
    assert len(data) > 100, f"應有 ≥100 chapters, got {len(data)}"

    # 抽 chapter 1 驗證結構
    ch1 = data.get("1")
    assert ch1 is not None, "必須有 chapter 1"
    assert "locations" in ch1, "chapter 1 必須有 locations 字段"
    assert isinstance(ch1["locations"], list)
    assert len(ch1["locations"]) > 0, "chapter 1 至少要有 1 個 location"

    # 每個 location entry 必須有 id, name, summary, confidence
    for entry in ch1["locations"]:
        assert "id" in entry
        assert "name" in entry
        assert "summary" in entry
        assert "confidence" in entry
        assert 0 <= entry["confidence"] <= 1, f"confidence 必須 0-1: {entry['confidence']}"
        assert entry["id"].startswith("loc_"), f"id 必須係 loc_ 開頭: {entry['id']}"
        assert len(entry["summary"]) <= 200, f"summary 過長: {len(entry['summary'])}"


def test_chapter_summaries_validate_against_schema():
    """Phase E: chapter-summaries.json 全部 chapters 必須通過 schema validation。"""
    schema = load(SCHEMAS / "chapter-summaries.schema.json")
    validator = Draft202012Validator(schema)
    data = load(PUBLIC / "chapter-summaries.json")

    for ch_key, ch_val in data.items():
        # 將 chapter 整體包成 {ch_key: ch_val} 嚟 match additionalProperties
        wrapped = {ch_key: ch_val}
        errors = list(validator.iter_errors(wrapped))
        assert not errors, f"chapter-summaries[{ch_key}]: {[e.message for e in errors][:1]}"


def test_event_coords_match_location():
    """Phase E 修：event.geometry.coordinates 必須同 location_id 對應嘅 location 一致。
    之前嘅 bug：38% events 冇 location_id，仲有 3 個有 loc_id 但 coords 錯。"""
    locs = {f["properties"]["id"]: f for f in load(PUBLIC / "locations.geojson")["features"]}
    mismatch = []
    for ev in load(PUBLIC / "events.geojson")["features"]:
        lid = ev["properties"].get("location_id")
        if lid and lid in locs:
            loc_coords = locs[lid]["geometry"]["coordinates"]
            ev_coords = ev["geometry"]["coordinates"]
            if abs(loc_coords[0] - ev_coords[0]) > 0.0001 or abs(loc_coords[1] - ev_coords[1]) > 0.0001:
                mismatch.append((ev["properties"]["id"], lid, ev_coords, loc_coords))
    assert not mismatch, f"Phase E bug 復活：{len(mismatch)} 個 events coords 唔 match: {mismatch[:3]}"


def test_routes_no_alias_collisions():
    """Phase E 修：routes.character_name 唔應該再出現「老師」、「鳥嘴」、「我（敘事者）」等
    應該 merge 入 主角 嘅 alias 記錄。"""
    routes = load(PUBLIC / "routes.geojson")["features"]
    for r in routes:
        name = r["properties"]["character_name"]
        assert name != "老師", f"Phase E bug: '老師' 應該 merge 入 主角: {r['properties']['id']}"
        assert name != "鳥嘴", f"Phase E bug: '鳥嘴' 應該 merge 入 主角: {r['properties']['id']}"
        assert name != "我（敘事者）", f"Phase E bug: '我（敘事者）' 應該 merge 入 主角: {r['properties']['id']}"


def test_event_location_id_coverage():
    """Phase E: events 至少 95% 應該有 location_id。"""
    events = load(PUBLIC / "events.geojson")["features"]
    with_loc = sum(1 for e in events if e["properties"].get("location_id"))
    ratio = with_loc / len(events)
    assert ratio >= 0.95, f"events with location_id 應 ≥ 95% (currently {ratio*100:.1f}%)"

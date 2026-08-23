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
    loc_ids = {f["properties"]["id"] for f in load(PUBLIC / "locations.geojson")["features"]}
    for f in load(PUBLIC / "events.geojson")["features"]:
        assert f["properties"]["location_id"] in loc_ids


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


def test_provisional_mode_all_needs_review_with_banner():
    mc = load(PUBLIC / "map-config.json")
    assert mc["provisional_mode"]["enabled"] is True
    assert mc["provisional_mode"]["banner"]
    docs = [
        load(PUBLIC / "locations.geojson"),
        load(PUBLIC / "events.geojson"),
        load(PUBLIC / "routes.geojson"),
    ]
    for doc in docs:
        for f in doc["features"]:
            assert f["properties"]["review_status"] == "needs_review"


def test_manifest_counts_match():
    mf = load(PUBLIC / "asset-manifest.json")
    counts = {
        "location": len(load(PUBLIC / "locations.geojson")["features"]),
        "event": len(load(PUBLIC / "events.geojson")["features"]),
        "route": len(load(PUBLIC / "routes.geojson")["features"]),
        "timeline": len(load(PUBLIC / "timeline.json")),
        "character": len(load(PUBLIC / "characters.json")),
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

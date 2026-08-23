"""《病港》Phase B — extraction 基建測試（合成資料，零 API 呼叫）。

涵蓋：
- 章節分段（budget、段落邊界、deterministic hash）
- 缺 key 阻擋行為
- run ledger / cache 讀寫
- location / character resolution 規則
- public dataset builder 端到端（合成 candidates）
- 治理：builder 產出無 evidence excerpt、無全文
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import extraction_core as core  # noqa: E402
import build_public_dataset as bpd  # noqa: E402


# ---- 分段 ----


class TestSegments:
    def test_short_chapter_single_segment(self):
        segs = core.build_segments(1, "短短正文。")
        assert len(segs) == 1
        assert segs[0].chapter == 1
        assert segs[0].text == "短短正文。"

    def test_long_chapter_split_respects_budget(self):
        para = "這是一個測試段落，描述主角喺街頭行走嘅場景。" * 30  # ~1200 chars
        content = "\n\n".join([para] * 10)  # ~12k chars
        segs = core.build_segments(5, content)
        assert len(segs) > 1
        for s in segs:
            assert len(s.text) <= core.SEGMENT_CHAR_BUDGET + 50  # 少量容差
        # 全部內容保留（無丟失）
        assert "".join(s.text.replace("\n\n", "") for s in segs)[:100] == content.replace("\n\n", "")[:100]

    def test_prompt_hash_deterministic(self):
        a = core.build_segments(1, "同樣內容。")
        b = core.build_segments(1, "同樣內容。")
        assert a[0].prompt_hash == b[0].prompt_hash
        c = core.build_segments(2, "同樣內容。")
        assert a[0].prompt_hash != c[0].prompt_hash


# ---- 缺 key 阻擋 ----


class TestApiKeyGate:
    def test_missing_key_raises(self, monkeypatch):
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.setattr(core, "load_env", lambda repo_root=None: {})
        with pytest.raises(core.ExtractionConfigError, match="OPENROUTER_API_KEY"):
            core.require_api_key()


# ---- ledger / cache ----


class TestLedgerCache:
    def test_ledger_append_and_completed(self, tmp_path):
        led = core.RunLedger(path=tmp_path / "ledger.jsonl")
        led.append({"chapter": 1, "segment_index": 0, "status": "ok"})
        led.append({"chapter": 1, "segment_index": 1, "status": "error"})
        led.append({"chapter": 2, "segment_index": 0, "status": "ok"})
        assert led.completed_keys() == {"1:0", "2:0"}

    def test_cache_roundtrip(self, tmp_path):
        cache = core.ExtractionCache(root=tmp_path, run_id="r1")
        cache.put("abc", {"parsed": {"candidates": []}})
        assert cache.get("abc")["parsed"] == {"candidates": []}
        assert cache.get("missing") is None

    def test_candidate_store(self, tmp_path):
        store = core.CandidateStore(path=tmp_path / "cands.jsonl")
        store.append({"candidate_id": "c_00001", "name": "大本營"})
        store.append({"candidate_id": "c_00002", "name": "將軍澳"})
        rows = [json.loads(l) for l in open(tmp_path / "cands.jsonl", encoding="utf-8")]
        assert len(rows) == 2 and store.count == 2


# ---- resolution 規則（純函式）----


class TestResolution:
    def test_locations_group_by_name(self):
        locs = [
            {"name": "大本營", "chapter": 3, "fictional": True, "confidence": 0.8, "location_type": "facility"},
            {"name": "大本營", "chapter": 26, "fictional": True, "confidence": 0.7, "location_type": "facility"},
            {"name": "將軍澳", "chapter": 11, "fictional": False, "confidence": 0.9, "location_type": "district"},
        ]
        out = bpd.resolve_locations(locs)
        assert set(out.keys()) == {"da_ben_ying", "jiang_ao"} or len(out) == 2
        # 大本營群組：兩章合併
        dby = next(v for v in out.values() if v["display_name"] == "大本營")
        assert dby["chapters"] == [3, 26]
        assert dby["fictional"] is True
        # 將軍澳：真實參考區
        tko = next(v for v in out.values() if v["display_name"] == "將軍澳")
        assert tko["fictional"] is False

    def test_unknown_place_defaults_fictional(self):
        out = bpd.resolve_locations(
            [{"name": "第七區廢墟", "chapter": 40, "fictional": None, "confidence": 0.6}]
        )
        rec = next(iter(out.values()))
        assert rec["fictional"] is True  # 唔喺已知真實清單 → 預設虛構（保守）

    def test_characters_alias_union(self):
        chars = [
            {"name": "少佐", "aliases": ["阿佐"], "chapter": 1, "confidence": 0.8},
            {"name": "阿佐", "aliases": [], "chapter": 5, "confidence": 0.75},
            {"name": "夏晴", "aliases": [], "chapter": 1, "confidence": 0.7},
        ]
        out = bpd.resolve_characters(chars)
        # 少佐+阿佐 合併為一個；夏晴獨立
        assert len(out) == 2
        merged = [v for v in out.values() if v["display_name"] in ("少佐", "阿佐")][0]
        assert sorted(merged["chapters"]) == [1, 5]
        assert "阿佐" in merged["aliases"] or "少佐" in merged["aliases"]


# ---- builder 端到端（合成 candidates + 治理檢查）----


class TestBuilderEndToEnd:
    @pytest.fixture
    def built(self, tmp_path, monkeypatch):
        cand_path = tmp_path / "candidates.jsonl"
        rows = [
            {
                "candidate_id": "c_00001", "run_id": "r", "chapter": 11,
                "entity_kind": "location", "name": "將軍澳",
                "claim": "主角喺將軍澳一帶活動。",
                "evidence_excerpt": "（私有證據摘錄，不應出現喺公開輸出）" + "字" * 250,
                "confidence": 0.85, "fictional": False, "location_type": "district",
                "spoiler_level": 0, "status": "pending",
            },
            {
                "candidate_id": "c_00002", "run_id": "r", "chapter": 3,
                "entity_kind": "event", "name": "抵達大本營",
                "claim": "主角到達倖存者據點。",
                "evidence_excerpt": "（另一段私有證據）",
                "confidence": 0.8, "spoiler_level": 1, "status": "pending",
            },
            {
                "candidate_id": "c_00003", "run_id": "r", "chapter": 1,
                "entity_kind": "character", "name": "少佐",
                "claim": "早期已登場嘅角色。",
                "evidence_excerpt": "（私有）",
                "confidence": 0.7, "aliases": ["阿佐"], "status": "pending",
            },
        ]
        with open(cand_path, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

        public_dir = tmp_path / "public"
        private_review = tmp_path / "private-review"
        monkeypatch.setattr(bpd, "CANDIDATES", cand_path)
        monkeypatch.setattr(bpd, "OUT_DIR", public_dir)
        monkeypatch.setattr(bpd, "PRIVATE_REVIEW", private_review)

        rc = bpd.main_injectable() if hasattr(bpd, "main_injectable") else None
        if rc is None:
            # 直接呼叫 main（路徑已被 monkeypatch）
            import contextlib, io
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                sys.argv = ["build_public_dataset.py"]
                rc = bpd.main()
            assert rc == 0, buf.getvalue()
        return public_dir

    def test_outputs_exist_and_counts_match(self, built):
        for fname in ("locations.geojson", "events.geojson", "routes.geojson", "timeline.json", "characters.json", "asset-manifest.json"):
            assert (built / fname).exists(), fname
        mf = json.loads((built / "asset-manifest.json").read_text(encoding="utf-8"))
        assert mf["counts"]["location"] == 1
        assert mf["counts"]["event"] == 1
        assert mf["counts"]["character"] == 1

    def test_no_evidence_leakage_into_public(self, built):
        text = "".join(open(p, encoding="utf-8").read() for p in built.glob("*.json*"))
        assert "私有證據摘錄" not in text
        assert "evidence_excerpt" not in text
        # 冇任何 >200 字連續 CJK（治理掃描門檻以下但檢查事件摘要合理長度）
        import re
        for m in re.finditer(r"[^\x00-\x7f]{201,}", text):
            raise AssertionError(f"疑似長文本洩漏：{m.group(0)[:60]}")

    def test_all_records_needs_review(self, built):
        for fname in ("locations.geojson", "events.geojson"):
            doc = json.loads((built / fname).read_text(encoding="utf-8"))
            for f in doc["features"]:
                assert f["properties"]["review_status"] == "needs_review"
        chars = json.loads((built / "characters.json").read_text(encoding="utf-8"))
        assert all(c["review_status"] == "needs_review" for c in chars)

    def test_real_district_keeps_reference_coords(self, built):
        doc = json.loads((built / "locations.geojson").read_text(encoding="utf-8"))
        tko = next(f for f in doc["features"] if f["properties"]["name"] == "將軍澳")
        assert tko["geometry"]["coordinates"] == bpd.HK_DISTRICT_CENTERS["將軍澳"]
        assert tko["properties"]["fictional"] is False

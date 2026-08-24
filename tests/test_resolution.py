"""《病港》Phase B — resolution 規則單元測試（resolution_enhance.py + builder slugify）。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import resolution_enhance as renh  # noqa: E402
import build_public_dataset as bpd  # noqa: E402


class TestSlugify:
    def test_ascii_name(self):
        assert bpd.slugify("Mong Kok") == "mong_kok"

    def test_chinese_name_gets_hash_id(self):
        cid = bpd.slugify("大本營")
        import re

        assert re.fullmatch(r"[a-z0-9_]+", cid), cid
        # deterministic
        assert bpd.slugify("大本營") == cid

    def test_different_names_different_ids(self):
        ids = {bpd.slugify(n) for n in ("大本營", "將軍澳", "病窩")}
        assert len(ids) == 3


class TestParenthetical:
    def test_strip_parenthetical_basic(self):
        result = renh.strip_parenthetical("M（主角）")
        assert result is not None
        main, note = result
        assert main == "M"
        assert note == "主角"

    def test_no_parenthetical(self):
        assert renh.strip_parenthetical("夏晴") is None

    def test_halfwidth_parens_also_matched(self):
        # NFKC 會將全形括號轉半形，所以兩種都支援
        result = renh.strip_parenthetical("商場(病窩)")
        assert result is not None
        assert result == ("商場", "病窩")


class TestVagueDetection:
    def test_vague_location_in_list(self):
        assert "呢一區" in renh.VAGUE_LOCATION
        assert "安區" in renh.VAGUE_LOCATION

    def test_vague_character_in_list(self):
        assert "首領" in renh.VAGUE_CHARACTER


class TestResolutionRules:
    def test_locations_merge_exact_name(self):
        locs = [
            {"name": "將軍澳中心", "chapter": 1, "fictional": False, "confidence": 0.9, "location_type": "district"},
            {"name": "將軍澳中心", "chapter": 2, "fictional": False, "confidence": 0.9, "location_type": "district"},
        ]
        out = bpd.resolve_locations(locs)
        assert len(out) == 1
        rec = next(iter(out.values()))
        assert rec["chapters"] == [1, 2]

    def test_unknown_place_conservative_fictional(self):
        out = bpd.resolve_locations(
            [{"name": "第七區廢墟", "chapter": 9, "fictional": None, "confidence": 0.6}]
        )
        assert next(iter(out.values()))["fictional"] is True

    def test_characters_alias_union_transitive(self):
        chars = [
            {"name": "少佐", "aliases": ["阿佐"], "chapter": 1, "confidence": 0.8},
            {"name": "阿佐", "aliases": [], "chapter": 5, "confidence": 0.75},
            {"name": "夏晴", "aliases": [], "chapter": 2, "confidence": 0.7},
        ]
        out = bpd.resolve_characters(chars)
        assert len(out) == 2  # 少佐=阿佐 合併；夏晴獨立

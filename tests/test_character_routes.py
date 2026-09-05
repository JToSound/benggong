"""《病港》— 角色移動路線推導測試（derive_character_routes.py）。"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


def load_module(tmp_candidates: Path):
    spec = importlib.util.spec_from_file_location(
        "dcr", REPO / "scripts" / "derive_character_routes.py"
    )
    mod = importlib.util.module_from_spec(spec)
    # patch 路徑常量
    spec.loader.exec_module(mod)
    return mod, tmp_candidates


def write_candidates(path: Path, rows: list[dict]):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8"
    )


@pytest.fixture
def run_derive(monkeypatch, tmp_path):
    def _run(rows: list[dict]) -> tuple[object, dict]:
        cand = tmp_path / "candidates.jsonl"
        out = tmp_path / "routes.json"
        write_candidates(cand, rows)
        spec = importlib.util.spec_from_file_location("dcr", REPO / "scripts" / "derive_character_routes.py")
        mod = importlib.util.module_from_spec(spec)
        monkeypatch.setattr(mod.__spec__, "submodule_search_locations", [])
        # 直接覆寫模組級常量後執行 main
        spec.loader.exec_module(mod) if False else None
        import types

        mod2 = types.ModuleType("dcr")
        code = (REPO / "scripts" / "derive_character_routes.py").read_text(encoding="utf-8")
        code = code.replace(
            'CANDIDATES = REPO / "data/private/evidence/candidates.jsonl"',
            f"CANDIDATES = Path(r\"{cand}\")",
        ).replace(
            'OUT = REPO / "data/private/review/character-routes.json"',
            f'OUT = Path(r"{out}")',
        )
        exec(compile(code, "dcr", "exec"), mod2.__dict__)
        rc = mod2.main()
        data = json.loads(out.read_text(encoding="utf-8")) if out.exists() else []
        return rc, data

    return _run


class TestDeriveRoutes:
    def test_basic_route(self, run_derive):
        locs = [{"entity_kind": "location", "chapter": i, "name": n} for i, n in [(1, "大本營"), (3, "商場")]]
        chars = [
            {"entity_kind": "character", "chapter": ch, "name": "阿明", "claim": claim}
            for ch, claim in [
                (1, "阿明喺大本營門口把守"),
                (2, "阿明留喺大本營休息"),
                (3, "阿明同主角去到商場搜刮"),
                (4, "阿明喺商場遇到舌女"),
                (5, "阿明返到大本營醫療室"),
                (6, "阿明喺大本營養傷"),
            ]
        ]
        rc, routes = run_derive(locs + chars)
        assert rc == 0
        assert len(routes) == 1
        r = routes[0]
        assert r["character"] == "阿明"
        assert r["provisional"] is True
        assert r["review_status"] == "needs_review"
        wps = [(w["chapter"], w["location"]) for w in r["waypoints"]]
        assert wps[0] == (1, "大本營")
        assert ("3", ) and any(w == (3, "商場") for w in wps)

    def test_fewer_than_min_chapters_skipped(self, run_derive):
        rows = [
            {"entity_kind": "location", "chapter": 1, "name": "大本營"},
            *[
                {"entity_kind": "character", "chapter": ch, "name": "路人甲", "claim": "佢喺大本營"}
                for ch in range(1, 4)  # 3 章 < MIN_CHAPTERS(5)
            ],
        ]
        rc, routes = run_derive(rows)
        assert rc == 0
        assert routes == []

    def test_same_location_dedup(self, run_derive):
        rows = [
            {"entity_kind": "location", "chapter": 1, "name": "大本營"},
            *[
                {"entity_kind": "character", "chapter": ch, "name": "守衛乙", "claim": "一直喺大本營"}
                for ch in range(1, 7)
            ],
        ]
        rc, routes = run_derive(rows)
        assert rc == 0
        assert routes == []  # 冇位置變化 → 無 route

    def test_name_location_overlap_excluded(self, run_derive):
        # 角色名本身係地名（如「公仔」）時唔應該自證移動
        rows = [
            {"entity_kind": "location", "chapter": 1, "name": "公仔"},
            *[
                {"entity_kind": "character", "chapter": ch, "name": "公仔", "claim": f"公仔喺公仔度 ch{ch}"}
                for ch in range(1, 7)
            ],
        ]
        rc, routes = run_derive(rows)
        assert rc == 0
        assert routes == []

    def test_longer_name_matched_first(self, run_derive):
        rows = [
            {"entity_kind": "location", "chapter": 1, "name": "大本營"},
            {"entity_kind": "location", "chapter": 2, "name": "大本營市集"},
            {
                "entity_kind": "character",
                "chapter": 5,
                "name": "商人丙",
                "claim": "商人丙喺大本營市集擺檔",
            },
        ] + [
            {"entity_kind": "character", "chapter": ch, "name": "商人丙", "claim": "商人丙喺大本營"}
            for ch in (1, 2, 3, 4, 6)
        ]
        rc, routes = run_derive(rows)
        assert rc == 0
        assert len(routes) == 1
        wps = [w["location"] for w in routes[0]["waypoints"]]
        assert "大本營市集" in wps  # 長名優先，唔會錯配做「大本營」


# ---- Phase E: alias override (manual-resolutions.json) ----


class TestAliasOverride:
    """Phase E：manual-resolutions.json 嘅 merge_routes 規則必須令
    '老師' / '鳥嘴' / '我（敘事者）' 等 alias merge 入 '主角'，避免 route 衝突。"""

    def test_manual_resolutions_has_主角_aliases(self):
        """manual-resolutions.json 必須有 merge_routes 將 53+ aliases 合併到 主角。"""
        path = REPO / "data/private/review/manual-resolutions.json"
        if not path.exists():
            pytest.skip("manual-resolutions.json 不存在 (私有不入 repo)")
        res = json.loads(path.read_text(encoding="utf-8"))
        merge = None
        for d in res.get("decisions", []):
            if d.get("action") == "merge_routes":
                for m in d.get("merges", []):
                    if m.get("into") == "主角":
                        merge = m
                        break
            if merge:
                break
        assert merge, "manual-resolutions.json 必須有 merge_routes → 主角"
        aliases = set(merge.get("from_aliases", []))
        # 確認 Phase E 已加入 plain-name aliases
        for required in ("M", "M先生", "老師", "鳥嘴", "我（敘事者）"):
            assert required in aliases, f"必須包含 alias '{required}'"

    def test_character_routes_no_主角_aliases(self):
        """Phase E：derive_character_routes 嘅 output 唔應該再包含 主角 aliases 嘅獨立 route。
        應該全部 rename 做 主角。"""
        path = REPO / "data/private/review/character-routes.json"
        if not path.exists():
            pytest.skip("character-routes.json 尚未生成")
        routes = json.loads(path.read_text(encoding="utf-8"))
        for r in routes:
            assert r["character"] != "老師", "Phase E bug: 老師 應該 merge 入 主角"
            assert r["character"] != "鳥嘴", "Phase E bug: 鳥嘴 應該 merge 入 主角"
            assert r["character"] != "我（敘事者）", "Phase E bug: 我（敘事者） 應該 merge 入 主角"

    def test_routes_geojson_no_alias_character_names(self):
        """Phase E：routes.geojson 嘅 character_name 唔應有 alias 衝突。"""
        path = REPO / "data/public/routes.geojson"
        if not path.exists():
            pytest.skip("routes.geojson 尚未生成")
        routes = json.loads(path.read_text(encoding="utf-8"))["features"]
        for r in routes:
            name = r["properties"]["character_name"]
            assert name not in ("老師", "鳥嘴", "我（敘事者）"), (
                f"Phase E bug: route {r['properties']['id']} 仍用 alias '{name}'"
            )

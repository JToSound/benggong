"""地點推斷引擎回歸測試（scripts/infer_places.py）。

保護嘅關鍵行為：
1. 「A大樓」等模糊名要推斷到真實校園座數同**正確座標**（用戶明確要求）
2. 唔可以出重複推斷（同一 id 兩條矛盾記錄）
3. 唔可以出假陽性（「荒廢商場 → 香港」呢類）
4. 推斷結果必須合 schema
5. 異體正規化要統一 座／幢／橦／部
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "infer_places.py"
JSONL = REPO / "data" / "private" / "review" / "place-inference.jsonl"
SCHEMA = REPO / "data" / "schemas" / "place-inference.schema.json"


def _load_module():
    spec = importlib.util.spec_from_file_location("infer_places", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def mod():
    return _load_module()


@pytest.fixture(scope="module")
def records() -> list[dict]:
    """讀推斷輸出。

    `data/private/` 係 gitignore（版權規則：小說全文不得 commit），所以
    新 clone／CI 上呢個檔唔存在。**唔可以就咁 skip** —— 咁會令整批核心
    測試靜靜地唔跑。改為即場執行引擎生成。
    """
    if not JSONL.exists():
        proc = subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=str(REPO), capture_output=True, text=True,
        )
        if proc.returncode != 0 or not JSONL.exists():
            pytest.skip(
                "無法生成推斷輸出（可能缺 OSM cache）："
                f"{proc.stderr[-300:]}"
            )
    return [
        json.loads(line)
        for line in JSONL.read_text(encoding="utf-8").splitlines()
        if line
    ]


# ---------------------------------------------------------------------------
# 模糊偵測
# ---------------------------------------------------------------------------
def test_generic_suffix_detects_vague_names(mod):
    assert mod.generic_suffix("A大樓") == "大樓"
    assert mod.generic_suffix("商場") == "商場"
    assert mod.generic_suffix("學校") == "學校"


def test_generic_suffix_rejects_specific_names(mod):
    # 詞幹 > 3 字 = 有識別性，唔算模糊
    assert mod.generic_suffix("香港知專設計學院") is None
    assert mod.generic_suffix("李惠利大樓下小型垃圾站") is None


def test_distinctive_stem_rejects_bare_generic_words(mod):
    # 「商場」「二樓」係通用詞，唔可以當父項
    assert not mod._has_distinctive_stem("商場")
    assert not mod._has_distinctive_stem("二樓")
    # 有詞幹就通過
    assert mod._has_distinctive_stem("李惠利大樓")
    assert mod._has_distinctive_stem("將軍澳廣場")


def test_road_names_excluded_from_district_evidence(mod):
    assert mod._is_road_like("寶琳北路")
    assert mod._is_road_like("將軍澳隧道")
    assert not mod._is_road_like("寶琳")


def test_generic_area_names_excluded(mod):
    # 「香港」幾乎每章都出現，唔可以做區域證據
    assert not mod._is_area_name("香港")
    assert not mod._is_area_name("九龍")
    assert mod._is_area_name("寶琳")
    assert mod._is_area_name("調景嶺")


# ---------------------------------------------------------------------------
# 異體正規化
# ---------------------------------------------------------------------------
def test_variant_normalisation_unifies_seat_characters(mod):
    """座／幢／橦／部 係同一件事嘅唔同寫法。"""
    names = ["D座大樓", "D橦大樓", "D部大樓"]
    groups = mod.find_variants(
        [{"properties": {"id": f"loc_{i}", "name": n, "chapters": [1]}}
         for i, n in enumerate(names)]
    )
    assert len(groups) == 1, f"應該合成一組，實際 {len(groups)} 組"
    assert set(groups[0]["names"]) == set(names)


# ---------------------------------------------------------------------------
# 推斷結果（核心）
# ---------------------------------------------------------------------------
#: 用戶明確指出嘅例子：「A大樓」要推斷到真實建築，而且座標必須正確。
#: 座標嚟自 OSM 調景嶺 VTC 校園嘅 Block A/B/C/D。
EXPECTED_BLOCKS = {
    "A大樓": (114.25311, 22.30590),
    "B橦大樓": (114.25355, 22.30613),
    "C橦大樓": (114.25375, 22.30573),
    "D座大樓": (114.25332, 22.30547),
}


@pytest.mark.parametrize("name,lonlat", list(EXPECTED_BLOCKS.items()))
def test_campus_block_inference(records, name, lonlat):
    hits = [r for r in records if name in r["subject_names"]]
    assert hits, f"「{name}」應該有推斷"
    r = hits[0]
    assert r["pattern"] == "R-CAMPUS-BLOCK"
    assert r["inferred_lonlat"] is not None, "校園座數必須有座標"
    assert r["coordinate_source"] == "osm_way"
    assert abs(r["inferred_lonlat"][0] - lonlat[0]) < 1e-5
    assert abs(r["inferred_lonlat"][1] - lonlat[1]) < 1e-5
    assert r["proposed_changes"]["location_precision"] == "exact"
    # 引擎輸出一定係 pending；審閱之後會變 approved／rejected。
    # 所以呢度只驗證狀態係合法值，而唔係寫死 pending。
    assert r["review_status"] in ("pending", "approved", "rejected", "needs_info")


def test_variant_inheritance_covers_all_spellings(records):
    """D 座嘅全部異體寫法都要指到同一個座數。"""
    for name in ("D橦大樓", "D部大樓"):
        hits = [r for r in records if name in r["subject_names"]]
        assert hits, f"「{name}」應該透過異體傳播得到推斷"
        r = hits[0]
        assert "D座" in (r["inferred_prototype"] or "")
        assert r["inferred_lonlat"] is not None
        assert abs(r["inferred_lonlat"][0] - 114.25332) < 1e-5


def test_no_duplicate_inference_per_subject(records):
    seen: dict[str, int] = {}
    for r in records:
        for sid in r["subject_ids"]:
            seen[sid] = seen.get(sid, 0) + 1
    dup = {k: v for k, v in seen.items() if v > 1}
    assert not dup, f"同一 id 出現多條推斷：{dup}"


def test_no_generic_place_false_positives(records):
    """唔可以出現「模糊地點 → 香港／九龍」呢類零資訊推斷。"""
    bad = [
        r for r in records
        if r["pattern"] == "R-DISTRICT"
        and r["inferred_prototype"] in ("香港", "九龍", "新界")
    ]
    assert not bad, f"區域推斷出現過於籠統嘅目標：{[b['subject_names'] for b in bad]}"


def test_no_duplicate_coordinates_within_same_prototype(records):
    """同一原型嘅多個推斷要指到同一個座標（唔可以各自亂放）。"""
    by_proto: dict[str, set[tuple[float, float]]] = {}
    for r in records:
        if not r["inferred_lonlat"] or r["pattern"] == "R-DISTRICT":
            continue
        by_proto.setdefault(str(r["inferred_prototype"]), set()).add(
            (r["inferred_lonlat"][0], r["inferred_lonlat"][1])
        )
    for proto, pts in by_proto.items():
        assert len(pts) == 1, f"原型「{proto}」有 {len(pts)} 個唔同座標：{pts}"


def test_all_coordinates_within_hong_kong(records):
    for r in records:
        ll = r["inferred_lonlat"]
        if ll is None:
            continue
        assert 113.0 < ll[0] < 115.0, f"{r['inference_id']} lon 唔喺香港"
        assert 22.0 < ll[1] < 23.0, f"{r['inference_id']} lat 唔喺香港"


def test_every_inference_has_evidence(records):
    for r in records:
        assert r["evidence"], f"{r['inference_id']} 冇證據鏈"


def test_confidence_monotonic_with_rule_strength(records):
    """R-CAMPUS-BLOCK（有精確座標）應該比 R-DISTRICT（只有區）高信心。"""
    campus = [r["confidence"] for r in records if r["pattern"] == "R-CAMPUS-BLOCK"]
    district = [r["confidence"] for r in records if r["pattern"] == "R-DISTRICT"]
    if campus and district:
        assert min(campus) > max(district)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
def test_records_validate_against_schema(records):
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    errors: list[str] = []
    for r in records:
        for err in validator.iter_errors(r):
            errors.append(f"{r.get('inference_id')}: {err.message}")
    assert not errors, "schema 驗證失敗：\n" + "\n".join(errors[:10])


def test_engine_output_is_always_pending(tmp_path):
    """引擎唔可以自己批自己 —— 原始輸出必須全部 pending。

    呢個係安全原則嘅核心：推斷係機械性嘅，審閱係價值判斷。如果引擎
    可以寫 approved，整個審閱關卡就形同虛設。
    """
    mod = _load_module()
    src = SCRIPT.read_text(encoding="utf-8")
    # 引擎只可以寫死 pending；唔可以讀決定檔
    assert '"review_status": "pending"' in src
    assert "place-inference-decisions" not in src, (
        "引擎唔應該讀審閱決定檔 —— 審閱係 apply_place_inferences.py 嘅責任"
    )
    assert mod is not None


def test_schema_forbids_unknown_coordinate_source(records):
    """coordinate_source 必須係 enum 之一（唔可以自由發揮）。"""
    allowed = {
        "osm_way", "osm_relation", "hk-districts.json",
        "parent_containment", "external_verified", None,
    }
    for r in records:
        assert r["coordinate_source"] in allowed, (
            f"{r['inference_id']} 嘅 coordinate_source "
            f"「{r['coordinate_source']}」唔係合法值"
        )


# ---------------------------------------------------------------------------
# 私有邊界：推斷檔只可以喺 data/private
# ---------------------------------------------------------------------------
def test_inference_output_stays_private():
    # 用 Path.parts 而唔係字串比對（Windows 用反斜線，而且層數會變）
    assert "data" in JSONL.parts and "private" in JSONL.parts, (
        f"推斷檔必須喺 data/private 之下，實際：{JSONL}"
    )
    assert JSONL.parts.index("data") < JSONL.parts.index("private")
    assert not (REPO / "data" / "public" / "place-inference.jsonl").exists(), (
        "推斷結果唔可以出現喺 public"
    )


def test_script_runs_and_passes_schema():
    """端對端：跑一次引擎，確認 schema 驗證通過。"""
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--stats"],
        cwd=str(REPO), capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert "推斷候選" in proc.stdout

"""推斷反饋迴圈嘅回歸測試（`scripts/infer_places.py`）。

保護嘅關鍵行為
==============
`R-CHAPTER-CLUSTER` 嘅座標係「同章其他已解析地點嘅質心」。如果佢**自己**
嘅輸出又入返錨點池，就會形成正反饋：

    質心(錨點) → 本規則輸出 → 成為下輪錨點 → 質心改變 → …

實測（2026-10-04）：每輪 **56 個** feature 漂移、全部 `inferred_from` 非空，
其中 **51 個**就係本規則嘅輸出；漂移量遞減（57 → 48 → 34 m）但**唔收斂** ✗
→ `tests/test_apply_inferences.py::test_pipeline_is_idempotent` 紅。

⚠️ 原本嘅 `self_resolved` 守衛係**死代碼**
----------------------------------------
佢只由 `results_so_far` 建立，但本函數喺 `main()` 只被呼叫**一次**（而且係
喺 `results` 仍未包含本規則輸出之前）→ `self_resolved` 永遠係空集。
所以一定要**另外**由上一輪 `place-inference.jsonl` 讀返（見
`load_previous_cluster_subjects`）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# ⚠️ `scripts/` 唔係 package —— 要自己插入 sys.path（同其他測試檔一致）。
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import infer_places as ip  # noqa: E402  （一定要喺 sys.path 設定之後）

M_PER_DEG_LON = 111320 * 0.9247
M_PER_DEG_LAT = 110570


def feat(loc_id: str, name: str, lon: float, lat: float, ch: int = 5,
         precision: str = "exact") -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "id": loc_id,
            "name": name,
            "description": "",
            "chapters": [ch],
            "location_precision": precision,
        },
    }


def candidate(loc_id: str, name: str, ch: int = 5) -> dict:
    return {
        "id": loc_id,
        "name": name,
        "description": "",
        "chapters": [ch],
        "location_precision": "fictional",
    }


#: 三個高度集中嘅同章錨點（互相 < 50 m）。
ANCHORS = [
    feat("loc_A", "錨點甲", 114.2500, 22.3100),
    feat("loc_B", "錨點乙", 114.2504, 22.3104),
    feat("loc_C", "錨點丙", 114.2508, 22.3108),
]


def run(prev: set[str] | None = None) -> list[dict]:
    return ip.infer_from_chapter_cluster(
        [candidate("loc_D", "神秘房間")],
        set(),          # covered：冇任何已覆蓋
        ANCHORS,
        [],             # results_so_far：冇其他規則輸出
        prev,
    )


def test_no_previous_exclusion_uses_all_anchors():
    """基準：冇排除任何錨點 → 質心 = 三個錨點嘅平均。"""
    out = run(None)
    assert len(out) == 1
    lon, lat = out[0]["inferred_lonlat"]
    assert lon == pytest.approx((114.2500 + 114.2504 + 114.2508) / 3, abs=1e-6)
    assert lat == pytest.approx((22.3100 + 22.3104 + 22.3108) / 3, abs=1e-6)


def test_prev_cluster_subject_is_excluded_from_anchor_pool():
    """⭐ 上一輪由本規則解析嘅地點，唔可以再做錨點。"""
    out = run({"loc_C"})
    assert len(out) == 1
    lon, lat = out[0]["inferred_lonlat"]
    # 只剩甲、乙 → 質心係兩者中點，唔同「三個嘅平均」
    assert lon == pytest.approx((114.2500 + 114.2504) / 2, abs=1e-6)
    assert lat == pytest.approx((22.3100 + 22.3104) / 2, abs=1e-6)
    assert lon != pytest.approx((114.2500 + 114.2504 + 114.2508) / 3, abs=1e-9)


def test_excluding_two_leaves_one_anchor_and_no_inference():
    """⚠️ 錨點少過 2 個 → 唔推斷（一點冇跨距可言，唔可以當「喺嗰個點」）。"""
    assert run({"loc_B", "loc_C"}) == []


def test_results_so_far_still_excluded():
    """同一次執行內嘅守衛仍然有效（`results_so_far`）。"""
    out = ip.infer_from_chapter_cluster(
        [candidate("loc_D", "神秘房間")],
        set(),
        ANCHORS,
        [{"pattern": "R-CHAPTER-CLUSTER", "subject_ids": ["loc_C"]}],
        None,
    )
    lon, _ = out[0]["inferred_lonlat"]
    assert lon == pytest.approx((114.2500 + 114.2504) / 2, abs=1e-6)


# ─────────────────────────────────────────────────────────────────────────────
# 讀上一輪 JSONL
# ─────────────────────────────────────────────────────────────────────────────


def test_load_previous_cluster_subjects(tmp_path, monkeypatch):
    """由上一輪 JSONL 讀返 R-CHAPTER-CLUSTER 嘅 subject（其他 pattern 唔要）。"""
    p = tmp_path / "place-inference.jsonl"
    rows = [
        {"pattern": "R-CHAPTER-CLUSTER", "subject_ids": ["loc_1", "loc_2"]},
        {"pattern": "R-DESC-RESOLVED", "subject_ids": ["loc_3"]},
        {"pattern": "R-CHAPTER-CLUSTER", "subject_ids": ["loc_4"]},
        {"pattern": "R-DISTRICT", "subject_ids": ["loc_5"]},
    ]
    p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), "utf-8")
    monkeypatch.setattr(ip, "OUT_JSONL", p)
    assert ip.load_previous_cluster_subjects() == {"loc_1", "loc_2", "loc_4"}


def test_load_previous_missing_file_returns_empty(tmp_path, monkeypatch):
    """冇 JSONL（全新 clone）→ 回空集，行為同修復前一樣（唔會更差）。"""
    monkeypatch.setattr(ip, "OUT_JSONL", tmp_path / "nope.jsonl")
    assert ip.load_previous_cluster_subjects() == set()


def test_load_previous_tolerates_bad_lines(tmp_path, monkeypatch):
    """壞行（截斷 JSON）唔可以令整個推斷爆掉。"""
    p = tmp_path / "place-inference.jsonl"
    p.write_text(
        '{"pattern": "R-CHAPTER-CLUSTER", "subject_ids": ["loc_9"]}\n'
        '{"pattern": "R-CHAPTER-CLUSTER", "subject_ids": [\n'  # 截斷
        "\n"
        '{"pattern": "R-CHAPTER-CLUSTER", "subject_ids": ["loc_8"]}\n',
        "utf-8",
    )
    monkeypatch.setattr(ip, "OUT_JSONL", p)
    assert ip.load_previous_cluster_subjects() == {"loc_9", "loc_8"}

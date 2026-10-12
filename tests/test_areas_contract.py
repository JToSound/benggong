"""#14 契約測試：`areas.json` 面層種類（`k` 值）同產生器規則必須一致。

為何要呢個測試
==============
`areas.json` 嘅 `k` 值係**跨語言契約** —— 產生器係 Python
（`scripts/build_vector_basemap.py`），消費者係 TypeScript
（`src/map/BaseGeometryLayer.ts` 嘅 `AREA_KIND_*`）。兩者冇共用模組，
所以任何一邊改咗、另一邊唔改，就會出現：
  · 「有資料但當成另一類」→ 顏色錯（靜默、冇錯誤）；
  · 「新 kind 前端唔認得」→ 整個面層靜默消失。

本測試係**唯一**把關點：逐個斷言 Python 常數同 TS 常數相等。

第二個測試驗證**產生器規則本身**：
  · `landuse=residential` 一定要入 `areas`（#14 嘅本體）；
  · 佢一定要係 `AREA_KIND_RESIDENTIAL`（唔可以併入綠地 —— 語意相反）；
  · 面數要反映「真係加咗好多」（防止有人靜默 revert）。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import build_vector_basemap as bvb  # noqa: E402

TS_PATH = REPO / "src" / "map" / "BaseGeometryLayer.ts"


def _ts_const(name: str) -> int:
    """由 TS 原始碼抽 `export const NAME = <int>;`。"""
    src = TS_PATH.read_text(encoding="utf-8")
    m = re.search(rf"export const {name}\s*=\s*(\d+)\s*;", src)
    assert m, f"{TS_PATH.name} 搵唔到 {name}"
    return int(m.group(1))


class TestKindContract:
    """Python ↔ TS 嘅 `k` 值定義必須逐一相等。"""

    def test_green(self):
        assert bvb.AREA_KIND_GREEN == _ts_const("AREA_KIND_GREEN")

    def test_industrial(self):
        assert bvb.AREA_KIND_INDUSTRIAL == _ts_const("AREA_KIND_INDUSTRIAL")

    def test_residential(self):
        assert bvb.AREA_KIND_RESIDENTIAL == _ts_const("AREA_KIND_RESIDENTIAL")

    def test_kinds_are_distinct(self):
        kinds = {
            bvb.AREA_KIND_GREEN,
            bvb.AREA_KIND_INDUSTRIAL,
            bvb.AREA_KIND_RESIDENTIAL,
        }
        assert len(kinds) == 3, f"kind 值撞咗：{kinds}"


class TestBuildAreasRules:
    """產生器規則（用合成元素，唔使 182 MB OSM 快取）。"""

    @staticmethod
    def _way(lon: float, lat: float, size: float = 0.01, **tags) -> dict:
        """建一個方形 way（足夠大，穩過面積門檻）。"""
        return {
            "type": "way",
            "tags": tags,
            "geometry": [
                {"lon": lon, "lat": lat},
                {"lon": lon + size, "lat": lat},
                {"lon": lon + size, "lat": lat + size},
                {"lon": lon, "lat": lat + size},
            ],
        }

    def test_residential_is_included(self):
        els = [self._way(114.10, 22.32, landuse="residential")]
        out = bvb.build_areas(els)
        assert len(out) == 1
        assert out[0]["k"] == bvb.AREA_KIND_RESIDENTIAL

    def test_residential_not_merged_into_green(self):
        """住宅區絕對唔可以當綠地（語意相反）。"""
        els = [self._way(114.10, 22.32, landuse="residential")]
        out = bvb.build_areas(els)
        assert out[0]["k"] != bvb.AREA_KIND_GREEN

    def test_park_is_green(self):
        els = [self._way(114.10, 22.32, leisure="park")]
        out = bvb.build_areas(els)
        assert out[0]["k"] == bvb.AREA_KIND_GREEN

    def test_industrial_is_industrial(self):
        els = [self._way(114.10, 22.32, landuse="industrial")]
        out = bvb.build_areas(els)
        assert out[0]["k"] == bvb.AREA_KIND_INDUSTRIAL

    def test_three_kinds_coexist(self):
        els = [
            self._way(114.10, 22.32, leisure="park"),
            self._way(114.12, 22.33, landuse="industrial"),
            self._way(114.14, 22.34, landuse="residential"),
        ]
        out = bvb.build_areas(els)
        assert {a["k"] for a in out} == {
            bvb.AREA_KIND_GREEN,
            bvb.AREA_KIND_INDUSTRIAL,
            bvb.AREA_KIND_RESIDENTIAL,
        }

    def test_residential_area_threshold(self):
        """太細嘅住宅面（< MIN_RESIDENTIAL_AREA_M2）要過濾走。"""
        # 0.001° ≈ 110 m → 約 12,000 m²（過門檻）
        big = self._way(114.10, 22.32, size=0.001, landuse="residential")
        # 0.0005° ≈ 55 m → 約 3,000 m²（唔過門檻）
        small = self._way(114.20, 22.40, size=0.0005, landuse="residential")
        out = bvb.build_areas([big, small])
        assert len(out) == 1, "細過門檻嘅住宅面應該被過濾"

    def test_residential_threshold_is_documented_constant(self):
        assert bvb.MIN_RESIDENTIAL_AREA_M2 > 0


class TestManifestCompleteness:
    """`--only` 唔可以令 manifest 靜默失去其他層（已修嘅 footgun）。"""

    @staticmethod
    def _manifest() -> dict:
        p = REPO / "public" / "assets" / "vector" / "manifest.json"
        if not p.exists():
            pytest.skip("manifest.json 未產生")
        return json.loads(p.read_text(encoding="utf-8"))

    def test_all_expected_layers_present(self):
        layers = self._manifest()["layers"]
        expected = {"land", "water", "areas", "l0", "l1", "labels", "tiles"}
        missing = expected - set(layers)
        assert not missing, (
            f"manifest 缺少層：{sorted(missing)}"
            "（可能由 `--only` 靜默刪走 —— 要用完整 build 修復）"
        )

    def test_areas_layer_count_matches_file(self):
        m = self._manifest()
        areas = json.loads(
            (REPO / "public" / "assets" / "vector" / "areas.json").read_text("utf-8")
        )["areas"]
        assert m["layers"]["areas"]["count"] == len(areas)


class TestOnlyFlagMergesManifest:
    """`--only` 嘅 merge 行為（原始碼契約，防止回退）。"""

    def test_source_merges_existing_layers(self):
        src = (REPO / "scripts" / "build_vector_basemap.py").read_text(encoding="utf-8")
        assert "prev[" in src or "prev.get" in src, (
            "--only 應該由現有 manifest 讀回 layers 做基礎"
        )
        assert "由現有 manifest 保留" in src, "應該有 --only merge 嘅痕跡"


class TestGeneratedAreasFile:
    """驗證**已產生**嘅 `areas.json` 真係有住宅層（#14 落地證據）。"""

    @staticmethod
    def _areas() -> list[dict]:
        p = REPO / "public" / "assets" / "vector" / "areas.json"
        if not p.exists():
            pytest.skip("areas.json 未產生 —— 先跑 build_vector_basemap.py")
        return json.loads(p.read_text(encoding="utf-8"))["areas"]

    def test_file_contains_all_three_kinds(self):
        areas = self._areas()
        kinds = {a["k"] for a in areas}
        assert bvb.AREA_KIND_RESIDENTIAL in kinds, "areas.json 冇住宅層（#14 未落地）"
        assert bvb.AREA_KIND_GREEN in kinds
        assert bvb.AREA_KIND_INDUSTRIAL in kinds

    def test_residential_is_substantial(self):
        """住宅層唔可以係象徵式幾個 —— 防止靜默 revert 到「只加咗幾十個」。"""
        areas = self._areas()
        n = sum(1 for a in areas if a["k"] == bvb.AREA_KIND_RESIDENTIAL)
        assert n > 2000, f"住宅層只有 {n} 個面，似乎未真正加入"

    def test_no_unknown_kind(self):
        areas = self._areas()
        valid = {
            bvb.AREA_KIND_GREEN,
            bvb.AREA_KIND_INDUSTRIAL,
            bvb.AREA_KIND_RESIDENTIAL,
        }
        bad = sorted({a["k"] for a in areas} - valid)
        assert not bad, f"areas.json 有未知 kind：{bad}"

"""《病港》— Phase I: 全港 fallback anchor pool 測試。

背景：`src/data/fallbackAnchors.ts` 原本聲稱 503 個「全港」anchor，
但實測有 69 個係深圳 POI（華強北站、福田站、深圳圖書館…），因為
Phase G 嘅 Overpass bbox 北緣掠過深圳。呢個 test module 鎖定修復結果，
防止同類污染再發生。

驗證範圍：
- TS 檔格式同 export 名（前端同 tests/phase-i.test.ts 都依賴）
- entry 數量同 lon/lat/kind 完整性
- 全部座標喺香港 bbox 內
- 全部座標喺香港行政邊界多邊形內（需要 private cache，CI 會 skip）
- 冇簡體字／內地地名標記
- 生成腳本 --check 通過（輸出係最新）
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PY = Path(r"C:\Users\User\AppData\Local\Microsoft\WindowsApps\python3.12.exe")
if not PY.exists():  # CI (ubuntu) 用 PATH 上嘅 python
    PY = Path(sys.executable)

TS_PATH = REPO / "src" / "data" / "fallbackAnchors.ts"
GEN_SCRIPT = REPO / "scripts" / "gen_fallback_anchors.py"
BOUNDARY_CACHE = REPO / "data" / "private" / "cache" / "hk-boundary.geojson"

HK_BBOX = {
    "lon_min": 113.85,
    "lon_max": 114.45,
    "lat_min": 22.18,
    "lat_max": 22.55,
}

MIN_ENTRIES = 501  # tests/phase-i.test.ts 要求 > 500

# 必須存在嘅地標（故事主要發生地 + 抽查用）
REQUIRED_LANDMARKS = [
    "將軍澳中心 Park Central",
    "又一城 Festival Walk",
    "時代廣場 Times Square",
    "西港城 Western Market",
    "置富南區廣場 Chi Fu Landmark",
    "彩明商場 Choi Ming Shopping Centre",
]

# 內地地名標記（簡體字寫法）——唔應該出現喺香港 anchor pool
MAINLAND_MARKERS = (
    "深圳", "南山", "福田", "罗湖", "龙岗", "宝安", "龙华", "盐田",
    "坪山", "光明", "大鹏", "前海", "蛇口", "少年宫", "红岭", "莲花",
    "茂业", "通发", "华强", "东门", "门诊部", "校医院", "广东省",
)


def _ts_text() -> str:
    if not TS_PATH.exists():
        pytest.skip(f"missing {TS_PATH}")
    return TS_PATH.read_text(encoding="utf-8")


def _entries(text: str) -> dict[str, dict]:
    """抽出 `"name": { lon: x, lat: y, kind: "k" }` 形式嘅 entry。"""
    pattern = re.compile(
        r'^\s{2}"(?P<name>[^"]+)":\s*\{\s*lon:\s*(?P<lon>[\d.]+),\s*'
        r'lat:\s*(?P<lat>[\d.]+),\s*kind:\s*"(?P<kind>[^"]+)"',
        re.M,
    )
    return {
        m.group("name"): {
            "lon": float(m.group("lon")),
            "lat": float(m.group("lat")),
            "kind": m.group("kind"),
        }
        for m in pattern.finditer(text)
    }


# --------------------------------------------------------------------------
# 格式 / 數量
# --------------------------------------------------------------------------
def test_ts_file_exports_full_hk_anchors():
    text = _ts_text()
    assert "export interface FullHKAnchor" in text
    assert "export const FULL_HK_ANCHORS: Record<string, FullHKAnchor>" in text


def test_pool_has_at_least_501_entries():
    entries = _entries(_ts_text())
    assert len(entries) >= MIN_ENTRIES, (
        f"anchor pool 只有 {len(entries)} 個，少於 {MIN_ENTRIES}"
    )


def test_every_entry_has_lon_lat_kind():
    entries = _entries(_ts_text())
    assert entries, "冇解析到任何 entry"
    for name, e in entries.items():
        assert e["kind"], f"{name} 缺少 kind"
        assert isinstance(e["lon"], float) and isinstance(e["lat"], float), name


def test_required_landmarks_present():
    text = _ts_text()
    for name in REQUIRED_LANDMARKS:
        assert f'"{name}"' in text, f"缺少必要地標：{name}"


# --------------------------------------------------------------------------
# 地理正確性
# --------------------------------------------------------------------------
def test_all_coords_within_hk_bbox():
    entries = _entries(_ts_text())
    bad = [
        (n, e["lon"], e["lat"])
        for n, e in entries.items()
        if not (
            HK_BBOX["lon_min"] <= e["lon"] <= HK_BBOX["lon_max"]
            and HK_BBOX["lat_min"] <= e["lat"] <= HK_BBOX["lat_max"]
        )
    ]
    assert not bad, f"{len(bad)} 個 anchor 超出香港 bbox：{bad[:5]}"


def test_all_coords_within_hk_boundary():
    """用香港行政邊界多邊形驗證，確保冇深圳 POI 混入。

    邊界 GeoJSON 喺 data/private/cache/（唔會 commit），CI 上會 skip。
    """
    if not BOUNDARY_CACHE.exists():
        pytest.skip("hk-boundary.geojson 唔存在（private cache 未生成）")
    with BOUNDARY_CACHE.open(encoding="utf-8") as f:
        geo = json.load(f)

    def rings(g: dict) -> list[list[list[float]]]:
        t, c = g.get("type"), g.get("coordinates") or []
        if t == "Polygon":
            return [c[0]] if c else []
        if t == "MultiPolygon":
            return [p[0] for p in c if p]
        return []

    def inside(lon: float, lat: float) -> bool:
        for ring in rings(geo):
            hit = False
            n = len(ring)
            j = n - 1
            for i in range(n):
                xi, yi = ring[i][0], ring[i][1]
                xj, yj = ring[j][0], ring[j][1]
                if ((yi > lat) != (yj > lat)) and (
                    lon < (xj - xi) * (lat - yi) / (yj - yi) + xi
                ):
                    hit = not hit
                j = i
            if hit:
                return True
        return False

    entries = _entries(_ts_text())
    outside = [(n, e["lon"], e["lat"]) for n, e in entries.items() if not inside(e["lon"], e["lat"])]
    assert not outside, (
        f"{len(outside)} 個 anchor 唔喺香港境內（疑似深圳 POI）：{outside[:5]}"
    )


def test_no_mainland_place_markers_in_names():
    entries = _entries(_ts_text())
    bad = [n for n in entries if any(m in n for m in MAINLAND_MARKERS)]
    assert not bad, f"anchor 名含內地地名標記：{bad[:5]}"


# --------------------------------------------------------------------------
# 生成腳本可重跑性
# --------------------------------------------------------------------------
def test_generator_script_exists():
    assert GEN_SCRIPT.exists(), f"missing {GEN_SCRIPT}"


def test_generator_output_is_up_to_date():
    """重跑 --check，確認 committed TS 檔同生成器輸出一致（deterministic）。"""
    if not BOUNDARY_CACHE.exists():
        pytest.skip("需要 private cache 嘅邊界檔先跑得 --check")
    proc = subprocess.run(
        [str(PY), str(GEN_SCRIPT), "--check"],
        cwd=str(REPO),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.returncode == 0, (
        f"gen_fallback_anchors.py --check 失敗：\n{proc.stdout}\n{proc.stderr}"
    )

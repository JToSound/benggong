#!/usr/bin/env python3
"""《病港》風格地圖渲染器 —— 手繪古地圖 / 水彩紙質。

為何唔用 AI 圖像生成做底圖
==========================
本專案嘅地圖係**互動故事地圖**：標記要對應真實香港座標，前端要 pan / zoom /
疊 marker。AI 圖像模型有三個無法繞過嘅問題：

1. **地理唔準** —— 生成模型唔會跟真實海岸線，將軍澳同西貢會走位。
2. **中文必亂** —— 生成模型畫唔出可讀嘅中文字，街道名會變鬼畫符。
3. **不可稽核** —— 專案要求 deterministic、可 hash 驗證；生成模型每次唔同。

所以底圖用**程序化渲染**：由真實 OSM 資料砌出陸地遮罩，再用 fractal noise
合成古地圖質感。風格（陳年紙、橄欖綠陸地、深青海洋、暗紅棕標籤、手繪圖示）
完全跟到參考圖，同時保住地理準確、可重跑、可驗證。

風格規格（對照官方認可參考圖）
==============================
- 海洋：深青綠底 + **域扭曲大理石脈理**（流線狀，非雲團狀），近岸較淺
- 淺灘：貼岸光環 + 岸線墨邊 + 陸側沙線（三層，令海岸銳利）
- 陸地：淡橄欖黃 + 多尺度水彩斑駁 + 山體陰影 + 高處青灰
- 市區：由**建築密度場**推導嘅建成區淡染 + 細斜網線
- 內陸水：水塘 / 湖 / 河（`natural=water`）實色 + 墨邊
- 樹木：抖動網格 + 叢聚密度場，集中山野
- 標籤：暗紅棕楷體 + 多層描邊光暈
- 整體：低對比、陳舊、紙纖維顆粒、暗角

實作要點（三個容易踩嘅坑）
==========================
1. **fBm 對比度**：多層均勻亂數相加會高度集中喺 0.5（σ≈0.12），直接用
   會變平色。所有 noise 場都要先過 `stretch()`。
2. **脊狀紋理**：`1-|2n-1|` 一定要先拉伸 n，否則 `|2n-1|≈0` 令全圖都係脊。
3. **紋理各向異性**：fBm 各向同性 → 等值線係閉合雲團。壓扁垂直方向
   （`stretch<1`）才會拉長成流線，即大理石紋。

用法：
    python scripts/render_binggang_map.py --width 2048
    python scripts/render_binggang_map.py --width 2048 --crop none
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage

REPO = Path(__file__).resolve().parent.parent
CACHE_PATH = REPO / "data" / "private" / "cache" / "osm-hk.json"
BOUNDARY_PATH = REPO / "data" / "private" / "cache" / "hk-boundary.geojson"
DEFAULT_OUT = REPO / "public" / "assets" / "binggang-map.png"
DEFAULT_COORDS = REPO / "public" / "assets" / "binggang-map-coords.json"

HK_BBOX = {
    "lon_min": 113.79,
    "lon_max": 114.49,
    "lat_min": 22.11,
    "lat_max": 22.61,
}

# 目前生效嘅 bbox（可由 --bbox 覆寫，用嚟做分區 / 街道級 LOD 渲染）
ACTIVE_BBOX: dict[str, float] = dict(HK_BBOX)

# 縮放層級：bbox 經度跨度 → 要開邊啲細節圖層
#
# 為何用「跨度」而唔係 zoom 數字
# ----------------------------
# 渲染器嘅輸出尺寸固定（例如 2048 px），所以 bbox 越窄 = 每像素覆蓋越少
# 真實距離 = 實際放大。用跨度判斷最直接：
#   0.70°  全港總覽   → 建築係亞像素（20 m ≈ 0.36 px），畫咗都係污點
#   0.20°  區域（將軍澳 / 西貢）
#   0.08°  分區       → 建築開始可見（20 m ≈ 3 px）
#   0.03°  街道       → 建築清晰（20 m ≈ 8 px）
LOD_TIERS = [
    # (最大經度跨度, 名稱, 畫道路, 畫建築, 畫樓宇標籤)
    #
    # 門檻要同 `build_map_lods.py` 嘅層級 bbox 對齊：
    #   overview 0.70° / region 0.20° / district 0.11° / street 0.06°
    # 每級留約 8–15% 餘裕，避免 bbox 微調就跌落下一級。
    #
    # 各級解析度（1536–2048 px 畫布）：
    #   overview  47 m/px → 建築 0.4 px、道路 <1 px：兩者都唔畫
    #   region    13 m/px → 主要道路約 2 px：畫路；建築 1.5 px：唔畫
    #   district   7 m/px → 道路 3 px、建築 3 px：兩者都畫
    #   street     4 m/px → 道路 6 px、建築 5 px：加樓宇標籤
    # ⚠️ 新增 0.45° 一級。
    #
    # 為何：`build_map_lods.py` 加咗全港分區層（hk-nw/ne/sw/se，各 0.35°）
    # 之後，原本 0.900 嘅門檻會令佢哋被判為 `overview`（唔畫道路）——
    # 但 0.35° 喺 2048 px 畫布下係 **17 m/px**，道路有 1–2 px 闊，
    # 畫得出而且有資訊價值。實測 `phase-j-lod` 測試報
    # 「hk-nw 應該有道路圖層」。
    #
    # 所以喺 0.45–0.90 之間加一級「regional overview」：畫路唔畫樓。
    (0.900, "overview", False, False, False),
    (0.450, "regional", True, False, False),
    (0.260, "region", True, False, False),
    (0.120, "district", True, True, False),
    (0.070, "street", True, True, True),
]


def pick_lod(lon_span: float) -> tuple[str, bool, bool, bool]:
    """按 bbox 經度跨度揀 LOD 層級。

    必須用**升序**掃：搵第一個「容納得落呢個跨度」嘅最窄層級。
    如果照 LOD_TIERS 原本嘅闊→窄次序掃，`lon_span <= 0.900` 會即刻命中
    overview，令所有分區圖都永遠唔開道路／建築圖層。
    """
    for max_span, name, roads, buildings, b_labels in sorted(LOD_TIERS):
        if lon_span <= max_span:
            return name, roads, buildings, b_labels
    return "street", True, True, True


# ---------------------------------------------------------------------------
# 投影（等距圓柱 / equirectangular，標準緯線 = 香港中位緯度）
#
# 為何一定要做長寬比校正
# ----------------------
# 香港陸地實際範圍約 0.62° 經 × 0.44° 緯。喺北緯 22.36°，
# 1° 經度 ≈ 111.32 × cos(22.36°) ≈ 103.0 km，1° 緯度 ≈ 110.6 km。
# 即係「1 度緯度」喺地圖上應該比「1 度經度」長 1/cos(φ) ≈ 1.081 倍。
#
# 舊底圖用正方形 2048×2048 畫 0.6°×0.37°：
#   經度方向 61.8 km / 2048 px，緯度方向 41.1 km / 2048 px
# → 垂直被拉伸 1.51 倍，香港睇落高咗一半。
# 本渲染器改為按真實比例計高度，杜絕變形。
# ---------------------------------------------------------------------------
LAT0 = (HK_BBOX["lat_min"] + HK_BBOX["lat_max"]) / 2.0
_LAT0 = LAT0
_COS_LAT0 = float(np.cos(np.radians(LAT0)))

CANVAS_W = 2048
CANVAS_H = 2048


def configure_canvas(
    width: int, bbox: dict[str, float] | None = None
) -> tuple[int, int]:
    """按 bbox 真實長寬比計出畫布高度，並更新投影常數。

    `bbox` 傳入時會切換 ACTIVE_BBOX —— 呢個係 LOD 縮放嘅基礎：
    輸出尺寸固定，改細 bbox 就等於放大，細節圖層隨之開啟。
    """
    global CANVAS_W, CANVAS_H, ACTIVE_BBOX, _LAT0, _COS_LAT0
    if bbox is not None:
        for k in ("lon_min", "lon_max", "lat_min", "lat_max"):
            if k not in bbox:
                raise ValueError(f"bbox 缺少 {k}")
        if bbox["lon_max"] <= bbox["lon_min"] or bbox["lat_max"] <= bbox["lat_min"]:
            raise ValueError("bbox 無效：max 必須大於 min")
        ACTIVE_BBOX = dict(bbox)
    _LAT0 = (ACTIVE_BBOX["lat_min"] + ACTIVE_BBOX["lat_max"]) / 2.0
    _COS_LAT0 = float(np.cos(np.radians(_LAT0)))
    lon_span = ACTIVE_BBOX["lon_max"] - ACTIVE_BBOX["lon_min"]
    lat_span = ACTIVE_BBOX["lat_max"] - ACTIVE_BBOX["lat_min"]
    px_per_deg_lon = width / lon_span
    px_per_deg_lat = px_per_deg_lon / _COS_LAT0
    CANVAS_W = int(round(width))
    CANVAS_H = int(round(lat_span * px_per_deg_lat))
    return CANVAS_W, CANVAS_H

# ---------------------------------------------------------------------------
# 調色板 —— 直接取自官方認可參考圖
# ---------------------------------------------------------------------------
PALETTE = {
    # 海洋：深青綠，帶大理石紋
    "sea_deep":   (30, 56, 54),
    "sea_mid":    (52, 88, 80),
    "sea_shallow": (92, 130, 114),
    "sea_rim":    (146, 174, 150),   # 貼岸淺灘光環
    # 陸地：淡橄欖黃（參考圖 2 偏黃，圖 1 偏褐）
    "land_pale":  (232, 226, 166),
    "land_base":  (211, 203, 137),
    "land_dark":  (172, 168, 104),
    "land_high":  (150, 148, 92),
    "land_wash":  (196, 188, 122),   # 水彩暈染中間調
    # 內陸水（水塘 / 湖）
    "inland_water": (58, 96, 86),
    "inland_deep":  (40, 72, 68),
    # 市區（建成區淡染 + 細網線）
    "urban_tint": (198, 190, 126),
    "urban_line": (146, 140, 90),
    # 道路 / 建築（LOD 分區級以上）
    "road":       (226, 218, 178),   # 路面：比陸地略淺，似手繪留白
    "building_lg": (196, 166, 130),  # 大型建築（商廈 / 工業）：暖褐
    "building_sm": (211, 185, 146),  # 小型建築（村屋 / 住宅）：暖米
    "building_ink": (96, 78, 52),    # 建築墨邊
    # 線 / 墨
    "coast_line": (66, 58, 40),
    "shore_ink":  (110, 100, 66),    # 岸內側沙線
    "ink":        (58, 44, 32),
    "ink_label":  (118, 48, 34),   # 暗紅棕（地名）
    "ink_region": (92, 38, 28),    # 更深（大區域名）
    "tree":       (78, 100, 60),
    "tree_dark":  (54, 76, 44),
    "paper":      (233, 226, 198),
}

# ---------------------------------------------------------------------------
# 地名標籤（策展清單）
#
# 為何唔由 OSM 抽：Overpass cache 用 `out geom` 只取 way / relation，
# **完全冇 node**，所以 `place=*` 嘅 node 標籤攞唔到；而 way 上嘅 place
# 只有 30 個，仲混雜深圳地名（南头古城、罗湖金岸…）。
# 地區名屬事實性地理資料（非版權內容），用策展清單反而更準、更可控、
# 更 deterministic。
#
# TODO(phase-j): 搬去 data/public/map-labels.json 並加 schema 驗證。
# ---------------------------------------------------------------------------
REGION_LABELS: list[tuple[str, float, float, int]] = [
    # (名稱, 經度, 緯度, 等級 0=大區 1=城鎮 2=細區)
    ("新界", 114.130, 22.430, 0),
    ("九龍", 114.185, 22.325, 0),
    ("香港島", 114.155, 22.265, 0),
    ("大嶼山", 113.960, 22.270, 0),
    ("西貢半島", 114.320, 22.390, 0),
    # 城鎮 / 區
    ("西貢", 114.273, 22.382, 1),
    ("將軍澳", 114.258, 22.310, 1),
    ("調景嶺", 114.252, 22.304, 2),
    ("坑口", 114.266, 22.317, 2),
    ("寶琳", 114.256, 22.323, 2),
    ("康城", 114.272, 22.295, 2),
    ("觀塘", 114.226, 22.320, 1),
    ("九龍城", 114.192, 22.328, 1),
    ("旺角", 114.170, 22.319, 1),
    ("深水埗", 114.163, 22.331, 1),
    ("黃大仙", 114.196, 22.342, 1),
    ("尖沙咀", 114.172, 22.297, 1),
    ("中環", 114.158, 22.282, 1),
    ("銅鑼灣", 114.185, 22.280, 1),
    ("香港仔", 114.155, 22.248, 1),
    ("赤柱", 114.216, 22.216, 1),
    ("沙田", 114.188, 22.382, 1),
    ("大埔", 114.168, 22.450, 1),
    ("粉嶺", 114.140, 22.492, 1),
    ("上水", 114.128, 22.502, 1),
    ("元朗", 114.033, 22.444, 1),
    ("屯門", 113.977, 22.392, 1),
    ("荃灣", 114.113, 22.371, 1),
    ("葵涌", 114.135, 22.360, 1),
    ("東涌", 113.943, 22.289, 1),
    ("大澳", 113.852, 22.253, 2),
    ("長洲", 114.028, 22.210, 2),
    ("南丫島", 114.117, 22.200, 2),
    ("坪洲", 114.038, 22.286, 2),
]


# ---------------------------------------------------------------------------
# 幾何 helper
# ---------------------------------------------------------------------------
def lonlat_to_px(lon: float, lat: float) -> tuple[float, float]:
    """經緯度 → 像素（等距圓柱投影，已做長寬比校正）。"""
    b = ACTIVE_BBOX
    px_per_deg_lon = CANVAS_W / (b["lon_max"] - b["lon_min"])
    px_per_deg_lat = px_per_deg_lon / _COS_LAT0
    return (lon - b["lon_min"]) * px_per_deg_lon, (b["lat_max"] - lat) * px_per_deg_lat


def way_points(el: dict[str, Any]) -> list[tuple[float, float]]:
    return [(g["lon"], g["lat"]) for g in el.get("geometry", []) or []]


def rel_rings(el: dict[str, Any]) -> list[list[tuple[float, float]]]:
    """relation → 每條 member way 一個 ring（用 outer 優先）。"""
    out: list[list[tuple[float, float]]] = []
    for m in el.get("members", []) or []:
        if m.get("type") != "way":
            continue
        if m.get("role") not in ("outer", "", None):
            continue
        pts = [(g["lon"], g["lat"]) for g in m.get("geometry", []) or []]
        if len(pts) >= 3:
            out.append(pts)
    return out


def to_px_poly(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [lonlat_to_px(p[0], p[1]) for p in pts]


def boundary_rings() -> list[list[tuple[float, float]]]:
    """讀香港行政邊界，回傳 ring 清單（lon, lat）。

    容忍三種格式：FeatureCollection / 單一 Feature / 裸 geometry
    （Nominatim 直接回 Polygon 時就係第三種）。
    """
    if not BOUNDARY_PATH.exists():
        return []
    gj = json.loads(BOUNDARY_PATH.read_text(encoding="utf-8"))
    geoms: list[dict[str, Any]] = []
    if gj.get("type") == "FeatureCollection":
        geoms = [f.get("geometry", {}) for f in gj.get("features", [])]
    elif gj.get("type") == "Feature":
        geoms = [gj.get("geometry", {})]
    elif gj.get("type") in ("Polygon", "MultiPolygon"):
        geoms = [gj]

    rings: list[list[tuple[float, float]]] = []
    for geom in geoms:
        gt = geom.get("type")
        if gt == "Polygon":
            for ring in geom.get("coordinates", []):
                rings.append([(c[0], c[1]) for c in ring])
        elif gt == "MultiPolygon":
            for poly in geom.get("coordinates", []):
                for ring in poly:
                    rings.append([(c[0], c[1]) for c in ring])
    return rings


# ---------------------------------------------------------------------------
# Fractal noise（用嚟做紙紋、海面大理石紋、陸地斑駁）
# ---------------------------------------------------------------------------
def _upsample(grid: np.ndarray, w: int, h: int) -> np.ndarray:
    """把低解像格子雙三次放大到 w×h。"""
    img = Image.fromarray(grid.astype(np.float32), mode="F")
    return np.asarray(img.resize((w, h), Image.BICUBIC), dtype=np.float32)


def fbm(
    w: int,
    h: int,
    octaves: int = 5,
    base_cells: int = 4,
    gain: float = 0.5,
    seed: int = 0,
    stretch: float = 1.0,
) -> np.ndarray:
    """分形布朗運動（多層 value noise 疊加），輸出 0–1。

    `stretch` < 1 會壓扁垂直方向 → 得到橫向長條紋（用嚟做紙纖維、
    海面水流痕）；> 1 則得到縱向紋。
    """
    rng = np.random.default_rng(seed)
    total = np.zeros((h, w), np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        c = base_cells * (2 ** o)
        gx = max(2, int(c))
        gy = max(2, int(round(c * h / w * stretch)))
        total += amp * _upsample(rng.random((gy, gx)).astype(np.float32), w, h)
        norm += amp
        amp *= gain
    return total / norm


def normalize(a: np.ndarray) -> np.ndarray:
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / (hi - lo) if hi > lo else np.zeros_like(a)


def stretch(a: np.ndarray, k: float = 2.6) -> np.ndarray:
    """以 0.5 為中心做線性對比拉伸，夾到 0–1。

    為何一定要做
    ------------
    fBm 係多層均勻亂數相加，根據中央極限定理，輸出會**高度集中喺 0.5
    附近**（實測標準差只有 ~0.12）。直接用會令所有紋理都變成一塊平色 ——
    呢個就係第一版陸地睇落「冇質感」嘅根本原因。
    拉伸後 ±0.12 變成 ±0.31，紋理層次才出得嚟。
    """
    return np.clip(0.5 + (a - 0.5) * k, 0.0, 1.0)


def ridged(a: np.ndarray, k: float = 2.8, sharp: float = 2.2) -> np.ndarray:
    """脊狀紋理：`(1 - |2n - 1|) ^ sharp`，n 先做對比拉伸。

    拉伸係必要步驟 —— 唔拉的話 n ≈ 0.5 幾乎到處都成立，`|2n-1|` ≈ 0
    會令整幅圖都係「脊」，得出平色而唔係脈理。
    """
    n = stretch(a, k)
    return np.power(1.0 - np.abs(2.0 * n - 1.0), sharp)


def domain_warp(
    field: np.ndarray, warp_x: np.ndarray, warp_y: np.ndarray, amount: float
) -> np.ndarray:
    """用兩個 noise 場扭曲 `field` 嘅取樣座標（雙線性重取樣）。

    為何要 domain warp
    ------------------
    直接對 fBm 做 `1-|2n-1|` 只會得到「一撻撻」嘅脊狀紋，睇落似雲唔似石。
    真實大理石脈理係**流動**嘅：紋路被另一個低頻場推歪，形成長而蜿蜒嘅
    條帶。參考圖 1 嘅海面正正就係呢種效果，所以一定要 warp。
    """
    h, w = field.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    sx = np.clip(xs + (warp_x - 0.5) * amount, 0.0, w - 1.001)
    sy = np.clip(ys + (warp_y - 0.5) * amount, 0.0, h - 1.001)
    x0 = np.floor(sx).astype(np.int32)
    y0 = np.floor(sy).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (sx - x0).astype(np.float32)
    fy = (sy - y0).astype(np.float32)
    return (
        field[y0, x0] * (1 - fx) * (1 - fy)
        + field[y0, x1] * fx * (1 - fy)
        + field[y1, x0] * (1 - fx) * fy
        + field[y1, x1] * fx * fy
    )


def poly_area_px(pts: list[tuple[float, float]]) -> float:
    """鞋帶公式算多邊形實際面積（px²）。

    為何唔用包圍盒面積
    ----------------
    包圍盒會嚴重高估斜向薄條：實測將軍澳分區有 2,525 個「水體」通過
    包圍盒過濾，但總面積只有 1,500 px —— 即平均每個 0.6 px，全部都係
    斜向明渠嘅外框。用真實面積過濾才可以濾走呢啲雜訊。
    """
    n = len(pts)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) * 0.5


def collect_polys(
    elements: list[dict[str, Any]],
    want: Any,
    min_px_area: float = 0.0,
) -> list[list[tuple[float, float]]]:
    """收集符合 `want(tags)` 嘅 way / relation 多邊形（已投影為像素）。

    relation 會展開為每條 outer member 一個 ring；**實際面積**太細嘅會
    濾走（水體 / 建成區有大量幾 px 嘅碎件，畫出嚟只會變污點）。
    """
    out: list[list[tuple[float, float]]] = []
    for el in elements:
        tags = el.get("tags") or {}
        if not want(tags):
            continue
        rings: list[list[tuple[float, float]]] = []
        if el.get("type") == "way":
            geom = el.get("geometry") or []
            if geom:
                lons = [g["lon"] for g in geom]
                lats = [g["lat"] for g in geom]
                if not _bbox_hits(lons, lats):
                    continue
            pts = to_px_poly(way_points(el))
            if len(pts) >= 3:
                rings.append(pts)
        elif el.get("type") == "relation":
            rings = [to_px_poly(r) for r in rel_rings(el)]
        for pts in rings:
            if len(pts) < 3:
                continue
            if poly_area_px(pts) < min_px_area:
                continue
            out.append(pts)
    return out


def polys_to_mask(
    polys: list[list[tuple[float, float]]], shrink: int = 0
) -> np.ndarray:
    """多邊形清單 → bool 遮罩。"""
    W, H = CANVAS_W, CANVAS_H
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    for pts in polys:
        d.polygon(pts, fill=255)
    arr = np.asarray(m) > 127
    if shrink > 0:
        arr = ndimage.binary_erosion(arr, iterations=shrink)
    return arr


# ---------------------------------------------------------------------------
# 陸地遮罩
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 海岸線拓樸修復
# ---------------------------------------------------------------------------
def coastline_bridges(
    elements: list[dict[str, Any]], max_gap_m: float = 6000.0, verbose: bool = True
) -> tuple[list[tuple[tuple[float, float], tuple[float, float]]], int]:
    """用節點圖搵出海岸線嘅自由端，就近配對補線封口。

    為何一定要補線（而唔係加粗屏障）
    --------------------------------
    本 OSM 抽取嘅 1,603 條 `natural=coastline` way 會斷成 **876 個連通
    分量**。斷口係真實資料缺口，唔係渲染誤差 —— 例如大嶼山主體
    （分量 8,514 節點）嘅西岸有 **3,504 m** 缺口，大澳（分量 504）同
    主體之間亦斷開。

    後果：舊做法「由維港 flood fill 搵海」會令海水由缺口灌入島嶼內部，
    實測大嶼山陸地只剩 **3.1%**（應該約 60%）。

    為何唔可以靠「加粗屏障」了事
    ----------------------------
    把屏障由 2 px 加粗到 6 px，大嶼山陸地會「恢復」到 78%，但呢個係
    **假修復**：真正發生嘅係維港入口被加粗嘅線封死，海水被困死喺細範圍，
    於是全港陸地由 184,727 px 暴漲到 475,330 px（2.6 倍）。所以必須由
    **拓樸層面**把開放鏈駁成閉環。

    做法：degree-1 嘅節點就係鏈嘅自由端；把所有自由端按距離貪心配對
    （每個端只用一次，超過 `max_gap_m` 唔配），再畫直線補上。

    回傳 (補線段清單, 自由端總數)。
    """
    coast = [
        e
        for e in elements
        if e.get("type") == "way" and (e.get("tags") or {}).get("natural") == "coastline"
    ]
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        r = x
        while parent[r] != r:
            r = parent[r]
        while parent[x] != r:
            parent[x], x = r, parent[x]
        return r

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    adj: dict[int, set[int]] = {}
    coord: dict[int, tuple[float, float]] = {}
    for e in coast:
        nd = e.get("nodes") or []
        for n in nd:
            parent.setdefault(n, n)
            adj.setdefault(n, set())
        for n, g in zip(nd, e.get("geometry") or []):
            coord[n] = (g["lon"], g["lat"])
        for a, b in zip(nd, nd[1:]):
            if a == b:
                continue
            adj[a].add(b)
            adj[b].add(a)
            union(a, b)

    ends = [n for n, nb in adj.items() if len(nb) == 1]
    if not ends:
        return [], 0

    pts = np.array([coord[n] for n in ends], dtype=np.float64)
    # 度數 → 米（經度要乘 cos(lat)）
    m_per_deg_lon = 111320.0 * _COS_LAT0
    m_per_deg_lat = 110570.0
    xy = np.column_stack([pts[:, 0] * m_per_deg_lon, pts[:, 1] * m_per_deg_lat])

    from scipy.spatial import cKDTree

    tree = cKDTree(xy)
    pairs = sorted(tree.query_pairs(max_gap_m), key=lambda p: float(np.hypot(*(xy[p[0]] - xy[p[1]]))))

    used: set[int] = set()
    bridges: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for i, j in pairs:
        if i in used or j in used:
            continue
        used.add(i)
        used.add(j)
        bridges.append((tuple(pts[i]), tuple(pts[j])))  # type: ignore[arg-type]

    if verbose:
        print(
            f"  coastline topology: {len(coast)} ways, {len(ends)} free ends, "
            f"bridged {len(bridges)} gaps (<= {max_gap_m/1000:.0f} km)"
        )
    return bridges, len(ends)


# ---------------------------------------------------------------------------
# 海域種子
#
# 為何唔可以只用一個維港種子
# --------------------------
# LOD 縮放時畫布可能完全唔包含維多利亞港（例如渲染沙田 / 上水）。原本
# 「由維港 flood fill」嘅做法會直接越界失敗。
#
# 為何又唔可以手揀一堆海點
# ------------------------
# **手揀海點極危險**：實測吐露港（114.230, 22.440）同后海灣
# （113.980, 22.460）兩個「海點」其實落喺陸地。種子一旦落喺陸地，
# flood fill 就會由陸地蔓延，把整個新界變成「海」—— 實測全港陸地由
# 26.3% 暴跌到 7.1%。
#
# 所以最終做法：全港視窗只用唯一可信種子（維港）；LOD 視窗則由
# `_global_sea_points()` 提供**驗證過係海**嘅點。
#
# 內陸視窗（例如沙田）冇任何海點命中 → sea 為空 → 全部非屏障像素當
# 陸地，呢個對內陸分區圖係正確結果。
# ---------------------------------------------------------------------------
SEA_SEEDS: list[tuple[str, float, float]] = [
    ("維多利亞港", 114.165, 22.293),
]

# 郊野判定：離最近「已開發」像素幾多米就當係山野。
#
# 調校紀錄（分區尺度 0.07° 視窗實測樹木數）
# ------------------------------------------
#   16 m（原本嘅像素門檻，街道級等效）→ 9,875 棵 —— 市區內都長樹，明顯錯誤
#   600 m → 624 棵 —— 清水灣郊野公園變禿，太疏
#   400 m → 757 棵
#   250 m → 1,504 棵 —— 樹集中成叢，似手繪地圖嘅森林符號，採用
WILD_DIST_M = 250.0

# 全港尺度陸地遮罩快取（用嚟驗證 LOD 視窗嘅海域種子）
_GLOBAL_LAND: np.ndarray | None = None
_GLOBAL_BBOX: dict[str, float] = dict(HK_BBOX)
_GLOBAL_SIZE = 1024


def px_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """像素 → 經緯度（`lonlat_to_px` 嘅反函數）。"""
    b = ACTIVE_BBOX
    px_per_deg_lon = CANVAS_W / (b["lon_max"] - b["lon_min"])
    px_per_deg_lat = px_per_deg_lon / _COS_LAT0
    return b["lon_min"] + x / px_per_deg_lon, b["lat_max"] - y / px_per_deg_lat


def _global_sea_on_view(elements: list[dict[str, Any]]) -> np.ndarray:
    """把全港海陸圖重取樣到目前視窗嘅像素格（nearest neighbour）。

    回傳 bool 遮罩：True = 全港圖話呢個像素係海。
    """
    gmask, gbbox = _global_land_mask(elements)
    gh, gw = gmask.shape
    W, H = CANVAS_W, CANVAS_H
    b = ACTIVE_BBOX
    lon_span = b["lon_max"] - b["lon_min"]
    lat_span = b["lat_max"] - b["lat_min"]
    xs = b["lon_min"] + (np.arange(W) + 0.5) / W * lon_span
    ys = b["lat_max"] - (np.arange(H) + 0.5) / H * lat_span
    gx = ((xs - gbbox["lon_min"]) / (gbbox["lon_max"] - gbbox["lon_min"]) * gw).astype(np.int32)
    gy = ((gbbox["lat_max"] - ys) / (gbbox["lat_max"] - gbbox["lat_min"]) * gh).astype(np.int32)
    np.clip(gx, 0, gw - 1, out=gx)
    np.clip(gy, 0, gh - 1, out=gy)
    return ~gmask[np.ix_(gy, gx)]


def _compute_mask(
    elements: list[dict[str, Any]],
    seed_points: list[tuple[float, float]],
    verbose: bool = False,
    sea_ref: np.ndarray | None = None,
) -> np.ndarray:
    """按**目前畫布**光柵化海岸線 + 行政界，再判定海陸。

    海陸判定有兩條路
    ----------------
    A. `sea_ref is None` → 由 `seed_points` 做連通分量 flood fill。
       適用於全港視窗（維港種子可信）。
    B. `sea_ref` 提供 → **連通分量多數表決**（見下）。

    為何 LOD 視窗唔可以用 flood fill
    ------------------------------
    flood fill 要求視窗內嘅海岸線**完整分隔**海陸。但高縮放時視窗可能
    完全冇海岸線 way —— 實測將軍澳市中心（114.248–114.276 / 22.300–22.322）
    bbox 內零條海岸線，於是海水種子嘅連通分量覆蓋全畫布，`land = 0.0%`。

    多數表決做法：先做連通分量，再逐個分量問「全港海陸圖話呢個分量
    有幾多比例係海」。> 50% 就當海。
      - 海岸線完整時，每個分量本身純粹 → 結果係**高解析度**邊界。
      - 海岸線缺失時，分量混合 → 退化成全港圖嘅粗邊界（~70 m），
        但唔會出現「整幅圖變陸地」嘅災難性錯誤。
    即係話：精度按資料可用性自動降級，而唔係直接失效。
    """
    W, H = CANVAS_W, CANVAS_H
    barrier = Image.new("L", (W, H), 0)
    bd = ImageDraw.Draw(barrier)

    coast_w = max(2, W // 700)
    n_coast = 0
    for el in elements:
        if el.get("type") != "way":
            continue
        if (el.get("tags") or {}).get("natural") != "coastline":
            continue
        pts = to_px_poly(way_points(el))
        if len(pts) >= 2:
            bd.line(pts, fill=255, width=coast_w, joint="curve")
            n_coast += 1

    bridges, n_ends = coastline_bridges(elements, verbose=False)
    for a, b in bridges:
        bd.line([lonlat_to_px(*a), lonlat_to_px(*b)], fill=255, width=coast_w)

    rings = boundary_rings()
    ring_px: list[list[tuple[float, float]]] = []
    for ring in rings:
        pts = to_px_poly(ring)
        if len(pts) >= 3:
            ring_px.append(pts)
            bd.line(pts + [pts[0]], fill=255, width=coast_w)

    bmask = np.asarray(barrier) > 127

    # 行政界「內部」：邊界環同畫布相交才需要填色，否則視窗本身就喺境內
    touches = False
    for pts in ring_px:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        if max(xs) >= 0 and min(xs) <= W and max(ys) >= 0 and min(ys) <= H:
            touches = True
            break
    if touches:
        inside = Image.new("L", (W, H), 0)
        idd = ImageDraw.Draw(inside)
        for pts in ring_px:
            idd.polygon(pts, fill=255)
        inside_mask = np.asarray(inside) > 127
    else:
        inside_mask = np.ones((H, W), dtype=bool)

    free = ~bmask
    labels, _ = ndimage.label(free)
    sea = np.zeros((H, W), dtype=bool)
    n_used = 0

    if sea_ref is not None:
        flat = labels.ravel()
        valid = flat > 0
        n_lab = int(labels.max()) + 1
        counts = np.bincount(flat[valid], minlength=n_lab)
        sea_counts = np.bincount(
            flat[valid & sea_ref.ravel()], minlength=n_lab
        )
        frac = sea_counts / np.maximum(counts, 1)
        lut = frac > 0.5
        lut[0] = False
        sea = lut[labels] & free
        n_used = int(lut.sum())
    else:
        used_labels: set[int] = set()
        for lon, lat in seed_points:
            sx_f, sy_f = lonlat_to_px(lon, lat)
            sx, sy = int(round(sx_f)), int(round(sy_f))
            if not (0 <= sx < W and 0 <= sy < H):
                continue
            lab = int(labels[sy, sx])
            if lab == 0:
                lab = _nearest_free_label(labels, sx, sy, W, H)
            if lab != 0 and lab not in used_labels:
                used_labels.add(lab)
                sea |= labels == lab
                n_used += 1
        sea &= free

    land = inside_mask & (~sea) & (~bmask)
    if verbose:
        mode = "majority-vote" if sea_ref is not None else "flood-fill"
        print(
            f"  land mask: coast ways={n_coast}, bridged ends={n_ends}, "
            f"{mode} units={n_used}, land px={land.sum():,} ({land.mean() * 100:.1f}%)"
        )
    return land


def _global_land_mask(
    elements: list[dict[str, Any]],
) -> tuple[np.ndarray, dict[str, float]]:
    """全港尺度陸地遮罩（唯一可信種子：維多利亞港），帶 bbox 供查表。

    為何唔可以靠「抽一批海點」做 LOD 種子
    ----------------------------------
    原本做法係由全港海陸圖抽約 6,000 個海點，再揀落喺視窗內嘅做種子。
    但密度係每 95 px（全港尺度）一個點 —— 細視窗（例如將軍澳市中心
    0.028°）嘅海可能一個點都冇，於是 `seeds used=0`，整幅圖被當成陸地
    （實測 land = 99.9%，明顯錯誤）。

    改為：視窗內用網格逐點查全港海陸圖，並要求 3×3 鄰域全部係海。
    咁樣保證覆蓋，同時避免岸邊誤判。
    """
    global _GLOBAL_LAND, _GLOBAL_BBOX, _LAT0, _COS_LAT0
    if _GLOBAL_LAND is not None:
        return _GLOBAL_LAND, _GLOBAL_BBOX

    saved_bbox = dict(ACTIVE_BBOX)
    saved_w, saved_h = CANVAS_W, CANVAS_H
    saved_lat0, saved_cos = _LAT0, _COS_LAT0
    try:
        configure_canvas(_GLOBAL_SIZE, HK_BBOX)
        land = _compute_mask(elements, [(114.165, 22.293)])
        _GLOBAL_LAND = land
        _GLOBAL_BBOX = dict(ACTIVE_BBOX)
    finally:
        configure_canvas(saved_w, saved_bbox)
        _LAT0, _COS_LAT0 = saved_lat0, saved_cos
        globals()["CANVAS_H"] = saved_h
    return _GLOBAL_LAND, _GLOBAL_BBOX



def build_land_mask(elements: list[dict[str, Any]], verbose: bool = True) -> np.ndarray:
    """由海岸線 + 行政邊界砌出陸地遮罩（bool），尺寸 = CANVAS_W × CANVAS_H。

    原理
    ----
    1. 把 1,603 條 `natural=coastline` way 畫成粗線屏障。
    2. **補上拓樸缺口**（見 `coastline_bridges`）—— 唔補的話海水會灌入島嶼。
    3. 把香港行政邊界畫成屏障（防止向北漏入深圳陸地）。
    4. 由維多利亞港（全港視窗）或多個驗證過嘅海點（LOD 視窗）flood fill。
    5. 陸地 = 行政邊界內 ∧ 非海 ∧ 非屏障。

    LOD 相容性
    ----------
    分區級 bbox 會令行政邊界完全落喺畫布外，此時「邊界內」應該係全畫布
    （視窗本身就喺香港境內）。內陸分區（例如沙田）冇任何海點命中 →
    sea 為空 → 全部非屏障像素當陸地，呢個對內陸圖係正確結果。
    """
    b = ACTIVE_BBOX
    is_full = (
        abs(b["lon_min"] - HK_BBOX["lon_min"]) < 1e-9
        and abs(b["lon_max"] - HK_BBOX["lon_max"]) < 1e-9
        and abs(b["lat_min"] - HK_BBOX["lat_min"]) < 1e-9
        and abs(b["lat_max"] - HK_BBOX["lat_max"]) < 1e-9
    )
    if is_full:
        # 全港視窗：維港種子可信，直接用高解析度 flood fill
        return _compute_mask(
            elements, [(lon, lat) for _, lon, lat in SEA_SEEDS], verbose=verbose
        )
    # LOD 視窗：用全港海陸圖做多數表決（見 `_compute_mask` docstring）
    return _compute_mask(
        elements, [], verbose=verbose, sea_ref=_global_sea_on_view(elements)
    )



def _nearest_free_label(
    labels: np.ndarray, sx: int, sy: int, W: int, H: int, radius: int = 40
) -> int:
    """由 (sx, sy) 向外螺旋搵第一個非零 label。"""
    for r in range(1, radius):
        for dy in range(-r, r + 1):
            for dx in (-r, r):
                yy, xx = sy + dy, sx + dx
                if 0 <= yy < H and 0 <= xx < W and labels[yy, xx] != 0:
                    return int(labels[yy, xx])
        for dx in range(-r + 1, r):
            for dy in (-r, r):
                yy, xx = sy + dy, sx + dx
                if 0 <= yy < H and 0 <= xx < W and labels[yy, xx] != 0:
                    return int(labels[yy, xx])
    return 0


# ---------------------------------------------------------------------------
# 風格合成
# ---------------------------------------------------------------------------
def compose_style(
    land: np.ndarray,
    water: np.ndarray | None = None,
    urban: np.ndarray | None = None,
    seed: int = 20260915,
    vignette: float = 0.30,
    sea_depth: float = 1.0,
    terrain_amp: float = 1.0,
) -> Image.Image:
    """把陸地遮罩合成為《病港》風格底圖。

    圖層次序（由底到面）
    --------------------
    1. 海：深度漸變 → 域扭曲大理石脈理 → 水彩污漬 → 橫向水流痕
    2. 岸：海側淺灘光環 → 岸線墨邊 → 陸側沙線
    3. 陸：多尺度水彩斑駁 → 地勢山體陰影 → 陳舊暈染
    4. 建成區：淡染 + 細網線（做出參考圖 2 嘅市區密度感）
    5. 內陸水（水塘 / 湖）：實色 + 墨邊
    6. 紙：纖維條紋 + 顆粒 + 暗角

    `vignette` 由 LOD 決定：暗角代表「陳年紙張嘅邊緣」，只對全港總覽
    有意義。分區圖如果照用 0.30，位處畫面邊緣嘅海面會被壓到近乎黑色
    （實測將軍澳圖嘅藍塘海峽就係咁）。

    `sea_depth` 同理：水深漸變係**大尺度**特徵（香港水域幾十公里），
    分區圖只覆蓋幾公里，照用會令整片海飽和成最深色。所以分區圖把
    depth 壓向中間值（0.5），保留少許層次但唔會全黑。

    `terrain_amp` 係陸地層嘅變化幅度。山勢同水彩斑駁都係大尺度特徵：
    喺全港總覽睇得好靚，但喺街道級（2 km 視窗）同一組 noise 會變成
    一團一團嘅「雲」。所以高縮放時把陸地層嘅變化壓向平均值 ——
    紙紋（`paper` / `fibre`）喺之後才疊，唔受影響，仍然保留質感。
    """
    h, w = land.shape
    if water is None:
        water = np.zeros_like(land)
    if urban is None:
        urban = np.zeros_like(land)

    # --- 各種 noise 場（全部先做對比拉伸，否則會變平色） -----------------
    # 海面大理石：先做脊狀 fBm，再用兩個低頻場把取樣座標推歪。
    #
    # `stretch` 係關鍵：fBm 本身各向同性，等值線會係一團團閉合曲線
    # （睇落似雲）。壓扁垂直方向令等值線拉長成流線，才有大理石紋。
    # k 越大 → 等值線越陡 → 脈理越幼；sharp 再收窄亮帶。
    marble_src = fbm(w, h, octaves=7, base_cells=3, gain=0.56, seed=seed + 1, stretch=0.34)
    warp_x = fbm(w, h, octaves=4, base_cells=3, gain=0.5, seed=seed + 11, stretch=0.5)
    warp_y = fbm(w, h, octaves=4, base_cells=3, gain=0.5, seed=seed + 12, stretch=0.5)
    warped = domain_warp(marble_src, warp_x, warp_y, amount=w * 0.22)
    veins = ridged(warped, k=3.2, sharp=2.4)

    # 第二層細脈理（近岸更明顯）
    fine_src = fbm(w, h, octaves=6, base_cells=6, gain=0.5, seed=seed + 13)
    fine_warp = fbm(w, h, octaves=3, base_cells=5, gain=0.5, seed=seed + 14)
    fine = ridged(
        domain_warp(fine_src, fine_warp, fine_warp, w * 0.07), k=3.2, sharp=2.6
    )

    # 水流痕：橫向長條紋
    streak = stretch(
        fbm(w, h, octaves=4, base_cells=5, gain=0.5, seed=seed + 15, stretch=0.22), 2.2
    )

    land_mottle = stretch(fbm(w, h, octaves=5, base_cells=6, gain=0.5, seed=seed + 2), 3.1)
    land_blotch = stretch(fbm(w, h, octaves=4, base_cells=3, gain=0.55, seed=seed + 6), 2.7)
    land_fine = stretch(fbm(w, h, octaves=5, base_cells=16, gain=0.5, seed=seed + 7), 2.2)
    relief = fbm(w, h, octaves=5, base_cells=9, gain=0.52, seed=seed + 3)
    paper = stretch(fbm(w, h, octaves=7, base_cells=24, gain=0.5, seed=seed + 4), 1.8)
    fibre = stretch(
        fbm(w, h, octaves=4, base_cells=30, gain=0.5, seed=seed + 16, stretch=0.10), 2.0
    )
    stain = stretch(fbm(w, h, octaves=3, base_cells=3, gain=0.5, seed=seed + 5), 2.0)

    land_f = land.astype(np.float32)
    # 距離陸地幾遠（像素），用嚟做淺灘光環
    sea_dist = ndimage.distance_transform_edt(~land)
    land_dist = ndimage.distance_transform_edt(land)

    # --- 海洋 ------------------------------------------------------------
    # 深度漸變嘅模糊半徑要**隨畫布闊度**縮放，否則分區圖嘅海水會喺離岸
    # 幾十像素內就飽和成最深色（實測將軍澳圖整片海變黑）。
    depth_blur = max(18.0, w * 0.013)
    depth = ndimage.gaussian_filter((~land).astype(np.float32), depth_blur)
    depth = normalize(depth)  # 近岸低、遠岸高
    if sea_depth != 1.0:
        depth = np.clip(0.5 + (depth - 0.5) * sea_depth, 0.0, 1.0)

    sea_img = np.zeros((h, w, 3), np.float32)
    for i in range(3):
        sea_img[..., i] = (
            PALETTE["sea_shallow"][i] * (1 - depth) + PALETTE["sea_deep"][i] * depth
        )

    # 大理石脈理：遠岸（深水）弱、近岸（淺水）強，做出參考圖嘅石紋。
    # 深水區嘅最低值唔可以太低，否則分區圖嘅外海會變成一塊平黑。
    vein_gain = 34.0 + 70.0 * (1.0 - depth)
    sea_img += (veins * vein_gain)[..., None] * np.array([0.60, 0.86, 0.80], np.float32)
    sea_img += (fine * 20.0)[..., None] * np.array([0.52, 0.78, 0.72], np.float32)
    # 水流痕：極淡，只做質感
    sea_img += ((streak - 0.5) * 15.0)[..., None] * np.array([0.55, 0.82, 0.76], np.float32)
    # 大範圍色調起伏（陳舊水彩感）
    sea_img += ((stain - 0.5) * 30.0)[..., None] * np.array([0.60, 0.92, 0.82], np.float32)
    # 淺灘光環：貼岸 1–14 px 提亮
    rim = np.clip(1.0 - sea_dist / max(4.0, w * 0.011), 0.0, 1.0)
    rim = np.power(rim, 1.7) * (~land)
    sea_img += (rim * 34.0)[..., None] * np.array([0.92, 1.0, 0.86], np.float32)

    # --- 陸地 ------------------------------------------------------------
    mottle = np.clip(
        0.46 * land_mottle + 0.32 * land_blotch + 0.22 * land_fine, 0, 1
    )
    land_img = np.zeros((h, w, 3), np.float32)
    for i in range(3):
        land_img[..., i] = (
            PALETTE["land_pale"][i] * mottle + PALETTE["land_dark"][i] * (1 - mottle)
        )
    # 中間調水彩層（令層次更豐富）
    wash = np.clip((land_blotch - 0.40) * 2.0, 0, 1)
    for i in range(3):
        land_img[..., i] += (PALETTE["land_wash"][i] - land_img[..., i]) * wash * 0.42

    # 地勢陰影（relief 梯度做 hillshade）
    #
    # 注意：relief 係低頻場，原始梯度數值極細（~1e-3），直接乘常數等於冇
    # 效果。一定要先正規化到 -1..1 才有立體感。
    relief_s = ndimage.gaussian_filter(relief, max(1.5, w / 320.0))
    gy, gx = np.gradient(relief_s)
    gnorm = gx + gy
    gmax = float(np.abs(gnorm).max()) or 1.0
    shade = np.clip(0.5 + (gnorm / gmax) * 1.5, 0.0, 1.0)
    land_img *= (0.72 + 0.50 * shade)[..., None]
    # 高處加淡青灰（山嶺感）
    high = np.clip((stretch(relief, 2.2) - 0.52) * 2.4, 0, 1)
    for i in range(3):
        land_img[..., i] += (PALETTE["land_high"][i] - land_img[..., i]) * high * 0.50
    # 陳舊斑（水彩暈染）
    land_img += ((stain - 0.5) * 40.0)[..., None] * np.array([1.00, 0.95, 0.62], np.float32)
    land_img += ((land_blotch - 0.5) * 34.0)[..., None] * np.array([0.92, 0.90, 0.56], np.float32)
    land_img += ((land_fine - 0.5) * 16.0)[..., None] * np.array([0.90, 0.88, 0.60], np.float32)

    # 高縮放時壓低陸地層變化幅度（見 docstring）：只保留局部質感，
    # 去掉喺細視窗內唔合理嘅大尺度「雲團」
    if terrain_amp < 1.0:
        lmean = land_img.reshape(-1, 3).mean(axis=0)
        land_img = lmean + (land_img - lmean) * terrain_amp

    # --- 建成區（市區淡染 + 細網線） ------------------------------------
    urban_soft = ndimage.gaussian_filter(urban.astype(np.float32), max(1.2, w / 900.0))
    urban_soft = np.clip(urban_soft, 0.0, 1.0)
    if urban_soft.max() > 0:
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        pitch = max(4.0, w / 300.0)
        # 斜網線，用 noise 調變粗細 → 避免變成死板印刷網屏
        hatch = ((xs + ys * 0.62) % pitch) / pitch
        hatch = np.clip(1.0 - np.abs(hatch - 0.5) * 2.0, 0.0, 1.0) ** 2.4
        hatch = ndimage.gaussian_filter(hatch, 0.45)
        hatch *= 0.55 + 0.85 * land_fine
        for i in range(3):
            land_img[..., i] += (
                PALETTE["urban_tint"][i] - land_img[..., i]
            ) * urban_soft * 0.15
            land_img[..., i] += (
                PALETTE["urban_line"][i] - land_img[..., i]
            ) * urban_soft * hatch * 0.13

    # --- 合成（海岸柔化過渡） -------------------------------------------
    alpha = np.clip(ndimage.gaussian_filter(land_f, 1.0), 0.0, 1.0)
    alpha = alpha[..., None]
    out = sea_img * (1 - alpha) + land_img * alpha

    # --- 海岸線：陸側沙線 → 墨邊（手繪感） ------------------------------
    hard = land_f
    edge = np.clip(hard - ndimage.grey_erosion(hard, size=5), 0.0, 1.0)
    edge = ndimage.gaussian_filter(edge, 0.7)
    out = out * (1 - edge[..., None] * 0.70) + np.array(
        PALETTE["coast_line"], np.float32
    ) * (edge[..., None] * 0.70)

    # 陸側沙線：離岸 2–9 px 嘅淡褐帶，令海岸唔會「貼住」海
    shore = np.clip(1.0 - land_dist / max(3.0, w * 0.009), 0.0, 1.0)
    shore = np.power(shore, 1.8) * land_f
    out = out * (1 - shore[..., None] * 0.30) + np.array(
        PALETTE["shore_ink"], np.float32
    ) * (shore[..., None] * 0.30)

    # --- 內陸水（水塘 / 湖） --------------------------------------------
    if water.any():
        walpha = np.clip(ndimage.gaussian_filter(water.astype(np.float32), 0.8), 0.0, 1.0)
        wdepth = ndimage.gaussian_filter(water.astype(np.float32), 5.0)
        wdepth = normalize(wdepth) if wdepth.max() > 0 else wdepth
        wat_img = np.zeros((h, w, 3), np.float32)
        for i in range(3):
            wat_img[..., i] = (
                PALETTE["inland_water"][i] * (1 - wdepth) + PALETTE["inland_deep"][i] * wdepth
            )
        wat_img += ((veins - 0.5) * 16.0)[..., None] * np.array([0.55, 0.78, 0.72], np.float32)
        wa = walpha[..., None]
        out = out * (1 - wa) + wat_img * wa
        # 水體墨邊
        wed = np.clip(
            water.astype(np.float32)
            - ndimage.grey_erosion(water.astype(np.float32), size=3),
            0.0,
            1.0,
        )
        wed = ndimage.gaussian_filter(wed, 0.6)
        out = out * (1 - wed[..., None] * 0.55) + np.array(
            PALETTE["ink"], np.float32
        ) * (wed[..., None] * 0.55)

    # --- 紙質：纖維 + 顆粒 + 暗角 ---------------------------------------
    out += ((fibre - 0.5) * 11.0)[..., None]
    out += ((paper - 0.5) * 16.0)[..., None]
    if vignette > 0:
        vig = _vignette(w, h, strength=vignette)
        out *= vig[..., None]

    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def _vignette(w: int, h: int, strength: float = 0.30) -> np.ndarray:
    """四角稍暗，做出舊紙邊緣感。"""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = w / 2.0, h / 2.0
    r = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (max(w, h) * 0.72)
    return np.clip(1.0 - strength * np.power(np.clip(r, 0, 1), 2.4), 0.0, 1.0)


# ---------------------------------------------------------------------------
# 手繪圖示
# ---------------------------------------------------------------------------
def draw_tree(
    d: ImageDraw.ImageDraw, x: float, y: float, s: float, color: tuple[int, int, int]
) -> None:
    """手繪松樹（三角形樹冠 + 樹幹）。"""
    d.polygon(
        [(x, y - s), (x - s * 0.62, y + s * 0.42), (x + s * 0.62, y + s * 0.42)],
        fill=color,
    )
    d.rectangle(
        [x - s * 0.10, y + s * 0.34, x + s * 0.10, y + s * 0.62], fill=color
    )


def draw_hut(
    d: ImageDraw.ImageDraw, x: float, y: float, s: float, color: tuple[int, int, int]
) -> None:
    """手繪小屋（三角頂 + 方形身）。"""
    d.rectangle([x - s * 0.44, y - s * 0.05, x + s * 0.44, y + s * 0.52], fill=color)
    d.polygon(
        [(x, y - s * 0.68), (x - s * 0.60, y - s * 0.02), (x + s * 0.60, y - s * 0.02)],
        fill=color,
    )


def build_urban_mask(
    elements: list[dict[str, Any]],
    land: np.ndarray,
    water: np.ndarray,
) -> tuple[np.ndarray, float]:
    """由建成區 / 建築物**密度**推導市區範圍。

    為何唔可以直接填色
    ------------------
    實測本 OSM 抽取嘅 `landuse=residential` 等 16,115 個多邊形，**包圍盒
    面積中位數只有 1 px²**（1280 畫布）—— 因為香港嘅建築物係 20–30 m 級，
    喺全港尺度下係**亞像素**。直接用 `polygon()` 填色只會得到 5,703 px
    （佔陸地 1.9%），等於完全隱形。

    正確做法：把每個多邊形當一個「點」光柵化，再做高斯核密度估計，
    最後按密度門檻取出連續嘅建成區。呢個方法保留真實分佈（九龍、荃灣、
    沙田、將軍澳會自然浮現），又唔受多邊形解析度限制。

    回傳 (市區遮罩, 門檻值)。
    """
    W, H = CANVAS_W, CANVAS_H
    dots = Image.new("L", (W, H), 0)
    dd = ImageDraw.Draw(dots)
    urban_use = {
        "residential", "industrial", "commercial", "retail", "railway", "depot",
        # ⚠️ 機場用地。實測赤鱲角（香港國際機場）只有 `landuse=industrial`
        # （貨運區），客運廊／停機坪係 `aeroway=terminal/apron/runway`，
        # 唔喺原本嘅名單之內 → 被當成未發展土地 → 睇落似樹林。
        "aerodrome", "airport",
    }
    n = 0
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        if tags.get("landuse") not in urban_use and "building" not in tags:
            continue
        pts = to_px_poly(way_points(el))
        if not pts:
            continue
        # 用多邊形質心落點，避免同一建築重複計
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        if 0 <= cx < W and 0 <= cy < H:
            dd.point((int(cx), int(cy)), fill=255)
            n += 1

    dot_np = (np.asarray(dots) > 127).astype(np.float32)
    sigma = max(2.5, W / 190.0)
    dens = ndimage.gaussian_filter(dot_np, sigma)
    # 用 **98 百分位**而唔係 max 做正規化。
    # 用 max 嘅話，只要有一個極密點（例如將軍澳某個大型屋苑），其餘地區
    # 嘅相對密度就會被壓到好低 —— 實測分區尺度下市區只剩 3.7%，等於隱形。
    # 百分位正規化令門檻跨尺度都穩定。
    land_vals = dens[land]
    ref = float(np.percentile(land_vals, 98)) if land_vals.size else 0.0
    if ref > 0:
        dens = np.clip(dens / ref, 0.0, 1.0)
    # 門檻：0.045 → 49% 陸地（過闊，全港建成區實際約 25%）；0.18 收窄到市區核心。
    thr = 0.18
    urban = (dens > thr) & land & (~water)
    if n == 0:
        urban = np.zeros_like(land)
    return urban, thr


# ---------------------------------------------------------------------------
# 道路 / 建築圖層（LOD 分區級以上）
#
# 為何呢兩層要按 LOD 開關
# ----------------------
# 香港有 42,758 條道路同 133,361 個建築多邊形。喺全港尺度（0.70° 跨度），
# 一幢 20 m 建築只佔 0.36 px —— 畫出嚟只會變成污點，反而破壞地圖。
# 但同一批資料喺分區尺度（0.08° 跨度）就變成 3 px，街道尺度（0.03°）
# 變成 8 px，自然呈現真實城市肌理。
#
# 所以「放大後顯示更加多細節」唔需要新資料來源 —— OSM cache 已經有齊，
# 只需要按 bbox 跨度決定要唔要畫。
# ---------------------------------------------------------------------------
ROAD_CLASSES: dict[str, tuple[float, float]] = {
    # 級別: (線寬倍數, 描邊倍數) —— 以 2048 畫布為基準
    "motorway": (3.2, 4.6),
    "trunk": (2.9, 4.2),
    "primary": (2.5, 3.7),
    "secondary": (2.1, 3.2),
    "tertiary": (1.7, 2.6),
    "unclassified": (1.3, 2.0),
    "residential": (1.3, 2.0),
    "service": (1.0, 1.6),
    "living_street": (1.1, 1.7),
    "pedestrian": (1.1, 1.7),
}


def _bbox_hits(lons: list[float], lats: list[float]) -> bool:
    """要素嘅經緯 bbox 有冇同 ACTIVE_BBOX 相交（平價前置過濾）。"""
    b = ACTIVE_BBOX
    return not (
        max(lons) < b["lon_min"]
        or min(lons) > b["lon_max"]
        or max(lats) < b["lat_min"]
        or min(lats) > b["lat_max"]
    )


def draw_roads(
    elements: list[dict[str, Any]], base: Image.Image, land: np.ndarray
) -> tuple[Image.Image, int]:
    """畫道路網：先描邊（casing）再填色，做出手繪地圖嘅雙線道路感。"""
    W, H = CANVAS_W, CANVAS_H
    scale = W / 2048.0
    casing = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fill = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(casing)
    fd = ImageDraw.Draw(fill)

    n = 0
    # 一次過分桶（避免每個級別都掃 198,300 個要素）
    buckets: dict[str, list[list[tuple[float, float]]]] = {k: [] for k in ROAD_CLASSES}
    for el in elements:
        if el.get("type") != "way":
            continue
        cls = (el.get("tags") or {}).get("highway")
        if cls not in buckets:
            continue
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        lons = [g["lon"] for g in geom]
        lats = [g["lat"] for g in geom]
        if not _bbox_hits(lons, lats):
            continue
        buckets[cls].append([(g["lon"], g["lat"]) for g in geom])

    # 由細到大畫，令大路壓住細路
    for cls in ("service", "living_street", "pedestrian", "residential",
                "unclassified", "tertiary", "secondary", "primary",
                "trunk", "motorway"):
        w_fill, w_case = ROAD_CLASSES[cls]
        wf = max(1, int(round(w_fill * scale)))
        wc = max(2, int(round(w_case * scale)))
        for lonlat in buckets[cls]:
            pts = to_px_poly(lonlat)
            cd.line(pts, fill=(*PALETTE["coast_line"], 150), width=wc, joint="curve")
            fd.line(pts, fill=(*PALETTE["road"], 190), width=wf, joint="curve")
            n += 1

    out = Image.alpha_composite(base.convert("RGBA"), casing)
    out = Image.alpha_composite(out, fill)
    return out, n


def draw_buildings(
    elements: list[dict[str, Any]], base: Image.Image, land: np.ndarray
) -> tuple[Image.Image, int]:
    """畫建築物多邊形（分區級以上 LOD）。

    風格：屋身用暖灰褐填色，加極細墨邊 —— 遠睇似手繪地圖嘅城市街廓，
    近睇逐幢可辨。
    """
    W, H = CANVAS_W, CANVAS_H
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    scale = W / 2048.0
    outline_w = 2 if scale >= 0.7 else 1

    n = 0
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        if "building" not in tags:
            continue
        geom = el.get("geometry") or []
        if len(geom) < 3:
            continue
        lons = [g["lon"] for g in geom]
        lats = [g["lat"] for g in geom]
        if not _bbox_hits(lons, lats):
            continue
        pts = to_px_poly([(g["lon"], g["lat"]) for g in geom])
        if len(pts) < 3:
            continue
        # 用多邊形面積揀色調：大廈略深、屋仔略淺
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        area = (max(xs) - min(xs)) * (max(ys) - min(ys))
        col = PALETTE["building_lg"] if area > 400 * scale * scale else PALETTE["building_sm"]
        d.polygon(pts, fill=(*col, 235), outline=(*PALETTE["building_ink"], 150), width=outline_w)
        n += 1

    return Image.alpha_composite(base.convert("RGBA"), layer), n


def build_green_mask(elements: list[dict[str, Any]], land: np.ndarray) -> np.ndarray:
    """計出「應該有樹」嘅範圍。

    為何唔可以直接用 OSM 綠地標籤
    ----------------------------
    實測本 OSM 抽取：`landuse=forest` 只有 281 個、`natural=wood` 只有 3 個、
    `leisure=nature_reserve` 只有 1 個 —— 香港郊野公園喺 OSM 主要靠
    `boundary=protected_area` / 專題圖層表達，唔喺一般 landuse 標籤內。
    單靠標籤會令全港只有 ~55 棵樹。

    所以改用**開發密度推導**：把道路同住宅／工業／商業用地畫成「已開發」
    遮罩，計距離場；遠離開發嘅陸地就係山野。呢個方法唔靠標籤完整性，
    結果亦更貼近參考圖（樹木集中山嶺、市區冇樹）。

    最終綠地 = 山野 ∪ OSM 綠地多邊形（公園 / 林地 / 花園）。

    尺度陷阱
    --------
    距離門檻一定要用**固定地理距離**，唔可以用像素數。原本寫死
    `max(6.0, W * 0.008)`，喺全港總覽（2048 px / 0.70°）等於 577 m，
    效果良好；但喺街道級（1600 px / 0.02°）只等於 **16 m** —— 即係話
    離馬路 16 m 就當係山野，結果成個將軍澳市中心都長滿樹。
    改用 600 m 固定距離後，各尺度表現一致。
    """
    W, H = CANVAS_W, CANVAS_H
    dev = Image.new("L", (W, H), 0)
    dd = ImageDraw.Draw(dev)
    developed_use = {
        "residential", "industrial", "commercial", "retail", "railway",
        # ⚠️ 機場用地 —— 見上面 urban_use 嘅註解。
        "aerodrome", "airport",
    }
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        pts: list[tuple[float, float]] | None = None
        # `aeroway=*`（客運廊、停機坪、跑道、機庫）亦係已發展土地。
        # 冇呢個判斷嘅話，香港國際機場會顯示成一片綠色。
        if (
            tags.get("landuse") in developed_use
            or "building" in tags
            or tags.get("aeroway")
        ):
            geom = el.get("geometry") or []
            if geom:
                lons = [g["lon"] for g in geom]
                lats = [g["lat"] for g in geom]
                if not _bbox_hits(lons, lats):
                    continue
            pts = to_px_poly(way_points(el))
            if pts and len(pts) >= 3:
                dd.polygon(pts, fill=255)
        elif tags.get("highway"):
            geom = el.get("geometry") or []
            if geom:
                lons = [g["lon"] for g in geom]
                lats = [g["lat"] for g in geom]
                if not _bbox_hits(lons, lats):
                    continue
            pts = to_px_poly(way_points(el))
            if pts and len(pts) >= 2:
                dd.line(pts, fill=255, width=max(2, W // 700))

    dev_np = np.asarray(dev) > 127
    dist = ndimage.distance_transform_edt(~dev_np)
    # 固定地理距離 → 換算成像素
    m_per_px = (ACTIVE_BBOX["lon_max"] - ACTIVE_BBOX["lon_min"]) * 111320.0 * _COS_LAT0 / W
    wild_px = WILD_DIST_M / max(m_per_px, 1e-6)
    wild = land & (dist > wild_px)

    # OSM 綠地多邊形
    gm = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(gm)
    green_tags = {"park", "garden", "nature_reserve", "common", "recreation_ground"}
    for el in elements:
        tags = el.get("tags") or {}
        ok = (
            tags.get("leisure") in green_tags
            or tags.get("landuse") in ("forest", "grass", "meadow", "recreation_ground")
            or tags.get("natural") in ("wood", "scrub", "heath", "grassland")
        )
        if not ok:
            continue
        if el.get("type") == "way":
            pts = to_px_poly(way_points(el))
            if len(pts) >= 3:
                gd.polygon(pts, fill=255)
        elif el.get("type") == "relation":
            for ring in rel_rings(el):
                pts = to_px_poly(ring)
                if len(pts) >= 3:
                    gd.polygon(pts, fill=255)
    green = (np.asarray(gm) > 127) & land

    return wild | green


def scatter_icons(
    elements: list[dict[str, Any]],
    base: Image.Image,
    land: np.ndarray,
) -> tuple[Image.Image, int]:
    """喺山野 / 綠地散落手繪樹木圖示。

    為何要「叢聚」而唔係均勻散點
    --------------------------
    參考圖嘅樹係**成片林**：山脊密、山腳疏、平地完全冇。單純用固定機率
    散點會得出「波點紙」效果。所以用一個低頻 noise 場做聚落密度，
    再配抖動網格，令樹木自然成團。
    """
    W, H = CANVAS_W, CANVAS_H
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    zmask_np = build_green_mask(elements, land)
    # 叢聚密度場
    cluster = fbm(W, H, octaves=5, base_cells=8, gain=0.55, seed=7171)
    cluster = normalize(ndimage.gaussian_filter(cluster, max(1.0, W / 400.0)))

    rng = np.random.default_rng(4242)
    # 抖動網格取樣：比純隨機均勻，又唔會出現明顯行列
    spacing = max(5, W // 235)
    tree_size = max(3.0, W / 330.0)
    n = 0
    for gy in range(0, H, spacing):
        for gx in range(0, W, spacing):
            jx = int(gx + rng.uniform(0, spacing))
            jy = int(gy + rng.uniform(0, spacing))
            if not (0 <= jx < W and 0 <= jy < H):
                continue
            if not zmask_np[jy, jx]:
                continue
            # 密度跟叢聚場走：密林 0.85 機會、疏林 0.12
            p = 0.12 + 0.80 * cluster[jy, jx]
            if rng.random() > p:
                continue
            s = tree_size * rng.uniform(0.62, 1.25)
            col = PALETTE["tree"] if rng.random() < 0.60 else PALETTE["tree_dark"]
            draw_tree(d, float(jx), float(jy), s, col)
            n += 1

    return Image.alpha_composite(base.convert("RGBA"), layer), n


# ---------------------------------------------------------------------------
# 標籤
# ---------------------------------------------------------------------------
def _load_font(size: int):
    """優先楷體 / 宋體（古地圖感），最後退回任何可用 CJK 字體。"""
    for cand in (
        "C:/Windows/Fonts/kaiu.ttf",      # 標楷體（最貼近參考圖）
        "C:/Windows/Fonts/msjh.ttc",      # 微軟正黑
        "C:/Windows/Fonts/mingliu.ttc",   # 細明體
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simsun.ttc",
    ):
        if Path(cand).exists():
            try:
                return ImageFont.truetype(cand, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def build_label_layer(
    crop: tuple[int, int, int, int] | None = None,
) -> tuple[Image.Image, int]:
    """產生**獨立透明**標籤圖層（RGBA），同底圖共用同一 bbox。

    為何要拆層
    ----------
    前端 `#label-detail-layer` 會按縮放淡入／淡出街道名。要令呢個圖層
    同底圖**像素級對齊**，兩者必須由同一次渲染、同一 bbox、同一畫布尺寸
    產生 —— 舊版兩張圖由唔同設定產生，疊起上嚟必然走位。
    """
    W, H = CANVAS_W, CANVAS_H
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    fonts = {
        0: _load_font(max(22, W // 40)),
        1: _load_font(max(14, W // 74)),
        2: _load_font(max(11, W // 112)),
    }
    halo = PALETTE["paper"]
    n = 0
    placed: list[tuple[int, int, int, int]] = []
    # 光暈方向：8 方位 × 2 圈，做出足夠厚嘅描邊（古地圖標籤要壓得住底紋）
    _halo_off = [
        (dx, dy)
        for r in (1, 2)
        for dx, dy in (
            (-r, 0), (r, 0), (0, -r), (0, r),
            (-r, -r), (r, -r), (-r, r), (r, r),
        )
    ]
    # 等級 0 先畫（大區名優先霸位），然後 1、2
    for name, lon, lat, rank in sorted(REGION_LABELS, key=lambda t: t[3]):
        x, y = lonlat_to_px(lon, lat)
        cx0, cy0, cx1, cy1 = crop if crop else (0, 0, W, H)
        if not (cx0 <= x <= cx1 and cy0 <= y <= cy1):
            continue
        font = fonts.get(rank, fonts[2])
        ink = PALETTE["ink_region"] if rank == 0 else PALETTE["ink_label"]
        txt = "  ".join(name) if rank == 0 else name  # 大區名加字距
        try:
            bb = d.textbbox((x, y), txt, font=font, anchor="mm")
        except Exception:
            continue
        if bb[0] < 2 or bb[2] > W - 2 or bb[1] < 2 or bb[3] > H - 2:
            continue
        pad = 4
        box = (bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad)
        if any(
            not (box[2] < p[0] or box[0] > p[2] or box[3] < p[1] or box[1] > p[3])
            for p in placed
        ):
            continue
        for dx, dy in _halo_off:
            d.text((x + dx, y + dy), txt, font=font, fill=(*halo, 165), anchor="mm")
        d.text((x, y), txt, font=font, fill=(*ink, 255), anchor="mm")
        placed.append(box)
        n += 1
    return layer, n


def draw_labels(
    base: Image.Image,
    crop: tuple[int, int, int, int] | None = None,
) -> tuple[Image.Image, int]:
    """畫地區標籤（暗紅棕楷體 + 多層描邊光暈），合成到底圖上。"""
    layer, n = build_label_layer(crop)
    return Image.alpha_composite(base.convert("RGBA"), layer), n


def land_crop(land: np.ndarray, pad_ratio: float = 0.03) -> tuple[int, int, int, int]:
    """計出陸地實際範圍嘅裁切窗（去掉大片空白海面）。"""
    W, H = CANVAS_W, CANVAS_H
    ys, xs = np.nonzero(land)
    if len(ys) == 0:
        return (0, 0, W, H)
    pad = int(min(W, H) * pad_ratio)
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(W, int(xs.max()) + pad)
    y1 = min(H, int(ys.max()) + pad)
    return (x0, y0, x1, y1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def parse_bbox(text: str) -> dict[str, float] | None:
    """解析 `--bbox lon_min,lon_max,lat_min,lat_max`。"""
    if text.strip().lower() in ("", "none", "hk"):
        return None
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 4:
        raise ValueError("--bbox 需要 4 個數字：lon_min,lon_max,lat_min,lat_max")
    lon_min, lon_max, lat_min, lat_max = (float(p) for p in parts)
    return {
        "lon_min": lon_min,
        "lon_max": lon_max,
        "lat_min": lat_min,
        "lat_max": lat_max,
    }


def main() -> int:
    global WILD_DIST_M
    ap = argparse.ArgumentParser(description="Render 《病港》-style HK map")
    ap.add_argument(
        "--width", type=int, default=2048, help="畫布闊度（px）；高度按真實長寬比自動計算"
    )
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--coords", type=Path, default=DEFAULT_COORDS)
    ap.add_argument("--seed", type=int, default=20260915)
    ap.add_argument(
        "--bbox",
        type=str,
        default="hk",
        help="經緯範圍 lon_min,lon_max,lat_min,lat_max；'hk' = 全港。"
        "縮窄 bbox = 放大，會自動開啟更多細節圖層（道路 / 建築）。",
    )
    ap.add_argument(
        "--lod",
        choices=("auto", "overview", "region", "district", "street"),
        default="auto",
        help="細節層級；auto = 按 bbox 跨度自動判斷",
    )
    ap.add_argument(
        "--labels",
        choices=("base", "none", "only"),
        default="base",
        help="標籤處理：base = 合成到底圖；none = 唔畫；only = 只出透明標籤層",
    )
    ap.add_argument(
        "--labels-out",
        type=Path,
        default=None,
        help="額外輸出透明標籤層（同底圖同 bbox，保證像素對齊）",
    )
    ap.add_argument(
        "--wild-dist",
        type=float,
        default=WILD_DIST_M,
        help="郊野判定：離最近已開發像素幾多米當係山野（預設 300）",
    )
    ap.add_argument(
        "--crop",
        choices=("auto", "none", "land"),
        default="auto",
        help="裁切模式：auto = 總覽裁到陸地範圍，分區級唔裁（保持座標對應）",
    )
    args = ap.parse_args()

    WILD_DIST_M = args.wild_dist

    if not CACHE_PATH.exists():
        print(f"缺少 OSM cache：{CACHE_PATH}", file=sys.stderr)
        return 2

    try:
        bbox = parse_bbox(args.bbox)
    except ValueError as exc:
        print(f"參數錯誤：{exc}", file=sys.stderr)
        return 2

    W, H = configure_canvas(args.width, bbox)
    aspect = W / H
    lon_span = ACTIVE_BBOX["lon_max"] - ACTIVE_BBOX["lon_min"]
    lat_span = ACTIVE_BBOX["lat_max"] - ACTIVE_BBOX["lat_min"]

    auto_lod, lod_roads, lod_buildings, lod_blabels = pick_lod(lon_span)
    lod = auto_lod if args.lod == "auto" else args.lod
    if args.lod != "auto":
        # 手動指定時重算圖層開關
        for max_span, name, roads, buildings, blabels in LOD_TIERS:
            if name == lod:
                lod_roads, lod_buildings, lod_blabels = roads, buildings, blabels
                break

    print(f"畫布：{W}×{H}（長寬比 {aspect:.3f}，等距圓柱校正）")
    print(
        f"bbox：{ACTIVE_BBOX['lon_min']:.4f}–{ACTIVE_BBOX['lon_max']:.4f}E / "
        f"{ACTIVE_BBOX['lat_min']:.4f}–{ACTIVE_BBOX['lat_max']:.4f}N "
        f"（跨度 {lon_span:.3f}°）"
    )
    print(
        f"LOD：{lod}{'（自動）' if args.lod == 'auto' else '（指定）'}"
        f"  道路={'開' if lod_roads else '關'} 建築={'開' if lod_buildings else '關'}"
    )

    print(f"讀取 OSM cache：{CACHE_PATH}")
    data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    elements = data.get("elements", [])
    print(f"  {len(elements):,} elements")

    print("1/8 建立陸地遮罩…")
    land = build_land_mask(elements)

    print("2/8 抽取內陸水體 / 市區密度…")
    min_water_px = max(20.0, (W * 0.0035) ** 2)
    water_polys = collect_polys(
        elements,
        lambda t: t.get("natural") == "water",
        min_px_area=min_water_px,
    )
    water = polys_to_mask(water_polys) & land

    urban, urban_thr = build_urban_mask(elements, land, water)
    print(
        f"  水體 {len(water_polys):,} 個（{water.sum():,} px）；"
        f"市區（密度>{urban_thr:.3f}）{urban.sum():,} px（佔陸地 "
        f"{urban.sum() / max(1, land.sum()) * 100:.1f}%）"
    )

    print("3/8 合成古地圖質感…")
    # 暗角只對總覽有意義（代表陳年紙邊）；分區圖用弱暗角，避免邊緣海面變黑
    vig_strength = 0.30 if lod == "overview" else 0.10
    # 水深漸變係大尺度特徵，分區圖壓向中間值
    sea_depth_c = 1.0 if lod == "overview" else 0.40
    # 陸地地形／水彩同樣係大尺度；用冪律衰減，避免街道級出現「雲團」
    span_ratio = lon_span / (HK_BBOX["lon_max"] - HK_BBOX["lon_min"])
    terrain_amp = float(np.clip(span_ratio ** 0.42, 0.40, 1.0))
    img = compose_style(
        land, water, urban,
        seed=args.seed, vignette=vig_strength, sea_depth=sea_depth_c,
        terrain_amp=terrain_amp,
    )
    print(
        f"  暗角：{vig_strength:.2f}　水深對比：{sea_depth_c:.2f}　"
        f"地形幅度：{terrain_amp:.2f}（{lod}）"
    )

    print("4/8 散落手繪樹木…")
    img, n_tree = scatter_icons(elements, img, land)
    print(f"  樹木圖示：{n_tree:,}")

    n_road = 0
    if lod_roads:
        print("5/8 繪製道路網…")
        img, n_road = draw_roads(elements, img, land)
        print(f"  道路：{n_road:,} 段")
    else:
        print("5/8 道路網：本層級略過（亞像素）")

    n_bldg = 0
    if lod_buildings:
        print("6/8 繪製建築物…")
        img, n_bldg = draw_buildings(elements, img, land)
        print(f"  建築物：{n_bldg:,} 幢")
    else:
        print("6/8 建築物：本層級略過（亞像素）")

    # 裁切：總覽裁到陸地範圍；分區級唔裁（保持 bbox 對應，前端要按 bbox 定位）
    if args.crop == "auto":
        do_crop = lod == "overview"
    else:
        do_crop = args.crop == "land"
    crop = land_crop(land) if do_crop else (0, 0, W, H)
    print(f"7/8 裁切窗：{crop}（{crop[2]-crop[0]}×{crop[3]-crop[1]}）")

    print("8/8 處理標籤並儲存…")
    label_layer, n_label = build_label_layer(crop)
    print(f"  標籤：{n_label:,}")

    args.out.parent.mkdir(parents=True, exist_ok=True)

    if args.labels == "only":
        # 只出透明標籤層（前端 #label-detail-layer 用，按縮放淡入）
        label_layer.crop(crop).save(args.out, "PNG", optimize=True)
    else:
        if args.labels == "base":
            img = Image.alpha_composite(img.convert("RGBA"), label_layer)
        img.crop(crop).convert("RGB").save(args.out, "PNG", optimize=True)
        if args.labels_out:
            args.labels_out.parent.mkdir(parents=True, exist_ok=True)
            label_layer.crop(crop).save(args.labels_out, "PNG", optimize=True)
            print(f"  {args.labels_out} ({args.labels_out.stat().st_size:,} bytes)")

    print(f"  {args.out} ({args.out.stat().st_size:,} bytes)")

    coords = {
        "canvas": {"width": W, "height": H, "aspect": round(aspect, 6)},
        "bbox": dict(ACTIVE_BBOX),
        "lod": lod,
        "lod_layers": {
            "roads": lod_roads,
            "buildings": lod_buildings,
            "building_labels": lod_blabels,
        },
        "projection": "equirectangular",
        "standard_parallel": round(_LAT0, 6),
        "projection_note": (
            "x = (lon - lon_min) * px_per_deg_lon; "
            "y = (lat_max - lat) * px_per_deg_lon / cos(lat0); "
            "px_per_deg_lon = canvas.width / (lon_max - lon_min)"
        ),
        "style": "binggang_handdrawn_parchment",
        "crop_box": list(crop),
        "output_size": [crop[2] - crop[0], crop[3] - crop[1]],
        "layers": {
            "base": args.out.name,
            **(
                {"label_detail": args.labels_out.name}
                if args.labels_out
                else {}
            ),
        },
        "stats": {            "trees": n_tree,
            "labels": n_label,
            "roads": n_road,
            "buildings": n_bldg,
            "water_bodies": len(water_polys),
            "water_px": int(water.sum()),
            "urban_px": int(urban.sum()),
            "urban_share_of_land": round(float(urban.sum()) / max(1, int(land.sum())), 4),
            "land_px": int(land.sum()),
            "land_share": round(float(land.mean()), 4),
            "bbox_span_deg": round(lon_span, 6),
        },
    }
    args.coords.parent.mkdir(parents=True, exist_ok=True)
    args.coords.write_text(
        json.dumps(coords, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  {args.coords}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

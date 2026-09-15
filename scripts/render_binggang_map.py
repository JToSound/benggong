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
- 海洋：深青綠 + 大理石紋脈理，近岸較淺
- 陸地：淡橄欖黃 + 斑駁水彩質感，地勢高處較深
- 海岸線：柔和深色描邊
- 標籤：暗紅棕楷體
- 圖示：手繪單色（小屋、松樹）
- 整體：低對比、陳舊、紙質顆粒

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
_COS_LAT0 = float(np.cos(np.radians(LAT0)))

CANVAS_W = 2048
CANVAS_H = 2048


def configure_canvas(width: int) -> tuple[int, int]:
    """按 bbox 真實長寬比計出畫布高度。"""
    global CANVAS_W, CANVAS_H
    lon_span = HK_BBOX["lon_max"] - HK_BBOX["lon_min"]
    lat_span = HK_BBOX["lat_max"] - HK_BBOX["lat_min"]
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
    "sea_deep":   (34, 62, 58),
    "sea_mid":    (52, 88, 80),
    "sea_shallow": (86, 122, 108),
    # 陸地：淡橄欖黃（參考圖 2 偏黃，圖 1 偏褐）
    "land_pale":  (228, 222, 158),
    "land_base":  (211, 203, 137),
    "land_dark":  (172, 168, 104),
    "land_high":  (150, 148, 92),
    # 內陸水（水塘 / 湖）
    "inland_water": (58, 96, 86),
    # 線 / 墨
    "coast_line": (76, 68, 46),
    "ink":        (58, 44, 32),
    "ink_label":  (118, 48, 34),   # 暗紅棕（地名）
    "ink_region": (92, 38, 28),    # 更深（大區域名）
    "tree":       (74, 96, 58),
    "tree_dark":  (56, 78, 46),
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
    b = HK_BBOX
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
) -> np.ndarray:
    """分形布朗運動（多層 value noise 疊加），輸出 0–1。"""
    rng = np.random.default_rng(seed)
    total = np.zeros((h, w), np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        c = base_cells * (2 ** o)
        gx = max(2, int(c))
        gy = max(2, int(round(c * h / w)))
        total += amp * _upsample(rng.random((gy, gx)).astype(np.float32), w, h)
        norm += amp
        amp *= gain
    return total / norm


def normalize(a: np.ndarray) -> np.ndarray:
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / (hi - lo) if hi > lo else np.zeros_like(a)


# ---------------------------------------------------------------------------
# 陸地遮罩
# ---------------------------------------------------------------------------
def build_land_mask(elements: list[dict[str, Any]], verbose: bool = True) -> np.ndarray:
    """由海岸線 + 行政邊界砌出陸地遮罩（bool），尺寸 = CANVAS_W × CANVAS_H。

    原理
    ----
    1. 把 1,603 條 `natural=coastline` way 畫成粗線屏障。
    2. 把香港行政邊界畫成屏障（防止向北漏入深圳陸地）。
    3. 由維多利亞港中心做連通分量 flood fill → 得到「海」。
    4. 陸地 = 行政邊界內 ∧ 非海 ∧ 非屏障。
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

    # 行政邊界屏障
    rings = boundary_rings()
    for ring in rings:
        pts = to_px_poly(ring)
        if len(pts) >= 3:
            bd.line(pts + [pts[0]], fill=255, width=coast_w)

    bmask = np.asarray(barrier) > 127

    # 行政邊界「內部」
    inside = Image.new("L", (W, H), 0)
    idd = ImageDraw.Draw(inside)
    for ring in rings:
        pts = to_px_poly(ring)
        if len(pts) >= 3:
            idd.polygon(pts, fill=255)
    inside_mask = np.asarray(inside) > 127

    # Flood fill：由維多利亞港中心（確定係海）做連通分量
    free = ~bmask
    labels, _ = ndimage.label(free)
    seed_x, seed_y = lonlat_to_px(114.165, 22.293)
    sx = min(max(int(round(seed_x)), 0), W - 1)
    sy = min(max(int(round(seed_y)), 0), H - 1)
    sea_label = labels[sy, sx]
    if sea_label == 0:
        # 種子啱好落喺屏障上，喺附近搵一個 free pixel
        found = False
        for r in range(1, 40):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    yy, xx = sy + dy, sx + dx
                    if 0 <= yy < H and 0 <= xx < W and labels[yy, xx] != 0:
                        sea_label = labels[yy, xx]
                        found = True
                        break
                if found:
                    break
            if found:
                break
    sea = (labels == sea_label) & free

    land = inside_mask & (~sea) & (~bmask)
    if verbose:
        print(
            f"  land mask: coast ways={n_coast}, "
            f"land px={land.sum():,} ({land.mean() * 100:.1f}%)"
        )
    return land


# ---------------------------------------------------------------------------
# 風格合成
# ---------------------------------------------------------------------------
def compose_style(land: np.ndarray, seed: int = 20260915) -> Image.Image:
    """把陸地遮罩合成為《病港》風格底圖。"""
    h, w = land.shape

    # --- 各種 noise 場 ---------------------------------------------------
    sea_marble = fbm(w, h, octaves=6, base_cells=3, gain=0.55, seed=seed + 1)
    # 脊狀紋理 → 大理石脈理
    veins = 1.0 - np.abs(2.0 * sea_marble - 1.0)
    veins = np.power(veins, 1.6)

    land_mottle = fbm(w, h, octaves=5, base_cells=6, gain=0.5, seed=seed + 2)
    land_blotch = fbm(w, h, octaves=4, base_cells=3, gain=0.55, seed=seed + 6)
    relief = fbm(w, h, octaves=4, base_cells=10, gain=0.5, seed=seed + 3)
    paper = fbm(w, h, octaves=7, base_cells=24, gain=0.5, seed=seed + 4)
    stain = fbm(w, h, octaves=3, base_cells=3, gain=0.5, seed=seed + 5)

    # --- 海洋 ------------------------------------------------------------
    depth = ndimage.gaussian_filter((~land).astype(np.float32), 26)
    depth = normalize(depth)  # 近岸低、遠岸高

    sea_img = np.zeros((h, w, 3), np.float32)
    for i in range(3):
        sea_img[..., i] = (
            PALETTE["sea_shallow"][i] * (1 - depth)
            + PALETTE["sea_deep"][i] * depth
        )
    # 脈理提亮（大理石紋）
    sea_img += (veins * 46.0)[..., None] * np.array([0.55, 0.78, 0.72], np.float32)
    # 大範圍色調起伏（陳舊水彩感）
    sea_img += ((stain - 0.5) * 24.0)[..., None] * np.array([0.6, 0.9, 0.8], np.float32)

    # --- 陸地 ------------------------------------------------------------
    mottle = np.clip(0.62 * land_mottle + 0.38 * land_blotch, 0, 1)
    land_img = np.zeros((h, w, 3), np.float32)
    for i in range(3):
        land_img[..., i] = (
            PALETTE["land_pale"][i] * mottle
            + PALETTE["land_dark"][i] * (1 - mottle)
        )
    # 地勢陰影（relief 梯度做 hillshade）
    gy, gx = np.gradient(ndimage.gaussian_filter(relief, 3.0))
    shade = np.clip(0.5 + (gx + gy) * 5.5, 0.0, 1.0)
    land_img *= (0.86 + 0.28 * shade)[..., None]
    # 陸地陳舊斑（水彩暈染）
    land_img += ((stain - 0.5) * 30.0)[..., None] * np.array([1.0, 0.95, 0.6], np.float32)
    land_img += ((land_blotch - 0.5) * 22.0)[..., None] * np.array([0.9, 0.9, 0.55], np.float32)

    # --- 合成（海岸柔化過渡） -------------------------------------------
    alpha = np.clip(ndimage.gaussian_filter(land.astype(np.float32), 1.0), 0.0, 1.0)
    alpha = alpha[..., None]
    out = sea_img * (1 - alpha) + land_img * alpha

    # --- 海岸線描邊（手繪感） --------------------------------------------
    hard = land.astype(np.float32)
    edge = np.clip(hard - ndimage.grey_erosion(hard, size=5), 0.0, 1.0)
    edge = ndimage.gaussian_filter(edge, 0.8)
    out = out * (1 - edge[..., None] * 0.62) + np.array(
        PALETTE["coast_line"], np.float32
    ) * (edge[..., None] * 0.62)

    # --- 紙質顆粒 + 污漬 + 暗角 -----------------------------------------
    grain = (paper - 0.5) * 15.0
    out += grain[..., None]
    vig = _vignette(w, h)
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
    """
    W, H = CANVAS_W, CANVAS_H
    dev = Image.new("L", (W, H), 0)
    dd = ImageDraw.Draw(dev)
    developed_use = {"residential", "industrial", "commercial", "retail", "railway"}
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        pts: list[tuple[float, float]] | None = None
        if tags.get("landuse") in developed_use:
            pts = to_px_poly(way_points(el))
            if len(pts) >= 3:
                dd.polygon(pts, fill=255)
        elif tags.get("highway"):
            pts = to_px_poly(way_points(el))
            if len(pts) >= 2:
                dd.line(pts, fill=255, width=max(2, W // 700))

    dev_np = np.asarray(dev) > 127
    dist = ndimage.distance_transform_edt(~dev_np)
    wild = land & (dist > max(6.0, W * 0.008))

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
    """喺山野 / 綠地散落手繪樹木圖示。"""
    W, H = CANVAS_W, CANVAS_H
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    zmask_np = build_green_mask(elements, land)

    rng = np.random.default_rng(4242)
    # 抖動網格取樣：比純隨機均勻，又唔會出現明顯行列
    spacing = max(6, W // 170)
    tree_size = max(4.0, W / 210.0)
    n = 0
    for gy in range(0, H, spacing):
        for gx in range(0, W, spacing):
            jx = int(gx + rng.uniform(0, spacing))
            jy = int(gy + rng.uniform(0, spacing))
            if not (0 <= jx < W and 0 <= jy < H):
                continue
            if not zmask_np[jy, jx]:
                continue
            if rng.random() > 0.55:      # 留白，避免過密
                continue
            s = tree_size * rng.uniform(0.70, 1.18)
            col = PALETTE["tree"] if rng.random() < 0.62 else PALETTE["tree_dark"]
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


def draw_labels(
    base: Image.Image,
    crop: tuple[int, int, int, int] | None = None,
) -> tuple[Image.Image, int]:
    """畫地區標籤（暗紅棕楷體 + 淡色描邊）。

    等級 0（新界／九龍／香港島）用大字距、更大字級，做出參考圖
    「北方領域」嗰種區域感；等級 1/2 用一般地名大小。
    """
    W, H = CANVAS_W, CANVAS_H
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    fonts = {
        0: _load_font(max(20, W // 52)),
        1: _load_font(max(14, W // 92)),
        2: _load_font(max(11, W // 132)),
    }
    halo = PALETTE["paper"]
    n = 0
    placed: list[tuple[int, int, int, int]] = []
    # 等級 0 先畫（大區名優先霸位），然後 1、2
    for name, lon, lat, rank in sorted(REGION_LABELS, key=lambda t: t[3]):
        x, y = lonlat_to_px(lon, lat)
        # 畫喺完整畫布，最後才裁剪；呢度只係判斷有冇落喺裁切窗內
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
        # 碰撞檢測：同已畫標籤重疊就跳過（留 4px 呼吸位）
        pad = 4
        box = (bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad)
        if any(
            not (box[2] < p[0] or box[0] > p[2] or box[3] < p[1] or box[1] > p[3])
            for p in placed
        ):
            continue
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            d.text((x + dx, y + dy), txt, font=font, fill=(*halo, 170), anchor="mm")
        d.text((x, y), txt, font=font, fill=(*ink, 255), anchor="mm")
        placed.append(box)
        n += 1
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
def main() -> int:
    ap = argparse.ArgumentParser(description="Render 《病港》-style HK map")
    ap.add_argument(
        "--width", type=int, default=2048, help="畫布闊度（px）；高度按真實長寬比自動計算"
    )
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--coords", type=Path, default=DEFAULT_COORDS)
    ap.add_argument("--seed", type=int, default=20260915)
    ap.add_argument(
        "--crop",
        choices=("none", "land"),
        default="land",
        help="裁切模式：land = 收緊到陸地範圍（去掉大片空白海面）",
    )
    args = ap.parse_args()

    if not CACHE_PATH.exists():
        print(f"缺少 OSM cache：{CACHE_PATH}", file=sys.stderr)
        return 2

    W, H = configure_canvas(args.width)
    aspect = W / H
    print(f"畫布：{W}×{H}（長寬比 {aspect:.3f}，已做等距圓柱校正）")
    print(f"讀取 OSM cache：{CACHE_PATH}")
    data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    elements = data.get("elements", [])
    print(f"  {len(elements):,} elements")

    print("1/6 建立陸地遮罩…")
    land = build_land_mask(elements)

    print("2/6 合成古地圖質感…")
    img = compose_style(land, seed=args.seed)

    print("3/6 散落手繪樹木…")
    img, n_tree = scatter_icons(elements, img, land)
    print(f"  樹木圖示：{n_tree:,}")

    crop = land_crop(land) if args.crop == "land" else (0, 0, W, H)
    print(f"4/6 裁切窗：{crop}（{crop[2]-crop[0]}×{crop[3]-crop[1]}）")

    print("5/6 繪製地區標籤…")
    img, n_label = draw_labels(img, crop)
    print(f"  標籤：{n_label:,}")

    img = img.crop(crop)

    print("6/6 儲存…")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(args.out, "PNG", optimize=True)
    print(f"  {args.out} ({args.out.stat().st_size:,} bytes)")

    coords = {
        "canvas": {"width": W, "height": H, "aspect": round(aspect, 6)},
        "bbox": HK_BBOX,
        "projection": "equirectangular",
        "standard_parallel": round(LAT0, 6),
        "projection_note": (
            "x = (lon - lon_min) * px_per_deg_lon; "
            "y = (lat_max - lat) * px_per_deg_lon / cos(lat0); "
            "px_per_deg_lon = canvas.width / (lon_max - lon_min)"
        ),
        "style": "binggang_handdrawn_parchment",
        "crop_box": list(crop),
        "output_size": [crop[2] - crop[0], crop[3] - crop[1]],
        "layers": {"base": args.out.name},
        "stats": {"trees": n_tree, "labels": n_label},
    }
    args.coords.parent.mkdir(parents=True, exist_ok=True)
    args.coords.write_text(
        json.dumps(coords, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  {args.coords}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

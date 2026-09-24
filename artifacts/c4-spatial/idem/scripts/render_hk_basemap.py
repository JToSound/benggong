#!/usr/bin/env python3
"""《病港》— Phase G: 香港全境 stylized top-down basemap renderer.

Generates a dark post-apocalyptic game-style map of Hong Kong from
OpenStreetMap vector data, suitable as an interactive basemap for the
《病港》interactive story map. Output replaces the previous hand-drawn SVG.

Why procedural + OSM (not ComfyUI):
- ComfyUI diffusion models excel at illustrations, not technical maps
- OSM vector data gives us real roads, water bodies, building footprints
- Procedural rendering with PIL is deterministic, reproducible, and free
- Result is interactive-ready: every pixel maps to a lon/lat, so markers
  align correctly

Output:
- public/assets/hk-basemap.png (2048x2048 by default)
- public/assets/hk-basemap-coords.json (bbox metadata for front-end)

Usage:
    python scripts/render_hk_basemap.py [--size 2048] [--out PATH]

Author: JToSound (benggong project)
License: ODbL (OpenStreetMap data) + project license (rendered image)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_PNG = REPO / "public" / "assets" / "hk-basemap.png"
DEFAULT_OUTPUT_LABELS_PNG = REPO / "public" / "assets" / "hk-basemap-labels.png"
DEFAULT_OUTPUT_JSON = REPO / "public" / "assets" / "hk-basemap-coords.json"

# Hong Kong bounding box: covers the full territory at the standard extent
# used by the project's story data (Phase A baseline).
# lon: 113.85 - 114.45 (E-W ~55km)
# lat: 22.18  - 22.55  (N-S ~41km)
HK_BBOX = {
    "lon_min": 113.85,
    "lon_max": 114.45,
    "lat_min": 22.18,
    "lat_max": 22.55,
}

# Overpass API endpoint (public, free, low-rate tolerated for small queries)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Dark post-apocalyptic "bing-gang" color palette.
# (Avoiding any copyright infringement on the source novel artwork — these
# colors are inspired by 病港's narrative themes of abandoned cityscape.)
PALETTE = {
    # background: deep desaturated navy
    "bg_deep":      (16, 22, 34, 255),
    "bg_water":     (22, 36, 52, 255),       # ocean / harbour
    "bg_water_dark":(14, 24, 36, 255),       # deep water (deeper channels)
    # land: muted earth tones
    "land_main":    (38, 42, 44, 255),       # base landmass
    "land_park":    (28, 38, 32, 255),       # parks / green spaces
    "land_urban":   (50, 50, 52, 255),       # dense urban
    "land_filled":  (44, 46, 48, 255),       # reclaimed land
    "land_deserted":(34, 30, 28, 255),      # abandoned areas
    # roads
    "road_motor":   (88, 78, 60, 255),       # motorway (amber-grey)
    "road_primary": (78, 70, 56, 255),       # primary road
    "road_secondary":(70, 64, 52, 255),     # secondary
    "road_tertiary":(60, 56, 48, 255),      # tertiary
    "road_residential":(52, 50, 44, 255),   # residential
    # infrastructure
    "building":     (62, 60, 58, 255),       # building footprint
    "building_dense":(70, 66, 62, 255),     # dense building
    # accents
    "accent_warning":(200, 100, 40, 255),   # 病港 warning accent
    "accent_blood":  (140, 50, 40, 255),     # 病 (illness) accent
    "label_text":   (220, 210, 180, 255),    # aged-paper label color
    "label_subtle": (140, 132, 116, 255),   # subtle label
}

# Overpass query — collect vectors for Hong Kong territory
# Note: `out geom` is required to embed lat/lon per node, otherwise we
# would only get node IDs and have to do a second pass to resolve them.
OVERPASS_QUERY = """
[out:json][timeout:180];
(
  // Water bodies (polygons)
  way["natural"="water"](22.18,113.85,22.55,114.45);
  relation["natural"="water"](22.18,113.85,22.55,114.45);
  // Coastline
  way["natural"="coastline"](22.18,113.85,22.55,114.45);
  // Land use
  way["landuse"="park"](22.18,113.85,22.55,114.45);
  way["landuse"="forest"](22.18,113.85,22.55,114.45);
  way["landuse"="residential"](22.18,113.85,22.55,114.45);
  way["landuse"="commercial"](22.18,113.85,22.55,114.45);
  way["landuse"="industrial"](22.18,113.85,22.55,114.45);
  way["landuse"="military"](22.18,113.85,22.55,114.45);
  way["leisure"="park"](22.18,113.85,22.55,114.45);
  // Roads (highways)
  way["highway"="motorway"](22.18,113.85,22.55,114.45);
  way["highway"="trunk"](22.18,113.85,22.55,114.45);
  way["highway"="primary"](22.18,113.85,22.55,114.45);
  way["highway"="secondary"](22.18,113.85,22.55,114.45);
  way["highway"="tertiary"](22.18,113.85,22.55,114.45);
  way["highway"="residential"](22.18,113.85,22.55,114.45);
  way["highway"="unclassified"](22.18,113.85,22.55,114.45);
  // Buildings
  way["building"](22.18,113.85,22.55,114.45);
);
out geom;
"""


def fetch_overpass(query: str) -> dict[str, Any]:
    """POST Overpass API and return JSON. Retries on transient failures."""
    headers = {
        "User-Agent": "BingGangMap/0.1 (benggong research; contact: github.com/JToSound/benggong)",
    }
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            r = requests.post(
                OVERPASS_URL,
                data={"data": query},
                headers=headers,
                timeout=120,
            )
            r.raise_for_status()
            return r.json()
        except Exception as e:  # network or HTTP
            last_err = e
            wait = 5 * (attempt + 1)
            print(f"  Overpass attempt {attempt+1} failed: {e!r}; retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"Overpass fetch failed after retries: {last_err!r}")


def lonlat_to_px(lon: float, lat: float, size: int) -> tuple[int, int]:
    """Project (lon, lat) to pixel coords in HK bbox at given output size.

    lon: west-east increases → x left-to-right
    lat: north increases → y top-to-bottom (image y axis)
    """
    bbox = HK_BBOX
    fx = (lon - bbox["lon_min"]) / (bbox["lon_max"] - bbox["lon_min"])
    fy = (bbox["lat_max"] - lat) / (bbox["lat_max"] - bbox["lat_min"])
    return int(round(fx * size)), int(round(fy * size))


def way_to_points(way: dict) -> list[tuple[float, float]]:
    """Extract (lon, lat) sequence from an Overpass way element."""
    return [(n["lon"], n["lat"]) for n in way.get("geometry", [])]


def render_basemap(data: dict[str, Any], size: int) -> Image.Image:
    """Render the basemap to a PIL Image of given edge size."""
    img = Image.new("RGBA", (size, size), PALETTE["bg_deep"])
    draw = ImageDraw.Draw(img, "RGBA")

    elements = data.get("elements", [])
    print(f"  Rendering {len(elements)} elements…")

    # Categorize by type — pass 1: water + coast (background layers)
    n_water = n_coast = n_park = n_road = n_bldg = n_other = 0
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {}) or {}
        natural = tags.get("natural")
        landuse = tags.get("landuse")
        leisure = tags.get("leisure")
        highway = tags.get("highway")
        building = tags.get("building")

        pts = way_to_points(el)
        if not pts or len(pts) < 2:
            n_other += 1
            continue

        if natural == "coastline":
            color = PALETTE["land_main"]
            # Coastline = land boundary, but we use it as a wide band
            for i in range(len(pts) - 1):
                p1 = lonlat_to_px(pts[i][0], pts[i][1], size)
                p2 = lonlat_to_px(pts[i + 1][0], pts[i + 1][1], size)
                draw.line([p1, p2], fill=color, width=max(1, size // 1200))
            n_coast += 1
        elif natural == "water":
            color = PALETTE["bg_water"]
            poly = [lonlat_to_px(p[0], p[1], size) for p in pts]
            if len(poly) >= 3:
                draw.polygon(poly, fill=color, outline=PALETTE["bg_water_dark"])
            n_water += 1
        else:
            n_other += 1

    # Pass 2: parks + green spaces (overlaid on land)
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {}) or {}
        pts = way_to_points(el)
        if not pts or len(pts) < 2:
            continue
        if tags.get("landuse") == "park" or tags.get("leisure") == "park":
            poly = [lonlat_to_px(p[0], p[1], size) for p in pts]
            if len(poly) >= 3:
                draw.polygon(poly, fill=PALETTE["land_park"], outline=None)
            n_park += 1
        elif tags.get("landuse") == "forest":
            poly = [lonlat_to_px(p[0], p[1], size) for p in pts]
            if len(poly) >= 3:
                draw.polygon(poly, fill=PALETTE["land_park"], outline=None)
            n_park += 1

    # Pass 3: roads (thin → thick)
    road_widths = {
        "motorway":     max(2, size // 350),
        "trunk":        max(2, size // 450),
        "primary":      max(1, size // 550),
        "secondary":    max(1, size // 700),
        "tertiary":     max(1, size // 900),
        "residential":  max(1, size // 1100),
        "unclassified": max(1, size // 1300),
    }
    road_colors = {
        "motorway":     PALETTE["road_motor"],
        "trunk":        PALETTE["road_primary"],
        "primary":      PALETTE["road_primary"],
        "secondary":    PALETTE["road_secondary"],
        "tertiary":     PALETTE["road_tertiary"],
        "residential":  PALETTE["road_residential"],
        "unclassified": PALETTE["road_residential"],
    }
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {}) or {}
        hwy = tags.get("highway")
        if not hwy:
            continue
        pts = way_to_points(el)
        if not pts or len(pts) < 2:
            continue
        width = road_widths.get(hwy, 1)
        color = road_colors.get(hwy, PALETTE["road_residential"])
        for i in range(len(pts) - 1):
            p1 = lonlat_to_px(pts[i][0], pts[i][1], size)
            p2 = lonlat_to_px(pts[i + 1][0], pts[i + 1][1], size)
            draw.line([p1, p2], fill=color, width=width)
        n_road += 1

    # Pass 4: buildings (small dark blocks)
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {}) or {}
        if not tags.get("building"):
            continue
        pts = way_to_points(el)
        if not pts or len(pts) < 3:
            continue
        poly = [lonlat_to_px(p[0], p[1], size) for p in pts]
        if len(poly) >= 3:
            draw.polygon(poly, fill=PALETTE["building"], outline=None)
        n_bldg += 1

    # Pass 5: street / place labels
    # Render major road names + landmark names (parks, hospitals) at low
    # alpha so they don't dominate the basemap. The text uses the same aged-
    # paper colour as the rest of the bing-gang palette.
    n_label = 0
    n_skipped_small = 0
    label_font, label_font_small = _load_label_fonts(size)

    if label_font is not None:
        # 5a) Road labels — only major highways with name, single midpoint
        major_roads = ("motorway", "trunk", "primary")
        for el in elements:
            if el.get("type") != "way":
                continue
            tags = el.get("tags", {}) or {}
            if tags.get("highway") not in major_roads:
                continue
            name = tags.get("name")
            if not name:
                continue
            pts = way_to_points(el)
            if len(pts) < 2:
                continue
            # Midpoint of way
            mid = pts[len(pts) // 2]
            x, y = lonlat_to_px(mid[0], mid[1], size)
            # Truncate to 14 CJK chars
            txt = name[:14] if len(name) > 14 else name
            try:
                draw.text(
                    (x, y), txt, fill=(220, 210, 180, 200),
                    font=label_font, anchor="mm", spacing=2,
                )
                n_label += 1
            except Exception:
                n_skipped_small += 1
        # 5b) Place labels — parks, hospitals, malls, schools (top 200)
        place_count = 0
        for el in elements:
            if el.get("type") != "way":
                continue
            tags = el.get("tags", {}) or {}
            kind = (
                "park" if tags.get("leisure") == "park" or tags.get("landuse") == "park"
                else "hospital" if tags.get("amenity") == "hospital"
                else "school" if tags.get("amenity") in ("school", "kindergarten")
                else "university" if tags.get("amenity") == "university"
                else "mall" if tags.get("shop") == "mall"
                else None
            )
            if not kind:
                continue
            name = tags.get("name")
            if not name or len(name) < 2:
                continue
            n = el.get("geometry", [])
            if not n:
                continue
            x, y = lonlat_to_px(n[0]["lon"], n[0]["lat"], size)
            try:
                txt = name[:10]
                draw.text(
                    (x, y), txt, fill=(200, 220, 240, 180),
                    font=label_font_small, anchor="lm", spacing=1,
                )
                place_count += 1
                if place_count >= 200:
                    break
            except Exception:
                pass
        n_label += place_count

    print(f"  water={n_water} coast={n_coast} park={n_park} road={n_road} bldg={n_bldg} labels={n_label} other={n_other}")

    # Post-processing: subtle blur to soften pixel edges, slight desaturation
    # for a "weathered" look without losing sharpness.
    img = img.filter(ImageFilter.GaussianBlur(radius=0.6))

    # Vignette: darken corners
    vignette = Image.new("L", (size, size), 0)
    vd = ImageDraw.Draw(vignette)
    for i in range(60):
        a = int(255 * (i / 60) ** 1.2)
        vd.rectangle([i, i, size - i, size - i], outline=a, width=1)
    # Apply a soft vignette
    img = img.filter(ImageFilter.GaussianBlur(radius=size // 80))
    # Overlay: dark corners
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rectangle([0, 0, size, size], fill=(0, 0, 0, 60))
    img = Image.composite(img, overlay, vignette)

    return img


def _load_label_fonts(size: int):
    """載入 CJK 標籤字體（大／小兩級）。搵唔到就回 (None, None)。"""
    font_path = None
    for cand in (
        "C:/Windows/Fonts/msgothic.ttc",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ):
        if Path(cand).exists():
            font_path = cand
            break
    try:
        big = ImageFont.truetype(font_path, size=max(10, size // 100)) if font_path else ImageFont.load_default()
        small = ImageFont.truetype(font_path, size=max(8, size // 140)) if font_path else ImageFont.load_default()
        return big, small
    except Exception as e:  # pragma: no cover - 視乎系統字體
        print(f"  (label font unavailable: {e}; skipping label pass)", file=sys.stderr)
        return None, None


def _short_label(name: str, max_cjk: int = 7, max_latin: int = 18) -> str:
    """把道路名縮短到適合 14 px 標籤嘅長度。

    為何唔可以簡單 `name[:10]`
    --------------------------
    OSM 香港道路名通常係「中文 English」混合（例如
    「大涌橋路 Tai Chung Kiu Road」）。按字元數硬切會變成
    「大涌橋路 Tai C」—— 英文斷喺半個字中間，中文亦可能被切斷。

    策略：
    - 名內有中文 → 只取中文部分（本專案 UI 以粵文為主），最多 `max_cjk` 字。
    - 純英文 → 最多 `max_latin` 個字元，並且退到最後一個完整詞。
    """
    cjk = "".join(ch for ch in name if _is_cjk(ch))
    if len(cjk) >= 2:
        return cjk[:max_cjk]
    if len(name) <= max_latin:
        return name
    cut = name[:max_latin]
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    return cut or name[:max_latin]


def _is_cjk(ch: str) -> bool:
    """粗略判斷 CJK 漢字（涵蓋常用區同擴展 A 區）。"""
    cp = ord(ch)
    return (
        0x3400 <= cp <= 0x4DBF      # 擴展 A
        or 0x4E00 <= cp <= 0x9FFF   # 基本區
        or 0xF900 <= cp <= 0xFAFF   # 相容表意
    )


def render_label_overlay(data: dict[str, Any], size: int) -> Image.Image:
    """Phase I：獨立嘅透明標籤圖層（secondary / tertiary 道路名）。

    為何要獨立圖層
    --------------
    原本 Pass 5c 將次要道路標籤直接燒入底圖 PNG，但燒入之後前端就
    無法按 zoom 調整密度 —— 用戶 zoom out 時會見到密密麻麻嘅街道名。
    將呢層拆做獨立透明 PNG 之後，前端可以喺 `#label-detail-layer`
    上按 `viewScale` 線性插值透明度（zoom in 才顯示），做到真正嘅
    zoom-dependent label decluttering。

    輸出係 RGBA 透明圖，座標系同底圖完全一致（同一 bbox、同一 size），
    所以前端可以將兩個 <image> 用相同 x/y/width/height 疊埋一齊。

    為何要 declutter（2026-09-15 修正）
    ----------------------------------
    OSM 會將一條道路切成好多段 way，所以「一段一個標籤」會嚴重重複。
    實測：16,887 段合資格 way 只對應 **1,515 個唯一路名**（平均 11.1 次），
    最誇張係「英皇道 King's Road」重複 **130 次**。喺 2048 px 畫布上等於
    平均每 15.8 px 就有一個標籤，必然互相堆疊，地圖上會出現同一路名
    連續疊六、七層嘅情況。

    修正策略（三層）：
    1. **按路名分組** —— 同一路名嘅所有 way 段先合併成候選點集合。
    2. **同名最小間距** —— 同名標籤之間至少隔 `MIN_SAME_NAME_PX`，
       每個路名最多 `MAX_PER_NAME` 個（長道路仍然可以出現幾次）。
    3. **全域碰撞檢測** —— 用空間網格（cell ≈ 1.2 × 字高）檢查文字
       bbox，同已畫標籤重疊就跳過。

    排序固定為 (等級, 路名)，令輸出 deterministic（同一輸入永遠同一 PNG）。
    純邏輯抽喺 `plan_labels()`，方便單元測試。
    """
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")

    _, label_font_small = _load_label_fonts(size)
    if label_font_small is None:
        print("  (no font; empty label overlay)", file=sys.stderr)
        return overlay

    placed, stats = plan_labels(
        data.get("elements", []), size, label_font_small
    )
    for name, x, y in placed:
        try:
            draw.text(
                (x, y), _short_label(name), fill=(180, 200, 170, 200),
                font=label_font_small, anchor="mm", spacing=1,
            )
        except Exception:
            pass

    print(
        f"  label overlay: {len(placed)} 個街道標籤"
        f"（候選 {stats['candidates']}，合資格 way 段 {stats['ways']}，"
        f"唯一路名 {stats['names']}）"
    )
    return overlay


def plan_labels(
    elements: list[dict[str, Any]],
    size: int,
    font: Any,
    min_same_ratio: float = 0.09,
    max_per_name: int = 3,
    cell_ratio: float = 1.2,
) -> tuple[list[tuple[str, int, int]], dict[str, int]]:
    """計算最終應該畫嘅街道標籤（去重 + 避碰），唔會真正繪圖。

    抽做獨立函式係為咗可以喺測試入面用合成資料驗證 declutter 行為，
    唔需要 182 MB 嘅 OSM cache。

    回傳 `(placed, stats)`：
    - `placed`：`(name, x, y)` 清單，順序即繪圖順序（deterministic）。
    - `stats`：`{"ways", "names", "candidates"}` 統計數字。
    """
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))

    # --- 1) 收集候選點，按路名分組 ---------------------------------------
    by_name: dict[str, list[tuple[int, int, int]]] = {}
    n_ways = 0
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {}) or {}
        hw = tags.get("highway")
        if hw not in ("secondary", "tertiary"):
            continue
        name = tags.get("name")
        if not name:
            continue
        pts = way_to_points(el)
        if len(pts) < 2:
            continue
        mid = pts[len(pts) // 2]
        x, y = lonlat_to_px(mid[0], mid[1], size)
        # rank: 0 = secondary（較重要，優先畫）, 1 = tertiary
        by_name.setdefault(name, []).append((0 if hw == "secondary" else 1, x, y))
        n_ways += 1

    # --- 2) 同名內部篩選（最小間距 + 上限） ------------------------------
    min_same_px = min_same_ratio * size
    min_sq = min_same_px * min_same_px
    candidates: list[tuple[int, str, int, int]] = []
    for name, pts in by_name.items():
        chosen: list[tuple[int, int]] = []
        # secondary 優先；同名內部再按座標排序，確保 deterministic
        for rank, x, y in sorted(pts, key=lambda p: (p[0], p[2], p[1])):
            if len(chosen) >= max_per_name:
                break
            if any((x - cx) ** 2 + (y - cy) ** 2 < min_sq for cx, cy in chosen):
                continue
            chosen.append((x, y))
        for x, y in chosen:
            candidates.append((rank, name, x, y))

    # --- 3) 全域碰撞檢測（空間網格） -------------------------------------
    font_px = max(1, getattr(font, "size", size // 140))
    cell = max(4, int(round(font_px * cell_ratio)))
    occupied: set[tuple[int, int]] = set()
    placed: list[tuple[str, int, int]] = []
    for _rank, name, x, y in sorted(candidates, key=lambda c: (c[0], c[1])):
        txt = _short_label(name)
        try:
            bbox = probe.textbbox((x, y), txt, font=font, anchor="mm")
        except Exception:  # pragma: no cover - 退化字體
            bbox = (x - cell, y - cell, x + cell, y + cell)
        cells = {
            (cx, cy)
            for cx in range(bbox[0] // cell, bbox[2] // cell + 1)
            for cy in range(bbox[1] // cell, bbox[3] // cell + 1)
        }
        if cells & occupied:
            continue
        occupied |= cells
        placed.append((name, x, y))

    stats = {"ways": n_ways, "names": len(by_name), "candidates": len(candidates)}
    return placed, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Render HK basemap from OSM")
    parser.add_argument("--size", type=int, default=2048,
                        help="Output image edge size in pixels (default 2048)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT_PNG,
                        help="Output PNG path")
    parser.add_argument("--labels-out", type=Path, default=DEFAULT_OUTPUT_LABELS_PNG,
                        help="Output transparent label-overlay PNG path (Phase I)")
    parser.add_argument("--coords", type=Path, default=DEFAULT_OUTPUT_JSON,
                        help="Output coords JSON path")
    parser.add_argument("--skip-fetch", action="store_true",
                        help="Use cached fetch data (faster local rerender)")
    args = parser.parse_args()

    cache_path = REPO / "data" / "private" / "cache" / "osm-hk.json"
    if args.skip_fetch and cache_path.exists():
        print(f"Using cached OSM data from {cache_path}")
        with cache_path.open(encoding="utf-8") as f:
            data = json.load(f)
    else:
        print("Fetching OSM data from Overpass API…")
        data = fetch_overpass(OVERPASS_QUERY)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with cache_path.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        print(f"  cached to {cache_path}")
    print(f"  {len(data.get('elements', []))} elements received")

    print(f"Rendering {args.size}x{args.size} basemap…")
    img = render_basemap(data, args.size)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out, "PNG", optimize=True)
    print(f"  saved {args.out} ({args.out.stat().st_size:,} bytes)")

    # Phase I: 獨立透明標籤圖層（次要街道名），前端按 zoom 控制透明度
    print("Rendering label overlay…")
    overlay = render_label_overlay(data, args.size)
    args.labels_out.parent.mkdir(parents=True, exist_ok=True)
    overlay.save(args.labels_out, "PNG", optimize=True)
    print(f"  saved {args.labels_out} ({args.labels_out.stat().st_size:,} bytes)")

    # Coord metadata for front-end
    coords = {
        "size_px": args.size,
        "bbox": HK_BBOX,
        "projection": "lonlat_to_xy_linear",
        "note": "lon=x*scale+lon_min; lat=lat_max-y*scale (image y axis points down)",
        "layers": {
            "base": args.out.name,
            "label_detail": args.labels_out.name,
            "label_detail_note": (
                "透明 RGBA 圖層，只含 secondary/tertiary 街道名；"
                "前端 #label-detail-layer 按 viewScale 控制 opacity"
            ),
        },
    }
    args.coords.parent.mkdir(parents=True, exist_ok=True)
    with args.coords.open("w", encoding="utf-8") as f:
        json.dump(coords, f, ensure_ascii=False, indent=2)
    print(f"  saved {args.coords}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

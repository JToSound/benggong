#!/usr/bin/env python3
"""《病港》— Phase I: 全港 fallback anchor pool 生成器（deterministic）。

問題背景
--------
`src/data/fallbackAnchors.ts` 原本聲稱有 503 個「全港」anchor，但實測
有 **69 個係深圳 POI**（華強北站、福田站、深圳圖書館、深圳市公安局…）。
成因：Phase G 嘅 Overpass 查詢 bbox 北緣（lat_max = 22.55）掠過深圳，
而 anchor pool 亦係由同一批資料衍生，於是深圳市區嘅 POI 被當成香港
landmark 收錄。

呢個係真實資料缺陷，唔可以靠 clamp 座標掩蓋 —— 深圳 POI 錨定到香港
座標等於捏造位置。

為何唔可以只用「簡體字」過濾
----------------------------
部分深圳地名用繁體同形字（老街站、深大站、燕南站、人民南站…），
單靠字形判別會漏網；而部分香港邊境地名（文錦渡檢查站、得月樓警崗）
緯度比深圳部分地方更高，單靠緯度亦分唔開。所以本腳本用**香港行政
邊界多邊形**做 point-in-polygon 判別，呢個係唯一可靠嘅方法。

資料來源
--------
- `data/private/cache/fallback-anchors.json`：curated anchor pool
- `data/private/cache/osm-hk.json`：Phase G OSM 向量 cache（補足來源）
- `data/private/cache/hk-boundary.geojson`：香港行政邊界（OSM relation
  913110，經 Nominatim 取得；cache 唔存在時會自動抓取）

用法
----
    python scripts/gen_fallback_anchors.py            # 生成
    python scripts/gen_fallback_anchors.py --check    # 只驗證輸出係否最新
    python scripts/gen_fallback_anchors.py --offline  # 禁止聯網抓邊界

輸出永遠 deterministic：同一組輸入 → byte-identical 輸出。

Author: JToSound (benggong project)
License: ODbL (OpenStreetMap data) + project license
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO / "data" / "private" / "cache"
ANCHOR_CACHE = CACHE_DIR / "fallback-anchors.json"
OSM_CACHE = CACHE_DIR / "osm-hk.json"
BOUNDARY_CACHE = CACHE_DIR / "hk-boundary.geojson"
OUT_TS = REPO / "src" / "data" / "fallbackAnchors.ts"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "BingGangMap/0.1 (benggong project; github.com/JToSound/benggong)"

# 同 render_hk_basemap.py / public/assets/hk-basemap-coords.json 一致。
HK_BBOX = {
    "lon_min": 113.85,
    "lon_max": 114.45,
    "lat_min": 22.18,
    "lat_max": 22.55,
}

# Pool 目標大小（同 Phase I 設計文件一致）。
TARGET_COUNT = 503

# 補足候選嘅品質要求：名字必須雙語（中文 + 拉丁字母），同 curated pool
# 嘅風格一致。咁可以排除 "Office"、"1234Space" 等無意義或內地純英文名。
CJK_RE = re.compile(r"[\u3400-\u9fff]")
LATIN_RE = re.compile(r"[A-Za-z]")

GOV_AMENITIES = {
    "townhall", "police", "fire_station", "post_office",
    "courthouse", "library", "government", "ranger_station",
}
SCHOOL_AMENITIES = {"school", "kindergarten", "university", "college"}
TRANSIT_RAILWAYS = {"station", "halt", "tram_stop", "subway_entrance"}

# kind 順序固定，令 round-robin 結果 deterministic。
KIND_ORDER = ("transit", "school", "hospital", "gov", "mall", "park", "place")


# --------------------------------------------------------------------------
# 邊界幾何
# --------------------------------------------------------------------------
def fetch_boundary() -> dict[str, Any]:
    """由 Nominatim 抓香港行政邊界 GeoJSON（一次，之後用 cache）。"""
    import requests  # 延遲 import，令 --offline 模式唔需要 requests

    print("抓取香港行政邊界（Nominatim / OSM relation 913110）…")
    r = requests.get(
        NOMINATIM_URL,
        params={
            "q": "Hong Kong",
            "format": "json",
            "polygon_geojson": 1,
            "limit": 1,
            "featureType": "state",
        },
        headers={"User-Agent": USER_AGENT},
        timeout=120,
    )
    r.raise_for_status()
    results = r.json()
    if not results:
        raise SystemExit("Nominatim 冇回傳香港邊界，無法繼續")
    geo = results[0]["geojson"]
    BOUNDARY_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with BOUNDARY_CACHE.open("w", encoding="utf-8") as f:
        json.dump(geo, f, ensure_ascii=False)
    print(f"  已快取到 {BOUNDARY_CACHE.relative_to(REPO)}")
    return geo


def load_boundary(offline: bool) -> dict[str, Any]:
    if BOUNDARY_CACHE.exists():
        with BOUNDARY_CACHE.open(encoding="utf-8") as f:
            return json.load(f)
    if offline:
        raise SystemExit(
            f"缺少 {BOUNDARY_CACHE.relative_to(REPO)}；--offline 模式下唔會聯網抓取。"
        )
    return fetch_boundary()


def _rings(geo: dict[str, Any]) -> list[list[list[float]]]:
    """抽出所有 outer ring（支援 Polygon / MultiPolygon）。"""
    t = geo.get("type")
    c = geo.get("coordinates") or []
    if t == "Polygon":
        return [c[0]] if c else []
    if t == "MultiPolygon":
        return [poly[0] for poly in c if poly]
    if t == "GeometryCollection":
        out: list[list[list[float]]] = []
        for sub in geo.get("geometries", []):
            out.extend(_rings(sub))
        return out
    return []


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon（單一 ring）。"""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / (yj - yi) + xi
        ):
            inside = not inside
        j = i
    return inside


class HKBoundary:
    """香港邊界判別器（union of outer rings）。"""

    def __init__(self, geo: dict[str, Any]) -> None:
        self.rings = _rings(geo)
        if not self.rings:
            raise SystemExit("邊界 GeoJSON 冇有效 ring")

    def contains(self, lon: float, lat: float) -> bool:
        # 先做 bbox 快速篩選（同前端 viewBox 判準一致）
        if not (
            HK_BBOX["lon_min"] <= lon <= HK_BBOX["lon_max"]
            and HK_BBOX["lat_min"] <= lat <= HK_BBOX["lat_max"]
        ):
            return False
        return any(point_in_ring(lon, lat, r) for r in self.rings)


# --------------------------------------------------------------------------
# OSM tag → anchor kind
# --------------------------------------------------------------------------
def classify(tags: dict[str, Any]) -> str | None:
    if tags.get("shop") == "mall":
        return "mall"
    if tags.get("amenity") == "hospital":
        return "hospital"
    if tags.get("amenity") in SCHOOL_AMENITIES:
        return "school"
    if tags.get("leisure") == "park" or tags.get("landuse") == "park":
        return "park"
    if tags.get("amenity") in GOV_AMENITIES:
        return "gov"
    if tags.get("railway") in TRANSIT_RAILWAYS:
        return "transit"
    if tags.get("public_transport") == "station":
        return "transit"
    return None


def way_centroid(el: dict[str, Any]) -> tuple[float, float] | None:
    geom = el.get("geometry") or []
    if not geom:
        return None
    lon = sum(p["lon"] for p in geom) / len(geom)
    lat = sum(p["lat"] for p in geom) / len(geom)
    return lon, lat


def load_json(path: Path) -> Any:
    if not path.exists():
        raise SystemExit(f"缺少必要檔案：{path}")
    with path.open(encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------
# 補足
# --------------------------------------------------------------------------
def build_candidates(
    osm: dict[str, Any], boundary: HKBoundary, existing: set[str]
) -> dict[str, list[tuple[str, float, float]]]:
    by_kind: dict[str, list[tuple[str, float, float]]] = {k: [] for k in KIND_ORDER}
    seen = set(existing)
    for el in osm.get("elements", []):
        tags = el.get("tags") or {}
        name = tags.get("name")
        if not name or len(name) < 2 or name in seen:
            continue
        # 品質要求：雙語名（中文 + 拉丁），同 curated pool 風格一致
        if not (CJK_RE.search(name) and LATIN_RE.search(name)):
            continue
        kind = classify(tags)
        if kind is None:
            continue
        c = way_centroid(el)
        if c is None:
            continue
        lon, lat = c
        if not boundary.contains(lon, lat):
            continue
        by_kind[kind].append((name, round(lon, 4), round(lat, 4)))
        seen.add(name)
    # deterministic：按名字碼點排序
    for k in by_kind:
        by_kind[k] = sorted(set(by_kind[k]))
    return by_kind


def round_robin(
    by_kind: dict[str, list[tuple[str, float, float]]], need: int
) -> list[tuple[str, str, float, float]]:
    """按 kind 輪流補足，令各 kind 分佈平均（deterministic）。"""
    picked: list[tuple[str, str, float, float]] = []
    cursors = {k: 0 for k in KIND_ORDER}
    while len(picked) < need:
        progressed = False
        for k in KIND_ORDER:
            if len(picked) >= need:
                break
            i = cursors[k]
            if i < len(by_kind.get(k, [])):
                name, lon, lat = by_kind[k][i]
                cursors[k] = i + 1
                picked.append((name, k, lon, lat))
                progressed = True
        if not progressed:
            break
    return picked


# --------------------------------------------------------------------------
# 輸出
# --------------------------------------------------------------------------
def render_ts(pool: dict[str, dict[str, Any]]) -> str:
    """Render fallbackAnchors.ts。格式必須符合 tests/phase-i.test.ts 嘅 regex。"""
    lines = [
        "// Phase I: Full-Hong-Kong FALLBACK_ANCHORS pool — 全港 landmark anchors",
        "// 由 scripts/gen_fallback_anchors.py 自動生成（deterministic，可重跑）。",
        "// 來源：data/private/cache/fallback-anchors.json（curated）+",
        "//       data/private/cache/osm-hk.json（OSM Overpass，ODbL）。",
        "// 每個 entry: {lon, lat, kind} — 用嚟將故事地點錨定到真實香港座標。",
        "// 全部座標經香港行政邊界（OSM relation 913110）point-in-polygon 驗證，",
        "// 深圳 POI 一律剔除；座標保證喺香港 bbox 113.85-114.45 / 22.18-22.55 內。",
        "",
        "export interface FullHKAnchor {",
        "  lon: number;",
        "  lat: number;",
        "  kind: string;",
        "}",
        "",
        "export const FULL_HK_ANCHORS: Record<string, FullHKAnchor> = {",
    ]
    for name in sorted(pool):
        e = pool[name]
        lines.append(
            f'  {json.dumps(name, ensure_ascii=False)}: '
            f'{{ lon: {e["lon"]}, lat: {e["lat"]}, '
            f'kind: {json.dumps(e["kind"], ensure_ascii=False)} }},'
        )
    lines.append("};")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="生成全港 fallback anchor pool")
    parser.add_argument("--check", action="store_true",
                        help="只檢查現有輸出係否最新，唔寫檔")
    parser.add_argument("--offline", action="store_true",
                        help="禁止聯網抓取邊界（cache 必須已存在）")
    args = parser.parse_args()

    boundary = HKBoundary(load_boundary(args.offline))
    print(f"香港邊界：{len(boundary.rings)} 個 outer ring")

    curated = load_json(ANCHOR_CACHE)
    print(f"讀入 curated pool：{len(curated)} 個 entry")

    # Step 1 — 剔除香港境外 entry（深圳 POI）
    dropped: list[tuple[str, float, float]] = []
    pool: dict[str, dict[str, Any]] = {}
    for name, v in curated.items():
        lon, lat = float(v["lon"]), float(v["lat"])
        if boundary.contains(lon, lat):
            pool[name] = {"lon": lon, "lat": lat, "kind": v["kind"]}
        else:
            dropped.append((name, lon, lat))

    print(f"剔除香港境外 entry（深圳 POI）：{len(dropped)} 個")
    for name, lon, lat in sorted(dropped)[:10]:
        print(f"  - {name}  ({lon}, {lat})")
    if len(dropped) > 10:
        print(f"  … 其餘 {len(dropped) - 10} 個")

    # Step 2 — 由 OSM cache 補足
    need = TARGET_COUNT - len(pool)
    if need > 0:
        osm = load_json(OSM_CACHE)
        by_kind = build_candidates(osm, boundary, set(pool))
        print("OSM cache 候選數（按 kind）："
              + ", ".join(f"{k}={len(by_kind.get(k, []))}" for k in KIND_ORDER))
        added = round_robin(by_kind, need)
        for name, kind, lon, lat in added:
            pool[name] = {"lon": lon, "lat": lat, "kind": kind}
        print(f"由 OSM cache 補足：{len(added)} 個")
        for name, kind, lon, lat in added:
            print(f"  + [{kind}] {name}  ({lon}, {lat})")
        if len(added) < need:
            print(f"⚠ 候選不足：需要 {need}，只補到 {len(added)}", file=sys.stderr)
    else:
        print("唔需要補足（pool 已達標）")

    # Step 3 — 驗證
    if len(pool) < TARGET_COUNT:
        print(f"✗ pool 只有 {len(pool)} 個，未達 {TARGET_COUNT}", file=sys.stderr)
        return 1
    for name, e in pool.items():
        assert boundary.contains(e["lon"], e["lat"]), f"{name} 唔喺香港境內: {e}"
        assert e["kind"], f"{name} 缺少 kind"

    kinds: dict[str, int] = {}
    for e in pool.values():
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    print(f"最終 pool：{len(pool)} 個；分佈 " + ", ".join(
        f"{k}={v}" for k, v in sorted(kinds.items())))

    out = render_ts(pool)
    digest = hashlib.sha256(out.encode("utf-8")).hexdigest()

    if args.check:
        current = OUT_TS.read_text(encoding="utf-8") if OUT_TS.exists() else ""
        if current != out:
            print("✗ src/data/fallbackAnchors.ts 唔係最新，請重跑本腳本",
                  file=sys.stderr)
            return 1
        print(f"✓ src/data/fallbackAnchors.ts 已係最新（sha256 {digest[:16]}…）")
        return 0

    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUT_TS.write_text(out, encoding="utf-8")
    print(f"寫入 {OUT_TS.relative_to(REPO)}（{OUT_TS.stat().st_size:,} bytes）")
    print(f"  sha256 {digest}")

    with ANCHOR_CACHE.open("w", encoding="utf-8") as f:
        json.dump(pool, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"回寫 {ANCHOR_CACHE.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

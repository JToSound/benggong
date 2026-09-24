#!/usr/bin/env python3
"""《病港》— Phase E routes geojson generator（master prompt §10.4）。

讀 data/private/review/character-routes.json（人手已審 alias 合併版）
+ data/public/locations.geojson（取每個 waypoint 嘅 story_position x/y → 投影到香港座標）
+ data/public/characters.json（取 character_id）
→ 輸出 data/public/routes.geojson

每條 route 包含（按 data/schemas/route.schema.json）：
- id: route_<char_slug>_<seq>
- character_id, character_name, color
- chapters_span: [first, last]
- precision: fictional (location 為虛構)
- waypoints: [{location_id, chapter, note, confidence}]
- source, review_status

用法：python scripts/derive_routes_geojson.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from collections import defaultdict

REPO = Path(__file__).resolve().parent.parent
PRIVATE_ROUTES = REPO / "data/private/review/character-routes.json"
PUBLIC_LOC = REPO / "data/public/locations.geojson"
PUBLIC_CHARS = REPO / "data/public/characters.json"
PUBLIC_ROUTES = REPO / "data/public/routes.geojson"
MANUAL = REPO / "data/private/review/manual-resolutions.json"


def slugify(s: str) -> str:
    s = re.sub(r"[\s\u3000]+", "_", s)
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "", s)
    return s.lower()[:40] or "char"


def load_location_coords() -> dict[str, dict]:
    """location name → {id, coordinates, fictional}"""
    if not PUBLIC_LOC.exists():
        return {}
    doc = json.loads(PUBLIC_LOC.read_text(encoding="utf-8"))
    coords: dict[str, dict] = {}
    for feat in doc.get("features", []):
        p = feat.get("properties", {})
        name = p.get("name", "")
        if not name:
            continue
        geom = feat.get("geometry", {}).get("coordinates", [None, None])
        if geom and len(geom) == 2:
            coords[name] = {
                "id": p.get("id", name),
                "coordinates": list(geom),
                "fictional": bool(p.get("fictional", True)),
            }
    return coords


def load_characters() -> dict[str, dict]:
    """character name → {id, color, fictional_aliases}

    Phase E: 套用 manual-resolutions.json 嘅 merge_routes，將 alias character records
    合併到 target。例：「老師」、「鳥嘴」、「奎斯老師」等 alias → 主角
    """
    if not PUBLIC_CHARS.exists():
        return {}
    chars_doc = json.loads(PUBLIC_CHARS.read_text(encoding="utf-8"))
    chars: dict[str, dict] = {}
    for c in chars_doc:
        name = c.get("name", "")
        if not name:
            continue
        chars[name] = {
            "id": c.get("id", name),
            "color": c.get("color", "#888888"),
        }

    # Phase E: 套用 manual-resolutions.json 嘅 merge_routes
    if MANUAL.exists():
        try:
            res = json.loads(MANUAL.read_text(encoding="utf-8"))
            decisions = res.get("decisions", [])
            for d in decisions:
                if d.get("action") != "merge_routes":
                    continue
                for m in d.get("merges", []):
                    target = m.get("into", "")
                    sources = set(m.get("from_aliases", []))
                    if not target or target not in chars:
                        continue
                    target_info = chars[target]
                    for src in sources:
                        if src == target or src not in chars:
                            continue
                        # 將 src 嘅 record 移除，並將 src name 標為 alias of target
                        src_info = chars.pop(src)
                        # Phase E: 用 target 嘅 id 統一（routes 會有相同 character_id）
                        # 但要保留 src 嘅 color if target 冇（其實 target 已 ok）
                        chars[src] = {
                            "id": target_info["id"],  # 統一 id
                            "color": target_info.get("color", src_info.get("color")),
                        }
        except (json.JSONDecodeError, OSError):
            pass
    return chars


def build_routes(
    char_routes: list[dict],
    loc_coords: dict[str, dict],
    characters: dict[str, dict],
) -> dict:
    features = []
    skipped_short = []
    skipped_no_coords = []

    for seq, r in enumerate(char_routes, 1):
        waypoints = r.get("waypoints", [])
        character_name = r.get("character", "")
        if len(waypoints) < 2:
            skipped_short.append(character_name)
            continue

        # 將 waypoints 轉座標 + waypoint entries
        line_coords = []
        wp_entries = []
        missing = []
        chapters_seen = []
        for w in waypoints:
            loc = w.get("location")
            ch = w.get("chapter")
            if ch is not None:
                chapters_seen.append(ch)
            info = loc_coords.get(loc)
            if info is None:
                missing.append(loc)
                continue
            line_coords.append(info["coordinates"])
            wp_entries.append({
                "location_id": info["id"],
                "chapter": ch,
                "note": (loc or "")[:80],
                "confidence": 0.85,  # routes 推導 conf — Phase E auto-generated
            })
        if len(line_coords) < 2:
            skipped_no_coords.append((character_name, missing))
            continue

        char_info = characters.get(character_name, {})
        if not char_info:
            # character name 唔喺 public characters.json — skip（Phase E 仍未拆出）
            skipped_no_coords.append((character_name, ["character not in public dataset"]))
            continue
        # ID: route_<char_id_slug>_<seq> (ASCII only to match schema regex)
        # characters.json 入面 id 例如 "ent_970c603b4f" 或 "w" 或 "boss" — 取 alphanumeric part
        char_id = char_info.get("id", character_name)
        # slugify: keep alnum + underscore
        char_id_slug = re.sub(r"[^a-z0-9_]", "_", char_id.lower())[:30].strip("_") or "x"
        route_id = f"route_{char_id_slug}_{seq:03d}"
        chapters_span = [min(chapters_seen), max(chapters_seen)] if chapters_seen else [0, 0]

        feat = {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": line_coords,
            },
            "properties": {
                "id": route_id,
                "character_id": char_info.get("id", character_name),
                "character_name": character_name,
                "color": char_info.get("color", "#888888"),
                "chapters_span": chapters_span,
                "chapters": sorted(set(chapters_seen))[:50],
                "precision": "fictional",  # 全部 fictional 投影
                "waypoints": wp_entries,
                "missing_waypoint_locations": missing if missing else None,
                "provenance": "character-routes.json → derive_routes_geojson.py",
                "source": "bing_gang",
                "confidence": 0.8,
                "review_status": "needs_review",  # routes from private review need manual review
            },
        }
        features.append(feat)

    return {
        "type": "FeatureCollection",
        "features": features,
        "_meta": {
            "skipped_short": skipped_short,
            "skipped_no_coords": skipped_no_coords,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase E routes geojson generator")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not PRIVATE_ROUTES.exists():
        print(f"[blocked] {PRIVATE_ROUTES} 不存在")
        return 2
    char_routes = json.loads(PRIVATE_ROUTES.read_text(encoding="utf-8"))
    print(f"讀取 {len(char_routes)} 條 character-routes（人手審閱版）")

    loc_coords = load_location_coords()
    print(f"讀取 {len(loc_coords)} 個 location 座標")

    characters = load_characters()
    print(f"讀取 {len(characters)} 個 character 記錄")

    fc = build_routes(char_routes, loc_coords, characters)
    n_feats = len(fc["features"])
    n_short = len(fc["_meta"]["skipped_short"])
    n_no = len(fc["_meta"]["skipped_no_coords"])

    print(f"\n產生 {n_feats} 條 routes")
    if n_short:
        print(f"  跳過（waypoints<2）：{n_short} 個 character：{fc['_meta']['skipped_short'][:5]}")
    if n_no:
        print(f"  跳過（座標缺）：{n_no} 個 character")
        for char, missing in fc["_meta"]["skipped_no_coords"][:5]:
            print(f"    {char}: missing {missing[:3]}")

    if args.dry_run:
        print(f"\n[dry-run] 未寫入 {PUBLIC_ROUTES}")
        return 0

    public_doc = {
        "type": "FeatureCollection",
        "features": fc["features"],
    }
    PUBLIC_ROUTES.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_ROUTES.write_text(json.dumps(public_doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✅ 寫入 {PUBLIC_ROUTES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

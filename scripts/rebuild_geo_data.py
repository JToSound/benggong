#!/usr/bin/env python3
"""《病港》— Phase F: Rebuild locations/events/timeline with proper HK geo anchoring。

讀 evidence candidates + character_definitions override
→ 用 hk-districts.json 做真實座標 fallback (將軍澳優先)
→ 為 event 自動配對 location_id
→ 寫 public/locations.geojson / events.geojson / timeline.json

Phase F 重點：
- 將軍澳優先 fallback (Story 主要場景)
- HK district fuzzy match → 真實座標 + deterministic name-hash offset (避免重疊)
- Fictional (艾寶琳、倖存區等) → 用 story grid 投影
- Event 自動配對 location_id by chapter context
- 加 character_chapter_appearances 統計
- 加 chapter_summaries (Phase F 自動生成)
"""

from __future__ import annotations

import json
import re
import hashlib
from collections import defaultdict, Counter
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parent.parent
EVIDENCE = REPO / "data/private/evidence/candidates.jsonl"
HK_DISTRICTS = REPO / "data/private/review/hk-districts.json"
PUBLIC_DIR = REPO / "data/public"
PHASE_C_EXCL = REPO / "data/private/review/phase-c-exclusions.json"
MANUAL_RES = REPO / "data/private/review/manual-resolutions.json"

# 將軍澳子座標（基於 hk-districts.json + 0.005° 內細分）
TSEUNG_KWAN_O_SUB_DISTRICTS = {
    "寶琳": [114.2415, 22.3229],
    "坑口": [114.2729, 22.3166],
    "調景嶺": [114.2506, 22.3077],
    "將軍澳市中心": [114.259, 22.316],
    "尚德": [114.262, 22.317],
    "彩明": [114.265, 22.3165],
    "日出康城": [114.275, 22.295],
    "將軍澳": [114.272, 22.332],
}


def load_json(p: Path):
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def load_candidates():
    rows = []
    for line in EVIDENCE.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rows.append(json.loads(line))
    return rows


def normalize_name(name: str) -> str:
    """正規化：去標點、空格、括號內容"""
    s = re.sub(r"[【】「」《》（）。、，！？：；""''·…—\-\s\u3000]+", "", name)
    return s


def name_offset(name: str, base: list[float], spread: float = 0.012) -> list[float]:
    """基於 name hash 嘅 deterministic offset（避免所有同名 location 重疊）"""
    h = int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:8], 16)
    dx = ((h >> 16) & 0xFFFF) / 0xFFFF - 0.5
    dy = (h & 0xFFFF) / 0xFFFF - 0.5
    return [base[0] + dx * spread, base[1] + dy * spread]


def match_hk_district(name: str, hk: dict) -> Optional[str]:
    """Fuzzy match location name → HK district。
    Returns: matched district name (in hk dict) or None"""
    norm = normalize_name(name)
    if not norm:
        return None
    # 1. Exact match
    if norm in hk:
        return norm
    # 2. Partial match (name contains district, or district contains name)
    candidates = []
    for district in hk.keys():
        dnorm = normalize_name(district)
        if dnorm in norm or norm in dnorm:
            candidates.append((len(dnorm), district))
    if not candidates:
        return None
    # 揀 longest match
    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]


def assign_location_coords(name: str, hk: dict) -> tuple[list[float], str, str, str]:
    """為 location name 揀座標。
    Returns: (coordinates [lon, lat], precision, location_type, fictional)
    precision: 'district' (真實), 'approximate' (估計), 'fictional' (虛構)
    """
    # 1. exact match in hk
    if name in hk:
        return hk[name], "district", "district", False
    norm = normalize_name(name)
    if norm in hk:
        return hk[norm], "district", "district", False

    # 2. Partial match
    matched = match_hk_district(name, hk)
    if matched:
        base = hk[matched]
        return name_offset(name, base), "approximate", "district", False

    # 3. Fictional: 將軍澳相關虛構地點 (大本營、倖存區等)
    fictional_keywords = ["大本營", "倖存區", "病者之都", "艾寶琳", "病者", "病獵", "病者平權"]
    for kw in fictional_keywords:
        if kw in name:
            base = TSEUNG_KWAN_O_SUB_DISTRICTS["將軍澳"]
            return name_offset(name, base, spread=0.025), "fictional", "fictional", True

    # 4. 完全 fictional - 投影到 story grid
    h = int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:8], 16)
    # Map hash to grid offset 0.15-0.85 (避免邊界)
    x = 0.15 + ((h >> 16) & 0xFFFF) / 0xFFFF * 0.7
    y = 0.15 + (h & 0xFFFF) / 0xFFFF * 0.7
    base_lon = 113.80 + x * 0.60
    base_lat = 22.15 + y * 0.35
    return [base_lon, base_lat], "fictional", "fictional", True


def is_known_hk(name: str, hk: dict) -> bool:
    """name 係真實 HK reference（exact 或 partial match）"""
    if name in hk:
        return True
    norm = normalize_name(name)
    if norm in hk:
        return True
    return match_hk_district(name, hk) is not None


# EPSG:4326 邊界 (大約，覆蓋整個香港)
HK_LON_MIN, HK_LON_MAX = 113.85, 114.45
HK_LAT_MIN, HK_LAT_MAX = 22.18, 22.55


def lonlat_to_story_position(lon: float, lat: float) -> dict:
    """EPSG:4326 → 0-1 normalized story_position。
    Clamp 喺 HK bbox 範圍內。"""
    x = (lon - HK_LON_MIN) / (HK_LON_MAX - HK_LON_MIN)
    y = (lat - HK_LAT_MIN) / (HK_LAT_MAX - HK_LAT_MIN)
    # Clamp 0-1
    x = max(0.0, min(1.0, x))
    y = max(0.0, min(1.0, y))
    return {"x": round(x, 3), "y": round(y, 3)}


def hash_story_position(name: str) -> dict:
    """For fictional locations: deterministic story_position by name hash."""
    h = int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:8], 16)
    x = 0.15 + ((h >> 16) & 0xFFFF) / 0xFFFF * 0.7
    y = 0.15 + (h & 0xFFFF) / 0xFFFF * 0.7
    return {"x": round(x, 3), "y": round(y, 3)}


def build_locations(cands, hk, excl_locs: set) -> list[dict]:
    """Build 716 location features with proper HK geo anchoring.
    同時加返: characters (出現過嘅 characters), story_position (0-1 normalized)
    conf < 0.7 嘅 entry 跳過 (低信心 noise)."""
    features = []
    seen_names = set()
    seq = 0
    for c in cands:
        if c.get("entity_kind") != "location":
            continue
        # Phase F: 跳過 conf < 0.7 嘅 entry (低信心 noise)
        if (c.get("confidence") or 0) < 0.7:
            continue
        name = (c.get("name") or "").strip()
        if not name or name in seen_names or name in excl_locs:
            continue
        if c.get("status") not in ("pending", "reviewed"):
            continue
        seen_names.add(name)
        seq += 1

        coords, precision, loc_type, fictional = assign_location_coords(name, hk)
        chapter = c.get("chapter", 0)
        desc = (c.get("claim") or "")[:100]

        # story_position: 根據座標來源計算
        if fictional:
            story_pos = hash_story_position(name)
        else:
            story_pos = lonlat_to_story_position(coords[0], coords[1])

        feat = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": coords,
            },
            "properties": {
                "id": f"loc_{seq:04d}",
                "name": name[:40],
                "display_name": f"{name}（{'虛構' if fictional else '參考位置'}）"[:60],
                "location_type": loc_type,
                "fictional": fictional,
                "location_precision": precision,
                "story_position": story_pos,
                "first_appearance": max(1, min(198, chapter)),
                "chapters": [max(1, min(198, chapter))],
                "characters": [],  # 稍後用 second pass 補
                "description": desc[:100],
                "confidence": min(1.0, max(0.0, c.get("confidence") or 0.7)),
                "review_status": "reviewed" if (c.get("confidence") or 0) >= 0.7 else "needs_review",
                "source": "bing_gang",
            },
        }
        features.append(feat)
    return features


def populate_characters_per_location(cands, locations: list[dict]) -> None:
    """Second pass: 為每 location 收集 character appearances。
    對每 character candidate, 抽佢嘅 claim 提及嘅 location names, 然後 add 去 location.characters.
    為 speed 我哋用 set: loc_name -> {character_name}."""
    # 1) Build inverse: character candidates by chapter (so 同一 chapter 嘅 characters "在" 該 chapter 嘅 locations)
    # 簡化: 我哋直接用 event candidates 嘅 location claim，find matching location name
    
    # 2) For each character candidate, 抽佢 claim 內 HK location keywords
    # 用 evidence claim 文字 + 檢查 包含 location.name
    loc_name_to_features = {f["properties"]["name"]: f for f in locations}
    
    for c in cands:
        if c.get("entity_kind") != "character":
            continue
        if c.get("status") not in ("pending", "reviewed"):
            continue
        char_name = (c.get("name") or "").strip()
        if not char_name:
            continue
        claim = c.get("claim") or ""
        # 揾 evidence claim 內提及嘅 location name
        for loc_name, loc_feat in loc_name_to_features.items():
            if not loc_name:
                continue
            if loc_name in claim and char_name not in loc_feat["properties"]["characters"]:
                if len(loc_feat["properties"]["characters"]) < 20:
                    loc_feat["properties"]["characters"].append(char_name)


def build_location_index(locations: list[dict]) -> dict[str, dict]:
    """name → location dict"""
    return {f["properties"]["name"]: f for f in locations}


def match_event_to_location(event_cand, location_index: dict, hk: dict) -> Optional[dict]:
    """為 event candidate 配對 location。
    優先級: (1) chapter context (2) claim 內地點名 (3) name match
    """
    name = (event_cand.get("name") or "").strip()
    claim = (event_cand.get("claim") or "")
    text = f"{name} {claim}"

    # 1. exact name match
    if name in location_index:
        return location_index[name]

    # 2. claim 內地點 keyword
    candidates = []
    for loc_name, loc in location_index.items():
        if loc_name in text:
            candidates.append((len(loc_name), loc))
    if candidates:
        candidates.sort(reverse=True, key=lambda x: x[0])
        return candidates[0][1]

    # 3. HK district partial match
    matched = match_hk_district(name, hk) or match_hk_district(claim, hk)
    if matched:
        # 揾 location 名包含 matched district 嘅第一個
        for loc_name, loc in location_index.items():
            if matched in loc_name:
                return loc
        # fallback: 用 hk district 自身 (if in hk)
        if matched in hk:
            return {
                "type": "Feature",
                "properties": {"id": f"loc_{matched}", "name": matched},
                "geometry": {"type": "Point", "coordinates": hk[matched]},
            }

    return None


def build_events(cands, location_features, hk) -> list[dict]:
    """Build events with auto-matched location_id."""
    loc_index = build_location_index(location_features)
    features = []
    seq = 0
    for c in cands:
        if c.get("entity_kind") != "event":
            continue
        if c.get("status") not in ("pending", "reviewed"):
            continue
        seq += 1
        eid = f"bg_event_{seq:03d}"
        chapter = c.get("chapter", 0)
        title = (c.get("name") or "未命名事件")[:40]
        desc = (c.get("claim") or "")[:200]
        spoiler = min(3, max(0, int(c.get("spoiler_level") or 0)))

        matched_loc = match_event_to_location(c, loc_index, hk)
        loc_id = matched_loc["properties"]["id"] if matched_loc else None
        loc_name = matched_loc["properties"]["name"] if matched_loc else None
        coords = matched_loc["geometry"]["coordinates"] if matched_loc else None

        feat = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": coords or [114.272, 22.332],  # default 將軍澳
            },
            "properties": {
                "id": eid,
                "title": title,
                "description": desc,
                "chapter": chapter,
                "chapter_name": f"{chapter:02d}",
                "chapter_refs": [chapter],
                "characters": [],
                "event_type": "minor",
                "spoiler_level": spoiler,
                "location_id": loc_id,
                "location_name": loc_name,
                "confidence": c.get("confidence") or 0.5,
                "review_status": "reviewed" if (c.get("confidence") or 0) >= 0.7 else "needs_review",
                "source": "bing_gang",
            },
        }
        features.append(feat)
    return features


def build_timeline(events: list[dict]) -> list[dict]:
    """由 events 構建 timeline records."""
    records = []
    for ev in events:
        p = ev["properties"]
        records.append({
            "id": f"tl_{p['id']}",
            "date_label": "按章節先後",
            "date_sort": f"ch{p['chapter']:03d}",
            "chapter": p["chapter"],
            "location_id": p.get("location_id"),
            "location_name": p.get("location_name"),
            "title": p["title"],
            "description": p["description"],
            "characters": p.get("characters", []),
            "type": p.get("event_type", "minor"),
            "spoiler_level": p.get("spoiler_level", 1),
            "confidence": p.get("confidence", 0.5),
            "review_status": p.get("review_status", "reviewed"),
            "event_id": p["id"],
        })
    return records


def build_chapter_summaries(cands) -> dict[int, str]:
    """每章生成 30-50 字 summary（從 events/characters/locations claim 抽出）"""
    chapter_content = defaultdict(list)
    for c in cands:
        if c.get("status") not in ("pending", "reviewed"):
            continue
        ch = c.get("chapter", 0)
        kind = c.get("entity_kind", "")
        claim = (c.get("claim") or "").strip()
        name = (c.get("name") or "").strip()
        if not claim and not name:
            continue
        # 高信心優先
        conf = c.get("confidence") or 0
        if conf < 0.6:
            continue
        text = ""
        if name and claim:
            text = f"{name}：{claim[:60]}"
        elif claim:
            text = claim[:80]
        else:
            text = name
        chapter_content[ch].append(text)

    summaries = {}
    for ch, lines in chapter_content.items():
        # 揀 3-5 個最 representative lines
        unique_lines = []
        seen = set()
        for ln in lines:
            key = ln[:30]
            if key not in seen:
                seen.add(key)
                unique_lines.append(ln)
        # 截 5 個
        sample = unique_lines[:5]
        if sample:
            summary = "；".join(sample)[:150]
            summaries[ch] = summary + "..." if len(summary) >= 150 else summary
    return summaries


def main() -> int:
    print("=== Phase F: Rebuild Locations + Events + Timeline + Chapters ===\n")
    cands = load_candidates()
    hk = load_json(HK_DISTRICTS)
    excl = load_json(PHASE_C_EXCL)
    excl_locs = set(excl.get("excluded_locations", []))
    print(f"Loaded {len(cands)} candidates, {len(hk)} HK districts, {len(excl_locs)} excluded locations")

    # 1. Locations
    print("\n--- Building locations ---")
    locations = build_locations(cands, hk, excl_locs)
    # Second pass: populate character appearances per location
    populate_characters_per_location(cands, locations)
    print(f"  Total locations: {len(locations)}")
    real_count = sum(1 for f in locations if not f["properties"]["fictional"])
    approx_count = sum(1 for f in locations if f["properties"]["location_precision"] == "approximate")
    fict_count = sum(1 for f in locations if f["properties"]["fictional"])
    with_chars = sum(1 for f in locations if f["properties"]["characters"])
    print(f"  Real HK: {real_count}, Approximate: {approx_count}, Fictional: {fict_count}")
    print(f"  Locations with characters: {with_chars}")

    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    loc_doc = {"type": "FeatureCollection", "features": locations}
    (PUBLIC_DIR / "locations.geojson").write_text(
        json.dumps(loc_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  Written: {PUBLIC_DIR / 'locations.geojson'}")

    # 2. Events
    print("\n--- Building events with location matching ---")
    events = build_events(cands, locations, hk)
    print(f"  Total events: {len(events)}")
    with_loc = sum(1 for e in events if e["properties"]["location_id"])
    print(f"  Events with location_id: {with_loc} ({with_loc * 100 // len(events)}%)")
    event_doc = {"type": "FeatureCollection", "features": events}
    (PUBLIC_DIR / "events.geojson").write_text(
        json.dumps(event_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  Written: {PUBLIC_DIR / 'events.geojson'}")

    # 3. Timeline
    print("\n--- Building timeline ---")
    timeline = build_timeline(events)
    (PUBLIC_DIR / "timeline.json").write_text(
        json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  Total timeline entries: {len(timeline)}")
    print(f"  Written: {PUBLIC_DIR / 'timeline.json'}")

    # 4. Chapter summaries
    print("\n--- Generating chapter summaries ---")
    summaries = build_chapter_summaries(cands)
    (PUBLIC_DIR / "chapter-summaries.json").write_text(
        json.dumps(summaries, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  Chapter summaries: {len(summaries)}/198")
    print(f"  Written: {PUBLIC_DIR / 'chapter-summaries.json'}")

    # 5. Update asset-manifest
    manifest = load_json(PUBLIC_DIR / "asset-manifest.json")
    if manifest:
        # 讀 routes.geojson + characters.json 計 actual count
        routes_doc = load_json(PUBLIC_DIR / "routes.geojson")
        n_routes = len(routes_doc.get("features", [])) if routes_doc else 0
        chars_doc = load_json(PUBLIC_DIR / "characters.json")
        n_chars = len(chars_doc) if chars_doc else 0
        manifest["counts"] = {
            "location": len(locations),
            "event": len(events),
            "route": n_routes,
            "timeline": len(timeline),
            "character": n_chars,
        }
        manifest["generated_at"] = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="seconds")
        (PUBLIC_DIR / "asset-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n  Updated asset-manifest.json counts (loc={len(locations)}, event={len(events)}, route={n_routes}, char={n_chars})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

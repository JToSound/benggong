#!/usr/bin/env python3
"""《病港》Phase B — 公開資料驗證器。

用 JSON Schema 驗證 data/public/ 全部檔案，並執行治理規則：
- review_status 只可有 reviewed/verified（provisional sample 除外，要齊 banner）
- 禁止長段小說文本（>100 字連續 CJK 即 fail）
- 禁止雜訊／secret pattern
- location 引用一致性（events.location_id / routes.waypoints.location_id 必須存在）
- timeline.event_id deep link 一致性

用法：python scripts/validate_public_data.py [--public-dir PATH] [--allow-provisional]
Exit code：0=通過；1=有 error。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:
    print("[error] 缺少 jsonschema：請執行 pip install jsonschema")
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PUBLIC = REPO_ROOT / "data/public"
DEFAULT_SCHEMAS = REPO_ROOT / "data/schemas"

# 公開資料禁止嘅內容（雜訊殘留＝上游清理失敗；secret pattern＝治理事故）
FORBIDDEN_PATTERNS: dict[str, re.Pattern[str]] = {
    "penana_noise": re.compile(
        r"No Plagiarism|copyright protection|Please respect copyright|"
        r"[ＰＰ][ＥＥ][ＮＮ][ＡＡ][ＮＮ][ＡＡ]|And\s+\d+\s+More",
        re.IGNORECASE,
    ),
    "ip_or_secret": re.compile(
        r"\b\d{1,3}(?:\.\d{1,3}){3}\b|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._\-]{20,}",
        re.IGNORECASE,
    ),
}

# 超過 100 字連續 CJK（無標點中斷）視為疑似小說原文段落。
# 標點（U+3000–303F 中文標點、U+FF00–FFEF 全形標點）算中斷——
# 正常書面中文每十幾字就有標點；真正嘅原文長段引用先會成百字不斷。
LONG_CJK_RUN = re.compile(
    r"[\u4e00-\u9fff\u3400-\u4dbf]"
    r"(?:[^\x00-\x7f\u3000-\u303f\uff00-\uffef\n\r\t ]){100,}"
)

SCHEMA_FILES = {
    "locations.geojson": "location.schema.json",
    "events.geojson": "event.schema.json",
    "routes.geojson": "route.schema.json",
    "timeline.json": "timeline.schema.json",
    "characters.json": "character.schema.json",
    "chapter-summaries.json": "chapter-summaries.schema.json",
}


def load_schema(name: str) -> dict:
    with open(DEFAULT_SCHEMAS / name, encoding="utf-8") as f:
        return json.load(f)


def iter_features(doc):
    """GeoJSON FeatureCollection 或單一 Feature 都支援。"""
    if doc.get("type") == "FeatureCollection":
        yield from doc["features"]
    elif doc.get("type") == "Feature":
        yield doc


def check_text_governance(obj, path_hint: str) -> list[str]:
    """遞迴掃描字串值：雜訊、secret、長 CJK run。"""
    errors: list[str] = []

    def walk(o):
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, str):
            if LONG_CJK_RUN.search(o):
                errors.append(f"{path_hint}: 疑似長段小說文本（>100 連續 CJK）：{o[:40]}…")
            for name, pat in FORBIDDEN_PATTERNS.items():
                if pat.search(o):
                    errors.append(f"{path_hint}: 禁止內容 [{name}]")

    walk(obj)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="《病港》公開資料驗證器")
    parser.add_argument("--public-dir", help="data/public 目錄")
    parser.add_argument(
        "--allow-provisional",
        action="store_true",
        default=True,
        help="允許 provisional sample（全部 needs_review 但 manifest 有 banner）（預設開）",
    )
    parser.add_argument("--strict-review", action="store_true", help="只准 reviewed/verified")
    args = parser.parse_args()

    public_dir = Path(args.public_dir) if args.public_dir else DEFAULT_PUBLIC
    if not public_dir.exists():
        print(f"[error] 搵唔到 {public_dir}")
        return 1

    errors: list[str] = []
    stats: dict[str, int] = {}
    review_counts = {"verified": 0, "reviewed": 0, "needs_review": 0}
    location_ids: set[str] = set()
    event_ids: set[str] = set()

    # ---- schema validation ----
    validators = {name: Draft202012Validator(load_schema(name)) for name in set(SCHEMA_FILES.values()) if name}

    def validate_against(instance, schema_name: str, hint: str):
        for e in validators[schema_name].iter_errors(instance):
            loc = ".".join(str(p) for p in list(e.absolute_path)[:6])
            errors.append(f"{hint} [{schema_name}] {loc}: {e.message[:160]}")

    for fname, sname in SCHEMA_FILES.items():
        fpath = public_dir / fname
        if not fpath.exists():
            continue
        doc = json.loads(open(fpath, encoding="utf-8").read())
        items = list(iter_features(doc)) if fname.endswith(".geojson") else doc

        if sname:
            if fname.endswith(".geojson"):
                for i, item in enumerate(items):
                    # schema 定義喺 Feature 層（type/geometry/properties）
                    validate_against(item, sname, f"{fname}[{i}]")
            else:
                # 非 geojson：例如 chapter-summaries.json 係 object 結構
                # 為每個 chapter key 個別 validate
                if fname == "chapter-summaries.json" and isinstance(doc, dict):
                    for ch_key, ch_val in doc.items():
                        try:
                            int(ch_key)  # 確認係 numeric key
                        except ValueError:
                            errors.append(f"{fname}: chapter key 必須係 numeric string: '{ch_key}'")
                            continue
                        # 將 chapter value 包成 {chapter: ch_val} 嚟 match schema 嘅 additionalProperties
                        # Phase E: chapter-summaries 結構係 {chapter: {locations: [...]}}
                        wrapped = {ch_key: ch_val}
                        validate_against(wrapped, sname, f"{fname}[{ch_key}]")
                elif isinstance(doc, list):
                    # timeline.json / characters.json：array of records，per-record validate
                    for i, item in enumerate(doc):
                        validate_against(item, sname, f"{fname}[{i}]")
                else:
                    validate_against(doc, sname, fname)

        # 收集統計同 id
        key_map = {"locations.geojson": "location", "events.geojson": "event", "routes.geojson": "route",
                   "timeline.json": "timeline", "characters.json": "character", "chapter-summaries.json": "chapter_summary"}
        if fname in key_map:
            stats[key_map[fname]] = len(items) if isinstance(items, list) else sum(
                1 for _ in items
            )
        # chapter-summaries.json 唔需要 per-item review_status check (schema 已驗)
        if fname == "chapter-summaries.json":
            continue
        for item in items:
            p = item.get("properties", item)
            rs = p.get("review_status")
            if rs in review_counts:
                review_counts[rs] += 1
            if "id" in p:
                if fname == "locations.geojson":
                    location_ids.add(p["id"])
                elif fname == "events.geojson":
                    event_ids.add(p["id"])

            if args.strict_review and rs != "verified" and rs != "reviewed":
                errors.append(f"{fname}: strict 模式下不可有 {rs}: {p.get('id')}")

    # ---- 引用一致性 ----
    ev_path = public_dir / "events.geojson"
    if ev_path.exists():
        # 先 load locations by id (for coord consistency check)
        loc_path = public_dir / "locations.geojson"
        loc_by_id = {}
        if loc_path.exists():
            for f in iter_features(json.loads(loc_path.read_text(encoding="utf-8"))):
                loc_by_id[f["properties"]["id"]] = f
        for feat in iter_features(json.loads(ev_path.read_text(encoding="utf-8"))):
            p = feat["properties"]
            lid = p.get("location_id")
            if lid and lid not in location_ids:
                errors.append(f"events.geojson: location_id '{lid}' 唔存在於 locations")
            # Phase E: 如果有 location_id，coords 應同 location 一致
            if lid and lid in loc_by_id:
                loc_coords = loc_by_id[lid]["geometry"]["coordinates"]
                ev_coords = feat["geometry"]["coordinates"]
                # 容許微差（因為 floating point）
                if abs(loc_coords[0] - ev_coords[0]) > 0.0001 or abs(loc_coords[1] - ev_coords[1]) > 0.0001:
                    errors.append(
                        f"events.geojson: event '{p.get('id')}' location_id '{lid}' 嘅 coords "
                        f"{ev_coords} 與 location 嘅 coords {loc_coords} 唔一致（Phase E bug 確認）"
                    )

    rt_path = public_dir / "routes.geojson"
    if rt_path.exists():
        for feat in iter_features(json.loads(rt_path.read_text(encoding="utf-8"))):
            for wp in feat["properties"].get("waypoints", []):
                if wp.get("location_id") not in location_ids:
                    errors.append(f"routes.geojson: waypoint location_id '{wp.get('location_id')}' 唔存在")

    tl_path = public_dir / "timeline.json"
    if tl_path.exists():
        for rec in json.loads(tl_path.read_text(encoding="utf-8")):
            eid = rec.get("event_id")
            if eid and eid not in event_ids:
                errors.append(f"timeline.json: event_id '{eid}' 唔存在於 events")
            if rec.get("location_id") and rec["location_id"] not in location_ids:
                errors.append(f"timeline.json: location_id '{rec['location_id']}' 唔存在")

    # ---- 治理掃描 ----
    for fpath in sorted(public_dir.glob("*.json*")) + sorted(public_dir.glob("*.geojson")):
        try:
            text = fpath.read_text(encoding="utf-8")
            doc = json.loads(text)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            errors.append(f"{fpath.name}: JSON parse 失敗：{e}")
            continue
        errs = check_text_governance(doc, fpath.name)
        errors.extend(errs)

    # ---- manifest 一致性 ----
    mf_path = public_dir / "asset-manifest.json"
    if mf_path.exists():
        mf = json.loads(mf_path.read_text(encoding="utf-8"))
        declared = mf.get("counts", {})
        for k, v in stats.items():
            if declared.get(k) != v:
                errors.append(f"asset-manifest.json counts.{k}={declared.get(k)} 與實際 {v} 不符")

    # ---- provisional gate ----
    total = sum(review_counts.values())
    all_reviewed = (review_counts["needs_review"] == 0)
    if not all_reviewed:
        if not args.allow_provisional:
            errors.append("有 needs_review 資料但未允許 provisional 模式")
        else:
            mc_path = public_dir / "map-config.json"
            has_banner = False
            if mc_path.exists():
                mc = json.loads(mc_path.read_text(encoding="utf-8"))
                pm = mc.get("provisional_mode", {})
                if pm.get("enabled") and pm.get("banner"):
                    has_banner = True
            if not has_banner:
                errors.append("provisional 模式要求 map-config.json 有 enabled+banner")

    # ---- report ----
    print(f"公開資料驗證：{stats}")
    print(f"review 分佈：{review_counts}")
    if errors:
        print(f"\n❌ {len(errors)} 個錯誤：")
        for e in errors[:15]:
            print(f"  - {e}")
        return 1
    print("\n✅ 全部通過（schema、引用一致性、治理掃描、manifest、provisional gate）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

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
    # ⚠️ 版權紅線（World Atlas V2 / B4）：小說原文只可以留喺 `data/private/`。
    # B4 之前 `zones.geojson` 48/48 個 feature 嘅 `evidence` 都係
    # `"ch73 原文：「…」"` 格式 —— 成段原文入咗公開 bundle（`npm run sync-data`
    # 之後前端任何人下載到）。規則 DS4 明文禁止。
    "novel_quote": re.compile(r"原文\s*[：:「]|ch\s*\d+\s*原文"),
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
    "zones.geojson": "zone.schema.json",
    "zone-dossiers.json": "zone-dossier.schema.json",
    "chronicle.json": "chronicle.schema.json",
    "chapter-summaries.json": "chapter-summaries.schema.json",
}

# ---- B4：zone v2 確定性映射（spec §5.2）------------------------------------
#: `kind` → `zone_type`（規則 Z2：前端只讀 `zone_type`，`kind` 只作向後兼容）
KIND_TO_ZONE_TYPE = {
    "survivor": "survivor_zone",
    "nest": "infected_nest",
    "outpost": "contested",
}
ZONE_TYPE_ENUM = {
    "survivor_zone", "infected_nest", "quarantine", "contested", "transit", "unknown",
}
ZONE_STATUS_ENUM = {"active", "collapsed", "unknown", "historical"}
ZONE_SPATIAL_PRECISION_ENUM = {"verified", "approximate", "fictional", "unknown"}
ZONE_REVIEW_STATUS_ENUM = {"validated", "auto_inferred", "needs_validation"}
ZONE_DANGER_BY_TYPE = {
    "survivor_zone": 1, "contested": 3, "infected_nest": 4,
    "quarantine": 4, "transit": 2, "unknown": None,
}
COORDINATE_SOURCE_ENUM = {
    "explicit_text", "cross_chapter_evidence", "zone_inference",
    "legacy", "manual_geometry",
    # 2026-09-24：由**故事文字點名嘅現實地標**錨定（`anchor_locations_from_text.py`）。
    # 證據強度：地標名出現喺 location 自己嘅名／別名（規則 A）、描述嘅定位片語
    # （規則 B）、或 zone dossier 嘅定位片語（規則 C）。
    "text_landmark",
}
COORDINATE_REVIEW_STATUS_ENUM = {
    "validated", "auto_corrected", "needs_validation", "quarantined",
}


def check_zone_v2(items) -> list[str]:
    """B4：zone v2 欄位存在性 + 確定性映射一致性（規則 Z1／Z2、§5.2）。"""
    errors: list[str] = []
    for item in items:
        p = item.get("properties", {})
        zid = p.get("id", "?")
        if p.get("schema_version") != 2:
            errors.append(f"zones.geojson: {zid} schema_version 唔係 2")
        for key in ("zone_type", "status", "danger_level", "spatial_precision",
                    "display_style", "chapter_refs", "event_ids", "character_ids",
                    "member_location_ids", "dossier_id", "review_status",
                    "confidence", "confidence_inputs",
                    "coordinate_confidence", "coordinate_source",
                    "coordinate_review_status", "spatial_evidence_count"):
            if key not in p:
                errors.append(f"zones.geojson: {zid} 缺 v2 欄位 {key}")
        # ⚠️ 版權紅線：`evidence` 必須完全消失
        if "evidence" in p:
            errors.append(f"zones.geojson: {zid} 仲有 evidence 欄位（版權紅線）")
        if p.get("zone_type") not in ZONE_TYPE_ENUM:
            errors.append(f"zones.geojson: {zid} 非法 zone_type {p.get('zone_type')!r}")
        if p.get("status") not in ZONE_STATUS_ENUM:
            errors.append(f"zones.geojson: {zid} 非法 status {p.get('status')!r}")
        if p.get("spatial_precision") not in ZONE_SPATIAL_PRECISION_ENUM:
            errors.append(f"zones.geojson: {zid} 非法 spatial_precision")
        if p.get("review_status") not in ZONE_REVIEW_STATUS_ENUM:
            errors.append(f"zones.geojson: {zid} 非法 review_status {p.get('review_status')!r}")
        if p.get("zone_review_status") != p.get("review_status"):
            errors.append(f"zones.geojson: {zid} review_status 同 zone_review_status 唔一致")
        # 確定性映射：kind → zone_type
        expect_type = KIND_TO_ZONE_TYPE.get(p.get("kind"))
        if expect_type and p.get("zone_type") != expect_type:
            errors.append(
                f"zones.geojson: {zid} kind={p.get('kind')} 應映射到 {expect_type}，"
                f"實際 {p.get('zone_type')!r}"
            )
        # 確定性映射：zone_type → danger_level
        if p.get("danger_level") != ZONE_DANGER_BY_TYPE.get(p.get("zone_type")):
            errors.append(
                f"zones.geojson: {zid} danger_level 唔符合 {p.get('zone_type')} 查表"
            )
        # display_style.fill 必須係 B1 token 名（唔可以存 raw hex）
        ds = p.get("display_style") or {}
        if not str(ds.get("fill", "")).startswith("--zone-"):
            errors.append(f"zones.geojson: {zid} display_style.fill 唔係 token 名：{ds.get('fill')!r}")
        # chapter_refs 必須等於 chapters
        if p.get("chapter_refs") != p.get("chapters"):
            errors.append(f"zones.geojson: {zid} chapter_refs 同 chapters 唔一致")
        # confidence 公式（§4）
        ci = p.get("confidence_inputs") or {}
        if all(k in ci for k in ("coord_score", "dossier_score", "kind_score")):
            expect = round(
                0.40 * ci["coord_score"] + 0.40 * ci["dossier_score"] + 0.20 * ci["kind_score"], 2
            )
            if abs((p.get("confidence") or 0) - expect) > 1e-9:
                errors.append(f"zones.geojson: {zid} confidence 唔符合公式（應 {expect}）")
        # coordinate_* enum
        if p.get("coordinate_source") not in COORDINATE_SOURCE_ENUM:
            errors.append(f"zones.geojson: {zid} 非法 coordinate_source")
        if p.get("coordinate_review_status") not in COORDINATE_REVIEW_STATUS_ENUM:
            errors.append(f"zones.geojson: {zid} 非法 coordinate_review_status")
        # dossier_id 確定性推導
        if p.get("dossier_id") != "dossier_" + str(zid)[len("zone_"):]:
            errors.append(f"zones.geojson: {zid} dossier_id 唔係確定性推導")
    return errors


def check_zone_bidirectional(public_dir: Path) -> list[str]:
    """B4：zone ↔ event ↔ location ↔ dossier 雙向連結一致性。"""
    errors: list[str] = []
    zpath = public_dir / "zones.geojson"
    if not zpath.exists():
        return errors
    zones = list(iter_features(json.loads(zpath.read_text(encoding="utf-8"))))
    zone_ids = {f["properties"]["id"] for f in zones}

    # zone → event
    zone_events: dict[str, set] = {}
    zone_locations: dict[str, set] = {}
    for f in zones:
        p = f["properties"]
        for eid in p.get("event_ids") or []:
            zone_events.setdefault(eid, set()).add(p["id"])
        for lid in p.get("member_location_ids") or []:
            zone_locations.setdefault(lid, set()).add(p["id"])

    epath = public_dir / "events.geojson"
    if epath.exists():
        for f in iter_features(json.loads(epath.read_text(encoding="utf-8"))):
            p = f["properties"]
            zid = p.get("zone_id")
            if zid is None:
                if p["id"] in zone_events:
                    errors.append(
                        f"events.geojson: {p['id']} 冇 zone_id 但 zone.event_ids 有佢"
                    )
            elif zid not in zone_ids:
                errors.append(f"events.geojson: {p['id']} zone_id '{zid}' 唔存在")
            elif zid not in zone_events.get(p["id"], set()):
                errors.append(
                    f"events.geojson: {p['id']} zone_id={zid} 但該 zone 冇列佢（單邊連結）"
                )

    lpath = public_dir / "locations.geojson"
    if lpath.exists():
        for f in iter_features(json.loads(lpath.read_text(encoding="utf-8"))):
            p = f["properties"]
            zids = set(p.get("zone_ids") or [])
            expect = zone_locations.get(p["id"], set())
            if zids != expect:
                errors.append(
                    f"locations.geojson: {p['id']} zone_ids {sorted(zids)} "
                    f"同 zone.member_location_ids {sorted(expect)} 唔一致"
                )
            if p.get("coordinate_source") not in COORDINATE_SOURCE_ENUM:
                errors.append(f"locations.geojson: {p['id']} 非法 coordinate_source")
            if p.get("coordinate_review_status") not in COORDINATE_REVIEW_STATUS_ENUM:
                errors.append(f"locations.geojson: {p['id']} 非法 coordinate_review_status")

    # dossier 引用
    dpath = public_dir / "zone-dossiers.json"
    if dpath.exists():
        doc = json.loads(dpath.read_text(encoding="utf-8"))
        dossiers = doc.get("dossiers", [])
        dids = {d.get("id") for d in dossiers}
        if len(dids) != len(dossiers):
            errors.append("zone-dossiers.json: dossier id 重複")
        for f in zones:
            did = f["properties"].get("dossier_id")
            if did not in dids:
                errors.append(f"zones.geojson: {f['properties']['id']} dossier_id {did} 唔存在")
        for d in dossiers:
            if d.get("zone_id") not in zone_ids:
                errors.append(f"zone-dossiers.json: {d.get('id')} 指向唔存在 zone {d.get('zone_id')}")
            if d.get("review_status") not in ZONE_REVIEW_STATUS_ENUM:
                errors.append(f"zone-dossiers.json: {d.get('id')} 非法 review_status")
            # 規則 DS2：infected_nest 只可以有 nest_profile
            zt = next(
                (f["properties"]["zone_type"] for f in zones
                 if f["properties"]["id"] == d.get("zone_id")), None
            )
            if zt == "infected_nest" and "nest_profile" not in d:
                errors.append(f"zone-dossiers.json: {d.get('id')} 病窩缺 nest_profile")
            if zt and zt != "infected_nest" and "nest_profile" in d:
                errors.append(f"zone-dossiers.json: {d.get('id')} 非病窩唔應該有 nest_profile")
    return errors


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
                   "timeline.json": "timeline", "characters.json": "character",
                   "chapter-summaries.json": "chapter_summary", "zones.geojson": "zone",
                   "zone-dossiers.json": "zone_dossier",
                   "chronicle.json": "chronicle_entry"}
        if fname in key_map:
            # ⚠️ chronicle.json 係 {version, season, entries}，要數 entries
            # 而唔係 dict 嘅 key 數（後者會得出 4）。
            if fname == "chronicle.json" and isinstance(items, dict):
                stats[key_map[fname]] = len(items.get("entries", []))
            elif fname == "zone-dossiers.json":
                # ⚠️ zone-dossiers.json 係 {schema_version, generated_from, dossiers}，
                # 要數 dossiers 而唔係頂層 key 數（後者會得出 3）。
                stats[key_map[fname]] = len(doc.get("dossiers", []))
            else:
                stats[key_map[fname]] = len(items) if isinstance(items, list) else sum(
                    1 for _ in items
                )
        # chapter-summaries.json 唔需要 per-item review_status check (schema 已驗)
        if fname == "chapter-summaries.json":
            continue
        # chronicle.json 係 {version, season, entries:[...]}，唔係 FeatureCollection。
        # 要抽出 entries 才做 per-item 檢查，否則會 iterate dict 嘅 key（字串）。
        if fname == "chronicle.json":
            items = doc.get("entries", []) if isinstance(doc, dict) else []
        # ⚠️ zone-dossiers.json 係 object（唔係 array）—— 唔抽 dossiers 就會
        # iterate dict 嘅 key（字串），`item.get()` 直接 AttributeError。
        if fname == "zone-dossiers.json":
            items = doc.get("dossiers", []) if isinstance(doc, dict) else []
        # ---- B4：zone v2 欄位 + 確定性映射（規則 Z1／Z2）----
        if fname == "zones.geojson":
            errors.extend(check_zone_v2(list(iter_features(doc))))
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

    # ---- B4：zone ↔ event ↔ location ↔ dossier 雙向一致性 ----
    errors.extend(check_zone_bidirectional(public_dir))

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

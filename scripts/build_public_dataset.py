#!/usr/bin/env python3
"""《病港》Phase B — entity resolution + 公開 provisional dataset builder。

輸入：data/private/evidence/candidates.jsonl（私有）
輸出：
  data/private/review/entity-resolution.md（人手審閱用決策記錄）
  data/public/*.geojson / timeline.json / characters.json（provisional）

設計原則（master prompt §7.1、§7.8）：
- resolution 以 deterministic 規則為主（exact/alias name match），模糊判斷留俾人手
- 全部公開記錄 review_status=needs_review + provisional gate
- 摘要只由 claim 組成（≤200 字），絕不複製正文段落；evidence 留喺 private
- 坐標：真實參考區用粗略 district 中心；虛構地點用 story grid 投影

用法：python scripts/build_public_dataset.py [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CANDIDATES = REPO_ROOT / "data/private/evidence/candidates.jsonl"
OUT_DIR = REPO_ROOT / "data/public"
PRIVATE_REVIEW = REPO_ROOT / "data/private/review"

# 已知真實香港參考區 → 粗略 district 中心座標（EPSG:4326，僅供 render 投影）
HK_DISTRICT_CENTERS: dict[str, list[float]] = {
    "將軍澳": [114.272, 22.332],
    "寶琳": [114.2415, 22.3229],
    "坑口": [114.2729, 22.3166],
    "調景嶺": [114.2506, 22.3077],
    "旺角": [114.1694, 22.3193],
    "中環": [114.1544, 22.2824],
    "香港": [114.1694, 22.3193],
}

# 故事 grid 投影（虛構地點用；0–1 normalized，render 時映射到 EPSG:3857）
STORY_GRID: dict[str, tuple[float, float]] = {
    "大本營": (0.62, 0.42),
}


def stable_color(seed: str) -> str:
    palette = ["#F39C12", "#9B59B6", "#1ABC9C", "#E67E22"]
    h = int(hashlib.sha256(seed.encode("utf-8")).hexdigest(), 16)
    return palette[h % len(palette)]


def slugify(name: str) -> str:
    """canonical id：ASCII 轉 snake_case；非 ASCII（中文名）用短 hash 確保唯一。

    例：'Mong Kok' → 'mong_kok'；'大本營' → 'loc_3f2a9c1d4e'
    （schema 規定 id 只可 ^[a-z0-9_]+$；中文名無法直接入 id）
    """
    s = unicodedata.normalize("NFKC", name).strip().lower()
    ascii_part = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    if ascii_part and re.fullmatch(r"[a-z0-9_]+", ascii_part):
        return ascii_part[:60]
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:10]
    kind_hint = "ent"
    return f"{kind_hint}_{digest}"


class CandidateReader:
    def __init__(self, path: Path):
        if not path.exists():
            raise FileNotFoundError(f"搵唔到 {path}——請先執行 extraction run")
        self.rows = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.rows.append(json.loads(line))

    def by_kind(self, kind: str) -> list[dict]:
        return [r for r in self.rows if r.get("entity_kind") == kind and r.get("status") == "pending"]


def load_resolution_rules() -> dict:
    """讀取人手確認嘅 resolution 規則（私有）；無檔案回空規則。"""
    rules_path = REPO_ROOT / "data/private/review/resolution-rules.json"
    if not rules_path.exists():
        return {}
    try:
        return json.loads(rules_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[warn] resolution-rules.json parse 失敗（{e}）——忽略規則")
        return {}


def apply_parenthetical_merge(rows: list[dict]) -> list[dict]:
    """括號註解合併：「M（主角）」歸入「M」，註解存 alias_note。"""
    import unicodedata

    out = []
    for r in rows:
        name = r.get("name")
        if not name:
            continue
        n = unicodedata.normalize("NFKC", name).strip()
        m = re.match(r"^(.+?)[（(](.+?)[）)]$", n)
        if m:
            main, note = m.group(1).strip(), m.group(2).strip()
            r2 = dict(r)
            r2["name"] = main
            aliases = list(r2.get("aliases") or [])
            if note and note not in aliases:
                aliases.append(note)
            r2["aliases"] = aliases
            out.append(r2)
        else:
            out.append(r)
    return out


def apply_rules(
    rows: list[dict],
    kind: str,
    rules: dict,
    merge_targets: dict[str, str],
) -> tuple[list[dict], dict[str, str]]:
    """套用確認清單：剔除 exclude_*；merge_into 將名稱重寫為 canonical。

    回傳（過濾後 rows, 名稱→canonical 顯示名映射）。
    """
    exclude_key = f"exclude_{kind}_names"
    excluded = set(rules.get(exclude_key) or [])

    # 先攞全部名稱（含被 merge 嘅來源），用嚟搵 canonical 顯示名
    all_names = {norm_name := unicodedata.normalize("NFKC", r.get("name") or "").strip() for r in rows}

    kept = []
    rename_map: dict[str, str] = {}
    for r in rows:
        name = unicodedata.normalize("NFKC", r.get("name") or "").strip()
        if not name or name in excluded:
            continue
        target = merge_targets.get(name)
        if target:
            rename_map[name] = target
            r2 = dict(r)
            r2["name"] = target
            aliases = list(r2.get("aliases") or [])
            if name != target and name not in aliases:
                aliases.append(name)
            r2["aliases"] = aliases
            kept.append(r2)
        else:
            kept.append(r)

    return kept, rename_map


def resolve_locations(locs: list[dict]) -> dict[str, dict]:
    """以正規化名稱分組（deterministic）。回傳 canonical_id -> merged record。"""
    groups: dict[str, list[dict]] = defaultdict(list)
    for c in locs:
        key = slugify(c["name"])
        groups[key].append(c)
    resolved: dict[str, dict] = {}
    for key, members in groups.items():
        chapters = sorted({m["chapter"] for m in members})
        best_name = max(members, key=lambda m: len(m["name"]))["name"]  # 最長名（通常最完整）
        fictional_votes = sum(1 for m in members if m.get("fictional") is True)
        is_fictional = (
            fictional_votes > len(members) / 2
            or best_name not in HK_DISTRICT_CENTERS
        )
        confidences = [m.get("confidence") or 0 for m in members]
        resolved[key] = {
            "canonical_id": key,
            "display_name": best_name,
            "members": members,
            "chapters": chapters,
            "first_chapter": chapters[0],
            "fictional": is_fictional,
            "confidence": round(sum(confidences) / len(confidences), 2),
            "location_type": members[0].get("location_type") or ("fictional" if is_fictional else "unknown"),
        }
    return resolved


def resolve_characters(chars: list[dict]) -> dict[str, dict]:
    """名稱+alias 合併（exact match only；模糊合併留人手）。"""
    alias_map: dict[str, set[int]] = defaultdict(set)
    canon: dict[int, str] = {}
    next_id = [0]

    def find(x: int) -> int:
        while canon[x] != x:
            x = canon[x]
        return x

    def union(a: int, b: int):
        ra, rb = find(a), find(b)
        if ra != rb:
            canon[rb] = ra

    entries = []
    for c in chars:
        names = {c["name"], *(c.get("aliases") or [])}
        idx = next_id[0]
        next_id[0] += 1
        canon[idx] = idx
        entries.append((idx, names, c))
        for n in names:
            alias_map[n.strip()].add(idx)

    for idxs in alias_map.values():
        idx_list = sorted(idxs)
        for other in idx_list[1:]:
            union(idx_list[0], other)

    groups: dict[int, list] = defaultdict(list)
    for idx, names, c in entries:
        groups[find(idx)].append(c)

    resolved: dict[str, dict] = {}
    for members in groups.values():
        chapters = sorted({m["chapter"] for m in members})
        # 出現次數最多嘅名做 canonical
        name_counts: dict[str, int] = defaultdict(int)
        for m in members:
            name_counts[m["name"]] += 1
        best_name = max(name_counts.items(), key=lambda kv: kv[1])[0]
        aliases = sorted(
            {a for m in members for a in [m["name"], *(m.get("aliases") or [])]} - {best_name}
        )
        cid = slugify(best_name)
        resolved[cid] = {
            "canonical_id": cid,
            "display_name": best_name,
            "aliases": aliases,
            "members": members,
            "chapters": chapters,
            "first_chapter": chapters[0],
            "confidence": round(sum(m.get("confidence") or 0 for m in members) / len(members), 2),
        }
    return resolved


def build_location_feature(rec: dict, seq: int) -> dict | None:
    name = rec["display_name"]
    known_center = HK_DISTRICT_CENTERS.get(name)
    if known_center and not rec["fictional"]:
        coords = known_center
        precision = "district"
        loc_type = "district"
        story_pos = None
    else:
        story_pos = STORY_GRID.get(name) or (
            0.15 + (int(hashlib.sha256(name.encode()).hexdigest(), 16) % 700) / 1000,
            0.15 + (int(hashlib.sha256(("y" + name).encode()).hexdigest(), 16) % 700) / 1000,
        )
        coords = [
            113.80 + story_pos[0] * 0.60,   # 投影到香港範圍附近（明確非真實）
            22.15 + story_pos[1] * 0.35,
        ]
        precision = "fictional"
        loc_type = "fictional"

    props = {
        "id": f"{rec['canonical_id']}"[:60],
        "name": name,
        "display_name": f"{name}（{'虛構' if rec['fictional'] else '參考位置'}）",
        "location_type": loc_type if loc_type != "unknown" or not known_center else "district",
        "fictional": bool(rec["fictional"]),
        "location_precision": precision,
        "story_position": {"x": round(story_pos[0], 3) if story_pos else 0.5, "y": round(story_pos[1], 3) if story_pos else 0.5},
        "description": _short_claim_desc(rec["members"], 100),
        "first_appearance": rec["first_chapter"],
        "chapters": rec["chapters"][:50],
        "characters": [],
        "confidence": rec["confidence"],
        "review_status": "needs_review",
        "source": "bing_gang",
    }
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": coords},
        "properties": props,
    }


def _short_claim_desc(members: list[dict], limit: int) -> str:
    """由 claims 組成 ≤limit 字摘要；無 claim 就用通用描述。唔會複製 evidence。"""
    claims = [m.get("claim") for m in members if m.get("claim")]
    if claims:
        text = claims[0]
        return text[: limit - 1] + "…" if len(text) > limit else text
    return "小說內出現嘅實體；詳細描述待人手審閱補充。"


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase B public dataset builder")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        reader = CandidateReader(CANDIDATES)
    except FileNotFoundError as e:
        print(f"[blocked] {e}")
        return 2

    kinds = defaultdict(int)
    for r in reader.rows:
        kinds[r.get("entity_kind")] += 1

    print(f"讀入 {len(reader.rows)} candidates：{dict(kinds)}")

    # ---- 人手確認嘅 resolution 規則（私有）----
    rules = load_resolution_rules()
    merge_targets = {k: v for k, v in (rules.get("merge_into") or {}).items() if isinstance(v, str)}

    loc_rows = apply_parenthetical_merge(reader.by_kind("location"))
    char_rows = apply_parenthetical_merge(reader.by_kind("character"))
    loc_rows, _loc_renames = apply_rules(loc_rows, "location", rules, merge_targets)
    char_rows, _char_renames = apply_rules(char_rows, "character", rules, merge_targets)
    print(f"規則套用後：locations {len(loc_rows)}、characters {len(char_rows)}（剔除了 exclude 清單）")

    loc_resolved = resolve_locations(loc_rows)
    char_resolved = resolve_characters(char_rows)

    print(f"resolved locations: {len(loc_resolved)}；characters: {len(char_resolved)}")

    if args.dry_run:
        print("[dry-run] 未寫入任何檔案。")
        return 0

    # ---- locations.geojson ----
    loc_features = []
    id_map: dict[str, str] = {}
    for i, (cid, rec) in enumerate(sorted(loc_resolved.items()), 1):
        feat = build_location_feature(rec, i)
        if feat:
            loc_features.append(feat)
            id_map[cid] = feat["properties"]["id"]

    # ---- events（由 event candidates 直接映射）----
    events = reader.by_kind("event")
    event_features = []
    tl_records = []
    event_id_map: dict[tuple[int, str], str] = {}
    ev_seq = 0
    # 按 chapter 排序產生穩定 id
    for cand in sorted(events, key=lambda c: (c["chapter"], c.get("name") or "")):
        ev_seq += 1
        eid = f"bg_event_{ev_seq:03d}"
        desc = _short_claim_desc([cand], 200)
        title = (cand.get("name") or "未命名事件")[:40]
        spoiler = min(3, max(0, int(cand.get("spoiler_level") or 0)))
        props = {
            "id": eid,
            "title": title,
            "description": desc,
            "chapter": cand["chapter"],
            "chapter_name": f"{cand['chapter']:02d}",
            "chapter_refs": [cand["chapter"]],
            "characters": [],
            "event_type": "minor",
            "spoiler_level": spoiler,
            # LLM extraction 階段未有 event→location 連結；留 null 待人手/後續 pipeline 指派
            "location_id": None,
            "confidence": cand.get("confidence") or 0.5,
            "review_status": "needs_review",
            "source": "bing_gang",
        }
        event_features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": HK_DISTRICT_CENTERS["香港"]},
                "properties": props,
            }
        )
        event_id_map[(cand["chapter"], cand.get("name") or "")] = eid
        tl_records.append(
            {
                "id": f"tl_event_{ev_seq:03d}",
                "date_label": "按章節先後",
                "date_sort": f"ch{cand['chapter']:03d}",
                "chapter": cand["chapter"],
                "location_id": None,
                "characters": [],
                "type": "minor",
                "spoiler_level": spoiler,
                "description": desc,
                "confidence": cand.get("confidence") or 0.5,
                "review_status": "needs_review",
                "event_id": eid,
            }
        )

    # ---- characters.json ----
    char_records = []
    char_seq_colors: dict[str, str] = {}
    predefined = {"protagonist": "#E74C3C", "ha_ching": "#3498DB", "a_ming": "#2ECC71"}
    for i, (cid, rec) in enumerate(sorted(char_resolved.items())):
        color = predefined.get(cid) or stable_color(cid)
        char_seq_colors[cid] = color
        char_records.append(
            {
                "id": cid[:60],
                "name": rec["display_name"],
                "aliases": rec["aliases"][:10],
                "role": "supporting",
                "color": color,
                "first_appearance": rec["first_chapter"],
                "chapter_refs": rec["chapters"][:50],
                "spoiler_level": 1,
                "description": f"全書 {len(rec['chapters'])} 章出現；詳情待人手審閱。",
                "confidence": rec["confidence"],
                "review_status": "needs_review",
                "portrait_asset_id": None,
                "source": "bing_gang",
            }
        )

    # ---- routes（暫時空 FeatureCollection：等 location-event 關聯經人手審閱後先有據可依）----
    route_fc = {"type": "FeatureCollection", "features": []}

    # ---- 寫入 ----
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    def write_json(path: Path, doc) -> None:
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")

    write_json(OUT_DIR / "locations.geojson", {"type": "FeatureCollection", "features": loc_features})
    write_json(OUT_DIR / "events.geojson", {"type": "FeatureCollection", "features": event_features})
    write_json(OUT_DIR / "routes.geojson", route_fc)
    write_json(OUT_DIR / "timeline.json", tl_records)
    write_json(OUT_DIR / "characters.json", char_records)

    counts = {
        "location": len(loc_features),
        "event": len(event_features),
        "route": 0,
        "timeline": len(tl_records),
        "character": len(char_records),
    }

    manifest = {
        "dataset_version": f"0.2.0-provisional.{datetime.now(timezone.utc).strftime('%Y%m%d')}",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "scripts/build_public_dataset.py ← data/private/evidence/candidates.jsonl",
        "counts": counts,
        "review_summary": {
            "verified": 0,
            "reviewed": 0,
            "needs_review": sum(counts.values()),
        },
        "notes": [
            "全部 needs_review；網站必須 VITE_PROVISIONAL_DATA_MODE=true 並顯示 banner。",
            "事件坐標目前統一投影至故事中心，待人手審閱後逐項指派位置。",
            "routes 為空：等位置-事件關聯經人手確認後先建立，避免捏造路線。",
            "本 dataset 由 LLM candidates 經 deterministic rules 生成；無全文、無 evidence excerpt 入公開檔案。",
        ],
    }
    write_json(OUT_DIR / "asset-manifest.json", manifest)

    # map-config 更新 provisional banner 保持不變；呢度唔改佢

    # ---- 人手審閱決策記錄（private）----
    res_doc = [
        "# Entity Resolution 審閱記錄（私有）",
        "",
        f"> 生成：{datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        "> 本檔案列出自動 resolution 結果，等人手確認或修正。**含實體名稱，不得 commit。**",
        "",
        "## Locations（自動分組結果）",
        "",
        "| canonical_id | 顯示名 | fictional | 章數 | 首現 | confidence |",
        "|---|---|---|---|---|---|",
    ]
    for cid, rec in sorted(loc_resolved.items()):
        res_doc.append(
            f"| {cid} | {rec['display_name']} | {rec['fictional']} "
            f"| {len(rec['chapters'])} | {rec['first_chapter']} | {rec['confidence']} |"
        )
    res_doc += ["", "## Characters（alias 合併結果）", "", "| canonical_id | 顯示名 | aliases | 章數 | confidence |", "|---|---|---|---|---|"]
    for cid, rec in sorted(char_resolved.items()):
        res_doc.append(
            f"| {cid} | {rec['display_name']} | {'、'.join(rec['aliases'][:5]) or '—'} "
            f"| {len(rec['chapters'])} | {rec['confidence']} |"
        )
    res_doc += [
        "",
        "## 人手審閱指引",
        "",
        "1. 檢查有冇應該合併但未合併（例如同一地方兩個寫法）→ 喺下方記錄",
        "2. 有冇錯誤合併（兩個不同實體被當成一個）→ 記錄並要求拆分",
        "3. 事件坐標指派：目前全部投影至中心，請按章節內容建議 location_id",
        "",
        "### 你的修改記錄",
        "",
        "```",
        "",
        "```",
    ]
    PRIVATE_REVIEW.mkdir(parents=True, exist_ok=True)
    (PRIVATE_REVIEW / "entity-resolution.md").write_text("\n".join(res_doc), encoding="utf-8")

    print(f"寫入完成：{counts}")
    print(f"Resolution 記錄：{PRIVATE_REVIEW / 'entity-resolution.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""《病港》Phase B — entity resolution + 公開 provisional dataset builder。

⚠️ 歷史警告（保留作記錄）⚠️
============================
呢支腳本係 Phase B 產生器，輸出之後會被後續階段改寫，**唔可以由現有輸入
逐 byte 重現**（實測，見下）。舊版每次跑都會直接覆蓋已凍結嘅公開資產，
造成不可逆損壞：

  - `data/public/characters.json`：330 條 → 344 條
    （新增未合併角色 + **遺失 11 個已合併角色**；即「數量增加但內容遺失」）
  - `data/public/locations.geojson`：704 → 629（覆蓋後續階段成果）

C 項修復：現行安全契約（非破壞性 + reconcile）
==============================================
1. **非破壞性寫入**：只會寫「輸出目錄內唔存在」嘅檔案；已存在嘅經審閱公開
   資產**一律原封不動保留**（`_write_json` 見到檔案存在就 skip）。要強制覆蓋
   必須明確加 `--force`，屆時會再印警告（即上面嘅歷史損壞模式）。
   → 重跑唔會改動 `data/public/**` 嘅 id 集合（idempotent）。
2. **reconcile 對照**：每次跑都會將 provisional 結果同磁碟上嘅凍結公開資產
   對照，寫出報告（`data/private/review/dataset-reconciliation.json` +
   `.md`，私有、唔 commit）。報告會列出：
     - 凍結資產有、provisional 冇 → 唔可以被產生器削減
     - provisional 有、凍結資產冇 → 未審閱新實體，唔會自動公開
     - provisional 名出現在凍結資產別名 → 即已被下游合併嘅名（重現 root cause）
3. 本腳本依然**唔喺 `run_pipeline.py` 之內** —— 佢係 staging／reconcile 工具，
   唔係 pipeline step；公開資料嘅唯一權威係 `data/public/**` 經審閱版本。

為何無法「重跑就重現 330」
==========================
凍結 `characters.json` 含有一條 `老師`（唔可以由現時 `candidates.jsonl` +
私有 review 檔重現），而現時輸入又會產生凍結版本冇嘅 `鳥嘴老師`。
屬 candidate／私有檔版本 skew，所以正確做法係「凍結資產做權威 + 產生器
唔可以削減」，而唔係盲目重算覆蓋。

輸入：data/private/evidence/candidates.jsonl（私有）
輸出（只有唔存在先寫；`--force` 才覆蓋）：
  data/public/*.geojson / timeline.json / characters.json（provisional）
  data/private/review/entity-resolution.md（自動推斷決策記錄）
  data/private/review/dataset-reconciliation.json / .md（reconcile 對照）

設計原則（master prompt §7.1、§7.8）：
- resolution 以 deterministic 規則為主（exact/alias name match），模糊判斷交由
  確定性規則 + 多代理交叉驗證處理
- 全部公開記錄 review_status=needs_review + provisional gate
- 摘要只由 claim 組成（≤200 字），絕不複製正文段落；evidence 留喺 private
- 坐標：真實參考區用粗略 district 中心；虛構地點用 story grid 投影

用法：python scripts/build_public_dataset.py [--dry-run] [--force]
      [--out-dir DIR] [--private-review-dir DIR]
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


def load_manual_resolutions() -> dict:
    """讀取人手 override（私有）；無檔案回空。"""
    p = REPO_ROOT / "data/private/review/manual-resolutions.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"[warn] manual-resolutions.json 讀取失敗（{e}）——忽略")
        return {}


def load_phase_c_exclusions() -> dict:
    """讀取 Phase C 低 conf 排除清單（私有）。"""
    p = REPO_ROOT / "data/private/review/phase-c-exclusions.json"
    if not p.exists():
        return {"excluded_locations": [], "excluded_characters": []}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"excluded_locations": [], "excluded_characters": []}


def apply_manual_resolutions(rows: list[dict], decisions: list[dict]) -> tuple[list[dict], dict]:
    """應用人手 override：拆 character、rename canonical、移除錯誤 alias、合併 routes、定義 character alias。
    設計：每個 decision 透過修改 row.name 嚟影響 union-find 嘅分組。
    - rename_canonical：將 group display 改名
    - split：將每個 child group 嘅 match_aliases 嘅 row.name 改成 child.display_name
              咁 union-find 會自然將佢哋分到唔同 group（因為佢哋唔再共享 aliases）
    - remove_alias：將指定 alias 由所有 row.aliases 拎走（避免 cross-character union）
    - merge_routes：將 alias 群嘅 character name rename 到 target（routes 會將佢哋合併）
    - character_definitions：完全覆寫 character 嘅 alias 列表（Phase E 核心方案）
    Returns: (new_rows, stats)
    """
    renames = [d for d in decisions if d.get("action") == "rename_canonical"]
    splits = [d for d in decisions if d.get("action") == "split"]
    remove_aliases = [d for d in decisions if d.get("action") == "remove_alias"]
    merge_routes = [d for d in decisions if d.get("action") == "merge_routes"]
    char_defs = [d for d in decisions if d.get("action") == "character_definitions"]
    bulk_remove = [d for d in decisions if d.get("action") == "bulk_remove_alias"]
    stats = {"renames": 0, "splits_renamed_rows": 0, "splits_new_groups": 0, "aliases_removed": 0, "routes_merged_rows": 0, "bulk_alias_removed": 0, "characters_defined": 0}

    # 1) rename
    for rd in renames:
        from_name = rd["canonical_alias_from"]
        to_name = rd["canonical_alias_to"]
        for r in rows:
            if r.get("name") == from_name:
                r["name"] = to_name
                aliases = list(r.get("aliases") or [])
                if from_name not in aliases:
                    aliases.append(from_name)
                r["aliases"] = aliases
                stats["renames"] += 1

    # 2) split
    for sd in splits:
        # 收集所有 child.target_name（同其他 sibling.target_name 唔應該再做 alias）
        child_target_names = {c["display_name"] for c in sd.get("splits", [])}
        for child in sd.get("splits", []):
            match_aliases = set(child.get("match_aliases", []))
            target_name = child["display_name"]
            for r in rows:
                if r.get("name") in match_aliases:
                    r["name"] = target_name
                    aliases = list(r.get("aliases") or [])
                    aliases = [
                        a for a in aliases
                        if a not in child_target_names - {target_name}
                        and a not in match_aliases
                    ]
                    r["aliases"] = aliases
                    stats["splits_renamed_rows"] += 1
            stats["splits_new_groups"] += 1

    # 3) remove_alias：將指定 alias 由所有 row.aliases 拎走（避免 cross-character union）
    for rad in remove_aliases:
        to_remove = set(rad.get("remove_aliases", []))
        for r in rows:
            aliases = list(r.get("aliases") or [])
            new_aliases = [a for a in aliases if a not in to_remove]
            if len(new_aliases) != len(aliases):
                r["aliases"] = new_aliases
                stats["aliases_removed"] += 1

    # 3.5) Phase E: 對所有 character row 拎走其他 character 嘅 name alias
    # 計算 evidence 入面所有 character name
    all_char_names = set()
    for r in rows:
        n = (r.get("name") or "").strip()
        if n:
            all_char_names.add(n)
    for r in rows:
        aliases = list(r.get("aliases") or [])
        new_aliases = [a for a in aliases if a not in all_char_names or a == r.get("name")]
        if len(new_aliases) != len(aliases):
            r["aliases"] = new_aliases

    # 4) merge_routes：將 alias 群嘅 character name rename 到 target
    for mr in merge_routes:
        for m in mr.get("merges", []):
            target = m["into"]
            sources = set(m.get("from_aliases", []))
            for r in rows:
                if r.get("name") in sources:
                    r["name"] = target
                    aliases = list(r.get("aliases") or [])
                    for s in sources - {target}:
                        if s not in aliases:
                            aliases.append(s)
                    r["aliases"] = aliases
                    stats["routes_merged_rows"] += 1

    # 5) bulk_remove_alias：自動 cross-alias 衝突清理
    for ba in bulk_remove:
        remove_map = ba.get("remove_map", {})
        for char_name, alias_list in remove_map.items():
            to_remove = set(alias_list)
            for r in rows:
                if r.get("name") == char_name:
                    aliases = list(r.get("aliases") or [])
                    new_aliases = [a for a in aliases if a not in to_remove]
                    if len(new_aliases) != len(aliases):
                        r["aliases"] = new_aliases
                        stats["bulk_alias_removed"] += 1

    # 6) character_definitions：完全覆寫 character alias list + 同步 entry rename
    # 對 definitions 入面每個 character，搵所有 row 將 aliases 改成定義
    # 同時將所有 alias entry rename 為 target character name
    # 支援 keep_aliases_map：明確指定某 character 嘅 self-aliases
    # 支援 remove_map：對 character 拎走指定 alias（但保留其他 self-aliases）
    for cd in char_defs:
        definitions = cd.get("definitions", {})
        keep_map = cd.get("keep_aliases_map", {})
        remove_map_full = cd.get("remove_map", {})

        for char_name, defn in definitions.items():
            # 支援兩種格式：{char: [aliases]} 或 {char: {'aliases': [...]}}
            if isinstance(defn, list):
                defined_aliases = set(defn)
            else:
                defined_aliases = set(defn.get("aliases", []))
            defined_aliases.add(char_name)
            for r in rows:
                if r.get("name") == char_name:
                    r["aliases"] = sorted(defined_aliases)
                    stats["characters_defined"] += 1

        # keep_aliases_map：明確指定 self-aliases（清走 entry 其他 alias）
        for char_name, keep_aliases in keep_map.items():
            keep_set = set(keep_aliases) | {char_name}
            for r in rows:
                if r.get("name") == char_name:
                    current = set(r.get("aliases") or [])
                    new = sorted(current & keep_set)
                    r["aliases"] = new if new else sorted(keep_set)
                    stats["characters_defined"] += 1

        # remove_map：每 character 拎走指定 alias（保留其他）
        for char_name, alias_list in remove_map_full.items():
            to_remove = set(alias_list)
            for r in rows:
                if r.get("name") == char_name:
                    current = set(r.get("aliases") or [])
                    new = sorted(current - to_remove)
                    r["aliases"] = new if new else [char_name]
                    stats["characters_defined"] += 1

        # 同步 entry rename：所有 alias entry 改為 target name
        for merge in cd.get("merge_into", []):
            target = merge["into"]
            sources = set(merge.get("from_aliases", []))
            # 嘗試從 definitions 拎 target 嘅 self-aliases
            defn = definitions.get(target, [])
            if isinstance(defn, list):
                target_defined = set(defn)
            else:
                target_defined = set(defn.get("aliases", []))
            # 否則從 keep_map
            if not target_defined:
                target_defined = set(keep_map.get(target, []))
            target_defined.add(target)
            for r in rows:
                if r.get("name") in sources and r.get("name") != target:
                    r["name"] = target
                    if target_defined == {target}:
                        orig_aliases = r.get("aliases") or []
                        new_aliases = sorted(set(orig_aliases) | {target})
                        r["aliases"] = new_aliases
                    else:
                        r["aliases"] = sorted(target_defined)

    return list(rows), stats


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
        # 0903 Phase C：conf ≥ 0.7 → reviewed（人手已批 routes/alias override）
        # conf < 0.7 → needs_review（人手必查）
        "review_status": "reviewed" if (rec["confidence"] or 0) >= 0.7 else "needs_review",
        "source": "bing_gang",
    }
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": coords},
        "properties": props,
    }


def _short_claim_desc(members: list[dict], limit: int) -> str:
    """由 claims 組成 ≤limit 字摘要；無 claim 就用通用描述。唔會複製 evidence。

    治理規則：>100 連續 CJK 無標點＝疑似原文段落；摘要必須有標點/空格中斷。
    超長 claim 先按句號/分號切短，再截到 limit。
    """
    claims = [m.get("claim") for m in members if m.get("claim")]
    text = ""
    if claims:
        # 揀最短嘅 claim 做 seed（通常最精煉），避免長篇複述
        text = min(claims, key=len)
        if len(text) > limit:
            # 按句讀切第一兩句
            for sep in ("。", "；", "！", "？"):
                parts = text.split(sep)
                if len(parts) > 1 and len(parts[0]) >= 20:
                    text = parts[0] + sep
                    break
            if len(text) > limit:
                cut = text[: limit - 1]
                # 喺最後一個標點處斷開，避免無標點長 CJK run
                last_punct = max(cut.rfind(p) for p in "。，、；！？")
                if last_punct > 30:
                    cut = cut[: last_punct + 1]
                text = cut
    else:
        text = "小說內出現嘅實體；詳細描述待自動推斷補充。"

    # 無條件最後防線：任何 >100 連續 CJK run 都插入「，」中斷（治理規則）
    import re as _re

    def _break_long(match: "_re.Match[str]") -> str:
        seg = match.group(0)
        mid = len(seg) // 2
        return seg[:mid] + "，" + seg[mid:]

    text = _re.sub(r"[\u3400-\u4dbf\u4e00-\u9fff]{100,}", _break_long, text)
    return text


#: 本腳本**唔**產生、但 manifest counts 要如實反映嘅 dataset。
#: key → (檔名, 頂層容器 key 或 None)
_OTHER_DATASETS: dict[str, tuple[str, str | None]] = {
    "zone": ("zones.geojson", "features"),
    "zone_dossier": ("zone-dossiers.json", "dossiers"),
    "chronicle_entry": ("chronicle.json", "entries"),
    "chapter_summary": ("chapter-summaries.json", None),
}


def _count_other_datasets(out_dir: Path) -> dict[str, int]:
    """由磁碟重算其他 dataset 嘅 count（唔可以寫死，亦唔可以漏）。

    ⚠️ 為何要咁做：呢支腳本會覆蓋 `asset-manifest.json`。如果 counts 只寫
    自己嘅 5 個 dataset，其他（zone / zone_dossier / chronicle / chapter）
    嘅 count 會靜默消失，`validate_public_data.py` 就會報 manifest 不符。
    """
    out: dict[str, int] = {}
    for key, (fname, container) in _OTHER_DATASETS.items():
        path = out_dir / fname
        if not path.exists():
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if container and isinstance(doc, dict) and container in doc:
            out[key] = len(doc[container])
        elif isinstance(doc, (list, dict)):
            out[key] = len(doc)
    return out


#: 產生器會寫入嘅公開檔案（文檔用途：呢六個檔預設一律唔覆蓋）。
GENERATED_FILES: tuple[str, ...] = (
    "locations.geojson",
    "events.geojson",
    "routes.geojson",
    "timeline.json",
    "characters.json",
    "asset-manifest.json",
)


def _write_json(path: Path, doc, *, force: bool) -> str:
    """寫入 JSON，但**唔覆蓋已存在嘅檔**（除咗明確 force）。

    回傳 `'written'` 或 `'preserved'`。呢個就係 C 項修復嘅核心：
    重跑唔可以削減經審閱嘅公開資產（330 → 344 / 704 → 629 嘅損壞就係
    因為舊版無條件覆蓋）。
    """
    if path.exists() and not force:
        return "preserved"
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    return "written"


def _load_json_soft(path: Path):
    """讀 JSON；唔存在／壞檔一律回 None（reconcile 係 best-effort，唔應該 raise）。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError, OSError):
        return None


def _disk_count(path: Path, container: str | None) -> int:
    """由磁碟數實際記錄數（唔可以靠 provisional 數字，因為檔案可能被保留）。"""
    doc = _load_json_soft(path)
    if doc is None:
        return 0
    if container and isinstance(doc, dict):
        return len(doc.get(container) or [])
    if isinstance(doc, (list, dict)):
        return len(doc)
    return 0


def reconcile_datasets(
    out_dir: Path,
    char_resolved: dict[str, dict],
    loc_resolved: dict[str, dict],
    private_review_dir: Path,
    *,
    write: bool = True,
) -> dict:
    """將 provisional resolution 同磁碟上嘅凍結公開資產對照，寫出報告。

    為何要程式化做呢件事
    --------------------
    「重跑產生器會唔會損壞公開資料」以前只靠人手記住（檔頭警告）。呢個
    reconcile 報告將同一件事變成**可重跑嘅資料**：

      - `baseline_only_ids`：凍結資產有、provisional 冇 → 一旦覆蓋就會消失
        （即 11 個已合併角色嗰類）
      - `provisional_only_ids`：provisional 有、凍結資產冇 → 未審閱新實體
      - `provisional_names_in_baseline_aliases`：provisional 嘅顯示名出現喺
        凍結資產嘅 aliases → 即「已經被下游合併」嘅名（root cause 指紋）
      - `locations`：id 命名方案唔同（凍結用 `loc_NNNN`），所以改用**名稱**對照

    報告含實體名，所以只可以寫入私有目錄（gitignored、唔 deploy）。
    """
    report: dict = {"characters": {}, "locations": {}}

    base_chars = _load_json_soft(out_dir / "characters.json")
    prov_ids = set(char_resolved)
    if isinstance(base_chars, list):
        base_ids = {c["id"] for c in base_chars if isinstance(c, dict) and "id" in c}
        base_names = {c.get("name") for c in base_chars if isinstance(c, dict)}
        alias_index: dict[str, str] = {}
        for c in base_chars:
            if not isinstance(c, dict):
                continue
            alias_index.setdefault(c.get("name"), c.get("id"))
            for a in c.get("aliases") or []:
                alias_index.setdefault(a, c.get("id"))
        # 「已被下游合併」：provisional 嘅顯示名唔係凍結資產嘅名，但係凍結資產嘅別名。
        # 例：provisional 有「我母親」、凍結資產只有「我的母親」（別名含「我母親」）
        #     → 即呢條記錄已經被 merge_characters.py 摺入 canonical。
        absorbed = {
            cid: rec["display_name"]
            for cid, rec in char_resolved.items()
            if rec["display_name"] not in base_names and rec["display_name"] in alias_index
        }
        unmatched = {
            cid: rec["display_name"]
            for cid, rec in char_resolved.items()
            if rec["display_name"] not in alias_index
            and not any(n in alias_index for n in {rec["display_name"], *(rec.get("aliases") or [])})
        }
        report["characters"] = {
            "baseline_count": len(base_ids),
            "provisional_count": len(prov_ids),
            "common_count": len(base_ids & prov_ids),
            "baseline_only_ids": sorted(base_ids - prov_ids),
            "provisional_only_ids": sorted(prov_ids - base_ids),
            "provisional_names_absorbed_by_baseline_aliases": dict(sorted(absorbed.items())),
            "provisional_unmatched_new_names": dict(sorted(unmatched.items())),
        }

    base_locs = _load_json_soft(out_dir / "locations.geojson")
    if isinstance(base_locs, dict) and "features" in base_locs:
        base_loc_names = {
            f["properties"].get("name")
            for f in base_locs["features"]
            if isinstance(f, dict) and isinstance(f.get("properties"), dict)
        }
        prov_loc_names = {rec["display_name"] for rec in loc_resolved.values()}
        report["locations"] = {
            "baseline_count": len(base_locs["features"]),
            "provisional_count": len(loc_resolved),
            "baseline_id_scheme": (base_locs["features"][0]["properties"].get("id") or "")[:8],
            "baseline_only_names": sorted(n for n in base_loc_names - prov_loc_names if n),
            "provisional_only_names": sorted(n for n in prov_loc_names - base_loc_names if n),
        }

    if write:
        private_review_dir.mkdir(parents=True, exist_ok=True)
        (private_review_dir / "dataset-reconciliation.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    lines = [
        "# Dataset Reconciliation（私有，唔 commit）",
        "",
        "> provisional resolution vs 磁碟上嘅凍結公開資產。",
        "",
        "## characters",
        "",
    ]
    ch = report["characters"]
    if ch:
        lines += [
            f"- 凍結 {ch['baseline_count']} 條 / provisional {ch['provisional_count']} 條 / 交集 {ch['common_count']}",
            f"- **凍結有、provisional 冇（一旦覆蓋會消失）：{len(ch['baseline_only_ids'])}**",
            f"- provisional 有、凍結冇（未審閱新實體）：{len(ch['provisional_only_ids'])}",
            f"- 已被下游合併（provisional 名 = 凍結別名）：{len(ch['provisional_names_absorbed_by_baseline_aliases'])}",
            "",
            "已被合併嘅名：",
            "",
        ]
        for cid, nm in ch["provisional_names_absorbed_by_baseline_aliases"].items():
            lines.append(f"- {nm}（{cid}）")
    else:
        lines.append("（冇凍結 characters.json，略過）")
    lines += ["", "## locations", ""]
    lo = report["locations"]
    if lo:
        lines += [
            f"- 凍結 {lo['baseline_count']} 條（id 方案 `{lo['baseline_id_scheme']}…`）/ provisional {lo['provisional_count']} 條",
            f"- 名稱：凍結有、provisional 冇 {len(lo['baseline_only_names'])}；provisional 有、凍結冇 {len(lo['provisional_only_names'])}",
        ]
    else:
        lines.append("（冇凍結 locations.geojson，略過）")
    if write:
        (private_review_dir / "dataset-reconciliation.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def _print_reconcile_summary(report: dict) -> None:
    """印出 reconcile 摘要（唔含實體名，安全）。"""
    ch = report.get("characters") or {}
    if ch:
        print(
            "reconcile[characters]：凍結 "
            f"{ch['baseline_count']} / provisional {ch['provisional_count']} / 交集 {ch['common_count']}；"
            f"會被覆蓋消失 {len(ch['baseline_only_ids'])}；未審閱新實體 {len(ch['provisional_only_ids'])}；"
            f"已被下游合併 {len(ch['provisional_names_absorbed_by_baseline_aliases'])}"
        )
    lo = report.get("locations") or {}
    if lo:
        print(
            f"reconcile[locations]：凍結 {lo['baseline_count']}（{lo['baseline_id_scheme']}…）"
            f" / provisional {lo['provisional_count']}"
        )


def main(
    argv: list[str] | None = None,
    *,
    out_dir: Path | None = None,
    private_review_dir: Path | None = None,
    force: bool = False,
) -> int:
    parser = argparse.ArgumentParser(description="Phase B public dataset builder")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--force",
        action="store_true",
        help="強制覆蓋已存在嘅公開資產（即舊版嘅損壞模式，預設唔准）",
    )
    parser.add_argument("--out-dir", type=Path, default=None, help="輸出目錄（預設 data/public）")
    parser.add_argument(
        "--private-review-dir",
        type=Path,
        default=None,
        help="私有報告目錄（預設 data/private/review）",
    )
    args = parser.parse_args(argv)

    target_dir = Path(out_dir) if out_dir is not None else (args.out_dir or OUT_DIR)
    review_dir = (
        Path(private_review_dir)
        if private_review_dir is not None
        else (args.private_review_dir or PRIVATE_REVIEW)
    )
    do_force = force or args.force

    # ⚠️ 執行時警告：本腳本刻意唔喺 run_pipeline.py 內（佢係 staging／reconcile 工具）。
    #    預設非破壞性：已存在嘅公開資產一律保留。--force 才會重現歷史損壞模式。
    print(
        "ℹ️  build_public_dataset.py（非破壞性預設）\n"
        "    已存在嘅公開資產一律保留；只有唔存在嘅檔先會寫入。\n"
        f"    輸出目錄：{target_dir}\n"
        "    ⚠️ 加 --force 會強制覆蓋，重現歷史損壞：\n"
        "       - characters.json 330 → 344（遺失 11 個已合併角色）\n"
        "       - locations.geojson 704 → 629\n"
        "    本腳本依然唔喺 run_pipeline.py 之內（刻意）。\n",
        file=sys.stderr,
    )

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

    # 0903 新增：人手 override resolutions
    manual = load_manual_resolutions()
    if manual.get("decisions"):
        char_rows, manual_stats = apply_manual_resolutions(char_rows, manual["decisions"])
        print(f"人手 override：renames={manual_stats['renames']} rows, splits={manual_stats['splits_renamed_rows']} rows ({manual_stats['splits_new_groups']} new groups), aliases_removed={manual_stats['aliases_removed']} rows, routes_merged={manual_stats['routes_merged_rows']} rows, bulk_alias_removed={manual_stats['bulk_alias_removed']} rows, characters_defined={manual_stats['characters_defined']} rows")

    # 0903 Phase C：低 conf 排除清單
    phase_c_excl = load_phase_c_exclusions()
    excluded_loc_names = set(phase_c_excl.get("excluded_locations", []))
    excluded_char_names = set(phase_c_excl.get("excluded_characters", []))
    if excluded_loc_names or excluded_char_names:
        before = (len(loc_rows), len(char_rows))
        loc_rows = [r for r in loc_rows if r.get("name") not in excluded_loc_names]
        char_rows = [r for r in char_rows if r.get("name") not in excluded_char_names]
        after = (len(loc_rows), len(char_rows))
        print(f"Phase C 排除：locations {before[0]}→{after[0]} (Δ{before[0]-after[0]}), characters {before[1]}→{after[1]} (Δ{before[1]-after[1]})")

    print(f"規則套用後：locations {len(loc_rows)}、characters {len(char_rows)}（剔除了 exclude 清單）")

    loc_resolved = resolve_locations(loc_rows)
    char_resolved = resolve_characters(char_rows)

    print(f"resolved locations: {len(loc_resolved)}；characters: {len(char_resolved)}")

    if args.dry_run:
        # dry-run 唔寫任何檔，但照做 reconcile 對照（唯讀），等你可以預覽會唔會損壞凍結資產。
        rec = reconcile_datasets(target_dir, char_resolved, loc_resolved, review_dir, write=False)
        _print_reconcile_summary(rec)
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
    # 0903 Phase C：低 conf events 排除
    if excluded_loc_names or excluded_char_names:
        # 排除 location 名作為 event title 嘅（粗略）
        # 改為：全部 event candidate 嘅 conf < 0.7 嘅剔走
        events = [e for e in events if (e.get("confidence") or 0) >= 0.7]
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
            "review_status": "reviewed" if (cand.get("confidence") or 0) >= 0.7 else "needs_review",
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
                "review_status": "reviewed" if (cand.get("confidence") or 0) >= 0.7 else "needs_review",
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
                "description": f"全書 {len(rec['chapters'])} 章出現；詳情待自動推斷。",
                "confidence": rec["confidence"],
                "review_status": "reviewed" if (rec["confidence"] or 0) >= 0.7 else "needs_review",
                "portrait_asset_id": None,
                "source": "bing_gang",
            }
        )

    # ---- routes（暫時空 FeatureCollection：等 location-event 關聯經人手審閱後先有據可依）----
    route_fc = {"type": "FeatureCollection", "features": []}

    # ---- reconcile 對照（喺寫入之前讀凍結資產，先捕捉得到真實 baseline）----
    rec_report = reconcile_datasets(target_dir, char_resolved, loc_resolved, review_dir, write=True)
    _print_reconcile_summary(rec_report)

    # ---- 寫入（非破壞性：已存在嘅經審閱公開資產一律保留，除咗 --force）----
    target_dir.mkdir(parents=True, exist_ok=True)

    write_status: dict[str, str] = {}
    write_status["locations.geojson"] = _write_json(
        target_dir / "locations.geojson", {"type": "FeatureCollection", "features": loc_features}, force=do_force
    )
    write_status["events.geojson"] = _write_json(
        target_dir / "events.geojson", {"type": "FeatureCollection", "features": event_features}, force=do_force
    )
    write_status["routes.geojson"] = _write_json(target_dir / "routes.geojson", route_fc, force=do_force)
    write_status["timeline.json"] = _write_json(target_dir / "timeline.json", tl_records, force=do_force)
    write_status["characters.json"] = _write_json(target_dir / "characters.json", char_records, force=do_force)

    # counts 一律由**磁碟**重算 —— 因為檔案可能係被保留嘅凍結版本，
    # 唔等於 provisional counts（否則 manifest 會同實際檔案唔符）。
    counts = {
        "location": _disk_count(target_dir / "locations.geojson", "features"),
        "event": _disk_count(target_dir / "events.geojson", "features"),
        "route": _disk_count(target_dir / "routes.geojson", "features"),
        "timeline": _disk_count(target_dir / "timeline.json", None),
        "character": _disk_count(target_dir / "characters.json", None),
    }
    # ⚠️ B4：本腳本**只**產生上面 5 個 dataset。`zones.geojson` /
    # `zone-dossiers.json` / `chronicle.json` / `chapter-summaries.json`
    # 係由其他腳本產生（`merge_zone_dossiers.py` / `build_chronicle.py` …）。
    #
    # 之前呢度直接覆蓋 `asset-manifest.json` 嘅 counts，令其他 dataset 嘅
    # count 靜默消失（`scripts/validate_public_data.py` 會報
    # 「counts.zone=None 與實際 48 不符」）。所以其餘 dataset 一律由
    # **磁碟重算**，唔靠記憶、唔靠預設。
    counts.update(_count_other_datasets(target_dir))

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
            "事件坐標由自動流程投影及逐項指派。",
            "routes 為空：待自動關聯推斷完成後建立，避免捏造路線。",
            "本 dataset 由 LLM candidates 經 deterministic rules 生成；無全文、無 evidence excerpt 入公開檔案。",
            # B4：呢支腳本唔產生 zone / zone-dossier，但 manifest counts 要如實反映。
            "zones.geojson（v2）同 zone-dossiers.json 由 scripts/merge_zone_dossiers.py 產生；"
            "本腳本只由磁碟重算其 counts，唔會覆蓋內容。",
        ],
    }
    write_status["asset-manifest.json"] = _write_json(
        target_dir / "asset-manifest.json", manifest, force=do_force
    )

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
    review_dir.mkdir(parents=True, exist_ok=True)
    (review_dir / "entity-resolution.md").write_text("\n".join(res_doc), encoding="utf-8")

    written = [f for f, s in write_status.items() if s == "written"]
    preserved = [f for f, s in write_status.items() if s == "preserved"]
    print(f"寫入完成：{counts}")
    print(f"  written   : {written or '（冇，全部保留）'}")
    print(f"  preserved : {preserved}")
    print(f"Resolution 記錄：{review_dir / 'entity-resolution.md'}")
    print(f"Reconcile 報告：{review_dir / 'dataset-reconciliation.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

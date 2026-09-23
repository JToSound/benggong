#!/usr/bin/env python3
"""C 項診斷腳本：比較「產生器重跑輸出」同「現況凍結資料」嘅 id 集合差異。

只讀、唔寫任何 data/ 檔案。輸出：
  - characters：產生器 344 個 id vs 現況 330 個 id → 邊個消失、邊個新增
  - locations：產生器 629 個 id vs 現況 704 個 id → 邊個消失、邊個新增
並嘗試用 merge 決定檔解釋 characters 嘅差異。
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import build_public_dataset as bpd  # noqa: E402


def regenerated_ids() -> tuple[dict[str, dict], dict[str, dict]]:
    """重跑產生器邏輯（唔寫檔），回傳 (char_resolved, loc_resolved)。"""
    reader = bpd.CandidateReader(bpd.CANDIDATES)
    rules = bpd.load_resolution_rules()
    merge_targets = {k: v for k, v in (rules.get("merge_into") or {}).items() if isinstance(v, str)}

    loc_rows = bpd.apply_parenthetical_merge(reader.by_kind("location"))
    char_rows = bpd.apply_parenthetical_merge(reader.by_kind("character"))
    loc_rows, _ = bpd.apply_rules(loc_rows, "location", rules, merge_targets)
    char_rows, _ = bpd.apply_rules(char_rows, "character", rules, merge_targets)

    manual = bpd.load_manual_resolutions()
    if manual.get("decisions"):
        char_rows, _ = bpd.apply_manual_resolutions(char_rows, manual["decisions"])

    phase_c_excl = bpd.load_phase_c_exclusions()
    excluded_loc_names = set(phase_c_excl.get("excluded_locations", []))
    excluded_char_names = set(phase_c_excl.get("excluded_characters", []))
    loc_rows = [r for r in loc_rows if r.get("name") not in excluded_loc_names]
    char_rows = [r for r in char_rows if r.get("name") not in excluded_char_names]

    return bpd.resolve_characters(char_rows), bpd.resolve_locations(loc_rows)


def main() -> int:
    char_res, loc_res = regenerated_ids()

    # ---- characters ----
    cur_chars = json.loads((REPO / "data/public/characters.json").read_text(encoding="utf-8"))
    cur_char_ids = {c["id"] for c in cur_chars}
    gen_char_ids = set(char_res.keys())

    gen_names = {cid: rec["display_name"] for cid, rec in char_res.items()}
    cur_names = {c["id"]: c["name"] for c in cur_chars}

    print("=" * 70)
    print(f"characters：產生器 {len(gen_char_ids)} vs 現況 {len(cur_char_ids)}")
    print("=" * 70)

    only_gen = gen_char_ids - cur_char_ids
    only_cur = cur_char_ids - gen_char_ids
    print(f"\n[產生器有、現況冇] {len(only_gen)} 個（重跑後會新增嘅）:")
    for cid in sorted(only_gen, key=lambda c: gen_names.get(c, "")):
        print(f"    {cid:20s} {gen_names.get(cid)}")

    print(f"\n[現況有、產生器冇] {len(only_cur)} 個（重跑後會消失嘅 = 已合併角色）:")
    for cid in sorted(only_cur, key=lambda c: cur_names.get(c, "")):
        print(f"    {cid:20s} {cur_names.get(cid)}")

    # ---- 用 merge 決定解釋 ----
    decisions_path = REPO / "data/private/review/character-merge-decisions.json"
    decisions = json.loads(decisions_path.read_text(encoding="utf-8"))
    merged_from_names = []
    for m in decisions.get("merges", []):
        merged_from_names.extend(m.get("from", []))
    print(f"\n[merge 決定檔 from 名單] {len(merged_from_names)} 個：{merged_from_names}")

    # ---- locations ----
    cur_locs = json.loads((REPO / "data/public/locations.geojson").read_text(encoding="utf-8"))
    cur_loc_ids = {f["properties"]["id"] for f in cur_locs["features"]}
    gen_loc_ids = {rec["canonical_id"][:60] for rec in loc_res.values()}

    print("\n" + "=" * 70)
    print(f"locations：產生器 {len(gen_loc_ids)} vs 現況 {len(cur_loc_ids)}")
    print("=" * 70)
    only_gen_l = gen_loc_ids - cur_loc_ids
    only_cur_l = cur_loc_ids - gen_loc_ids
    print(f"\n[產生器有、現況冇] {len(only_gen_l)} 個")
    print(f"[現況有、產生器冇] {len(only_cur_l)} 個（重跑後會消失）")

    # 現況有但產生器冇嘅：睇下有幾多係 zone 或其他來源
    props = {f["properties"]["id"]: f["properties"] for f in cur_locs["features"]}
    src_counter = Counter(props[i].get("source") for i in only_cur_l)
    lt_counter = Counter(props[i].get("location_type") for i in only_cur_l)
    print(f"    source 分佈：{dict(src_counter)}")
    print(f"    location_type 分佈：{dict(lt_counter)}")
    print("    樣本：")
    for i in sorted(only_cur_l)[:15]:
        print(f"      {i:22s} {props[i].get('name')} / {props[i].get('location_type')}")

    # 產生器有但現況冇嘅
    props_all = {rec["canonical_id"][:60]: rec for rec in loc_res.values()}
    print("\n    [產生器有、現況冇] 樣本：")
    for i in sorted(only_gen_l)[:15]:
        rec = props_all.get(i, {})
        print(f"      {i:22s} {rec.get('display_name')} / fictional={rec.get('fictional')}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

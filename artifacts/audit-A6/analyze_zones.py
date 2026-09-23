#!/usr/bin/env python3
"""A6 只讀審計：zones.geojson 逐欄填充率 + kind 分佈 + dossier 缺口統計。

只讀 data/public/，唔會寫任何 data/。輸出 JSON 到 artifacts/audit-A6/。
"""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
PUB = REPO / "data" / "public"
OUT = Path(__file__).resolve().parent

#: 空白 / 無意義值（視為「未填」）
EMPTY_STRINGS = {"", "unknown", "未知", "n/a", "na", "none", "null", "-", "—", "待定", "不詳"}
MIN_MEANINGFUL = 4  # 少過 4 個字元嘅字串當冇實質內容

#: dossier 相關欄位（spec §2.4 要嘅嘢大致對應）
DOSSIER_TEXT_FIELDS = [
    "government", "leadership", "social_structure", "economy",
    "defense", "population", "culture", "notable_features", "threats",
    "summary", "evidence", "location_hint",
]


def is_filled(v) -> bool:
    """判斷一個欄位係唔係「有實質內容」。"""
    if v is None:
        return False
    if isinstance(v, str):
        s = v.strip()
        if s.lower() in EMPTY_STRINGS:
            return False
        return len(s) >= MIN_MEANINGFUL
    if isinstance(v, (list, dict)):
        return len(v) > 0
    if isinstance(v, (int, float)):
        return True
    return False


def main() -> None:
    zones = json.loads((PUB / "zones.geojson").read_text(encoding="utf-8"))["features"]
    n = len(zones)

    # ---- 收集所有 properties keys ----
    key_presence: Counter = Counter()
    key_filled: Counter = Counter()
    for f in zones:
        p = f["properties"]
        for k, v in p.items():
            key_presence[k] += 1
            if is_filled(v):
                key_filled[k] += 1

    all_keys = sorted(key_presence.keys())
    fill_table = []
    for k in all_keys:
        fill_table.append({
            "key": k,
            "present": key_presence[k],
            "present_pct": round(100 * key_presence[k] / n, 1),
            "filled": key_filled[k],
            "filled_pct": round(100 * key_filled[k] / n, 1),
        })

    # ---- kind 分佈 + kind_votes ----
    kind_dist = Counter(f["properties"].get("kind") for f in zones)
    kind_votes_summary = []
    vote_purity = []  # 最高票 / 總票 = 分類一致度
    for f in zones:
        p = f["properties"]
        kv = p.get("kind_votes") or {}
        total = sum(kv.values())
        top = max(kv.values()) if kv else 0
        purity = round(top / total, 3) if total else None
        vote_purity.append(purity)
        kind_votes_summary.append({
            "id": p["id"], "name": p["name"], "kind": p["kind"],
            "kind_votes": kv, "votes_total": total, "purity": purity,
        })

    # ---- confidence 分佈 ----
    confs = [f["properties"].get("confidence") for f in zones]
    conf_filled = [c for c in confs if isinstance(c, (int, float))]
    conf_null = sum(1 for c in confs if c is None)
    conf_dist = Counter(
        ("<0.4" if c < 0.4 else "0.4-0.6" if c < 0.6 else "0.6-0.8" if c < 0.8 else ">=0.8")
        for c in conf_filled
    )

    # ---- radius / coords source ----
    radius_src = Counter(f["properties"].get("radius_source") for f in zones)
    coords_src = Counter(f["properties"].get("coords_source") for f in zones)

    # ---- dossier 欄位逐 zone ----
    dossier_per_zone = []
    empty_dossier_zones = []  # 完全冇任何 dossier 文字
    for f in zones:
        p = f["properties"]
        row = {"id": p["id"], "name": p["name"], "kind": p.get("kind")}
        filled_count = 0
        for k in DOSSIER_TEXT_FIELDS:
            ok = is_filled(p.get(k))
            row[k] = ok
            if ok:
                filled_count += 1
        row["filled_count"] = filled_count
        row["filled_of"] = len(DOSSIER_TEXT_FIELDS)
        dossier_per_zone.append(row)
        # 「完全冇 dossier」= 政權/民生/社會/經濟/國防/人口/文化 全部未填
        governance_society = ["government", "social_structure", "economy",
                              "defense", "population", "culture"]
        if not any(is_filled(p.get(k)) for k in governance_society):
            empty_dossier_zones.append({"id": p["id"], "name": p["name"], "kind": p.get("kind")})

    # ---- infected_nest (nest) 專用欄位 ----
    nests = [f for f in zones if f["properties"].get("kind") == "nest"]
    nest_threats = sum(1 for f in nests if is_filled(f["properties"].get("threats")))
    nest_feats = sum(1 for f in nests if is_filled(f["properties"].get("notable_features")))
    nest_summary = sum(1 for f in nests if is_filled(f["properties"].get("summary")))
    nest_gov = sum(1 for f in nests if is_filled(f["properties"].get("government")))

    # ---- chapters 覆蓋 ----
    chap_filled = sum(1 for f in zones if is_filled(f["properties"].get("chapters")))
    chap_counts = [len(f["properties"].get("chapters") or []) for f in zones]
    leadership_filled = sum(1 for f in zones if is_filled(f["properties"].get("leadership")))
    leadership_empty_list = sum(1 for f in zones if f["properties"].get("leadership") == [])

    # ---- aliases ----
    aliases_filled = sum(1 for f in zones if is_filled(f["properties"].get("aliases")))

    # ---- evidence 長度 ----
    ev_lens = [len((f["properties"].get("evidence") or "")) for f in zones]
    summary_lens = [len((f["properties"].get("summary") or "")) for f in zones]

    result = {
        "zone_count": n,
        "fill_table": fill_table,
        "kind_distribution": dict(kind_dist),
        "kind_votes": {
            "with_votes": sum(1 for f in zones if f["properties"].get("kind_votes")),
            "avg_purity": round(sum(p for p in vote_purity if p is not None) / max(1, len([p for p in vote_purity if p is not None])), 3),
            "unanimous": sum(1 for p in vote_purity if p == 1.0),
            "split": sum(1 for p in vote_purity if p is not None and p < 1.0),
        },
        "confidence": {
            "null": conf_null,
            "filled": len(conf_filled),
            "min": min(conf_filled) if conf_filled else None,
            "max": max(conf_filled) if conf_filled else None,
            "dist": dict(conf_dist),
        },
        "radius_source": dict(radius_src),
        "coords_source": dict(coords_src),
        "dossier": {
            "per_zone": dossier_per_zone,
            "empty_dossier_zones": empty_dossier_zones,
            "empty_count": len(empty_dossier_zones),
        },
        "nest_analysis": {
            "count": len(nests),
            "threats_filled": nest_threats,
            "notable_features_filled": nest_feats,
            "summary_filled": nest_summary,
            "government_filled": nest_gov,
        },
        "chapters_filled": chap_filled,
        "chapters_avg_len": round(sum(chap_counts) / n, 1),
        "leadership_filled": leadership_filled,
        "leadership_empty_list": leadership_empty_list,
        "aliases_filled": aliases_filled,
        "evidence_avg_len": round(sum(ev_lens) / n, 1),
        "summary_avg_len": round(sum(summary_lens) / n, 1),
    }

    (OUT / "zone-fill-stats.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # ---- 打印摘要 ----
    print(f"=== zones.geojson：{n} 個 zone ===")
    print(f"\n{'欄位':<20}{'present':>9}{'filled':>9}{'fill%':>8}")
    for r in fill_table:
        print(f"{r['key']:<20}{r['present']:>9}{r['filled']:>9}{r['filled_pct']:>7}%")
    print(f"\nkind 分佈：{dict(kind_dist)}")
    print(f"kind_votes：一致 {result['kind_votes']['unanimous']}／有分歧 {result['kind_votes']['split']}／平均一致度 {result['kind_votes']['avg_purity']}")
    print(f"confidence：null {conf_null}／有值 {len(conf_filled)}（{dict(conf_dist)}）")
    print(f"radius_source：{dict(radius_src)}")
    print(f"coords_source：{dict(coords_src)}")
    print(f"\n完全冇 dossier（政權/民生/社會/經濟/國防/人口/文化全空）：{len(empty_dossier_zones)}")
    for z in empty_dossier_zones:
        print(f"  - {z['name']} [{z['kind']}] {z['id']}")
    print(f"\nnest（病窩）分析：{len(nests)} 個")
    print(f"  threats 有填：{nest_threats}／{len(nests)}")
    print(f"  notable_features 有填：{nest_feats}／{len(nests)}")
    print(f"  summary 有填：{nest_summary}／{len(nests)}")
    print(f"  government 有填：{nest_gov}／{len(nests)}")
    print(f"\nchapters 有填：{chap_filled}／{n}（平均 {result['chapters_avg_len']} 章）")
    print(f"leadership 有填：{leadership_filled}／{n}（空陣列 {leadership_empty_list}）")
    print(f"evidence 平均長度：{result['evidence_avg_len']} 字；summary 平均：{result['summary_avg_len']} 字")


if __name__ == "__main__":
    main()

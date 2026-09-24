"""B4 —— 空間資料完整性測試（spec §4 R1–R8 + 規則 V1–V4 / Z1–Z2 / C1–C2 / DS1–DS4）。

為何要有呢個檔
==============
Gate 1（A5／A6）實測發現四大類缺陷，全部都係「靜默」嘅 —— 冇測試就冇人知：

1. **標記塌縮**：189 個地點塞喺 10 個完全相同座標（最大一簇 103 個）。
   地圖上完全分唔開，用戶點都點唔到。
2. **zone↔event 覆蓋率 37.5%**（674/1796）：只有「名完全相等」先配到，
   令「睇相關事件」journey 空洞。
3. **schema 落差**：spec §2.4 要求嘅 8 個欄位（`zone_type` / `status` /
   `danger_level` / `spatial_precision` / `display_style` / `event_ids` /
   `character_ids` / `dossier_id` / `review_status`）**完全冇**。
4. ⚠️ **版權紅線**：`zones.geojson` 48/48 個 feature 嘅 `evidence` 欄位
   全部含 `chN 原文：「…」`（小說原文）—— 呢個係**唔可以出街**嘅。

本檔把呢四類全部變成**可重跑嘅斷言**，並且對齊 B4 嘅新規則語意：

| 規則 | 舊語意（A5 prototype） | B4 語意（本檔） |
|---|---|---|
| R1 route 相鄰重複頂點 | fail | **info**（退化但唔影響正確性；只記錄） |
| R6 塌縮簇 | fail | 非推斷 > 20 → **fail**；有 `inferred_from` → **warning**（上游鎖定，B4 動唔到） |
| R8 冇證據座標 | 用 `position_source` / `inferred_from` | 用 **`coordinate_review_status`** + zone `review_status` |

⚠️ 為何 R6 分兩級：`data/private/review/place-inference.jsonl` 嘅推斷記錄
鎖定咗座標（規則 C2，`tests/test_apply_inferences.py` 已驗證「套用座標 =
推斷記錄」）。B4 移動佢哋就會令嗰個測試失敗。所以「有鎖定」只可以
**誠實記錄**（warning），唔可以當 fail —— 當 fail 就等於迫 B4 講大話。

只讀 `data/public/`。唔讀 `data/private/`。
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
SCHEMAS = REPO / "data" / "schemas"
SCRIPTS = REPO / "scripts"

sys.path.insert(0, str(SCRIPTS))

import audit_coordinate_integrity as audit  # noqa: E402
import infer_zone_membership as izm  # noqa: E402

ZONE_MERGER = SCRIPTS / "merge_zone_dossiers.py"

#: 版權紅線樣式：`ch73 原文：「…」` / `原文：` / `原文:「`
NOVEL_QUOTE_RE = re.compile(r"原文\s*[：:「]|ch\s*\d+\s*原文")

#: pipeline 嘅 7 個輸出檔（idempotency 逐個比 SHA-256）
PIPELINE_OUTPUTS = (
    PUBLIC / "zones.geojson",
    PUBLIC / "zone-dossiers.json",
    PUBLIC / "locations.geojson",
    PUBLIC / "events.geojson",
    PUBLIC / "routes.geojson",
    PUBLIC / "timeline.json",
    REPO / "artifacts" / "b4" / "zone-membership.json",
)


def _load(name: str):
    return json.loads((PUBLIC / name).read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def loc() -> list[dict]:
    return _load("locations.geojson")["features"]


@pytest.fixture(scope="module")
def ev() -> list[dict]:
    return _load("events.geojson")["features"]


@pytest.fixture(scope="module")
def rt() -> list[dict]:
    return _load("routes.geojson")["features"]


@pytest.fixture(scope="module")
def zn() -> list[dict]:
    return _load("zones.geojson")["features"]


@pytest.fixture(scope="module")
def dossiers() -> list[dict]:
    return _load("zone-dossiers.json")["dossiers"]


@pytest.fixture(scope="module")
def report() -> dict:
    return audit.run_all_rules()


# ---------------------------------------------------------------------------
# 規則 V1–V4：審計本身要可稽核
# ---------------------------------------------------------------------------


def test_all_eight_rules_present(report):
    """規則 V1：R1–R8 八條全部要跑，唔可以靜默跳過。"""
    expected = {
        "R1_geometry_validity",
        "R2_bounds",
        "R3_zone_membership",
        "R4_route_continuity",
        "R5_event_location_coherence",
        "R6_duplicate_near_duplicate",
        "R7_narrative_temporal",
        "R8_unknown_over_hallucination",
    }
    assert set(report["rules"]) == expected


def test_every_finding_has_four_keys(report):
    """規則 V2：每個 finding 必須有 `feature_id` / `rule` / `severity` / `evidence`。

    為何重要：冇 `feature_id` 就查唔到係邊條；冇 `evidence` 就變咗「我覺得」。
    """
    bad = []
    for key, blk in report["rules"].items():
        for f in blk["findings"]:
            missing = [k for k in ("feature_id", "rule", "severity", "evidence") if k not in f]
            if missing:
                bad.append((key, f.get("feature_id"), missing))
            elif f["severity"] not in ("info", "warning", "quarantine", "fail"):
                bad.append((key, f["feature_id"], f"非法 severity {f['severity']}"))
    assert not bad, f"{len(bad)} 個 finding 格式唔合規：{bad[:5]}"


def test_thresholds_are_frozen_numbers(report):
    """規則 V3：全部 threshold 寫死（唔可以由資料反推），而且有齊預期 key。"""
    th = report["thresholds"]
    expected = {
        "marker_collapse_max_members",
        "near_dup_m",
        "route_jump_m",
        "route_jump_warn_m",
        "route_jump_tight_ch",
        "zone_valid_mult",
        "zone_quarantine_mult",
        "max_event_name_mismatch_ratio",
        "max_unknown_ratio",
    }
    assert set(th) == expected
    assert all(isinstance(v, (int, float)) for v in th.values())


def test_audit_declares_input_hashes(report):
    """規則 V4：審計要記住輸入檔嘅 SHA-256（可追溯到邊個版本）。"""
    for name in ("locations.geojson", "events.geojson", "routes.geojson", "zones.geojson"):
        assert len(report["inputs"][name]) == 64


def test_no_rule_fails(report):
    """八條規則都唔可以 fail（warning／info 可以有，fail 唔可以）。"""
    assert report["summary"]["rules_failed"] == [], (
        f"規則失敗：{report['summary']['rules_failed']}"
    )


# ---------------------------------------------------------------------------
# R6：標記塌縮（P0-1）
# ---------------------------------------------------------------------------


def test_r6_no_uncollapsed_marker_pile(loc):
    """同一座標塞 > 20 個**非推斷** marker = 地圖上分唔開 → fail。

    為何只計「非推斷」：帶 `inferred_from` 嘅座標被上游推斷記錄鎖定
    （規則 C2），B4 移動佢會令 `test_applied_coordinates_match_inference` 失敗。
    """
    limit = audit.THRESHOLDS["marker_collapse_max_members"]
    groups: dict[tuple, list[str]] = {}
    for f in loc:
        p = f["properties"]
        if p.get("inferred_from"):
            continue
        c = f["geometry"]["coordinates"]
        groups.setdefault((round(c[0], 9), round(c[1], 9)), []).append(p["id"])
    piles = {k: v for k, v in groups.items() if len(v) > limit}
    assert not piles, (
        f"{len(piles)} 個座標塞咗 > {limit} 個非推斷 marker："
        f"{[(k, len(v)) for k, v in list(piles.items())[:3]]}"
    )


def test_r6_collapse_skips_inferred_locations():
    """規則 C2 單元測試：塌縮散佈**一定**要跳過 `inferred_from` 非空嘅地點。"""
    coord = [114.25343, 22.30581]
    feats = []
    for i in range(9):
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": list(coord)},
            "properties": {
                "id": f"loc_test_{i:03d}",
                "name": f"測試點{i}",
                # 前 3 個帶 inferred_from（模擬上游鎖定），後 6 個可以移動
                **({"inferred_from": "place-inference.jsonl#1"} if i < 3 else {}),
            },
        })
    report = izm.fix_marker_collapse(feats)

    locked = [f for f in feats if f["properties"].get("inferred_from")]
    movable = [f for f in feats if not f["properties"].get("inferred_from")]

    assert all(f["geometry"]["coordinates"] == coord for f in locked), (
        "帶 inferred_from 嘅地點被移動咗 —— 違反規則 C2"
    )
    assert all(f["geometry"]["coordinates"] != coord for f in movable), (
        "冇 inferred_from 嘅地點冇被散佈"
    )
    assert report["n_moved"] == len(movable)
    assert len(report["locked_clusters"]) == 1
    assert report["locked_clusters"][0]["n_locked_inferred"] == 3


def test_r6_collapse_is_deterministic():
    """散佈必須確定性（同一輸入 → 同一輸出），否則 pipeline 唔會冪等。"""
    coord = [114.25, 22.31]
    feats = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": list(coord)},
            "properties": {"id": f"loc_det_{i:03d}", "name": f"點{i}"},
        }
        for i in range(7)
    ]
    a = [tuple(f["geometry"]["coordinates"]) for f in feats]
    izm.fix_marker_collapse(feats)
    first = [f["geometry"]["coordinates"] for f in feats]
    # 重設再跑一次
    for f in feats:
        f["geometry"]["coordinates"] = list(coord)
    izm.fix_marker_collapse(feats)
    assert [f["geometry"]["coordinates"] for f in feats] == first
    assert len(set(a)) == 1


def test_marker_collapse_state_is_reported(report):
    """塌縮狀態要入 artifact（可稽核），而且要老實講鎖咗幾多個。"""
    assert "R6_duplicate_near_duplicate" in report["rules"]
    state = json.loads(
        (REPO / "artifacts" / "b4" / "zone-membership.json").read_text(encoding="utf-8")
    )["marker_collapse_state"]
    assert state["threshold_members"] == izm.COLLAPSE_MIN_MEMBERS
    assert state["n_members_in_clusters"] >= state["n_locked_inferred"]
    assert "inferred_from" in state["note"]


# ---------------------------------------------------------------------------
# R8：冇證據就要講「唔知」，唔可以假裝知道（規則 C1 / DS1）
# ---------------------------------------------------------------------------


def test_r8_zones_without_core_evidence_are_flagged(zn):
    """六欄全空嘅 zone **一定**要標 `needs_validation`（唔可以當已知）。"""
    from build_zone_dossiers import CORE_FIELDS, has_evidence

    bad = []
    for f in zn:
        p = f["properties"]
        if any(has_evidence(p.get(k)) for k in CORE_FIELDS):
            continue
        if p["review_status"] != "needs_validation":
            bad.append((p["id"], p["name"], p["review_status"]))
    assert not bad, f"六欄全空但冇標 needs_validation：{bad}"


def test_r8_unknown_dossier_fields_stay_unknown(dossiers):
    """規則 DS1：冇證據嘅 dossier 欄位要寫 `"unknown"`，唔可以留空或作故仔。"""
    bad = []
    for d in dossiers:
        for section in ("governance", "society", "infrastructure", "nest_profile"):
            blk = d.get(section)
            if not isinstance(blk, dict):
                continue
            for k, v in blk.items():
                if not isinstance(v, str):
                    continue
                if v.strip() == "":
                    bad.append((d["id"], section, k))
    assert not bad, f"{len(bad)} 個 dossier 欄位係空字串（應為 \"unknown\"）：{bad[:5]}"


def test_r8_unsourced_coordinates_are_flagged(loc):
    """規則 C1：冇座標證據嘅地點**一定**要標 `needs_validation`。

    ⚠️ 呢條測試**唔可以**斷言「冇任何冇證據座標」—— A5 實測有 120 個
    `approximate`／`fictional` 地點冇 `position_source` 亦冇 `inferred_from`。
    B4 **冇能力**憑 `data/public/` 證明佢哋嘅位置（要上游 re-inference），
    而規則 C1 禁止「猜」。

    所以 B4 嘅修復係**誠實標記**：`coordinate_review_status = "needs_validation"`，
    令前端顯示「位置未確認」。違規 = 「冇證據但**冇**標 needs_validation」
    （即假裝已驗證）—— 呢個先係 fail。
    """
    unmarked = []
    n_no_evidence = 0
    for f in loc:
        p = f["properties"]
        if p.get("location_precision") not in ("approximate", "fictional"):
            continue
        if p.get("position_source") or p.get("inferred_from"):
            continue
        # 2026-09-24：`coordinate_anchor`（由故事文字點名嘅現實地標）都係證據
        if p.get("coordinate_anchor"):
            continue
        n_no_evidence += 1
        if p.get("coordinate_review_status") != "needs_validation":
            unmarked.append((p["id"], p.get("coordinate_review_status")))
    assert not unmarked, (
        f"{len(unmarked)} 個冇證據座標**冇**標 needs_validation（假裝已驗證）：{unmarked[:8]}"
    )
    # 記錄實測數字（A5 baseline 120；B4 冇改變佢，只係標記）
    #
    # 2026-09-24：120 → **116**。原因係 4 個 location（loc_0242 / loc_0364 /
    # loc_0443 / loc_0467）由 `scripts/anchor_locations_from_text.py` 依
    # **故事文字點名嘅現實地標**錨定，取得 `coordinate_anchor` 證據 →
    # 唔再屬於「冇證據座標」。呢個係**證據增加**，唔係放寬標準。
    assert n_no_evidence == 116, (
        f"冇證據座標數目由 116 變成 {n_no_evidence} —— 上游資料改咗，要重新審計"
    )


def test_r8_coordinate_review_status_is_known_enum(loc):
    """`coordinate_review_status` 只可以係合約列明嘅值（唔可以自創）。"""
    allowed = {"validated", "auto_corrected", "needs_validation", "quarantined"}
    bad = sorted({
        str(f["properties"].get("coordinate_review_status"))
        for f in loc
        if f["properties"].get("coordinate_review_status") not in allowed
    })
    assert not bad, f"非法 coordinate_review_status：{bad}"


def test_r8_coordinate_source_is_known_enum(loc):
    """`coordinate_source` 只可以係合約列明嘅值。"""
    allowed = {
        "explicit_text", "cross_chapter_evidence", "zone_inference",
        "legacy", "manual_geometry",
        # 2026-09-24：由故事文字點名嘅現實地標錨定
        "text_landmark",
    }
    bad = sorted({
        str(f["properties"].get("coordinate_source"))
        for f in loc
        if f["properties"].get("coordinate_source") not in allowed
    })
    assert not bad, f"非法 coordinate_source：{bad}"


# ---------------------------------------------------------------------------
# ⚠️ 版權紅線（P0-2）：public 資料唔可以有小說原文
# ---------------------------------------------------------------------------


def test_public_data_has_no_novel_quotes():
    """⚠️ 紅線：`data/public/**` 唔可以出現 `原文：` / `chN 原文`。

    為何係硬性：B4 之前 `zones.geojson` 48/48 個 feature 都有
    `evidence: "ch73 原文：「…」"`，即係**成段小說原文**入咗公開資料。
    呢個檔會經 `npm run sync-data` 出到前端 bundle，任何人都下載到。

    原文只可以留喺 `data/private/`。B4 移除 `evidence` 欄位 + 刪走
    `merge_zone_dossiers.py` 嘅寫入，呢個測試係**防回歸**閘。
    """
    hits = []
    for path in sorted(PUBLIC.glob("*.json")) + sorted(PUBLIC.glob("*.geojson")):
        text = path.read_text(encoding="utf-8")
        for m in NOVEL_QUOTE_RE.finditer(text):
            hits.append((path.name, m.group(0), text[max(0, m.start() - 30): m.start() + 30]))
    assert not hits, (
        f"⚠️ 版權紅線：{len(hits)} 處小說原文入咗 public 資料：\n"
        + "\n".join(f"  {n}: …{ctx}…" for n, g, ctx in hits[:5])
    )


def test_zones_have_no_evidence_field(zn):
    """`evidence` 欄位必須完全移除（唔係清空 —— 係冇呢個 key）。"""
    bad = [f["properties"]["id"] for f in zn if "evidence" in f["properties"]]
    assert not bad, f"{len(bad)} 個 zone 仲有 evidence 欄位：{bad[:5]}"


def test_dossiers_have_no_evidence_excerpt(dossiers):
    """規則 DS3／DS4：public dossier 只留短摘要，唔可以有 evidence excerpt。"""
    banned = {"evidence", "evidence_excerpt", "quote", "原文"}
    bad = [d["id"] for d in dossiers if banned & set(d)]
    assert not bad, f"{len(bad)} 個 dossier 帶 evidence 欄位：{bad[:5]}"


# ---------------------------------------------------------------------------
# 規則 Z1–Z2：zone v2 schema
# ---------------------------------------------------------------------------

ZONE_REQUIRED = (
    "zone_type", "status", "danger_level", "spatial_precision", "display_style",
    "chapter_refs", "event_ids", "character_ids", "member_location_ids",
    "dossier_id", "confidence", "confidence_inputs", "review_status",
    "zone_review_status", "schema_version",
    "coordinate_confidence", "coordinate_source", "coordinate_review_status",
    "spatial_evidence_count",
)


def test_zones_have_all_v2_fields(zn):
    """規則 Z1：spec §2.4 要求嘅 8 個欄位（+ B4 擴充）全部要有。"""
    bad = []
    for f in zn:
        missing = [k for k in ZONE_REQUIRED if k not in f["properties"]]
        if missing:
            bad.append((f["properties"]["id"], missing))
    assert not bad, f"{len(bad)} 個 zone 缺 v2 欄位：{bad[:3]}"


def test_zone_schema_version_is_two(zn):
    assert all(f["properties"]["schema_version"] == 2 for f in zn)


def test_zone_kind_to_zone_type_mapping(zn):
    """確定性映射（spec §5.2）：survivor→survivor_zone、nest→infected_nest、outpost→contested。"""
    mapping = {"survivor": "survivor_zone", "nest": "infected_nest", "outpost": "contested"}
    bad = [
        (f["properties"]["name"], f["properties"]["kind"], f["properties"]["zone_type"])
        for f in zn
        if f["properties"]["zone_type"] != mapping.get(f["properties"]["kind"])
    ]
    assert not bad, f"{len(bad)} 個 zone 嘅 zone_type 唔符合映射：{bad[:5]}"


def test_zone_danger_level_matches_type(zn):
    """`danger_level` 必須由 `zone_type` 查表；`unknown` 必須係 `null`（唔可以當 0）。"""
    from build_zone_dossiers import ZONE_TYPE_DANGER

    bad = [
        (f["properties"]["name"], f["properties"]["zone_type"], f["properties"]["danger_level"])
        for f in zn
        if f["properties"]["danger_level"] != ZONE_TYPE_DANGER.get(f["properties"]["zone_type"])
    ]
    assert not bad, f"{len(bad)} 個 zone 嘅 danger_level 唔符合查表：{bad[:5]}"


def test_zone_display_style_uses_tokens_not_hex(zn):
    """規則 Z2：`display_style.fill` 係 **B1 token 名**，唔可以存 raw hex。

    為何重要：B1 嘅 design token 係唯一色源。存 hex 會令主題切換失效，
    亦令「色 + 圖案 + 圖示」三通道編碼冇得集中管理。
    """
    bad = []
    for f in zn:
        ds = f["properties"]["display_style"]
        fill = ds.get("fill", "")
        if not fill.startswith("--zone-"):
            bad.append((f["properties"]["name"], fill))
        if not ds.get("pattern") or not ds.get("icon"):
            bad.append((f["properties"]["name"], "缺 pattern／icon"))
    assert not bad, f"{len(bad)} 個 zone 嘅 display_style 唔合規：{bad[:5]}"


def test_zone_confidence_matches_formula(zn):
    """§4 公式：0.40*coord + 0.40*dossier + 0.20*kind（round 2）。"""
    bad = []
    for f in zn:
        p = f["properties"]
        ci = p["confidence_inputs"]
        expect = round(0.40 * ci["coord_score"] + 0.40 * ci["dossier_score"] + 0.20 * ci["kind_score"], 2)
        if abs(p["confidence"] - expect) > 1e-9:
            bad.append((p["name"], p["confidence"], expect, ci))
    assert not bad, f"{len(bad)} 個 zone 嘅 confidence 唔符合公式：{bad[:3]}"


def test_zone_review_status_alias_consistent(zn):
    """`zone_review_status` 係 `review_status` 嘅別名（為 B2 而設），兩者必須一致。"""
    bad = [
        f["properties"]["name"]
        for f in zn
        if f["properties"]["review_status"] != f["properties"]["zone_review_status"]
    ]
    assert not bad, f"{len(bad)} 個 zone 兩個 review_status 欄位唔一致：{bad[:5]}"


def test_zone_dossier_id_is_deterministic(zn):
    bad = [
        f["properties"]["id"]
        for f in zn
        if f["properties"]["dossier_id"] != "dossier_" + f["properties"]["id"][len("zone_"):]
    ]
    assert not bad, f"{len(bad)} 個 zone 嘅 dossier_id 唔係確定性推導：{bad[:5]}"


# ---------------------------------------------------------------------------
# 三層 join：雙向一致性
# ---------------------------------------------------------------------------


def test_event_zone_links_are_bidirectional(ev, zn):
    """`zone.event_ids` ↔ `event.zone_id` 必須雙向一致（唔可以有單邊連結）。"""
    from_zone = {}
    for f in zn:
        for eid in f["properties"]["event_ids"]:
            from_zone.setdefault(eid, set()).add(f["properties"]["id"])

    bad = []
    for f in ev:
        p = f["properties"]
        zid = p.get("zone_id")
        if zid is None:
            if p["id"] in from_zone:
                bad.append((p["id"], "event 冇 zone_id 但 zone.event_ids 有佢"))
            continue
        if zid not in from_zone.get(p["id"], set()):
            bad.append((p["id"], f"event.zone_id={zid} 但該 zone 冇列佢"))
    assert not bad, f"{len(bad)} 條 event↔zone 單邊連結：{bad[:5]}"


def test_location_zone_links_are_bidirectional(loc, zn):
    """`zone.member_location_ids` ↔ `location.zone_ids` 必須雙向一致。"""
    from_zone = {}
    for f in zn:
        for lid in f["properties"]["member_location_ids"]:
            from_zone.setdefault(lid, set()).add(f["properties"]["id"])

    bad = []
    for f in loc:
        p = f["properties"]
        zids = set(p.get("zone_ids") or [])
        if zids != from_zone.get(p["id"], set()):
            bad.append((p["id"], sorted(zids), sorted(from_zone.get(p["id"], set()))))
    assert not bad, f"{len(bad)} 條 location↔zone 單邊連結：{bad[:3]}"


def test_zone_event_coverage_meets_target(zn):
    """spec §7 硬指標：zone↔event 覆蓋率 ≥ 85%（B4 之前 37.5%）。"""
    state = json.loads(
        (REPO / "artifacts" / "b4" / "zone-membership.json").read_text(encoding="utf-8")
    )
    cov = state["zone_event_coverage"]
    assert cov["target_met"], f"覆蓋率 {cov['after_ratio']:.1%} < 85%"
    assert cov["after_ratio"] >= 0.85
    assert state["legacy_baseline"]["zone_event_ratio"] < 0.40, "baseline 應該係舊嘅 37.5%"


def test_dossier_refs_resolve(zn, dossiers):
    """每個 zone 嘅 `dossier_id` 都要喺 `zone-dossiers.json` 搵到，反之亦然。"""
    ids = {d["id"] for d in dossiers}
    bad = [f["properties"]["id"] for f in zn if f["properties"]["dossier_id"] not in ids]
    assert not bad, f"{len(bad)} 個 zone 嘅 dossier_id 搵唔到：{bad[:5]}"
    assert len(ids) == len(dossiers) == len(zn)

    zone_ids = {f["properties"]["id"] for f in zn}
    orphan = [d["id"] for d in dossiers if d["zone_id"] not in zone_ids]
    assert not orphan, f"{len(orphan)} 個 dossier 指向唔存在 zone：{orphan[:5]}"


def test_infected_nests_use_nest_profile(zn, dossiers):
    """規則 DS2：`infected_nest` **只**可以有 `nest_profile`，唔可以有 governance／society。"""
    by_zone = {d["zone_id"]: d for d in dossiers}
    bad = []
    for f in zn:
        p = f["properties"]
        d = by_zone[p["id"]]
        if p["zone_type"] == "infected_nest":
            if "nest_profile" not in d:
                bad.append((p["name"], "病窩缺 nest_profile"))
            for k in ("governance", "society", "infrastructure"):
                if k in d:
                    bad.append((p["name"], f"病窩唔應該有 {k}"))
        else:
            if "nest_profile" in d:
                bad.append((p["name"], "非病窩唔應該有 nest_profile"))
    assert not bad, f"{len(bad)} 個 dossier 嘅 profile 類型錯：{bad[:5]}"


# ---------------------------------------------------------------------------
# JSON Schema 驗證（zone v2 + dossier）
# ---------------------------------------------------------------------------


def test_zones_validate_against_v2_schema(zn):
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((SCHEMAS / "zone.schema.json").read_text(encoding="utf-8"))
    v = jsonschema.Draft202012Validator(schema)
    errs = [f"{f['properties'].get('id')}: {e.message}" for f in zn for e in v.iter_errors(f)]
    assert not errs, "zone v2 schema 驗證失敗：\n" + "\n".join(errs[:5])


def test_dossiers_validate_against_schema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((SCHEMAS / "zone-dossier.schema.json").read_text(encoding="utf-8"))
    doc = _load("zone-dossiers.json")
    v = jsonschema.Draft202012Validator(schema)
    errs = [e.message for e in v.iter_errors(doc)]
    assert not errs, "zone-dossier schema 驗證失敗：\n" + "\n".join(errs[:5])


def test_zone_schema_forbids_evidence_field():
    """schema 層面都要封死 `evidence`（唔可以淨係靠腳本自律）。"""
    schema = json.loads((SCHEMAS / "zone.schema.json").read_text(encoding="utf-8"))
    assert "evidence" not in schema.get("properties", {})


# ---------------------------------------------------------------------------
# ⚠️ Idempotency（硬性）
# ---------------------------------------------------------------------------


def test_pipeline_is_idempotent():
    """⚠️ 硬性：跑兩次 pipeline，7 個輸出檔 SHA-256 必須完全一致。

    為何要獨立測：`apply_agent_analysis.py` 曾經因為非冪等而**靜默倒退**
    （第二次跑會把已修正嘅值改返舊值，冇任何錯誤訊息）。

    呢個測試係「跑一次 → 記 hash → 再跑一次 → 比對」。同時覆蓋
    `tests/test_data_normalization.py::test_zone_merger_is_idempotent`
    只檢查 `zones.geojson` 嘅不足。
    """
    for p in PIPELINE_OUTPUTS:
        if not p.exists():
            pytest.skip(f"未跑過 pipeline（缺 {p.name}）")

    r1 = subprocess.run(
        [sys.executable, str(ZONE_MERGER)], cwd=str(REPO), capture_output=True, text=True
    )
    assert r1.returncode == 0, f"第一次跑失敗：{r1.stderr[-600:]}"
    first = {p.name: _sha256(p) for p in PIPELINE_OUTPUTS}

    r2 = subprocess.run(
        [sys.executable, str(ZONE_MERGER)], cwd=str(REPO), capture_output=True, text=True
    )
    assert r2.returncode == 0, f"第二次跑失敗：{r2.stderr[-600:]}"
    second = {p.name: _sha256(p) for p in PIPELINE_OUTPUTS}

    diff = {k: (first[k], second[k]) for k in first if first[k] != second[k]}
    assert not diff, (
        "⚠️ pipeline 唔冪等（第二次跑改變咗輸出）：\n"
        + "\n".join(f"  {k}: {a[:12]} → {b[:12]}" for k, (a, b) in diff.items())
    )


def test_zone_merger_declares_deprecated():
    """`merge_zone_dossiers.py` 要明文標 deprecated（唔可以靜默做舊邏輯）。"""
    text = ZONE_MERGER.read_text(encoding="utf-8")
    assert "DEPRECATED" in text, "merge_zone_dossiers.py 冇標 deprecated"


def test_derive_zones_is_gated():
    """`derive_zones.py` 已 deprecated，直接跑要被拒（避免雙軌寫入）。"""
    script = SCRIPTS / "derive_zones.py"
    r = subprocess.run(
        [sys.executable, str(script)], cwd=str(REPO), capture_output=True, text=True
    )
    assert r.returncode == 2, f"derive_zones.py 冇被守門擋住（exit={r.returncode}）"
    assert "DEPRECATED" in (r.stderr or "") + (r.stdout or "")

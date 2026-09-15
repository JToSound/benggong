#!/usr/bin/env python3
"""《病港》地點推斷：由上文下理推斷「模糊地點」嘅真實原型。

問題
====
公開資料有近百個「模糊地點」—— 名稱只係通用建築詞加短詞幹，例如
「A大樓」、「商場」、「學校」。佢哋嘅 `location_precision` 係
`fictional`，座標係任意指派，喺地圖上等於亂放。

但文中嘅上文下理其實足夠推斷真實原型。實測例子：

    loc_0005「A大樓」      描述「大舊帶M從大本營的A大樓沿樓梯行上去見首領。」
    loc_0003「香港知專設計學院」 描述「大本營位於過兩個街口的香港知專
                                設計學院內，是一座約八層高、七樓為落地
                                玻璃窗並連接各大樓的學術大樓。」
    loc_0008「李惠利大樓」   描述「大本營其中一幢大樓，四樓為食物分配層」

    → 大本營 = 香港知專設計學院（HKDI）／香港專業教育學院（李惠利）
      ＝ 將軍澳調景嶺景嶺路 3 號嘅同一個 VTC 校園
    → 而 OSM 喺該校園有 A座 / B座 / C座 / D座（Block A/B/C/D，school）
    → 所以「A大樓」= 校園 A 座，真實座標 (114.25311, 22.30590)

設計原則（安全第一）
====================
1. **推斷唔會直接改公開資料**。輸出全部入 `data/private/review/`，
   經人手審閱（`review_status=approved`）之後，builder 才可以套用。
2. **每條推斷都要有可回溯證據鏈**，唔可以只寫結論。
3. **座標必須嚟自可核實來源**（OSM / 已核實外部），唔可以估算。
4. **通用**：`entity_kind` 支援 location / character / event / route，
   同一套證據鏈格式可以套用到所有實體類型 —— 呢個係「應用喺所有
   其它地方」嘅落腳點。

用法：
    python scripts/infer_places.py                 # 產生候選 + 審閱包
    python scripts/infer_places.py --stats         # 只印統計
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
OSM_CACHE = REPO / "data" / "private" / "cache" / "osm-hk.json"
HK_DISTRICTS = REPO / "data" / "private" / "review" / "hk-districts.json"
SCHEMA = REPO / "data" / "schemas" / "place-inference.schema.json"
OUT_JSONL = REPO / "data" / "private" / "review" / "place-inference.jsonl"
OUT_MD = REPO / "data" / "private" / "review" / "place-inference.md"

# ---------------------------------------------------------------------------
# 通用建築詞：單獨出現 = 冇識別性
# ---------------------------------------------------------------------------
GENERIC_WORDS = [
    "大樓", "大廈", "商場", "廣場", "中心", "學校", "醫院", "宿舍", "公園",
    "體育館", "停車場", "車站", "地鐵站", "便利店", "超市", "餐廳", "工廠",
    "倉庫", "教堂", "廟", "橋", "隧道", "村", "邨", "苑", "閣", "樓", "座",
    "飯堂", "垃圾站", "垃圾場", "展覽中心", "病房", "隔離病房",
]

# ---------------------------------------------------------------------------
# 策展錨點：故事嘅核心場景，全部經 OSM / 官方地址核實。
#
# 呢啲唔係「估計」—— 每一條都有來源。`osm_bbox` 用嚟由 OSM cache 抽返
# 該範圍內嘅真實建築，令下層推斷可以攞到精確座標。
# ---------------------------------------------------------------------------
ANCHORS: list[dict[str, Any]] = [
    {
        "id": "anchor_vtc_tko",
        "names": ["大本營", "香港知專設計學院", "HKDI", "李惠利", "李惠利大樓"],
        "prototype": "香港知專設計學院／香港專業教育學院（李惠利）調景嶺校園",
        "source": "external_verified",
        "source_note": (
            "文中 loc_0003 明寫「大本營位於…香港知專設計學院內」；"
            "IVE(李惠利) 官方地址為「新界將軍澳景嶺路3號」，與 HKDI 同屬"
            "同一個 VTC 校園。"
        ),
        "osm_bbox": [114.2510, 114.2555, 22.3040, 22.3075],
        "campus_blocks": {
            "A": (114.25311, 22.30590),
            "B": (114.25355, 22.30613),
            "C": (114.25375, 22.30573),
            "D": (114.25332, 22.30547),
        },
    },
]

# ---------------------------------------------------------------------------
# 規則表（可稽核）
# ---------------------------------------------------------------------------
RULES: dict[str, str] = {
    "R-EXPLICIT": "描述明文指出真實地點（例如「位於…香港知專設計學院內」）",
    "R-CAMPUS-BLOCK": "模糊大樓名（A/B/C/D 座）＋同章出現校園錨點 → 對應校園座數",
    "R-CONTAIN": "名稱包含另一個**非模糊**地點名（例如「X 下小型垃圾站」→ X）",
    "R-ANCHOR-MEMBER": "描述指明係錨點嘅一部分（「大本營其中一幢大樓」）",
    "R-VARIANT-INHERIT": "同一實體嘅異體寫法繼承已推斷結果（跨 entity_kind 通用）",
    "R-DISTRICT": "只可以確定到區域層級（同章出現區域名）",
    "R-NO-EVIDENCE": "證據不足，只列作待補",
}

# ---------------------------------------------------------------------------
# 太過籠統嘅名稱：唔可以當「區域證據」用。
#
# 實測陷阱：原本嘅 R-DISTRICT 會令「荒廢商場 → 香港」、「鄰近的便利店 →
# 香港」。因為「香港」喺幾乎每一章都出現，同任何模糊地點都「共現」。
# 呢類假陽性比冇推斷更差 —— 佢會令審閱者對整個機制失去信心。
# ---------------------------------------------------------------------------
TOO_GENERIC_FOR_DISTRICT = {
    "香港", "九龍", "新界", "大嶼山", "離島", "西貢半島",
    "香港島", "將軍澳", "市區", "郊區",
}

# 真正嘅「地區名」白名單（由 hk-districts.json 篩出）。
#
# 為何唔可以直接用成個 dict
# ------------------------
# `hk-districts.json` 混雜咗地區名（寶琳、坑口）同**具體場館**
# （將軍澳運動場、寶康路、學堂）。用場館做「區域證據」會出假陽性：
# 實測「寶康路 → 將軍澳運動場」、「死亡之路 → 將軍澳運動場」、
# 「紫線區 → 將軍澳運動場」—— 全部都係同章偶然共現，唔係真推斷。
AREA_NAMES = {
    "將軍澳", "寶琳", "坑口", "調景嶺", "將軍澳市中心", "尚德", "彩明",
    "日出康城", "康城", "百勝角", "佛堂澳", "小赤沙", "大赤沙",
    "西貢", "觀塘", "九龍灣", "牛頭角", "藍田", "油塘", "順利",
    "北角", "鰂魚涌", "中環", "銅鑼灣", "香港仔", "赤柱",
}


def _is_area_name(name: str) -> bool:
    """係唔係真正嘅地區名（唔係場館／道路）。"""
    if name in TOO_GENERIC_FOR_DISTRICT or len(name) < 2:
        return False
    if _is_road_like(name):
        return False
    return name in AREA_NAMES


def _is_road_like(name: str) -> bool:
    """道路名唔可以當「區域」用（「寶琳北路」係路，唔係區）。"""
    return bool(re.search(r"(路|道|街|巷|里|徑|公路|大橋|隧道|幹線)$", name))


# ---------------------------------------------------------------------------
# 載入
# ---------------------------------------------------------------------------
def load_osm_places() -> dict[str, dict[str, Any]]:
    """由 OSM cache 抽有名字嘅設施 → {name: {lon, lat, kind, osm_id}}。"""
    if not OSM_CACHE.exists():
        return {}
    els = json.loads(OSM_CACHE.read_text(encoding="utf-8")).get("elements", [])
    out: dict[str, dict[str, Any]] = {}
    for e in els:
        t = e.get("tags") or {}
        nm = t.get("name") or t.get("name:zh")
        if not nm:
            continue
        geom = e.get("geometry") or []
        if not geom:
            continue
        lons = [p["lon"] for p in geom]
        lats = [p["lat"] for p in geom]
        kind = (
            t.get("amenity") or t.get("building") or t.get("landuse")
            or t.get("leisure") or t.get("shop") or t.get("highway") or ""
        )
        prev = out.get(nm)
        # 同名多個 → 保留點數最多（通常係最完整嘅輪廓）
        if prev is None or len(geom) > prev["pts"]:
            out[nm] = {
                "lon": round(sum(lons) / len(lons), 6),
                "lat": round(sum(lats) / len(lats), 6),
                "kind": kind,
                "osm_id": e.get("id"),
                "osm_type": e.get("type"),
                "pts": len(geom),
            }
    return out


def load_locations() -> list[dict[str, Any]]:
    d = json.loads(LOCATIONS.read_text(encoding="utf-8"))
    return d["features"]


def load_districts() -> dict[str, list[float]]:
    if not HK_DISTRICTS.exists():
        return {}
    return json.loads(HK_DISTRICTS.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 模糊地點偵測
# ---------------------------------------------------------------------------
def generic_suffix(name: str) -> str | None:
    """回傳令 `name` 變成模糊嘅通用詞；唔模糊就 None。"""
    for g in GENERIC_WORDS:
        if name.endswith(g):
            stem = name[: -len(g)]
            if len(stem) <= 3:
                return g
    return None


def is_vague(props: dict[str, Any]) -> bool:
    return generic_suffix(props["name"]) is not None


def is_candidate(props: dict[str, Any]) -> bool:
    """推斷候選：名稱模糊，**或者**精度仍然係 fictional。

    為何要包埋全部 fictional
    ------------------------
    只捉「短詞幹 + 通用詞」會漏掉一類同樣重要嘅個案：名稱夠長但其實
    係**組合式描述**，例如「李惠利大樓下小型垃圾站」—— 詞幹有 8 個字，
    唔算「模糊」，但佢係依附喺另一個地點之上，一樣可以推斷。
    fictional 精度（543 個）本身就係「座標任意指派」嘅標記。
    """
    return is_vague(props) or props.get("location_precision") == "fictional"


# ---------------------------------------------------------------------------
# 證據收集
# ---------------------------------------------------------------------------
def build_chapter_index(feats: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    idx: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for f in feats:
        p = f["properties"]
        for ch in p["chapters"]:
            idx[ch].append(p)
    return idx


def collect_evidence(
    props: dict[str, Any],
    by_chapter: dict[int, list[dict[str, Any]]],
    osm: dict[str, dict[str, Any]],
    districts: dict[str, list[float]],
) -> dict[str, Any]:
    """收集一個模糊地點嘅所有可用證據。"""
    name = props["name"]
    desc = props["description"] or ""
    ev: list[dict[str, Any]] = []

    # E1：自身描述
    ev.append(
        {
            "kind": "description_claim",
            "chapter": props["chapters"][0] if props["chapters"] else None,
            "detail": desc[:300],
            "refs": [],
        }
    )

    # E2：同章出現嘅「非模糊」地點（可以係真實地點，亦可以係另一個已命名實體）
    co: dict[str, list[str]] = {}
    for ch in props["chapters"]:
        for other in by_chapter.get(ch, []):
            if other["id"] == props["id"]:
                continue
            if other["name"] == name:
                continue
            if is_vague(other):
                continue
            co.setdefault(other["name"], []).append(other["id"])
    # 只保留出現 ≥1 次、而且名夠具體嘅
    strong = {k: v for k, v in co.items() if len(k) >= 2}
    if strong:
        ev.append(
            {
                "kind": "chapter_cooccurrence",
                "chapter": props["chapters"][0] if props["chapters"] else None,
                "detail": "同章出現：" + "、".join(sorted(strong)[:12]),
                "refs": sorted({i for ids in strong.values() for i in ids})[:20],
            }
        )

    return {"evidence": ev, "cooccur": strong}


# ---------------------------------------------------------------------------
# 推斷規則
# ---------------------------------------------------------------------------
def _has_distinctive_stem(name: str, min_len: int = 2) -> bool:
    """名稱有冇「識別性詞幹」。

    陷阱：R-CONTAIN 最初會令「荒廢商場 → 依附於『商場』」、「B橦二樓 →
    依附於『二樓』」—— 因為「商場」「二樓」本身都係資料集入面嘅地點名。
    但佢哋係**通用詞**，唔係真正嘅父項，配對到等於零資訊。

    判準：扣掉通用後綴之後，剩低嘅詞幹要有 ≥ `min_len` 個字。
      「商場」      → 詞幹「」      長度 0 → 否
      「二樓」      → 詞幹「二」    長度 1 → 否
      「李惠利大樓」 → 詞幹「李惠利」 長度 3 → 是
      「將軍澳廣場」 → 詞幹「將軍澳」 長度 3 → 是
    """
    suf = generic_suffix(name)
    stem = name[: -len(suf)] if suf else name
    return len(stem) >= min_len


def infer(
    props: dict[str, Any],
    ev: dict[str, Any],
    osm: dict[str, dict[str, Any]],
    districts: dict[str, list[float]],
    all_names: list[str],
    by_id: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """套用規則；回傳推斷結果或 None。

    規則由「最強證據」排到「最弱」：
      R-EXPLICIT > R-CAMPUS-BLOCK > R-CONTAIN > R-ANCHOR-MEMBER > R-DISTRICT
    先命中先回傳 —— 呢個次序就係「置信度優先」嘅實作。
    """
    name = props["name"]
    desc = props["description"] or ""
    cooccur: dict[str, list[str]] = ev["cooccur"]
    evidence: list[dict[str, Any]] = list(ev["evidence"])

    # ---- R-EXPLICIT：描述明文指出真實地點 ----
    for anchor in ANCHORS:
        for nm in anchor["names"]:
            if "位於" in desc and nm in desc:
                # 注意：呢條規則只證明「喺錨點範圍內」，證明唔到喺邊一幢
                # 建築，所以唔應該出座標，信心亦唔可以太高（0.95 會令
                # 審閱者以為已經精確定位）。
                return _mk(
                    props, "R-EXPLICIT",
                    f"{anchor['prototype']} 範圍內（具體位置待考）",
                    None, None, evidence + [{
                        "kind": "explicit_statement",
                        "chapter": props["chapters"][0] if props["chapters"] else None,
                        "detail": f"描述明文：「{desc[:150]}」",
                        "refs": [],
                    }],
                    0.75,
                    {"location_precision": "district", "merge_into": None},
                )

    # ---- R-CAMPUS-BLOCK：A/B/C/D 座 ----
    m = re.fullmatch(r"([A-Da-d])\s*[座部幢橦]?\s*大樓", name)
    if m:
        letter = m.group(1).upper()
        for anchor in ANCHORS:
            if not anchor.get("campus_blocks"):
                continue
            hits = [n for n in cooccur if any(a in n for a in anchor["names"])]
            mentions_base = "大本營" in desc
            if hits or mentions_base:
                lon, lat = anchor["campus_blocks"][letter]
                ev2 = list(evidence)
                if hits:
                    ev2.append({
                        "kind": "osm_place_match",
                        "chapter": props["chapters"][0] if props["chapters"] else None,
                        "detail": (
                            f"同章出現「{'、'.join(hits[:3])}」；"
                            f"OSM 於該校園有 {letter}座（Block {letter}）"
                        ),
                        "refs": sorted({i for n in hits for i in cooccur[n]})[:10],
                    })
                else:
                    ev2.append({
                        "kind": "description_claim",
                        "chapter": props["chapters"][0] if props["chapters"] else None,
                        "detail": f"描述提及「大本營」，而大本營已定位為 {anchor['prototype']}",
                        "refs": [],
                    })
                return _mk(
                    props, "R-CAMPUS-BLOCK",
                    f"{anchor['prototype']} {letter}座（Block {letter}）",
                    [lon, lat], "osm_way", ev2, 0.88,
                    {"location_precision": "exact", "merge_into": None,
                     "set_lonlat": [lon, lat]},
                )

    # ---- R-CONTAIN：名稱包含另一個非模糊地點 ----
    #
    # 注意：要掃**全部**地點名，唔可以只掃同章共現嘅 ——
    # 「李惠利大樓下小型垃圾站」同「李惠利大樓」可能唔同章。
    best: tuple[int, str] | None = None
    for other in all_names:
        if other == name or len(other) < 2:
            continue
        if not _has_distinctive_stem(other):
            continue  # 「商場」「二樓」呢類通用詞唔算父項
        if other in name:
            if best is None or len(other) > best[0]:
                best = (len(other), other)
    if best is not None:
        parent = best[1]
        parent_vague = generic_suffix(parent) is not None
        o = osm.get(parent)
        if o and not parent_vague and len(parent) >= 3:
            return _mk(
                props, "R-CONTAIN", parent, [o["lon"], o["lat"]],
                "osm_way", evidence + [{
                    "kind": "name_containment",
                    "chapter": None,
                    "detail": f"名稱「{name}」包含具體地點名「{parent}」（OSM 有記錄）",
                    "refs": [],
                }],
                0.80,
                {"location_precision": "approximate", "merge_into": None,
                 "set_lonlat": [o["lon"], o["lat"]]},
            )
        if parent_vague:
            return _mk(
                props, "R-CONTAIN", f"依附於「{parent}」（本身亦為模糊地點）",
                None, None, evidence + [{
                    "kind": "name_containment",
                    "chapter": None,
                    "detail": (
                        f"名稱「{name}」包含有識別性嘅「{parent}」，但後者亦係模糊地點"
                        " —— 必須先解決父項才可以定位子項"
                    ),
                    "refs": [],
                }],
                0.45,
                {"location_precision": None, "merge_into": None},
            )

    # ---- R-ANCHOR-MEMBER：描述或名稱指明係錨點一部分 ----
    for anchor in ANCHORS:
        named_after_anchor = any(a in name for a in anchor["names"] if len(a) >= 2)
        described_as_member = (
            "大本營其中一幢大樓" in desc
            or "大本營四橦大樓之一" in desc
            or "大本營內" in desc
        )
        if named_after_anchor or described_as_member:
            hits = [n for n in cooccur if any(a in n for a in anchor["names"])]
            if hits or "大本營" in desc or named_after_anchor:
                blocks = anchor.get("campus_blocks") or {}
                if blocks:
                    xs = [p[0] for p in blocks.values()]
                    ys = [p[1] for p in blocks.values()]
                    pt = [round(sum(xs) / len(xs), 5), round(sum(ys) / len(ys), 5)]
                    src = "parent_containment"
                else:
                    pt = list(districts.get("調景嶺") or [114.2506, 22.3077])
                    src = "hk-districts.json"
                return _mk(
                    props, "R-ANCHOR-MEMBER",
                    f"{anchor['prototype']}（校園範圍內，具體座數待考）",
                    pt, src, evidence + [{
                        "kind": "description_claim",
                        "chapter": props["chapters"][0] if props["chapters"] else None,
                        "detail": (
                            "描述指明係大本營其中一幢大樓；大本營已定位為 VTC 調景嶺校園。"
                            "座標取校園 A/B/C/D 座嘅質心（非任何單一建築）"
                        ),
                        "refs": [],
                    }],
                    0.72,
                    {"location_precision": "approximate", "merge_into": None,
                     "set_lonlat": pt},
                )

    # ---- R-DISTRICT：只可以確定區域 ----
    #
    # 收緊條件（防止「荒廢商場 → 香港」呢類假陽性）：
    #   1. 排除過於籠統嘅名稱（香港／九龍／新界…）—— 佢哋幾乎每章都出現，
    #      同任何模糊地點都「共現」，等於零資訊。
    #   2. 排除道路名（「寶琳北路」係路，唔係區）。
    #   3. **該區域名嘅記錄章節必須覆蓋目標嘅全部章節**。單章偶然共現唔算
    #      證據 —— 實測原本嘅寬鬆版本會令「隔離病房 → 寶琳」呢類假陽性出現。
    chapters = set(props["chapters"] or [])
    if chapters:
        for dname, pt in districts.items():
            if not _is_area_name(dname):
                continue
            ids = cooccur.get(dname)
            if not ids:
                continue
            covered: set[int] = set()
            for rid in ids:
                f = by_id.get(rid)
                if f is not None:
                    covered |= set(f["properties"]["chapters"])
            if not chapters.issubset(covered):
                continue
            return _mk(
                props, "R-DISTRICT", dname, list(pt), "hk-districts.json",
                evidence + [{
                    "kind": "chapter_cooccurrence",
                    "chapter": sorted(chapters)[0],
                    "detail": (
                        f"「{dname}」喺目標全部 {len(chapters)} 個相關章節都出現"
                        f"（章節 {sorted(chapters)[:6]}）"
                    ),
                    "refs": ids[:5],
                }],
                0.55,
                {"location_precision": "district", "merge_into": None,
                 "set_lonlat": list(pt)},
            )

    return None


def _mk(
    props: dict[str, Any],
    pattern: str,
    prototype: str | None,
    lonlat: list[float] | None,
    coord_source: str | None,
    evidence: list[dict[str, Any]],
    confidence: float,
    proposed: dict[str, Any],
) -> dict[str, Any]:
    return {
        "entity_kind": "location",
        "subject_ids": [props["id"]],
        "subject_names": [props["name"]],
        "pattern": pattern,
        "inferred_prototype": prototype,
        "inferred_lonlat": lonlat,
        "coordinate_source": coord_source,
        "evidence": evidence,
        "confidence": round(confidence, 2),
        "proposed_changes": proposed,
        "review_status": "pending",
        "review_notes": None,
    }


# ---------------------------------------------------------------------------
# 變體合併（通用：任何 entity_kind 都用得着）
# ---------------------------------------------------------------------------
def find_variants(
    feats: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """搵同一實體嘅異體寫法。

    做法：正規化名稱（統一 座／幢／橦／部，去括號），然後分組。
    呢個 pass 唔限於地點 —— 同一套邏輯可以直接套用到角色名。
    """
    def norm(s: str) -> str:
        s = re.sub(r"[（(].*?[)）]", "", s)
        # 「座／幢／橦／部」係同一件事嘅唔同寫法（實測：D座大樓／D橦大樓／
        # D部大樓／D大樓 係同一個實體）。唔統一嘅話異體傳播會斷開。
        for ch in ("橦", "部", "座"):
            s = s.replace(ch, "幢")
        return s.strip()

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in feats:
        p = f["properties"]
        groups[norm(p["name"])].append(p)

    out: list[dict[str, Any]] = []
    for key, members in groups.items():
        names = {m["name"] for m in members}
        if len(names) < 2:
            continue
        out.append(
            {
                "key": key,
                "names": sorted(names),
                "ids": [m["id"] for m in members],
                "chapters": sorted({c for m in members for c in m["chapters"]}),
            }
        )
    out.sort(key=lambda g: (-len(g["names"]), g["key"]))
    return out


def propagate_variants(
    results: list[dict[str, Any]],
    variants: list[dict[str, Any]],
    by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """把已推斷嘅結果沿「異體群組」傳播。

    為何需要
    --------
    「D座大樓」（loc_0075）描述明寫「大本營內的D座大樓」，證據充足，
    會被 R-CAMPUS-BLOCK 命中 → 校園 D 座。

    但異體「D橦大樓」（loc_0092）嘅描述係「M養傷的隔離病房位於內部複雜
    的D橦大樓」，冇提大本營，所以規則唔命中，結果跌落到較弱嘅區域推斷
    （→ 寶琳）。兩者其實係**同一個實體** —— 既然已知「D座大樓 = 校園
    D 座」，咁「D橦大樓」亦必然係。

    呢個就係「概念要應用喺所有其它地方」嘅具體落腳點：傳播邏輯只依賴
    `subject_ids` 同異體群組，完全唔理 `entity_kind` —— 同一套代碼可以
    直接套用到角色名、事件名嘅異體。
    """
    by_id_inf: dict[str, dict[str, Any]] = {}
    for r in results:
        for sid in r["subject_ids"]:
            prev = by_id_inf.get(sid)
            if prev is None or r["confidence"] > prev["confidence"]:
                by_id_inf[sid] = r

    out: list[dict[str, Any]] = []
    for group in variants:
        strong = [
            by_id_inf[i]
            for i in group["ids"]
            if i in by_id_inf and by_id_inf[i]["confidence"] >= 0.70
            and by_id_inf[i]["inferred_lonlat"]
        ]
        if not strong:
            continue
        src = max(strong, key=lambda r: r["confidence"])
        src_id = src["subject_ids"][0]
        for sid in group["ids"]:
            cur = by_id_inf.get(sid)
            if cur is not None and cur["confidence"] >= src["confidence"]:
                continue
            props = by_id[sid]["properties"]
            out.append(
                _mk(
                    props, "R-VARIANT-INHERIT",
                    src["inferred_prototype"],
                    list(src["inferred_lonlat"]),
                    src["coordinate_source"],
                    [
                        {
                            "kind": "name_variant",
                            "chapter": None,
                            "detail": (
                                f"「{props['name']}」同「{src['subject_names'][0]}」"
                                f"屬同一異體群組（群組：{'／'.join(group['names'])}）"
                            ),
                            "refs": [src_id],
                        },
                        {
                            "kind": "description_claim",
                            "chapter": None,
                            "detail": (
                                f"繼承自「{src['subject_names'][0]}」嘅推斷"
                                f"（規則 {src['pattern']}，信心 {src['confidence']}）："
                                f"{src['inferred_prototype']}"
                            ),
                            "refs": [src_id],
                        },
                    ],
                    round(src["confidence"] * 0.95, 2),
                    dict(src["proposed_changes"]),
                )
            )
    return out


def validate_against_schema(records: list[dict[str, Any]]) -> list[str]:
    """用 `place-inference.schema.json` 驗證；回傳問題清單（空 = 通過）。

    有 jsonschema 就用正式驗證器；冇就退回手寫檢查（覆蓋 required /
    enum / 範圍）。點都要驗 —— 唔合規格嘅候選會令下游 builder 爆。
    """
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    try:
        import jsonschema  # type: ignore

        v = jsonschema.Draft202012Validator(schema)
        out: list[str] = []
        for r in records:
            for err in v.iter_errors(r):
                out.append(f"{r.get('inference_id')}: {err.message}")
        return out
    except ImportError:
        pass

    out = []
    required = schema["required"]
    props = schema["properties"]
    for r in records:
        rid = r.get("inference_id", "?")
        for k in required:
            if k not in r:
                out.append(f"{rid}: 缺少必要欄位 {k}")
        if r.get("entity_kind") not in props["entity_kind"]["enum"]:
            out.append(f"{rid}: entity_kind 唔合法")
        if r.get("review_status") not in props["review_status"]["enum"]:
            out.append(f"{rid}: review_status 唔合法")
        c = r.get("confidence")
        if not isinstance(c, (int, float)) or not (0 <= c <= 1):
            out.append(f"{rid}: confidence 超出 0–1")
        if not r.get("evidence"):
            out.append(f"{rid}: evidence 唔可以為空")
        ll = r.get("inferred_lonlat")
        if ll is not None:
            if not (isinstance(ll, list) and len(ll) == 2):
                out.append(f"{rid}: inferred_lonlat 格式錯")
            else:
                lon, lat = ll
                if not (113.0 < lon < 115.0 and 22.0 < lat < 23.0):
                    out.append(f"{rid}: 座標 {ll} 唔喺香港範圍")
    return out


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="《病港》地點推斷")
    ap.add_argument("--stats", action="store_true", help="只印統計，唔寫檔")
    args = ap.parse_args()

    feats = load_locations()
    osm = load_osm_places()
    districts = load_districts()
    by_chapter = build_chapter_index(feats)
    by_id = {f["properties"]["id"]: f for f in feats}
    all_names = [f["properties"]["name"] for f in feats]

    vague = [f["properties"] for f in feats if is_candidate(f["properties"])]
    n_vague_name = sum(1 for f in feats if is_vague(f["properties"]))
    n_fict = sum(
        1 for f in feats if f["properties"]["location_precision"] == "fictional"
    )
    print(f"locations 總數：{len(feats):,}")
    print(f"推斷候選：{len(vague)}（名稱模糊 {n_vague_name} ＋ fictional 精度 {n_fict}，去重後）")
    print(f"OSM 有名字設施：{len(osm):,}")
    print(f"區域座標表：{len(districts)} 個")

    results: list[dict[str, Any]] = []
    for props in vague:
        ev = collect_evidence(props, by_chapter, osm, districts)
        r = infer(props, ev, osm, districts, all_names, by_id)
        if r is not None:
            results.append(r)

    # 異體傳播（跨 entity_kind 通用）
    variants = find_variants(feats)
    inherited = propagate_variants(results, variants, by_id)
    # 繼承結果取代同一個 id 嘅弱推斷（否則「D橦大樓」會同時有
    # R-DISTRICT 0.55 同 R-VARIANT-INHERIT 0.84 兩條矛盾記錄）
    superseded = {i for r in inherited for i in r["subject_ids"]}
    results = [
        r for r in results
        if not (set(r["subject_ids"]) & superseded and r["confidence"] < 0.70)
    ]
    results.extend(inherited)

    # 補上 R-NO-EVIDENCE（證據不足但值得列出）
    covered = {i for r in results for i in r["subject_ids"]}
    for props in vague:
        if props["id"] in covered:
            continue
        ev = collect_evidence(props, by_chapter, osm, districts)
        results.append(
            _mk(
                props, "R-NO-EVIDENCE", None, None, None, ev["evidence"], 0.0,
                {"location_precision": None, "merge_into": None},
            )
        )

    for i, r in enumerate(results, 1):
        r["inference_id"] = f"inf_{i:04d}"

    print("\n=== 推斷結果（按規則）===")
    for rule, n in Counter(r["pattern"] for r in results).most_common():
        print(f"  {rule:18s} {n:3d}  {RULES.get(rule, '')}")
    print(f"\n=== 異體寫法群組（任何實體類型通用）===")
    for g in variants[:8]:
        print(f"  {'／'.join(g['names'])}  (ch {g['chapters'][:5]})")
    print(f"  合計 {len(variants)} 組")

    if args.stats:
        return 0

    # 寫 JSONL
    OUT_JSONL.parent.mkdir(parents=True, exist_ok=True)
    with OUT_JSONL.open("w", encoding="utf-8") as fh:
        for r in results:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"\n寫入 {OUT_JSONL}（{len(results)} 條）")

    # schema 驗證（唔可以出咗唔合規格嘅候選，否則 builder 會爆）
    problems = validate_against_schema(results)
    if problems:
        print("\n⚠️ schema 驗證問題：", file=sys.stderr)
        for p in problems[:10]:
            print(f"  {p}", file=sys.stderr)
    else:
        print(f"✅ schema 驗證通過（{len(results)} 條）")

    # 寫審閱包
    lines: list[str] = []
    lines.append("# 地點推斷審閱包\n")
    lines.append(
        "> **私有文件。** 推斷結果**未經人手確認**，"
        "`review_status` 全部係 `pending`。\n"
        "> 只有 `approved` 嘅項目才可以由 builder 套用到公開資料。\n"
    )
    lines.append(f"- 推斷候選：{len(vague)}\n")
    lines.append(f"- 有推斷：{sum(1 for r in results if r['pattern'] != 'R-NO-EVIDENCE')}\n")
    lines.append(f"- 證據不足：{sum(1 for r in results if r['pattern'] == 'R-NO-EVIDENCE')}\n")
    lines.append("\n## 規則表\n")
    for k, v in RULES.items():
        lines.append(f"- `{k}`：{v}\n")

    for r in results:
        if r["pattern"] == "R-NO-EVIDENCE":
            continue
        lines.append(f"\n---\n\n### {r['inference_id']}　{r['subject_names'][0]}\n")
        lines.append(f"- 規則：`{r['pattern']}`\n")
        lines.append(f"- 推斷原型：**{r['inferred_prototype']}**\n")
        if r["inferred_lonlat"]:
            lines.append(
                f"- 座標：`{r['inferred_lonlat'][0]:.5f}, {r['inferred_lonlat'][1]:.5f}`"
                f"（來源：{r['coordinate_source']}）\n"
            )
        lines.append(f"- 信心：{r['confidence']}\n")
        lines.append(f"- 建議：`{json.dumps(r['proposed_changes'], ensure_ascii=False)}`\n")
        lines.append("- 證據鏈：\n")
        for e in r["evidence"]:
            lines.append(f"  - `{e['kind']}`：{e['detail'][:200]}\n")
        lines.append("- 審閱：`[ ] approved` / `[ ] rejected` / `[ ] needs_info`\n")

    lines.append("\n---\n\n## 異體寫法群組（建議合併）\n")
    for g in variants:
        lines.append(f"- {'／'.join(g['names'])}　→ ids: {', '.join(g['ids'][:6])}\n")

    OUT_MD.write_text("".join(lines), encoding="utf-8")
    print(f"寫入 {OUT_MD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

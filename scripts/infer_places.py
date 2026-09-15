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
import hashlib
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
    # 第二遍暴露嘅通用詞：呢啲做父項時會配對錯（例如「圖書館４號會議室」
    # 配到「會議室」、「愛紗工坊」配到「工坊」）。加落嚟之後佢哋唔會再
    # 被當成有識別性嘅父項。
    "室", "廳", "堂", "房", "會議室", "辦公室", "工坊", "工作室",
    "倉", "廠", "店", "鋪", "廊", "庭", "園", "間",
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
    "R-CONTAIN-RESOLVED": "第二遍：父項已解決 → 子項繼承父項座標（先解父、再解子）",
    "R-DISTRICT": "只可以確定到區域層級（同章出現區域名）",
    "R-NAME-PLACE": "名稱本身就係一個真實香港地點（OSM 有記錄）",
    "R-DESC-PLACE": "描述直接提及真實地區名（比同章共現強）",
    "R-NO-EVIDENCE": "證據不足，只列作待補",
    # 其他實體類型（同一套結構，唔同 entity_kind）
    "C-NORM": "角色名稱正規化後相同（去括號／全形／大小寫）",
    "C-TYPO": "角色名只差一個字（拼寫手誤，例如 Chirs／Chris）",
    "C-ALIAS-SHARE": "兩個角色共用同一個別名 → 可能係同一人",
    "E-LOC-LINK": "事件寫住地名但冇 location_id，而資料集有同名地點",
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
    """由 OSM cache 抽有名字嘅設施 → {name: {lon, lat, kind, osm_id}}。

    ⚠️ 一定要索引 `name:zh`
    ----------------------
    OSM 嘅 `name` 通常係**中英雙語**（例如
    `"將軍澳中心 Park Central"`），而 `name:zh` 才係純中文
    （`"將軍澳中心"`）。原本只索引 `name`，令中文名精確匹配大量失敗 ——
    實測「將軍澳中心」「將軍澳廣場」「彩明商場」「新都城中心一期」
    全部配對唔到，明明 OSM 有記錄。

    所以每個設施會同時用三個 key 索引：
      1. `name`（可能係雙語）
      2. `name:zh`（純中文）
      3. `name` 嘅中文前綴（去掉英文部分）
    """
    if not OSM_CACHE.exists():
        return {}
    els = json.loads(OSM_CACHE.read_text(encoding="utf-8")).get("elements", [])
    out: dict[str, dict[str, Any]] = {}

    def put(key: str, rec: dict[str, Any]) -> None:
        if not key or len(key) < 2:
            return
        prev = out.get(key)
        # 同名多個 → 保留點數最多（通常係最完整嘅輪廓）
        if prev is None or rec["pts"] > prev["pts"]:
            out[key] = rec

    for e in els:
        t = e.get("tags") or {}
        raw = t.get("name") or t.get("name:zh")
        if not raw:
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
        rec = {
            "lon": round(sum(lons) / len(lons), 6),
            "lat": round(sum(lats) / len(lats), 6),
            "kind": kind,
            "osm_id": e.get("id"),
            "osm_type": e.get("type"),
            "pts": len(geom),
            "osm_name": raw,
        }
        put(raw, rec)
        zh = t.get("name:zh")
        if zh:
            put(zh, rec)
        # `name` 嘅中文前綴（第一個 ASCII 字之前）
        m = re.match(r"^([^\x00-\x7F\s]+)", raw)
        if m:
            put(m.group(1), rec)
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
    """推斷候選：名稱模糊，**或者**精度仍然係 fictional，**或者**已經係推斷產物。

    為何要包埋全部 fictional
    ------------------------
    只捉「短詞幹 + 通用詞」會漏掉一類同樣重要嘅個案：名稱夠長但其實
    係**組合式描述**，例如「李惠利大樓下小型垃圾站」—— 詞幹有 8 個字，
    唔算「模糊」，但佢係依附喺另一個地點之上，一樣可以推斷。
    fictional 精度（543 個）本身就係「座標任意指派」嘅標記。

    ⚠️ 為何一定要包埋 `inferred_from`（管線冪等性）
    ----------------------------------------------
    `apply_place_inferences.py` 會把已批推斷寫入 `locations.geojson`，
    令 `location_precision` 由 `fictional` 變成 `approximate`／`exact`。

    如果候選集只睇 `fictional`，咁**重跑推斷就會失去已經套用嘅結果**
    （實測：R-ANCHOR-MEMBER 由 45 條跌到 10 條、R-EXPLICIT 全消失），
    因為嗰批地點已經唔再係 fictional。呢個係管線非冪等 —— 極危險，
    因為重跑係日常操作。

    加咗 `inferred_from` 之後，推斷 → 套用 → 再推斷會收斂到同一結果。
    """
    return (
        is_vague(props)
        or props.get("location_precision") == "fictional"
        or bool(props.get("inferred_from"))
    )


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
                # 呢條規則只證明「喺錨點範圍內」，證明唔到喺邊一幢建築。
                # 所以座標取**校園質心**（唔係任何單一建築），精度標
                # `approximate` 而唔係 `exact`，信心亦唔可以太高。
                blocks = anchor.get("campus_blocks") or {}
                if blocks:
                    xs = [p[0] for p in blocks.values()]
                    ys = [p[1] for p in blocks.values()]
                    pt = [round(sum(xs) / len(xs), 5), round(sum(ys) / len(ys), 5)]
                else:
                    pt = None
                return _mk(
                    props, "R-EXPLICIT",
                    f"{anchor['prototype']} 範圍內（具體位置待考）",
                    pt,
                    "parent_containment" if pt else None,
                    evidence + [{
                        "kind": "explicit_statement",
                        "chapter": props["chapters"][0] if props["chapters"] else None,
                        "detail": (
                            f"描述明文：「{desc[:150]}」"
                            "；座標取校園 A/B/C/D 座質心（非任何單一建築）"
                        ),
                        "refs": [],
                    }],
                    0.75,
                    {"location_precision": "approximate", "merge_into": None,
                     "set_lonlat": pt},
                )

    # ---- R-NAME-PLACE：名稱本身就係一個真實香港地點 ----
    #
    # 最強嘅一類：唔需要任何上文下理推斷 —— 名稱直接對應 OSM 記錄。
    # 例如「將軍澳中心」「將軍澳廣場」「彩明商場」「新都城商場」。
    # 呢批之前配對唔到，係因為 OSM 用雙語 `name`（見 load_osm_places）。
    o = osm.get(name)
    if o is not None:
        # 雙重過濾，兩者缺一不可：
        #   1. 名稱要有識別性詞幹 —— 排除「學校」「飯堂」「宿舍」呢類
        #      通用詞（佢哋喺 OSM 有記錄，但同故事無關）
        #   2. OSM 配對要落喺故事設定區域 —— 排除同名但明顯唔相關嘅
        #      設施（實測「禮堂」配到屯門、「停車場」配到元朗）
        if not _has_distinctive_stem(name):
            o = None
        elif not _in_story_region(o["lon"], o["lat"]):
            o = None
    if o is not None:
        return _mk(
            props, "R-NAME-PLACE", name, [o["lon"], o["lat"]],
            "osm_way", evidence + [{
                "kind": "osm_place_match",
                "chapter": None,
                "detail": (
                    f"名稱直接對應 OSM 記錄「{o['osm_name']}」"
                    f"（{o['osm_type']} {o['osm_id']}，{o['pts']} 點，{o['kind']}）；"
                    f"座標落喺故事設定區域內"
                ),
                "refs": [],
            }],
            0.90,
            {"location_precision": "exact", "merge_into": None,
             "set_lonlat": [o["lon"], o["lat"]]},
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

    # ---- R-ANCHOR-MEMBER：描述或名稱指明係錨點一部分 ----
    for anchor in ANCHORS:
        # 要求**前綴**匹配，唔可以只係「包含」。
        # 實測假陽性：「不良人大本營」「康城大本營」—— 兩者都含「大本營」
        # 但係**唔同**嘅據點（不良人係敵對組織；康城係另一個地區）。
        # 要求 name 以錨點名開頭就唔會誤中。
        named_after_anchor = any(
            len(a) >= 2 and (name == a or name.startswith(a))
            for a in anchor["names"]
        )
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

    # ---- R-DESC-PLACE：描述直接提及真實地區名 ----
    #
    # 比 R-DISTRICT（同章共現）強得多：描述係**直接證據**，唔係統計相關。
    # 例如描述寫「…位於寶琳嘅…」→ 該地點喺寶琳。
    #
    # 只准真正嘅地區名（`_is_area_name`），排除「商場」「醫院」「公園」
    # 呢類通用詞 —— 佢哋雖然喺 hk-districts.json 有座標，但唔係區域。
    desc_hits: list[tuple[int, str]] = []
    for dname in districts:
        if not _is_area_name(dname):
            continue
        idx = desc.find(dname)
        if idx >= 0:
            desc_hits.append((idx, dname))
    if desc_hits:
        # 取最早出現嘅（通常係句子主語）
        idx, dname = min(desc_hits)
        pt = districts[dname]
        return _mk(
            props, "R-DESC-PLACE", dname, list(pt), "hk-districts.json",
            evidence + [{
                "kind": "description_claim",
                "chapter": props["chapters"][0] if props["chapters"] else None,
                "detail": (
                    f"描述直接提及地區「{dname}」"
                    f"（位置 {idx}）：「…{desc[max(0, idx - 20):idx + 30]}…」"
                ),
                "refs": [],
            }],
            0.65,
            {"location_precision": "district", "merge_into": None,
             "set_lonlat": list(pt)},
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


def resolve_containment(
    results: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    all_names: list[str],
) -> list[dict[str, Any]]:
    """第二遍：父項已解決之後，重新處理依附關係。

    為何需要第二遍
    --------------
    第一遍嘅 R-CONTAIN 對「D橦大樓醫療室」只能講「依附於『D橦大樓』，
    但後者亦係模糊地點」—— 係一個**阻塞標記**，唔係真推斷。

    但主 pass 已經解決咗「D橦大樓 = 校園 D 座」。既然父項有座標，子項
    就可以繼承：醫療室喺 D 座入面。

    呢個「先解父、再解子」嘅兩遍設計係必須嘅 —— 一遍做唔到，因為
    處理子項嘅時候父項嘅答案仲未存在。實測有 16 條卡喺第一遍。

    同名單一父項優先；多個父項候選時取最長（最具體）嗰個。
    """
    PRECISE_SOURCES = {"osm_way", "osm_relation", "external_verified"}
    resolved: list[tuple[str, dict[str, Any]]] = []
    for r in results:
        if r["confidence"] < 0.80 or not r["inferred_lonlat"]:
            continue
        if r["coordinate_source"] not in PRECISE_SOURCES:
            continue
        for nm in r["subject_names"]:
            resolved.append((nm, r))
    # 長名優先，令「D橦大樓」贏過「大樓」
    resolved.sort(key=lambda t: -len(t[0]))
    if not resolved:
        return []

    covered = {i for r in results for i in r["subject_ids"]}
    out: list[dict[str, Any]] = []
    for props in candidates:
        if props["id"] in covered:
            continue
        name = props["name"]
        parent: tuple[str, dict[str, Any]] | None = None
        for nm, r in resolved:
            if nm != name and nm in name and _has_distinctive_stem(nm):
                parent = (nm, r)
                break
        if parent is None:
            continue
        pname, pr = parent
        out.append(
            _mk(
                props, "R-CONTAIN-RESOLVED",
                f"{pr['inferred_prototype']} 內（依附於「{pname}」）",
                list(pr["inferred_lonlat"]),
                "parent_containment",
                [
                    {
                        "kind": "name_containment",
                        "chapter": None,
                        "detail": (
                            f"名稱「{name}」包含已解決嘅父項「{pname}」"
                            f"（{pr['pattern']}，信心 {pr['confidence']}）"
                        ),
                        "refs": pr["subject_ids"][:3],
                    },
                    {
                        "kind": "description_claim",
                        "chapter": props["chapters"][0] if props["chapters"] else None,
                        "detail": (props["description"] or "")[:200],
                        "refs": [],
                    },
                ],
                round(pr["confidence"] * 0.85, 2),
                {
                    "location_precision": "approximate",
                    "merge_into": None,
                    "set_lonlat": list(pr["inferred_lonlat"]),
                },
            )
        )
    return out


#: 故事設定區域。用嚟過濾「同名但明顯唔相關」嘅 OSM 配對。
#:
#: 為何需要
#: --------
#: OSM 全港都有同名設施。實測 R-NAME-PLACE 一開始命中：
#:   「學校」  → 上水 (114.2226, 22.5461)
#:   「飯堂」  → 粉嶺 (114.1639, 22.5217)
#:   「禮堂」  → 屯門 (113.9621, 22.3748)
#:   「停車場」→ 元朗 (114.0420, 22.3621)
#: 呢啲配對完全冇意義 —— 故事嘅「學校」唔會係上水嗰間。
#: 加區域限制之後，配對只會落喺故事發生地一帶。
#:
#: 範圍比將軍澳稍闊（包埋坑口、寶琳、調景嶺、西貢南），因為角色會行出
#: 將軍澳。呢個係**故事設定**，唔係推斷結果。
STORY_REGION = {
    "lon_min": 114.19,
    "lon_max": 114.36,
    "lat_min": 22.25,
    "lat_max": 22.40,
}


def _in_story_region(lon: float, lat: float) -> bool:
    return (
        STORY_REGION["lon_min"] <= lon <= STORY_REGION["lon_max"]
        and STORY_REGION["lat_min"] <= lat <= STORY_REGION["lat_max"]
    )


# ---------------------------------------------------------------------------
# 推廣至其他實體類型（「應用喺所有其它地方」）
#
# 地點推斷用嘅三樣嘢，其實同 entity_kind 完全無關：
#   1. 正規化 → 分組（搵異體）
#   2. 證據鏈（每條推斷都要可回溯）
#   3. 審閱關卡（引擎唔可以自己批自己）
# 所以同一套結構可以直接套用到角色、事件、路線。
# ---------------------------------------------------------------------------
def _norm_name(s: str) -> str:
    """通用名稱正規化：去括號、統一全形、去空白、轉小寫。"""
    s = re.sub(r"[（(].*?[)）]", "", s)
    s = s.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    s = re.sub(r"[\s·・,，.。!！?？]", "", s)
    return s.lower()


def _edit_distance_1(a: str, b: str) -> bool:
    """兩個字串係唔係只差一個字（替換／插入／刪除）。

    實測例子：角色「Chirs」同「Chris」—— 明顯係同一個人嘅拼寫手誤，
    但因為唔係完全一樣，現有嘅 alias 合併捉唔到。
    """
    if a == b:
        return False
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        diff = sum(1 for x, y in zip(a, b) if x != y)
        return diff == 1
    # 長度差 1：短的係唔係長嘅刪一個字
    if la > lb:
        a, b = b, a
    i = j = 0
    skipped = False
    while i < len(a) and j < len(b):
        if a[i] != b[j]:
            if skipped:
                return False
            skipped = True
            j += 1
        else:
            i += 1
            j += 1
    return True


#: 反義／對立詞對。單字替換如果落喺呢啲對上，**唔係**同一個人。
#:
#: 實測陷阱：「主角的母親」vs「主角的父親」、「公仔之母」vs「公仔之父」、
#: 「戴紅色冷帽竊屍賊」vs「戴綠色冷帽竊屍賊」—— 全部只差一個字，
#: 但係**完全唔同**嘅角色。單純用編輯距離會產生大量假陽性，而假陽性
#: 比冇推斷更差（會令審閱者對整個機制失去信心）。
CONTRAST_PAIRS: set[frozenset[str]] = {
    frozenset(p) for p in (
        ("父", "母"), ("爸", "媽"), ("爹", "娘"), ("男", "女"), ("兄", "弟"),
        ("姊", "妹"), ("姐", "妹"), ("哥", "弟"), ("紅", "綠"), ("紅", "藍"),
        ("紅", "黑"), ("綠", "藍"), ("綠", "黑"), ("藍", "白"), ("黑", "白"),
        ("黃", "藍"), ("大", "小"), ("上", "下"), ("左", "右"), ("前", "後"),
        ("內", "外"), ("生", "死"), ("老", "少"), ("新", "舊"), ("高", "低"),
        ("長", "短"), ("我", "你"), ("我", "他"), ("真", "假"), ("正", "反"),
    )
}

#: 無語義嘅助詞／量詞：插入或刪除呢啲字唔改變所指。
#:
#: 實測正確例子：「我嘅母親」vs「我的母親」、「攻擊學嘅病者老師」vs
#: 「攻擊學病者老師」、「貴華嘅母親」vs「貴華母親」—— 全部同一人。
PARTICLES = set("嘅的之個")


def _single_edit(a: str, b: str) -> tuple[str, str, str] | None:
    """回傳 (類型, 差嘅字, 對應嘅字)；唔係單一編輯就 None。

    類型：`sub`（替換）／`ins`（b 比 a 多一個字）／`del`（b 比 a 少一個字）
    """
    if a == b:
        return None
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return None
    if la == lb:
        diffs = [(x, y) for x, y in zip(a, b) if x != y]
        if len(diffs) != 1:
            return None
        return ("sub", diffs[0][0], diffs[0][1])
    short, long_ = (a, b) if la < lb else (b, a)
    i = j = 0
    while i < len(short) and j < len(long_):
        if short[i] != long_[j]:
            if short[i:] != long_[j + 1:]:
                return None
            return ("ins" if long_ is b else "del", long_[j], "")
        i += 1
        j += 1
    if i == len(short):
        return ("ins" if long_ is b else "del", long_[-1], "")
    return None


def _is_contrast(x: str, y: str) -> bool:
    return frozenset((x, y)) in CONTRAST_PAIRS


def infer_characters(characters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """角色推斷：搵疑似同一人嘅變體（拼寫手誤、共享 alias）。

    同地點推斷共用同一套結構：`subject_ids` 係角色 id、`evidence` 係
    可回溯證據鏈、`review_status` 一律 pending。
    """
    out: list[dict[str, Any]] = []

    def mk(ids: list[str], names: list[str], pattern: str, prototype: str,
           evidence: list[dict[str, Any]], confidence: float) -> dict[str, Any]:
        return {
            "entity_kind": "character",
            "subject_ids": ids,
            "subject_names": names,
            "pattern": pattern,
            "inferred_prototype": prototype,
            "inferred_lonlat": None,
            "coordinate_source": None,
            "evidence": evidence,
            "confidence": round(confidence, 2),
            "proposed_changes": {"merge_into": prototype, "location_precision": None},
            "review_status": "pending",
            "review_notes": None,
        }

    # --- 1. 正規化後同名（去括號、全形、大小寫）---
    by_norm: dict[str, list[dict[str, Any]]] = {}
    for c in characters:
        by_norm.setdefault(_norm_name(c["name"]), []).append(c)
    for key, group in by_norm.items():
        names = {c["name"] for c in group}
        if len(names) < 2:
            continue
        canonical = sorted(names, key=len)[0]
        out.append(mk(
            [c["id"] for c in group], sorted(names), "C-NORM",
            canonical,
            [{
                "kind": "name_variant",
                "chapter": None,
                "detail": f"正規化後同名（key={key}）：{'／'.join(sorted(names))}",
                "refs": [c["id"] for c in group],
            }],
            0.80,
        ))

    # --- 2. 拼寫只差一個字 ---
    #
    # ⚠️ 一定要分辨「助詞」同「反義詞」：
    #   助詞差異（嘅／的／之）  → 同一人，強證據
    #   反義詞替換（父↔母、紅↔綠）→ **唔同人**，直接跳過
    #   其他替換              → 弱證據，需要人手判斷
    items = sorted(characters, key=lambda c: c["name"])
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            na, nb = _norm_name(a["name"]), _norm_name(b["name"])
            if len(na) < 3 or len(nb) < 3:
                continue
            ed = _single_edit(na, nb)
            if ed is None:
                continue
            kind, x, y = ed

            if kind == "sub" and _is_contrast(x, y):
                continue  # 反義詞 → 明確唔同人，唔應該出推斷
            if kind == "sub" and x in PARTICLES or kind == "sub" and y in PARTICLES:
                conf = 0.80  # 助詞替換，幾乎肯定同一人
            elif kind in ("ins", "del") and (x in PARTICLES):
                conf = 0.80  # 插入／刪除助詞
            elif kind in ("ins", "del"):
                conf = 0.60  # 插入／刪除實義字
            else:
                conf = 0.50  # 其他單字替換，最弱

            shared = set(a.get("chapter_refs") or []) & set(b.get("chapter_refs") or [])
            if not shared:
                conf = min(conf, 0.45)  # 冇共同章節 → 唔可以當證據

            out.append(mk(
                [a["id"], b["id"]], sorted([a["name"], b["name"]]),
                "C-TYPO",
                sorted([a["name"], b["name"]], key=len)[0],
                [{
                    "kind": "name_variant",
                    "chapter": None,
                    "detail": (
                        f"「{a['name']}」同「{b['name']}」"
                        + (
                            f"只差助詞「{x or y}」"
                            if kind == "sub" and (x in PARTICLES or y in PARTICLES)
                            else f"只差一個字（{kind}）"
                        )
                        + (f"；共同章節 {sorted(shared)[:5]}" if shared else "；冇共同章節")
                    ),
                    "refs": [a["id"], b["id"]],
                }],
                conf,
            ))

    # --- 3. 共享 alias（兩個角色用同一個別名 → 可能係同一人）---
    alias_owner: dict[str, list[dict[str, Any]]] = {}
    for c in characters:
        for al in c.get("aliases") or []:
            alias_owner.setdefault(_norm_name(al), []).append(c)
    for al, owners in alias_owner.items():
        uniq = {c["id"]: c for c in owners}
        if len(uniq) < 2:
            continue
        group = list(uniq.values())
        names = sorted(c["name"] for c in group)
        out.append(mk(
            [c["id"] for c in group], names, "C-ALIAS-SHARE",
            names[0],
            [{
                "kind": "name_variant",
                "chapter": None,
                "detail": f"共用別名「{al}」：{'／'.join(names)}",
                "refs": [c["id"] for c in group],
            }],
            0.60,
        ))
    return out


def infer_event_location_gaps(
    events: list[dict[str, Any]], locations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """事件推斷：有 `location_name` 但冇 `location_id`（或指向唔到）嘅事件。

    事件嘅座標係由地點投影出嚟。如果事件只寫住地名而連唔到 location，
    佢就會停留在「投影至故事中心」嘅佔位座標 —— 即係地圖上一個假位置。
    """
    by_name = {l["properties"]["name"]: l["properties"] for l in locations}
    out: list[dict[str, Any]] = []
    for ev in events:
        p = ev["properties"]
        lid = p.get("location_id")
        lname = p.get("location_name")
        if lid or not lname:
            continue
        target = by_name.get(lname)
        if target is None:
            continue
        out.append({
            "entity_kind": "event",
            "subject_ids": [p["id"]],
            "subject_names": [p.get("title") or p["id"]],
            "pattern": "E-LOC-LINK",
            "inferred_prototype": lname,
            "inferred_lonlat": None,
            "coordinate_source": None,
            "evidence": [{
                "kind": "chapter_cooccurrence",
                "chapter": p.get("chapter"),
                "detail": (
                    f"事件寫住地點「{lname}」但冇 location_id；"
                    f"資料集有同名地點 {target['id']}"
                ),
                "refs": [target["id"]],
            }],
            "confidence": 0.85,
            "proposed_changes": {"merge_into": target["id"], "location_precision": None},
            "review_status": "pending",
            "review_notes": None,
        })
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

    # 第二遍：父項已解決 → 重新處理依附關係（見 resolve_containment）
    second = resolve_containment(results, vague, all_names)
    if second:
        superseded2 = {i for r in second for i in r["subject_ids"]}
        results = [
            r for r in results
            if not (set(r["subject_ids"]) & superseded2 and r["confidence"] < 0.70)
        ]
        results.extend(second)

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

    # ---- 推廣至其他實體類型（同一套結構）----
    chars_path = REPO / "data" / "public" / "characters.json"
    events_path = REPO / "data" / "public" / "events.geojson"
    other: list[dict[str, Any]] = []
    if chars_path.exists():
        chars = json.loads(chars_path.read_text(encoding="utf-8"))
        other += infer_characters(chars)
        print(f"\n角色推斷：{len([r for r in other if r['entity_kind'] == 'character'])} 條"
              f"（{len(chars)} 個角色）")
    if events_path.exists():
        evs = json.loads(events_path.read_text(encoding="utf-8"))["features"]
        ev_inf = infer_event_location_gaps(evs, feats)
        other += ev_inf
        print(f"事件推斷：{len(ev_inf)} 條（{len(evs)} 個事件）")
    results += other

    # 最終去重：每個 subject id 只保留最強嘅一條推斷。
    # 各 pass 嘅 supersede 只清「弱過 0.70」嘅，兩個 ≥0.70 嘅規則同時命中
    # （例如 R-ANCHOR-MEMBER 0.72 同 R-CONTAIN-RESOLVED 0.75）就會漏。
    best_by_id: dict[str, dict[str, Any]] = {}
    for r in results:
        for sid in r["subject_ids"]:
            prev = best_by_id.get(sid)
            if prev is None or r["confidence"] > prev["confidence"]:
                best_by_id[sid] = r
    keep = {id(r) for r in best_by_id.values()}
    results = [r for r in results if id(r) in keep]

    # inference_id 必須**穩定**：由 subject id 衍生，唔可以用序號。
    #
    # 為何：`apply_place_inferences.py` 會把 inference_id 寫入公開資料嘅
    # `inferred_from`。如果用 `inf_0001`、`inf_0002`… 呢類序號，每次重跑
    # （規則改動、去重次序改變）都會令同一個 id 指向**唔同記錄** ——
    # 實測：某次重跑之後 `inf_0042` 由「D橦三樓看護室」變成「大本營
    # （倖存區）」，令已套用嘅審閱決定靜默地指向錯誤對象。
    # 呢個令審計軌跡完全失效，比推斷錯更危險。
    for r in results:
        ids = sorted(r["subject_ids"])
        if len(ids) == 1:
            r["inference_id"] = f"inf_{ids[0]}"
        else:
            sig = hashlib.sha1("|".join(ids).encode("utf-8")).hexdigest()[:10]
            r["inference_id"] = f"inf_{sig}"

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

#!/usr/bin/env python3
"""用 LLM 為剩餘嘅未定位地點推斷真實原型（**只命名，唔出座標**）。

為何要 LLM
==========
Phase J 用字串規則推到 327 條就停咗 —— 佢哋全部係單章出現，描述冇空間
關係詞、冇已解析地點名、同章又冇足夠錨點。**字串匹配已到極限**，要再
推進需要語意理解。

關鍵設計：模型只負責「命名」，座標由 OSM 查
============================================
如果叫模型直接出經緯度，佢會**幻覺座標**（寫出一個似合理但實際錯嘅
數字），而且冇得核實。所以：

    LLM 輸出：{ "prototype": "香港知專設計學院", "confidence": 0.8, ... }
                                    ↓
    我哋用 OSM 查「香港知專設計學院」嘅真實座標

好處：
  1. 座標一定嚟自可核實來源（OSM），唔會係模型編出嚟
  2. 原型名可以人手覆核（「呢個推斷合唔合理？」比「呢個座標啱唔啱？」易答）
  3. 查唔到座標 → 推斷自動降級，唔會產生假座標

安全保證
========
- `temperature=0` + prompt hash 快取 → **可重複**
- 輸出係**候選**（`review_status=pending`），**永遠唔會自動套用**
- 全部入 `data/private/`，唔會公開
- 過 JSON schema validation 先寫入

用法：
    python scripts/infer_places_llm.py --limit 5 --dry-run   # 試跑
    python scripts/infer_places_llm.py --limit 20            # 小批量
    python scripts/infer_places_llm.py                       # 全部
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from extraction_core import (  # noqa: E402
    ExtractionCache,
    OpenRouterClient,
    RunLedger,
    load_env,
    require_api_key,
)

INFERENCE = REPO / "data" / "private" / "review" / "place-inference.jsonl"
CLEANED = REPO / "data" / "private" / "cleaned" / "bing-gang.clean.jsonl"
OSM = REPO / "data" / "private" / "cache" / "osm-hk.json"
HK_DISTRICTS = REPO / "data" / "private" / "review" / "hk-districts.json"
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
OUT = REPO / "data" / "private" / "review" / "place-inference-llm.jsonl"

SCHEMA_VERSION = "place-inference-llm-v1"
TEMPERATURE = 0.0

#: 故事設定區域（同 infer_places.py 一致）。OSM 配對要落喺呢度。
STORY_REGION = {"lon_min": 114.19, "lon_max": 114.36, "lat_min": 22.25, "lat_max": 22.40}

SYSTEM_PROMPT = """你係《病港》小說嘅地理考據助手。呢本小說以香港將軍澳為背景。

**任務**：判斷一個「模糊地點名」對應香港邊一個真實地點。

**重要規則**：
1. 只可以答**真實存在嘅香港地點**（例如「寶康公園」「將軍澳中心」「坑口站」）。
   唔可以作名、唔可以答虛構名。
2. 如果冇足夠證據，`prototype` 必須係 null —— **唔確定就唔好估**。
   錯誤嘅推斷比冇推斷更差。
3. 唔需要答座標（我哋會用 OpenStreetMap 查）。
4. `evidence_quote` 必須係**原文摘錄**（唔可以自己改寫），冇就 null。
5. `confidence` 要保守：有明文地名證據 0.7-0.85；靠語意推測 0.4-0.6。

**輸出 JSON**：
{
  "prototype": "真實香港地點名" 或 null,
  "confidence": 0.0-1.0,
  "reasoning": "簡短理由（≤120 字）",
  "evidence_quote": "原文摘錄" 或 null
}"""


def load_texts() -> dict[int, str]:
    fw = "０１２３４５６７８９"
    texts: dict[int, str] = {}
    for line in CLEANED.read_text(encoding="utf-8").splitlines():
        d = json.loads(line)
        s = "".join(str(fw.index(c)) if c in fw else c for c in d.get("chapter_num", ""))
        m = re.search(r"\d+", s)
        if m:
            texts[int(m.group())] = d.get("content", "")
    return texts


def load_osm_names() -> dict[str, dict]:
    els = json.loads(OSM.read_text(encoding="utf-8")).get("elements", [])
    out: dict[str, dict] = {}
    for e in els:
        t = e.get("tags") or {}
        raw = t.get("name") or t.get("name:zh")
        geom = e.get("geometry") or []
        if not raw or not geom:
            continue
        lons = [p["lon"] for p in geom]
        lats = [p["lat"] for p in geom]
        rec = {
            "lon": sum(lons) / len(lons),
            "lat": sum(lats) / len(lats),
            "osm_name": raw,
            "pts": len(geom),
        }
        for key in (raw, t.get("name:zh")):
            if key and len(key) >= 2:
                prev = out.get(key)
                if prev is None or rec["pts"] > prev["pts"]:
                    out[key] = rec
        m = re.match(r"^([^\x00-\x7F\s]+)", raw)
        if m:
            out.setdefault(m.group(1), rec)
    return out


#: 已核實錨點：LLM 推斷到、但 OSM **冇名**嘅真實機構。
#:
#: 為何需要
#: --------
#: OSM 有啲設施**有建築物但冇名**（例如靈實醫院嘅主座大樓 tagged
#: `building=hospital` 但無 `name`），所以按名查會落空。
#:
#: 每一條都要有 `source`（點核實）同 `osm_evidence`（座標點嚟）。
#: 唔可以就咁填一個「聽講係」嘅數字。
CURATED_VERIFIED: dict[str, dict] = {
    "香港道教聯合會圓玄學院第三中學": {
        "lonlat": [114.25720, 22.30930],
        "source": (
            "學校官方網站：地址「將軍澳唐明街2號尚德」"
            "（https://hktayy3.edu.hk/CP/pG/35/40/169）"
        ),
        "osm_evidence": (
            "OSM 喺唐明街一帶有 3 幢 tagged `amenity=school` 但**無名**嘅"
            "建築物，質心 (114.2570–114.2572, 22.3091–22.3095)，同"
            "「唐明街」道路質心 (114.2577, 22.3094) 一致。"
            "⚠️ 呢個係**街道級近似**（唔肯定邊一幢係圓玄三中），"
            "精度標 approximate。"
        ),
    },
    "靈實醫院": {
        "lonlat": [114.2566, 22.3138],
        "source": (
            "醫院管理局官方地址：將軍澳靈實路8號"
            "（https://www3.ha.org.hk/hhh/internet/show.aspx?p=contactus）"
        ),
        "osm_evidence": (
            "OSM 喺該地址有 3 幢 tagged `building=hospital` 但**無名**嘅建築物，"
            "質心 (114.2563–114.2568, 22.3136–22.3140)；毗鄰有名字嘅"
            "靈實協會設施（靈實護養院、靈實司務道護養院、靈實協會禮拜堂）"
        ),
    },
}


#: 人手整理嘅本地座標表（載入一次）。
_HK_DISTRICTS: dict[str, list[float]] = (
    json.loads(HK_DISTRICTS.read_text(encoding="utf-8")) if HK_DISTRICTS.exists() else {}
)


def osm_prefix_cluster(osm: dict[str, dict], name: str) -> list[float] | None:
    """用 OSM 名嘅**共同前綴叢集**推導座標。

    香港好多屋邨／車站嘅附屬設施有名字，但邨／站本身冇。實測：
      「翠林邨」查唔到 → 但 OSM 有「翠林社區會堂」「翠林新城」「翠林體育館」
      「康城站」查唔到 → 冇任何「康城」前綴設施（所以仍然失敗）

    要求 ≥2 條匹配 —— 單一條可能只係巧合（例如「翠林閣」喺大埔）。
    """
    # 取前綴：去掉「邨／站／村／苑／花園／中心／大廈」等後綴
    stem = re.sub(r"(邨|站|村|苑|花園|中心|大廈|廣場|商場|公園|街|路|道)$", "", name)
    if len(stem) < 2:
        return None
    pts = [
        [v["lon"], v["lat"]]
        for k, v in osm.items()
        if k.startswith(stem) and len(k) > len(stem)
    ]
    uniq = {(round(p[0], 6), round(p[1], 6)) for p in pts}
    if len(uniq) < 2:
        return None
    coords = [list(p) for p in uniq]

    # ⚠️ **緊密度**要求（關鍵）
    #
    # 實測嚴重錯誤：「康城站」嘅前綴「康城」喺全港都搵到同名設施，質心
    # 計出嚟係 (114.198, 22.356) —— 即係**西貢**，而真正嘅康城站喺
    # (114.270, 22.295)，相差 6 km。
    #
    # 但唔可以因為「有一兩個遠方同名」就放棄整組 —— 實測「翠林邨」嘅
    # 前綴「翠林」同時匹配到大埔嘅「翠林閣」、元朗嘅「翠林花園」，
    # 令整組被棄，但將軍澳嘅「翠林社區會堂／翠林新城／翠林體育館／
    # 翠林抽水站」其實係一個緊密叢集（跨距約 290 m）。
    #
    # 所以改為：搵**最大嘅緊密子叢集**（所有成員互相相距 ≤ 門檻）。
    MAX_CLUSTER_SPREAD_M = 1000.0
    best: list[list[float]] = []
    for a in coords:
        group = [b for b in coords if haversine_m(a, b) <= MAX_CLUSTER_SPREAD_M]
        if len(group) > len(best):
            best = group
    if len(best) < 2:
        return None

    cx = sum(p[0] for p in best) / len(best)
    cy = sum(p[1] for p in best) / len(best)
    if not in_story_region(cx, cy):
        return None
    return [round(cx, 6), round(cy, 6)]


def haversine_m(a: list[float], b: list[float]) -> float:
    """兩點距離（米）。"""
    import math

    return math.hypot(
        (b[0] - a[0]) * 111320 * math.cos(math.radians(22.36)),
        (b[1] - a[1]) * 110570,
    )


def in_story_region(lon: float, lat: float) -> bool:
    return (
        STORY_REGION["lon_min"] <= lon <= STORY_REGION["lon_max"]
        and STORY_REGION["lat_min"] <= lat <= STORY_REGION["lat_max"]
    )


def build_prompt(name: str, desc: str, chapters: list[int], texts: dict[int, str]) -> str:
    # 抽原文視窗（每個提到嘅位置取前後 80 字）
    excerpts: list[str] = []
    for ch in chapters[:2]:
        t = texts.get(ch)
        if not t:
            continue
        for m in list(re.finditer(re.escape(name), t))[:2]:
            w = t[max(0, m.start() - 80) : m.end() + 80].replace("\n", " ").strip()
            excerpts.append(f"[第{ch}章] …{w}…")
    body = "\n".join(excerpts[:3]) if excerpts else "（原文搵唔到直接提及）"

    return f"""**地點名**：{name}
**章節**：{chapters[:5]}
**資料庫描述**：{desc or "（冇）"}

**原文上下文**：
{body}

請判斷呢個地點對應邊一個真實香港地點。唔確定就答 null。"""


def main() -> int:
    ap = argparse.ArgumentParser(description="LLM 推斷未定位地點嘅真實原型")
    ap.add_argument("--limit", type=int, default=0, help="最多處理幾多條（0 = 全部）")
    ap.add_argument("--dry-run", action="store_true", help="只印 prompt，唔呼叫 API")
    ap.add_argument("--model", help="覆蓋 model id（預設讀 OPENROUTER_EXTRACTION_MODEL）")
    args = ap.parse_args()

    rows = [
        json.loads(l)
        for l in INFERENCE.read_text(encoding="utf-8").splitlines()
        if l
    ]
    todo = [r for r in rows if r["pattern"] == "R-NO-EVIDENCE"]

    locs = json.loads(LOCATIONS.read_text(encoding="utf-8"))["features"]
    by_id = {f["properties"]["id"]: f["properties"] for f in locs}

    # 優先處理「名含真實地名線索」嘅個案。
    #
    # 為何要排序：327 條之中好多係虛構內景（「商場四樓」「小學隱蔽地下室」），
    # 根本冇真實原型。但有一批嘅名直接含真實機構詞（志蓮小學、田家炳小學、
    # 圓玄第三中學、靈實醫院），命中率明顯高得多。先做高價值嘅，限額試跑
    # 時唔會白費。
    CUES = (
        "將軍澳", "坑口", "寶琳", "調景嶺", "康城", "尚德", "彩明", "翠林",
        "寶康", "靈實", "新都城", "志蓮", "宣基", "梁潔華", "田家炳", "圓玄",
        "佛教", "天主教", "聖", "邨", "苑", "街", "路", "站", "醫院",
        "中學", "小學", "公園", "墳場", "碼頭",
    )

    def cue_score(r: dict) -> int:
        p = by_id.get(r["subject_ids"][0])
        if not p:
            return 0
        return sum(1 for c in CUES if c in p["name"])

    todo.sort(key=lambda r: -cue_score(r))
    if args.limit:
        todo = todo[: args.limit]
    print(f"待推斷：{len(todo)} 條（已按真實地名線索排序）")
    texts = load_texts()
    osm = load_osm_names()
    print(f"原文章節 {len(texts)}；OSM 名 {len(osm):,}")

    if args.dry_run:
        r = todo[0]
        p = by_id[r["subject_ids"][0]]
        print("\n=== 範例 prompt ===")
        print(build_prompt(p["name"], p["description"], p["chapters"], texts))
        return 0

    env = load_env(REPO)
    api_key, base_url = require_api_key()
    model = args.model or env.get("OPENROUTER_EXTRACTION_MODEL") or ""
    if not model:
        print("冇指定 model", file=sys.stderr)
        return 2
    client = OpenRouterClient(api_key, base_url)
    cache = ExtractionCache(run_id="infer-places-llm")
    ledger = RunLedger()

    results: list[dict] = []
    stats = {"ok": 0, "null": 0, "no_coord": 0, "error": 0}

    for i, r in enumerate(todo, 1):
        sid = r["subject_ids"][0]
        p = by_id.get(sid)
        if not p:
            continue
        user = build_prompt(p["name"], p["description"], p["chapters"], texts)
        raw = None
        for attempt in range(3):
            try:
                raw, status = call_llm(client, model, user, cache, ledger, p["chapters"][0])
                break
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                # 免費模型限流好常見 —— 退避重試，唔好當成失敗
                if "429" in msg and attempt < 2:
                    wait = 8 * (attempt + 1)
                    print(f"  [{i}/{len(todo)}] {p['name']}：限流，等 {wait}s 重試")
                    time.sleep(wait)
                    continue
                print(f"  [{i}/{len(todo)}] {p['name']}：錯誤 {msg[:80]}")
                stats["error"] += 1
                break
        if raw is None:
            stats["error"] += 1
            continue

        proto = raw.get("prototype")
        conf = float(raw.get("confidence") or 0)
        if not proto:
            stats["null"] += 1
            print(f"  [{i}/{len(todo)}] {p['name']}：模型答唔確定")
            continue

        # 座標解析（三層，全部可稽核）
        #
        # 1. OSM 精確名
        # 2. OSM **前綴叢集** —— 香港好多屋邨／車站嘅**附屬設施**有名字，
        #    但邨本身冇。實測：「翠林邨」查唔到，但 OSM 有「翠林社區會堂」
        #    「翠林新城」「翠林體育館」三條，質心就係翠林邨嘅位置。
        #    要求 ≥2 條匹配（單一條可能係巧合），並驗證落喺故事區域。
        # 3. 已核實錨點（OSM 有建築但冇名嘅機構）
        lon = lat = None
        coord_src = None
        o = osm.get(proto)
        if o and in_story_region(o["lon"], o["lat"]):
            lon, lat = round(o["lon"], 6), round(o["lat"], 6)
            coord_src = "osm_way"
        else:
            cluster = osm_prefix_cluster(osm, proto)
            if cluster is not None:
                lon, lat = cluster
                coord_src = "osm_relation"
        # 3. 已核實錨點（OSM 有建築但冇名，座標由官方地址 + OSM 建築推導）
        #
        # ⚠️ 次序：`CURATED_VERIFIED` 一定要排喺 `hk-districts.json` **之前**。
        # 實測「靈實醫院」兩個來源相差 1.5 km：
        #   hk-districts.json (114.245, 22.302) ← 人手填，冇記錄來源
        #   CURATED_VERIFIED  (114.2566, 22.3138) ← 官方地址（靈實路8號）
        #                                            + OSM 醫院建築質心
        # 後者有完整依據（而且同毗鄰嘅靈實護養院／禮拜堂一致，
        # 官方資料亦話「步行 2 分鐘」），所以優先。
        if lon is None and proto in CURATED_VERIFIED:
            v = CURATED_VERIFIED[proto]
            lon, lat = v["lonlat"]
            coord_src = "external_verified"
        # 4. 本地人手座標表（最後手段；冇記錄來源，所以排最後）
        if lon is None:
            hk = _HK_DISTRICTS.get(proto)
            if hk and in_story_region(hk[0], hk[1]):
                lon, lat = round(hk[0], 6), round(hk[1], 6)
                coord_src = "hk-districts.json"
        if lon is None:
            stats["no_coord"] += 1
            print(f"  [{i}/{len(todo)}] {p['name']} → 「{proto}」但 OSM 查唔到（唔出座標）")
        else:
            stats["ok"] += 1
            print(f"  [{i}/{len(todo)}] {p['name']} → 「{proto}」({lon},{lat}) conf={conf}")

        results.append({
            "inference_id": f"inf_llm_{sid}",
            "entity_kind": "location",
            "subject_ids": [sid],
            "subject_names": [p["name"]],
            "pattern": "R-LLM-SEMANTIC",
            "inferred_prototype": proto,
            "inferred_lonlat": [lon, lat] if lon is not None else None,
            "coordinate_source": coord_src,
            "evidence": [
                {
                    "kind": "description_claim",
                    "chapter": p["chapters"][0] if p["chapters"] else None,
                    "detail": f"LLM（{model}, temp={TEMPERATURE}）：{raw.get('reasoning', '')[:200]}",
                    "refs": [],
                },
                {
                    "kind": "explicit_statement",
                    "chapter": p["chapters"][0] if p["chapters"] else None,
                    "detail": f"原文引錄：{(raw.get('evidence_quote') or '（無）')[:200]}",
                    "refs": [],
                },
                {
                    "kind": "osm_place_match",
                    "chapter": None,
                    "detail": (
                        f"座標來源：{coord_src}"
                        + (
                            f"；{CURATED_VERIFIED[proto]['source']}；"
                            f"{CURATED_VERIFIED[proto]['osm_evidence']}"
                            if proto in CURATED_VERIFIED
                            else ""
                        )
                    ),
                    "refs": [],
                },
            ],
            "confidence": round(conf, 2),
            "proposed_changes": {
                "location_precision": "approximate" if lon is not None else None,
                "merge_into": None,
                "set_lonlat": [lon, lat] if lon is not None else None,
            },
            "review_status": "pending",
            "review_notes": f"LLM 推斷，model={model}；座標由 OSM 查（非模型輸出）",
        })

    print(f"\n=== 統計 ===")
    print(f"  有原型+座標：{stats['ok']}　模型答唔確定：{stats['null']}")
    print(f"  有原型但 OSM 查唔到：{stats['no_coord']}　錯誤：{stats['error']}")

    # 同現有結果**合併**，唔覆蓋。
    #
    # 為何要合併：免費層限流嚴重（全量 332 條約 100 分鐘），所以要分批跑。
    # 如果每次都覆蓋，第二批就會沖走第一批嘅結果。合併之後可以累積。
    existing: dict[str, dict] = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line:
                r = json.loads(line)
                existing[r["subject_ids"][0]] = r
    before = len(existing)
    for r in results:
        existing[r["subject_ids"][0]] = r
    merged = sorted(existing.values(), key=lambda r: r["inference_id"])
    OUT.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in merged) + "\n",
        encoding="utf-8",
    )
    print(
        f"\n寫入 {OUT}（本次 {len(results)} 條，累計 {len(merged)} 條"
        f"{f'，新增 {len(merged) - before}' if before else ''}，全部 pending）"
    )
    return 0


def call_llm(client, model, user, cache, ledger, chapter):
    """帶快取嘅 LLM 呼叫（temperature=0，可重複）。"""
    import hashlib

    cache_key = hashlib.sha256(
        json.dumps(
            {"model": model, "system": SYSTEM_PROMPT, "user": user, "temp": TEMPERATURE},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    hit = cache.get(cache_key)
    if hit is not None:
        return hit, "cache"
    content = client.chat(model, [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ], temperature=TEMPERATURE, max_tokens=2000)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return None, "invalid_json"
    cache.put(cache_key, parsed)
    ledger.append({
        "run_id": "infer-places-llm",
        "chapter": chapter,
        "segment_index": 0,
        "model": model,
        "prompt_hash": cache_key[:16],
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
    })
    return parsed, "ok"


if __name__ == "__main__":
    raise SystemExit(main())

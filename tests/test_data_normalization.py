"""公開資料一致性測試（正規化 + 引用完整性）。

保護嘅關鍵行為，全部係實際踩過嘅缺陷：

1. **時間線排序** —— `date_label` 寫住「按章節先後」，但實測有 41 個
   逆序對（index 15 係 ch3、index 16 係 ch1）。前端照陣列次序顯示，
   用戶會見到時間倒流。
2. **路線座標同 waypoint 一致** —— 地點推斷改咗座標之後，路線幾何
   冇跟住更新，出現「真-真」線段長 37.5 km 嘅荒謬結果（「皇宮」同
   「新都城商場」明明喺同一個座標，路線畫成相距 37 km）。
3. **路線精度值合法** —— route.schema.json 只允許
   `reference`／`approximate`／`fictional`，唔可以自己發明新值。
4. **角色合併之後冇斷鏈** —— 被合併嘅名要入 canonical 嘅 aliases，
   而且唔可以再有引用指向唔存在嘅角色。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
NORMALIZE = REPO / "scripts" / "normalize_public_data.py"
MERGE = REPO / "scripts" / "merge_characters.py"


def _load(name: str):
    return json.loads((PUBLIC / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def timeline() -> list[dict]:
    return _load("timeline.json")


@pytest.fixture(scope="module")
def events() -> list[dict]:
    return _load("events.geojson")["features"]


@pytest.fixture(scope="module")
def locations() -> list[dict]:
    return _load("locations.geojson")["features"]


@pytest.fixture(scope="module")
def routes() -> list[dict]:
    return _load("routes.geojson")["features"]


@pytest.fixture(scope="module")
def characters() -> list[dict]:
    return _load("characters.json")


# ---------------------------------------------------------------------------
# 1. 時間線
# ---------------------------------------------------------------------------
def test_timeline_is_chronological(timeline):
    """時間線必須按章節遞增 —— 唔可以有逆序對。

    `date_label` 明寫「按章節先後」，所以呢個係資料自己嘅承諾。
    """
    seq = [
        int(t["date_sort"][2:])
        for t in timeline
        if isinstance(t.get("date_sort"), str) and t["date_sort"].startswith("ch")
    ]
    inversions = [(i, seq[i], seq[i + 1]) for i in range(len(seq) - 1) if seq[i] > seq[i + 1]]
    assert not inversions, (
        f"時間線有 {len(inversions)} 個逆序對（index, 前, 後）：{inversions[:5]}"
    )


def test_timeline_ids_unique(timeline):
    ids = [t["id"] for t in timeline]
    assert len(ids) == len(set(ids)), "時間線有重複 id"


def test_timeline_event_refs_resolve(timeline, events):
    ev_ids = {e["properties"]["id"] for e in events}
    missing = [t["id"] for t in timeline if t.get("event_id") not in ev_ids]
    assert not missing, f"{len(missing)} 條時間線指向唔存在嘅事件：{missing[:3]}"


def test_timeline_chapter_matches_event(timeline, events):
    by_id = {e["properties"]["id"]: e["properties"] for e in events}
    bad = [
        t["id"]
        for t in timeline
        if t.get("event_id") in by_id
        and t.get("chapter") != by_id[t["event_id"]].get("chapter")
    ]
    assert not bad, f"{len(bad)} 條時間線嘅章節同事件唔一致：{bad[:3]}"


# ---------------------------------------------------------------------------
# 2. 路線座標 ↔ waypoint 一致（引用完整性）
# ---------------------------------------------------------------------------
def test_route_coords_match_waypoint_locations(routes, locations):
    """路線幾何每個點必須等於對應 waypoint 嘅地點座標。

    呢個測試保護一個實際踩過嘅缺陷：地點推斷改咗座標之後，路線幾何
    冇跟住更新。因為驗證器只檢查 events 同 location 一致，所以呢個
    缺陷**唔會報錯** —— 但前端會照樣畫出假線（實測出現 37.5 km 嘅
    「真-真」線段）。
    """
    loc_coords = {
        f["properties"]["id"]: f["geometry"]["coordinates"] for f in locations
    }
    bad: list[tuple[str, int]] = []
    for f in routes:
        wps = f["properties"].get("waypoints") or []
        coords = f["geometry"]["coordinates"]
        for i, w in enumerate(wps):
            if i >= len(coords):
                break
            lid = w.get("location_id")
            if not lid or lid not in loc_coords:
                continue
            if coords[i] != loc_coords[lid]:
                bad.append((f["properties"]["id"], i))
    assert not bad, (
        f"{len(bad)} 個路線點同地點座標唔一致（路線幾何係舊嘅）：{bad[:5]}"
    )


def test_route_segments_are_plausible(routes, locations):
    """真-真線段唔應該長過 8 km。

    角色係喺將軍澳活動嘅人，唔會一步跨 37 km。呢個檢查會捉到
    「座標更新唔完整」造成嘅假線段。
    """
    import math

    prec = {
        f["properties"]["id"]: f["properties"]["location_precision"]
        for f in locations
    }

    def dist(a, b):
        return math.hypot(
            (b[0] - a[0]) * 111320 * 0.9247, (b[1] - a[1]) * 110570
        )

    bad: list[tuple[str, float]] = []
    for f in routes:
        wps = f["properties"].get("waypoints") or []
        coords = f["geometry"]["coordinates"]
        for i in range(min(len(coords), len(wps)) - 1):
            a = prec.get(wps[i].get("location_id"), "fictional")
            b = prec.get(wps[i + 1].get("location_id"), "fictional")
            if a == "fictional" or b == "fictional":
                continue
            d = dist(coords[i], coords[i + 1])
            if d > 8000:
                bad.append((f["properties"]["id"], d))
    assert not bad, f"{len(bad)} 段真-真線段過長：{[(i, f'{d:.0f}m') for i, d in bad[:5]]}"


def test_route_precision_in_schema_enum(routes):
    allowed = {"reference", "approximate", "fictional"}
    bad = [f["properties"]["id"] for f in routes if f["properties"].get("precision") not in allowed]
    assert not bad, f"路線精度值唔合法：{bad[:5]}"


def test_route_real_fraction_present(routes):
    """每條有 waypoint 嘅路線都要有 real_waypoint_fraction（正規化產物）。"""
    missing = [
        f["properties"]["id"]
        for f in routes
        if (f["properties"].get("waypoints") or [])
        and "real_waypoint_fraction" not in f["properties"]
    ]
    assert not missing, f"{len(missing)} 條路線缺 real_waypoint_fraction：{missing[:3]}"


# ---------------------------------------------------------------------------
# 3. 角色合併完整性
# ---------------------------------------------------------------------------
def test_no_duplicate_character_names(characters):
    names = [c["name"] for c in characters]
    dup = {n for n in names if names.count(n) > 1}
    assert not dup, f"角色名重複：{dup}"


def test_character_ids_unique(characters):
    ids = [c["id"] for c in characters]
    assert len(ids) == len(set(ids)), "角色 id 重複"


def test_merged_names_preserved_as_aliases(characters):
    """被合併嘅名要保留喺 canonical 嘅 aliases（可追溯）。

    合併係破壞性操作 —— 一個實體會消失。保留舊名做 alias 係唯一可以
    事後回溯「本來有邊幾條記錄」嘅方法。
    """
    applied = REPO / "data" / "private" / "review" / "character-merge-applied.json"
    if not applied.exists():
        pytest.skip("未跑過 merge_characters.py")
    log = json.loads(applied.read_text(encoding="utf-8"))
    by_id = {c["id"]: c for c in characters}
    missing = []
    for m in log.get("merges", []):
        canon = by_id.get(m["into_id"])
        if canon is None:
            continue  # canonical 自己後來又被合併
        if m["from_name"] not in (canon.get("aliases") or []):
            missing.append((m["from_name"], canon["name"]))
    assert not missing, f"被合併嘅名冇保留做 alias：{missing[:5]}"


def test_merge_script_is_idempotent():
    """重跑合併腳本唔應該再改任何嘢。"""
    before = (PUBLIC / "characters.json").read_text(encoding="utf-8")
    r = subprocess.run(
        [sys.executable, str(MERGE)], cwd=str(REPO), capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr[-500:]
    after = (PUBLIC / "characters.json").read_text(encoding="utf-8")
    assert before == after, "merge_characters.py 唔冪等"


def test_normalize_script_is_idempotent():
    """重跑正規化唔應該再改任何嘢。"""
    before_tl = (PUBLIC / "timeline.json").read_text(encoding="utf-8")
    before_rt = (PUBLIC / "routes.geojson").read_text(encoding="utf-8")
    r = subprocess.run(
        [sys.executable, str(NORMALIZE)], cwd=str(REPO), capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr[-500:]
    assert (PUBLIC / "timeline.json").read_text(encoding="utf-8") == before_tl
    assert (PUBLIC / "routes.geojson").read_text(encoding="utf-8") == before_rt


# ---------------------------------------------------------------------------
# 事件／時間線角色連結
# ---------------------------------------------------------------------------
LINK = REPO / "scripts" / "link_event_characters.py"


def test_events_have_character_links(events):
    """實測原本 1,796 條事件嘅 characters 全部係空陣列。"""
    linked = sum(1 for e in events if e["properties"].get("characters"))
    assert linked > 1000, f"應該有大量事件連到角色，實際只有 {linked}"


def test_character_ids_resolve(characters, events):
    """事件引用嘅角色 id 必須存在。"""
    valid = {c["id"] for c in characters}
    bad: list[str] = []
    for e in events:
        for cid in e["properties"].get("characters") or []:
            if cid not in valid:
                bad.append(cid)
    assert not bad, f"{len(bad)} 個角色 id 唔存在：{set(bad)}"


def test_timeline_characters_match_events(timeline, events):
    """timeline 同 events 嘅角色連結必須一致。"""
    by_id = {e["properties"]["id"]: e["properties"] for e in events}
    bad = [
        t["id"]
        for t in timeline
        if t.get("event_id") in by_id
        and set(t.get("characters") or [])
        != set(by_id[t["event_id"]].get("characters") or [])
    ]
    assert not bad, f"{len(bad)} 條 timeline 同 events 角色唔一致：{bad[:3]}"


def test_no_pronoun_aliases_used_as_links(characters):
    """代名詞唔應該出現喺角色名／別名（會令每條事件都「命中」）。"""
    bad = [
        (c["name"], a)
        for c in characters
        for a in (c.get("aliases") or [])
        if a.strip() in {"我", "你", "他", "她", "佢", "它"}
    ]
    assert not bad, f"角色別名含代名詞：{bad[:5]}"


def test_link_script_is_idempotent():
    before_ev = (PUBLIC / "events.geojson").read_text(encoding="utf-8")
    before_tl = (PUBLIC / "timeline.json").read_text(encoding="utf-8")
    r = subprocess.run(
        [sys.executable, str(LINK)], cwd=str(REPO), capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr[-500:]
    assert (PUBLIC / "events.geojson").read_text(encoding="utf-8") == before_ev
    assert (PUBLIC / "timeline.json").read_text(encoding="utf-8") == before_tl


# ---------------------------------------------------------------------------
# 地點合併 / 孤兒引用
# ---------------------------------------------------------------------------
def test_location_ids_unique(locations):
    ids = [f["properties"]["id"] for f in locations]
    assert len(ids) == len(set(ids)), "地點 id 重複"


def test_merged_location_names_preserved(locations):
    """被合併嘅地點名要保留做 canonical 嘅 aliases。"""
    applied = REPO / "data" / "private" / "review" / "place-inference-applied.json"
    if not applied.exists():
        pytest.skip("未跑過 apply_place_inferences.py")
    log = json.loads(applied.read_text(encoding="utf-8"))
    by_id = {f["properties"]["id"]: f["properties"] for f in locations}
    missing = []
    for m in log.get("merged", []):
        canon = by_id.get(m["into_id"])
        if canon is None:
            continue
        if m["from_name"] not in (canon.get("aliases") or []):
            missing.append((m["from_name"], canon["name"]))
    assert not missing, f"合併後冇保留舊名做 alias：{missing[:5]}"


def test_no_orphan_location_refs(locations, events, routes, timeline):
    """所有 location_id 引用必須指向存在嘅地點。

    呢個測試保護一個實際踩過嘅缺陷：地點合併之後，**上一次**合併走嘅
    id 唔會出現喺今次嘅映射表，令引用變成孤兒。驗證器會捉到，但呢個
    測試喺單元層面更快定位。
    """
    valid = {f["properties"]["id"] for f in locations}
    bad: list[str] = []
    for e in events:
        lid = e["properties"].get("location_id")
        if lid and lid not in valid:
            bad.append(f"event {e['properties']['id']} → {lid}")
    for t in timeline:
        lid = t.get("location_id")
        if lid and lid not in valid:
            bad.append(f"timeline {t['id']} → {lid}")
    for f in routes:
        for w in f["properties"].get("waypoints") or []:
            lid = w.get("location_id")
            if lid and lid not in valid:
                bad.append(f"route {f['properties']['id']} → {lid}")
    assert not bad, f"{len(bad)} 個孤兒 location_id：{bad[:5]}"


# ---------------------------------------------------------------------------
# 角色身份（subject / mentioned）
# ---------------------------------------------------------------------------
def test_character_roles_present(events):
    """每個有角色連結嘅事件都要有 character_roles。"""
    missing = [
        e["properties"]["id"]
        for e in events
        if e["properties"].get("characters")
        and not e["properties"].get("character_roles")
    ]
    assert not missing, f"{len(missing)} 條事件有角色但冇身份：{missing[:3]}"


def test_character_roles_keys_match_characters(events):
    """character_roles 嘅 key 必須同 characters 一致。"""
    bad = [
        e["properties"]["id"]
        for e in events
        if set((e["properties"].get("character_roles") or {}).keys())
        != set(e["properties"].get("characters") or [])
    ]
    assert not bad, f"{len(bad)} 條事件嘅身份 key 同角色清單唔一致：{bad[:3]}"


def test_character_roles_enum(events):
    allowed = {"subject", "mentioned"}
    bad: list[tuple[str, str]] = []
    for e in events:
        for cid, role in (e["properties"].get("character_roles") or {}).items():
            if role not in allowed:
                bad.append((e["properties"]["id"], role))
    assert not bad, f"角色身份值唔合法：{bad[:5]}"


def test_subject_role_implies_title_mention(events, characters):
    """被標為 subject 嘅角色，必須真係出現喺事件標題。

    呢個係規則嘅定義 —— 如果唔成立，代表規則實作有 bug。
    """
    by_id = {c["id"]: c for c in characters}
    names: dict[str, list[str]] = {}
    for c in characters:
        names[c["id"]] = [
            n for n in [c["name"], *(c.get("aliases") or [])] if n
        ]
    bad: list[tuple[str, str]] = []
    for e in events:
        title = e["properties"].get("title") or ""
        for cid, role in (e["properties"].get("character_roles") or {}).items():
            if role != "subject":
                continue
            if cid not in by_id:
                continue
            if not any(n in title for n in names[cid]):
                bad.append((e["properties"]["id"], by_id[cid]["name"]))
    assert not bad, f"{len(bad)} 個 subject 冇出現喺標題：{bad[:5]}"


def test_single_latin_letters_allowed_as_names():
    """單個拉丁字母（例如主角別名「M」）應該可以用嚟比對。

    實測缺口：用 `len(n) < 2` 過濾會令「M」被排除，導致
    「M擊殺便利店大眼店員」呢類事件捕捉唔到主角。
    但單個**中文**字（代名詞）就唔可以。
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location("link", LINK)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    assert mod.is_usable_name("M")
    assert mod.is_usable_name("A")
    assert not mod.is_usable_name("我")
    assert not mod.is_usable_name("你")
    assert mod.is_usable_name("夏晴")


# ---------------------------------------------------------------------------
# 前端資料同步（最危險嘅一類缺陷：驗證綠燈但成品係舊嘅）
# ---------------------------------------------------------------------------
SYNC = REPO / "scripts" / "sync_public_data.py"
SERVE_DIR = REPO / "public" / "data" / "public"


def test_served_data_matches_source():
    """前端讀取嘅 `public/data/public/` 必須同 `data/public/` 一致。

    ⚠️ 為何呢個測試最重要
    --------------------
    `data/public/` 係資料來源（builder 寫入、驗證器檢查、audit 掃描），
    但前端係由 `public/data/public/` 讀取（Vite `publicDir` 複製）。

    實測踩過：`public/data/public/` 停留喺 **12 日前**，而 `data/public/`
    已經改咗好多（fictional 543→327、事件角色連結 0→1,501、時間線排序、
    路線座標修正……）—— **全部冇喺地圖上出現過**。

    而**所有閘門都通過**：`validate_public_data.py` 同 `audit_release.py`
    都只檢查 `data/public/`，唔會發現前端讀到舊資料。

    即係「驗證綠燈但成品係舊嘅」—— 最危險嘅一類缺陷。
    """
    import hashlib

    def sha(p: Path) -> str:
        return hashlib.sha256(p.read_bytes()).hexdigest()

    # ⚠️ 先跑同步再斷言。
    #
    # 為何唔可以直接斷言：同一個 pytest session 入面，其他測試（例如
    # `test_infer_places` 嘅 fixture、`test_derive_zones_is_idempotent`）
    # 會改寫 `data/public/`，令之後嘅同步測試見到「唔一致」—— 但嗰個
    # 唔一致係測試自己造成嘅，唔係真嘅缺陷（實測踩過）。
    #
    # 呢個測試真正要驗嘅係：**同步腳本有效**。而「開發者記唔記得跑」
    # 由 `npm run build` 嘅 `prebuild` 掛鈎保證。
    r = subprocess.run(
        [sys.executable, str(SYNC)], cwd=str(REPO), capture_output=True, text=True
    )
    assert r.returncode == 0, f"同步失敗：{r.stdout[-300:]}"

    src = {p.name: p for p in REPO.joinpath("data", "public").glob("*.json")}
    src.update({p.name: p for p in REPO.joinpath("data", "public").glob("*.geojson")})

    missing, stale = [], []
    for name, sp in src.items():
        dp = SERVE_DIR / name
        if not dp.exists():
            missing.append(name)
        elif sha(sp) != sha(dp):
            stale.append(name)
    assert not missing, f"前端缺少呢啲檔：{missing}"
    assert not stale, (
        f"同步之後仍然唔一致（{len(stale)} 個檔）：{stale}\n"
        "代表同步腳本有 bug"
    )


def test_sync_script_check_mode():
    """`--check` 模式喺同步之後應該 exit 0。"""
    # 先同步（其他測試可能改過來源）
    subprocess.run([sys.executable, str(SYNC)], cwd=str(REPO), capture_output=True)
    r = subprocess.run(
        [sys.executable, str(SYNC), "--check"],
        cwd=str(REPO), capture_output=True, text=True,
    )
    # ⚠️ `--check` 亦會檢查 dist。測試期間 dist 必然係舊嘅（冇 build），
    # 所以只驗證 public/ 嗰層一致，唔可以因為 dist 而 fail。
    assert "public/data/public 唔一致" not in (r.stdout + r.stderr), (
        f"public/ 層同步失敗：{r.stdout[-400:]}"
    )


def test_prebuild_hooks_sync():
    """`npm run build` 必須自動同步 —— 否則人手跑漏就會再次靜默落後。"""
    pkg = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
    scripts = pkg.get("scripts", {})
    assert "sync-data" in scripts, "缺 sync-data script"
    assert "prebuild" in scripts, (
        "缺 prebuild —— build 之前一定要同步，否則前端會讀到舊資料"
    )
    assert "sync" in scripts["prebuild"], "prebuild 必須呼叫 sync-data"


# ---------------------------------------------------------------------------
# 區域（倖存區／病窩／據點）
#
# 資料由 scripts/merge_zone_dossiers.py 產生（全文抽取 + 確定性合併）。
# 舊嘅 derive_zones.py 只由地點名推導，已經被取代。
# ---------------------------------------------------------------------------
ZONES = REPO / "data" / "public" / "zones.geojson"
ZONE_SCHEMA = REPO / "data" / "schemas" / "zone.schema.json"
ZONE_MERGER = REPO / "scripts" / "merge_zone_dossiers.py"


@pytest.fixture(scope="module")
def zones() -> list[dict]:
    if not ZONES.exists():
        pytest.skip("未跑過 merge_zone_dossiers.py")
    return json.loads(ZONES.read_text(encoding="utf-8"))["features"]


def test_zones_validate_against_schema(zones):
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(ZONE_SCHEMA.read_text(encoding="utf-8"))
    v = jsonschema.Draft202012Validator(schema)
    errs = [f"{z['properties']['id']}: {e.message}" for z in zones for e in v.iter_errors(z)]
    assert not errs, "區域 schema 驗證失敗：\n" + "\n".join(errs[:5])


def test_zone_radius_within_bounds(zones):
    """半徑必須喺上下限之內（太細睇唔到，太大蓋過其他區域）。"""
    for z in zones:
        r = z["properties"]["radius_m"]
        assert 80 <= r <= 1500, f"{z['properties']['name']} 半徑 {r} m 超出範圍"


def test_zone_radius_source_is_auditable(zones):
    """每個區域都要講清楚範圍同座標係點嚟 —— 唔可以只寫結論。"""
    allowed = {"members", "default", "unknown"}
    for z in zones:
        p = z["properties"]
        assert p["radius_source"] in allowed, f"{p['name']} radius_source 唔合法"
        assert p["coords_source"], f"{p['name']} 缺 coords_source"
        assert p["coords_evidence"], f"{p['name']} 缺 coords_evidence"
        assert p["range_evidence"], f"{p['name']} 缺 range_evidence"


def test_zone_geometry_is_polygon_within_radius(zones):
    """幾何一定要係多邊形，而且所有頂點都喺 radius_m 之內。

    呢個係防止「標咗 300 m 但畫咗 3 km」嘅假範圍。
    """
    import math

    for z in zones:
        p = z["properties"]
        assert z["geometry"]["type"] == "Polygon", f"{p['name']} 唔係多邊形"
        ring = z["geometry"]["coordinates"][0]
        assert len(ring) >= 4, f"{p['name']} 環太短"
        assert ring[0] == ring[-1], f"{p['name']} 環未閉合"
        cx = sum(pt[0] for pt in ring[:-1]) / (len(ring) - 1)
        cy = sum(pt[1] for pt in ring[:-1]) / (len(ring) - 1)
        far = max(
            math.hypot((pt[0] - cx) * 111320 * 0.9247, (pt[1] - cy) * 110570)
            for pt in ring
        )
        # 容許 5% 誤差（質心同中心定義唔完全一樣）
        assert far <= p["radius_m"] * 1.05 + 1, (
            f"{p['name']} 幾何最遠點 {far:.0f} m 超出 radius_m {p['radius_m']:.0f} m"
        )


def test_zone_kinds_cover_three_types(zones):
    """區域要有安全、危險、敵對據點三類（用戶要求用顏色區分）。"""
    kinds = {z["properties"]["kind"] for z in zones}
    assert "survivor" in kinds, "應該有倖存區（安全）"
    assert "nest" in kinds, "應該有病窩（危險）"
    assert "outpost" in kinds, "應該有據點（敵對）"


def test_zone_dossiers_have_governance_detail(zones):
    """用戶明確要求「政權種類、人文風格、社會結構」等詳細內容。

    所以倖存區一定要有 summary，而且大部分要有 government。
    """
    survivors = [z for z in zones if z["properties"]["kind"] == "survivor"]
    assert survivors, "應該有倖存區"
    with_summary = [z for z in survivors if (z["properties"].get("summary") or "").strip()]
    assert len(with_summary) == len(survivors), "所有倖存區都要有 summary"
    with_gov = [z for z in survivors if (z["properties"].get("government") or "").strip()]
    assert len(with_gov) >= len(survivors) * 0.6, (
        f"倖存區政權資料太少：{len(with_gov)}/{len(survivors)}"
    )


def test_zone_evidence_is_not_leaked_to_public(zones):
    """⚠️ 版權紅線（B4 改寫）—— 呢個測試**由「要求有 evidence」反轉為「禁止 evidence」**。

    原本嘅 `test_zone_evidence_quotes_chapters` 要求 ≥70% 區域嘅 `evidence`
    含 `"ch"` 章節標記。但實測 48/48 個 `evidence` 都係
    `"ch73 原文：「…」"` 格式 —— 即係**成段小說原文**入咗公開資料，
    而呢個檔會經 `npm run sync-data` 出到前端 bundle。

    所以 World Atlas V2 決定：**`evidence` 欄位完全移除**，原文只留
    `data/private/`。取代佢嘅係：
      - `chapter_refs`（章節索引，唔含原文）
      - `zone-dossiers.json` 嘅短摘要（≤180 字，DS3）
      - `artifacts/b4/coordinate-audit-report.md` 嘅統計（唔含原文）

    防回歸：`tests/test_spatial_integrity.py::test_public_data_has_no_novel_quotes`
    會掃描所有 `data/public/**` 有冇 `原文：`／`chN 原文`。
    """
    # 1. `evidence` 欄位必須完全消失（唔係清空）
    leaked = [z["properties"]["id"] for z in zones if "evidence" in z["properties"]]
    assert not leaked, f"{len(leaked)} 個 zone 仲有 evidence 欄位（版權紅線）：{leaked[:5]}"

    # 2. 取代品必須存在：`chapter_refs` 係 spec §2.2 嘅統一命名
    missing = [z["properties"]["id"] for z in zones if "chapter_refs" not in z["properties"]]
    assert not missing, f"{len(missing)} 個 zone 缺 chapter_refs：{missing[:5]}"
    assert all(z["properties"]["chapter_refs"] == z["properties"]["chapters"] for z in zones), (
        "chapter_refs 應該係 chapters 嘅同義改名"
    )

    # 3. 冇任何 properties 值含 `原文` 標記
    import re as _re

    pat = _re.compile(r"原文\s*[：:「]|ch\s*\d+\s*原文")
    hits = [
        z["properties"]["id"]
        for z in zones
        if pat.search(json.dumps(z["properties"], ensure_ascii=False))
    ]
    assert not hits, f"{len(hits)} 個 zone 嘅 properties 含小說原文標記：{hits[:5]}"


def test_zone_ids_unique(zones):
    ids = [z["properties"]["id"] for z in zones]
    assert len(ids) == len(set(ids)), "區域 id 重複"


def test_zone_merger_is_idempotent():
    """合併腳本必須冪等 —— 重跑唔可以令結果靜默改變。"""
    if not ZONES.exists():
        pytest.skip("未跑過 merge_zone_dossiers.py")
    before = ZONES.read_text(encoding="utf-8")
    r = subprocess.run(
        [sys.executable, str(ZONE_MERGER)],
        cwd=str(REPO), capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr[-400:]
    assert ZONES.read_text(encoding="utf-8") == before, "merge_zone_dossiers.py 唔冪等"


# ---------------------------------------------------------------------------
# 虛構地點錨定
# ---------------------------------------------------------------------------
def test_fictional_locations_have_position_source():
    """每個 `fictional` 地點都要有 `position_source` 講明位置點嚟。

    ⚠️ 為何重要：呢啲地點冇真實對照，位置係「示意」。如果唔講明來源，
    用戶會以為佢哋係真實位置。
    """
    locs = json.loads(
        (REPO / "data" / "public" / "locations.geojson").read_text(encoding="utf-8")
    )["features"]
    missing = [
        f["properties"]["name"]
        for f in locs
        if f["properties"]["location_precision"] == "fictional"
        and not f["properties"].get("position_source")
    ]
    assert not missing, f"{len(missing)} 個 fictional 地點冇 position_source：{missing[:5]}"


def test_parent_anchored_locations_inherit_precision():
    """依附父項嘅地點，精度必須**等於**父項（唔可以更準，亦唔應該係 fictional）。

    子項係父項內部嘅房間，位置準確度同父項一樣 —— 唔會更準。
    """
    locs = json.loads(
        (REPO / "data" / "public" / "locations.geojson").read_text(encoding="utf-8")
    )["features"]
    by_name = {f["properties"]["name"]: f["properties"] for f in locs}

    checked = 0
    for f in locs:
        p = f["properties"]
        src = str(p.get("position_source") or "")
        if "依附於" not in src:
            continue
        # 由 source 抽父項名
        m = re.search(r"依附於「([^」]+)」", src)
        assert m, f"{p['name']} 嘅 position_source 格式唔對：{src[:60]}"
        parent = by_name.get(m.group(1))
        if parent is None:
            continue
        assert p["location_precision"] == parent["location_precision"], (
            f"{p['name']} 精度 {p['location_precision']} 唔等於父項"
            f"「{m.group(1)}」嘅 {parent['location_precision']}"
        )
        assert p["location_precision"] != "fictional", (
            f"{p['name']} 依附咗父項但精度仍然係 fictional"
        )
        checked += 1
    assert checked > 20, f"依附父項嘅個案太少（{checked}），規則可能冇觸發"


def test_anchored_locations_stay_in_story_region():
    """錨定之後全部地點都要喺將軍澳範圍（唔可以散落全港）。

    ⚠️ 例外：**有地名證據**（`coord_corrected`）嘅地點可以喺區外。
    實測「海洋公園」—— ch198 原文寫明「海洋公園位於港島區」，
    所以佢**應該**喺港島，而唔係被強行拉入將軍澳。
    冇證據嘅地點仍然一律要喺區內。
    """
    locs = json.loads(
        (REPO / "data" / "public" / "locations.geojson").read_text(encoding="utf-8")
    )["features"]
    outside = [
        f["properties"]["name"]
        for f in locs
        if not f["properties"].get("map_hidden")
        and not f["properties"].get("coord_corrected")
        and not (
            114.225 <= f["geometry"]["coordinates"][0] <= 114.310
            and 22.265 <= f["geometry"]["coordinates"][1] <= 22.350
        )
    ]
    assert not outside, f"{len(outside)} 個可見地點喺將軍澳以外：{outside[:5]}"


def test_coord_corrections_are_auditable():
    """所有程式化座標修正都要有可稽核嘅理由（唔可以靜默改座標）。"""
    locs = json.loads(
        (REPO / "data" / "public" / "locations.geojson").read_text(encoding="utf-8")
    )["features"]
    corrected = [f for f in locs if f["properties"].get("coord_corrected")]
    assert corrected, "應該有程式化修正過嘅地點"
    # ⚠️ 只檢查**本階段**（audit_location_coords.py）加嘅修正。
    # Phase J 之前已經有一批 `coord_corrected` 標記，佢哋嘅
    # `position_source` 格式唔同 —— 唔應該用同一條規則去驗。
    ours = [f for f in corrected if "程式化座標校正" in (f["properties"].get("position_source") or "")]
    assert ours, "應該有 audit_location_coords.py 修正過嘅地點"
    for f in ours:
        src = f["properties"]["position_source"]
        assert "m" in src, f"{f['properties']['name']} 理由應該包含距離數字"

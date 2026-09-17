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
        f"前端讀到舊資料（{len(stale)} 個檔唔一致）：{stale}\n"
        "請跑 python scripts/sync_public_data.py"
    )


def test_sync_script_check_mode():
    """`--check` 模式喺一致時應該 exit 0。"""
    r = subprocess.run(
        [sys.executable, str(SYNC), "--check"],
        cwd=str(REPO), capture_output=True, text=True,
    )
    assert r.returncode == 0, f"同步檢查失敗：{r.stdout[-400:]}"


def test_prebuild_hooks_sync():
    """`npm run build` 必須自動同步 —— 否則人手跑漏就會再次靜默落後。"""
    pkg = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
    scripts = pkg.get("scripts", {})
    assert "sync-data" in scripts, "缺 sync-data script"
    assert "prebuild" in scripts, (
        "缺 prebuild —— build 之前一定要同步，否則前端會讀到舊資料"
    )
    assert "sync" in scripts["prebuild"], "prebuild 必須呼叫 sync-data"

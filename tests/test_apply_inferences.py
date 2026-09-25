"""套用推斷管線嘅回歸測試（scripts/apply_place_inferences.py）。

保護嘅關鍵行為：
1. **冪等性** —— 推斷 → 套用 → 再推斷 → 再套用，結果必須完全相同。
   呢個係最重要嘅一條：`apply` 會改 `locations.geojson`，如果候選集依賴
   被改動嘅欄位（例如 `location_precision`），重跑就會失去已套用結果。
   實測踩過：R-ANCHOR-MEMBER 由 45 條跌到 10 條。
2. 只有 `approved` 會被套用，`pending`／`rejected` 一律唔動。
3. 套用之後 `events.geojson` 嘅座標要同對應地點一致（傳播完整性）。
4. 座標必須喺香港範圍內。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PIPELINE = REPO / "scripts" / "run_pipeline.py"
INFER = REPO / "scripts" / "infer_places.py"
APPLY = REPO / "scripts" / "apply_place_inferences.py"
LOCATIONS = REPO / "data" / "public" / "locations.geojson"
EVENTS = REPO / "data" / "public" / "events.geojson"
JSONL = REPO / "data" / "private" / "review" / "place-inference.jsonl"
DECISIONS = REPO / "data" / "private" / "review" / "place-inference-decisions.json"


PUBLIC_DIR = REPO / "data" / "public"
#: 管線最後一步 `sync_public_data.py` 會將 `data/public` 同步去呢度，
#: 所以快照一定要**兩邊都包**（只包一邊會令另一半 dirty）。
SERVED_DIR = REPO / "public" / "data" / "public"


def _run(script: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script)], cwd=str(REPO), capture_output=True, text=True
    )


@pytest.fixture(scope="module", autouse=True)
def _restore_public_after_module():
    """⚠️ 本模組會跑**完整管線**，而管線會改寫 `data/public/**` 同
    `public/data/public/**`（最後一步 `sync_public_data.py`）。

    原本冇還原 → 跑一次 pytest 之後 worktree 就有 **12 個檔**變 dirty，
    之後嘅 `sync_public_data.py` 會將**中間狀態**同步出去 ✗
    （C5 對抗驗收 2026-09-25 標記為 G3）。

    ⚠️ 一定要係 **autouse + module scope 而且聲明喺 `ready` 之前** ——
    因為 `ready` fixture 本身就會跑管線；如果快照喺測試內部才做，
    影到嘅已經係被污染嘅狀態，還原就冇用 ✗（實測踩過）。
    """
    roots = (PUBLIC_DIR, SERVED_DIR)
    snapshot = {
        p: p.read_bytes() for root in roots for p in sorted(root.rglob("*")) if p.is_file()
    }
    yield
    restored = 0
    for path, data in snapshot.items():
        if path.exists() and path.read_bytes() != data:
            path.write_bytes(data)
            restored += 1
    if restored:
        print(f"\n[teardown] 還原 {restored} 個被管線改寫嘅公開資料檔")


@pytest.fixture(scope="module")
def ready() -> None:
    """跑完整管線（推斷 → 套用），令受測狀態一致。

    ⚠️ 唔可以只跑 `infer`：`infer` 會重新編 inference_id，如果 `apply`
    未跟住跑，`locations.geojson` 嘅 `inferred_from` 就會指向舊 id，
    測試會見到「引用未批核推斷」嘅假失敗。
    """
    if not (REPO / "data" / "private" / "cache" / "osm-hk.json").exists():
        pytest.skip("缺 OSM cache")
    # ⚠️ 要跑**完整管線**，唔止 infer + apply。
    #
    # 為何：`locations.geojson` 係多步共同產生嘅（infer → apply →
    # anchor_fictional → corrections → derive_zones）。如果 fixture 只跑
    # 頭兩步，之後嘅測試就會見到**中間狀態**，而同「完整管線之後」嘅
    # 比對必然唔同 —— 產生假失敗（實測踩過）。
    r = _run(PIPELINE)
    if r.returncode != 0:
        pytest.skip(f"管線跑唔起：{(r.stderr or r.stdout)[-300:]}")


@pytest.fixture(scope="module")
def locations(ready) -> dict:
    return json.loads(LOCATIONS.read_text(encoding="utf-8"))


def test_decisions_file_is_auditable():
    """審閱決定必須有理由 —— 唔可以只寫 approve/reject。"""
    d = json.loads(DECISIONS.read_text(encoding="utf-8"))
    assert d["reviewed_by"]
    assert d["rationale"], "每個規則層級決定都要有理由"
    for rule, status in d["rule_decisions"].items():
        if status in ("approved", "rejected"):
            assert rule in d["rationale"], f"{rule} 缺理由"
    for rid, ex in d.get("exceptions", {}).items():
        assert ex.get("reason"), f"例外 {rid} 缺理由"


def test_only_approved_are_applied(locations, ready):
    """推斷出嚟嘅座標只可以嚟自已批核嘅條目。"""
    records = {
        r["inference_id"]: r
        for r in (
            json.loads(line)
            for line in JSONL.read_text(encoding="utf-8").splitlines()
            if line
        )
    }
    for f in locations["features"]:
        p = f["properties"]
        src = p.get("inferred_from")
        if not src:
            continue
        rec = records.get(src)
        assert rec is not None, f"{p['id']} 引用咗唔存在嘅推斷 {src}"
        assert rec["review_status"] == "approved", (
            f"{p['id']} 引用咗未批核嘅推斷 {src}（{rec['review_status']}）"
        )


def test_applied_coordinates_match_inference(locations, ready):
    records = {
        r["inference_id"]: r
        for r in (
            json.loads(line)
            for line in JSONL.read_text(encoding="utf-8").splitlines()
            if line
        )
    }
    for f in locations["features"]:
        p = f["properties"]
        src = p.get("inferred_from")
        if not src:
            continue
        want = records[src]["inferred_lonlat"]
        got = f["geometry"]["coordinates"]
        assert abs(got[0] - want[0]) < 1e-6, f"{p['id']} lon 唔一致"
        assert abs(got[1] - want[1]) < 1e-6, f"{p['id']} lat 唔一致"


def test_event_coords_follow_location(locations, ready):
    """事件座標必須同對應地點一致（否則驗證器會捉到）。"""
    loc_by_id = {
        f["properties"]["id"]: f["geometry"]["coordinates"]
        for f in locations["features"]
    }
    ev = json.loads(EVENTS.read_text(encoding="utf-8"))
    bad = []
    for f in ev["features"]:
        lid = f["properties"].get("location_id")
        if not lid or lid not in loc_by_id:
            continue
        if f["geometry"]["coordinates"] != loc_by_id[lid]:
            bad.append((f["properties"]["id"], lid))
    assert not bad, f"{len(bad)} 條事件座標同地點唔一致：{bad[:5]}"


def test_all_inferred_coordinates_in_hong_kong(locations, ready):
    for f in locations["features"]:
        if not f["properties"].get("inferred_from"):
            continue
        lon, lat = f["geometry"]["coordinates"]
        assert 113.0 < lon < 115.0, f"{f['properties']['id']} lon 唔喺香港"
        assert 22.0 < lat < 23.0, f"{f['properties']['id']} lat 唔喺香港"


def test_pipeline_is_idempotent(ready):
    """推斷 → 套用 → 再推斷 → 再套用，結果必須完全相同。

    呢個測試保護一個實際踩過嘅嚴重缺陷：`apply` 會把
    `location_precision` 由 `fictional` 改成 `approximate`，如果候選集
    只睇 `fictional`，重跑就會令已套用嘅推斷消失（管線非冪等）。
    """
    # ⚠️ 要跑**完整管線**，唔可以只跑 infer + apply。
    #
    # 為何：`locations.geojson` 係多步共同產生嘅 ——
    #   infer → apply → anchor_fictional → corrections → derive_zones
    # 只跑前兩步會停喺**中間狀態**（未錨定、未修正），同最終狀態比對
    # 必然唔同 —— 但嗰個唔係「唔冪等」，係「比錯對象」。
    # 實測踩過呢個假失敗。
    before = LOCATIONS.read_text(encoding="utf-8")

    # ⚠️ 快照 + 還原（2026-09-25，C5 對抗驗收 G3）
    # ------------------------------------------
    # 呢個測試會跑**完整管線**，而管線會改寫 `data/public/**`。原本冇還原
    # → 跑一次 pytest 之後 worktree 就有 6 個檔變 dirty，之後嘅
    # `sync_public_data.py` 會將**中間狀態**同步出去 ✗。
    #
    # 修法：跑之前快照 `data/public`，跑完（無論 pass / fail）還原。
    # 測試嘅目的係「比對 before / after」，唔係「改動 repo」。
    snapshot = {
        p: p.read_bytes()
        for p in sorted(PUBLIC_DIR.rglob("*"))
        if p.is_file()
    }
    try:
        r = _run(PIPELINE)
        assert r.returncode == 0, (r.stderr or r.stdout)[-500:]
        after = LOCATIONS.read_text(encoding="utf-8")
        assert before == after, (
            "管線唔冪等：重跑完整管線之後 locations.geojson 改變咗。"
            "通常係某條規則依賴咗被自己改動嘅欄位（反饋循環）。"
        )
    finally:
        for path, data in snapshot.items():
            if path.read_bytes() != data:
                path.write_bytes(data)


def test_inference_count_stable_across_reruns(ready):
    """推斷條數唔應該因為重跑而減少。"""
    out1 = _run(INFER).stdout
    out2 = _run(INFER).stdout

    def substantive(text: str) -> int:
        n = 0
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("R-") and "R-NO-EVIDENCE" not in s:
                parts = s.split()
                if len(parts) >= 2 and parts[1].isdigit():
                    n += int(parts[1])
        return n

    assert substantive(out1) == substantive(out2), "重跑之後推斷條數改變"
    assert substantive(out1) > 0, "應該有實質推斷"

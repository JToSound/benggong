"""C 項：`characters.json` / `locations.geojson` 可重現性回歸測試。

為何要有呢個檔
==============
Gate 2 遺留項 #2：`scripts/build_public_dataset.py` 係 Phase B 產生器，
輸出之後被下游（`merge_characters.py`）改寫，舊版**每次跑都會無條件覆蓋**
`data/public/**`，造成不可逆損壞：

  - `characters.json` 330 → 344（**遺失 11 個已合併角色**）
  - `locations.geojson` 704 → 629

C 項修復將產生器改為**非破壞性**（已存在嘅公開資產一律保留；`--force` 才覆蓋），
並加 reconcile 對照。本檔係**程式化防回歸**：用沙盒複製一份凍結 `data/public`
再重跑產生器，斷言凍結資產冇被削減。

⚠️ 守門設計（沿用 Gate 2 嘅教訓）
--------------------------------
**唔可以用「數量」做 characters 嘅守門指標** —— 330 → 344 係「數量增加但
內容遺失」。所以本檔對 characters 一律用 **id 集合 hash**；只有 locations
（損壞係數量減少 629 < 704）先用數量。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
CANDIDATES = REPO / "data" / "private" / "evidence" / "candidates.jsonl"

sys.path.insert(0, str(REPO / "scripts"))
import build_public_dataset as bpd  # noqa: E402

#: 同 `tests/test_zero_manual_review.py` 一致嘅凍結 id 錨（單一真相來源：
#: 兩個檔各自持有同一 hash；若果改咗錨，兩個測試會一齊紅，唔會靜默走樣）。
FROZEN_CHARACTER_IDS_SHA256 = (
    "834b42f97bc675a063003904e723a9d0b2fc015ecc4c956c7cd525e3cdebeaf1"
)
FROZEN_LOCATIONS_MIN = 704

pytestmark = pytest.mark.skipif(
    not CANDIDATES.exists(),
    reason="需要私有 data/private/evidence/candidates.jsonl（唔喺 CI 環境）",
)


# ---- helpers ----


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _char_ids(path: Path) -> list[str]:
    return sorted(c["id"] for c in _load(path))


def _char_hash(path: Path) -> str:
    return hashlib.sha256("\n".join(_char_ids(path)).encode("utf-8")).hexdigest()


def _loc_ids(path: Path) -> list[str]:
    return [f["properties"]["id"] for f in _load(path)["features"]]


def _run(out_dir: Path, review_dir: Path) -> int:
    """喺沙盒跑產生器（argv 傳空 list，避免食到 pytest 自己嘅 CLI 參數）。"""
    return bpd.main([], out_dir=out_dir, private_review_dir=review_dir)


def _file_digests(root: Path) -> dict[str, str]:
    """產生器擁有嘅公開檔逐個計 sha256（用嚟證明重跑冇改動內容）。"""
    out: dict[str, str] = {}
    for name in bpd.GENERATED_FILES:
        path = root / name
        if path.exists():
            out[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


# ---- fixtures ----


@pytest.fixture(scope="module")
def frozen_rerun(tmp_path_factory):
    """沙盒複製凍結 `data/public`，重跑產生器兩次，捕捉前後狀態。"""
    root = tmp_path_factory.mktemp("c-repro-frozen")
    sandbox = root / "public"
    review = root / "review"
    shutil.copytree(PUBLIC, sandbox)

    before_chars = _char_hash(sandbox / "characters.json")
    before_char_ids = set(_char_ids(sandbox / "characters.json"))
    before_loc_ids = set(_loc_ids(sandbox / "locations.geojson"))
    before_digests = _file_digests(sandbox)

    assert _run(sandbox, review) == 0, "第一次重跑產生器失敗"
    after1 = {
        "char_hash": _char_hash(sandbox / "characters.json"),
        "char_ids": set(_char_ids(sandbox / "characters.json")),
        "loc_ids": set(_loc_ids(sandbox / "locations.geojson")),
        "digests": _file_digests(sandbox),
    }

    assert _run(sandbox, review) == 0, "第二次重跑產生器失敗"
    after2 = {
        "char_hash": _char_hash(sandbox / "characters.json"),
        "char_ids": set(_char_ids(sandbox / "characters.json")),
        "loc_ids": set(_loc_ids(sandbox / "locations.geojson")),
    }

    report = _load(review / "dataset-reconciliation.json")
    return {
        "before_chars": before_chars,
        "before_char_ids": before_char_ids,
        "before_loc_ids": before_loc_ids,
        "before_digests": before_digests,
        "after1": after1,
        "after2": after2,
        "report": report,
    }


@pytest.fixture(scope="module")
def provisional_build(tmp_path_factory):
    """空目錄 provisional build —— 確認 builder 功能冇被「非破壞性」改壞。"""
    root = tmp_path_factory.mktemp("c-repro-provisional")
    out = root / "public"
    review = root / "review"
    assert _run(out, review) == 0
    return out


# ---- 主斷言：重跑唔可以削減凍結資產 ----


def test_rerun_preserves_frozen_character_id_hash(frozen_rerun):
    """重跑之後 characters id 集合 hash **不變**（同 FROZEN 錨一致）。

    ⚠️ 呢個就係 Gate 2 教訓嘅落實：唔用數量（344 > 330 會漏），用 id 集合 hash。
    """
    assert frozen_rerun["before_chars"] == FROZEN_CHARACTER_IDS_SHA256, (
        "測試前提唔成立：現況 characters.json 已經唔係凍結版本，請先還原。"
    )
    assert frozen_rerun["after1"]["char_hash"] == FROZEN_CHARACTER_IDS_SHA256, (
        "重跑產生器之後 characters id 集合已變（疑似又變返破壞性覆蓋）。"
        f"實際 {len(frozen_rerun['after1']['char_ids'])} 條。"
    )


def test_rerun_preserves_every_frozen_character_id(frozen_rerun):
    """逐個 id 檢查：重跑**唔可以**令任何凍結角色消失（即 11 個已合併角色）。"""
    lost = frozen_rerun["before_char_ids"] - frozen_rerun["after1"]["char_ids"]
    assert not lost, f"重跑之後有 {len(lost)} 個凍結角色 id 消失：{sorted(lost)[:5]}"


def test_rerun_does_not_shrink_locations(frozen_rerun):
    """locations.geojson 唔可以縮水（凍結 704；產生器 provisional 只出 629）。"""
    assert len(frozen_rerun["after1"]["loc_ids"]) >= FROZEN_LOCATIONS_MIN, (
        f"重跑之後 locations 縮到 {len(frozen_rerun['after1']['loc_ids'])} 條"
        f"（預期 >= {FROZEN_LOCATIONS_MIN}）"
    )
    lost = frozen_rerun["before_loc_ids"] - frozen_rerun["after1"]["loc_ids"]
    assert not lost, f"重跑之後有 {len(lost)} 個凍結 location id 消失：{sorted(lost)[:5]}"


def test_rerun_is_idempotent(frozen_rerun):
    """連續重跑兩次結果完全一致（idempotent）。"""
    assert frozen_rerun["after1"]["char_hash"] == frozen_rerun["after2"]["char_hash"]
    assert frozen_rerun["after1"]["loc_ids"] == frozen_rerun["after2"]["loc_ids"]


def test_rerun_preserves_all_generator_owned_files(frozen_rerun):
    """產生器擁有嘅六個公開檔，重跑後內容要同凍結版本**逐 byte 一樣**。

    呢個係最強嘅非破壞性斷言：唔止 id 集合，連檔案內容都冇被改寫。
    """
    for name in bpd.GENERATED_FILES:
        assert name in frozen_rerun["before_digests"], f"凍結資產應該有 {name}"
        assert (
            frozen_rerun["before_digests"][name] == frozen_rerun["after1"]["digests"][name]
        ), f"重跑改動咗 {name}（預設應該原封不動保留）"


# ---- reconcile 報告：root cause 可驗證 ----


def test_reconcile_report_identifies_absorbed_merged_names(frozen_rerun):
    """reconcile 報告要指出「provisional 名 = 凍結別名」＝已被下游合併嘅角色。

    Gate 2 講「遺失 11 個已合併角色」；實測 merge 決定檔有 12 個 from，
    其中 11 個會以獨立記錄重現，另有 3 個 `鳥嘴*` 變體亦已被合併
    → 報告應該捉到 14 個。
    """
    ch = frozen_rerun["report"]["characters"]
    assert ch["baseline_count"] == 330
    assert len(ch["provisional_names_absorbed_by_baseline_aliases"]) == 14, (
        "reconcile 應該指出 14 個已被下游合併嘅名"
    )


def test_reconcile_report_flags_unreproducible_baseline_records(frozen_rerun):
    """凍結資產有、provisional 冇嘅記錄要如實報告（呢啲唔可以由輸入重現）。"""
    ch = frozen_rerun["report"]["characters"]
    # 實測：凍結有一條 `老師`（provisional 只出到 `鳥嘴老師`）→ 唔可以重算得到。
    assert len(ch["baseline_only_ids"]) == 1
    assert len(ch["provisional_unmatched_new_names"]) == 1


# ---- builder 功能保留 ----


def test_provisional_build_still_writes_full_dataset(provisional_build):
    """空目錄時產生器仍然要寫齊全部 dataset（唔可以因為加咗守門而變 no-op）。"""
    for fname in (
        "locations.geojson",
        "events.geojson",
        "routes.geojson",
        "timeline.json",
        "characters.json",
        "asset-manifest.json",
    ):
        assert (provisional_build / fname).exists(), fname
    chars = _load(provisional_build / "characters.json")
    assert len(chars) == 344, "provisional characters 應該係 344（未合併狀態）"
    assert len(_loc_ids(provisional_build / "locations.geojson")) == 629


def test_provisional_build_is_deterministic(provisional_build, tmp_path_factory):
    """同一批輸入跑兩次，provisional 輸出 id 集合要完全一樣（deterministic）。"""
    out2 = tmp_path_factory.mktemp("c-repro-prov2") / "public"
    review2 = out2.parent / "review"
    assert _run(out2, review2) == 0
    assert _char_ids(provisional_build / "characters.json") == _char_ids(out2 / "characters.json")
    assert _loc_ids(provisional_build / "locations.geojson") == _loc_ids(
        out2 / "locations.geojson"
    )


def test_provisional_reintroduces_merged_names(provisional_build):
    """root cause 指紋：provisional 會令已合併角色以獨立記錄重現。

    呢個係「為何唔可以無條件覆蓋凍結 `characters.json`」嘅直接證據。
    """
    names = {c["name"] for c in _load(provisional_build / "characters.json")}
    for merged_name in ("我母親", "敘述者", "德蘭教主", "阿達尼"):
        assert merged_name in names, (
            f"provisional 應該重現已合併角色「{merged_name}」（證明覆蓋會令佢哋返生）"
        )

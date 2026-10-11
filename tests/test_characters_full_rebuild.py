"""C 項全鏈重建：把「重建 → 殘餘偏差」鎖成**可重跑斷言**。

為何要有呢個檔
==============
`characters.json` **唔可以由現時輸入完整重現** —— 呢個結論喺 Gate 2
（`docs/progress/gate-2-zero-manual-review.md` §3.2：「再套用 merge_characters
決定 → 333（仍然差 3）」）同 C 項報告（`c-characters-reproducibility.md` §2.3）
都實測過，但**兩次都係一次性人手量度** → 冇守衛。

本檔將佢變成**永久守衛**：如果將來有人改咗輸入／決定檔／產生器，
令殘餘**增加**或者**改變形狀**，呢度會即刻變紅。

⚠️ 刻意**唔**斷言「id 集合相同」—— 因為實測**唔可能**（輸入 skew）。
斷言嘅係「殘餘＝**已知嘅 4＋1**，而且每一條都有解釋」。
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
CANDIDATES = REPO / "data" / "private" / "evidence" / "candidates.jsonl"
DECISIONS = REPO / "data" / "private" / "review" / "character-merge-decisions.json"
FROZEN = REPO / "data" / "public" / "characters.json"

sys.path.insert(0, str(REPO / "scripts"))
import build_public_dataset as bpd  # noqa: E402
import verify_characters_rebuild as vcr  # noqa: E402

#: 同 `tests/test_characters_reproducibility.py` 一致嘅凍結 id 錨
#: （⚠️ 兩檔各自持有同一個 hash —— 改咗錨就會兩邊一齊紅，唔會靜默走樣）。
FROZEN_CHARACTER_IDS_SHA256 = (
    "834b42f97bc675a063003904e723a9d0b2fc015ecc4c956c7cd525e3cdebeaf1"
)

pytestmark = pytest.mark.skipif(
    not (CANDIDATES.exists() and DECISIONS.exists()),
    reason="需要私有 data/private/（candidates.jsonl ＋ 合併決定檔）—— 唔喺 CI 環境",
)


def _frozen() -> list[dict]:
    return json.loads(FROZEN.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def rebuilt() -> dict[str, list[dict]]:
    """跑一次產生器嘅**兩條路徑**（預設／已合併）—— 全部喺沙盒。"""
    out: dict[str, list[dict]] = {}
    with tempfile.TemporaryDirectory(prefix="bg-fullrebuild-") as td:
        tmp = Path(td)
        for tag, dec in (("default", None), ("merged", DECISIONS)):
            d = tmp / tag
            d.mkdir(parents=True, exist_ok=True)
            chars, _tail = vcr.rebuild(d / "public", d / "review", dec)
            out[tag] = chars
    return out


def test_frozen_id_anchor_unchanged() -> None:
    """凍結 `characters.json` 嘅 id 集合 hash 冇變（唯一可靠嘅守門指標）。"""
    ids = sorted(c["id"] for c in _frozen())
    h = hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest()
    assert h == FROZEN_CHARACTER_IDS_SHA256, "凍結資產被改動（或錨要更新）"
    assert len(ids) == 330


def test_generator_default_output_is_unchanged(rebuilt: dict[str, list[dict]]) -> None:
    """⚠️ 契約：**預設**（冇 `--merge-decisions`）輸出仍然係 344。

    呢個鎖住「加咗合併支援**冇**改動預設行為」—— 因為 330 → 344 係
    歷史損壞數字，好多測試同文件都引用佢。
    """
    assert len(rebuilt["default"]) == 344, "預設 provisional 應該仍然係 344（未合併狀態）"


def test_full_chain_rebuild_reaches_merged_state(rebuilt: dict[str, list[dict]]) -> None:
    """⭐ 加咗 `--merge-decisions` 之後，provisional 直接係「已合併」狀態（333）。

    ⚠️ 333 ≠ 330 —— 呢個就係「唔可以由輸入完整重現」嘅實測數字
    （Gate 2 §3.2 亦量到同一個數）。
    """
    assert len(rebuilt["merged"]) == 333


def test_residual_is_exactly_the_documented_set(rebuilt: dict[str, list[dict]]) -> None:
    """⭐⭐ 殘餘＝**已知嘅 4 extra ＋ 1 missing**（唔可以多、唔可以少、唔可以換）。

    ⚠️ 刻意**唔**斷言「id 集合相同」—— 實測**唔可能**（輸入 skew）。
    斷言嘅係「殘餘嘅**形狀**冇變」：名單、數量、以及每條都有解釋。
    """
    led = vcr.build_ledger(rebuilt["merged"], _frozen())

    assert not led["id_sets_equal"], "如果 id 集合竟然相同，就要更新本檔同報告"
    assert [e["name"] for e in led["extra"]] == sorted(vcr.EXPECTED_EXTRA)
    assert [m["id"] for m in led["missing"]] == sorted(vcr.EXPECTED_MISSING)
    assert all(e["expected"] for e in led["extra"])
    assert all(m["expected"] for m in led["missing"])
    assert led["rebuilt_id_hash"] != led["frozen_id_hash"]


def test_residual_classification(rebuilt: dict[str, list[dict]]) -> None:
    """⭐ 4 個 extra 之中 3 個已經係凍結檔嘅 alias（＝本來就應該合併）。

    即係真正「無法重現」嘅只有 **2 條**：
      · `鳥嘴老師`（凍結檔完全冇）
      · `老師`／`ent_40e6666820`（輸入產生唔到）
    """
    led = vcr.build_ledger(rebuilt["merged"], _frozen())
    absorbed = [e["name"] for e in led["extra"] if e["absorbed_as_alias"]]
    unexplained = [e["name"] for e in led["extra"] if not e["absorbed_as_alias"]]

    assert sorted(absorbed) == sorted(["鳥嘴先生", "鳥嘴兄", "鳥嘴弟兄"]), (
        f"預期 3 個已併入 aliases，實測 {absorbed}"
    )
    assert unexplained == ["鳥嘴老師"], f"預期只剩「鳥嘴老師」無法解釋，實測 {unexplained}"


def test_merge_logic_has_a_single_implementation() -> None:
    """⭐ 合併邏輯只可以有一份實作（否則兩套真相會靜默分歧）。

    `merge_characters.py` **唔可以**再自己定義 `build_merge_map` ——
    要由 `character_merge_core` 匯入（同 `build_public_dataset.py` 一樣）。
    """
    core = REPO / "scripts" / "character_merge_core.py"
    assert core.exists(), "缺少共用核心 scripts/character_merge_core.py"
    core_src = core.read_text(encoding="utf-8")
    assert "def build_merge_map(" in core_src
    assert "def merge_records_inplace(" in core_src
    assert "def propagate_references_inplace(" in core_src

    for name in ("merge_characters.py", "build_public_dataset.py"):
        src = (REPO / "scripts" / name).read_text(encoding="utf-8")
        assert "from character_merge_core import" in src, f"{name} 應該用共用核心"
        assert "def build_merge_map(" not in src, f"{name} 唔應該再自己實作 build_merge_map"


def test_ledger_cli_is_rerunnable_and_green() -> None:
    """帳目 CLI 可以重跑，而且 `--fail-on-unexpected` 係綠（殘餘全部已記錄）。"""
    with tempfile.TemporaryDirectory(prefix="bg-ledger-") as td:
        out = Path(td) / "ledger.json"
        r = subprocess.run(
            [
                sys.executable,
                str(REPO / "scripts" / "verify_characters_rebuild.py"),
                "--json",
                str(out),
                "--fail-on-unexpected",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=str(REPO),
        )
        assert r.returncode == 0, f"帳目應該係綠：\n{r.stdout}\n{r.stderr}"
        led = json.loads(out.read_text(encoding="utf-8"))
        assert led["unexpected"] == []
        assert led["rebuilt_count"] == 333
        assert led["frozen_count"] == 330
        assert led["merge_decisions_applied"] is True

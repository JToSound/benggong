"""角色合併「群一致性」守衛 —— 將 C 項殘餘嘅**根因**鎖成可重跑斷言。

為何要有呢個檔
==============
`test_characters_full_rebuild.py` 鎖住「殘餘係幾多」；本檔鎖住「**為咩**」。

2026-10-12 調查發現：`鳥嘴兄`／`鳥嘴先生`／`鳥嘴弟兄`／`鳥嘴老師` 之所以
喺「已合併」重建中變獨立 canonical，唔係輸入 skew，而係上游
`data/private/review/manual-resolutions.json` 嘅 `character_definitions`
（Phase E v17 FINAL）把「鳥嘴」開成**獨立互斥群**（同「主角」群零交集）。

呢個 bug 類別（「定義群同合併決定唔一致」）**唔會**被現有測試捉到 ——
因為現有測試只睇最終殘餘數字。所以本檔針對**根因**設守衛：

  · 群互斥：各 `character_definitions` 群兩兩交集必須為空；
  · 群鍵唔被收納：一個群嘅 key 唔可以出現喺另一個群嘅 alias；
  · 殘餘可閉合：重建出嘅每一條殘餘名，都要喺合併決定有對應 entry。

⚠️ 同其他 C 項測試一樣：需要私有 `data/private/`，唔喺 CI 環境會 skip。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
MANUAL = REPO / "data" / "private" / "review" / "manual-resolutions.json"
DECISIONS = REPO / "data" / "private" / "review" / "character-merge-decisions.json"
CANDIDATES = REPO / "data" / "private" / "evidence" / "candidates.jsonl"

sys.path.insert(0, str(REPO / "scripts"))
import diagnose_merge_groups as dmg  # noqa: E402

pytestmark = pytest.mark.skipif(
    not (MANUAL.exists() and DECISIONS.exists() and CANDIDATES.exists()),
    reason="需要私有 data/private/（manual-resolutions ＋ 合併決定 ＋ candidates）",
)


@pytest.fixture(scope="module")
def report() -> dict:
    return dmg.diagnose()


def test_definition_groups_are_pairwise_disjoint(report: dict) -> None:
    """⭐ `character_definitions` 各群**兩兩交集為空**。

    ⚠️ 如果兩群共享 alias，union-find 就會把它們合埋 —— 即係定義檔
    自相矛盾（寫嘅人以為分開咗，實際冇）。
    """
    assert report["group_overlaps"] == [], (
        f"定義群有交集（會令 union-find 意外合併）：{report['group_overlaps']}"
    )


def test_no_group_key_is_captured_by_another_group(report: dict) -> None:
    """⭐ 冇任何群 key 出現喺**另一個**群嘅 alias 入面。

    呢個係上一條嘅對偶檢查：key 被別人收納 = 「一個名同時做群名同
    別人嘅別名」= 定義矛盾。
    """
    assert report["key_captured"] == [], (
        f"群 key 被其他群收納：{report['key_captured']}"
    )


def test_every_residual_name_is_closable_by_a_decision(report: dict) -> None:
    """⭐⭐ 重建嘅每一條殘餘名，都要喺 `character-merge-decisions.json` 有對應決定。

    ⚠️ 呢個係**收緊**後嘅契約：第四輪補完 4 條「鳥嘴」系列之後，殘餘名係 **0**。
    如果將來又有名因為定義群分裂而彈出，但冇對應合併決定 → 呢度即刻紅。

    ⚠️ 刻意**唔**斷言 `residual_names == []` 嘅**硬編碼**清單 —— 而係斷言
    「殘餘集合嘅每一條都可閉合」。咁樣「殘餘變 0」同「殘餘存在但已閉合」
    兩種健康狀態都過，只有「殘餘存在但**未**閉合」會fail。
    """
    assert report["unclosed_names"] == [], (
        f"有殘餘名冇對應合併決定（＝定義群分裂未閉合）：{report['unclosed_names']}"
    )
    # 第四輪實測：殘餘名應該係 0。
    assert report["residual_names"] == [], (
        f"殘餘名應該係空，實測 {report['residual_names']}"
    )


def test_group_structure_is_consistent(report: dict) -> None:
    """群結構一致（互斥 ＋ 無群鍵衝突）。"""
    assert report["consistent"] is True
    assert report["all_residual_closable"] is True


def test_the_four_bird_beak_names_are_recorded_as_merged(report: dict) -> None:
    """⭐ 「鳥嘴」四個名都要有合併決定（唔可以靜默撤回）。

    呢條鎖住第四輪嘅成果：4 條「鳥嘴」系列決定曾經**唔存在**，令 4 條殘餘
    一直掛住當「已記錄嘅已知限制」。如果有人「清理」咗佢哋，呢度會紅。
    """
    merges = report["decisions_targets"]
    main_from = set(merges.get("主角", []))
    for nm in ("鳥嘴兄", "鳥嘴先生", "鳥嘴弟兄", "鳥嘴老師"):
        assert nm in main_from, f"「{nm}」應該係「主角」嘅合併來源，實測 {sorted(main_from)}"


def test_residual_names_belong_to_the_bird_beak_group(report: dict) -> None:
    """殘餘名（如果仲有）嘅歸屬必須可追溯至定義群 —— 唔可以有「孤兒」殘餘。

    ⚠️ 呢條唔假設殘餘係空；佢檢查嘅係**歸屬完整性**（每一條殘餘都講得出
    屬邊個定義群）。空殘餘 = 平凡通過。
    """
    for r in report["residual_attribution"]:
        assert r["definition_groups"], (
            f"殘餘「{r['name']}」唔屬任何定義群 —— 歸屬不可追溯"
        )


def test_diagnostics_cli_is_rerunnable_and_green() -> None:
    """診斷 CLI 可以重跑，而且 `--fail-on-inconsistent` 係綠。"""
    r = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts" / "diagnose_merge_groups.py"),
            "--fail-on-inconsistent",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(REPO),
    )
    assert r.returncode == 0, f"診斷應該係綠：\n{r.stdout}\n{r.stderr}"
    assert "群兩兩交集（應該 0）：0" in r.stdout
    assert "群鍵被其他群收納（應該 0）：0" in r.stdout


def test_diagnostics_report_is_json_serialisable(report: dict) -> None:
    """診斷報告可以 JSON round-trip（唔可以有 set／Path 等非序列化物件）。"""
    dumped = json.dumps(report, ensure_ascii=False)
    assert json.loads(dumped)["consistent"] is True

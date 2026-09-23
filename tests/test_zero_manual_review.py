"""零人手參與紅線測試（Gate 2）—— 公開元資料文案。

為何要有呢個檔
==============
`AGENTS.md` 有一條最高優先強制規則：

> 🚫 零人手參與（強制）—— 唔要任何人手抽樣覆核，唔要任何人手參與。

而 `data/public/**`（會 deploy 到 GitHub Pages）一度有 332 處面向公眾嘅文案
寫住「待人手審閱」「未經最終人工確認」等字眼（見
`docs/progress/gate-2-preparation.md` §3）。本檔係**程式化防回歸**：
一旦有人喺元資料欄位重新引入呢類字眼，測試即刻變紅。

⚠️⚠️ 為何**只**掃「元資料欄位」白名單，唔掃全文
------------------------------------------------
小說**正文**本身有「人手」一詞（實測）：

  - `chapter-summaries.json`：「今次戰鬥後派出大批人手出來支援。」
  - `chronicle.json`：「佈滿多隻人手製作的花牌」「六個人手貼手搭在一起」

呢啲係**小說正文**，屬版權紅線，**絕對唔可以改**。如果測試掃全文（或者用
裸「人手」做關鍵字），就會誤中正文，令測試**永遠紅**，最終迫使人改小說原文
—— 咁就係最嚴重嘅違規。

所以本檔嘅規則係：
  1. 只檢查 key ∈ `METADATA_KEYS`（`description` / `note` / `banner` /
     `disclaimer` …）之下嘅字串值；
  2. 禁止字眼係**完整詞組**（`人手審閱` / `人工審閱` …），**唔包括**裸「人手」；
  3. 額外加一條**正面斷言**：正文仍然有裸「人手」，證明我哋冇誤刪正文。
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"
PUBLIC_SYNC = REPO / "public" / "data" / "public"
SCHEMAS = REPO / "data" / "schemas"

sys.path.insert(0, str(REPO / "scripts"))
# 由腳本匯入單一真相來源，避免測試同實作各自維護一份字眼清單
from normalize_public_wording import (  # noqa: E402
    FORBIDDEN_RE,
    METADATA_KEYS,
    iter_metadata_strings,
    process,
)

DATA_FILES = sorted(PUBLIC.glob("*.json")) + sorted(PUBLIC.glob("*.geojson"))
SCHEMA_FILES = sorted(SCHEMAS.rglob("*.json"))

#: 明確聲明：呢啲 key 係**正文內容**，永不可掃（版權紅線）
CONTENT_KEYS_NOT_SCANNED = {"summary", "text", "content", "body", "quote", "excerpt", "title"}

#: schema 係**純 JSON**（冇小說正文），所以可以連裸「人手」「審閱」「覆核」都禁。
#: 唔禁裸「人工」係因為「人工智能」等正常詞語會被誤中；但「人工審閱」等
#: 完整詞組仍由 `FORBIDDEN_RE` 覆蓋。呢個 regex 由單一真相來源衍生，避免兩份清單走樣。
SCHEMA_FORBIDDEN_RE = re.compile(FORBIDDEN_RE.pattern + r"|人手|審閱|覆核")


def load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def iter_all_strings(node):
    """遞迴 yield JSON 內**所有**字串值（唔理 key）。

    只用喺 `data/schemas/` —— 該目錄係純 schema 文件，冇小說正文，
    所以可以全文掃描而唔怕誤中版權內容。
    """
    if isinstance(node, dict):
        for value in node.values():
            yield from iter_all_strings(value)
    elif isinstance(node, list):
        for item in node:
            yield from iter_all_strings(item)
    elif isinstance(node, str):
        yield node


def metadata_strings(doc):
    """只 yield 元資料白名單欄位之下嘅字串值。"""
    for _container, _key, value in iter_metadata_strings(doc):
        yield value


# ---- 主斷言：元資料欄位零人手違規 ----


@pytest.mark.parametrize("path", DATA_FILES, ids=lambda p: p.name)
def test_metadata_fields_have_no_manual_review_wording(path):
    """`data/public/**` 元資料欄位唔可以有「人手審閱／人工審閱」等字眼。"""
    offenders = [
        s for s in metadata_strings(load(path)) if FORBIDDEN_RE.search(s)
    ]
    assert not offenders, (
        f"{path.name} 元資料欄位仍有零人手違規字眼：{offenders[:3]}"
    )


def test_synced_copy_also_clean():
    """`public/data/public/**`（前端實際讀取）亦要零違規（兩邊係獨立複本）。"""
    synced = sorted(PUBLIC_SYNC.glob("*.json")) + sorted(PUBLIC_SYNC.glob("*.geojson"))
    assert synced, "public/data/public 應該有同步副本"
    offenders: list[str] = []
    for p in synced:
        offenders += [
            f"{p.name}:{s[:40]}"
            for s in metadata_strings(load(p))
            if FORBIDDEN_RE.search(s)
        ]
    assert not offenders, f"同步副本仍有違規：{offenders[:3]}"


def test_normalizer_reports_clean():
    """正規化腳本對現況應該係 no-op（證明已清理乾淨 + idempotent）。"""
    residual = {}
    for p in DATA_FILES:
        n, errs = process(p, write=False)
        assert not errs, f"{p.name}: {errs}"
        if n:
            residual[p.name] = n
    assert not residual, f"正規化腳本仍偵測到違規：{residual}"


# ---- 正文完整性（正面斷言）：證明冇誤刪小說原文 ----


def test_novel_prose_with_人手_is_preserved():
    """正文「派出大批人手」必須仍然存在（冇被清理波及）。"""
    summaries = (PUBLIC / "chapter-summaries.json").read_text(encoding="utf-8")
    assert "派出大批人手" in summaries, "小說正文『派出大批人手』唔見咗 —— 清理誤中正文！"

    chronicle = (PUBLIC / "chronicle.json").read_text(encoding="utf-8")
    assert "人手" in chronicle, "編年史正文『人手』唔見咗 —— 清理誤中正文！"


def test_bare_人手_is_not_forbidden():
    """偵測器唔可以當裸「人手」係違規 —— 否則會誤中正文。"""
    for prose in (
        "今次戰鬥後派出大批人手出來支援。",
        "佈滿多隻人手製作的花牌、深紅似血的長地毯。",
        "六個人手貼手搭在一起。",
    ):
        assert not FORBIDDEN_RE.search(prose), f"裸「人手」被誤判：{prose}"


def test_content_keys_are_excluded_from_whitelist():
    """白名單唔可以包含正文 key（防呆：日後有人加 key 入白名單會被擋）。"""
    leaked = METADATA_KEYS & CONTENT_KEYS_NOT_SCANNED
    assert not leaked, f"白名單錯誤包含正文 key：{leaked}"


# ---- 產生器源頭防回歸 ----


def test_generator_source_has_no_legacy_wording():
    """產生器（build_public_dataset.py）唔可以再輸出舊違規字眼。"""
    src = (REPO / "scripts" / "build_public_dataset.py").read_text(encoding="utf-8")
    for legacy in (
        "詳情待人手審閱",
        "待人手審閱後逐項指派位置",
        "經人手確認後先建立",
        "未經最終人工確認",
    ):
        assert legacy not in src, f"產生器源頭仍有違規字眼：{legacy}"


# ---- schema 文件防回歸（`data/schemas/` 係純 JSON，可全文掃描） ----


def test_schemas_dir_is_not_empty():
    """防呆：`data/schemas/` 應該有 schema 檔，否則下面嘅參數化測試會空跑。"""
    assert SCHEMA_FILES, "data/schemas 應該有 JSON schema"


@pytest.mark.parametrize("path", SCHEMA_FILES, ids=lambda p: p.name)
def test_schemas_have_no_manual_review_wording(path):
    """`data/schemas/` 全部字串值唔可以有零人手違規字眼。

    同 `data/public/**` 唔同，schema 係**純 JSON 文件**（冇小說正文），
    所以呢度**唔需要**元資料白名單 —— 可以掃所有字串值。
    除咗 `FORBIDDEN_RE` 嘅完整詞組，額外連裸「人手」「審閱」「覆核」都禁。
    """
    offenders = [
        s for s in iter_all_strings(load(path)) if SCHEMA_FORBIDDEN_RE.search(s)
    ]
    assert not offenders, f"{path.name} 仍有零人手違規字眼：{offenders[:3]}"


def test_schema_re_forbids_bare_manual_words():
    """防呆：schema 專用 regex 必須覆蓋裸「人手」「審閱」「覆核」。"""
    for bad in ("待人手審閱", "需人手覆核", "留俾審閱者", "等人手修正"):
        assert SCHEMA_FORBIDDEN_RE.search(bad), f"schema regex 漏咗：{bad}"
    # 唔可以誤中「人工智能」等正常詞語（裸「人工」唔喺禁止清單）
    assert not SCHEMA_FORBIDDEN_RE.search("由人工智能模型抽取"), "誤中『人工智能』"


# ---- 產生器守門：`build_public_dataset.py` 唔可以入管線 ----


def test_build_public_dataset_is_not_in_pipeline():
    """`build_public_dataset.py` 唔應該加入 `run_pipeline.py`。

    佢係 Phase B 產生器，輸出之後被 `merge_characters.py` 改寫，
    **唔可以由現有輸入逐 byte 重現**（凍結 `characters.json` 有一條 `老師`
    係現時 candidates + 私有 review 檔都產生唔到嘅）。C 項修復已經令佢
    預設非破壞性（唔會再 330 → 344 / 704 → 629），但佢本質仍然係
    staging／reconcile 工具，唔係 pipeline step —— 公開資料嘅唯一權威係
    `data/public/**` 經審閱版本。

    ⚠️ 守門用「步驟名單」而唔係「數量」：330 → 344 係**數量增加但內容遺失**，
    所以 `assert len(...) >= 330` 根本捉唔到。
    """
    import run_pipeline

    names = {script for script, _desc in run_pipeline.STEPS}
    offenders = sorted(n for n in names if "build_public_dataset" in n)
    assert not offenders, (
        f"build_public_dataset.py 唔應該加入管線（佢係 staging 工具）：{offenders}"
    )


def test_build_public_dataset_header_has_frozen_warning():
    """產生器檔頭必須保留「歷史損壞」警告 + C 項非破壞性契約（防有人刪走）。

    Gate 2 加嘅係「唔可以跑」警告；C 項修復之後產生器改為非破壞性預設，
    但歷史損壞數字（330/344、704/629）同「唔喺 run_pipeline」仍然要寫住，
    同時要標明新契約（非破壞性 + `--force` 逃生門）。
    """
    src = (REPO / "scripts" / "build_public_dataset.py").read_text(encoding="utf-8")
    assert "唔喺 run_pipeline.py" in src, "檔頭警告唔見咗"
    assert "330" in src and "344" in src, "檔頭警告應該列明 330 → 344 損壞數字"
    assert "704" in src and "629" in src, "檔頭警告應該列明 locations 704 → 629"
    # C 項修復契約
    assert "非破壞性" in src, "檔頭應該標明非破壞性預設（C 項修復契約）"
    assert "--force" in src, "檔頭應該講明 --force 逃生門"


def test_build_public_dataset_default_write_is_non_destructive():
    """產生器預設**唔覆蓋**已存在檔案（`_write_json` 見到檔就 skip）。

    呢個係 C 項修復嘅核心契約：舊版無條件覆蓋令 characters 330 → 344。
    測試用純函式驗證，唔需要真跑產生器。
    """
    import tempfile

    from build_public_dataset import _write_json

    with tempfile.TemporaryDirectory() as d:
        target = Path(d) / "characters.json"
        target.write_text('{"sentinel": true}', encoding="utf-8")
        status = _write_json(target, [{"id": "x"}], force=False)
        assert status == "preserved"
        assert "sentinel" in target.read_text(encoding="utf-8"), "預設唔應該覆蓋"
        # --force 才會覆蓋
        assert _write_json(target, [{"id": "x"}], force=True) == "written"
        assert "sentinel" not in target.read_text(encoding="utf-8")


# ---- 凍結資料守門：`characters.json` id 錨 + `locations.geojson` 數量 ----


#: `data/public/characters.json` 凍結角色 id 集合嘅 sha256
#: （= sha256("\n".join(sorted(ids)))；Gate 2 實測，330 條）。
#:
#: ⚠️ 為何用「id 集合 hash」而**唔**用「數量」：
#:   重跑 `build_public_dataset.py` 會令 characters 由 330 → 344（**數量增加**），
#:   但同時遺失 11 個已合併角色 —— 即「數量增加但內容遺失」。
#:   所以 `assert len >= 330` 根本捉唔到；id 集合一變就即刻變紅。
#: 完整 id 清單見 `artifacts/gate2/characters_id_anchor.json`；
#: 對照用：`git show HEAD:data/public/characters.json`。
FROZEN_CHARACTER_IDS_SHA256 = (
    "834b42f97bc675a063003904e723a9d0b2fc015ecc4c956c7cd525e3cdebeaf1"
)


def test_frozen_character_ids_unchanged():
    """凍結角色 id 集合唔可以變（防有人重跑 Phase B 產生器）。"""
    ids = sorted(c["id"] for c in load(PUBLIC / "characters.json"))
    digest = hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest()
    assert digest == FROZEN_CHARACTER_IDS_SHA256, (
        "characters.json 角色 id 集合已變（疑似重跑咗 build_public_dataset.py："
        f"330 → 344，遺失 11 個已合併角色）。實際 {len(ids)} 條，"
        f"sha256={digest[:16]}…；預期 {FROZEN_CHARACTER_IDS_SHA256[:16]}…。"
        " 對照清單：artifacts/gate2/characters_id_anchor.json"
    )


def test_frozen_locations_count_not_shrunk():
    """`locations.geojson` 唔可以縮水（重跑產生器會由 704 → 629）。

    ⚠️ 呢度用數量係 OK 嘅，因為對 locations 而言損壞係**數量減少**（629 < 704）；
    但 characters 就唔可以用數量（344 > 330，見上面 id 錨測試）。
    """
    feats = load(PUBLIC / "locations.geojson")["features"]
    assert len(feats) >= 704, (
        f"locations.geojson 縮水到 {len(feats)} 條（預期 >= 704）—— "
        "疑似重跑咗 build_public_dataset.py（產生器只出 629）"
    )

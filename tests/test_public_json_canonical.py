"""C 項 —— 公開 JSON 嘅 **byte-level 重建** 契約。

為何要有呢個檔
==============
`characters.json` 嘅「由 `data/private/**` 重算」係**唔可能**嘅（版本 skew，
見 `docs/progress/c-characters-reproducibility.md` §2.3）。所以「byte-level
重建」定義喺**可達成**嘅一層：

    給定已 parse 嘅資料模型，用唯一 canonical 序列化器重出，一定逐 byte 相同。

本檔斷言：
  1. `data/public/**` 每一個 JSON 都係 canonical 形式
     （`json.dumps(ensure_ascii=False, indent=2) + "\\n"`、UTF-8、無 BOM、LF）；
  2. **重建**（`rebuild_public_json.rebuild()`）出嘅 bytes 同已 commit 嘅**逐 byte 一致**；
  3. `public/data/public/**` 鏡像同來源一致；
  4. `characters.json` 嘅結構不變式（排序／唯一／合併乾淨／key 順序）令重建結果**唯一**；
  5. 檢查器**唔係恆真**（餵一個 indent=4 嘅檔案入去要變紅）。

⚠️ 行尾：Windows `core.autocrlf=true` 會 checkout 出 CRLF。canonical 形式係
**LF**（同 git blob 一致），所以比較前一律 `normalize_eol()`。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "data" / "public"

sys.path.insert(0, str(REPO / "scripts"))
import rebuild_public_json as rpj  # noqa: E402


def test_all_public_json_is_canonical() -> None:
    """⭐ 每個公開 JSON 都係唯一 canonical 形式（改過格式就紅）。"""
    bad = []
    for name in rpj.TARGETS:
        r = rpj.check_file(PUBLIC / name)
        if not r["ok"]:
            bad.append(f"{name}: {'；'.join(r['problems'])}")
    assert bad == [], "以下檔案唔係 canonical 形式：\n" + "\n".join(bad)


def test_rebuild_is_byte_identical(tmp_path: Path) -> None:
    """⭐ 重建出嘅 bytes 同已 commit 嘅逐 byte 一致（byte-level 重建）。"""
    written = rpj.rebuild(tmp_path)
    assert written, "至少要重建到一個檔"
    for name in written:
        src = (PUBLIC / name).read_bytes()
        out = (tmp_path / name).read_bytes()
        assert rpj.normalize_eol(out) == rpj.normalize_eol(src), f"{name} 重建唔一致"
        # 重建輸出一定要係純 LF（唔受 core.autocrlf 影響）
        assert b"\r\n" not in out, f"{name} 重建輸出有 CRLF"


def test_rebuild_is_deterministic(tmp_path: Path) -> None:
    """連續兩次重建 → 逐 byte 一致（令「重建」有確定性）。"""
    a = tmp_path / "a"
    b = tmp_path / "b"
    rpj.rebuild(a)
    rpj.rebuild(b)
    for name in rpj.TARGETS:
        pa, pb = a / name, b / name
        if pa.exists() and pb.exists():
            assert pa.read_bytes() == pb.read_bytes(), f"{name} 兩次重建唔一致"


def test_canonical_text_is_idempotent() -> None:
    """canonical 化再 canonical 化 → 不變（固定點）。"""
    doc = json.loads((PUBLIC / "characters.json").read_text(encoding="utf-8"))
    once = rpj.canonical_text(doc)
    twice = rpj.canonical_text(json.loads(once))
    assert once == twice


def test_mirror_matches_source() -> None:
    """⭐ `public/data/public/**` 鏡像同 `data/public/**` 一致。"""
    m = rpj.check_mirror()
    assert m["ok"], "鏡像唔一致：\n" + "\n".join(m["problems"])
    assert m["checked"] > 0, "冇檢查到任何鏡像（測試會空轉）"


def test_characters_invariants() -> None:
    """⭐ `characters.json` 結構不變式 → 重建結果唯一、可稽核。"""
    ci = rpj.check_characters_invariants()
    assert ci["ok"], "不變式違反：\n" + "\n".join(ci["problems"])
    assert ci["count"] > 0


def test_check_is_sensitive(tmp_path: Path) -> None:
    """⭐ 對照：唔係 canonical 形式嘅檔案一定要被判紅（檢查器唔係恆真）。"""
    doc = json.loads((PUBLIC / "characters.json").read_text(encoding="utf-8"))
    # ① indent=4 → 唔係 canonical
    bad1 = tmp_path / "indent4.json"
    bad1.write_text(json.dumps(doc, ensure_ascii=False, indent=4), encoding="utf-8")
    assert rpj.check_file(bad1)["ok"] is False
    # ② 結尾冇換行 → 唔係 canonical
    bad2 = tmp_path / "nonl.json"
    bad2.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    assert rpj.check_file(bad2)["ok"] is False
    # ③ BOM → 唔係 canonical
    bad3 = tmp_path / "bom.json"
    bad3.write_bytes(b"\xef\xbb\xbf" + rpj.canonical_text(doc).encode("utf-8"))
    assert rpj.check_file(bad3)["ok"] is False
    # ④ 正確 canonical → 綠（證明上面唔係恆假）
    good = tmp_path / "good.json"
    good.write_text(rpj.canonical_text(doc), encoding="utf-8", newline="")
    assert rpj.check_file(good)["ok"] is True


def test_cli_exit_codes(tmp_path: Path) -> None:
    """CLI：正常 → exit 0；`--rebuild` 可寫出 byte-identical 檔案。"""
    script = REPO / "scripts" / "rebuild_public_json.py"
    out = tmp_path / "out"
    r = subprocess.run(
        [sys.executable, str(script), "--check", "--rebuild", str(out)],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert r.returncode == 0, f"CLI 應該 exit 0，實測 {r.returncode}\n{r.stdout}\n{r.stderr}"
    assert (out / "characters.json").exists()
    assert rpj.normalize_eol((out / "characters.json").read_bytes()) == rpj.normalize_eol(
        (PUBLIC / "characters.json").read_bytes()
    )

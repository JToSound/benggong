#!/usr/bin/env python3
"""C 項 —— 公開 JSON 嘅 **byte-level 重建** 同 canonical 形式檢查。

背景（為何「重建」唔係「重算」）
================================
`docs/progress/c-characters-reproducibility.md` §2.3 已經證實：凍結
`data/public/characters.json`（330 條）**唔可以由現時 `data/private/**` 重算**
—— 因為 candidate／review 檔同凍結資產之間有**版本 skew**（產生器會出 344 條，
而且含凍結版冇嘅 `鳥嘴老師`；凍結版又有產生器出唔到嘅 `老師`）。
嗰個係**資料層**問題，唔係程式 bug。

所以本工具定義「byte-level 重建」為**可達成而且有意義**嘅一層：

  給定一份 JSON 文件（已 parse 嘅資料模型），用**唯一 canonical 序列化器**
  重新輸出，一定得到**逐 byte 相同**嘅檔案。

呢個保證嘅價值：
  1. 證明 `data/public/**` 冇被任何工具／編輯器用**唔同格式**改過
     （改過就唔會係 canonical 形式）→ 一改就變紅；
  2. 令「重建」有**確定性**：任何經本工具輸出嘅檔案都同已 commit 嘅一樣；
  3. 令 `.gitattributes`／`core.autocrlf` 造成嘅行尾差異**唔會**污染判斷
     （本工具一律以 **LF** 為準，同 git blob 一致）。

Canonical 形式（唯一）
======================
    json.dumps(doc, ensure_ascii=False, indent=2) + "\\n"
    · UTF-8、冇 BOM
    · 行尾一律 LF
    · 結尾一個換行
    · key 順序保留**文件原本**順序（唔 sort_keys —— 欄位順序本身係契約一部分）

用法：
    python scripts/rebuild_public_json.py --check
        → 檢查所有公開 JSON 係唔係 canonical 形式（唔一致 → exit 1）
    python scripts/rebuild_public_json.py --rebuild <dir>
        → 將 canonical bytes 寫入 <dir>（byte-level 重建；唔會改 repo）
    python scripts/rebuild_public_json.py --check --json <report.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC_DIR = REPO / "data" / "public"
MIRROR_DIR = REPO / "public" / "data" / "public"

#: 公開 JSON 檔（順序固定 → 報告穩定）。
TARGETS: list[str] = [
    "characters.json",
    "timeline.json",
    "asset-manifest.json",
    "locations.geojson",
    "events.geojson",
    "routes.geojson",
    "zones.geojson",
]


def canonical_text(doc: object) -> str:
    """**唯一** canonical 序列化：`ensure_ascii=False`、`indent=2`、結尾一個 `\\n`。"""
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def normalize_eol(data: bytes) -> bytes:
    """行尾一律 LF（`core.autocrlf=true` 會喺 Windows checkout 出 CRLF）。"""
    return data.replace(b"\r\n", b"\n")


def first_diff(a: str, b: str) -> int:
    """回傳第一個唔同嘅字元 index（冇就回 -1）。"""
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return -1 if len(a) == len(b) else n


def check_file(path: Path) -> dict:
    """檢查一個檔案係唔係 canonical 形式。"""
    res: dict = {"file": path.name, "path": str(path), "ok": True, "problems": []}
    if not path.exists():
        res["ok"] = False
        res["problems"].append("檔案唔存在")
        return res
    raw = path.read_bytes()
    res["bytes"] = len(raw)
    if raw[:3] == b"\xef\xbb\xbf":
        res["problems"].append("有 UTF-8 BOM")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:  # pragma: no cover - 保險
        res["ok"] = False
        res["problems"].append(f"唔係合法 UTF-8：{exc}")
        return res
    if not raw.endswith(b"\n"):
        res["problems"].append("結尾冇換行")
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        res["ok"] = False
        res["problems"].append(f"唔係合法 JSON：{exc}")
        return res
    norm = normalize_eol(raw).decode("utf-8")
    canon = canonical_text(doc)
    if norm != canon:
        i = first_diff(norm, canon)
        res["problems"].append(
            f"唔係 canonical 形式（第一處差異喺字元 {i}："
            f"實際 {norm[i : i + 12]!r} vs 預期 {canon[i : i + 12]!r}）"
        )
    res["ok"] = not res["problems"]
    return res


def check_mirror() -> dict:
    """`public/data/public/**` 要同 `data/public/**` 逐 byte 一致（忽略行尾）。"""
    res: dict = {"ok": True, "problems": [], "checked": 0}
    for name in TARGETS:
        src = PUBLIC_DIR / name
        mir = MIRROR_DIR / name
        if not src.exists():
            continue
        if not mir.exists():
            res["ok"] = False
            res["problems"].append(f"{name}：鏡像唔存在（{mir.relative_to(REPO)}）")
            continue
        res["checked"] += 1
        if normalize_eol(src.read_bytes()) != normalize_eol(mir.read_bytes()):
            res["ok"] = False
            res["problems"].append(f"{name}：鏡像同來源唔一致")
    return res


def check_characters_invariants() -> dict:
    """`characters.json` 嘅結構不變式（令「重建」嘅結果唯一、可稽核）。"""
    res: dict = {"ok": True, "problems": [], "count": 0}
    p = PUBLIC_DIR / "characters.json"
    if not p.exists():
        res["ok"] = False
        res["problems"].append("characters.json 唔存在")
        return res
    chars = json.loads(p.read_text(encoding="utf-8"))
    res["count"] = len(chars)
    ids = [c.get("id") for c in chars]
    names = [c.get("name") for c in chars]
    if len(set(ids)) != len(ids):
        res["ok"] = False
        res["problems"].append("有重複 id")
    if ids != sorted(ids):
        res["ok"] = False
        res["problems"].append("記錄冇按 id 排序（重建次序唔唯一）")
    if len(set(names)) != len(names):
        res["ok"] = False
        res["problems"].append("有重複 canonical name")
    # 合併不變式：任何 alias 唔應該同時係另一條記錄嘅 canonical name
    aliases = {a for c in chars for a in c.get("aliases", [])}
    clash = sorted(set(names) & aliases)
    if clash:
        res["ok"] = False
        res["problems"].append(f"alias 同 canonical name 撞（合併未做乾淨）：{clash[:10]}")
    # key 順序要一致（欄位順序係契約一部分）
    orders = {tuple(c.keys()) for c in chars}
    if len(orders) > 1:
        res["ok"] = False
        res["problems"].append(f"記錄嘅 key 順序唔一致（{len(orders)} 種）")
    return res


def rebuild(dest_dir: Path) -> list[str]:
    """將所有目標嘅 **canonical bytes** 寫入 `dest_dir`（唔改 repo）。

    回傳寫咗嘅檔名。呢個就係「byte-level 重建」嘅實作。
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for name in TARGETS:
        src = PUBLIC_DIR / name
        if not src.exists():
            continue
        doc = json.loads(src.read_text(encoding="utf-8"))
        (dest_dir / name).write_text(canonical_text(doc), encoding="utf-8", newline="")
        written.append(name)
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description="公開 JSON canonical 形式檢查 / byte-level 重建")
    ap.add_argument("--check", action="store_true", help="檢查 canonical 形式（預設）")
    ap.add_argument("--rebuild", metavar="DIR", help="將 canonical bytes 寫入 DIR")
    ap.add_argument("--json", help="將報告寫入呢個檔案")
    ap.add_argument("--skip-mirror", action="store_true", help="唔檢查鏡像")
    args = ap.parse_args()

    report: dict = {"files": [], "mirror": None, "characters_invariants": None}

    print("=== 公開 JSON canonical 形式檢查 ===")
    ok = True
    for name in TARGETS:
        r = check_file(PUBLIC_DIR / name)
        report["files"].append(r)
        mark = "✅" if r["ok"] else "❌"
        extra = "" if r["ok"] else "  " + "；".join(r["problems"])
        print(f"  {mark} {name}{extra}")
        ok = ok and r["ok"]

    if not args.skip_mirror:
        m = check_mirror()
        report["mirror"] = m
        print(f"  鏡像：{'✅ 一致' if m['ok'] else '❌ ' + '；'.join(m['problems'])}")
        ok = ok and m["ok"]

    ci = check_characters_invariants()
    report["characters_invariants"] = ci
    print(
        f"  characters 不變式：{'✅' if ci['ok'] else '❌ ' + '；'.join(ci['problems'])}"
        f"（{ci['count']} 條）"
    )
    ok = ok and ci["ok"]

    if args.rebuild:
        written = rebuild(Path(args.rebuild))
        print(f"\n已重建 {len(written)} 個檔 → {args.rebuild}")

    if args.json:
        Path(args.json).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"報告：{args.json}")

    print("\n" + ("✅ 全部通過" if ok else "❌ 有問題（見上）"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

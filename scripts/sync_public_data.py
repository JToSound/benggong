#!/usr/bin/env python3
"""把 `data/public/` 同步到 `public/data/public/`（前端實際讀取嘅位置）。

為何需要呢一步
==============
`data/public/` 係**資料嘅來源**（builder 寫入、驗證器檢查、audit 掃描），
但前端係由 `public/data/public/` 讀取（Vite 嘅 `publicDir` 預設係 `public/`，
build 時原樣複製到 `dist/`）。兩者係**兩個獨立嘅複本**。

⚠️ 實測踩過（嚴重）
------------------
`public/data/public/` 停留喺 **9 月 5 日**，而 `data/public/` 已經改咗好多：
`fictional` 精度地點由 543 減到 327、事件角色連結由 0 加到 1,501、
時間線排序修正、路線座標修正……**全部冇喺地圖上出現過**。

而且**所有閘門都通過** —— 因為：
  - `validate_public_data.py` 檢查 `data/public/`
  - `audit_release.py` 比對 `asset-manifest.json` 同 `data/public/`
  - 兩者都唔會發現 `public/data/public/` 係舊嘅

即係「驗證綠燈但成品係舊嘅」—— 呢個係最危險嘅一類缺陷。

所以：
  1. 呢支腳本係建置嘅**必要步驟**（已接入 `npm run build`）
  2. 加咗測試檢查兩邊一致

用法：
    python scripts/sync_public_data.py --check   # 只檢查，唔一致就 exit 1
    python scripts/sync_public_data.py           # 同步
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "data" / "public"
DST = REPO / "public" / "data" / "public"
#: Vite 嘅建置產物。`vite build` 會將 `public/` 複製過去，但實測**唔一定
#: 每次都更新** —— 用戶就係因此讀到舊資料（見下面 check_dist）。
DIST = REPO / "dist" / "data" / "public"

#: 需要同步嘅檔（副檔名過濾，避免複製到暫存檔）
PATTERNS = ("*.json", "*.geojson")


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(root: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for pat in PATTERNS:
        for p in root.glob(pat):
            out[p.name] = p
    return out


def diff() -> tuple[list[str], list[str], list[str]]:
    """回傳 (要複製/更新, 目標多出, 兩邊一致)。"""
    src, dst = collect(SRC), collect(DST)
    to_copy = [
        n for n, p in src.items()
        if n not in dst or sha256(p) != sha256(dst[n])
    ]
    extra = [n for n in dst if n not in src]
    same = [n for n in src if n in dst and sha256(src[n]) == sha256(dst[n])]
    return sorted(to_copy), sorted(extra), sorted(same)


def check_dist() -> tuple[list[str], list[str]]:
    """檢查 `dist/data/public/` 同來源一唔一致（如果 dist 存在）。

    ⚠️ 為何一定要檢查 dist
    ----------------------
    用戶喺 `localhost:5174`（測試用 preview server，serve `dist/`）見到
    「載入 locations.geojson 時收到 HTML 而唔係 JSON」。

    根因：`dist/data/public/` 停留喺舊版本，而 `public/data/public/` 已經
    更新。`vite build` 理論上會複製 `public/` → `dist/`，但實測**唔一定
    每次都更新**（`dist/index.html` 係新嘅，但 `dist/data/public/*` 係舊嘅）。

    所以同步檢查要覆蓋**兩層**：來源 → `public/` → `dist/`。
    """
    if not DIST.exists():
        return [], []
    src, dst = collect(SRC), collect(DIST)
    stale = [n for n, p in src.items() if n not in dst or sha256(p) != sha256(dst[n])]
    missing = [n for n in src if n not in dst]
    return sorted(stale), sorted(missing)


def main() -> int:
    ap = argparse.ArgumentParser(description="同步 data/public → public/data/public")
    ap.add_argument("--check", action="store_true", help="只檢查，唔一致就 exit 1")
    args = ap.parse_args()

    if not SRC.exists():
        print(f"來源唔存在：{SRC}", file=sys.stderr)
        return 2

    to_copy, extra, same = diff()
    print(f"來源 {SRC}")
    print(f"目標 {DST}")
    print(f"  一致：{len(same)}　要更新：{len(to_copy)}　目標多出：{len(extra)}")
    if to_copy:
        for n in to_copy:
            print(f"    更新 {n}")
    if extra:
        for n in extra:
            print(f"    多出 {n}（唔會刪，請人手確認）")

    if args.check:
        bad = bool(to_copy)
        if to_copy:
            print(
                "\n❌ public/data/public 唔一致 —— 前端會讀到舊資料。"
                "請跑 python scripts/sync_public_data.py",
                file=sys.stderr,
            )
        dist_stale, dist_missing = check_dist()
        if dist_stale or dist_missing:
            bad = True
            print(
                f"\n❌ dist/data/public 唔一致（{len(dist_stale)} 個唔同、"
                f"{len(dist_missing)} 個缺失）—— preview server 會讀到舊資料。"
                "請跑 npm run build",
                file=sys.stderr,
            )
            for n in dist_stale[:8]:
                print(f"    {n}", file=sys.stderr)
        if bad:
            return 1
        print("\n✅ 兩層都一致")
        return 0

    DST.mkdir(parents=True, exist_ok=True)
    for n in to_copy:
        shutil.copy2(SRC / n, DST / n)
    print(f"\n已同步 {len(to_copy)} 個檔")

    # 同步之後即刻覆核（唔可以只信 shutil）
    to_copy2, _, _ = diff()
    if to_copy2:
        print(f"❌ 同步之後仍然唔一致：{to_copy2}", file=sys.stderr)
        return 1

    dist_stale, dist_missing = check_dist()
    if dist_stale or dist_missing:
        print(
            f"\n⚠️ dist/data/public 有 {len(dist_stale)} 個檔同來源唔一致。"
            "Vite 應該會喺 build 時複製過去 —— 如果 build 之後仍然唔一致，"
            "請跑 npm run clean 再 build。"
        )
    print("✅ 覆核通過")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

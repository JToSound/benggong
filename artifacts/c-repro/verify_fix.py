#!/usr/bin/env python3
"""C 項修復驗證：沙盒重跑產生器，確認凍結公開資產唔會被削減。

步驟：
  1. 複製 `data/public` → 沙盒目錄（模擬「已有凍結資產」）
  2. 記低 characters id hash / locations 條數
  3. 用沙盒做 out_dir 重跑 `build_public_dataset.main()`
  4. 再對照 → 應完全一致（idempotent、無損）
  5. 再跑第二次 → 亦要一致
另外亦跑一次「空目錄」provisional build，確認 builder 功能仍然存在。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import build_public_dataset as bpd  # noqa: E402

FROZEN = "834b42f97bc675a063003904e723a9d0b2fc015ecc4c956c7cd525e3cdebeaf1"


def char_hash(path: Path) -> str:
    doc = json.loads(path.read_text(encoding="utf-8"))
    ids = sorted(c["id"] for c in doc)
    return hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest()


def loc_count(path: Path) -> int:
    return len(json.loads(path.read_text(encoding="utf-8"))["features"])


def run(out_dir: Path, review_dir: Path) -> int:
    import contextlib
    import io

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        rc = bpd.main(out_dir=out_dir, private_review_dir=review_dir)
    if rc != 0:
        print(buf.getvalue())
    return rc


def main() -> int:
    # ⚠️ 唔可以 rmtree（環境 deny 批量刪檔）——每次用新目錄名，唔需要清理。
    tmp = REPO / "artifacts" / "c-repro" / f"sandbox-{time.time_ns()}"
    sandbox = tmp / "public"
    review = tmp / "review"
    shutil.copytree(REPO / "data" / "public", sandbox)

    before_hash = char_hash(sandbox / "characters.json")
    before_locs = loc_count(sandbox / "locations.geojson")
    print(f"[before] characters hash={before_hash[:16]}… locs={before_locs}")

    assert run(sandbox, review) == 0, "第一次重跑失敗"
    after1_hash = char_hash(sandbox / "characters.json")
    after1_locs = loc_count(sandbox / "locations.geojson")
    print(f"[after#1] characters hash={after1_hash[:16]}… locs={after1_locs}")

    assert run(sandbox, review) == 0, "第二次重跑失敗"
    after2_hash = char_hash(sandbox / "characters.json")
    after2_locs = loc_count(sandbox / "locations.geojson")
    print(f"[after#2] characters hash={after2_hash[:16]}… locs={after2_locs}")

    ok = (
        before_hash == after1_hash == after2_hash == FROZEN
        and before_locs == after1_locs == after2_locs
    )
    print(f"\n重跑無損 + idempotent + == FROZEN：{'✅ PASS' if ok else '❌ FAIL'}")

    rec = json.loads((review / "dataset-reconciliation.json").read_text(encoding="utf-8"))
    ch = rec["characters"]
    lo = rec["locations"]
    # ⚠️ 完整報告含實體名 → 只可以留喺私有目錄。artifacts/ 會 commit，
    #    所以呢度只寫**唔含名稱**嘅摘要（counts + ids）。
    summary = {
        "characters": {
            "baseline_count": ch["baseline_count"],
            "provisional_count": ch["provisional_count"],
            "common_count": ch["common_count"],
            "baseline_only_ids": ch["baseline_only_ids"],
            "provisional_only_ids": ch["provisional_only_ids"],
            "absorbed_count": len(ch["provisional_names_absorbed_by_baseline_aliases"]),
            "unmatched_count": len(ch["provisional_unmatched_new_names"]),
        },
        "locations": {
            "baseline_count": lo["baseline_count"],
            "provisional_count": lo["provisional_count"],
            "baseline_id_scheme": lo["baseline_id_scheme"],
            "baseline_only_names_count": len(lo["baseline_only_names"]),
            "provisional_only_names_count": len(lo["provisional_only_names"]),
        },
    }
    (REPO / "artifacts" / "c-repro" / "reconciliation-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        f"[reconcile] 凍結 {ch['baseline_count']} / provisional {ch['provisional_count']}"
        f" / 會被覆蓋消失 {len(ch['baseline_only_ids'])}"
        f" / 未審閱新實體 {len(ch['provisional_only_ids'])}"
        f" / 已被下游合併 {len(ch['provisional_names_absorbed_by_baseline_aliases'])}"
    )

    # provisional build（空目錄）仍然可以完整產生
    prov = tmp / "provisional"
    prov.mkdir(parents=True, exist_ok=True)
    assert run(prov, review) == 0, "provisional build 失敗"
    prov_chars = json.loads((prov / "characters.json").read_text(encoding="utf-8"))
    prov_locs = loc_count(prov / "locations.geojson")
    print(f"[provisional] characters={len(prov_chars)} locs={prov_locs}（builder 功能保留）")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

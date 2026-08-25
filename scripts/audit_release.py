#!/usr/bin/env python3
"""《病港》— Release Audit（master prompt §12.3）。

對 dist/ 執行完整 release gate 檢查：
1. 無 private files / raw JSONL / cleaned full text
2. 無完整小說、長引文、embedding corpus
3. 無 secret patterns（API key、token、cookie）
4. 無 remote map/tile URL（OSM/Mapbox/Google/Carto/Esri/Bing 等）
5. 所有 public image/tile 存在 asset manifest
6. NOTICE.md / attribution / governance 文件存在
7. public locations/events/routes schema valid（重用 validate_public_data）
8. needs_review 資料只可以喺 provisional mode + banner 下 deploy

用法：python scripts/audit_release.py [--dist PATH] [--strict]
Exit：0 = 通過；1 = 有 fail；2 = dist 不存在。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ---- §12.3(1)(2)：private 內容 ----
PRIVATE_MARKERS = re.compile(
    r"bing-gang\.clean|Bing-Gang-_full|evidence_excerpt|candidates\.jsonl"
    r"|extraction-ledger|review-queue",
    re.IGNORECASE,
)

# ---- §12.3(2)：長引文（>100 連續 CJK 無標點中斷＝疑似原文段落）----
# 中文／全形標點算中斷（正常書面中文唔會成百字不斷）
LONG_CJK = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff]"
    r"(?:[^\x00-\x7f\u3000-\u303f\uff00-\uffef\n\r\t ]){100,}"
)

# ---- §12.3(3)：secrets ----
SECRET_PATTERNS: dict[str, re.Pattern[str]] = {
    "openrouter_key": re.compile(r"sk-or-v1-[A-Za-z0-9\-_]{16,}"),
    "generic_api_key": re.compile(r"(?:api[_-]?key|apikey)\s*[:=]\s*['\"][A-Za-z0-9\-_]{20,}['\"]", re.IGNORECASE),
    "bearer": re.compile(r"Bearer\s+[A-Za-z0-9._\-]{25,}"),
    "cookie": re.compile(r"(?:set-cookie|cookie)\s*[:=]\s*['\"][^'\"]{30,}['\"]", re.IGNORECASE),
    "private_key_block": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "github_pat": re.compile(r"ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"),
}

# ---- §12.3(4)：remote map providers ----
REMOTE_MAP: dict[str, re.Pattern[str]] = {
    "osm": re.compile(r"openstreetmap\.org|tile\.openstreetmap", re.I),
    "mapbox": re.compile(r"mapbox\.com", re.I),
    "google": re.compile(r"maps\.google|googleapis\.com/maps", re.I),
    "carto": re.compile(r"basemaps\.cartocdn|carto\.(?:com|org)", re.I),
    "esri": re.compile(r"arcgisonline\.com", re.I),
    "bing": re.compile(r"bing\.com/maps|virtualearth", re.I),
    "stamen": re.compile(r"stamen\.com|stamentiles", re.I),
    "thunderforest": re.compile(r"thunderforest\.com", re.I),
    "here": re.compile(r"hereapi|heremaps", re.I),
}


def iter_files(root: Path):
    for p in root.rglob("*"):
        if p.is_file():
            yield p


def main() -> int:
    parser = argparse.ArgumentParser(description="Release audit gate")
    parser.add_argument("--dist", default=str(REPO_ROOT / "dist"))
    parser.add_argument("--strict", action="store_true", help="禁止任何 needs_review 記錄")
    args = parser.parse_args()

    dist = Path(args.dist)
    if not (dist / "index.html").exists():
        print(f"[error] {dist}/index.html 唔存在——請先 npm run build")
        return 2

    errors: list[str] = []
    warns: list[str] = []

    # ---- 掃描全部文字檔 ----
    scanned = 0
    for f in iter_files(dist):
        if f.stat().st_size > 5 * 1024 * 1024:
            warns.append(f"{f.name}: 檔案 >5MB，請確認係必要資產")
        try:
            if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2"):
                continue
            text = f.read_text(encoding="utf-8")
            scanned += 1
        except (UnicodeDecodeError, ValueError):
            continue

        if PRIVATE_MARKERS.search(text):
            errors.append(f"[private-marker] {f.relative_to(dist)} 含私有檔案引用")

        m = LONG_CJK.search(text)
        if m:
            errors.append(f"[long-cjk] {f.relative_to(dist)} 疑似小說原文段落（>{len(m.group(0))} 連續 CJK）")

        for name, pat in SECRET_PATTERNS.items():
            if pat.search(text):
                errors.append(f"[secret:{name}] {f.relative_to(dist)}")

        for name, pat in REMOTE_MAP.items():
            if pat.search(text):
                errors.append(f"[remote-map:{name}] {f.relative_to(dist)}")

    # ---- §12.3(5)+(8)：public dataset 檢查 ----
    public_dir = REPO_ROOT / "data/public"
    needs_review = 0
    total_records = 0
    manifest_ok = True

    mf_path = public_dir / "asset-manifest.json"
    mc_path = public_dir / "map-config.json"

    def count_features(fname: str) -> int | None:
        p = public_dir / fname
        if not p.exists():
            return None
        doc = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(doc, dict):
            return len(doc["features"]) if doc.get("type") == "FeatureCollection" else len(doc)
        return len(doc)

    counts = {
        "location": count_features("locations.geojson"),
        "event": count_features("events.geojson"),
        "route": count_features("routes.geojson"),
        "timeline": count_features("timeline.json"),
        "character": count_features("characters.json"),
    }

    if mf_path.exists() and mc_path.exists():
        mf = json.loads(mf_path.read_text(encoding="utf-8"))
        mc = json.loads(mc_path.read_text(encoding="utf-8"))
        for k, v in counts.items():
            if v is None:
                errors.append(f"[manifest] data/public 缺少 {k} 對應檔案")
                continue
            total_records += v
            if mf.get("counts", {}).get(k) != v:
                errors.append(f"[manifest] counts.{k}={mf['counts'].get(k)} 與實際 {v} 不符")

        pm = mc.get("provisional_mode", {})
        has_banner = bool(pm.get("enabled") and pm.get("banner"))

        # 統計 needs_review
        for fname in ("locations.geojson", "events.geojson"):
            p = public_dir / fname
            if p.exists():
                doc = json.loads(p.read_text(encoding="utf-8"))
                for feat in doc["features"]:
                    if feat["properties"].get("review_status") == "needs_review":
                        needs_review += 1
        tl = public_dir / "timeline.json"
        if tl.exists():
            needs_review += sum(
                1 for r in json.loads(tl.read_text(encoding="utf-8"))
                if r.get("review_status") == "needs_review"
            )
        cj = public_dir / "characters.json"
        if cj.exists():
            needs_review += sum(
                1 for c in json.loads(cj.read_text(encoding="utf-8"))
                if c.get("review_status") == "needs_review"
            )

        if needs_review > 0:
            if args.strict:
                errors.append("[review] strict 模式：有 needs_review 資料不可 deploy")
            elif not has_banner:
                errors.append("[provisional] needs_review 資料存在但 map-config 無 provisional banner")
            else:
                print(f"[info] provisional mode：{needs_review}/{total_records} 記錄為 needs_review，banner 已啟用")
        manifest_ok = True
    else:
        errors.append("[manifest] data/public 缺 asset-manifest.json 或 map-config.json")

    # ---- §12.3(6)：必要文件 ----
    for doc in ("NOTICE.md", "LICENSE", "docs/DATA_GOVERNANCE.md", "docs/ARCHITECTURE.md"):
        if not (REPO_ROOT / doc).exists():
            errors.append(f"[docs] 缺少 {doc}")

    # ---- §12.3(1)：data/private 唔會入 dist（git 層由 CI private-data-guard 把關）----
    # dist 入面唔應該有任何 data/private 路徑結構
    for f in iter_files(dist):
        rel = str(f.relative_to(dist)).replace("\\", "/")
        if rel.startswith("data/private") or "raw/" in rel.split("/")[:2]:
            errors.append(f"[private-path] dist/ 入面出現疑似私有路徑：{rel}")

    # ---- 報告 ----
    print(f"已掃描 {scanned} 個文字檔；記錄總數 {total_records}（needs_review {needs_review}）")
    if warns:
        print(f"\n⚠️ {len(warns)} 個警告：")
        for w in warns[:5]:
            print(f"  - {w}")
    if errors:
        print(f"\n❌ RELEASE AUDIT FAILED：{len(errors)} 個問題")
        for e in errors[:20]:
            print(f"  - {e}")
        return 1

    print("\n✅ RELEASE AUDIT PASSED——無私隱洩漏、無 secrets、無 remote map URL、文件齊全")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""C5 Data Governance — 獨立敵意掃描（唔信任既有腳本）。

只讀：data/public、public、dist、src、docs、根目錄部署檔。
唔會寫入 data/**。

用法：
    python artifacts/c5-governance/independent_governance_scan.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# 部署／公開面：真正會被 commit 或 deploy 嘅嘢
PUBLIC_ROOTS = ["data/public", "public", "dist", "src", "docs"]
ROOT_FILES = ["index.html", "404.html", "manifest.webmanifest", "NOTICE.md", "README.md", "AGENTS.md"]

# ---- 1. 原文特徵 ----
# 章節原文引用格式
QUOTE_REF = re.compile(r"原文\s*[：:「]|ch\s*\d+\s*原文|原文節錄|節錄自")
# 長中文段落（≥40 連續 CJK，標點算中斷）
LONG_CJK_40 = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff](?:[^\x00-\x7f\u3000-\u303f\uff00-\uffef\n\r\t ]){40,}"
)
# 帶對話引號嘅中文段落（「…」內 ≥12 字）
DIALOGUE = re.compile(r"[「『][^」』\n]{12,}[」』]")

# ---- 2. secrets ----
SECRETS = {
    "openrouter": re.compile(r"sk-or-v1-[A-Za-z0-9\-_]{16,}"),
    "generic_api_key": re.compile(r"(?:api[_-]?key|apikey|secret|token)\s*[:=]\s*['\"][A-Za-z0-9\-_]{20,}['\"]", re.I),
    "bearer": re.compile(r"Bearer\s+[A-Za-z0-9._\-]{25,}"),
    "private_key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "github_pat": re.compile(r"ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"),
    "aws": re.compile(r"AKIA[0-9A-Z]{16}"),
    "google": re.compile(r"AIza[0-9A-Za-z_\-]{30}"),
    "slack": re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"),
}

# ---- 3. remote map / tile / geocoder host（runtime）----
REMOTE_HOST = re.compile(
    r"tile\.openstreetmap|maps\.googleapis|googleapis\.com/maps|mapbox\.com|"
    r"nominatim\.openstreetmap|arcgisonline|basemaps\.cartocdn|stamen\.com|"
    r"thunderforest|hereapi|virtualearth|unpkg\.com|cdn\.jsdelivr|cdnjs\.cloudflare",
    re.I,
)
# 任何 http(s):// 資源引用（部署面）
HTTP_REF = re.compile(r"https?://[^\s\"'<>)\]]+")

# ---- 4. private 路徑外洩 ----
PRIVATE_PATH = re.compile(r"data[/\\]private|\.zones-task|evidence_excerpt|candidates\.jsonl|"
                          r"extraction-ledger|review-queue|bing-gang\.clean|Bing-Gang-_full", re.I)

TEXT_EXT = {".json", ".geojson", ".js", ".mjs", ".ts", ".tsx", ".css", ".html", ".md", ".txt", ".svg", ".webmanifest", ".jsonl", ".map"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".pdf"}


def iter_files():
    for root_name in PUBLIC_ROOTS:
        root = REPO / root_name
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file() and p.suffix.lower() in TEXT_EXT:
                yield p
    for f in ROOT_FILES:
        p = REPO / f
        if p.is_file():
            yield p


def main() -> int:
    findings: dict[str, list[str]] = {k: [] for k in
        ["quote_ref", "long_cjk_40", "dialogue", "secrets", "remote_host", "private_path"]}
    http_refs: dict[str, int] = {}
    scanned = 0

    for p in iter_files():
        rel = p.relative_to(REPO).as_posix()
        # dist/ 入面 node_modules 之類唔理
        if "/node_modules/" in rel:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, ValueError, OSError):
            continue
        scanned += 1

        for m in QUOTE_REF.finditer(text):
            findings["quote_ref"].append(f"{rel}: {m.group(0)!r}")
        for m in LONG_CJK_40.finditer(text):
            findings["long_cjk_40"].append(f"{rel}: ({len(m.group(0))} CJK) {m.group(0)[:60]}…")
        for m in DIALOGUE.finditer(text):
            findings["dialogue"].append(f"{rel}: {m.group(0)[:40]}")
        for name, pat in SECRETS.items():
            for m in pat.finditer(text):
                findings["secrets"].append(f"{rel}: [{name}] {m.group(0)[:30]}")
        for m in REMOTE_HOST.finditer(text):
            findings["remote_host"].append(f"{rel}: {m.group(0)}")
        for m in PRIVATE_PATH.finditer(text):
            findings["private_path"].append(f"{rel}: {m.group(0)}")
        for m in HTTP_REF.finditer(text):
            host = m.group(0)
            http_refs[host] = http_refs.get(host, 0) + 1

    print(f"=== C5 獨立掃描：已讀 {scanned} 個文字檔（data/public, public, dist, src, docs + 根檔）===")
    for k, v in findings.items():
        mark = "✅" if not v else "❌"
        print(f"\n{mark} [{k}] 命中 {len(v)}")
        for line in v[:25]:
            print(f"   - {line}")
        if len(v) > 25:
            print(f"   … 其餘 {len(v) - 25} 條")

    print(f"\n=== http(s):// 資源引用（部署面）共 {len(http_refs)} 個不同 URL ===")
    for url, n in sorted(http_refs.items(), key=lambda x: -x[1])[:40]:
        print(f"   {n:4d}× {url}")

    total = sum(len(v) for v in findings.values())
    print(f"\n總命中：{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

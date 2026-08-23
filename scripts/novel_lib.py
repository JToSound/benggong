"""《病港》互動地圖 — Python pipeline 共用套件。

Phase A：提供清理規則（versioned noise rules）同共用工具函式，
俾 clean_novel.py / validate_novel.py / tests 共用，確保單一事實來源。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

# ---- Pipeline 版本標記（寫入所有 manifest / report）----
SCHEMA_VERSION = "1.0.0"
CLEAN_RULES_VERSION = "clean-rules-v1"

REQUIRED_FIELDS = ("story", "issue_index", "chapter_num", "url", "content", "word_count")

# ============================================================
# Versioned cleaning rules — 只移除高度明確嘅 Penana 污染字串。
# 經實測校準（見 docs/progress/phase-0-and-a.md）：
# - PENANA 為全半形混合（PＥNAＮＡ / ＰＥＮＡＮＡ），必須容納。
# - 「喜歡」「分享」「展開」等常為正文，一律唔可以刪。
# ============================================================

# 全半形混合嘅 PENANA 字樣
_PENANA = r"[PＰ][EＥ][NＮ][AＡ][NＮ][AＡ]"

# 行首防盜聲明：No Plagiarism!<token>posted on PＥNAＮＡ
RE_NO_PLAGIARISM_HEAD = re.compile(
    rf"No Plagiarism![A-Za-z0-9]+posted on {_PENANA}", re.IGNORECASE
)

# 行內：6174Please respect copyright.ＰＥＮＡＮＡ<token>
RE_RESPECT_INLINE = re.compile(
    rf"\d*Please respect copyright\.{_PENANA}[A-Za-z0-9]+"
)

# 行內：1234 copyright protection6170ＰＥＮＡＮＡ<token> 尼
RE_PROTECTION_INLINE = re.compile(
    rf"\d{{1,5}} copyright protection\d*{_PENANA}[A-Za-z0-9]+(?:\s+尼)?"
)

# 兜底：任何殘餘 copyright protection 句式
RE_COPYRIGHT_LEFTOVER = re.compile(
    rf"\d{{0,6}}\s*copyright protection\d*{_PENANA}[A-Za-z0-9]+"
)

# 獨立成行嘅 IP（footer 起點錨點）
RE_IP_LINE = re.compile(r"^\s*\d{1,3}(?:\.\d{1,3}){3}\s*$", re.MULTILINE)

# ns223.122.76.172da2 形態
RE_NS_DA = re.compile(r"\bns\d{1,3}(?:\.\d{1,3}){3}\s*da\d*\b")

# 讀者名單結尾：And 68 More
RE_AND_MORE = re.compile(r"And\s+\d+\s+More\s*$", re.IGNORECASE)

# 結尾純數字行（reader counts：\n0\n36 或 \n32）
RE_TRAILING_COUNT_LINES = re.compile(r"(?:\n\s*\d{1,6}\s*){1,2}\Z")


@dataclass
class CleanStats:
    """單章清理統計。"""

    issue_index: int
    raw_chars: int = 0
    clean_chars: int = 0
    removed_head_noise: int = 0
    removed_inline_noise: int = 0
    removed_footer: int = 0
    footer_truncated: bool = False
    trailing_count_removed: bool = False
    warnings: list[str] = field(default_factory=list)


def clean_content(content: str, stats: CleanStats | None = None) -> str:
    """清理一章正文。

    規則次序：
    1. 移除行首 No Plagiarism 宣告。
    2. 截斷 reader-interaction footer（由最後一行獨立 IP 行開始）。
       注意：「喜歡」等詞常出現於正文，絕不可作截斷錨點。
    3. 移除結尾純數字 reader-count 行（最多兩行）。
    4. 移除行內 Penana 版權雜訊（保留其餘正文）。
    5. 連續空行壓成一個空行。
    """
    stats = stats or CleanStats(issue_index=-1)
    text = content.strip()
    stats.raw_chars = len(text)

    # 1) 行首宣告
    m = RE_NO_PLAGIARISM_HEAD.match(text)
    if m:
        text = text[m.end():].lstrip()
        stats.removed_head_noise += m.end()

    # 2) Footer 截斷：由最後一行「獨立 IP」開始全部截走，
    #    但只限 IP 行之後嘅內容符合 reader-footer 特徵
    #    （有 ns..da.. token 或者 And N More 名單結尾），
    #    避免誤刪正文中段嘅疑似 IP 數字行。
    ip_matches = list(RE_IP_LINE.finditer(text))
    if ip_matches:
        last = ip_matches[-1]
        after = text[last.end():]
        if RE_NS_DA.search(after) or RE_AND_MORE.search(after):
            stats.removed_footer = len(text) - last.start()
            stats.footer_truncated = True
            text = text[:last.start()]

    # 3) 結尾純數字行
    new_text = RE_TRAILING_COUNT_LINES.sub("", text).rstrip()
    if new_text != text:
        stats.trailing_count_removed = True
        stats.removed_footer += len(text) - len(new_text)
        text = new_text

    # 4) 行內雜訊
    for pattern in (
        RE_NO_PLAGIARISM_HEAD,
        RE_RESPECT_INLINE,
        RE_PROTECTION_INLINE,
        RE_COPYRIGHT_LEFTOVER,
        RE_NS_DA,
    ):
        new_text, _n = pattern.subn("", text)
        stats.removed_inline_noise += len(text) - len(new_text)
        text = new_text

    # 5) 連續空行壓成一個空行
    text = re.sub(r"\n{3,}", "\n\n", text)

    stats.clean_chars = len(text.strip())
    return text.strip()


def compute_word_count(content: str) -> int:
    """規格指定嘅計字方式：移除所有空白後計字符數。"""
    return len(re.sub(r"[\s\n\r]+", "", content))


def sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_jsonl(path: Path) -> list[dict]:
    """Parse JSONL；回傳物件清單，並以 _line_no 標記行號。"""
    rows: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"第 {i} 行 JSON parse 失敗：{e}") from e
            if not isinstance(obj, dict):
                raise ValueError(f"第 {i} 行唔係 JSON 物件")
            obj["_line_no"] = i
            rows.append(obj)
    return rows


def validate_raw_row(obj: dict) -> list[str]:
    """檢查原始 row 必要欄位；回傳錯誤訊息清單。"""
    errors = []
    for field_name in REQUIRED_FIELDS:
        if field_name not in obj:
            errors.append(f"缺少必要欄位 {field_name}")
    return errors

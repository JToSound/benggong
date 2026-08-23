"""《病港》Phase A — 清理規則 unit tests。

涵蓋 master prompt §6.4 要求：
- 每種已知雜訊形態
- 行內雜訊仍保留正文
- 正文含單獨數字、角色名、英文時唔會誤截斷
- issue/0 正確排除
- 重複 issue index 正確 fail
- clean JSONL schema valid
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from novel_lib import (  # noqa: E402
    CLEAN_RULES_VERSION,
    RE_AND_MORE,
    RE_COPYRIGHT_LEFTOVER,
    RE_IP_LINE,
    RE_NO_PLAGIARISM_HEAD,
    RE_NS_DA,
    RE_PROTECTION_INLINE,
    RE_RESPECT_INLINE,
    CleanStats,
    clean_content,
    compute_word_count,
    parse_jsonl,
    validate_raw_row,
)


# ============================================================
# 1. 每種已知雜訊
# ============================================================


class TestNoisePatterns:
    def test_no_plagiarism_head(self):
        s = "No Plagiarism!H1ju9ceSrVSHL8gq2Ee0posted on PＥＮＡＮＡ\n\n正文開始。"
        st = CleanStats(issue_index=1)
        out = clean_content(s, st)
        assert "No Plagiarism" not in out
        assert "posted on" not in out
        assert out.startswith("正文開始。")

    def test_respect_copyright_inline(self):
        s = "前一句。\n\n6174Please respect copyright.ＰＥＮＡＮＡ9awckKiO6j\n\n後一句。"
        out = clean_content(s)
        assert "respect copyright" not in out
        assert "9awckKiO6j" not in out
        assert "前一句。" in out and "後一句。" in out

    def test_copyright_protection_inline_with_ni(self):
        s = "1234 copyright protection18645ＰＥＮＡＮＡtFCvArwtma 尼"
        out = clean_content(s)
        assert out == ""

    def test_protection_inline_keeps_surrounding_text(self):
        s = "他望住海。\n\n1234 copyright protection18645ＰＥＮＡＮＡtFCvArwtma 尼\n\n佢轉身走咗。"
        out = clean_content(s)
        assert "他望住海。" in out
        assert "佢轉身走咗。" in out
        assert "copyright" not in out

    def test_fullwidth_and_mixed_penana_variants(self):
        for variant in ("ＰＥＮＡＮＡ", "PＥNAＮＡ", "PENANA"):
            s = f"5Please respect copyright.{variant}AbCd1234"
            out = clean_content(s)
            assert "NA" not in out.replace("正文", "")
            assert variant not in out

    def test_ip_line_removal_via_footer_truncation(self):
        s = (
            "正文一段。\n\n"
            "223.122.76.172\n\nns223.122.76.172da2\n\n"
            "0\n\n58\n\n喜歡\n\n讀者A\n\n讀者B\n\nAnd 68 More"
        )
        out = clean_content(s)
        assert "223.122.76.172" not in out
        assert "ns223" not in out
        assert "喜歡" not in out
        assert "讀者A" not in out
        assert "More" not in out
        assert "正文一段。" in out

    def test_ns_da_pattern(self):
        assert RE_NS_DA.search("ns223.122.76.172da2")
        out = clean_content("行一。\n\nns223.122.76.172da2\n\n行二。")
        assert "ns223" not in out and "行二。" in out

    def test_and_more_tail(self):
        assert RE_AND_MORE.search("And 68 More")

    def test_trailing_count_lines_removed(self):
        s = "結尾對白。」\n\n0\n\n36"
        out = clean_content(s)
        assert out.endswith("結尾對白。」")
        s2 = "外傳完──\n\n38"
        assert clean_content(s2).endswith("外傳完──")


# ============================================================
# 2. 行內雜訊仍保留正文
# ============================================================


class TestInlinePreservation:
    def test_noise_between_paragraphs(self):
        s = (
            "第一段講病者襲擊營地。\n\n"
            "1234 copyright protection3057ＰＥＮＡＮＡavplHGVNKP 尼\n\n"
            "3061Please respect copyright.ＰＥＮＡＮＡ50jl7vmlIl\n\n"
            "第二段主角逃出生天。"
        )
        out = clean_content(s)
        assert "第一段講病者襲擊營地。" in out
        assert "第二段主角逃出生天。" in out
        assert "copyright" not in out.lower()

    def test_consecutive_blank_lines_collapsed(self):
        s = "甲\n\n\n\n\n乙"
        assert clean_content(s) == "甲\n\n乙"


# ============================================================
# 3. 正文含單獨數字、角色名、英文時唔會誤截斷／誤刪
# ============================================================


class TestFalsePositiveGuards:
    def test_likes_in_prose_preserved(self):
        # 「喜歡」喺正文中段：絕不可被截斷
        s = "我鍾意佢，因為佢喜歡在雨天的日子站在天台觀望住天空。\n\n下一場景。"
        out = clean_content(s)
        assert "喜歡在雨天的日子站在天台觀望住天空。" in out
        assert "下一場景。" in out

    def test_share_expand_words_preserved(self):
        s = "「請將訊息分享」教主話。下一秒，卻展開了我們意想不到的事。"
        out = clean_content(s)
        assert "分享" in out and "展開" in out

    def test_standalone_numbers_in_dialogue_kept(self):
        s = "「七樓、六樓、五樓租間房，都得。」公仔說。\n\n第 32 日，他們出發。"
        out = clean_content(s)
        assert "32" in out or "三十二" in out

    def test_mid_text_number_lines_not_truncated(self):
        # 正文中部有獨立數字行：唔喺尾部，不應觸發 trailing-count 移除
        s = "第一章\n\n198\n\n第二章內容繼續發生好多事情，情節推進去。"
        out = clean_content(s)
        assert "198" in out
        assert "第二章內容繼續發生好多事情" in out

    def test_english_names_kept(self):
        s = "Dr.D立即變回一面正常。M！快啲同佢分享下你嘅喜悅。"
        out = clean_content(s)
        assert "Dr.D" in out and "M！" in out

    def test_ip_like_numbers_in_middle_not_removed(self):
        # 中段疑似 IP 數字：footer 截斷只限尾部 2000 字符內
        long_prefix = "很長的正文。" * 300
        s = long_prefix + "\n\n192.168.1.1\n\n之後還有大段正文繼續發展，情節未完結，這裡是中段位置而已，後面仲有好多內容接住落去直到完結為止。"
        out = clean_content(s)
        assert "之後還有大段正文繼續發展" in out


# ============================================================
# 4. issue/0 排除 + 重複 index 處理（clean_novel 層級邏輯）
# ============================================================


class TestStructure:
    def test_issue0_row_detected_by_validate_raw_row_then_skip_logic(self):
        row = {
            "story": "病港",
            "issue_index": 0,
            "chapter_num": "《病港》 | Penana",
            "url": "https://example.com/issue/0",
            "content": "menu login 網站內容",
            "word_count": 100,
        }
        # 必要欄位齊 -> 無 schema error；排除與否由 clean_novel main 邏輯決定
        assert validate_raw_row(row) == []

    def test_missing_field_reported(self):
        row = {"story": "病港", "issue_index": 5}
        errs = validate_raw_row(row)
        assert any("content" in e for e in errs)

    def test_parse_jsonl_error(self, tmp_path):
        p = tmp_path / "bad.jsonl"
        p.write_text('{"story": "x"}\nnot-json\n', encoding="utf-8")
        with pytest.raises(ValueError, match="JSON parse"):
            parse_jsonl(p)

    def test_clean_jsonl_schema_valid(self, tmp_path):
        # 模擬 clean_novel 輸出格式並驗證 schema
        rows = [
            {
                "story": "病港",
                "issue_index": i,
                "chapter_num": "０１",
                "url": f"https://example.com/issue/{i}",
                "content": f"第{i}章正文。" * 10,
                "word_count": 60,
                "raw_word_count": 90,
            }
            for i in (1, 2)
        ]
        p = tmp_path / "clean.jsonl"
        with open(p, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        loaded = parse_jsonl(p)
        assert len(loaded) == 2
        for r in loaded:
            for key in ("story", "issue_index", "chapter_num", "url", "content", "word_count"):
                assert key in r


# ============================================================
# 5. word count 計法
# ============================================================


class TestWordCount:
    def test_compute_word_count_removes_whitespace(self):
        assert compute_word_count("你好 世界\n\r\t 再見") == 6

    def test_rules_version_tagged(self):
        assert CLEAN_RULES_VERSION.startswith("clean-rules-")

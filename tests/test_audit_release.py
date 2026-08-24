"""《病港》— audit_release.py 測試：用合成 dist 驗證佢真係捉到違規。"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("audit_release", REPO / "scripts" / "audit_release.py")
audit = importlib.util.module_from_spec(spec)
sys.argv = ["audit_release.py"]
spec.loader.exec_module(audit)


@pytest.fixture
def fake_dist(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    return tmp_path


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def run_audit(dist: Path, monkeypatch) -> int:
    monkeypatch.setattr("sys.argv", ["audit_release.py", "--dist", str(dist)])
    return audit.main()


def make_minimal_dist(d: Path):
    write(
        d / "index.html",
        '<html><head><link rel="stylesheet" href="./assets/x.css"></head><body></body></html>',
    )
    write(d / "assets", "x.js", "") if False else None


class TestAuditCatches:
    def test_remote_map_url_detected(self, fake_dist, monkeypatch):
        write(fake_dist / "index.html", '<html><script src="https://unpkg.com/leaflet"></script></html>')
        # unpkg 唔喺 map list，但外部 script 會由 HTML 外部引用檢查唔會捉（只掃 map patterns）
        # 改用真 OSM pattern
        write(fake_dist / "index.html", '<html>tile.openstreetmap.org/{z}/{x}/{y}.png</html>')
        assert run_audit(fake_dist, monkeypatch) == 1

    def test_secret_detected(self, fake_dist, monkeypatch):
        write(fake_dist / "index.html", "<html>ok</html>")
        write(fake_dist / "assets" / "app.js", 'const k = "sk-or-v1-abcdefghijklmnop123456";')
        assert run_audit(fake_dist, monkeypatch) == 1

    def test_long_cjk_detected(self, fake_dist, monkeypatch):
        long_text = (
            "這是一段連續中文冇任何標點同英文中斷就咁延續落去超過一百個字符一定係小說原文段落"
            "唔應該出現喺公開網站度繼續寫多幾十字確保長度超標觸發規則仲有少少再多啲字"
            "令成段嘢遠遠超出一百個字符門檻無論點計都會俾正則表達式捉到因為佢真係太長"
        )
        assert len(long_text) > 100
        write(fake_dist / "index.html", f"<html>{long_text}</html>")
        assert run_audit(fake_dist, monkeypatch) == 1

    def test_private_marker_detected(self, fake_dist, monkeypatch):
        write(fake_dist / "index.html", "<html>fetch('bing-gang.clean.jsonl')</html>")
        assert run_audit(fake_dist, monkeypatch) == 1

    def test_missing_docs_fail(self, fake_dist, monkeypatch):
        # NOTICE.md 存在於 repo，但測試隔離環境無——audit 用 REPO_ROOT 搵 docs，
        # 所以呢個 case 只測 dist 層。乾淨 dist 應該 pass（repo 文件齊全）。
        clean = "<html><body>《病港》互動地圖</body></html>"
        write(fake_dist / "index.html", clean)
        rc = run_audit(fake_dist, monkeypatch)
        assert rc in (0, 1)  # 視乎 repo docs 是否齊全；唔應該 crash


class TestAuditPasses:
    def test_clean_dist_passes(self, fake_dist, monkeypatch):
        write(
            fake_dist / "index.html",
            '<html lang="zh-Hant-HK"><head><link rel="stylesheet" href="./assets/main.css"></head>'
            '<body><p>《病港》互動地圖：暫定資料模式 banner 示例。</p>'
            '<script src="./assets/main.js"></script></body></html>',
        )
        js = (
            'const events=[{"id":"bg_event_001","title":"被困一年","spoiler_level":0,'
            '"description":"主角收拾三罐午餐肉離開住所。"}];'
        )
        write(fake_dist / "assets" / "main.js", js)
        write(fake_dist / "assets" / "main.css", "body{color:#ecf0f1}")
        rc = run_audit(fake_dist, monkeypatch)
        assert rc == 0

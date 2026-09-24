#!/usr/bin/env python3
"""將編年史匯出為 PNG（時期統計 + 章節時間軸 + 伏筆網絡）。

為何用 Python 而唔係前端 canvas
==============================
前端要渲染 DOM 做 PNG 需要 `html2canvas`（新依賴，~50KB）。
但呢個專案嘅原則係**完全離線、零 runtime 依賴**。

而 Python 側已經有 PIL（本專案多支離線匯出 script 用緊），所以用
伺服器端渲染更符合專案原則，而且可以生成更精緻嘅圖（唔受限於 DOM）。

輸出：
    docs/assets/chronicle-summary.png

用法：
    python scripts/export_chronicle_png.py
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
CHRONICLE = REPO / "data" / "public" / "chronicle.json"
OUT = REPO / "docs" / "assets" / "chronicle-summary.png"

W, H = 1600, 900
BG = (18, 20, 24)
FG = (232, 234, 237)
MUTED = (140, 146, 156)
GRID = (44, 48, 56)

#: 時期 → （顯示名、顏色）。顏色同前端 CSS 保持一致。
PERIODS = [
    ("pre_outbreak", "爆發前", (167, 139, 250)),
    ("outbreak", "病毒爆發", (217, 83, 79)),
    ("early", "爆發初期", (232, 150, 63)),
    ("basecamp", "大本營時期", (45, 212, 191)),
    ("lohas", "康城時期", (96, 165, 250)),
    ("endgame", "終局", (239, 68, 68)),
]
COLOR = {k: c for k, _, c in PERIODS}
LABEL = {k: n for k, n, _ in PERIODS}


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """搵一個支援中文嘅字體；搵唔到就退到預設（會顯示唔到中文）。"""
    for name in ("msyh.ttc", "msyh.ttf", "simhei.ttf", "NotoSansCJK-Regular.ttc"):
        for base in (r"C:\Windows\Fonts", "/usr/share/fonts", "/System/Library/Fonts"):
            p = Path(base) / name
            if p.exists():
                try:
                    return ImageFont.truetype(str(p), size)
                except OSError:
                    continue
    return ImageFont.load_default()


def main() -> int:
    doc = json.loads(CHRONICLE.read_text(encoding="utf-8"))
    entries = doc["entries"]

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title = load_font(34)
    f_sub = load_font(17)
    f_body = load_font(19)
    f_small = load_font(14)

    # ---- 標題 ----
    d.text((50, 40), "《病港》第一季編年史", font=f_title, fill=FG)
    total = len(entries)
    fb = sum(1 for e in entries if e.get("flashback"))
    fs = sum(len(e.get("foreshadows", [])) for e in entries)
    n_loc = sum(1 for e in entries if e.get("location_name"))
    d.text(
        (50, 88),
        f"{total} 條事件　·　{fb} 條回帶　·　{fs} 對伏筆關係　·　{n_loc} 條有地點",
        font=f_sub, fill=MUTED,
    )

    # ---- 時期統計（左欄）----
    counts: dict[str, int] = {}
    for e in entries:
        lab = e["story_time"]["label"]
        counts[lab] = counts.get(lab, 0) + 1
    d.text((50, 140), "時期分佈", font=f_body, fill=FG)
    y = 180
    max_n = max(counts.values()) if counts else 1
    bar_w = 420
    for key, name, color in PERIODS:
        n = counts.get(name, 0)
        d.text((50, y), name, font=f_body, fill=FG)
        d.text((250, y + 3), f"{n}", font=f_small, fill=MUTED)
        w = int(bar_w * n / max_n) if max_n else 0
        d.rectangle([(310, y + 4), (310 + w, y + 24)], fill=color)
        y += 42

    # ---- 章節時間軸（下方）----
    tx, ty, tw, th = 50, 500, W - 100, 200
    d.text((tx, ty - 34), "章節時間軸（高度＝該章事件數，顏色＝時期）", font=f_body, fill=FG)

    per_ch: dict[int, tuple[int, str | None]] = {}
    max_ch = 0
    for e in entries:
        c = e["first_mention_chapter"]
        max_ch = max(max_ch, c)
        n, lab = per_ch.get(c, (0, None))
        per_ch[c] = (n + 1, lab or e["story_time"]["label"])
    max_n_ch = max((v[0] for v in per_ch.values()), default=1)

    if max_ch:
        bw = tw / max_ch
        for c in range(1, max_ch + 1):
            if c not in per_ch:
                continue
            n, lab = per_ch[c]
            h = max(3, int(th * n / max_n_ch))
            x0 = tx + (c - 1) * bw
            x1 = x0 + max(1.5, bw - 1)
            key = next((k for k, name, _ in PERIODS if name == lab), None)
            d.rectangle([(x0, ty + th - h), (x1, ty + th)],
                        fill=COLOR.get(key or "", MUTED))
        # 軸線 + 標籤
        d.line([(tx, ty + th), (tx + tw, ty + th)], fill=GRID, width=2)
        for c in (1, max_ch // 2, max_ch):
            x = tx + (c - 0.5) * bw
            d.line([(x, ty + th), (x, ty + th + 6)], fill=GRID)
            d.text((x - 18, ty + th + 10), f"ch{c}", font=f_small, fill=MUTED)

    # ---- 圖例 ----
    lx, ly = 50, 760
    for key, name, color in PERIODS:
        d.rectangle([(lx, ly), (lx + 16, ly + 16)], fill=color)
        d.text((lx + 24, ly), name, font=f_small, fill=MUTED)
        lx += 24 + int(len(name) * 16) + 30

    d.text((50, H - 42), "病港互動地圖　·　原創資料集　·　CC BY-NC-SA 4.0",
           font=f_small, fill=(90, 96, 106))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"已匯出 {OUT}（{OUT.stat().st_size / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

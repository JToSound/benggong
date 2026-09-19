#!/usr/bin/env python3
"""編年史伏筆分析圖（樞紐排行 + 關係網絡）。

為何要獨立於 `export_chronicle_png.py`
=====================================
`export_chronicle_png.py` 出嘅係**總覽圖**（時期分佈 + 時間軸）。
呢個腳本出嘅係**伏筆分析圖**，回答兩個問題：

1. **邊啲條目係「伏筆樞紐」？** —— 連接最多關係嘅條目（`--mode hubs`）
2. **伏筆網絡嘅結構係點？** —— 最強嘅關係群組（`--mode network`）

⚠️ 為何要呢個分析
----------------
434 對伏筆關係唔係平均分佈 —— 少數條目（例如「滿天身份」「董倫陰謀」）
串連大量關係。呢啲**樞紐條目**係理解故事結構嘅關鍵。

輸出：
    docs/assets/chronicle-hubs.png
    docs/assets/chronicle-network.png

用法：
    python scripts/export_chronicle_hubs.py            # 兩個都出
    python scripts/export_chronicle_hubs.py --mode hubs
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
CHRONICLE = REPO / "data" / "public" / "chronicle.json"
OUT_DIR = REPO / "docs" / "assets"

BG = (18, 20, 24)
FG = (232, 234, 237)
MUTED = (140, 146, 156)
GRID = (44, 48, 56)
ACCENT = (96, 165, 250)
ACCENT2 = (45, 212, 191)
WARN = (232, 150, 63)


def load_font(size: int):
    """搵支援中文嘅字體；搵唔到就退到預設。"""
    for name in ("msyh.ttc", "msyh.ttf", "simhei.ttf", "NotoSansCJK-Regular.ttc"):
        for base in (r"C:\Windows\Fonts", "/usr/share/fonts", "/System/Library/Fonts"):
            p = Path(base) / name
            if p.exists():
                try:
                    return ImageFont.truetype(str(p), size)
                except OSError:
                    continue
    return ImageFont.load_default()


def load_entries() -> list[dict]:
    return json.loads(CHRONICLE.read_text(encoding="utf-8"))["entries"]


def degree(entries: list[dict]) -> dict[str, int]:
    """每個條目嘅關係度數（出邊 + 入邊，去重）。"""
    d: dict[str, set[str]] = defaultdict(set)
    for e in entries:
        for f in e.get("foreshadows", []):
            d[e["id"]].add(f)
            d[f].add(e["id"])
    return {k: len(v) for k, v in d.items()}


def longest_spans(entries: list[dict], limit: int = 18) -> list[tuple[dict, dict, int]]:
    """跨度最長嘅伏筆對（按章節距離排序）。

    ⚠️ 為何用「跨度」而唔係「度數」
    -----------------------------
    實測度數最高只有 4 —— 因為伏筆關係多數係 1 對 1，唔會形成密集樞紐。
    所以「度數排行」資訊量低。

    而**跨度**（解答章節 − 伏筆章節）先係用戶想要嘅效果嘅量化：
    跨度越大 = 伏筆埋得越早、收得越遲 = 「後續篇章回帶補完」越明顯。
    """
    by_id = {e["id"]: e for e in entries}
    pairs: list[tuple[dict, dict, int]] = []
    for e in entries:
        for fid in e.get("foreshadows", []):
            f = by_id.get(fid)
            if not f:
                continue
            # ⚠️ 符號唔可以倒轉：`e` 係**伏筆**（較早），`f` 係**解答**
            # （較後）。所以跨度 = 解答章節 − 伏筆章節。
            # 實測踩過：寫成 `e - f` 會全部變負數 → 排行圖空白。
            span = f["first_mention_chapter"] - e["first_mention_chapter"]
            if span > 0:
                # ⚠️ tuple 順序 = (伏筆, 解答, 跨度) —— 顯示時先伏筆後解答
                pairs.append((e, f, span))
    pairs.sort(key=lambda t: -t[2])
    # 去重（同一對可能由多個代理提出）
    seen: set[tuple[str, str]] = set()
    out: list[tuple[dict, dict, int]] = []
    for f, e, span in pairs:
        k = (f["id"], e["id"])
        if k in seen:
            continue
        seen.add(k)
        out.append((f, e, span))
        if len(out) >= limit:
            break
    return out


def draw_hubs(entries: list[dict]) -> Path:
    """橫條圖：伏筆跨度最長嘅關係對。"""
    deg = degree(entries)
    by_id = {e["id"]: e for e in entries}
    top = longest_spans(entries, 18)

    W, H = 1400, 900
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title = load_font(32)
    f_sub = load_font(16)
    f_body = load_font(18)
    f_small = load_font(13)

    n_rel = sum(len(e.get("foreshadows", [])) for e in entries)
    d.text((50, 36), "《病港》編年史：伏筆跨度排行", font=f_title, fill=FG)
    d.text(
        (50, 80),
        f"{len(entries)} 條事件　·　{n_rel} 對伏筆關係　·　"
        f"{len(deg)} 條有連結　·　顯示跨度最長 18 對",
        font=f_sub, fill=MUTED,
    )

    y = 140
    max_span = top[0][2] if top else 1
    bar_x, bar_w = 760, 420
    for rank, (f, e, span) in enumerate(top, 1):
        # 排名
        d.text((50, y + 3), f"{rank:2d}", font=f_small, fill=MUTED)
        # 跨度（ch 範圍）
        d.text((78, y + 3), f"ch{f['first_mention_chapter']:3d}",
               font=f_small, fill=MUTED)
        d.text((122, y + 3), "→", font=f_small, fill=(80, 86, 96))
        d.text((140, y + 3), f"ch{e['first_mention_chapter']:3d}",
               font=f_small, fill=MUTED)
        # 伏筆標題（縮短）
        d.text((200, y), f["title"][:22], font=f_body, fill=FG)
        # 橫條
        w = int(bar_w * span / max_span)
        d.rectangle([(bar_x, y + 2), (bar_x + w, y + 24)], fill=ACCENT)
        # 跨度數
        d.text((bar_x + w + 8, y + 3), f"{span} 章", font=f_small, fill=ACCENT2)
        y += 38

    d.text(
        (50, H - 76),
        "「跨度」＝ 解答章節 − 伏筆章節。跨度越大 = 伏筆埋得越早、收得越遲。",
        font=f_small, fill=MUTED,
    )
    d.text(
        (50, H - 54),
        "注意：呢個就係「後續篇章回帶補完伏筆」效果嘅量化。",
        font=f_small, fill=WARN,
    )
    d.text((50, H - 30), "病港互動地圖　·　原創資料集　·　CC BY-NC-SA 4.0",
           font=f_small, fill=(90, 96, 106))

    out = OUT_DIR / "chronicle-hubs.png"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    return out


PERIOD_ORDER = ["爆發前", "病毒爆發", "爆發初期", "大本營時期", "康城時期", "終局"]


def draw_network(entries: list[dict]) -> Path:
    """時期流向矩陣：伏筆同解答各屬邊個時期。

    ⚠️ 為何唔用「節點網絡圖」
    ------------------------
    實測度數分佈極稀疏：525 個節點度數=1、136 個=2、只有 23 個 ≥3。
    畫出嚟只係散點，冇結構可言。

    改為**時期 × 時期**嘅流向矩陣 —— 回答一個更有意義嘅問題：
    「邊個時期埋嘅伏筆，喺邊個時期收？」呢個先係編年史嘅核心。
    """
    by_id = {e["id"]: e for e in entries}
    # 建立 時期 × 時期 矩陣
    mat: dict[tuple[str, str], int] = {}
    for e in entries:
        fp = e["story_time"]["label"]
        for fid in e.get("foreshadows", []):
            f = by_id.get(fid)
            if not f:
                continue
            pp = f["story_time"]["label"]
            if fp in PERIOD_ORDER and pp in PERIOD_ORDER:
                mat[(fp, pp)] = mat.get((fp, pp), 0) + 1

    W, H = 1200, 760
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title = load_font(30)
    f_sub = load_font(15)
    f_body = load_font(16)
    f_small = load_font(13)

    n_rel = sum(len(e.get("foreshadows", [])) for e in entries)
    d.text((50, 36), "《病港》編年史：伏筆流向矩陣", font=f_title, fill=FG)
    d.text(
        (50, 78),
        f"{n_rel} 對伏筆關係　·　橫軸 = 解答時期　·　縱軸 = 伏筆時期",
        font=f_sub, fill=MUTED,
    )

    # 格仔尺寸
    cw, chh = 130, 62
    ox, oy = 210, 150
    maxv = max(mat.values()) if mat else 1
    for j, pp in enumerate(PERIOD_ORDER):
        d.text((ox + j * cw + 6, oy - 26), pp, font=f_small, fill=MUTED)
    for i, fp in enumerate(PERIOD_ORDER):
        d.text((50, oy + i * chh + 20), fp, font=f_body, fill=FG)
        for j, pp in enumerate(PERIOD_ORDER):
            v = mat.get((fp, pp), 0)
            x0, y0 = ox + j * cw, oy + i * chh
            if v:
                # 顏色深淺按數量
                t = v / maxv
                col = (
                    int(30 + 66 * t),
                    int(70 + 95 * t),
                    int(120 + 130 * t),
                )
                d.rectangle([(x0 + 2, y0 + 2), (x0 + cw - 4, y0 + chh - 4)], fill=col)
                d.text((x0 + cw // 2 - 8, y0 + chh // 2 - 9), str(v),
                       font=f_body, fill=FG)
            else:
                d.rectangle([(x0 + 2, y0 + 2), (x0 + cw - 4, y0 + chh - 4)],
                            outline=GRID)

    # 對角線（同章／同時期）加註
    d.text((50, oy + len(PERIOD_ORDER) * chh + 24),
           "對角線 = 伏筆同解答喺同一時期（通常係同章或相鄰章）。",
           font=f_small, fill=MUTED)
    d.text((50, oy + len(PERIOD_ORDER) * chh + 46),
           "右上角 = 跨度最長（早期埋、後期收）。",
           font=f_small, fill=ACCENT2)
    d.text((50, H - 30), "病港互動地圖　·　原創資料集　·　CC BY-NC-SA 4.0",
           font=f_small, fill=(90, 96, 106))

    out = OUT_DIR / "chronicle-network.png"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    return out


def _unused_old_network(entries: list[dict]) -> Path:
    import math

    deg = degree(entries)
    by_id = {e["id"]: e for e in entries}
    # 只取度數 ≥3 嘅節點（否則線太多，睇唔到結構）
    nodes = [i for i, n in deg.items() if n >= 3]
    nodes.sort(key=lambda i: -deg[i])
    nodes = nodes[:60]
    node_set = set(nodes)

    W, H = 1400, 1000
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title = load_font(32)
    f_sub = load_font(16)
    f_small = load_font(12)

    d.text((50, 36), "《病港》編年史：伏筆關係網絡", font=f_title, fill=FG)
    d.text(
        (50, 80),
        f"顯示度數 ≥3 嘅節點（共 {len(nodes)} 個，上限 60）　·　"
        f"圓形佈局按章節排序",
        font=f_sub, fill=MUTED,
    )

    if not nodes:
        img.save(OUT_DIR / "chronicle-network.png", "PNG", optimize=True)
        return OUT_DIR / "chronicle-network.png"

    # 按章節排序 → 順序排喺圓周（令相鄰章節嘅節點靠近）
    nodes.sort(key=lambda i: by_id[i]["first_mention_chapter"])
    cx, cy, r = W // 2, H // 2 + 30, 360
    pos: dict[str, tuple[float, float]] = {}
    for k, nid in enumerate(nodes):
        ang = 2 * math.pi * k / len(nodes) - math.pi / 2
        pos[nid] = (cx + r * math.cos(ang), cy + r * math.sin(ang))

    # 畫邊
    drawn = set()
    for e in entries:
        a = e["id"]
        if a not in node_set:
            continue
        for b in e.get("foreshadows", []):
            if b not in node_set:
                continue
            key = tuple(sorted((a, b)))
            if key in drawn:
                continue
            drawn.add(key)
            d.line([pos[a], pos[b]], fill=(60, 72, 92), width=1)

    # 畫節點（大小按度數）
    for nid in nodes:
        x, y = pos[nid]
        rad = 4 + min(10, deg[nid])
        color = ACCENT if deg[nid] >= 6 else ACCENT2
        d.ellipse([(x - rad, y - rad), (x + rad, y + rad)], fill=color)
        d.text((x + rad + 3, y - 6), f"ch{by_id[nid]['first_mention_chapter']}",
               font=f_small, fill=MUTED)

    # 圖例
    lx, ly = 50, H - 70
    d.ellipse([(lx, ly + 4), (lx + 8, ly + 12)], fill=ACCENT2)
    d.text((lx + 16, ly), "度數 3–5", font=f_small, fill=MUTED)
    d.ellipse([(lx + 130, ly + 2), (lx + 146, ly + 18)], fill=ACCENT)
    d.text((lx + 154, ly), "度數 ≥6（樞紐）", font=f_small, fill=MUTED)
    d.text((50, H - 30), "病港互動地圖　·　原創資料集　·　CC BY-NC-SA 4.0",
           font=f_small, fill=(90, 96, 106))

    out = OUT_DIR / "chronicle-network.png"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="編年史伏筆分析圖")
    ap.add_argument("--mode", choices=["hubs", "network", "all"], default="all")
    args = ap.parse_args()

    entries = load_entries()
    if args.mode in ("hubs", "all"):
        p = draw_hubs(entries)
        print(f"已匯出 {p}（{p.stat().st_size / 1024:.0f} KB）")
    if args.mode in ("network", "all"):
        p = draw_network(entries)
        print(f"已匯出 {p}（{p.stat().st_size / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

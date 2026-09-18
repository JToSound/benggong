#!/usr/bin/env python3
"""建置《病港》互動地圖嘅多層級縮放（LOD）圖磚集。

為何要 LOD
==========
單張 2048 px 底圖覆蓋全港（0.70°）。放大 8 倍時，1 個螢幕像素對應
2048/8 = 256 個來源像素 —— 必然模糊，而且放大後仍然只有地區名，
冇街道、冇樓宇。

LOD 做法：**輸出尺寸固定，改細 bbox**。同樣 1536 px 畫布：
    全港 0.70°  →  47 m/px
    分區 0.07°  →  4.7 m/px
    街道 0.02°  →  1.3 m/px
配合渲染器嘅自動細節開關（見 `render_binggang_map.LOD_TIERS`），
放大後道路同建築會自然浮現 —— 資料本身一直存在（42,758 條道路、
133,361 幢建築），只係全港尺度下係亞像素。

輸出
====
    public/assets/map-lod/<tier>.png
    public/assets/map-lod/<tier>-coords.json
    public/assets/map-lod/manifest.json

manifest.json 係前端揀層級嘅唯一依據，每層記錄 bbox、輸出尺寸、
LOD 名稱同檔案路徑。

用法：
    python scripts/build_map_lods.py
    python scripts/build_map_lods.py --only overview,tko-district
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RENDERER = REPO / "scripts" / "render_binggang_map.py"
OUT_DIR = REPO / "public" / "assets" / "map-lod"
MANIFEST = OUT_DIR / "manifest.json"
ASSETS = REPO / "public" / "assets"

# 總覽層直接用前端既有嘅底圖檔名（避免重複 1.8 MB），其餘層放 map-lod/
OVERVIEW_PNG = ASSETS / "hk-basemap.png"
OVERVIEW_LABELS = ASSETS / "hk-basemap-labels.png"
OVERVIEW_COORDS = ASSETS / "hk-basemap-coords.json"

# ---------------------------------------------------------------------------
# 層級定義
#
# bbox 全部係 [lon_min, lon_max, lat_min, lat_max]。
# 主場景（將軍澳／調景嶺）嚟自內容推斷：李惠利大樓 + A/B/C/D 座 +
# G 層大堂 + 靈實醫院 + 尚德商場 → IVE(HKDI) 調景嶺校園一帶。
#
# 全部用 --crop none：裁切會令「輸出像素 ↔ 經緯度」嘅對應多一層換算，
# 而 LOD 切換本身已經要換算，兩層疊埋好易出錯。寧願留多啲海面。
# ---------------------------------------------------------------------------
# 為何 bbox 要「比實際需要闊」
# --------------------------
# 前端揀層級嘅條件係「層級 bbox 完全覆蓋目前視窗」—— 只有咁樣才保證
# 畫面唔會出現空白。如果 bbox 太貼近核心範圍，用戶稍為平移到邊緣就會
# 退回全港總覽（變模糊），體驗好差。所以每層都留約 1.5–2× 餘裕，
# 而且四層互相嵌套（overview ⊃ region ⊃ district ⊃ street）。
TIERS: list[dict[str, object]] = [
    {
        "id": "overview",
        "label": "全港總覽",
        "width": 2048,
        "bbox": [113.79, 114.49, 22.11, 22.61],
        "note": "地區名同主要島嶼；道路／建築係亞像素所以唔畫",
        "shared_asset": True,
    },
    # ⚠️ 為何由 1536 提高到 2048
    #
    # 用戶報告「放大會變得低清」。根因：最細層（tko-campus，跨距 0.036°）
    # 只有 1536 px，即 42,667 px/°。但前端可以縮到 0.023° 甚至更細 ——
    # 圖磚被**拉伸 1.5–4 倍**，必然模糊。
    #
    # 2048 px 令線性解像度提升 33%（42,667 → 56,889 px/°），配合下面
    # 新增嘅 campus-core 層（0.020°）令最細層達到 102,400 px/°。
    # ══════════════════════════════════════════════════════════════════
    # 全港分區層（2×2 網格）
    # ══════════════════════════════════════════════════════════════════
    #
    # 用戶反映「大部份地區未可以順利放大會提到更加多細節」。
    #
    # 原本只有將軍澳有分層，其他地區放大就退回 overview（2,926 px/°），
    # 即係 1 個螢幕像素對應 8 個來源像素 —— 必然模糊。
    #
    # 做法：將全港（0.70° × 0.50°）切成 2×2 網格，每格 0.35° × 0.25°，
    # 2048 px → **5,851 px/°（overview 嘅 2 倍）**。
    #
    # ⚠️ 為何唔用更細嘅網格（例如 3×3）：圖磚數量同檔案大小會倍增
    # （每張約 2 MB）。2×2 係「覆蓋全港」同「資產大小」嘅平衡點；
    # 故事主場景（將軍澳）另外有 7 層更細嘅專用圖磚。
    #
    # bbox 之間**刻意重疊少許**（0.005°），令揀層時唔會出現「兩格都
    # 唔完全覆蓋」嘅縫隙。
    {
        "id": "hk-nw",
        "label": "香港西北（屯門／元朗／大嶼山北）",
        "width": 2048,
        "bbox": [113.790, 114.145, 22.360, 22.610],
        "note": "全港分區層：西北",
    },
    {
        "id": "hk-ne",
        "label": "香港東北（沙田／西貢／大埔）",
        "width": 2048,
        "bbox": [114.140, 114.490, 22.360, 22.610],
        "note": "全港分區層：東北",
    },
    {
        "id": "hk-sw",
        "label": "香港西南（大嶼山／港島西）",
        "width": 2048,
        "bbox": [113.790, 114.145, 22.110, 22.365],
        "note": "全港分區層：西南",
    },
    {
        "id": "hk-se",
        "label": "香港東南（港島東／九龍／將軍澳）",
        "width": 2048,
        "bbox": [114.140, 114.490, 22.110, 22.365],
        "note": "全港分區層：東南",
    },
    {
        "id": "tko-region",
        "label": "將軍澳／西貢一帶",
        "width": 2048,
        "bbox": [114.160, 114.360, 22.235, 22.405],
        "note": "主場景所在區域；開始見到主要道路同大型建築群",
    },
    {
        "id": "tko-district",
        "label": "將軍澳新市鎮",
        "width": 2048,
        "bbox": [114.208, 114.318, 22.266, 22.354],
        "note": "街道網同逐幢樓宇清晰可辨",
    },
    {
        "id": "tko-street",
        "label": "將軍澳市中心",
        "width": 2048,
        "bbox": [114.232, 114.292, 22.286, 22.336],
        "note": "街廓級細節；樓宇形狀、屋苑佈局可見",
    },
    # --- 以下兩層針對實際地點分佈（唔係憑感覺揀）---
    #
    # 實測 239 個有真實座標嘅地點，按 0.05° 網格分群：
    #   (114.25, 22.30) 180 個  ← 調景嶺 VTC 校園（大本營所在）
    #   (114.25, 22.35)  41 個  ← 坑口／寶琳／將軍澳北
    #   (114.30, 22.30)   9 個  ← 康城／日出康城
    # 所以最值得加街道級圖磚嘅係前兩個叢集。
    {
        "id": "tko-campus",
        "label": "調景嶺校園（大本營）",
        "width": 2048,
        "bbox": [114.2340, 114.2700, 22.2920, 22.3220],
        "note": "180 個地點集中喺呢度 —— 大本營（VTC 校園）同周邊設施",
    },
    {
        # 最細一層：大本營校園核心。180 個地點之中大部分集中喺
        # (114.25, 22.30) 附近，所以值得單獨出一層街廓級圖磚。
        "id": "tko-campus-core",
        "label": "大本營校園核心",
        "width": 2048,
        # ⚠️ bbox 一定要**闊過最窄視窗**（0.0200°），否則揀層條件
        # （「完全覆蓋視窗」）永遠唔成立，圖磚永遠用唔到。
        # 實測踩過：原本 bbox 0.0200° 啱啱好等於最窄視窗，只要用戶
        # 稍微偏離中心就唔夠覆蓋 → 一直退回 tko-campus（0.036°）。
        # 加 30% 餘裕 → 0.026°。
        "bbox": [114.2404, 114.2664, 22.2955, 22.3161],
        "note": "校園核心：逐幢建築物同內部通道可見",
    },
    # --- 以下兩層針對**北部次叢集**（唔係憑感覺揀）---
    #
    # 實測 264 個 lat>22.315 嘅地點，按 0.02° 網格分群：
    #   (114.26, 22.32) 111 個  ← 坑口
    #   (114.24, 22.32)  83 個  ← 寶琳
    #   (114.28, 22.32)  41 個  ← 康城／百勝角
    # tko-north（0.068°）覆蓋全部，但解像度只有 30,118 px/°；
    # 呢兩層各 0.030° → 68,267 px/°（高 2.3 倍）。
    #
    # ⚠️ bbox 一定要闊過最窄視窗（0.020°），否則永遠揀唔到。
    {
        "id": "tko-hang-hau",
        "label": "坑口",
        "width": 2048,
        "bbox": [114.2480, 114.2780, 22.3060, 22.3260],
        "note": "坑口一帶：111 個地點",
    },
    {
        "id": "tko-po-lam",
        "label": "寶琳",
        "width": 2048,
        "bbox": [114.2280, 114.2580, 22.3100, 22.3300],
        "note": "寶琳一帶：83 個地點",
    },
    {
        # 康城／百勝角：41 個地點。tko-district（0.110°）覆蓋到，但
        # 解像度只有 18,618 px/°。呢層 0.030° → 68,267 px/°。
        "id": "tko-lohas",
        "label": "康城／日出康城",
        "width": 2048,
        "bbox": [114.2620, 114.2920, 22.2840, 22.3040],
        "note": "康城、日出康城、百勝角一帶：41 個地點",
    },
    {
        # 康城／百勝角：41 個地點。tko-district（0.110°）覆蓋到，但
        # 解像度只有 18,618 px/°。呢層 0.030° → 68,267 px/°。
        "id": "tko-lohas",
        "label": "康城／日出康城",
        "width": 2048,
        "bbox": [114.2620, 114.2920, 22.2840, 22.3040],
        "note": "康城、日出康城、百勝角一帶：41 個地點",
    },
    {
        "id": "tko-north",
        "label": "坑口／寶琳／將軍澳北",
        "width": 2048,
        "bbox": [114.2220, 114.2900, 22.3040, 22.3540],
        "note": "41 個地點；坑口、寶琳、將軍澳北一帶",
    },
]


def render_tier(tier: dict[str, object]) -> dict[str, object]:
    """呼叫渲染器產生一個層級，回傳 manifest 條目。"""
    tid = str(tier["id"])
    bbox = tier["bbox"]
    assert isinstance(bbox, list)
    bbox_arg = ",".join(f"{v}" for v in bbox)
    shared = bool(tier.get("shared_asset"))

    if shared:
        png = OVERVIEW_PNG
        labels = OVERVIEW_LABELS
        coords = OVERVIEW_COORDS
    else:
        png = OUT_DIR / f"{tid}.png"
        labels = None
        coords = OUT_DIR / f"{tid}-coords.json"

    cmd = [
        sys.executable,
        str(RENDERER),
        "--width",
        str(tier["width"]),
        "--bbox",
        bbox_arg,
        "--crop",
        "none",
        "--out",
        str(png),
        "--coords",
        str(coords),
    ]
    if labels is not None:
        cmd += ["--labels", "none", "--labels-out", str(labels)]

    print(f"\n=== {tid} ({tier['label']}) ===")
    proc = subprocess.run(cmd, cwd=str(REPO), capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:], file=sys.stderr)
        raise SystemExit(f"層級 {tid} 渲染失敗（exit {proc.returncode}）")
    for line in proc.stdout.splitlines():
        if any(k in line for k in ("LOD：", "land mask", "道路", "建築", "標籤", "暗角")):
            print("  " + line.strip())

    meta = json.loads(coords.read_text(encoding="utf-8"))
    entry: dict[str, object] = {
        "id": tid,
        "label": tier["label"],
        "note": tier["note"],
        "image": (
            f"assets/{png.name}" if shared else f"assets/map-lod/{tid}.png"
        ),
        "coords": (
            f"assets/{coords.name}" if shared else f"assets/map-lod/{tid}-coords.json"
        ),
        "bbox": meta["bbox"],
        "lod": meta["lod"],
        "lod_layers": meta["lod_layers"],
        "output_size": meta["output_size"],
        "canvas": meta["canvas"],
        "bytes": png.stat().st_size,
    }
    if shared and labels is not None:
        entry["label_layer"] = f"assets/{labels.name}"
        entry["label_layer_bytes"] = labels.stat().st_size
    return entry


def main() -> int:
    ap = argparse.ArgumentParser(description="Build 《病港》 map LOD tiles")
    ap.add_argument(
        "--only",
        type=str,
        default="",
        help="只建置指定層級（逗號分隔），預設全部",
    )
    args = ap.parse_args()

    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    tiers = [t for t in TIERS if not wanted or t["id"] in wanted]
    if not tiers:
        print(f"冇符合嘅層級：{args.only}", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, object]] = []
    # ⚠️ 合併現有 manifest 時要按 id 去重。
    #
    # 實測踩過：連續跑兩次 `--only tko-lohas` 之後，manifest 入面出現
    # **兩個** tko-lohas（同一個 id、同一個 bbox）。前端 `pickTier()`
    # 唔會出事，但 `phase-j-lod` 測試（檢查「冇兩個圖磚有完全相同 bbox」）
    # 會捉到 —— 而且重複項會令 manifest 隨時間膨脹。
    # ⚠️ 合併現有 manifest 時要按 id 去重。
    #
    # 實測踩過：連續跑兩次 `--only tko-lohas` 之後，manifest 入面出現
    # **兩個** tko-lohas（同一個 id、同一個 bbox）。前端 `pickTier()`
    # 唔會出事，但 `phase-j-lod` 測試（檢查「冇兩個圖磚有完全相同 bbox」）
    # 會捉到 —— 而且重複項會令 manifest 隨時間膨脹。
    if MANIFEST.exists() and wanted:
        # 局部重建時保留其他層級嘅條目
        old = json.loads(MANIFEST.read_text(encoding="utf-8"))
        entries = [e for e in old.get("tiers", []) if e["id"] not in {t["id"] for t in tiers}]

    for tier in tiers:
        entries.append(render_tier(tier))

    order = {str(t["id"]): i for i, t in enumerate(TIERS)}
    entries.sort(key=lambda e: order.get(str(e["id"]), 99))

    manifest = {
        "version": 1,
        "generator": "scripts/build_map_lods.py",
        "renderer": "scripts/render_binggang_map.py",
        "style": "binggang_handdrawn_parchment",
        "coordinate_system": "EPSG:4326",
        "projection": "equirectangular",
        "standard_parallel": 22.36,
        "projection_cos": 0.9247,
        "projection_note": (
            "SVG user unit：x = lon；y 由 bbox.lat_max 遞增。"
            "垂直方向已乘 1/cos(標準緯線)，所以圖上長度同真實距離成比例。"
            "放置圖磚時：x = lonToUser(lon_min)，"
            "y = latToUser(lat_max)，width/height 由對應經緯換算。"
        ),
        "note": (
            "LOD 圖磚：輸出尺寸固定，改細 bbox = 放大。前端按目前視窗 bbox "
            "揀最窄但仍然覆蓋視窗嘅層級；放大到 district / street 時，"
            "道路同建築圖層會自動出現。"
        ),
        "tiers": entries,
    }
    # 按 id 去重（保留最後一次建置嘅結果）
    _by_id: dict[str, dict[str, object]] = {}
    for e in entries:
        _by_id[str(e["id"])] = e
    entries = list(_by_id.values())

    # 按 id 去重（保留最後一次建置嘅結果）
    _by_id: dict[str, dict[str, object]] = {}
    for e in entries:
        _by_id[str(e["id"])] = e
    entries = list(_by_id.values())

    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    total = sum(
        int(e["bytes"]) + int(e.get("label_layer_bytes", 0)) for e in entries
    )
    print(f"\nmanifest：{MANIFEST}")
    print(f"層級數：{len(entries)}　總大小：{total:,} bytes ({total/1024/1024:.2f} MiB)")
    for e in entries:
        extra = f" +標籤 {int(e.get('label_layer_bytes', 0)):,} B" if e.get("label_layer_bytes") else ""
        print(f"  {e['id']:14s} {e['lod']:9s} {int(e['bytes']):>9,} B{extra}  {e['label']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

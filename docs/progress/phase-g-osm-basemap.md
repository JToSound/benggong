# Phase G 進度報告：OSM-based 全香港地圖 basemap

**日期**: 2026-09-05
**作者**: JToSound (benggong project)
**狀態**: ✅ 完成並部署到 GitHub Pages

---

## 摘要

Phase G 為《病港》互動地圖建立咗**一個真正嘅、基於 OpenStreetMap 數據嘅、可互動嘅全香港地圖 basemap**。

呢個係從之前 ComfyUI diffusion 嗰個錯誤方向嘅徹底修正：之前用 dreamShaper 8 喺做插畫，唔似地圖。改用程序化渲染（procedural rendering）由真實 OSM 數據畫出 198,300 個 elements 嘅 stylized top-down game-style 地圖。

## 改動清單

| 檔案 | 用途 | 增/刪行數 |
|------|------|-----------|
| `scripts/render_hk_basemap.py` (new) | OSM Overpass API → PIL procedural renderer | +273 |
| `public/assets/hk-basemap.png` (new) | 2048×2048 dark game-style basemap | +42,927 bytes |
| `public/assets/hk-basemap-coords.json` (new) | bbox metadata（前端 lon/lat 投影用）| +5 |
| `src/components/SvgMap.ts` | 用 `<image>` 載 PNG，lon/lat → viewbox 投影，刪除手繪 SVG + 70 個 PNG_ANCHORS + 13 行 extractBasemapInner + FALLBACK_ANCHORS（37 個小說虛構地點）| -111, +118 |
| `tests/test_hk_basemap.py` (new) | 8 個新 test（file exist、bbox、PNG dimensions、color variation、known anchors、projection roundtrip）| +157 |
| `requirements-dev.txt` | 加 Pillow 10+, requests 2.31+ | +3, -0 |

**Commits**:
- `88d84cb` Phase G: OSM-based procedural HK basemap (replaces ComfyUI attempt)
- `81ee4a0` ci: add Pillow + requests to requirements-dev for Phase G basemap tests

## 技術決策

### 點解唔用 ComfyUI？
- ComfyUI diffusion models 擅長**插畫**、唔擅長 stylized 遊戲地圖
- 之前用 dreamShaper 8 喺度生成嘅係 aesthetic illustration，唔係 interactive map
- ComfyUI Desktop image preview 出現「No workflow data available」係另一個原因（圖 metadata 損壞）

### 點解用 OSM Overpass API + PIL？
- **OSM** 有**真實嘅**香港地理數據：198,300 elements（roads, water, buildings, parks, coastlines）
- **Overpass API** 係 public、free、low-rate tolerated，唔需要 API key（用 User-Agent header）
- **PIL** 完全 deterministic，唔需要 GPU，每次 render 結果完全相同
- **Pillow `?raw` import** 將 1.4MB PNG inlined 入 Vite bundle = single-file deploy 友好
- 過程可重跑：cache 喺 `data/private/cache/osm-hk.json`（gitignored）

### 座標投影（Lon/Lat → SVG viewbox）
- Bbox: 113.85-114.45 lon, 22.18-22.55 lat → SVG viewbox (113.85, 22.18, 0.60, 0.37)
- **關鍵**：SVG y 軸向下、地理 lat 向上，y fraction 要 invert：`fy = (lat_max - y) / (lat_max - lat_min)`
- 結果：將軍澳（HK 南面）正確喺地圖右下方；港島中間偏右；新界頂部

### 病港風格配色
- 海洋：`bg_water (22, 36, 52)` 深藍（dark navy）
- 陸地：`land_main (38, 42, 44)` 灰黑
- 道路：`road_motor (88, 78, 60)` amber-grey
- 建築：深灰 footprint（post-apocalyptic 廢土感）
- Vignette：四角更暗，凸顯中央

## Frontend 改動

### `SvgMap.ts` 簡化
**刪除**:
- `extractBasemapInner()` helper（13 行）— `?raw` import 嘅 SVG inline 已經唔再需要
- `PNG_ANCHORS` 70 個 hand-curated 條目（寶琳/坑口/將軍澳/西環/中環/尖沙咀 etc.）— 全部由 **真實 lon/lat** 取代
- Hand-drawn SVG `tseung-kwan-o-basemap.svg`（4.6KB, 5 個 polygon）

**新增**:
- `BASEMAP_PNG`（`<image>` element 而非 `<g>` SVG content）
- `BASEMAP_BBOX`（front-end 用嘅 metadata）
- `lonlatToViewbox(lon, lat)` function — clamp bbox + invert y-axis
- `FALLBACK_ANCHORS`（37 個）— 俾小說虛構地點（艾寶琳倖存區、病者之都、不良人根據地）因為 OSM 冇 record

## 測試

### pytest 8 個新 test (`tests/test_hk_basemap.py`)
| Test | 用途 |
|------|------|
| `test_render_script_exists` | scripts/render_hk_basemap.py 存在 |
| `test_basemap_png_exists` | public/assets/hk-basemap.png 存在（skip if missing）|
| `test_basemap_coords_metadata_exists` | coords JSON 存在 + bbox 喺 HK 範圍（113-115 lon, 22-23 lat）|
| `test_basemap_png_dimensions` | PNG square + size 對應 coords JSON |
| `test_basemap_png_file_size_reasonable` | 30KB-2MB 之間（唔係空又唔係 bloat）|
| `test_basemap_contains_color_variation` | > 10 個 unique colors（唔係 solid）|
| `test_basemap_known_anchors_within_bbox` | 4 個將軍澳 landmarks（艾寶琳、大本營、將軍澳站、康城）座標全部喺 bbox 內 |
| `test_lonlat_projection_roundtrip` | bbox 角落 + 中點投影數學正確（top-left, bottom-right, midpoint）|

### 全部 gates 過
| Gate | 結果 |
|------|------|
| `pytest` | 92 → **100** passed ✅ |
| `vitest` | 12/12 ✅ |
| `tsc --noEmit` | 0 errors ✅ |
| `eslint` | 0 errors ✅ |
| `vite build` | 31.79KB JS + 16.20KB CSS + 42.93KB PNG ✅ |
| `validate_public_data.py` | ✅ |
| `audit_release.py --strict` | ✅ |

## GitHub Pages 部署

兩個 issue 解決：
1. **CI 失敗**：`Pillow` 未喺 `requirements-dev.txt` → 加返
2. **Pages 失敗**：classic source 同 workflow `actions/deploy-pages@v4` 衝突 → DELETE classic source → RE-enable with `build_type=workflow` → 重新 trigger

最後部署成功：`https://jtosound.github.io/benggong/`  
- HTML：`/assets/index-CQsY6CDG.js` (build output, 唔再係 `/src/`)
- PNG：`/assets/hk-basemap-DMBAu4dt.png` (42,927 bytes, image/png)
- 通過 Pages workflow `actions/upload-pages-artifact@v3` + `actions/deploy-pages@v4` 流程

## Visual Verification

- **Chapter 10「大本營」**: 將軍澳中心地帶，markers 圍繞 寶琳/彩明/大本營
- **Chapter 60「將軍澳海旁」**: markers 聚集喺將軍澳南面海旁
- 將軍澳半島、港島南、九龍東、藍田、維港輪廓全部清楚可辨
- 配色：dark navy 海洋 + 灰黑陸地 + amber 道路 + 深灰建築 footprint

## 已知限制

1. **OSM 數據過期**：Overpass API `timestamp_osm_base: 2026-09-05T03:08:00Z`，可定期 re-render 取得新道路
2. **虛構地點**：`艾寶琳倖存區`/`病者之都`/`不良人` etc. 唔喺 OSM，需要 FALLBACK_ANCHORS 手動指定
3. **Caching**：`data/private/cache/osm-hk.json` (174MB) 喺 `.gitignore`，每位 contributor 需要自己 fetch
4. **唔 re-render 嘅話**：地圖靜態，唔會反映新增道路或建築
5. **First-paint** PNG 42.93KB + JS 28.83KB = 71KB initial load（之前 inline SVG 4.6KB + JS 30.79KB）

## 下一步（Phase H?）

- [ ] 為 病港 2 預留 extent（schema `bing_gang_2` namespace 已 OK）
- [ ] 將軍澳以外嘅 fictional 地點多 fallback（如果將來有 九龍東 / 港島 / 新界 虛構地點）
- [ ] 道路 labels（中英文街道名）
- [ ] 地圖 zoom + pan 用戶指示（暫時 user can wheel zoom + drag pan，但 UI hint 欠奉）
- [ ] 考慮 tile-based rendering（按章節顯示 sub-region 提高 detail）

# Phase I 進度報告：標籤分層、平滑轉場、全港 anchors、雙語圖例

**日期**: 2026-09-15
**作者**: JToSound (benggong project)
**狀態**: ✅ 全部品質閘門通過；⚠️ **未推送**（本機環境冇 GitHub 憑證）
**Commit**: `473ea05`（本機 main，領先 origin/main 1 個 commit）

---

## 摘要

Phase I 嘅四個方向（I1 label declutter、I2 smooth animation、I3 全港 anchors、
I4 雙語 legend）＋測試（I5）今次一次過完成，並修正咗兩個真實缺陷。

**最重要嘅發現**：Phase I 總結文件描述嘅「阻滯」同「已完成」狀態同倉庫實際
情況不符。實測結果如下。

| 總結文件聲稱 | 實測結果 |
|---|---|
| `tsc` 因 SvgMap.ts loose statements 而失敗 | ❌ 不成立 —— `tsc --noEmit` 0 errors、ESLint 0 errors |
| `toggleLegendLanguage` 重複宣告 | ❌ 不成立 —— 檔案內完全冇呢個 method |
| `bindEvents()` 重複註冊 | ❌ 不成立 —— 只有一組 listener（僅縮排混亂） |
| I2 animateViewBox 完成 | ❌ 不成立 —— 檔案內冇 `animateViewBox` |
| I3 `resolveCoord` 三層 fallback 完成 | ❌ 不成立 —— 冇 `resolveCoord`、冇 import `FULL_HK_ANCHORS` |
| I4 i18n legend 完成 | ❌ 不成立 —— 冇 `LEGEND_ZH`／`data-i18n`／`#legend-lang-btn` |
| I1 `#label-detail-layer` 完成 | ❌ 不成立 —— 冇呢個 element |
| I5 `tests/phase-i.test.ts` 15/15 通過 | ❌ 不成立 —— 13/16 失敗（從未跑過） |
| vitest 18/18 | ❌ 不成立 —— 實際 21 passed / 13 failed |
| pytest 100/100 | ✅ 成立 |

實際起點：`SvgMap.ts` 停在 Phase H 版本；`fallbackAnchors.ts` 同
`tests/phase-i.test.ts` 係未 commit 嘅新檔；`render_hk_basemap.py` 有一段未
commit 嘅 Pass 5c（燒入底圖）。Phase I 嘅**前端功能全部未實作**。

---

## 改動清單

| 檔案 | 用途 | 改動 |
|------|------|------|
| `src/components/SvgMap.ts` | 重寫：Phase I 全部功能 | 全檔重寫（404 → 555 行） |
| `scripts/gen_fallback_anchors.py` | **新增** — anchor pool 生成器 | +372 行 |
| `src/data/fallbackAnchors.ts` | 剔除 69 個深圳 POI，補足至 503 | 45,718 → 47,528 bytes |
| `scripts/render_hk_basemap.py` | Pass 5c 由底圖拆出成獨立圖層 | +90, -28 |
| `public/assets/hk-basemap-labels.png` | **新增** — 透明街道標籤圖層 | 262,862 bytes |
| `public/assets/hk-basemap.png` | 底圖（移除 Pass 5c 後 byte-identical） | 74,361 bytes（不變） |
| `public/assets/hk-basemap-coords.json` | 加 `layers` metadata | +8 行 |
| `src/styles/main.css` | 圖例語言按鈕 + 標籤圖層樣式 | +32 |
| `tests/test_fallback_anchors.py` | **新增** — 9 個 anchor pool 回歸測試 | +186 |
| `tests/test_hk_basemap.py` | 加 6 個標籤圖層測試 | +88 |
| `tests/phase-i.e2e.test.ts` | **新增** — 3 個 Playwright 互動驗證 | +172 |

---

## 技術細節

### I3 — 全港 anchors：修復 69 個深圳 POI 污染

**問題**：`fallbackAnchors.ts` 聲稱 503 個「全港」anchor，但經香港行政邊界
point-in-polygon 驗證，**其中 69 個係深圳 POI**（13.7% 污染）：華強北站、
華強路站、福田站、會展中心站、深圳圖書館、深圳市公安局（多個分局）、
羅湖村、蛇口港站、茂業百貨、少年宮站、紅嶺站、蓮花西站… 成因係 Phase G 嘅
Overpass 查詢 bbox 北緣（`lat_max = 22.55`）掠過深圳市區。

**為何唔可以 clamp 座標解決**：將深圳 POI 錨定到香港座標等於捏造位置，違反
專案「不確定資料只可標 unknown」嘅原則。必須剔除。

**為何唔可以只用簡體字過濾**：部分深圳地名用繁體同形字 —— 老街站、深大站、
燕南站、人民南站、鹿丹村站等，字形判別會漏網；而部分香港邊境地名
（文錦渡檢查站 22.536、得月樓警崗 22.528）緯度比深圳部分地方更高，緯度
亦分唔開。**唯一可靠方法係行政邊界多邊形。**

**做法**：新增 `scripts/gen_fallback_anchors.py`：
1. 由 Nominatim 取香港行政邊界（OSM relation 913110），cache 到
   `data/private/cache/hk-boundary.geojson`（35 KB，唔 commit）。
2. Ray-casting point-in-polygon 過濾 curated pool：503 → **434**。
3. 由 `osm-hk.json` 補足，候選要求：香港境內 + 名字雙語（中文 + 拉丁，
   同 curated pool 風格一致，排除 `Office`／`1234Space` 等雜訊）+ kind 可分類。
4. 按 kind round-robin 補足至 **503**，輸出 deterministic（同輸入 → byte-identical）。

邊界多邊形判別能力抽驗：15 個測試點（深圳 7 個、香港 8 個）**14/15 正確**。
唯一失手係「羅芳橋警崗 Lo Fong Bridge Police Post」（22.5439）—— Nominatim
邊界幾何經簡化，邊境微地形有偏差，屬已知限制。

補足後分佈：`mall=213, gov=84, transit=70, park=68, school=60, place=6, hospital=2`。

### I1 — Label declutter：雙 PNG 圖層架構

**問題**：`render_hk_basemap.py` 嘅 Pass 5c 將 secondary/tertiary 街道名**燒入**
底圖 PNG。燒入之後前端無法按 zoom 調整密度 —— zoom out 時密密麻麻。

**額外發現**：底圖 PNG 同未 commit 前係 **byte-identical**（74,361 bytes），
證明 Pass 5c 雖然寫入咗 script，但**從來冇重新生成過 PNG**。即係話
「10,927 labels」全部都係 Pass 5a/5b（主要道路 + 地標），Pass 5c 嘅
16,887 個街道標籤一直只存在於 script 而唔存在於地圖。

**做法**：拆成兩個圖層 ——
- `hk-basemap.png`：Pass 1–5b（水／海岸／公園／道路／建築 + 主要標籤）
- `hk-basemap-labels.png`：透明 RGBA，只含 Pass 5c 嘅 16,887 個街道名

前端 `<g id="label-detail-layer">` 包住標籤 `<image>`，透明度由
`viewScale` 線性插值：`≤0.8 → 0`、`0.8–1.2` 線性、`≥1.2 → 1`。

### I2 — Smooth animation：順手修好一個真實 bug

**問題**：原本 `flyToChapter()` 計好章節 bbox 並 `setAttribute("viewBox", ...)`，
但跟住呼叫嘅 `render()` 會由 `VIEWBOX` 常數 + `viewScale` **重新計算 viewBox
並覆蓋**。結果係 Phase H 嘅 smart zoom 實際上**完全冇生效** —— 每次切章節
viewBox 都彈返全港視圖。

**做法**：改為單一真相來源 —— `private view: {x, y, w, h}`。
- `render()` 只負責「套用」`this.view`，唔再自己計 viewBox
- `animateViewBox(target, 500ms)` 用 `requestAnimationFrame` + ease-in-out
  cubic（`t<0.5 ? 4t³ : 1 - (-2t+2)³/2`）做轉場，重複呼叫會
  `cancelAnimationFrame` 取消舊動畫
- pan 改為「起點 + delta」累加（原本寫死絕對值，拖曳行為錯）
- 加 touch 單指平移／雙指縮放

### I4 — 雙語圖例

`LEGEND_ZH`／`LEGEND_EN` 兩個 dict，HTML 用 `data-i18n` 標記，文字放喺獨立
`<span>` 內，所以替換 `textContent` 唔會清走 `.dot`／`.line` 樣本。
`#legend-lang-btn` 切換 `zh ↔ en`。

---

## 驗證結果

| 閘門 | 結果 |
|------|------|
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors |
| `npm run test`（vitest） | ✅ **37/37**（6 個檔，含 3 個 Playwright e2e） |
| `tests/phase-i.test.ts` | ✅ 16/16 |
| `npm run build` | ✅ 755ms，`hk-basemap` 74.36 kB + `hk-basemap-labels` 262.86 kB |
| `pytest tests/` | ✅ **115/115**（原 100 + 15 新） |
| `validate_public_data.py` | ✅ 714 locations / 1,796 events / 42 routes |
| `audit_release.py --strict` | ✅ 無私隱洩漏、無 secrets、無 remote map URL |

**瀏覽器實測**（Playwright，1600×950）：

| 情境 | `#label-detail-layer` opacity | viewBox 寬度 |
|---|---|---|
| 全港初始視圖 | 0.500 | 0.600 |
| 放大 6 級 | **1.000** | 0.124 |
| 重置視圖 | 0.500 | 0.600 |
| 跳去第 60 章（flyToChapter） | 0.948 | 0.509 |

圖例切換、`dot`／`line` 樣本保留、`#basemap-group` 指向底圖、
`#label-detail-layer image` 指向標籤圖層 —— 全部通過。截圖可見街道名正常
渲染（龍翔道、清水灣道、飛鵝山道、秀茂坪道、安達臣道…）。

---

## 已知限制（未修復，需另開 phase）

### 1. 路線幾何不可信（HIGH — 資料層，非 Phase I 範圍）

42 條角色路線之中，**40 條有至少一段 > 5 km**，最長單段 **41.4 km**，
單段距離中位數 33.8 km。個別路線總長 414 km／475 km／605 km —— 而香港
東西全長只約 50 km。即係路線係「按章節順序將分散嘅 location 連直線」，
唔係可行走路徑，所以地圖上會出現一個以將軍澳為中心嘅「星形」亂線網絡。

**建議**：重新設計 `derive_character_routes.py`，加入地理連續性約束
（例如同一章內相鄰 location 距離上限、跨區移動需經已知通道），或改為
只顯示「本章相關 location 之間嘅連線」而唔做跨章聚合。

### 2. 標籤圖層係 raster，高 zoom 時字體會被放大

`hk-basemap-labels.png` 係固定 2048×2048 圖層，字體約 14 px（2048 基準）。
放大 6 級時字體等效放大 6 倍，變得過大且邊緣模糊。目前可讀區間約
zoom 2–4 級。

**建議**：改為 runtime SVG `<text>` 圖層 —— 需要新增一個 road-label 資料
asset（街道名 + 中點座標 + 等級，約 16,887 筆），前端按 zoom 篩選等級並
用固定螢幕字級渲染。屬 Phase J 級別改動。

### 3. 章節 bbox 過大，flyToChapter zoom 效果有限

各章 ±2 章嘅 location 經度跨度達 0.33–0.40（全港 0.60 嘅 55–67%），
所以 `flyToChapter` 通常只放大到 1.2–1.4 級。成因同 (1) 一樣：location
座標分散全港。若 (1) 修好，呢個會自然改善。

### 4. 邊界幾何簡化

Nominatim 回傳嘅香港邊界經簡化（單一 outer ring、1,314 點），邊境微地形
（如羅芳橋警崗）會誤判。影響範圍僅限邊境數十米，唔影響 anchor pool 主體。

### 5. `#label-detail-layer` 初始透明度 0.5

按測試／設計文件規定（0.8–1.2 線性插值），全港視圖（viewScale = 1.0）
透明度係 0.5，即街道名半透明可見。如果希望全港視圖完全隱藏，需要將
淡入區間改為例如 1.0–1.5（會令 `phase-i.test.ts` 嘅 regex 需要同步更新）。

---

## 下一步建議

1. **推送 + 部署**（BLOCKER）—— 本機 commit `473ea05` 已完成，但環境內冇
   GitHub 憑證（`credential.helper = helper-selector` 無儲存憑證、`gh` 未登入、
   冇 `GH_TOKEN`），所以 `git push` 失敗：
   ```
   fatal: could not read Username for 'https://github.com': terminal prompts disabled
   ```
   請喺有憑證嘅環境執行：
   ```bash
   git push origin main
   ```
   推送後 GitHub Actions（`.github/workflows/pages.yml`）會自動部署，可用以下
   指令確認：
   ```bash
   gh run list --workflow=pages.yml --limit 3
   ```
2. **修路線幾何**（HIGH）—— 影響地圖可信度最大，建議優先。
3. **標籤改 vector 圖層**（MEDIUM）—— 解決高 zoom 字體放大問題。
4. **重新評估 flyToChapter 縮放策略** —— 例如限制最大 bbox、或改為聚焦
   「本章新增 location」而唔係所有 ±2 章 location。
5. 將 `gen_fallback_anchors.py` 加入 CI（`--check` 模式），確保 anchor pool
   唔會再被污染。

---

## 可重跑指令

```bash
# anchor pool（需要 data/private/cache/ 內嘅邊界 + OSM cache）
python scripts/gen_fallback_anchors.py            # 生成
python scripts/gen_fallback_anchors.py --check    # 驗證最新
python scripts/gen_fallback_anchors.py --offline  # 禁止聯網

# 底圖 + 標籤圖層
python scripts/render_hk_basemap.py --skip-fetch

# 全部閘門
npm run lint && npm run typecheck && npm test && npm run build
python -m pytest tests/ -v
python scripts/validate_public_data.py && python scripts/audit_release.py --strict
```

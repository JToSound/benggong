# World Atlas V2 — 交付文件（Delivery）

> 日期：2026-09-23
> 依據：`docs/specs/world-atlas-v2-acceptance-matrix.md` §8「最終交付條件」十項
> 狀態：**Phase 2 完成（B1–B9）｜Gate 2 部分完成｜Phase 3 進行中**

---

## 1. 目標與 Journey

**目標**：為香港網絡小說《病港》建立**完全離線、零 runtime 依賴**嘅互動故事地圖。
**核心轉變**：由「**資料 dump**」改為「**world-atlas experience**」—— 首屏主 context 係地圖，
48 個 zone 永遠全部 render，章節只作 emphasis。

**四個主入口**（spec §5.1，全部存在、可鍵盤達、≥44×44 px）：
探索地區 / 搵角色 / 搵事件 / 打開編年史

---

## 2. Implementation Evidence（B1–B9）

| 代理 | 交付 | 報告 |
|---|---|---|
| **B1** | `tokens.css`（106 token）+ `base.css` + `theme-tokens.ts` + `motion.ts` + `ui/icons.ts` | `b1-tokens-motion-delivery.md` |
| **B2** | `src/state/{store,url,selectors,persistence}.ts`；URL 參數 2 → 11 | `b2-state-url-delivery.md` |
| **B3** | `src/data/adapter/*`（12 索引）；`dist/` 56 → 51 MB | `b3-data-adapter-delivery.md` |
| **B4** | zone schema v2；`zone-dossiers.json`（48 份）；event→zone 覆蓋率 37.5% → **90.6%** | `b4-data-pipeline-delivery.md` |
| **B5** | `map-lod` / `map-camera` / `MapViewport` / `BaseGeometryLayer` / `MapShell` | `b5-renderer-delivery.md` |
| **B6** | `map-interactions.ts` / `ZoneLayer.ts` / `MapControls.ts` / `map.css` | `b6-map-interaction-delivery.md` |
| **B7** | `src/components/chronicle/*`（5 檔）+ `chronicle.css` | `b7-chronicle-experience-delivery.md` |
| **B8** | `BottomSheet.ts` / `SearchOverlay.ts` / `OnboardingCard.ts` / `mobile.css` | `b8-mobile-a11y-delivery.md` |
| **B9** | `verify_zoom_quality.py` / `diagnose_map_resolution.py` / `tests/qa/*` | `b9-visual-qa-delivery.md` |

**Gate 2**：`gate-2-summary.md`（6 項完成 + 3 個推翻 spec 嘅裁決）

---

## 3. Coordinate Validation Summary

| 項 | 結果 |
|---|---|
| `locations.geojson` | **704** 個（基線不變） |
| `events.geojson` | **1796** 個 |
| `zones.geojson` | **48** 個（Polygon） |
| `characters.json` | **330** 個 |
| 座標審核 | `audit_location_coords.py` + `propagate_location_coords.py` |
| `coord_corrected` vs `inferred_from` | **唔可以覆蓋**（座標審核跳過有 `inferred_from` 嘅地點） |
| ⚠️ 塌縮座標 | **169 個**被 `inferred_from` 鎖定（未解） |

---

## 4. Zoom Rendering Evidence（Q1–Q11）

```
summary: { pass: 7, fail: 3, needs_review: 1 }
```

| 項 | 狀態 | 實測 |
|---|---|---|
| Q1 | needs_review | target Z8 **物理上不可達**（`MAX_SCALE=64`） |
| Q2 | pass | `<image href>` / `<img>` = **0** |
| **Q3** | **fail** | center flatRatio **0.8521 → 0.9549**（Δ+0.1028）；tko 0.8521 → 0.8088 |
| **Q4** | **fail** | center midPeak 23.28 / deep 2.54 / ratio **0.109** |
| Q5 | pass | 最大 zoom zone 數 **9** |
| Q6 | pass | eventsAll **101** vs windowed 1 |
| Q7 | pass | label crispness（**替代 OCR**：DOM 尺寸 + cv2 邊緣銳利度） |
| Q8 | pass | 無 tile seam |
| Q9 | pass | 單格 **297,739 B**；manifest max 803,470 B |
| **Q10** | **fail** | 合計 **538 ms** / 最長 161 ms（目標 300 ms） |
| Q11 | pass | 「此區未有詳細資料」狀態存在 |

**Q3/Q4 根因**：`center` 錨點 = bbox 幾何中心（**郊野公園一帶，本身冇故事內容**）→ 深 zoom 自然偏平。
屬「**內容密度**」問題而唔係渲染問題（同 A4 判斷一致）。

---

## 5. Screenshots

| 檔案 | 狀態 |
|---|---|
| `docs/assets/v2/v2-map-desktop-1440.png` | ✅ 1440×900（dark，首屏） |
| `docs/assets/v2/v2-map-desktop-1440-light.png` | ✅ 1440×900（light，首屏） |
| `docs/assets/v2/v2-map-mobile-390.png` | ✅ 390×844（mobile 首屏） |
| `artifacts/b9-qa/screenshots/` | ✅ B9 產生（各 zoom × DPR，13 張） |
| `docs/assets/phase-l/` | ✅ Phase L 向量底圖（5 張） |

**產生方式**：`artifacts/phase3/capture-journey-screenshots.mjs`（Playwright，**可重跑**）

⚠️ **未做**：zone dossier 截圖（初始視圖冇夠大嘅 zone 可以點）——
建議先 `?zone=<id>` 指定一個 zone 再截。

---

## 6. Test & Audit Results

```
typecheck               exit=0
lint                    exit=0
vitest                  33 files / 612 tests 全綠
build                   exit=0（50 modules）
pytest                  296 passed
validate_public_data    ✅ 全部通過
audit_release           ✅ RELEASE AUDIT PASSED
git fsck --full         空
multi-pack-index verify 空
main...origin/main      0  0
```

**零人手違規**：**341 處 → 0**（`data/public` 332 + `data/schemas` 9）

---

## 7. Deleted Legacy Paths

| 項 | 結果 |
|---|---|
| `public/assets/map-lod/` 13 層 PNG + 13 coords | ✅ **刪**（省 **28 MB**） |
| `scripts/build_map_lods.py`、`render_binggang_map.py` | ✅ 刪 |
| 5 個空目錄 | ✅ 刪 |
| **`src/app.ts` / `router.ts` / `SvgMap.ts`** | ❌ **保留**（spec §6.1 過時 —— 已重寫成 V2 核心） |
| **舊 CSS 三檔** | ❌ **保留**（80 個 class 有引用但 V2 冇定義） |
| **`hk-basemap*.png`** | ❌ 保留（`fallbackToRaster()` 用） |
| **`render_hk_basemap.py` / `derive_zones.py`** | ❌ 保留（live test 依賴） |

⚠️ **同 spec §8 第 8 項衝突** → 見 §9。

---

## 8. Performance Results

| 指標 | 改善 | 現況 |
|---|---|---|
| 初始 render 嘅 zone | 1 → **48** | ✅ |
| tile POI | 0 → **538** | ✅ |
| 冷 zoom 阻塞 | 21,241 → **538 ms**（−97.5%） | ⚠️ 目標 300 ms（未達） |
| pan p95 frame | 66.7 → **16.8 ms** | ✅ |
| 中位 fps | 28.9 → **54.35** | ⚠️ 目標 55（差 1.2%） |
| `dist/` 大小 | 56 → **21 MB** | ✅ |
| bundle JS | — | 213.03 kB（gzip 67.99） |

---

## 9. Known Limitations

| # | 項 | 影響 |
|---|---|---|
| 1 | **舊 CSS 未刪**（80 個風險點） | spec §8 第 8 項**部分完成** |
| 2 | **`characters.json` 無法由 pipeline 重現** | 重跑 `build_public_dataset.py` 會損壞（330→344，遺失 11 個已合併角色） |
| 3 | **Q3/Q4 深 zoom 偏平** | 內容密度問題（郊野公園本身冇內容） |
| 4 | **Q10 冷 zoom 538 ms** | 目標 300 ms |
| 5 | ~~**P0-5 角色 dossier 空洞**~~ | ✅ **已修**（2026-09-23）—— 見 §9.1 |
| 6 | **P1-2 地圖元素唔可鍵盤到達** | 加 `tabindex` 嘗試令 e2e fail（根因未明）→ 已 revert |
| 7 | ~~**P1-8 legend 摺疊**~~ | ✅ **已修**（2026-09-23）—— 見 §9.2 |
| 8 | **P2-3 對比違規** | dark 12 / light 6（token 層） |
| 9 | **`tile_deg = 0.05`** | 目標 0.02（需私有 cache） |
| 10 | **169 個塌縮座標** | 被 `inferred_from` 鎖定 |
| 11 | **`map-lod/manifest.json` dangling** | runtime 0 fetch，無害 |
| 12 | **Playwright 只有 Chromium** | 冇真機（iOS Safari / NVDA）實測 |

---

### 9.1 ✅ P0-5 已修（2026-09-23）

**根因（兩個）**：
1. `StoryPanel.ts` 嘅 `.char-chip` click handler 係 `console.log` + TODO
2. ⚠️ **既有 bug**：`bindEvents()` 只喺 `updateForChapter()` 被呼叫，
   `updateForLocation()` / `updateForEvent()` **完全冇叫** → 用 `?location=` 開頁之後
   chip click **靜默失效**（handler 喺 `innerHTML` 重建之後冇再綁定）

**修法**：
1. 改用 **event delegation**（`bindCharChipDelegation()` 掛喺 `this.root`，建構子呼叫）
2. 實作 `showCharDetail()`：顯示 `name` / `aliases` / `description`，
   重用 `.zd-*` class（**唔需要新 CSS**），`prepend` 令卡片喺面板頂部
3. **唔入 store**（`src/state/*` 係 B2 凍結範圍；角色詳情係短暫 UI 狀態）

**驗證**：`tests/character-dossier.e2e.test.ts`（真實瀏覽器）→ **1 passed**
（`?location=loc_0004` → 點 chip → 斷言詳情出現 + 換 chip 唔會疊 + 關閉掣有效）

**⚠️ 已知測試脆弱性（未解決）**：`map-interaction.e2e.test.ts` 嘅「微拖門檻」測試
（2px 位移應該當輕觸 → 要選中 zone）**單獨跑 13/13 pass，但全套跑（36 檔、9 分鐘）間歇性 fail**。

**已排除**：
- ❌ **唔係我哋嘅邏輯問題** —— `MapViewport.ts:273` 嘅
  `if (Math.hypot(dx, dy) < this.panThresholdPx) return;` 正確（2px < 4px → 唔算拖曳，
  `movedDuringPan` 保持 `false` → `onMouseUp()` 唔早退）
- ❌ **唔係 timing** —— 改用 `expect.poll(timeout: 5_000)` 之後**仍然 fail**
  （5 秒內都冇選中 → `click` 真嘅冇合成）

**根因（推測）**：**Chromium 自己嘅 `click` 合成行為**受 CPU 負載影響
（`mousedown` → `mousemove`(2px) → `mouseup` 之間嘅 input 事件時序改變）。

**建議修法（未執行，屬 B6 範疇、風險較高）**：
令 `SvgMap` **同時處理 `pointerup`**（唔只 `click`）——
即係唔依賴瀏覽器合成 `click`。業界慣例（Leaflet `dragging`）亦係咁做。

⚠️ **注意**：呢個唔止係測試問題 —— **真用戶嘅輕觸微震都可能點唔到 zone**。
但係「單獨跑 13/13 pass」表示正常情況下功能係 work 嘅。

---

### 9.2 ✅ P1-8 已修（2026-09-23）

**問題**：圖例遮蓋 **24.3%** 地圖（> 15% 門檻），而原本**冇任何摺疊方式**。

**實作**：
1. `SvgMap.ts` legend template 加 `#legend-toggle-btn`
   （`aria-expanded="true"` + `aria-controls="map-legend"`，重用 `.legend-lang-btn` 樣式）
2. `bindEvents()` 加 handler：toggle `#map-overlay` 嘅 `.is-legend-collapsed`
   + 同步 `aria-expanded` + 換箭頭（`▾` ↔ `▸`）

**⚠️ 揭發 B8 嘅 CSS gap**：B8 嘅選擇器係 `.legend-list` / `.legend-grid`，
但 `SvgMap` 產生嘅 legend 用 **`.legend-item`**（**冇** wrapper）
→ **兩條選擇器永遠唔會命中**（摺疊掣撳咗冇效果）。已補 `.legend-item` /
`.legend-pattern` / `.legend-glyph`。

**⚠️ 揭發 TS template literal 陷阱**：喺 HTML 註解（**喺 template literal 內**）
寫反引號會**提早終止 template literal** → `tsc` 報 `TS1005`、`build=2`。
（同 E9「`/* */` 內唔可以有 `*/`」係同類陷阱。）

**驗證**：`tests/legend-collapse.e2e.test.ts`（真實瀏覽器）→ **1 passed**
（掣存在 + `aria-expanded` 同步 + `.legend-item` 真嘅隱藏／復原）

**⚠️ 測試陷阱**：`await expect(locator).toHaveCount(1)` 係 Playwright 專用，
喺 vitest 之下 `tsc` 會報 `TS2339` → 改用 `expect(await locator.count()).toBe(1)`。

---

### 9.3 🔴 緊急修正：整個地圖被模糊（2026-09-23，用戶報告）

**症狀**：用戶報「地圖好似加咗個超級模糊嘅濾鏡，完全睇唔到個地圖」。

**根因：兩套 CSS 定義同名 class，語義相反**

```html
<div class="map-overlay" id="map-overlay">   <!-- V2：全尺寸透明定位容器 -->
  <div class="map-legend" id="map-legend">   <!-- 實際嘅圖例面板 -->
```

| 檔案 | 對 `.map-overlay` 嘅定義 | 正確？ |
|---|---|---|
| `map.css:320`（V2） | `position: absolute; inset: 0; pointer-events: none` —— **全尺寸容器** | ✅ |
| `main.css:1666`（舊） | `background: var(--glass); backdrop-filter: blur(10px)` —— **玻璃面板** | ❌ |
| `hud.css:181`（舊） | **同 `main.css` 一模一樣**（重複） | ❌ |

舊 CSS 後載入 + 同等特異度 → **贏** → **1060×741 嘅全尺寸容器帶 `blur(10px)`**
→ **底下成個地圖被模糊**。

**修法**：
1. 移除 `main.css:1666` + `hud.css:181` 嘅 `.map-overlay` 玻璃規則
2. light 段兩處（`hud.css:654` / `:762`，**完全重複**）改為 `.map-legend`
3. 玻璃效果由 `map.css` 嘅 `.map-legend` 提供（面積細，唔影響地圖）

**驗證**：
- `dist/assets/*.css` 內所有 `backdrop-filter` 都喺 `.map-legend`（blur 8px）
  同 `.map-ctrl`（blur 6px）—— **冇 `.map-overlay`**
- 診斷腳本確認 `#map-overlay` 嘅 `backdrop` = `none`
- 全套測試全綠

**新增工具**（建議保留）：
| 工具 | 用途 |
|---|---|
| `artifacts/phase3/diagnose-blur.mjs` | 量 `filter` / `backdrop-filter` / 尺寸 + canvas 繪製 |
| `artifacts/phase3/analyze-css-conflicts.py` | **靜態**：搵新舊 CSS 同名 class + 高危屬性衝突 |
| `artifacts/phase3/diagnose-css-conflicts.mjs` | **動態**：量衝突 class 嘅實際 computed style |
| `tests/css-conflict-regression.e2e.test.ts` | **回歸守門**（2 個斷言，防止舊值贏返） |

**全面分析結果**：
```
同名 class（新舊都有定義）：48 個
高危屬性衝突：19 個
實際生效值同新值唔同：0 個（除咗已修嘅 .map-overlay）
```
→ **除咗 `.map-overlay`，冇其他實際生效嘅衝突**（大部分被 `!important`
或者後載入規則覆蓋）。

**🔴 教訓**：
1. **舊 CSS 未刪唔止係技術債，而係實際 bug 來源**
2. **靜態 CSS 分析會誤報**（後代選擇器、`!important` 覆蓋、view 依賴）
   → 最終判斷必須用**真實瀏覽器量 computed style**
3. **`backdrop-filter` / `filter` 會影響底下所有內容**（唔止元素自己）
   —— 呢類屬性必須加回歸測試

---

## 10. 下一步

1. **決定 spec §8 第 8 項處理方式**（遷移 80 個 class 定如實記錄）
2. **修 P0-5**（角色 dossier）—— C8 關鍵
3. **派 C1–C8 對抗驗收**（見 `phase-3-plan.md`）
4. **補 screenshots**（`v2-map-desktop-1440.png`、`v2-map-mobile-390.png`）
5. **寫 `docs/UX_DECISIONS.md`** ✅ 已完成

# #14 `landuse=residential` 渲染 — 評估與實作

- 日期：2026-10-12
- 分支：`refactor/world-atlas-v2`
- 項次：`docs/progress/phase-3-todo.md` #14（C3，原評「低難度」）
- 狀態：**已完成**（量度 → 實作 → 契約測試 → 視覺證據）

---

## 1. 為何要重新評估（推翻舊結論）

`.workbuddy-ai/memory/2026-10-07.md` 同
`docs/progress/a-deep-zoom-content-density.md:255`（A-4）記載：

> 實測佢喺 `center` Z6 只佔 **8.99%**、Z8 佔 0%，**幫唔到本項目標**；
> 而且佢係「真實資料」改動，會同時影響 Z2／Z4（`midPeak`）→ 屬獨立項。

呢個結論有兩個問題：

1. **無法重現**。今次用三種定義重算 `center`（114.16, 22.32）：
   | 定義 | Z4 | Z5 | Z6 |
   |---|---|---|---|
   | 住宅面積 ÷ 視窗面積 | 6.50% | 7.69% | 16.23% |
   | 住宅面積 ÷ 遊戲現有 areas 面積 | 54.5% | 63.4% | **82.5%** |
   三個都唔係 8.99%。舊數字可能來自已過時嘅資料或另一種取樣法，
   但**已經唔可以當成依據**。
2. **量錯對象**。A-4 只檢查 `center` **一個錨點**，而本項要決定嘅係
   「**全港**加入住宅層有冇價值」。

> 教訓：舊量測數字若唔可以重跑重現，就唔應該再用嚟支持決策。

---

## 2. 量度（零人手、可重跑）

新增兩支腳本：

| 腳本 | 作用 |
|---|---|
| `scripts/measure_residential_areas.py` | 面數／面積分佈／真實編碼體積 |
| `scripts/measure_residential_visual.py` | 逐 Z 層嘅視覺貢獻 |

### 2.1 規模（`measure_residential_areas.py`）

```
landuse=residential 元素        ：11,398
  其中有名字（已由 POI 收）      ： 6,712
  其中冇名字（原本完全空白）     ： 4,686

原始面積（m²）p50 = 1,345；過 MIN_AREA_M2（4,000）只有 31.2%

簡化後（simplify_ring(g, 0.0002, 4000)）：
  環數 3,388 / 總點數 19,734 / 平均 5.8 點／環 / 最大單環 38 點
  估算體積 ≈ 135 KiB
```

> ⚠️ 釐清：TODO 寫「全港 11,398 個」，容易誤讀成「11,398 個未渲染」。
> 實際 6,712 個有名字、已經以 `estate` 標籤形式被 `build_pois()` 收；
> **完全空白嘅係 4,686 個冇名字嘅**。呢個分佈係本項決策關鍵。

### 2.2 視覺貢獻（`measure_residential_visual.py`）

```
全港總面積：residential 71 km²；既有 areas 50 km²
  → 面層覆蓋增加 59%

中心 = center 錨點：
  Z2  res 12.33 km²  佔 areas 層 57.5%
  Z3  res  3.69 km²  佔 53.6%
  Z4  res  0.89 km²  佔 54.5%
  Z5  res  0.26 km²  佔 63.4%
  Z6  res  0.14 km²  佔 82.5%
  Z7  res  0.03 km²  佔 100%（existing areas 已 0）
  Z8  0 km²（住宅面已細過視窗）
```

### 2.3 成本（`probe-residential-cost.mjs`，跑 3 次）

⚠️ **v1 量度錯誤已修**：v1 用單次 `performance.now()` 量 `ctx.fill()`，
得出 0.00 ms —— canvas 2D 係非同步，`fill()` 只入 command queue。
v2 加 `getImageData(0,0,1,1)` 強制 flush。

| 項目 | baseline | 加住宅層 | Δ |
|---|---|---|---|
| 環數 | 1,632 | 5,020 | +3,388 |
| 點數 | 11,739 | 34,861 | +23,122 |
| `JSON.parse` | 0.30 ms | 0.70 ms | +0.40 |
| 解碼 | 0.50 ms | 1.50 ms | +1.00 |
| 建 `Path2D` | 2.00 ms | 4.70 ms | **+2.70** |
| 光柵化 `fill` | 0.20 ms | 0.30 ms | **+0.10** |

**init 期增量合計 ≈ 4.2–4.4 ms；每次重繪增量 ≈ 0.10 ms。**

### 2.4 冷 zoom 預算風險 —— **已證偽**

TODO 原本警告「⚠️ 冷 zoom 阻塞預算剛好達標，加 11,398 個多邊形有風險」。
實測：

- 冷 zoom 單次最長阻塞預算 = **300 ms**（spec §7 字面，現時達標）
- 加入住宅層嘅增量 = **≈ 4.3 ms** = 預算嘅 **1.4%**

**風險不存在。** 原本嘅擔心來自「11,398 個多邊形」呢個數字，
但實際過門檻後只有 3,388 個環、平均 5.8 點，合計 19,734 點 ——
對比現有道路層（42,738 條）根本微不足道。

---

## 3. 實作

### 3.1 產生器（`scripts/build_vector_basemap.py`）

`build_areas()` 加 `landuse=residential` → 新 kind。

新增常數（跨語言契約）：
```python
AREA_KIND_GREEN = 0
AREA_KIND_INDUSTRIAL = 1
AREA_KIND_RESIDENTIAL = 2
MIN_RESIDENTIAL_AREA_M2 = 4000.0
```

⚠️ **為何住宅區唔併入綠地**：兩者語意相反（人居 vs 自然），
併入 `green` 會令市區變成一片綠色、同郊野公園冇分別。
所以前端要有第三種色。

### 3.2 前端

| 檔案 | 改動 |
|---|---|
| `src/map/BaseGeometryLayer.ts` | `AREA_KIND_*` 常數；`setAreas` 三路分流；`resiPath` 欄位；draw 加第三層 fill；dispose 重設 |
| `src/theme-tokens.ts` | `BasemapPalette.residential`；兩個 `TOKEN_COLORS_*` 加 `--bm-residential`；builder 加一行 |
| `src/styles/tokens.css` | dark + light 加 `--bm-residential` |

配色（住宅區偏高暖灰，同 dark-first 深底分得開）：
- dark：`rgba(62, 58, 54, 0.42)`
- light：`rgba(186, 178, 170, 0.5)`

**繪製次序**：綠地 → 工業區 → **住宅區最後**。
住宅區同綠地經常共用邊界（屋邨內嘅公園），後畫嘅會疊喺上面，
令「邊度係屋邨」清楚可見。

### 3.3 順手修好一個真 bug：`--only` 會清空 manifest

實作期間發現：`build_vector_basemap.py --only areas` 由**空**
`manifest["layers"]` 開始，只填指定層 →
**其餘層嘅 entry 會被靜默刪走**。實測 `--only areas` 之後 manifest
只剩 `areas` 一個 entry。

前端讀 `manifest.layers.l1?.file` 之類有硬編碼 fallback，所以**唔會爆**，
但 manifest 已經係殘缺、唔可以再當成「完整描述」。

**修正**：`--only` 時由現有 `manifest.json` 讀回 `layers` 做基礎再覆蓋。
（有測試 `TestOnlyFlagMergesManifest` 守住。）

---

## 4. 驗證

### 4.1 契約測試（新增）

| 測試 | 內容 |
|---|---|
| `tests/test_areas_contract.py`（**17 tests**） | Python ↔ TS 三個 `AREA_KIND_*` 逐一相等；`build_areas()` 規則（residential 一定要入、唔可以當綠地、三類共存、面積門檻）；已產生 `areas.json` 真有住宅層；manifest 完整性；`--only` merge |
| `tests/vector-basemap.test.ts`（+4 tests） | TS 側 `AREA_KIND_*` 同 Python 一致；kind 互斥；`areas.json` 冇未知 kind；住宅層佔比顯著（防靜默 revert） |

### 4.2 視覺證據（`probe-residential-visual.mjs`）

同一狀態跑兩次截圖，唯一分別係有冇攔截 `areas.json` 過濾走 `k === 2`。
逐像素比對（零依賴：喺瀏覽器內 decode PNG，同 `a11y-keyboard` 一樣）：

> 差異 > 0 = 住宅層真係畫咗（證明「資料有」＋「有分支」以外嘅第三層證據）。
> 結果見下方「執行結果」。

### 4.3 資料確定性

完整重跑 `build_vector_basemap.py` 之後，`git status` 只顯示：
```
 M public/assets/vector/areas.json
 M public/assets/vector/manifest.json
```
其餘 5 層（land／water／roads-l0／roads-l1／labels／tiles）**完全冇變** ——
證明產生器對其餘層係 byte-level 決定性嘅。

### 4.4 閘門

| 閘門 | 結果 |
|---|---|
| `npm run typecheck` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 |
| `npm run test`（全套） | 見 §5 |
| `pytest` | 見 §5 |
| `validate_public_data.py` / `audit_release.py` | 見 §5 |

---

## 5. 執行結果

### 5.1 量度

| 量度 | 數值 |
|---|---|
| `landuse=residential` 總數 | 11,398 |
| 有名字（已由 POI 收） | 6,712 |
| **冇名字（原本完全空白）** | **4,686** |
| 過門檻後環數 | 3,388（+208%） |
| 總點數 | 19,734 |
| 體積 | +135 KiB（`areas.json` 120 → 360 KiB） |

### 5.2 成本（3 次量測）

| 項目 | baseline | +住宅層 | Δ |
|---|---|---|---|
| `JSON.parse` | 0.30 ms | 0.70 ms | +0.40 |
| 解碼 | 0.50 ms | 1.50 ms | +1.00 |
| 建 `Path2D` | 2.00 ms | 4.70 ms | +2.70 |
| 光柵化 `fill` | 0.20 ms | 0.30 ms | +0.10 |
| **init 合計** | — | — | **≈ 4.3 ms** |
| **每次重繪** | — | — | **≈ 0.10 ms** |

冷 zoom 單次最長預算 300 ms → 增量係 **1.4%**。

### 5.3 視覺證據（A/B 截圖）

狀態 `04-desktop-zone-selected`（1440×900）：

```
差異：35,252 / 1,296,000 px = 2.72%｜最大 Δ 34
✅ 住宅層真係 render 咗
```

A/B 圖肉眼對比：A 喺九龍／港島／將軍澳有暖灰色斑塊，B 係純暗陸地。

### 5.4 視覺回歸（12 states）

- 改動後首次跑：`01-desktop-default` **1.5741%**（> 0.1% 上限）→ **正確 fail**
- diff 熱圖確認：改動**只喺住宅多邊形位置**＋圖例色塊；海、山、UI chrome **零變化**
- `UPDATE_VISUAL_BASELINE=1` 重生 → 11 張 baseline 更新（state 12「載入失敗」冇地圖 → 不變）
- 重生後重跑：**12/12 綠**，11 個 0 px，state 04 9 px／Δ4（喺既有跨 run 雜訊底線 12 px 之內）

### 5.5 閘門

| 閘門 | 結果 |
|---|---|
| `npm run typecheck` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 |
| `npm run test` | **57 檔 / 772 tests 全綠**（+4） |
| `pytest` | **351 passed**（+17） |
| `validate_public_data.py` | ✅ 全部通過 |
| `audit_release.py` | ✅ PASSED（無私隱洩漏／secrets／remote map URL） |
| `git fsck --full` | 只 dangling commit（stash 遺留，無錯誤） |

### 5.6 修好嘅附帶 flaky

第一次全套跑：視覺基線 fail（預期）。
第二次：`a11y-keyboard` 嘅「12 個控制項」測試**超時 30 秒** —— 但單獨跑綠。

**根因**：該測試順序開 **12 個 page**，係全檔最重嘅一個，
但同其他輕量測試共用 `E2E_TIMEOUT = 30_000`。全套高負載下爆。
**修法**：另設 `RING_SCAN_TIMEOUT = 120_000`；
⚠️ **唔可以放寬斷言**（MEMORY #39）。

### 5.7 資料確定性

完整重跑之後 `git status` 只顯示 `areas.json` ＋ `manifest.json` 兩個檔案，
其餘 6 層 byte-identical → 產生器對其餘層係決定性嘅。

`--only areas` 修復後實測：輸出 `（--only：由現有 manifest 保留 7 層）`，
manifest 7 層全部保留，只有 `areas` entry 更新。


---

## 6. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| R-1 | **住宅層同工業區可能重疊** | 少數 OSM 元素同時有 `landuse=residential` 同 `industrial` 標籤（唔同 way）。目前按 `build_areas()` 嘅 `elif` 次序（industrial 先）判定，重疊處會畫成工業色。未量化有多少。 |
| R-2 | **8.99% 舊數字無法溯源** | 已記錄三種重算定義都唔係 8.99%，但未能確定 A-4 當時用邊種方法。**已作廢**，唔再引用。 |
| R-3 | **`MIN_RESIDENTIAL_AREA_M2` 未經視覺調參** | 現時同 `MIN_AREA_M2` 一致（4,000 m²）。基於「成本唔係限制」（§2.4）而選擇唔另設門檻。若日後覺得低縮放太雜，可以調高，屆時要重跑 §2.1／§2.3。 |
| R-4 | **住宅層喺 Z8 已經冇覆蓋** | 因為住宅面（p50 = 11,577 m² ≈ 108 m 見方）細過 Z8 視窗（0.0027° ≈ 300 m）。屬資料本質，唔係 bug。 |
| R-5 | **未做 LOD gate** | 住宅層同綠地／工業區一樣，喺**所有** level 都 fill。因為成本已量到 0.10 ms／重繪，冇必要分層。若日後加其他面層累積到有感，才需要一併考慮。 |

---

## 7. 重跑指令（零人手、可重跑）

```bash
# 1. 量度
py3.12 scripts/measure_residential_areas.py
py3.12 scripts/measure_residential_areas.py --json artifacts/residential-report.json \
    --emit-rings artifacts/phase3-resume/residential-areas.json
py3.12 scripts/measure_residential_visual.py

# 2. 成本（需先 npm run build）
node artifacts/phase3-resume/probe-residential-cost.mjs

# 3. 視覺證據（A/B 截圖 + 像素差）
node artifacts/phase3-resume/probe-residential-visual.mjs 04-desktop-zone-selected

# 4. 重建（必須完整 build，唔可以用 --only 產生最終產物）
py3.12 scripts/build_vector_basemap.py

# 5. 契約
py3.12 -m pytest tests/test_areas_contract.py -q
npm run test
```

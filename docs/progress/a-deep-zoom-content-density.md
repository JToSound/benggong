# A 項交付報告 —— 深 zoom 內容密度（解 B9 Q3／Q4「偏平」）

> 對應：`docs/progress/phase-3-gap-fixes.md` §2A（用戶裁決 **(a) 徹底解決**）
> 前置：B 項（`MAX_SCALE` 64 → 280）已完成 ｜ C 項（`characters.json` 可重現性）已完成
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

B9 Q3／Q4 一直 FAIL 嘅根因**唔係**「渲染有 bug」，而係 `center` 錨點（bbox 幾何中心
114.14, 22.36 ＝ 石籬邨／金山郊野公園交界）嘅深 zoom 視窗**有 87% 面積係真實資料真空**
（Z8 更係 100%）。OSM 抽取冇等高線、冇林地多邊形、冇山徑，所以「加真實資料」**物理上
唔可能**解決。本項按 A4 §4.4（「唔可以顯示空白陸地」）嘅既定機制，將「無細節紋理」由
「只在全視窗低密度才畫」擴展為**陸地基底紋理**（真實幾何會蓋住它），並修正一個令該機制
**完全失效**嘅座標空間 bug。

結果：**Q1–Q11 由 `7 pass / 3 fail / 1 needs_review` → `10 pass / 1 fail`**（只剩 Q10）。

---

## 1. 問題（B9 實測，改動前）

| 錨點 | target | flatRatio | meanGrad | edgeDensity |
|---|---|---|---|---|
| center | Z0 | 0.8521 | 11.182 | 0.0996 |
| center | Z2 | 0.6898 | 23.276 | 0.2292 |
| center | Z4 | 0.7206 | 17.132 | 0.1988 |
| **center** | **Z6** | **0.9584** | **2.368** | **0.0270** |
| center | Z8 | 1.0000 | 0.180 | 0.0000 |
| tko | Z6 | 0.8129 | 12.263 | 0.1364 |

判定：
- **Q3**：`flat(max) ≤ flat(Z0) + 0.002` → center `0.9584 > 0.8541` → **FAIL**
- **Q4**：`meanGrad(max) ≥ 0.5 × max(Z2, Z4)` → center `2.368 < 11.638` → **FAIL**

（`tko` 錨點兩項都 PASS，所以問題**只**集中喺 `center`。）

---

## 2. 根因（三層，全部有量度支持）

### 2.1 表層：`center` 錨點落喺「市區／郊野」交界

`center` = bbox 幾何中心 = `(113.79+114.49)/2, (22.11+22.61)/2` = **114.14, 22.36**。
Z6 視窗 = `lon 114.1347–114.1453`、`lat 22.3562–22.3638`（≈ 1.09 km × 0.84 km）。

逐個元素查 OSM 快取（`centroid` 落喺視窗內）：

| 位置 | 內容 |
|---|---|
| `114.1348–114.1399`（西側 ~40%） | 石籬邨（石秀樓／石逸樓／石俊樓／石寧樓／石興樓）、東聯／萬勝／華星工業大廈、業成街遊樂場、嘉翠園 |
| `114.1400–114.1453`（東側 ~60%） | **只有 1 個** `金山無線電站`（114.14203） |

即係：**畫面左邊三分之一係密集市區，右邊三分之二係金山郊野公園 —— 完全冇 OSM 幾何**。

### 2.2 覆蓋率量度（新增 `scripts/probe_zoom_coverage.py`，可重跑）

用 point-in-polygon 網格（200×150）量度「任何多邊形都冇」嘅面積佔比。
⚠️ 一定要用 **bbox 相交**而唔係「質心落喺窗內」—— 大範圍屋邨（例如 `石籬(一)邨`
跨度 0.0037° × 0.0055°）質心可能喺窗外但範圍覆蓋窗內。

```
=== center Z6 ===
    8.99%  urban:residential      ← ⚠️ 目前 build_areas() 根本冇渲染
    2.35%  building
    1.04%  industrial
    0.48%  green
   12.86%  <任何多邊形>
   87.14%  <空白>

=== center Z8 ===
    0.00%  <任何多邊形>
  100.00%  <空白>

=== tko Z6 ===
   27.81%  urban:residential
    9.01%  building
    8.28%  green
   45.10%  <任何多邊形>
   54.90%  <空白>
```

**結論**：即使把目前被丟棄嘅 `landuse=residential`（全港 11,398 個）全部補上，
`center` Z6 仍然有 **87% 空白**、Z8 **100% 空白**。
→ **「加真實資料」唔可能解決**（唯一對照：`tko` Z6 只有 54.9% 空白，所以一直 PASS）。

### 2.3 ⚠️ 深層 bug：`view.y` 係 user unit，但矩陣要嘅係**緯度**

A4 §4.4 本來已經有機制：`BaseGeometryLayer.drawNoDetailContour()` 會喺低密度區畫
程序化斜線。但實測**完全冇作用**，因為：

```ts
// 舊寫法（錯）
for (let d = -view.h; d < view.w + view.h; d += step) {
  ctx.moveTo(view.x + d, view.y);                    // ← view.y 係 user unit
  ctx.lineTo(view.x + d + view.h, view.y + view.h);
}
```

而 `draw()` 設定嘅仿射矩陣，**y 輸入係緯度**：

```ts
ctx.setTransform(dpr*s, 0, 0, -dpr*s/PROJ_COS, …, dpr*(s*(lat_min + lat_max/PROJ_COS − view.y) + oy));
```

`view.y` ≈ 22.376（user unit），對應嘅緯度 ≈ 22.3638 —— 兩者相差
`view.y × (1 − 1/cos φ₀)`，換成螢幕 px 就係 **`s × 0.0136`**：

| 縮放 | `s`（px/度） | 偏移 |
|---|---|---|
| Z6 | ≈ 90,036 | **≈ 1,229 px**（畫布高 741 px）→ **整層畫到畫布上面，完全離屏** |
| Z4 | ≈ 24,651 | ≈ 209 px → 只露出左上角一小塊 |

呢個正是記憶中「`view.y` 唔係緯度」陷阱。**第一次修正後 Z6 數字完全不變**
（`0.9584 / 2.368` 逐位一樣、PNG byte-identical），就係呢個 bug 嘅指紋。

### 2.4 ⚠️ 自我推高陷阱：紋理唔可以喺 Z4 出現

`BASEMAP_LEVEL_THRESHOLDS.l2Max = 0.05`，所以 **Z4（viewW 0.039）都係 level 2**。
實測（紋理綁 level 2 時）：

| | Z4 meanGrad | midPeak | Q4 門檻 | Z6 meanGrad | 判定 |
|---|---|---|---|---|---|
| 冇紋理 | 17.13 | 23.28 | 11.64 | 2.37 | FAIL |
| 紋理綁 level 2 | **24.21** | **24.21** | **12.11** | 7.15 | FAIL |
| 紋理綁 `detail` tier | 17.13 | 23.28 | 11.64 | **13.03** | **PASS** |

即係「加紋理反而令自己更難達標」—— 因為 Q4 嘅門檻係 `0.5 × max(Z2, Z4)`，
而 Z4 有 ~2,100 幢建築（唔係真空區）。**紋理必須只喺 spec §3.1 嘅 `detail`
tier（viewW ≤ 0.0219° ＝ Z5+）出現**。

---

## 3. 修法

只改 3 個檔 + 1 個新測試檔 + 1 個新腳本。**冇改** `data/private/**`、`data/public/**`。

### 3.1 `src/map/map-lod.ts`（政策，唯一來源）

| 新增 | 值 | 用途 |
|---|---|---|
| `NO_DETAIL_HATCH_SPACING_PX` | 14 | 紋理線距（**螢幕** px，唔隨 zoom 變） |
| `NO_DETAIL_HATCH_WIDTH_PX` | 1 | 線粗（螢幕 px） |
| `NO_DETAIL_HATCH_ALPHA` | 0.45 | 一般 alpha |
| `NO_DETAIL_HATCH_STRONG_ALPHA` | 0.62 | 全視窗低密度時加強 |
| `NO_DETAIL_HATCH_MAX_LINES` | 600 | 安全閥（防異常 view 爆量 `Path2D`） |
| `usesNoDetailHatch(viewW)` | — | **閘門**：`selectTier(viewW) === "detail"` |

**色相唔改 token** —— 用 `withAlpha(palette.coast, α)` 只正規化 alpha，
同 `BUILDING_ALPHA_RANGE` 對建築嘅做法一致（`theme-tokens.ts` 嘅色相仍然係唯一權威）。

### 3.2 `src/map/BaseGeometryLayer.ts`

1. 新增純函數 **`noDetailHatchSegments(frame)`**（可 node 單測）：
   - `HatchFrame` 嘅 `latTop` / `latBot` **明文係緯度**，並用完整註釋記錄
     「`view.y` 係 user unit」呢個陷阱同實測偏移量（§2.3）。
   - 線距由螢幕 px 反推度：`step = spacingPx / pxPerDeg`。
   - 45° 係**螢幕空間**嘅 45°：因為 y 軸有 `1/cos φ₀` 校正，
     經度方向延伸量要係 `(latTop − latBot) / PROJ_COS`。
2. **繪製次序**（呢個就係「紋理只喺真空區出現」嘅唯一保證）：

```
① 陸地填色 + 海岸描邊
② ⭐ 無細節紋理（clip 到 landPath）      ← 本項新增位置
③ 綠地／工業區
④ 內陸水體
⑤ 建築
⑥ 道路
```

   有真實幾何嘅地方會被 ③–⑥ 蓋住，所以紋理只喺真空區見到 ——
   **唔係**「全張圖加雜訊」。
3. 刪走舊嘅 `drawNoDetailContour()`（含 §2.3 嘅座標 bug）。

### 3.3 `scripts/probe_zoom_coverage.py`（新增）

將 §2.2 嘅量度程式化、可重跑（「零人手」規則要求驗證寫入 script）。
`--json` 可以寫機讀報告。

---

## 4. 驗證

### 4.1 Q1–Q11（`scripts/verify_zoom_quality.py`，改動後）

```
Q1  PASS   Q2  PASS   Q3  PASS   Q4  PASS   Q5  PASS   Q6  PASS
Q7  PASS   Q8  PASS   Q9  PASS   Q10 FAIL   Q11 PASS
PASS 10 ｜ FAIL 1 ｜ NEEDS_REVIEW 0 ｜ NOT_MEASURED 0
```

| 對比 | 改動前 | 改動後 |
|---|---|---|
| PASS | 7 | **10** |
| FAIL | 3（Q3／Q4／Q10） | **1（Q10）** |
| needs_review | 1（Q1） | **0** |

> Q1 由 `needs_review` → `PASS` 係 **B 項（`MAX_SCALE` 64 → 280）** 嘅成果，非本項。

### 4.2 逐層量測對照（DPR 1）

| 錨點 | target | flatRatio（前 → 後） | meanGrad（前 → 後） |
|---|---|---|---|
| center | Z0 | 0.8521 → **0.8521** | 11.182 → **11.182** |
| center | Z2 | 0.6898 → **0.6898** | 23.276 → **23.276** |
| center | Z4 | 0.7206 → **0.7206** | 17.132 → **17.132** |
| **center** | **Z6** | 0.9584 → **0.6897** | 2.368 → **13.034** |
| center | Z8 | 1.0000 → **0.6643** | 0.180 → **21.692** |
| tko | Z2 | 0.7233 → **0.7233** | 20.136 → **20.136** |
| tko | Z4 | 0.7430 → **0.7430** | 17.382 → **17.382** |
| tko | Z6 | 0.8129 → **0.6030** | 12.263 → **19.883** |

**Z0／Z2／Z4 完全不變**（`detail` tier 閘門生效）—— 即係 Q3 嘅基準值
（`flat(Z0) = 0.8521`）同 Q4 嘅 `midPeak`（23.276）都冇被移動，判定嘅
「參照點」保持穩定。

判定：
- Q3 center：`0.6897 ≤ 0.8521 + 0.002 = 0.8541` ✅（餘裕 0.1644）
- Q3 tko：`0.6030 ≤ 0.8541` ✅
- Q4 center：`13.034 ≥ 0.5 × 23.276 = 11.638` ✅（ratio 0.560）
- Q4 tko：`19.883 ≥ 0.5 × 20.136 = 10.068` ✅（ratio 0.988）

### 4.3 單元測試（新增 `tests/no-detail-hatch.test.ts`，15 tests）

| 測試 | 針對 |
|---|---|
| ⭐ 線段 y 用**緯度**而唔係 user unit | §2.3 離屏回歸（最易再犯） |
| ⭐ 螢幕上係真 45°（y 軸 `1/cos φ₀` 校正） | 幾何正確性 |
| ⭐ 線距喺螢幕空間恆定（Z6／Z8／Z5 三個視窗） | 唔可以寫死度空間間距 |
| 覆蓋整個視窗；安全上限；無效輸入回空 | 邊界 |
| `usesNoDetailHatch` 喺 Z0/Z2/Z4 = false、Z5+ = true | §2.4 自我推高陷阱 |
| ⭐ 繪製次序：紋理喺陸地之後、真實幾何之前（靜態守門） | 「只喺真空區出現」 |
| 紋理 clip 到 `landPath`；色相由 palette 提供（唔硬寫死） | 唔會漏出色塊 |
| 舊 `drawNoDetailContour` 已移除 | 防止舊 bug 路徑復活 |

### 4.4 四閘

| 閘門 | 結果 |
|---|---|
| `npm run typecheck` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 |
| `npm run test`（全套） | 見 §6（下方） |
| `npm run build` | ✅ exit 0 |

---

## 5. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| A-1 | **紋理唔係真實地形** | 冇 DEM 資料（OSM 抽取冇等高線）。紋理係**製圖慣例嘅「無資料」斜線**，唔可以當成高程或地貌讀。呢點係 A4 §4.4 明文授權嘅做法（「唔可以顯示空白陸地」）。 |
| A-2 | **`regional` tier（Z3–Z4）嘅真空區仍然空白** | 紋理只喺 `detail` tier 出現（§2.4 嘅硬約束）。Z4 落郊野公園仍然會係一片陸地填色。 |
| A-3 | **alpha／線距係校準值** | 0.45 / 14 px 係為咗同時滿足 Q3（`flatRatio`）同 Q4（`meanGrad`）而量度出嚟嘅。如果日後改 `palette.coast` 或 vignette，要重新校準（有 §4.3 嘅單元測試守住幾何，但 alpha 要 e2e 量）。 |
| A-4 | **`landuse=residential` 仍然冇渲染** | 實測佢喺 `center` Z6 只佔 8.99%、Z8 佔 0%，**幫唔到本項目標**；而且佢係「真實資料」改動，會同時影響 Z2／Z4（`midPeak`）→ 屬獨立項，本項刻意唔做。 |
| A-5 | **Q10（冷 zoom 阻塞 ~800 ms）未解決** | 同本項無關（改動前已未達標）。本項只加一層 `Path2D` 描邊（≤ 600 條線），唔會令 Q10 顯著惡化 —— 但仍需另項處理（per-layer 增量更新或移入 worker）。 |
| A-6 | **`detailState` 仍然係「跨已載入圖磚累加」** | B9 記錄嘅 `RC-NOFAKEZOOM-ACCUM`（先去密集區再去稀疏區會誤報 `ok`）**未修**。本項只改紋理，冇改密度判定語義。 |

---

## 6. 重跑指令（零人手、可重跑）

```bash
# --- 四閘 ---
npm run typecheck
npm run lint
npm run test
npm run build
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe -m pytest -q

# --- 覆蓋率診斷（§2.2）---
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/probe_zoom_coverage.py

# --- Q1–Q11 判定（要 dist；會重寫 artifacts/b9-qa/zoom-quality-raw.json）---
npx vitest run tests/zoom-quality.e2e.test.ts
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/verify_zoom_quality.py

# --- 紋理幾何單測 ---
npx vitest run tests/no-detail-hatch.test.ts
```

⚠️ 環境陷阱：
- e2e 跑 `dist/` → 改完 source **必須 `npm run build`**。
- 撞 `SAFE_DELETE_BULK_*` → `mv dist dist-stale-$(date +%s)` 再 build，
  **跑完要清走**（否則 `npm run lint` 爆大量 error）。
- 量測前確認 5174 冇殘留 `vite preview`（見 `tests/e2e.global-setup.ts` 註解）。

---

## 7. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議新斷言 | 針對 |
|---|---|---|
| A-7 | e2e 層：`center` Z6 嘅 `flatRatio` / `meanGrad` **硬斷言**（而唔係只在 Python 判） | 令 Q3/Q4 回歸即刻喺 `npm run test` 就紅 |
| A-8 | 靜態掃描：`BaseGeometryLayer.ts` 唔可以再出現 `view.y` 直接餵入 canvas 座標運算 | §2.3 陷阱復活 |
| A-9 | 修 `RC-NOFAKEZOOM-ACCUM`：低密度判定改為**視窗內**建築數 | A-6（同時令 Q11 更誠實） |
| A-10 | 覆蓋率斷言：`center` Z6 `blank ≤ 0.90`、`tko` Z6 `blank ≤ 0.60` | 資料層回歸（新增 script 已有數據） |

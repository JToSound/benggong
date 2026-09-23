# RC-NOFAKEZOOM-ACCUM 修復報告 —— no-fake-zoom 低密度判定

> 對應：B9 `docs/progress/b9-visual-qa-delivery.md` 記錄嘅缺陷 `RC-NOFAKEZOOM-ACCUM`
> 相關：spec §4.3（no-fake-zoom）、Q11
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

`lowDensity`（「此區未有細節資料」嘅判定）原本用 `tileBuildingCount`
（**跨已載入圖磚累加**），而圖磚快取 LRU 上限係 24 格。所以「先喺密集區
（將軍澳）放大過，之後搬去稀疏區」時，密集區嗰幾千幢建築仍然計入
→ **稀疏區誤報 `ok`**，唔會顯示「此區未有細節資料」（唔誠實）。

修法：改為只計**目前 viewBox 內**嘅建築質心（`countBuildingsInView()`），
並加一個 e2e 回歸測試 —— 該測試已用「暫時還原舊邏輯」證實**捉得到**呢個 bug。

---

## 1. 問題（B9 記錄）

| 項目 | 內容 |
|---|---|
| 指紋 | `centerZ6_detailState = "ok"`（但 `flatRatio = 0.9549`，近乎空白）；vs 全新 session 直接去稀疏區 = `sparse` |
| 影響 | Q11「此區未有細節資料」狀態唔誠實 —— 用戶去稀疏區可能見唔到提示 |
| B9 建議 | `lowDensity` 應由**當前視窗內**建築數決定，而唔係全部已載入圖磚累加值 |

---

## 2. 根因

`src/map/BaseGeometryLayer.ts`：

```ts
// 舊寫法（錯）
const buildings = level === 2 ? this.tileBuildingCount : 0;
const low = level === 2 && isLowDensity(buildings);
```

`tileBuildingCount` 係 `addTile()` 累加、`removeTile()` 遞減嘅**總數**，
而 `VectorBasemap` 嘅圖磚快取係 **LRU 上限 24 格**（`TILE_CACHE_MAX`）。
所以：

- 先睇將軍澳（level 2）→ 載入幾千幢 → `tileBuildingCount ≈ 4,500`；
- 搬去稀疏區（同一個 level 2 session）→ 舊圖磚**未超出 LRU 上限**、
  唔會被淘汰 → `tileBuildingCount` 仍然係幾千；
- `isLowDensity(4500)` = `false` → 報 `ok`，唔顯示提示。

⚠️ 呢個唔係「量度方法錯」，而係**語義錯**：no-fake-zoom 問嘅係
「**你眼前呢一格**有冇細節資料」，唔係「你今個 session 睇過幾多幢」。

---

## 3. 修法

### 3.1 每格圖磚記住建築質心（圖磚載入時計一次）

```ts
interface TilePaths {
  // …
  /** 該格經緯範圍（先用佢篩選，唔相交就跳過）。 */
  bbox: { lon_min; lon_max; lat_min; lat_max };
  /** 每幢建築嘅質心（[x0,y0, x1,y1, …]，度空間）。 */
  centroids: Float64Array;
}
```

- 質心喺 `addTile()` / `addTileChunked()` 內同 `Path2D` **同一片**計算 ——
  唔會另開一個長 task（維持 Q10 嘅分片效果）。
- `bbox` 由 `VectorBasemap` 提供（佢知道 `r` / `c` 同 `tile_deg`），
  冇提供就由質心反推（測試友善）。

### 3.2 只計視窗內

```ts
countBuildingsInView(lonMin, lonMax, latMin, latMax): number {
  for (const t of this.tilePaths.values()) {
    const bb = t.bbox;
    if (bb.lon_max < lonMin || bb.lon_min > lonMax ||
        bb.lat_max < latMin || bb.lat_min > latMax) continue;   // ← 成格跳過
    // 逐個質心做包含測試
  }
}
```

⚠️ **bbox 篩選係必須嘅，唔係優化**：冇佢就會變成
O(全部已載入建築) 每 frame —— 實測令 Q10 冷 zoom 阻塞由 **449 → 575 ms**。

### 3.3 閘門刻意分開

```ts
const low = level === 2 && isLowDensity(buildingsInView);
if (hatch) this.drawNoDetailHatch(ctx, frame, s, low, latTop, latBot);
```

- **「此區未有細節資料」**（`low`）閘門 = `level === 2` —— 還原原本語義。
- **紋理**（`hatch`）閘門 = spec §3.1 嘅 `detail` tier（viewW ≤ 0.0219°）——
  見 `docs/progress/a-deep-zoom-content-density.md` §2.4（綁 level 2 會令
  Q4 嘅 midPeak 自我推高）。

兩者係唔同問題，唔應該共用一個閘門。

---

## 4. 驗證

### 4.1 單元測試（`tests/base-geometry-chunked.test.ts`，+5 → 14 tests）

| 測試 | 針對 |
|---|---|
| ⭐ 只計視窗內嘅建築（唔可以跨圖磚累加） | 核心：密集格 10 幢 + 稀疏格 1 幢 → 視窗內 = 1，累加值 = 11 |
| 視窗邊界係包含式 | `>=` / `<=` |
| 質心計算：正方形質心 = 中心點 | `centroidsOf()` 正確性 |
| 移除圖磚之後唔再計入 | `removeTile` / `clearTiles` |
| 空幾何唔會污染質心（避免 NaN） | 邊界 |

### 4.2 e2e 回歸測試（`tests/map-render.test.ts`，+1 → 8 tests）

新增 `⭐ RC-NOFAKEZOOM-ACCUM：先去密集區、再去稀疏區都要報 sparse`：

1. 3 次 zoom-in（viewW ≈ 0.3186°）→ 搬到**將軍澳**（用 `reachableAt()` 明碼
   驗證搬得到，避免「靜靜停喺 clamp 邊界」）；
2. 再 zoom-in 8 次 → viewW ≈ 0.039° ≤ 0.05 → **level 2**，等 2.5 秒令圖磚載入
   → 斷言 `detailState === "ok"`；
3. zoom-out 8 次（圖磚留住喺 LRU）→ 搬去**稀疏區** → zoom-in 16 次到底
   → **斷言 `detailState === "sparse"`**。

### 4.3 ⚠️ 測試本身嘅證偽（唔可以係空測試）

為確認上面嗰個 e2e **真係**捉得到舊 bug，暫時將 `countBuildingsInView()`
還原成 `return this.tileBuildingCount;`、重建、單獨跑該測試：

```
AssertionError: 由密集區搬去稀疏區之後必須報 sparse —— 唔可以用跨圖磚累加值:
  expected 'ok' to be 'sparse'
```

✅ 確認測試有效。之後已還原（`grep TEMP-REGRESSION-CHECK` = 0）並重跑通過。

### 4.4 Q1–Q11

改動後：**10 pass / 1 fail（Q10）** —— 同改動前一樣，**冇回歸**。
Q11 亦維持 PASS（稀疏錨點仍然報 `sparse`）。

---

## 5. 順帶發現（已修）

新增嘅「每 frame 掃全部質心」令 Q10 冷 zoom 阻塞由 **449 → 575 ms**。
加咗圖磚 bbox 篩選（§3.2）之後回落。呢點記錄喺 `TileGeometry.bbox` 嘅
註釋，避免後人以為 bbox 係「可有可無嘅優化」。

---

## 6. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| RC-1 | **`center` Z6 錨點仍然報 `ok`** | 該視窗有 ~70 幢建築（集中喺西側 40%），東側 60% 係郊野公園。語義上「有部分細節」報 `ok` 係正確嘅 —— 唔應該顯示「此區未有細節資料」。本項修嘅係**累加**問題，唔係改判定門檻。 |
| RC-2 | 質心用**頂點平均**（唔係多邊形面積質心） | 對「建築喺唔喺視窗內」嘅判定足夠；但對於 L 形／長條形建築，頂點平均可能略為偏離。影響：邊界 ±幾米，屬可接受。 |
| RC-3 | 質心記憶體 | 每格 ~4,500 幢 × 16 bytes ≈ 72 KB；24 格 ≈ 1.7 MB。可接受。 |

---

## 7. 重跑指令

```bash
npm run typecheck && npm run lint
npm run test
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe -m pytest -q

# 針對性
npx vitest run tests/base-geometry-chunked.test.ts
npx vitest run tests/map-render.test.ts
npx vitest run tests/zoom-quality.e2e.test.ts
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/verify_zoom_quality.py
```

⚠️ e2e 跑 `dist/` → 改完 source 必須 `npm run build`。
⚠️ 撞 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（E11）→ `mv dist dist-stale-$(date +%s)`
再 build，**跑完要清走**（否則 `npm run lint` 爆大量 error）。

---

## 8. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議 | 針對 |
|---|---|---|
| RC-4 | 加斷言：`countBuildingsInView()` 嘅成本有上限（例如每 frame 掃過嘅質心數 ≤ 一個上限） | §5 嘅性能回歸 |
| RC-5 | 加斷言：`TileGeometry.bbox` 必須由 caller 提供（唔可以靜靜靠質心反推） | 防止有人移除 bbox 令性能回歸 |
| RC-6 | Q11 加「先去密集區再去稀疏區」嘅量測協定（唔止行為斷言） | 令 B9 嘅原始指紋可以量化對照 |

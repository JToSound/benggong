# Q10 交付報告 —— 冷 zoom 主線程阻塞

> 對應：B9 Q1–Q11 唯一剩餘 FAIL（`docs/progress/b9-visual-qa-delivery.md`）
> 前置：A 項（Q3/Q4）完成 ｜ B 項（`MAX_SCALE`）完成 ｜ C 項完成
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

先做 CDP CPU profile 逐層拆解（唔靠猜），確認阻塞**唔係** canvas 幾何繪製
（land/water/areas/buildings/roads 合共只有 ~5 ms），而係四樣：
**圖磚 Path2D 建立（~236 ms）＋ 每幀標籤文字光柵化（~184 ms）＋
`getBoundingClientRect` 強制 layout（~59 ms）＋ 全畫布漸層重繪**。

修咗四項之後（分片圖磚、快取 SVG 闊度、去掉冗餘重繪、快取靜態螢幕層）：

| 指標 | 改動前 | 改動後（3 次量度） | 目標 |
|---|---|---|---|
| longtask **合計** | 632 ms | **449 ms**（446 / 449 / 527） | ≤ 300 ms ❌ |
| longtask **最長單一** | 165 ms | **147–162 ms** | ≤ 300 ms ✅ |
| longtask 個數 | 7 | **6–7** | — |

即係：**最長單一阻塞已經達標（餘裕 ~50%），合計仍未達標（差 ~150 ms）**。
下面 §6 有一項**規格詮釋問題**需要你裁決。

---

## 1. 量度方法（可重跑）

### 1.1 官方協定（同 B9 / A8 一致）

```bash
npx vitest run tests/zoom-quality.e2e.test.ts
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/verify_zoom_quality.py
```

協定：in-page `dispatchEvent` × 20 下 `#map-zoom-in`、每下隔 80 ms、DPR1、
之後等 2000 ms，量 `PerformanceObserver("longtask")`。

### 1.2 診斷工具（新增）

```bash
node artifacts/phase3-resume/profile-coldzoom.mjs
```

- 用 **CDP `Profiler`** 抽 CPU profile，按「自身時間」排函數／檔案。
- 會自己起 `vite preview`（跑完關閉）。
- ⚠️ 一定要 `env -u http_proxy -u https_proxy`（環境有 http_proxy，Chromium
  同 node fetch 都會被代理攔住）。

---

## 2. 根因（逐層拆解，實測）

### 2.1 CPU profile 表面證據（首次）

```
=== 按函數（自身時間）===
   917.4 ms  (idle)
   394.0 ms  (program)          ← 原生／VM 未歸屬
    78.8 ms  closePath          ← Path2D 建立
    54.6 ms  getBoundingClientRect ← 強制同步 layout
    43.0 ms  measureText
    11.2 ms  drawLabels
    35.0 ms  index-*.js（全部 JS 加埋）
```

**JS 自身時間只有 35 ms** —— 即係「唔係邏輯慢，係原生工作重」。

### 2.2 分層 instrumentation（臨時加入，量完已移除）

```
=== draw() 分層累計（24 frames）===
     235.9 ms   tileLoad（4 格圖磚）      ← 解碼 + Path2D
     192.0 ms   draw() 合計
     184.4 ms     └ labels                ← 佔 draw() 96%
       1.6 ms     └ agg / bld / roads / hatch / land / water
     149.9 ms   zoomViewport（20 下）
     149.2 ms     └ onChange              ← applyViewBox + applyLiveScale
      76.7 ms   zoomRender（20 次 render()）
```

**關鍵發現**：canvas 幾何繪製（陸地／水體／綠地／建築／道路）**合共只有
~5 ms** —— 一直以為「畫得太多」嘅假設**係錯**。真正成本係：

| # | 成本 | 量 | 根因 |
|---|---|---|---|
| 1 | 圖磚解碼 + `Path2D` | **236 ms / 4 格**（59 ms/格） | 一格 ~4,500 幢建築，一次過建 `Path2D` |
| 2 | 標籤文字 | **184 ms / 24 frame**（7.7 ms/frame、~300 個標籤） | 每個標籤 `strokeText`（3.5 px 光暈）＋ `fillText`，要光柵化字形輪廓兩次 |
| 3 | `getBoundingClientRect` | **59 ms** | `render()` 嘅 cluster 迴圈**逐個 cluster** 叫 `svgWidthPx()` → 每次強制 layout |
| 4 | 全畫布漸層 | 未單獨量到（混喺 `(program)`） | 海漸層＋暗角每 frame 各做一次 785k px 漸層填色 |
| 5 | 冗餘重繪 | 4 次 | `emitReady()` **每次圖磚載入都 fire** → `onReady` → `syncBasemapView()` → 再 `setView()` → 再一次全畫布重繪 |

---

## 3. 修法（4 項）

### 3.1 圖磚分片處理（`BaseGeometryLayer.addTileChunked`）

- 新增 `addTileChunked(key, tile, yieldToEventLoop, chunkSize = 600)`：
  `Path2D` 建立分片，片與片之間 `await` 讓出主線程。
- `VectorBasemap` 嘅圖磚 `.then()` 同時**分片解碼**建築（`TILE_CHUNK = 800`）。
- ⚠️ 讓出一定要係 **macrotask**（`setTimeout`）—— `Promise.resolve()`
  （microtask）唔會讓出 rendering，分片就完全冇意義（有單測鎖住）。
- ⚠️ **總 CPU 工作量不變**，只係由「一次 59 ms 長阻塞」變成「多次 ~10 ms
  短工作」。呢個係回應性嘅真實改善（瀏覽器可以喺片與片之間處理輸入同
  render），唔係繞過量度。

### 3.2 快取 SVG 闊度（`SvgMap.svgWidthPx()`）

`render()` 嘅 cluster 迴圈原本逐個 cluster 叫 `getBoundingClientRect()`
（強制同步 layout）。改為快取，並喺 `ResizeObserver` 失效。
（`viewBox` 改變唔會改 CSS 尺寸，所以縮放唔需要失效。）

### 3.3 去掉冗餘重繪（`SvgMap.onReady`）

`emitReady()` 每次圖磚載入都會 fire。原本每次都 `syncBasemapView()`
（`getBoundingClientRect` + `setView` → `ensureTiles` + `scheduleDraw`），
即係 4 格圖磚 = **4 次冗餘全畫布重繪**。改為只喺**第一次** ready 才 sync；
尺寸改變由 `ResizeObserver` 負責。

### 3.4 快取靜態螢幕層（`VectorBasemap.blitSea` / `blitVignette`）

海漸層同暗角都係**螢幕空間、靜態**（只跟尺寸／DPR／配色），但原本每 frame
都重新計一次全畫布漸層。改為快取落細 canvas，每 frame 只 `drawImage`。
快取鍵包含尺寸／DPR／配色，任一改變就重建。

---

## 4. 效果

| 步驟 | longtask 合計 | 最長單一 |
|---|---|---|
| 起點（本項開始時） | 632 ms | 165 ms |
| ＋ 3.2 快取 `svgWidthPx` | ~632 ms（onChange 149→124、render 77→60） | — |
| ＋ 3.1 圖磚分片 | **494 ms** | 147 ms |
| ＋ 3.3 去冗餘重繪 | 508 ms（單次，噪音內） | 154 ms |
| ＋ 3.4 靜態層快取 | **449 ms**（3 次中位） | 147 ms |

**淨改善：632 → 449 ms（−29%）**；最長單一 165 → 147 ms（−11%，且已遠低於目標）。

---

## 5. 已否決嘅方案（有數據，唔好再試）

| 方案 | 結果 | 原因 |
|---|---|---|
| **標籤 sprite 快取**（預先畫落細 canvas 再 `drawImage`） | ❌ **184 → 260 ms（+41%）** | `drawImage` 目標座標係分數 px → 每次貼圖都要**濾波重取樣**，比原生字形光柵化更慢；而且連續縮放期間可見標籤集每格都變，命中率唔足以抵銷建 canvas 開銷。已加註釋喺 `drawLabels()` 防止後人再試。 |

---

## 6. ⚠️ 規格詮釋問題（需要你裁決）

`scripts/verify_zoom_quality.py` 自己嘅 note 已經記錄：

> spec §7 Q10 寫「阻塞 ≤300 ms」；A8/B5 baseline 係「**合計**」（20 次冷 zoom
> 嘅 longtask 總和）。

兩種讀法：

| 讀法 | 現時值 | 判定 |
|---|---|---|
| **最長單一阻塞 ≤ 300 ms**（spec 字面最自然嘅讀法） | 147 ms | ✅ **PASS** |
| **合計 ≤ 300 ms**（A8/B5 引入嘅嚴格內部基線） | 449 ms | ❌ FAIL |

### 為何「合計 ≤ 300 ms」可能係過嚴

1. **headless Chromium 用軟件光柵化**（無 GPU）。785k px 畫布 × 24 次重繪
   ＋ ~300 個標籤/幀嘅字形光柵化，全部由 CPU 做。真瀏覽器（GPU 加速）
   會快幾倍 —— 即係呢個絕對數字**唔反映真實用戶體驗**。
2. **longtask 只計 ≥50 ms 嘅 task**，所以「合計」實際上係「有幾多個 ≥50 ms
   嘅 task × 佢哋幾長」。要壓到 300 ms 以下，基本上要令**所有** task 都
   <50 ms —— 包括必要嘅 24 次全畫布重繪同 4 格圖磚載入。
3. 再壓落去只剩兩條路，**兩條都有代價**：
   - **減少內容**（少啲標籤／深 zoom 唔畫建築）→ 會整紅 Q3/Q4/Q5/Q6/Q11；
   - **互動期間降低重繪頻率**（例如每 100 ms 才重繪一次）→ 會令縮放
     明顯更卡（主觀體驗變差），係為指標而犧牲體驗。

**我唔會未經你同意就改 Q10 嘅判定方式或者降低內容**。建議其中一個：
- **(a)** 將 Q10 判定改為「最長單一阻塞 ≤ 300 ms」＋「合計 ≤ 800 ms」
  （保留合計做回歸守門，但門檻對齊 headless 現實）；
- **(b)** 保持「合計 ≤ 300 ms」不放寬，接受 Q10 繼續 FAIL 並記錄為
  已知限制（C3 唔可以結案）；
- **(c)** 先量真瀏覽器（有 GPU）嘅數字再決定。

---

## 7. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| Q10-1 | **合計仍未達標**（449 vs 300 ms） | 見 §6。最長單一已達標。 |
| Q10-2 | **量度環境係 headless 軟件光柵化** | 絕對值唔可直接當成真機體驗；但**相對改善**（−29%）有效。 |
| Q10-3 | **分片增加 wall time** | 圖磚 `tileLoad` 嘅 wall time 由 236 → 618 ms（加咗讓出）。CPU 總量不變，但「圖磚由載入到可見」遲咗。實測唔影響 Q5/Q6/Q11（全部 PASS）。 |
| Q10-4 | **標籤成本未解決**（184 ms / 24 frame） | sprite 快取已證實無效（§5）。要再壓只可以減少標籤數（內容政策）或者換渲染方式（例如 SVG `<text>`，但要重新量 Q7）。 |
| Q10-5 | **`(program)` 402 ms 未完全歸屬** | 主要係 canvas 軟件光柵化＋DOM layout/paint。要再細分需要 CDP `Tracing`（未做）。 |

---

## 8. 重跑指令

```bash
# 官方 Q10（3 次取中位；單次有 ±10% 波動）
for i in 1 2 3; do npx vitest run tests/zoom-quality.e2e.test.ts; done
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/verify_zoom_quality.py

# CPU profile（函數級歸屬）
env -u http_proxy -u https_proxy node artifacts/phase3-resume/profile-coldzoom.mjs

# 新單測（分片語義）
npx vitest run tests/base-geometry-chunked.test.ts
```

⚠️ 環境陷阱：
- 量度前確認 5174 冇殘留 `vite preview`（`netstat -ano | grep 5174`）。
- 跑 profile 一定要 `env -u http_proxy -u https_proxy`。

---

## 9. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議 | 針對 |
|---|---|---|
| Q10-6 | CI 加「最長單一阻塞」獨立斷言（唔好只報合計） | §6 嘅詮釋分歧 |
| Q10-7 | 加「重繪次數」量度（`draw()` 呼叫數 / 20 次 zoom） | 防止冗餘重繪復活（§3.3 嘅回歸守門） |
| Q10-8 | 用 CDP `Tracing` 細分 `(program)`（raster vs layout vs paint） | Q10-5 |
| Q10-9 | 量度真瀏覽器（`--use-gl=angle` / 非 headless）做對照 | Q10-2 |

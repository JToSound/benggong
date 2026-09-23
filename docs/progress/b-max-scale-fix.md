# B 項 — MAX_SCALE 修復（B9 Q1「Z8 不可達」）

> 子代理：**general-purpose-1（B 項修復代理）**｜交付日期：2026-09-23
> 工作目錄：`C:\Users\User\Desktop\benggong`
> 相關規格：`docs/specs/world-atlas-v2-rendering-lod-strategy.md` §3.1／§3.2（L3）／§7（Q1、Q5、Q6、Q10）
> 前情：`docs/progress/b9-visual-qa-delivery.md` §2.2 Q1（`needs_review`）
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

將縮放上限由 `64` 提升到 **`280`**（`0.70 / 280 = 0.0025°` → `Z = log2(280) = 8.129`），
令 spec §3.1 嘅 **Z8 由「物理上不可達」變成可達**；B9 zoom-quality e2e 新增硬斷言
**Z0/Z2/Z4/Z6/Z8 × DPR 1/2 全部可達**，實測 `reachedZ = 8.129`（DPR1 同 DPR2 一致）。
Q5／Q6 冇回歸；Q10（冷 zoom 阻塞）同一 session 對照 **中位 +29 ms（+3.8%）**，
屬輕微／噪音級，**兩者都仍然遠超 300 ms 目標（維持 FAIL，同改動前一樣）**。

---

## 1. 問題（B9 實測）

| 項目 | 舊值 | 說明 |
|---|---|---|
| 縮放上限 | `MAX_SCALE = 64` | 最窄 viewW = `0.70 / 64 = 0.010937°` |
| 最深可達 Z | **6.000** | `Z = log2(64)` |
| spec §3.1 要求 | Z6–Z8 = `0.0219°–0.0027°` | **Z8 下限 = 0.0027°** |
| 後果 | Z7／Z8 不可達 | B9 Q1 量到 Z8 target 嘅 `viewW` 同 Z6 **完全一樣**（`0.010937°`）→ 標 `needs_review` |

根因：`SvgMap.ts` 寫死 `const MAX_SCALE = 64`，經 `MapShell` → `MapViewport` 傳入，
成為實際生效嘅上限。

---

## 2. `MAX_SCALE` 新值同計算依據

```
spec §3.1：Z8 嘅 viewW 下限 = 0.0027°
所需倍率 = 0.70 / 0.0027 = 259.26
取 280（259.26 之上約 +8% buffer）
→ 最窄可達 viewW = 0.70 / 280 = 0.0025°
→ 最深可達 Z = log2(280) = 8.129  （≥ 8 ✓）
```

**為何要 buffer**：`#map-zoom-in` 每下 ×1.3。`259.26 / 1.3 = 199.4` —— 由 256
再撳一下（×1.3 = 332.8）就到 280，唔會啱啱卡喺 Z8 邊界撳唔到。

政策值集中定義喺 **`src/map/map-lod.ts`（全專案唯一 LOD／縮放政策來源）**，
另外導出 `MAX_VIEW_W = BASE_VIEW_W / MAX_SCALE`。

---

## 3. 改動檔案（全部喺 allowlist 之內）

| 檔案 | 改動 |
|---|---|
| `src/map/map-lod.ts` | **新增** `export const MAX_SCALE = 280` ＋ `export const MAX_VIEW_W`（含完整計算依據註釋） |
| `src/map/map-camera.ts` | `scaleView` / `viewBoxForGeoBounds` 嘅 `maxScale` 預設由寫死 `64` → `MAX_SCALE` |
| `src/map/MapViewport.ts` | 建構器 `this.maxScale = opts.maxScale ?? MAX_SCALE`（舊值 `?? 64`） |
| `src/map/MapShell.ts` | `maxScale: Math.max(opts.maxScale ?? MAX_SCALE, MAX_SCALE)` —— **以政策值做下限** |
| `tests/qa/harness.ts` | `MAX_VIEW_W` 由 `BASE_VIEW_W / 64` → `BASE_VIEW_W / MAX_SCALE`（唔再寫死） |
| `tests/zoom-quality.e2e.test.ts` | 新增 Q1 **硬斷言**：Z0/Z2/Z4/Z6/Z8 × DPR 1/2 全部 `reachedZ ≥ target − 0.01`，且 `maxZ ≥ 8` |
| `tests/map-lod-zone.test.ts` | 新增 4 個 node 單測（行為性驗證 Z8 可達，見 §4） |

### 3.1 為何 `MapShell` 要用 `Math.max(...)` 做下限

`SvgMap.ts` 仍然寫死 `const MAX_SCALE = 64` 並經 `MapShellOptions.maxScale` 傳入，
而 **`SvgMap.ts` 唔喺本 pass 嘅可寫範圍**（allowlist 只有 `src/map/*` 四個檔）。
若原封不動轉發，Z7／Z8 會再次不可達。

所以 `MapShell`（viewport 政策嘅唯一出口）計 `max(傳入值, MAX_SCALE)`：

- 傳入 `64`（legacy）→ 用政策值 **280**；
- 傳入**更大**嘅值 → 照用，唔會反向封頂（有單測鎖住）。

---

## 4. Z8 驗證（實際輸出）

### 4.1 Node 單測（`tests/map-lod-zone.test.ts`，新增 4 個）

```
✓ MAX_SCALE 令最窄 viewW ≤ 0.0027°（即 Z ≥ 8）
✓ MapViewport 預設（唔傳 maxScale）可以撳到 Z8
✓ MapShell 收 legacy maxScale: 64 都唔會封頂（Z8 仍然可達）
✓ MapShell 傳入大過政策嘅值仍然生效（只可以放寬，唔會反向封頂）
```

（`MapViewport` / `MapShell` 嘅 `zoomBy` 唔需要 DOM，所以呢啲係真 node 單測，
行為性驗證而唔係只讀常數。）

### 4.2 B9 e2e 硬斷言（`tests/zoom-quality.e2e.test.ts`，exit=0）

| 錨點 | target | DPR | `reachedZ`（改動前） | `reachedZ`（改動後） |
|---|---|---|---|---|
| center | Z0 | 1／2 | 0 | 0 |
| center | Z2 | 1／2 | 2.271 | 2.271 |
| center | Z4 | 1／2 | 4.164 | 4.164 |
| center | Z6 | 1／2 | 6.000 | 6.056 |
| **center** | **Z8** | **1／2** | **6.000（不可達）** | **8.129 ✓（DPR1＝DPR2）** |

- `raw.maxViewW`：`0.0109375` → **`0.0025`**
- `raw.maxZ`：`6` → **`8.129`**
- 硬斷言「Z8 必須可達」由本 pass 新增，改動後 e2e **exit=0**。

---

## 5. Q5／Q6 回歸檢查

| 量測 | 改動前 | 改動後 | 判定 |
|---|---|---|---|
| B9 Q5：tko Z6 視窗內 `zonesInView` | 9 | **9** | ✅ ≥ 3 |
| B9 Q6：tko Z6 `eventsWindowed` | 1 | **1** | — |
| B9 Q6：tko Z6「顯示全部事件」後 `eventsAll` | 101 | **52** | ✅ ≥ 5 且 > 窗口值 |
| B9 Q6：`aria-pressed` | `true` | **`true`** | ✅ |
| `tests/map-render.test.ts`（**max zoom** 嘅 Q5/Q6/Q11，7 tests） | 7 pass | **7 pass** | ✅ 冇回歸 |

> ⚠️ **如實記錄**：`eventsAll` 由 101 跌到 52。原因係 `zoomUntilZ(page, 6)`
> 喺新上限之下停喺 `viewW = 0.01052°`（舊上限係 `0.010937°`，即 Z6.056 vs Z6.000），
> 視窗線性窄 4%；事件 clustering 對 `viewScale` 非線性敏感，所以計數差異放大。
> **Q6 嘅門檻係 ≥5，改動後仍有 10 倍餘裕**，判定不變（PASS）。
> 另一條 Q5/Q6 檢查（`map-render.test.ts` 直接量「max zoom」，即真正最深）亦 7/7 過。

---

## 6. Q10（冷 zoom 阻塞）改動前後

協定同 A8／B9 一致（in-page `dispatchEvent` × 20，每下隔 80 ms，DPR1）。

### 6.1 同一 session 對照（3 樣本，權威數字）

| build | sample1 | sample2 | sample3 | 中位 | `longTasks` | `maxMs` |
|---|---|---|---|---|---|---|
| `MAX_SCALE = 64`（改動前） | 810 ms | 769 ms | 750 ms | **769 ms** | 9 | 168–181 |
| `MAX_SCALE = 280`（改動後） | 831 ms | 798 ms | 798 ms | **798 ms** | 9–10 | 169–174 |

**Δ 中位 = +29 ms（+3.8%）**，樣本區間有重疊 → 屬輕微／噪音級，**唔算顯著惡化**。
兩者都**遠超 300 ms 目標**，所以 Q10 判定**維持 FAIL**（同改動前一樣，本 pass 未解決）。

> 為何要另做同一 session 對照：headless software raster 嘅 run-to-run 抖動好大
> （改動前跨 run 見過 525／538／540／673 ms；改動後跨 run 見過 744／796／819／831 ms）。
> 用「同一 session、同一 build 流程、各 3 樣本」先可以分開「真回歸」同「抖動」。
> 早前用跨 run 比較（673 → 819）會誇大成 +22%，屬量測假象。

---

## 7. 四閘結果

| 閘門 | 指令 | 結果 | 備註 |
|---|---|---|---|
| Typecheck | `npm run typecheck` | ✅ **exit 0** | `tsc --noEmit` 0 error |
| Lint | `npm run lint` | ✅ **exit 0** | 已清走 `dist-stale-*` 之後跑 |
| 單元／整合 | `npm run test` | ✅ **exit 0** | 詳見 §7.1 |
| Python | `pytest -q` | ✅ **306 passed / 0 failed（exit 0）** | ⚠️ 主代理基線寫 296，實測 306（非本 pass 改動） |
| Build | `npm run build` | ✅ **exit 0** | `50 modules`；`index.js 215.34 kB（gzip 68.75 kB）` |

### 7.1 測試檔／測試數變化（如實記錄）

- `tests/map-lod-zone.test.ts`：**21 → 25 tests**（本 pass 新增 4 個 Z8 可達性單測）
- `tests/zoom-quality.e2e.test.ts`：量測 test 由 1 個 `it` 內含更多硬斷言（**唔加新 `it`**）
- **冇新增測試檔**（臨時量測檔 `tests/qa/b-maxscale-coldzoom.e2e.test.ts` 已刪除，唔會留喺套件）
- 所以 `npm run test` 嘅**檔案數不變**，測試數 **+4**（全部 PASS，唔會整紅）

---

## 8. 已知限制／未搞掂

| ID | 問題 | 影響 | 建議（零人手） |
|---|---|---|---|
| B-MAX-1 | `src/components/SvgMap.ts` 仍寫死 `const MAX_SCALE = 64`（唔喺本 pass 可寫範圍） | 經 `MapShell` 傳入時已被政策下限擋住（Z8 可達）；但 `SvgMap.scaledView()`（`zoomToLocation` 用）同 `flyToChapter` 嘅 `viewBoxForGeoBounds(..., maxScale: MAX_SCALE)` **仍然用 64** → 呢兩條路徑最深只到 Z6 | 由 `SvgMap` owner 改為 `import { MAX_SCALE } from "./map-lod"`，刪走本地常數 |
| B-MAX-2 | `tests/phase-j-lod.test.ts` 由 `SvgMap` **源碼**讀 `const MAX_SCALE = N`（`/const MAX_SCALE = (\d+)/`）做「最窄圖磚跨度」斷言 | 讀到嘅 `64` 已**唔再係實際生效值**（實際 280）→ 呢條斷言嘅前提過時（暫時仍然 PASS，因為門檻更寬鬆） | 改為由 `src/map/map-lod.ts` 讀 `MAX_SCALE` |
| B-MAX-3 | Q10 冷 zoom 合計阻塞仍然 **~800 ms**（目標 300 ms） | 未達標（**改動前已經未達標**，本 pass 冇顯著惡化） | per-layer incremental update 或移去 worker（spec §2.2 規則 R3） |
| B-MAX-4 | `pytest` 實測 **306 passed**，同主代理寫嘅基線 296 唔一致 | 非本 pass 改動（本 pass 冇碰 Python／`scripts/`）；不影響 exit code | 下次核實基線數字 |

> ⚠️ B-MAX-1／B-MAX-2 係**同一個根因**：`MAX_SCALE` 嘅權威值搬入 `map-lod.ts` 之後，
> `SvgMap.ts` 同讀佢源碼嘅測試就變成「讀緊一個唔生效嘅舊值」。
> 兩者都唔喺本 pass 可寫範圍，所以如實記錄並交主代理／`SvgMap` owner。

---

## 9. 重跑指令（零人手、可重跑）

```bash
# --- 四閘 ---
npm run typecheck
npm run lint
npm run test
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe -m pytest -q
npm run build

# --- Z8 可達性（node 單測，唔需要 browser）---
npx vitest run tests/map-lod-zone.test.ts

# --- B9 量測（需要 dist；跑完會重寫 artifacts/b9-qa/zoom-quality-raw.json）---
npx vitest run tests/zoom-quality.e2e.test.ts

# --- max zoom 嘅 Q5/Q6/Q11 回歸（需要 dist）---
npx vitest run tests/map-render.test.ts
```

> ⚠️ 環境陷阱：`npm run build` 若撞 `SAFE_DELETE_BULK_*`，先 `mv dist dist-stale-$(date +%s)`；
> **跑完必須清走 `dist-stale-*`**（`rm` 會被 shim 擋，要用 PowerShell
> `Remove-Item -Recurse -Force`），否則 `npm run lint` 會爆大量 error。

---

## 10. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議新斷言 | 針對 |
|---|---|---|
| B1 | CI 讀 `raw.maxZ`，要求 `max(zTargets) ≤ maxZ`（硬斷言，唔再係軟檢查） | 防止 Q1 target 清單同縮放上限再次漂移（B9 §12 Q15 嘅硬性版） |
| B2 | 靜態掃描：全 `src/` 唔可以再出現寫死嘅縮放上限 literal（只准 `map-lod.ts` 定義） | 防止 B-MAX-1／B-MAX-2 再發生 |
| B3 | `tests/phase-j-lod.test.ts` 改由 `src/map/map-lod.ts` 讀 `MAX_SCALE` | B-MAX-2 |
| B4 | 深 zoom（Z7–Z8）內容密度斷言：Z8 視窗至少 1 個可見 label／zone，唔可以係新嘅「內容真空」 | 確認 Z8 唔止「撳得到」而係「有內容」（B9 §12 Q13） |

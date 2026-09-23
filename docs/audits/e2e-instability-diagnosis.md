# e2e 不穩定診斷：`reduced-motion` 喺全套測試卡死

> 日期：2026-09-23
> 診斷者：主代理
> 狀態：**進行中**（3 個假設已推翻，最後一個實驗跑緊）
> 診斷腳本：`artifacts/phase3-diag/diag-chromium-accumulation.mjs`

---

## 1. 症狀

`npm run test`（全套）之中，`tests/reduced-motion.test.ts` 嘅 **3 個瀏覽器測試全部卡死**：

```
× reduce 模式下，改章唔會產生 rAF viewBox 插值序列   90003ms
× reduce 模式下，章節條唔會做 smooth 捲動           90012ms
× CSS 層仍然有效（transition-duration 歸零）        90006ms
```

⚠️ **恰好 90,000 ms** = 我設定嘅 timeout → 即係**完全冇進展**（唔係慢，係卡死）。

**同一時間**：7 個靜態契約測試（同檔）**全部過**（1–5 ms each）。

**對照**：單獨跑 `npx vitest run tests/reduced-motion.test.ts` → **`10 passed`、22 秒、exit=0** ✅

→ 即係「**全套跑卡死、單獨跑全過**」。

---

## 2. 已推翻嘅假設（逐項實驗證偽）

### ❌ 假設 1：CPU 高負載造成 timeout 太緊

**推論**：測試實測 3,922 / 3,795 ms，貼近 Vitest 預設 5,000 ms 上限，全套跑 CPU 高負載就超時。

**實驗**：加 `}, 90_000);` timeout 後重跑全套。

**結果**：**推翻** —— 仍然卡，而且係 `Test timed out in 90000ms`（即卡足 90 秒）。

→ **唔係 timeout 太短，係真卡死。**

**⚠️ 我犯嘅錯**：第一次見到單獨跑 `10 passed` 就以為係 timeout 問題，
但係**當時冇意識到「單獨跑過」本身就係重要線索**（指向環境狀態而唔係 timeout 值）。

### ❌ 假設 2：「跑過任何 e2e」就觸發

**推論**：`reduced-motion` 喺全套中前面跑過其他 e2e，環境被污染。

**實驗**：`npx vitest run tests/phase-j-lod.test.ts tests/reduced-motion.test.ts`

**結果**：**推翻** —— `2 passed (2)`、`28 passed (28)`、exit=0、31 秒 ✅

### ❌ 假設 3：Chromium launch/close 累積效應

**推論**：`map-interaction`（13 tests）+ `visual-smoke`（14 tests）每個都 `chromium.launch()` + `browser.close()` → 資源累積。

**實驗**：`artifacts/phase3-diag/diag-chromium-accumulation.mjs` 連續 launch/close × 30。

**結果**：**推翻** —— launch 時間穩定甚至變快：

```
首 5 次平均 launch: 321 ms
末 5 次平均 launch: 182 ms
增幅: -43.3%
最慢一次: 457 ms
```

⚠️ 但係發現 **`close` 好慢**（2.6–2.9 秒／次）—— 值得記錄。

### ❌ 假設 4：`map-interaction` 單獨觸發

**推論**：`map-interaction`（235 秒、13 個 browser）係觸發源。

**實驗**：`npx vitest run tests/map-interaction.e2e.test.ts tests/reduced-motion.test.ts`

**結果**：**推翻** —— `2 passed (2)`、`23 passed (23)`、exit=0、240 秒 ✅

---

## 3. 剩低假設（進行中）

### ❌ 假設 5：全部 e2e 就觸發

**推論**：13 個開 browser 嘅檔累積 → 觸發。

**實驗**：`npx vitest run tests/*.e2e.test.ts tests/reduced-motion.test.ts`（12 個 e2e + reduced-motion）

**結果**：**推翻** —— `13 passed (13)`、`82 passed (82)`、exit=0、**712 秒** ✅

→ 全部 e2e 都過！

### ⏳ 假設 6：單元測試 + e2e 混合（總量）觸發

**證據對照**：

| 情境 | 檔案數 | 時長 | `reduced-motion` |
|---|---|---|---|
| 單獨跑 | 1 | 22 秒 | ✅ 過 |
| `phase-j-lod` + reduced-motion | 2 | 31 秒 | ✅ 過 |
| `map-interaction` + reduced-motion | 2 | 240 秒 | ✅ 過 |
| **全部 e2e**（12+1） | 13 | **712 秒** | ✅ 過 |
| **全套**（13 e2e + 24 單元） | 37 | **1007 秒** | ❌ **卡** |

**差異**：24 個單元測試檔 + 295 秒。

**實驗**：加 step logging（`RM_DEBUG=1`）跑全套，精確定位卡喺邊一步
（launch / newContext / newPage / goto / evaluate）。

⚠️ **唔再猜** —— 直接用 step log 確認。

---

## 3.1 對照表（全部實驗結果）

| # | 假設 | 實驗 | 檔案數 | 時長 | 結果 |
|---|---|---|---|---|---|
| 1 | CPU 負載 → timeout 緊 | 加 90s timeout 跑全套 | 37 | 1027 秒 | ❌ 推翻（仍卡 90s） |
| 2 | 跑過任何 e2e | `phase-j-lod` + rm | 2 | 31 秒 | ❌ 推翻（過） |
| 3 | launch 累積 | launch/close × 30 | — | 108 秒 | ❌ 推翻（末 5 次快 43%） |
| 4 | `map-interaction` 觸發 | `map-interaction` + rm | 2 | 240 秒 | ❌ 推翻（過） |
| 5 | 全部 e2e 觸發 | 全部 e2e + rm | 13 | 712 秒 | ❌ 推翻（過） |
| 6 | 單元 + e2e 總量 | step logging 跑全套 | 37 | ⏳ | ⏳ 跑緊 |

---

## 4. 已發現嘅結構性問題（唔依賴假設 5）

### 4.1 `globalSetup` 嘅 early-return 設計缺陷

`tests/e2e.global-setup.ts`：

```ts
const alreadyUp = await fetch("http://localhost:5174/").then((r) => r.ok).catch(() => false);
if (alreadyUp) return () => {};   // ← 唔起新 server，而且 teardown 係 no-op
```

**問題**：如果 5174 已經有**殘留 server**（由上次測試留低），今次測試會用嗰個舊 server，
**而且唔會關閉佢** → 舊 server 永遠留低。

**實測**：每次測試完結都報 `Tests closed successfully but something prevents Vite server from exiting`。

**配合觀察**：`tasklist` 見到 **25 個 node 進程**（每個 50–150 MB，合共約 **2.3 GB**）。

### 4.2 每個 e2e 測試都獨立 launch/close browser

`map-interaction.e2e.test.ts`：
- `await launch()` × 13
- `browser.close()` × 13（配對 ✅，唔算 leak）
- `page.close()` × 0（但 `browser.close()` 會連帶關閉）

13 個測試 = 13 次 launch/close 循環。若 13 個檔都咁做 → **~50+ 次**。

**候選優化**：每檔用 `beforeAll` / `afterAll` 共用一個 browser（13 → 1）。

### 4.3 `networkidle` 不穩定

三個卡死嘅測試都用 `page.goto(url, { waitUntil: "networkidle" })`。

Playwright 官方建議**避免** `networkidle`（因為「500ms 無請求」嘅判定不穩定）。

**候選優化**：改用 `domcontentloaded` + `waitForSelector(".basemap-vector-ready")`。

---

## 5. 方法論教訓

### 5.1 「單獨跑過」係重要線索，唔係「證明冇問題」

我第一次見到單獨跑 `10 passed`，就推論「係 timeout 值太緊」——**錯**。

**正確推論**：單獨跑過 + 全套卡 = **環境狀態差異**，唔係測試邏輯問題。

### 5.2 逐項證偽 > 猜測

4 個假設全部用**可重跑嘅實驗**證偽，冇一個係「我覺得」。

| 假設 | 實驗 | 耗時 |
|---|---|---|
| CPU 負載 | 加 timeout 重跑全套 | 17 分鐘 |
| 跑過 e2e | `phase-j-lod` + `reduced-motion` | 31 秒 |
| launch 累積 | launch/close × 30 | 108 秒 |
| `map-interaction` 觸發 | `map-interaction` + `reduced-motion` | 240 秒 |

### 5.3 ⚠️ 唔可以亂殺進程

發現 25 個殘留 node 進程（2.3 GB）之後，我**冇**直接 `taskkill` ——
因為可能殺到用戶其他重要嘅 node 工作。

**正確做法**：報告 + 等用戶確認。

---

## 6. 候選修復方案（等假設 5 確認後選）

| # | 方案 | 優點 | 缺點 |
|---|---|---|---|
| A | **e2e 共用 browser**（`beforeAll`/`afterAll`） | 最根本，減少 launch 13→1 | 要改 13 個測試檔 |
| B | **唔用 `networkidle`** | 消除已知不穩定源 | 要改所有 e2e |
| C | **修 `globalSetup` 令 teardown 真嘅 kill server** | 消除殘留進程 | 要搵 PID（Windows 較麻煩） |
| D | **分批跑 e2e**（加 npm script） | 唔改測試 | 治標不治本 |

**初步傾向**：**A + B**（最根本），C 作為配套。

---

## 7. 最終結論（2026-09-23）

### 7.1 🔴 核心發現：呢個係 **flaky**（間歇性），唔係必然失敗

加 step logging 之後跑全套：

```
Test Files  37 passed (37)
Tests       618 passed (618)      ← 全綠！
exit=0      738.61s
```

而 step log 顯示**所有 step 都完成**：

```
[rm-debug] ① launch 開始 / 完成
[rm-debug] ② newContext 開始 / 完成
[rm-debug] ③ newPage 開始 / 完成
[rm-debug] ④ goto(networkidle) 開始 / 完成
[rm-debug] ⑤ evaluate 開始
```

**時長對照**：
- 卡嘅嗰次：**1027 秒**
- 今次（全綠）：**738 秒**
- 差異：**289 秒 ≈ 3 × 90 秒**（恰好係 3 個測試卡死嘅時間）

→ **同一份 code、同一部機，一次卡死、一次全綠** ⇒ 確認係間歇性問題。

### 7.2 六個假設全部證偽

| # | 假設 | 結果 |
|---|---|---|
| 1 | CPU 負載 → timeout 緊 | ❌ 推翻（仍卡 90s） |
| 2 | 跑過任何 e2e | ❌ 推翻（過） |
| 3 | Chromium launch 累積 | ❌ 推翻（末 5 次快 43%） |
| 4 | `map-interaction` 觸發 | ❌ 推翻（過） |
| 5 | 全部 e2e 觸發 | ❌ 推翻（過） |
| 6 | 單元 + e2e 總量 | ❌ 推翻（今次全套全綠） |

### 7.3 最可能嘅觸發條件（未完全確認）

**殘留 server**。證據鏈：

1. `globalSetup` 有 early-return 缺陷：如果 5174 已有 server，**唔起新嘅而且 teardown 係 no-op**
2. 我跑咗多次 `npx vitest run`（單獨／組合實驗），每次都可能留低 server
3. 卡死嗰次（yR5Kzo）之前，我啱跑過 2 次單獨 `reduced-motion`（Rrwcfx、NYGKcm）——**極可能有殘留 server 被沿用**
4. 今次（xcwYbQ）之前嘅實驗（LdnXWX）teardown 咗 server，所以 globalSetup 起咗新 server → 過
5. 配合觀察：每次測試完結都報 `something prevents Vite server from exiting`；`tasklist` 見到 25 個殘留 node 進程（2.3 GB）

⚠️ **未做嘅確認實驗**：故意起一個「殘留 server」再跑全套，睇會唔會卡。
（成本 17 分鐘；已記錄為待辦。）

### 7.4 已實施嘅修復

**`tests/e2e.global-setup.ts`**：
1. 加 `probe()` helper —— `fetch` 帶 `AbortSignal.timeout(5000)`，避免 ping 永遠等
2. 沿用殘留 server 時**明確警告**（`console.warn`），唔再靜默
3. 加**完整粵文註解**記錄陷阱 + 檢查步驟（`curl --noproxy '*' ...`）

⚠️ **保守選擇**：**冇**改成「強制 kill 殘留 server」——Windows 之下要搵 PID，
而且**唔應該亂殺用戶其他 node 工作**。改為「明確警告 + 記錄檢查步驟」。

### 7.5 保留嘅診斷工具

| 工具 | 用途 |
|---|---|
| `artifacts/phase3-diag/diag-chromium-accumulation.mjs` | launch/close 累積實驗（可重跑） |
| `tests/reduced-motion.test.ts` 嘅 `dbg()` | step logging（`RM_DEBUG=1` 開啟，未設時零輸出零開銷） |
| 本報告 §3.1 | 六個實驗嘅完整對照表 |

### 7.6 下一步

1. **（可選）** 做「殘留 server」確認實驗，精確鎖定觸發條件
2. **（可選）** 實施方案 A（e2e 共用 browser）+ B（唔用 `networkidle`），進一步降低 flaky 率
3. 將結論寫入 `docs/progress/phase-3-todo.md`
4. **繼續 Phase 3**（修 P1-2 → 派 C1–C8）

⚠️ **唔阻塞 Phase 3** —— 因為：
- 今次全套 **618 passed 全綠**
- 單獨跑／組合跑都穩定
- C 角色可以分批跑，避免累積

---

## 8. 方法論教訓（總結）

### 8.1 「單獨跑過」係重要線索，唔係「證明冇問題」

我第一次見到單獨跑 `10 passed`，就推論「係 timeout 值太緊」——**錯**。

**正確推論**：單獨跑過 + 全套卡 = **環境狀態差異**（而唔係測試邏輯或 timeout 值）。

### 8.2 ⚠️ 我犯過嘅第二個錯：太快下「資源累積」結論

見到 25 個殘留 node 進程（2.3 GB）之後，我一度傾向「資源累積」假設。
但係**今次全套（殘留進程更多）反而全綠** → 推翻。

**教訓**：**相關性唔等於因果**。要實驗證偽。

### 8.3 逐項證偽 > 猜測（六次實驗）

| # | 實驗 | 耗時 |
|---|---|---|
| 1 | 加 timeout 跑全套 | 17 分鐘 |
| 2 | `phase-j-lod` + rm | 31 秒 |
| 3 | launch/close × 30 | 108 秒 |
| 4 | `map-interaction` + rm | 240 秒 |
| 5 | 全部 e2e + rm | 712 秒 |
| 6 | step logging 跑全套 | 12.5 分鐘 |

**總計約 50 分鐘** —— 但係每一項都有硬數據，冇一項係「我覺得」。

### 8.4 ⚠️ 唔可以亂殺進程

發現 25 個殘留 node 進程之後，**冇**直接 `taskkill` —— 可能殺到用戶其他重要工作。
**正確做法**：報告 + 等用戶確認。

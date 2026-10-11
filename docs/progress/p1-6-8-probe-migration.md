# P1-6-8 完成：全部探測腳本遷移至 `_probe-lib.mjs`（棘輪 → 零容忍）

> 對應 `d5-10-and-verification-expansion.md` §3（P1-6-8）嘅餘項。
> 全部驗證程式化、可重跑；**零人手參與**。日期：2026-10-11。

---

## 0. 一句話總結

`artifacts/phase3-resume/` 剩餘 **18 個**歷史探測腳本全部由自己抄嘅
bootstrap（`process.kill(-pid)` —— **Windows 冇效**）遷移到
`_probe-lib.mjs` 嘅 `withTeardown()`。

守衛由**棘輪**（容忍 18 個遺留）升級為**零容忍**（一個都唔准）。
淨刪 **481 行**重複 bootstrap。

---

## 1. 問題（為何要修）

⚠️ `process.kill(-pid)` 喺 Windows **冇效**（專案 MEMORY E18）——
`spawn(..., { detached: true })` 之後想收成個 process group，Windows 唔支援。
後果：`vite preview` **殘留**，佔住 5174 → 之後嘅 e2e／視覺守衛連去
**舊 build** → 比對「舊 vs 舊」→ **假綠**（比假紅危險得多）。

正確做法：`taskkill /PID <pid> /T /F`（`/T` 連子孫）—— 已封裝喺
`_probe-lib.mjs` 嘅 `stopPreviewServer()`。

---

## 2. 做法（機械式轉換）

18 個腳本嘅 bootstrap **結構一致但寫法各異**（`const PORT` 單行／兩行、
`ok` 係 `async function` 定 `const … =>`、`ensure` 定 `ensureServer`）。
所以用一次性 Python 腳本做**原子轉換**（先全部計好、通過 assert 才寫）：

| # | 轉換 | 說明 |
|---|---|---|
| 1 | 刪 `import { spawn } from "node:child_process";` | |
| 2 | 刪 `const PORT = …` / `const BASE = …` | `BASE` 改由 lib 提供 |
| 3 | 刪 `ok`／`probe` helper（brace 配對） | |
| 4 | 刪 `ensure`／`ensureServer` 函數（brace 配對） | |
| 5 | 加 `import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";` | 放喺最後一個 `import` 之後 |
| 6 | `await ensure()`／`ensureServer()` → `await ensurePreviewServer()` | |
| 7 | `args: ["--no-proxy-server"]` → `args: LAUNCH_ARGS` | |
| 8 | 外層 `try {` → `await withTeardown(browser, server, async () => {`；`} finally { … }` → `});` | ⚠️ **body 縮排不變**（`try {}` 同 `async () => {}` 都係一層） |

⚠️ **保留** `const INIT`／`const INV`／`const CONFIGS` —— body 會用
（`INIT` 由 6 個腳本用嚟 `addInitScript()`）。

### 2.1 實測踩到嘅陷阱：brace 配對要跳過 `} finally {` 嘅行首 `}`

第一次跑就俾 atomic assert 捉到（`probe-canvas-churn.mjs: 仍有 process.kill`）。
根因：`} finally {` 呢行有一個 `}`（**上一個 block 嘅收尾**）同一個 `{`，
如果由行首開始數，depth 即刻變 0 → 誤判「finally 得一層」→ 冇刪到內容。

**修法**：配對時跳過行首嗰個 `}`，由 `{` 開始數。

> 教訓：**brace 配對唔可以假設「行首嘅 `}` 屬於本 block」** ——
> `} else {`／`} finally {`／`} catch {` 都係反例。

### 2.2 唯一唔可以純機械轉換嘅個案

`probe-css-important.mjs` 喺 try/finally **之後**仲有 10 行（寫檔 ＋ 印統計），
用到 `snapshot`。檢查後確認 `const snapshot` 喺原檔**已經**喺 `try {` **之前**
宣告（top-level scope）→ 轉換後仍然 top-level ✓，**唔需要改**。

（如果佢係喺 try 內宣告，就會變成 ReferenceError —— 呢個係轉換前必須逐個檢查嘅點。）

---

## 3. 驗證（三層）

| 層 | 方法 | 結果 |
|---|---|---|
| 語法 | `node --check` 逐個 | ✅ 18/18 |
| 行為 | 煙霧測試 3 個（涵蓋兩種 helper 變體 ＋ 單行／多行 finally） | ✅ 全部正常輸出 |
| 收檔 | 每次跑完 `netstat` 查 5174 | ✅ **0 殘留** |

煙霧測試樣本：`probe-zone-flyto.mjs`（`ok`/`ensure`）、
`probe-marker-collapse.mjs`（`probe`/`ensureServer` ＋ 單行 finally）、
`probe-panel-autopen.mjs`。

---

## 4. 守衛：棘輪 → **零容忍**

`tests/probe-hygiene.test.ts` 重寫：

| 斷言 | 之前 | 之後 |
|---|---|---|
| `process.kill(-pid)` | 18 個遺留列 `LEGACY`（容忍） | **零容忍** —— 一個都唔准（`LEGACY` 清單已刪） |
| 用 `_probe-lib.mjs` | 只檢查 6 個具名檔 | **所有** `.mjs`（唯一豁免：`probe-native-memory.mjs`） |
| 自己 `spawn("npx")` | 只檢查 6 個 | **所有** `.mjs` |
| `_probe-lib.mjs` API | 保留 | 保留 |
| D5-10／D4-1 單一來源 | 保留 | 保留 |

### 4.1 豁免：`probe-native-memory.mjs`

佢**自己起一個帶 COOP/COEP header 嘅 Node 靜態伺服器**（port **5175**，
唔係 5174）—— 因為 `measureUserAgentSpecificMemory()` 需要
cross-origin isolated 環境。冇 `spawn`、冇 child process → 唔需要收檔。

順手清走一個**死 import**（`import { spawn }` 從未使用）。

---

## 5. 閘門

| 閘門 | 結果 |
|---|---|
| typecheck | **0** |
| lint | **0** |
| `probe-hygiene` | ✅ 6 tests |
| vitest 全套 | **57 檔 / 768 tests 全綠（exit 0）** |
| `node --check`（18 檔） | ✅ |
| 5174 殘留 | **0** |

---

## 6. 已知限制（誠實記錄）

1. **只做靜態 ＋ 煙霧驗證**，冇逐個跑齊 18 個（部分腳本要幾分鐘、亦要
   特定條件）。⚠️ 但轉換係**純 bootstrap 層**，body 一個字都冇改
   （diff 可逐行核對），所以風險低。
2. `probe-native-memory.mjs` 係唯一豁免 —— 如果將來有腳本要自帶伺服器，
   應該喺 `EXEMPT` 加名並寫明理由（唔可以靜默放行）。
3. 18 個腳本嘅**行尾由 CRLF 變 LF**（`core.autocrlf` 嘅正常行為，唔影響執行）。

---

## 7. 下一步（全部程式化，零人手）

1. **C 項全鏈重建**（下一項）：將 `merge_characters.py` 嘅合併決定前移入產生器。
2. 為 `_probe-lib.mjs` 加 `--if-needed` 之類嘅選項？—— ⚠️ 暫無需要，唔做。
3. 如果將來新增探測腳本，**由第一日起**就用 `_probe-lib.mjs`（守衛已強制）。

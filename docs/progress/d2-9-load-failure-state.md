# D2-9 擴狀態：載入失敗路徑 ＋ class 契約執行期證據（D4-9）

> 對應 `d5-10-and-verification-expansion.md` §12 第 1 項（同第 4 項）。
> 全部驗證程式化、可重跑；**零人手參與**。日期：2026-10-08。

---

## 0. 一句話總結

新增 **`12-desktop-load-failure`** 視覺狀態（第 12 個），將「載入失敗」路徑
納入**像素守衛 ＋ 樣式契約 ＋ class 契約執行期證據**。

過程中**捉到一個真 a11y 缺陷**（重試掣只有 42px，低於專案 44px 標準）並修好；
另外**大幅降低**視覺守衛嘅跨 run 雜訊（最大 51px／Δ12 → **12px／Δ1**）。

---

## 1. 為何要擴（D4-3 嘅盲點）

`docs/contracts/class-contract.json` 保護嘅 4 個 class 入面，有 4 個
（`.bg-error-panel` / `-detail` / `-hint` / `.bg-retry-btn`）**只喺載入失敗
路徑出現** → 之前 11 個狀態**全部係正常路徑** → 執行期探測永遠睇唔到
→ 極易被誤判死 ✗。

即係話：契約寫咗「呢啲 class 必須存在」，但**冇任何執行期證據**支持 ——
呢個正正係 D4-3 指出嘅判斷盲點。

---

## 2. 做法

### 2.1 擴 `ShotState`（`tests/helpers/visual-shots.ts`）

| 新欄位 | 用途 |
|---|---|
| `beforeGoto?` | 喺 `goto` **之前**做嘅事（例如 `page.route(...)` 攔截請求） |
| `ready?` | 覆寫「等 ready」（預設 `waitApp`）—— 失敗狀態**冇** `.ch-pill` |
| `blockServiceWorkers?` | 停用 service worker（見 §3.1） |

### 2.2 抽 `bootShotPage()`（單一來源）

之前 **4 個呼叫者**（2 個 e2e ＋ 3 個探測）各自抄一次「開 page → goto →
等 ready → act → 等穩定」嘅序列。加 `beforeGoto`／`ready` 就要改 4 個地方
—— 同 D5-10 嘅教訓一樣。所以抽成一個函數：

```ts
bootShotPage(browser, st, baseUrl)
  → openShotPage → beforeGoto? → goto → (ready ?? waitApp) → act? → waitStable
```

5 個呼叫者全部改用（`visual-regression`／`visual-contract`／
`visual-shots.mjs`／`probe-dead-css-shots.mjs`／`probe-style-contract.mjs`）。

### 2.3 新狀態

```ts
{
  name: "12-desktop-load-failure",
  blockServiceWorkers: true,
  beforeGoto: (page) => page.route(/\/data\/public\/characters\.json$/,
    (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" })),
  ready: (page) => page.waitForSelector(".bg-error-panel", { timeout: 25_000 }),
}
```

⚠️ **確定性關鍵**：只令**一個**請求失敗。`loadAllData()` 用 `Promise.all`
→ 若多過一個同時失敗，**reject 次序唔確定** → 錯誤訊息會飄 → 像素基線
會 flaky ✗。

---

## 3. 三個實測發現（最有價值嘅部分）

### 3.1 ⚠️ Service worker 會令 `page.route` 被繞過

第一次試：只攔 `characters.json` → **失敗狀態唔會出現** ✗。
實測（`_debug-failure.mjs`）：

```
[route hit] 1 http://localhost:5174/data/public/characters.json
[resp] 500 http://localhost:5174/data/public/characters.json   ← 第 1 次（經 route）
[resp] 200 http://localhost:5174/data/public/characters.json   ← 重試（經 SW cache！）
DOM: {"panel":false,"pills":198}
```

根因：`public/sw.js`（`main.ts:157` 註冊）會**快取**資料檔 →
`loadWithRetry()` 嘅重試由 SW 回 200，**繞過 `page.route`** → app 照樣載入。

修法：`serviceWorkers: "block"`（`browser.newPage` 選項）。
⚠️ 凡「模擬 network 失敗」嘅 e2e 都要問：**service worker 會唔會兜住？**

### 3.2 ⚠️ 新序列令視覺守衛雜訊**大幅下降**

`bootShotPage` 喺 `act` 之後**先等穩定**，然後 `shoot()` 才注入 `FREEZE`。
舊序列係 `act` → 400ms → `shoot()`（即**先**注入 FREEZE **再**等穩定）
→ `flyTo` 動畫被凍結喺**中途** → 位置取決於時序 → flaky ✗。

實測對照（`04-desktop-zone-selected`，同一個 baseline）：

| 序列 | 差異 |
|---|---|
| 舊（先 FREEZE 再等） | **63.86%**（大幅偏離 —— 凍結喺中途） |
| 新（先等穩定再 FREEZE） | **0 px／Δ0** ✓ |

全套雜訊底線：最大由 **51px／Δ12** → **12px／Δ1**（11 個狀態之中 9 個係 0 px）。

> 教訓：**「停動畫」同「等穩定」嘅次序有意義** —— 先停動畫會凍結喺中途。

### 3.3 ⚠️ 捉到一個真 a11y 缺陷（重試掣 42px）
新測試斷言重試掣符合專案自己嘅 **44px 觸控目標**標準（B8 §2-9 / VA3）：

```
AssertionError: 重試掣高度要 ≥44px（實測 42px）: expected 42 to be greater than or equal to 44
```

根因：`.bg-retry-btn { padding: 9px 22px; font-size: 14px }` → 高 42px。

⚠️ 為何之前冇發現：呢個掣**只喺失敗路徑出現**，而 B8 嘅觸控目標測試
只行正常路徑 ✗。

**修法**：`.bg-retry-btn` 加 `min-height: 44px; min-width: 44px;`
（`src/styles/legacy-migrated.css`）。⚠️ 載入失敗畫面係**唯一**可以令用戶
脫離失敗狀態嘅路徑 —— 掣太細會令觸控用戶卡死。

### 3.4 ⚠️ 全套跑再捉到一個**設定步驟** flake（`map-interaction`）

擴完狀態之後嘅第一次全套跑：`map-interaction.e2e.test.ts` 嘅
「迴歸：輕觸要選中、拖曳要平移」失敗：

```
TimeoutError: page.click: Timeout 30000ms exceeded.
  - <image y="22.11" x="113.79" id="basemap-group" class="basemap-layer" ...>
    from <svg id="svg-map" ...> subtree intercepts pointer events
```

**逐項證偽**（唔靠直覺）：

| 檢查 | 結果 |
|---|---|
| 單獨跑嗰個測試 | ✅ pass（100%）→ 唔係產品回歸 |
| `elementFromPoint` 量測 | ✅ `#map-zoom-in` 係最頂層（`#map-controls` z=20 > `#svg-map` z=10）→ **唔係**長期遮蓋 |
| 8 個同類呼叫點嘅性質 | **全部**係設定步驟（縮放令 zone／pulse／LOD 到達可測狀態），**冇一個**係測掣本身 |

根因：`page.click()` 嘅 **actionability hit-test** 喺高負載下間歇失敗
（同檔已有先例：`#btn-toggle-panel` 用 `force: true`）。

**修法**：設定步驟改用**鍵盤快捷鍵**（`+` = `zoomBy(1.3)`，同掣完全一樣；
實測兩者 viewBox **逐位相同**）。鍵盤路徑**唔需要 hit-test** → 唔會 flake。

```ts
async function zoomIn(page: Page, times = 1): Promise<void> {
  await page.evaluate(() => document.querySelector("#svg-map")?.focus());
  for (let i = 0; i < times; i++) await page.keyboard.press("+");
}
```

8 個呼叫點全部轉用（⚠️ **斷言冇改**）。掣本身嘅可點性由
`panel-overlay.e2e.test.ts` 覆蓋 ✓。

> ⚠️ 唔用 `force: true`：`force` 會喺**唔檢查** hit target 之下派發真滑鼠
> click —— 若嗰刻真係被 basemap 蓋住，click 會去錯元素 → 縮放靜默失敗
> → 下游 `pickClickableZone()` 回 null → 假紅。鍵盤路徑係**確定性**嘅。

### 3.5 ⚠️ `04-desktop-zone-selected` 本身係**不確定**（兩個獨立根因）

修完 §3.4 之後再跑全套：**又**係 04 失敗（**80.99%**）。逐項證偽：

| 檢查 | 結果 |
|---|---|
| 單獨連跑 5 次 | ✅ 5/5 完全一致（`paneX=1060`、同一個 viewBox、同一個 URL） |
| 全套跑（高負載） | ❌ 80.99% |
| 診斷圖 | 基準線：**冇故事面板** + 頂欄右邊控制項未 render；當前：面板開、頂欄完整 |

即係話：**同一份程式碼、同一個 baseline，會有兩種結果** → 唔係產品回歸，
係**捕捉時序**問題。追落去有**兩個獨立根因**：

#### 根因 ①：`waitStable` 嘅判準太弱（250ms 無變化）

原本要求「`viewBox` 連續 **2** 次取樣相同」= 只要求 **250ms 無變化**。
實測：`flyTo` 嘅 JS 動畫（緩動尾段／高負載掉帧）之下，相隔 250ms 嘅
兩個樣本可以**碰巧相同** → 提早當「穩定」→ 截到**中途**位置 ✗。

**修法**：加強到「連續 **4** 次相同」= **800ms 完全無變化**。
效果：60.4% → **3.41%**。

#### 根因 ②：`page.mouse.click(座標)` 本質上 racy

剩低嘅 3.41% 差異集中喺**故事面板嘅內文**（診斷熱圖清楚顯示）——
即係**撞到另一個 zone**（唔同 dossier）。原因：座標係由「當刻」嘅
zone bounding box 算出，地圖未完全定 → 座標唔中 → 落到**另一個** zone。

**修法**：`04` 改用 **URL 選 zone**（唔用座標 click）：

```ts
const id = await page.evaluate(
  () => document.querySelector("#zones-layer .zone")?.getAttribute("data-zone-id") ?? null,
);
const u = new URL(page.url());
if (id) u.searchParams.set("zone", id);
u.searchParams.set("chapter", "198");
await page.goto(u.toString(), { waitUntil: "networkidle" });
```

效果：**0 px／Δ0**（連跑 2 次）✓ —— 完全確定性。

> ⚠️ **教訓（已加入 MEMORY #43）**：**座標 click 唔可以用嚟做「狀態設定」**
> —— 佢嘅結果取決於當刻版面。建立狀態要用**無座標**路徑（URL／鍵盤／
> store action）。斷言想測 click 本身嘅話，嗰個 click 就係被測行為，
> 應該用 `elementFromPoint` 驗證命中（專案已有 `pickClickableZone()`）。

---

## 4. 新測試：`tests/load-failure-state.e2e.test.ts`（3 tests）

| 測試 | 內容 |
|---|---|
| ⭐ 契約 class 都真係會 render | 讀 `class-contract.json` → 逐個 assert 佢喺「正常 ∪ 失敗」狀態出現過（**契約唔可以係空談**） |
| ⭐ 失敗畫面可見性 ＋ 觸控目標 | 面板可見、`role=alert`、訊息含 `HTTP 500` ＋ 檔名、重試掣 ≥44×44 |
| ⭐ 撳「重試」可以復原 | 解除攔截 → 撳掣 → `.ch-pill` > 100（真係載入到）＋ 錯誤畫面消失 |

---

## 5. 契約擴充（D4-9）

`docs/contracts/class-contract.json` 加 `bg-retry-btn`（第 5 個）：

```json
"bg-retry-btn": {
  "producedBy": "src/main.ts",
  "reason": "載入失敗畫面嘅「重試」掣……⚠️ 佢係唯一可以令用戶脫離失敗狀態嘅控制項 → 一定要有可見樣式。"
}
```

---

## 6. 基線

| 檔案 | 改動 |
|---|---|
| `tests/baselines/visual/12-desktop-load-failure.png` | 新增（第 12 張） |
| `tests/baselines/visual/*.png`（其餘 11 張） | **全部重生**（因為 `bootShotPage` 改咗截圖時序 —— 見 §3.2） |
| `tests/baselines/style-contract.json` | 重生（12 狀態；每個狀態多 2 個 selector 條目：`.bg-error-panel`／`.bg-retry-btn`） |

⚠️ 刻意**保留**新增嘅 `SNAPSHOT_SELECTORS` 條目 —— 令「失敗畫面元素唔應該
喺正常狀態出現」都變成契約（正常狀態記錄 `null`）。

---

## 7. 閘門（最終）

| 閘門 | 結果 |
|---|---|
| typecheck | **0** |
| lint | **0** |
| vitest 全套 | **57 檔 / 762 tests 全綠（exit 0）**（基線 759） |
| pytest | **327 passed** |
| `visual-regression`（連跑 2 次） | ✅ 12 狀態；**04 同 12 都係 0 px／Δ0** |
| `visual-contract` | ✅ 3 tests |
| `load-failure-state` | ✅ 3 tests |
| `map-interaction` | ✅ 14 tests |
| `validate_public_data.py` | ✅ |
| `audit_release.py` | ✅ |
| `rebuild_public_json.py --check` | ✅ |
| `audit_dead_css.py --fail-on-dead` | ✅ 0 死 class |
| `git fsck --full` | 無 error／missing |

---

## 8. 已知限制（誠實記錄）

1. **失敗畫面嘅錯誤訊息係斷言嘅一部分**（含 `HTTP 500` ＋ 檔名）——
   若將來改 `main.ts` 嘅訊息文案，像素基線同呢個斷言都會紅
   （**有意**：文案係視覺契約一部分）。
2. **只模擬「單一檔案 500」**，冇模擬「網絡中斷」／「HTML 回退」等
   其他失敗模式（`fetchJSON` 有唔同分支）—— 可作為下一步。
3. `serviceWorkers: "block"` 只喺失敗狀態開 —— 其餘 11 個狀態仍然
   行 SW（同 production 一致）。
4. 失敗狀態**唔會**出現喺 `probe-dead-css.mjs`（執行期 class 收集）——
   佢自己寫死狀態清單；可考慮一併擴（見下一步）。

---

## 9. 下一步（全部程式化，零人手）

1. **擴失敗模式覆蓋**：加「網絡中斷（`route.abort()`）」同「HTML 回退」
   （`fulfill({ contentType: "text/html" })`）兩個變體 → 覆蓋 `fetchJSON`
   嘅三條錯誤分支。
2. ~~**`probe-dead-css.mjs` 改用 `STATES`**（單一來源）~~ → ✅ **已完成
   （2026-10-10）**：原本寫死 7 個狀態 → 自動漏咗新狀態（包括失敗路徑）。
   改用 `STATES` ＋ `bootShotPage()` → **12 個狀態**，執行期 class 聯集
   **192 個**（含契約 class 全部 5 個 `runtime=True`）。
   守衛：`probe-hygiene.test.ts` 新增一條斷言。
3. **P1-6-8 繼續遷移**：剩餘 ~18 個歷史探測腳本搬去 `_probe-lib.mjs`。
4. **C 項全鏈重建**：`merge_characters.py` 決定前移入產生器。

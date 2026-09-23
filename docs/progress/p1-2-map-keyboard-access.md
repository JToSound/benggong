# P1-2 交付報告 —— 地圖元素鍵盤可達（A7 驗收矩陣 §10.9）

> 對應：`docs/audits/mobile-a11y-audit.md` P1-2（「地圖 0 / 19 個互動元素鍵盤可達」）
> 驗收項：§10.9「地圖標記／區域可鍵盤選取」原本 **FAIL（0/19）**
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

地圖 19 個互動元素原本全部 `tabIndex = -1`、冇 `role`、冇 `aria-label`，
互動只靠單一 delegated `click` handler → **鍵盤可達 0/19**。

本項加咗 **roving tabindex** ＋ `role="button"` ＋ `aria-label` ＋
`Enter` / `Space` 啟動 ＋ 方向鍵組內移動 ＋ 逐像素驗證過嘅焦點環。

⚠️ **同時解開咗一個長期「根因未明」嘅回歸**：之前加 `tabindex` 會令
`tests/map-interaction.e2e.test.ts` 變紅。真正根因係一條**三層因果鏈**
（見 §3），唔係「加 tabindex 本身有問題」。

---

## 1. 問題（A7 實測）

| 選擇器 | 數量 | `tabIndex` | `role` | `aria-label` | 鍵盤可達 |
|---|---|---|---|---|---|
| `.zone` / `.zone-area` / `.zone-badge` | 3 | -1 | null | 0 | **0** |
| `.location-marker` / `-cluster` | 5 | -1 | null | 0 | **0** |
| `.event-marker` | 11 | -1 | null | 0 | **0** |
| `.route-line` | 1 | -1 | null | 0 | **0** |
| **合計** | **19** | 全部 -1 | 全部 null | **0** | **0** |

- `#svg-map` 內 66 個元素 `tabIndex` 分佈 = `{-1: 66}`。
- 18 個元素有 SVG `<title>`（tooltip），但**因為元素唔可聚焦，螢幕閱讀器同鍵盤都用唔到**。

---

## 2. 設計：roving tabindex

### 2.1 為何唔可以逐個元素 `tabindex="0"`

地圖一次可以 render **48 個 zone** ＋ 多個 location／event marker。
全部變成 Tab stop 會令鍵盤用戶要 Tab 過百次才離開地圖；而且會直接撞紅
`tests/a11y-keyboard.e2e.test.ts` 嘅兩條斷言：

- 「全頁 Tab stop 總數 < 600」
- 「第 2 / 3 個 Tab stop 落喺頂欄導覽（20 次內到）」

### 2.2 採用嘅做法（WAI-ARIA 對「一組同性質項目」嘅標準）

| 鍵 | 行為 |
|---|---|
| `Tab` / `Shift+Tab` | 進／出地圖（**整個地圖只有 1 個** roving Tab stop ＋ SVG root） |
| `→` `↓` / `←` `↑` | 喺組內移動焦點（環繞） |
| `Home` / `End` | 跳去第一個／最後一個 |
| `Enter` / `Space` | 啟動（**同 click 完全同一條路徑** —— `handleHitAt()`） |
| `Escape` | 離開地圖元素 |

實作喺新模組 `src/map/map-keyboard.ts`（**純函數**，可 node 單測）：
`resolveMapKey()` / `rovingIndex()` / `isNavigationAction()` /
`MAP_INTERACTIVE_SELECTOR`。

---

## 3. ⚠️ 之前「加 tabindex 令 e2e fail、根因未明」嘅**真正根因**

呢個係本項最重要嘅發現。因果鏈有三層，缺一都解釋唔到：

### 第 1 層：`tabindex` 改變咗「點擊 → 聚焦」嘅結果

為 `.zone` 加 `tabindex` 之後，Chromium「點擊 → 聚焦最近可聚焦祖先」
嘅結果變咗。實測（`artifacts/phase3-resume/probe-p12.mjs`）：

```
① 點擊後：activeElement = BODY      ← 唔係 SVG，亦唔係 zone
```

### 第 2 層：焦點離開 SVG → 地圖自己嘅快捷鍵**靜默失效**

`SvgMap.bindKeyboard()`（P0-7）綁喺 `#svg-map`，**要求焦點喺 SVG 之內**，
提供 `0`（重置）、`+` / `-`（縮放）、方向鍵（平移）。

焦點變 `BODY` 之後呢批快捷鍵全部唔 work。實測：

```
② press("0") 後：viewW = 0.0706（冇重置到 0.7）
```

### 第 3 層：`render()` 重建圖層會**銷毀**焦點

就算明確 `focus()` 咗元素，`render()` 嘅 `replaceChildren()` 會即刻
銷毀佢 → 焦點再次跌返 `BODY`。

更陰險嘅係：銷毀時瀏覽器 fire 一個 `focusout`，而 `relatedTarget` 係
`null`（唔係「去咗另一個元素」）→ 如果用 `focusout` 去清除「應該還原
焦點」嘅旗標，就會喺還原之前清走 → **還原邏輯永遠唔會行**（實測踩過）。

### 連鎖症狀

`tests/map-interaction.e2e.test.ts` 嘅「輕觸要選中、拖曳要平移」用
`press("0")` 重置視圖之後再 `pick()` zone。快捷鍵失效 → 視圖停留喺
章節飛航嘅深 zoom（viewW 0.0706）→ **所有 zone 都喺畫面外（`cy` 係負數）**
→ `pick()` 回 `null` → 斷言失敗。

> 呢個就係「根因未明」嘅真相：**症狀（zone 揀唔到）同原因（焦點被 render
> 銷毀）相隔三層**，而且中間經過「快捷鍵靜默失效」呢個唔顯眼嘅環節。

---

## 4. 修法

| # | 改動 | 針對 |
|---|---|---|
| 1 | `markInteractive(el, label)`：設 `tabindex="-1"` ＋ `role="button"` ＋ `aria-label`（5 類元素都呼叫） | §1 鍵盤可達 0/19 |
| 2 | `applyRovingTabindex()`：`render()` 尾部確保**只有一個** `tabindex="0"`，並用 `kbFocusKey` 記住上次目標 | §2.1 Tab stop 爆炸 |
| 3 | `bindMapKeyboard()`：delegated `keydown`（方向鍵／Home／End／Enter／Space／Escape）＋ `focusin` 同步 | §2.2 |
| 4 | `handleHitAt()` 抽成方法：click / pointerup / 鍵盤**共用同一條分派路徑** | 行為唔可以漂移 |
| 5 | **`focusHitElement()`**：點擊後明確 `focus()`；失敗就退返 `#svg-map` | §3 第 1 層 |
| 6 | **`kbWantFocus` ＋ `rendering` 守衛**：render 之後還原焦點；`focusout` 喺 render 進行中唔准清除旗標 | §3 第 3 層 |
| 7 | **`bindKeyboard()` 守衛收窄**：只跳過**方向鍵**（唔係「有地圖元素就成個 return」） | ⚠️ 自己引入嘅二次回歸 |
| 8 | 方向鍵／Home／End 加 `stopPropagation()` | 避免同 `app.ts` 嘅章節快捷鍵（`←`/`→`、Home/End）打架 |
| 9 | CSS 焦點環：`:focus-visible` + `filter: drop-shadow()` | SVG 冇 box model，`outline` 唔可靠 |

⚠️ 第 7 項值得單獨記：第一次修完 §3 之後測試仍然紅，原因係**我自己加嘅
守衛太闊**（`if (t.closest(MAP_INTERACTIVE_SELECTOR)) return;` 連 `0` / `+` /
`-` 都擋）。**修 bug 嘅改動本身要當成新改動重新驗證。**

---

## 5. 驗證

### 5.1 純函數單測（`tests/map-keyboard.test.ts`，23 tests）

按鍵映射（含 `" "` 同 `"Spacebar"` 兩種寫法）｜`rovingIndex` 環繞／邊界／
空組｜`isNavigationAction`｜選擇器同 `resolveHit()` 嘅 `HIT_SELECTORS` 一致｜
`markInteractive()` **只可以設 `-1`**（防止有人改返 `0` 造成 Tab stop 爆炸）｜
`render()` 尾部有 `applyRovingTabindex()`｜`applyRovingTabindex()` 只會有一個 `0`｜
keydown 用 `resolveMapKey` + `preventDefault` + 同一條 `handleHitAt()` 路徑｜
CSS 用 `drop-shadow` 唔用 `outline`。

### 5.2 實瀏覽器 e2e（`tests/map-keyboard.e2e.test.ts`，3 tests）

| 測試 | 內容 |
|---|---|
| 屬性覆蓋 | 全部互動元素有 `role=button` + `aria-label`；**任何時候只有一個 `tabindex="0"`** |
| ⭐ 真鍵盤旅程 | `Tab` 入到地圖 → 落到地圖元素；`ArrowRight` → roving 移到**另一個** zone；`Enter` → 真係選中（`.zone.is-selected` = 1、URL 帶 `zone=<目標 id>`） |
| ⭐ 焦點環可見 | focused vs unfocused **逐像素比對**，一定要有差異（唔可以「focus 咗但睇唔到」） |

### 5.3 回歸（§3 嘅連鎖症狀）

`tests/map-interaction.e2e.test.ts`：**13 / 13 全過**（改動前係 1 failed / 12 passed）。

### 5.4 逐項隔離過程（記錄方法論）

1. 移除新增 CSS → 仍然紅 → **CSS 唔係元兇**。
2. 寫 `probe-p12.mjs` 重現測試步驟並 dump 診斷 → 見到「點擊後
   `activeElement = BODY`」同「所有 zone `cy` 係負數」。
3. 加 `focusHitElement()` → 焦點仍然 BODY → 發現 `focusout` 喺 render 期間
   清走旗標 → 加 `rendering` 守衛 → 焦點正確。
4. 測試仍然紅 → 發現係**自己嘅過闊守衛**擋咗 `0` → 收窄 → 綠。

---

## 6. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| P1-2-1 | **地圖有 2 個 Tab stop**（SVG root ＋ 1 個 roving 元素） | SVG root 係 P0-7 既有嘅（`tabindex="0"` + `role="application"`），唔改動。總數仍然遠低於 <600 斷言。 |
| P1-2-2 | **焦點喺地圖元素時方向鍵唔再平移** | 方向鍵改為「組內移動」（標準複合 widget 行為）。要平移可以先 `Tab` 返 SVG root，或者用 `Shift` 相關手勢。⚠️ 呢個係**行為改動**，已寫入 §2.2 表格。 |
| P1-2-3 | **方向鍵仍然會改章節？** | 唔會 —— 地圖元素上嘅方向鍵／Home／End 已 `stopPropagation()`（§4 第 8 項）。但**焦點喺 SVG root** 時方向鍵仍然會同時平移＋改章節（P0-7 既有行為，本項冇改）。 |
| P1-2-4 | **`Home` / `End` 喺地圖元素上會 `stopPropagation`** | 即係焦點喺地圖元素時 Home/End 唔會跳章節。呢個係刻意（否則「跳去第一個元素」會順便跳章節）。 |
| P1-2-5 | **焦點環用 `filter: drop-shadow`，唔係 `outline`** | Chromium 對 SVG 元素嘅 `outline` 支援唔一致。`drop-shadow` 會令元素建立 stacking context（已加 `z-index: 3` 令焦點元素喺上層）。 |

---

## 7. 重跑指令

```bash
npm run typecheck && npm run lint
npm run test

# 針對性
npx vitest run tests/map-keyboard.test.ts
npx vitest run tests/map-keyboard.e2e.test.ts
npx vitest run tests/map-interaction.e2e.test.ts   # §3 回歸
npx vitest run tests/a11y-keyboard.e2e.test.ts     # Tab stop 預算

# 診斷（重現 §3 嘅因果鏈）
env -u http_proxy -u https_proxy node artifacts/phase3-resume/probe-p12.mjs
```

⚠️ e2e 跑 `dist/` → 改完 source 必須 `npm run build`。
⚠️ 量度前確認 5174 冇殘留 `vite preview`（`netstat -ano | grep 5174`）。

---

## 8. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議 | 針對 |
|---|---|---|
| P1-2-6 | 加斷言：`#svg-map [tabindex="0"]` 嘅數量**恆久 ≤ 1**（已有），再加「**新增互動元素類別時**一定要加入 `MAP_INTERACTIVE_SELECTOR`」嘅靜態守門 | §2.1 Tab stop 爆炸 |
| P1-2-7 | 加斷言：`focusHitElement()` 之後 `document.activeElement` 一定要喺 `#svg-map` 之內 | §3 第 1 層回歸 |
| P1-2-8 | 加斷言：`render()` 之後焦點唔可以變 `BODY`（如果之前喺地圖之內） | §3 第 3 層回歸 |
| P1-2-9 | A7 §10.9 由 FAIL 改為 PASS，並將量測腳本（`a7-probe-map2.mjs`）更新為量「有幾多個元素可鍵盤選取」而唔止「有冇 `tabindex`」 | 驗收記錄 |

# B8 接線後回歸診斷報告

> 日期：2026-09-23
> 診斷者：主代理（team-lead）
> 觸發：`npm run test` 由 26 files / 525 tests 全綠 → 30 files / 604 tests，其中 **4 項失敗**
> 診斷腳本：`artifacts/b8-scratch/diag-zone-null.mjs`、`diag2-reproduce.mjs`、`diag3-overflow.mjs`、`diag4-reproducibility.mjs`

---

## 1. 症狀

B8（Mobile + A11y）實作 + 接線完成之後，`npm run test` 有 4 項失敗：

| # | 測試檔 | 測試名 |
|---|---|---|
| 1 | `tests/map-interaction.e2e.test.ts` | ⭐ zone 中心 click → store.selectedZoneId 非空（P0-1 核心斷言） |
| 2 | `tests/map-interaction.e2e.test.ts` | 迴歸：輕觸要選中、拖曳要平移 |
| 3 | `tests/map-interaction.e2e.test.ts` | ⭐ 微拖門檻：位移 2 px → 觸發選中 |
| 4 | `tests/a11y-keyboard.e2e.test.ts` | 12 個控制項：逐個到達，ring 區變化像素 > 0 |

⚠️ **失敗 1–3 係真回歸**：`map-interaction.e2e.test.ts` 之前係 **13/13 全綠**（B6 交付時），而且佢係 B6 揭發嘅最重要 bug（zone 可點）嘅**唯一行為證據**。

---

## 2. 診斷方法

**唔可以只信錯誤訊息**。寫咗 4 個獨立診斷腳本，喺真實 Chromium（`vite preview` 服務 `dist/`）量度：

- `diag-zone-null.mjs` —— 量 viewport / 各容器 rect / zone rect / `elementFromPoint` 結果 / `inert` 狀態
- `diag2-reproduce.mjs` —— 完整重現測試流程（按 `k` ×197 → zoom ×3），量 `body` computed style
- `diag3-overflow.mjs` —— 搵溢出元素、追蹤 `scrollX`、量 onboarding 遮蓋範圍
- `diag4-reproducibility.mjs` —— 跑 3 次確認可重現性

⚠️ 陷阱：`vite preview` 只綁 IPv6 `[::1]`，必須用 `http://localhost:PORT/`（唔可以 `127.0.0.1`）；
Playwright launch 要加 `args: ["--no-proxy-server"]`（環境有 `http_proxy`）。

---

## 3. 根因（失敗 1–3）

### 3.1 確定根因：`OnboardingCard` 遮蓋 zone 中心

**3 次 100% 重現**（`diag4-reproducibility.mjs`）：

```
run1: pick={zoneId:"zone_2a22537f9c", cx:686, cy:192, hitTag:"H2", hitClass:null}
run2: pick={zoneId:"zone_2a22537f9c", cx:686, cy:192, hitTag:"H2", hitClass:null}
run3: pick={zoneId:"zone_2a22537f9c", cx:686, cy:192, hitTag:"H2", hitClass:null}
```

`hitTag: "H2"` 而 `hitClass: null` —— 即 `elementFromPoint` 命中一個**冇 class 嘅 `<h2>`**。

**遮蓋物量測**（`diag3-overflow.mjs`）：

```json
"onboarding": {
  "rect": { "x": 300, "y": 171, "w": 420, "h": 226 },
  "pointerEvents": "auto",
  "zIndex": "20",
  "display": "block",
  "coveredZoneCenters": 1,
  "coveredIds": ["zone_2a22537f9c"]
}
```

**完整因果鏈**：

1. B8 新增 `OnboardingCard`（`position: absolute`，420×226，`z-index: 20`，`pointer-events: auto`），掛喺 `#map-pane` 內
2. 佢覆蓋地圖左上角 `(300, 171)` 至 `(720, 397)`
3. `zone_2a22537f9c` 嘅中心 `(686, 192)` 落喺呢個範圍內
4. `elementFromPoint(686, 192)` 命中卡片內嘅 `<h2>`（而唔係 `.zone-area`）
5. 測試斷言「應該命中 `.zone`」失敗 → 3 項連鎖失敗

**為何係真問題（唔可以只改測試）**：`pointer-events: auto` + `z-index: 20` 之下，
**真用戶點落去都係觸發卡片而唔係 zone** —— 嗰個 zone 完全不可互動。

### 3.2 已排除嘅嫌疑（逐項驗過）

| 嫌疑 | 量測結果 | 判定 |
|---|---|---|
| CSS cascade 輸咗 | computed `pointer-events` = `"auto"`，對應測試**通過** | ❌ 排除 |
| `#app-root` 向左偏移 | 3 次量 `appX` 都係 **0** | ❌ 排除（見 §3.3） |
| `bottom-sheet` 規則 | `@media (max-width: 1023px)`，測試用 1400×900 唔命中 | ❌ 排除 |
| zone 中心喺 viewport 外 | `inViewport: true` | ❌ 排除 |
| `#story-pane` 加咗 `inert` | `storyPane.inert = false`（初始 snap = half，唔係 peek） | ❌ 排除 |
| `#search-shell` 造成溢出 | 移除前後 `appRoot.x` 都係 -375（診斷 2）／0（診斷 4） | ❌ 非主因 |

### 3.3 ⚠️ 一個 flaky 觀察（已排除，但要記錄）

`diag2-reproduce.mjs` 一度量到 `appRoot.x = -378`、`mapPane.x = -378`（即整個 body 向左滾咗 378px）。

**但 `diag4-reproducibility.mjs` 跑 3 次都係 `appX: 0`**，而 `diag3-overflow.mjs` 亦係 0。

→ 判定為**動畫期間嘅暫時值**（`measure()` 執行時啱逢 `flyToChapter` 動畫），**唔係穩定狀態**。

**但已記錄為觀察項**：`body.scrollWidth` 實測 1590–1677（viewport 1400），
即係有橫向溢出。若日後發現 body 真係可被滾動，要重新調查。

---

## 4. 根因（失敗 4）

### 4.1 `#btn-toggle-panel` 喺 desktop 本來就隱藏

```
AssertionError: 以下控制項 focus ring 不可見：
#btn-toggle-panel 冇 bounding box
```

**根因**：`src/styles/main.css:1061`

```css
.panel-toggle { display: none; }
/* 然後喺窄屏 @media 內 */
.panel-toggle { display: inline-block; }
```

`#btn-toggle-panel`（`src/app.ts:306`，class = `nav-btn panel-toggle`）喺 **desktop 默認 `display: none`** ——
呢個係 **V1 遺留嘅既有設計**（desktop 側欄永遠顯示，唔需要 toggle；只有窄屏才需要）。

**判定**：B8 嘅 `a11y-keyboard.e2e.test.ts` 要求「12 個控制項」喺 desktop 全部可見，
**測試假設錯誤**，唔係產品 bug。

**修法**：`#btn-toggle-panel` 應該喺 **mobile viewport** 測（佢只喺窄屏顯示），
或喺 desktop 測時 skip 並喺測試內用粵文註明理由。
❌ **唔可以**為咗令測試過而改 `main.css`。

---

## 5. 副作用觀察（唔使修，但要記錄）

### 5.1 P1-1 修法造成橫向溢出

B8 嘅 P1-1 修法將 `.ch-pill` 由 30×24 改成 **44×44**（spec §7.2 第 9 項要求），
令 `#chapter-strip` 內容撐爆容器：

```
bodyScrollW: 1649 / 1677 / 1590（viewport 1400）
```

**但 `body` / `html` 都係 `overflow-x: hidden`，`scrollLeft` 三次量度都係 0**
→ **唔影響互動**（`elementFromPoint` 正常、`scrollX` 保持 0）。

**判定**：可接受副作用。建議 Gate 2 檢討 —— 舊 CSS 移除後可改為喺
`#chapter-strip` 自己身上 `overflow-x: auto`，唔使靠 body 嘅 `overflow-x: hidden` 兜底。

⚠️ **唔可以**為咗消除溢出而將 `.ch-pill` 改細過 44px（違反 spec）。

### 5.2 溢出元素清單

`diag3-overflow.mjs` 初始狀態搵到嘅溢出元素全部係 `BUTTON.ch-pill`：

```
{ sel: "BUTTON.ch-pill", x: 1396, right: 1440, w: 44, offsetWidth: 44 }
{ sel: "BUTTON.ch-pill", x: 1442, right: 1486, w: 44, offsetWidth: 44 }
...
```

即係 198 個章節 pill 水平排列（44px each）→ 總闊遠超容器。

---

## 6. 修法要求（已派修正代理）

### 產品側
1. **`OnboardingCard` 唔可以令地圖 zone 點唔到** —— 由代理揀最合理方案
   （可關閉 + 記住狀態／移位／縮細／改掛載點）
2. **必須保留 spec §5.1 要求嘅「4 個主入口」可達性** —— 唔可以為咗修呢個而刪走入門

### 測試側
3. **`tests/map-interaction.e2e.test.ts`** 嘅 zone 揀選邏輯有弱點：
   佢揀「**第一個**夠大嘅 zone」，冇檢查係否被遮蓋。
   應改為揀「**第一個真正可點嘅** zone」（`elementFromPoint` 命中 `.zone` 或其後代）。
   ⚠️ **但唔可以淨係修測試** —— 咁會掩蓋真問題。兩者都要做。
4. **`tests/a11y-keyboard.e2e.test.ts`** 嘅 `panel-toggle` 假設要改（見 §4.1）

---

## 7. 方法論教訓

### 7.1 「綠燈」唔等於「冇回歸」—— 必須跑全套

B8 代理自報「typecheck 0 / lint 0 / build 0」全部通過，但**冇跑全套測試**，
所以完全冇發現自己整紅咗 B6 嘅核心斷言。

→ **新交付嘅元件若被接線入 production 路徑，必須跑全套測試**，
唔可以只跑自己嗰幾個檔。

### 7.2 症狀訊息可能誤導

錯誤訊息係「實際命中：null」，令人以為係「座標冇元素」（viewport 外 / visibility hidden）。
**真相係命中一個冇 class 嘅 `<h2>`**（`getAttribute("class")` 對 H2 返 `null`）。

→ **要睇 `hitTag` 而唔係只睇 `hitClass`**。診斷腳本兩個都量，先睇得出真相。

### 7.3 診斷腳本要量「有咩元素」而唔係「係唔係 null」

`elementsFromPoint()`（複數）比 `elementFromPoint()` 更能揭露遮蓋鏈。
診斷 1 用複數版本見到：

```
topAtCenter: ["circle.event-marker", "circle.event-marker", "path.zone-area", ...]
```

即係當時命中 event-marker（因為嗰個 zone 唔同）。**用複數版本可以一次見到整個堆疊**。

### 7.4 單次量度可能係 flaky —— 要跑多次

`appX = -378`（診斷 2）vs `appX = 0`（診斷 3、4）。
如果只信單次量度，就會誤報一個唔存在嘅佈局問題。

→ **關鍵量度至少跑 3 次**，確認可重現性先落結論。

---

## 8. 結論

| 失敗 | 根因 | 性質 | 修法 |
|---|---|---|---|
| 1–3 | `OnboardingCard` 遮蓋 `zone_2a22537f9c` 中心 | **真回歸**（B8 引入） | 產品修 + 測試修（兩者都要） |
| 4 | `#btn-toggle-panel` 喺 desktop 本來 `display: none` | 測試假設錯誤 | 改測試（喺 mobile 測或 skip） |

**全部根因已確定，有可重跑嘅硬證據。**

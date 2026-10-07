# D 階段 5 交付報告 —— 視覺回歸守衛

> 對應：`docs/progress/d-legacy-css-migration.md` §6「未做（階段 2 / 4 / 5）」之階段 5
> 前置：D 階段 1+3／2／4 已完成
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

建立**確定性**視覺回歸守衛：7 個 canonical 狀態（3 個 surface × 2 種 viewport），
截圖 → 降採樣 → 逐像素比對，**喺瀏覽器 canvas 內完成**（零新依賴）。

| 指標 | 數值 |
|---|---|
| 狀態數 | **7**（桌面 1440×900 ×6 ＋ 手機 390×844 ×1） |
| 雜訊底線（同一份程式碼跑兩次） | **0～10 個像素、最大 Δ1** |
| 比對解析度 | 720×450（基線 50% 降採樣） |
| 容忍度 | 差異 **≤0.1%** 且 最大 Δ **≤32** |
| 基線大小 | 7 張 / **1.38 MB** |

**守衛有效性已用對照實驗證明**：故意加 `#topbar { background: #ff0000 }`
→ 差異 **7.33%（23,734 px）／Δ247** → **守衛變紅** ✓✓。

---

## 1. 為何一定要先解決「確定性」

D 階段 4 實測：**同一份程式碼跑兩次，7 張截圖有 6 張唔同** ✗ ——
根因係地圖 `flyTo` 係 **JS 動畫**，截圖截到中間狀態。
用嗰種圖做回歸 = 將 flakiness 當成 regression ✗。

`tests/helpers/visual-shots.ts` 嘅**四重確定性措施**：

| 措施 | 作用 |
|---|---|
| 注入 `*{transition:none;animation:none}` | 停 CSS 過場／關鍵帧（含 `zone-pulse`） |
| 等 `document.fonts.ready` | 字體載入完成（唔會截到 fallback 字形） |
| 等 `#svg-map` 嘅 `viewBox` **連續 2 次取樣相同** | 等地圖 flyTo／pan 動畫完 |
| 等 **2 帧 rAF** ＋ 固定 settle | 等 canvas 底圖重繪完 |

**實測效果**：由「6/7 張唔同（最大差 45 KB）」→ **「6/7 byte-identical，
剩 1 張 7 個像素、每通道差 1」** ✓✓。

---

## 2. 架構（零新依賴）

```
tests/helpers/visual-shots.ts        確定性截圖 + 比對（共用）
tests/visual-regression.e2e.test.ts  守衛本體
tests/baselines/visual/*.png         基線（7 張，50% 降採樣，1.38 MB）
```

### ⚠️ 為何比對要喺瀏覽器 canvas 內做

Node 側**冇 PNG decoder** ✗（加 `pngjs` 又要 CI 裝依賴 ✗）。
Playwright 已經開住一個瀏覽器 → 用 `<canvas>` 解碼／降採樣／逐像素比對 ✓
→ 只回傳一個細嘅摘要物件 ✓。

⚠️ **踩過嘅坑**：第一版係「喺頁面讀 `getImageData` 再傳返 Node」✗ ——
720×450 RGBA = **1,296,000 個數字** → `page.evaluate` 要序列化 ~10 MB JSON
→ **失敗**（回傳 undefined → 長度唔匹配 → 誤報「100% 唔同」）✗。
所以降採樣、比對、統計**一定要喺同一個 evaluate 內完成** ✓。

### 比對解析度嘅兩次修正

| 版本 | 問題 |
|---|---|
| v1 | 基線（720×450）**再** ×0.5 → 360×225 ✗ → 同當前圖（720×450）尺寸唔匹配 → 誤報 100% ✗ |
| v2 | 改為「以基線尺寸為準」✓ 但**又**乘 DOWNSCALE → 360×225（25%）→ 細節太少 ✗ |
| **v3（最終）** | 用基線嘅**原生尺寸**（720×450 = 50%）✓ → 捉得到細元件回歸 ✓ |

---

## 3. 容忍度校準（唔係隨意定）

```
雜訊底線（同一份程式碼跑兩次）：全 7 張合計 7～10 個像素、每通道最大 Δ1
```

| 參數 | 值 | 理由 |
|---|---|---|
| `MAX_DIFF_PCT` | **0.1%** | 比底線闊 ~200 倍；但仍然捉得到「一個 ~36×36 區域變色／移位」 |
| `MAX_DELTA` | **32/255** | 比底線闊 32 倍；單像素小變化唔誤報，肉眼可見色差一定中 |

---

## 4. 守衛有效性驗證（對照實驗）

| 實驗 | 期望 | 實測 |
|---|---|---|
| 同一份程式碼跑兩次 | 通過（0 差異） | ✅ 6/7 byte-identical、1 張 7 px Δ1 |
| **故意加 `#topbar { background: #ff0000 }`** | **變紅** | ✅ **7.33%（23,734 px）／Δ247 → gate_exit=1** |

> 一個**無效**嘅守衛比冇守衛更差（會畀假安全感）。所以呢步一定要做。

### ⚠️ 一個假線索（誠實記錄）

中間試過改 `--sp-3: 12px → 20px`，守衛**冇**捉到 ✗。查證之後：
嗰個 token 喺呢 7 個狀態**幾乎冇視覺影響**（只用喺 `#topbar` 嘅**橫向**
padding）→ 唔係守衛壞 ✓。**要證偽「守衛壞」就要用明顯改動** ✓。

同時發現 **PIL 同 canvas 嘅比對結果唔一致** ✗：
PIL（LANCZOS 重取樣）報 37.9%、canvas 報 0.001%。
根因：**基線係用 canvas `drawImage` 降採樣產生** ✓ → 同 canvas 比對一致 ✓；
PIL 用**另一個重取樣演算法** → 每個像素都差少少 ✓ → 37.9% ✗。
→ **驗證方法本身要一致**（同一條重取樣路徑）✓。

---

## 5. 使用方式

```bash
# 跑守衛（⚠️ 跑之前一定要清 5174 —— 見 §6 D5-1）
npx vitest run tests/visual-regression.e2e.test.ts

# 有意改動視覺之後，更新基線（**要 review diff**）
UPDATE_VISUAL_BASELINE=1 npx vitest run tests/visual-regression.e2e.test.ts
```

`npm run test`（全套）已包含本守衛 ✓。

---

## 6. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| **D5-1** | ⚠️ **殘留 server 會令守衛假綠** | `e2e.global-setup.ts` 會**沿用**已存在嘅 5174 server（只出 warning）。如果嗰個 server 係**改動之前**起嘅，佢可能服務舊 `dist/` → 守衛比對「舊 build vs 舊基線」→ **假綠** ✗。**緩解（未做）**：喺守衛內核對「頁面載入嘅 CSS 檔名 = `dist/assets/` 最新嗰個」。現時靠**人手記得清 5174** ✗ —— 已列為下一步 D5-5。 |
| D5-2 | **基線係機器相關** | 字體光柵化／DPR／GPU 因機而異 → 換機可能要重生基線。 |
| D5-3 | **CI 冇視覺守衛** | CI（ubuntu-latest）冇裝 Playwright browser → e2e 一律 skip ✓（唔會假紅 ✓ 但亦冇覆蓋 ✗）。 |
| D5-4 | **只有 7 個狀態** | 未覆蓋：淺色主題、其他 viewport、dossier 展開、載入失敗畫面。 |
| D5-5 | **`visual-shots.mjs` 同 helper 有重複** | 前者係獨立探測（量雜訊底線用），後者係守衛用；邏輯有重複 ✗。 |
| D5-6 | **未自動產生「差異圖」** | 失敗時只有數字（差異 %／Δ），冇 side-by-side 圖。 |

---

## 7. 閘門

| 閘門 | 結果 |
|---|---|
| `typecheck` / `lint` | 0 / 0 |
| `npm run test` | 見 `artifacts/phase3-resume/full-vitest15.log` |
| `pytest` / `validate` / `audit` | 見 `artifacts/phase3-resume/gates-d5.log` |

---

## 8. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議 | 針對 |
|---|---|---|
| ~~D5-7~~ | ~~加「殘留 server」守衛~~ → ✅ **已完成（見 §10）** | D5-1 |
| D5-8 | 擴到淺色主題 ＋ 更多 viewport（1280／1920） | D5-4 |
| D5-9 | 失敗時自動產生 side-by-side ＋ 差異熱圖 PNG | D5-6 |
| D5-10 | 統一 `visual-shots.mjs` 同 helper（後者為唯一來源） | D5-5 |

---

## 10. ✅ D5-7 完成（2026-10-07）：殘留 server 守衛（雙重）

### 10.1 問題

`tests/e2e.global-setup.ts` 原本「5174 已經有 server 就沿用」✗ —— 如果嗰個
server 服務緊**舊 build**，之後所有 e2e 都係測舊 build，而**視覺回歸守衛**
會比對「舊 build vs 舊基線」→ **假綠** ✗✗（比假紅危險得多）。

### 10.2 兩層守衛

| 層 | 位置 | 做法 |
|---|---|---|
| **① 根因層** | `tests/e2e.global-setup.ts` | 沿用之前核對「server 服務嘅 `/assets/*` 檔名 == `dist/index.html` 嘅」（Vite asset 有 content hash → 檔名變 = build 變）→ 唔一致就**清走重起** ✓ |
| **② 測試層** | `tests/visual-regression.e2e.test.ts` | 每次 assert「頁面實際載入嘅 CSS 檔名 == `dist/assets/` 最新嗰個」→ 唔一致就**大聲失敗** ✓ |

⚠️ 清走 5174 係安全：`vite.config.ts` 嘅 dev server 係 **5173**，5174 專屬 e2e preview ✓。

### 10.3 驗證（兩層都做咗）

| 實驗 | 期望 | 實測 |
|---|---|---|
| 改 `dist/index.html` 嘅 asset 名（模擬「頁面載入唔存在於 dist 嘅檔」） | **測試層守衛紅** | ✅ `頁面載入嘅 CSS 唔係 dist/ 最新嗰個 → 5174 有殘留舊 server ✗` |
| 由另一個目錄（`/tmp/olddist`，asset 名改成 `index-OLDBUILD.css`）起 server | **根因層偵測 + 清走** | ✅ `[e2e] ⚠️ 5174 有殘留 server 但服務緊**舊 build** → 清走重起` |
| 乾淨環境跑守衛 | 通過 | ✅ 7/7（最大 4 px / Δ1） |

### 10.4 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| **D5-11** | **「清走重起」對非 `vite preview` server 未必成功** | 實測用 `python -m http.server` 起嘅殘留 server，setup **偵測到** ✓ 亦嘗試清走 ✓，但嗰個 server 之後仍然服務舊 build ✗ → **測試層守衛照樣紅** ✓✓（即係**唔會假綠** ✓，但自動復原失敗 ✗）。另外：`vite preview` 實測會**即時讀 `dist/`** ✓ → 「preview 服務舊 build」呢個情境其實好難出現 ✓（真正風險係「由另一個目錄／另一個 checkout 起嘅 server」✓）。 |
| D5-12 | **`assetNames()` 只比 `/assets/*.js|css`** | 如果將來有新 asset 目錄（例如 `/chunks/`）就要擴 ✓。 |

---

## 9. D 舊 CSS 遷移 —— 五個階段全部完成

| 階段 | 內容 | 狀態 |
|---|---|---|
| 1+3 | 158 個被引用 class 原文搬入 `legacy-migrated.css`；三個舊檔刪除 | ✅ 2026-09-24 |
| 2 | `!important` 審計：49 條候選 → **0 條**（次序改由程式碼保證） | ✅ 2026-10-07 |
| 4 | 死 CSS 剪除：**31 個零引用 class / 49 條規則**（建置後 CSS −8.1%） | ✅ 2026-10-07 |
| **5** | **視覺回歸守衛**（7 個狀態、雜訊底線 ≤10 px、對照實驗證明有效） | ✅ **2026-10-07** |

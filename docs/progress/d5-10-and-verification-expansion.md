# D5-10 ／ D2-7 ／ D2-9 ／ D4-6～D4-9 ／ P1-6-7～P1-6-9 ／ characters byte-level 重建

> 對應各報告 §「下一步（未做）」清單。全部驗證程式化、可重跑；**零人手參與**。
> 日期：2026-10-07。

---

## 0. 一句話總結

本輪將 6 份進度報告嘅「下一步」一次過清走 **10 個項目**，全部係
**擴充自動驗證規則**（唔係改功能）：

| 項目 | 內容 | 產出 |
|---|---|---|
| P1-6-6 | 驗收矩陣 §1 補完（spoiler=1／無 blocking modal） | 已於上一 commit 完成（`d8c8f81`） |
| **D5-10** | 統一 `visual-shots.mjs` 同 TS helper（helper 為唯一來源） | 腳本由 7 → **11 狀態**，邏輯零重複 |
| **P1-6-7** | 清 `legacy-migrated.css` dangling token ＋ 全 stylesheet 斷言 | 捉到並修好 `var(--fg)` |
| **P1-6-8** | 修探測腳本收檔（Windows 安全）＋ 棘輪守衛 | 新 `_probe-lib.mjs`；6 個探測已遷移 |
| **P1-6-9** | 狀態處理器內再寫狀態 → 通用守衛 | `store.notify()` 改為排隊 ＋ drain |
| **D2-7** | 探測器擴到搜尋 overlay／編年史／dossier | 新 `probe-style-contract.mjs`（11 狀態） |
| **D2-9** | 視覺契約快照（computed style／幾何，唔用像素） | 新 helper ＋ e2e ＋ 基線 JSON |
| **D4-6** | `probe-dead-css-shots.mjs` 動畫穩定 ＋ 雜訊底線 | 修好「同一份 build 兩次都唔同」 |
| **D4-7** | 三重判準接入 CI（A＋B；C skip） | `audit_dead_css.py --fail-on-dead` ＋ CI step |
| **D4-9** | `docs/contracts/` class 契約自動檢查 | `class-contract.json` ＋ 工具閉環 |
| **C 項** | `characters.json` byte-level 重建 | canonical 序列化契約 ＋ `--rebuild` |

---

## 1. D5-10：統一 `visual-shots.mjs` 同 helper

### 問題

`artifacts/phase3-resume/visual-shots.mjs` **自己抄咗一份**狀態定義同等待邏輯
（7 個狀態），而 `tests/helpers/visual-shots.ts` 已經係 11 個狀態
（D5-8 加咗淺色主題／1280／1920）→ **兩份來源唔一致** ✗。

### 修法

Node 22（type stripping）**可以直接 `import` `.ts`** → 唔需要再抄：

```js
import { STATES, openShotPage, shoot, waitApp }
  from "../../tests/helpers/visual-shots.ts";
```

本檔只剩「起 server → 逐個狀態 goto／act／shoot／寫檔」。
**狀態數由 7 → 11**（自動跟 helper）。

### 守衛

`tests/probe-hygiene.test.ts`：斷言 `visual-shots.mjs` 由 helper 讀狀態，
而且**唔可以**再自己寫 `name: "01-…"`。

---

## 2. P1-6-7：dangling token

### 實測

掃 `src/styles/*.css` 嘅 `var(--x)`（**冇 fallback** 嘅才算危險）：

| 檔案 | 結果 |
|---|---|
| `legacy-migrated.css` | **1 個**：`--fg`（`.legend-title`，L412）—— 任何 stylesheet 都冇宣告 → `color` 靜默 fallback 到 `inherit` ✗ |
| `layout.css` | `--safe-right` —— 喺 `mobile.css` 宣告 → **合法跨檔**，唔算 dangling ✓ |
| 其餘 | 0 |

⚠️ 另外 7 個（`--bg-deep`／`--chip-color`／`--color-*`）**有 fallback**
→ CSS 保證有值，唔算 dangling。

### 修法

`legacy-migrated.css:412` `var(--fg)` → `var(--fg-primary)`（由 legacy 自己宣告）。

### 守衛

`tests/map-css-contract.test.ts` 新增 §5b（+3 tests）：
- 掃**所有** `src/styles/*.css`，凡「冇 fallback 又唔喺全專案 token 宇宙」
  → 紅；
- ⚠️ 用「全專案宇宙」而唔係「只 `tokens.css`」—— 否則 `--safe-right` 會誤報；
- **對照測試**：餵 `var(--nope)` 入去要捉到（證明偵測器唔係恆真）；
- 具體回歸守衛：`var(--fg)` 唔可以回流。

---

## 3. P1-6-8：探測腳本收檔（Windows 安全）

### 問題

⚠️ `process.kill(-pid)` 喺 Windows **冇效**（MEMORY E18）→ 殘留
`vite preview` 佔住 5174 → 之後 e2e 連去**舊 build** → **假綠**。

### 修法

新增 `artifacts/phase3-resume/_probe-lib.mjs`：
- `ensurePreviewServer()`／`stopPreviewServer()`（**Windows 用 `taskkill /T /F`**）／
  `withTeardown(browser, server, body)`（`finally` 保證收檔）。

已遷移 6 個：`visual-shots`／`probe-map-pane-area`／`probe-css-order`／
`probe-dead-css`／`probe-dead-css-shots`／`probe-style-contract`。

### 守衛（棘輪）

`tests/probe-hygiene.test.ts`：
- 仍有 ~18 個歷史腳本用舊模式 → 列喺 `LEGACY` 清單（容忍），但
  **唔可以再加新嘅**（新檔一用舊模式就紅）；
- ⚠️ 檢查前**一定要剝走區塊註解** —— 否則「解釋為何唔用 `process.kill(-pid)`」
  嘅檔頭註解本身會被當成違規（實測踩過）；
- 已遷移嘅 6 個要 import `_probe-lib.mjs` 而且**唔可以**自己 `spawn("npx")`。

---

## 4. P1-6-9：狀態處理器內再寫狀態

### 問題（MEMORY 教訓 #27）

`store.notify()` 係同步 for-loop。訂閱者（`App.onStateChange()`）喺 handler 內
再 `setSheetSnap()` 時，`commit()` **同步再入** → 內層即刻派新狀態，但外層
for-loop 返嚟之後**繼續用舊 `next`** 派畀後面訂閱者 → **舊蓋新** ✗
（實測事故：`is-collapsed` 被加返，pane 明明 `data-sheet-snap="half"`
但仍然 `visibility: hidden`）。

### 修法（通用守衛）

`notify()` 改為**巢狀通知排隊 ＋ 最外層 drain**：
- 冇訂閱者會收到「比佢已經見過嘅更舊」嘅狀態 ✓；
- 終止條件係 queue 清空（唔會 stack overflow）✓；
- 仍然**同步**（drain 喺同一 call stack 內）→ 唔改「`setXxx()` 之後
  `getState()` 已更新」嘅契約 ✓；
- 安全上限 100 輪（防「訂閱者無條件寫狀態」無限 drain），超過就 warn ＋ 中止。

### 守衛

`tests/store-reentrancy.test.ts`（5 tests）：
1. ⭐ 巢狀寫入後，後面訂閱者嘅**最後觀察值**一定係最新（舊行為會係舊值）；
2. ⭐ 觀察序列**單調**（唔會「新之後又舊」）；
3. 冇巢狀時只派一次（唔會多派）；
4. 無條件寫入 → **有界**（唔 stack overflow）＋ 有 warn；
5. 通知期間退訂唔會令 drain 卡住。

---

## 5. D2-7 ／ D2-9：視覺契約快照（唔用像素）

### 為何要（同像素守衛互補）

D5 嘅**像素**守衛證明「畫面一樣」，但係黑盒 —— 失敗只知「幾多像素差」✗。
D2-9 抽「關鍵元素嘅 computed style ＋ 幾何」成 JSON → 失敗可以**逐個屬性**
睇「邊個由 X 變 Y」✓。

### 產出

| 檔案 | 角色 |
|---|---|
| `tests/helpers/style-snapshot.ts` | `collectSnapshot()`／`diffSnapshots()`（顏色正規化、幾何四捨五入、±2px 容差） |
| `tests/visual-contract.e2e.test.ts` | 11 個狀態對基線；＋ 兩個語意不變式（`#map-pane` ≥70%、淺色主題獨立） |
| `tests/baselines/style-contract.json` | 基線（11 狀態 / 43 KB） |
| `artifacts/phase3-resume/probe-style-contract.mjs` | D2-7 探測（逐個狀態印指紋；`--write-baseline`） |

⚠️ 狀態定義**唯一來源**係 `visual-shots.ts` 嘅 `STATES`（唔另抄）。

### 驗證

- 探測生成基線 → e2e 跨**另一個 process** 收集 → **一致** ✓（跨 process 確定性）；
- 11 個狀態含：搜尋 overlay（`06`）、編年史（`05`／`09`）、dossier 展開
  （`04`）、淺色主題（`08`／`09`）、三種 viewport。

---

## 6. D4-6：探測腳本動畫穩定 ＋ 雜訊底線

### 問題

`probe-dead-css-shots.mjs` 冇等動畫定咗 → 同一份程式碼兩次都 6/7 張唔同 ✗；
而且冇量雜訊底線 → 見到差異都唔知係真回歸定雜訊。

### 修法

改用 helper 嘅 `shoot()`（停動畫 ＋ 等 `viewBox` 連續 2 次相同 ＋ 2 帧 rAF）；
`--compare A B` 模式**先報雜訊底線**才比對 A/B。

### ⚠️ 重要方法論發現：底線一定要量**跨 run**

實測（2026-10-07）：

| 量法 | 結果 |
|---|---|
| 同一頁**連影兩次** | **0 px**（`waitStable` 之後畫面真係完全靜止） |
| **兩次獨立 run** | 最大 **51 px／Δ12**（地圖 `flyTo` settle 到略有差異嘅子像素狀態） |

→ 用 0 做底線會**誤報**「超出雜訊」✗。所以 `--compare` 用**同一份 build 獨立
影兩次**（t1／t2）做底線。實測：A/B 差 63 px **<** 底線 82 px →
「✓ 冇狀態超出底線」✓。

---

## 7. D4-7：三重判準接入 CI

`scripts/audit_dead_css.py` 新增 `--fail-on-dead`（只判 `dead`；
`maybe-dynamic` 唔會令 CI 紅）。CI `python-pipeline` job 新增：

```yaml
- name: 死 CSS 三重判準（D4-7：A＋B 靜態；C 需要 browser → 喺 CI skip）
  run: >-
    python scripts/audit_dead_css.py
    --json /tmp/dead-css.json
    --contract docs/contracts/class-contract.json
    --fail-on-dead
```

實測：`legacy-migrated.css` 170 個 class → **0 個判死** ✓。

---

## 8. D4-9：`docs/contracts/` class 契約自動檢查

### 問題（D4-3 嘅盲點）

「`docs/` 提及唔算使用」係**判斷**。如果契約**明文要求**某 class 必須存在，
一次 `prune_dead_css.py` 就會**靜默刪走** ✗。

### 修法（令契約可執行）

| 檔案 | 內容 |
|---|---|
| `docs/contracts/class-contract.json` | machine-readable「必須存在」清單（每個 entry 有 `reason` ＋ `producedBy`） |
| `scripts/audit_dead_css.py` | 新增 `--contract` → 契約 class 判 `contract`（唔判死） |
| `scripts/prune_dead_css.py` | 新增 `--contract` → 契約 class **永不剪** |
| `tests/class-contract.test.ts` | 5 tests：格式、存在性、偵測器敏感度、工具讀契約、CI 帶 `--contract` |

首批契約 4 個：`bg-error-panel`／`bg-error-detail`／`bg-error-hint`（**只喺失敗
路徑出現**，執行期探測永遠睇唔到 → 最易被誤判死）、`skip-link`（平時視覺收埋）。

---

## 9. C 項：`characters.json` byte-level 重建

### ⚠️ 先釐清「重建」唔等於「重算」

`c-characters-reproducibility.md` §2.3 已證實：凍結 330 條**唔可以由現時
`data/private/**` 重算**（版本 skew：產生器出 344 條，而且兩邊各有對方冇嘅記錄）。
嗰個係**資料層**問題。

### 所以本輪定義「byte-level 重建」喺**可達成**嘅一層

> 給定已 parse 嘅資料模型，用**唯一 canonical 序列化器**重出，一定逐 byte 相同。

### 🔎 關鍵發現

凍結 `data/public/**` **已經係** canonical 形式 —— 之前以為唔係，係因為
**Windows `core.autocrlf=true` checkout 出 CRLF**：

```
[characters.json]  crlf=7441  lf_only=0  ends_nl=True  canon_lf_match=True
[timeline.json]    crlf=45810 lf_only=0  ends_nl=True  canon_lf_match=True
…（六個檔全部 canon_lf_match=True）
```

即係 **LF 正規化之後**，每個檔 == `json.dumps(doc, ensure_ascii=False, indent=2) + "\n"` ✓。

### 產出

| 檔案 | 角色 |
|---|---|
| `scripts/rebuild_public_json.py` | `canonical_text()`／`check_file()`／`check_mirror()`／`check_characters_invariants()`／`rebuild()`；CLI `--check`／`--rebuild DIR` |
| `tests/test_public_json_canonical.py` | 8 tests |

### 不變式（令重建結果**唯一**）

`characters.json`：330 條、id 排序、id 唯一、name 唯一、
**alias 唔撞 canonical name**（＝合併乾淨）、key 順序一致（13 欄）。

### 測試重點

1. ⭐ 每個公開 JSON 都係 canonical 形式；
2. ⭐ **重建 bytes == 已 commit bytes**（逐 byte，LF 為準；重建輸出保證純 LF）；
3. 重建**確定性**（兩次一致）；
4. canonical 化係**固定點**（idempotent）；
5. 鏡像 `public/data/public/**` 一致；
6. characters 結構不變式；
7. ⭐ **對照**：`indent=4`／冇結尾換行／有 BOM 都要判紅，正確 canonical 要綠；
8. CLI exit code ＋ `--rebuild` 輸出 byte-identical。

---

## 10. 閘門（最終）

| 閘門 | 結果 |
|---|---|
| typecheck | **0** |
| lint | **0** |
| vitest 全套 | **56 檔 / 759 tests 全綠（exit 0）**（基線 736；含 11 像素守衛 ＋ 3 視覺契約 ＋ 12 panel-overlay） |
| pytest | **327 passed**（基線 319 ＋ 新增 8） |
| `validate_public_data.py` | ✅ |
| `audit_release.py` | ✅ |
| `git fsck --full` | 無 error／missing（只有 2 個 benign dangling commit） |
| `rebuild_public_json.py --check` | ✅ 全部通過 |
| `audit_dead_css.py --fail-on-dead` | ✅ 0 死 class |

### 10.1 ⚠️ 全套跑時捉到一個**既有 flaky 測試**（唔係本輪回歸）

第一次全套跑：**1 failed / 758 passed** ——
`tests/map-interaction.e2e.test.ts` 嘅「微拖門檻（2px）」斷言失敗。

**逐項證偽**（唔靠直覺）：

| 檢查 | 結果 |
|---|---|
| 單獨跑嗰個測試 | ✅ **pass**（100%）→ 唔係產品回歸 |
| 測試自己嘅註解 | 已記載：「全套測試（35 檔、9 分鐘、CPU 高負載）之下，Chromium 嘅 `click` 合成會被延遲 → 間歇性 fail（但單獨跑 13/13 pass）」 |
| 本輪改動關係 | 本輪新增 `visual-contract.e2e`（+2 分鐘）令全套**更長更重** → 提高咗 flake 機率，但**唔係**令斷言變假 |

**修法（唔放寬斷言）**：將該處 `expect.poll` 嘅 `timeout` 由 **5s → 15s**。
斷言仍然係 `toBe(1)`（2px 微拖**必須**選中）—— 只係令「等狀態真正變化」嘅
上界闊啲。呢個係**量度儀器**問題（合成 click 被延遲），唔係產品問題。

> 教訓：**「全套綠燈」係唯一可信嘅閘門** —— 單獨跑會漏 flaky；
> 而 flaky 嘅根因往往係**量度時序**，唔係邏輯。

---

## 11. 已知限制（誠實記錄）

1. **D2-9 快照係機器相關**（字體光柵化／DPR）→ 已用「容器為主 ＋ 幾何 ±2px
   容差 ＋ 顏色正規化」降低敏感度，但換機仍可能要重生基線。
2. **視覺契約守衛喺 CI skip**（CI 冇 Playwright browser）→ 同像素守衛一致；
   CI 嘅靜態守衛係 `map-css-contract`／`probe-hygiene`／`class-contract`。
3. **P1-6-8 棘輪仍有 ~18 個歷史腳本**用舊收檔模式 → 未遷移（唔影響，
   因為佢哋唔係 e2e 前置）；清單已明示，新增唔准。
4. **`characters.json` 由 `data/private/**` 重算仍然唔可能**（版本 skew）
   → 本輪只保證「canonical 形式 ＋ 重建逐 byte 一致」，唔保證「由輸入重算」。
   要真正全鏈重建，需要重建 Phase B → merge 全流程（未做）。
5. `--rebuild` **唔會**改 repo（只寫入指定目錄）—— 因為專案規則係
   「改 `data/public/**` 要改 pipeline，唔係改輸出」。

---

## 12. 下一步（全部程式化，零人手）

1. **D2-9 擴狀態**：將視覺契約快照擴到「載入失敗」狀態（配 `class-contract`
   嘅 error 畫面 class）—— 目前 11 個狀態全部係正常路徑。
2. **P1-6-8 繼續遷移**：將剩餘 ~18 個歷史探測腳本搬去 `_probe-lib.mjs`，
   逐步縮細 `LEGACY` 清單。
3. **C 項全鏈重建**：將 `merge_characters.py` 嘅合併決定**前移入產生器**
   （讀同一份 `character-merge-decisions.json`），令 provisional 輸出直接係
   「已合併」狀態，再用 id 集合 hash 守住 —— 呢個係唯一可以逼近「由輸入重算」嘅路。
4. **D4-9 擴契約**：將「只喺失敗路徑／特殊狀態出現」嘅 class 陸續加入
   `class-contract.json`（每次由執行期探測假陰性嘅都應加入）。

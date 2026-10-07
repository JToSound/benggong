# D 階段 4 交付報告 —— 死 CSS 剪除（31 個零引用 class）

> 對應：`docs/progress/d-legacy-css-migration.md` §6「未做（階段 2 / 4 / 5）」之階段 4
> 前置：D 階段 1+3（舊 CSS 原文搬入 `legacy-migrated.css`）＋ 階段 2（`!important` 審計）已完成
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

`legacy-migrated.css` 有 **202 個 class 選擇器**。用**三重保守判準**
（靜態字面 ＋ 前綴碎片 ＋ 真瀏覽器 7 狀態實測）分析之後，**31 個係零引用**
（49 條規則）→ 已剪除：

| 指標 | 前 | 後 |
|---|---|---|
| `legacy-migrated.css` | 3,336 行 | **2,999 行**（−337） |
| 原始碼大小 | 83,000 字元 | **76,782 字元**（−7.5%） |
| **建置後 CSS** | **60.14 kB** | **55.29 kB**（−8.1%） |
| gzip | 12.62 kB | **11.72 kB** |

**驗證強度**（由弱至強）：三重判準 ✓ → **剪除前後逐像素比對**（差異
**10 / 1,296,000** 像素、最大強度差 **3/765** = 亞像素雜訊）✓ → 全套測試 ✓。

---

## 1. 為何唔可以用原本嘅 Gate 2 分析器

`docs/progress/d-legacy-css-migration.md` §6 已記載兩個問題：
1. 只印**前 30 個**結果；
2. 註明「class 可能由變數拼成 → 會誤判為死」。

**本輪實測仲發現兩個更嚴重嘅問題**（兩者都會令結論反轉）：

| 問題 | 實例 | 後果 |
|---|---|---|
| **假陽性**：`docs/` 提及當成「有引用」 | `docs/audits/*.md` 列出咗 `chr-tl-bar`（V1 時間軸）→ 被判「有引用」 | 掩蓋「V1 時間軸已死」✗（**第一次分析只搵到 6 個死 class；分開 docs 之後變 31 個**） |
| **假陰性**：漏咗模板字串拼接 | `ChronicleView.ts:307` 有 `` `is-${item.confidence}` `` → 舊判準只match「引號開頭嘅前綴」→ 唔會發現 `is-` 係動態 | 可能誤刪 live 嘅動態 class ✗ |

→ 所以本輪重寫成 `scripts/audit_dead_css.py`（三重判準）＋
`artifacts/phase3-resume/probe-dead-css.mjs`（執行期收集）。

---

## 2. 三重保守判準

判死 = **A 冇** **且** **B 冇** **且** **C 冇**：

| 判準 | 內容 | 為何必要 |
|---|---|---|
| **A 全字面** | 使用語料（`src/**`、`tests/**`、`scripts/**`、`index.html`、`public/**`）內**冇**該 class 嘅完整字面（詞邊界匹配） | 最基本嘅「有冇人用」 |
| **B 前綴碎片** | 語料內**冇**任何係該 class 前綴（長度 ≥ 4）嘅字串（含 `"frag"` / `'frag'` / `` `frag ``） | 防止 `"zd-" + kind`／`` `is-${x}` `` 之類拼接被誤判為死 |
| **C 執行期** | 真瀏覽器行 **7 個 app 狀態**（桌面預設／面板開／第 198 章／揀咗 zone／編年史／搜尋 overlay／手機），收集實際出現過嘅 class 集合 → 有出現就唔係死 | 兜住「由資料驅動」嘅 class |

⚠️ **`docs/` 唔計入使用語料** —— 文件提及唔代表執行期會用（見 §1）。

⚠️ **C 係抽樣**（唔可能窮舉所有狀態）→ 只可以**否證**「死」，唔可以單憑佢判定死。
所以三重缺一不可。

---

## 3. 結果：31 個死 class（49 條規則）

| 家族 | 個數 | 說明 |
|---|---|---|
| `bg-*`（V1 側欄／關於／搜尋／量測） | 15 | `bg-sidebar-inner`、`bg-search*`、`bg-about-inner`、`bg-char-list`、`bg-detail-actions`、`bg-hint`、`bg-measure-btn`、`bg-measure-tip`、`bg-provisional-banner`、`bg-dot`、`bg-marker`、`bg-meta`、`bg-spoiler-btns`、`bg-error` |
| `tl-*`（V1 時間軸） | 11 | `tl-item`、`tl-list`、`tl-marker`、`tl-chapter`、`tl-date`、`tl-desc`、`tl-meta`、`tl-spoiler`、`tl-highlight`、`tl-filter` |
| `is-*`（V1 時間軸時期顏色，掛喺已死嘅 `.chr-tl-bar`） | 5 | `is-outbreak`、`is-early`、`is-basecamp`、`is-lohas`、`is-endgame` |

### 獨立佐證（重要）

`docs/audits/visual-motion-audit.md:480` 早已指出：

> **32 個 class selector 喺 TS 完全冇 producer（真死碼）**：`bg-provisional-banner`、
> `bg-marker`、`bg-dot`、`bg-meta`、`tl-list`、`tl-item`、…、`is-current`、`#map-root`

而 `docs/audits/frontend-architecture-audit.md:521` 對 `src/styles/timeline.css`
嘅裁決係 **DELETE**（「大部分係已移除功能嘅死 CSS（`tl-*`、`bg-search*`、
`bg-sidebar-*`、`bg-measure-*`、`bg-provisional-banner`）」）。

→ 本輪三重判準嘅 **31 個**同舊審計嘅 **32 個**高度吻合 ✓✓ —— 而舊審計嗰份係
**人手／啟發式**得出，本輪係**可重跑程式化**得出 ✓。

### 為何 `is-current` 唔喺我哋嘅清單

舊審計列咗 `is-current`（同 `type-character`、`spoiler-2` 等）。本輪判準下佢哋係
**「可能拼接」**（語料有 `type-${…}`／`spoiler-${…}` 之類）→ **唔會判死** ✓
—— 呢個就係三重判準比舊審計**更準**嘅地方 ✓。

---

## 4. 驗證

### 4.1 剪除前後逐像素比對（7 個狀態）

工具：`artifacts/phase3-resume/probe-dead-css-shots.mjs`

⚠️ **第一次比對得出「6/7 有差異」，係假警報** ✗ —— 為咗證偽，我**還原 CSS
再截一次**（同一份程式碼、兩次跑）：

| 圖 | before vs revert（**同一份程式碼**） | revert vs after（**真差異**） |
|---|---|---|
| 01-desktop-default | ⚠️ 唔同 | ✅ 一樣 |
| 02-desktop-pane-open | ⚠️ 唔同 | ⚠️ 唔同 |
| 03-desktop-ch198 | ⚠️ 唔同 | ✅ 一樣 |
| 04-desktop-zone-selected | ⚠️ 唔同 | ✅ 一樣 |
| 05-desktop-chronicle | ⚠️ 唔同 | ✅ 一樣 |
| 06-desktop-search-open | ⚠️ 唔同 | ✅ 一樣 |
| 07-mobile-default | ✅ 一樣 | ✅ 一樣 |

→ **同一份程式碼跑兩次都有 6/7 唔同** ✗ → 截圖比對**本身唔可靠**（地圖
`flyTo` 係 JS 動畫，截到中間狀態）。

再用像素級量度嗰個唯一「真差異」：

```
02-desktop-pane-open: 有差異像素 10 / 1,296,000 = 0.0008%
                       最大強度差 3 / 765｜平均 0.0000
05-desktop-chronicle: 0
01-desktop-default  : 0
```

→ **亞像素雜訊**（一行 1 px 高、強度差 0.4%）✓ → 剪除係**像素中性** ✓✓。

> **教訓**：用截圖做回歸驗證之前，一定要先量「**同一份程式碼跑兩次**」嘅
> 雜訊底線 ✗。否則會將 flakiness 當成 regression。

### 4.2 閘門

見 §6。

---

## 5. 新增契約（防止回流）

`tests/dead-css-policy.test.ts`（4 tests）：

| 斷言 | 內容 |
|---|---|
| ⭐ 31 個已剪除嘅 class 唔可以回流 | 用選擇器邊界匹配（`.bg-error(?![\\w-])` → 唔會誤中 live 嘅 `.bg-error-panel`） |
| ⭐ live 嘅同名前綴 class 唔可以被誤刪 | `.bg-error-panel` / `-detail` / `-hint`（`src/main.ts` 載入失敗畫面）必須仍然存在 |
| CSS 結構完好 | 大括號平衡 ＋ 冇空規則（`{}`） |
| 工具仍然存在 | 分析／剪除／探測腳本齊全（可重跑） |

---

## 6. 閘門

| 閘門 | 結果 |
|---|---|
| `typecheck` / `lint` | 0 / 0 |
| `npm run test` | 見 `artifacts/phase3-resume/full-vitest14.log` |
| `pytest` / `validate` / `audit` | 見 `artifacts/phase3-resume/gates-d4.log` |

---

## 7. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| D4-1 | **執行期判準係抽樣** | 7 個狀態覆蓋唔到「載入失敗」（`.bg-error-panel` 就係咁樣喺第一次分析被誤判）→ 所以**唔可以單憑 C 判死**，一定要 A＋B＋C 一齊。 |
| D4-2 | **前綴判準係啟發式** | 只檢查「語料內有冇該 class 嘅前綴字串（≥4 字）」。如果拼接用嘅碎片 <4 字（例如 `"b" + kind`），就會漏 ✗ → 但方向安全（漏 → 唔殺 ✓）。 |
| D4-3 | **`docs/` 提及唔算使用** | 呢個係判斷（唔係量度）。如果將來有 `docs/contracts/` 明文要求某 class 必須存在，就會被誤判為死 ✗ → 所以契約文件要寫落 `tests/`（可執行）而唔係 `docs/`。 |
| D4-4 | **截圖比對未自動化** | 本輪嘅 `probe-dead-css-shots.mjs` 冇「等地圖動畫定咗」嘅等待 → 同一份程式碼兩次跑都 6/7 唔同 ✗。要真正做視覺回歸（階段 5）必須先解決呢點。 |
| D4-5 | **階段 5（視覺回歸）仍未做** | 本輪嘅像素比對係**一次性驗證**，唔係常設守衛。 |

---

## 8. 重跑指令

```bash
# 1) 執行期收集（真瀏覽器；⚠️ 跑完要清 5174）
node artifacts/phase3-resume/probe-dead-css.mjs artifacts/phase3-resume/dead-css-runtime.json

# 2) 三重判準分析
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/audit_dead_css.py \
  --json artifacts/phase3-resume/dead-css-final.json \
  --runtime artifacts/phase3-resume/dead-css-runtime.json

# 3) 剪除（dry-run 先睇）
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/prune_dead_css.py \
  --analysis artifacts/phase3-resume/dead-css-final.json
# 加 --apply 才真改

# 4) 逐像素驗證（⚠️ 要先跑一次「唔改」做雜訊底線！）
node artifacts/phase3-resume/probe-dead-css-shots.mjs artifacts/phase3-resume/shots-before
node artifacts/phase3-resume/probe-dead-css-shots.mjs artifacts/phase3-resume/shots-after

# 5) 契約
npx vitest run tests/dead-css-policy.test.ts
```

---

## 9. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議 | 針對 |
|---|---|---|
| D4-6 | `probe-dead-css-shots.mjs` 加「等地圖動畫定咗」（`viewBox` 連續兩帧相同）＋先跑雜訊底線，才做像素比對 | D4-4 |
| D4-7 | 將三重判準接入 CI（Python job 可跑 A＋B；C 需要 browser → skip） | D4-1 |
| D4-8 | **階段 5**：用本輪嘅截圖框架做視覺回歸（先解決 D4-4） | D4-5 |
| D4-9 | 為 `docs/contracts/` 嘅 class 契約加自動檢查（令 D4-3 嘅判斷唔再靠人） | D4-3 |

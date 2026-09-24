# C8 敵意產品審查報告 —《病港》互動地圖 World Atlas V2

> 角色：C8 Hostile Product Reviewer（對抗驗收）
> 日期：2026-09-24
> 對象：`dist/`（build 2026-09-24 21:47，比所有 `src/` 檔新）
> 方法：`npx vite preview --port 5176` + Playwright（`artifacts/audit-C8/capture*.mjs`），全部證據存 `artifacts/audit-C8/`
> 硬性限制遵守：只寫 `docs/audits/` 同 `artifacts/`；冇改 `src/` `scripts/` `data/` `tests/`；冇跑 `npm run test`；preview server 已 `taskkill` 清理

---

## 0. 判定

| 項目 | 結果 |
|---|---|
| **P0** | **1**（編年史不可讀） |
| **P1** | **8** |
| spec §7 C8 通過條件（**無 P0 / 無 P1**） | ❌ **不通過** |
| 總體判定 | **唔可交付**。架構層係真嘅 V2 遷移，但**產品層**「world-atlas experience」只完成一半 |

---

## 1. 執行摘要 — P0 / P1 清單

### P0-1 編年史被塞入 380px 側欄，條目卡實測 **83px 寬**，文字逐字斷行，不可讀

- **證據**
  - `src/styles/chronicle.css:31` → `grid-template-columns: 220px minmax(0, 1fr)`（設計係 220px 側欄 + 彈性主欄）
  - `src/styles/legacy-migrated.css:301` → `.pane-story { width: 380px; }`（面板固定 380px）
  - 實測（`evidence4.json` / `evidence6.json`）：`.chronicle` 容器 **347px** → `.chr-rail` **220px** → `.chronicle-body-wrap` **115px** → `.chr-entry` **83px**
  - 1280 / 1440 / 1920 / 2560 四個桌面寬度，`.chr-entry` **一律 83px**（面板固定 380px，唔隨 viewport 變）
  - 截圖：`04-desktop-chronicle.png`、`11-desktop-chronicle-nobanner.png`、`16-desktop-1920-chronicle.png` —— 條目文字以「一欄一字」垂直排列（例：「M / 自述 / 患病 / 與中 / 學被 / 欺凌 / 的過 / 去」）
- **影響**：編年史係 spec IA §5.1 **四個主入口之一**（「打開編年史」）、頂欄有獨立按鈕（`📜 編年史`）、有獨立設計文檔（`docs/CHRONICLE_DESIGN.md`）同設計資產（`docs/assets/chronicle-*.png`）、收錄 1320 條。用戶由任何入口入去，見到嘅係不可讀介面 → **功能等同未交付**。
- **唔係 viewport 特例**：`getViewMode()`（`src/app.ts:196`）回 `"chronicle"` 之後，`syncSurfaces()`（`src/app.ts:625`）只係將 chronicle render 入 `#story-panel-mount`；grep 全 `src/styles/` **冇** 任何 chronicle 全寬／全屏模式。

### P1-1 48 個 zone 喺預設世界視圖擠成不可辨識嘅一坨

- **證據**
  - 幾何：48 個 zone 質心經度跨度 **0.1039°**、緯度跨度 **0.0894°**；**46/48（96%）** 距整體質心 **<0.03°**
  - DOM（`evidence4.json`）：zone 兩兩視覺重疊 **559 / 1128 對（49.6%）**；抽樣 zone `zone_51bf7d8190` 同 **35 個其他 zone** 嘅 rect 重疊
  - LOD（`evidence5.json`）：世界視圖下確有 6 個 `zone-cluster` badge（counts `14,10,5,5,3,2`），但 badge 直徑只 10px、低對比（深青字喺深底），被 48 個 ~21px 半透明 zone 圓淹沒
  - 截圖：`crop-zone-cluster.png`、`crop-cluster-tight.png`（放大 6 倍後仍然係一團圓 + 幾個幾乎睇唔到嘅數字）
- **影響**：spec 硬性要求「48 個 zone 永遠全部 render」，但實際效果係首屏 zone 圖層 = 視覺噪音；用戶睇唔出「48 個區域」，亦冇辦法喺世界視圖揀到特定一個。

### P1-2 選中 zone **唔會** fly-to／唔會放大，而且同 35 個 zone 重疊 → 用戶唔知自己揀咗邊個

- **證據**
  - `evidence3.json` `desktopZoneClick`：click 前後 `viewBox` 完全一樣（`113.79 22.11 0.6999… 0.5407…`），`mapMoved: false`
  - 對比：**章節**選擇會 fly-to —— `evidence3.json` `chapterChange.mapMoved: true`（`viewBox` 由 0.70° 縮到 0.0265°）
  - `src/app.ts:519` 自己註明：「`SvgMap` 暫時**冇** `flyToLocation` / `flyToZone` 公開方法」
  - `evidence4.json` `sampleOverlapDistinct: 35`
  - 截圖：`09-desktop-zone-clicked.png`（dossier 開咗，但地圖一動不動，選中 zone 淹沒喺圓堆中）
- **影響**：同一個產品內兩種選取行為唔一致；deep link（`?zone=…`）用戶更加完全唔知 zone 喺邊。

### P1-3 手機（390×844）選中 zone 之後面板唔自動展開，dossier 內容喺摺疊 sheet 之外

- **證據**
  - `evidence3.json` `mobileDossierVisibility`：tap zone 後 `sheetSnap = "peek"`、`sheetClass = "pane-story is-collapsed is-peek"`、sheet top=633 h=211，**第一個內容 section top = 1187**（viewport 高 844）
  - `evidence4.json` `mobileExpanded`：即使用「面板」掣開到 `half`，**第一個 section top = 934**，仍然低於 844
  - 截圖：`12-mobile-zone-tapped.png`（tap 完畫面幾乎冇變化，只係頂欄按鈕變「◈ 區域」）、`15-mobile-zone-panel-open.png`（要手動按掣才睇得到內容）
- **影響**：手機 tap zone / location / event 之後**零可見回饋**（`syncSurfaces` 只切換 mount 嘅 `hidden`，冇 `setSheetSnap`）。

### P1-4 `zone-dossiers.json`（48 個富 dossier）**從來冇被前端載入** —— UI 讀嘅係舊 `zones.geojson` inline 欄位

- **證據**
  - `src/data/loadAllData.ts:151-161`：`Promise.all([...])` 載入 9 個檔，**冇** `zone-dossiers.json`
  - `loadDossiers()`（`src/data/adapter/index.ts:197`）**只喺** `tests/data-adapter.test.ts` 被呼叫（`grep -rn "loadDossiers\|getDossier" src/ tests/` 唯一命中 src 就係定義本身）
  - 網絡記錄（`evidence.json` `requests`）：每次入站（包括首屏）都冇 `zone-dossiers.json` 請求
  - `src/components/ZoneDossier.ts:99-119` 讀嘅係 `zone.properties`（`government` / `leadership` / `social_structure` / `economy` / `defense` / `population` / `culture` / `notable_features` / `threats`）
  - 兩份資料係**唔同 schema**：`zone-dossiers.json` 有 `overview` / `governance` / `society` / `infrastructure` / `nest_profile` / `risk_profile` / `key_characters` / `evidence_sources` / `review_status`（例：`zone_14d4957e04` 艾寶琳倖存區嘅 `society.population_structure`、`infrastructure.security` 都有具體小說內容）；`zones.geojson` inline 欄位係另一份較薄嘅抽取
- **影響**：直接命中「係咪換皮」——V2 造咗一份更豐富嘅 dossier 資料檔，但出街嘅面板仍然讀舊資料；同時解釋咗 Q2「空洞」嘅真正成因（**接線問題**，唔係資料問題）。

### P1-5 dossier「資料來源」區直接顯示內部工程欄位；首屏故事面板顯示 raw ML 信心度

- **證據**
  - `src/components/ZoneDossier.ts:163-176`（「◇ 資料來源」區）render `range_evidence` / `coords_evidence` / `sources`
  - 皇室區實際顯示（`evidence.json` `zoneRich.auditList`，截圖 `02`）：
    - 「範圍　**只有 2 個成員點，用按類型嘅預設半徑（估算）**」
    - 「座標　**由 2 個地點分佈推導（精確配對 1 + 同名前綴 1）**」
    - 「抽取來源　**A6**」
  - 首屏故事面板（`src/components/StoryPanel.ts:90`）每行顯示信心度百分比：`['100%','100%','100%','100%','70%']`（`evidence4.json` `firstScreenConfPct`；截圖 `01`）
  - 事件詳情仍顯示原始 id（`src/components/StoryPanel.ts:335` `${p.location_id}`，例 `loc_0014`）；事件 meta 顯示原始 enum（`StoryPanel.ts:326` `${p.event_type}`、`🔒 ${p.spoiler_level}`）
- **影響**：呢啲係審計／ML metadata，對讀者零價值，卻佔用 dossier 版面 —— 令面板「睇落有內容」但實際係雜訊。

### P1-6 11 個倖存區一律標示「倖存區 · 人類聚居 · 安全」，但 9/11 未經核實

- **證據**
  - `src/components/ZoneDossier.ts:23-45` `KIND_META` 硬編：`survivor.sub = "人類聚居 · 安全"`
  - `zones.geojson` 統計：`review_status` = validated 7 / auto_inferred 31 / needs_validation 10；`status` = unknown 43 / active 3 / collapsed 2
  - 11 個倖存區之中只有 3 個 `validated`（寶琳／艾寶琳／康城倖存區）；皇室區 `auto_inferred`、心朗村 `needs_validation` 且 `confidence = 0.4`
  - 心朗村自身 summary 原文：「**文中未交代心朗村是否一個正式的倖存區**」（截圖 `03`）—— 但 UI 仍然用綠色盾牌 +「人類聚居 · 安全」badge
  - `ZoneDossier.ts` **完全冇** render `status` / `review_status` / `spatial_precision` / `coordinate_review_status`（grep 只有 `radius_source` 有做中文映射，`ZoneDossier.ts:133-138`）
- **影響**：`docs/UX_DECISIONS.md` §4 第 7 項明文要求「誠實標示（`unknown` / `approximate` / `fictional` / `needs_review`）」—— zone badge 完全冇落實。

### P1-7 `#map-pane` 只佔 viewport 60.6%，低於 spec §7.2 第 1 項「≥70%」

- **證據**：`evidence.json` `mapAreaRatio = 0.606`（1440×900：map pane 1060×741）；`evidence6.json`：1280→0.579、1440→0.606、1920→0.660、2560→0.701
- 上方 chrome：topbar 65px + 章節條 94px = **159px（17.7% 高度）**；右側面板 380px
- **影響**：只有 2560px 超闊屏才達到 spec 自己嘅門檻。

### P1-8 zone dossier 冇「下一步」引導 —— 唯一可動作係章節 chip

- **證據**：`src/components/ZoneDossier.ts:185-190` —— 全份 dossier 只有 `.zd-ch`（章節 chip）有 listener；`ZoneDossier.ts:107-109` 嘅 `key_characters` chip 係純 `<span>`，唔可點；zone 明明有 `event_ids`（36/48 zone 有值）但面板**冇**「相關事件」區；亦冇「在地圖上定位此區域」
- **影響**：用戶睇完 dossier 之後，除咗跳去某章，冇任何路徑深入（連角色都去唔到）。違反「有引導敘事」。

---

## 2. 三條問題逐條回答（附證據）

### Q1「係咪只係換皮？」→ **架構唔係，產品層係一半換皮**

**唔係換皮嘅實證（要公平記錄）**
- 首屏主 context 真係地圖：`#map-pane` 佔 60.6%，地圖可 pan / zoom / click（截圖 `01`、`10`）
- **章節流程係完整嘅敘事流程**：click pill 5 → 地圖 fly-to 該章 bbox（`viewBox` 0.70°→0.0265°，`evidence3.json`）、章節條摘要更新（「商場（病腦嘅病窩）：…」）、故事面板換成該章摘要 + 事件 + 角色 + 路線（截圖 `14-desktop-chapter5.png`）
- zone 由「唔可點」變可點（`is-selected` class 有上，dossier 開得到）
- 編年史由 1320 eager render 變成 virtualized（DOM 1502、`.chr-entry` 40 條）
- 搜尋 5 類齊全、有分組（截圖 `05`）
- 首屏 **0 個** 工程師式內部詞（jargon 掃描 0 hits）

**係換皮嘅實證**
1. **頂欄 198 個純數字 pill** 仍然係「章節清單式」data dump，只係換咗位置（截圖 `01`）
2. **dossier 面板視覺重做，但內容源頭冇換**：分節 + 圖標 + 折疊係新嘅，但讀嘅仍然係 `zones.geojson` 舊 inline 欄位；V2 新造嘅 `zone-dossiers.json`（更豐富）**從來冇載入**（P1-4）。呢個係最典型嘅換皮
3. **首屏故事面板每行顯示 ML 信心度百分比**（100% / 100% / 100% / 100% / 70%）—— metadata dump（P1-5）
4. **編年史（旗艦功能）實質未可用**（P0-1）—— 換咗皮（`.chronicle` 新 class、新 CSS）但出唔到貨
5. 網路層仍然「先落載全書，再渲染」：首屏即 fetch `chronicle.json`（1.4 MB）+ `events.geojson`（2.1 MB）+ `locations.geojson`（0.9 MB）…（`evidence.json` `requests`）

**判定**：store / URL / LOD / motion 係真嘅架構遷移；但「world-atlas experience」只完成「地圖做主角」一半，敘事引導、內容深度、編年史全部未達標。

### Q2「dossier 係唔係空洞？」→ **29% 明顯空洞；而且空洞係接線問題，唔係資料問題**

**量化（`all-zone-dossiers.json`，全 48 個 zone 實測）**

| 內容分節數（9 個中） | zone 數 |
|---|---|
| 0 | 2（心朗村、靈實禮拜堂） |
| 1 | 2 |
| 2 | 3 |
| 3 | 7 |
| 5 | 3 |
| 6 | 9 |
| 7 | 4 |
| 8 | 11 |
| 9 | 7 |

- **14/48（29%）≤3 個分節**；全文長度中位數 **633 字**、最短 **232 字**、12 個 ≤450 字
- 空洞實例：心朗村（截圖 `03`）—— 只有 header + 一段 summary +「資料來源」+「出現章節」；政權／社會／經濟／人口／風俗**全部冇**

**但「全部空洞」唔成立（要公平記錄）**
- 富嘅 zone 內容係**實質小說內容**：皇室區（9/9 分節、876 字）嘅政權（艾氏皇室）、社會結構（三等公民）、經濟（艾幣、書館、甜品鋪）、人口（「區內人少少」）、風俗（血酒、歐陸花園、交際花司儀）都係具體情節（截圖 `02`）
- **關鍵**：`zone-dossiers.json` 對**同一個**心朗村／靈實禮拜堂都有 `overview` / `risk_profile` / `key_characters` / `evidence_sources`（例：`dossier_0190fb28f4` 有 27 條區內事件、12 個角色、舌女威脅簽名）—— 只係前端冇載入（P1-4）
- 所以：**空洞係「更豐富嘅新資料冇接線」，唔係「冇資料」**

**額外**：「資料來源」區放內部審計欄位（`A6`、`精確配對 1 + 同名前綴 1`、`成員點`）反而係「假充實」—— 令面板睇落有內容，實際係雜訊（P1-5）。

### Q3「地圖係唔係仍然資料 dump？」→ **係，未脫離**

- **世界視圖 zone 層 = 一團圓**：48 個全 render（spec 要求），但 46/48 集中喺 0.03° 內、559/1128 對重疊；cluster badge 只有 10px 低對比、被淹沒（P1-1；`crop-zone-cluster.png`、`crop-cluster-tight.png`）
- **冇層級／冇「由邊度開始」引導**：onboarding 卡只係 4 粒掣 + 統計數字（「48 個區域、704 個地點、1,796 條事件」）—— 係統計 dump，唔係敘事 hook（截圖 `01`）
- **選中 zone 冇 fly-to**（P1-2）→ 揀完唔知揀咗邊
- **頂欄 198 個數字 pill** = 章節 data dump（截圖 `01`）
- **首屏即載全書資料**（chronicle 1.4 MB、events 2.1 MB…）—— 網路層係「先落載全部，再渲染」
- **唯一有敘事感嘅流程係章節切換**（fly-to + 摘要 + 事件 + 角色 + 路線；截圖 `14`）
- 結論：地圖**係**主 context（真），但「world-atlas experience」嘅引導敘事只存在於章節流程；**zone 層面仍然係資料 dump**。

---

## 3. 截圖清單（`artifacts/audit-C8/`）

| 檔名 | 內容 |
|---|---|
| `01-desktop-firstscreen-1440.png` | 桌面首屏 1440×900（onboarding 卡遮住地圖中央） |
| `02-desktop-zone-rich-皇室區.png` | 富 dossier（9/9 分節）—— 內容實質 |
| `03-desktop-zone-thin-心朗村.png` | 空洞 dossier（0/9 分節）—— 只有 summary + audit metadata |
| `04-desktop-chronicle.png` | `?view=chronicle`（有 onboarding 卡）—— 條目被壓成 83px |
| `05-desktop-search.png` | 搜尋 overlay（角色分組） |
| `06-mobile-firstscreen-390.png` | 手機首屏 390×844（onboarding + legend 幾乎遮晒地圖） |
| `07-mobile-zone-dossier.png` | 手機 `?zone=皇室區`（dossier 完全睇唔到） |
| `08-desktop-nobanner.png` | 桌面首屏（已 dismiss onboarding） |
| `09-desktop-zone-clicked.png` | click zone 之後 —— 地圖一動不動 |
| `10-desktop-zoomed.png` | zoom 6 次之後（TKO 街景 + zone 圓） |
| `11-desktop-chronicle-nobanner.png` | 編年史（無 onboarding 卡）—— 83px 條目最清楚 |
| `12-mobile-zone-tapped.png` | 手機 tap zone 之後 —— 零可見回饋 |
| `13-mobile-zone-expanded.png` | 手機拖 sheet（未成功展開） |
| `14-desktop-chapter5.png` | **正面例子**：章節 fly-to + 摘要 + 事件 |
| `15-mobile-zone-panel-open.png` | 手機手動按「面板」→ dossier 可讀（證明問題係「唔自動開」） |
| `16-desktop-1920-chronicle.png` | 1920 寬下編年史 —— 條目**仍然** 83px |
| `crop-zone-cluster.png` | 世界視圖 zone 團（3× 放大） |
| `crop-cluster-tight.png` | cluster badge 特寫（6× 放大）—— badge 幾乎睇唔到 |

原始量測：`evidence.json`、`evidence2.json`、`evidence3.json`、`evidence4.json`、`evidence5.json`、`evidence6.json`、`all-zone-dossiers.json`
腳本：`capture.mjs` ～ `capture6.mjs`

---

## 4. 我試過但**搵唔到**問題嘅角度（誠實記錄）

1. **首屏工程師式內部詞**：對 `document.body` 全 DOM 掃 `location_precision|coordinate_source|radius_source|zone_type|review_status|needs_validation|auto_inferred|kind_votes|schema_version|loc_\d+|zone_[0-9a-f]{6,}|dossier_[0-9a-f]{6,}|event_|A[0-9]` → **0 hits**（`evidence.json` `jargonFirstScreen = []`）。首屏乾淨；`StoryPanel.ts:283` 顯示嘅係 `location_precision` 嘅**值**（例如 `approximate`）而唔係欄位名 —— 但值本身仍屬半技術性（已列 P1-5）。
2. **console error / warning**：7 個 flow（首屏 / zone 富 / zone 薄 / 編年史 / 搜尋 / 手機首屏 / 手機 zone）**全部 0 條**（`evidence.json` `console = []`）。
3. **水平 overflow**：手機 390 下 `documentElement.scrollWidth = 390 = innerWidth`，**冇** overflow。
4. **外部網絡請求**：全部 request 都係 `localhost:5176`，**0 個**外部域 —— 離線要求達標。
5. **搜尋**：5 類（角色／區域／地點／事件／章節）齊、有分組、`Enter`／`↑↓` 可用（截圖 `05`，`evidence.json` `search`）—— 搵唔到問題。
6. **章節流程**：pill → fly-to → 章節摘要 + 事件 + 角色 + 路線，係完整可用嘅敘事流程（截圖 `14`）—— 搵唔到問題。
7. **富 dossier 內容深度**：皇室區（9/9 分節）內容係具體小說情節，唔係 metadata 重複 —— 搵唔到「空洞」問題（空洞只集中喺 29% zone）。
8. **zone 深 zoom 後嘅可讀性**：`?chapter=5` 同 zoom 6 次之後，zone 圓、街道標籤、location marker 都清晰可辨（截圖 `10`、`14`）—— LOD 喺 L-Z1/L-Z2 冇問題；問題只喺 L-Z0（世界視圖）。
9. **a11y / keyboard / reduced-motion / contrast / token**：屬 C7 範圍，我**冇**重複審，避免同 C7 結論打架。
10. **我冇跑 `npm run test`**（按指示），所以**唔會**就 unit / e2e 測試綠唔綠下結論。

---

## 5. 建議（按優先次序）

1. **【P0】編年史唔應該住喺 `.pane-story`（380px）**。二擇一：
   (a) `view=chronicle` 時改 `workspace` grid（地圖收起或縮到側邊），俾 chronicle 真正全寬；
   (b) 將 `chronicle.css:31` 由 `220px minmax(0, 1fr)` 改成單欄（`chr-rail` 變頂部橫向 chips）。
   **最少**要令 `.chr-entry` ≥ 320px。加一條 regression test 斷言 `.chr-entry` 寬度 ≥ 300px（1280/1440/1920）。
2. **【P1-4】接線 `zone-dossiers.json`**：`ZoneDossier.update()` 應該經 `loadDossiers()` 讀 `overview` / `governance` / `society` / `infrastructure` / `nest_profile` / `risk_profile`，保留 `zones.geojson` inline 欄位做 fallback。呢個一次過解決「29% 空洞」同「換皮」兩個指控。
3. **【P1-5】刪走（或摺埋）內部審計欄位**：`抽取來源 A6`、`精確配對 1 + 同名前綴 1`、`成員點`、raw `100%` 信心度、`loc_0014`、raw `event_type` —— 一律唔應該係用戶第一眼見到嘅嘢。
4. **【P1-1】世界視圖（L-Z0）唔應該 render 48 個 full-size zone 圓**：只出 cluster badge，zone 圓／polygon 留到 L-Z1/L-Z2。同時 cluster badge 要加大（≥16px）＋提高對比。
5. **【P1-2】加 `flyToZone(zoneId)`**（同 `flyToChapter` 同一機制），或者最少喺世界視圖下將選中 zone 提到最上層 + 加高對比 highlight ring，並喺 dossier 加「在地圖上顯示」按鈕。
6. **【P1-3】手機選中 zone / location / event 要自動 `setSheetSnap("half")`**；若唔想搶焦點，最少 `peek` 要顯示標題 + 一行「上拉睇詳情」提示。
7. **【P1-6】zone badge 要反映 `review_status`**：未核實嘅唔可以一律寫「人類聚居 · 安全」，應加「未核實 / 資料不足」標籤（spec §4.7 要求）。
8. **【P1-7】縮減上方 chrome**：198 個數字 pill 唔應該獨佔 94px 全寬頻；考慮收成可展開嘅 scrubber，或將 pill 縮窄 + 只顯示有事件嘅章。
9. **【P1-8】dossier 加「相關事件」（`event_ids` 已有）同可點角色 chip**，令用戶有下一步。
10. **【效能／資料】首屏唔應該 eager 載入 `chronicle.json`（1.4 MB）**：已有 `loadTimeline()` lazy 模式可參考，改成 `view=chronicle` 時才載。

---

## 6. 附註（方法透明度）

- 所有截圖喺 `dist/`（build 21:47，晚於所有 `src/`）上拍攝，反映**出街版本**，唔係 dev server。
- 每個 zone dossier 嘅量測係逐個 `goto(?zone=…)` 採樣（48 次），非抽樣。
- 我**冇**修改任何 `src/` / `data/` / `scripts/` / `tests/`；所有產出喺 `docs/audits/` 同 `artifacts/audit-C8/`。
- 我**冇**跑 `npm run test`（避免同其他代理搶資源）；亦**冇**靠印象下結論 —— 每項 P0/P1 都有檔案行號或量測 JSON。
- preview server 已用 `taskkill /PID 50136 /T /F` 清理，`netstat` 確認冇 LISTENING。
- **並行修改注意**：審查期間有其他代理（C4／C5）改動 `data/public/*` 同重建 `dist/`。我已核對：
  - 我所有**靜態**統計係基於 22:07 讀取嘅版本 —— `data/public/zones.geojson` md5 `cb230afd50ba667a68f5c6b2ea0364e1`、`zone-dossiers.json` md5 `1e372ff23fd6d224279a308cc230bb35`（同 `dist/data/public/` 當時完全一致）
  - 我所有**截圖**係基於 bundle `index-BkrIS2kd.js` / `index-CrDXynb7.css`；22:16:56 嘅重建輸出**檔名同大小完全一樣**（content-hash 檔名不變 ⇒ 內容不變），所以截圖仍然有效
  - 22:13 之後 `zone-dossiers.json` 被 C5 改動（101001→100914 bytes），我重新核對過 schema 不變（`overview` 48/48、`governance`／`society`／`infrastructure` 27/48、`nest_profile` 21/48）→ P1-4 結論不受影響

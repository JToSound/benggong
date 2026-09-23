# World Atlas V2 — Product Spec

> **Gate 1 交付物 1／8** · 狀態：**定稿（主代理裁定）**
> 來源：`prompts/world-atlas-v2-rebuild.md` + A1–A10 審計（`docs/audits/`）
> baseline commit：`0260ecb` · branch：`refactor/world-atlas-v2`
> 語言：粵文（程式識別字可用英文）

---

## 0. 一頁摘要

### 0.1 主代理裁定：**breaking refactor**

**決定：採 breaking refactor，唔採 incremental。** 理由（evidence-based，非偏好）：

| # | 證據 | 來源 |
|---|---|---|
| 1 | 現行版本「世界地圖」呢個產品**根本未存在**：48 個 zone 之中，首章只有 1 個符合渲染條件，而該 zone 實測 380/380 像素**完全不可點**（`.zone-area` 被 `main.css:458` 設 `pointer-events: none`） | A1 |
| 2 | 冇單一 state 來源：`App` 4 個欄位 + 6 個 component 私有欄位 + 6 個 DOM class/attribute 各自持有狀態；spec §5.1 八個 URL 參數**實測 7 個零支援** | A3、A9 |
| 3 | 5 套互斥顏色權威疊喺同一個 DOM；`--hud-cyan` 全頁只用於 2 個元素，實際主導係 legacy `--accent-teal`(1214 元素) / `--accent-blue`(1320 元素) | A2 |
| 4 | 3262 行 CSS（41% 於 TS 邏輯），其中 623 行係逐字重複；`timeline.css` 430 行只有 2 行 selector 對得上 live 元素 | A2、A3 |
| 5 | 2581 行 renderer（`SvgMap.ts` 1646 + `VectorBasemap.ts` 935）混齊 layout／projection／LOD／render／interaction／data access，且**雙軌並存** | A3 |
| 6 | 32 MB 死重資產（`map-lod/` 28 MB runtime 零請求）令資產策略同 LOD policy 一齊失效 | A4、A8 |

**incremental 不成立嘅關鍵**：上述 6 項互相依賴（顏色權威 ↔ token ↔ CSS 重複 ↔ component 邊界 ↔ state ↔ URL）。逐項 patch 會產生「新舊兩套架構長期並存」，正是 spec §4.5 明文禁止嘅狀態。

### 0.2 五個不可模糊決定（spec §4.3 要求）

| # | 決定 | 裁定 | 主要依據 |
|---|---|---|---|
| D1 | 預設主題 | **dark-first**。`dark` 永遠係預設，**唔跟系統偏好**；`light` 係用戶主動 opt-in（持久化） | A2（實測 default 走咗 light 羊皮紙，與 §1.1 相反）、A10 |
| D2 | 世界 territory 層可見性 | **48 個 zone 永遠全部 render**。章節只作**強調（emphasis）**，唔作**過濾（filter）** | A1（ch1 只有 1/48）、A4（章節窗口令深 zoom 清空）、A10 |
| D3 | 首屏主 context | **地圖**。編年史改為 `?view=chronicle` 嘅 drawer／secondary view，**唔再係預設右側面板** | A1（首屏可見文字 98.1% 係編年史）、A8（1320 卡 eager render） |
| D4 | 預設 spoiler level | **1**，且**必須**顯示「已隱藏 M 條（spoiler ≥ N）」提示；用戶可調 0–3 並持久化 | A1（949/1796 = 52.8% 事件屬 level ≥2 而預設全量顯示） |
| D5 | URL contract 形式 | **統一用 query string**（`?event=`／`?zone=`／…）。`#` 只用於 in-page anchor。保留 `#ch=<n>`／`#loc=<id>` 作 **legacy alias**（向後兼容，唔可以拆） | A3、A9（現有 `visual-smoke` 測試依賴 `#ch=`） |

### 0.3 北極星驗收（修訂版，取代 spec §0.3）

原 §0.3 第 2 點「最大 zoom 唔起格、唔模糊」**實測已達成**（A4：raster 路徑 0 參與、DPR 正確、viewBox 無拉伸）。已改寫為「最大 zoom 有足夠內容可探索」。

| # | 北極星條款 | 驗收方式 |
|---|---|---|
| N1 | 一眼睇落係「末日情報指揮室」，唔係資料表 + 地圖 | C2 visual rubric；desktop/tablet/mobile 首屏截圖 + 灰度分析 |
| N2 | **最大 zoom 有足夠內容可探索**（唔起格 **且** 唔稀疏） | C3：各 zoom × DPR 1/2 截圖 + `flatRatio` / `meanGrad` / 內容計數斷言 |
| N3 | 每種 layer 有清楚 legend，且**唔可以只靠色**（color + pattern + icon） | C2/C7：灰度 pixel diff（去色後仍可分辨） |
| N4 | 每個 zone 有 dossier；資料不足顯示「資料未足以確認」而非空白／假資料 | C4：schema + UI 狀態斷言 |
| N5 | 座標品質重驗：錯置／無證據候選已 auto-correct、降精度或 quarantine | C4：`spatial-audit.json` 可重跑 |
| N6 | 新讀者 3 秒知道用途；兩次互動內完成「搵角色路線」或「搵事件／地點」 | C1 E2E：Journey A/C/D |
| N7 | mobile 唔係縮細 desktop：bottom sheet、touch-first、safe area、≥44×44px | C7 + A7 17 項檢查 |
| N8 | 預設劇透模式安全、可持久化、清楚顯示可見範圍 | C1 E2E + C7 |

---

## 1. 產品定位與範圍

### 1.1 定位

`interactive tactical atlas + survivor dossier + living chronicle`

一個高質素、具未來感、具電影式沉浸感嘅《病港》世界探索介面。**唔係**將 GeoJSON / JSON 直接塞入網頁嘅 dashboard。

### 1.2 目標用戶與情境

| 用戶 | 情境 | 對應 Journey |
|---|---|---|
| 新讀者 | 聽講呢個網站，想知係咩 | A |
| 追更讀者 | 想睇某章發生咩事、喺邊 | D、E |
| 考據型讀者 | 想追角色足跡、伏筆、時期流向 | C、E |
| 世界觀愛好者 | 想了解各倖存區／病窩嘅政權、民生、風險 | B |

### 1.3 範圍（In scope）

1. App shell、header、context panel、map toolbar、search、detail view、mobile shell 全面重建。
2. 單一 state machine；selection / URL / spoiler / layer / viewport / route 單一管理。
3. Data adapter / selector / index layer；component 唔可以散落直接讀 raw JSON shape。
4. World Territory System：倖存區／病窩／爭議地帶／未知區，可視、可互動、有 legend、有 dossier。
5. Coordinate Integrity Pipeline（可重跑）。
6. Zoom quality / LOD 策略重建。
7. Chronicle virtualization + 篩選 + 深層連結。
8. Mobile bottom sheet + a11y + keyboard 全流程。
9. 視覺系統：單一 dark-first token 語言、多 channel 編碼、語意化 motion。

### 1.4 非目標（Out of scope）

- 唔重新爬取任何網站；唔繞過任何 access control（spec §0.1 規則 3）。
- 唔引入任何 online map / tile / geocoder / font / icon CDN（spec §0.1 規則 4）。
- 唔捏造《病港》世界設定；《病港2》只保留 `bing_gang_2` namespace（AGENTS.md）。
- 唔做「AI 生成空拍圖」等需要外部生成能力嘅 feature（`map-config.json` 嘅 `ai-aerial-concept` 維持 `unavailable`）。
- **唔要求任何人手覆核、人手抽樣、人手目視**（AGENTS.md「零人手參與」）。

---

## 2. Journey 可驗收定義（修訂 spec §3）

> 每個 Journey 附**現況判定**（A1 實測）同 **V2 通過條件**（自動化可驗）。

### Journey A：第一次進入世界

| 項 | 現況（A1 實測） | V2 通過條件 |
|---|---|---|
| 3 秒知道用途 | ⚠️ 首個可見 H2 係「第一季編年史」，唔係世界地圖 | 首屏 H1/H2 明確講《病港》世界地圖；C1 斷言 |
| 4 個入口 | ❌ 只有 2 個存在；「探索地區」文案完全唔存在 | 4 個入口 `探索地區`／`搵角色`／`搵事件`／`打開編年史` 全部存在、可鍵盤達、≥44×44px |
| 初始畫面 | ❌ 只有 2 個紅色 marker，冇 territory | 初始視圖顯示全部 48 個 zone（D2），地圖佔首屏 ≥70% 面積 |
| 安全劇透 | ❌ 52.8% 高階事件全量顯示 | 預設 level 1（D4）+「已隱藏 M 條」提示 |
| 非阻塞 onboarding | ❌ 冇 | 非 modal、可 dismiss、唔阻塞地圖互動 |

### Journey B：探索倖存區／病窩

| 項 | 現況 | V2 通過條件 |
|---|---|---|
| 點選 zone | ❌ 0/380 像素可點 | zone 中心點 click → `selectedZoneId` 非空；E2E 斷言 |
| 地圖聚焦 | ❌ | fly-to polygon + soft-focus 其他區域；viewBox 改變 |
| Dossier panel | ❌ 開唔到 | 右側 panel（desktop）／bottom sheet（mobile）顯示 dossier |
| 內容可理解 | ❌ | 顯示 name / kind / status / danger / 政權／社會／民生（如有）；不足顯示「資料未足以確認」 |
| 相關連結 | ❌ | 可以切去 `相關事件`／`相關角色`／`時間軸`／`返回世界地圖` |
| 返回唔迷失 | ❌ | Esc / 返回按鈕回到 explore context，地圖 viewport 保留 |

### Journey C：角色旅程

| 項 | 現況（A1/A7） | V2 通過條件 |
|---|---|---|
| 兩次互動開 dossier | ❌ 兩次互動只跳章；`char-chip` click 係 `console.log` + TODO | Search → 角色 → dossier；鍵盤可完成 |
| Route 突出 | ❌ | 開啟 route 後只強調相關 route／waypoint／zone 關係 |
| Waypoint list | ❌ | 有 chapter range、zone relation、短 note、精度狀態 |
| 點 waypoint | ❌ | fly-to 正確地點 + URL 更新 |

### Journey D：事件／地點

| 項 | 現況（A1/A9） | V2 通過條件 |
|---|---|---|
| Search 分類 | ⚠️ 只有 3 類（無 zone／chapter）、硬上限 50 | 支援 character / zone / location / event / chapter 五類 |
| 選 event | ⚠️ detail 顯示原始 id `loc_0014` | fly-to + detail 顯示 summary、characters、chapter refs、spoiler、location precision、zone relation |
| Quarantine 處理 | ❌ | 座標 quarantine 嘅 event **唔可以用假點**；顯示「位置未能可靠確認」+ 可用 context |
| 鍵盤 | ❌ ArrowDown/Enter 無效 | ↑↓/Enter/Esc 全通（A9 gap B） |

### Journey E：深入編年史／伏筆

| 項 | 現況（A1/A8） | V2 通過條件 |
|---|---|---|
| 篩選 | ❌ 0 個篩選器 | 按時期、chapter、zone、character、event type、spoiler 篩選 |
| 大量卡片 | ❌ 1320 卡 eager render、DOM 14,036、scrollHeight 160,291 px | virtualization / pagination；DOM ≤4,000 |
| 伏筆 disclosure | ⚠️ 只有 expand/collapse | progressive disclosure；點關係帶去對應 event / chapter / map context |
| 匯出 | ⚠️ | 只輸出 public metadata，**永不**輸出小說全文 |

---

## 3. 成功標準（Gate 定義）

| Gate | 內容 | 通過條件 |
|---|---|---|
| **Gate 1** | A1–A10 audit + 8 份 V2 spec | 本目錄 8 份文件齊全；五個決定已裁定；ownership map 無衝突 |
| **Gate 2** | B1–B9 實作 + 主代理整合 + legacy removal | `npm run lint` / `typecheck` / `test` / `build` 全綠；`pytest` 全綠；`validate_public_data.py` ✅；舊 implementation 已刪，冇兩套架構並存 |
| **Gate 3** | C1–C8 對抗驗收 | `world-atlas-v2-acceptance-matrix.md` 全部 P0/P1 通過；C8 hostile review 無 P0/P1 |

---

## 4. 已知限制與資料缺口（誠實聲明）

| 項 | 現況 | V2 處理 |
|---|---|---|
| 座標精度 | 77.1% 事件掛喺 `approximate`／`fictional` 地點 | 加 `coordinate_precision` 欄位 + UI 顯示；**唔假裝修正** |
| Zone ↔ Event 關聯 | 只有 37.5%（events 冇 `zone_id`） | `infer_zone_membership.py` 三層 join；未證實者標 `needs_validation` |
| Dossier 填充率 | 5 個 zone 六個核心欄位全空 | UI 顯示「資料未足以確認」 |
| `infected_nest` 政權欄位 | 病窩用 `threats`（20/21）代替 | dossier schema 分支：nest 用「威脅特徵／活動模式／影響範圍／關聯事件」 |
| 《病港2》 | 未提供 | 只保留 namespace，**唔捏造** |
| 角色路線 | 42 條（README 曾寫 51） | 以實測為準，README 需修正 |

---

## 5. 與 spec §2.3 問題定義嘅修訂（重要）

原 spec §2.3 假設「最大 zoom 出現 pixelation，base-map 係單張低清 raster 被放大」。**A4 實測推翻**：

- raster 路徑 **0 參與**（`map-lod/` 請求數 = 0、`<image href>` / `<img>` 數 = 0）
- DPR 1 = 1060×752、DPR 2 = 2120×1503（HiDPI **正確**）
- viewBox 等比、無拉伸、資產精度亞像素（`quant: 100000` ≈ 1.1 m）

**真正問題係「內容密度隨 zoom 反向下降」**：max zoom `flatRatio = 0.850` 比初始全港視圖 `0.846` **更平**；細節高峰落喺中段 zoom（0.245°，`flatRatio = 0.662`）。

→ §2.3 已改寫為「地圖放大後內容稀疏、缺少細節（唔係 pixelation）」，詳見 `world-atlas-v2-rendering-lod-strategy.md`。

---

## 6. 交付物清單（Gate 1）

```
docs/specs/
  world-atlas-v2-product-spec.md              ← 本檔
  world-atlas-v2-information-architecture.md
  world-atlas-v2-component-state-contract.md
  world-atlas-v2-visual-motion-system.md
  world-atlas-v2-spatial-data-contract.md
  world-atlas-v2-rendering-lod-strategy.md
  world-atlas-v2-acceptance-matrix.md
  world-atlas-v2-migration-plan.md
```

配套：`docs/audits/`（A1–A10，8992 行）、`artifacts/`（baseline + 各 A 實測，可重跑）。

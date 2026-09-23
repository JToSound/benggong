# Phase 0 / Phase 1 / Gate 1 進度報告 —— World Atlas V2

> 日期：2026-09-20 · branch：`refactor/world-atlas-v2` · baseline commit：`0260ecb`
> 依據：`prompts/world-atlas-v2-rebuild.md`
> 本階段**只做審計與規格**，**冇改任何 production code／data／config**，**冇 commit / push / deploy**。

---

## 1. 本階段做咗咩

| 步驟 | 內容 | 狀態 |
|---|---|---|
| Phase 0-1 | Repo baseline：讀 `AGENTS.md`／docs／package scripts／tests／git status；確認 `data/private/` 未被追蹤 | ✅ |
| Phase 0-2 | 建立 branch `refactor/world-atlas-v2` | ✅ |
| Phase 0-3 | Production build + 起 preview server | ✅ |
| Phase 0-4 | Baseline artifacts：3 個規格 viewport + DPR2 + 2 個 zoom 序列，共 6 run（截圖／network／trace／console／metrics） | ✅ |
| Phase 1 | 平行派遣 A1–A10 只讀審計子代理 | ✅ |
| Gate 1 | 整合並交付 8 份 V2 spec | ✅ |

---

## 2. Baseline 實測摘要（`artifacts/`）

### 2.1 建置

```
tsc --noEmit  PASS
vite build    ✓ 24 modules
  index.js    128.47 kB │ gzip: 41.83 kB
  index.css    45.17 kB │ gzip:  9.35 kB
  hk-basemap.png   1,978.25 kB   ← raster 仍入 bundle（canvas 冇用）
  hk-basemap-labels.png  131.69 kB
```

### 2.2 執行期（6 個 run）

| run | viewport | DPR | requests | **external** | console error | LCP | CLS |
|---|---|---|---|---|---|---|---|
| desktop | 1440×900 | 1 | 19 | **0** | 0 | 484 ms | 0 |
| tablet | 768×1024 | 1 | 19 | **0** | 0 | 484 ms | 0 |
| mobile | 390×844 | 1 | 19 | **0** | 0 | 412 ms | 0 |
| desktop-dpr2 | 1440×900 | 2 | 19 | **0** | 0 | 392 ms | 0 |
| desktop-zoom | 1440×900 | 1 | 36 | **0** | 0 | 408 ms | 0 |
| mobile-zoom | 390×844 | 1 | 36 | **0** | 0 | 420 ms | 0 |

- ✅ **零外部請求** —— 完全離線目標已達成。
- ✅ HiDPI 正確（DPR2 canvas backing = 2120×1503）。
- ⚠️ 預設主題係 **light**（與 spec §1.1 目標方向相反）。
- ⚠️ **48 個 zone polygon 完全冇 render**（首章只有 1 個符合條件，且 0% 可點）。
- ⚠️ Mobile 390 標題逐字換行成 4 行、nav 按鈕直排、legend 遮 18.9%、冇 bottom sheet。
- ⚠️ 最大 zoom（14 次點擊到 0.02° 上限）**冇 pixelation**，但**內容極度稀疏**。

### 2.3 資產死重

`map-lod/` 28 MB + `hk-basemap.png` 1.9 MB + labels 132 KB = **約 30 MB** runtime **零請求**。

---

## 3. A1–A10 審計摘要

| ID | 角色 | 報告 | 行數 | P0 | 一句總結 |
|---|---|---|---|---|---|
| A1 | Product/UX | `ux-product-audit.md` | 798 | 4 | 「世界地圖呢個產品根本未存在」—— zone 0/380 px 可點；spoiler 完全冇實作；首屏 98.1% 文字係編年史 |
| A2 | Visual/Motion | `visual-motion-audit.md` | 1708 | 5 | 5 套互斥顏色權威 + 冇 LOD 尺度策略；`--hud-cyan` 只用於 2 個元素 |
| A3 | Front-end Arch | `frontend-architecture-audit.md` | 789 | 4 | **必須 breaking refactor**；冇單一 state 來源；URL 8 參數零支援 |
| A4 | Map Rendering | `map-rendering-audit.md` | 630 | 3 | **spec §2.3 問題定義係誤判** —— 冇 pixelation；真問題係「內容密度隨 zoom 反向下降」 |
| A5 | Spatial Data | `spatial-integrity-audit.md` | 503 | 3 類 | 103 個地點完全重疊；77.1% 事件座標無證據；4 個 coordinate_* 欄位全層缺失 |
| A6 | Territory/Dossier | `territory-dossier-audit.md` | 542 | 2 | 內容豐富但 schema 落後；zone↔event 只有 37.5%；5 個 zone 六欄全空 |
| A7 | Mobile/A11y | `mobile-a11y-audit.md` | 1192 | 5 | 收合面板仍有 **2,920** 個 Tab stop；頂欄 Tab 350 次到唔到；12 個控制項 focus ring 不可見 |
| A8 | Data/Perf | `data-performance-audit.md` | 646 | 4 | 冷 zoom 阻塞 **21.2 秒**；1320 卡 eager render；可回收 **36.2 MB** |
| A9 | QA Adversary | `qa-gap-analysis.md` | 521 | 4 | **零真 crash**；URL 8 參數 7 個唔支援；推翻一個已知假陽性 |
| A10 | Design Reference | `design-reference-patterns.md` | 1663 | 5 | 12 個本機可實現 pattern；token 表；外部依賴 **0** |

**合計 8,992 行審計、P0 約 39 項、P1 約 70 項。**

### 3.1 兩項審計互相推翻嘅重要發現

1. **A4 推翻 spec §2.3**：原假設「低清 raster 被放大」→ 實測 raster 路徑 0 參與、DPR 正確、無拉伸。真 root cause 係「內容密度隨 zoom 反向下降」（章節窗口過濾 + tile POI 未渲染 + 建築對比過低）。
2. **A7 修正兩個量測高估**：`fail44Count 3131/3131` → 真實 **24**（mobile）；`contrast 3135/8423` → 真實 **12**（dark）。根因：舊 `visible()` 冇檢查中心點喺 viewport、冇檢查遮蓋。
3. **A9 推翻一個假陽性**：`a9-gaps.log` 記 `crash=true` → 實測係 **preview server 未起** 造成嘅空白頁。真實現象係**靜默忽略**（唔 crash 但冇效果）。

---

## 4. Gate 1 交付：8 份 V2 spec

```
docs/specs/
  world-atlas-v2-product-spec.md              198 行
  world-atlas-v2-information-architecture.md  216 行
  world-atlas-v2-component-state-contract.md  243 行
  world-atlas-v2-visual-motion-system.md      235 行
  world-atlas-v2-spatial-data-contract.md     249 行
  world-atlas-v2-rendering-lod-strategy.md    266 行
  world-atlas-v2-acceptance-matrix.md         169 行
  world-atlas-v2-migration-plan.md            271 行
                                   合計       1847 行
```

### 4.1 五個不可模糊決定

| # | 決定 |
|---|---|
| D1 | **dark-first**（唔跟系統偏好；light 係 opt-in） |
| D2 | **48 個 zone 永遠全部 render**；章節只作 emphasis 唔作 filter |
| D3 | **首屏主 context = 地圖**；chronicle 改為 `?view=chronicle` |
| D4 | **預設 spoiler = 1** + 「已隱藏 M 條」提示 |
| D5 | **URL 統一 query string**；`#ch=` / `#loc=` 保留作 legacy alias |

### 4.2 核心裁定

- **BREAKING REFACTOR**（六項互相依賴嘅結構問題）。
- **KEEP 1 / REWRITE 11 / DELETE 4**（模組）+ DELETE 3 個 CSS 檔。
- File ownership map（B1–B9 allowlist + 共享檔案衝突規則）已定稿。
- Implementation dependency graph 已定稿（B2／B4／B1 可並行起步）。

---

## 5. 驗證與證據

| 項 | 結果 |
|---|---|
| `git status`（非 untracked） | **29 項，全部係 Phase L 既有未提交改動** —— 本階段**零 production 改動** |
| `data/private/` 追蹤狀態 | `git ls-files data/private` **為空** ✅ |
| 外部網絡請求（6 run） | **0** ✅ |
| Console error | **0** ✅ |
| 所有審計產出可重跑 | ✅ 每份報告附 `.mjs` / `.py` 腳本 |
| `pytest` | 224 passed（A9 實跑） |
| `vitest` | 77 passed / 1 failed（`phase-i.e2e.test.ts` 路線測試 120 s timeout，根因 = chronicle eager render） |

---

## 6. 環境事故與處置（重要）

### 6.1 `.git` 目錄損毀

**症狀**：`git checkout -b refactor/world-atlas-v2` 之後，`.git/refs/heads/` 同 `.git/logs/` **目錄消失**，HEAD 變成 unborn；`git rev-parse HEAD` 報 `not a git repository`；父 commit `ae2ec7f` 物件遺失。

**根因（已定位）**：環境**唔支援 git 經正常 ref 更新流程建立含 `/` 嘅 branch**（需喺 `.git/refs/heads/` 下建子目錄，該子目錄會被回滾）。同時本地 object store 不完整。

**處置**：
1. `git fetch --refetch origin` 全量重取 objects → 歷史完整復原。
2. 改用**直接檔案寫入**建立 branch：`mkdir -p .git/refs/heads/refactor` + 寫 `refs/heads/main`／`refs/heads/refactor/world-atlas-v2` + 改 `.git/HEAD`。
3. 驗證：`git log` 完整、`git status` 正常（42 項）、branch 持久。

**工作樹零損失**：所有 source／data／docs 檔案完整。

**後續建議**：Phase 2 前先跑一次 `git fetch --refetch origin` 並驗證；避免用 `git checkout -b <含 slash>`。

---

## 7. 已知限制

| # | 限制 |
|---|---|
| 1 | 本階段**只做審計與規格**；所有 P0 仍未修（依設計，Phase 2 才實作）。 |
| 2 | A4 嘅 zoom quality 測試設計（Q1–Q11）**尚未落地成 script** —— 屬 B9 範圍。 |
| 3 | A5 無法喺只讀 public 嘅前提下完成 D1（Spatial Evidence Extractor，需 private evidence）—— 已明確認定留 B4。 |
| 4 | `zones.geojson.evidence` 100% 含小說原文片段 → **版權紅線**，必須喺 B4 移除（本階段只記錄，未改資料）。 |
| 5 | Zone ↔ Event 關聯覆蓋率 37.5% → 目標 ≥85%，未達標部分須標 `needs_validation`。 |
| 6 | A10 嘅 pattern 效能描述屬**機制分析（定性）**，未做 profiling。 |

---

## 8. 下一步（Phase 2）

> 依 `world-atlas-v2-migration-plan.md` §4.2：**B2（State/URL）、B4（Data Pipeline）、B1（Tokens/Motion）無互相依賴，可第一時間並行。**

1. 先跑 `git fetch --refetch origin` 並驗證 repo 完整。
2. 派 B1／B2／B4（並行，各先交 interface contract）。
3. 依 dependency graph 派 B5 → B6 → B7／B8。
4. 最後 B9 接 QA harness。
5. 主代理按 Gate 2 順序整合 + legacy removal。
6. 派 C1–C8 對抗驗收。

**注意（唔可以違反）**：
- 每個 B agent 只可改 allowlist 範圍，唔可以 mass format。
- 所有驗收必須**程式化、可重跑**；**唔可以**寫「人手覆核」「人手抽樣」。
- 現有 tests 同新 spec 衝突時，更新 tests 去驗證新 spec，唔好屈就舊 UI。

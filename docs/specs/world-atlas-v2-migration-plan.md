# World Atlas V2 — Migration Plan

> **Gate 1 交付物 8／8** · 狀態：**定稿**
> 依據：spec §4.3（Gate 1 決定）、§4.4（B1–B9）、§4.5（Gate 2 整合）、§6.3（anti-stagnation）
> 本檔包含：**breaking 決定**、**keep/rewrite/delete 表**、**file ownership map**、**dependency graph**、**風險登記**。

---

## 1. 不可模糊決定

### 1.1 breaking refactor 或 incremental

> ## 決定：**BREAKING REFACTOR**

**唔採 incremental。** 六項證據（詳見 `world-atlas-v2-product-spec.md` §0.1）：

1. 世界地圖產品未存在（zone 0/380 px 可點）
2. 冇單一 state 來源；URL 8 參數中 7 個零支援
3. 5 套互斥顏色權威
4. 3262 行 CSS（41% 於 TS），623 行重複
5. 2581 行 renderer 混齊六件事 + 雙軌並存
6. 32 MB 死重資產令 LOD policy 失效

**incremental 不成立嘅關鍵**：六項互相依賴。逐項 patch 會產生「新舊兩套架構長期並存」，正是 spec §4.5 明文禁止。

### 1.2 其他決定（spec §4.3 要求）

| 項 | 決定 |
|---|---|
| State ownership | 單一 `src/state/store.ts`；DOM 只可作衍生輸出 |
| URL serialization | 統一 query string；`#ch=` / `#loc=` 保留作 legacy alias |
| Data adapter 邊界 | `src/data/adapter/`；component 唔可以直接 import raw geojson |
| Vector / high-res texture / LOD | **純向量**；刪 raster LOD 28 MB；tile_deg 0.05→0.02；MAX_SCALE 35→64 |
| Zone schema migration | v1 → v2（versioned，idempotent）；`kind` → `zone_type` 映射 |
| Dossier schema | **抽出獨立 `zone-dossiers.json`**（方案 B） |
| Coordinate validation migration | 加 4 個 `coordinate_*` 欄位 + deterministic backfill |
| Motion system | 3 duration + 2 easing + 7 用途白名單；CSS + JS 雙層 reduced-motion |
| 預設主題 | **dark-first**（唔跟系統偏好） |
| Territory 可見性 | 48 個 zone **永遠全部 render**；章節只作 emphasis |
| 首屏主 context | **地圖**；chronicle 改為 `?view=chronicle` |
| 預設 spoiler | **1** + 「已隱藏 M 條」提示 |

---

## 2. Keep / Rewrite / Delete（逐個 production module）

| # | 現有檔案 | 行數 | 決定 | 去向 / 原因 |
|---|---|---|---|---|
| 1 | `src/app.ts` | 441 | **DELETE** | → `AppShell` + `src/state/store.ts`。冇單一 state 來源，重寫成本低於修補 |
| 2 | `src/router.ts` | 42 | **DELETE** | → `src/state/url.ts`。只支援 2 個非 spec 參數 |
| 3 | `src/components/SvgMap.ts` | 1646 | **DELETE** | → `src/map/*`（12 模組）。混齊六件事，無法局部修 |
| 4 | `src/map/VectorBasemap.ts` | 935 | **REWRITE** | 拆出 `BaseGeometryLayer`；**保留** Canvas `Path2D` 快取 + `setTransform` 策略 |
| 5 | `src/components/ChronicleView.ts` | 433 | **REWRITE** | 加 virtualization + 6 篩選維度 + deep link |
| 6 | `src/components/StoryPanel.ts` | 286 | **REWRITE** | 拆為 `EventDetail` / `CharacterDossier` / `RoutePanel`；`char-chip` 係 TODO 空殼 |
| 7 | `src/components/ZoneDossier.ts` | 192 | **REWRITE** | 對齊 dossier schema v2 + 「資料未足以確認」狀態 |
| 8 | `src/components/SearchBox.ts` | 165 | **REWRITE** | 5 類 + 鍵盤 + 移除硬上限 50 |
| 9 | `src/components/ChapterStrip.ts` | 88 | **REWRITE** | 移除 `scrollIntoView`（A7 P0-2）；virtualize |
| 10 | `src/components/AboutModal.ts` | 93 | **REWRITE** | 加 `role=dialog` / `aria-modal` / focus trap / restore |
| 11 | `src/theme.ts` | 89 | **REWRITE** | dark-first + token mirror；保留 `basemap-theme-change` |
| 12 | `src/exportMap.ts` | 148 | **KEEP** | 唯一可保留；加 public-only 斷言 |
| 13 | `src/main.ts` | 95 | **REWRITE** | 移除重複 import；改為 bootstrap store |
| 14 | `src/data/loadAllData.ts` | — | **REWRITE** | 加索引；移除 `timeline.json` eager load |
| 15 | `src/data/fallbackAnchors.ts` | — | **MOVE** | → `src/data/adapter/` |
| 16 | `src/types/dataset.ts` | — | **REWRITE** | 加 coordinate_* / zone v2 / dossier 型別 |
| 17 | `src/styles/main.css` | 2047 | **DELETE** | → `tokens.css` + 分層 CSS |
| 18 | `src/styles/hud.css` | 785 | **DELETE** | 含 106 行重複 light block |
| 19 | `src/styles/timeline.css` | 430 | **DELETE** | 只有 2 行 selector 對得上 live 元素 |

**統計：KEEP 1 / REWRITE 11 / DELETE 4（模組）＋ DELETE 3（CSS 檔）**

---

## 3. File Ownership Map（禁止多代理同時改同一 production file）

### 3.1 B1–B9 可寫範圍

| ID | 子代理 | 可寫範圍（allowlist） | 交付 |
|---|---|---|---|
| **B1** | Design System & Motion | `src/styles/tokens.css`（新）、`src/styles/base.css`（新）、`src/theme.ts`、`src/theme-tokens.ts`（新）、`src/motion.ts`（新）、`src/ui/icons.ts`（新）、`tests/theme-token-parity.test.ts` | tokens、motion primitives、responsive shell、SVG sprite |
| **B2** | App State & Router | `src/state/**`（新）、`src/app.ts`（→ AppShell）、`src/router.ts`（刪）、`src/main.ts`、`src/types/**` | state machine、URL contract、tests |
| **B3** | Data Adapter | `src/data/**`、`vite.config.ts`（gzip / `emptyOutDir` / `manualChunks`） | normalized adapter、search index、tests |
| **B4** | Territory Data Pipeline | `scripts/**`、`data/schemas/**`、`data/public/zones.geojson`、`data/public/zone-dossiers.json`（新）、`tests/test_spatial_integrity.py`（新） | zone/dossier/coordinate pipeline |
| **B5** | Vector Map & LOD Renderer | `src/map/MapShell.ts`、`MapViewport.ts`、`BaseGeometryLayer.ts`、`map-lod.ts`、`map-camera.ts`（新）、`src/map/VectorBasemap.ts` | crisp vector / LOD / HiDPI |
| **B6** | Map Interaction | `src/map/ZoneLayer.ts`、`EventLayer.ts`、`RouteLayer.ts`、`MarkerLayer.ts`、`LabelLayer.ts`、`MapControls.ts`、`map-interactions.ts`（新）、`src/components/ZoneDossier.ts`、`StoryPanel` 系列 | layer toggle、zone interaction、marker/route detail |
| **B7** | Chronicle Experience | `src/components/ChronicleView.ts`、`src/styles/chronicle.css`（新） | virtualized chronicle、zone/route deep link |
| **B8** | Mobile + A11y | `src/components/BottomSheet.ts`（新）、`src/components/SearchOverlay.ts`（新）、`src/components/OnboardingCard.ts`（新）、`src/components/AboutModal.ts`、`src/components/ChapterStrip.ts`、`src/styles/mobile.css`（新）、`tests/*a11y*` | bottom sheet、focus、keyboard、reduced motion |
| **B9** | Visual QA Automation | `tests/*.e2e.test.ts`、`tests/qa/**`（新）、`scripts/verify_zoom_quality.py`（新）、`scripts/diagnose_map_resolution.py`（新） | screenshot/OCR/zoom/pixelation checks |

### 3.2 共享檔案衝突規則

| 檔案 | Owner | 其他代理 |
|---|---|---|
| `src/styles/tokens.css` | **B1 專屬** | 只可**讀** token，唔可以改定義 |
| `src/theme-tokens.ts` | **B1 專屬** | 只讀 |
| `src/state/store.ts` | **B2 專屬** | 只可經 action 呼叫 |
| `src/state/url.ts` | **B2 專屬** | 只讀 |
| `src/types/dataset.ts` | **B2** | 其他代理要加型別 → **開 PR 畀 B2**，唔可以自己改 |
| `src/data/adapter/index.ts` | **B3 專屬** | 只可經 `adapter` 呼叫 |
| `vite.config.ts` | **B3 專屬** | — |
| `data/public/zones.geojson` | **B4 專屬** | 前端只讀 |
| `src/map/map-lod.ts` | **B5 專屬** | B6 只讀 Z 定義 |
| `src/components/ZoneDossier.ts` | **B6 專屬** | — |
| `src/components/ChronicleView.ts` | **B7 專屬** | — |
| `package.json` | **主代理** | 任何代理要加依賴 → 必須經主代理批准（**預設禁止加新依賴**） |
| `tests/visual-smoke.e2e.test.ts` | **主代理** | 唔可以拆 `#ch=150` 測試 |
| `AGENTS.md` / `docs/specs/**` | **主代理** | 只讀 |

> **規則 O1**：任何代理唔可以改 allowlist 以外嘅檔案。
> **規則 O2**：唔可以 mass format（唔可以跑 repo-wide prettier / eslint --fix）。
> **規則 O3**：唔可以修改同一份 shared interface 而無主代理批准。
> **規則 O4**：產出 `docs/progress/<agent>-delivery.md`（modified files、contract、tests、screenshots、known limitation）。

---

## 4. Implementation Dependency Graph

```
                    ┌──────────────────────────────────────┐
                    │  主代理：Gate 1 specs（已完成）        │
                    └──────────────────────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌───────────────┐          ┌──────────────────┐         ┌─────────────────┐
│ B2 State/URL  │          │ B4 Data Pipeline │         │ B1 Tokens/Motion│
│  （無依賴）    │          │  （無依賴）       │         │  （無依賴）      │
└───────┬───────┘          └────────┬─────────┘         └────────┬────────┘
        │                           │                            │
        │  state contract           │  zone_type / dossier_id     │  token names
        │                           │  / danger_level / coord_*   │
        ▼                           ▼                            ▼
┌───────────────┐          ┌──────────────────┐         ┌─────────────────┐
│ B3 Data       │◄─────────│  B4 outputs      │         │ B5 Renderer/LOD │
│ Adapter       │  indexes │                  │         │                 │
└───────┬───────┘          └──────────────────┘         └────────┬────────┘
        │                                                          │
        │  selectors                                               │  LOD / Z 定義
        ▼                                                          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          B6 Map Interaction                               │
│  （依賴 B2 state + B3 selectors + B4 zone_type/display_style + B5 LOD）    │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐      ┌─────────────────┐    ┌─────────────────┐
│ B7 Chronicle  │      │ B8 Mobile/A11y  │    │ B9 Visual QA    │
│（依賴 B2/B3） │      │（依賴 B1/B2/B6）│    │（依賴全部，最後）│
└───────────────┘      └─────────────────┘    └─────────────────┘
```

### 4.1 關鍵依賴（硬性）

| 依賴 | 為何 |
|---|---|
| **B4 → B6** | zone layer 需要 `zone_type` + `display_style` + `danger_level` 先做到 legend 同 hover/click（A6 integration note 第 4 點） |
| **B4 → B3** | dossier lazy-load 需要 `dossier_id` ↔ `zone_id` 索引（A6 第 5 點） |
| **B2 → 全部** | URL contract 係所有 module 嘅基礎（A3：「B2 嘅第一優先」） |
| **B1 → B5** | Canvas palette 由 token 讀取；`theme-tokens.ts` parity test |
| **B5 → B6** | B6 需要 `map-lod.ts` 嘅 Z 定義 |
| **B9 → 全部** | QA harness 最後接 |

### 4.2 可並行開始嘅三個（無依賴）

**B2（State/URL）、B4（Data Pipeline）、B1（Tokens/Motion）** —— 三者無互相依賴，可第一時間並行。

---

## 5. Gate 2 整合順序（spec §4.5）

| 次序 | 步驟 | 說明 |
|---|---|---|
| 1 | **B2** state/router | 所有模組基礎 |
| 2 | **B3** data adapters | indexes + selectors |
| 3 | **B4** data schema/pipeline outputs | zone v2 + dossier + coordinate_* |
| 4 | **B1** design/motion primitives | tokens + motion |
| 5 | **B5** renderer/LOD | map 模組 |
| 6 | **B6** map interaction | layer + zone interaction |
| 7 | **B7** chronicle | virtualization + filter |
| 8 | **B8** mobile/a11y | bottom sheet + focus |
| 9 | **B9** QA harness | 全部檢查 |
| 10 | **Legacy removal** | 見 §6 |

> **規則 I1**：如 output 有 conflict，以 V2 spec 為 authority；**不得為方便 merge 而保留舊 interaction model**。

---

## 6. Legacy Cleanup 清單（Gate 2 第 10 步）

### 6.1 必須刪除

| 類別 | 項目 |
|---|---|
| Component | `src/app.ts`、`src/router.ts`、`src/components/SvgMap.ts` |
| CSS | `src/styles/main.css`（2047）、`src/styles/hud.css`（785）、`src/styles/timeline.css`（430） |
| 重複 CSS | `main.css:1496-2047` 同 `hud.css` 逐字重複；`hud.css` 內部 light 段重複兩次；`main.css` 106 行重複 light block |
| 死 CSS | 43 個搵唔到 TS 引用嘅 class（21%） |
| 資產 | `public/assets/map-lod/`（28 MB）、`hk-basemap.png`、`hk-basemap-labels.png`、`hk-basemap-coords.json`、空目錄 ×4 |
| 死 keyframes | 11 個之中 8 個未運行 |
| 死 token | `--color-*` 12 個從未定義 |
| 死 config | `map-config.json` 11/12 未被引用嘅區塊（改由 B4 產生） |
| 死 script | `scripts/build_map_lods.py`、`render_binggang_map.py`、`render_hk_basemap.py`（raster 路徑）、`derive_zones.py`（deprecated） |
| 死 state | `App` 4 個 selection 欄位、`viewMode` private、DOM 內嘅 6 個 state class/attribute |
| 死 listener | 50 個 `addEventListener` vs 1 個 `removeEventListener` |

### 6.2 必須保留（唔可以誤刪）

| 項 | 原因 |
|---|---|
| `src/exportMap.ts` | 唯一可保留模組 |
| `theme.ts` 嘅 `basemap-theme-change` 事件 | Canvas 唔會讀 CSS 變數 |
| `VectorBasemap` 嘅 Canvas `Path2D` 快取 + `setTransform` | 效能關鍵 |
| `fallbackToRaster()` | Emergency fallback（唔設預設 href） |
| `#ch=` / `#loc=` legacy alias | `tests/visual-smoke.e2e.test.ts` 依賴 |
| `artifacts/audit-A1/*.mjs` | Baseline 對照腳本 |
| `artifacts/audit-A9/a9-gaps.log` | 假陽性對照 |
| `tests/` 全部現有測試 | 改為驗證新 spec，**唔可以**因為衝突而刪 |

### 6.3 必須修正嘅零人手違規（AGENTS.md 紅線）

| # | 位置 | 處置 |
|---|---|---|
| 1 | `data/public/map-config.json` `provisional_mode.banner` | 移除「人工審閱」字眼，改為「自動驗證」 |
| 2 | `data/public/characters.json` `description` | 同上 |
| 3 | `scripts/apply_location_corrections.py` | 改為全程式化流程 |
| 4 | `data/public/zones.geojson` `evidence`（100% 含原文） | **版權紅線** → 移除或改為結構化引用 |

---

## 7. 風險登記（Risk Register）

| # | 風險 | 可能性 | 影響 | 緩解 |
|---|---|---|---|---|
| R1 | **git object store 不穩** —— 實測 `.git/refs/heads` 曾被刪、父 commit 遺失，需 `git fetch --refetch` 復原 | 高（環境問題） | 高 | ① 唔用 `git checkout -b <含 slash>`；直接寫 `.git/refs/heads/**` + `.git/HEAD` ② 定期 `git fetch --refetch origin` ③ 每次 git 操作後立即驗證 `git log` / `git status` ④ **Phase 2 前先做一次完整 fetch 驗證** |
| R2 | **B4 需讀 private evidence（D1）** | 中 | 中 | D1 輸出**必須**過 `evidence-candidate.schema.json` + deterministic 合併；**唔可以**靠對話文字改 production GeoJSON |
| R3 | **Zone ↔ Event 覆蓋率只能到 37.5% → 85%** | 中 | 中 | 三層 join；未達標部分標 `needs_validation`，**唔亂填** |
| R4 | **5 個 zone 六欄全空** | 高（已知） | 低 | UI 顯示「資料未足以確認」；**唔可以**補寫 fiction |
| R5 | **刪 raster 資產會令 build 爆** | 高（已知） | 中 | **必須同 PR** 先移除 `SvgMap.ts` 靜態 import |
| R6 | **`emptyOutDir: false` 改 `true` 可能觸發 rm shim fail** | 中 | 中 | 用 `npm run clean` 前置；如仍失敗，記錄 block reason |
| R7 | **B5/B6 交接：`render()` 全量重建 SVG layer** | 高 | 高 | 明文要求 per-layer incremental update；B9 加 frame rate 斷言 |
| R8 | **Chronicle virtualization 同 a11y（`inert`/`aria-hidden`）必須一齊修** | 中 | 高 | B7 + B8 聯合驗收；否則收合面板仍可 Tab |
| R9 | **`timeline.json` 移除可能影響未知用途** | 低 | 低 | 先 `grep` 確認 0 引用（已確認），再移除 |
| R10 | **`zone_type` 映射語意弱**（`outpost` → `contested`） | 中 | 中 | `kind_votes` 分歧嘅 5 個標 `needs_validation` |
| R11 | **Dark-first 決定影響所有視覺 baseline** | 高（已決定） | 中 | 所有 baseline 截圖需重拍；C2/C3 對照組要標明主題 |
| R12 | **AI 生成空拍圖 feature** | 低 | 低 | 維持 `unavailable`（產品不支援相關能力） |
| R13 | **`pytest` 現有 224 測試 vs 新 schema** | 中 | 中 | 加 `schema_version`；舊測試改為驗證新 spec（**唔可以**屈就舊 UI） |
| R14 | **`vitest` 1 個 e2e fail（120 s timeout）** | 高（已知） | 低 | 根因係 chronicle eager render；B7 修好後應轉綠 |

---

## 8. Phase 2 執行前檢查清單

- [ ] `git fetch --refetch origin` 並驗證 `git log` 完整
- [ ] 確認 branch `refactor/world-atlas-v2` 存在且 HEAD = `0260ecb`
- [ ] 確認 `data/private/` 未被追蹤（`git ls-files data/private` 為空）
- [ ] 確認 42 項未提交改動仍在（Phase L 工作）
- [ ] preview server 可起（`npx vite preview`，**必須用 `localhost`**）
- [ ] 每個 B agent 先交 interface contract，再寫 code
- [ ] 每個 B agent 只改 allowlist 範圍
- [ ] Gate 1 八份 spec 已定稿

---

## 9. Anti-stagnation 指令（每個 implementation task 必須包含）

1. 「呢個係 **replacement task**；舊 component **唔係**優先真相。」
2. 「如舊 architecture 阻礙 spec，**replace architecture**；唔好 patch around it。」
3. 「**不可**只做 CSS／style diff；必須改變 information hierarchy、user flow、state contract、render strategy 或 data integrity。」
4. 「完成證據係 E2E、visual screenshot、keyboard flow、refresh persistence、zoom/DPR report，**唔係** code line count。」
5. 「existing tests 同新規格衝突時，**更新 tests 去驗證新 spec**；唔好屈就舊 UI。」
6. 「**唔可以**建議人手覆核／人手抽樣；所有驗收必須程式化、可重跑。」

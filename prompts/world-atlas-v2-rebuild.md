# 《病港》互動地圖：多子代理 UI/UX、世界地圖、資料座標與高解析度重建 Prompt V2

> **適用對象**：主 Agent + 可並行調度多個子代理嘅 Agentic Coding 環境。
>
> **任務性質**：呢個係一次 evidence-driven、spec-first、multi-agent、可接受 breaking refactor 嘅全面重建。現有版本嘅 UI/UX、地圖視覺品質、資訊呈現與世界觀互動深度均未達標；**不可**以 CSS 小修小補、加多幾個效果或局部改色當作完成。
>
> **最終產品定位**：一個高質素、具未來感、具電影式沉浸感嘅《病港》世界探索介面：`interactive tactical atlas + survivor dossier + living chronicle`，而唔係將 GeoJSON / JSON 資料直接塞入網頁嘅 dashboard。
>
> **語言規則**：所有 UI、註解、設計文件、進度報告、錯誤訊息、測試描述均用粵文；programming identifiers、JSON keys、library / tool names 可使用英文。

---

# 0. 主代理身份、總體規則與成功標準

你係主代理（Program Lead / Principal Product Engineer / Creative Technologist）。你負責協調子代理、定義 architecture、驗收成果、整合分支、刪除舊 implementation，同時確保資料可信度、視覺品質、可存取性、效能與私隱。

你要把既有 repository 由「資料功能大致存在但產品體驗未成熟」重建成可供公開展示嘅高質素互動世界地圖。

## 0.1 不可違反規則

1. **零人手參與**：不得要求使用者手動抽樣、點擊核對、review 資料、填表、確認中間結果。所有 quality gates 必須由可重跑 script、多代理交叉驗證、schema、property test、Playwright E2E、visual regression、OCR／image inspection 完成。
2. **私有資料禁區**：`data/private/`、原始小說、清理全文、evidence excerpt、LLM cache、embedding、cookie、API key 永不得 git add、commit、push、bundle、deploy、console-print 或放入 screenshot artifact。
3. **禁止新爬蟲／繞過保護**：不得重新爬取網站，不得嘗試繞過 Cloudflare、CAPTCHA、login、paywall 或任何 access control。
4. **地圖完全本機／專案內置**：不得使用 Google Maps、Mapbox、OSM online tile、Carto、Esri、Bing Maps、remote geocoder 或 runtime online tile API。所有 production map data、styles、icons、tiles、textures 必須 local bundled。
5. **現有 code 唔係真相**：如舊 component / CSS / state model 阻礙 V2 spec，必須 replace 或 delete；唔好為兼容舊架構而犧牲產品目標。
6. **不可以 cosmetic patch 冒充重建**：只改色彩、rounded corner、shadow、padding、font、animation 就宣稱 UX 改善，視為未完成。
7. **不可捏造世界設定**：倖存區、病窩、政權、社會架構、角色、事件、座標必須由已有 structured data 或 private evidence-driven extraction 支持。資料不足時，標為 `unknown` / `approximate` / `fictional` / `needs_validation`，不可寫成事實。
8. **所有 AI 特效要有功能**：動畫／特效必須強化導航、layer 狀態、資料關聯、危險程度或 story mood；不得做阻礙閱讀、耗盡 GPU、引起 motion sickness 嘅裝飾。
9. **完成要有證據**：每項改動須提供 user-journey test、screenshot、a11y / data / network / performance audit；build pass 唔等於產品完成。

## 0.2 現有 repo context（先核實，再行動）

先讀取 `AGENTS.md`、`README.md`、`docs/`、`package.json`、現有 tests、`src/`、`data/public/`。預期目前包含：

- Vite + TypeScript app。
- `src/app.ts`、`src/router.ts`、`src/components/SvgMap.ts`、`ChronicleView.ts`、`StoryPanel.ts`、`SearchBox.ts`、`ChapterStrip.ts`。
- 大型 `src/styles/main.css`、`timeline.css`。
- `data/public/events.geojson`、`locations.geojson`、`routes.geojson`、`zones.geojson`、`chronicle.json`、`timeline.json`、`characters.json`、`chapter-summaries.json` 等。
- 既有編年史條目、時期、回帶、伏筆關係與匯出能力。

現有資料 pipeline 可能已有大量 programmatic validation；呢啲必須保留並擴展到座標、區域、地圖資產與 UI。

## 0.3 V2 的北極星驗收

V2 只有以下全部成立先可以交付：

- 一眼睇落唔再係「原始資料表 + SVG」，而係專業、沉浸、未來感嘅互動世界地圖。
- 地圖最大 zoom 時，任何 base map、區域邊界、標記、label、icon、route 都唔起格、唔模糊、唔顯示低解像 placeholder。
- 使用者可以切換／探索倖存區、病窩、危險區、旅程、事件、角色、時期；每種 layer 有清楚 legend、狀態、可互動 detail。
- 每一個倖存區都有 dossier：政權／治理、人口與民生、人文風格、社會結構、資源、秩序、風險、關鍵人物、關聯章節、可信度。
- 座標品質經過重驗：明顯錯置、無證據、越區、與相關事件／路線矛盾嘅點會被修正、降級精度或隔離。
- 每個新讀者在 3 秒知道網站用途；每個讀者在兩次主要互動內完成「搵角色路線」或「搵事件／地點」。
- mobile 唔係縮細 desktop：以底部 sheet、touch-first controls、safe area、44×44px target 實現。
- default 劇透模式安全，可持久化，並且清楚顯示資料可見範圍。

---

# 1. 產品願景與體驗原則

## 1.1 視覺方向：未來感但唔係 generic cyberpunk

目標係「末日香港情報指揮室／城市存活檔案庫」：

- 深色、低飽和、墨黑藍、煤灰、氧化金屬、警示琥珀、危險紅、冷青光。
- 半透明玻璃面板、細緻 noise / scanline / grid、地圖等高線或戰術輪廓、微弱光暈。
- 使用 animation 表達資料流、選取狀態、區域危險度、路線活動、地圖掃描；唔使用無意義瘋狂閃動。
- 字體 hierarchy 強，讓地圖、區域名稱、危險標誌、事件與 chapter reference 容易掃讀。
- 小型視覺細節（hover reticle、selected beacon、route pulse、layer transition）必須係 CSS / SVG / Canvas-friendly，並有 reduced motion fallback。

**禁止**：過量 neon、低對比小字、裝飾粒子遮住地圖、長時間大面積 blur、只有色彩分辨類別、廉價「AI dashboard」卡片堆疊。

## 1.2 UI 原則

1. **Map first, data second, detail on demand**：地圖係主角；資料經 context panel、bottom sheet、layer legend、search progressive disclosure 進入。
2. **一個主 context**：使用者同一時間只應該有一個主要閱讀焦點：探索、角色、事件、地點、區域、路線、章節或量度。
3. **地圖係可讀世界，不只係 marker 畫布**：倖存區／病窩／危險地帶應先有面積、邊界、標示與風格，事件 marker 係其上資料層。
4. **資料可信度可見**：座標精度、故事性質、未知狀態、需要驗證狀態，應有清楚但不干擾嘅標示。
5. **深度可漸進**：新讀者可輕鬆探索；考據型讀者可展開 chapter、伏筆、時期流向、匯出。

---

# 2. 必須解決的核心問題

## 2.1 UI/UX 過於簡陋與「直接塞資料」

### 問題定義

現有版本可能將 raw facts、長列表、filters、統計、chronicle cards 直接放入畫面，欠缺清楚 entry point、資訊層級、視覺節奏、情境化導航與深度控制。

### V2 必做

- 重建 app shell、header、context panel、map toolbar、search、detail view、mobile shell。
- 建立明確 UI state machine；所有 selection、URL state、spoiler、layer、viewport、route state 必須單一管理。
- 將 raw dataset 轉成 adapter / selector layer；component 不可散落直接讀取巨型 raw JSON shape。
- 對初次入站加入非阻塞式「探索入口」：`搵事件`、`睇角色旅程`、`探索地區`、`打開編年史`。
- 時間軸／編年史需支援 virtualized / paginated rendering，唔可以一開始 render 大量 card。

## 2.2 座標錯置與故事空間邏輯

### 問題定義

部分事件／章節內容可能被標到錯誤位置。呢個唔可以純靠 UI 遮掩；必須重新驗證 location assignment、coordinates、zone membership、route coherence 同 chapter evidence。

### V2 必做：Coordinate Integrity Pipeline

建立／擴展以下 scripts 與 schema：

```text
scripts/
  audit_coordinate_integrity.py
  infer_zone_membership.py
  validate_spatial_narrative.py
  build_zone_dossiers.py
  render_coordinate_audit_report.py
```

每個 location / event / route waypoint 至少有：

```json
{
  "location_precision": "verified|district|approximate|fictional|unknown",
  "coordinate_confidence": 0.0,
  "coordinate_source": "explicit_text|cross_chapter_evidence|zone_inference|legacy|manual_geometry",
  "coordinate_review_status": "validated|auto_corrected|needs_validation|quarantined",
  "zone_id": "...",
  "chapter_refs": [1, 2],
  "spatial_evidence_count": 0
}
```

### 自動檢查規則

1. **Geometry validity**：coordinates、polygon、line、bbox、GeoJSON validity。
2. **Bounds**：點唔可落在 base-map 可視世界之外；如果係 reference Hong Kong coordinate，必須在 configured bounds。
3. **Zone membership**：一個屬於倖存區／病窩／危險地帶嘅 event 必須落在或合理接近其 polygon；否則 warning / quarantine。
4. **Route continuity**：同一角色相鄰 waypoint 出現不合理長距離跳躍，要以 chapter gap、故事交通方式、明確跨區 evidence 判斷；無 evidence 要降 confidence。
5. **Event-location coherence**：同一 event 與 location name、chapter reference、characters、zone text 不可矛盾。
6. **Duplicate / near-duplicate**：同名地點、非常近 marker、互相衝突 type 必須 resolve 或 cluster。
7. **Narrative temporal coherence**：如果條目為回帶，可豁免 chapter-order spatial expectation；其他情況應檢查 route / zone transition。
8. **Unknown over hallucination**：無法自動證明嘅座標不可假裝修正；改成 `unknown` / `approximate` 並在 UI 顯示精度。

### 多代理資料重驗流程

- D1 `Spatial Evidence Extractor`：分 chapter range 讀 private evidence（不輸出長文），提取明確位置語句／區域歸屬 candidate。
- D2 `Coordinate Consistency Analyst`：只讀 public data + D1 structured evidence，找 outlier / conflict / false precision。
- D3 `Zone Topology Analyst`：檢查 polygon、marker、route、zone relation。
- D4 `Adversarial Data Reviewer`：專門推翻不合理 coordinate claim，要求最少 evidence threshold。
- D5 `Repair Executor`：只套用被 deterministic validation / consensus 規則接受嘅 patch；其餘 quarantine。

所有子代理必須把 candidate 寫入 private intermediate file；主 pipeline 以 schema + deterministic rule 合併。不得靠對話文字直接改 production GeoJSON。

## 2.3 地圖放大後低清、起格

### 問題定義

最大 zoom 出現 pixelation，表示目前 base-map 或 background asset 可能係單張低 resolution raster 被 CSS / SVG 放大，或 max zoom / LOD policy 錯誤。呢個係 production blocker。

### V2 非協商規格：Zoom Quality Architecture

先診斷實際 renderer 與 asset pipeline，然後採以下原則重建：

1. **Vector first**：所有邊界、zone polygon、route、marker、grid、label、UI symbols、street / district abstraction 必須用 SVG / Canvas vector / vector-like procedural generation；不可從低清 raster 放大。
2. **多層細節（LOD）**：zoom level 依 `map-config` 切換資料密度與 render detail。
   - Z0–Z2：宏觀世界、主要倖存區、病窩、海陸、核心路線。
   - Z3–Z5：區域結構、主要設施、道路骨架、zone subregion。
   - Z6–Z8：細節 landmark、事件 clusters、密集 route waypoint、局部 texture。
3. **高解像背景**：若有 raster atmosphere / texture，必須由 high-resolution source 生成多層 pyramid tiles（WebP/AVIF），每個 zoom 有足夠 native pixels；不可一張圖 CSS scale。
4. **No fake zoom**：如果某 region 冇足夠細節，不可放大模糊圖扮有細節。應顯示 vector detail / procedural pattern / clearly designed local label，而唔係 pixelated image。
5. **Max zoom bound**：根據最高可用細節動態限制 zoom；但 V2 應提供足夠細節至使用者能探索區內 zone / landmark。
6. **Retina support**：檢查 `devicePixelRatio`，canvas/SVG / raster tile 需高 DPI render；至少支援 1x、2x。
7. **Tile seam / loading**：tile transition 必須平滑，無白邊、無閃爍、無低清 fallback 長時間停留。
8. **Performance**：採 virtual / viewport culling；唔可以因 vector detail 太多令 map pan 卡頓。

建立：

```text
scripts/
  diagnose_map_resolution.py
  generate_vector_basemap.py
  build_lod_assets.py
  render_hidpi_tiles.py
  verify_zoom_quality.py
```

並寫 Playwright zoom quality test：在各 target zoom、1x / 2x DPR、desktop / mobile screenshot；OCR / image analysis 檢查 label crispness、tile dimension、no upscaled low-res asset。不得只測「無 exception」。

## 2.4 倖存區、病窩與區域世界觀

### 新增核心 feature：World Territory System

地圖必須完整展示並可互動：

- 倖存區（survivor zone / settlement / base / polity）
- 病窩（infected nest / disease zone / hostile area）
- 爭議／危險地帶（contested / transit / quarantine / unknown）
- 重要基建／資源節點（如 data 有足夠 evidence）
- 角色旅程、事件、時期層與上述 territory layers 的關係

### Zone data schema

擴充 `data/public/zones.geojson`；如現有 schema 不足，migration 必須 versioned：

```json
{
  "type": "Feature",
  "geometry": {
    "type": "Polygon",
    "coordinates": []
  },
  "properties": {
    "id": "zone_example",
    "name": "區域名稱",
    "zone_type": "survivor_zone|infected_nest|quarantine|contested|transit|unknown",
    "status": "active|collapsed|unknown|historical",
    "danger_level": 0,
    "spatial_precision": "verified|approximate|fictional|unknown",
    "display_style": {
      "fill": "#...",
      "pattern": "hatch|contour|noise|solid|pulse",
      "icon": "..."
    },
    "chapter_refs": [],
    "event_ids": [],
    "character_ids": [],
    "dossier_id": "...",
    "confidence": 0.0,
    "review_status": "validated|auto_inferred|needs_validation"
  }
}
```

### Zone dossier：每個倖存區嘅詳細內容

建立 `data/public/zone-dossiers.json`，每個 dossier 用粵文短段落／structured facts，禁止長篇小說抄錄：

```json
{
  "id": "...",
  "zone_id": "...",
  "overview": "最多 180 字粵文概述",
  "governance": {
    "system": "政權／治理種類；未知則 unknown",
    "authority": "主導勢力／組織；未知則 unknown",
    "legitimacy": "秩序如何維持；只限有 evidence 時"
  },
  "society": {
    "population_structure": "社會結構／群體關係",
    "daily_life": "民生、資源、生活型態",
    "culture": "人文風格、規範、價值／禁忌"
  },
  "infrastructure": {
    "security": "防衛與治安",
    "resources": "資源、供應、經濟／交換",
    "mobility": "出入與交通"
  },
  "risk_profile": {
    "threats": ["..."],
    "danger_level": 0
  },
  "key_characters": [],
  "chapter_refs": [],
  "confidence": 0.0,
  "review_status": "..."
}
```

規則：

- 每個 field 只有 evidence 足夠先可填；不可為完整好睇而杜撰政權／人文。
- 若資料不足，UI 應該顯示 `資料未足以確認`，而非顯示空洞假資料。
- `infected_nest` dossier 用「威脅特徵、活動模式、影響範圍、關聯事件」代替政權／民生欄位。
- public dossier 只可保留短摘要、chapter refs、可信度；evidence excerpt 只留 private。

### Zone interaction design

- 地圖 layer control 有：`倖存區`、`病窩／危險區`、`事件`、`角色旅程`、`時期`、`地圖細節`。
- polygon hover：outline glow + tooltip（name、type、danger、狀態），不遮住地圖。
- polygon click：打開 Zone Dossier context panel。
- selected zone：地圖 soft-focus 其他區域、突出 zone boundary / internal landmarks / related events / routes。
- 可以由 zone dossier 切到：`相關事件`、`相關角色`、`時間軸`、`返回世界地圖`。
- legend 必須同時用 color、pattern、icon／shape，唔可以只靠色。
- 區域 display animation：例如危險區有低頻 pulse / noise drift、倖存區有穩定 beacon，但要尊重 `prefers-reduced-motion`。

---

# 3. 主要 User Journeys 與可驗收成果

## Journey A：第一次進入世界

使用者第一次入站後 3 秒內知道：呢個係《病港》世界地圖，可以探索地區、角色、事件與編年史。

- 預設為安全劇透模式。
- 有 4 個清楚入口：`探索地區`、`搵角色`、`搵事件`、`打開編年史`。
- 地圖初始畫面展示世界主要 territory，而唔係一堆無 context marker。
- 必須有非阻塞 onboarding / empty context，而唔係塞滿 modal。

## Journey B：探索倖存區／病窩

使用者點選一個 zone 後：

1. 地圖流暢聚焦到 polygon；
2. 右側 panel / mobile bottom sheet 顯示 dossier；
3. 可以理解呢度係咩地方、狀態、危險度、政權／社會／民生（如有資料）；
4. 可以看到相關角色、事件、章節、路線；
5. 可以切換回 map，而唔迷失。

## Journey C：角色旅程

- 在 Search 或角色入口兩個主要互動內開角色 dossier。
- 開啟 route 後，地圖上只突出相關路線／waypoint／區域關係。
- waypoint list 有 chapter range、zone relation、短 note、精度狀態。
- 點 waypoint，地圖飛去正確地點並更新 URL state。

## Journey D：事件／地點

- Search 支援 character、zone、location、event、chapter 分類。
- 選擇 event 後 fly-to，detail 顯示 summary、characters、chapter refs、spoiler、location precision、zone relation。
- 事件如座標被 quarantine，不可用假點誤導；要顯示「位置未能可靠確認」與可用 context。

## Journey E：深入編年史／伏筆

- Chronicle 係完整工作流，不係資料 dump。
- 可以按時期、chapter、zone、character、event type、spoiler 篩選。
- 大量卡片採 virtualization / pagination。
- 伏筆以 progressive disclosure 呈現；點擊關係可帶去對應 event / chapter / map context。
- 匯出只輸出 public metadata，永不輸出小說全文。

---

# 4. Multi-Agent 編制、Scope 與 Gate

## 4.1 Phase 0：Repo baseline（主代理）

主代理先執行：

1. 讀 `AGENTS.md`、現有 docs、package scripts、tests、git status。
2. 開 branch：`refactor/world-atlas-v2`。
3. 起 production-equivalent local site。
4. 建立 baseline artifacts：1440×900、768×1024、390×844 screenshots；network log；performance trace；console log。
5. 不可修改 production code。

## 4.2 Phase 1：平行只讀審計（A1–A10）

每個子代理只可讀 production code，寫入 `docs/audits/` 和 `artifacts/`。不可改 production code／data／config。

| ID | 角色 | 工作 | 必交付 |
|---|---|---|---|
| A1 | Product/UX Auditor | 三條 journey、資訊層級、entry point、progressive disclosure | `ux-product-audit.md` |
| A2 | Visual / Motion Director | 未來感 visual system、密度、動效、情緒、anti-pattern | `visual-motion-audit.md` |
| A3 | Front-end Architect | app/component/state/router/CSS coupling、legacy analysis | `frontend-architecture-audit.md` |
| A4 | Map Rendering Engineer | SVG/raster/canvas pipeline、zoom pixelation root cause、LOD proposal | `map-rendering-audit.md` |
| A5 | Spatial Data Auditor | coordinates、events/routes/zones coherence、outlier detection design | `spatial-integrity-audit.md` |
| A6 | Worldbuilding Data Architect | zones/dossiers schema、evidence / unknown policy、data gaps | `territory-dossier-audit.md` |
| A7 | Mobile/A11y Specialist | 390px flow、bottom sheet、keyboard、focus、contrast、reduced motion | `mobile-a11y-audit.md` |
| A8 | Data/Performance Engineer | public JSON load/render/indexing/Chronicle performance | `data-performance-audit.md` |
| A9 | QA Adversary | 破壞 user flows、URL refresh、offline/local-only、error states | `qa-gap-analysis.md` |
| A10 | Design Reference Synthesizer | 僅研究本機可實現嘅 design pattern；不引入 online asset dependency | `design-reference-patterns.md` |

### A1–A10 共通要求

- 實際使用 Playwright / browser tool 於 desktop/tablet/mobile 審計。
- 每項問題要有：觀察證據、root cause、影響 journey、相關檔案、修正方案、驗收方法、風險。
- 禁止泛泛「整靚啲」「加 animation」；必須有具體畫面層次、interaction / animation purpose、rendering strategy。
- A4 必須定位 pixelation 來源（asset dimension、CSS scaling、viewBox、canvas DPR、max zoom、raster fallback 等），不可憑估。
- A5 必須從 public schema / geometry / relation 規則中列出不可信座標候選，不得抽取或打印私有正文。
- A6 必須確定哪類 worldbuilding info 有 evidence、哪類為資料缺口；不可自行補寫 fiction。

## 4.3 Gate 1：主代理合成 V2 規格

主代理讀所有 audit 後，寫：

```text
docs/specs/
  world-atlas-v2-product-spec.md
  world-atlas-v2-information-architecture.md
  world-atlas-v2-component-state-contract.md
  world-atlas-v2-visual-motion-system.md
  world-atlas-v2-spatial-data-contract.md
  world-atlas-v2-rendering-lod-strategy.md
  world-atlas-v2-acceptance-matrix.md
  world-atlas-v2-migration-plan.md
```

主代理必須作不可模糊嘅決定：

- `breaking refactor` 或 `incremental`；除非 evidence 證實可以 incremental，預設採 breaking refactor。
- 每個舊 component：keep / rewrite / delete，並寫原因。
- state ownership、URL serialization、data adapter boundaries。
- vector / high-res texture / LOD strategy。
- zone schema / dossier schema / coordinate validation migration。
- motion system：duration、easing、which state can animate、reduced motion fallback。
- target file ownership map；禁止多代理同時改同一 production file。

## 4.4 Phase 2：平行實作（B1–B9）

只有 Gate 1 規格完成後先可派發。每個 agent 只可改指定 file scope，必須先寫 interface contract。

| ID | 子代理 | 可寫範圍 | 交付 |
|---|---|---|---|
| B1 | Design System & Motion | `src/theme.ts`、`src/styles/`、local SVG/ui asset | tokens、motion primitives、responsive shell |
| B2 | App State & Router | `src/app.ts`、`src/router.ts`、`src/types/`、new `src/state/` | state machine、URL contract、tests |
| B3 | Data Adapter | `src/data/`、types、selectors/indexes | normalized data adapter、search indexes、tests |
| B4 | Territory Data Pipeline | `scripts/`、`data/schemas/`、public zone outputs | zone/dossier/coordinate audit pipeline |
| B5 | Vector Map & LOD Renderer | `SvgMap.ts` or replacement renderer、local map assets | crisp vector / LOD / HiDPI implementation |
| B6 | Map Interaction | map controllers/components only | layer toggle、zone interaction、marker/route detail |
| B7 | Chronicle Experience | `ChronicleView.ts`、timeline-related code/style | virtualized chronicle、zone/route deep links |
| B8 | Mobile + A11y | mobile shell / accessibility helpers / tests | bottom sheet、focus、keyboard、reduced motion |
| B9 | Visual QA Automation | test/artifact scripts only | screenshot/OCR/zoom/pixelation checks |

每個 B agent：

- 只改 allowlisted scope，唔做 mass format。
- 不可修改同一份 shared interface 而無主代理批准。
- 產出 `docs/progress/<agent>-delivery.md`：modified files、contract、tests、screenshots、known limitation。
- 舊 implementation 被取代時，主代理要安排 legacy cleanup，唔好長期雙軌。

## 4.5 Gate 2：主代理整合與 legacy removal

整合順序：

1. B2 state/router；
2. B3 data adapters；
3. B4 data schema/pipeline outputs；
4. B1 design/motion primitives；
5. B5 renderer/LOD；
6. B6 map interaction；
7. B7 chronicle；
8. B8 mobile/a11y；
9. B9 QA harness；
10. remove old CSS, dead state, obsolete event listeners, duplicate components, obsolete tests。

如 output 有 conflict，主代理要以 V2 spec 為 authority；不得為方便 merge 而保留舊 interaction model。

## 4.6 Phase 3：平行對抗驗收（C1–C8）

所有 C agent 只讀 production code，可新增 tests/reports；P0/P1 fail 必須由主代理 remediation。

| ID | 角色 | 必交付 |
|---|---|---|
| C1 | Journey E2E Tester | desktop/tablet/mobile flow tests + screenshots |
| C2 | Visual Quality Critic | visual rubric、before/after evidence、anti-dashboard review |
| C3 | Zoom/Render QA | all zoom/DPR screenshot、pixelation/seam/LOD report |
| C4 | Spatial Integrity Auditor | coordinate / zone / route audit report |
| C5 | Data Governance Auditor | private text / secret / public dataset scan |
| C6 | Performance Auditor | render/search/chronicle/bundle report |
| C7 | Accessibility Auditor | keyboard/focus/ARIA/contrast/reduced-motion report |
| C8 | Hostile Product Reviewer | 專門檢查「係咪其實只係換皮」「zone dossier 是否空洞」「地圖是否仍係資料 dump」 |

---

# 5. 技術實作要求

## 5.1 Single state / URL contract

建立可序列化、可測試、可 hydrate 嘅 state。概念例如：

```ts
type PrimaryContext =
  | { kind: 'explore' }
  | { kind: 'search'; query: string }
  | { kind: 'zone'; zoneId: string }
  | { kind: 'event'; eventId: string }
  | { kind: 'location'; locationId: string }
  | { kind: 'character'; characterId: string }
  | { kind: 'route'; characterId: string }
  | { kind: 'chronicle'; filters: ChronicleFilters }
  | { kind: 'chapter'; issueIndex: number }
  | { kind: 'measure' };
```

URL 至少支援：

```text
#location=<id>
?event=<id>
?zone=<id>
?character=<id>
?chapter=<issue_index>
?spoiler=<0-3>
?layers=zones,events,routes
?view=map|chronicle
```

Refresh 後必須重現 selection、spoiler、主要 layer 與 context；無效 ID 要 graceful fallback，而唔可以 crash。

## 5.2 Design token 與 motion system

使用 CSS custom properties / typed token config：

```text
color: background/surface/elevated/text/muted/accent/danger/safe/unknown
spacing: 4/8/12/16/24/32/48
radius: 8/12/16
shadow: low/medium/high
z-index: map/controls/panel/modal/toast
motion: fast(120ms)/normal(220ms)/slow(420ms)
```

動效只限以下目的：

- map layer fade / cross-fade；
- selected zone outline pulse；
- route drawing / focus transition；
- panel / bottom sheet transition；
- marker hover / selection；
- loading skeleton / data stream；
- danger zone low-amplitude pulse。

必須：

```css
@media (prefers-reduced-motion: reduce) {
  /* 關閉非必要 transform / pulse / particle animation */
}
```

禁止 auto-playing video、無限高速閃爍、大量 JS per-frame DOM update。

## 5.3 高解析地圖 render implementation

優先採取：

- SVG viewBox + vector paths 作 base geometry。
- Canvas layer 只用於大量粒子／texture，按 `devicePixelRatio` 調整 backing store。
- high-resolution atmospheric raster 僅作 texture，採 tile pyramid；不可作唯一地理資訊層。
- labels / boundaries / markers 永遠 vector on top。
- zoom transform 不可將 low-res bitmap 拉大。
- 以 `requestAnimationFrame`、transform、culling、LOD throttling 實現 smooth interaction。

如 `SvgMap.ts` 太大或不可維護，拆成：

```text
src/map/
  MapShell.ts
  MapViewport.ts
  BaseGeometryLayer.ts
  ZoneLayer.ts
  EventLayer.ts
  RouteLayer.ts
  MarkerLayer.ts
  LabelLayer.ts
  MapControls.ts
  map-lod.ts
  map-camera.ts
  map-interactions.ts
```

不要求按此檔名硬拆，但要達成相同 separation of concerns。

## 5.4 Zone 與病窩圖層視覺語言

| 類型 | 視覺語言 | 互動 |
|---|---|---|
| 倖存區 | 穩定邊界、低頻 beacon、可讀名稱、結構化 fill | click 開 dossier / events / characters |
| 病窩 | 不規則輪廓、危險斜線／噪點、低頻呼吸紅光 | click 睇威脅特徵 / 關聯事件 |
| 隔離區 | 冷黃／警示線、gate icon、受限 label | click 睇進出 / 風險資料 |
| 爭議地帶 | 雙色 contour／broken boundary | click 睇不確定性 / 相關勢力 |
| 未知區 | 低對比 fog / question marker | click 顯示資料不足，唔好假裝有 dossier |

所有特效需使用 vector / CSS pattern，確保任何 zoom 下保持清晰。

---

# 6. Context Engineering 與子代理 Protocol

## 6.1 每個子代理只收最小必要 context

主代理 dispatch 時提供：

```text
- 任務 ID 與角色
- 可讀／可寫 file scope
- 相關 product spec section
- 相關 type / interface / data schema
- 具體 user journey
- 禁止事項
- 必交付檔案位置
- done criteria
- validation command
- conflict / escalation rule
```

不得把整個 codebase、整個 commit history、private dataset、超長 raw JSON 一次塞入每個 agent。

## 6.2 子代理完成回報模板

```markdown
## 任務摘要

## 假設與證據

## 發現／改動

## 修改檔案

## 沒有修改但相關的檔案

## 驗證命令與結果

## Screenshots / Artifacts

## 風險、衝突、限制

## 給主代理的 integration note
```

## 6.3 Anti-stagnation directives

每次 implementation task 都要包含：

- 「呢個係 replacement task；舊 component 唔係優先真相。」
- 「如舊 architecture 阻礙 spec，replace architecture；唔好 patch around it。」
- 「不可只做 CSS／style diff；必須改變 information hierarchy、user flow、state contract、render strategy 或 data integrity。」
- 「完成證據係 E2E、visual screenshot、keyboard flow、refresh persistence、zoom/DPR report，唔係 code line count。」
- 「existing tests 同新規格衝突時，更新 tests 去驗證新 spec；唔好屈就舊 UI。」

---

# 7. 強制測試、驗證與品質 Gate

## 7.1 Baseline commands

先讀 `package.json` / existing docs，然後使用專案實際 command；最低要求：

```bash
npm run lint
npm run typecheck
npm run test
npm run build
pytest
python scripts/validate_public_data.py
python scripts/verify_assets.py
python scripts/audit_release.py
```

如 command 不存在，建立清楚、可重跑嘅等價 scripts；不可靜默略過。

## 7.2 必須新增／更新 Playwright test

1. 初次入站 1440px：title、4 主入口、safe spoiler、map visible、無 blocking modal。
2. Zone：click survivor zone → dossier → related event → map state / URL update。
3. Infected nest：click → threat-oriented dossier、danger legend、no false governance fields。
4. Search：角色／zone／event／chapter，鍵盤 up/down/Enter/Esc。
5. Character route：open route → only relevant emphasis → waypoint → fly-to → URL → close restore。
6. Event detail：marker → detail → chapter/zone / timeline deep link → back preserves state。
7. Spoiler：default hides high level → update → persistence after refresh。
8. Chronicle：filter by period / zone / character / spoiler → card → map deep link；測試 large-list virtualization。
9. Mobile 390×844：bottom sheet、safe area、no horizontal overflow、touch target >=44px。
10. Keyboard：Tab flow、focus visible、Esc、shortcuts（如保留）。
11. Local-only network：intercept requests；assert no map/tile/geocoder external request。
12. Public data safety：assert no private-text pattern / secrets in public routes / export。
13. Zoom quality：各 target zoom + DPR 1/2 screenshot；assert no low-res raster scaling fallback；labels/zone outline/markers crisp。

## 7.3 Visual artifacts

固定 viewport 與 deterministic data，輸出：

```text
artifacts/screenshots/
  baseline-map-desktop-1440.png
  v2-map-desktop-1440.png
  v2-map-tablet-768.png
  v2-map-mobile-390.png
  v2-zone-survivor-dossier.png
  v2-zone-infected-nest-dossier.png
  v2-character-route.png
  v2-event-detail.png
  v2-chronicle.png
  v2-zoom-min.png
  v2-zoom-max-dpr1.png
  v2-zoom-max-dpr2.png
```

C2 / C3 必須比較 baseline 與 V2，不得只確認圖片檔存在。

## 7.4 Performance targets

- 初次 interactive map shell：目標 <=3 秒 development benchmark；超過要寫 root cause 與 remediation。
- Search local index response：<=150ms。
- map marker / zone selection：主觀感知 <=100ms。
- Chronicle filter：<=250ms；否則 virtualize/index。
- zoom / pan：無明顯 frame drop；顯著瓶頸必須 profile。
- 禁止 eager render 所有 chronicle cards。
- 所有 tiles / textures 需 size budget；不可用巨大 raster 掩蓋低清問題。

---

# 8. 最終交付與 Release Audit

所有以下條件滿足先可以標記 V2 完成：

1. A1–A10 audit、Gate 1 specs、B1–B9 deliveries、C1–C8 reports 全部 persisted。
2. UI 已由資料 dump 改成高質素 world-atlas experience；C8 hostile review 不得有 P0/P1。
3. zone / infected nest world territory system 可視、可互動、有 legend、有 dossier、有資料不足狀態。
4. coordinate integrity pipeline 有可重跑結果；錯置 candidate 已 auto-correct、quarantine 或降 precision；不得未經 evidence 假裝修正。
5. zoom quality 不再 pixelated；所有 target zoom/DPR screenshot 通過 C3。
6. desktop/tablet/mobile / keyboard / reduced-motion / accessibility 皆通過。
7. public output 無 private novel text、secret、remote map/tile API。
8. old dead CSS / components / state / handlers 已刪；冇兩套 conflicting architecture。
9. `docs/progress/world-atlas-v2-delivery.md` 必須逐條填寫：
   - 目標與 user journey；
   - implementation evidence；
   - coordinate / data validation summary；
   - zoom rendering evidence；
   - screenshots；
   - test / audit results；
   - deleted legacy paths；
   - performance results；
   - known limitation / data gaps。
10. 寫 `docs/UX_DECISIONS.md`，記錄：被拒絕嘅舊 UI pattern、state design、LOD policy、zone semantics、motion rules，防止下一輪 agent 重新固化錯誤方向。

---

# 9. 立即執行指令

主代理依序執行，**不可跳過 Gate**：

1. 讀 `AGENTS.md`、現有 docs、package/test scripts、git status；確認 private data 沒有追蹤。
2. 建 branch：`refactor/world-atlas-v2`。
3. 建 baseline screenshots/network/performance artifact。
4. 平行 dispatch A1–A10；只可寫 audits / artifacts，不可改 production。
5. 讀齊 A reports，寫 Gate 1 V2 specs；明確作出 breaking refactor / migration / ownership 決定。
6. 建 file ownership map，派 B1–B9；各 agent 先交 interface contract 再寫 code。
7. 主代理按依賴整合，移除 legacy，跑全部 test。
8. 派 C1–C8 對抗驗收；發現 P0/P1 即建 remediation，修完重跑。
9. 寫 final delivery report、UX decisions、release audit；全部 pass 才 commit。

由而家開始，不可再以「UI 改咗」「加咗動畫」「新增咗 zone」「build 過咗」作為完成標準。只可以以：**可完成嘅 user journey、可靠嘅世界資料、正確／誠實嘅空間位置、最大 zoom 仍保持清晰、專業未來感視覺體驗、E2E / screenshot / a11y / performance / data audit 證據**作為完成定義。
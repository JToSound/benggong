# B3 Data Adapter — 交付報告

> 子代理：**B3 Data Adapter**｜Branch：`refactor/world-atlas-v2`
> 契約（先寫後做）：`docs/contracts/b3-interface-contract.md`
> 狀態：**已交付**；`typecheck` / `lint` / `test` / `build` 全綠。

---

## 任務摘要

建立咗 World Atlas V2 嘅**唯一資料邊界** `src/data/adapter/`，取代「component 直接掃 raw GeoJSON」嘅做法：

1. **索引層**：spec §2.3 表 10 個索引 + 2 個 B2 需要嘅補充索引，全部 `Map` / `Set`，**零線性 `find()`**。
2. **`dossierByZone` lazy**：`zone-dossiers.json`（100 KB）唔喺首屏載入，按需載入後**就地填充同一個 Map**（B2 `selectDossier()` 唔使改簽名）。
3. **移除 `timeline.json` eager load**：省 **195 KB transfer + 3.6 ms parse**（A8 P1-2），`AppData.timeline` 欄位保留（值 `[]`），下游零影響。
4. **Search index**：5 類（character / zone / location / event / chapter）、**冇硬上限**、實測最壞 **0.124 ms**（預算 ≤150 ms，餘裕 >1,200×）。
5. **`emptyOutDir: false → true`**：清走 `dist/` 累積嘅 stale bundle，**56 MB → 51 MB、JS 檔 49 → 1、CSS 檔 17 → 1**。
6. **`normalize.ts`**：處理 B4 新增嘅 `zone_type` / `dossier_id` / `coordinate_*` / `zone_ids` / `zone_id`，並按規則 D4 收納 `resolveCoord` / `hasEvidence` / `FALLBACK_ANCHORS`。

**`loadAllData()` 簽名同 `AppData` shape 完全不變**（見 §「AppData 不變嘅證明」）。

---

## 假設與證據

### 讀過嘅規格／契約／審計

| 文件 | 取用重點 |
|---|---|
| `world-atlas-v2-component-state-contract.md` | §2.2 規則 D1–D4、§2.3 索引表、§1.5 derived selectors |
| `world-atlas-v2-information-architecture.md` | §8 Search IA（5 類、移除硬上限） |
| `world-atlas-v2-rendering-lod-strategy.md` | §6.2 預算、§6.3 修正優先次序 ①⑥ |
| `docs/contracts/b4-interface-contract.md` | 44 欄 zone v2、`zone-dossiers.json` schema、`coordinate_*`、§9 消費指引 |
| `docs/contracts/b2-interface-contract.md` | `WorldIndex`（§2.4）、selector 簽名（§4）、搜尋無硬上限（§4.1） |
| `docs/audits/data-performance-audit.md`（A8） | P1-2 timeline、P1-4 `find()` 風暴、P1-5 stale bundle、P0-2 geojson gzip |
| `docs/audits/frontend-architecture-audit.md`（A3） | §4.1 載入量、§4.2 index 覆蓋不足、§4.3 component 直讀 raw shape |

### 資料實測（本次，2026-09-21，B4 已交付版本）

| 檔案 | 大小 | 筆數 |
|---|---|---|
| `events.geojson` | 2,135,972 B | 1,796（`zone_id` 有值 **1,627 = 90.59%**） |
| `locations.geojson` | 939,086 B | 704（`zone_ids` 有值 587 = 83.4%） |
| `zones.geojson` | 409,630 B | 48（`schema_version: 2`、`zone_type` / `dossier_id` 齊） |
| `routes.geojson` | 376,241 B | 42（759 waypoint） |
| `timeline.json` | 1,331,860 B | 1,796（**src/ 零引用**） |
| `zone-dossiers.json` | 100,890 B | 48 |
| `characters.json` | 163,191 B | 330 |
| `chronicle.json` | 1,464,747 B | 1,320 |
| `chapter-summaries.json` | 216,803 B | 195 |
| `map-config.json` | 1,888 B | — |

### 關鍵假設

1. `zone.event_ids` 同由 `event.zone_id` 建嘅 `eventsByZone` **必須一致**（B4 契約 §9 明文）。**實測 48/48 完全一致**（見 §索引正確性）。
2. `event.characters[]` 係**角色 id**（實測 173/173 全部命中 `characters.json`）。
3. `chapter-summaries.json` 嘅 key 係字串 `"1".."195"`（唔係 198）。

---

## 發現／改動

### 1. 索引層（`src/data/adapter/indexes.ts`）

spec §2.3 表逐條實作 + 2 個 B2 需要嘅補充索引（`routesById` / `routesByCharacter`）。

| 索引 | Key → Value | 實測項數 |
|---|---|---|
| `locationsById` | `id → LocationFeature` | 704 |
| `eventsById` | `id → EventFeature` | 1,796 |
| `zonesById` | `id → ZoneFeature` | 48 |
| `eventsByLocation` | `location_id → EventFeature[]`（跳過 `null`） | 274 |
| `eventsByZone` | `zone_id → EventFeature[]`（先為 48 個 zone 開 key） | 48 |
| `charactersById` | `id → CharacterRecord` | 330 |
| `eventsByCharacter` | `character_id → EventFeature[]` | 173 |
| `zonesByLocation` | `location_id → zone_id[]`（雙向、去重） | 587 |
| `dossierByZone` | `zone_id → ZoneDossier`（**lazy**） | 0 → 48 |
| `chronicleByPeriod` | `story_time.label → ChronicleEntry[]` | 6 |
| `routesById` | `id → RouteFeature` | 42 |
| `routesByCharacter` | `character_id → RouteFeature`（首個命中） | 42 |
| `search` | 見 §4 | 3,073 entries |

#### 索引建構時間表（實測，node 22；`tests/data-adapter.test.ts` 直接輸出）

| 索引 | ms | 索引 | ms |
|---|---|---|---|
| `search` | **20.32** | `eventsByCharacter` | 0.48 |
| `zonesByLocation` | 0.51 | `eventsByZone` | 0.29 |
| `eventsByLocation` | 0.31 | `eventsById` | 0.31 |
| `chronicleByPeriod` | 0.18 | `locationsById` | 0.19 |
| `zonesById` | 0.09 | `charactersById` | 0.06 |
| `routesById` | 0.03 | `routesByCharacter` | 0.02 |
| `dossierByZone` | 0.01 | | |
| **合計** | | | **22.90 ms** |

> `search` 佔 89%（單字倒排要掃 ~53 萬字元）；其餘 12 個索引合計 **2.6 ms**。
> 索引係**一次過**成本（首屏之後唔再重算），相對 A8 量到嘅 24.66 ms JSON parse 屬同一量級。
> ⚠️ 數字係兩次獨立 run 嘅其中一次；run-to-run 有 ±20% 波動
> （另一 run：`total = 23.58 ms`、`search = 19.70 ms`、`eventsByCharacter = 1.90 ms`）。
> 測試只斷言「有量度、每項 ≥0」，唔斷言絕對值（避免 flaky）。

### 2. `dossierByZone` lazy（`index.ts`）

- `loadWorldData()` 嘅 fetch 清單 **9 個檔**，**唔含** `timeline.json` / `zone-dossiers.json`（測試斷言）。
- `world.indexes.dossierByZone === world.dossiers.byZone`（同一 `Map` reference）；`loadDossiers()` 之後**就地填充** 48 筆。
- 因此 B2 `WorldIndex.dossierByZone`（同步 `ReadonlyMap`）**唔使改簽名**都食到 lazy 結果。
- `loadDossiers()` memoized：連續呼叫回**同一個 Promise**，只 fetch 一次。

### 3. 移除 `timeline.json` eager load（`loadAllData.ts`）

- **先 grep 確認**（證據）：

  ```
  $ grep -rn "timeline" src/ --include=*.ts
  src/components/ChronicleView.ts:299:  <div class="chr-timeline" ...>   ← CSS class 名
  src/data/loadAllData.ts:87:  timeline: TimelineRecord[];               ← 型別宣告
  $ grep -rn "\.timeline\b" src/ --include=*.ts
  （除 adapter 自己嘅 lazy loader 之外）0 個 component 讀取
  ```
  → `AppData.timeline` 冇任何 component 用，移除 eager fetch 對下游**零影響**。
- 改動 = **刪 2 行 fetch、加 1 行 `const timeline: TimelineRecord[] = [];`**（+ 註解）。
- **冇刪資料檔**（`data/**` 屬 B4），需要時用 `loadTimeline(world)`（lazy、memoized）取回 1,796 條。

### 4. Search index（`src/data/searchIndex.ts`）

- 結構：`entries`（扁平、穩定次序 character→zone→location→event→chapter）+ `byKind` + `postings`（單字倒排）。
- 演算法：揀 query 中**最稀有嘅字**攞 posting 做候選 → 套 kind 過濾 → `includes()` 覆核。覆核保證正確性，倒排保證亞線性。
- **冇硬上限**：查「病」回傳 **870** 條（舊版硬上限 50）。

| 查詢 | 結果數 | 單次耗時 |
|---|---|---|
| 「病」 | 870 | 0.055 ms（200 次取最大） |
| 「人」（posting 最長 = 1,394，**worst case**） | — | 0.124 ms |
| 逐字打「將軍澳大本營」6 keystroke | — | 合計 0.066 ms |
| **預算** | | **≤150 ms** ✅（餘裕 >1,200×） |

- 正確性：10 條 query × 6 個 kind 組合（`null` + 5 類），同**線性掃描 ground truth** 嘅 id 序列**完全一致**（60 組斷言）。

### 5. `vite.config.ts`（只改 build）

- `emptyOutDir: false → true`。舊註解（`rm` shim fail-closed）已更新：實測 `npm run clean`（純 node `fs.rmSync`）已可處理；`vite build` 喺本機**成功**（見 §驗證）。
- **`test.exclude` 冇改**（`artifacts/**` / `dist/**` 原樣）。
- **冇加 `manualChunks`**：目前單一 entry（145 KB / 47.5 KB gzip）已喺預算內（≤60 KB gzip），加 chunk 只係搬位、唔減總量，屬「為做而做」→ 唔加。
- **冇加 geojson pre-compression**：見 §「geojson gzip 判斷」。

### 6. `normalize.ts`（規則 D4 + B4 v2 欄位）

- `zone_type` 缺失 → 由 `kind` 確定性推導（`survivor→survivor_zone` …）；`display_style` 由 `zone_type` 查表補（token 名，唔存 hex）。
- `danger_level` / `dossier_id` 補 `null`；`event_ids` / `character_ids` / `member_location_ids` / `zone_ids` / `aliases` 補 `[]`。
- `event.zone_id` 補 `null`；`chapter_refs` 缺失時由 `chapter` 補。
- `resolveCoord`（四層）/ `hasEvidence` / `FALLBACK_ANCHORS`（34 條人手錨點）搬入 adapter 並 export。
- **唔 mutate 輸入**（spread 造新 properties 物件；測試斷言）。

---

## 修改檔案

### 新增（8）

| 檔案 | 行數 | 用途 |
|---|---|---|
| `docs/contracts/b3-interface-contract.md` | — | **先寫**嘅介面契約 |
| `src/data/adapter/index.ts` | 305 | 對外唯一入口：`loadWorldData` / `toWorldIndex` / lazy loaders / selectors |
| `src/data/adapter/normalize.ts` | 353 | raw → typed shape；規則 D4 |
| `src/data/adapter/indexes.ts` | 268 | 13 個索引 + 建構時間量度 |
| `src/data/adapter/config.ts` | 137 | `map-config` → `MapRuntimeConfig` |
| `src/data/searchIndex.ts` | 197 | 5 類倒排搜尋索引 |
| `tests/data-adapter.test.ts` | 292 | adapter 契約 + lazy + 相容性靜態斷言 |
| `tests/data-indexes.test.ts` | 236 | 13 個索引正確性（全量重算比對） |
| `tests/search-index.test.ts` | 223 | 5 類 + 無上限 + benchmark |
| `docs/progress/b3-data-adapter-delivery.md` | — | 本報告 |

### 改（2）

| 檔案 | 改動 | 風險 |
|---|---|---|
| `src/data/loadAllData.ts` | 刪 `timeline.json` eager fetch（2 行）＋加 `timeline: []`（1 行）＋註解 | **低**：簽名／shape 不變，零下游影響 |
| `vite.config.ts` | `emptyOutDir: false → true`（+ 更新註解） | **低**：build 已實測成功 |

### 冇改（allowlist 內但決定唔改）

| 檔案 | 原因 |
|---|---|
| `src/data/fallbackAnchors.ts` | **唔搬**（見 §風險 C1）：`tests/phase-i.test.ts:9` 直接 `readFileSync` 該檔內容，搬走會整紅現有測試；改為由 adapter re-export。 |
| `package.json` | 冇需要新依賴。 |

---

## 沒有修改但相關的檔案

| 檔案 | 關係 |
|---|---|
| `src/components/SvgMap.ts`（B5） | 仍有自己嘅 `resolveCoord` / `hasEvidence` / `FALLBACK_ANCHORS`（屬 B5，唔可以改）→ B5 接手後應改為由 adapter import（規則 D4） |
| `src/state/selectors.ts`（B2） | `buildWorldIndex()` 過渡橋保留；`toWorldIndex(world)` 回傳嘅物件滿足同一個 `WorldIndex`，可**直接取代** |
| `src/components/SearchBox.ts`（B6/B7） | 舊搜尋（硬上限 50、3 類）；B7/B8 應改用 `searchSearchIndex(world.indexes.search, kind, q)` |
| `src/components/ZoneDossier.ts`（B6） | 應改用 `loadDossiers()` + `getDossier()`（lazy） |
| `src/components/ChronicleView.ts`（B7） | 自己重複聲明 `ChronicleEntry` interface（A3 §4.3）→ 應改由 `loadAllData` / adapter import |
| `data/public/zone-dossiers.json`（B4） | B3 只讀（lazy） |
| `public/assets/map-lod/`、`hk-basemap*.png` | 28 MB + 4 MB 死重（A8 P0-4）→ 屬 B5 / 主代理（唔喺 B3 allowlist） |
| `dist/` | 已清空重建 |

---

## 驗證命令與結果

```bash
npm run typecheck   # ✅ 0 error
npm run lint        # ✅ 0 error / 0 warning
npm run test        # ✅ 17 files / 240 tests 全綠（現有 14 files / 195 tests + B3 新增 3 files / 45 tests）
npm run build       # ✅ 成功（vite v7.3.6，32 modules，built in 1.20s）
```

### `npm run test` 摘要（實跑）

```
Test Files  17 passed (17)
     Tests  240 passed (240)
  Duration  209.15s
```

B3 新增三個檔：`tests/data-adapter.test.ts`（17）、`tests/data-indexes.test.ts`（13）、`tests/search-index.test.ts`（15）。

### `npm run build` 摘要（實跑）

```
dist/index.html                                 0.97 kB │ gzip:  0.57 kB
dist/assets/hk-basemap-labels-DtX8PzYn.png    131.69 kB
dist/assets/hk-basemap-_tR-jzZe.png         1,978.25 kB
dist/assets/index-BdSiIJ4y.css                 52.37 kB │ gzip: 11.51 kB
dist/assets/index-X5vIyw-A.js                 144.96 kB │ gzip: 47.55 kB
✓ built in 1.20s
```

### `dist/` 大小前後對比（`emptyOutDir` 修正）

| 指標 | 前 | 後 | 變化 |
|---|---|---|---|
| `dist/` 總大小 | **56 MB** | **51 MB** | **−5 MB** |
| 檔案數 | 211 | 147 | −64 |
| `dist/assets/index-*.js` | 49（1 active + **48 stale**） | **1** | **stale = 0** |
| `dist/assets/index-*.css` | 17（1 active + **16 stale**） | **1** | **stale = 0** |
| Active JS | 128,468 B（gzip 41,602） | 144,961 B（gzip 47,328） | +16.5 KB |
| Active CSS | 45,170 B（gzip 9,315） | 52,372 B（gzip 11,452） | +7.2 KB |

> **Active bundle 增長唔關 B3 事**：`dist/assets/index-*.js` 完全**唔含** B3 adapter 代碼
> （`grep -c "zone-dossiers.json" dist/assets/index-*.js` = **0**）。增長來自並行代理
> （B1 `theme-tokens`/`motion`、B2 `src/state`、B5 `src/map`、B8 `src/ui`）新模組。
> B3 嘅 adapter 目前係 tree-shaken 出 bundle（entry 未 import），**runtime 成本 = 0**；
> B5/B6/B7 接線之後先計入。
> 剩低嘅 51 MB 之中 **map-lod 28 MB + vector 12 MB**（A8 P0-4 死重）→ 唔屬 B3 allowlist。

### 索引正確性（`tests/data-indexes.test.ts`，13 條）

| 斷言 | 方法 | 結果 |
|---|---|---|
| `locationsById` / `eventsById` / `zonesById` / `charactersById` | 全量：每個 feature id 都指返自己（identity） | ✅ |
| `eventsByLocation` | 同 raw 獨立重算 **全量比對** | ✅ |
| `eventsByCharacter` | 同 raw 獨立重算 **全量比對**（173 個 key） | ✅ |
| `zonesByLocation` | 同 raw 獨立重算 **全量比對**（雙向、去重） | ✅ |
| `eventsByZone` | **逐個 48 zone** 同 `zone.event_ids` 比對（集合相等） | ✅ **48/48 一致** |
| `eventsByZone` 覆蓋率 | 唯一 event 數 / 1,796 | ✅ **1,627 / 1,796 = 90.59%**（≥ 90.6% 四捨五入） |
| `chronicleByPeriod` | 同 raw 重算比對；總數 = 1,320 | ✅ |
| `routesById` / `routesByCharacter` | 同 raw 重算比對 | ✅ |
| `dossierByZone` | 首屏 size = 0（lazy） | ✅ |
| 建構量度 | 每項 ≥0、total > 0、sizes 對得上 | ✅ |

### `AppData` 不變嘅證明（diff 摘要 + 靜態斷言）

`git diff src/data/loadAllData.ts` 只有三處**實質**改動（其餘係註解）：

```diff
     routes,
-    timeline,
     characters,
@@
     fetchJSON<RoutesFeatureCollection>(base + "routes.geojson"),
-    fetchJSON<TimelineRecord[]>(base + "timeline.json"),
     fetchJSON<CharactersData>(base + "characters.json"),
@@
+  // timeline.json 唔 eager 載入（A8 P1-2）；欄位保留、值為空陣列。
+  const timeline: TimelineRecord[] = [];
```

`tests/data-adapter.test.ts` 另有 4 條**靜態斷言**（唔靠人手覆核）：

| # | 斷言 | 結果 |
|---|---|---|
| 1 | `export async function loadAllData(): Promise<AppData>` 原樣存在 | ✅ |
| 2 | `AppData` interface 14 個欄位一個都冇少（`config`…`routesByChapter`） | ✅ |
| 3 | 冇任何 `base + "timeline.json"` fetch 路徑；`const timeline: TimelineRecord[] = [];` 存在 | ✅ |
| 4 | 現有 4 個 index（`locationsById` / `charactersByName` / `eventsByChapter` / `routesByChapter`）建構規則原樣 | ✅ |

→ **B5 / B6 / B7 可以放心照舊用 `loadAllData()` + `AppData`，唔使改任何一行。**

### geojson gzip 判斷（P0-2，A8 最高 ROI ①）

實測 gzip 收益（`zlib.gzipSync` level 9）：

| 檔案 | raw | gzip | 壓縮率 |
|---|---|---|---|
| `events.geojson` | 2,135,972 | 215,770 | 10.1% |
| `locations.geojson` | 939,086 | 89,931 | 9.6% |
| `zones.geojson` | 409,630 | 64,164 | 15.7% |
| `routes.geojson` | 376,241 | 16,250 | 4.3% |
| **合計** | **3,860,929** | **386,115** | **10.0%（可省 3.47 MB）** |

**判斷：唔加 build-time pre-compression。** 理由（如實記錄）：

1. A8 量到嘅「未壓縮」係**本機 `vite preview`（sirv）** 行為 —— sirv 唔做 on-the-fly 壓縮。
2. **GitHub Pages 喺 CDN edge 自動 gzip**（主代理提供嘅前提）；`*.geojson` 用 `application/geo+json`，GitHub Pages 對 text-ish content-type 一樣會壓。
3. GitHub Pages **唔會** serve `.gz` sidecar（冇 `Content-Encoding` 設定入口）→ build 出 `.gz` 只會令 `dist/` **+3.9 MB** 而**零收益**，屬過度工程。
4. 若果 deploy 後實測發現 GitHub Pages **真係冇**壓 `application/geo+json`，正確修法係喺**部署層**（或將副檔名改 `.json`，屬 B4 `data/**`），**唔喺** `vite.config.ts`。

---

## Screenshots / Artifacts

- 本任務**冇新增 screenshot**（證據全部係程式化 metrics：測試斷言、`du`、`zlib.gzipSync`、`performance.now()`）。
- 可重跑嘅證據入口：
  - `npx vitest run tests/data-adapter.test.ts tests/data-indexes.test.ts tests/search-index.test.ts`
    → 直接 print 索引建構時間表、search 延遲、worst case。
  - `npm run build` → dist 逐檔 size + gzip。
- 契約：`docs/contracts/b3-interface-contract.md`。

---

## 風險、衝突、限制

| # | 項 | 說明 | 影響 |
|---|---|---|---|
| **C1** | `fallbackAnchors.ts` 冇搬入 adapter | `tests/phase-i.test.ts:9` 用 `readFileSync("src/data/fallbackAnchors.ts")` 讀**檔內容**，斷言 `export const FULL_HK_ANCHORS: Record<string, FullHKAnchor>` + ≥500 條目。搬走內容（改 re-export）會令該測試**必然紅**，而該檔唔屬 B3 allowlist。→ 保留原檔為資料來源，adapter re-export。規則 D4 嘅**邏輯**（`resolveCoord` / `hasEvidence`）已搬入 adapter。 | 低（功能等價；只係資料檔位置未收斂） |
| **C2** | `FALLBACK_ANCHORS`（34 條人手錨點）暫時喺 adapter 同 `SvgMap.ts` **各有一份** | 同上：`SvgMap.ts` 唔屬 B3 allowlist。B5 接手後應改為 import adapter 版本，消除重複。 | 低（內容一致；有分歧風險） |
| **C3** | geojson gzip 未喺 build 解決 | 見上；屬部署層 / B4 `data/**`。 | 中（首屏多 3.47 MB，直到部署層處理） |
| **C4** | `dist/` 仍然 51 MB | 其中 **map-lod 28 MB + vector 12 MB**（A8 P0-4 死重）唔屬 B3 allowlist（`public/assets/**` 由 B5 / 主代理處理）。 | 中 |
| **C5** | `chapterTotal` 係 198，但 `chapter-summaries.json` 只有 195 章 | search 嘅 `chapter` kind 只有 195 entries（缺 3 章）。B2 `chapterTotal` 用 198 係另一回事。 | 低（資料缺口，唔係 bug） |
| **C6** | 搜尋索引係**單字倒排**（唔係 bigram） | 對 CJK 單字查詢足夠；單字倒排 memory 遠低於 bigram。`search` 建構 20 ms 係最大單項成本。 | 低 |
| **C7** | 只索引「有意義」字元（CJK／字母／數字） | 純標點 query（如「，」）會回 `[]`（唔會 match 到含標點嘅 text）。屬刻意設計（query 語意為「搵名／內容」，唔係搵標點）。 | 低（未實測有實際用例） |
| **C8** | `emptyOutDir: true` 未喺「`vite preview` 正鎖住 `dist`」嘅情境實測 | 本次 `npm run build` 時冇 preview server 運行 → 成功。若果 CI / 本機有 preview 同時跑，可能撞檔案鎖 → 跑 `npm run clean` 再 build。 | 低 |
| **C9** | 索引係**一次過**建構（22.9 ms） | 首屏主線程成本 +22.9 ms（相對 A8 量到嘅 24.66 ms JSON parse 屬同級）。未做 incremental / idle 建構。 | 低（預算餘裕大） |

---

## 給主代理的 integration note

1. **B5 / B6 / B7 唔使改任何現有 code 都可以繼續交付**：`loadAllData()` 簽名 + `AppData` shape 完全不變（§AppData 不變嘅證明）。新能力全部喺**新模組**。

2. **B2 selector 可以直接食 adapter 輸出**：
   ```ts
   import { loadWorldData, toWorldIndex } from "../data/adapter";
   const world = await loadWorldData();
   const wi = toWorldIndex(world);          // 滿足 b2-interface-contract §2.4
   selectVisibleZones(state, wi);           // 簽名唔變
   ```
   `buildWorldIndex()` 過渡橋可以喺 B2 想清理時移除。

3. **Zone dossier（B6）流程**（lazy 已實測）：
   ```ts
   await loadDossiers(world);                        // 首次才 fetch 100 KB
   const d = getDossier(world, zoneId);              // 或 selectDossier(world, zoneId)
   ```
   `d.review_status === "needs_validation"` 或 field === `"unknown"` → 顯示「資料未足以確認」。

4. **搜尋（B7/B8）**：用 `searchSearchIndex(world.indexes.search, kind, query)` —— 5 類、無硬上限、實測 0.124 ms worst case。

5. **需要主代理裁決／跟進嘅三件事**：
   - **C1/C2**：`fallbackAnchors.ts` 真正搬入 adapter + `SvgMap.ts` 改 import → 需要改 `tests/phase-i.test.ts`（唔屬 B3 allowlist）。建議喺 B5 改寫 `SvgMap.ts` 時一併做。
   - **C3**：geojson gzip —— 建議部署後**實測** `curl -H "Accept-Encoding: gzip" -D -` 對 `application/geo+json` 嘅 `Content-Encoding`；若冇，修法喺部署層或改副檔名（B4）。
   - **C4**：`public/assets/map-lod/`（28 MB）+ basemap PNG（4 MB）死重 → 屬 B5 / 主代理。

6. **B3 交付檔案清單**：`docs/contracts/b3-interface-contract.md`、`src/data/adapter/{index,normalize,indexes,config}.ts`、`src/data/searchIndex.ts`、`tests/{data-adapter,data-indexes,search-index}.test.ts`、`docs/progress/b3-data-adapter-delivery.md`；改動：`src/data/loadAllData.ts`（3 行）、`vite.config.ts`（`emptyOutDir`）。

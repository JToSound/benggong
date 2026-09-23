# Phase 2（第二波：B3 / B5）進度報告 —— World Atlas V2

> 日期：2026-09-22 · branch：`refactor/world-atlas-v2` · baseline commit：`0260ecb`
> 依據：`docs/specs/world-atlas-v2-migration-plan.md` §4.1 依賴圖
> 前一波：`docs/progress/phase-2-wave1-b1-b2-b4.md`（B1 / B2 / B4）

---

## 1. 本波做咗咩

| 子代理 | Interface contract | 交付報告 | 狀態 |
|---|---|---|---|
| B3 Data Adapter | `docs/contracts/b3-interface-contract.md` | `docs/progress/b3-data-adapter-delivery.md` | ✅ |
| B5 Vector Map & LOD Renderer | `docs/contracts/b5-interface-contract.md` | `docs/progress/b5-renderer-delivery.md` | ✅（曾因 429 中斷，由收尾代理補完） |

> ⚠️ **流程備註**：B5 首次派遣因 API 額度（429）中斷。實作已完成 6 個模組 + contract，
> 但 delivery 報告未落盤。主代理發現後派收尾代理「核實已有實作 + 補跑量度 + 寫報告」，
> **冇由零重跑**。此為既定處理模式（同 Phase 1 嘅 A7 / A9 一致）。

---

## 2. B3 —— Data Adapter（解 A3/A8 嘅資料層缺失）

**交付**：`src/data/adapter/{index,normalize,indexes,config}.ts`、`src/data/searchIndex.ts`、`tests/{data-adapter,data-indexes,search-index}.test.ts`（45 項）。

| 指標 | 前 | 後 |
|---|---|---|
| 索引 | **冇**（10 處線性掃描 raw GeoJSON） | **12 個 Map/Set 索引**，建構總 **24.05 ms** |
| `eventsByZone` | — | 逐個 48 zone 同 B4 `event_ids` **完全一致**；覆蓋 **1627/1796 = 90.59%** |
| Search | 3 類 + 硬上限 50 | **5 類 + 無上限**；最慢單次 **0.149 ms**（預算 150 ms） |
| `timeline.json` | eager load（1.33 MB decoded / 195 KB 傳輸） | **已移除**（`grep` 確認 0 引用） |
| `zone-dossiers.json` | — | **lazy load**（首屏唔載入） |
| `dist/` | 56 MB | **51 MB**（stale JS 49→1、CSS 17→1） |
| `AppData` shape | — | **不變**（`git diff` 只有 3 行實質改動 + 4 條靜態斷言） |

**B3 未做（合理）**：geojson gzip。理由：GitHub Pages **唔 serve `.gz` sidecar**，加 build-time 壓縮只會令 `dist/` 增 3.9 MB 而零收益。建議部署後實測 `Content-Encoding` 再決定。

---

## 3. B5 —— Vector Map & LOD Renderer（解 A4/A8 四個 P0）

### 3.1 量度結果（全部程式化，`artifacts/b5/`）

| 項目 | Baseline（A4/A8） | B5 收尾 | 目標 | 判定 |
|---|---|---|---|---|
| **冷 zoom 合計阻塞** | 21,241 ms（20 task） | **842 ms**（8 task） | ≤300 ms | ❌ 未達標（但 **−96%**） |
| 冷 zoom 最長單一 task | 4,650 ms | **182 ms** | ≤300 ms | ✅ |
| 冷 zoom fps | 1.8 | **25.3** | — | ✅ ×14 |
| **Pan fps（中位）** | 28.9–30.9 | **54.35** | ≥55 | ❌ 差 1.2% |
| Pan p95 frame | 66.7 ms | **16.8 ms** | — | ✅（0 longtask） |
| **Zone（最大 zoom，相交）** | 0 | **9** | ≥3 | ✅ |
| **Event（最大 zoom，showAll）** | 0 | **53** | ≥5 | ✅ |
| **Tile POI** | 0 | **538** | >0 | ✅ |
| 建築 alpha | 0.14–0.42 | **0.35–0.65** | 0.35–0.65 | ✅ |
| 建築邊寬 | 0.35 px | **0.7 px** | 0.7 px | ✅ |
| `meanGrad`（細節量） | 9.12 | **12.27** | 提升 | ✅ +34.5% |

### 3.2 決定 D2 已生效（**最重要**）

| 項 | Baseline | 現在 |
|---|---|---|
| 初始視圖 render 嘅 zone 數 | **1** | **48** ✅ |
| 最大 zoom render 嘅 zone 數 | 0 | **48**（DOM）／9（相交） |
| 最大 zoom viewBox 寬 | 0.0200° | **0.0109°**（MAX_SCALE 35 → 64） |
| 最大 zoom label 數 | 6 | **49** |

**48 個 zone 永遠全部 render** —— 章節 gate（`c <= cur && cur <= c + 12`）已移除，章節只作 emphasis。

### 3.3 其他已落地項

- **`map-lod.ts`** —— 全專案唯一 Z 定義（`Z = log2(0.70/viewW)`）、門檻 `0.175` / `0.0219`、Zone LOD 三層（cluster / boundary / full）、basemap level 選擇。
- **模組抽離** —— `map-camera.ts`（309 行）、`MapViewport.ts`（348 行，含 rAF coalesce）、`BaseGeometryLayer.ts`（506 行，增量 `Path2D`）、`MapShell.ts`（282 行，layer 註冊介面供 B6 用）。
- **Bundle 唔再 emit raster PNG** —— build 輸出只有 `index.css` + `index.js`（36 modules）。`dist/assets/hk-basemap*.png` 仍存在，但係由 `public/` **直接複製**，非 Vite 打包 → **刪資產已安全**（Gate 2 執行）。

### 3.4 B5 如實記錄嘅未達標項（**唔可以虛報**）

1. **冷 zoom 合計 842 ms > 300 ms**。CDP 拆解：script 195 ms + layout 91 ms + recalc 49 ms，餘約 500 ms 係 20 次全量重繪。再壓低需 web worker（**禁止新依賴**）或改 `#map-zoom-in` 語意（兩個既有 e2e 依賴）。
2. **Pan 中位 54.35 fps < 55**。但 ≥95% frame 係 60 fps、0 longtask；headless software raster 可能比真 GPU 低 5–15%。
3. **新發現**：最大 zoom **idle** fps 只有 20.1 —— 由 **21 個 `.zone-pulse` CSS 動畫**單獨造成（`display:none` 後即返 60）。keyframes 喺 B1 嘅 CSS，**只報告、未擅自改視覺**。
4. **Deferred**：`tile_deg` 0.05°→0.02°（Q9 ≤1.0 MB）需重生成資產，而重生成要讀 `data/private/cache/osm-hk.json` → **本 pass 禁止**，延後。

---

## 4. 主代理整合發現（新增 2 項）

| # | 問題 | 處理 |
|---|---|---|
| 1 | **`emptyOutDir: true` 會間歇性令 build 失敗** —— Vite `prepareOutDir()` 直接呼叫 `emptyDir()`→`rmSync()`，**冇 try/catch**；環境嘅 safe-delete shim 喺 `dist/` 累積大量 stale 檔時會拋 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。 | 連續測 3 次 `npm run build` 皆 **exit=0**（guard 只在一次清理大量舊檔時觸發）。**保留 `true`**，但已記錄：如 build 失敗，先跑 `npm run clean`。⚠️ **唔可以用 `npm run build \| tail` 掩蓋 exit code**（我第一次就係咁樣睇漏）。 |
| 2 | **世界視圖下 48 個 zone 疊成一團** —— Zone LOD 嘅 `cluster` 層目前係「48 個各自 10 px 嘅 glyph 疊喺將軍澳同一點」，視覺上係一坨圓形，未達 spec §3.2「cluster glyph（帶 kind icon + 數量）」嘅要求。 | **列為 B6 必須處理項**（cluster 應該係單一 badge + 數量，唔係 48 個疊埋）。 |

---

## 5. 閘門結果（全綠）

| 命令 | 結果 |
|---|---|
| `npm run typecheck` | **0 error** ✅ |
| `npm run lint` | **0 error** ✅ |
| `npm run test` | **19 files / 298 tests 全綠** ✅（B3 前 195 → B3 後 240 → B5 後 298） |
| `npm run build` | ✅（36 modules；JS 155.40 kB / gzip 51.43 kB；CSS 52.37 kB / gzip 11.51 kB） |
| `python -m pytest -q` | **260 passed** ✅ |
| `python scripts/validate_public_data.py` | **✅ 全部通過** |
| `python scripts/audit_release.py` | **✅ PASSED**（128 檔、4668 記錄、needs_review 0） |

**執行期實測**（`artifacts/phase2-b5-visual-summary.json`）：

| 項 | 世界視圖 | 最大 zoom |
|---|---|---|
| zone（DOM） | **48** | **48** |
| label | 6 | **49** |
| theme | `dark` | `dark` |
| `<img>` 數 | **0** | **0** |
| page error | **0** | **0** |

截圖：`artifacts/screenshots/phase2-b5-{world-view,max-zoom}.png`、`phase2-{desktop-1440,tablet-768,mobile-390}.png`。

---

## 6. 已知限制（餘下 B6–B9 + Gate 2）

| # | 項 | 負責 |
|---|---|---|
| 1 | 世界視圖 48 zone 疊成一團（cluster glyph 未正規化） | **B6** |
| 2 | zone 仍然不可點（`pointer-events: none` + hit priority 未修） | **B6** |
| 3 | nav 仍係 8 個 emoji（B1 icon sprite 未接上） | **B6 / B8** |
| 4 | legend 仍只有色，冇 pattern / icon（spec §2.4 三通道） | **B6** |
| 5 | 右側面板仍 1320 卡 eager render，未 virtualize | **B7** |
| 6 | 最大 zoom idle fps 20.1（21 個 `.zone-pulse`） | **B6**（配合 B1 token） |
| 7 | 冷 zoom 合計 842 ms（未達 300 ms） | 需 web worker 或改 zoom 語意 → 待裁決 |
| 8 | pan 中位 54.35 fps（差 1.2%） | 真機 GPU 對照後再評 |
| 9 | 169 個塌縮座標被 `inferred_from` 鎖定 | 需上游 re-inference |
| 10 | `tile_deg` 0.05→0.02 未做（需讀 private cache） | 待授權或延後 |
| 11 | **過渡期雙軌**：舊 CSS import + `app.ts`/`router.ts` shim + `public/assets/map-lod/`（28 MB）+ `hk-basemap*.png`（4 MB） | **Gate 2 必須清** |

---

## 7. 下一步

依 migration plan §4.1：

1. **B6 Map Interaction** —— 依賴 B2 + B3 + B4 + B5 **全部已就緒** → **可以即刻派**。
   重點：zone cluster glyph 正規化、zone 可點 + hit priority、7 個 layer toggle、legend 三通道、map controls ≥44px、max zoom idle fps。
2. **B7 Chronicle Experience** —— 依賴 B2 + B3（已就緒）→ 可與 B6 並行。
3. 之後 **B8 Mobile + A11y**（依賴 B1 + B2 + B6）→ **B9 Visual QA Automation**。

**必須記住**：
- 每個 B agent 只可改 allowlist 範圍，唔可以 mass format。
- 所有驗收必須程式化、可重跑；**唔可以**寫「人手覆核」「人手抽樣」。
- 改完 source 必須 `npm run build`，e2e 才會見到改動。

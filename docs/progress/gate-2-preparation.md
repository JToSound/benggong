# Gate 2（Legacy Cleanup）準備文件

> 日期：2026-09-23
> 依據：`docs/specs/world-atlas-v2-migration-plan.md` §5（整合順序）、§6（清理清單）
> 狀態：**準備中**（B9 完成後執行）
> ⚠️ 本檔係**主代理親自核實嘅現況**，唔係照抄 spec。

---

## 0. 為何要呢份文件

Spec §6.1 係 **Gate 1（2026-09-21）** 產出，當時對 V2 實作嘅假設**部分已經被推翻**。
如果照抄清單去刪，會**刪走 V2 嘅核心模組**。

本檔逐項核實現況，標記「仍然有效」／「已過時」／「新增項」。

---

## 1. Spec §6.1「必須刪除」—— 逐項核實

### 1.1 ⚠️ Component 項：**大部分已過時**

| spec 寫 | 現況 | 判定 |
|---|---|---|
| `src/app.ts` | **存在，766 行**（原 441 行）—— 已由 B2 重構為 AppShell，B8 接線再加咗 9 個呼叫點 | ❌ **過時**，保留 |
| `src/router.ts` | **存在，50 行** —— legacy shim（`#ch=` / `#loc=` 向後兼容） | ✅ **裁決保留**（見 §1.1.1） |
| `src/components/SvgMap.ts` | **存在，2,322 行** —— 已由 B5/B6 重寫成 V2 renderer；被 **25 個檔**引用（`src/` + `tests/`） | ❌ **過時**，**絕對唔可以刪** |

**為何 spec 會過時**：Gate 1 假設 V2 會用**全新 renderer 取代** `SvgMap.ts`。
實際 B5/B6 選擇**重寫**佢（`SvgMap.ts` 1,840 → 2,322 行），而 `MapControls`、`ZoneLayer`、
`#svg-map`、`map.css` 全部掛喺佢身上，大量 e2e 依賴 `#svg-map`。

### 1.1.1 `router.ts` 裁決：**保留**（推翻 spec §6.1）

**主代理實測調查（2026-09-23）**：

| 事實 | 證據 |
|---|---|
| `router.ts` 係 legacy shim，只負責 **`hashchange`** | `src/router.ts:41` `window.addEventListener("hashchange", …)` |
| `state/index.ts` **只**處理 `popstate` | `src/state/index.ts:100` `window.addEventListener("popstate", onPopState)` |
| `state/index.ts:83` 明文：「hashchange 由 legacy shim `src/router.ts` 負責（保留 `#ch=` / `#loc=` 向後兼容）」 | 檔案註解 |
| `#ch=` / `#loc=` 係 **spec §6.2 明文要求保留** | migration-plan §6.2「`#ch=` / `#loc=` legacy alias」 |
| 初始 hash 載入**唔需要** `router.ts` | `url.ts:180` `parseHashParams` + `fromUrl()` 已處理；`main.ts` 嘅 `hydrateFromUrl()` 用它 |
| 但**運行中** hashchange **只有** `router.ts` 處理 | 冇其他 listener |
| **冇任何測試**覆蓋運行中 hashchange | `visual-smoke.e2e.test.ts:471` 只做 `page.goto(`${BASE_URL}/#ch=150`)`（初始載入） |

**裁決：保留 `router.ts`。** 理由：
1. 佢實作 §6.2 **明文要求保留**嘅 legacy alias —— 刪咗會令 §6.1 同 §6.2 直接衝突
2. **冇測試覆蓋運行中 hashchange** → 刪咗係「**靜默失去功能**」（唔會有測試變紅）
3. `AGENTS.md` 要求「採**最保守、可逆**、可稽核決策」
4. 成本只 50 行；風險係舊分享連結（帶 `#ch=`）喺運行中改變時失效

**→ 裁定：`SvgMap.ts` 同 `app.ts` 保留；`router.ts` 亦保留。spec §6.1 Component 項全部推翻。**

### 1.2 CSS 項：**仍然有效**

| 項 | 現況 | 動作 |
|---|---|---|
| `src/styles/main.css`（2,047 行） | 存在，58,760 B | 刪（但要先確認 V2 CSS 已完全覆蓋） |
| `src/styles/hud.css`（785 行） | 存在，22,714 B | 刪 |
| `src/styles/timeline.css`（430 行） | 存在，8,183 B | 刪 |
| 重複 CSS（`main.css:1496-2047` 同 `hud.css` 逐字重複） | 未核實 | 刪（連同上面三個檔） |
| 死 CSS（43 個 class 搵唔到 TS 引用） | 未核實 | 刪 |
| 死 keyframes（11 個之中 8 個未運行） | 未核實 | 刪 |
| 死 token（`--color-*` 12 個從未定義） | 未核實 | 刪 |

⚠️ **刪 CSS 之前必須先確認**：
- `main.css:458` 嘅 `.zone-area { pointer-events: none; }` 已被 B6 用
  `#svg-map .zone-area`（特異度 `(1,1,0)`）覆蓋 —— 刪咗舊規則之後，
  B6 嘅 id 特異度**仍然有效但唔再必要**
- `mobile.css`（B8）同 `map.css`（B6）用咗 **`!important`** 蓋過舊 CSS ——
  刪舊 CSS 之後**可以移除 `!important`**（簡化）
- `panel-toggle` 喺 `main.css:1061`（`display: none`）—— 刪咗之後要喺新 CSS 重現呢個行為

### 1.3 資產項：**主代理實測後修正 spec**

| spec 寫 | 主代理實測 | 判定 |
|---|---|---|
| `public/assets/map-lod/`（28 MB） | **28 MB**，`SvgMap.ts:103` 註解確認「13 層 raster pyramid 已經確認 **0 次參與**」 | ✅ **可刪** |
| `hk-basemap-coords.json`（1,088 B） | ⚠️ **被 `src/components/SvgMap.ts:63` import**（`import basemapCoords from "../../public/assets/hk-basemap-coords.json"`） | ❌ **唔可以刪**（刪咗 build 失敗） |
| `hk-basemap.png`（1,978,248 B） | 喺 `SvgMap.ts:107` 嘅 `RASTER_FALLBACK.image` | ⚠️ **待裁決**（見下） |
| `hk-basemap-labels.png`（131,687 B） | 喺 `SvgMap.ts:108` 嘅 `RASTER_FALLBACK.labelLayer` | ⚠️ **待裁決** |
| 空目錄 ×4 | 實測 **5 個**：`public/assets/{attribution,generated,map-tiles,markers,ui}` | ✅ 可刪 |

#### 1.3.1 ⚠️ 命名混淆陷阱：`map-lod` 有**兩個意思**

| 路徑 | 性質 | 處置 |
|---|---|---|
| `public/assets/map-lod/` | **raster pyramid 資產**（28 MB） | ✅ 刪 |
| `src/map/map-lod.ts` | **TS 模組**（LOD 邏輯，B5 核心） | ❌ **絕對保留** |

**→ `grep "map-lod"` 會命中兩者。刪嘢之前一定要睇清楚係 `public/assets/` 定 `src/map/`。**

#### 1.3.2 `hk-basemap*.png` 裁決：**保留**

**矛盾點**：
- spec §6.1 話「必須刪除」`hk-basemap.png` / `hk-basemap-labels.png`
- 但 spec §6.2 話「**必須保留** `fallbackToRaster()`（emergency fallback，**唔設預設 href**）」

**分析**：
- `fallbackToRaster()` 係**程式碼路徑**，spec §6.2 明確要保留
- 佢引用 `RASTER_FALLBACK.image` / `.labelLayer`（即嗰兩個 PNG）
- 「唔設預設 href」= 正常情況**唔會請求**佢哋
- 但**向量底圖載入失敗**時（emergency），fallback 會請求 → 若資產已刪就會 **404**

**裁決：保留兩個 PNG（合計 2.1 MB）**。理由：
1. spec §6.2 明文要求保留 fallback 機制 —— 刪資產等於令 fallback **靜默失效**
2. 成本只 2.1 MB（相對 28 MB 嘅 raster pyramid 係小數）
3. `AGENTS.md` 要求「最保守、可逆」

**→ 只刪 `public/assets/map-lod/`（28 MB）+ 5 個空目錄，共省 28 MB。**

### 1.4 Script 項：**仍然有效**

| 項 | 動作 |
|---|---|
| `scripts/build_map_lods.py` | 刪（raster 路徑） |
| `scripts/render_binggang_map.py` | 刪 |
| `scripts/render_hk_basemap.py` | 刪 |
| `scripts/derive_zones.py` | 刪（已由 `merge_zone_dossiers.py` 取代） |

### 1.5 State / Listener 項：**要重新核實**

| 項 | 說明 |
|---|---|
| `App` 4 個 selection 欄位 | B2 已引入單一 store → 舊欄位應已無用，但要逐個核實 |
| `viewMode` private | 同上 |
| DOM 內 6 個 state class/attribute | 同上 |
| 50 個 `addEventListener` vs 1 個 `removeEventListener` | **B8 已引入 `inert` 同 focus trap，情況可能已變** → 重新量度 |

---

## 2. Spec §6.2「必須保留」—— 確認

| 項 | 狀態 |
|---|---|
| `src/exportMap.ts` | ✅ 保留（唯一可保留模組） |
| `theme.ts` 嘅 `basemap-theme-change` 事件 | ✅ 保留（Canvas 唔會讀 CSS 變數） |
| `VectorBasemap` 嘅 Canvas `Path2D` 快取 + `setTransform` | ✅ 保留（效能關鍵） |
| `fallbackToRaster()` | ✅ 保留（emergency fallback，唔設預設 href） |
| `#ch=` / `#loc=` legacy alias | ✅ 保留（`tests/visual-smoke.e2e.test.ts` 依賴） |
| `artifacts/audit-A1/*.mjs` | ✅ 保留（baseline 對照腳本） |
| `artifacts/audit-A9/a9-gaps.log` | ✅ 保留（假陽性對照） |
| `tests/` 全部現有測試 | ✅ 保留（改為驗證新 spec） |

---

## 3. 🔴 Spec §6.3「零人手違規」—— **實測仍有 332 處未修**

### 3.1 現況（主代理實測，2026-09-23）

```
data/public/asset-manifest.json     1 處
data/public/characters.json       330 處   ← 主體
data/public/map-config.json         1 處
public/data/public/*                （同步副本，同樣數字）
```

**實際文案樣本**：

```
"待人工審閱。已發佈內容經自動驗證，但角色路線來源自私有審閱文件，未經最終人工確認。請勿引用作準確資料。"
"待人手審閱。"
"待人手審閱後逐項指派位置。"
"routes 為空：等位置-事件關聯經人手確認後先建立，避免捏造路線。"
```

### 3.2 為何係紅線

`AGENTS.md`「🚫 零人手參與（強制）」明文：

> **唔要任何人手抽樣覆核，唔要任何人手參與。**

而且呢啲文案係**面向公眾嘅**（`data/public/**` 會 deploy 到 GitHub Pages）。

### 3.3 ⚠️ 修復陷阱：**唔可以一律刪「人手」二字**

主代理實測發現，小說**正文**亦有「人手」：

```
data/public/chapter-summaries.json:3055  "大本營係大舊及其學生據守嘅倖存者基地…今次戰鬥後派出大批人手出來支援。"
data/public/chronicle.json:1566          "病窩深處佈滿多隻人手製作的花牌、深紅似血的長地毯…"
data/public/chronicle.json:8338          "六名學生進行同伴間的「搭手儀式」，最終六個人手貼手搭在一起。"
```

呢啲係**正文內容**，屬版權紅線，**絕不可以改**。
（同 `AGENTS.md` 講嘅「『喜歡』『分享』『展開』等詞常為正文一部分，清理時絕不可當 UI token 刪除」同理。）

**→ 必須精確區分「元資料文案」vs「小說正文」。**

### 3.4 正確修法：**改 pipeline，唔係改輸出**

`data/public/**` 係由 pipeline 產生（`scripts/build_public_dataset.py` 等）。
只改 JSON 輸出 → **下次跑 pipeline 會還原**。

**要改嘅係產生嗰啲文案嘅 script**。

要追查：
- `characters.json` `description` 嘅產生位置
- `asset-manifest.json` 嘅 `note`
- `map-config.json` 嘅 `provisional_mode.banner`

**建議替代措辭**（自動驗證語氣）：
| 原文 | 建議 |
|---|---|
| 「詳情待人手審閱。」 | 「詳情待自動推斷。」 |
| 「待人手審閱後逐項指派位置。」 | 「座標由自動流程指派。」 |
| 「未經最終人工確認」 | 「經自動驗證流程判定」 |
| 「等位置-事件關聯經人手確認後先建立」 | 「待自動關聯推斷完成後建立」 |

⚠️ 要加 **pytest 斷言**防回歸（掃 `data/public/**` 元資料欄位，禁止「人手審閱」字眼）。

### 3.5 §6.3 其他項

| # | 項 | 現況 |
|---|---|---|
| 1 | `map-config.json` `provisional_mode.banner` | ⚠️ **仍有違規字眼**（見 §3.1） |
| 2 | `characters.json` `description` | ⚠️ **仍有 330 處** |
| 3 | `scripts/apply_location_corrections.py` 改全程式化 | 未核實 |
| 4 | `zones.geojson` `evidence` 含原文 | ✅ **B4 已完成**（48/48 → 0） |

---

## 4. 主代理新增項（spec 冇列，但實際要清）

| # | 項 | 來源 |
|---|---|---|
| N1 | `src/main.ts` 舊 CSS import 三行（`main.css` / `timeline.css` / `hud.css`） | B1 過渡期雙軌 |
| N2 | `vite.config.ts` 嘅 `dist-stale-*/**` exclude | B6 第二輪（B6 自己實測證偽，屬無害防禦性聲明） |
| N3 | 檢討 `map.css` / `mobile.css` 嘅 `?inline` 注入機制 | B6/B8（舊 CSS 移除後特異度必要性消失） |
| N4 | `#chapter-strip` 改 `overflow-x: auto` | B8 P1-1 副作用（`body.scrollWidth` 1590–1677） |
| N5 | `SvgMap.ts` 嘅 W7（zone/marker `tabindex`）/ W8（legend 摺疊） | B8 遺留接線項 |
| N6 | `StoryPanel.ts:162` 角色 dossier 內容（現為 `console.log` + TODO） | B8 遺留（P0-5 部分） |
| N7 | token 層對比修正（dark 12 / light 6 違規） | B8 遺留（P2-3） |
| N8 | `SvgMap.clampView()` overview 平移提示 | B8 遺留（P2-6） |
| N9 | `map-lod/` 28 MB + `hk-basemap*.png` 4 MB 實際刪除 | 同 spec §6.1 |
| N10 | `scripts/` 內 raster 路徑 script 刪除 | 同 spec §6.1 |
| N11 | `mobile.css` / `map.css` 內嘅 `!important` 移除 | 舊 CSS 刪除後唔再需要 |

---

## 5. 執行順序（建議）

| 步 | 動作 | 風險 |
|---|---|---|
| 1 | 核實 `router.ts` 功能已由 B2 URL contract 取代 → 刪 | 中（要跑全套測試） |
| 2 | 修 §3 零人手違規（改 pipeline + 加 pytest 防回歸） | **高優先**（用戶紅線） |
| 3 | 刪 raster 資產（28 MB + 4 MB）+ 對應 script | 低（B5 已唔用） |
| 4 | 刪舊 CSS 三檔 + `main.ts` 三行 import | **高**（要驗證 V2 CSS 完全覆蓋） |
| 5 | 移除 `mobile.css` / `map.css` 內嘅 `!important` | 中 |
| 6 | 清理 `vite.config.ts` 嘅 `dist-stale-*/**` | 低 |
| 7 | 逐項核實死 CSS / 死 keyframes / 死 token / 死 state | 中 |
| 8 | 跑全套閘門 + `audit_release` + `validate_public_data` | — |
| 9 | 寫 `docs/progress/gate-2-legacy-cleanup.md` | — |

⚠️ **每步之後都要跑全套測試**（`30+ files / 612+ tests`）——
B8 就係因為只跑部分而漏咗回歸。

---

## 6. 風險登記

| 風險 | 影響 | 緩解 |
|---|---|---|
| 刪舊 CSS 令版面解體 | 高 | 先逐條規則核實有冇 V2 對應；分階段刪；每階段跑 e2e |
| 刪 `router.ts` 令 URL 還原失效 | 中 | 先確認 B2 `hydrateFromUrl` + `bindUrlSync` 已完全取代 |
| 誤刪正文「人手」 | **極高**（版權紅線） | 只改元資料欄位；加 pytest 斷言只掃元資料 |
| 改 pipeline 令輸出變動 | 中 | 跑 idempotency 測試（SHA-256 比對） |
| 刪資產後 fallback 失效 | 低 | `fallbackToRaster()` 保留，只刪資產 |

---

## 7. 結論

- **Spec §6.1 嘅 Component 項大部分過時**（`app.ts`、`SvgMap.ts` 已重寫，唔可以刪）
- **§6.3 零人手違規仍有 332 處未修** —— **最高優先**，且要改 pipeline 唔係改輸出
- **刪 CSS 係最高風險步驟** —— 要分階段 + 每階段跑全套測試
- **新增 11 項**（N1–N11）來自 B6/B8 嘅遺留同副作用

---

## 8. 執行進度（主代理核實）

### ✅ 8.1 §6.3 零人手違規 —— **已完成**（2026-09-23）

報告：`docs/progress/gate-2-zero-manual-review.md`
（⚠️ 原檔名 `gate-2-legacy-cleanup.md` 被 `.gitignore:13` 嘅 `*clean*.md` 忽略，
主代理已改名 → 唔再被忽略）

**主代理獨立核實**：

| 檢查 | 結果 |
|---|---|
| 違規清零（`data/public` + `public/data/public`） | ✅ **332 → 0** |
| 正文完整（`派出大批人手`） | ✅ **1**（原封不動） |
| 正文完整（`chronicle` 內「人手」） | ✅ **7**（原封不動） |
| 資料量基線 | ✅ locations 704 / events 1796 / zones 48 / **characters 330** |
| `dist/data/public` 一致性（5 個關鍵檔 SHA-256） | ✅ **全部 SAME** |
| pytest | ✅ **278 passed**（260 → 278，+18 條防回歸） |

**修法（雙軌）**：
1. **治本**：改 `scripts/build_public_dataset.py:517/703/755/756` 嘅文案
2. **治標**：新增 `scripts/normalize_public_wording.py`
   （**白名單限定**、idempotent、支援 `--check`），接入 `run_pipeline.py` 第 15 步
3. `data/public/map-config.json:40` 嘅 banner —— **靜態檔，冇 script 產生**，直接改 source

**安全網**：正規化器只掃白名單 key（`description` / `note` / `notes` / `banner` / `disclaimer`）；
違規字眼一旦落喺**非白名單**欄位即**中止**（防止誤改正文）。

### 🔴 8.2 新發現：`characters.json` **唔可以由 pipeline 重現**（嚴重，未解）

**代理實測**：
- `scripts/build_public_dataset.py` **唔喺 `run_pipeline.py` 內**
- 重跑會令 `characters.json` **330 → 344**（**遺失 11 個已合併角色**）
- 而且會連帶覆蓋 `locations.geojson`（產生器只出 **629**，現有 **704**）

**即係話**：現有 `data/public/characters.json` 係「**手工累積**」狀態，產生器已過時。

⚠️ **呢個違反 `AGENTS.md`「可重跑、可稽核」原則** —— 任何人重跑 pipeline 都會損壞資料。

**緩解（代理已做）**：文案正規化獨立成 `normalize_public_wording.py`，
**唔需要重跑產生器**。

**建議進一步緩解**（Gate 2 或之後）：
加**守門斷言** —— pipeline 跑之前/之後檢查輸出數量唔會**減少**
（例如 `characters >= 330`、`locations >= 704`），減少即中止。

**根治**需要重建 Phase B 流程（令產生器可重現），屬較大工作。

### ⚠️ 8.3 遺留：`data/schemas/*.json` 仍有「人手審閱」

```
data/schemas/event.schema.json:108        "null = 未指派（待人手審閱或後續 pipeline）。"
data/schemas/place-inference.schema.json:4  "title": "…（私有，需人手審閱）"
data/schemas/place-inference.schema.json:5  "…推斷結果必須經人手審閱，才可以升級 location_precision 或改座標。"
data/schemas/place-inference.schema.json:37 "…方便人手審閱。"
```

**性質**：
- 呢啲係 **schema 文件**（唔 deploy、唔影響 runtime）
- 但 `place-inference.schema.json` 係**設計層面明文要求人手審閱** —— 同 `AGENTS.md` 直接衝突
- 屬**規則一致性**問題，低優先（唔影響 deploy）但應該修

**建議**：改為自動驗證語氣（例如「待自動推斷」「經多代理交叉驗證」），
並加 pytest 斷言（掃 `data/schemas/**`）。

### ⚠️ 8.4 `npm run build` 被 host 刪除守衛攔（環境問題，已繞過）

代理報告：清 `dist/assets` >50 檔時撞 safe-delete 守衛。

**代理處理**：手動複製 3 個 JSON 入 `dist/data/public/`。

**主代理核實**：`dist/data/public/` 5 個關鍵檔 SHA-256 **全部 SAME** → 手動複製正確。

⚠️ 但呢個係**繞過**，唔係修復。`dist/` 係 build 產物（gitignored），
下次 `npm run build` 會經 `prebuild` 嘅 `sync-data` 重新同步（正常）。
**標準繞法**仍然係 `mv dist dist-stale-$(date +%s)` 再 build（見 E11）。

### 8.5 下一步

| 步 | 動作 | 狀態 |
|---|---|---|
| 1 | 核實 `router.ts` | ✅ 完成（裁決保留） |
| 2 | 修 §6.3 零人手違規 | ✅ 完成（332 → 0，pytest 278） |
| 3 | 刪 raster 資產 28 MB + 空目錄 | ✅ 完成（49M→21M） |
| 4 | 刪舊 CSS 三檔 + `main.ts` 三行 | ❌ **裁決唔刪**（見 §9） |
| 5 | 移除 `!important` | ❌ 連帶（見 §9） |
| 6 | 清 `vite.config.ts` 嘅 `dist-stale-*/**` | ⏳ |
| 7 | 核實死 CSS / keyframes / token / state | ⏳ 部分（見 §9） |
| 8 | 修 `data/schemas/**` 違規 + 加斷言 | ⏳ 低優先 |
| 9 | 加 `characters.json` 守門斷言 | ⏳ 建議 |
| 10 | 跑全套閘門 + 寫 Gate 2 報告 | ⏳ |

---

## 9. 🔴 舊 CSS 移除 —— **裁決唔刪**（推翻 spec §6.1，2026-09-23）

### 9.1 主代理程式化分析（`artifacts/gate2/analyze-legacy-css.py`，只讀）

```
【規模】
  src/styles/main.css      2,047 行   173 個 class
  src/styles/hud.css         785 行    53 個 class
  src/styles/timeline.css    430 行    30 個 class
  合計                     3,262 行   202 個 class（去重）

  V2 CSS 定義嘅 class：134

【分類】
  ① 死 CSS（舊有但 src/ 零引用）        44 個  → 可安全刪
  ② ⚠️ 風險點（有引用但 V2 冇定義）     80 個  → **刪咗會壞**
  ③ 已覆蓋（有引用且 V2 有定義）        78 個
  ④ V2 新增（舊 CSS 冇）                56 個
```

### 9.2 關鍵發現：**80 個 class 仍然被引用但 V2 CSS 冇對應定義**

**呢個直接推翻 spec §6.1「舊 CSS 必須刪除」嘅前提** —— 舊 CSS 唔係死碼，
而係**仍然承載 80 個 class 嘅樣式**。

**風險點清單（節錄）**：

| 類別 | Class | 影響 |
|---|---|---|
| **a11y 關鍵** | `.skip-link` | 跳去主內容連結（B8 P0-2 依賴） |
| **向量底圖** | `.basemap-layer`、`.basemap-vector-failed` | ⚠️ **Phase L 樣式仍然住喺 `main.css`，冇搬去 V2** |
| **Zone Dossier** | `.zd`、`.zd-*`（約 25 個） | dossier 面板全部樣式 |
| **StoryPanel** | `.story-*`（8 個） | 故事面板 |
| **Modal** | `.modal-backdrop`、`.modal-content`、`.modal-body`、`.modal-header` | AboutModal |
| **錯誤畫面** | `.bg-error-panel`、`.bg-error-detail`、`.bg-error-hint`、`.bg-retry-btn` | `main.ts` 嘅 `showError()` |
| **其他** | `.panel-toggle`、`.chapter-strip`、`.char-chip`、`.route-*`、`.event-*` | 各面板內容 |

⚠️ **特別注意 `.basemap-layer` / `.basemap-vector-failed`**：呢啲係 **Phase L（向量底圖）**
嘅規則（09-20 改動），佢哋**從來冇搬去 V2 CSS**。刪 `main.css` 會令向量底圖**壞掉**。

### 9.3 裁決：**唔刪舊 CSS**（至少唔係 Gate 2 範圍內）

**理由**：
1. **80 個風險點未遷移** —— 遷移係「功能工作」（逐個 class 判斷 V2 是否需要 + 重建樣式），
   唔係「清理工作」
2. **風險極高** —— 刪咗會令大量 UI 失去樣式（版面解體）
3. **價值有限** —— 省 59 KB CSS（gzip 12 KB），相對 80 個 class 嘅遷移工作量唔成比例
4. `AGENTS.md` 要求「採**最保守、可逆**、可稽核決策」
5. Gate 2 嘅**主要目標已達成**（零人手違規 332→0、raster 28 MB）

**連帶影響**：
- **§5「移除 `!important`」亦推遲** —— `mobile.css` / `map.css` 用 `!important` 蓋過舊 CSS；
  舊 CSS 未刪，`!important` 就仍然必要
- **`main.css:458` 嘅 `.zone-area { pointer-events: none; }` 繼續由 B6 嘅
  `#svg-map .zone-area`（特異度 `(1,1,0)`）覆蓋** —— 現狀有效

### 9.4 建議嘅正確做法（Phase 3 之後或獨立工作）

**分階段遷移**（每階段跑全套測試）：

| 階段 | 動作 | 驗證 |
|---|---|---|
| 1 | 將 `.basemap-*` 遷入 `map.css`（向量底圖係 V2 核心） | e2e 底圖測試 |
| 2 | 將 `.zd-*`（25 個）遷入新 `zone-dossier.css` | Zone Dossier e2e |
| 3 | 將 `.story-*` / `.modal-*` / `.skip-link` 遷入對應 V2 CSS | a11y e2e（skip-link 係 P0-2） |
| 4 | 將 `.bg-error-*` 遷入 `base.css` | 錯誤路徑測試 |
| 5 | 刪 44 個死 CSS + 舊檔 | 全套測試 |

⚠️ **每階段之後必須跑全套測試**（33 files / 612 tests）——
B8 就係因為只跑部分而漏咗回歸。

### 9.5 分析工具嘅已知誤差

`artifacts/gate2/analyze-legacy-css.py` 基於 regex class 提取 + 字串匹配，可能有誤差：
- class 可能由變數拼成（例如 `` `ch-pill-${n}` ``）→ 會誤判為「死」
- CSS 內嘅 `.foo` 可能喺字串內 → 已去註解，但字串未處理
- **所以 44 個「死 CSS」唔應該盲刪** —— 要逐個確認

**→ 亦係唔應該輕率刪除舊 CSS 嘅另一個理由。**

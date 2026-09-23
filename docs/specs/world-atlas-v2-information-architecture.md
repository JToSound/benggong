# World Atlas V2 — Information Architecture

> **Gate 1 交付物 2／8** · 狀態：**定稿**
> 依據：spec §1.2、§3、§5.1；A1（IA 倒置）、A3（URL contract）、A9（URL 實測）、A6（layer control）

---

## 1. 核心原則

| # | 原則 | 對應現況問題（A1 實測） |
|---|---|---|
| IA-1 | **Map first, data second, detail on demand** | 首屏可見文字 98.1% 係編年史（45,358/46,246 字元），地圖只有 84 字元 |
| IA-2 | **一個主 context** | 同一時間 zone dossier + story panel + chronicle 三個 mount 並存，`setViewMode` 語意混亂 |
| IA-3 | **地圖係可讀世界，不只係 marker 畫布** | 48 個 zone 首章只 1 個 render，且 0% 可點 |
| IA-4 | **資料可信度可見** | 冇 precision 顯示；event detail 顯示原始 id `loc_0014` |
| IA-5 | **深度可漸進** | 1320 卡 eager render；0 個篩選器 |

---

## 2. 單一 Primary Context 模型

同一時間**只有一個** `PrimaryContext`。呢個係 IA 嘅憲法。

```ts
type PrimaryContext =
  | { kind: 'explore' }
  | { kind: 'search';   query: string }
  | { kind: 'zone';     zoneId: string }
  | { kind: 'event';    eventId: string }
  | { kind: 'location'; locationId: string }
  | { kind: 'character'; characterId: string }
  | { kind: 'route';    characterId: string }
  | { kind: 'chronicle'; filters: ChronicleFilters }
  | { kind: 'chapter';  issueIndex: number }
  | { kind: 'measure' };
```

### 2.1 Context ↔ 表面（surface）映射

| PrimaryContext | 地圖行為 | 主表面 | 次要表面 |
|---|---|---|---|
| `explore` | 顯示全部 48 zone（D2）+ 當前章事件 | 無 panel（或 onboarding card） | legend、layer control |
| `search` | 保持現狀 viewport | search overlay（modal / sheet） | — |
| `zone` | fly-to polygon + soft-focus 其他 | **Zone Dossier panel / bottom sheet** | 相關事件／角色／時間軸 quick links |
| `event` | fly-to location | Event detail panel / sheet | chapter / zone / timeline deep links |
| `location` | fly-to location | Location detail | 所屬 zone、相關事件 |
| `character` | 突出該角色出現過嘅 zone / location | Character dossier | route 入口、chapter refs |
| `route` | **只**強調該 route + waypoint + zone 關係 | Route panel（waypoint list） | waypoint fly-to |
| `chronicle` | 保留 viewport，地圖 dimmed 或並列 | **Chronicle view（full drawer / view）** | card → map deep link |
| `chapter` | 更新章節強調（**唔過濾 zone**） | Chapter strip 狀態 + story panel | — |
| `measure` | 量度覆蓋層 | Measure HUD | 清除／取消 |

> ⚠️ **由 `zone` 轉 `event` 必須明確切換 context**。現行 bug：zone 模式下點 event 寫入隱藏 story panel 而唔切 view，mode 標籤仍顯示「◈ 區域」（A9 P0-4）。

---

## 3. URL Contract（定稿）

### 3.1 參數表

| 參數 | 型別 | 對應 | 現況 | V2 |
|---|---|---|---|---|
| `?event=<id>` | string | `{kind:'event'}` | ❌ 唔支援 | ✅ |
| `?zone=<id>` | string | `{kind:'zone'}` | ❌ 唔支援 | ✅ |
| `?location=<id>` | string | `{kind:'location'}` | ⚠️ 只有 `#loc=` | ✅（`#loc=` 保留 alias） |
| `?character=<id>` | string | `{kind:'character'}` | ❌ 唔支援 | ✅ |
| `?route=<characterId>` | string | `{kind:'route'}` | ❌ 唔支援 | ✅ |
| `?chapter=<issue_index>` | int 1–198 | `{kind:'chapter'}` | ❌ `?chapter=150` 被完全忽略 | ✅ |
| `?spoiler=<0-3>` | int | spoiler 上限 | ❌ 唔支援、無持久化 | ✅ |
| `?layers=<csv>` | csv | layer 開關 | ❌ 唔支援 | ✅ |
| `?view=map\|chronicle` | enum | 主視圖 | ❌ 唔支援 | ✅ |
| `?measure=<csv>` | csv of ids | `{kind:'measure'}` | ❌ | ✅ |
| `?q=<query>` | string | `{kind:'search'}` | ❌ | ✅ |

### 3.2 規則

1. **統一 query string**（D5）。`#` 只用於 in-page anchor。
2. **Legacy alias（必須保留）**：`#ch=<n>` → `?chapter=<n>`；`#loc=<id>` → `?location=<id>`。現有 `tests/visual-smoke.e2e.test.ts` 依賴 `#ch=150`，**唔可以拆**（A9 integration note 第 3 點）。
3. **Precedence**：`?chapter=` > `#ch=`；`?location=` > `#loc=`。
4. **Normalization**：寫入時用 canonical 形式（query）；讀取時接受 alias。同一 state 只可以有一個 canonical URL（避免 `?chapter=150#ch=150`）。
5. **無效 ID → graceful fallback**：
   - 無法解析 → 落回 `explore`，**唔 crash、唔白畫面、唔寫 pageerror**。
   - 存在但已 quarantine → 保留 context，但 detail 顯示「位置未能可靠確認」（Journey D）。
   - 型別錯（`?spoiler=99`）→ clamp 到合法範圍 + `console.warn`（**唔可以** `throw`）。
6. **Refresh 必須重現**：selection、spoiler、主要 layer、view。
7. **URL 更新時機**：所有 context 轉換都要 `replaceState`（唔製造 history spam），只有「用戶主動導航」用 `pushState`。

### 3.3 現況違反（A9 實測）

| 項 | 實測 |
|---|---|
| 支援參數 | 只有 `#ch=`、`#loc=`（**兩者皆非 spec 格式**） |
| zone 選擇入 URL | ❌ `setSelectedZone` 冇呼叫 `syncHash()` |
| event 選擇入 URL | ❌ 完全唔寫（`src/app.ts:420-426`） |
| `?chapter=150` | 靜默忽略 → `activeCh` 仍 `1`、chronicle 顯示「1320 條 · 全部章節」 |
| hash 形式 `#chapter=` / `#event=` / `#zone=` | 靜默忽略（**唔 crash** —— 前次 `crash=true` 係 preview server 未起嘅假陽性） |
| 無效輸入（10 項含 500 字超長 id、控制字元） | 全部 graceful，零 crash |

---

## 4. 資訊架構圖

```
┌─────────────────────────────────────────────────────────────────────┐
│  HEADER                                                             │
│  H1 《病港》世界地圖   [探索地區][搵角色][搵事件][打開編年史]          │
│                        [spoiler ▾] [主題] [?] [關於]                 │
├─────────────────────────────────────────────────────────────────────┤
│  CHAPTER STRIP（198 章，virtualized 橫向）                            │
├──────────────────────────────────┬──────────────────────────────────┤
│                                  │  CONTEXT SURFACE                 │
│   MAP（Primary）                 │  ┌────────────────────────────┐  │
│   ├ VectorBasemap（Canvas）      │  │ explore → onboarding card  │  │
│   ├ ZoneLayer（Polygon）         │  │ zone    → Dossier          │  │
│   ├ RouteLayer                   │  │ event   → Event detail     │  │
│   ├ EventLayer / MarkerLayer     │  │ route   → Waypoint list    │  │
│   ├ LabelLayer                   │  │ character → Dossier        │  │
│   └ MeasureLayer                 │  │ chronicle → Chronicle view │  │
│                                  │  └────────────────────────────┘  │
│   [LAYER CONTROL]  [LEGEND]      │                                  │
│   [ZOOM +/−]  [SCALE BAR]        │                                  │
└──────────────────────────────────┴──────────────────────────────────┘
```

**Mobile（<768px）**：context surface 變成 **bottom sheet**（3 段 snap：peek 25% / half 55% / full 92%），header 收成單行 + overflow menu，legend 變成可摺疊 chip row。

---

## 5. Entry Points（Journey A）

### 5.1 四個主入口（必須全部存在、可鍵盤達、≥44×44px）

| 入口 | 行為 | URL |
|---|---|---|
| `探索地區` | 顯示全部 48 zone + 開 zone layer + 顯示 legend | `?view=map&layers=zones` |
| `搵角色` | 開 search，filter 預設 `character` | `?q=&kind=character` |
| `搵事件` | 開 search，filter 預設 `event` | `?q=&kind=event` |
| `打開編年史` | 切去 chronicle view | `?view=chronicle` |

### 5.2 現況（A1 實測）

- 頂部 8 個 nav 按鈕：📜編年史 / 🔍搜尋 / 🔗 / ⬇ / ☀️ / ? / 關於 / 面板
- 其中 **3 個係純 emoji**（🔗 ⬇ ?），無文字標籤、無 `aria-label`
- `探索地區` 文案**完全唔存在**；`搵角色`／`搵事件` 唔存在
- 冇 onboarding；首個可見 H2 係「第一季編年史」

→ V2 必須以 4 個語意入口取代，並用本機 SVG sprite 取代 emoji（A10）。

---

## 6. Layer Control（spec §2.4 要求）

| Layer | 預設 | 說明 |
|---|---|---|
| `倖存區` | ON | `kind=survivor` polygon + 穩定 beacon |
| `病窩／危險區` | ON | `kind=nest` polygon + 低頻呼吸 + hatch pattern |
| `據點／爭議區` | ON | `kind=outpost` → `contested` 視覺 |
| `事件` | ON | 當前章 ± 窗口（可調）／「顯示全部」toggle |
| `角色旅程` | OFF | route polyline + waypoint |
| `時期` | OFF | 時期分層／流向 |
| `地圖細節` | auto（LOD） | 道路／樓宇／POI 密度 |

**Legend 規則（硬性）**：每一項**必須**同時提供 color + pattern + icon／shape 三通道（spec §2.4）。驗收：灰度 pixel diff（C2/C7）。

**現況問題**：`outpost` 佔 48 個 zone 中 16 個（33%），legend **完全冇**呢一項（A2）。

---

## 7. Progressive Disclosure 層級

| 層 | 內容 | 顯示方式 |
|---|---|---|
| L0 | 世界 territory、當前章事件 | 預設 |
| L1 | Zone hover tooltip（name / kind / danger / status） | hover / focus，**唔遮蓋地圖** |
| L2 | Zone / event / character dossier | context surface |
| L3 | 相關事件、相關角色、chapter refs | dossier 內 quick links |
| L4 | Chronicle 全文、伏筆關係、時期流向 | `?view=chronicle` + 篩選 |
| L5 | 匯出（public metadata only） | 主動觸發 |

**Spoiler 與 disclosure 正交**：spoiler level 控制**可見範圍**，disclosure 控制**資訊深度**。UI 必須清楚顯示「已隱藏 M 條（spoiler ≥ N）」。

---

## 8. Search IA

| 類別 | 來源 | 現況 |
|---|---|---|
| `character` | `characters.json`（330） | ✅（但硬上限 50） |
| `event` | `events.geojson`（1796） | ✅ |
| `location` | `locations.geojson`（704） | ✅ |
| `zone` | `zones.geojson`（48） | ❌ 完全冇 |
| `chapter` | `chapter-summaries.json`（198） | ❌ 完全冇 |

**V2 要求**：
1. 五類齊全。
2. 移除硬上限，改用 virtualization + 分組顯示。
3. 鍵盤：↑↓ 移動、Enter 開啟、Esc 關閉、`aria-activedescendant`（A7 P0-5、A9 P1-3）。
4. 結果點擊 → 更新 URL + context（現況：search 結果只寫 `#ch=95`）。

---

## 9. 現況 IA 問題總表（A1/A3/A9）

| ID | 問題 | 嚴重度 | 影響 Journey |
|---|---|---|---|
| IA-P0-1 | 首屏主 context 係編年史而非地圖（98.1% 文字） | P0 | A、B |
| IA-P0-2 | 冇 4 個語意入口；3 個 nav 係無標籤 emoji | P0 | A |
| IA-P0-3 | zone 選擇／event 選擇唔入 URL | P0 | B、C、D |
| IA-P0-4 | zone 模式下點 event 唔切 view（寫入隱藏 panel） | P0 | B、D |
| IA-P1-1 | 冇 layer control UI | P1 | B、E |
| IA-P1-2 | 冇 spoiler 控制／持久化／可見範圍提示 | P1 | A、D、E |
| IA-P1-3 | Search 只有 3 類 + 硬上限 50 | P1 | C、D |
| IA-P1-4 | 冇 onboarding | P1 | A |
| IA-P1-5 | Chronicle 冇篩選、冇 virtualization | P1 | E |
| IA-P2-1 | mode 標籤與實際 view 唔一致 | P2 | B |
| IA-P2-2 | 伏筆連結唔更新 URL | P2 | E |

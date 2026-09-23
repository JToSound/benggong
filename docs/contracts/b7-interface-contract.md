# B7 Chronicle Experience — 介面契約（Interface Contract）

> 子代理：**B7 Chronicle Experience**｜Branch：`refactor/world-atlas-v2`
> 上游契約：`b1-interface-contract.md`（token / motion）、`b2-interface-contract.md`（state / selector / URL）、
> `b3-interface-contract.md`（adapter / searchIndex）、`b4-interface-contract.md`（資料 pipeline）
> 主要規格：`docs/specs/world-atlas-v2-component-state-contract.md` §1.5 / §3（規則 C1–C3）、
> `docs/specs/world-atlas-v2-information-architecture.md` §2 / §3 / §5.1 / §7 / §8 / §9（IA-P1-5、IA-P2-2）、
> `docs/specs/world-atlas-v2-visual-motion-system.md` §2 / §5 / §6（規則 T1–T4、M1–M5）
> 設計文件：`docs/CHRONICLE_DESIGN.md`
> **本檔先寫，後實作**（spec §4.4、migration plan §8）。所有文字用粵文。

---

## 0. 一句話總結

B7 將 V1 嘅「逐條列表式編年史」重做成**體驗完整嘅故事時間軸**，並且：

1. 所有選中狀態經 **B2 store**（唔再有 `ChronicleView` 私有 state）；
2. 所有資料經 **B3 adapter / selector**（唔再自己 `fetch` / 掃 raw array）；
3. 所有時長／緩動由 **B1 token** 讀（唔硬寫死）；
4. 條目渲染 **virtualized**（規則 C1 明文要求），令 1,320 條唔會變成 1,320 個 DOM 卡。

**最重要嘅保證**：

> 🚧 B7 **唔改** B1 / B2 / B3 / B4 / B5 任何 export 嘅簽名或語意。
> B7 只喺自己 allowlist 內新增／改寫檔案。`src/app.ts` 對 `ChronicleView`
> 嘅既有呼叫（`render()` / `setChapterFilter(n)`）**維持可用**（thin shim 保留）。

---

## 1. B7 獨佔（Owned by B7）

| 檔案 | 狀態 | 說明 |
|---|---|---|
| `src/components/ChronicleView.ts` | **改** | 編年史主元件（唯一 class export） |
| `src/components/chronicle/period.ts` | **新** | 時期定義 + 分群（純函數） |
| `src/components/chronicle/foreshadow.ts` | **新** | 伏筆關係解析（純函數） |
| `src/components/chronicle/virtual.ts` | **新** | virtualization 窗口計算（純函數） |
| `src/components/chronicle/model.ts` | **新** | `ChronicleEntry` → view model（純函數） |
| `src/components/chronicle/a11y.ts` | **新** | ARIA / keyboard 契約常數 |
| `src/styles/chronicle.css` | **新** | V2 編年史 CSS（只准 `var(--token)`） |
| `tests/chronicle-view.test.ts` | **新** | 渲染 / 章節選擇 / store 同步 |
| `tests/chronicle-foreshadow.test.ts` | **新** | 伏筆解析 / 跳轉 |
| `tests/chronicle-a11y.test.ts` | **新** | 鍵盤 / ARIA |
| `docs/contracts/b7-interface-contract.md` | **新** | 本檔 |
| `docs/progress/b7-chronicle-experience-delivery.md` | **新** | 交付報告 |

**B7 唔會改**：`src/styles/main.css`、`timeline.css`、`hud.css`、`index.css`（Gate 2 才清）、
`src/state/**`、`src/data/**`、`src/app.ts`、`src/main.ts`、`src/types/**`、`data/**`、
`scripts/**`、`vite.config.ts`、`eslint.config.js`、`tsconfig.json`、`package.json`。

---

## 2. Store 整合契約（規則 S1–S4）

### 2.1 唯一選中狀態來源

V1 有兩個私有欄位（`filterChapter` / `expanded`）。V2 之後：

| 狀態 | V2 去邊 | 理由 |
|---|---|---|
| `filterChapter` | `state.context.filters.chapter`（`context.kind === 'chronicle'`） | `ChronicleFilters.chapter` 已經係 B2 契約一部分；URL 已經支援 `?chapter=` |
| `expanded`（展開邊條） | `state.context.filters.query` + 元件內 `focusId` | **見 §2.2 偏離說明** |
| 目前 focus 條目 | `state.pendingFocus`（透過 `setPendingFocus`） | a11y focus restoration（IA §7 L3） |
| 搜尋 query | `state.context.filters.query` + B3 `searchSearchIndex` | IA §8 五類搜尋 |

### 2.2 偏離說明（需主代理知悉）

| # | 偏離 | 理由 |
|---|---|---|
| **B7-D1** | 「展開邊條」**唔**入 store，留作元件內 DOM 焦點狀態 | `AppState` 冇「展開條目 id」欄位，而加欄位要改 B2 獨佔嘅 `src/types/state.ts`（B7 唔可以改）。替代做法：展開狀態以 `aria-expanded` + `hidden` 表達（衍生 DOM），條目 id 經 `setPendingFocus(id)` 記錄，令「跳轉後 focus」可測。**不影響 URL round-trip**（展開唔屬 spec §3.6「必須重現」清單）。 |
| **B7-D2** | 唔用 `selectChroniclePage()`（B2 selector）做唯一渲染路徑 | `selectChroniclePage` 收 `WorldIndex.chronicle`；B7 需要嘅係 **B3 `World`**（有 `chronicleByPeriod` 索引 + `searchSearchIndex`）。B7 用 B3 adapter selector，`selectChroniclePage` 語意完全不變、**未被廢棄**（B8 可繼續用）。 |
| **B7-D3** | 時期排序**唔**依賴 `chronicleByPeriod` 嘅 Map 次序 | `Map` 保住插入次序係 spec 細節，唔係契約。B7 用**顯式** `PERIOD_ORDER` 陣列排序（同 V1 一致），`chronicleByPeriod` 只用嚟快速取一組條目。 |

### 2.3 元件公開介面（`ChronicleView`）

```ts
export interface ChronicleViewOptions {
  root: HTMLElement;
  app: App;                    // 只讀 app.store / app.world（B2 薄 adapter）
  doc: ChronicleDoc;           // 保留：V1 呼叫路徑仍可用
}

export class ChronicleView {
  constructor(root: HTMLElement, app: App, doc: ChronicleDoc);

  /** 由 store 重繪（訂閱者會叫；app.ts 亦會直接叫）。 */
  render(): void;

  /** 章節篩選（V1 相容簽名；內部轉為 store action）。 */
  setChapterFilter(ch: number | null): void;

  /** 目前篩選章節（由 store 衍生，唔再係私有欄位）。 */
  getChapterFilter(): number | null;

  /** 訂閱 store；回傳 unsubscribe（測試用，避免 listener 洩漏）。 */
  destroy(): void;

  /** 鍵盤事件入口（可測；`document` keydown 會委派嚟呢度）。 */
  handleKeydown(e: KeyboardEvent): boolean;
}
```

> `setChapterFilter(n)` 保留係因為 `src/app.ts:397` 會呼叫佢 —— **B7 唔可以改 app.ts**，
> 所以簽名必須維持。內部行為改為呼叫 `store.setChapter(n)`（`null` → 保留現章，
> 即「清除篩選」＝ 回到非篩選狀態）。

---

## 3. Adapter 整合契約（規則 D1–D3）

```ts
import {
  loadWorldData, toWorldIndex, getDossier, loadDossiers,
  selectSearchResults as selectAdapterSearch,   // B3 adapter selector
  type World,
} from "../data/adapter";
```

- **唔准** import `data/public/*.geojson` 或 `public/assets/*.json`（規則 D1）。
- **唔准** 自己 `fetch`（規則 D2）；一切經 `World`。
- 搜尋用 `searchSearchIndex(world.indexes.search, kind, query)`（IA §8.3：**冇硬上限**）。
- 深連結：條目 → `setContext({kind:'event'|'location'|'zone'|'chapter'})`，令地圖同時反應。

### 3.1 搜尋整合方式

編年史標題旁嘅搜尋框用 **`kind = null`**（跨類），並喺 filter 之後只保留**編年史相關**
結果（`event` / `location` / `chapter` / `zone` 四類 —— `character` 類喺編年史用唔到，
因為條目只存 `characters: string[]` 而冇渲染入口）。

> 為何唔加 `character`：加咗會出現「搜到角色但撳落去冇反應」嘅死路（比唔顯示更差）。

---

## 4. 時間軸體驗契約

### 4.1 時期（period）—— 分期視覺化

| 常數 | 內容 |
|---|---|
| `PERIOD_ORDER` | `pre_outbreak → outbreak → early → basecamp → lohas → endgame`（同 V1 一致） |
| `PERIOD_LABEL` | 粵文標籤 |
| `unknown key` | `"_unknown"`（label「時期未判定」） |

**硬性**：`periodOf(entry)` **必須**同時接受 `story_time.source ∈ {"llm_period", "chapter_boundary"}`。
（`docs/CHRONICLE_DESIGN.md` §6.8：V1 只認 `llm_period`，令 391 條 `chapter_boundary` 顯示「未判定」。
呢個 bug 踩過兩次 → B7 用**單一來源** `ACCEPTED_PERIOD_SOURCES` 集合，並由測試斷言。）

### 4.2 捲動定位 + 當前位置指示

- 時期側邊導覽（period rail）：每個時期一粒，`aria-current="true"` 標示目前所在；
- 點一粒 → 捲到該時期標題（用 B1 `scrollElementTo`，**唔用** `scrollIntoView` —— 規則 C1 / A7 P0-2）；
- 捲動時用 `IntersectionObserver`（唔存在就 fallback 到 scroll 事件）更新 `aria-current`。

### 4.3 Virtualization（規則 C1 明文「必須 virtualized」）

**做法**：窗口式渲染（windowed rendering），唔引入任何 runtime 依賴。

- 每個條目一個**固定高度估算** `ROW_H`（展開時更高，用 `data-open` class 加高）；
- 容器 `scrollTop` → `computeWindow(total, scrollTop, viewportH, overscan)` → `{ start, end }`；
- 只 render `[start, end)`，上下各留一個 spacer `<div>` 撐高度；
- `ROW_H` 係**常數**（唔量 DOM → 唔會 layout thrash）。

```ts
// src/components/chronicle/virtual.ts
export interface WindowRange { start: number; end: number; padTop: number; padBottom: number }
export function computeWindow(
  total: number, scrollTop: number, viewportH: number, overscan?: number,
): WindowRange;
```

**測試斷言**：1,320 條之下，`scrollTop=0` 渲染 ≤ `WINDOW_MAX`（預設 40）個 `article`。

---

## 5. 伏筆（foreshadow）連結契約

```ts
// src/components/chronicle/foreshadow.ts
export interface ForeshadowPair {
  fromId: string;           // 埋下伏筆嘅條目
  toId: string;             // 被埋伏筆嘅條目
  resolvesChapter: number;  // 解答發生嘅章節（= from.first_mention_chapter）
  plantedChapter: number;   // 伏筆首次提及章節（= to.first_mention_chapter）
  /** 跨咗幾多章（正數 = 後章解答前章伏筆；負數 = 資料異常）。 */
  gap: number;
}
export function resolveForeshadows(entries: ChronicleEntry[]): ForeshadowPair[];
export function foreshadowsOf(id: string, pairs: ForeshadowPair[]): ForeshadowPair[];
export function paysOffOf(id: string, pairs: ForeshadowPair[]): ForeshadowPair[];
```

**硬性驗證**（`docs/CHRONICLE_DESIGN.md` §4 嘅既有治理規則，B7 只讀唔改）：

1. `fromId !== toId`（冇自我指向）；
2. 兩邊 id 都真係存在（唔會 render 死鏈）；
3. `gap >= 0`（伏筆章節唔遲過解答章節）；
4. **冇循環**（`from → to → … → from`）。

不合格嘅 pair **靜默丟棄**（唔可以 throw、唔可以 render 死鏈）。
`resolveForeshadows()` 回傳嘅 pair 數 **必然 ≤** 原始 `foreshadows` 邊數。

### 5.1 跳轉行為

點伏筆 chip：

1. 設 `setPendingFocus(toId)`（a11y focus restoration）；
2. 若目標條目**唔喺**目前窗口 → 先 `scrollElementTo` 到目標 offset；
3. 設 `aria-expanded="true"` + 移除 `hidden`；
4. `focus()` 目標標題（`tabindex="-1"`）；
5. **唔會**改 URL（條目 id 唔屬 URL contract 嘅 11 個參數 —— 見 §7）。

---

## 6. Motion 契約（規則 M1 / M2 / M5）

| 用途 | token | reduced-motion fallback |
|---|---|---|
| 條目展開／收合 | `--dur-fast` / `--ease-standard` | 即時顯示 |
| 時期 sticky header 位移 | `--dur-normal` / `--ease-standard` | 即時 |
| 捲到目標條目 | `DUR.normal`（`motion.ts`） | 即時跳（`scrollElementTo` 內部處理） |
| focus ring | `--dur-fast` | 保留（micro feedback，白名單第 5 項） |

**白名單**：以上全部落喺 spec §5 表格第 4 / 5 / 6 項。**冇**新增任何唔喺白名單嘅動效
（**冇** auto-play、**冇**無限閃爍、**冇** per-frame DOM update）。

**Reduced motion**：`motion.ts` 嘅 `scrollElementTo()` 內建 `prefersReducedMotion()` 判斷，
B7 **唔可以**自己再寫 `requestAnimationFrame` 做捲動。

---

## 7. URL 同步契約

B7 **唔加**任何 URL 參數。`src/state/url.ts` 嘅 11 個參數（`event` / `zone` / `location` /
`character` / `route` / `chapter` / `spoiler` / `layers` / `view` / `measure` / `q`／`kind`）
**完全不變**。B7 只係**觸發**已有 action：

| 用戶動作 | store action | URL 效果 |
|---|---|---|
| 點章節 chip | `setView("map")` + `setChapter(n)`（＝`app.goToChapter`） | `?chapter=n` |
| 點時期 rail | `scrollElementTo` 到該段 | **唔變** |
| 喺編年史搜尋 | `setContext({kind:'search', query})` | `?q=…` |
| 清除搜尋 | `setContext({kind:'chronicle', filters})` | `?view=chronicle`（+ `?chapter=` 若有） |
| 開／關編年史 | `setView("chronicle" \| "map")` | `?view=` |
| 點伏筆 chip | `setPendingFocus(id)` | **唔變**（見 §5.1） |

> IA §9 嘅 **IA-P2-2「伏筆連結唔更新 URL」**：B7 判定**唔應該**更新 URL。
> 理由：條目 id 唔屬 URL contract，加參數會令 `isCanonical()` 對所有現有 URL 判 false
> （令每次載入都觸發 canonicalize），反而製造新嘅狀態來源（違反規則 S4）。
> 正確做法係「唔改 URL，改 focus + 捲動」。**此為對 IA-P2-2 嘅有意解決，唔係遺漏。**

---

## 8. a11y 契約（規則 C3 / A7）

| 項 | 要求 |
|---|---|
| 容器 | `role="region"` + `aria-label="第一季編年史"` |
| 條目 | `<article role="listitem">`，清單容器 `role="list"` |
| 章節 chip | `<button type="button">`，`aria-label="第 N 章（首次提及）"` |
| 展開 / 收合 | `<button aria-expanded="true\|false" aria-controls="…">` |
| 伏筆 chip | `<button type="button" aria-label="跳去「標題」（第 N 章）」` |
| 時期 rail | `role="tablist"` 語意**唔用**（唔係 tab 面板）；用 `<nav aria-label="故事時期">` + `<a href="#" role="button">`，`aria-current="true"` |
| 目前在讀計數 | `aria-live="polite"`（唔用 `assertive`，避免洗屏） |
| 互動目標 | ≥44×44 CSS px（`.chr-tap` class） |
| focus ring | `:focus-visible` + `--focus-ring`；**冇** `clip-path`（唔會被剪） |
| 文字 | 全部 ≥12px（`--fs-2xs` 起）；對比 ≥4.5:1（用 token 保證） |
| 鍵盤 | `↑` / `↓` 移 focus；`Enter` / `Space` 展開；`Home` / `End` 跳首尾；`Esc` 清除搜尋 |

> **`Esc` 唔會**切走 view（避免同 `app.ts` 嘅 `Escape → setContext({kind:'explore'})` 打架）。

---

## 9. CSS 契約（規則 T1 / T4）

- `src/styles/chronicle.css` **只准** `var(--*)`；**零** raw hex / `rgb()` literal。
- 由測試 `tests/chronicle-a11y.test.ts` 用 regex 掃檔斷言：
  - 冇 `#[0-9a-fA-F]{3,8}` 色值；
  - 冇 `rgb(` / `rgba(` / `hsl(` literal；
  - 所有 `transition` / `animation` 時長係 `var(--dur-*)` 或 `0s`（唔硬寫 `120ms` 等）。
- **仍需 `src/main.ts` 加一行 `@import`** —— 呢個屬 B2 allowlist，B7 **唔可以改**。
  → **B7 交付時 CSS 已寫好但未載入**，列為「需主代理一行接線」項（**唔係**人手覆核，
  係**程式化**嘅一行接線，可由主代理喺整合 pass 執行或由 B7 喺 allowlist 放寬後補）。

---

## 10. 測試契約

| 檔案 | 斷言 |
|---|---|
| `tests/chronicle-view.test.ts` | ① 渲染時期分群正確；② `llm_period` **同** `chapter_boundary` 都當有時期（391 條陷阱）；③ 章節 chip → `store.setChapter`；④ 搜尋 filter 經 store；⑤ virtualization 窗口 ≤ `WINDOW_MAX`；⑥ `setChapterFilter` V1 相容簽名仍然有效 |
| `tests/chronicle-foreshadow.test.ts` | ① 自我指向丟棄；② 不存在 id 丟棄；③ 負 gap 丟棄；④ 2-循環丟棄；⑤ 正常 pair 保留；⑥ `gap` 數值正確；⑦ pair 數 ≤ 邊數 |
| `tests/chronicle-a11y.test.ts` | ① 每個互動 chip 有 `aria-label`；② `aria-expanded` 隨展開改變；③ 鍵盤 `↓` 移動 focus；④ `Home` / `End`；⑤ CSS 零 raw hex；⑥ CSS 只用 `var(--dur-*)`；⑦ 時期 rail 有 `aria-current` |

**所有測試零 DOM 依賴**（`environment: node`）：B7 將「產生 HTML 字串」同「bind 事件」
分離，令 `renderToString()` / `computeWindow()` / `resolveForeshadows()` 全部係純函數。

---

## 11. 驗收（B7 自己跑）

```bash
npm run typecheck    # 0 error
npm run lint         # 0 error
npm run test         # 新增 3 檔全綠；既有 19 files / 298 tests 保持全綠
npm run build        # 必須成功
```

**唔可以整紅任何既有測試**（硬性）。特別注意 `tests/visual-smoke.e2e.test.ts`
依賴 `#ch=150` legacy alias，同 `tests/phase-j-lod.test.ts` 依賴初始世界視圖。

---

## 12. 未處理項（明確唔做，附理由）

| # | 項 | 理由 |
|---|---|---|
| 1 | 編年史條目 → 地圖 fly-to | 屬 **B6 Map Interaction** 範疇（`src/map/**` 唔喺 B7 allowlist）。B7 只做 `setContext`，地圖反應由 B6 實作 |
| 2 | `character` 類搜尋結果喺編年史 | 冇角色渲染入口（見 §3.1）；避免死路 |
| 3 | 時間軸橫向 bar 圖（V1 `renderTimeline`） | V1 用「章節格高度 = 條目數」，同 IA §7 嘅 **L4 時期流向**語意唔一致（章節 ≠ 時期）。V2 改用**時期 rail + 時期分群**，語意更準。橫向 bar 圖唔屬任何 spec 驗收項 |
| 4 | CSS 載入 | 需改 `src/main.ts`（B2 allowlist）—— 見 §9 |
| 5 | 匯出 JSON | V1 功能；V2 保留（`exportJson()`）但改為經 adapter 讀，只出 public metadata（版權紅線：唔含小說原文） |

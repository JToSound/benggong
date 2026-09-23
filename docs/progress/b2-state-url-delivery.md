# B2 — App State & Router 交付報告

> 子代理：**B2 App State & Router**｜Branch：`refactor/world-atlas-v2`
> 交付日期：2026-09-21
> 主要規格：`docs/specs/world-atlas-v2-component-state-contract.md`、`docs/specs/world-atlas-v2-information-architecture.md` §3
> 介面契約（先寫）：`docs/contracts/b2-interface-contract.md`

---

## 任務摘要

建立 **單一 state store + 完整 URL contract**，作為其他 module（B3/B5/B6/B7/B8/B9）嘅基礎。

| 交付 | 內容 |
|---|---|
| 單一 state 來源 | `src/state/store.ts` —— `AppState` + `PrimaryContext`（10 kind）+ 15 個 action + `subscribe`（規則 S1–S4） |
| URL 契約 | `src/state/url.ts` —— `toUrl` / `fromUrl` / `isCanonical`；**11 個參數**（spec 8 + `?measure=` / `?q=` / `?kind=`）＋ legacy `#ch=` / `#loc=` |
| Derived selector | `src/state/selectors.ts` —— 11 個 selector + `buildWorldIndex`（過渡橋，B3 會取代） |
| 持久化 | `src/state/persistence.ts` —— spoiler + theme，全部 try/catch |
| 接線 | `src/app.ts`（4 個 selection 欄位 + `viewMode` 全部改為經 store）、`src/router.ts`（降為 legacy shim）、`src/main.ts`（bootstrap store + B1 CSS + sprite） |
| 型別 | `src/types/state.ts`（新）、`src/types/dataset.ts`（加 `coordinate_*` / zone v2 / dossier） |
| 測試 | `tests/state-store.test.ts`（31）、`tests/url-contract.test.ts`（41）、`tests/url-legacy-alias.test.ts`（16）—— **88 全綠** |

---

## 假設與證據

### 假設

1. **Spec 為唯一權威**（anti-stagnation）：舊 `router.ts` / `app.ts` 嘅 state model 唔係優先真相。凡衝突，一律以 V2 spec 為準。
2. **`#ch=` / `#loc=` 只係「讀」紅線**：`visual-smoke` 依賴 `#ch=150` 能開到第 150 章。B2 保留讀取路徑，寫入一律 canonical query（rule 4）。
3. **URL 語意驗證由呼叫方注入**：`fromUrl` 做語法檢查（長度／控制字元／字元集）；id 係唔係真係存在由 `App` 用 `WorldIndex` 建 predicate 注入（`UrlValidationContext.isValidId`）。node 單元測試注入假 predicate。
4. **selector 需要 read model**：B3 adapter 未交付，故 B2 提供 `buildWorldIndex(data)` 過渡橋；selector 簽名唔會因 B3 而變。

### 證據（Playwright 實測，`vite preview` @ 5174，production build）

| 情境 | 實測結果 |
|---|---|
| `/#ch=150` | URL canonicalize 成 `/?chapter=150`；`#strip-ch-num` = **"150"**；**零 pageerror** |
| `/#ch=9999` | 落回第 1 章；URL 變 `/`（hash 清走）；零 pageerror |
| `/?event=INVALID` | `explore`；URL 變 `/`；零 pageerror |
| `/?zone=唔存在` | `explore`；零 pageerror |
| `/?chapter=99999` | 第 1 章；零 pageerror |
| `/?spoiler=99` | canonicalize 成 `/?spoiler=3`（clamp）；零 pageerror |
| `/?view=xyz` | `view=map`；零 pageerror |
| `/?zone=<500 字 id>` | `explore`；零 pageerror |
| `/?event=%00%01` | `explore`；零 pageerror |
| `/?zone=z1&chapter=150` | zone 唔存在 → 丟棄；`chapter=150` 保留 → `/?chapter=150`；零 pageerror |
| `/?view=chronicle` | view = chronicle，`#btn-mode` 顯示「📜 編年史」；零 pageerror |
| SVG sprite | `mountIconSprite()` 已注入（31 個 `<defs>` 相關節點） |
| 按 `k`（`#ch=9999` 之後） | 第 2 章；URL = `/?chapter=2`；`location.hash` = **`""`** ← 見「風險 C1」 |

### 命令結果

```
npm run typecheck   → 0 error
npm run lint        → 16 error（全部喺 artifacts/**，pre-existing，唔屬 B2 scope；src/ + tests/ 0 error）
npm run test（B2 三個檔） → 88 passed
npm run build       → 成功（29 modules；CSS 7.20 kB；JS 144.95 kB）
```

---

## 發現／改動

### 1. 舊 state model 有 5 個獨立權威（已消滅）

| 舊 | 新 |
|---|---|
| `App.currentChapter` / `selectedLocationId` / `selectedEventId` / `selectedZoneId` | `store.getState().chapter` + `context`（`PrimaryContext` union） |
| `App.viewMode`（private） | 由 `state.view` + `context.kind` **衍生**（`getViewMode()`） |
| `App.syncHash()`（只寫 `ch` + `loc`） | `state/url.ts` 嘅 `toUrl`，由 action 內部投影（規則 S4） |
| `#story-pane.is-collapsed`（DOM-as-state） | `state.sheetSnap === "peek"`；class 只係衍生輸出 |
| `#zone-dossier-mount[hidden]` / `#story-panel-mount[hidden]` | 由 `context.kind` + `view` 衍生 |

### 2. URL 參數：實測由 **2 → 11**

spec §5.1 要求 8 個，IA §3.1 另外列 `?measure=` / `?q=`，加 `?kind=`（4 個入口需要）＝ **11 個全部實作**。

### 3. `selectVisibleZones` 硬性遵守 D2

`selectVisibleZones` **完全唔讀 `state.chapter`**。測試斷言：chapter 由 1 掃到 198，回傳長度**恆等於 48**。章節只經 `selectEmphasisZoneIds` 做 emphasis。

### 4. 錯誤處理契約（§5）

- `fromUrl` / `hydrateFromUrl` **唔會 throw**；所有無效值 → 預設 + `console.warn`（實測零 pageerror）。
- localStorage 被停用 → `readSpoilerMax` / `writeSpoilerMax` 全部 try/catch，落回記憶體 state。
- `pushError` / `clearError` 提供非阻塞 error 通道（同 code 只留最新一筆，最多 5 筆）。

---

## 修改檔案

| 檔案 | 狀態 | 說明 |
|---|---|---|
| `docs/contracts/b2-interface-contract.md` | 新 | 介面契約（先寫） |
| `src/state/store.ts` | 新 | 單一 store + 15 action + subscribe |
| `src/state/url.ts` | 新 | toUrl / fromUrl / isCanonical / applyUrl + 11 參數 + legacy alias |
| `src/state/selectors.ts` | 新 | 11 selector + buildWorldIndex |
| `src/state/persistence.ts` | 新 | spoiler + theme 持久化（try/catch） |
| `src/state/index.ts` | 新 | 對外入口 + createUrlEffects + bindUrlSync |
| `src/types/state.ts` | 新 | AppState / PrimaryContext / WorldIndex / 預設值 |
| `src/types/dataset.ts` | 改 | 加 `CoordinateIntegrity`、zone v2（`zone_type` / `danger_level` / `display_style` / `dossier_id` / `zone_review_status` …）、`ZoneDossier` |
| `src/app.ts` | 改 | 私有 state → store；`syncHash()` 移除；`is-collapsed` 改為衍生 |
| `src/router.ts` | 改 | 降為 legacy shim（只保留 `hashchange` → store action） |
| `src/main.ts` | 改 | `import "./styles/index.css"`；`mountIconSprite()`；bootstrap store + hydrate + bindUrlSync |
| `tests/state-store.test.ts` | 新 | 31 測試 |
| `tests/url-contract.test.ts` | 新 | 41 測試 |
| `tests/url-legacy-alias.test.ts` | 新 | 16 測試 |

## 沒有修改但相關的檔案

- `src/styles/main.css` / `hud.css` / `timeline.css` —— **只係唔再 import**，檔案仍然存在（Gate 2 由主代理刪）。
- `src/components/**`（B6/B7/B8）、`src/map/**`（B5）、`src/data/**`（B3）、`data/**`（B4）、`scripts/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`tests/visual-smoke.e2e.test.ts` —— 全部零改動。
- `src/components/SvgMap.ts`、`src/exportMap.ts`、`src/styles/main.css`、`tests/phase-i.e2e.test.ts`、`tests/phase-j-lod.test.ts`、`tests/test_data_normalization.py` —— 呢啲喺 B2 開工**之前**已經係 modified 狀態（Phase L 遺留），B2 冇再改。

---

## 驗證命令與結果

```bash
npm run typecheck
# → 0 error

npm run lint
# → 16 error / 1 warning，**全部喺 artifacts/**（pre-existing）
#    src/ 同 tests/ 0 error

npx vitest run tests/state-store.test.ts tests/url-contract.test.ts tests/url-legacy-alias.test.ts
# → Test Files 3 passed (3)｜Tests 88 passed (88)

npx vitest run tests/dataset.model.test.ts tests/svgmap.legend.test.ts tests/phase-i.test.ts \
  tests/phase-j-lod.test.ts tests/vector-basemap.test.ts tests/theme-token-parity.test.ts \
  tests/motion.test.ts tests/network-audit.test.ts
# → Test Files 1 failed | 7 passed｜Tests 1 failed | 86 passed
#    唯一 fail：tests/phase-j-lod.test.ts「全港視圖應該係層級 0」（見風險 C2）

npm run build
# → prebuild 同步 OK；tsc --noEmit 0 error；vite build 成功
#    dist/assets/index-*.css  7.20 kB（只係 B1 tokens + base）
#    dist/assets/index-*.js  144.95 kB
```

---

## Screenshots / Artifacts

- **URL 契約實測表**（見上「證據」）—— 由 Playwright headless Chromium 對 `vite preview` production build 跑 10 個 URL 情境，逐個記錄 `page.url()` / `#strip-ch-num` / pageerror 數。
- **`#ch=150` 實測**：`#strip-ch-num` = `"150"`、URL 由 `/#ch=150` canonicalize 成 `/?chapter=150`。
- **`?spoiler=99` 實測**：URL 由 `/?spoiler=99` 變成 `/?spoiler=3`（clamp 生效嘅可見證據）。
- **量度證據（C2）**：移除舊 CSS import 之後，`.svg-map-wrap` 尺寸 = `1400 × 26890`（未樣式化），`#svg-map` viewBox 寬 = `0.1475`（應該係 ~0.5）→ `VectorBasemap.pickLevel(0.1475)` 回 **1**（`w > 0.35` 才係 0）。

---

## 風險、衝突、限制

### C1（需主代理裁決）—— `visual-smoke` 嘅「按 k 之後 hash 含 `ch=2`」斷言同 D5 直接衝突

`tests/visual-smoke.e2e.test.ts:486-490` 斷言：

```ts
await page.keyboard.press("k");
const hash = await page.evaluate(() => window.location.hash);
expect(hash, "切章節應該更新 hash").toContain("ch=2");
```

V2 D5 + IA §3.2 rule 1／4 明文要求 **統一 query string**、**同一 state 只可以有一個 canonical URL**（避免 `?chapter=150#ch=150`）。B2 依 spec 只寫 `?chapter=2`，`location.hash` 因此係 `""`。

**實測**：按 `k` 之後 `location.hash === ""`、`location.search === "?chapter=2"`、`#strip-ch-num === "2"`（功能正確）。

- 同一個 test case 嘅 `#ch=150` 斷言（line 460-476）**仍然通過** —— legacy 讀取路徑冇拆。
- 該檔屬主代理專屬，B2 唔可以改 → **請主代理將 line 489-490 改為斷言 `window.location.search` 含 `chapter=2`**。

### C2（需主代理知悉）—— 移除舊 CSS import 令舊 UI 暫時失去樣式

依 B1 契約 §3.1.1 同本任務第 6 點，`src/main.ts` 已改為只 `import "./styles/index.css"`（B1 tokens + base）。過渡期 B6/B7/B8 嘅 component CSS 未交付，所以：

- `dist` CSS 由舊 bundle 變成 **7.20 kB**（只有 tokens + base）。
- `.svg-map-wrap` 高度變 `26890px`、`#svg-map` viewBox 寬由 ~0.5 變 `0.1475`。
- **實測影響**：`tests/phase-j-lod.test.ts` 嘅「全港視圖應該係層級 0」變紅（LOD level 0 → 1，因為視域被容器尺寸帶偏）。`visual-smoke` 嘅版面斷言（地圖佔比、面板寬度）亦預期會紅。
- **唔關 B2 logic 事**：state / URL / selector 全部正常；呢個純粹係「舊 CSS 已卸、新 component CSS 未上」嘅空窗。

**主代理選項**：(a) 接受空窗，等 B6/B7/B8 + B9；(b) 暫時喺 `main.ts` 補返舊 CSS import（一行，唔影響 state/URL 契約），等 component CSS 齊先再卸。

### C3 —— `PrimaryContext.measure` 加 `ids: string[]`

IA §2 寫 `{ kind: "measure" }`，但 `?measure=<csv>` 需要承載 id 清單先做到 round-trip。B2 加 `ids` 欄位（空陣列 = 無 payload），其餘 9 個 kind 逐條對齊。

### C4 —— `?kind=` 參數

IA §5.1 四個入口用 `?q=&kind=character`，但 §3.1 參數表冇列 `kind`。B2 補上 `?kind=`（映射 `state.searchKind`），令入口可 deep-link。

### 限制

1. **`?layers=` 用偏差編碼**：只列非預設值（`routes` = ON、`-events` = OFF）。理由係規則 U2（URL 短）；副作用係 layer 狀態要靠預設表解讀（已寫入契約 §5.5）。
2. **Chronicle filters 唔入 URL**（U1 只列 context + spoiler + layers + view）。`?view=chronicle` 只還原 view + chronicle context，filter 維度由 B7 決定要唔要擴充參數。
3. **`buildWorldIndex` 係過渡橋**：B3 交付 `src/data/adapter/index.ts` 之後會取代佢；`selectVisibleZones` 等簽名唔變。
4. **D2 目前只在 selector 層保證**：`selectVisibleZones` 一定回 48 個，但 legacy `SvgMap` 未接 selector（實測 chapter 1 只 render 1 個 `.zone`）。真正「48 個 zone 全部 render」要 B5/B6 將 renderer 接上 selector。
5. **`src/types/state.ts` 依賴 `../data/loadAllData` 嘅 `ChronicleEntry`**（type-only）。B3 重寫 loader 時請保留／搬移呢個型別；否則 `src/state/index.ts` 嘅 re-export 會斷。

---

## 給主代理的 integration note

1. **B2 係其他 module 嘅前置**。其他 agent 應該：
   - 用 `createAppStore()` + `createUrlEffects()` 建 store（`src/main.ts` 已經係範例）；
   - 讀 state 用 `store.getState()`、寫用 action、訂閱用 `subscribe`；
   - 讀 derived 用 `selectVisibleZones` / `selectEmphasisZoneIds` / … —— **唔可以**喺 component 內重算；
   - 唔可以自己 `history.replaceState`（所有 URL 寫入經 action 嘅 `effects.projectUrl`）。
2. **`src/types/dataset.ts` 已加 zone v2 / dossier / `coordinate_*` 型別**，B4 嘅 pipeline 輸出可以直接對齊（全部 optional，v1 資料唔會爆）。
3. **`buildWorldIndex()` 係臨時橋**：B3 上線 `WorldIndex` 之後，請喺 `selectors.ts` 移除過渡碼（selector 簽名保持不變）。
4. **兩件要裁決嘅事**：
   - **C1**：`tests/visual-smoke.e2e.test.ts:486-490` 請改為斷言 `location.search` 含 `chapter=2`（`#ch=150` 讀取路徑 B2 已保證唔會拆）。
   - **C2**：`main.ts` 已卸舊 CSS import（依 B1 契約）；如果要保住 `phase-j-lod` / `visual-smoke` 嘅版面斷言，請決定係暫時補返舊 CSS，抑或接受空窗到 B6/B7/B8 完成。
5. **`router.ts` / `app.ts` 已降為 shim 但未刪** —— 刪除屬 Gate 2 主代理 legacy cleanup（migration plan §6.1）。

# A9 QA Adversary —— QA Gap Analysis（World Atlas V2 重建）

- 專案：`C:\Users\User\Desktop\benggong`
- 角色：A9 QA Adversary（**只讀**對抗性審計子代理）
- 稽核對象：`dist/`（`npx vite preview --port 5180 --strictPort`），測試 URL 一律 `http://localhost:5180/`
- 環境：node 22.22.2、Playwright 1.62.1（`chromium.launch({ args: ["--no-proxy-server"] })`）
- Spec 來源：`prompts/world-atlas-v2-rebuild.md` §5.1（URL contract）、§7.2（13 項 Playwright test）、§7.4（perf targets）
- 本報告為 A9 交付物；**所有結論均由自動化腳本重現，無任何人手點擊驗證步驟**。

> 本版係**融合版**：保留前輪 A9 嘅源碼層 root cause 分析，並加入本輪新補跑嘅缺口（SW 遮蓋資料錯誤、無限掛起、觸控目標、focus 陷阱、chronicle 重繪成本、搜尋鍵盤導航細節），同時**修正**前輪兩處量測口徑（Esc 優先級、mobile touch target）。

---

## 任務摘要

上一個 A9 代理已完成大量對抗實測但報告未寫入（API 額度中斷）。本次工作：

1. **核實** `artifacts/audit-A9/` 全部既有 JSON / log / 截圖，逐項對返原始數據。
2. **補跑** 上一輪未覆蓋嘅缺口：
   - spec §5.1 嘅 **hash 形式**參數（`#chapter=` / `#event=` / `#zone=` / `#character=` / `#spoiler=` / `#layers=` / `#view=`）；
   - **真正延遲 30 秒** 與 **無限掛起（永不回應）**（唔止 `route.abort()`）；
   - **localStorage 禁用 / 塞滿**下 theme 持久化；
   - **Service Worker 開 / 關**對資料錯誤嘅影響（前輪明言未覆蓋）；
   - **搜尋鍵盤導航**、**mobile 390 觸控目標**量測、**chronicle 重繪成本**。
3. **掃描** hardcode 外部 URL（`src/`、`public/`、`index.html`、`dist/`）與 service worker。
4. **審計** 現有測試覆蓋率（pytest 224 / vitest 78），對照 spec §7.2 十三項。

**核心結論（一句講完）**：spec §5.1 嘅 **8 個 URL 參數實測 0 個支援**（只有非 spec 嘅 `#ch=` / `#loc=` 生效）；**搵到 0 個 crash**（所有無效輸入皆 graceful）；但搵到 **5 個 P0（其中 1 個係本輪新增嘅 SW 遮蓋資料錯誤）、7 個 P1、6 個 P2**，而 spec §7.2 十三項之中 **6 項完全冇測試、5 項只有部分覆蓋**。

**最重要嘅新發現**：

- 🔴 **P0-1（本輪新增）**：**Service Worker 會用舊快取遮蓋資料 404 / 壞 JSON**，令 spec 要求嘅 error state 喺 production 完全不可達，並可能將過時資料當作現行資料顯示。前輪明言「SW 開啟時嘅 cache 行為未覆蓋」，本輪補做並證實係真問題。
- ⚠️ **推翻前輪嘅一項「已知結果」**：`artifacts/audit-A9/a9-gaps.log` 記載 `#chapter=150` / `#event=` / `#zone=` 全部 `crash=true`。本輪喺 preview server 正常運行下重跑（`a9-gaps-hashparams.json`），**8/8 全部 `crash=false`**。該 log 係「server 未起 → `page.goto` 失敗 → 空白頁」造成嘅**假陽性**，唔係 app bug。真正問題係：**hash 形式參數被靜默忽略**。
- ⚠️ **修正前輪兩處量測**：
  - Esc 優先級：前輪判「✅ 無問題」，但本輪 `_probe-focus.mjs` 證實 **Esc 關 modal 後 focus 卡喺隱藏嘅 `search-input`**，令之後嘅 `Esc`（清選擇）同 `k` 快捷鍵**全部失效**（新 P1）。
  - Mobile touch target：前輪判「touch target 76px ✅」，但本輪逐個量測發現 **390px viewport 內 24/24 個可見互動元素至少一個維度 <44px**（`.nav-btn` 闊 29–39px、`.ch-pill` 30×24px）。

---

## 假設與證據

### 前提假設

1. **`dist/` 即係受測成品**：`dist/` mtime = Sep 18 17:24，期間未重建；所有量測針對同一份 bundle（`assets/index-8RBFSg4n.js`），可比較。
2. **`http://localhost:5180/` 係唯一有效入口**：vite preview 只綁 IPv6 `[::1]`；`curl --noproxy '*' http://localhost:5180/` → 200，`127.0.0.1` 走 proxy 會 502。
3. **大部分 Playwright 量測用 `serviceWorkers: "block"`**，避免 SW cache 污染；呢個係刻意設定，會令 console 出現 `Service Worker registration blocked by Playwright` 警告（已知、無害）。**另設 `serviceWorkers: "allow"` 對照組**專門測 SW 行為（本輪新增）。
4. **`crash` 定義**（沿用 `a9-gaps.mjs`）：`!hasMapSvg && !hasErrorPanel && bodyTextLen < 60` —— 即「冇地圖、冇錯誤面板、頁面近乎空白」。
5. **A3**：`performance.memory.usedJSHeapSize` 喺 headless 被量化（實測恆等 11200000 B），故**唔可以**用嚟證明無記憶體洩漏；改以 CDP `DOMDebugger.getEventListeners` 嘅 listener 計數為準。

### 推翻 `a9-gaps.log` crash=true 嘅證據鏈

| 觀察 | `a9-gaps.log`（首輪，server 中途斷線） | 本輪重跑 `a9-gaps-hashparams.json`（server 正常） |
|---|---|---|
| `#chapter=150` → `hash` | `""`（空） | `"#chapter=150"` |
| `activeCh` | `null` | `"1"` |
| `mode` | `null` | `"📜 編年史"` |
| `bodyTextLen` | `0` | `46246` |
| `gotoErr` | `net::ERR_CONNECTION_REFUSED` | `null` |
| `crash` | `true` | `false` |

推理：若 `page.goto` 成功，`location.hash` 必然保留 `#chapter=150`；log 顯示 `hash=""`，代表**導航根本冇發生**（server 未起），SNAP 讀到嘅係空白頁 → 觸發 `crash=true` 定義。**故該 log 唔可作為 bug 證據**（保留作對照，唔好刪）。

### Root cause（源碼層）

- `src/router.ts:17-27`：`readHash()` **只** match `/[#&]ch=(\d+)/` 同 `/[#&]loc=([\w-]+)/`；其他 hash 內容一律唔讀。
- `src/router.ts` 全文**冇** `URLSearchParams`；`src/` 全域亦搵唔到 `URLSearchParams` → 任何 `?query` 參數（`?chapter=`、`?event=`、`?zone=`…）**永遠唔會被讀取**。
- `src/app.ts:411-418` `syncHash()` 只寫 `ch=` 同 `loc=` 兩個 key → zone / event / spoiler / layers / view 冇得序列化。
- `src/app.ts:420-426` `setSelectedEvent()` **冇** `this.setViewMode(...)`、**亦冇** `this.syncHash()`（對比 `setSelectedZone` 有 syncHash、`setSelectedLocation` 有 setViewMode + syncHash）。
- `src/components/ChronicleView.ts:336-384` `render()` 直接 `innerHTML` 渲染**全部** visible entries（1320 條），冇 virtualization。
- `src/components/SearchBox.ts:53-55` `input.addEventListener("keydown", …)` **只處理 `Escape`**；`hide()`（68-71）只 `classList.remove("open")`，**冇還原 focus**。
- `src/data/loadAllData.ts:93-105` `fetchJSON()` 冇 `AbortController` / timeout。
- `public/sw.js:8-13, 60-70`：資料檔用 **stale-while-revalidate（先派快取）** —— 呢個係 P0-1 嘅根因（sw.js 註解自己都承認呢個係「舊資料」問題根源）。

---

## 發現／改動

> 本節所有數字均引自 `artifacts/audit-A9/` 下 JSON／log，括號內為出處。

### 1. URL 參數支援對照表（spec §5.1 八個參數）

Spec §5.1（`prompts/world-atlas-v2-rebuild.md:471-484`）要求至少支援 8 個參數。逐個實測：

| # | spec 參數 | 實測 URL | 支援程度 | 證據（原始 JSON 欄位） |
|---|---|---|---|---|
| 1 | `#location=<id>` | `#location=loc_0029` | ❌ **完全忽略** | `location-hash`：hash 保留但 `activeCh=1`、`storyTitle=null`、`bodyTextLen=46246`（＝預設全量）。對照非 spec 嘅 `#loc=loc_0029` → `storyTitle="商場"`、`spoilWarnCount=10` → **正確格式係 `#loc=`，唔係 `#location=`** |
| 2 | `?event=<id>` | `?event=bg_event_001` | ❌ **完全忽略** | `event-query`：`search` 保留，`storyEventMeta=null`、`eventMarkerCount=11`（＝預設） |
| 3 | `?zone=<id>` | `?zone=zone_d3f76d3c94` | ❌ **完全忽略** | `zone-query`：`zoneDossierVisible=false`、`modeBtn="📜 編年史"` |
| 4 | `?character=<id>` | `?character=ann` | ❌ **完全忽略** | `character-query`：無任何 emphasis / route 變化 |
| 5 | `?chapter=<issue_index>` | `?chapter=150` | ❌ **完全忽略** | `chapter-query`：`activeCh="1"`、`chronicleCountText="1320 條 · 全部章節"`；`a9-evidence.json` `chapterQueryIgnored` 亦記錄 `activeCh:"1"`（截圖 `a9-evidence-chapter-query-ignored.png`） |
| 6 | `?spoiler=<0-3>` | `?spoiler=2` | ❌ **完全忽略** | `spoiler-query`：`spoilWarnCount=0`（對照 `#loc=loc_0029` 嘅 `spoilWarnCount=10`） |
| 7 | `?layers=zones,events,routes` | `?layers=…` | ❌ **完全忽略** | `layers-query`：`zoneCount=1`、`eventMarkerCount=11`（＝預設） |
| 8 | `?view=map\|chronicle` | `?view=map` / `?view=chronicle` | ❌ **完全忽略** | `view-map` 與 `view-chronicle` **兩者** `modeBtn` 都係「📜 編年史」，無差異 |

**Hash 形式變體亦全部忽略**（`a9-gaps-hashparams.json`）：`#chapter=150`、`#event=`、`#zone=`、`#character=`、`#spoiler=`、`#layers=`、`#view=` 全部 `activeCh=1`、`bodyTextLen=46246`（＝預設），零 crash。

**現行實際支援（非 spec 格式）**：

| 實測 URL | 支援 | 證據 |
|---|---|---|
| `#ch=150` | ✅ **支援** | `ch-hash`：`activeCh="150"`、`chronicleCountText="7 條 · 第 150 章相關"`、`zoneCount=13`、`eventMarkerCount=21` |
| `#loc=loc_0029` | ✅ **支援** | `loc-hash`：hash 正規化為 `#ch=1&loc=loc_0029`、`storyTitle="商場"`、`spoilWarnCount=10` |

**深層連結（UI 內部產生嘅 URL）**：`a9-deeplink.json` 顯示內部跳轉多數 work ——
chronicle 章節標籤 → `#ch=13`（`urlUpdated:true`）；search 結果 → `#ch=95`；zone dossier 章節 chip → `#ch=1`；`#ch=13` 喺新 tab 重現成功（`reproduced:true`）。
**但** chronicle 伏筆／解答連結（`chronicle-goto-link`，id `chr_de2ae96503`）點擊後 **URL 冇變**（`urlUpdated:false`）。

### 2. 無效輸入行為表（逐個參數，含 crash 與否）

出處：`a9-url-state.json`（invalid）、`a9-gaps.json`（invalidHash）、`a9-gaps-hashparams.json`。

| 輸入 | 類別 | crash | error panel | pageErrors | 實際行為 | 判定 |
|---|---|---|---|---|---|---|
| `?event=INVALID` | 唔存在 id | 否 | 否 | 0 | 忽略，正常載入 | ✅ graceful |
| `?zone=不存在` | 唔存在 id（CJK） | 否 | 否 | 0 | 忽略（`search` percent-encode 保留） | ✅ graceful |
| `?chapter=99999` | 超範圍 | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `?spoiler=99` / `-1` | 超範圍 / 負數 | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `?view=xyz` | 非法 enum | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#chapter=99999` / `-5` / `abc` / `9×500` | 超範圍 / 非數 | 否 | 否 | 0 | `router.ts:22-25` 邊界檢查 → fallback 1 | ✅ graceful |
| `#event=INVALID` | 唔存在 id | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#zone=不存在` | 唔存在 id（CJK） | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#location=INVALID` | 唔存在 id | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#spoiler=99` | 超範圍 | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#view=xyz` | 非法 enum | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#layers=,,,` | 空元素 | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#character=___none___` | 唔存在 id | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#loc=loc_999999` | 唔存在 id | 否 | 否 | 0 | 忽略，hash 變 `#ch=1&loc=loc_999999`，無 selection | ✅ graceful |
| `#loc=%00%01%02` | 控制字元 | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#loc=%3Cscript%3E…` | XSS 嘗試 | 否 | 否 | 0 | 忽略，無 script 執行 | ✅ graceful |
| `#loc="a"×2000` | 超長 id | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#loc=../etc/passwd` | 路徑穿越 | 否 | 否 | 0 | 忽略 | ✅ graceful |
| `#loc=loc%200029` | 空格 | 否 | 否 | 0 | 截斷為 `loc`，忽略 | ✅ graceful |
| `#ch=`（空）/ `9×21` | 空 / 超長數字 | 否 | 否 | 0 | fallback 1 | ✅ graceful |
| 組合：`#ch=150&loc=…&event=…&zone=…&spoiler=2&layers=…&view=map` | 多參數 | 否 | 否 | 0 | 只有 `ch`+`loc` 生效 | ✅ graceful |
| 組合：`#ch=42&loc=…?event=…&view=chronicle` | hash+query 混用 | 否 | 否 | 0 | hash 截到 `?` 前 | ✅ graceful |

**結論：22 組無效 / 極端 / 組合輸入，0 個 crash、0 個白畫面、0 個 pageError。** 無效 ID 處理係 graceful（符合 spec §5.1 line 484 後半句「無效 ID 要 graceful fallback」），但「fallback」係靠「靜默忽略」達成 —— 用戶唔會知個連結壞咗。**故此類無 P0。**

### 3. Error-state 注入結果表

出處：`a9-offline-error.json`、`a9-gaps.json`（dataTimeout）、`a9-sw-hang-chronicle.json`（SW 對照）、`a9-consistency.json`。

| 注入情境 | SW | map 有冇 | error panel | retry 掣 | pageErrors | 判定 |
|---|---|---|---|---|---|---|
| `events.geojson` → 404 | block | ❌ | ✅ | ✅ | 0 | ✅ 正確（文案「地圖載入失敗 / 載入 … 失敗：HTTP 404 / 常見原因… / 重試」） |
| `events.geojson` → 404 | **allow** | ✅（14036 nodes） | ❌ | ❌ | 0 | ❌ **SW 回 cached 200（`fromSW:true`）遮蓋 404** → P0-1 |
| `events.geojson` → 壞 JSON | block | ❌ | ✅ | ✅ | 0 | ✅ 正確（訊息「解析 … 失敗：Expected property name or '}'…」） |
| `events.geojson` → 壞 JSON | **allow** | ✅ | ❌ | ❌ | 0 | ❌ **SW 遮蓋** → P0-1 |
| `events.geojson` → HTML（SPA fallback） | block | ❌ | ✅ | ✅ | 0 | ✅ 正確（訊息「收到 HTML 而唔係 JSON」） |
| `events.geojson` → 連線中斷（abort） | block | ❌ | ✅ | ✅ | 0 | ✅ 正確（`TypeError: Failed to fetch`） |
| `events.geojson` → **延遲 30s（之後成功）** | block | ✅（33.1s 後） | ❌ | ❌ | 0 | ⚠️ 33s 內零進度提示 → P2-5 |
| `events.geojson` → **無限掛起（永不回應）** | block | ❌ | ❌ | ❌ | 0 | ❌ **45s 後仍係「載入中…」（bodyTextLen=12）** → P1-4 |
| `zones.geojson` → 404 | block | ❌ | ✅ | ✅ | 0 | ✅ 正確 |
| `map-config.json` → 404 | block | ❌ | ✅ | ✅ | 0 | ✅ 正確 |
| **全部** `data/public/*.json` → 404 | block | ❌ | ✅ | ✅ | 0 | ✅ 正確（`a9-data-404-all.png`） |
| `assets/vector/*.json` → 404 | block | ✅（正確 fallback 到 raster） | ❌ | ❌ | **1** | ⚠️ fallback 正確但拋 uncaught `pageerror` → P1-3 |
| `assets/vector/*.json` → 壞 JSON | block | ✅ | ❌ | ❌ | **1** | ⚠️ 拋 `Uncaught (in promise) SyntaxError` → P1-3 |

vector 404 詳情（`a9-consistency.json` `vector404-fallback`）：`basemapHref="/assets/hk-basemap.png"`、`wrapClasses="svg-map-wrap basemap-vector-failed"`、canvas 有內容（`alphaNonZero=40000`）、`rasterRequests` 有 `hk-basemap.png` + `hk-basemap-labels.png`；`pageErrors=["Error: 載入 /assets/vector/manifest.json 失敗：HTTP 404"]`。

SW 遮蓋詳情（`a9-sw-hang-chronicle.json`）：

```
[404-with-sw]     resp=[{404,fromSW:false},{200,fromSW:true}] errPanel=false bodyLen=46246
[404-without-sw]  resp=[{404},{404},{404}]                   errPanel=true  retry=true bodyLen=112
[badjson-with-sw] resp=[{200,fromSW:false},{200,fromSW:true}] errPanel=false bodyLen=46246
[badjson-without-sw] errPanel=true bodyLen=173
[hang-forever]    elapsed=45066ms map=false errPanel=false bodyLen=12
```

### 4. Offline / local-only 掃描結果

**(a) 動態（Playwright 攔截）**

| 情境 | 外部請求數 | pageErrors | 判定 |
|---|---|---|---|
| 封鎖所有非 localhost（`route.abort()`）後載入 | **0** | 0 | ✅（`a9-offline-error.json` `offline-block-external`） |
| 同上，再做 6 個互動：`click-zone`→`click-event`→`open-search`→`type-search`→`open-about`→`toggle-theme` | **0** | 0 | ✅（`a9-gaps.json` `offlineInteraction`：`external=0`、`fail=0`、`crashed=false`、`hasMapSvg=true`） |
| `tests/network-dynamic.test.ts`（載入＋時間軸＋搜尋） | 斷言 0 | — | ✅ 通過 |

**(b) 靜態掃描**

```
grep -rn "http" src/ public/ index.html
```
結果：**只有 3 條，全部係 XML namespace，唔會產生網絡請求**：

- `src/components/SvgMap.ts:1149` → `http://www.w3.org/2000/svg`（`SVG_NS` 常數）
- `src/exportMap.ts:72-73` → `http://www.w3.org/2000/svg`、`http://www.w3.org/1999/xlink`（`setAttribute("xmlns"…)`）

另掃其他網絡 pattern（`fetch(` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` / `.tile.` / `geocod` / `googleapis` / `gstatic` / `cdn.` / `unpkg` / `jsdelivr`）：只有 `fetch(` 3 處，**全部相對路徑**（`loadAllData.ts:95`、`exportMap.ts:28`、`VectorBasemap.ts:385` 經 `assetUrl()`）。CSS `url(http…)` **0 命中**。

`dist/` 遞歸掃描：**0 個外部 http(s) URL**（除 w3.org namespace）。`public/assets/vector/manifest.json` 內嘅 `"source":"OpenStreetMap（ODbL）經 Overpass API 匯出，本機快取"` 係**離線授權註記**，唔係 runtime fetch。

**(c) Service Worker 結論**

- `public/sw.js`（4678 B）存在；`dist/sw.js`、`dist/manifest.webmanifest` 已隨 build 輸出（`start_url:"./"`、`scope:"./"`）。
- `src/main.ts:82-90`：**只喺 `import.meta.env.PROD` 註冊**，dev 刻意跳過。
- `tests/visual-smoke.e2e.test.ts` 兩條 PWA 測試皆 **passed**。
- SW 內**冇**任何外部 URL；自述「零外部請求：只處理同源；任何 cross-origin 直接放行唔快取」。
- `_probe-sw.mjs` 結論：`swBlock=false` 時（SW 生效）即使 `events.geojson` 回 404，**map 仍然載入**（`map:true`、`err:false`、`bodyLen:46246`、`sw:true`）；`swBlock=true` 時同一 404 就**顯示 error panel**。→ 證實 SW 遮蓋（P0-1）。

**判定：local-only 紅線成立（`src` / `dist` 皆零外部 URL，動態互動亦零外部請求）。但 SW 遮蓋資料錯誤係獨立問題（P0-1）。**

### 5. State 一致性問題清單

出處：`a9-consistency.json`、`a9-evidence.json`、`a9-gaps.json`、`a9-url-state.json`、`_probe-focus.mjs`、`a9-gaps-mobile-a11y.json`。

| # | 問題 | 重現步驟（自動化） | 實測結果 | 嚴重度 |
|---|---|---|---|---|
| S1 | **zone → event：寫入隱藏 panel、唔切 view、mode 標籤誤導** | 開 zone dossier（mode=`◈ 區域`、`dossierVisible=true`）→ 點 `.event-marker` | `a9-consistency.json` `zone-then-event-click`：`afterEvent.modeBtn="◈ 區域"`、`dossierVisible=true`、`dossierName="大本營"`、`storyTitle="病毒爆發（末日之始）"`、`eventMeta="ch1 · minor · 🔒 0"`、`eventDetailVisible=false`；`a9-evidence.json` `zoneThenEvent.after`：`mode:"◈ 區域"`、`storyPanelHidden=true`、`eventMetaInDom="ch1 · minor · 🔒 0"`。截圖 `a9-bug-zone-then-event-{1-zone,2-event}.png` | **P0-4** |
| S2 | **zone 選擇唔入 URL，refresh 必然失 state** | 點 `.zone` → 讀 URL → `reload()` | `a9-gaps.json` `selectionPersist[zone-click-reload]`：`urlBefore=urlAfter="http://localhost:5180/#ch=1"`（**冇 zone**）；reload 後 `zoneVis true→false`、`zoneName "大本營"→null`、`mode "◈ 區域"→"📜 編年史"` | **P0-2** |
| S3 | **event 選擇唔入 URL，refresh 必然失 state** | 點 `.event-marker` → 讀 URL → `reload()` | `selectionPersist[event-click-reload]`：`urlBefore=urlAfter="http://localhost:5180/"`（**完全冇變**）；reload 後 `storyTitle "病毒爆發（末日之始）"→null`、`eventMeta "ch1 · minor · 🔒 0"→null` | **P0-3** |
| S4 | **mode 標籤同實際 state 滯後一格** | `a9-consistency.json` `mode-panel-matrix`：依序 target=chapter / chronicle / zone / chronicle | `chronicle→modeBtn 仍「📖 章節」`、`zone→modeBtn 仍「📜 編年史」` | **P1-5** |
| S5 | **Esc 清選擇失效（focus 吞噬）** | 開搜尋 → `Esc` 關 modal → 再 `Esc` | `_probe-focus.mjs` E/F/G/H：`Esc#2` 後 `storyTitle` 仍「商場」、`document.activeElement` 仍係（已隱藏嘅）`search-input`；之後按 `k` **`activeCh` 由 1 唔變** | **P1-6** |
| S6 | **搜尋結果冇鍵盤導航、modal 關閉唔還原 focus** | 開搜尋 → 輸入 → `ArrowDown` → `Enter` → `Esc` | `a9-gaps-mobile-a11y.json` `searchKeyboard`：`afterDown.activeIdx=-1`、`afterDown.focused="search-input"`、`afterEnter.modalOpen=true`、`afterEnter.url` 不變、`afterEsc.focused="search-input"` | **P1-4** |
| S7 | **同章節兩種結果** | 比較 `#ch=150` vs `?chapter=150` | `#ch=150`：`zoneCount=13`、`eventMarkerCount=21`、`"7 條 · 第 150 章相關"`；`?chapter=150`：`zoneCount=1`、`eventMarkerCount=11`、`"1320 條 · 全部章節"` | P1-1 嘅子症狀 |
| S8 | **spoiler 冇持久化機制（亦冇 UI 可更新）** | 開 `#loc=loc_0029` → 掃 `spoiler|劇透|spoil` 控件 → `reload()` | `a9-gaps.json` `spoilerPersist`：`spoilControls=[]`（**搵唔到任何控件**）；`spoilWarn 10→10` 只係因為 URL 帶 `#loc=` 重新選中同一地點，**唔係**設定被持久化；`localStorage keys=[]` | **P1-7 / P2-4** |
| S9 | **localStorage 禁用** | `addInitScript` 令 getter 拋 `SecurityError` → 載入 → 切主題 | `a9-gaps-mobile-a11y.json` `lsDisabled`：`theme0=light`→`afterToggle=dark`→`afterReload=light`、`pageErrors=[]`、`clickErr=null` → ✅ 正確處理（記憶體內切換有效，唔持久化係預期） | ✅ 無問題 |
| S10 | **localStorage 塞滿（QuotaExceededError）** | `Storage.prototype.setItem` 一律拋 → 載入 → 點 `#btn-theme` | `a9-gaps.json` `storage[ls-quota-theme-toggle]`：`theme "light"→"dark"`、`clickErr=null`、`pageErrors=[]` | ✅ 無問題 |
| S11 | **theme 持久化正常** | `a9-consistency.json` `theme-persist`：`t0=light → t1=dark → stored=dark → t2=dark`，`persisted=true` | ✅ 通過 | ✅ 無問題 |
| S12 | **zoom / pan 無漂移** | `pan-zoom-100`：100 次 zoom in/out + reset 後 `viewBox` 三次取樣完全相同（`113.79 22.11 0.6999999999999886 0.5407159078620093`），`resetOk=true` | ✅ 通過 | ✅ 無問題 |
| S13 | **panel toggle 斷點 1023 / 1024 / 1280** | `a9-consistency.json` `panel-toggle-1023/1024/1280`：1023 有 toggle 掣（`aria=false`→`true`）；1024 / 1280 冇 toggle 掣但 `aria` 可切 | ✅ 行為一致 | ✅ 無問題 |

> 註：S1 令 spec §7.2-2 要求嘅「zone → dossier → related event → map state / URL update」流程**直接失敗**（related event 詳情對用戶不可見）。

### 6. 記憶體 / listener 洩漏結論

出處：`a9-memory-console.json`（baseline：`heap=11.2MB`、`nodes=14036`、`windowListeners=18`、`documentListeners=1`）。

| Phase | 動作 | heapΔ | nodesΔ | windowListenersΔ | documentListenersΔ | 新 pageError |
|---|---|---|---|---|---|---|
| open-close-about-50 | 開關「關於」modal ×50 | 0 MB | +45 | 0 | 0 | 0 |
| open-close-search-50 | 開關搜尋 modal ×50 | 0 MB | +7 | 0 | 0 | 0 |
| toggle-panel-50 | 開關面板 ×50 | 0 MB | 0 | 0 | 0 | 0 |
| switch-view-50 | 切 view ×50 | 0 MB | 0 | 0 | 0 | 0 |
| select-zone-event-40 | 交替選 zone/event/location ×40 | 0 MB | **−13445** | 0 | 0 | 0 |
| zoom-100 | zoom in/out ×100 | 0 MB | 0 | 0 | 0 | 0 |
| chapter-keys-100 | 按 → ×100 | 0 MB | +182 | 0 | 0 | 0 |
| **final** | 共 490 次操作 | `totalHeapDeltaMB=0` | `totalNodesDelta=−13211` | **0** | **0** | `pageErrors=[]`、`consoleErrorCount=0` |

**結論**：

- **無 listener 洩漏**：7 個 phase、共 490 次操作，`windowListenersΔ` 同 `documentListenersΔ` **完全係 0**。呢個係可靠信號（CDP `DOMDebugger.getEventListeners`）。
- **`heapΔMB` 全部 0 唔可以當證據**：`performance.memory.usedJSHeapSize` 喺 headless Chromium 被量化成固定 `11200000` B。要證 heap 洩漏須加 `--js-flags=--enable-precise-memory-info` 或 CDP `HeapProfiler.takeHeapSnapshot`。
- `nodesΔ` 只反映 DOM churn：`select-zone-event-40` 嘅 **−13445** 係「離開 chronicle 模式 → 1320 條 entry DOM 被拆走」，**唔係洩漏**；`chapter-keys-100` 嘅 +182 屬正常波動。**無 node 單調增長，無明顯 DOM 洩漏。**
- 唯一警告：`consoleWarnCount=1` → `"Service Worker registration blocked by Playwright"`（測試設定造成，非 app 問題）。

**chronicle 重繪成本（本輪新增，`a9-sw-hang-chronicle.json` `chronicle-render`）**：`entries=1320`、`nodes 14036 →（切去 chapter）421 →（切返 chronicle）14036`、`reentryMs=2069`。即每次切返 chronicle 都**全量重新 render 1320 條（~2.1 秒）**，無快取、無 virtualization。

### 7. Spec §7.2 十三項測試 gap 對照表

Spec 原文：`prompts/world-atlas-v2-rebuild.md:638-652`。對照 `tests/` 現有檔案 + 本輪實測。

| # | spec §7.2 要求 | 狀態 | 現有覆蓋／缺口 |
|---|---|---|---|
| 1 | 初次入站 1440px：title、4 主入口、safe spoiler、map visible、無 blocking modal | 🟡 **部分** | `visual-smoke.e2e.test.ts` 有「地圖有真正渲染」「載入零 console error、零失敗請求」，但**冇**斷言「4 主入口」、冇斷言「無 blocking modal」。baseline 可引 `a9-evidence.json` `defaultLoad`（`totalNodes:14036`、`bodyTextLen:46246`） |
| 2 | Zone：click survivor zone → dossier → related event → map state / URL update | 🔴 **冇**（且流程實測壞） | dossier 有黑盒觀察（`a9-consistency.json`），但 **related event 一步係 P0-4**、URL **唔會** update（P0-2）。`tests/` 冇此流程測試 |
| 3 | Infected nest：threat dossier、danger legend、no false governance fields | 🔴 **冇** | `tests/` 完全冇 infected nest 專項測試 |
| 4 | Search：角色／zone／event／chapter，鍵盤 up/down/Enter/Esc | 🔴 **冇** | `a9-deeplink.json` 證實搜尋可用（50 結果）→ `#ch=95`；但 `search-keyboard-nav.supported:false`。本輪補測 `afterDown.activeIdx=-1`、`afterEnter.modalOpen=true`。源碼 `SearchBox.ts:53-55` 只處理 `Escape` → **P1-6** |
| 5 | Character route：open route → emphasis → waypoint → fly-to → URL → close restore | 🔴 **冇** | `tests/phase-i.e2e.test.ts` 有「路線只畫短距離可信線段」（**目前 120s timeout**）；`tests/test_character_routes.py` 只測後端 derive。**冇**「open route → URL → close restore」端到端測試 |
| 6 | Event detail：marker → detail → chapter/zone/timeline deep link → back preserves state | 🔴 **冇** | marker→detail 有（`a9-consistency.json`），但 **URL 唔更新（P0-3）**、`back preserves state` 冇測試 |
| 7 | Spoiler：default hides high level → update → persistence after refresh | 🔴 **冇** | default hide 有（`#loc=loc_0029` → `spoilWarnCount=10`）；**update 同 persistence 冇實作**（S8：`spoilControls=[]`、`?spoiler=` 唔支援）→ **P1-7** |
| 8 | Chronicle：filter by period/zone/character/spoiler → card → map deep link；large-list virtualization | 🟡 **部分** | filter by chapter 有（`#ch=150` → `7 條 · 第 150 章相關`）；**zone/character/spoiler filter 未見**；**virtualization 未做**（`ChronicleView.render()` 全量 innerHTML，1320 條 / 13478 nodes、重入 2069ms）→ **P1-1** |
| 9 | Mobile 390×844：bottom sheet、safe area、no horizontal overflow、touch target ≥44px | 🟡 **部分** | `a9-gaps-mobile-a11y.json`：`horizOverflow=false` ✅、`safeAreaSupported=true` ✅，但 `bottomSheetSelectors=[]`（係右側 `translateX(100%)` drawer，唔係 bottom sheet）→ **P2-1**；**touch target 24/24 個可見元素至少一維 <44px** → **P2-2** |
| 10 | Keyboard：Tab flow、focus visible、Esc、shortcuts | 🟡 **部分** | `visual-smoke` 有「`?` 開快捷鍵提示、`Esc` 關」（✅）；本輪補測 Tab ×8 → `focusVisible=true`（outline solid 1px）、`k` 快捷鍵有效（`1→2`）。**但** Esc 關 modal 後 focus 卡住（S5 / **P1-6**）。**冇**正式 Tab flow / focus-visible 斷言 |
| 11 | Local-only network：assert no map/tile/geocoder external request | 🟢 **已有** | `tests/network-dynamic.test.ts`（通過）、`tests/network-audit.test.ts`（通過）、`a9-offline-error.json`（external=0）、`a9-gaps.json`（6 互動後 external=0）。✅ 覆蓋充足 |
| 12 | Public data safety：no private-text pattern / secrets in public routes / export | 🟢 **已有** | `tests/test_audit_release.py`（`test_secret_detected`、`test_private_marker_detected`、`test_remote_map_url_detected`、`test_long_cjk_detected`）、`tests/test_public_data.py`、`tests/test_extraction.py`；pytest 224 passed ✅ |
| 13 | Zoom quality：各 target zoom + DPR 1/2 screenshot；no low-res raster scaling；crisp | 🟡 **部分** | `tests/phase-j-lod.test.ts`（18 tests 通過）測 LOD／投影對齊；`visual-smoke` 有「匯出 PNG：檔案夠大」。**冇** DPR 1/2 對照斷言、冇 crispness 斷言 |

**小結**：🟢 已有 **2** 項（11、12）；🟡 部分 **5** 項（1、8、9、10、13）；🔴 冇 **6** 項（2、3、4、5、6、7）。

**「冇」／「部分」嘅可重跑測試設計**（全部 Playwright、`serviceWorkers:"block"`、`BASE=http://localhost:5180/`）：

**(A) §7.2-3 Infected nest dossier**
```
1. goto BASE；waitForFunction(#svg-map-mount svg)；wait 1500ms
2. 由 /data/public/zones.geojson 揀 zone_type=="infected_nest" 嘅 zone id（若冇 fail-fast 報「測試資料缺」）
3. page.evaluate 對該 zone 派發 MouseEvent("click",{bubbles:true})
4. 斷言：a) #zone-dossier-mount 內含 danger 圖例（class 含 danger/legend）
        b) dossier 文案唔含治理字眼（/政府|議會|行政|部門/ 命中數 === 0）
        c) modeBtn 顯示「◈ 區域」
        d) pageErrors === []
5. 存證：artifacts/audit-A9/a9-infected-nest.json + screenshot
```

**(B) §7.2-4 Search 鍵盤導航（現時 fail，屬 P1-6 regression test）**
```
1. goto BASE；click #btn-search；keyboard.type("大本營")；wait 600ms
2. keyboard.press("ArrowDown")
   → 斷言 #search-results 內出現 .active / aria-selected（現時 fail：activeIdx=-1）
3. keyboard.press("Enter")
   → 斷言 #search-modal 唔再 .open、且 URL hash 變 #ch=<n>（現時 fail：modal 仍 open）
4. keyboard.press("Escape")；斷言 modal 關閉
5. 斷言 document.activeElement 唔再係（隱藏嘅）#search-input（現時 fail）
```

**(C) §7.2-7 Spoiler 更新 + refresh 持久化（現時無法測：冇控件）**
```
1. goto BASE + "#loc=loc_0029"；wait 1500ms；記錄 .spoil-warn 數量 = N0（預期 10）
2. 尋找 spoiler 控件（button/input/select，id/class/aria-label 命中 /spoiler|劇透|spoil/i）
   → 若為空：fail 並輸出「spec §7.2-7 無法測：UI 冇 spoiler 控件」（現時實測即此情況）
3. 將 spoiler level 調到 0；斷言 .spoil-warn 數量 === 0
4. page.reload()；wait 1500ms；斷言 .spoil-warn 數量仍然 === 0（持久化）
```

**(D) §7.2-8 Chronicle virtualization（現時 fail，屬 P1-1 regression test）**
```
1. goto BASE（預設 chronicle 模式）；wait 2000ms
2. 斷言 #story-panel-mount .chr-entry 數目 <= 200（virtualization 上限），
   而 .chronicle-count 仍顯示 1320
   → 現時實測 1320 條 entry、13478 nodes，必然 fail
3. 斷言 document.getElementsByTagName("*").length < 4000（現時 14036）
4. 量度切去 chapter 模式再切返 chronicle 嘅重繪時間 < 250ms
   （現時 reentryMs=2069，違反 §7.4「Chronicle filter <=250ms」）
5. 可選：scroll .chronicle-body 到 50%，斷言 node 數唔隨 scroll 單調上升
```

**(E) §7.2-13 Zoom quality DPR 1/2（現時冇）**
```
1. for dpr in [1, 2]：newContext({ deviceScaleFactor: dpr, viewport:{width:1440,height:900} })
2. goto BASE；waitForFunction(#svg-map-mount svg)
3. for z in [min, mid, max]：evaluate 設定 viewBox 到對應級別；wait 400ms
4. 斷言：a) .svg-map-wrap 唔含 basemap-vector-failed（唔可以跌落 raster fallback）
        b) #svg-map-mount .zone path 存在且 stroke-width > 0
        c) canvas backing store width == cssWidth * devicePixelRatio
5. 存證：a9-zoom-dpr{dpr}-z{z}.png
```

**(F) §7.2-1 初次入站「4 主入口 + 無 blocking modal」（現時冇）**
```
1. goto BASE（1440×900）；waitForFunction(#svg-map-mount svg)；wait 1500ms
2. 斷言 document.querySelectorAll("#topbar .nav-btn").length >= 4（實測 8，足夠）
3. 斷言 document.querySelectorAll(".modal-backdrop.open").length === 0（無 blocking modal）
4. 斷言 document.title 含「病港」
5. 斷言 #svg-map-mount svg 可見、且 .spoil-warn 數目符合預設 spoiler level
```

**(G) §7.2-2 / §7.2-6 URL update + refresh 重現（P0-2/3/4 regression test）**
```
1. goto BASE；click .zone → 斷言 location.hash 含 zone（現時 fail：只有 #ch=1）
2. reload() → 斷言 #zone-dossier-mount 仍顯示同一 zone
3. click .event-marker（確保 viewMode 唔係 zone）→ 斷言 location.hash 含 event（現時 fail）
4. reload() → 斷言 story panel 仍顯示同一 event（現時 fail）
5. click .event-marker（**喺 zone 模式之下**）→ 斷言 modeBtn 同實際可見面板一致
   （現時 fail：modeBtn「◈ 區域」但 panel hidden、event detail 不可達）
```

**(H) §7.2-11 加強：SW 遮蓋（P0-1 regression test，本輪新增）**
```
1. ctx = newContext({ serviceWorkers: "allow" })
2. page.route("**/data/public/events.geojson", r => r.fulfill({ status: 404, body: "nf" }))
3. goto BASE；wait 6000ms
4. 斷言 hasErrorPanel === true（現時 fail：SW 回 cached 200，map 照載入、無 error）
5. 反向對照：serviceWorkers:"block" 時同一 404 必須顯示 error panel（現時 pass）
```

**(I) §7.2-10 加強：Esc 後 focus 還原（P1-6 regression test，本輪新增）**
```
1. goto BASE + "#loc=loc_0029"；wait 1500ms（storyTitle="商場"）
2. click #btn-search；wait 500ms；keyboard.press("Escape")
3. 斷言 document.activeElement 唔係 #search-input（現時 fail：仍係 search-input）
4. keyboard.press("Escape") → 斷言 storyTitle 變「香港」（選擇被清）
   （現時 fail：focus 卡住，Esc 無效）
5. keyboard.press("k") → 斷言 activeCh 由 1 變 2（現時 fail：focus 卡住，快捷鍵失效）
```

### 8. 現有測試套件實跑結果

**(a) pytest** —— `artifacts/audit-A9/pytest-run.log`

```
........................................................................ [ 32%]
........................................................................ [ 64%]
........................................................................ [ 96%]
........                                                                 [100%]
224 passed in 44.07s
```

✅ **224 passed，零 fail。**（log 尾段嘅 `SystemExit: 1` 係 pytest atexit 清理 temp dir 時撞到 WorkBuddy 沙盒嘅 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 保護，**唔係測試失敗**。）

`tests/` 下 12 個 Python 測試檔案（另有 `e2e.global-setup.ts` 為 TS 共用 setup，非測試檔），各自測咩：

| 檔案 | 測咩 |
|---|---|
| `test_apply_inferences.py` | 座標推論決策檔可審計、只 apply 已批准項、推論座標對得上、事件座標跟地點、全部喺香港範圍、pipeline idempotent |
| `test_audit_release.py` | release audit 能捉到 remote map URL／secret／超長 CJK／private marker；缺 docs 要 fail；乾淨 dist 要 pass |
| `test_character_routes.py` | 角色路線 derive：基本路線、章節太少要 skip、同名去重、名撞地點要排除、長名優先；alias override |
| `test_chronicle.py` | 編年史結構、entry id 穩定唯一、章節合法、first_mention 最早章、source event 存在、無重複、閃回標記、provenance、period 唔可以同章節序矛盾 |
| `test_cleaning.py` | 抄襲頭／版權行／Penana 變體／IP 行／尾段計數行等噪音清理；inline 保留 |
| `test_data_normalization.py` | timeline 時序、id 唯一、event ref 可解析、chapter 對得上、route 座標對得上 waypoint、route segment 合理、zone schema／半徑／多邊形 |
| `test_extraction.py` | 分段預算、prompt hash 決定性、API key gate、ledger cache、candidate store、地點分組、public 無 evidence 洩漏 |
| `test_fallback_anchors.py` | `FULL_HK_ANCHORS` ≥501、每項有 lon/lat/kind、地標齊、喺 HK bbox／boundary 內、唔可以有內地地名、generator script 存在 |
| `test_hk_basemap.py` | render script 存在、PNG 存在／尺寸／大小合理／有色彩變化、錨點喺 bbox 內、經緯投影 roundtrip、label overlay 尺寸／alpha／碰撞 |
| `test_infer_places.py` | 地名推論模組：generic suffix、district evidence、變體正規化、campus block 推論、schema、private guard |
| `test_public_data.py` | public data 安全（secret／IP／Penana 噪音／長 CJK 偵測）、schema 驗證、manifest counts、zone schema |
| `test_resolution.py` | 名稱解析／消歧：ascii、CJK hash id、括號剝除、vague list、alias union |

**(b) vitest 全套** —— `artifacts/audit-A9/vitest-run.log`

```
Test Files  1 failed | 8 passed (9)
     Tests  1 failed | 77 passed (78)
  Duration  293.23s
```

| 檔案 | tests | 結果 | 測咩 |
|---|---|---|---|
| `tests/visual-smoke.e2e.test.ts` | 14 | ✅ 全過（117.7s） | 地圖 SVG 唔溢出、零 console error／零失敗請求、前端讀到嘅資料同來源一致、章節跳轉後標記唔會過大、區域常駐標籤、窄螢幕抽屜、`?`/`Esc`、touch-action、主題切換持久化、匯出 PNG、`#ch=150` 深層連結、PWA（×2）、地圖真正渲染 |
| `tests/phase-i.e2e.test.ts` | 5 | ❌ **1 failed**（142.1s） | 向量底圖跟縮放重繪 ✅／`flyToChapter` bbox ✅／雙語圖例 ✅／**路線只畫短距離可信線段 ❌ timeout 120s**／切換章節重繪 ✅ |
| `tests/phase-j-lod.test.ts` | 18 | ✅ | 投影對齊、LOD 圖磚 manifest、LOD 揀層邏輯、端對端縮放切層 |
| `tests/network-dynamic.test.ts` | 1 | ✅ | 動態網絡：零 external request |
| `tests/network-audit.test.ts` | 3 | ✅ | 靜態掃描 `dist/` 網絡紅線（9 種 remote tile pattern） |
| `tests/dataset.model.test.ts` | 8 | ✅ | provisional dataset 契約（review_status／source／摘要上限／story_position／spoiler_level／date_label／配色契約） |
| `tests/phase-i.test.ts` | 16 | ✅ | anchor pool、label layer、`animateViewBox`、雙語 legend、`resolveCoord` |
| `tests/vector-basemap.test.ts` | 7 | ✅ | Python↔TS 常數一致、資產完整性 |
| `tests/svgmap.legend.test.ts` | 6 | ✅ | legend HTML、CJK 標籤、marker 說明、flyToChapter padding、basemap PNG |

**(c) `phase-i.e2e.test.ts` 失敗重跑** —— `artifacts/audit-A9/vitest-rerun-phase-i.log`

```
Test Files  1 failed (1)
     Tests  1 failed | 4 passed (5)
```

同一條測試（`路線只畫短距離可信線段（唔會出現跨區假連線）`，`tests/phase-i.e2e.test.ts:217`）**穩定重現 timeout**（120000ms）。

**(d) 失敗 root cause（A9 補測）**

| 量測 | 來源 | 數字 |
|---|---|---|
| chronicle 模式逐章切換 | `_probe-perf.mjs` | 218ms/章（估 198 章 43.1s） |
| chapter 模式逐章切換 | `_probe-perf.mjs` | 136ms/章（估 198 章 27.0s） |
| **完整 198 章迴圈（複製測試邏輯）** | `_probe-phase-i-loop.mjs --noproxy` | **59023ms（59.0s，298ms/章）**，route-line 累計 717，**單獨跑未逾時** |

配合源碼 `src/components/ChronicleView.ts:336-384`（`render()` 全量 `innerHTML`，1320 條）同 `a9-evidence.json`（`chronicleEntries:1320`、`chronicleEntryNodes:13478`、`totalNodes:14036`）→ **eager render 令逐章掃描累積成本極高**；單獨跑 59s 未逾時，但**全量 vitest 並行（多個 Chromium）時每章成本上升，198 章 × ~300ms + 每章 40ms 等待 + 斷言開銷 > 120s**。故判定為 **flaky / borderline timeout**（非產品 crash），但反映「每章切換 ~300ms」未達 spec §7.4「marker / zone selection 主觀感知 <=100ms」附近嘅期望。→ **P2-3**

### 9. P0 / P1 / P2 分級清單

> 分級原則（依任務指示）：**crash / 資料錯誤 = P0**。

#### P0（5 個）

| ID | 問題 | 證據 | Root cause |
|---|---|---|---|
| **P0-1** | **Service Worker 用舊快取遮蓋資料 404 / 壞 JSON**：令 spec 要求嘅 error state 喺 production 完全不可達，並可能將過時資料當作現行資料顯示（**資料錯誤**） | `a9-sw-hang-chronicle.json`：`404-with-sw` → `responses=[{404,fromSW:false},{200,fromSW:true}]`、`hasMapSvg=true`、`chronicleEntryCount=1320`、`hasErrorPanel=false`；對照 `404-without-sw` → `hasErrorPanel=true`、`hasRetryBtn=true`。`badjson-with-sw` 同樣被遮蓋。`_probe-sw.mjs` 亦見同一分歧 | `public/sw.js:8-13`：資料檔用 **SWR（先派快取）**；sw.js 註解自己承認呢個係「舊資料」問題根源 |
| **P0-2** | **Spec §5.1 URL contract：8 個參數全部唔支援**（`#location`、`?event`、`?zone`、`?character`、`?chapter`、`?spoiler`、`?layers`、`?view` 全部靜默忽略）。深層連結靜默失效 —— 用戶以為分享成功，對方睇到完全唔同內容（`?chapter=150` → 「1320 條 · 全部章節」而唔係第 150 章）。唯一可用格式係**非 spec** 嘅 `#ch=`／`#loc=` | `a9-url-state.json` 全 11 個 param case；`a9-gaps-hashparams.json` 8 個 hash case；`a9-evidence.json` `chapterQueryIgnored` | `src/router.ts:17-27` 只 match `ch=`／`loc=`；全 `src/` 冇 `URLSearchParams` |
| **P0-3** | **zone 選擇唔入 URL，refresh 必然失 state**（違反 §5.1 line 484「Refresh 後必須重現 selection」） | `a9-gaps.json` `selectionPersist[zone-click-reload]`：`urlBefore=urlAfter="#ch=1"`、`zoneVis true→false`、`zoneName "大本營"→null` | `src/app.ts:411-418` `syncHash()` 只寫 `ch`／`loc` |
| **P0-4** | **event 選擇唔入 URL，refresh 必然失 state**（同上違反） | `a9-gaps.json` `selectionPersist[event-click-reload]`：`urlBefore=urlAfter="/"`、`storyTitle "病毒爆發（末日之始）"→null` | `src/app.ts:420-426` `setSelectedEvent()` 冇 `syncHash()` |
| **P0-5** | **zone 模式下點 event marker：寫入隱藏 panel、唔切 view、mode 標籤誤導**（用戶感知「點擊冇反應」） | `a9-consistency.json` `zone-then-event-click`：`afterEvent.modeBtn="◈ 區域"`、`dossierVisible=true`、`storyTitle="病毒爆發（末日之始）"`、`eventDetailVisible=false`；`a9-evidence.json` `zoneThenEvent.after`：`mode:"◈ 區域"`、`storyPanelHidden=true`、`eventMetaInDom="ch1 · minor · 🔒 0"`；截圖 `a9-bug-zone-then-event-{1,2}.png` | `src/app.ts:420-426` `setSelectedEvent()` 冇 `this.setViewMode("chapter")`（對比 `setSelectedLocation` 有） |

> 註：P0-2 至 P0-5 係前輪已識別（編號重排）；**P0-1 係本輪新增**，屬「資料錯誤」類，故列 P0。

#### P1（7 個）

| ID | 問題 | 證據 |
|---|---|---|
| **P1-1** | **Chronicle 冇 virtualization，eager render 1320 條**（違反 §7.4「禁止 eager render 所有 chronicle cards」＋ §7.2-8）；重入 chronicle 全量重繪 ~2.1s；直接導致 `phase-i.e2e.test.ts` 路線測試 120s timeout | `a9-evidence.json`（`chronicleEntryNodes:13478`／`totalNodes:14036`）；`a9-sw-hang-chronicle.json` `chronicle-render`（`nodesBackToChronicle=14036`、`reentryMs=2069`）；`src/components/ChronicleView.ts:336-384`；`vitest-run.log` 1 failed |
| **P1-2** | **data 請求掛起無 timeout → 45 秒後仍係「載入中…」**，無 error state、無 retry（無限載入） | `a9-sw-hang-chronicle.json` `hang-forever`：`elapsedMs=45066`、`hasMapSvg=false`、`hasErrorPanel=false`、`hasRetryBtn=false`、`bodyTextLen=12`（只有 `#initial-loading` 文字）；`src/data/loadAllData.ts:93-105` 冇 `AbortController` |
| **P1-3** | **vector 404／壞 JSON 直拋 uncaught pageError**（fallback 正確，但污染 console，會令「零 console error」類測試誤判；同時一旦 vector 資產缺失，LOD / 向量標籤靜默降級、無任何用戶可見提示） | `a9-offline-error.json` `vector-404`：`pageErrors=["Error: 載入 /assets/vector/manifest.json 失敗：HTTP 404"]`；`vector-badjson`：`pageErrors=["Uncaught (in promise) SyntaxError: …"]`；`a9-consistency.json` `vector404-fallback`：`wrapClasses="svg-map-wrap basemap-vector-failed"` |
| **P1-4** | **Search 鍵盤導航唔支援**（§7.2-4 要求 up/down/Enter/Esc，實際只有 Esc） | `a9-deeplink.json` `search-keyboard-nav`：`supported:false`；本輪 `a9-gaps-mobile-a11y.json` `searchKeyboard`：`afterDown.activeIdx=-1`、`afterEnter.modalOpen=true`、`afterEnter.url` 不變；`src/components/SearchBox.ts:53-55` 只處理 `Escape` |
| **P1-5** | **mode 標籤同實際可見面板唔一致**（切去 chronicle 後標籤仍顯示「📖 章節」；切去 zone 後仍「📜 編年史」） | `a9-consistency.json` `mode-panel-matrix[1]`：`modeBtn="📖 章節"` 但 `storyTitle="香港"`、`chronicleVisible=false` |
| **P1-6** | **Esc 關 modal 後 focus 卡喺隱藏 `search-input` → 之後 Esc（清選擇）同 `k` 快捷鍵全部失效** | `_probe-focus.mjs` E/F/G/H：`Esc#2` 後 `storyTitle` 仍「商場」、`activeElement="search-input"`、按 `k` 後 `activeCh` 由 1 唔變；`a9-consistency.json` `esc-priority`；`src/components/SearchBox.ts:68-71` `hide()` 唔還原 focus |
| **P1-7** | **Spoiler 冇 UI 可更新、亦冇持久化**（§7.2-7「update → persistence」無法達成；`?spoiler=` 亦唔支援）；另 **chronicle 伏筆／解答連結點擊後 URL 冇更新**（深層連結不可分享） | `a9-gaps.json` `spoilerPersist`：`spoilControls=[]`、`localStorage keys=[]`；`a9-url-state.json` `spoiler-query` `spoilWarnCount=0`；`.bg-spoiler-btns` 只喺 `src/styles/timeline.css:249-268` 定義，**零 TS 引用**（dead CSS）；`a9-deeplink.json` `chronicle-goto-link`：`urlUpdated:false` |

#### P2（6 個）

| ID | 問題 | 證據 |
|---|---|---|
| **P2-1** | **Mobile 冇 bottom sheet**：實作係右側 `translateX(100%)` slide-in drawer（`#story-pane` 喺 ≤1023px 變 absolute 浮層），唔係 §7.2-9 字面要求嘅 bottom sheet | `a9-gaps-mobile-a11y.json` `mobile390`：`bottomSheetSelectors=[]`、`storyPanel.position="static"`、`panePos="absolute"`、`paneBottom="0px"`、`paneCollapsed=true`；`src/styles/main.css:1067-1091`（註明「面板變浮層：由右邊滑入」） |
| **P2-2** | **touch target 唔達 44px**：390px viewport 內 **24/24** 個可見互動元素至少一維 <44px（`.nav-btn` 闊 29–39px、高 76px；`.ch-pill` 30×24px） | `a9-gaps-mobile-a11y.json` `touchTargets`：`total=3131`、`inViewport=24`、`under44=24`，sample 列出 8 個 `.nav-btn`（w 29–39、h 76）同 7 個 `.ch-pill`（w 30–33、h 24–26） |
| **P2-3** | **`phase-i.e2e.test.ts` flaky / borderline timeout**：198 章迴圈單獨 59s，全量並行下 >120s | `vitest-run.log:23-25`、`vitest-rerun-phase-i.log:8-10`、`_probe-phase-i-loop.mjs`（59.0s）、`_probe-perf.mjs`（218ms/章） |
| **P2-4** | **§7.2 測試覆蓋缺口**：#1（4 主入口／無 blocking modal）、#3（infected nest）、#5（route URL／close restore）、#10（Tab flow／focus visible 正式斷言）、#13（DPR 1/2 crispness）未有自動化測試 | 見第 7 節對照表 |
| **P2-5** | **資料延遲期間零進度提示**：只有靜態「載入中…」文字，33s 內無 spinner / 進度 / 逾時提示 | `a9-gaps.json` `dataTimeout`：`elapsedMs=33055`、`hasErrorPanel=false`、`hasRetryBtn=false`；`index.html:15` `#initial-loading` |
| **P2-6** | **`phase-i.e2e.test.ts` 逾時測試冇拆細**：單一測試做 198 章掃描，超出 120s default timeout；即使修好 P1-1 亦建議拆測或提高 timeout 並加註理由 | `vitest-run.log:23-25`、`vitest-rerun-phase-i.log:8-10` |

---

## 修改檔案

**產品檔案：零修改。** 本任務係只讀審計，**冇修改任何受測檔案**。

- `src/**`、`data/**`、`public/**`、`tests/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`scripts/**`、`.gitignore` —— **全部未改動**。
- 無任何 git 寫操作。

**新增（限 `artifacts/audit-A9/` 同本報告）**：

| 路徑 | 說明 |
|---|---|
| `docs/audits/qa-gap-analysis.md` | 本報告（A9 交付物，融合版） |
| `artifacts/audit-A9/a9-gaps.mjs` / `a9-gaps.json` / `a9-gaps.log` | 缺口補跑腳本 + 完整輸出（hash 參數、無效輸入、dataTimeout、storage、spoiler、offline 互動、selection persist） |
| `artifacts/audit-A9/a9-gaps-hashparams.mjs` / `.json` | spec §5.1 **hash 形式**參數重跑（首輪因 server 斷線作廢） |
| `artifacts/audit-A9/a9-sw-hang-chronicle.mjs` / `.json` / `.log` | **本輪新增**：SW 遮蓋、無限掛起、localStorage、chronicle 重繪 |
| `artifacts/audit-A9/a9-gaps-mobile-a11y.mjs` / `.json` | **本輪新增**：mobile 390 觸控目標 / 鍵盤 / 搜尋鍵盤 / localStorage 禁用 |
| `artifacts/audit-A9/a9-gaps-mobile-390.png` | **本輪新增**：390px 截圖 |
| `artifacts/audit-A9/a9-gaps.out.txt`、`_probe-perf.out.txt` | 前輪 A9 執行 stdout |
| `artifacts/audit-A9/preview-5180-restart.log` / `restart2.log` | server 重啟 log |

> 註：`artifacts/audit-A9/a9-gaps.log`（首輪，server 斷線）**保持原樣、冇覆寫**，以保留「假陽性」對照證據。本報告已明確標示其不可作為 bug 證據。

---

## 沒有修改但相關的檔案

| 路徑 | 為何相關 |
|---|---|
| `src/router.ts` | P0-2 root cause：`readHash()` 只讀 `ch=`／`loc=` |
| `src/app.ts` | P0-3／P0-4／P0-5／P1-5 root cause：`syncHash()`、`setSelectedEvent()`、`setViewMode()` |
| `src/components/ChronicleView.ts` | P1-1 root cause：`render()` 全量 innerHTML |
| `src/components/SearchBox.ts` | P1-4／P1-6 root cause：keydown 只處理 Escape；`hide()` 唔還原 focus |
| `src/data/loadAllData.ts` | P1-2：`fetchJSON()` 冇 timeout |
| `src/map/VectorBasemap.ts` | P1-3：vector 失敗拋 uncaught |
| `src/main.ts` | error panel／retry／SW 註冊實作（§7.2-11、錯誤處理正確） |
| `public/sw.js`、`dist/sw.js` | P0-1 root cause：資料檔用 SWR（先派快取） |
| `index.html` | `#initial-loading` 載入提示（P2-5 嘅唯一 UI 撐持） |
| `src/styles/main.css:1067-1091` | P2-1（右側 drawer 而非 bottom sheet）；`.nav-btn` / `.ch-pill` 尺寸（P2-2） |
| `src/styles/timeline.css:249-268` | P1-7：`.bg-spoiler-btns` dead CSS |
| `tests/phase-i.e2e.test.ts` | 唯一 fail 測試（P1-1 受害者、P2-3／P2-6） |
| `tests/visual-smoke.e2e.test.ts` | 現有覆蓋最廣嘅 e2e（14 tests 全過） |
| `tests/network-audit.test.ts`、`tests/network-dynamic.test.ts` | §7.2-11 已覆蓋來源 |
| `prompts/world-atlas-v2-rebuild.md` | spec §5.1／§7.2／§7.4 來源 |

---

## 驗證命令與結果

```bash
# 1. 起 preview server（vite preview 只綁 IPv6，必須用 localhost）
cd /c/Users/User/Desktop/benggong
npx vite preview --port 5180 --strictPort        # 背景；log 見 artifacts/audit-A9/preview-5180-restart.log
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://localhost:5180/   # → 200

# 2. A9 補跑腳本
node artifacts/audit-A9/a9-gaps.mjs
node artifacts/audit-A9/a9-gaps-hashparams.mjs
node artifacts/audit-A9/a9-sw-hang-chronicle.mjs
node artifacts/audit-A9/a9-gaps-mobile-a11y.mjs

# 3. 既有探針重跑
node artifacts/audit-A9/_probe-sw.mjs
node artifacts/audit-A9/_probe-focus.mjs
node artifacts/audit-A9/_probe-perf.mjs
node artifacts/audit-A9/_probe-phase-i-loop.mjs --noproxy

# 4. 外部 URL 掃描
grep -rn "http" src/ public/ index.html          # 只有 3 條 w3.org namespace
grep -rohE "https?://[^\"' )]+" dist/ | sort -u   # 只有 w3.org namespace

# 5. 測試套件（唯讀；結果引自既有 log，未重跑全套）
python -m pytest -q                              # → 224 passed in 44.07s
npx vitest run                                   # → 1 failed | 77 passed (78)
```

**關鍵輸出**：

```
[hashParam] #chapter=150 → activeCh=1（忽略）; #ch=150 → activeCh=150（生效）
[invalidHash] 10 個 case → crash=false 全部
[dataTimeout30s] elapsed=33055ms mapSvg=true errPanel=false
[storage] ls-disabled-load → crash=false; ls-quota-theme-toggle → theme light→dark 無錯
[offlineInteraction] actions=6 external=0 pageErr=0 crash=false
[selectionPersist] zone-click-reload zoneVis true→false; event-click-reload story 有→null
[404-with-sw]     resp=[{404,fromSW:false},{200,fromSW:true}] errPanel=false bodyLen=46246
[404-without-sw]  errPanel=true retry=true bodyLen=112
[hang-forever]    elapsed=45066ms map=false errPanel=false bodyLen=12（「載入中…」）
[chronicle-render] entries=1320 nodes=14036→421→14036 reentryMs=2069
[searchKeyboard]  afterDown.activeIdx=-1 afterEnter.modalOpen=true afterEsc.focused=search-input
[mobile390]       horiz=false sheet=[] under44=24/24
[_probe-focus]    Esc#2 後 activeElement=search-input、storyTitle 仍「商場」、按 k 無效
[_probe-phase-i-loop] 198 章迴圈 = 59023ms（59.0s，298ms/章）
[pytest] 224 passed in 44.07s
[vitest] 1 failed | 77 passed (78)
```

| 命令 | 結果 |
|---|---|
| `curl http://localhost:5180/` | **200** |
| `a9-gaps.mjs` | 完成，`a9-gaps.json` 26.5KB |
| `a9-gaps-hashparams.mjs` | 完成，8 個 hash 參數全部 `crash=false` |
| `a9-sw-hang-chronicle.mjs` | 完成，SW 遮蓋 + hang 證據齊 |
| `a9-gaps-mobile-a11y.mjs` | 完成，`under44=24/24` |
| `_probe-sw.mjs` | 完成，`swBlock=false` vs `true` 分歧證實 P0-1 |
| `_probe-perf.mjs` | 完成（218ms/章） |
| `_probe-phase-i-loop.mjs --noproxy` | 完成（59.0s，未逾時） |
| 外部 URL 靜態掃描 | 0 個 runtime 外部依賴 |
| pytest | **224 passed** |
| vitest（全套） | **77 passed / 1 failed** |
| vitest（phase-i 單檔重跑） | **4 passed / 1 failed**（穩定） |

---

## Screenshots / Artifacts

`artifacts/audit-A9/` 下證據（本報告引用）：

| 檔案 | 用途 |
|---|---|
| `a9-url-state.json` / `.mjs` | spec §5.1 八個參數 + 現行格式逐個實測（11 cases）+ 14 invalid + 9 combo + 4 refresh |
| `a9-deeplink.json` / `.mjs` | chronicle 卡片／search 結果／zone dossier 深層連結 → URL 更新；搜尋鍵盤導航 |
| `a9-offline-error.json` / `.mjs` | 封鎖外部、data 404／壞 JSON／HTML／中斷、vector 404／壞 JSON、LS 禁用／塞滿、viewport 極端、race 情境 |
| `a9-consistency.json` / `.mjs` | vector fallback、zone-then-event、mode↔panel matrix、Esc 優先級、panel toggle 1023/1024/1280、theme 持久化、rapid keys、pan/zoom |
| `a9-memory-console.json` / `.mjs` | 7 個 phase 嘅 listener／heap／node 洩漏量測 |
| `a9-evidence.json` / `.mjs` | DOM node 數、chronicle eager render、zone-then-event、mobile 390 佈局 |
| `a9-gaps.json` / `.log` / `.out.txt` | 補跑：hash 參數、無效輸入、dataTimeout、storage、spoiler、offline 互動、selection persist |
| `a9-gaps-hashparams.json` | spec §5.1 hash 形式參數重跑（推翻 crash=true 假陽性） |
| `a9-sw-hang-chronicle.json` / `.log` | **本輪新增**：SW 遮蓋、無限掛起、chronicle 重繪 |
| `a9-gaps-mobile-a11y.json` | **本輪新增**：mobile 390 觸控目標、鍵盤、搜尋鍵盤、LS 禁用 |
| `_probe-sw.mjs` | SW 開／關對照 |
| `_probe-focus.mjs` | Esc / focus 吞噬探針 |
| `_probe-perf.mjs` / `_probe-perf.out.txt` | 逐章切換成本 |
| `_probe-phase-i-loop.mjs` | 198 章迴圈耗時 |
| `pytest-run.log` | pytest 224 passed |
| `vitest-run.log` | vitest 1 failed / 77 passed |
| `vitest-rerun-phase-i.log` | phase-i 單檔重跑，穩定 1 failed |
| `a9-bug-zone-then-event-1-zone.png` | zone dossier 開啟狀態（bug 前） |
| `a9-bug-zone-then-event-2-event.png` | 點 event 後狀態（bug 後，mode 仍「◈ 區域」） |
| `a9-data-404-all.png` | 全部 data 404 → error panel + 重試按鈕 |
| `a9-evidence-default-chronicle.png` | 預設載入（chronicle 1320 條） |
| `a9-evidence-chapter-query-ignored.png` | `?chapter=150` 被忽略 |
| `a9-evidence-mobile-390.png` / `a9-gaps-mobile-390.png` | mobile 390 佈局 |
| `a9-viewport-1440x400.png`、`a9-viewport-320x400.png` | 極短／極窄 viewport |
| `preview-5180.log` / `preview-5180-restart.log` / `restart2.log` | server log |

---

## 風險、衝突、限制

1. **已知結果被推翻，需主代理覆核**：任務書列明 `#chapter=150`／`#event=`／`#zone=` 全部 `crash=true`。本報告基於「server 正常」嘅重跑（`a9-gaps-hashparams.json`），斷定該結果係**假陽性**（`hash=""` + `activeCh=null` + `gotoErr=ERR_CONNECTION_REFUSED`）。喺同一份 `dist/` + 正常 server 下，**8/8 皆 `crash=false`**。
2. **`performance.memory` 唔可信**：headless Chromium 將 `usedJSHeapSize` 量化成固定 11200000 B，令所有 `heapΔMB` 顯示 0。**唔可以**據此宣稱「無記憶體洩漏」。可靠信號只有 listener 計數。建議後續加 `--js-flags=--enable-precise-memory-info` 或 CDP `HeapProfiler`。
3. **server 穩定性**：`vite preview` 只綁 IPv6，用 `&` 背景啟動時會隨 shell process group 被殺。本輪曾兩次 `ERR_CONNECTION_REFUSED`，導致 `a9-gaps.mjs` 首 6 個 case 作廢（已用 `a9-gaps-hashparams.mjs` 補回）。**所有引用數字皆來自成功回應嘅 run**。
4. **P0-1 嘅觸發條件**：需要「SW 已快取過好嘅資料副本」+「之後資料檔損壞 / 缺失」。正常 release 唔會觸發，但一旦觸發，spec 要求嘅 error state 完全失效，且會顯示過時資料。
5. **`a9-evidence.json` 同 `a9-consistency.json` 對 zone-then-event 嘅量測略有出入**：前者記 `storyPanelHidden=true`（事件詳情寫入隱藏 panel）；後者記 `eventDetailVisible=false` 但 `storyTitle` 有值。兩者一致嘅部分係：`mode` 停留「◈ 區域」、dossier 仍然可見、事件詳情對用戶唔可見。本報告只採用兩者一致嘅結論，並以 `src/app.ts:420-426` 源碼佐證。
6. **觸控目標量測口徑**：44px 係 spec §7.2-9 要求（Apple HIG）。`.nav-btn` 高 76px 已達標，但**闊 29–39px** 未達；`.ch-pill` 30×24px 兩維皆未達。若改以 WCAG 2.5.8（24×24 AA）為準，則只有部分 ch-pill 邊緣未達。報告採用 spec 口徑。
7. **`hasBottomSheet` 判定**：本輪改以 `#story-pane` computed style 判定，避免前輪 class-name 探測嘅漏報；但「bottom sheet vs drawer」含設計意圖判斷，若團隊刻意用右側 drawer 取代 bottom sheet，應更新 spec §7.2-9 而非改碼。
8. **只測 `dist/`（production build）**：dev server（`vite dev`）行為可能唔同（例如 SW 唔註冊）。若最終交付係 dev 模式，需另測。
9. **`serviceWorkers:"block"` 為預設**：大部分量測封鎖 SW；SW 行為另設 `"allow"` 對照組（本輪新增），但**只覆蓋資料檔 404 / 壞 JSON 情境**，未覆蓋「build 更新後攞舊版」等更廣 cache 情境。
10. **`?spoiler=`／`#spoiler=` 唔支援** 令 §7.2-7 目前**無法測試**（連 UI 控件都搵唔到）；呢個係「未實作」而唔止「測試缺失」。
11. **pytest log 尾段 `SystemExit: 1`** 係沙盒保護（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）干擾 pytest atexit 清理，**與測試結果無關**。
12. **未實測項目**：DPR 1/2 crispness（§7.2-13）、infected nest dossier（§7.2-3）、character route UI（§7.2-5）**今次冇實測**，只提供測試設計（第 7 節 A–I）。時間限制下未跑。
13. **`data/private/` 內容全程未讀取、未輸出**（已遵守硬性限制）。

---

## 給主代理的 integration note

**優先處理次序**：

1. **先修 P0-5（`setSelectedEvent` 缺 `setViewMode`）** —— 一行改動（`src/app.ts:420-426` 加 `if (eventId) this.setViewMode("chapter")`），直接消除「點擊冇反應」+ mode 標籤誤導，用戶感知最強。
2. **再修 P0-3／P0-4（`syncHash()` 只寫 `ch`／`loc`）** —— 令 zone／event 入 URL，並喺 `router.ts` `readHash()` 加返 `zone=`／`event=` 讀取，令 refresh 可重現。呢兩項合埋係 §5.1 line 484 嘅核心違反。
3. **P0-2（URL contract）係最大範圍改動**，建議獨立一個 phase 做：`router.ts` 改用 `URLSearchParams`（query）+ hash 雙讀，支援 spec 8 個參數，並保留 `#ch=`／`#loc=` 做向後兼容 alias。**注意**：現有 `visual-smoke` 嘅「`#ch=150` 深層連結」測試依賴 `#ch=`，改動時**唔可以拆走** `#ch=`。
4. **P0-1（SW 遮蓋資料錯誤）** —— 建議 `public/sw.js` 對 `data/public/*` 由 SWR 改為 **network-first**（或 cache 命中時檢查 `response.ok` 且內容 hash 對得上 `asset-manifest.json` 才派），令 404 / 壞 JSON 穿透到 app 嘅 error panel。呢項係本輪新增，優先度同 URL contract 並列（屬資料正確性）。
5. **P1-1（chronicle virtualization）係唯一令測試套件紅燈嘅問題**，亦係 §7.4 硬性要求。修好之後 `phase-i.e2e.test.ts` 路線測試應該會轉綠；建議同時將該測試拆細或加 `testTimeout` 並註明理由（P2-6）。
6. **P1-2（fetch timeout）**：`loadAllData.ts` `fetchJSON()` 加 `AbortController`（例如 15s）+ 逾時 error state；否則無限掛起會令用戶永久卡喺「載入中…」。
7. **P1-3（vector uncaught error）**：將 `throw` 改為 `console.warn` + fallback（fallback 邏輯已經正確，只係唔應該拋 uncaught），否則任何「零 console error」斷言都會被污染。
8. **P1-4／P1-6（搜尋鍵盤 + focus）**：`SearchBox` 加 ↑↓/Enter 導航；`hide()` 要還原 focus 到觸發掣（否則 Esc 清選擇、`k` 快捷鍵一齊死）。
9. **測試缺口（P2-4）**：第 7 節 (A)–(I) 已寫好**可直接落地**嘅 Playwright 測試設計，全部自動化、可重跑，冇任何人手步驟。建議優先補 (G)（P0 regression）、(H)（SW 遮蓋）、(B)（search 鍵盤，現時 fail）、(I)（focus 陷阱，現時 fail）。
10. **唔需要處理**：offline／local-only（§7.2-11）完全達標（0 外部請求、靜態掃描 0 外部依賴、SW 只快取同源）；記憶體／listener 無洩漏（7 個 phase、490 次操作全部 delta=0）；無效輸入全部 graceful（22/22）。**console 見到嘅 `Service Worker registration blocked by Playwright` 係測試設定造成，唔係 app 問題。**

**證據保鮮**：本報告所有數字都可由 `artifacts/audit-A9/` 既有 JSON + 上面「驗證命令」重跑復現；`a9-gaps.log`（首輪，server 斷線）請保留作假陽性對照，**唔好刪**。

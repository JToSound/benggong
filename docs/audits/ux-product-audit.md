# A1 Product/UX Audit — 《病港》互動地圖 World Atlas V2

> 審計對象：**現行 production 版本**（branch `refactor/world-atlas-v2`，baseline commit `0260ecb9272470b220fe2b98f54947858c05078b`）
> 審計方式：只讀 production code + Playwright 1.62.1 實測（desktop 1440×900 / tablet 768×1024 / mobile 390×844）
> preview server：`http://localhost:5180/`
> 所有數字均為本代理實測，非估計。與 `artifacts/audit-context/baseline-findings.md` 不符者已在文中註明。

---

## 任務摘要

我對現行版本完成 Product/UX 只讀審計，聚焦 Journey A–E、資訊層級、entry point 設計、progressive disclosure、spoiler 模式。

**結論：現行版本唔係「UI 未夠靚」，而係「世界地圖呢個產品根本未存在」。** 最關鍵嘅三點：

1. **世界 territory 系統 0% 可見、0% 可點。** 地圖上唯一存在嘅 zone（大本營）實測 **380/380 像素完全唔可點擊**（367 px 被 `circle.event-marker` 遮住、13 px 被底圖遮住），而 polygon 本體 `.zone-area` 更被 CSS 設成 `pointer-events: none`。使用者**無論點樣點，都開唔到區域檔案**。48 個 zone 之中，首章只有 1 個符合渲染條件。
2. **劇透模式完全冇實作。** `map-config.spoiler.default_max_level = 1` 只存在於型別宣告，production 從未讀取。全部 1796 條事件（當中 **949 條 = 52.8% 屬 spoiler level ≥ 2**）預設全量顯示，冇控制項、冇持久化、冇可見範圍提示。
3. **資訊層級倒置。** 首屏可見文字 **98.1% 係右側編年史**（45,358 / 46,246 字元），地圖本身只有 84 字元；**1320 張編年史卡一次過 render 落 DOM**（`.pane-story` scrollHeight = 160,291 px ≈ 213 個 viewport 高）。「map first, data second」完全反轉。

**發現總數 20 項：P0 × 4、P1 × 9、P2 × 7。**

四條 journey 的實測結果：

| Journey | 結果 | 決定性證據 |
|---|---|---|
| A 第一次進入世界 | **失敗** | 4 個入口只有 2 個存在；`探索地區` 文案完全唔存在；冇 onboarding；首個可見 H2 係「第一季編年史」 |
| B 探索倖存區／病窩 | **完全失敗** | zone 0/380 px 可點；ch1 只有 1/48 zone；該 zone 屏幕尺寸 10×10 px（地圖寬 0.9%）且冇 label |
| C 角色旅程 | **完全失敗** | 兩次互動後只係跳章（`#ch=15`），`hasCharDossier: false`；`char-chip` click 係 `console.log` + TODO |
| D 事件／地點 | **部分失敗** | 搜尋只有 3 類（無 zone／chapter）、硬上限 50；event detail 顯示原始 id `loc_0014`；冇 precision／zone relation |
| E 深入編年史／伏筆 | **部分失敗** | 1320 卡 eager render、**0 個篩選器**（period/zone/character/type/spoiler 全部 false）、無 virtualization；expand/collapse 係唯一 disclosure |

---

## 假設與證據

### 假設
1. 以 `prompts/world-atlas-v2-rebuild.md` §0.3 北極星、§1.2 UI 原則、§3 Journey A–E、§5.1 URL contract、§7.2/§7.4 為驗收標準。
2. 「使用者」定義為首次到訪、冇讀過小說、用桌面或手機、唔識專案內部詞彙（`loc_0014`、`zone_51bf7d8190`）。
3. baseline-findings.md 的數字可直接引用；如與本代理實測不符，以本代理實測為準（已標註差異）。

### 主要實測證據（可直接覆核）

**渲染／資料實測（`artifacts/audit-A1/ux-audit*-results.json`）**

| 指標 | 實測值 | 來源 |
|---|---|---|
| `document.body.innerText.length` | 46,246 | ux-audit-results.json |
| `#story-panel-mount` 文字 | 45,358（98.1%） | ux-audit2-results.json `density` |
| `#map-pane` 文字 | 84 | ux-audit2-results.json `density` |
| DOM 節點總數 | 14,036 | ux-audit-results.json `desktop.domNodeCount` |
| `.chr-entry` render 數 | **1,320**（== dataset 總數） | ux-audit2-results.json `journeyE.entriesRendered` |
| `.pane-story` clientHeight / scrollHeight | 752 / **160,291** | ux-audit2-results.json `density` |
| `#zones-layer .zone`（ch1） | **1** | ux-audit-results.json `desktop.map.zoneCount` |
| 大本營 zone 屏幕尺寸 | 10 × 10 px（地圖寬 1060 px 的 **0.9%**） | ux-audit-results.json `zoneGeometry` |
| zone badge 可點像素 | **0 / 380**（367 被 `circle.event-marker` 遮） | 見「驗證命令與結果」 |
| zone glow 可點像素 | **0 / 144** | 同上 |
| `.zone-area` computed `pointer-events` | **none** | 同上（`main.css:458`） |
| 首屏 map / panel 面積比 | 61% / 22% | ux-audit3-results.json `firstScreen` |
| legend 佔地圖面積 | 7% | ux-audit3-results.json |
| `#topbar` 出現時間 | 465 ms（全量資料 2.6–2.8 s） | ux-audit3-results.json `timeToTopbarMs` |

**資料實測（`data/public/*`，node 直接解析）**

| 項目 | 實測值 |
|---|---|
| zones | 48（survivor 11 / nest 21 / outpost 16）；radius_m 220–800（中位 260）；`radius_source`: default 37 / members 11 |
| zone 章節可見性 | ch1=**1**、ch5=2、ch14=4、ch25=5、ch50=4、ch100=8、ch150=13、ch198=15；**只有 63/198 章有 ≥10 個 zone** |
| events | 1796；`spoiler_level` = {0:193, 1:654, **2:793, 3:156**} → 52.8% 屬 level ≥ 2 |
| `map-config.spoiler` | `{levels:0, default_max_level:1}` |
| chronicle | 1320 entries（season 1）；period 分佈 basecamp 761 / lohas 399 / endgame 106 / early 28 / outbreak 18 / pre_outbreak 8 |
| locations | 704；precision = approximate 415 / district 63 / exact 54 / fictional 172；`review_status` **全部 "reviewed"**（quarantined 0、unknown 0） |
| characters / routes | 330 / 42（README 稱 51，與 baseline §5.1 一致地不符） |

---

## 發現／改動

> 本節只列**發現**（本任務為只讀審計，冇改 production code）。每項格式：觀察證據 → root cause → 影響 journey → 相關檔案 → 修正方案 → 驗收方法 → 風險。

---

### P0-1 — 世界 territory 系統 0% 可見、0% 可點（Journey B 完全失效）

**觀察證據**
- `#zones-layer .zone` 在 ch1 只有 **1** 個（大本營）。該 zone 屏幕尺寸 **10 × 10 px**，佔地圖寬 **0.9%**，`hasLabel: false`。
- 像素級 hit test（1440×900，預設 view）：
  - `.zone-area`（bbox 144 px）：**selfHit 0 / 144**，`computed pointer-events = none`。
  - `.zone-glow`（bbox 144 px）：**selfHit 0 / 144**，全部被 `circle.event-marker` 攔截。
  - `.zone-badge circle`（bbox 380 px）：**selfHit 0 / 380**（367 px 被 `circle.event-marker`、13 px 被 `image.basemap-layer`）。
- 實際操作：點 polygon 中心 → `#btn-mode` 仍係「📜 編年史」、`#zone-dossier-mount` 文字長度 **0**、hash 空。點 badge 中心亦一樣。
- 用 `.zone-glow` stroke 逐像素掃描強制 dispatch click → `clickedGlow: false`（144 px 內冇任何像素命中 zone 元素）。
- 區域章節過濾（`SvgMap.ts:1200-1206`：`chs.some(c => c <= cur && cur <= c + 12)`）令可見 zone 數上限極低：**ch1 = 1/48，ch198 = 15/48**。
- label 只在「zone 直徑 ≥ 視窗寬 7%」時才畫（`SvgMap.ts:1308`）；大本營直徑 0.9% → 永遠冇 label。
- Legend 卻列出「倖存區（安全）」「病窩（危險）」「虛線＝範圍係估算」三項 → **legend 承諾地圖冇兌現嘅內容**。

**Root cause（三重疊加）**
1. `src/styles/main.css:458` — `.zone-area { pointer-events: none; }`。註解寫「唔應該攔截滑鼠（標記要照樣點得到）」，但代價係 **polygon 面完全唔可互動**。同檔 `main.css:1750-1754` 又再定義一次 `.zone-area`（雙重來源，見 P2-7）。
2. SVG 層序：`SvgMap.ts:501-504` 次序係 `zones-layer → routes-layer → locations-layer → events-layer`。事件層最後繪，所以 event marker **永遠蓋住** zone badge（實測 367/380 px）。
3. 渲染 gate 同視覺尺度：`SvgMap.ts:1200-1206` 用「首次出現後 12 章」窗口；`markerR()`（`SvgMap.ts:432-435`）令 zone 在半徑 220–800 m、全港視圖寬 0.7°（≈78 km）之下必然只有 ~1% 寬。

**影響 journey**：B（完全失效）；A（初始畫面冇 world territory）；E（dossier 冇入口）。

**相關檔案**
- `src/styles/main.css:458`（pointer-events）、`:1750-1754`（重複定義）
- `src/components/SvgMap.ts:501-504`（層序）、`:1200-1206`（章節 gate）、`:1208-1329`（zone 繪製）、`:1306-1326`（label gate）
- `src/components/ZoneDossier.ts`（唯一 zone 內容元件，UI 不可達）

**修正方案（程式化、可自動驗證）**
1. 移除 `.zone-area` 的 `pointer-events: none`（或改 `pointer-events: visiblePainted`）。標記唔會被搶走 —— 因為 `#events-layer` / `#locations-layer` 在 DOM 後方，命中優先序天然較高（實測已證明 event marker 贏）。
2. 引入 **World Territory LOD**：在 overview zoom（`viewScale <= 1.2`）無條件渲染全部 48 個 zone 嘅邊界 + 類型 pattern + 名稱，唔受 12 章窗口限制；章節窗口只適用於 zoom-in 之後嘅「本章活躍 zone」高亮。
3. 對 zone 加**最小屏幕尺寸**（例如 badge 半徑下限 11 px、boundary stroke 下限 1.5 px），並在 `viewScale` 低時把 badge 提升到 `#events-layer` 之上（或將 badge 移入獨立 `#zone-badge-layer` 放最後）。
4. 令 legend 由靜態 key 變成 layer control（見 P2-2），zone 層可獨立 toggle。

**驗收方法（Playwright，可重跑）**
```js
// 1) world view 必須見到全部 territory
expect(await page.locator('#zones-layer .zone').count()).toBeGreaterThanOrEqual(48);
// 2) 每個 zone 至少一個像素可點
const hit = await page.evaluate(() => [...document.querySelectorAll('#zones-layer .zone')].map(z => {
  const bb = z.querySelector('.zone-area').getBoundingClientRect();
  for (let x = Math.floor(bb.left); x <= Math.ceil(bb.right); x++)
    for (let y = Math.floor(bb.top); y <= Math.ceil(bb.bottom); y++) {
      const e = document.elementFromPoint(x, y);
      if (e && e.closest('.zone') === z) return true;
    }
  return false;
}));
expect(hit.every(Boolean)).toBe(true);
// 3) 點 zone 中心 → dossier 有內容 + URL 有 zone
await page.locator('#zones-layer .zone').first().click({ position: 'center' });
expect(await page.locator('#zone-dossier-mount').innerText()).not.toHaveLength(0);
expect(page.url()).toContain('zone=');
```

**風險**：開啟 polygon 命中後，若日後有 marker 疊在 zone 之上且 z-order 反轉，會出現「點 zone 誤觸 marker」；必須以測試 2 鎖死。另外，如果 spec 決定「世界視圖唔顯示全部 48 個 zone」（例如怕視覺噪音），必須改為「按 kind 分層 toggle」，唔可以維持「1/48」。

---

### P0-2 — 劇透模式完全冇實作（Journey A 預設安全失敗）

**觀察證據**
- `spoilerControl.hasButtons = 0`、`hasSelect = false`、DOM 內冇任何「劇透」字樣（`ux-audit-results.json`）。
- `grep -rn "default_max_level|provisional_mode" src/` → **只命中 `src/types/dataset.ts:229-231`（型別宣告）**，冇任何 production 讀取。
- `map-config.json` 明明有 `spoiler: { levels: 0, default_max_level: 1 }`，`loadAllData.ts:146` 亦已載入 `config`，但**從未被消費**。
- 事件資料 `spoiler_level` = {0:193, 1:654, **2:793, 3:156**}；`StoryPanel.renderEventItem()`（`:136-147`）只加一個 `🔒N` 徽章 + CSS class `spoiler-2/3`（`main.css:573-577` 只係把標題模糊化），標題、描述、地點全部照顯示。
- 持久化：`localStorage` 只有一個 key `binggang-theme`（`theme.ts:18`）→ 劇透設定無法持久化。
- 冇「資料可見範圍」提示（例如「已隱藏 949 條高劇透內容」）。

**Root cause**：spoiler 從來冇進入 App state。`App` 只有 `currentChapter / selectedLocationId / selectedEventId / selectedZoneId / viewMode`（`app.ts:30-34, 318`），冇 spoiler 維度；亦冇任何 filter layer。

**影響 journey**：A（§3 明列「預設為安全劇透模式」）；D（event detail 直接洩漏 level 3 內容）；E（chronicle 1320 條全部照出）。

**相關檔案**
- `src/app.ts:26-50`（state 定義）、`:318`（viewMode）
- `src/components/StoryPanel.ts:136-147, 249-285`
- `src/data/loadAllData.ts:146`（config 已載入但未用）
- `src/types/dataset.ts:229-231`
- `src/styles/main.css:573-577`（目前唯一「保護」，只係模糊標題）
- `src/styles/timeline.css:249-268`（`.bg-spoiler-btns` 係**死 CSS**，冇任何 TS 引用）

**修正方案**
1. App state 加 `spoilerLevel: 0|1|2|3`，初值 = `config.spoiler.default_max_level`；`localStorage` key `binggang-spoiler`；同步 URL `?spoiler=N`。
2. Header 加一個可見控制（segmented 0–3 或 slider），旁邊永遠顯示**可見範圍文案**：`顯示 spoiler ≤ N（已隱藏 M 條）`。
3. 建立單一 filter selector（B3 的 adapter layer）：events / chronicle entries / routes / characters 全部過同一個 `visibleAt(level)` 判斷；被隱藏者顯示為「🔒 劇透等級 N — 已隱藏」佔位而非完全消失（避免使用者以為資料缺失）。
4. 刪除 `timeline.css:249-268` 死 CSS，或正式接駁成 UI。

**驗收方法（Playwright）**
```js
// 預設安全
await page.goto(BASE); // 無 localStorage
expect(await page.locator('[data-spoiler-level="2"]:visible, [data-spoiler-level="3"]:visible').count()).toBe(0);
expect(await page.locator('#spoiler-control').inputValue()).toBe('1');
// 提升 → 內容出現 + 持久化
await page.selectOption('#spoiler-control', '3');
expect(await page.locator('[data-spoiler-level="3"]:visible').count()).toBeGreaterThan(0);
await page.reload();
expect(await page.locator('#spoiler-control').inputValue()).toBe('3');
// URL 還原
await page.goto(BASE + '?spoiler=0');
expect(await page.locator('#spoiler-control').inputValue()).toBe('0');
```

**風險**：level 2 佔 44%（793/1796），若預設硬擋 level ≥ 2，地圖同編年史會**大幅變空**，可能反而令人以為網站冇料。必須同時提供「已隱藏 M 條」的可見提示，並容許一鍵提升（唔可以靜默）。此決定需 A6/A8 確認資料分佈後再定稿。

---

### P0-3 — 資訊層級倒置：首屏 98% 文字係編年史，1320 卡 eager render

**觀察證據**
- 首屏文字分佈：`body` 46,246 字元；`#story-panel-mount` **45,358（98.1%）**；`#map-pane` **84**；`#topbar` 59。
- `#story-panel-mount .chr-entry` = **1,320**（等於 chronicle 總數）→ **零 virtualization**（`hasVirtualization: false`）。
- `.pane-story` clientHeight 752 / scrollHeight **160,291**（≈213 個 viewport 高）；`#story-panel-mount` clientHeight 160,259 == scrollHeight（mount 自身被撐到 16 萬 px）。
- DOM 節點 14,036；a11y tree 內有 **1,320 個 `<h4>`**（ux-audit3 `headings` 抽樣）。
- 首個可見 `<h2>` 係「第一季編年史」（`firstVisibleHeading`）→ 使用者第一眼見到嘅「主體」係資料列表，唔係地圖。
- 違反 spec §7.4「**禁止 eager render 所有 chronicle cards**」及 §2.1「時間軸／編年史需支援 virtualized / paginated rendering」。
- 違反 §1.2-2「一個主 context」：同一時間並存 map + legend + chapter strip + chronicle + sparkline timeline（`visibleModules` 全 true）。

**Root cause**
- `ChronicleView.render()`（`ChronicleView.ts:336-384`）用單一 `innerHTML` 把 `grouped()` 全部 groups × 全部 entries 一次過串接，冇 windowing。
- `app.ts:318` `viewMode` 預設 `"chronicle"`，即「資料面板」係預設主體。
- `#story-panel-mount` 冇高度上限（`main.css:974` 只設 background/padding），scroll 由 `.pane-story` 承擔（`main.css:265-270` `overflow-y: auto`），所以內容量直接等於 16 萬 px。

**影響 journey**：A（首屏唔知係世界地圖）；E（1320 條無法掃讀，篩選器又係 0 個 → 等於資料 dump）；並拖累 §7.4 效能目標。

**相關檔案**
- `src/components/ChronicleView.ts:136-173`（visibleEntries / grouped）、`:336-384`（render）
- `src/app.ts:318`（預設 viewMode）
- `src/styles/main.css:265-270, 974-1000, 1714`（`.pane-story` 三重定義）

**修正方案**
1. **Virtualization**：以 IntersectionObserver / windowed list 只 render 視窗內 ± buffer 的 period section；每個 period 先 render 標題 + 前 N 條（N=20），其餘「載入更多」或自動增量。
2. **預設主 context = 地圖**：編年史改為可召喚的 overlay / drawer（`?view=chronicle`），唔再係首屏常駐主體。
3. 首屏只保留：地圖 + 一個精簡 context 面板（預設顯示世界摘要／onboarding，唔係 1320 卡）。
4. `#story-panel-mount` 加 `contain: content` 與固定高度，避免 mount 被撐到 16 萬 px。

**驗收方法（Playwright）**
```js
await page.goto(BASE);
expect(await page.locator('#story-panel-mount .chr-entry').count()).toBeLessThanOrEqual(60);
expect(await page.evaluate(() => document.querySelectorAll('*').length)).toBeLessThan(4000);
// 捲到底仍能逐段載入，最終總數 == 篩選後總數
await page.locator('#story-panel-mount').evaluate(el => el.scrollTo(0, el.scrollHeight));
// 重複直至穩定，然後斷言總數
```
**風險**：virtualization 會令 Ctrl+F、匯出、scrollIntoView 跳轉（`ChronicleView.ts:422-425` 的伏筆跳轉）失效。必須同時實作「依 entry id 定位 + 展開」API，並保留 `#chr-export-json` 以全量資料輸出（現行 export 已正確地只輸出篩選後條目，見 `ChronicleView.ts:229-257`）。

---

### P0-4 — Journey A 冇 4 個入口、冇 onboarding、首屏唔知係《病港》世界地圖

**觀察證據**
- 8 個 nav 按鈕實測：`📜 編年史` / `🔍 搜尋` / `🔗` / `⬇` / `☀️` / `?` / `關於` / `面板`（桌面 0×0，不可見）。
- **4 個按鈕係純 emoji 且冇 `aria-label`**：`🔗` `⬇` `☀️` `?` → `accessibleName` 就係 emoji 本身（ux-audit3 `a11y.navButtons`）。baseline 講「3 個」，實測係 **4 個**。
- spec 要求嘅 4 個入口：`entryPointTexts.探索地區 = **false**`；`搵角色`/`搵事件`/`打開編年史` 之所以 true，只係因為 body 內文出現過「角色」「事件」「編年史」等字，**唔係入口按鈕**。
- `onboardingMatches` 只有 `["第一次"]`（來自章節摘要正文「讀者幾時第一次知」一類字串）→ **冇任何 onboarding**。
- 首屏可見內容：地圖 61% 面積、legend 7%、右側 panel 22%；地圖上只有 11 個 event marker + 5 個 location marker/cluster + 1 個 zone + 1 條 route，但 legend 列 9 項。
- 唯一「呢個網站係咩」嘅說明在 `AboutModal`（`app.ts:148`），要點「關於」或按 `?` 才會出現，且 `?` 冇文字標籤。
- `map-config.json` 的 `provisional_mode.banner`（「…仍待人工審閱…未經最終人工確認」）**完全冇 render**，使用者見唔到任何資料可信度聲明。

**Root cause**：header 只係功能按鈕列，冇資訊架構（IA）；冇 onboarding layer；legend 係靜態 key 而唔係 layer control；`provisional_mode` 未接駁。

**影響 journey**：A（完全失敗）。

**相關檔案**
- `src/app.ts:80-99`（header HTML）、`:148-153`（nav 綁定）
- `src/components/SvgMap.ts:507-524`（legend HTML）
- `src/components/AboutModal.ts:43-92`（唯一說明）
- `src/components/ChapterStrip.ts:39-52`（198 pill）
- `data/public/map-config.json`（`provisional_mode.banner`）

**修正方案**
1. Header 改為 **4 個具名主入口**：`探索地區` / `搵角色` / `搵事件` / `打開編年史`，每個都要有文字標籤（唔可以只有 emoji）。
2. Utility（分享／匯出／主題／說明）收納入 overflow menu，並補 `aria-label`；`?` 改為有文字的「快捷鍵」。
3. 加**非阻塞 onboarding**：首次到訪在右側 context 面板（唔係 modal）顯示 empty-context 卡，內容 = 一句網站定位 + 4 個入口按鈕；關閉後寫 `localStorage`，之後唔再出現。地圖完全唔被遮。
4. Legend 改為 layer control（見 P2-2）；`provisional_mode.banner` 接駁為一個可關閉的可信度 banner。

**驗收方法（Playwright）**
```js
await page.goto(BASE);
for (const n of ['探索地區','搵角色','搵事件','打開編年史'])
  await expect(page.getByRole('button', { name: n })).toBeVisible();
// 每個 nav button 的 accessible name 唔可以係純 emoji
const names = await page.locator('#topbar .nav-btn').evaluateAll(bs => bs.map(b => (b.textContent||'').trim()));
expect(names.filter(t => !/[\u4e00-\u9fffA-Za-z]/.test(t))).toHaveLength(0);
// onboarding 非阻塞 + 可持久關閉
expect(await page.locator('[data-onboarding]').isVisible()).toBe(true);
expect(await page.locator('.modal-backdrop.open').count()).toBe(0);
await page.locator('[data-onboarding-close]').click();
await page.reload();
expect(await page.locator('[data-onboarding]').count()).toBe(0);
```

**風險**：onboarding 若做成 modal 就變成「阻塞」，直接違反 §3 Journey A；必須放喺面板內。另外 4 個入口會令「編年史」同「章節條」功能重疊，需一併處理 P2-3。

---

### P1-1 — 點地圖 marker 會靜默摧毀編年史（shared mount + viewMode 唔同步）

**觀察證據**
- 在 chronicle 模式（預設）點一個 event marker：
  - `#story-panel-mount .chr-entry`：**1320 → 0**
  - `.chronicle` 由 `true` → `false`；`.story-header` 由 `false` → `true`；`h2` 變「大眼尖叫引來病者群集」
  - `#btn-mode` **仍然顯示「📜 編年史」**（`viewMode` 仍係 `"chronicle"`）
  - `location.hash` 仍然係 `""`
- 之後按 `Esc`：panel 變「香港」（章節面板），**編年史唔會返嚟**；只有連按 `#btn-mode` 兩次才會重新 render。
- 同類情況：搜尋角色 → 揀結果 → `setChapter(15)` → 編年史被篩成「第 15 章相關」，但按鈕文字不變。

**Root cause**
- `ChronicleView` 同 `StoryPanel` **共用同一個 mount**：`app.ts:125-127` 與 `:135-139` 都掛在 `#story-panel-mount`；切換靠 `app.ts:327-330` 的 `hidden` 旗標，但 `setSelectedEvent`（`app.ts:420-426`）**冇改 viewMode**，直接叫 `storyPanel.updateForEvent()` 覆寫 mount。
- `Esc` 分支（`app.ts:302-308`）：`viewMode === "chronicle"` → 走 `else` → `storyPanel.updateForChapter()`，即永遠唔會還原編年史。
- 冇單一 `PrimaryContext` state（spec §5.1 要求），所以 UI 同 state 可以各自漂移。

**影響 journey**：D（event detail 開啟後無法返回）、E（編年史一觸即毀）、A（預設視圖不可靠）。

**相關檔案**：`src/app.ts:105-112, 302-308, 327-330, 392-426`；`src/components/ChronicleView.ts`；`src/components/StoryPanel.ts`

**修正方案**
1. 引入 `PrimaryContext`（`explore | search | zone | event | location | character | route | chronicle | chapter | measure`），**所有** selection 入口（map click / search / chronicle link / dossier link）都經同一個 `setContext()`。
2. `ChronicleView` 同 `StoryPanel` 分開 mount（例如 `#chronicle-mount` / `#context-mount`），或者由 `setContext()` 決定邊個 mount 有內容 —— 唔可以兩個同時寫同一個容器。
3. `Esc` 由 context stack 決定（overlay → context → clear selection），而唔係硬編 if/else。
4. 每次 `setContext()` 都同步 URL（見 P1-2）。

**驗收方法（Playwright）**
```js
await page.goto(BASE);                     // chronicle 模式
await page.locator('#events-layer .event-marker').first().click();
expect(await page.locator('#btn-mode').innerText()).not.toContain('編年史'); // context 已切
expect(page.url()).toMatch(/event=/);
await page.keyboard.press('Escape');
expect(await page.locator('#story-panel-mount .chronicle').count()).toBe(1); // 編年史還原
expect(await page.locator('.chr-entry').count()).toBeGreaterThan(0);
```

**風險**：若只改按鈕文字而唔改 state，問題只會轉移；必須以單一 context state 為唯一真相。

---

### P1-2 — Router 只支援 `ch` / `loc`，spec §5.1 其餘 URL 全部無效

**觀察證據**（`ux-audit3-results.json` `routerQuery`，每項均強制 reload）
| URL | 結果 |
|---|---|
| `?event=ev_0001` | 無變化（ch1 / chronicle / 1320 條） |
| `?zone=zone_d3f76d3c94` | 無變化，`dossier: false` |
| `?character=xxx` | 無變化 |
| `?chapter=50` | 無變化（仍 ch1） |
| `?spoiler=0` | 無變化（冇控制項可反映） |
| `?layers=zones,events` | 無變化 |
| `?view=chronicle` | 無變化 |
| `?location=loc_0001` | 無變化 |
| `#ch=1&zone=…` | hash 保留但 **無 dossier** |
| `#ch=999` | chapter clamp 到 1（graceful ✓）但 hash 仍留 `#ch=999`（stale） |
| `#ch=1&loc=NOPE` | `viewMode` 變「📖 章節」但 panel 冇對應內容（半壞狀態） |

- 全部 case 都冇 crash、冇 error panel → **靜默忽略**，使用者以為連結有效但其實冇效。
- `router.ts:17-27` 只讀 `window.location.hash` 的 `ch` / `loc`；`app.ts:411-418` `syncHash()` 亦只寫 `ch` / `loc`。
- 事件／zone／角色 selection 完全唔會入 URL（`setSelectedEvent` 冇呼叫 `syncHash`）。

**影響 journey**：B、C、D、E 全部嘅「分享／返回／refresh 還原」；亦令 Playwright E2E 無法以 URL 驅動（spec §7.2 要求多條 URL 測試）。

**相關檔案**：`src/router.ts:14-42`；`src/app.ts:411-418, 420-426, 356-364`

**修正方案**：實作 §5.1 URL contract（`?event=` `?zone=` `?character=` `?chapter=` `?spoiler=` `?layers=` `?view=` `#location=`），雙向 sync，無效 ID 走 graceful fallback **並顯示明確提示**（唔可以靜默）；`#ch=999` 之類要 normalize 返 URL。

**驗收方法**：對每個 URL 逐一 `goto` 並斷言 state（zone → dossier 有標題；event → detail 顯示；spoiler → 控制值；layers → layer 狀態）；`page.reload()` 後 state 一致；無效 ID → 顯示提示且唔 crash。

**風險**：URL 格式一旦公開就要穩定；建議 Gate 1 定稿後才實作。

---

### P1-3 — Journey C 完全冇角色 dossier；route 只係「跳去起始章」

**觀察證據**
- **兩次互動測試**：① 開搜尋 → ② 輸入「A隊」揀第一個「角色」結果 → 結果：`hash = "#ch=15"`、`viewMode` 仍「📜 編年史」、panel 變「第一季編年史 … 5 條 · 第 15 章相關」、**`hasCharDossier: false`**。即係「搜角色」只係跳章 + 篩章，冇角色檔案。
- `StoryPanel.ts:162-169`：`char-chip` 點擊 handler 係 `this.app.setSelectedLocation(null); // TODO: open character modal` + `console.log("char click:", name)` → **角色 chip 完全冇功能**（實測 10 個 chip）。
- `StoryPanel.ts:170-176`：`.route-item` 點擊 → `setChapter(route.chapters_span[0])` → 實測由 ch15 **跳返 ch1**，route 線由 3 條變 1 條。冇 route mode、冇 waypoint list、冇 chapter range、冇 zone relation、冇精度狀態。
- route 突出邏輯（`SvgMap.ts:1112-1117`）係「本章出現嘅路線」，唔係「選中角色嘅路線」；`routesByChapter`（`loadAllData.ts:173-187`）亦係以章節索引，唔存在 character → route 索引。
- `characters.json`（330 條）只被 `SearchBox.ts:82-94` 用嚟跳章；`AppData` 只有 `charactersByName`（`loadAllData.ts:163-166`），冇 character dossier 概念。

**影響 journey**：C（完全失敗）。

**相關檔案**：`src/components/StoryPanel.ts:162-176`；`src/components/SearchBox.ts:82-94`；`src/components/SvgMap.ts:1112-1117, 1343-1401`；`src/data/loadAllData.ts:163-166, 173-187`

**修正方案**
1. 新增 character context：角色 dossier（name / aliases / role / first_appearance / chapter_refs / description / spoiler_level / 關聯 zone / 關聯 route / 出現章節）。
2. Route mode：選中角色後地圖只繪該角色 route（`#routes-layer .route-line` == 1），其他圖層 soft-focus。
3. waypoint list：每個 waypoint 顯示 `chapter` / `zone relation` / `note` / `precision`；點擊 → fly-to 該點並更新 URL。
4. 建立 `characterById` / `routeByCharacter` index（B3 範圍）。

**驗收方法（Playwright）**
```js
await page.getByRole('button', { name: '搵角色' }).click();
await page.fill('#search-input', 'A隊');
await page.locator('.search-result-item[data-type=character]').first().click();
expect(await page.locator('#character-dossier')).toBeVisible();      // 兩次互動內
await page.locator('#character-dossier [data-action=route]').click();
expect(await page.locator('#routes-layer .route-line').count()).toBe(1);
await page.locator('.waypoint-item').first().click();
expect(page.url()).toMatch(/character=.+&waypoint=/);
```

**風險**：42 條 route 中大量 waypoint 落在 fictional 座標（172 個 fictional location），route mode 會暴露資料稀疏。必須同時顯示 `precision`／`approximate`，唔可以畫成確定路線（與 A5 結論對齊）。

---

### P1-4 — 編年史 0 個篩選器（spec Journey E 要求 period / chapter / zone / character / type / spoiler）

**觀察證據**
- `filterControls`：`period:false, zone:false, character:false, type:false, spoiler:false, search:false`（全部 false）。
- 唯一 action button：`["⬇ JSON"]`（另有條件性的「✕ 清除篩選」）。
- 可用嘅縮窄手段只有兩種：198 個章節 pill（`ChapterStrip`）同 198 個 timeline bar → 兩者都只係「按章篩」。
- Progressive disclosure 只有一層：1320 條預設全部 `collapsed`（`expansionMode: 0`、`entrySummaryVisible: 0`），即係「展開／收起」。冇「先睇時期大綱 → 再落條目 → 再睇原文關係」嘅三層結構。
- 伏筆關係（`foreshadows` / `pays_off`）實作良好（`ChronicleView.ts:316-334`），但因為冇篩選，使用者要喺 1320 條之中撞到先見到。

**影響 journey**：E（spec §3 明列 6 種篩選）。

**相關檔案**：`src/components/ChronicleView.ts:136-173, 336-384, 386-432`；`src/components/ChapterStrip.ts:39-52`

**修正方案**
1. 加 period / zone / character / event_type / spoiler 篩選（以 Map index 預建，唔可以每次 filter 掃 1320 條）。
2. 加條目內文搜尋（title + summary）。
3. 篩選狀態寫入 URL（`?view=chronicle&period=…&character=…`），可分享。
4. Progressive disclosure 三層：period 摘要（條數 + 一句概述）→ 條目標題列 → 展開摘要 + 伏筆連結。

**驗收方法**：每個篩選器存在且可操作；每次篩選結果數量單調遞減；篩選後 `#chr-export-json` 只含篩選後條目（現行已符合，需保留）；filter 響應 ≤250 ms（spec §7.4）。

**風險**：篩選 + virtualization 必須一齊設計，否則每次改篩選都 re-render 1320 卡（現時每次 `render()` 都重建全部 innerHTML，見 `ChronicleView.ts:336`）。

---

### P1-5 — Zone dossier 冇相關事件／角色／時間軸／返回世界地圖，zone 亦唔入 URL

**觀察證據**
- `ZoneDossier.ts:55-65` SECTIONS 只有：政權 / 領袖與要員 / 社會結構 / 經濟 / 防禦 / 人口 / 人文風俗 / 地標與設施 / 威脅，再加「資料來源」與「出現章節」。
- dossier 內文搜尋 `返回|相關事件|相關角色|時間軸|世界地圖` → **0 命中**（`backLinks: []`）。
- zone 冇 URL 參數（router 唔支援）→ 分享 zone 不可能。
- `events.geojson` **冇 `zone_id`**（只有 `location_id`，baseline §5.1 已記錄）→ 目前冇任何 zone→event 關係層。
- 註：因為 P0-1，dossier 實際上**無法由 UI 到達**；本代理用 stroke 掃描強制 click 亦 0 命中（`clickedGlow: false`），所以以下「內容缺漏」係靜態審計結論。

**影響 journey**：B（即使修好 P0-1，dossier 仍然係「孤立檔案」）。

**相關檔案**：`src/components/ZoneDossier.ts:47-65, 140-183`；`src/components/SvgMap.ts:1195-1201`；`src/router.ts`

**修正方案**
1. dossier 加「相關事件」（由 `location.zone_ids` 反查 events）、「相關角色」、「相關章節時間軸」、「返回世界地圖」四個出口。
2. zone 入 URL（`?zone=<id>`），refresh 還原。
3. `infected_nest` 用「威脅特徵 / 活動模式 / 影響範圍 / 關聯事件」取代政權民生欄位（spec §2.4 明確要求）；現行 `ZoneDossier` 對 nest 同 survivor 用同一組 SECTIONS，會令 nest 出現「政權：—」之類空洞欄位（現行程式碼靠 `if (!text) return ""` 跳過，所以唔會顯示假資料，但亦冇 threat-first 結構）。

**驗收方法（Playwright）**
```js
await page.locator('#zones-layer .zone').first().click();
expect(page.url()).toMatch(/zone=/);
for (const t of ['相關事件','相關角色','時間軸','返回世界地圖'])
  await expect(page.getByText(t)).toBeVisible();
await page.reload();
expect(await page.locator('#zone-dossier-mount h2')).toBeVisible();
// nest 專屬結構
await page.locator('#zones-layer .zone-nest').first().click();
expect(await page.locator('#zone-dossier-mount [data-section=threat-profile]')).toBeVisible();
expect(await page.locator('#zone-dossier-mount [data-section=governance]').count()).toBe(0);
```

**風險**：zone→event 反查依賴 `location.zone_ids` 覆蓋率（需 A5/A6 確認）；若覆蓋率低，需顯示「未足以確認關聯」而唔可以留空。

---

### P1-6 — 搜尋只有 3 類、硬上限 50、冇鍵盤導航、冇 zone/chapter

**觀察證據**
- `SearchBox.ts:158-160` `typeLabel` 只有 `角色 / 事件 / 地點`；spec §3 Journey D 要求 `character / zone / location / event / chapter` 五類。
- `SearchBox.ts:131` `results.slice(0, 50)`；搜「將軍澳」→ 50 條（32 事件 + 18 地點）並顯示「…另外 N 個結果」但**冇方法睇到其餘**。
- `hasCategoryTabs: false`、`keyboardNav: false`（冇 `aria-activedescendant`、冇 ↑/↓ 處理）→ 違反 spec §7.2「鍵盤 up/down/Enter/Esc」。
- 每次 `input` 事件都線性掃描 1796 events + 704 locations + 330 characters（`SearchBox.ts:73-128`），冇 index。

**影響 journey**：C（搵角色入口）、D（搵事件／地點）。

**相關檔案**：`src/components/SearchBox.ts:73-156`

**修正方案**
1. 建立 local index（B3）：5 類結果 + prefix/fuzzy。
2. 加分類 tab／filter chip，容許只看某一類。
3. 加鍵盤導航（↑/↓/Enter/Esc）+ `aria-activedescendant` + `role=listbox`。
4. 移除硬上限，改為分頁／虛擬列表（spec §7.4 要求 search ≤150 ms）。

**驗收方法（Playwright）**
```js
await page.click('#btn-search');
await page.fill('#search-input', '將軍澳');
expect(await page.locator('.search-cat-tab').count()).toBe(5);
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
expect(page.url()).toMatch(/(location|zone|event)=/);
// 效能
const t = await page.evaluate(async () => { const s=performance.now(); /* type */ return performance.now()-s; });
expect(t).toBeLessThan(150);
```

**風險**：index 會增加首屏記憶體；需同 A8 的 bundle/記憶體預算一齊定。

---

### P1-7 — 事件／地點 detail 顯示原始 id、冇 precision／zone relation

**觀察證據**
- event detail 實測輸出：「`← 返第 1 章 / 💫 事件 / 病毒爆發（末日之始） / CH1 · MINOR · 🔒 0 / 事件詳情 / … / 地點 / **loc_0014**」。
- `StoryPanel.ts:273` 直接 `this.escapeHtml(p.location_id)` → 使用者見到內部 id。
- `hasPrecisionField: false`、`hasZoneRelation: false`。
- location detail（`StoryPanel.ts:205-247`）只把 `p.location_precision` 原字串（英文）印出，冇圖示／冇解釋、冇「位置未能可靠確認」狀態。
- 資料實測：`location_precision` = approximate 415 / district 63 / exact 54 / fictional 172；`review_status` **全部 "reviewed"**，`quarantined = 0`、`unknown = 0` → **spec §2.2 講嘅 quarantine 狀態在現行資料唔存在**，UI 亦冇任何對應分支。所以「quarantined 座標處理」目前既無資料亦無 UI，**唔可以當作已實作**。

**影響 journey**：D。

**相關檔案**：`src/components/StoryPanel.ts:136-147, 205-247, 249-285`

**修正方案**
1. 用 `locationsById` 顯示地名（唔可以出 id）。
2. 加 `precision` 徽章元件（`verified|district|approximate|fictional|unknown`），並以 pattern/icon 表達，唔可以只靠色。
3. 加「位置未能可靠確認」狀態分支（當 `review_status` 為 `quarantined` / `needs_validation` 或 precision 為 `unknown`）；以 fixture 測試。
4. 加 zone relation（由 location.zone_ids 反查）。

**驗收方法（Playwright）**
```js
await page.locator('#events-layer .event-marker').first().click();
const txt = await page.locator('#story-panel-mount').innerText();
expect(txt).not.toMatch(/loc_\d+/);           // 唔可以出原始 id
expect(await page.locator('#story-panel-mount [data-precision]').count()).toBe(1);
```
另加 fixture 測試：注入一個 `review_status: "quarantined"` 的 location → 斷言出現「位置未能可靠確認」而唔係假座標。

**風險**：若 A5 建議大量 quarantine，detail 會出現大量「未能確認」，需同步空狀態設計。

---

### P1-8 — 移動版係「縮細 desktop」：冇 bottom sheet、冇 44px、legend 遮 49% 寬

**觀察證據（390×844，DPR 2，isMobile + hasTouch）**
- `#topbar` 高 **107 px**；標題《病港》互動地圖 **逐字換行 4 行**。
- 8 個 nav 按鈕同一排，但寬 **29–39 px**、高 76 px（`編年史` 39×76、`⬇` 29×76）→ 文字直排，且遠低於 44×44。
- `hasBottomSheet: false`（冇任何 `[class*=sheet]` / mobile dialog）。
- legend **193 × 258 px = 49% 寬 × 31% 高**，蓋住地圖左上；地圖可視區只剩下半部（mapRect 390×657）。
- `buttonsUnder44px: 3129`（含全部 chronicle／strip 小按鈕）；`safe-area-inset` 未使用；zoom 控制貼右下角。
- 橫向 overflow = false（唯一好消息）。
- Tablet 768：panel 被 `is-collapsed` 收起（`app.ts:73-75`），`#btn-toggle-panel` 變可見；legend 仍 193×258（= 25% 寬）。

**影響 journey**：A、B、C、D、E（全部）—— 因為 mobile 上根本冇一個可用嘅 context 面板流程。

**相關檔案**：`src/app.ts:60-77`；`src/styles/main.css:1064-1110`（媒體查詢）、`:265-271, 974`（`.pane-story`）；`src/styles/hud.css:226, 635, 741`

**修正方案**
1. Bottom sheet 化 context panel（drag handle + snap points：peek / half / full），取代「浮層抽屜」。
2. Header：標題唔換行（`white-space: nowrap` + 縮短或改 icon）；nav 改為 bottom tab bar 或 overflow menu。
3. Legend 預設摺疊為一個「圖例」按鈕，展開時才覆蓋。
4. 所有可點元素 ≥44×44；加 `env(safe-area-inset-*)`。
5. 保留 `prefers-reduced-motion` fallback（bottom sheet 動效）。

**驗收方法（Playwright 390×844）**
```js
expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
expect(await page.locator('[data-bottom-sheet]').count()).toBeGreaterThan(0);
// 44px：白名單容器以外全部達標
const bad = await page.evaluate(() => [...document.querySelectorAll('button, a, [role=button]')]
  .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44); })
  .filter(el => !el.closest('[data-dense-allow]')).map(el => el.id || el.className));
expect(bad).toHaveLength(0);
// legend 預設唔覆蓋 >10% 畫面
```
**風險**：bottom sheet 需 focus trap + 手勢衝突處理（同地圖 pan/zoom 衝突）；由 A7 一併處理。密閉/白名單要小心，唔可以用「白名單」掩蓋真實問題。

---

### P1-9 — 預設主題係 light，與 §1.1「末日情報指揮室」相反

**觀察證據**：`document.documentElement[data-theme] = "light"`（headless Chromium 系統偏好 light → `theme.ts:31-39` `systemPrefers()` 跟系統）；baseline §6.4 亦記錄 light。spec §1.1 要求深色、低飽和、煤黑藍／氧化金屬／警示琥珀。
（註：`main.css` / `hud.css` 內有完整 `[data-theme="light"]` 覆蓋層，即 light 係刻意支援，唔算 bug；問題在於**預設值**。）

**影響 journey**：A（第一印象與產品定位）。

**相關檔案**：`src/theme.ts:31-39, 78-89`；`index.html:9`（`theme-color` 已係 `#121820` 深色 → 與實際 light 主題不一致）

**修正方案**：未手動揀過時預設 `dark`；保留切換，並提供「跟隨系統」選項。同步 `index.html` 的 `theme-color`。

**驗收方法（Playwright，`prefers-color-scheme: light`、無 localStorage）**：`expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')`。

**風險**：低。需 A2 確認 light 主題係保留為可選。

---

### P2-1 — `provisional_mode.banner` 文案違反「零人手參與」規則

**觀察證據**：`data/public/map-config.json` → `provisional_mode.banner = "⚠️ 部份資料（角色路線）仍待人工審閱。已發佈內容經自動驗證，但角色路線來源自私有審閱文件，未經最終人工確認。請勿引用作準確資料。"`。Grep 確認 `provisional_mode` 只出現在型別宣告，**從未被 render**。
**Root cause**：文案寫於 pipeline 早期，之後 UI 未接駁。
**影響**：A（可信度聲明缺失）＋ 治理（違反 `AGENTS.md`「零人手參與」）。
**相關檔案**：`data/public/map-config.json`；`src/types/dataset.ts:233-236`；`src/data/loadAllData.ts:146`
**修正方案**：改寫為自動化驗證語言（例如「角色路線由確定性規則推導，覆蓋率 X%；未達閾值者標為 approximate／已隔離」），並接駁為可關閉的可信度 banner。
**驗收**：`python scripts/validate_public_data.py` 加規則：public JSON 內唔可以出現「人手」「人工審閱」「manual review」等字樣。
**風險**：低。

### P2-2 — Legend 係靜態 key，唔係 layer control；亦遮蓋地圖

**觀察證據**：`SvgMap.ts:507-524` 有 9 個 legend item（含「倖存區（安全）」「病窩（危險）」「虛線＝範圍係估算」），但冇任何 toggle；桌面 legend 佔地圖 7%，tablet 固定 193×258（25% 寬），mobile 49% 寬 × 31% 高。spec §2.4 要求 6 個 layer toggle（倖存區／病窩／事件／角色旅程／時期／地圖細節）。
**影響**：A、B、D、E。
**相關檔案**：`src/components/SvgMap.ts:507-524, 1090-1103`；`src/styles/main.css:367-411, 907-...`
**修正方案**：legend → layer control（6 toggle，每個用 color + pattern + icon 三重編碼）；layer 狀態寫入 URL `?layers=`；mobile 預設摺疊。
**驗收**：6 個 toggle 存在；toggle 後對應 `#*-layer` 子元素數目改變；URL 反映；reload 還原。
**風險**：layer toggle 同 §1.2「一個主 context」有張力，需定義「toggle 唔算切 context」。

### P2-3 — 198 個章節 pill 同編年史功能重疊

**觀察證據**：`#chapter-strip-mount .ch-pill` = 198（`ChapterStrip.ts:39-52` 全量 render），首屏見 1–40；而編年史亦有 198 個 timeline bar（`ChronicleView.renderTimeline()`），兩者都係「章節」入口但行為唔同（pill = 篩編年史，bar = 篩編年史，但 `StoryPanel` 內另有 `ch-prev/ch-next` = 切章）。三套章節控制並存。
**影響**：A（資訊架構混亂）、E。
**相關檔案**：`src/components/ChapterStrip.ts`；`src/components/ChronicleView.ts:268-305`；`src/components/StoryPanel.ts:102-108`
**修正方案**：收斂為單一章節控制（timeline bar 或 pill 二選一），章節切換與編年史篩選以同一 state 表達（`?chapter=`）。
**驗收**：DOM 內章節控制元件只有一套；兩種操作共用同一 URL 參數。
**風險**：中；要保留「快速掃全書」體驗。

### P2-4 — `#btn-toggle-panel` 桌面 0×0 仍在 DOM；`title` 唔等於 accessible name

**觀察證據**：桌面 `#btn-toggle-panel` `w=0, h=0`（仍存在於 `#topbar nav`）；4 個純 emoji 按鈕嘅 `accessibleName` 就係 emoji（`aria-label` 全為 null）。
**影響**：A、a11y（由 A7 深化）。
**相關檔案**：`src/app.ts:87-98`
**修正方案**：用 `hidden` 或 `aria-hidden` 明確移除桌面版本；所有 nav button 補 `aria-label`。
**驗收**：`#topbar .nav-btn:not([hidden])` 全部有非 emoji accessible name；`getByRole('button', {name:'/'+emoji+'/'})` 唔可以命中。
**風險**：低。

### P2-5 — 冇 event／location deep link，分享只複製章節

**觀察證據**：`app.ts:411-418` `syncHash()` 只寫 `ch` 同 `loc`；點 event marker 後 `location.hash === ""`（實測）。`#btn-share` 複製 `window.location.href`（`app.ts:193-224`），所以分享出去嘅永遠係「某章」而唔係「某事件／某角色」。
**影響**：D、E。
**相關檔案**：`src/app.ts:193-224, 411-418`
**修正方案**：同 P1-2 一併處理（URL contract）。
**驗收**：見 P1-2。
**風險**：低。

### P2-6 — 唯一「教學」藏在 About modal

**觀察證據**：鍵盤快捷鍵、地圖操作說明只在 `AboutModal.html()`（`AboutModal.ts:80-88`），要點 `關於` 或按 `?` 才見到；`?` 按鈕本身冇文字標籤。
**影響**：A（可發現性）。
**相關檔案**：`src/components/AboutModal.ts:80-88`；`src/app.ts:180-183`
**修正方案**：併入 onboarding 卡（見 P0-4）；`?` 改為有文字標籤。
**驗收**：首次到訪 onboarding 內已包含快捷鍵摘要。
**風險**：低。

### P2-7 — 同一組 zone / panel 樣式有 2–3 份來源，`pointer-events` 規則藏在較隱蔽位置

**觀察證據**：
- `.zone-area`：`main.css:458`（`pointer-events: none`）+ `main.css:1750`（transition）+ `main.css:1753-1754` + `hud.css:261,264,265` → 同一選擇器 4 次（main）+ 3 次（hud）。
- `.zone-badge`：`hud.css:285,289` + `main.css:1769,1773`。
- `.pane-story`：`main.css:265, 974, 1714` + `hud.css:226, 652, 758`。
- `timeline.css:249-268` `.bg-spoiler-btns` **完全冇 TS 引用**（死 CSS）。
- `main.ts:5-6` 重複 `import "./styles/hud.css";`（同一行寫兩次）。
**Root cause**：Phase L/HUD 追加樣式時冇移除舊規則。
**影響**：P0-1 的 `pointer-events: none` 正因為藏在「圖例樣本」段落（`main.css:457` 註解只講「唔應該攔截滑鼠」）而容易被忽略。
**相關檔案**：`src/styles/main.css`、`src/styles/hud.css`、`src/styles/timeline.css`、`src/main.ts:5-6`
**修正方案**：樣式收斂為單一來源（B1 範圍）；刪除死 CSS；`main.ts` 去重。
**驗收**：同一選擇器喺全部 CSS 檔只出現一次（可用 script 掃）；`timeline.css` 冇未被引用的 class（可用 PurgeCSS 式檢查）。
**風險**：低，但需視覺 regression 確保冇改壞。

---

## 修改檔案（只會係 docs/audits/ 同 artifacts/）

| 檔案 | 動作 |
|---|---|
| `docs/audits/ux-product-audit.md` | 新增（本報告） |
| `artifacts/audit-A1/ux-audit.mjs` | 新增（第 1 輪實測腳本：首屏／zone／journey A–E／mobile） |
| `artifacts/audit-A1/ux-audit2.mjs` | 新增（第 2 輪：zone hit test／資訊密度／journey E 乾淨量測／router） |
| `artifacts/audit-A1/ux-audit3.mjs` | 新增（第 3 輪：shared mount 狀態同步／query params／a11y／首屏） |
| `artifacts/audit-A1/ux-audit4.mjs` | 新增（第 4 輪：強制開 zone dossier／tablet） |
| `artifacts/audit-A1/ux-audit-results.json` | 新增（實測輸出） |
| `artifacts/audit-A1/ux-audit2-results.json` | 新增（實測輸出） |
| `artifacts/audit-A1/ux-audit3-results.json` | 新增（實測輸出） |
| `artifacts/audit-A1/ux-audit4-results.json` | 新增（實測輸出） |
| `artifacts/audit-A1/console.log` | 新增（browser console 輸出） |
| `artifacts/audit-A1/screenshots/*.png` | 新增（13 張，見下） |

**未觸碰**：`src/**`、`data/**`、`public/**`、`tests/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`scripts/**`、`.gitignore`。冇任何 git 寫操作。冇讀取 `data/private/`。

---

## 沒有修改但相關的檔案

| 檔案 | 為何相關 |
|---|---|
| `src/app.ts` | P0-2/3/4、P1-1/2/5、P2-3/4/5 的 state、header、mount、Esc 邏輯核心 |
| `src/router.ts` | P1-2 全部 URL 失效的單一根因 |
| `src/components/SvgMap.ts` | P0-1 層序／gate／label、P2-2 legend、P1-3 route 突出 |
| `src/components/ChronicleView.ts` | P0-3 eager render、P1-4 篩選器缺失、P1-1 狀態同步 |
| `src/components/StoryPanel.ts` | P1-3 char chip TODO、P1-7 原始 id／precision |
| `src/components/SearchBox.ts` | P1-6 分類／上限／鍵盤 |
| `src/components/ZoneDossier.ts` | P1-5 dossier 出口與 nest 結構 |
| `src/components/ChapterStrip.ts` | P2-3 章節控制重疊 |
| `src/components/AboutModal.ts` | P2-6 唯一教學、P2-1 banner 未接駁 |
| `src/data/loadAllData.ts` | P1-3 缺 character/route index；P0-2 config 已載入未用 |
| `src/types/dataset.ts` | P0-2 spoiler 型別；P2-1 provisional_mode 型別 |
| `src/styles/main.css` | P0-1 `pointer-events:none`、P1-8 mobile、P2-7 重複規則 |
| `src/styles/hud.css`、`timeline.css` | P2-7 重複／死 CSS |
| `src/theme.ts` | P1-9 預設主題 |
| `src/main.ts` | P2-7 重複 import |
| `index.html` | P1-9 `theme-color` 與實際主題不一致 |
| `data/public/map-config.json` | P0-2 spoiler 預設、P2-1 banner 文案 |
| `data/public/zones.geojson`、`events.geojson`、`locations.geojson` | P0-1 zone 章節窗口、P1-5 zone→event 關係、P1-7 precision 分佈 |

---

## 驗證命令與結果

**環境**
```
preview:  http://localhost:5180/   (curl → 200)
node:     v22.22.2
playwright: 1.62.1 (chromium, headless, --no-proxy-server)
```

**執行命令**
```bash
node artifacts/audit-A1/ux-audit.mjs    # 首屏 / zone / journey A–E / mobile / router
node artifacts/audit-A1/ux-audit2.mjs   # zone hit test / 資訊密度 / journey E 乾淨量測 / router（強制 reload）
node artifacts/audit-A1/ux-audit3.mjs   # shared mount 狀態同步 / query params / a11y / 首屏
node artifacts/audit-A1/ux-audit4.mjs   # 強制開 zone dossier / tablet
```
全部 4 個腳本 exit code 0，冇 pageerror。

**關鍵斷言與實測結果**

| 斷言 | 結果 |
|---|---|
| `#zones-layer .zone`（ch1） | 1（期望 ≥48）→ **FAIL** |
| `.zone-badge circle` 可點像素 | 0 / 380 → **FAIL** |
| `.zone-glow` 可點像素 | 0 / 144 → **FAIL** |
| `.zone-area` computed `pointer-events` | `none` → **FAIL** |
| 點 zone → dossier 有內容 | `dossierTextLen: 0`、hash `""` → **FAIL** |
| spoiler 控制項存在 | 0 buttons / 0 select → **FAIL** |
| 預設載入後可見 spoiler ≥2 內容 | 全部可見（949 條未過濾）→ **FAIL** |
| `#story-panel-mount .chr-entry` 首屏 | 1,320（期望 ≤60）→ **FAIL** |
| `?zone=` / `?event=` / `?character=` / `?spoiler=` / `?view=` / `?layers=` | 全部無效 → **FAIL** |
| 兩次互動內開角色 dossier | `hasCharDossier: false` → **FAIL** |
| 編年史篩選器（period/zone/char/type/spoiler/search） | 6 項全部 false → **FAIL** |
| chronicle 模式點 marker 後返回 | 編年史無法還原（Esc 變章節面板）→ **FAIL** |
| 4 個具名主入口 | `探索地區` 不存在 → **FAIL** |
| 每個 nav button accessible name 非 emoji | 4 個係純 emoji → **FAIL** |
| mobile 所有按鈕 ≥44×44 | 3,129 個未達標 → **FAIL** |
| mobile 有 bottom sheet | `false` → **FAIL** |
| mobile 無橫向 overflow | `false`（通過）→ **PASS** |
| 零外部請求（baseline §6.1） | 0（通過，本代理未重測）→ **PASS（引用 baseline）** |
| 預設主題為 dark | `light` → **FAIL** |

---

## Screenshots / Artifacts

```
artifacts/audit-A1/
  ux-audit.mjs / ux-audit2.mjs / ux-audit3.mjs / ux-audit4.mjs
  ux-audit-results.json / ux-audit2-results.json / ux-audit3-results.json / ux-audit4-results.json
  console.log
  screenshots/
    a1-desktop-first-screen-3s.png                    ← 首屏：98% 文字係編年史、地圖冇 territory
    a1-desktop-default.png
    a1-desktop-zone-click.png                         ← 點 zone 之後冇反應
    a1-desktop-zone-dossier-via-badge.png             ← 點 badge 亦冇反應（被 event marker 遮）
    a1-desktop-zone-dossier-forced.png                ← 強制 dispatch 亦失敗（clickedGlow:false）
    a1-desktop-chronicle.png                          ← 1320 卡一次過 render
    a1-desktop-search-char.png                        ← 搜尋只有 3 類
    a1-desktop-after-char-search.png                  ← 揀角色結果 → 只係跳章
    a1-desktop-chapter-mode.png
    a1-desktop-char-two-interactions.png              ← Journey C 兩次互動後冇 dossier
    a1-desktop-event-click-in-chronicle-mode.png      ← 編年史被靜默摧毀、按鈕文字不變
    a1-tablet-default.png                             ← panel 收起、legend 193×258
    a1-mobile-default.png                             ← 標題 4 行、nav 文字直排、legend 遮 49% 寬
```

引用既有 baseline（未重複產生）：`artifacts/screenshots/baseline-*`、`artifacts/network/`、`artifacts/perf/`、`artifacts/console/`、`artifacts/audit-context/baseline-findings.md`。

---

## 風險、衝突、限制

**限制**
1. 本代理只做 Product/UX 審計，**冇改任何 production code**；以上修正方案係提案，需 Gate 1 spec 定稿。
2. Zone dossier 內容深度（P1-5）係**靜態審計**結論 —— 因為 P0-1 令 dossier 無法由 UI 到達（強制 dispatch 亦 0 命中），所以「相關事件／角色／時間軸／返回」缺失係由 `ZoneDossier.ts` 原始碼推導，唔係畫面實測。
3. `?event=` 等 query param 的失效：第 1 輪測試 URL 構造有誤（`?t=…?event=…`），已由第 3 輪以正確格式重測確認無效；結論同時有 `router.ts:17-27` 只讀 hash 的程式碼證據支持。
4. 效能數字（LCP / 2.6–2.8 s）引用 baseline；本代理只實測 `#topbar` 出現時間 465 ms。
5. 未覆蓋：reduced-motion、focus 順序、對比度（屬 A7）；座標可信度（屬 A5）；資料 schema（屬 A6）；bundle／記憶體（屬 A8）。

**衝突**
1. **與 `map-config.json` 現有文案衝突**：P2-1 的 banner 講「仍待人工審閱」，但 `AGENTS.md` 明令零人手參與。需主代理裁定改寫方向（唔可以保留原文）。
2. **與 spec §1.1 衝突**：現行預設 light 主題係刻意支援（有完整 `[data-theme="light"]` 覆蓋層），改 dark 預設需 A2 確認 light 是否保留為選項。
3. **與 §1.2「一個主 context」張力**：P0-4 要求 4 個入口 + P2-2 要求 6 個 layer toggle + P2-3 要保留章節控制 —— 三者合計會令同時可見控制變多。建議以「一個主 context + 一個可摺疊工具列」界定。
4. **與 baseline §6.4「48 個 zone polygon 完全冇 render」**：本代理實測係「**1 個** zone 有 render 但 0% 可點、0.9% 大小、無 label」。結論方向一致（Journey B 失效），但精確描述需以本報告為準（baseline 建議 A4 重新定位 root cause，本報告已定位到 `main.css:458` + 層序 + 章節 gate 三重原因）。

**風險**
1. **修 P0-1 會令視覺噪音大增**：一次顯示 48 個 zone（其中 37 個 `radius_source: default` 即估算）會出現大量虛線圓。需同時定義 LOD 與 pattern 語言，否則由「睇唔到」變成「睇唔清」。
2. **修 P0-2（預設 spoiler 1）會令地圖同編年史大幅變空**（52.8% 事件被隱藏）。必須提供「已隱藏 M 條」提示，否則使用者會以為資料缺失。
3. **修 P0-3（virtualization）會令 Ctrl+F、伏筆跳轉、匯出失效**；需同步實作 id 定位 API。
4. **修 P1-1（分開 mount）會牽動 app.ts 大部分 selection 路徑**；建議同 P1-2（URL contract）一齊做，避免做兩次。
5. **URL contract 一旦公開就要穩定**；必須 Gate 1 定稿後才實作。

---

## 給主代理的 integration note

1. **最高槓桿、最低成本嘅單一修改**：`src/styles/main.css:458` 刪除 `.zone-area { pointer-events: none; }` + 將 `#zones-layer` 的 badge 提升到 marker 之上。呢兩行直接令 Journey B 由「0% 可用」變成「可點」。但**必須同時**處理章節 gate（`SvgMap.ts:1200-1206`），否則 ch1 仍然只有 1/48 zone。
2. **Gate 1 spec 需要明確裁定 5 件事**（其餘可由 B agent 決定）：
   - 世界視圖要唔要無條件顯示全部 48 個 zone（我建議：要，但按 kind 分層 + LOD）。
   - 預設 spoiler level（我建議：1，但必須有「已隱藏 M 條」提示；此決定會影響 52.8% 事件）。
   - 首屏主 context（我建議：地圖；編年史改為 `?view=chronicle` 的 drawer）。
   - URL contract 採 hash 定 query（我建議：統一 query，`#` 只用於 in-page anchor；但 spec §5.1 兩者混用，需定稿）。
   - light 主題保留與否（影響 §1.1 視覺方向）。
3. **建議 ownership 對應**（避免多代理改同一檔）：
   - P0-1 → B5/B6（`SvgMap.ts`、`main.css` 的 zone 段）
   - P0-2 / P1-1 / P1-2 → B2（`app.ts`、`router.ts`、`src/state/`）
   - P0-3 / P1-4 → B7（`ChronicleView.ts`）
   - P0-4 / P1-5 / P1-7 → B6 + B7（header、`ZoneDossier.ts`、`StoryPanel.ts`）
   - P1-3 / P1-6 → B3 + B6（`src/data/` index、`SearchBox.ts`）
   - P1-8 → B8；P2-7 → B1；P1-9 → B1
4. **可直接複用嘅自動化驗收**：本報告每項「驗收方法」都係 Playwright 斷言；建議直接納入 B9 的 QA harness 與 C1 的 E2E，唔需要另寫。
5. **`artifacts/audit-A1/*.mjs` 係可重跑嘅 baseline 對照腳本**；V2 完成後跑同一組腳本，`ux-audit-results.json` 可直接 diff 出改善幅度（特別係 zoneCount 1→48、chr-entry 1320→≤60、DOM 14,036→<4,000）。
6. **本審計冇觸碰任何 production file，冇 git 寫操作**；`git status` 內嘅 `src/**`、`data/**` 改動全部係 Phase L 未提交工作，非本代理所為。

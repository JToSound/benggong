# A2 Visual / Motion Director —— 視覺與動效審計報告（World Atlas V2）

> 審計對象：《病港》互動故事地圖 production 版本
> 審計者：A2 Visual / Motion Director（只讀子代理）
> 專案路徑：`C:\Users\User\Desktop\benggong`
> 環境：preview server `http://localhost:5180/`、Playwright 1.62.1（headless Chromium，`--no-proxy-server`）
> 產出位置：`docs/audits/visual-motion-audit.md`、`artifacts/audit-A2/`
>
> **本審計冇修改任何 production 檔案。** 全部數字都係實測，唔係估計。

---

## 任務摘要

### 一句總結

> 現況唔係「V2 差少少」，而係**五套互相衝突嘅顏色權威疊埋一齊**，加上**冇尺度（LOD）策略**，令「末日香港情報指揮室」喺視覺上根本無法成立：地圖係一張通用深色道路圖、區域圖層實質隱形、而右側面板係 1320 張一模一樣嘅圓角卡片。

### 六個結構性（唔係 cosmetic）視覺系統問題

| # | 結構問題 | 一句話證據 |
|---|---|---|
| S1 | **五套並行顏色權威**，冇單一 rendering palette 契約 | `--accent-*`（legacy 7 色）、`--hud-*`（HUD 7 色）、`--color-*`（12 個從未定義嘅死 token）、`PALETTE_DARK/LIGHT`（canvas）、TS inline 61 個 distinct hex |
| S2 | **「Tactical HUD」設計語言實際上冇被採用** | `--hud-cyan` 喺整頁只用於 **2 個元素**；實際主導係 legacy `--accent-teal`（1214 元素）同 `--accent-blue`（1320 元素） |
| S3 | **冇尺度／LOD 策略**：220–800 m 嘅 zone 同 78 km 嘅世界視圖硬碰 | 預設 viewBox 0.7° ≈ 78 km；zone 半徑中位數 260 m → 預設視圖 zone polygon 實測 **10×10 px** |
| S4 | **圖層 z-order / hit priority 冇定義** | zone 點擊被 event marker 攔截；實測 `.elementFromPoint` 頂層係 `circle.event-marker`，唔係 zone |
| S5 | **Motion 冇 scale、冇語意** | CSS 有 **19 個唔同 duration**（30–520 ms）+ 3 條 bezier + 7 `ease` + 8 `ease-out`；11 個 `@keyframes` 只有 **3 個真正運行** |
| S6 | **主題系統係「後加覆寫」而唔係 token 驅動** | 623 行重複 CSS（main.css 1527 行 ≈ hud.css 527 行；hud.css 96 行自我重複）；light 主題漏覆蓋 zone badge → 深色圓盤留在淺色地圖上 |

### 對 V2 北極星（spec §0.3）嘅直接判定

| 北極星條款 | 判定 | 依據 |
|---|---|---|
| 一眼睇落唔再係「原始資料表 + SVG」 | ❌ **FAIL** | 右側面板 = 1320 張 `<article>` 卡片（327×115、radius 8px、統一 `--bg-elevated`），13681 個 `chr-*` 元素 = DOM 97% |
| 最大 zoom 唔起格 | ✅ **PASS** | 向量底圖重繪，max zoom viewBox 0.02° 無 pixelation（與 baseline 一致） |
| 最大 zoom 有嘢睇 | ❌ **FAIL** | max zoom 下 zone 1 個、marker 24 個、route 0 條；69.18% 像素亮度 < 0.10 |
| 每種 layer 有清楚 legend | ❌ **FAIL** | `outpost` 佔 48 個 zone 中 16 個（33%），legend **完全冇**呢一項 |
| mobile 唔係縮細版 desktop | ❌ **FAIL** | mobile 標題斷成 4 行、nav 8 個按鈕直排、legend 佔畫面 18.9%、zone dossier 面板溢出螢幕 163 px |
| 每個區域可互動 | ❌ **FAIL** | 真實 mouse click 落 zone 中心 → `selected=0`、`dossierHidden=true` |

### P0 / P1 / P2 統計

- **P0：5 項**（視覺方向相反、zone 圖層不可見／不可點、zone 視覺語言不足 5 類且只靠色、mobile 面板溢出、對比大規模 fail）
- **P1：7 項**（CSS 重複、CSS 死碼、token 只做一半、motion 無 scale、reduced-motion 只有 CSS、選中 zone 零回饋、noise/scanline 缺失）
- **P2：6 項**（legend 遮蓋、卡片堆疊、nav 按鈕、max zoom 無 disabled、light 主題 badge 漏覆蓋、死碼 `zoneById`）

---

## 假設與證據

### 假設

1. **「預設主題」= 瀏覽器 `prefers-color-scheme` 結果。** `src/theme.ts:31-39` 先讀 localStorage，冇就用 `matchMedia("(prefers-color-scheme: light)")`。實測 headless Chromium 預設為 light → `data-theme="light"`。**與 baseline-findings.md §6.4 一致。**
2. **「可點」= 真實 pointer hit test 命中。** 我用 `document.elementFromPoint()` + `page.mouse.click()` 驗證，唔用 `dispatchEvent` 當作可達性證據（`dispatchEvent` 會繞過遮擋，會高估可達性）。
3. **「文字節點」= 直接含 text node 且寬高非零嘅可見元素。** 對比計算用 WCAG 2.x relative luminance；背景色由自身往上逐層 alpha 合成至首個不透明祖先。
4. **`hsl()` 使用率為 0。** 三份 CSS 實測 `hsl(`/`hsla(` 命中 0 次，所以顏色量化只需計 `#hex` 同 `rgb()/rgba()`。
5. **artifact 唔含私有內容。** 全程只讀 `src/`、`data/public/`、`public/` 嘅 metadata 與尺寸；**冇讀取亦冇輸出 `data/private/` 任何內容**；截圖只含公開 UI。

### 核心證據（全部可重跑）

| 證據 | 數值 | 來源 |
|---|---|---|
| CSS 總行數 | **3262**（main 2047 + hud 785 + timeline 430） | `wc -l` |
| TS 總行數（`src/**/*.ts`） | **5738** | `find src -name '*.ts' \| xargs cat \| wc -l` |
| CSS / TS 比 | **3262 / 5738 = 56.9%**；CSS 佔前端總碼（9000 行）**36.2%** | 同上 |
| CSS 硬寫顏色 | **329 個**（`#hex` 172 + `rgb()/rgba()` 157） | `grep -oE` |
| CSS `var(--…)` 使用 | **623 次** | `grep -oE 'var\(--'` |
| distinct hex（CSS） | **80 個**（main 60 + hud 12 + timeline 8） | `sort -u` |
| TS 硬寫顏色 | **102 個**（70 個 hex + 32 個 `rgba()`），distinct hex **61 個** | `grep -rnoE '"#[0-9a-fA-F]{3,8}"'` |
| **硬寫顏色總計** | **431 個 literal** | 上兩項相加 |
| CSS 硬寫 `font-size: Npx` | **93 處**（17 個 distinct 值；只有 24 處用 `var(--fs-*)`） | `grep -rhoE 'font-size:[ ]*[0-9.]+px'` |
| CSS 硬寫 `padding: N` | **100 處**（`var(--sp-*)` 只用 48 次） | `grep -rhoE 'padding:[ ]*[0-9]'` |
| CSS 硬寫 `border-radius: N` | **41 處**（`var(--r-*)` 只用 16 次） | `grep -rhoE 'border-radius:[ ]*[0-9]'` |
| CSS 硬寫 `box-shadow` | **32 處**（只有 7 處用 `var(--shadow*)`） | `grep -rhoE 'box-shadow:[ ]*[^v]'` |
| `z-index` distinct 值 | **11 個**（0, 1, 2, 60, 100, 800, 900, 1000, 1100, 1200, 1300） | `grep -rhoE 'z-index:[ ]*[-0-9]+' \| sort -u` |
| `@keyframes` | **11 個**（main 6 + hud 5） | `grep -rn '@keyframes'` |
| `animation:` 宣告 | **20 條** | `grep -cE '^\s*animation'` |
| `transition` 出現 | **52 次** | `grep -c 'transition'` |
| **真正運行嘅 animation** | **3 個**（`hud-in-left`、`story-enter`、`#topbar::after` `hud-sweep` 6s infinite） | `getComputedStyle` + pseudo 掃描 |
| `transition` 簽名（distinct） | **19–20 個** | `getComputedStyle` 全頁掃描 |
| `prefers-reduced-motion` 命中 | CSS **3 處**（main 1107 / main 2040 / hud 564）；TS **0 處** | `grep -rn` |
| 文字節點總數 | **7085** | DOM 掃描 |
| 對比 fail（dark desktop） | **2809 / 7085 = 39.6%** | WCAG AA 計算 |
| 對比 fail（light desktop） | **2728 / 7085 = 38.5%** | 同上 |
| 字級 ≤ 11 px 嘅文字節點 | **5556 / 7085 = 78.4%**（9px 1404、10px 1404、11px 2748） | `getComputedStyle` 直方圖 |
| DOM 元素總數 | **14036**（其中 `chr-*` 13681 = 97%） | DOM 掃描 |
| 可達 zone polygon（ch1） | **1 / 48** | 章節可見性 filter |
| 預設視圖 zone polygon 螢幕尺寸 | **10 × 10 px** | `getBoundingClientRect()` |

---

## 發現／改動

> 本節每一項都係**只讀發現**（冇任何 production 改動）。每項含：觀察證據 / root cause / 影響 / 相關檔案 / 修正方案 / 驗收方法 / 風險。

---

### 【P0-1】預設主題係 light，而且兩套主題都係「通用道路地圖」，唔係《病港》情報指揮室

**觀察證據**

- `data-theme` 預設 = `"light"`（`theme.ts:31-39` 跟 `prefers-color-scheme`，headless 預設 light）。與 spec §1.1「深色、低飽和、墨黑藍」**方向相反**。
- 底圖像素客觀量度（`palette-measure.mjs`，canvas 1060×752）：

| 指標 | dark | light |
|---|---|---|
| 亮度 < 0.10 像素佔比 | **69.18%** | 0% |
| 亮度 > 0.40 像素佔比 | **3.51%** | 99.67% |
| 其中暖色（R>B） | **2.75%** | 4.45% |
| 其中冷色（B≥R） | 0.76% | 95.22% |
| 色相 200–220° 佔比 | 90.71% | 87.06% |

- 即係：dark 底圖 = **69% 近黑 + 3.5% 明亮內容，而明亮內容 78% 係橙色道路**。整個畫面唯一高亮度元素就係橙色路網 → 視覺上必然讀成「通用深色道路圖」。
- 實測 `--hud-cyan`（#38e8ff）喺整頁只用於 **2 個元素**（`colorCount` 顯示 `rgb(56,232,255)` = 2）。真正主導色係 legacy `--accent-teal`（1214 元素）＋ `--accent-blue`（1320 元素）＋ `--accent-purple`（212 元素）。
- 截圖 `light-desktop.png` / `dark-desktop.png`：兩者都係「灰藍底 + 橙色路網 + 圓角卡片」，只係明暗反轉。

**Root cause（結構性）**

`src/map/VectorBasemap.ts:162-228` 嘅 `PALETTE_DARK` / `PALETTE_LIGHT` 係一套**道路地圖 palette**：唯一 accent 就係 `roads[].color`（`#ffc061`/`#e0a052`/`#b8845a`…），而 sea/land 只係兩個近黑灰。**冇任何「世界觀圖層」色**（倖存區／病窩／隔離／爭議／未知）。同時 `theme.ts` 將主題預設綁死系統偏好，令一個「末日情報指揮室」產品預設展示羊皮紙淺色。

**影響**

spec §0.3 北極星第 1 條（一眼唔再係原始資料）與 §1.1 整個視覺方向**同時 fail**。無論之後加幾多 zone / dossier，底色語言已經決定產品讀起來係「地圖工具」而唔係「存活檔案庫」。

**相關檔案**

- `src/map/VectorBasemap.ts`（`PALETTE_DARK` 162-194、`PALETTE_LIGHT` 196-228、`draw()` 694+）
- `src/theme.ts`（31-39、78-89）
- `src/styles/main.css`（24-84 `:root`、1149-1177 light theme、1191-1210 `prefers-color-scheme`）
- `src/styles/hud.css`（584-679、690-785）

**修正方案（V2 必須做，唔可以只調色）**

1. **反轉預設**：`currentTheme()` 預設 `"dark"`，light 變成 opt-in（`data-theme` 保留雙向）。理由：spec §1.1 係產品定位，唔應該由 OS 偏好決定。
2. **建立單一 rendering palette 契約**：`src/map/VectorBasemap.ts` 唔可以再自己持有色值。將 sea/land/coast/bld/label/grid/roads/vignette **全部**改成由 `getComputedStyle(document.documentElement).getPropertyValue('--basemap-*')` 讀取（即 CSS token 為唯一真相），canvas 只做繪圖。這同時消滅 S1「五套顏色權威」。
3. **加世界觀圖層色**：`--zone-survivor` / `--zone-nest` / `--zone-quarantine` / `--zone-contested` / `--zone-unknown`，並將 `roads[]` 由「橙色漸層」改為「煤灰主體 + 極少數琥珀主幹道」，令橙色路網唔再係唯一高亮。
4. **令橙色有語意**：橙色（警示琥珀）只准用於「危險／需注意」語意，唔准做道路裝飾。

**驗收方法（可重跑）**

```bash
node artifacts/audit-A2/palette-measure.mjs
```

通過條件（門檻寫入 V2 spec 並由 C2/C3 斷言）：
- dark 底圖「亮度 > 0.40 像素佔比」**≤ 1.5%**（現 3.51%），且暖色佔比 **≤ 明亮像素嘅 30%**（現 78%）。
- 亮度 0.10–0.35 嘅「中調」像素佔比 **≥ 15%**（現 2.22%），證明有世界觀圖層內容而唔係純黑底。
- 全頁 `--hud-*` accent 使用元素數 **≥ 150**（現 2）。
- `document.documentElement.dataset.theme === "dark"` 喺無 localStorage 情況下成立。

**風險**

- 反轉預設會令現有 light 使用者體驗突變 → 需要 `UX_DECISIONS.md` 記錄理由（spec §8.10 已要求）。
- 將 palette 由 TS 移到 CSS 會令 canvas 每次主題切換要重新讀 token；需注意切換時序（`basemap-theme-change` 事件已存在，可重用）。

---

### 【P0-2】Zone 圖層喺預設視圖實質隱形，而且**唔可點**

**觀察證據**

1. **可見性**：`data/public/zones.geojson` 有 **48 個 Polygon**（`survivor` 11、`nest` 21、`outpost` 16）。`SvgMap.ts:1200-1206` 用 `chs.some(c => c <= cur && cur <= c + 12)` 做章節 filter，實測各章可見 zone 數：

| 章節 | 1 | 10 | 50 | 100 | 198 |
|---|---|---|---|---|---|
| 可見 zone | **1** | 2 | 4 | 8 | 15 |

   → 預設（第 1 章）只有 **1 / 48** 個 zone 存在於 DOM。

2. **尺寸**：`zones.geojson` `radius_m` 範圍 **220–800 m，中位數 260 m**。預設 viewBox 寬 `0.7°` ≈ 78 km → 260 m 佔畫面 0.33%。實測 `.zone-area` `getBoundingClientRect()` = **`{w:10, h:10}`**（1060 px 寬地圖上）。

3. **可點性**：真實 mouse click 落 zone 中心（688, 605）：

```
after click: { "selected": 0, "dossierHidden": true, "url": "http://localhost:5180/#ch=1" }
```

   `document.elementsFromPoint(688,605)` 頂層係 `circle.event-marker`（多個），**唔係** `.zone-area`。因為 `SvgMap.ts:625-637` 先判斷 `t.closest('.zone')`，但實際 hit 到嘅係唔屬於任何 zone 嘅 event marker → 落入 `setSelectedEvent()` 分支。
   只有用 `dispatchEvent(new MouseEvent('click'))` 直接派去 `.zone-area` 才成功（`selected:1`、dossier 2026 字）。

4. **放大後正常**：zoom 10 步後 zone polygon 變 138×139 px、label 出現、dossier 可讀。**證明幾何係向量、清晰度冇問題** —— 問題純粹係尺度。

**Root cause（結構性）**

冇 LOD / 聚合 / 尺度分層策略。同一張地圖要同時承載「78 km 世界視圖」同「260 m 區內多邊形」，而兩者相差 **300 倍**。加上 zone 圖層（`#zones-layer`）z-order 喺 marker 之下且冇 hit priority 規則，令 zone 即使可見都被 marker 完全遮蓋。

**影響**

- spec §2.4「地圖必須完整展示並可互動」→ **FAIL**。
- spec §0.3「使用者可以切換／探索倖存區、病窩、危險區」→ **FAIL**（預設只能睇到 1 個，且點唔到）。
- Journey B（探索倖存區／病窩）**第一步就斷**：冇得由地圖進入 zone dossier。

**相關檔案**

- `src/components/SvgMap.ts`（1195-1206 可見性與排序、1224-1329 zone 繪製、625-637 click delegation）
- `data/public/zones.geojson`（`radius_m`、`radius_source`、`kind`、`chapters`）
- `src/styles/main.css`（1748-1784 zone CSS）、`src/styles/hud.css`（同區塊重複）

**修正方案（V2 必須做）**

1. **建立 zone LOD 三層**（spec §2.3 同構）：
   - `Z0–Z2`（世界視圖，viewBox > 0.15°）：zone **唔畫 polygon**，改畫 **cluster/aggregate glyph**（同一區內多個 zone 合成一個「區域簇」標記，附數量與最高 danger），並用面積／密度而不是半徑表達。
   - `Z3–Z5`（0.02°–0.15°）：畫 **zone 邊界 + 內部 landmark**，polygon 最少 24 px 才顯示。
   - `Z6+`（< 0.02°）：完整 polygon + pattern + label。
2. **修 z-order 與 hit priority**：`#zones-layer` 保持喺 marker 之下（視覺正確），但 zone **hit area** 要用獨立、透明、最上層嘅 `#zone-hit-layer`（`pointer-events: stroke` + 加粗 hit stroke）。或者明確規則：zone 優先於 marker，marker 需要 `pointer-events` 只喺 zone 之外生效。
3. **zone 可見性唔應該由「章節 ±12」硬 filter 決定**：應改為 opacity / 去飽和漸變，令「歷史 zone」仍可被搜尋與感知，而唔係忽然消失。

**驗收方法（可重跑）**

```bash
node artifacts/audit-A2/selected-zone-probe.mjs
node artifacts/audit-A2/zone-legend-probe.mjs
```

通過條件：
- 預設視圖 `.zone` 或 zone cluster 數量 **≥ 8**（現 1），且 **≥ 1 個 nest**。
- 預設視圖用**真實 mouse click** 落 zone 中心 → `document.querySelectorAll('.zone.is-selected').length === 1` 且 `#zone-dossier-mount` 唔 hidden（現 fail）。
- 每個 target zoom 層，zone 元素螢幕最小邊長 **≥ 24 px**（現 10 px）或者有替代 aggregate glyph。
- 48 個 zone 中，每個章節至少 **≥ 6** 個可被搜尋到（唔可以因為 filter 完全消失）。

**風險**

- Zone cluster 會引入「聚合語意」問題：必須誠實標示係「多個 zone 聚合」而唔可以扮單一區域（spec §0.1-7 不可捏造世界設定）。
- 加 hit layer 會增加 DOM 節點；需量測 pan/zoom frame 影響（交由 C6 量度）。

---

### 【P0-3】Zone 視覺語言只有 3 類、只有色相分辨、冇 pattern；`outpost` 33% 完全冇 legend

**觀察證據**

1. **種類不足**：`zones.geojson` `kind` 實測只有 `{survivor: 11, nest: 21, outpost: 16}`。spec §5.4 要求 5 類（倖存區 / 病窩 / 隔離區 / 爭議地帶 / 未知區）→ **缺 quarantine / contested / unknown**。
2. **`display_style` 欄位唔存在**：`z.features.some(f => f.properties.display_style !== undefined) === false`。spec §2.4 schema 要求嘅 `fill` / `pattern` / `icon` 完全冇。
3. **視覺語言係硬寫 TS 常量**：`SvgMap.ts:1168-1193` `ZONE_STYLE`：
   - `survivor` fill `#2fd6a8` stroke `#5cf0c4` glyph `shield`
   - `nest` fill `#ff5a4d` stroke `#ff8a72` glyph `biohazard`
   - `outpost` fill `#a06bd8` stroke `#c69bf0` glyph `flag`
   三者唯一區別 = **色相**（綠／紅／紫）＋ glyph 圖示。**冇 pattern**（hatch / contour / noise / solid / pulse 全部冇）。唯一「pattern」係 `radius_source !== "members"` 時加虛線（`SvgMap.ts:1248-1251`）。
4. **Legend 只覆蓋 2/3**：`.legend-item` 實測 9 項，其中 zone 相關只有「倖存區（安全）」「病窩（危險）」「虛線＝範圍係估算」。**`outpost` 16/48 = 33% 冇 legend 條目**。
5. **Legend swatch 只靠色**：實測 swatch 幾何完全一樣：

| legend 項 | class | shape | border-radius | border-style | 分辨依據 |
|---|---|---|---|---|---|
| 倖存區（安全） | `.area-survivor` | 14×14 | 50% | solid | 只有 fill 色 `rgb(47,214,168)` |
| 病窩（危險） | `.area-nest` | 14×14 | 50% | solid | 只有 fill 色 `rgb(255,90,77)` |
| 虛線＝範圍係估算 | `.area-estimated` | 14×14 | 50% | solid | 靠 `border-style`（唯一形狀差異） |
| 角色路線 | `.line-route-legend` | 16×3 | 2px | none | 靠形狀 |

   → 直接違反 spec §2.4「legend 必須同時用 color、pattern、icon／shape，唔可以只靠色」及 §1.1 禁止項「只有色彩分辨類別」。

**Root cause（結構性）**

Zone 視覺語言係**事後貼上嘅 TS 常量**，唔係資料驅動（`display_style` 唔存在於 schema），亦唔係 token 驅動（色值硬寫喺 `SvgMap.ts`）。加上 zone 分類本身只有 3 類，令「隔離／爭議／未知」呢啲世界觀最重要嘅狀態**完全冇視覺表達**。

**影響**

spec §5.4 整張表 fail；spec §2.4 legend 要求 fail；§0.3「每種 layer 有清楚 legend、狀態」fail。`outpost` 使用者永遠唔知紫色係咩。

**相關檔案**

- `src/components/SvgMap.ts`（1168-1193 `ZONE_STYLE`、1230-1326 繪製、519-521 legend HTML）
- `src/styles/main.css`（1782-1784 `.area-survivor` / `.area-nest` / `.area-estimated`）
- `data/public/zones.geojson`（`kind`、`radius_source`）
- `src/types/dataset.ts`（zone properties 型別）

**修正方案（V2 必須做 —— 全部 vector / CSS pattern，任何 zoom 保持清晰）**

見本報告末節 **〈V2 Zone 圖層視覺語言提案〉**（5 類完整方案）。核心原則：

1. **每一類同時有 3 個維度**：`fill 色` + `CSS/SVG pattern`（`<pattern>` 或 `repeating-linear-gradient`）+ `邊界線型`（solid / dashed / broken / dotted）。任何單一維度失效（例如色盲）仍然可辨。
2. **Pattern 用 SVG `<pattern>` 定義於 `<defs>`，`patternUnits="userSpaceOnUse"` 並隨 viewBox 縮放調整 `patternTransform`**，令任何 zoom 下 pattern 密度恆定而唔會變成一塊色。
3. **`display_style` 由 data 提供，TS 只做 fallback**；schema 擴充交 B4。
4. **Legend 必須機械化斷言**：每個 `kind` 值都要有 legend 條目，且 legend swatch 嘅 pattern 同地圖一致（由同一 token 生成）。

**驗收方法（可重跑）**

```bash
node artifacts/audit-A2/zone-legend-probe.mjs
```

通過條件：
- `new Set(zones.features.map(f => f.properties.kind))` 每個值都喺 legend 有對應條目（現 `outpost` 缺）。
- 對每個 zone kind：`getComputedStyle(swatch).backgroundImage !== 'none'`（即有 pattern）**或** `borderStyle !== 'solid'`；即「移除顏色後仍可區分」。可寫成 property test：對 5 個 kind，兩兩比較 `(pattern, borderStyle, iconPath)` 三元組必須唯一。
- 灰度測試：截圖轉灰階後，5 類 zone 邊界仍可分辨（交由 B9/C3 實作）。

**風險**

- Pattern 增加 SVG 繪製成本（尤其 48 polygon × pattern fill）。需限制 pattern 只用喺 polygon fill，唔用喺 glow，並量測 pan/zoom 影響。
- 若 `zones.geojson` 冇 `quarantine` / `contested` / `unknown` 資料，**唔可以捏造**：UI 必須顯示「未有此類區域」而唔係畫假 polygon（spec §0.1-7）。提案須同時提供「資料不足時嘅空狀態視覺」。

---

### 【P0-4】Mobile：zone dossier 面板溢出螢幕 163 px，文字被切斷

**觀察證據**

- Mobile 390×844，強制選中 zone 後量測 `#zone-dossier-mount`：

```
{ "dossierHidden": false, "rect": { "x": 235, "y": 199, "w": 318, "h": 633 }, "pos": "absolute" }
```

  `235 + 318 = 553 > 390` → **右邊 163 px（面板 51%）喺畫面外**。
- 截圖 `dark-mobile-zone-dossier.png`：文字逐行被切（「人類聚居 · 安…」「別稱：大本營安全區、安…」「將軍澳；由香港知專…」），內文完全讀唔到。
- 同時 legend 只剩左邊一條窄條（`EN` chip 可見），主體被面板蓋住。

**Root cause（結構性）**

`main.css:1067-1094` 喺 `max-width:1023px` 將 `.pane-story` 改成 `position:absolute; right:0; width:min(360px,88vw)`。但 `88vw` 喺 390 px = 343 px，加上 `.zone-dossier-mount { height:100%; overflow-y:auto }`（main.css:1790-1794）**冇 width 約束**，令 dossier 內容以自身最大寬度（318 px 內容 + padding）撐開，而 `x=235` 表示佢**唔係由 right:0 定位**（實際係被 `.workspace` 內某層 offset 推歪）。同時**完全冇 bottom sheet**（spec §0.3 明確要求「以底部 sheet、touch-first controls、safe area、44×44px target」）。

**影響**

spec §0.3「mobile 唔係縮細 desktop」**FAIL**；Journey B 喺 mobile 完全不可用（唯一進入 dossier 嘅路徑，內容卻讀唔到）。加上 zone 本身喺 mobile 只係 10 px（P0-2），實務上 mobile 使用者永遠見唔到 zone。

**相關檔案**

- `src/styles/main.css`（1063-1104 響應式、1790-1794 `.zone-dossier-mount`、1714-1718 `.pane-story`）
- `src/app.ts`（100-113 workspace 結構、60-77 `bindPanelToggle`）
- `src/components/ZoneDossier.ts`

**修正方案（V2 必須做）**

1. **Mobile 唔可以重用 `.pane-story` 做 dossier 容器**。新增 `#zone-sheet`：`position:fixed; left:0; right:0; bottom:0; max-height:70vh; border-radius 16px 16px 0 0;`，加 `env(safe-area-inset-bottom)`，配 drag handle 同 `overscroll-behavior: contain`。
2. **寬度必須由容器決定**：`.zone-dossier-mount { width:100%; min-width:0; }` + `box-sizing:border-box`，禁止內容撐開。
3. **`@media (max-width:639px)` 加硬性斷言**：`html, body { overflow-x: hidden }` 唔係解法；正確做法係 `* { max-width:100% }` 只針對 panel 內文，並在 CI 斷言 `document.documentElement.scrollWidth <= innerWidth`。
4. **map legend 喺 mobile 必須可收合**（現佔 18.9% 畫面且遮住地圖）。

**驗收方法（可重跑）**

```bash
node artifacts/audit-A2/zone-visual-capture.mjs
```

通過條件（mobile 390×844）：
- 選中 zone 後，`#zone-dossier-mount`（或 `#zone-sheet`）`getBoundingClientRect()` 完全落喺 `[0, innerWidth] × [0, innerHeight]` 之內（現 `right = 553 > 390`）。
- `document.documentElement.scrollWidth <= 390`。
- 面板係由底部升起（`rect.bottom ≈ 844`）而唔係右側 overlay。
- 面板內所有文字節點 `scrollWidth <= clientWidth`（冇水平截斷）。

**風險**

- Bottom sheet 需要 focus trap 與 `Esc` 關閉；交 A7 / B8 處理，唔好由視覺層單獨實作。

---

### 【P0-5】大規模低對比小字：39.6% 文字節點 fail WCAG AA，78.4% 文字 ≤ 11 px

**觀察證據**

- Dark desktop：**2809 / 7085 = 39.6%** 文字節點對比 < AA 要求。Light desktop：**2728 / 7085 = 38.5%**。
- 失敗集中（`failByClass`）：

| class | 失敗節點數 | 字級 | 對比 | 需要 | 樣本 |
|---|---|---|---|---|---|
| `chr-ch-role` | **1401** | 9 px | **2.19:1** | 4.5 | 「回帶」 |
| `chr-loc` | **1200** | 11 px | **3.25:1** | 4.5 | 「📍 醫院」 |
| `ch-pill` | **189** | 12 px | **4.22:1** | 4.5 | 「10」「11」… |
| `tagline` | 1 | 11 px | **2.61:1**（light 更低至 **1.94:1**） | 4.5 | 「第一章 · 香港網絡小說」 |
| `chronicle-count` | 1 | 13 px | **1.94:1** | 4.5 | 「1320 條 · 全部章節」 |
| `chr-period-title` | 6 | 12 px | **1.94:1** | 4.5 | 「爆發前」 |
| `skip-link` | 1 | 14 px | 2.91:1 | 4.5 | 「跳去主內容」 |

- 字級直方圖（dark desktop，全部文字節點）：

```
9px: 1404   10px: 1404   11px: 2748   12px: 197   13px: 1328   14px+: 3
```

  → **≤ 11 px = 5556 個（78.4%）**；≥ 14 px 只有 **3 個**。

- Light 主題嘅 fail 比率相若但**絕對對比更低**（`--fg-faint: #a8b0ba` on `#f4f1ea` = 1.94:1），即淺色主題係「低對比小字」最嚴重嘅情境。

**Root cause（結構性）**

字級系統（`--fs-xs: 11px` … `--fs-xl: 20px`，main.css:74-80）嘅**下限太低**（11 px 已經係「xs」，但實際有 9 / 10 px 硬寫值），而 `--fg-faint` / `--fg-muted` 係為「裝飾性次要文字」設計，卻被用喺**承載資訊嘅** chapter role / location 標籤（1401 + 1200 = 2601 個節點）。即係：**層級設計將「資訊」誤當「裝飾」**。

**影響**

spec §1.1 禁止項「低對比小字」**直接命中**；spec §0.3「字體 hierarchy 強，讓地圖、區域名稱、危險標誌、事件與 chapter reference 容易掃讀」**FAIL**（9 px / 2.19:1 完全唔可掃讀）。同時係無障礙 P0（交 A7/C7 交叉驗證）。

**相關檔案**

- `src/styles/main.css`（74-80 字級 token、32-36 文字色 token、1149-1177 light theme）
- `src/styles/timeline.css`（`--color-text-muted` fallback `#95a5a6`）
- `src/components/ChronicleView.ts`（產生 `chr-ch-role` / `chr-loc`）
- `src/components/ChapterStrip.ts`（`ch-pill`）

**修正方案（V2 必須做）**

1. **建立字級階梯並訂立硬下限**：`--fs-micro: 11px` 係**唯一**允許嘅最小字級，禁止 9 / 10 px。9 px 節點必須升到 11 px 或者改為非文字表達（icon + tooltip）。
2. **建立「文字色 × 背景」合法配對表**：`--fg-faint` **只准**用於非資訊性裝飾（分隔線、disabled）。任何承載資料嘅文字最低用 `--fg-secondary`，並在 dark / light 兩個主題都必須 ≥ 4.5:1。
3. **將對比檢查變成 CI gate**（B9/C7）：對每個可見文字節點計算 WCAG 對比，assert `fail == 0`。呢個係可重跑、零人手嘅驗收。
4. **縮短資訊密度而非縮字**：2601 個 9–11 px 節點反映資訊過載，應改為 progressive disclosure（hover / expand），而唔係縮字塞入去。

**驗收方法（可重跑）**

```bash
node artifacts/audit-A2/theme-capture.mjs
node -e "const d=require('./artifacts/audit-A2/theme-audit.json');for(const r of d)console.log(r.theme,r.viewport,r.audit.contrastFail+'/'+r.audit.contrastTotal)"
```

通過條件：**dark 同 light 兩個主題、三個 viewport，`contrastFail` 全部 = 0**（現 2808–2809 / 2726–2728）。另加：`fontSizes` 直方圖中 **冇任何 < 11 px** 嘅 key。

**風險**

- 升字級會令現有面板放唔落（380 px 面板 × 1320 張卡片）→ 必然需要同時做 virtualization / progressive disclosure，唔可以只改 `font-size`。呢個係 V2 必須接受嘅連鎖改動。
- 對比 gate 可能因為 canvas 上嘅 SVG 文字（`zone-label` 有 `paint-order: stroke` 描邊）而出現誤判，需要明確定義「描邊文字」嘅對比算法。

---

### 【P1-1】623 行 CSS 重複（佔三份 CSS 19%），包括 `main.ts` 重複 import

**觀察證據**

1. **`main.css:1521-2047` ≈ `hud.css:32-560`**：527 行對 529 行，`diff` 只有 **132 行差異**，而差異全部係排版（換行、註解文字、空格）—— 內容實質相同。即「Tactical HUD」整段被**同時**寫入兩份檔案。
2. **`hud.css:584-679` 與 `hud.css:690-785` 完全相同**（各 96 行，`diff` 輸出為空）。
3. **`src/main.ts:5-6`**：

```ts
import "./styles/hud.css";
import "./styles/hud.css";
```

   同一份 CSS **import 兩次**。
4. `hud.css:25-29` 嘅註解自己寫「為何另開一個檔案而唔係加落 main.css：main.css 已經有 1,000+ 行、而且歷史上有過重複嘅 #topbar 區塊」—— 但 main.css 亦被加上同一段，形成新一輪重複。

**Root cause（結構性）**

CSS 冇單一擁有者，靠「後載入覆蓋」做版本管理（`main.css` → `timeline.css` → `hud.css`）。同一段設計語言被複製兩次以「確保覆蓋」，結果兩份都會被將來嘅改動遺漏其中一份。

**影響**

- 任何 HUD 視覺改動都要改 2–3 個地方，漏改即產生「半新半舊」外觀（spec §8.8 明確禁止「兩套 conflicting architecture」）。
- 96 行 light 主題覆寫重複 → 增加漏覆蓋風險（見 P2-5）。

**相關檔案**

- `src/styles/main.css`（1495-2047）
- `src/styles/hud.css`（1-785）
- `src/main.ts`（3-6）

**修正方案**

刪除 `main.css:1495-2047` 整段（527 行），刪除 `hud.css:690-785`（96 行），刪除 `main.ts:6` 重複 import。**唔可以「保留兩份但同步」** —— 必須單一擁有者。

**驗收方法**

```bash
# 1) 確認 main.css 唔再含 HUD 區塊
grep -c 'hud-sweep\|hud-in-left\|hud-in-up\|zone-scan\|zd-glyph-pulse' src/styles/main.css   # 期望 0
# 2) 確認 hud.css 冇重複 light 區塊
grep -c '\[data-theme="light"\]' src/styles/hud.css   # 期望 ≈ 舊值一半
# 3) 確認 import 唯一
grep -c 'styles/hud.css' src/main.ts   # 期望 1
```

另加視覺回歸：刪除前後 desktop/tablet/mobile × dark/light 六張截圖必須 **pixel-identical**（交 B9 用 Playwright `toHaveScreenshot` 斷言）。呢個係「刪重複」最強證據：如果刪完外觀有變，就證明原本係 conflicting duplicate。

**風險**

- 低（純刪重複）。唯一風險係如果兩份**實際上**有細微差異（132 行 diff 中嘅實質差異），刪錯會改外觀 —— 所以必須用 pixel-diff 驗收。

---

### 【P1-2】CSS 死碼：`timeline.css` 幾乎全死；三份 CSS 有 34.2% 規則行對唔到任何 live 元素

**觀察證據**

區塊級分析（`css-dead-blocks.mjs`，先移除註解、按 `{}` 配對、以 selector 嘅 class/id token 對照 runtime live 集合）：

| 檔案 | 總行 | live 區塊（行數） | dead 區塊（行數） |
|---|---|---|---|
| `main.css` | 2048 | 207（1004 行） | 105（**488 行**） |
| `hud.css` | 786 | 67（262 行） | 64（**277 行**） |
| `timeline.css` | 431 | **2（8 行）** | **56（351 行）** |
| **合計** | **3265** | 1274（39.0%） | **1116（34.2%）** |

- **`timeline.css` 只有 2 個 selector 行對應 live 元素**（`.bg-spoiler-btns button.active`、`.bg-char-list button.active`），其餘 81 個 selector 行全部無匹配。即 430 行 CSS 服務一個**已經唔存在嘅 UI**。
- 抽出 **203 個 class token / 43 個 id token**，其中：
  - **32 個 class selector 喺 TS 完全冇 producer**（真死碼）：`bg-provisional-banner`、`bg-marker`、`bg-dot`、`bg-meta`、`tl-list`、`tl-item`、`tl-marker`、`tl-chapter`、`tl-date`、`tl-spoiler`、`tl-desc`、`tl-meta`、`tl-highlight`、`tl-filter`、`bg-search*`、`bg-sidebar-inner`、`bg-hint`、`bg-spoiler-btns`、`bg-char-list`、`char-dot`、`bg-measure-btn`、`bg-measure-tip`、`bg-detail-actions`、`bg-about-inner`、`type-character`、`type-event`、`type-location`、`spoiler-2`、`spoiler-3`、`is-current`、`#map-root`。
  - **98 / 203 class 喺 chronicle + chapter 兩種視圖都冇任何元素匹配**（包含條件性未達者，例如 `zd-*` 只在選中 zone 後出現 —— 但因為 P0-2，預設流程永遠達唔到）。
- **`43 個 id token 只有 4 個 live**：`app-root`、`topbar`、`svg-map-mount`、`story-panel-mount`。其餘 39 個（`#map-root`、`#bg-event-panel`、`#bg-sidebar`、`#bg-search-input`、`#timeline`…）全部唔存在。

**Root cause（結構性）**

`src/` 經歷多次「整個 UI 換掉但唔刪舊 CSS」嘅迭代（Phase F → H/I → L）。`timeline.css` 係 Flat-UI 時代遺物，`main.css` 前半係「Modern Archive」時代，後半係「Tactical HUD」時代 —— 三個時代嘅 CSS 同時 ship 到 production（bundle CSS 45.17 kB）。

**影響**

- spec §8.8「old dead CSS / components / state / handlers 已刪；冇兩套 conflicting architecture」**FAIL**。
- 34% 規則行係噪音，令任何視覺審計（包括本報告）嘅 signal-to-noise 惡化，亦令 A3 / B1 難以判斷「邊個係真相」。
- `timeline.css` 引入第三套 token 命名（`--color-*`），見 P1-3。

**相關檔案**

- `src/styles/timeline.css`（全檔）
- `src/styles/main.css`（105 個 dead 區塊，例如 `.modal-*`、`.search-*`、`.back-btn`）
- `src/styles/hud.css`（64 個 dead 區塊，主要係 `zd-*` / `zone-*` 條件性）
- `src/main.ts`（import）

**修正方案**

1. **刪 `timeline.css` 整個 import**（先確認 `.bg-spoiler-btns button.active` / `.bg-char-list button.active` 兩個 live 規則係唔係因為 class 名稱 substring 巧合而誤判 —— 需逐一核對，若真係 live 則搬去 `main.css` 再刪檔）。
2. **逐個 dead 區塊處理**：真死碼（32 個 class，TS 無 producer）**直接刪**；條件性未達者（`zd-*` 等）**保留但必須先修好 P0-2 令佢可達**，否則一律刪。
3. **建立 dead-CSS gate**（B9）：每次 build 後跑 `css-dead-blocks.mjs`，assert「dead 區塊行數 ≤ 5%」；並喺 CI 阻擋新增未使用 selector。

**驗收方法**

```bash
node artifacts/audit-A2/dead-css-probe.mjs
node artifacts/audit-A2/css-dead-blocks.mjs
```

通過條件：
- 三份 CSS 合計 dead 規則行 **≤ 160 行（≤5%）**（現 1116 行 / 34.2%）。
- `timeline.css` 唔再被 import（或已刪除），`src/main.ts` 只有 3 個 CSS import。
- 刪除前後六張 baseline 截圖 pixel-identical（證明刪嘅真係死碼）。

**風險**

- **高風險**：`dead-css-probe` 用「預設 + chapter 兩種視圖」做 live 判定，**會誤判只在其他狀態出現嘅 class**（例如開 modal 後、選中 zone 後）。所以「刪」必須配 pixel-diff + 全狀態覆蓋測試，唔可以只信本報告嘅 32 個清單。本報告提供嘅係**候選清單**，唔係最終判決。

---

### 【P1-3】Design token 只做一半：431 個硬寫顏色、12 個指向未定義 token、5 套並行顏色權威

**觀察證據**

1. **CSS 硬寫顏色 329 個**（`#hex` 172 + `rgb()/rgba()` 157），`var(--…)` 623 次。distinct hex **80 個**散落三檔（main 60 / hud 12 / timeline 8）。
2. **TS 硬寫顏色 102 個**（70 個 hex literal + 32 個 `rgba()`），distinct hex **61 個**，包含**大小寫重複**：`#e74c3c` 與 `#E74C3C`、`#9b59b6` 與 `#9B59B6`、`#f39c12` 與 `#F39C12`（同一顏色兩個 literal）。
3. **12 個 `var(--…)` 指向從未定義嘅 token**（`comm` 比對 var 使用 vs token 定義）：

```
--bg-deep  --chip-color  --color-accent  --color-border  --color-danger
--color-primary  --color-secondary  --color-success  --color-surface
--color-text  --color-text-muted  --fg
```

   `--color-*` 全部係 `timeline.css` 使用，帶 Flat-UI fallback（`#f39c12` / `#e74c3c` / `#2c3e50` / `#1a252f` / `#ecf0f1` / `#95a5a6` / `#2ecc71`）→ **第三套顏色權威，且係死 token**。`var(--fg)`（`main.css:376`）冇 fallback → 該宣告靜默失效。
4. **`--hud-*` 實際上冇被採用**：runtime 量測 `--hud-cyan`（`rgb(56,232,255)`）只用於 **2 個元素**，`--hud-danger`（`rgb(255,90,77)`）1 個，`--hud-safe`（`rgb(47,214,168)`）1 個，`--hud-amber`（`rgb(232,197,71)`）1 個。相反 legacy `--accent-teal` 用於 **1214** 個元素、`--accent-blue` **1320** 個、`--accent-purple` **212** 個。
5. **Runtime 色彩多樣性其實偏低但係「錯嘅色」**：全頁只有 **14 個 distinct text color**、**25 個 distinct bg**，但 top color 係 `rgb(238,243,249)`（5401）、`rgb(107,124,150)`（2828）、`rgb(169,184,204)`（1431）、`rgb(74,87,105)`（1425）、`rgb(74,158,219)`（1320）、`rgb(47,179,163)`（1214）→ 即 legacy `--fg-*` + `--accent-blue/teal` 主導，**HUD 青色系統缺席**。
6. **5 套並行顏色權威**：

| # | 權威 | 位置 | 規模 |
|---|---|---|---|
| S1 | `--accent-*` + `--bg-*` + `--fg-*`（Modern Archive） | `main.css:24-84` | 7 accent + 5 bg + 4 fg + 3 border |
| S2 | `--hud-*` + `--glass` + `--hairline`（Tactical HUD） | `hud.css:32-58`（＋`main.css:1521-1547` 重複） | 7 + 4 |
| S3 | `--color-*`（Flat UI 遺物，**未定義**） | `timeline.css` 使用 | 12 個死引用 |
| S4 | `PALETTE_DARK` / `PALETTE_LIGHT`（canvas 道路地圖） | `VectorBasemap.ts:162-228` | 每套 16 欄位 + 8 條道路色 |
| S5 | TS inline（zone / marker / route） | `SvgMap.ts:1168-1193`、1462、1540 等 | 61 distinct hex |

7. **非顏色 token 一樣只做一半**：

| 維度 | 硬寫次數 | 用 token 次數 | token 化率 |
|---|---|---|---|
| 顏色 | **431** | 623（`var(--…)`） | — |
| `font-size` | **93**（17 個 distinct 值） | 24 | 21% |
| `padding` | **100** | 48（`--sp-*`） | 32% |
| `border-radius` | **41** | 16（`--r-*`） | 28% |
| `box-shadow` | **32** | 7（`--shadow*`） | 18% |
| `z-index` | **11 個離散值** | 0（**冇 token**） | 0% |

   → 即 `--sp-*` / `--r-*` / `--shadow*` / `--fs-*` 四套 token **存在但使用率只有 18–32%**，而 `z-index` **完全冇 token**（11 個離散值，其中 `800 / 900 / 1200 / 1300` 冇文檔、冇註解）。

**Root cause（結構性）**

Token 化只做咗「命名」，冇做「**收斂**」。每一代 UI 都新增一套 token 而唔刪舊套，且 canvas / SVG 圖層**繞過 CSS** 自己持有色值。結果：token 存在，但**冇任何機制保證 UI 只用 token**。

**影響**

- spec §5.2「使用 CSS custom properties / typed token config」形式上滿足、**實質未滿足**（HUD token 使用率 2 個元素）。
- 任何「統一色調」嘅改動都要改 5 個地方，必然漏改 → 直接造成 P0-1（淺色主題 badge 漏覆蓋）同 P2-5。
- spec §8.8「冇兩套 conflicting architecture」FAIL。

**相關檔案**

- `src/styles/main.css`（24-84、1521-1547）
- `src/styles/hud.css`（32-58）
- `src/styles/timeline.css`（8-9、31、41-42、52、56、65、80-81、86、101、106、117、121、126）
- `src/map/VectorBasemap.ts`（162-228）
- `src/components/SvgMap.ts`（1168-1193 等）
- `src/theme.ts`（`basemap-theme-change` 事件 —— 已存在，可作為 token → canvas 嘅橋樑）

**修正方案**

1. **定義唯一 token 命名空間**（見末節〈V2 Design Token 提案〉），刪除 `--accent-*` 與 `--hud-*` 兩套並行命名，統一為 `--c-*`（color）語意命名。
2. **CSS 層硬性禁止 literal 值**：加 Stylelint 規則 —— `color-no-hex`、`declaration-property-value-disallowed-list`（`font-size` / `padding` / `border-radius` / `box-shadow` / `z-index` 只准用 `var(--…)`），`rgb`/`rgba`/`hsl` 只准喺 token 定義檔出現。呢個係可重跑 gate，唔需要人手。**重點：唔止顏色，尺寸同 z-index 都要 token 化**（現時 `font-size` 硬寫 93 處、`padding` 100 處、`border-radius` 41 處、`box-shadow` 32 處、`z-index` 11 個離散值）。
3. **Canvas palette 改為讀 CSS token**：`VectorBasemap.ts` 唔再 export `PALETTE_*`，改為 `readPalette()` 由 `getComputedStyle(document.documentElement)` 讀 `--basemap-*`，並監聽既有 `basemap-theme-change`。
4. **SVG zone/marker/route 顏色改為 `currentColor` 或 CSS class**，唔再 `setAttribute("fill", "#…")`。SVG presentation attribute 會被 CSS 覆蓋，所以只要加 CSS 規則就可以接管（呢個係低風險、可漸進嘅做法）。
5. **刪除 12 個未定義 token 引用**（`timeline.css` 一併刪，見 P1-2）。

**驗收方法**

```bash
# CSS literal 顏色數（期望 ≤ 60，即只在 token 定義檔出現）
grep -oE '#[0-9a-fA-F]{3,8}\b|\brgba?\(' src/styles/*.css | wc -l
# TS literal 顏色數（期望 ≤ 10，即只剩 fallback）
grep -rnoE '"#[0-9a-fA-F]{3,8}"' src --include='*.ts' | wc -l
# 未定義 token 引用（期望 0）
comm -23 <(grep -rhoE 'var\(--[a-z0-9-]+' src/styles/ | sed 's/var(//' | sort -u) \
         <(grep -rhoE '^\s*--[a-z0-9-]+\s*:' src/styles/ | tr -d ' :' | sort -u) | wc -l
# 非顏色 token 化率（期望：硬寫 ≤ 10 處）
grep -rhoE 'font-size:[ ]*[0-9.]+px' src/styles/*.css | wc -l   # 現 93
grep -rhoE 'padding:[ ]*[0-9]' src/styles/*.css | wc -l         # 現 100
grep -rhoE 'border-radius:[ ]*[0-9]' src/styles/*.css | wc -l   # 現 41
grep -rhoE 'box-shadow:[ ]*[^v]' src/styles/*.css | wc -l       # 現 32
```

通過條件：
- CSS literal 顏色 **≤ 60**（現 329）。
- TS literal 顏色 **≤ 10**（現 70 hex）。
- 未定義 token 引用 **= 0**（現 12）。
- `font-size` 硬寫 **= 0**、`padding` 硬寫 **≤ 10**、`border-radius` 硬寫 **= 0**、`box-shadow` 硬寫 **= 0**（現 93 / 100 / 41 / 32）。
- `z-index` 只准用 `var(--z-*)`，distinct 值 **≤ 5**（現 11）。
- runtime：每個 `--c-*` token 嘅使用元素數 **≥ 20**（即冇「定義但冇用」嘅 token）。

**風險**

- Stylelint 禁 hex 會令漸層 / shadow 難以表達 → 需容許 `rgb(from var(--x) r g b / 0.5)` 或提供 `--c-x-10/20/40` 透明度階梯 token。
- Canvas 讀 CSS token 每次 draw 都 `getComputedStyle` 會慢 → 必須喺主題切換時 cache，唔好每次 frame 讀。

---

### 【P1-4】Motion 系統冇 scale、冇語意：19 個 duration、9 個死 keyframes

**觀察證據**

1. **CSS duration 有 19 個唔同值**（硬寫，非 token）：

```
200ms×8  220ms×4  120ms×4  420ms×3  240ms×3  80ms×2  520ms×2
460ms×2  380ms×2  160ms×2  300ms×1  260ms×1  180ms×1  90ms×1
60ms×1   40ms×1   30ms×1  (+ 1ms / 0.001ms 減動效)
```

   spec §5.2 要求嘅 scale 只有 `fast 120 / normal 220 / slow 420`。現況有 **16 個值落喺 scale 之外**。
2. **Easing 有 3 條 bezier + 7 個 `ease` + 8 個 `ease-out`**：

```
cubic-bezier(0.4, 0, 0.2, 1)  ×3   （--transition / --transition-fast）
cubic-bezier(0.65, 0, 0.35, 1) ×2  （--ease-in-out）
cubic-bezier(0.22, 1, 0.36, 1) ×2  （--ease-out）
+ 裸 ease ×7、裸 ease-out ×8（非 token）
```

3. **`@keyframes` 11 個、`animation:` 20 條，但預設視圖只有 3 個真正運行**：

```
hud-in-left@0.52s x1        （.map-overlay）
story-enter@0.26s x1        （#story-panel-mount.story-enter > *）
hud-sweep@6s infinite       （#topbar::after，pseudo-element）
```

   即 `zone-scan`、`zd-glyph-pulse`、`hud-in-up`（5 條宣告）、`story-enter` 其他分支等 **8 個 keyframes 喺預設視圖完全冇運行**。
4. **spec §5.4 要求嘅「病窩低頻呼吸紅光」實測 0 個運行**：`.zone-pulse` 只在 `kind === "nest"` 時建立（`SvgMap.ts:1255-1263`），但第 1 章可見 zone 只有 1 個且係 `survivor` → `document.querySelectorAll('.zone-pulse').length === 0`。
5. **`transition: all` 出現 6 次**（`grep -rn 'transition: all'`），其中 `all` 喺 2725 個元素上生效（`getComputedStyle` 掃描最大 transition 簽名 = `all | 0.12s` × 2725）。
6. **JS 動畫完全喺 token 系統之外**：`SvgMap.ts:195` `const ANIM_DURATION_MS = 500;` 硬寫，`animateViewBox()` 用 rAF + ease-in-out cubic 自製（`SvgMap.ts:1021-1063`），唔用 CSS 亦唔用 token。
7. **Motion 用途冇白名單**：`#topbar::after` 有一條 `6s infinite` 掃描線 —— 屬「裝飾性持續動畫」，唔喺 spec §5.2 列出嘅 7 種目的之內（spec §5.2 禁止無限高速閃爍；6s 唔算高速，但屬「無目的裝飾」）。

**Root cause（結構性）**

Motion 係**逐個 component 手寫**，冇 motion primitive 層，亦冇「邊個狀態可以 animate」嘅契約。所以每次加效果就新增一個 duration，舊效果唔會收斂。

**影響**

- spec §5.2「motion system：duration、easing、which state can animate、reduced motion fallback」**未成立**。
- 19 個 duration 令節奏感散亂：hover 120ms、panel 520ms、dossier section 380ms、canvas fade 420ms —— 使用者感受到嘅係「唔一致」而唔係「有節奏」。
- `transition: all` × 2725 元素係效能風險（會 animate layout 屬性）。

**相關檔案**

- `src/styles/main.css`（82-83 token、1121-1137 story-enter、1587-1592、1668-1673、1737-1742、1760-1767、1800、1839、1930-1936）
- `src/styles/hud.css`（104-107、176-179、250-253、279-282、360-363）
- `src/components/SvgMap.ts`（195 `ANIM_DURATION_MS`、1021-1063 `animateViewBox`、1751-1767 zone-pulse 相關）
- `src/map/VectorBasemap.ts`（686-692 `scheduleDraw` —— 需求驅動，非持續迴圈，**此項係正面發現**）

**修正方案**

1. **建立 3 級 motion token + 2 條 easing**（見末節 token 表），並刪除其餘 16 個硬寫 duration。
2. **建立 motion 用途白名單**（spec §5.2 嘅 7 種目的），任何唔喺白名單嘅 animation 一律刪 —— 包括 `#topbar::after` 6s 掃描線（除非重新定位為「loading / data stream」語意，並且只喺載入時播放）。
3. **刪除 6 處 `transition: all`**，改為明確 property 清單（只 animate `opacity` / `transform` / `fill-opacity` / `stroke-opacity` / `color` / `background-color` / `border-color`）。
4. **JS motion 由 CSS token 驅動**：`ANIM_DURATION_MS` 改為 `parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mo-slow'))`，令 CSS 同 JS 共用同一 scale。
5. **將 `@keyframes` 由 11 個收斂到 ≤ 6 個**（`fade-in`、`slide-in-left`、`slide-in-up`、`zone-pulse`、`skeleton`、`draw-route`），其餘用參數化 utility class。

**驗收方法**

```bash
# 1) distinct duration（期望 ≤ 3，另加 0.001ms 減動效）
grep -rhoE '[0-9]+ms' src/styles/*.css | sort -u | wc -l
# 2) transition: all（期望 0）
grep -rc 'transition: all' src/styles/*.css
# 3) 裸 easing 關鍵字（期望 0，全部用 var(--mo-ease-*)）
grep -rhoE 'transition:[^;]*(ease|linear)' src/styles/*.css | wc -l
```

另加 runtime 斷言（交 B9）：預設視圖 `document.getAnimations().filter(a => a.playState === 'running' && a.effect.getTiming().iterations === Infinity).length === 0`（現有 1 個：topbar 掃描線）。

**風險**

- 收斂 duration 會改變既有手感 → 需喺 `UX_DECISIONS.md` 記錄。
- 刪 `transition: all` 可能令某些未預期嘅狀態變化失去過渡 → 需逐個 component 核對。

---

### 【P1-5】`prefers-reduced-motion` 只有 CSS 全局覆寫；JS 動畫完全唔理

**觀察證據**

1. CSS 有 **3 處** `prefers-reduced-motion`：
   - `main.css:1107-1112`（`animation-duration: 0.01ms !important; transition-duration: 0.01ms !important`）
   - `main.css:2040-2047`（`animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important`）
   - `hud.css:564-573`（同上，與 main.css:2040 **重複**）
2. 實測有效：`reducedMotion: 'reduce'` 之下 animation duration 由 `0.52s` 變 `1e-06s`，transition 簽名由 19 個降到 8 個。**CSS 層 fallback 係 work 嘅**（正面發現）。
3. **但 TS 完全冇處理**：

```bash
grep -rn "reduced-motion\|reducedMotion\|prefers-reduced" src --include='*.ts'
# → 0 命中
```

   即以下 JS 動畫喺 reduce 模式下**照樣播放**：
   - `SvgMap.animateViewBox()`（`SvgMap.ts:1021-1063`，500ms rAF tween，用於 zoom / reset / flyTo）
   - `SvgMap.zoomBy()` 觸發嘅 viewBox 更新
   - `VectorBasemap.scheduleDraw()` 每次 pan/zoom 重繪
   - `main.ts:36` 嘅分階段載入 `setTimeout(baseDelayMs * (i + 1))`
4. **全局 `*` 覆寫係鈍器**：`animation-duration: 0.001ms !important` 會令**必要**嘅狀態回饋（例如 selected zone outline）亦一齊消失，而唔係改成「無位移但仍然有狀態變化」。

**Root cause（結構性）**

Motion 冇單一入口。CSS 動畫同 JS 動畫係兩條平行軌道，reduced-motion 只覆蓋其中一條。

**影響**

- spec §5.2「必須有 `@media (prefers-reduced-motion: reduce)` fallback」形式上滿足、實質**只覆蓋一半**。
- spec §0.3 / §1.1「小型視覺細節必須有 reduced motion fallback」→ 對 JS 驅動嘅 fly-to / zoom 過場 **FAIL**。
- 對前庭功能敏感使用者，500ms 全屏 viewBox 縮放係最強烈嘅動態（比任何 CSS 效果都強）。

**相關檔案**

- `src/components/SvgMap.ts`（195、1021-1063）
- `src/map/VectorBasemap.ts`（686-692）
- `src/main.ts`（36）
- `src/styles/main.css`（1107-1112、2040-2047）
- `src/styles/hud.css`（564-573）

**修正方案**

1. **建立單一 motion 入口 `src/motion.ts`**：

```ts
export const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const motionDuration = (ms: number) => (prefersReducedMotion() ? 0 : ms);
```

   `SvgMap.animateViewBox()` 改為 `durationMs = motionDuration(ANIM_DURATION_MS)`；若為 0 就**直接跳到終態**（唔係跳過更新）。
2. **CSS 由「全局鈍器」改為「目的導向」**：移除 `*` 覆寫，改為逐個 motion primitive 提供 reduce 版本 ——
   - 位移／縮放／pulse → 完全移除；
   - 淡入淡出（opacity）→ 保留但縮短到 120ms（唔會引起 motion sickness，而且保留狀態回饋）。
3. **保留狀態可辨性**：reduce 模式下 selected zone 必須仍有**非動態**嘅視覺差異（例如更粗邊界 + pattern 密度改變），而唔係靠 pulse。

**驗收方法**

```bash
grep -rn "prefers-reduced-motion" src --include='*.ts' | wc -l   # 期望 ≥ 1
```

Playwright 斷言（`reducedMotion: 'reduce'`，交 B9）：
- 點 `#map-zoom-in` 之後 **下一 frame** `viewBox` 已經係終值（即無中間態）。
- `document.getAnimations().filter(a => a.playState === 'running').length === 0`。
- selected zone 仍然有可量測嘅非動態視覺差異（`stroke-width` 或 `fill-opacity` 不同於未選中）。

**風險**

- 「淡入保留、位移移除」需要逐個效果分類，係設計判斷而唔係機械規則 → 需寫入 `UX_DECISIONS.md`（spec §8.10 已要求）。
- 移除 `*` 覆寫後，可能遺漏某些第三方（無）或遺留 CSS 動畫 → 需逐個 keyframe 加 reduce 版本，並用 gate 斷言。

---

### 【P1-6】選中 zone 之後地圖零視覺回饋：冇 fly-to、冇 soft-focus、冇 URL

**觀察證據**

強制選中 zone 前後量測（`selected-zone-probe.mjs`）：

| 項目 | 選中前 | 選中後 |
|---|---|---|
| `viewBox` | `113.79 22.11 0.7 0.5407` | **完全相同**（無 fly-to） |
| selected polygon 螢幕尺寸 | 10×10 px | **10×10 px** |
| `zones-layer` opacity | 1 | **1**（無 dim） |
| 其他 zone opacity | — | **0 個其他 zone**；`layerOpacities` 全部 `1` |
| URL | `#ch=1` | **`#ch=1`**（無 `?zone=`） |
| selected `fill-opacity` | 0.10 | 0.30 |
| selected `stroke-width` | 0.0014 | 0.0022 |

- CSS 只實作「提升 selected」：`main.css:1753-1754`
  ```css
  .zone:hover .zone-area { fill-opacity: 0.24; stroke-opacity: 1; }
  .zone.is-selected .zone-area { fill-opacity: 0.30; }
  ```
  **冇任何規則降低未選中 zone** → spec §2.4「selected zone：地圖 soft-focus 其他區域」**冇實作**。
- 事件 marker 點擊同樣冇 fly-to（`viewBox` 不變）且 URL 唔變。
- URL 契約（`src/router.ts:16-36`）只支援 `#ch=<n>&loc=<id>`；`syncHash()`（`app.ts`）只寫 `ch` 同 `loc` → **zone / event / character / layers / spoiler / view 全部唔可序列化**。

**Root cause（結構性）**

Zone 互動只有「設定 state → 重繪」一條路，冇 camera 控制層（`map-camera.ts` 概念喺 spec §5.3 有提，現時唔存在）。`zoneById` Map 喺 `SvgMap.ts:1195-1196` 建立後**從未使用**（死碼）—— 反映 zone 互動層係未完成狀態。

**影響**

- spec §2.4 Zone interaction design 四項（hover glow + tooltip / click 開 dossier / soft-focus / 由 dossier 跳去相關事件）之中，**只有 click 開 dossier 部分成立**（而 P0-2 令佢實質不可達）。
- spec §5.1 URL contract（`?zone=`、`?event=`）**未實作** → 選中狀態 refresh 即失去，亦無法寫視覺回歸測試。
- Journey B 第 1 步「地圖流暢聚焦到 polygon」**FAIL**。

**相關檔案**

- `src/components/SvgMap.ts`（625-662 click、1021-1063 animateViewBox、1195-1196 死碼 `zoneById`）
- `src/styles/main.css`（1748-1784）、`src/styles/hud.css`（同區塊）
- `src/app.ts`（`setSelectedZone`、`syncHash`）
- `src/router.ts`（16-42）

**修正方案**

1. **加 camera 控制層**：`setSelectedZone()` 必須觸發 `flyTo(zoneBounds, padding 0.25)`，並用 `motionDuration()` 包住（見 P1-5）。同時處理「zone 太細」：fly-to 最小 viewBox 要令 polygon 螢幕 ≥ 160 px，否則唔算聚焦。
2. **實作 soft-focus**：
   - 未選中 zone：`opacity 0.35`、`fill-opacity 0.04`、`saturate(0.4)`（用 CSS filter 或直接調 token 色）；
   - 未選中 marker / route：`opacity 0.25`；
   - selected zone：加 `outline pulse`（spec §5.2 白名單第 2 項）＋ 顯示內部 landmark。
   呢個係 spec §5.2「map layer fade / cross-fade」嘅正當用途。
3. **擴充 URL 契約**：`#ch=1&zone=<id>` / `#ch=1&event=<id>` / `#layers=zones,events,routes`，並令 refresh 可還原 selected zone（spec §5.1）。
4. **刪死碼 `zoneById`** 或實作佢本來想做嘅事（zone lookup for tooltip）。

**驗收方法**

```bash
node artifacts/audit-A2/selected-zone-probe.mjs
```

通過條件：
- 選中 zone 後 `viewBox` **必須改變**，且 selected polygon 螢幕最小邊 **≥ 160 px**（現 10 px，viewBox 不變）。
- 若同章有多個 zone：未選中 zone 嘅 `opacity` **< 0.5**（現全部 1）。
- `location.hash` 含 `zone=<id>`；重新載入後 `document.querySelectorAll('.zone.is-selected').length === 1`。
- selected zone 有 `outline pulse` 且 `prefers-reduced-motion: reduce` 下仍有非動態差異。

**風險**

- Fly-to 動畫 + soft-focus 同時上場會令 reduce 模式使用者體驗突兀 → 必須配 P1-5 一齊做。
- 若 48 個 zone 全部 soft-focus 運算（filter），pan/zoom 可能掉 frame → 建議用 token 色而唔用 CSS `filter`（filter 會建立新 compositing layer）。

---

### 【P1-7】Spec §1.1 要求嘅 noise / scanline / grid：noise 完全冇、scanline 只有 1 處

**觀察證據**

```bash
grep -rin 'noise' src/ public/ --include='*.css' --include='*.ts' --include='*.svg'
# → 0 命中

grep -rn 'repeating-linear-gradient' src/styles/*.css
# → main.css:1818 與 hud.css:338（同一段 .zd-head::after，重複）
# → 即 scanline 只存在於 zone dossier 頭部一處

grep -rn 'grid' src/map/VectorBasemap.ts
# → 182: grid: "rgba(70, 140, 180, 0.055)"   ← alpha 0.055，極淡
# → 216: grid: "rgba(40, 90, 130, 0.07)"
```

- spec §1.1 要求「半透明玻璃面板、**細緻 noise / scanline / grid**、地圖等高線或戰術輪廓、微弱光暈」。
- 現況：**noise 0**、scanline 只有 dossier 頭部（且係重複代碼）、grid alpha 0.055（幾乎不可見）、**冇等高線 / 戰術輪廓**。
- Glass panel 實測 5 個（`backdrop-filter` 6 條宣告）：`div.map-overlay` `blur(10px) saturate(1.2)` 229×308（5.4% 面積）、`div.map-legend` `blur(8px)` 201×284（4.4%）、3 個 `button.map-ctrl` `blur(8px)` 34×34。→ **冇違反「長時間大面積 blur」**（正面發現：最大 5.4%，mobile 18.9%）。

**Root cause（結構性）**

「材質層」從來冇被實作。HUD 設計語言（`hud.css:1-30` 註解）自己寫「掃描線 + 微網格 —— 令平面面板有『儀器』質感」，但實際只有 1 個偽元素做掃描線。

**影響**

spec §1.1 材質要求大部分 **未滿足**。缺少材質令 UI 讀起來係「純色平面 + 陰影」= 通用 web app，而唔係「情報指揮室」。

**相關檔案**

- `src/styles/main.css`（1660-1666 `.map-overlay`、1814-1827 `.zd-head::after`）
- `src/styles/hud.css`（同區塊）
- `src/map/VectorBasemap.ts`（182、216 grid、852 `ctx.strokeStyle = this.palette.grid`）

**修正方案**

1. **建立材質 utility 層**（`src/styles/texture.css` 或 token 化 mixin）：
   - `.tex-noise`：SVG `feTurbulence` base64 data-URI（**本機產生，唔用 remote asset**），`opacity: 0.035`，`mix-blend-mode: overlay`。用 `background-image` 而唔係 `filter`（避免 compositing layer）。
   - `.tex-scanline`：`repeating-linear-gradient(0deg, rgba(255,255,255,.03) 0 1px, transparent 1px 4px)`，**只用於面板，唔用於地圖**（spec §1.1 禁止「裝飾粒子遮住地圖」）。
   - `.tex-grid`：`background-size: 24px 24px` 雙向 hairline，alpha ≤ 0.05。
2. **加戰術輪廓**：地圖層加「等距量測圈 / 方位刻度 / 經緯刻度」—— 用 SVG vector，`pointer-events: none`，透明度 ≤ 0.12。
3. **明確禁止清單**：noise / scanline **一律唔准覆蓋地圖內容區**（只能喺 panel 同邊框），並用 CI 斷言：地圖容器內 `.tex-*` 元素數 = 0。

**驗收方法**

```bash
grep -rc 'tex-noise\|tex-scanline\|tex-grid' src/styles/*.css   # 期望 > 0
grep -rin 'noise' src/ --include='*.css' | wc -l                 # 期望 ≥ 1
```

Playwright 斷言：
- 至少 1 個元素有 `backgroundImage` 含 noise data-URI；
- 地圖容器（`#svg-map-mount`）內**冇**任何 `.tex-*` 元素；
- 材質圖層 `opacity ≤ 0.05`，且唔改變任何文字節點嘅計算對比（跑 P0-5 嘅對比 gate 必須仍為 0 fail）。

**風險**

- `mix-blend-mode` 會建立 compositing layer，配合 `backdrop-filter` 可能令 mobile 掉 frame → 需量測（交 C6）。
- Data-URI noise 會增加 CSS 體積 → 需 size budget（spec §7.4 已要求）。

---

### 【P2-1】Legend 浮層遮蓋地圖：mobile 佔畫面 18.9%（寬度 57%）

**觀察證據**

| viewport | `.map-overlay` 尺寸 | 佔畫面面積 | 佔畫面寬度 |
|---|---|---|---|
| desktop 1440×900 | 229×308 | 5.4% | 16% |
| tablet 768×1024 | 221×282 | **7.9%** | 29% |
| mobile 390×844 | 221×282 | **18.9%** | **57%** |

- Mobile 截圖（`dark-mobile.png`）：legend 由 y≈205 到 y≈487，**遮住地圖上半部**，地圖實際可見只剩下半約 390×330。
- Legend 冇收合 / 冇 toggle 按鈕（`#legend-lang-btn` 只切換語言）。

**Root cause**

Legend 係固定 overlay，冇 responsive 策略（只有 `max-width: 44vw` / `56vw`，見 `main.css:1088-1101`），亦冇 mobile 專屬處理。

**影響**

spec §0.3「mobile 唔係縮細 desktop」、§1.2「Map first」FAIL。

**相關檔案**：`src/components/SvgMap.ts`（519-521 legend HTML）、`src/styles/main.css`（1088-1101）

**修正方案**：mobile 改為可收合 chip（只顯示「圖例」按鈕，點擊由底部 sheet 展開）；legend 內容改為 2 欄或 icon-only + tooltip；`@media (max-width:639px)` 下 legend 預設 collapsed。

**驗收方法**：mobile 390×844 下 `.map-overlay` 佔畫面面積 **≤ 4%**（現 18.9%），或預設 `display:none` + 有可達 toggle。

**風險**：低。

---

### 【P2-2】Chronicle 係 1320 張一模一樣嘅卡片堆疊（「廉價 AI dashboard」實證）

**觀察證據**

- **1320 個 `<article>`**（`chronicle.json` 1320 條），eager render；`chr-*` class 元素 **13681 個 = DOM 14036 嘅 97%**。
- 卡片幾何：**327×115 px、`border-radius: 8px`、`padding: 12px`、`background: rgb(34,43,57)`（`--bg-elevated`）、`border: 1px rgb(29,37,49)`** —— 1320 張完全同構。
- 每張卡片內容結構固定：標題 + 2 個 tag pill + `ch<N>` chip + 2–3 個 meta 標籤。
- 頂部「sparkline」係 **198 條 1px 寬 × 17px 高**嘅 `.chr-tl-bar`（等於每章 1px），資訊密度極低但視覺噪音高。
- 卡片內文字就係 P0-5 嘅主要對比 fail 來源（`chr-ch-role` 1401 + `chr-loc` 1200）。

**Root cause**

`ChronicleView` 直接 render 全部資料，冇 virtualization / 分組 / 視覺節奏設計。spec §2.1「時間軸／編年史需支援 virtualized / paginated rendering，唔可以一開始 render 大量 card」明確指出此問題。

**影響**

spec §1.1 禁止項「廉價『AI dashboard』卡片堆疊」**直接命中**；spec §0.3 北極星第 1 條 FAIL。

**相關檔案**：`src/components/ChronicleView.ts`（433 行）、`src/styles/main.css`（chronicle 相關區塊）

**修正方案（唔可以只改卡片樣式）**

1. **改資訊架構**：由「1320 張平鋪卡片」改為 **時期（period）→ 章節群 → 事件** 三層；預設只展開時期，章節群 collapsed。
2. **Virtualization**：只 render viewport 內 ± 1 屏。
3. **取消卡片隱喻**：改用「編年史條目 + 時間軸 spine」—— 事件用時間軸上嘅 tick + label，而唔係獨立圓角矩形。呢個係結構改變，唔係 cosmetic。
4. **sparkline 改用向量密度圖**（例如 198 章 × 事件數嘅 heat strip），唔用 198 條 1px bar。

**驗收方法**：預設 chronicle DOM 元素數 **≤ 2500**（現 13681）；`article` 數 **≤ 60**（現 1320）；捲動 10 屏後仍 ≤ 60。

**風險**：改資訊架構會影響 A1 / B7 範圍，需主代理協調 ownership。

---

### 【P2-3】頂欄 8 個按鈕、3 個純 emoji；mobile 按鈕寬 29–39 px（< 44 px）

**觀察證據**

| viewport | nav 按鈕 | 尺寸 |
|---|---|---|
| desktop | 8 個（`📜 編年史`、`🔍 搜尋`、`🔗`、`⬇`、`🌙`、`?`、`關於`、`面板`） | 高度全部 **31 px**（< 44）；`⬇` 38px、`?` 38px |
| mobile | 同上 8 個 | 寬 **29–39 px**、高 76 px（**文字直排**） |

- 3 個按鈕係**純 emoji 無文字標籤**（`🔗` / `⬇` / `?`），只有 `title` 屬性。
- Mobile 標題 `《病港》互動地圖` 斷成 **4 行**（《病港》／互動／地圖）。
- Mobile tap target fail 統計（`visual-probe`）：`nav-btn` 8 個全部 fail 44×44；`map-ctrl` 3 個 30×30 fail；`ch-pill` 198 個 30×24 fail；`legend-lang-btn` 31×16 fail；`chr-toggle` 1320 個 22×15 fail。

**Root cause**：頂欄係 `display:flex` 無響應式重排策略，只有 `@media (max-width:639px)` 縮 padding / font-size（`main.css:1096-1104`），令按鈕被壓到文字直排。

**影響**：spec §0.3「44×44px target」FAIL（交 A7）。

**相關檔案**：`src/app.ts`（82-99 nav HTML）、`src/styles/main.css`（1096-1104、1608-1621）

**修正方案**：mobile 改為「主要動作（搜尋 / 編年史）+ overflow menu」；emoji-only 按鈕必須有可見文字或 `aria-label` + tooltip；所有 target ≥ 44×44。

**驗收方法**：mobile 390×844 下，所有 `button/a` 嘅 `getBoundingClientRect()` 寬高 **≥ 44**（現 8 nav + 3 map-ctrl + 198 ch-pill + 1320 chr-toggle fail）。

**風險**：低（但改動數量多，交 A7/B8）。

---

### 【P2-4】Max zoom 冇 disabled 狀態、冇視覺提示

**觀察證據**

- `SvgMap.ts` `MAX_SCALE = 35`，最窄 viewBox `0.7/35 = 0.02°`，到達上限需 **14 次**點擊，之後完全無反應。
- 實測 max zoom：`{ "zoomInDisabled": false, "zoomInAria": null }` → `#map-zoom-in` **冇 `disabled`、冇 `aria-disabled`**。
- 截圖 `dark-desktop-zoom-zoommax.png`：`#map-zoom-in` 呈青色（hover/active 樣式）但仍然可點。

**Root cause**：`zoomBy()` 冇 clamp 通知 UI；按鈕狀態冇同 viewBox 同步。

**影響**：spec §0.3「每個讀者在兩次主要互動內完成…」間接受損（使用者重複點無反應按鈕）；亦係無障礙問題（按鈕冇狀態）。

**相關檔案**：`src/components/SvgMap.ts`（195、604-614、`zoomBy`）

**修正方案**：`applyViewBox()` 內同步 `zoomIn.disabled = atMax`、`zoomOut.disabled = atMin`；到達上限時顯示短暫提示（唔用 modal）。

**驗收方法**：max zoom 後 `document.querySelector('#map-zoom-in').disabled === true`。

**風險**：低。

---

### 【P2-5】Light 主題漏覆蓋：zone badge 深色圓盤硬寫喺 TS

**觀察證據**

- `SvgMap.ts:1276`：`bcircle.setAttribute("fill", "rgba(8, 13, 20, 0.82)")` —— **硬寫深色**。
- 同一函式 `SvgMap.ts:1318`：`label.setAttribute("stroke", "rgba(8, 13, 20, 0.9)")` —— 亦係硬寫深色，**但** `main.css:1186-1188` 有 `[data-theme="light"] .zone-label { stroke: rgba(244,241,234,0.9) }` 覆蓋（CSS 覆蓋 SVG presentation attribute）。
- 實測 light 主題下：

```
{ "badgeFill": "rgba(8, 13, 20, 0.82)",   ← 仍然係深色（漏覆蓋）
  "areaFill": "rgb(47, 214, 168)",
  "areaStroke": "rgb(92, 240, 196)",
  "labelStroke": "rgba(244, 241, 234, 0.9)" }  ← 已覆蓋
```

   → 同一個視覺單元（zone badge）一半跟主題、一半唔跟，係「後加覆寫」式主題管理嘅直接後果。

**Root cause**：同 P1-3（TS inline 顏色繞過 token）。

**影響**：light 主題下 zone badge 係深色圓盤疊喺淺色地圖上，與 label 描邊邏輯相反 → 視覺不一致；而且 `outpost`（16 個 zone）用紫色，配深色圓盤可讀性未經驗證。

**相關檔案**：`src/components/SvgMap.ts`（1274-1279、1318）、`src/styles/main.css`（1180-1188）

**修正方案**：`bcircle` / glyph / label 全部改用 CSS class + token，刪除 TS inline 色值（同 P1-3 一併處理）。

**驗收方法**：`grep -n 'setAttribute("fill", "rgba\|setAttribute("stroke", "rgba' src/components/SvgMap.ts` → 期望 0（除 `none`）。

**風險**：低。

---

### 【P2-6】死碼：`zoneById` 建立後從未使用

**觀察證據**

```bash
grep -n "zoneById" src/components/SvgMap.ts
# 1195:    const zoneById = new Map<...>();
# 1196:    for (const z of this.data.zones.features) zoneById.set(z.properties.id, z);
# → 之後 0 次引用
```

**Root cause**：zone tooltip / lookup 功能未完成。

**影響**：極低（但係 P1-6「zone 互動層未完成」嘅佐證）。

**相關檔案**：`src/components/SvgMap.ts:1195-1196`

**修正方案**：刪除，或完成佢本來嘅用途（zone tooltip 需要 id → feature 查詢）。

**驗收方法**：`grep -c zoneById src/components/SvgMap.ts` → 0 或 ≥ 3（有實際使用）。

**風險**：無。

---

## 修改檔案

**無。**

本審計為只讀審計，`src/**`、`data/**`、`public/**`、`tests/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`scripts/**`、`.gitignore` **全部未改動**，亦**冇執行任何 git 寫操作**。

新增檔案（全部落喺允許範圍）：

| 檔案 | 用途 |
|---|---|
| `docs/audits/visual-motion-audit.md` | 本報告 |
| `artifacts/audit-A2/theme-capture.mjs` | dark/light × desktop/tablet/mobile 截圖 + 視覺審計 |
| `artifacts/audit-A2/theme-audit.json` | 上者輸出（色彩分佈 / 對比 / 動效 / tap target / glass） |
| `artifacts/audit-A2/visual-probe.mjs` / `visual-probe.json` | pseudo 動效、圖層計數、對比分佈、tap target 分佈 |
| `artifacts/audit-A2/zone-legend-probe.mjs` | zone 尺寸 / 點擊可達性 / legend swatch 幾何 |
| `artifacts/audit-A2/hit-test-probe.mjs` | `elementFromPoint` hit stack 與 canvas pointer-events |
| `artifacts/audit-A2/selected-zone-probe.mjs` | 選中 zone 前後 viewBox / soft-focus / URL |
| `artifacts/audit-A2/dead-css-probe.mjs` / `dead-css.json` | class/id live vs dead 判定 |
| `artifacts/audit-A2/css-dead-blocks.mjs` / `css-dead-blocks.json` | 區塊級 dead CSS 行數量化 |
| `artifacts/audit-A2/palette-measure.mjs` / `palette-measure.json` | canvas 像素色彩 / 亮度 / 色相量度 |
| `artifacts/audit-A2/chronicle-probe.mjs` | 卡片堆疊 / eager render 量度 |
| `artifacts/audit-A2/zone-visual-capture.mjs` | zone 可見 / selected / chapter / search / mobile dossier 截圖 |
| `artifacts/audit-A2/screenshots/*.png` | 26 張截圖（見下） |

---

## 沒有修改但相關的檔案

| 檔案 | 行數 | 相關發現 |
|---|---|---|
| `src/styles/main.css` | 2047 | P0-1、P0-3、P0-4、P0-5、P1-1、P1-2、P1-3、P1-4、P1-5、P1-7、P2-1、P2-3、P2-5 |
| `src/styles/hud.css` | 785 | P1-1、P1-2、P1-3、P1-4、P1-5、P2-5 |
| `src/styles/timeline.css` | 430 | P1-2（幾乎全檔死碼）、P1-3（12 個未定義 token） |
| `src/components/SvgMap.ts` | 1646 | P0-2、P0-3、P1-4、P1-5、P1-6、P2-4、P2-5、P2-6 |
| `src/map/VectorBasemap.ts` | 935 | P0-1（`PALETTE_DARK` 162-194、`PALETTE_LIGHT` 196-228）、P1-7（grid 182/216） |
| `src/app.ts` | 441 | P0-4（workspace 結構）、P1-6（`syncHash`）、P2-3（nav HTML） |
| `src/theme.ts` | 89 | P0-1（預設主題）、P1-3（`basemap-theme-change` 橋樑） |
| `src/router.ts` | 42 | P1-6（URL 契約只有 `ch` / `loc`） |
| `src/components/ChronicleView.ts` | 433 | P2-2（1320 卡片 eager render） |
| `src/components/ChapterStrip.ts` | 88 | P0-5（`ch-pill` 4.22:1）、P2-3（30×24 px） |
| `src/components/ZoneDossier.ts` | 192 | P0-4（mobile 溢出） |
| `src/main.ts` | 95 | P1-1（重複 import hud.css） |
| `src/types/dataset.ts` | 360 | P0-3（zone 缺 `display_style` 型別） |
| `data/public/zones.geojson` | 311 KB | P0-2（48 polygon、`radius_m` 220–800 m）、P0-3（`kind` 只有 3 值、冇 `display_style`） |
| `data/public/events.geojson` | 1.74 MB | P0-2（1796 event marker 遮蓋 zone） |
| `index.html` | — | 字體 / meta（未發現視覺問題） |

---

## 驗證命令與結果

### 已執行命令（全部實測）

```bash
# 1. CSS / TS 規模
wc -l src/styles/main.css src/styles/hud.css src/styles/timeline.css
# → 2047 / 785 / 430，合計 3262

find src -name '*.ts' | xargs cat | wc -l
# → 5738（CSS:TS = 3262:5738 = 56.9%；CSS 佔前端碼 9000 行嘅 36.2%）
# ⚠️ 與 baseline-findings.md 嘅「7916 行」不符：實測 src TS 為 5738 行，已以實測為準

# 2. 顏色 / token
for f in src/styles/*.css; do
  echo "$f hex=$(grep -oE '#[0-9a-fA-F]{3,8}\b' $f | wc -l) \
  rgb=$(grep -oE 'rgba?\(' $f | wc -l) \
  hsl=$(grep -oE 'hsla?\(' $f | wc -l) \
  var=$(grep -oE 'var\(--' $f | wc -l)"; done
# → main: hex=94 rgb=53 hsl=0 var=427
# → hud:  hex=23 rgb=92 hsl=0 var=142
# → tline:hex=55 rgb=12 hsl=0 var=54
# → 合計 hex=172 rgb=157 hsl=0 var=623；distinct hex = 80

grep -rnoE '"#[0-9a-fA-F]{3,8}"' src --include='*.ts' | wc -l
# → 70（distinct 61，含 #e74c3c/#E74C3C 等大小寫重複）
grep -rhoE 'rgba?\([^)]*\)' src --include='*.ts' | wc -l
# → 32
# → TS 硬寫顏色合計 102；加 CSS 329 = 431 個 literal

# 3. 未定義 token 引用
comm -23 <(grep -rhoE 'var\(--[a-z0-9-]+' src/styles/ | sed 's/var(//' | sort -u) \
         <(grep -rhoE '^\s*--[a-z0-9-]+\s*:' src/styles/ | tr -d ' :' | sort -u)
# → --bg-deep --chip-color --color-accent --color-border --color-danger
#   --color-primary --color-secondary --color-success --color-surface
#   --color-text --color-text-muted --fg      （共 12 個）

# 4. Motion
grep -rn '@keyframes' src/styles/ | wc -l          # → 11
grep -rcE '^\s*animation' src/styles/*.css         # → main 8 + hud 12 = 20 條宣告
grep -rc 'transition' src/styles/*.css             # → 52
grep -rn 'prefers-reduced-motion' src/ | wc -l     # → CSS 3 處（+2 處註解提及）
grep -rn 'prefers-reduced-motion' src --include='*.ts' | wc -l   # → 0
grep -rn 'transition: all' src/styles/*.css | wc -l             # → 6
grep -rhoE '[0-9]+ms' src/styles/*.css | sort -u | wc -l        # → 19 個 distinct duration

# 5b. 其他硬寫值（token 化率）
grep -rhoE 'font-size:[ ]*[0-9.]+px' src/styles/*.css | wc -l       # → 93（17 個 distinct 值）
grep -rhoE 'font-size:[ ]*var\(--fs' src/styles/*.css | wc -l       # → 24
grep -rhoE 'padding:[ ]*[0-9]' src/styles/*.css | wc -l             # → 100
grep -rhoE 'var\(--sp-[0-9]' src/styles/*.css | wc -l               # → 48
grep -rhoE 'border-radius:[ ]*[0-9]' src/styles/*.css | wc -l       # → 41
grep -rhoE 'var\(--r-' src/styles/*.css | wc -l                     # → 16
grep -rhoE 'box-shadow:[ ]*[^v]' src/styles/*.css | wc -l           # → 32
grep -rhoE 'z-index:[ ]*[-0-9]+' src/styles/*.css | sort -u | wc -l # → 11

# 5. 重複 CSS
diff <(sed -n '32,560p' src/styles/hud.css) <(sed -n '1521,2047p' src/styles/main.css) | wc -l
# → 132 行差異（527 行 vs 529 行，差異全部係排版／註解）
diff <(sed -n '584,679p' src/styles/hud.css) <(sed -n '690,785p' src/styles/hud.css)
# → 無輸出（完全相同，96 行）
grep -c 'styles/hud.css' src/main.ts               # → 2（重複 import）

# 6. 執行審計腳本
node artifacts/audit-A2/theme-capture.mjs
node artifacts/audit-A2/visual-probe.mjs
node artifacts/audit-A2/dead-css-probe.mjs
node artifacts/audit-A2/css-dead-blocks.mjs
node artifacts/audit-A2/palette-measure.mjs
node artifacts/audit-A2/zone-legend-probe.mjs
node artifacts/audit-A2/hit-test-probe.mjs
node artifacts/audit-A2/selected-zone-probe.mjs
node artifacts/audit-A2/chronicle-probe.mjs
node artifacts/audit-A2/zone-visual-capture.mjs
```

### 關鍵輸出

```
✓ dark / desktop — applied=dark anim=2 trans=19 contrastFail=2809/7085
✓ dark / tablet  — applied=dark anim=2 trans=20 contrastFail=2809/7086
✓ dark / mobile  — applied=dark anim=2 trans=20 contrastFail=2808/7084
✓ light / desktop — applied=light anim=2 trans=19 contrastFail=2728/7085
✓ light / tablet  — applied=light anim=2 trans=20 contrastFail=2728/7086
✓ light / mobile  — applied=light anim=2 trans=20 contrastFail=2726/7084
✓ dark / desktop reduced-motion — anim=2（duration 全部變 1e-06s，trans 降至 8）
✓ dark / desktop zoommax — viewBox=114.13 22.37 0.02 0.01545, zones=1, markers=24, routes=0
```

```
zone: {"zoneId":"zone_d3f76d3c94","name":"大本營","cls":"zone zone-survivor",
       "rect":{"x":683,"y":600,"w":10,"h":10},
       "badgeFill":"rgba(8, 13, 20, 0.82)",
       "areaFill":"rgb(47, 214, 168)","areaStroke":"rgb(92, 240, 196)",
       "dash":"0.0055","fillOpacity":"0.10"}
after click（真實 mouse）: {"selected":0,"dossierHidden":true,"url":"#ch=1"}
after click（dispatchEvent）: {"selected":1,"dossierHidden":false,"dossierText":"🛡 倖存區 人類聚居 · 安全 大本營…（2026 字）"}
```

```
dark desktop layers: {"zones":1,"zoneAreas":1,"zonePulses":0,"zoneBadges":1,"zoneLabels":0,
                      "locationMarkers":1,"eventMarkers":11,"clusters":4,"routes":0}
pseudoAnims: [{"host":"header#topbar","pseudo":"::after","name":"hud-sweep",
               "duration":"6s","iteration":"infinite"}]
```

```
三份 CSS 總行: 3265
可對應 live 元素嘅規則行: 1274（39.0%）
冇任何 live 元素匹配嘅規則行: 1116（34.2%）
  timeline.css: live 區塊 2（8 行） / dead 區塊 56（351 行）
```

```
dark 底圖像素: 亮度<0.10 = 69.18% | 亮度>0.40 = 3.51%（暖 2.75% / 冷 0.76%）
               色相 210-220° = 81.98%、220-230° = 8.73%
light 底圖像素: 亮度>0.40 = 99.67%（暖 4.45% / 冷 95.22%）
```

---

## Screenshots / Artifacts

### 截圖（`artifacts/audit-A2/screenshots/`）

| 檔案 | 內容 |
|---|---|
| `dark-desktop.png` / `-fullpage.png` | dark 1440×900 預設（chronicle 面板） |
| `light-desktop.png` / `-fullpage.png` | light 1440×900 預設 |
| `dark-tablet.png` / `-fullpage.png` | dark 768×1024（面板 collapsed、legend 7.9%） |
| `light-tablet.png` / `-fullpage.png` | light 768×1024 |
| `dark-mobile.png` / `-fullpage.png` | dark 390×844（標題 4 行、nav 直排、legend 18.9%） |
| `light-mobile.png` / `-fullpage.png` | light 390×844 |
| `dark-desktop-reducedmotion.png` / `-fullpage.png` | `prefers-reduced-motion: reduce` 對照 |
| `dark-desktop-zoom.png` / `-fullpage.png` | zoom 16 步 |
| `dark-desktop-zoom-zoommax.png` | max zoom（viewBox 0.02°）：zone 1 / marker 24 / route 0 |
| `light-desktop-zoommax.png` | light max zoom 對照 |
| `dark-desktop-zoom-zone-visible.png` | zoom 10 步：zone polygon 138×139 px（證明向量清晰） |
| `dark-desktop-zone-selected-dossier.png` | 強制選中 zone：dossier 顯示但地圖無 fly-to、zone 不可見 |
| `light-desktop-zone-selected-dossier.png` | light 主題 zone badge 仍為深色圓盤（P2-5） |
| `dark-desktop-chapter-view.png` | chapter 視圖（story panel）—— 由 `#btn-mode` 切換（chronicle 係預設，所以 `dark-desktop.png` 就係 chronicle 視圖） |
| `dark-desktop-mode-toggle-chapter.png` | 同上（`visual-probe` 嘅 `#btn-mode` 切換結果，用作雙重確認） |
| `dark-desktop-search.png` | 搜尋 modal（50 結果） |
| `dark-desktop-zone-dossier.png` | zone dossier（dispatchEvent 路徑） |
| `dark-mobile-zone-dossier.png` | **mobile dossier 溢出 163 px，文字被切**（P0-4 關鍵證據） |

### 數據 artifact

| 檔案 | 內容 |
|---|---|
| `theme-audit.json`（457 KB） | 8 個 run：色彩分佈、對比、動效清單、字級直方圖、glass、tap target、token 實際值 |
| `visual-probe.json` | pseudo 動效、圖層計數、對比 failByClass、tap target byClass、legend swatch、theme toggle 核實 |
| `dead-css.json` | 203 class / 43 id token 嘅 live/dead 判定（chronicle + chapter 兩視圖） |
| `css-dead-blocks.json` | 區塊級 dead CSS 行數（逐檔） |
| `palette-measure.json` | canvas 像素飽和度 / 色相 / 亮度直方圖（dark / light） |

---

## 風險、衝突、限制

### 方法論限制（必須明示）

1. **`dead-css-probe` 會誤判條件性 class。** 我只測「預設 chronicle 視圖」同「chapter 視圖」兩個狀態，**冇測** modal 開啟、zone 選中、search 展開、hover 等狀態。所以：
   - 「32 個真死碼」係**候選清單**，唔係最終判決。
   - `zd-*`（64 個 hud.css dead 區塊）**唔係死碼**，而係「因為 P0-2 而不可達」—— 修好 P0-2 之後佢哋會變 live。
   - 刪 CSS 之前必須用**全狀態覆蓋**（每個可達 state 都截圖）做 pixel-diff。
2. **`contrastFail` 數字受「背景 alpha 合成」算法影響。** 我用「往上逐層合成到首個不透明祖先」。如果實際渲染有 `backdrop-filter` 或漸層背景，計算會有偏差。但主要失敗來源（`chr-ch-role` 2.19:1、`chr-loc` 3.25:1、`tagline` 1.94:1）係純色背景，誤差極小，**結論穩健**。
3. **HSL 飽和度喺極暗色下不可靠。** `palette-measure.mjs` 嘅「高飽和 50%」係 HSL 數學 artefact（深色 `s = d/(1-|2l-1|)` 分母趨近 0）。所以我改用**亮度 + 色相**做主要證據，並在報告中只引用亮度／色相數字。**唔好引用「高飽和 50%」呢個數字。**
4. **`elementFromPoint` 只係單點測試。** P0-2「zone 不可點」嘅結論係基於 1 個 zone（第 1 章唯一可見者）嘅中心點。但配合「zone 只有 10×10 px 且被 11 個 marker 覆蓋」嘅量測，結論係結構性嘅，唔係單點巧合。
5. **截圖係 headless Chromium 渲染。** 字體（`-apple-system` / `PingFang HK` / `Microsoft JhengHei`）喺 headless Linux 會 fallback，所以文字寬度／換行可能同 macOS/Windows 真實瀏覽器有差異。Mobile 標題 4 行斷行係真實問題（`main.css` 冇 `white-space` / `min-width` 處理），但精確行數可能因字體而異。

### 與 baseline-findings.md 嘅差異（以本報告實測為準）

| 項目 | baseline | A2 實測 | 說明 |
|---|---|---|---|
| `src/**/*.ts` 總行數 | 7916 | **5738** | baseline 可能計入 `tests/`；A2 只計 `src/` |
| 預設視圖 zone polygon | 「48 個完全冇 render」 | **1 個 render（10×10 px）** | 第 1 章有 1 個 zone 通過章節 filter，但螢幕上係 10 px 斑點 → 視覺上等同冇 render，兩者結論一致 |
| `load→stable` | 2.6–2.8 秒 | 未重測（A2 聚焦視覺） | 由 A8 負責 |
| mobile legend 遮蓋 | 「約 55% 寬、45% 高」 | **57% 寬、33% 高（18.9% 面積）** | A2 用 `getBoundingClientRect` 精確量度 |

### 未覆蓋範圍（交其他子代理）

| 項目 | 負責 |
|---|---|
| 對比 / focus / keyboard / ARIA 完整審計 | A7（本報告只提供 39.6% fail 嘅量化證據） |
| 縮放 pixelation / LOD asset 策略 | A4（本報告確認「向量清晰但內容稀疏」） |
| zone schema / dossier 資料完整性 | A6（本報告只審視覺語言與 schema 缺口） |
| 1320 卡片嘅效能成本 | A8 |
| 元件 / state / CSS coupling | A3 |
| 48 個 zone 座標可信度 | A5 |

### 衝突風險

0. **並行子代理正同時改動 `data/public/*`。** 審計期間（17:37 之後）實測 `data/public/` 7 個檔案（`zones.geojson`、`events.geojson`、`locations.geojson`、`routes.geojson`、`chronicle.json`、`timeline.json`、`asset-manifest.json`）嘅 mtime 有變動，`data/private/review/*` 亦有寫入 —— **呢啲唔係 A2 造成**（A2 只寫 `artifacts/audit-A2/` 同 `docs/audits/visual-motion-audit.md`）。A2 喺報告完成前已重新核實 `zones.geojson` 數值仍然一致（48 features、`kind` = `{survivor:11, nest:21, outpost:16}`、`radius_m` 220–800、`display_style` 唔存在），所以本報告嘅 zone 數字成立；但**若 B4 / A6 之後改動 zone schema，P0-2 / P0-3 嘅量化數字需重跑**。

1. **`main.css` 同時係 P1-1（要刪 527 行）同 P1-3（要改 token）嘅標的** → B1 必須一次過處理，唔可以兩個 agent 同時改同一檔（spec §4.3 file ownership map）。
2. **P0-2（zone LOD）跨越 B5（renderer）同 B6（map interaction）** → 需要主代理喺 Gate 1 明確定義 interface（`ZoneLayer` 對 `MapCamera` 嘅契約）。
3. **P0-5（升字級）同 P2-2（卡片改架構）互相依賴** → 只做其中一項會令面板爆版。必須同時做。
4. **P0-3 要求 5 類 zone，但 `zones.geojson` 只有 3 類** → 缺 `quarantine` / `contested` / `unknown` 嘅資料。**唔可以捏造**（spec §0.1-7）。UI 必須有「此類區域未有資料」空狀態。

---

## 給主代理的 integration note

### 1. 呢個唔係「調色」任務 —— 請喺 Gate 1 把以下三項定為 breaking refactor

**(a) 顏色權威收斂（5 → 1）**
現時 `--accent-*`、`--hud-*`、`--color-*`（未定義）、`PALETTE_DARK/LIGHT`、TS inline 五套並存，`--hud-cyan` 只用於 2 個元素。V2 必須由主代理指定**唯一** token 命名空間（本報告末節提供完整表），並要求：
- `src/styles/` 只有一個 token 定義檔；
- Canvas palette 由 CSS token 讀取（唔可以自己持有色值）；
- SVG 顏色用 CSS class 而唔用 `setAttribute("fill", "#…")`；
- Stylelint `color-no-hex` 成為 CI gate。

**(b) Zone 尺度策略（LOD）**
Zone 半徑 220–800 m vs 世界視圖 78 km = 300 倍差距。呢個唔可能用 CSS 修補。必須喺 Gate 1 定義 zone LOD 三層（cluster glyph / 邊界 / 完整 pattern）同 zone hit layer 契約。

**(c) Motion 契約**
19 個 duration、9 個死 keyframes、JS 動畫繞過 reduced-motion。必須定義：3 級 duration token、2 條 easing token、7 項用途白名單、單一 `src/motion.ts` 入口（CSS 同 JS 共用）。

### 2. 兩個「冇壞」嘅正面發現 —— 唔好誤刪

- **Zoom 清晰度**：max zoom（viewBox 0.02°）向量重繪，**冇 pixelation**。A4 應該將 root cause 由「放大變模糊」重新定位為「放大冇嘢睇」（與 baseline §6.3 一致）。**唔需要換 renderer。**
- **Reduced-motion CSS 層有效**：實測 duration 由 0.52s → 1e-06s。**唔需要重寫 CSS 減動效規則**，只需要（i）補 JS 層、（ii）由全局 `*` 改為目的導向。
- **Glass blur 冇過量**：最大 5.4% 面積（desktop）/ 18.9%（mobile legend），**冇違反「長時間大面積 blur」**。毋須刪 `backdrop-filter`。
- **Canvas 冇持續 rAF 迴圈**：`VectorBasemap.scheduleDraw()` 係需求驅動。**冇 GPU 空轉問題。**

### 3. Anti-pattern 對照表（spec §1.1 六項禁止）

| 禁止項 | 現況 | 證據 |
|---|---|---|
| 過量 neon | ⚠️ **部分命中**：`--hud-cyan` #38e8ff 只 2 個元素（唔算過量），但**橙路網**係唯一高亮內容（明亮像素 78% 係暖色）→ 問題係「單一高飽和色主導」而唔係「多 neon」 | `palette-measure.json` |
| 低對比小字 | ❌ **命中（嚴重）**：2809/7085 = 39.6% fail；78.4% 文字 ≤ 11 px；最差 9 px @ 2.19:1 | `theme-audit.json`、`visual-probe.json` |
| 裝飾粒子遮住地圖 | ✅ **冇命中**：noise 0 個、粒子 0 個；僅 2 個 `circle` 裝飾（`SvgMap.ts:483-484`，opacity 0.15，r 0.0005） | `grep -rin noise` = 0 |
| 長時間大面積 blur | ✅ **冇命中**：backdrop-filter 最大 5.4%（desktop）/ 18.9%（mobile legend） | `theme-audit.json` glass |
| 只有色彩分辨類別 | ❌ **命中**：legend 7 個 `dot` 全部 10×10 / radius 50% / solid，只靠 fill 色；zone 3 類只靠色相 + glyph；`outpost` 16/48 冇 legend | `zone-legend-probe.mjs` |
| 廉價 dashboard 卡片堆疊 | ❌ **命中**：1320 個 `<article>`、327×115、radius 8px、統一背景色；13681 個 `chr-*` 元素 = DOM 97% | `chronicle-probe.mjs` |

### 4. 建議嘅 A2 → Gate 1 交棒順序

1. 先讀本報告 **P0-1 / P0-2 / P0-3** —— 呢三項決定 `world-atlas-v2-visual-motion-system.md` 同 `rendering-lod-strategy.md` 嘅主體。
2. 末節〈V2 Design Token 提案〉可直接成為 `world-atlas-v2-visual-motion-system.md` 嘅附錄。
3. 末節〈V2 Zone 圖層視覺語言提案〉需同 A6（territory-dossier-audit）對齊 —— **A6 決定有冇 5 類 zone 資料，A2 只提供視覺方案**。若資料只有 3 類，UI 必須有「隔離／爭議／未知」空狀態，唔可以畫假 polygon。
4. P0-5（對比）同 P2-2（卡片架構）必須由同一 agent 處理，唔可以拆開。
5. `main.css` 嘅 ownership 要喺 Gate 1 一次過講清楚：P1-1（刪重複）、P1-2（刪死碼）、P1-3（改 token）三者改同一個檔，必須同一個 B agent。

### 5. 可直接變成 CI gate 嘅可重跑檢查（零人手）

```bash
# 對比（P0-5）
node artifacts/audit-A2/theme-capture.mjs && \
  node -e "const d=require('./artifacts/audit-A2/theme-audit.json');\
  const bad=d.filter(r=>r.audit.contrastFail>0);\
  if(bad.length){console.error('對比 fail',bad.map(r=>r.theme+'/'+r.viewport+':'+r.audit.contrastFail));process.exit(1)}"

# Zone 可達性（P0-2）
node artifacts/audit-A2/selected-zone-probe.mjs   # 斷言 viewBox 有變 + selected=1

# Dead CSS（P1-2）
node artifacts/audit-A2/css-dead-blocks.mjs       # 斷言 dead 行 ≤ 5%

# 顏色 literal（P1-3）
test $(grep -oE '#[0-9a-fA-F]{3,8}\b|\brgba?\(' src/styles/*.css | wc -l) -le 60

# Motion（P1-4 / P1-5）
test $(grep -rhoE '[0-9]+ms' src/styles/*.css | sort -u | wc -l) -le 4
test $(grep -rn 'prefers-reduced-motion' src --include='*.ts' | wc -l) -ge 1

# Mobile 溢出（P0-4）
# Playwright: expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
```

---

# 附錄 A：V2 Design Token 提案（spec §5.2）

> 命名原則：**語意命名 + 單一命名空間 `--c-*`（color）/ `--sp-*`（space）/ `--r-*`（radius）/ `--sh-*`（shadow）/ `--z-*` / `--mo-*`（motion）**。刪除 `--accent-*`、`--hud-*`、`--color-*` 三套舊命名。

## A.1 Color token

### 基礎色（5 層表面 + 4 級文字）

| Token | dark | light | 用途 | 對比要求 |
|---|---|---|---|---|
| `--c-bg-void` | `#060a10` | `#ece7dd` | 地圖容器底色、頁面底 | — |
| `--c-bg-base` | `#0b0f16` | `#f4f1ea` | app shell 底 | — |
| `--c-bg-surface` | `#121820` | `#faf8f3` | 面板 | — |
| `--c-bg-elevated` | `#1a212c` | `#ffffff` | 卡片 / 浮層 | — |
| `--c-bg-hover` | `#222b39` | `#f0ece3` | hover / 選中底 | — |
| `--c-text-primary` | `#e8eef6` | `#1f2733` | 主要文字 | ≥ 7:1 on surface |
| `--c-text-secondary` | `#a9b8cc` | `#3f4a58` | 次要文字（**最低資訊色**） | ≥ 4.5:1 on surface |
| `--c-text-muted` | `#7b8ba3` | `#5c6775` | 輔助文字 | ≥ 4.5:1 on surface |
| `--c-text-faint` | `#4a5769` | `#8a939e` | **只准裝飾／disabled，唔准承載資料** | — |

> ⚠️ 與現況差異：`--c-text-secondary` 由 `#a9b8cc` 改為需驗證 ≥ 4.5:1；`--c-text-muted` 由 `#6b7c96`（4.22:1，fail）改為 `#7b8ba3`。**每一對 (文字, 背景) 都要有 CI 斷言。**

### 語意色（4 個，各有 base / dim / glow 三階）

| Token | dark | light | 語意 |
|---|---|---|---|
| `--c-safe` / `-dim` / `-glow` | `#2fd6a8` / `rgba(47,214,168,.32)` / `rgba(47,214,168,.45)` | `#127a5c` / … | 安全 / 倖存 / 已驗證 |
| `--c-danger` / `-dim` / `-glow` | `#ff5a4d` / `rgba(255,90,77,.32)` / `rgba(255,90,77,.45)` | `#b33226` / … | 危險 / 病窩 |
| `--c-warn` / `-dim` / `-glow` | `#e8a33d` / `rgba(232,163,61,.30)` / `rgba(232,163,61,.42)` | `#8a5f14` / … | 警示 / 隔離 / 爭議 |
| `--c-info` / `-dim` / `-glow` | `#4fb0c8` / `rgba(79,176,200,.28)` / `rgba(79,176,200,.40)` | `#1b6b80` / … | 情報 / 選中 / 冷青 |

> **`--c-warn` 只准用於「需要人類注意」語意（危險 / 隔離 / 爭議 / 資料過期）。唔准做道路裝飾色。** 現時橙色路網 = 語意濫用。

### 未知 / 不確定（spec 要求誠實表達）

| Token | dark | light | 用途 |
|---|---|---|---|
| `--c-unknown` | `#5b6472` | `#98a0aa` | 未知區 / 低信心 |
| `--c-unknown-fog` | `rgba(91,100,114,.14)` | `rgba(152,160,170,.16)` | 未知區 fill |

### 線 / 玻璃

| Token | dark | light |
|---|---|---|
| `--c-line-hairline` | `rgba(120,190,220,.16)` | `rgba(40,80,110,.18)` |
| `--c-line-strong` | `rgba(120,200,235,.30)` | `rgba(40,80,110,.32)` |
| `--c-glass` | `rgba(12,18,27,.78)` | `rgba(255,255,255,.82)` |
| `--c-glass-solid` | `rgba(10,15,23,.94)` | `rgba(255,255,255,.96)` |

### Basemap palette（canvas 由呢啲 token 讀取，唔准自己持有色值）

| Token | dark | light |
|---|---|---|
| `--bm-sea-top` / `--bm-sea-bottom` | `#04080f` / `#071120` | `#c3d2e0` / `#aec1d3` |
| `--bm-land` / `--bm-land-hi` | `#1b222c` / `#28313d` | `#eef1f3` / `#f8fafb` |
| `--bm-coast` / `--bm-coast-glow` | `rgba(104,220,240,.55)` / `rgba(60,170,200,.22)` | `rgba(40,96,130,.55)` / `rgba(60,130,170,.18)` |
| `--bm-green` / `--bm-industrial` | `rgba(28,72,54,.72)` / `rgba(66,52,40,.62)` | `rgba(150,200,160,.60)` / `rgba(205,186,166,.55)` |
| `--bm-bld-1..4` | `rgba(126,168,200,.14→.40)` | `rgba(90,110,130,.16→.42)` |
| `--bm-label-1..6` | `#e8f4ff → #8aa8bc` | `#12202e → #4f6373` |
| `--bm-grid` | `rgba(70,140,180,.055)` | `rgba(40,90,130,.07)` |
| `--bm-road-1..8` | **煤灰為主**：`#8d9aa6` → `#2f3640` | `#9aa2ab` → `#c6ccd2` |
| `--bm-road-trunk` | `--c-warn`（**唯一橙**，只限主幹道） | `--c-warn` |

> 關鍵改動：道路由「8 階橙色漸層」改為「煤灰主體 + 單一琥珀主幹道」。呢個係 P0-1 嘅核心修正。

### Zone 色（5 類，配合附錄 B）

| Token | dark | 語意 |
|---|---|---|
| `--zone-survivor` / `-line` | `#2fd6a8` / `#5cf0c4` | 倖存區 |
| `--zone-nest` / `-line` | `#ff5a4d` / `#ff8a72` | 病窩 |
| `--zone-quarantine` / `-line` | `#e8c547` / `#f2da7a` | 隔離區 |
| `--zone-contested` / `-line` | `#c98adf` / `#dcb0ec` | 爭議地帶 |
| `--zone-unknown` / `-line` | `--c-unknown` / `--c-unknown` | 未知區 |

## A.2 Spacing（8 px 節奏，刪除非 8 倍數值）

| Token | 值 |
|---|---|
| `--sp-1` | 4 px |
| `--sp-2` | 8 px |
| `--sp-3` | 12 px |
| `--sp-4` | 16 px |
| `--sp-5` | 24 px |
| `--sp-6` | 32 px |
| `--sp-7` | 48 px |

> 現況已有此表（`main.css:60-66`），實測 `var(--sp-*)` 使用 **48 次**，但同時有 **100 處硬寫 `padding: <數字>`** → token 化率只約 1/3。

## A.3 Radius

| Token | 值 | 用途 |
|---|---|---|
| `--r-none` | `0` | HUD 切角面板（配合 `clip-path`） |
| `--r-sm` | 8 px | chip / pill |
| `--r-md` | 12 px | 卡片 / 面板 |
| `--r-lg` | 16 px | modal / bottom sheet |
| `--r-full` | `999px` | 圓形 marker |

> 現況 `--r-sm: 4px / --r-md: 8px / --r-lg: 12px` 只使用 **16 次**，而硬寫 `border-radius: <數字>` 有 **41 處**；spec §5.2 要求 8/12/16，現況最低值係 4px（唔喺 scale 內）。

## A.4 Shadow

| Token | dark | light |
|---|---|---|
| `--sh-low` | `0 1px 2px rgba(0,0,0,.32)` | `0 1px 2px rgba(31,39,51,.08)` |
| `--sh-med` | `0 4px 12px rgba(0,0,0,.38)` | `0 4px 12px rgba(31,39,51,.10)` |
| `--sh-high` | `0 12px 32px rgba(0,0,0,.48)` | `0 12px 32px rgba(31,39,51,.14)` |

> 現況已有，但 `box-shadow` 宣告合計 **34 處**（main 17 + hud 15 + timeline 2），其中只有 **7 處**用 `var(--shadow*)` → **32 處硬寫**。全部改為 token。
>
> 另加：`font-size` 硬寫 `Npx` 有 **93 處**（只用 24 處用 `var(--fs-*)`），共 **17 個 distinct 值**（9 / 9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 14 / 15 / 16 / 18 / 20 / 21 / 22 / 24 px）→ 即字級階梯實際上係「逐個 component 手寫」，token 形同虛設（亦係 P0-5「低對比小字」嘅直接成因）。

## A.5 Z-index（收斂為 5 級）

| Token | 值 | 用途 |
|---|---|---|
| `--z-map` | `0` | 地圖層 |
| `--z-map-overlay` | `10` | 地圖上嘅 legend / 控件 |
| `--z-panel` | `100` | 右側面板 / bottom sheet |
| `--z-modal` | `1000` | modal / search |
| `--z-toast` | `1100` | toast / 提示 |

> 現況 11 個離散值：`0, 1, 2, 60, 100, 800, 900, 1000, 1100, 1200, 1300`。**`800/900/1200/1300` 冇文檔、冇用途說明** → 收斂。

## A.6 Motion（3 級 duration + 2 條 easing）

| Token | 值 | 用途 |
|---|---|---|
| `--mo-fast` | `120ms` | hover / focus / 顏色變化 |
| `--mo-normal` | `220ms` | layer fade / panel 開合 / marker 選中 |
| `--mo-slow` | `420ms` | 地圖 cross-fade / route draw / 大範圍轉場 |
| `--mo-ease-out` | `cubic-bezier(.22,1,.36,1)` | 進場 / 出現 |
| `--mo-ease-in-out` | `cubic-bezier(.65,0,.35,1)` | 循環 / pulse |
| `--mo-reduce` | `0ms`（由 `prefers-reduced-motion` 覆蓋） | 減動效 |

> 刪除現有 19 個硬寫 duration、3 條第 3 款 bezier、7 個裸 `ease`、8 個裸 `ease-out`。
> JS 必須用同一 scale：`src/motion.ts` export `motionDuration(ms)`，`SvgMap.ANIM_DURATION_MS` 改為 `var(--mo-slow)` 讀值。

## A.7 Motion 用途白名單（**只限以下 7 種**，spec §5.2）

| # | 目的 | 實作 | duration | reduce 版本 |
|---|---|---|---|---|
| 1 | Map layer fade / cross-fade | `opacity` / `fill-opacity` transition | `--mo-slow` | 縮至 `--mo-fast` |
| 2 | Selected zone outline pulse | SVG `stroke-width` + `stroke-opacity` 循環 | `2.8s` loop | **完全停用**，改用靜態粗邊界 + pattern |
| 3 | Route drawing / focus transition | `stroke-dashoffset` transition + camera tween | `--mo-slow` | 直接跳終態 |
| 4 | Panel / bottom sheet transition | `transform: translateY/X` | `--mo-normal` | 直接跳終態（唔用位移） |
| 5 | Marker hover / selection | `r` / `stroke-width` / `opacity` | `--mo-fast` | 保留 opacity 變化 |
| 6 | Loading skeleton / data stream | `background-position` / `opacity` 循環 | `1.6s` loop | 改為靜態 skeleton |
| 7 | Danger zone low-amplitude pulse | 同心 `stroke-opacity` 呼吸（**振幅 ≤ 0.35、頻率 ≤ 0.4 Hz**） | `3.6s` loop | **完全停用**，改用靜態斜線 pattern |

**明確禁止**：
- 任何**冇喺上表**嘅 animation（包括現有 `#topbar::after` 6s 掃描線，除非重新定位為第 6 項且只喺 loading 時播放）；
- `transition: all`；
- 頻率 > 1 Hz 嘅閃爍；
- 覆蓋地圖內容區嘅粒子 / noise 動畫；
- `prefers-reduced-motion: reduce` 下仍然播放嘅位移 / 縮放 / 循環動畫。

---

# 附錄 B：V2 Zone 圖層視覺語言提案（spec §5.4）

> **全部用 SVG `<pattern>` / vector path / CSS `repeating-linear-gradient`，任何 zoom 保持清晰。唔用 raster、唔用模糊、唔用粒子。**
> 每個類型同時具備 **fill 色 + pattern + 邊界線型 + icon** 四個維度，移除任何單一維度後仍可分辨（灰度可辨 + 色盲可辨）。

## B.0 Pattern 定義（共用 `<defs>`）

```html
<defs>
  <!-- 穩定：細點陣，密度固定於螢幕像素 -->
  <pattern id="pat-stable" patternUnits="userSpaceOnUse" width="6" height="6"
           patternTransform="scale(var(--pat-scale))">
    <rect width="6" height="6" fill="var(--zone-survivor-fill)"/>
    <circle cx="3" cy="3" r="1" fill="var(--zone-survivor)"/>
  </pattern>

  <!-- 危險：45° 斜線，線距 5px -->
  <pattern id="pat-hatch" patternUnits="userSpaceOnUse" width="6" height="6"
           patternTransform="rotate(45) scale(var(--pat-scale))">
    <rect width="6" height="6" fill="var(--zone-nest-fill)"/>
    <rect width="1.2" height="6" fill="var(--zone-nest)"/>
  </pattern>

  <!-- 隔離：雙線柵欄（垂直 + 短橫） -->
  <pattern id="pat-gate" patternUnits="userSpaceOnUse" width="8" height="8"
           patternTransform="scale(var(--pat-scale))">
    <rect width="8" height="8" fill="var(--zone-quarantine-fill)"/>
    <rect width="1" height="8" x="1" fill="var(--zone-quarantine)"/>
    <rect width="1" height="8" x="6" fill="var(--zone-quarantine)"/>
    <rect width="8" height="1" y="4" fill="var(--zone-quarantine)"/>
  </pattern>

  <!-- 爭議：雙色 contour（兩組反向斜線） -->
  <pattern id="pat-contour" patternUnits="userSpaceOnUse" width="10" height="10"
           patternTransform="scale(var(--pat-scale))">
    <rect width="10" height="10" fill="var(--zone-contested-fill)"/>
    <path d="M0 10 L10 0" stroke="var(--zone-contested)" stroke-width="0.9" fill="none"/>
    <path d="M0 0 L10 10" stroke="var(--c-unknown)" stroke-width="0.9" fill="none" opacity="0.55"/>
  </pattern>

  <!-- 未知：低對比 fog + 稀疏問號 -->
  <pattern id="pat-fog" patternUnits="userSpaceOnUse" width="14" height="14"
           patternTransform="scale(var(--pat-scale))">
    <rect width="14" height="14" fill="var(--c-unknown-fog)"/>
    <circle cx="7" cy="7" r="0.8" fill="var(--c-unknown)" opacity="0.5"/>
  </pattern>
</defs>
```

`--pat-scale` 由 JS 隨 `viewScale` 更新（`--pat-scale: 1 / viewScale`），令 pattern 密度**喺螢幕上恆定**，唔會 zoom 到變成純色或摩爾紋。呢個係「任何 zoom 保持清晰」嘅實作關鍵。

## B.1 五類完整方案

| 類型 | fill | pattern | 邊界線型 | icon | 動態 | 互動 |
|---|---|---|---|---|---|---|
| **倖存區** `survivor_zone` | `--zone-survivor` @ 0.10 | `pat-stable`（穩定點陣） | `solid` 1.4px，`--zone-survivor-line` | `shield`（現有，保留） | **穩定 beacon**：badge 靜態、無 pulse；只有 hover 時 `--mo-fast` 提亮 | hover：outline glow + tooltip（name / type / danger / 狀態）；click：dossier；選中：soft-focus 其他 + 顯示內部 landmark |
| **病窩** `infected_nest` | `--zone-nest` @ 0.12 | `pat-hatch`（45° 危險斜線） | `solid` 1.6px，`--zone-nest-line`；**輪廓加不規則擾動**（per-vertex jitter ≤ 3%，由 zone id 做 seed，**唔用 random**，保證 deterministic） | `biohazard`（現有，保留） | **低頻呼吸紅光**：`stroke-opacity` 0.35→0.70，3.6s，振幅 ≤ 0.35（spec §5.2 第 7 項）；reduce 模式**完全停用** | click：威脅特徵 / 活動模式 / 影響範圍 / 關聯事件（唔顯示政權民生欄位） |
| **隔離區** `quarantine` | `--zone-quarantine` @ 0.10 | `pat-gate`（柵欄） | `dashed` 8-4，`--zone-quarantine-line` | `gate`（新：兩柱 + 橫閘） | 無循環動畫（靜態） | click：進出限制 / 風險資料 / 關聯章節 |
| **爭議地帶** `contested` | `--zone-contested` @ 0.08 | `pat-contour`（雙色 contour） | **`broken`**：由 zone id 決定 2–3 段缺口嘅 `stroke-dasharray`（例如 `12-4-3-4-8-4`），表達「邊界唔確定」 | `split-arrow`（新：左右相反箭頭） | 無循環動畫；選中時邊界缺口以 `--mo-slow` 順序補完（一次性，表達「確認中」） | click：不確定性說明 / 相關勢力 / 兩方證據 |
| **未知區** `unknown` | `--c-unknown-fog` | `pat-fog`（低對比霧點） | `dotted` 2-4，`--c-unknown`，`stroke-opacity ≤ 0.45` | `question`（新：圓圈 + ?） | 無任何動畫（誠實表達「冇資料」） | click：**只顯示「資料未足以確認」**，唔開 dossier、唔假裝有內容（spec §0.1-7、§5.4） |

## B.2 Legend 同步要求

1. **機械化斷言**：`zones.geojson` 出現嘅每個 `kind` 值都必須有 legend 條目（現 `outpost` 16/48 缺）。
2. **Legend swatch 必須用同一個 pattern 定義**：swatch 用 `<svg>` 內嵌同一 `<pattern>`，或者 CSS `background-image` 用同一 data-URI。唔可以手畫一個近似色塊。
3. **四維度可辨性測試**（CI gate）：
   - **灰度**：截圖轉灰階後，5 類 zone 邊界仍可分辨（pattern + 線型）；
   - **色盲模擬**：deuteranopia / protanopia / tritanopia 濾鏡下仍可分辨；
   - **縮放**：Z0–Z2 / Z3–Z5 / Z6+ 三個 LOD 層，pattern 密度一致、無摩爾紋；
   - **最小尺寸**：zone 螢幕最小邊 < 24 px 時，改顯示 aggregate glyph（唔畫 pattern，避免變成色塊）。

## B.3 資料缺口處理（**唔可以捏造**）

`zones.geojson` 實測只有 `kind ∈ {survivor, nest, outpost}`，**冇** `quarantine` / `contested` / `unknown`。

- 若 B4 / A6 確認資料不存在 → UI **唔可以**畫假 polygon。Legend 仍列出 5 類，但 `quarantine` / `contested` / `unknown` 條目顯示 `（目前資料未有此類區域）`，並以 `--c-text-muted` 呈現（唔用彩色）。
- `outpost`（16 個）需要一個明確歸屬：併入 `survivor_zone` 子類（例如 `survivor_zone / outpost` 二級樣式），或者獨立成第 6 類並補 legend。**由 A6 / Gate 1 決定，A2 只要求「唔可以有 zone 冇 legend」。**
- `display_style` 由 data 提供（spec §2.4 schema），TS 只做 fallback；若 data 冇提供，TS fallback **必須**用 CSS token 而唔係硬寫 hex。

## B.4 驗收方法（可重跑，零人手）

```bash
# 1. 每個 kind 都有 legend
node -e "
const z=require('./data/public/zones.geojson');
const kinds=[...new Set(z.features.map(f=>f.properties.kind))];
console.log('zone kinds:',kinds);
"
# Playwright 斷言：kinds.every(k => legend 有對應條目)

# 2. 每個 zone 有 pattern（唔只靠色）
# Playwright: for each kind, expect(swatch).toHaveCSS('background-image', /pattern|gradient/)

# 3. 灰度可辨（B9 實作）
# 截圖 → 轉灰階 → 5 類 zone 邊界像素對比 ≥ 3:1

# 4. Zoom 清晰度
node artifacts/audit-A2/zone-visual-capture.mjs
# 斷言：Z0–Z2 / Z3–Z5 / Z6+ 三層 pattern 密度差異 ≤ 15%（無摩爾紋）

# 5. 未知區誠實性
# Playwright: click .zone-unknown → 只出現「資料未足以確認」，冇 dossier section
```

---

# 附錄 C：本報告檔案清單

```
docs/audits/visual-motion-audit.md              ← 本檔
artifacts/audit-A2/theme-capture.mjs
artifacts/audit-A2/theme-audit.json             （457 KB，8 個 run）
artifacts/audit-A2/visual-probe.mjs
artifacts/audit-A2/visual-probe.json
artifacts/audit-A2/zone-legend-probe.mjs
artifacts/audit-A2/hit-test-probe.mjs
artifacts/audit-A2/selected-zone-probe.mjs
artifacts/audit-A2/dead-css-probe.mjs
artifacts/audit-A2/dead-css.json
artifacts/audit-A2/css-dead-blocks.mjs
artifacts/audit-A2/css-dead-blocks.json
artifacts/audit-A2/palette-measure.mjs
artifacts/audit-A2/palette-measure.json
artifacts/audit-A2/chronicle-probe.mjs
artifacts/audit-A2/zone-visual-capture.mjs
artifacts/audit-A2/screenshots/                 （26 張 PNG）
```

**全部重跑方式**（由專案根目錄，preview server 必須喺 `http://localhost:5180/`）：

```bash
node artifacts/audit-A2/theme-capture.mjs
node artifacts/audit-A2/visual-probe.mjs
node artifacts/audit-A2/zone-legend-probe.mjs
node artifacts/audit-A2/hit-test-probe.mjs
node artifacts/audit-A2/selected-zone-probe.mjs
node artifacts/audit-A2/dead-css-probe.mjs
node artifacts/audit-A2/css-dead-blocks.mjs
node artifacts/audit-A2/palette-measure.mjs
node artifacts/audit-A2/chronicle-probe.mjs
node artifacts/audit-A2/zone-visual-capture.mjs
```

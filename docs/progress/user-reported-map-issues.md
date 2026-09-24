# 用戶報告地圖問題（2026-09-24）—— 診斷與處理

> 來源：用戶實際使用後報告 4 個問題。
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部診斷程式化、可重跑。

---

## 0. 一句話總結

| # | 問題 | 狀態 | 交付 |
|---|---|---|---|
| 1 | **移動地圖一段時間後 out of memory** | ✅ **根因已搵到並修好**（圖磚失敗重試風暴） | `probe-tile-404.mjs` |
| 2 | **移動時倖存區光圈漂移** | ⚠️ **靜止時偏移 ≤ 0.35 px**（唔係靜態錯位）→ 需更多資訊 | `probe-pulse-drift.mjs` |
| 3 | **標記座標錯**（寶林倖存區、皇室區…） | ✅ **新增自動審計**，捉到 **14 locations + 6 zones** 文字↔座標矛盾（含用戶講嘅個案） | `audit_coordinate_text_consistency.py` |
| 4 | **第一章標記去咗旺角** | ✅ **真兇已定位**：地點「香港」（全境級）被畫成**點標記**，落喺九龍 | 同 #3 |

---

## 1. #1 移動地圖後 out of memory —— ✅ **根因：圖磚失敗重試風暴**

> 用戶補充：打開嘅係**主代理起嘅 `vite preview`**（即 build 好嘅 `dist/`），
> 錯誤頁係 **browser 自己嘅 out-of-memory 頁**。即係真·renderer OOM，
> 唔係 dev server 造成。

### 1.1 根因（實測）

圖磚格網係 `10×14 = 140` 格，但 `public/assets/vector/tiles/` 只有
**89 個檔案** —— 其餘 **51 格**全部喺 bbox 上下邊緣（`r00` 成行、
`r09` 成行、左右邊緣），即係**陸地之外，生成器冇出**。

而 `ensureTiles()` 嘅失敗路徑係：

```ts
if (this.tilePoi.has(k) || this.tilePending.has(k)) continue;   // ← 只查兩個集合
…
.catch(() => { /* 單一圖磚失敗唔應該令成個底圖消失 */ })          // ← 吞咗
.finally(() => this.tilePending.delete(k));                      // ← 清走 pending
```

→ 失敗嘅格**兩個集合都唔在** → **下一個 `setView()` 會再試**。
而 `setView()` 係**每個 pan frame** 都行一次（`applyViewBox()` → `syncBasemapView()`）。

`clampView()` 令視窗**好容易停喺 bbox 邊緣**（用戶拖到盡就會），
所以邊緣缺失格會**長期留在視窗內 → 每 frame 重試**。

### 1.2 量度（新增 `artifacts/phase3-resume/probe-tile-404.mjs`）

⚠️ **探測本身有個陷阱**：`vite preview` 有 **SPA fallback** —— 缺失檔案會
回 **`index.html` 但狀態 200**（唔係 404）！所以第一版用
`responseStatus` 計「失敗」係 **0**（假陰性）。改為用 `fetch` 包裝數
「**回非 JSON 嘅圖磚請求**」才睇到真相。

向北推 6 次（每次 40 下方向鍵）：

| 狀態 | 資源條目 | **非 JSON 圖磚（累計）** | fetch 次數 |
|---|---|---|---|
| 0（起始） | 4 | 0 | 4 |
| 4 | 10 | 0 | 10 |
| 5 | 26 | **16** | 26 |
| 6 | 36 | **26** | 36 |

**新增嘅 fetch 全部係失敗** → 確認重試風暴。

### 1.3 修法（`VectorBasemap`）

| # | 改動 |
|---|---|
| 1 | 新增 `private readonly tileMissing = new Set<string>()`（**負快取**） |
| 2 | `ensureTiles()` 檢查加 `\|\| this.tileMissing.has(k)` |
| 3 | `.catch()` 改為 `this.tileMissing.add(k)`（唔再靜靜吞） |
| 4 | **層級改變**時 `this.tileMissing.clear()`（換層值得重試一次） |

### 1.4 驗證（同一探測、同一協定）

| | 修復前 | 修復後 |
|---|---|---|
| 非 JSON 圖磚（累計） | 0 → **26** | 0 → **2**（第 5 步之後**唔再增長**） |
| fetch 次數 | 4 → 36 | 4 → 12 |
| 資源條目 | 4 → 36 | 4 → 12 |

**−92%**，而且**穩定**（剩下 2 個係兩個唔同缺失格嘅第一次嘗試 —— 正確行為）。

### 1.5 為何之前三次探測都睇唔到（方法論教訓）

1. **探測場景唔對**：之前全部喺**地圖中央**（將軍澳）縮放，視窗冇掂到
   bbox 邊緣 → 缺失格從來冇入 view → 冇 404。
2. **`vite preview` 嘅 SPA fallback 令失敗「睇落成功」**（狀態 200 + HTML）。
3. **儀器唔對**：`performance.memory` 只計 JS heap，**睇唔到**
   `Path2D`／canvas 嘅原生記憶體。今次改用「**失敗請求計數**」—— 一個
   唔受渲染模式影響嘅指標，才捉得到。

### 1.6 順帶修好嘅其他記憶體風險（保留）

| 改動 | 為何 |
|---|---|
| `labelWidths` 加快取上限（12,000） | 唯一無上限嘅快取（key 係 `rank\|文字`，理論上 ~20,000 entry） |
| `syncBasemapView()` 尺寸**整數化** + 快取 | 原本每個 pan frame 一次 `getBoundingClientRect()`（強制 layout）；而且 `getBoundingClientRect()` 回分數 px，一旦抖動就會令 `canvas.width = …` **每幀重新分配 backing store**（真瀏覽器係 GPU 記憶體） |

### 1.7 建議嘅後續（唔係今次做）

**由 `build_vector_basemap.py` 喺 manifest 直接列出**「邊啲格有檔案」
（tile index）。咁前端就可以**完全唔請求**缺失格，唔需要靠負快取。
今次嘅負快取已經解決重試風暴，但「請求一次先知道冇」仍然係浪費。

---

## 2. #2 移動時光圈漂移

### 2.1 量測（新增 `artifacts/phase3-resume/probe-pulse-drift.mjs`）

full LOD（viewW 0.0105、21 個 `.zone-pulse`）之下，量度每個 pulse 同
對應 `.zone-area` 嘅**螢幕 bounding rect 中心差**：

```
=== ① 靜止（animation 運行中）===
zone_51bf7d8190  dx=0      dy=0.09    （pulse 寬 949 / area 寬 910）
zone_8529def03c  dx=0.35   dy=0.09
zone_08f9447a47  dx=-0.35  dy=-0.09
zone_ec954725f8  dx=0      dy=-0.09
zone_a5768496df  dx=0      dy=0
```

**結論：靜止時偏移 ≤ 0.35 px**（係 `scale()` 動畫本身造成嘅正常差異，唔係錯位）。
即係用戶見到嘅「漂移」係一個**動態**現象（只喺移動期間出現），唔係靜態座標錯。

### 2.2 最可能嘅機制（未證實）

`.zone-pulse` 用 `transform-box: fill-box` + `will-change: opacity, transform`。
`will-change: transform` 會令元素**被提升成 composited layer**，而 SVG 元素
嘅合成層位置要跟住 `viewBox` 改變重新計算 —— Chromium 對
「composited SVG element + `transform-box: fill-box`」嘅位置同步係已知
唔夠即時（會落後 1 個 frame）。連續 pan 期間就係**持續落後** → 睇落「漂移」。

⚠️ **但係**：`suspendZonePulses()` 會喺手勢期間將 `.zone-pulse` 設
`display="none"`（220 ms 後才恢復），所以理論上 pan 期間應該見唔到光圈。
**呢點同用戶報告矛盾** —— 需要確認：

1. 「移動」係指**拖曳平移**、**滾輪縮放**、抑或**撳縮放掣**？
2. 光圈係**跟唔上地圖**（落後），抑或**同底圖分離**（一個郁一個唔郁）？
3. 係唔係喺**停止移動之後**先見到光圈「跳」返正確位置？

### 2.3 已排除

- 唔係靜態座標錯（§2.1 量到 ≤0.35 px）
- 唔係「pulse 冇跟 zone 更新」（兩者都喺同一個 `<g>` 之內）

---

## 3. #3 標記座標錯（寶林倖存區、皇室區…）

### 3.1 用戶講嘅個案：確認正確

**`皇室區`** 嘅 dossier（`zone-dossiers.json`）原文：

> 「位於**寶琳地鐵站上蓋**及商場的貴族專屬區域…**皇宮即新都城二期商場**」

而 `zones.geojson` 嘅幾何中心係 **`(114.23686, 22.33018)`** —— 距離真正嘅
新都城二期（`114.2467, 22.3186`）**2,368 m**（山邊，唔係寶琳站上蓋）。

**`艾寶琳倖存區`** 同樣：dossier 講「皇室與貴族居於**寶琳地鐵站上蓋**的
皇室區，皇宮設於**新都城二期商場**」→ 幾何中心距離 **1,938 m**。

**`寶琳倖存區`**：dossier 只講「位於**將軍澳北面**的超大型倖存區」——
冇點名現實地標，所以**文字證據不足以自動錨定**（要靠同區其他地點推導）。

### 3.2 新增自動審計（`scripts/audit_coordinate_text_consistency.py`）

將「故事文字有冇描述現實地標」變成**可重跑嘅一致性檢查**：

1. 由 `data/private/cache/osm-hk.json` 建**地標名 → 座標**索引
   （只收可以錨定位置嘅類別：地鐵站／商場／醫院／學校／公園／屋邨／
   酒店／歷史建築…）。
2. ⚠️ **地區名唔可以做錨** —— 用**資料驅動**規則：一個名如果係 ≥5 個
   其他錨名嘅子字串（例如「將軍澳」出現喺「將軍澳商場」「將軍澳墳場」
   「將軍澳游泳池」…），佢就係地區／泛稱。
   （第一版冇呢條規則 → 30+ 個 `將軍澳*` 地點全部誤報。）
3. 掃 location `description` / zone dossier `overview` → 計距離 → 判定
   `PASS` / `MISMATCH` / `AMBIGUOUS` / `NO_TEXT`。

### 3.3 審計結果（可重跑）

```
=== Locations ===   14 MISMATCH ｜ 665 NO_TEXT ｜ 25 PASS
=== Zones ===        6 MISMATCH ｜  34 NO_TEXT ｜  8 PASS
```

**Zones（全部 6 個）**

| zone | 距離 | 文字提到嘅地標 |
|---|---|---|
| 將軍澳商場 | 3,298 m | 將軍澳廣場 |
| 不法者監獄 | 2,724 m | 仁興工業大廈 |
| **皇室區** | **2,368 m** | **新都城二期** |
| **艾寶琳倖存區** | **1,938 m** | **新都城二期** |
| 死亡之路 | 1,422 m | 寶康公園 |
| popcorn 商場 | 958 m | 將軍澳中心 |

**Locations（前 10）**

| location | 距離 | 地標 | 章 | coord_source |
|---|---|---|---|---|
| 廣場燒烤區 | 8,560 m | 燒烤區 | 156 | legacy |
| 邱子文學院 | 1,733 m | 寶康公園 | 110 | cross_chapter_evidence |
| 社區教會堂 | 1,588 m | 彩明苑 | 94 | cross_chapter_evidence |
| 坑口38號街 | 1,224 m | 寶康公園 | 180 | legacy |
| 製毒工場 | 940 m | 慧安園 | 132 | legacy |
| **新都城二期** | **674 m** | **新都城二期** | 137 | legacy |
| 新都城中心三期 | 847 m | 新都城中心三期 | 111 | legacy |
| 哈姆雷特百貨公司 | 780 m | 新都城中心一期 | 112 | legacy |
| 賴桑所在的病房 | 697 m | 新都城二期 | 138 | legacy |
| 將軍澳廣場二樓超級市場 | 516 m | 將軍澳廣場 | 75 | manual_geometry |

⚠️ **最明顯嘅一個**：location **`新都城二期` 自己**距離真正嘅新都城二期
**674 m** —— 即係「名叫某地標嘅地點，唔喺嗰個地標」。

### 3.4 建議嘅確定性修正規則（**未執行**，需你決定）

**強規則（低風險）**：當一個 feature 嘅**自己嘅名**包含**恰好一個**錨名，
而且距離 > 容差 → 自動將座標設為錨嘅座標，
`coordinate_source = "text_landmark"`、`coordinate_review_status = "auto_corrected"`。

實測**可修 7 / 14 個 locations**（含「新都城二期」自己、「將軍澳廣場二樓
超級市場」、「新都城中心三期」…）。

**唔執行嘅原因（誠實）**：
1. 改 `locations.geojson` 之後，**zones 幾何唔會自動跟** —— zones 係由成員
   地點推導（`derive_zones.py` / `merge_zone_dossiers.py`）。要一齊重跑
   管線，並重新驗證全部閘門（`validate_public_data.py`、`audit_release.py`、
   pytest 307）。
2. 「廣場燒烤區 → 燒烤區（8,560 m）」顯示強規則仍有假陽性（「燒烤區」
   唔應該做錨）—— 要再加一層泛稱過濾。
3. 呢個係**產品資料改動**（會令地圖上嘅標記移位），應該由你確認。

---

## 4. #4 第一章標記去咗旺角

### 4.1 真兇

第一章只有 4 個 location：

| 距離將軍澳 | 名 | precision | coord_source |
|---|---|---|---|
| **9.6 km** | **香港** | district | legacy |
| 1.4 km | 荒廢已久的商場 | approximate | legacy |
| 1.1 km | 主角的安全屋大廈 | approximate | legacy |
| 0.4 km | 鄰近的便利店 | fictional | legacy |

**「香港」** 嘅描述係「故事舞台位於香港，病毒爆發後第一個星期過去…」
—— 即係一個**全境級**地點，但佢有 `location_precision: "district"`，
所以**被畫成一個點標記**，而嗰個點落喺九龍（用戶睇成「旺角」）。

⚠️ 呢個係**語義錯**：全境級地點唔應該用一個點表示。

### 4.2 建議修法（**未執行**）

| 方案 | 內容 |
|---|---|
| (a) **資料** | 為全境／地區級 location 加一個 `location_precision: "region"`，並令前端**唔畫點標記**（只喺搜尋／清單出現） |
| (b) **渲染** | 前端跳過「名 == 全境地名（香港／九龍／新界）」嘅點標記 |

⚠️ 兩個都涉及 schema／渲染契約改動 → 需要你確認。

---

## 5. 重跑指令

```bash
# #3/#4：座標 × 文字一致性審計（新增）
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/audit_coordinate_text_consistency.py --json artifacts/coord-text.json

# #1：記憶體探測（自帶 preview server）
env -u http_proxy -u https_proxy node artifacts/phase3-resume/probe-memory.mjs --rounds=60

# #2：光圈位置探測
env -u http_proxy -u https_proxy node artifacts/phase3-resume/probe-pulse-drift.mjs
```

⚠️ 環境有 `http_proxy` → 跑 node 探測一定要 `env -u http_proxy -u https_proxy`。

---

## 6. 下一步（按需要你確認嘅次序）

| 優先 | 項目 | 需要 |
|---|---|---|
| 1 | **#1 OOM** | 你提供錯誤文字／開啟方式（§1.3） |
| 2 | **#2 光圈漂移** | 你確認「移動」嘅方式同現象（§2.2） |
| 3 | **#3 座標自動錨定** | 你確認可以改 `data/public/**` + 重跑 zone 推導（§3.4） |
| 4 | **#4 全境級地點唔畫點** | 你確認 schema／渲染契約改動（§4.2） |

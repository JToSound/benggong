# 用戶報告地圖問題（2026-09-24）—— 診斷與處理

> 來源：用戶實際使用後報告 4 個問題。
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部診斷程式化、可重跑。

---

## 0. 一句話總結

| # | 問題 | 狀態 | 交付 |
|---|---|---|---|
| 1 | **移動地圖一段時間後 out of memory** | ⚠️ **headless 無法重現**（3 組探測 heap 平穩）；已修 2 個可疑結構 + 加防護 | `probe-memory.mjs` |
| 2 | **移動時倖存區光圈漂移** | ⚠️ **靜止時偏移 ≤ 0.35 px**（唔係靜態錯位）→ 需更多資訊 | `probe-pulse-drift.mjs` |
| 3 | **標記座標錯**（寶林倖存區、皇室區…） | ✅ **新增自動審計**，捉到 **14 locations + 6 zones** 文字↔座標矛盾（含用戶講嘅個案） | `audit_coordinate_text_consistency.py` |
| 4 | **第一章標記去咗旺角** | ✅ **真兇已定位**：地點「香港」（全境級）被畫成**點標記**，落喺九龍 | 同 #3 |

---

## 1. #1 移動地圖後 out of memory

### 1.1 探測（新增 `artifacts/phase3-resume/probe-memory.mjs`）

持續 pan（鍵盤方向鍵，因為實測 `page.mouse` 拖曳喺呢個版面之下唔會令
viewBox 改變）+ 每 4 輪 `gc()` 之後取樣：

| 配置 | heap | DOM 節點 | tile 請求 | 結論 |
|---|---|---|---|---|
| level 1（無圖磚層） | 24.8 MB → 24.8 MB | 947 → 947 | 0 | **零增長** |
| level 2（viewW 0.030） | 22 MB → 22 MB | 920 → 920 | 4 | **零增長** |
| **full LOD（viewW 0.0105，21 個 `.zone-pulse`）** | 22 MB → 22 MB | 985 → 920 | 4 | **零增長** |

**即係：喺 headless Chromium 之下無法重現 OOM。**

### 1.2 已修（唯一搵到嘅無上限結構 + 一個每 frame 成本）

| 改動 | 為何 |
|---|---|
| **`labelWidths` 加快取上限**（`LABEL_WIDTH_CACHE_MAX = 12000`） | 呢個係**唯一無上限**嘅快取：key 係 `rank\|文字`，理論上 ~20,000 entry（11,645 圖磚 POI 名 + 7,847 全域標籤）。長 session 行過全港會逐個累積。設上限之後最壞係重新 `measureText` 一次（~0.14 ms）。 |
| **`syncBasemapView()` 尺寸快取**（`wrapSizeCache`） | 呢個方法由 `applyViewBox()` 呼叫，而 `applyViewBox()` **每個 pan frame 都行一次** → 原本**每 frame 一次強制同步 layout**（`getBoundingClientRect()`）。同 Q10 量到嘅 59 ms 同一類問題。 |

### 1.3 需要你提供嘅資訊（無法從程式碼推斷）

1. **錯誤嘅完整文字**（係 Chromium「Aw, Snap! Out of memory」頁？抑或 console 某個 `RangeError`？）
2. **你係點開個網頁**：`npm run dev`（Vite dev server）／`npm run preview`／部署咗嘅 GitHub Pages？
3. **大概幾耐之後出現**（幾秒／幾分鐘）？**係唔係每次都由新分頁開始**？
4. 當時**喺邊個縮放級**（見到倖存區光圈 = full LOD，即 viewW ≤ 0.0219）

⚠️ 有一點值得留意：`npm run dev` 嘅 HMR 會令記憶體高好多 —— 如果係用 dev
server 開，**唔代表正式版本有同樣問題**。

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

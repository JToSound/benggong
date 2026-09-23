# A5 Spatial Data Auditor —— 空間完整性審計（World Atlas V2）

> 只讀審計。全程只讀 `data/public/**` 同 `data/schemas/**`；**冇讀取 `data/private/` 任何內容**（包括原始小說、清理全文、evidence excerpt、LLM cache、`data/private/cache/osm-hk.json`）。**冇改任何 production 檔案。** 所有結論由 `artifacts/audit-A5/spatial_audit.py` 程式化產生，可重跑、確定性、零人手抽樣。

---

## 任務摘要

對《病港》公開資料集做咗一次**全量、程式化**嘅空間完整性審計，覆蓋 spec §2.2 八條自動檢查規則，並產出「不可信座標候選清單」。

**最嚴重三個發現**：

1. **Marker 塌縮（P0）**：704 個地點只有 **472 個唯一座標**；**103 個地點完全重疊**喺同一點 `[114.25343, 22.30581]`（大本營建築群），另有 9 個 ≥5 成員嘅塌縮簇，合共 **189 個地點（26.8%）** 擠喺 10 個像素點。地圖上完全分唔開。
2. **事件座標大面積無證據（P0）**：**1385 / 1796 事件（77.1%）** 掛喺 `approximate` 或 `fictional` 地點上；其中 **120 個 `approximate` 地點完全冇 `position_source` 亦冇 `inferred_from`**（佔全體 17.0%）—— 即「冇證據但聲稱 approximate」。
3. **Schema 落差（P0）**：spec §2.2 要求嘅 `coordinate_confidence` / `coordinate_source` / `coordinate_review_status` / `spatial_evidence_count` **喺四個 layer 全部唔存在**；events **冇 `zone_id`**。即係 pipeline 目前**無法**誠實表達「座標精度／來源／覆核狀態」。

**候選清單總量**：P0 = **3 類（涉及 1,505 個 feature-instance）**；P1 = **4 類（涉及 302 個 instance）**；P2 = **7 類**。

---

## 假設與證據

### 讀取範圍（全部實測）

| 檔案 | 實測 |
|---|---|
| `data/public/locations.geojson` | 704 Point |
| `data/public/events.geojson` | 1796 Point |
| `data/public/routes.geojson` | 42 LineString（README 講 51，實測 42 —— 與 baseline §5 一致） |
| `data/public/zones.geojson` | 48 Polygon |
| `data/public/timeline.json` | 1796 |
| `data/public/chronicle.json` | 1320 entries（含 `flashback` 旗標） |
| `data/public/map-config.json` | `renderer: svg`（已過時，實際係 Canvas 向量底圖） |

### 座標系統假設

- 投影：等距圓柱（equirectangular），`standard_parallel = 22.36`，同 `scripts/build_vector_basemap.py` 一致。
- 換算：`M_PER_DEG_LON = 111320·cos(22.36°)`、`M_PER_DEG_LAT = 110570`。
- base-map bbox（spec §2.2 規則 2；同 `build_vector_basemap.BBOX` 一致）：`lon 113.79–114.49, lat 22.11–22.61`。
- 故事舞台 bbox（同 `scripts/audit_location_coords.STORY_BBOX` 一致）：`lon 114.14–114.36, lat 22.22–22.36`。

### 實測座標範圍

| 圖層 | lon | lat |
|---|---|---|
| locations | 114.1694 – 114.2810 | 22.2485 – 22.3379 |
| events | 114.1694 – 114.2795 | 22.2485 – 22.3379 |
| routes（全部頂點） | 114.1694 – 114.2810 | 22.2485 – 22.3379 |
| zones（全部頂點） | 114.1721 – 114.2804 | 22.2466 – 22.3399 |

> 註：資料實際只佔約 **11 km × 10 km**（將軍澳／寶琳／坑口／調景嶺一帶），遠細過 base-map bbox。`audit_location_coords.py` 同 `anchor_fictional_locations.py` 已把原本散落全港嘅合成座標拉返故事區。呢個係「事後收窄」，唔等於原始抽取準確。

---

## 發現／改動

> **改動**：冇。本節全部係**發現**。任何候選修正都必須由 B4 以 schema + deterministic rule 執行（見「給主代理的 integration note」）。

### 0. Schema 落差表（spec §2.2 vs 實測）

spec §2.2 要求每個 location / event / route waypoint 至少有 7 個欄位。實測：

| spec 欄位 | locations | events | route waypoint | zones | 判定 |
|---|---|---|---|---|---|
| `location_precision` | ✅ 已有（`exact`/`approximate`/`district`/`fictional`） | ❌ 冇（要經 `location_id` 反查） | ❌ 冇 | ⚠️ 部分有（等價 `spatial_precision` 唔存在；有 `coords_source` 但無精度欄） | **部分有** |
| `coordinate_confidence` | ❌ 冇（只有語意 `confidence`） | ❌ 冇 | ❌ 冇（只有 waypoint `confidence`） | ❌ 冇 | **冇** |
| `coordinate_source` | ⚠️ 部分有（等價：`position_source`、`inferred_from`） | ❌ 冇 | ❌ 冇（有 `provenance` 喺 route 層） | ⚠️ 部分有（`coords_source` 枚舉：`locations`/`locations_prefix`/`district`/`osm`/`unknown`） | **部分有** |
| `coordinate_review_status` | ⚠️ 部分有（等價：`review_status` + `coord_corrected`） | ⚠️ 部分有（`review_status`） | ⚠️ 部分有（route 層 `review_status`） | ❌ 冇 | **部分有** |
| `zone_id` | ⚠️ 部分有（等價：`zone_ids` 陣列，88/704 有值） | ❌ **冇**（只有 `location_id`） | ❌ 冇 | — | **冇／部分有** |
| `chapter_refs` | ⚠️ 部分有（等價：`chapters`、`first_appearance`） | ✅ 已有（`chapter_refs`、`chapter`） | ⚠️ 部分有（waypoint 有 `chapter` 單值） | ⚠️ 部分有（`chapters`） | **部分有** |
| `spatial_evidence_count` | ❌ 冇 | ❌ 冇 | ❌ 冇 | ❌ 冇 | **冇** |

**實測 property keys（union）**：

- locations：`id, name, display_name, location_type, fictional, location_precision, story_position, first_appearance, chapters, characters, description, confidence, review_status, source, aliases, zone_ids, inferred_from, position_source, map_hidden, coord_corrected`
- events：`id, title, description, chapter, chapter_name, chapter_refs, characters, event_type, spoiler_level, location_id, location_name, confidence, review_status, source, character_roles`
- routes：`id, character_id, character_name, color, chapters_span, chapters, precision, waypoints, missing_waypoint_locations, provenance, source, confidence, review_status, real_waypoint_fraction`
- route waypoint：`{location_id, chapter, note, confidence}`
- zones：`id, name, kind, kind_votes, aliases, chapters, first_appearance, location_hint, government, leadership, social_structure, economy, defense, population, culture, notable_features, threats, summary, evidence, confidence, radius_m, radius_source, coords_source, coords_evidence, range_evidence, sources, source`

**額外落差**：

- `zones` 用 `kind`（`survivor`/`nest`/`outpost`），**唔係** spec §2.4 嘅 `zone_type`；亦**冇** `status`、`danger_level`、`spatial_precision`、`display_style`、`event_ids`、`character_ids`、`dossier_id`、`review_status`。
- `location.schema.json` 描述聲明 `zone_ids` 要同 zones 嘅 `member_location_ids` 一致，但 zones **完全冇** `member_location_ids` 欄位（實測 0/48）。反向連結目前係 `merge_zone_dossiers.py` 用**名完全相等**單向填。
- events / timeline **冇** 任何 flashback 欄位；只有 `chronicle.json` 有 `flashback`（106 條 true）+ `chapters[].role`。

### 1. R1 Geometry validity —— 量化結果

| 檢查 | 命中 | 判定 |
|---|---|---|
| 非法／NaN／Inf 座標 | **0** | ✅ |
| 座標超出 lon/lat 全域範圍 | **0** | ✅ |
| Polygon self-intersection | **0 / 48** | ✅（凸包 + 放射擴張保證凸性） |
| Polygon 未閉合 | **0 / 48** | ✅ |
| Polygon 頂點 < 4 | **0 / 48** | ✅ |
| Route 相鄰重複頂點（退化段） | **207 段，涉及 36 / 42 條 route** | ⚠️ **P2** |
| 完全相同座標組（跨 feature） | **43 組，涉及 232 個 location** | 🔴 **P0**（見 R6） |

**最極端例子**：36 條 route 有零長度段，例如 `route_ent_47a73fb582_001`、`route_ent_b6ab37e537_002`……（`artifacts/audit-A5/spatial-audit.json` → `R1_geometry.duplicate_vertices` 有完整 207 條）。

### 2. R2 Bounds —— 量化結果

| 檢查 | 命中 |
|---|---|
| 座標落喺 base-map bbox（`113.79–114.49 / 22.11–22.61`）之外 | **0** |
| 座標落喺故事舞台 bbox（`114.14–114.36 / 22.22–22.36`）之外 | **0** |
| zone 頂點越出 base-map bbox | **0** |

✅ **Bounds 全過。** 但要留意：呢個係「上游已把合成座標強行收窄入故事區」嘅結果，唔代表原始 location assignment 正確。base-map bbox 比實際資料分佈大約 100 倍面積 —— 資料只用到極少一部分世界。

### 3. R3 Zone membership —— 量化結果

- 有 `zone_ids` 嘅 location：**88 / 704**（12.5%），zone link 總數 **99**。
- 落喺對應 polygon **內**：**69 / 99（69.7%）**。
- 落喺 polygon **外**：**30 / 99（30.3%）**。
  - 超出 **400 m**（warning）：**20**
  - 超出 **1500 m**（quarantine）：**12**
- 事件經 `location_id` 反查後**冇任何 zone**：**1664 / 1796（92.7%）**（因為 88 個有 zone 嘅地點覆蓋唔到大部分事件）。
- 事件 `location_id = null`：**16**。
- zones 有 `member_location_ids` 欄位：**0 / 48**。

**12 個 quarantine 候選（>1500 m）**：

| location | → zone | 距離 | 精度 |
|---|---|---|---|
| `loc_0238` 將軍澳廣場 | 將軍澳商場 | **3,036.9 m** | exact |
| `loc_0550` 仁興工業大廈 | 不法者監獄 | **2,464.5 m** | exact |
| `loc_0471` 康城 | 康城倖存區 | **2,372.9 m** | approximate |
| `loc_0704` 碉堡 | 魔鬼山碉堡 | **2,342.5 m** | fictional |
| `loc_0399` 病獵公會 | 病獵公會聖堂 | **2,321.0 m** | district |
| `loc_0003` 香港知專設計學院 | 大本營 | **2,329.9 m** | district |
| `loc_0473` 日出康城二期 | 康城二期倖存區 | **2,255.7 m** | approximate |
| `loc_0640` 康城區 | 康城倖存區 | **1,873.5 m** | fictional |
| `loc_0400` 聖堂 | 病獵公會聖堂 | **1,852.5 m** | fictional |
| `loc_0388` 翠林邨 | 翠林村倖存區 | **1,847.6 m** | approximate |
| `loc_0535` 疊翠軒停車場 | 疊翠軒 | **1,597.1 m** | approximate |
| `loc_0609` 靈實醫院精神科病院 | 靈實醫院 | **1,561.1 m** | approximate |

**另 8 個 400–1500 m warning**：`loc_0143` 醫院→靈實醫院 1,370 m、`loc_0177` 墳場→將軍澳華人永遠墳場 1,234 m、`loc_0338` 坑口→病者之都 1,341 m、`loc_0386` 詭區→詭區 491 m、`loc_0401`「詭區」→詭區 491 m、`loc_0469` 病者之都→坑口區 912 m、`loc_0633` 靈實→靈實醫院 1,214 m、`loc_0639` 政府綜合大樓→西貢將軍澳政府綜合大樓 586 m。

> **根因**：反向連結只靠「location 名 == zone 名或 alias」**完全相等**配對，冇做幾何驗證。同名但實際相隔 3 km（將軍澳廣場 vs 將軍澳商場）都會被硬連。呢個係 **P1**。

### 4. R4 Route continuity —— 量化結果

- 相鄰 waypoint 步數：**717**。
- 距離分佈：**p50 = 614 m、p90 = 2,607 m、p95 = 2,957 m、p99 = 3,908 m、max = 4,457 m**。
- 硬跳躍（> 5 km）：**0** ✅
- 警告級跳躍（> 2 km）：**176**，其中 **92 個章節差 ≤ 2**（高可疑：短時間內跨 2 km+）。
- waypoint 章節非單調：**0** ✅
- waypoint 數 vs geometry 頂點數唔一致：**0** ✅
- waypoint `confidence < 0.5`：**0**

**最極端例子（top 8）**：

| 角色 | 由 → 到 | 距離 | 章節 | gap | tight |
|---|---|---|---|---|---|
| 病童 | 寶琳倖存區 → 將軍澳區 | 4,457 m | 98→110 | 12 | |
| 奎斯 | 體育館 → 艾寶琳倖存區 | 4,424 m | 189→191 | 2 | ✔ |
| 賴三 | 病獵公會 → 皇室區 | 4,008 m | 126→132 | 6 | |
| 奎斯 | 艾寶琳倖存區 → 病獵公會 | 3,908 m | 132→133 | 1 | ✔ |
| 瑜小六 | 艾寶琳倖存區 → 病獵公會 | 3,908 m | 194→195 | 1 | ✔ |
| 白魂 | 艾寶琳倖存區 → 病獵公會 | 3,908 m | 178→180 | 2 | ✔ |
| 白鯨 | 艾寶琳倖存區 → 病獵公會 | 3,908 m | 145→146 | 1 | ✔ |
| 王達尼 | 寶琳倖存區 → 病獵公會 | 3,850 m | 115→116 | 1 | ✔ |

> **關鍵訊號**：**4 個唔同角色**出現**完全相同嘅 3,908 m**（艾寶琳倖存區 ↔ 病獵公會），另有重複嘅 3,850 m。距離完全一致 = 兩端座標都係**確定性合成錨點**（`position_source` 為空或 hash 偏移），唔係獨立證據。即 route continuity 表面上「冇硬跳躍」，但實際上係「兩端都唔可信」。
>
> 實測：`艾寶琳倖存區` 精度 = `approximate`、**冇** `position_source`；`病獵公會` 精度 = `district`、**冇** `position_source`。兩者都落入 R8 嘅 120 條無證據清單。呢個係 **P1**。

### 5. R5 Event-location coherence —— 量化結果

| 檢查 | 命中 |
|---|---|
| `location_id` 懸空（引用唔存在 location） | **0** ✅ |
| event coords ≠ location coords（> 1e-4°） | **0** ✅（`propagate_location_coords.py` 已保證） |
| `location_id = null` | **16 / 1796（0.89%）** —— 合乎 `test_event_location_id_coverage` ≥95% |
| `location_name` 同 location `name` 正規化後唔一致 | **9 / 1796（0.50%）** |

**9 條 name mismatch**：`bg_event_076`（天明的宿舍 vs 天明宿舍）、`bg_event_200/202/204/205/206`（董倫大宅 vs 董倫的大宅）、`bg_event_525/565`（操場的斷頭台 vs 操場斷頭台）、`bg_event_646`（不良人的據點 vs 不良人據點）。全部只係「的」字差異 → **P2**（正規化即可解）。

### 6. R6 Duplicate / near-duplicate —— 量化結果

| 檢查 | 命中 |
|---|---|
| 同名 location 組 | **7 組**（14 個 location） |
| 同名但 `location_type` 衝突 | **0** ✅ |
| 非常近 marker（< 50 m）pair | **15,946 pair** |
| 其中 < 1 m | **6,700 pair** |
| 其中同名 | **4 pair** |
| 完全同一座標嘅塌縮簇（≥5 成員） | **10 簇，共 189 個 location** |
| 唯一座標數 | **472 / 704**（33.0% 座標係重複） |

**10 個 marker 塌縮簇**：

| # | 座標 | 成員 | 主要名稱 | 有 zone |
|---|---|---|---|---|
| 1 | `114.25343, 22.30581` | **103** | 大本營、醫療室、圖書館、李惠利大樓、中央廣場… | 8 |
| 2 | `114.2415, 22.3229` | **24** | 寶琳、紫線區、祭品存放室、皇宮、寶琳地鐵站… | 5 |
| 3 | `114.25332, 22.30547` | **11** | D座大樓、608號房、D橦大樓、D大樓… | 0 |
| 4 | `114.248766, 22.323416` | **11** | 人類村莊、胡子老闆的酒館、村長的家… | 0 |
| 5 | `114.253375, 22.30564` | **10** | 手術室、茶水間、發電房、前面廣場、倖存區… | 2 |
| 6 | `114.25375, 22.30573` | **9** | C橦與A橦、C座攝影大樓、C橦００４活動室… | 0 |
| 7 | `114.277722, 22.29731` | **6** | 金門建築有限公司、辦公室、鐵門內嘅房間、大堂… | 0 |
| 8 | `114.253429, 22.30581` | **5** | 七樓、D橦大樓４０３號病房、精神科診所… | 0 |
| 9 | `114.2729, 22.3166` | **5** | 坑口、希望塔、病獵公會、「希望塔」、坑口村 | 4 |
| 10 | `114.254109, 22.305733` | **5** | K館內嘅房間、草原（催眠夢境）、地鐵站… | 0 |

**同名組（7）**：不良人據點、寶琳柒拾、詭區、翠林村、希望塔、哈姆雷特雜貨店、翠林村倖存區（各 2 個）。

> **根因**：`anchor_fictional_locations.py` 對「依附父項」嘅子地點用 `offset_for(ring=90)`，但當父項本身係 `approximate`／無證據座標時，大量子項被寫入**同一個父座標**（hash 偏移喺部分路徑冇生效，或父座標本身係合成錨點）。結果 103 個子地點完全重疊。呢個係 **P0**。

### 7. R7 Narrative temporal coherence —— 量化結果

| 檢查 | 命中 |
|---|---|
| chronicle entries | 1320 |
| `flashback = true` | **106（8.0%）** |
| `flashback` flag 同 `chapters[].role` 唔一致 | **0** ✅ |
| 非回帶條目嘅 `story_time.order` vs `first_mention_chapter` 逆序 | **0** ✅ |
| route waypoint `confidence < 0.5` | **0** ✅ |

✅ R7 喺 chronicle 層面完全一致。**限制**：events / timeline 圖層**冇** flashback 欄位，所以「回帶豁免」目前**只可以**喺 chronicle 層執行，事件層無法自動豁免 → 見「風險、衝突、限制」。

### 8. R8 Unknown over hallucination —— 量化結果

| 檢查 | 命中 |
|---|---|
| `approximate`／`fictional` 但**冇** `position_source` 亦**冇** `inferred_from` | **120 / 704（17.0%）** |
| 其中 `map_hidden = true`（唔顯示） | **0**（全部 120 條都會喺地圖顯示） |
| 全部精度 = `approximate` | 120 / 120 |
| 事件掛喺無證據地點上 | 約 306（120 條地點所屬事件） |

**confidence 分佈（呢 120 條）**：0.90 → 47、0.95 → 25、0.85 → 22、0.92 → 7、0.96 → 3、0.80 → 3。
**樣本**：`loc_0001` 荒廢商場（conf 0.95）、`loc_0017` 荒廢已久的商場（conf 1.0）、`loc_0021` 商場（病腦嘅病窩）（conf 0.95）、`loc_0030` 百貨超市（商場三樓）（conf 0.92）……

> **矛盾點**：呢批地點聲稱 `confidence` 高達 0.95–1.0，但**座標完全冇來源記錄**。spec 規則 8 明確要求「無法自動證明嘅座標不可假裝修正」。呢 120 條應由 `approximate` 降級為 **`unknown`**，或補上 `coordinate_source`。呢個係 **P0**（因為佢直接違反 §0.1 規則 7 同 §2.2 規則 8）。

### 9. Fictional 座標分析

| 指標 | 數值 |
|---|---|
| `fictional = true` | **172 / 704（24.4%）** |
| `inferred_from` 非空 | **260 / 704（36.9%）** |
| `coord_corrected = true` | **34 / 704（4.8%）** |
| `position_source` 非空 | **359 / 704（51.0%）** |
| `location_precision = fictional` | **172** |
| 分佈：`approximate` 415 / `fictional` 172 / `district` 63 / `exact` 54 | |

**172 個 fictional 地點嘅座標來源（`position_source`）**：

| 來源 | 數量 | 性質 |
|---|---|---|
| 同章質心錨定（+ id hash 環形偏移） | **131** | 「虛構但**弱**合理」——位置由同章已解析地點質心推導，唔聲稱具體建築 |
| 後備主場景（將軍澳校園一帶） | **40** | 「虛構但**無**證據」——冇任何同章錨點，全部塞落同一個後備中心 |
| 其他 | 1 | — |
| **冇 position_source** | **0** | ✅（fictional 全部有來源標記，呢點係好嘅） |

- fictional 全部 172 個都落喺故事區（將軍澳範圍）內：**172 / 172**。
- **260 個 `inferred_from`** 地點嘅來源：211 條 `position_source` 為空（靠 `inferred_from` 指向推斷記錄，屬**有證據**）、31 條同章質心、14 條後備主場景、4 條程式化校正。

**判定**：

- 「**虛構但合理**」（131 + 260 inferred）：座標有 deterministic 來源，可以顯示，但**必須**喺 UI 標明 `fictional`／`approximate`，唔可以當真實位置。
- 「**虛構且無證據**」（40 條用後備主場景）：座標係人為塞落將軍澳校園中心，**冇**任何 story evidence。應降級為 `unknown` 或移入 `map_hidden`，避免誤導。
- `coord_corrected` 只有 34 條（4.8%）—— 即係 95% 嘅座標**從來冇經過修正記錄**。

### 10. Zone polygon 品質

| 指標 | 數值 |
|---|---|
| zones | 48 |
| 面積分佈（km²） | min **0.0136** / p25 0.1516 / p50 0.2117 / p75 0.2149 / max **0.9476** |
| 過大（> 6 km²） | **0** |
| 過細（< 0.05 km²） | **1** —— `病獵公會聖堂`（0.0136 km²） |
| `radius_m` 同 polygon 幾何半徑唔一致（>35%） | **0** ✅ |
| 精確 polygon 重疊 pair | **141 / 1128（12.5%）** |
| 嵌套（一方完全包含另一方）pair | **9** |
| `radius_source = default`（估算，唔係證據） | **37 / 48（77.1%）** |
| `radius_source = members`（證據） | **11 / 48（22.9%）** |
| `coords_source = locations` | 47 |
| `coords_source = locations_prefix` | 1 |

**嵌套 pair（9）**：康城倖存區⊃大本營、李惠利大樓⊃大本營、Eagle 酒吧⊃大本營、佛教志蓮小學⊃大本營、死亡之路⊃大本營、聖安得肋堂⊃病者平權組織（聖安得肋堂）、病者平權組織（聖安得肋堂）⊃靈實禮拜堂、不良人據點⊃大本營、大本營⊃康城二期倖存區。

**重疊例子**：圓玄第三中學 × 詭區（centroid 相距 562 m）、圓玄第三中學 × 大本營（536 m）、西貢將軍澳政府綜合大樓 × 病獵公會（70 m）……

> **問題**：`大本營` 係一個 zone，但同時有 5 個 zone 嵌套喺佢入面／外面 —— 同「103 個 location 塌縮喺大本營同一點」係同一個根因（`resolve_coords` 嘅前綴擴充把同名地點全部拉埋一齊，凸包退化）。77% zone 半徑係**預設估算**，唔係成員分佈證據。呢個係 **P1**。

---

## 8 條規則嘅自動檢查設計（可重跑、確定性）

所有規則已實作成 `artifacts/audit-A5/spatial_audit.py`（產生 JSON 報告）同 `artifacts/audit-A5/test_spatial_rules_prototype.py`（pytest 斷言）。下表係 B4 可以直接搬入 `scripts/audit_coordinate_integrity.py` + `tests/test_spatial_integrity.py` 嘅規格。

| # | 規則 | 輸入 | 演算法 | Threshold | 輸出 | pytest 斷言 |
|---|---|---|---|---|---|---|
| **R1** | Geometry validity | locations / events / routes / zones | ① 座標 len==2、finite、lon∈[-180,180]、lat∈[-90,90]；② ring 閉合 + ≥4 頂點；③ O(n²) 線段相交測 self-intersection；④ route 相鄰頂點相等 = 退化段；⑤ 跨 feature 完全相同座標分組 | 非法數 = 0；self-int = 0；route 退化段 = 0（P2 可暫緩） | `bad_coords[]`、`duplicate_vertices[]`、`self_intersecting_polygons[]`、`identical_coordinate_groups[]` | `assert not bad_coords`；`assert not self_int`；`assert not route_dup` |
| **R2** | Bounds | 全部圖層 | 逐點 `in_bbox(c, BASE_BBOX)`；zone 另檢每個頂點 | bbox `113.79–114.49 / 22.11–22.61`；越界 = 0 | `outside_base_bbox[]`、`outside_story_bbox[]` | `assert not out` |
| **R3** | Zone membership | locations + zones | ① 建 `zone_id → ring`；② ray-casting point-in-polygon；③ 唔喺內就計「點到 ring 邊最短距離」；④ 經 `location_id` 反查 event zone；⑤ 檢查 zones 有冇 `member_location_ids` | 內 = pass；>400 m = warning；>1500 m = **quarantine** | `inside[]`、`outside[]`（含 distance_m）、`outside_over_400m[]`、`outside_over_1500m[]` | `assert not outside_over_1500m` |
| **R4** | Route continuity | routes | ① 逐對相鄰 waypoint 計距離；② 記 `chapter_gap`；③ 分硬／警告兩級；④ waypoint chapter 單調性 | hard > 5 km = fail；warning > 2 km 且 gap ≤ 2 = 高可疑；非單調 = fail | `jumps_over_5km[]`、`jumps_over_2km[]`、`non_monotonic_chapters[]`、`distance_quantiles_m` | `assert not jumps_over_5km`；`assert not non_mono` |
| **R5** | Event-location coherence | events + locations | ① `location_id` 必須存在或 null；② `location_name` 同 `location.name` 去「的」後比對；③ event coords vs location coords ≤ 1e-4° | 懸空 = 0；name mismatch ratio ≤ 2%；coord mismatch = 0 | `dangling_location_id[]`、`name_mismatch[]`、`coord_mismatch[]` | `assert ratio <= 0.02`；`assert not coord_mismatch` |
| **R6** | Duplicate / near-duplicate | locations + zones | ① 名正規化分組；② O(n²) 距離 < 50 m pair；③ 完全同一座標分組、成員 ≥5 = 塌縮簇；④ 同名 type 衝突 | 同座標 > 20 成員 = fail；同名 type 衝突 = 0；<50 m pair 要 cluster | `same_name_location_groups[]`、`near_duplicates_under_50m[]`、`marker_collapse_clusters[]` | `assert not marker_collapse`；`assert not type_conflict` |
| **R7** | Narrative temporal coherence | chronicle + routes | ① `flashback` flag 對 `chapters[].role`；② 非回帶條目 `story_time.order` vs `first_mention_chapter` 逆序；③ waypoint confidence 下限 | flag 唔一致 = 0；逆序 = 0 | `flashback_flag_role_inconsistent[]`、`story_order_inversions_non_flashback[]` | `assert not inconsistent`；`assert not inversions` |
| **R8** | Unknown over hallucination | locations | `precision ∈ {approximate, fictional}` 且 `position_source` 空 且 `inferred_from` 空 → 標 `should_be_unknown` | ratio ≤ 5% | `approximate_or_fictional_without_evidence[]`、`position_source_kind{}` | `assert ratio <= 0.05` |

### Prototype 實跑結果（4 fail / 9 pass）

```
FAILED test_r1_no_consecutive_duplicate_vertices        → 36 / 42 routes 有退化段
FAILED test_r3_zone_linked_locations_are_inside_or_near_polygon → 12 條 > 1500 m
FAILED test_r6_no_marker_collapse                       → 2 點塞 103 / 24 個 marker
FAILED test_r8_no_unsourced_approximate_coordinates     → 120 / 704 (17.0%) > 5%
9 passed（geometry 全域、bbox、polygon 閉合、route 硬跳躍、章節單調、event 引用、
          name ratio、同名 type、flashback 一致性）
```

### D1–D5 多代理流程可行性評估（**唔讀 private** 前提下）

| 階段 | spec 要求 | A5（只讀 public）能否做 | 建議由 B4 點實現 |
|---|---|---|---|
| **D1** Spatial Evidence Extractor | 分 chapter range 讀 **private evidence**，抽明確位置語句 | ❌ **唔可以** —— 需要 private 全文／evidence excerpt | 由 B4 執行，**輸出必須係 schema-validated structured JSON**（`evidence-candidate.schema.json` 已有）。**唔可以**直接寫 production GeoJSON |
| **D2** Coordinate Consistency Analyst | 只讀 public + D1 evidence，找 outlier／conflict／false precision | ✅ **可以** —— A5 已做（R1/R2/R4/R5/R6/R8 全部只靠 public） | 把 `artifacts/audit-A5/spatial_audit.py` 搬入 `scripts/audit_coordinate_integrity.py`，輸出 `data/private/review/` 級別嘅 candidate JSON |
| **D3** Zone Topology Analyst | polygon / marker / route / zone relation | ✅ **可以** —— A5 已做（R3 + zone 品質） | `scripts/infer_zone_membership.py`：用 point-in-polygon + 距離分佈自動填 `zone_ids`／`member_location_ids`，唔靠名相等 |
| **D4** Adversarial Data Reviewer | 推翻不合理 coordinate claim，要求 evidence threshold | ⚠️ **部分可以** —— 可以**確定性**要求「每個 claim 至少 1 個 `coordinate_source` + `spatial_evidence_count ≥ 1`」；但「推翻」需要 D1 evidence | `scripts/validate_spatial_narrative.py`：schema 層強制 `coordinate_confidence`／`coordinate_source`／`spatial_evidence_count` 存在，缺失即 quarantine |
| **D5** Repair Executor | 只套用 deterministic validation／consensus 接受嘅 patch | ⚠️ **部分可以** —— 可以套用「幾何／bounds／zone」類 deterministic patch（唔需小說證據）；「位置重配」類必須等 D1 | `scripts/apply_coordinate_patches.py`：只接受 `coordinate_review_status = validated` 嘅 patch |

**結論**：A5 層面可以**完整**完成 D2 + D3，**部分**完成 D4 + D5；**D1 本質上需要 private evidence**，必須留喺 B4，但 B4 要以 schema + deterministic rule 合併，唔可以靠對話文字直接改 production GeoJSON。

---

## 不可信座標候選清單（P0/P1/P2 分級）

### P0 —— production blocker（3 類）

| ID | 問題 | 命中 | 最極端例子 | 建議處置 |
|---|---|---|---|---|
| **P0-1** | Marker 塌縮：多個 location 完全同一座標 | **189 個 location / 10 簇**；唯一座標只有 472/704 | `114.25343, 22.30581` 塞 **103** 個 location | 對每個簇做 deterministic 環形散佈（現有 `offset_for` 已存在但未生效）；或降級為 cluster marker |
| **P0-2** | 事件座標大面積無證據 | **1385 / 1796（77.1%）** 事件掛喺 `approximate`／`fictional` 地點 | 全體 `approximate` 事件 | UI 必須顯示精度；事件 detail 唔可以當精確位置 |
| **P0-3** | Schema 缺 spec §2.2 欄位 | `coordinate_confidence`／`coordinate_source`／`coordinate_review_status`／`spatial_evidence_count` = **0 / 4 layer**；events 冇 `zone_id` | — | B4 versioned migration：加欄位 + 由 `position_source`／`inferred_from` backfill |

### P1 —— 高優先（4 類，302 instance）

| ID | 問題 | 命中 | 最極端例子 |
|---|---|---|---|
| **P1-1** | Zone membership 唔一致（名相等硬連，冇幾何驗證） | **12 quarantine（>1500 m） + 8 warning（>400 m）** | `loc_0238` 將軍澳廣場 → 將軍澳商場 **3,036.9 m** |
| **P1-2** | Route coherence 靠合成錨點（表面通過，實際兩端都唔可信） | **176 步 >2 km，92 步章節差 ≤2** | 4 個角色共用完全相同 3,908 m（艾寶琳倖存區 ↔ 病獵公會） |
| **P1-3** | Zone polygon 品質：重疊／嵌套／預設半徑 | **141 重疊 pair、9 嵌套、1 過細、37/48 用 default 半徑** | `大本營` 被 5 個 zone 嵌套；`病獵公會聖堂` 面積 0.0136 km² |
| **P1-4** | 40 個 fictional 用「後備主場景」= 冇證據座標 | **40 / 172 fictional** | 全部塞落將軍澳校園中心 |

### P2 —— 中低優先（7 類）

| ID | 問題 | 命中 |
|---|---|---|
| P2-1 | Route 相鄰重複頂點（退化零長度段） | 207 段 / 36 條 route |
| P2-2 | event `location_name` 同 location 名唔一致（「的」字） | 9 |
| P2-3 | event `location_id = null` | 16 |
| P2-4 | 同名 location 組（無 type 衝突） | 7 組 / 14 個 |
| P2-5 | zones 冇 `member_location_ids`（schema 描述聲明要有） | 0 / 48 |
| P2-6 | `map-config.json` `provisional_mode.banner` 文案寫「仍待人工審閱」——違反「零人手參與」 | 1 |
| P2-7 | `map-config.json` `renderer: "svg"` 已過時（實際 Canvas 向量底圖） | 1 |

---

## 修改檔案

**冇。** 本任務係只讀審計。新增檔案全部喺允許範圍：

| 檔案 | 用途 |
|---|---|
| `artifacts/audit-A5/spatial_audit.py` | 確定性空間審計腳本（產生 JSON 報告） |
| `artifacts/audit-A5/spatial-audit.json` | 完整候選清單（machine-readable） |
| `artifacts/audit-A5/test_spatial_rules_prototype.py` | 8 條規則嘅 pytest 斷言 prototype |
| `docs/audits/spatial-integrity-audit.md` | 本報告 |

**冇改**：`src/**`、`data/**`、`public/**`、`tests/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`scripts/**`、`.gitignore`。**冇**任何 git 寫操作。**冇**讀取 `data/private/`。

---

## 沒有修改但相關的檔案

| 檔案 | 相關性 |
|---|---|
| `scripts/audit_location_coords.py` | 已有 3 條確定性規則（地名重配／區外／同章離群），但**冇** zone membership、route continuity、duplicate 檢查；亦冇 output schema |
| `scripts/anchor_fictional_locations.py` | P0-1 塌縮嘅來源之一（`offset_for` + 父項錨定） |
| `scripts/merge_zone_dossiers.py` | P1-1／P1-3 根因：反向連結靠**名完全相等**、zone 範圍靠**前綴擴充凸包** |
| `scripts/propagate_location_coords.py` | 保證 event coords = location coords（R5 通過嘅原因） |
| `scripts/validate_public_data.py` | 已有 schema + 引用一致性 + 治理掃描，但**冇**任何幾何／空間規則 |
| `scripts/build_vector_basemap.py` | base-map bbox 定義（`BBOX`）來源 |
| `data/schemas/location.schema.json` | 已有 `location_precision`、`zone_ids`、`position_source`，缺 spec §2.2 四個欄位 |
| `data/schemas/event.schema.json` | 缺 `zone_id`、全部 `coordinate_*` |
| `data/schemas/zone.schema.json` | 用 `kind` 唔係 `zone_type`；冇 `member_location_ids` |
| `tests/test_public_data.py` | 已有 event coords ↔ location coords、location_id 覆蓋率（≥95%）斷言 |
| `tests/test_apply_inferences.py` | 已有「套用座標 = 推斷記錄座標」不變式；唔可以覆蓋 `inferred_from` 座標 |
| `data/public/map-config.json` | P2-6／P2-7（過時 renderer + 違規 banner 文案） |

---

## 驗證命令與結果

```bash
# 1. 空間審計（確定性、可重跑）
python artifacts/audit-A5/spatial_audit.py
# → 產出 artifacts/audit-A5/spatial-audit.json

# 2. 8 條規則 pytest prototype（用系統 Python）
"C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe" -m pytest \
  artifacts/audit-A5/test_spatial_rules_prototype.py -v

# 3. 現有 production 驗證器（確認審計冇改壞任何嘢）
python scripts/validate_public_data.py
```

**實跑結果**：

```
=== A5 空間審計 ===
locations=704 events=1796 routes=42 zones=48

R1 geometry: bad_coords=0 self_int=0 dup_vertices=207 identical_groups=43
R2 bounds: outside_base=0 outside_story=0
R3 zone: links=99 inside=69 outside=30 >400m=20 >1500m=12
R4 route: steps=717 jumps>5km=0 tight=0 quantiles={'p50':614.1,'p90':2607.4,'p95':2956.8,'p99':3908.3,'max':4457.1}
R5 coherence: name_mismatch=9 coord_mismatch=0 null_loc=16
R6 dup: same_name_groups=7 near<50m=15946 type_conflict=0 collapse_clusters=10(189 pts)
   jumps>2km=176 tight=92
provenance: real=300(43%) synthetic=284(40%) unknown=120(17%)
R7 temporal: flashback=106 flag_role_inconsistent=0 order_inversions=0
R8 unknown: no_evidence=120 visible=120
fictional: 172 (no_source=0) inferred_from=260 coord_corrected=34
zone quality: oversized=0 undersized=1 radius_inconsistent=0 overlaps=141
```

```
pytest artifacts/audit-A5/test_spatial_rules_prototype.py -q
→ 4 failed, 9 passed in 0.32s
```

> 腳本具**確定性**：唔用 `random`，所有偏移由 id hash 決定；重跑結果完全相同。

---

## Screenshots / Artifacts

| Artifact | 內容 |
|---|---|
| `artifacts/audit-A5/spatial-audit.json` | 完整機器可讀報告：8 條規則全部候選清單、schema 落差表、provenance 分類、zone 品質、fictional 分析 |
| `artifacts/audit-A5/spatial_audit.py` | 審計腳本（可重跑） |
| `artifacts/audit-A5/test_spatial_rules_prototype.py` | 8 條規則 pytest 斷言 prototype |

`spatial-audit.json` 主要 key：`schema_gap`、`R1_geometry`、`R2_bounds`、`R3_zone_membership`、`R4_route_continuity`、`R5_event_location_coherence`、`R6_duplicates`、`R7_temporal`、`R8_unknown`、`fictional`、`provenance`、`zone_quality`。

> 註：`R6_duplicates.near_duplicates_under_50m` 明細截斷至最近 3,000 條（`near_duplicates_truncated: true`），避免 artifact 過大；`n_near_duplicates` 仍然係完整數字 15,946。其餘清單全部完整。

---

## 風險、衝突、限制

### 限制

1. **冇讀 private**：本審計**無法**驗證「座標係唔係真係對應小說原文位置」—— 只能驗證**內部一致性**（幾何、bounds、zone、route、名稱、schema）。D1 級別嘅 evidence 驗證必須由 B4 做。
2. **R7 只覆蓋 chronicle**：events / timeline 冇 flashback 欄位，所以「回帶豁免」無法喺事件層自動執行。B4 需要為 events 加 `is_flashback`（或由 chronicle `source_event_ids` 反查）。
3. **Zone polygon 係凸包近似**：`merge_zone_dossiers.py` 用「凸包 + 放射擴張」，所以「嵌套」可能係幾何近似造成，唔一定係語意錯誤。但 141 個精確重疊 pair 仍然係真實嘅視覺衝突。
4. **`near_duplicates_under_50m = 15,946`** 係 O(n²) 全對，包含同一塌縮簇內部所有組合；解讀時應以「塌縮簇」為單位（189 個 location），唔係逐 pair。
5. **Provenance 分類嘅「real = 43%」** 係寬鬆定義（包含 `exact`/`district` 無來源者）。嚴格定義（有 `inferred_from` 或程式化校正）只有 **294 / 704（41.8%）**。

### 衝突

- **與 `tests/test_apply_inferences.py` 衝突風險**：R3 若要自動改 `zone_ids`，唔會影響該測試；但若要改 `inferred_from` 地點嘅座標，會違反 `test_applied_coordinates_match_inference`。**任何座標修正都必須跳過 `inferred_from` 非空嘅地點**（`audit_location_coords.py` 已有此保護）。
- **與「零人手參與」一致**：本審計**冇**任何抽樣或人手覆核建議；所有候選都由 threshold 決定。P2-6 指出 `map-config.json` banner 文案違規，需改為自動驗證描述。

### 風險

- **P0-1 若唔修**：地圖上 103 個地點永遠分唔開，任何「點選地點」journey 都會選到錯 marker。
- **P0-2 若唔修**：77% 事件顯示喺未驗證座標上，等同 spec §0.3「明顯錯置、無證據嘅點會被修正、降級精度或隔離」未達成。
- **P0-3 若唔修**：B4 無法表達 `coordinate_review_status`，D5 repair 無處落腳，coordinate integrity pipeline 會停滯。

---

## 給主代理的 integration note

1. **A5 已交付全部 spec §4.2 要求**：`spatial-integrity-audit.md`（schema 落差表 ✅、不可信座標候選清單（量化）✅、8 條規則自動檢查設計 ✅、fictional 座標分析 ✅，全部按 P0/P1/P2 分級 ✅）。

2. **Gate 1 決策建議**：
   - `data/schemas/*.schema.json` 必須做 **versioned migration**：加 `coordinate_confidence`、`coordinate_source`、`coordinate_review_status`、`spatial_evidence_count`；events 加 `zone_id`；zones 加 `member_location_ids` + `review_status`。
   - Backfill 規則（確定性，唔需 private）：`coordinate_source` ← `inferred_from ? "cross_chapter_evidence" : position_source 含「程式化座標校正」? "legacy" : "legacy"`；`coordinate_review_status` ← `coord_corrected ? "auto_corrected" : "needs_validation"`。

3. **B4 file scope 建議**（唔可以同其他 B agent 撞）：
   - `scripts/audit_coordinate_integrity.py` ← 搬 `artifacts/audit-A5/spatial_audit.py`
   - `scripts/infer_zone_membership.py` ← 用 point-in-polygon 取代「名相等」反查（解 P1-1）
   - `scripts/validate_spatial_narrative.py` ← R7 + R5 規則
   - `scripts/render_coordinate_audit_report.py` ← 讀 `spatial-audit.json` 出報告
   - `tests/test_spatial_integrity.py` ← 搬 `test_spatial_rules_prototype.py`

4. **P0 修復次序**：
   - P0-3（schema）先行 —— 冇 schema 就冇 `coordinate_review_status` 可以標 quarantine。
   - P0-1（塌縮）次之 —— 對每個 ≥5 成員簇用 deterministic 環形散佈；**必須跳過 `inferred_from` 非空地點**（見衝突）。
   - P0-2（事件無證據）最後 —— 依賴 P0-3 嘅 `coordinate_source` 欄位 + UI 精度顯示。

5. **唔需要人手**：所有 P0/P1 都有 deterministic threshold 同可重跑腳本，符合 AGENTS.md「零人手參與」。**唔好**建議抽樣覆核。

6. **D1 必須由 B4 做**：A5 層面無法讀 private evidence。B4 嘅 D1 輸出**必須**過 `evidence-candidate.schema.json`，然後由 deterministic rule 合併 —— 唔可以靠對話文字直接改 production GeoJSON（spec §2.2 明文要求）。

7. **A5 冇改任何 production 檔案**，唔需要 legacy cleanup，亦冇同其他 A agent 嘅 file scope 衝突。

# 座標錨定 + 全境級地點 + 圖層同步（2026-09-24 第二輪）

> 用戶授權：**可以改 `data/public/**`**，要一齊重跑 zone 推導 + 重驗全部閘門。
> 用戶補充 #2：「移動」係**拖曳**，光圈「**跟唔上**」及移動時「**同底圖分離**」，
> 明顯係兩層嘢。
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部確定性、可重跑。

---

## 0. 一句話總結

| # | 項目 | 結果 |
|---|---|---|
| 2 | **拖曳時 SVG 同 canvas 分離** | ✅ **已修**：中位落後 3.4 → **−0.2 ms**；跨 frame 比例 48% → **9%** |
| 3 | **標記座標錯** | ✅ **已修**：由故事文字錨定 **10 個 location**；zone 幾何跟隨重推 |
| 4 | **第一章標記去咗旺角** | ✅ **真兇 = event 標記**（唔係 location）；已修 |
| — | 座標審計 | Locations MISMATCH **14 → 6**；Zones **6 → 4** |
| — | 閘門 | pytest **307** ✅｜validate ✅｜audit ✅｜vitest **696** ✅ |

---

## 1. #2 拖曳時 SVG overlay 同 canvas 底圖分離

### 1.1 根因（用戶描述直接指向）

> 「**跟唔上**」＋「**同底圖分離**」＝ 兩層唔同步。

· `SvgMap.applyViewBox()` 係**同步**改 SVG `viewBox` → zone 光環／標記
  （SVG 層）即刻跟住郁；
· canvas 底圖（陸地／道路／建築）係經 `VectorBasemap.scheduleDraw()`
  排喺**下一個** rAF。

`MapViewport` 本身已經用 rAF coalesce 指標事件，所以 `setView()` 係喺
**一個 rAF callback 之內**被呼叫 —— 再排一個 rAF 就係**下一幀**
→ canvas 落後 SVG **整整 1 個 frame**。
快速拖曳時 1 frame ≈ 16 ms；以 1000 px/s 拖曳即係 **~16 px 位移**。

### 1.2 量度方法（新增 `artifacts/phase3-resume/probe-layer-sync.mjs`）

| 層 | 量度方式 |
|---|---|
| SVG | `MutationObserver` 監 `#svg-map` 嘅 `viewBox` 屬性 → 記 `performance.now()` |
| canvas | patch `CanvasRenderingContext2D.prototype.setTransform`，只收「重設去螢幕空間」嗰次（`a ≈ dpr && e === 0`，即 `draw()` 開頭） |

配對之後 `Δ = drawTime − viewBoxChangeTime`。

### 1.3 結果（25 次拖曳、275 次 viewBox 變更）

| | 修復前 | 修復後 |
|---|---|---|
| 中位落後 | 3.4 ms | **−0.2 ms**（同幀，甚至略早） |
| p90 | 17 ms | **−0.1 ms** |
| max | 18.2 ms | 85.6 ms（偶發長 task） |
| **>8 ms（跨 frame）比例** | **48%** | **9%** |

⚠️ 負值係因為 MutationObserver callback 係 microtask（喺同一個 task 之後才派），
所以繪製會**早過**記錄 —— 即係同幀 ✓。

### 1.4 修法

`VectorBasemap` 新增 `drawNow()`（取消已排隊嘅 rAF，**同步**繪製），
`setView()` 改為呼叫 `drawNow()`。因為 `setView()` 每個 frame 最多行一次，
**總工作量不變**，只係提早喺同一幀做完。

⚠️ 圖磚載入（async）路徑**仍然**用 `scheduleDraw()` —— 佢唔喺 rAF 之內，
同步重繪冇意義而且會重繪多次。

守門測試：`tests/layer-sync.test.ts`（4 tests）。

---

## 2. #3 標記座標錯 —— 由故事文字錨定

### 2.1 新增 `scripts/anchor_locations_from_text.py`

**證據優先次序**（每項記錄規則 + 信心，可稽核）：

| 規則 | 證據 | 信心 |
|---|---|---|
| **A** | location 嘅**名／別名包含**恰好一個地標名（錨名 ≥ 4 字） | 0.95 |
| **B** | location 嘅**描述**喺**強定位片語**內提到恰好一個地標 | 0.85 |
| **C** | zone dossier 用 `即`（同一性斷言）或 `位於`（喺 overview 開頭）提到恰好一個地標，**而且有同名 location** | 0.80 |

⚠️ **強定位片語只有 `位於` / `設於` / `即`**。實測踩過：收 `喺` 會令
「坑口38號街」誤錨 —— 佢嘅描述係「與老師**喺寶康公園**病窩塔頂畫嘅地圖
吻合嘅位置」，寶康公園只係「畫地圖」嘅地點，唔係條街嘅位置（誤差 1,224 m）。

### 2.2 已錨定 10 個 location

| location | 距離 | → 地標 | 規則 | 關係 |
|---|---|---|---|---|
| 不法者監獄 | 2,777 m | 仁興工業大廈 | C | at |
| 皇室區 | 2,374 m | 新都城二期 | C | at |
| 新都城中心三期 | 847 m | 新都城中心三期 | A | at |
| 梁潔華小學 | 847 m | 新都城中心三期 | B | adjacent |
| 新都城中心三期賭場 | 816 m | 新都城中心三期 | A | at |
| 哈姆雷特百貨公司 | 780 m | 新都城中心一期 | B | adjacent |
| 吉野家（將軍澳廣場二樓） | 757 m | 將軍澳廣場 | A | at |
| 將軍澳廣場二樓超市 | 726 m | 將軍澳廣場 | A | at |
| 新都城二期 | 674 m | 新都城二期 | A | at |
| 將軍澳廣場二樓超級市場 | 516 m | 將軍澳廣場 | A | at |

⚠️ `relation: adjacent` 表示文字講「喺地標**隔籬**」（例如「新都城中心三期
**左邊**、只隔一條馬路」）—— 錨係地標本身，地點可能喺隔籬。已寫入
`coordinate_anchor.relation`。

**錨嘅來源已逐個核實**（OSM）：
· 新都城二期 = way 28109599，`addr:housenumber=8`、`addr:street=欣景路`
· 新都城中心三期 = way 302740027，`shop=mall`、`addr:street=貿業路`
· 將軍澳廣場 = way 28104309／126392621

### 2.3 ⚠️ 管線次序陷阱（實測踩過兩次）

**第一次**：錨定跑喺管線**之前** → 階段 1（標記塌縮修復）**覆蓋**咗 10 個
錨定座標（全部打回 `legacy`）。
→ 修法：將錨定插入 `merge_zone_dossiers.py` 嘅 **階段 1.5**（階段 1 之後、
階段 2 之前 —— 因為 zone 幾何係由成員座標推導）。

**第二次**：`run_pipeline.py` 嘅 `propagate_location_coords.py` 跑喺
`merge_zone_dossiers.py` **之前**，所以錨定之後 events／timeline／routes
嘅座標仍然係舊嘅 → `test_route_coords_match_waypoint_locations` 紅。
→ 修法：加 **階段 1.6「重新傳播座標」**（塌縮散佈本身冪等，重跑安全）。

**第三次（metadata）**：階段 3 嘅 `coordinate_*` 回填會將
`coordinate_source` 打成 `legacy`、`coordinate_confidence` 打成 0.55。
→ 修法：`infer_zone_membership.py` 嘅回填加最高優先分支 ——
有 `coordinate_anchor` 就用 `text_landmark` + 規則信心。

### 2.4 zone 幾何跟隨重推

重跑 `merge_zone_dossiers.py` 之後：

| zone | 移動 | 新中心 |
|---|---|---|
| 皇室區 | **2,190 m** | (114.25654, 22.32264) —— 真正嘅寶琳／新都城區 |
| 不法者監獄 | **2,727 m** | (114.27407, 22.28187) —— 將軍澳工業邨 |

⚠️ zone 幾何係**成員質心**（`radius_source: "members"`），所以皇室區
未完全落到新都城二期（差約 200 m）—— 因為另外 19 個成員喺附近但唔喺同一點。
呢個係正確行為。

### 2.5 全故事掃描結果（`audit_coordinate_text_consistency.py`）

| | 修復前 | 修復後 |
|---|---|---|
| Locations MISMATCH | 14 | **6** |
| Locations PASS | 25 | **33** |
| Zones MISMATCH | 6 | **4** |
| Zones PASS | 8 | **10** |

**剩餘 6 + 4 個 MISMATCH 係刻意唔自動修**（歧義）：
· 「艾寶琳倖存區」嘅 overview 提到「皇宮**設於**新都城二期」—— 主語係**皇宮**
  唔係區域（規則 C 唔收 `設於`）
· 「將軍澳商場」/「死亡之路」/「popcorn 商場」—— dossier 提到地標但冇
  `即`／開頭 `位於` 嘅定位片語
· 「廣場燒烤區 → 燒烤區 (8,560 m)」—— 錨名「燒烤區」係泛稱
· 「邱子文學院 → 寶康公園」「社區教會堂 → 彩明苑」—— 描述用 `喺`（已排除）

---

## 3. #4 第一章標記去咗旺角 —— 真兇係 **event 標記**

### 3.1 追查過程

1. 第一章 4 個 location 全部喺將軍澳（0.4–1.4 km）✓
2. 「香港」（loc_0014，座標 114.1694/22.3193 = 旺角）**已經有 `map_hidden: true`**
   → location 標記唔會畫 ✓
3. **但第一章 6 個 event 之中，4 個連去 loc_0014** → event 標記**冇**跟
   `map_hidden` 規則 → 喺旺角出現 4 個標記 ← **真兇**

### 3.2 修法

`SvgMap.render()`：新增 `eventsToPlot`（過濾掉連去 `map_hidden` location 嘅 event），
繪製迴圈改用 `eventsToPlot`。呢個係 `map_hidden` 既有語義嘅延伸
（「資料保留喺面板度，但唔喺地圖標一個**誤導性嘅點**」）。

⚠️ 呢 4 個 event 冇 `zone_id` → 冇更好嘅 fallback 座標 → 只可以唔畫。
資訊唔會消失（仍然喺事件列表）。

守門測試：`tests/event-map-hidden.test.ts`（4 tests），含
「第一章唔應該再有離將軍澳 >4 km 嘅**可繪製** event」。

---

## 4. 閘門

| 閘門 | 結果 |
|---|---|
| `npm run typecheck` | 0 |
| `npm run lint` | 0 |
| `npm run test` | **44 檔 / 696 tests** ✅ |
| `pytest` | **307** ✅ |
| `validate_public_data.py` | ✅ |
| `audit_release.py` | ✅ |

### 4.1 因為資料改動而更新嘅斷言（3 處，全部係「改善」）

| 檔案 | 舊 | 新 | 理由 |
|---|---|---|---|
| `scripts/validate_public_data.py` | `COORDINATE_SOURCE_ENUM` | + `text_landmark` | 新增證據類型 |
| `tests/test_spatial_integrity.py` | 冇證據座標 = 120 | **116** | 4 個 location 取得 `coordinate_anchor` 證據（**證據增加**，唔係放寬） |
| `tests/data-indexes.test.ts` | `eventsByZone` = 1627 | `≥1627`（實測 1632） | 管線重跑後覆蓋率**改善**；硬編碼會將改善判成失敗 |

⚠️ `rule_r8`（`audit_coordinate_integrity.py`）同對應測試亦加咗
「`coordinate_anchor` 係證據」—— 否則已錨定嘅座標會被誤判「假裝已驗證」。

---

## 5. 重跑指令

```bash
# 完整資料管線（含座標錨定 1.5 + 重新傳播 1.6）
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/merge_zone_dossiers.py

# 座標 × 文字一致性審計
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/audit_coordinate_text_consistency.py --json artifacts/coord-text.json

# 錨定計劃（dry-run 睇會改咩）
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/anchor_locations_from_text.py --dry-run

# 圖層同步量度
env -u http_proxy -u https_proxy node artifacts/phase3-resume/probe-layer-sync.mjs --drags=25
```

---

## 6. 下一步（未做）

| ID | 項目 | 說明 |
|---|---|---|
| 2-1 | **剩餘 10 個 MISMATCH** | 需要更強嘅語義規則（例如「設於」但主語係區域嘅情況、泛稱錨過濾）。建議擴充 `audit` 嘅定位片語模型，而唔係放寬現有規則。 |
| 2-2 | **641 個 `NO_TEXT` location** | 文字冇提到任何已知地標 → 需要更豐富嘅地標來源（例如加入 `place=*` node 到 OSM 快取）。 |
| 2-3 | **`build_vector_basemap.py` 出 tile index** | 令前端完全唔請求缺失圖磚（而家係「請求一次先知道冇」） |
| 2-4 | **`eventsByZone` 覆蓋率再提升** | 90.9% → 目標 95%+（現時 164 個 event 冇 zone） |

# C4 — Spatial Integrity Audit（對抗驗收）

> 角色：**C4 Spatial Integrity Auditor**（對抗驗收）
> 日期：2026-09-24
> 範圍：`data/public/` 空間資料完整性；驗收矩陣 §4 嘅 **DA1–DA9**
> 限制：只讀；**冇改過** `src/` / `scripts/` / `data/` / `tests/`。全部產出喺 `artifacts/c4-spatial/`。
> 快照：`artifacts/c4-spatial/prod-snapshot.json`（`data/public/**` 逐檔 SHA-256）

---

## 0. 免責／時序說明（必讀）

審計期間（22:07–22:41）**有其他隊友持續就地重跑 pipeline**，`data/public/**` 被多次覆寫（非原子寫入）。
我嘅第一次 `pytest` 因此讀到**撕裂狀態**（見 §4.6）。所有結論以**最後穩定快照**為準：

```
data/public 最後穩定快照（SHA-256 頭 16 位）— 22:2x 版本
locations.geojson  ee5d3591e6af
events.geojson     bab9dff584d2
routes.geojson     c0403c66a566
zones.geojson      043f341e8903c97c
```

### 0.1 ⚠️ 22:37–22:41 觀察到「寫入風暴」（新）

重驗期間（22:37–22:41）**同一批檔案喺 4 分鐘內被改寫最少 5 次**，而且**輸出互不相同**：

```
22:37:06  locations.geojson = 86499c87bd49b9f2   （穩定態 A）
22:37:2x  locations.geojson = 0c89291b8e1d8d93   （態 B）
22:37:3x  locations.geojson = 97f32c9def77f0b2   （態 C）
22:38:xx  locations.geojson = 4798377f27becfc2   （態 D）
22:39:xx  locations.geojson = 51febb851bb8...    （態 E）
```

- 同時 `artifacts/b4/zone-membership.json` 亦同步換（`a8c4d1bb` → `ae17005c` → `65d9dbcb`）。
- 呢啲唔係「撕裂讀取」（JSON 每次都完整可解析），而係**多個唔同版本嘅輸出**。
- 成因最可能係隊友**邊改 script 邊重跑**（`git status` 顯示 `anchor_locations_from_text.py`、`audit_coordinate_integrity.py`、`audit_location_coords.py`、`audit_release.py` 同時被改）。
- **後果**：任何「現況判定」都會喺幾秒內失效。→ 所有 DA 判定都以**我凍結嘅具名快照**為準（見 §6），並喺結論標明快照 hash。
- **建議**：宣佈「凍結窗口」（停止寫入 `data/public`），先做最終驗收。否則 DA8/DA9 無法給出唯一答案。

### 0.2 誰係 writer？—— 已排除我自己（沙盒隔離證明）

有隊友懷疑 22:37–22:41 嘅寫入可能來自我嘅 `da9_driver.sh`。**已排除**：

```bash
# repo 靜止時：記錄 mtime → 跑沙盒 pipeline 一次 → 再記錄
data/public/locations.geojson      1790261013 → 1790261013   ✅ 冇變
data/public/zones.geojson          1790261014 → 1790261014   ✅ 冇變
artifacts/b4/zone-membership.json  1790261013 → 1790261013   ✅ 冇變
# 沙盒 log 顯示實際寫入路徑：
寫入 C:\Users\User\Desktop\benggong\artifacts\c4-spatial\idem\data\public\zones.geojson
```

→ pipeline 用 **cwd 相對路徑**；`cd artifacts/c4-spatial/idem` 之後全部寫入沙盒。證據：`artifacts/c4-spatial/{iso-0.txt,iso-1.txt,iso-run.log,sandbox-isolation-check.log}`。
→ **寫入者係第三方**（最可能係隊友修 G1 時重跑 pipeline）。我已同 C5 互相核對，雙方都唔係。

**附帶教訓（寫入風暴嘅破壞力實錄）**：我一度見到 `data/public/locations.geojson`（`41e097cf`）同 `public/data/public/locations.geojson`（`85d973c7`）唔同，以為「兩個副本唔同步」。**結果係誤報** —— 官方 `python scripts/sync_public_data.py --check` 顯示兩個目錄其實 `一致：12、要更新：0`；我讀到嘅差異只係並行 writer 喺兩個目錄嘅**寫入時間差（~24 s）**造成嘅中間態。→ **已撤回，冇寫入 §4**。（真正「唔一致」嘅係 build 產物 `dist/data/public`，屬正常狀態。）
→ **結論**：喺呢個寫入風暴環境下，連一個 hash 比對都會畀出錯誤結論 —— 更加證明必須先凍結窗口。

### 0.3 最終快照（22:45）亦確認同一結論

第三個獨立快照（`locations=41e097cf`）跑兩次：**run1 ≠ run2，仍然只有 `zone-membership.json` 唔同**（`60050096` → `133c3577`），6 個 data 檔 run1 == run2。
→ 三個獨立快照（HEAD、live、final）結果一致 → **§4.12 嘅根因判定穩健**。

---

## 1. 執行摘要 — DA1–DA9 判定

| # | 斷言 | 判定 | 證據（可重跑） |
|---|---|---|---|
| **DA1** | 所有 geojson feature 有 `coordinate_source` / `coordinate_review_status` / `coordinate_confidence` | **PARTIAL** | 見 §1.1（`null` 已修，餘 route 頂層） |
| **DA2** | `zone_type` enum 合法 | **PASS** | 48/48 合法（`survivor_zone` 11、`infected_nest` 21、`contested` 16）；`kind→zone_type` 映射一致 |
| **DA3** | `event.zone_id` 覆蓋率 ≥85% | **PASS** | 1632/1796 = **90.87%** |
| **DA4** | 每個 zone 有 `dossier_id` 且可 join | **PASS** | 48 zone ↔ 48 dossier，0 懸空、0 孤兒 |
| **DA5** | `infected_nest` 冇 `governance` 假資料 | **PASS** | 21 個 nest 全部有 `nest_profile`，0 個有 `governance`/`society`/`infrastructure` |
| **DA6** | `zones.geojson.evidence` 唔含小說原文 | **PASS** | 擴大 pattern 掃描 0 命中；修復已由 C5 commit（`d6da697`），見 §4.5 |
| **DA7** | R1–R8 規則 pytest 全綠 | **PASS** | R1–R8 全部 `fail=0`；`test_spatial_integrity.py` **36 passed / 1 deselected**（deselect 嘅係會寫 `data/public` 嘅 idempotency 測試） |
| **DA8** | Marker 塌縮：≥5 成員簇已散佈 | **FAIL** | **10 個 ≥5 成員簇、共 171 個 location 仍然完全同座標**；其中 8 簇（142 個）全部 `inferred_from` → **永久鎖死**。R6 門檻（非推斷 >20）報 0 fail → gate 綠燈但實際疊埋。見 §4.1、§4.11（修復後仍 FAIL，已重驗） |
| **DA9** | Pipeline idempotent | **FAIL** | 由 **HEAD** 跑：run1 ≠ run2（**只剩** `zone-membership.json`）；由 **live 快照** 跑：run1 ≠ run2（同樣只剩 zm）。根因已由「`from`/`distance_m` 漂移」轉為「**zm 內嵌 input SHA-256**」→ 見 §4.9、§4.12 |

**統計**：PASS 6、PARTIAL 1（DA1）、**FAIL 2（DA8、DA9）**。

> ⚠️ **2026-09-24 22:2x 更新**：期間有人（回應我 §3.1 建議）為 `anchor_locations_from_text.py` 加咗 `apply_offsets()` 環形偏移。**好處**：我 §4.1 嘅塌縮大致修好、§4.2 嘅 7 個 `null confidence` 亦修好（現時 0 個 null）。**代價**：引入咗 DA9 回歸（§4.9）。以下各節已同步更新。
>
> ⚠️ **2026-09-24 22:41 更新（修復後重驗，Task #10）**：
> - §4.9 嘅 **`from`/`distance_m` 漂移已修好** ✅ —— 由 HEAD 跑，`locations.geojson` 嘅 run1 == run2（`b3b67f80`）。
> - **但 DA9 仍然 FAIL**，根因換成 §4.12（zm 內嵌 input hash）。失敗面由「2 個檔」縮到「1 個檔」。
> - **DA8 仍然 FAIL**（10 簇 / 171 個 location，與修復前一樣）。
> - 重驗期間觀察到 **寫入風暴**（§0.1）→ 已無法喺 live repo 上給出唯一判定，全部改以凍結快照為準。

### 1.1 DA1 詳細（為何係 PARTIAL）

```
locations: coordinate_source 704/704, coordinate_review_status 704/704, coordinate_confidence 704/704  ← 已修好
events   : 1796/1796, 1796/1796, 1796/1796
routes   : 0/42, 0/42, 0/42        ← route feature 頂層完全冇呢三個欄位
zones    : 48/48, 48/48, 48/48
```

（早前版本有 7 個 location `coordinate_confidence: null`，加咗 `apply_offsets` 之後已全部修好 → 現時 0 個 null。）

只剩一點扣分：**42 個 route feature 頂層冇呢三個欄位**。合約 §2.1 只要求「route **waypoint**」要有 → waypoint 層面 100% 有（抽驗 `routes.geojson` waypoint 有齊 `coordinate_source`/`coordinate_review_status`/`coordinate_confidence`/`spatial_evidence_count`）。所以嚴格按矩陣字面（"feature"）係 FAIL，按合約（waypoint）係 PASS → 我判 **PARTIAL**。

重跑：
```bash
python artifacts/c4-spatial/da_checks.py        # → artifacts/c4-spatial/da-checks.json
```

---

## 2. 錨定驗證（`coordinate_source == "text_landmark"`）

> ⚠️ **修復後數量變化**：原本 **10** 個（含 `梁潔華小學`）；加咗 `apply_offsets` 之後 `梁潔華小學` **失去 `coordinate_anchor`**（見 §4.10）→ 現時 **9** 個。下表保留 10 個嘅完整核對（歷史證據），並標明現況。

### 2.1 逐個核對（OSM 元素真偽）

核對方法：喺 `data/private/cache/osm-hk.json`（198,300 個 element）搵 `name:zh` 對應元素，比對類別／地址／座標。

```bash
python artifacts/c4-spatial/verify_anchors.py   # → artifacts/c4-spatial/anchor-osm-verify.json
```

| location | 錨（OSM 元素） | OSM 類別 | 錨座標 == OSM 質心 | 判定 |
|---|---|---|---|---|
| 將軍澳廣場二樓超級市場 | 將軍澳廣場 | `way/28104309` **landuse=residential** | ✅ | ⚠️ 名稱啱，但揀錯 polygon（見 §4.4） |
| 吉野家（將軍澳廣場二樓） | 將軍澳廣場 | 同上 | ✅ | ⚠️ 同上 |
| 將軍澳廣場二樓超市 | 將軍澳廣場 | 同上 | ✅ | ⚠️ 同上 |
| 新都城中心三期 | 新都城中心三期 | `way/302740027` shop=mall | ✅ | **✅ 正確** |
| 哈姆雷特百貨公司 | 新都城中心一期 | `way/28109546` landuse=residential | ✅ | ✅ 位置啱（`relation` 標錯，見 §3） |
| 梁潔華小學 | 新都城中心三期 | `way/302740027` shop=mall | ✅ | **❌ 錨錯（見 §4.3）** |
| 皇室區 | 新都城二期 | `way/28109599` landuse=residential | ✅ | ✅ 有文字支持（dossier：「皇宮即新都城二期商場」） |
| 新都城二期 | 新都城二期 | 同上 | ✅ | **✅ 正確** |
| 新都城中心三期賭場 | 新都城中心三期 | shop=mall | ✅ | ✅ 合理（賭場喺商場內） |
| 不法者監獄 | 仁興工業大廈 | `way/135187088` landuse=industrial，駿才街 33 | ✅ | **✅ 正確**（dossier：「位於將軍澳工業邨仁興工業大廈」） |

**錨名本身嘅 OSM 存在性**：5 個錨名（將軍澳廣場、新都城中心三期、新都城中心一期、新都城二期、仁興工業大廈）**全部真實存在**。冇「錨去唔存在嘅元素」嘅個案。

**錨錯個案：1 個**（梁潔華小學，§4.3）。**次級問題：3 個**（錨揀咗住宅 polygon 而非商場，§4.4）。

### 2.2 一個關鍵限制（誠實記錄）

`build_landmark_index()` 對「同名多筆」取**面積最大**嗰筆。香港「商場 + 住宅」綜合體嘅住宅地塊面積通常大過商場建築 → 錨會落喺住宅地塊。實測：

- 將軍澳廣場：住宅 `way/28104309`（114.262760, 22.308841，被選中）vs 商場 `way/126392621`（114.262869, 22.309186，**實際被錨嘅係呢個**）→ 差 ~37 m
- 新都城中心一期：住宅 `way/28109546`（被選中）vs 商場 `way/302740028` → 差 ~30 m

---

## 3. `relation: adjacent` 兩個個案嘅判斷

`anchor_locations_from_text.py` 嘅 `relation_of()` 用「錨名前後 ±14 字窗口」有冇 `左邊/右邊/對面/附近/旁邊/上蓋…` 決定 `at` / `adjacent`。

### 個案 1：哈姆雷特百貨公司 — `relation: adjacent`（我判：**標籤錯，但座標啱**）

> 描述：「哈姆雷特百貨公司**位於新都城中心一期**，與三期商場只隔一條馬路」

- 主句係「**位於**新都城中心一期」→ 百貨公司**就係**喺一期入面 → 座標設成一期係**正確**。
- 但 `relation` 判成 `adjacent`，因為 ±14 字窗口撈到「隔一條馬路」—— 嗰句其實形容**三期**，唔係一期。
- **結論**：座標合理；`relation` 標籤係**假陽性**（窗口跨界撈錯子句）。

### 個案 2：梁潔華小學 — `relation: adjacent`（我判：**座標錯，唔可以接受**）

> 描述：「據瓦安所說**位於新都城中心三期左邊、只隔一條馬路**的小學」

- 文字**明確否定**「小學 == 商場」：小學喺商場**左邊、隔一條馬路**。
- 但座標被設成**新都城中心三期嘅質心**（114.256992, 22.322438），即**同商場完全同一個像素**。
- 後果：(a) 使用者喺高 zoom 見到「小學」標記坐喺商場上面；(b) 兩個 marker 疊埋，點唔開（見 §4.1）。
- **結論**：**唔合理，要修**。

### 3.1 更好嘅做法（建議）

1. **`relation == "adjacent"` 時用確定性方向偏移**：由文字抽出方位詞（`左邊`→西、`右邊`→東、`對面`→最近馬路對側、`附近`→固定方位），套一個固定距離（建議 120–200 m），並寫入 `coordinate_anchor.offset_m` / `bearing`。
   - 一石二鳥：既保留「喺隔籬」嘅語意，又**順手解決塌縮**（§4.1）。
2. **禁止兩個唔同 location 寫入完全相同座標**：直接重用 `audit_location_coords.py` 規則 1b 已有嘅 id-hash 環形偏移（40–220 m）。而家**兩套錨定機制做法唔一致** —— 舊機制有偏移，新機制冇。
3. **`relation` 要由「子句」推導**：只喺「位於／設於」同一子句內（以標點切分）搵方位詞，唔好用固定 ±14 字窗口跨界。
4. **優先錨去真實同類地標**：`梁潔華小學` 係現實學校名。若 OSM 有 `amenity=school` 同名元素應優先採用；呢個 export 冇（0 hits），所以只可以靠文字 → 咁就**更加唔應該**當佢係商場。

---

## 4. 新發現（腳本捉唔到嘅問題）

> 以下**唔重複**任何審計腳本嘅輸出（R1–R8、text-consistency、location-coords 嘅 findings）。

### 4.1 【P1，部分修復】文字錨定嘅 marker 塌縮（R6 門檻捉唔到）

**原始問題**：`anchor_locations_from_text.py` 第一版直接寫地標精確座標、零偏移 → 3 組座標完全相同：

```
114.262760,22.308841 → 將軍澳廣場二樓超級市場 / 吉野家（將軍澳廣場二樓）/ 將軍澳廣場二樓超市
114.256992,22.322438 → 新都城中心三期 / 梁潔華小學 / 新都城中心三期賭場
114.258518,22.322959 → 皇室區 / 新都城二期
```

- R6 門檻係「非推斷 > **20** 個」，呢啲得 2–3 個 → **R6 永遠捉唔到**。
- 而 `audit_location_coords.py` 規則 1b **有**做 id-hash 環形偏移（40–220 m）；`anchor_locations_from_text.py` **冇**。同一件事、兩套唔一致嘅實作。

**現況（2026-09-24 22:2x）**：已加 `apply_offsets()`（40 + 30×i，上限 220 m；`adjacent` 固定 120 m）→ **3 組已散開**。
**但仍有殘留（22:41 重驗：仍然存在）**：

```
114.256992,22.3228 → 新都城中心三期 (loc_0364) / 梁潔華小學 (loc_0376)   ← 仍然完全同座標（實測距離 0.0 m）
```

- 原因一（§4.10）：`梁潔華小學` 失去 `coordinate_anchor` → 唔再入 `fixes` → 冇被偏移。
- 原因二（§4.14）：`apply_offsets` 嘅碰撞避免用「6 位小數完全相等」比對，但 `loc_0364` 嘅候選點算出嚟係 `22.322799` vs 被佔用嘅 `22.3228` → **差 0.000001°（~0.1 m）當成唔撞**。
- → **DA8 唔算完全達標**（重驗後仍 FAIL）。

> ⚠️ 更大範圍嘅同類問題見 **§4.11**：`inferred_from` 地點被兩個塌縮機制同時跳過 → **171 個 marker（10 個 ≥5 簇）永久疊埋**。本節嘅 3 組只係其中可見嘅一小部分。

### 4.2 【已修復】7 個錨定 location 嘅 `coordinate_confidence` 曾經係 `null`

**原始問題**：`loc_0241/0242/0259/0364/0376/0443/0467` 嘅 `coordinate_confidence = null`，`coordinate_anchor` 亦缺 `confidence` key。
根因：`infer_zone_membership.py:502-506` 直接讀 `coordinate_anchor.confidence`，**冇 fallback**：

```python
p["coordinate_confidence"] = (
    (p.get("coordinate_anchor") or {}).get("confidence")   # ← key 唔存在 → None
    if p.get("coordinate_anchor")
    else _confidence_of_precision(...)
)
```

- **閘門盲區**：`data/schemas/location.schema.json` **完全冇定義** `coordinate_*` 欄位；`validate_public_data.py` 對 location 只檢 `coordinate_source` / `coordinate_review_status` 兩個 enum，**唔檢** `coordinate_confidence`。→ `null` 可以一路出到街。
- **而且唔會自癒**：`anchor_locations_from_text.py --dry-run` 當時報 **0 個建議修正**。

**現況**：新腳本對所有 `fixes` 寫 `coordinate_confidence = r["confidence"]` → 現時 **0 個 null**。
**殘留風險**：`location.schema.json` 同 `validate_public_data.py` 嘅盲區**未補** —— 下次再有上游欄位缺失，仍然會靜默出街。建議加 schema + 非 null 斷言。

### 4.3 【P1】梁潔華小學被錨死喺商場（語意錯置）

見 §3 個案 2。補充證據：`data/private/cache/osm-hk.json` 搜「潔華」→ **0 個學校**（只有無關嘅「黃民鄧潔華伉儷環球學生薈」）。即係文字係**唯一**證據，而文字明講「喺商場左邊、隔一條馬路」。

### 4.4 【P2】地標索引偏向「面積最大」，令 3 個錨落喺住宅地塊而非商場

見 §2.2。系統性偏差 ~30–40 m。對「寶琳／坑口」尺度無傷大雅，但同 DA8「標記要分得開」互相抵觸（兩個綜合體嘅商場／住宅會攞到唔同但相近嘅點）。

### 4.5 【P1，跨域】4 階段 pipeline 曾經會重新引入小說原文（C5 已修，已 commit）

- 用 **C5 改動之前**嘅 `merge_zone_dossiers.py` 喺沙盒跑：`zones.geojson` 嘅 `大本營.population` = `百多人（ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」）` —— **小說原文**。
- 來源：`merge_str()` 取「最長字串」，agent `A4.json` 帶住引文，`A3/A7.json` 係乾淨版 → 揀中最長 = 帶引文版。
- 原本三個偵測器只捉「`原文`」字樣 → `ch0092：「…」`（**冇「原文」二字**）**逃逸**。
- **現況**：C5 已加 `scripts/sanitise_public_data.py` + `merge_zone_dossiers.py` 階段 4.5，並**已 commit**（`d6da697 fix(data): 修版權紅線逃逸`）。
- 我獨立驗證：擴大 pattern 掃全部 public 檔 **0 命中**；沙盒由 production 輸入跑兩次嘅輸出 **== production**（7 檔 SHA-256 全對）→ DA6 目前**真 PASS**。
- 殘留風險：`merge_str()` 本身仍然係「取最長」→ 消毒係**事後補救**而唔係源頭治理。若日後新增 agent 欄位帶引文，仍然要靠 sanitise 執手尾。建議長遠令 `merge_str()` 對含引文版本降權。

### 4.6 【P2，流程】`data/public/**` 非原子就地寫入 → 讀者會見到撕裂狀態

實測：`pytest tests/test_spatial_integrity.py` 連續兩次報

```
FAILED tests/test_spatial_integrity.py::test_no_rule_fails
E  AssertionError: 規則失敗：['R3_zone_membership']
```

同一時間直接呼叫 `audit.run_all_rules()` 卻係 `pass`。等 pipeline 寫完之後再跑，**36 passed**。
根因：`merge_zone_dossiers.py` 逐個檔案就地覆寫；期間任何讀者（CI、其他審計員）會讀到「一半新一半舊」→ 假 fail。
證據：`artifacts/c4-spatial/pytest-spatial-integrity.out`（fail）vs `pytest-spatial-integrity-clean.out`（pass）。
建議：寫入用 temp file + `os.replace()` 原子換。

### 4.7 【P2】`legacy` source 但 `exact` precision + 0.95 confidence + `needs_validation`（12 個）

```
loc_0337 聖安得肋堂   prec=exact conf=0.95 source=legacy review=needs_validation
loc_0415 寧養院…     prec=exact conf=0.95 source=legacy review=needs_validation
…（共 12 個，全部係「依附於X」子地點）
```

四個欄位語意互相矛盾：`source=legacy`（冇證據）卻 `precision=exact` + `confidence=0.95`，而 `review=needs_validation`（未驗證）。前端會同時顯示「高信心」同「位置未確認」。`position_source` 其實寫住「依附於…（由描述配對）」—— 呢個係**證據**，但 `coordinate_source` 嘅回填規則（`infer_zone_membership.py:488-493`）只認 `inferred_from` / 「校正」字樣 → 一律打 `legacy`。屬分類學落差。

### 4.8 【已核實正常】海洋公園（唯一非 TKO 嘅非隱藏點）

`loc_0712 海洋公園` 距離將軍澳 **11.3 km**，但描述明寫「海洋公園**位於港島區**」→ 文字支持，**唔係錯**。（記錄落嚟係防止下一個審計員當佢係 outlier。）

---

### 4.9 【P0 → **已修復 ✅**】`apply_offsets` 引入 DA9 回歸：`coordinate_anchor.from` / `distance_m` 每次重跑都漂移

> **2026-09-24 22:41 重驗結論：已修好。** 隊友已改「補」pass 用 `prev.get("from")` / `prev.get("distance_m")` 保留第一次錨定嘅事實。我喺沙盒重驗：**由 HEAD 跑，`locations.geojson` 嘅 run1 == run2 == run3（`b3b67f80d1ba…`）**。原本嘅漂移已消失。
> **但 DA9 仍未 PASS** —— 剩低嘅非冪等來源換咗，見 **§4.12**。以下保留原始分析作歷史記錄。

**症狀**：`test_pipeline_is_idempotent` FAIL（C5 亦獨立報咗）：
`locations.geojson: 171884f9 → eceee036`、`zone-membership.json: 33fbc3c8 → 8ee41be4`。

**我嘅沙盒重現**（由 `HEAD` 抽 `data/public` 入沙盒，跑 4 次）：

```
run1 locations sha256: b0f70de19e20 | zone-membership: a3eb588e67ae
run2 locations sha256: 960e2167ec6a | zone-membership: f5fadf3ebd07
run3 locations sha256: 960e2167ec6a | zone-membership: f5fadf3ebd07
run4 locations sha256: 960e2167ec6a | zone-membership: f5fadf3ebd07
```

→ **run1 ≠ run2**（唔符合「重跑兩次一致」），第 3 次才收斂。

**根因（精準）**：新加嘅「補」pass（`anchor_locations_from_text.py:296-319`）用**當前座標**做 `from`：

```python
cur = (f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1])
fixes.append({... "from": [round(cur[0],6), round(cur[1],6)], ...})
```

於是每次重跑，`from` 同 `distance_m` 都會再漂移一次：

| | `from` | `distance_m` |
|---|---|---|
| run1 | 地標基準座標 `114.26276,22.308841` | 0.1 |
| run2+ | **已偏移座標** `114.26276,22.309203` | 40.1 |

- **座標本身唔郁**（9 個錨定全部移動 0.0 m）—— 即係**只有 metadata 唔穩定**，但足以令 idempotency 測試紅。
- 副作用：`coordinate_anchor.from` 嘅原意係「錨定**之前**嘅座標（審計用）」，但 run2 之後 `from` 變成「已偏移座標」→ `distance_m` 退化成等同 `offset_m`，**審計資訊永久丟失**（原本嘅 515.9 m 等偏移量已經冇咗）。
- 由 `HEAD` 跑先會紅；若 `data/public` 已收斂（第 2 次之後）就會綠 → **即係 HEAD 唔係 pipeline 嘅不動點，fresh checkout 跑 CI 一定紅**。

**建議修法**（一行）：喺「補」pass 用已儲存嘅原值，而唔係當前座標：

```python
origin = anc.get("from") or cur          # 有就沿用，唔好再取 cur
...
"from": [round(origin[0], 6), round(origin[1], 6)],
"distanceM": round(dist_m(origin, base), 1),
```

咁 run1 寫入 `from` 之後，run2 會讀返同一個 `from` → 穩定。修完之後要**重跑一次 pipeline 再 commit** `data/public`，令 HEAD 成為不動點。

### 4.10 【P1，新】`梁潔華小學` 失去 `coordinate_anchor`，退回 `cross_chapter_evidence` 且仍疊喺商場

> **22:41 重驗：狀態不變。** `loc_0376` 仍然 `coordinate_anchor=None`、`coordinate_source=cross_chapter_evidence`、座標 `[114.256992,22.3228]` == `loc_0364`（距離 **0.0 m**）。

加咗偏移之後，`loc_0376 梁潔華小學` 嘅狀態變成：

```
coordinate_source      : text_landmark  →  cross_chapter_evidence   （降級）
coordinate_anchor      : 有             →  冇                        （消失）
coordinate_confidence  : 0.85           →  0.55
coord                  : [114.256992, 22.3228]  ← 同 loc_0364 新都城中心三期 完全一樣
inferred_from          : inf_loc_0376（仍然存在）
```

- 失去 anchor → 「補」pass 跳過佢 → **永遠唔會被偏移** → 佢同商場繼續疊埋（§4.1）。
- 同時 `coordinate_source` 由 `text_landmark` 降級 → 前端顯示嘅證據等級下降，`relation: adjacent` 嘅資訊亦冇咗。
- **根因（C5 精確定位，我已複核屬實）**：唔係 `apply_place_inferences.py` 清嘅，而係 **`anchor_locations_from_text.py:330-341` 自己主動 `pop`**：

```python
# ⚠️ 清理：inferred_from 非空嘅地點唔應該有 coordinate_anchor
stale = [f["properties"]["id"] for f in doc["features"]
         if f["properties"].get("inferred_from") and f["properties"].get("coordinate_anchor")]
for f in doc["features"]:
    if f["properties"]["id"] in stale:
        f["properties"].pop("coordinate_anchor", None)
```

加上「補」pass（`:302`）`if ... or p.get("inferred_from"): continue` → 跳過佢 → **冇偏移** → 仍然同 `loc_0364` 同座標。
- 互斥不變式我亦複核：全 dataset `inferred_from` 非空 = **260** 條，其中同時有 `coordinate_anchor` = **0** 條。
- **建議**：唔好靠 `coordinate_anchor` 存在與否做閘；另外要為 `inferred_from` 地點設計去重偏移（見 §4.11），否則呢類碰撞永遠修唔到。



### 4.11 【P0，新】171 個 marker 永久疊埋：`inferred_from` 令塌縮機制完全失效（DA8 FAIL 主因）

> **22:41 重驗**：數字**完全不變**（10 簇 / 171 個 / 8 簇鎖死 / 142 個）—— 修復**冇覆蓋**呢類簇。`python artifacts/c4-spatial/collapse_locked.py`。

**量化（矩陣 DA8 判準：≥5 成員簇要散佈）**：

```
≥5 成員簇          : 10 個，共 171 個 location
  其中全部 inferred_from（永久鎖死）: 8 個簇，142 個 location
  最大簇            : 89 個 location @ 114.25343,22.30581（大本營一帶）
  其次              : 24 個 @ 114.2415,22.3229（寶琳）、11 個 @ 114.25332,22.30547（D座大樓）
R6 門檻（非推斷 >20）= fail 嘅簇 : 0   ← gate 綠燈
```

**為何永久鎖死（兩重機制都跳過 `inferred_from`）**：

1. `infer_zone_membership.fix_marker_collapse()` **明文跳過** `inferred_from`（規則 C2，由 `test_r6_collapse_skips_inferred_locations` 把關）。
2. `anchor_locations_from_text` 嘅「補」pass 亦跳過（`:302`），並主動 `pop` 佢哋嘅 `coordinate_anchor`（`:330-341`）。
3. `audit_coordinate_integrity` 嘅 **R6 只計「非推斷」成員**（門檻 >20）→ 對鎖死簇完全冇反應。

→ 結果：**89 個地點（大本營：醫療室／圖書館／中央廣場／三樓儲物室…）全部畫喺同一點**，而所有 gate 都綠燈。呢個正正係專案當初要修嘅「靜默疊埋」。

**注意**：`inferred_from` 鎖定本身係**刻意設計**（要維持 `test_applied_coordinates_match_inference`：套用座標 == 推斷記錄座標）。所以呢個唔係「邊個寫錯」，而係**設計缺口**：塌縮修復冇覆蓋推斷鎖定嘅地點。

**建議**（三選一）：
1. **最正**：喺**上游** `apply_place_inferences.py` 落偏移，並把偏移後嘅座標寫入推斷記錄 → 不變式仍然成立，同時散開。
2. 為 `inferred_from` 地點設**另一條去重偏移**，並同步更新推斷記錄。
3. 至少令 **R6 改為對「任何 ≥5 成員簇（唔分推斷與否）」出 warning/fail**，唔好再靜默。



### 4.12 【P0，新】DA9 真正殘留根因：`zone-membership.json` 內嵌「輸入檔 SHA-256」→ 單次跑唔可能係不動點

**精準定位（逐欄 diff 兩次輸出）**：由 HEAD 跑，run1 同 run2 **只有一個檔唔同**，而且**只有一個欄位**：

```
DIFF /inputs/events.geojson    '715ec0210948…' -> 'fcae79a680dd…'
DIFF /inputs/locations.geojson '639bfb201af4…' -> 'b3b67f80d1ba…'
（其餘 6 個輸出檔、`zone-membership.json` 嘅其餘所有欄位：完全一致）
```

- `artifacts/b4/zone-membership.json` 嘅 `inputs` 區塊**記低自己嘅輸入檔 hash**（`infer_zone_membership.py:757` 寫 `report`，`inputs` 由讀入時計算）。
- 所以：**只要輸入未收斂，run1 會改寫 `data/public` → run2 讀到嘅輸入 hash 唔同 → zm 唔同**。
- 收斂序列（沙盒實測，由 HEAD）：

```
run1 zone-membership = 9f70b08fba99   ← 記錄 HEAD 輸入 hash
run2 zone-membership = dcfd87af2af0   ← 記錄 run1 輸出 hash  ★收斂
run3 zone-membership = dcfd87af2af0
```

- **由 live 快照跑亦一樣**：`live run1 ≠ run2`，diff **只有** `zone-membership.json`（`56ad946e` → `8c3e27b8`）。
- **由已收斂輸入跑就 PASS**：沙盒 seed = 當時 repo 狀態（`data/public` 已係不動點）→ run1 == run2（7/7 檔）→ `test_pipeline_is_idempotent` 會綠。

**結論**：`test_pipeline_is_idempotent` **只在 `data/public` 已經係不動點時才會 PASS**。而 `HEAD`（已 commit 嘅基準）**唔係**不動點 → **fresh checkout 跑 CI 一定紅**。所以矩陣 DA9 字面（「重跑兩次結果一致」）仍然 **FAIL**。

**為何唔可以當佢係「無害嘅 provenance 欄位」**：矩陣嘅驗收命令係 `pytest tests/test_spatial_integrity.py`，而 `PIPELINE_OUTPUTS` 包含呢個報告檔。報告檔既然係 pipeline 輸出，就必須符合冪等。

**建議（三選一，由好到差）**：
1. **唔好把「輸入 hash」寫入 pipeline 輸出**（另存 `artifacts/b4/inputs.json`，或改寫成「唔參與比對」嘅 sidecar）。
2. 或者：**commit 一次已收斂嘅 `data/public` + `artifacts/b4/zone-membership.json`**，令 HEAD 成為不動點（治標，但可即時令 CI 綠）。
3. 至少喺 `test_pipeline_is_idempotent` 明確 exclude `inputs` 欄位，並加註解解釋（唔建議 —— 等於放寬門檻）。

**重跑證據**：
```bash
bash artifacts/c4-spatial/da9_driver.sh head artifacts/c4-spatial/idem/input-head 2   # run1≠run2（zm）
bash artifacts/c4-spatial/da9_driver.sh live artifacts/c4-spatial/idem/input-live 2   # run1≠run2（zm）
bash artifacts/c4-spatial/da9_driver.sh repo artifacts/c4-spatial/idem/input-work 2   # run1==run2（7/7）
python artifacts/c4-spatial/reverify_summary.py                                        # → artifacts/c4-spatial/reverify-summary.json
```

### 4.13 【P1，新】`coordinate_anchor.from` 退化：`from == coord`（5–8 / 9 個）

`coordinate_anchor.from` 嘅**設計原意**（見腳本註解）係「錨定**之前**嘅座標（第一次嘅），審計用」。但實測**大部分錨定 location 嘅 `from` 等於偏移後嘅最終座標**，即係 `from == coord` 但 `offset_m > 0` —— **自相矛盾**（位移 0 但有 40 m 偏移）。

```
loc_0241 將軍澳廣場二樓超級市場  off=40  from=[114.26276,22.309203] == coord  ← 退化
loc_0364 新都城中心三期        off=40  from=[114.256992,22.3228] == coord  ← 退化
…（live 快照 5 個、22:3x 快照 7–8 個，數字隨每次重跑變）
loc_0467 新都城中心三期賭場      off=70  from=[114.256151,22.321986] ≠ coord   ← 正常
```

- 後果：**審計欄位永久失去資訊**（無法再知原本喺邊、真正位移幾多）；`distance_m` 亦退化成等同 `offset_m`（如 `40.1` / `70.1` / `120.0`）。
- 成因：`from` 由 `prev.get("from")` 保留 —— 但上一版腳本**冇寫** `from`，反而喺「補」pass 用**當前（已偏移）座標**寫入，於是「第一次」被污染成偏移後值。
- **修法**：由一個「冇 `from` 污染」嘅乾淨輸入（例如 `HEAD`）重跑一次；或令 `from` 一旦寫入就**唔可以被偏移後值覆蓋**（現行已做，但污染已經入咗檔）。
- 沙盒對照：由 HEAD 重跑，`from` = 真正原座標（例：`loc_0241 from=[114.26276,22.308841]`、`distance_m=515.9`）→ 語意正確。

### 4.14 【P1，新】錨定偏移值跨 run 唔穩定（`loc_0552` 0↔40 m、`loc_0364` 40↔100 m）

同一份 `data/public` 輸入，喺唔同凍結快照見到**唔同嘅 `offset_m`**：

```
loc_0552 不法者監獄     offset_m = 40.0（22:3x）   vs  0.0（22:39 live）
loc_0364 新都城中心三期   offset_m = 40.0（22:38）   vs 100.0（22:37 態 B）
```

- 原因：`apply_offsets` 嘅**碰撞避免**用「當前 `occupied` 集合」決定半徑（撞到就 +30 m 重試）。
- ⚠️ **而碰撞避免會漏**：`occupied` 用 `round(…, 6)` 比對，但候選點 `base + 40 m` 算出嚟係 `22.322799`，而被佔用點係 `22.3228` → **差 0.000001°（約 0.1 m）→ 當成唔撞**。實測 `loc_0364` 因此仍然同 `loc_0376 梁潔華小學` **完全同座標**（見 §4.1、§4.10）。
- 即係話：腳本註解自稱「實測…碰撞避免…撞到就加大半徑重試」**對呢個個案冇生效**（因為 rounding 邊界）。
- **建議**：碰撞比對改用「距離 < 門檻（例如 15 m）」而唔係「6 位小數完全相等」；並把 `occupied` 改成包含所有地點（連 `fixes` 內成員嘅**目標**位置）。





## 5. 未解決風險 / 建議

| 優先 | 風險 | 建議 |
|---|---|---|
| **P0** | **DA8 FAIL**：171 個 marker（10 個 ≥5 簇）永久疊埋，`inferred_from` 令兩個塌縮機制都跳過（§4.11） | 喺上游 `apply_place_inferences.py` 落偏移並寫入推斷記錄；或為 `inferred_from` 地點設獨立去重偏移 |
| **P0** | **DA9 仍 FAIL**：`zone-membership.json` 內嵌 input SHA-256 → 由未收斂輸入跑，run1 ≠ run2（§4.12） | ① 唔好把輸入 hash 寫入 pipeline 輸出；② 或 commit 已收斂嘅 `data/public` + zm 令 HEAD 成為不動點 |
| **P0** | **寫入風暴**：22:37–22:41 觀察到 `data/public` 被改寫 ≥5 次、輸出互不相同 → 無法做唯一驗收（§0.1） | 宣佈凍結窗口（停止寫 `data/public`）先做最終驗收 |
| **P1** | `coordinate_anchor.from` 退化（`from == coord`，5–8/9）（§4.13） | 由乾淨輸入（HEAD）重跑一次；令 `from` 不可被偏移後值覆蓋 |
| **P1** | 錨定偏移值跨 run 唔穩定 + 碰撞避免因 rounding 失效（§4.14） | 碰撞比對改「距離 < 15 m」，唔用 6 位小數相等 |
| **P1** | `梁潔華小學` 失去 `coordinate_anchor` → 退回 `cross_chapter_evidence`、仍疊喺商場（§4.10） | 錨定唔好依賴 `coordinate_anchor` 存在；令 `inferred_from` 同 `coordinate_anchor` 兩個機制唔會互相清走 metadata |
| **P1** | 7 個 `coordinate_confidence=null` 曾經靜默出街（現已修，但**閘門盲區未補**）（§4.2） | ① `location.schema.json` 加 `coordinate_confidence: number`；② `validate_public_data.py` 加「非 null」斷言；③ `backfill_locations` 加 fallback |
| **P1** | 錨定 2–3 個 marker 塌縮低於 R6 門檻（§4.1） | R6 加「**任何**非推斷 ≥2 且屬唔同 location_type 就 warn」；確保每個 location 都有偏移（見上兩項） |
| **P1** | 梁潔華小學錨死喺商場（語意）（§4.3） | 用 `relation` 推導方向偏移；`relation` 改由子句推導 |
| **P1** | 4 階段 pipeline 曾經重引入原文（現已由 C5 `d6da697` 修復）（§4.5） | `merge_str()` 對含引文版本降權，令消毒由「事後補救」變成「源頭治理」 |
| **P2** | 地標索引偏向住宅地塊（§4.4） | 同名多筆時，**類別優先序**（shop=mall > landuse=residential）先於面積 |
| **P2** | 非原子寫入 → 撕裂讀取（§4.6） | `tempfile` + `os.replace()` |
| **P2** | `legacy`+`exact`+0.95+`needs_validation` 語意矛盾（§4.7） | 統一 `coordinate_confidence` 同 `coordinate_review_status` 嘅關係；`needs_validation` 唔應該配 0.95 |

---

## 6. 重跑指引（全部命令）

```bash
# 三個官方審計腳本（唔寫 data/public）
python scripts/audit_coordinate_integrity.py                       # → artifacts/b4/coordinate-audit.json
python scripts/audit_coordinate_text_consistency.py --json artifacts/c4-spatial/coord-text-consistency.json
python -c "import sys;from pathlib import Path;sys.path.insert(0,'scripts');import audit_location_coords as a;\
a.AUDIT_OUT=Path('artifacts/c4-spatial/location-coord-audit.json');sys.argv=['x','--dry-run'];a.main()"

# 獨立驗證
python artifacts/c4-spatial/verify_anchors.py                      # OSM 錨真偽
python artifacts/c4-spatial/da_checks.py                           # DA1–DA8 + 新發現
python scripts/anchor_locations_from_text.py --dry-run             # 證明 0 自癒

# DA7（排除會寫 data/public 嘅 idempotency 測試）
python -m pytest tests/test_spatial_integrity.py \
  --deselect tests/test_spatial_integrity.py::test_pipeline_is_idempotent -q
npx vitest run tests/event-map-hidden.test.ts

# DA9（沙盒，唔掂 production）—— 修復後重驗
bash artifacts/c4-spatial/da9_driver.sh head artifacts/c4-spatial/idem/input-head 2   # 由 HEAD 輸入（git show HEAD:data/public/*）
bash artifacts/c4-spatial/da9_driver.sh live artifacts/c4-spatial/idem/input-live 2   # 由即時凍結快照
bash artifacts/c4-spatial/da9_driver.sh repo artifacts/c4-spatial/idem/input-work 2   # 由已收斂輸入 → run1==run2
# 逐欄 diff 兩次輸出（搵出「只有 inputs.* 唔同」）
python -c "import json;a=json.load(open('artifacts/c4-spatial/da9-head-h1.json'));b=json.load(open('artifacts/c4-spatial/da9-head-h2.json'));print({k:(a[k][:12],b[k][:12]) for k in a if a[k]!=b[k]})"

# DA8 塌縮（矩陣判準：≥5 成員簇）
python artifacts/c4-spatial/collapse_locked.py                       # → artifacts/c4-spatial/collapse-locked.json

# 匯總重驗
python artifacts/c4-spatial/reverify_summary.py                      # → artifacts/c4-spatial/reverify-summary.json
```

**凍結快照（證據）**：
- `artifacts/c4-spatial/idem/input-head/data/public/` — `git show HEAD:data/public/*`（未修復前基準）
- `artifacts/c4-spatial/idem/input-work/data/public/` — 22:3x 穩定態（`locations=86499c87`）
- `artifacts/c4-spatial/idem/input-live/data/public/` — 22:39 live 凍結（`locations=51febb85`）
- `artifacts/c4-spatial/idem/input-final/data/public/` — 22:45 最終凍結（`locations=41e097cf`）
- 逐次 hash：`artifacts/c4-spatial/da9-{head,work,repo,live,final}-h{1,2}.json`
- 沙盒隔離證明：`artifacts/c4-spatial/{iso-0.txt,iso-1.txt,iso-run.log}`

**產出**：`artifacts/c4-spatial/`（`prod-snapshot.json`、`da-checks.json`、`anchor-osm-verify.json`、`pytest-*.out`、`da9-*.json`、`da9m-head-zm{1,2,3}.json`、`reverify-summary.json`、`collapse-locked*.json`、`*.out`）。

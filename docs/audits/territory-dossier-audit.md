# A6 Worldbuilding Data Architect — 區域／Dossier 資料審計（World Atlas V2）

> 只讀審計。所有數字由 `artifacts/audit-A6/*.py` 程式化實測產生，非估計。
> 未修改任何 `src/**`、`data/**`、`public/**`、`tests/**`、`scripts/**`、config。
> 未讀取 `data/private/**`。本報告**不輸出小說正文**（只報欄位有／無、長度、數量）。
> 所有建議**不得**包含人手覆核或人手補寫世界觀。

---

## 任務摘要

| 項目 | 實測結論 |
|---|---|
| `zones.geojson` | 48 個 Polygon（**全部 Polygon**，37 個 48 邊形近似圓 + 11 個凸包） |
| `kind` 分佈 | `survivor` 11／`nest` 21／`outpost` 16（**冇** `quarantine`／`contested`／`transit`） |
| spec §2.4 `zone_type` | **完全冇**。現有 `kind` 可 1:1 映射（`survivor→survivor_zone`、`nest→infected_nest`、`outpost→contested`） |
| spec 要求欄位缺口 | `status`、`danger_level`、`spatial_precision`、`display_style`、`event_ids`、`character_ids`、`dossier_id`、`review_status` —— **全部完全冇**（8 項） |
| Dossier 位置 | **冇** `zone-dossiers.json`；dossier 內容 inline 喺 `zones.geojson.properties` |
| Dossier 核心欄位（6 項） | 有 1 個以上 evidence：43/48；**5 個 zone 六項全空**；17 個 zone 核心欄 ≤2/6 |
| 病窩（nest）專用欄位 | `threats` 20/21、`notable_features` 16/21、`summary` 21/21（病窩替代欄位策略**可行**） |
| Zone ↔ Event 關聯 | events 只有 `location_id`，**冇** `zone_id`；經 location 反推只有 **674/1796（37.5%）** |
| Zone ↔ Character 關聯 | **冇** `character_ids`；經 event 反推 115/173 角色、33/48 zone |
| 可程式化重建 dossier 嘅證據來源 | `chapter-summaries.json` 有 877 條 location 摘要，可 join 到 **40/48** zone；只有 **2/48** zone 三種來源全空 |
| 現有驗證 | `python scripts/validate_public_data.py` ✅ 通過（schema + 引用一致性 + 治理掃描 + manifest + provisional gate） |

**核心結論**：現有 zone 資料**內容豐富但 schema 落後**。dossier 文字（政權／社會／經濟／國防／文化）對主要 zone 有實質 evidence，但 **schema 完全未對齊 spec §2.4**，而且 **zone↔event/character 關聯係斷嘅**（只有單向 name-match）。V2 必須做 versioned schema migration + 由現有 public 資料**程式化**生成關聯與 dossier，**不可補寫 fiction**。

---

## 假設與證據

### 假設

1. **A1**：`zones.geojson` 係 zone 嘅唯一真相來源（`derive_zones.py` 同 `merge_zone_dossiers.py` 都寫同一個檔；後者係現行版本，前者係舊版）。
2. **A2**：`locations.geojson` 嘅 `zone_ids` 係 zone↔location 嘅既有反向連結（由 `merge_zone_dossiers.py` 產生）。
3. **A3**：`kind_votes` 係 8 個子代理（`.zones-task/out/A*.json`）對 `kind` 嘅票數，屬可稽核 metadata。
4. **A4**：spec §2.4 要求嘅 `zone-dossiers.json` 尚未存在，inline 內容係現階段唯一 dossier 載體。
5. **A5**：`chapter-summaries.json[chapter].locations[]` 每條有 `id`（location id）、`name`、`summary`、`confidence`，可經 `location.zone_ids` join 去 zone。

### 證據（實測指令）

```bash
python artifacts/audit-A6/analyze_zones.py            # 欄位填充率 / kind / confidence / dossier 缺口
python artifacts/audit-A6/analyze_relations.py        # zone↔location↔event↔character 覆蓋率
python artifacts/audit-A6/analyze_evidence_sources.py # 可程式化重建 dossier 嘅來源覆蓋率
python artifacts/audit-A6/inspect_zones.py            # 結構化欄位樣本（唔含正文長引）
python scripts/validate_public_data.py                # 現況驗證（用 python3.12，見下）
```

環境註：預設 `python`（3.13.14）**冇** `jsonschema`；要跑 `validate_public_data.py` 必須用
`C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe`（3.12.10，有 `jsonschema` 4.23.0）。
**此環境落差必須喺 V2 pipeline 文件講清楚，否則 CI 會靜默失敗。**

---

## 發現／改動

### 3.1 Zone schema 逐欄填充率表（實測 48 個 zone）

`present` = key 存在；`filled` = 有實質內容（非 `null`／非 `""`／非 `"unknown"`／非空陣列／字串 ≥4 字元）。

| 欄位 | present | filled | 填充率 | 備註 |
|---|---:|---:|---:|---|
| `id` | 48 | 48 | 100% | `^zone_[0-9a-f]{10}$` |
| `name` | 48 | 48 | 100% | ⚠️ 表列 41 係「<4 字元」誤判，實際 48/48（短名如「大本營」「鼠窩」） |
| `kind` | 48 | 48 | 100% | enum `survivor\|nest\|outpost` |
| `kind_votes` | 48 | 48 | 100% | 多代理票數 |
| `aliases` | 48 | 40 | 83.3% | 8 個 zone 冇別名 |
| `chapters` | 48 | 48 | 100% | 平均 8.8 章 |
| `first_appearance` | 48 | 48 | 100% | = `min(chapters)` |
| `location_hint` | 48 | 42 | 87.5% | |
| `government` | 48 | 29 | **60.4%** | dossier 核心 |
| `leadership` | 48 | 33 | **68.8%** | 15 個係空陣列 `[]` |
| `social_structure` | 48 | 33 | **68.8%** | dossier 核心 |
| `economy` | 48 | 21 | **43.8%** | dossier 核心，最低之一 |
| `defense` | 48 | 27 | **56.2%** | dossier 核心 |
| `population` | 48 | 22 | **45.8%** | dossier 核心，最低之一 |
| `culture` | 48 | 29 | **60.4%** | dossier 核心 |
| `notable_features` | 48 | 39 | 81.2% | 病窩替代欄位 |
| `threats` | 48 | 44 | **91.7%** | 病窩替代欄位，最高填充率 |
| `summary` | 48 | 48 | 100% | 平均 143.8 字（spec 要求 overview ≤180 字，**吻合**） |
| `evidence` | 48 | 48 | 100% | 平均 159.5 字（**只可留 private 級別引用**，見風險） |
| `confidence` | 48 | 48 | 100% | 0–1，**全部有值** |
| `radius_m` | 48 | 48 | 100% | |
| `radius_source` | 48 | 48 | 100% | `members` 11／`default` 37 |
| `coords_source` | 48 | 48 | 100% | `locations` 47／`locations_prefix` 1 |
| `coords_evidence` | 48 | 48 | 100% | |
| `range_evidence` | 48 | 48 | 100% | |
| `sources` | 48 | 48 | 100% | 代理來源清單 |
| `source` | 48 | 48 | 100% | const `bing_gang` |

**幾何實測**：全部 48 個係 `Polygon`。環頂點分佈：49 頂點 × 37（48 邊形圓，對應 `radius_source=default`）、4–8 頂點 × 11（凸包，對應 `radius_source=members`）。
→ 即係**只有 11 個 zone 嘅範圍係由成員分佈證據推導**，其餘 37 個係按類型預設半徑（估算）。**呢個係 `spatial_precision` 嘅天然來源。**

### 3.2 `kind` 分佈、`kind_votes` 意思與可信度

- `kind` 值域：`survivor`（人類聚居／安全）、`nest`（病者巢穴／危險）、`outpost`（敵對組織據點）。
  - 語義定義見 `data/schemas/zone.schema.json:41-44`。
  - ⚠️ `derive_zones.py:49-56` 曾將「據點／根據地」歸 `nest`；`merge_zone_dossiers.py:58` 則用 `outpost`。**兩支腳本對「據點」嘅分類唔一致**，現行資料（`outpost`）以 `merge_zone_dossiers.py` 為準。
- `kind_votes`：8 個子代理對 `kind` 嘅多數票分佈，合併規則見 `merge_zone_dossiers.py:416-419`（取最高票，同票時按 `KIND_ORDER` 取先者）。
- 可信度實測：**43/48 一致（票數單一）**，5 個有分歧，平均一致度 **0.958**。
  | zone | kind | votes | 一致度 |
  |---|---|---|---:|
  | 大本營 | survivor | `{nest:1, outpost:2, survivor:8}` | 0.73 |
  | 靈實醫院 | nest | `{nest:4, outpost:2, survivor:1}` | 0.57 |
  | 聖安得肋堂 | nest | `{nest:1, outpost:1}` | 0.50 |
  | 詭區 | outpost | `{outpost:2, survivor:1}` | 0.67 |
  | 翠林村倖存區 | survivor | `{outpost:2, survivor:2}` | 0.50（同票，靠 `KIND_ORDER` 決定） |

→ **規則化結論**：`kind_votes` 一致度 = `最高票 / 總票`，可直接做 `kind` 嘅 confidence 因子。一致度 <1.0 嘅 5 個 zone 應標 `review_status=needs_validation`（見 §3.7）。

### 3.3 Schema 落差對照表（spec §2.4 vs 實測）

| spec §2.4 欄位 | 實測狀態 | 可映射來源 | 處置 |
|---|---|---|---|
| `id` | ✅ 已有 | — | keep |
| `name` | ✅ 已有 | — | keep |
| `zone_type` | ❌ 完全冇 | `kind`（`survivor→survivor_zone`、`nest→infected_nest`、`outpost→contested`） | **新增 + 由 `kind` 程式化遷移** |
| `status` | ❌ 完全冇 | 冇可靠來源 | **新增，預設 `unknown`；只可程式化推導** |
| `danger_level` | ❌ 完全冇 | 可由 `zone_type` + `threats` 數量推導 | **新增，標 `auto_inferred`** |
| `spatial_precision` | ❌ 完全冇 | `coords_source` + `radius_source` | **新增 + 程式化遷移** |
| `display_style` | ❌ 完全冇 | 可由 `zone_type` 決定 | **新增，由 theme token 生成** |
| `chapter_refs` | ✅ 可映射 | `chapters`（同義） | **改名／加 alias** |
| `event_ids` | ❌ 完全冇 | 可經 `location.zone_ids` 反推（覆蓋率低） | **新增 + `infer_zone_membership.py` 生成** |
| `character_ids` | ❌ 完全冇 | 可經 event/route 反推 | **新增 + 程式化生成** |
| `dossier_id` | ❌ 完全冇 | 可由 `zone.id` 生成 | **新增** |
| `confidence` | ✅ 已有（0–1） | — | keep，但改為**確定性重算**（見 §3.7） |
| `review_status` | ❌ 完全冇 | — | **新增 + 程式化判定** |

Dossier schema（spec §2.4）vs 現有 inline 欄位：

| spec dossier 欄位 | 現有 inline 對應 | 狀態 |
|---|---|---|
| `overview` | `summary` | ✅ 可映射（長度吻合 ≤180） |
| `governance.system` | `government` | ✅ 可映射 |
| `governance.authority` | `leadership` + `government` 內文 | 🟡 部分（要拆欄） |
| `governance.legitimacy` | — | ❌ 冇獨立欄位 |
| `society.population_structure` | `social_structure` | ✅ 可映射 |
| `society.daily_life` | `economy` + `population` | 🟡 部分 |
| `society.culture` | `culture` | ✅ 可映射 |
| `infrastructure.security` | `defense` | ✅ 可映射 |
| `infrastructure.resources` | `economy` | ✅ 可映射 |
| `infrastructure.mobility` | — | ❌ 冇（`location_hint` 只有部分） |
| `risk_profile.threats` | `threats` | ✅ 可映射 |
| `risk_profile.danger_level` | — | ❌ 冇 |
| `key_characters` | — | ❌ 冇（要 join 生成） |
| `chapter_refs` | `chapters` | ✅ 可映射 |
| `confidence` | `confidence` | ✅ 可映射（需重算） |
| `review_status` | — | ❌ 冇 |

**落差總計**：13 個 spec 欄位之中，**已有 2、可映射 5、完全冇 6**。

### 3.4 Dossier 策略決定：**抽出獨立 `zone-dossiers.json`，`zones.geojson` 保留幾何 + 索引**

實測體積（minify 後）：

| 內容 | 體積 | gzip 估算 |
|---|---:|---:|
| `zones.geojson` 全量（現況） | 102 KiB | — |
| 幾何 + 索引欄位（id/name/kind/chapters/radius/coords_source/confidence…） | **58 KiB** | — |
| dossier 文字欄位（gov/soc/eco/def/pop/cul/feat/threats/summary/evidence…） | **45 KiB** | 36 KiB |

（來源檔 `zones.geojson` 現為 pretty-print 239 KiB；minify 後 102 KiB。）

**三方案比較**：

| 方案 | 優點 | 缺點 |
|---|---|---|
| **A. inline 保留（現況）** | 零 migration；單一請求 | 幾何 + 文字耦合；地圖 layer 必須下載全部 dossier 文字；schema 版本無法獨立演進；spec §2.4 明文要求獨立檔，**不符 spec** |
| **B. 抽出獨立檔（建議）** | 幾何層 58 KiB 先載，dossier 45 KiB 按需 lazy-load（click zone 才 fetch）；layer 分離清晰；dossier schema 可獨立 version；符合 spec | 多一個請求；需要 join key（`zone_id`） |
| **C. 兩者並存（inline 保留 + 另出獨立檔）** | 兼容舊前端 | **雙重真相**，兩個檔會漂移；違反「現有 code 唔係真相」同避免雙軌嘅原則 |

**建議：方案 B（抽出獨立檔），但採 versioned migration，唔即時刪 inline。**

理由（按 spec 原則）：
1. spec §2.4 明文要求 `data/public/zone-dossiers.json` → 直接符合。
2. §0.3 北極星要求「click zone → 打開 dossier」= **on-demand**；分檔正好配合 lazy-load，避免首屏下載 45 KiB 純文字。
3. §5.4 要求 zone layer 有獨立視覺語言；幾何層唔應該孭 dossier 文字。
4. `zone.schema.json` 同 dossier schema 生命週期唔同（前者跟座標 pipeline，後者跟文字抽取 pipeline），分檔先可以各自 version。
5. 「零人手參與」要求可重跑：分檔後 `build_zone_dossiers.py` 可以獨立重跑而唔影響幾何。

**Migration 方案（versioned，可重跑、可回滾）**：

```text
v1（現況）  zones.geojson 內 inline dossier 欄位
             ↓  scripts/migrate_zone_schema_v2.py（新增）
v2          zones.geojson   → 幾何 + 索引欄位 + dossier_id + zone_type + review_status…
            zone-dossiers.json → { version:"2.0.0", dossiers:[{id, zone_id, overview, governance{...}, ...}] }
```

- `zones.geojson` 加 `"schema_version": "2.0.0"`（FeatureCollection 頂層）。
- `zone-dossiers.json` 加 `"schema_version": "2.0.0"` + `"generated_from": {"zones": "<sha256>", "chapter_summaries": "<sha256>"}`（AGENTS.md 要求來源 + hash）。
- 舊欄位**保留一個 version 週期**做 fallback，但前端 adapter **只讀 v2 欄位**；下個 version 才刪 inline 文字欄位（避免雙軌長期存在）。
- 回滾：保留 `zones.v1.geojson` 一個 release（或 git tag），migration script 支援 `--revert`。

### 3.5 Dossier 資料缺口清單（核心交付）

**逐欄位填充率**（同 §3.1）；**逐 zone 缺口**見 `artifacts/audit-A6/zone-dossier-gap-table.md`。

**缺口分級**：

| 級別 | 定義 | 數量 | 清單 |
|---|---|---:|---|
| 🔴 完全缺口 | 6 個核心欄位（gov/soc/eco/def/pop/cul）**全空** | **5** | 彩明商場病腦巢穴、死亡之路、寶翠公園、心朗村、靈實禮拜堂 |
| 🟠 嚴重缺口 | 核心欄位 ≤2/6 | 17 | 上述 5 個 + 將軍澳中心、圓玄第三中學、將軍澳商場、皇冠假日酒店病巢、將軍澳區、病者之都、寶盈花園、將軍澳華人永遠墳場、彩明商場、李惠利大樓、鼠窩、海洋公園 |
| 🟡 部分缺口 | 核心欄位 3–5/6 | 22 | 其餘（見 artifact） |
| 🟢 資料充足 | 核心欄位 6/6 | 7 | 靈實醫院、聖安得肋堂、皇室區、病者平權組織、不法者監獄、靈實協會寧養院、翠林村倖存區、病獵公會（部分 8–9 欄） |

**逐 zone 9 欄填充分佈**：`{0:2, 1:2, 2:3, 3:7, 5:3, 6:9, 7:4, 8:11, 9:7}`（**冇 zone 得 4 欄**）。

**⚠️ 關鍵缺口：2 個 zone 連任何替代來源都冇**
| zone | kind | 核心欄 | chapter-loc 摘要 | events | 處置 |
|---|---|---:|---:|---:|---|
| 寶翠公園 | nest | 0/6 | 0 | 0 | 只能標 `needs_validation`，UI 顯示「資料未足以確認」 |
| 靈實禮拜堂 | nest | 0/6 | 0 | 0 | 同上 |

（其餘 3 個「核心全空」zone —— 彩明商場病腦巢穴、死亡之路、心朗村 —— 仍有 chapter-loc 摘要或 events 可程式化重建。）

**病窩（`infected_nest`）用咩欄位？**

spec §2.4 要求病窩用「威脅特徵、活動模式、影響範圍、關聯事件」代替政權／民生。實測 `kind=nest` 21 個：

| 病窩替代欄位 | 有填 | 填充率 | 對應 spec |
|---|---:|---:|---|
| `threats` | 20/21 | **95.2%** | 威脅特徵 ✅ |
| `notable_features` | 16/21 | 76.2% | 活動模式／場景 ✅ |
| `summary` | 21/21 | 100% | 概述 ✅ |
| `government` | 5/21 | 23.8% | ⚠️ **不應填**（病窩冇政權）；呢 5 個係誤填或混合型 zone |

→ **結論**：病窩替代欄位策略**已有實質 evidence 支持**，`threats` + `notable_features` + `summary` 覆蓋良好。
→ **但**：現時 5 個 nest 有 `government` 值（例如「病者國度」等混合型），前端**必須**按 `zone_type` 決定顯示邊組欄位 —— `infected_nest` **唔顯示** governance／society，改顯示 threats／features／活動模式。
→ **「活動模式」同「影響範圍」目前冇獨立欄位**：可程式化由 `chapters`（活動章節範圍）+ `radius_m`（影響範圍）+ `threats` 推導，標 `auto_inferred`。

**其他資料品質缺口（實測，非 fiction）**：

1. **`summary` 可能唔對應 zone 本體**：實測「大本營」嘅 `summary` 內容係講「多媒體地下攝影棚」（子區域），屬 `merge_zone_dossiers.py` 合併子區域時嘅 artifact。→ 建議加 `summary_source_zone` 或喺 `build_zone_dossiers.py` 用「本體 location」重新生成 overview。
2. **`characters.json` 全部 330 個角色 `description` 都係模板字串**「全書 N 章出現；詳情待人手審閱。」→ 即 **`key_characters` 冇實質描述可用**；而且文案含「人手審閱」字眼，**違反零人手參與原則**（屬 A1/A3/A9 範圍，A6 只作資料缺口標記）。
3. **`map-config.json` `provisional_mode.banner` 含「仍待人工審閱」** → 同上，違反零人手原則。
4. **`evidence` 欄位 100% 填充且平均 159.5 字，內含 `chN 原文：「…」` 引用** → ⚠️ **有機會觸及版權紅線**（public dossier 只可留短摘要 + chapter refs，evidence excerpt 只可留 private）。`validate_public_data.py` 嘅長 CJK run 檢查（>100 連續 CJK）目前**通過**，但 spec §2.4 明文「evidence excerpt 只留 private」→ **建議 v2 將 `evidence` 移去 private 或改為純 chapter ref 陣列**。

### 3.6 `unknown` policy 設計（全部可程式化）

**原則**：UI 顯示「資料未足以確認」，唔顯示空洞假資料。**判定規則必須可程式化**，唔可以人手填。

#### (a) 每個 dossier 欄位「有 evidence」判定規則

```python
EMPTY = {"", "unknown", "未知", "n/a", "na", "none", "null", "-", "—", "不詳", "待定"}

def has_evidence(v, *, min_len=8, min_items=1, min_item_len=2):
    if v is None: return False
    if isinstance(v, str):
        s = v.strip()
        return s.lower() not in EMPTY and len(s) >= min_len
    if isinstance(v, list):
        return len([x for x in v if isinstance(x, str) and len(x.strip()) >= min_item_len]) >= min_items
    return False
```

| 欄位 | min_len / min_items | 額外條件 |
|---|---|---|
| `government` `social_structure` `economy` `defense` `culture` | ≥8 字 | zone 必須有非空 `evidence` 或 `chapters` |
| `population` | ≥4 字 | 同上 |
| `leadership` | ≥1 項，每項 ≥2 字 | 排除空陣列 `[]` |
| `notable_features` `threats` | ≥1 項 | 同上 |
| `summary` | ≥20 字 | 否則視為 placeholder |

**Field-level `review_status`**（每個 dossier 欄位獨立標）：
- `validated`：`has_evidence()` 為真 **且** 有 `chapters` 引用
- `needs_validation`：`has_evidence()` 為假（即顯示「資料未足以確認」）
- 唔存在「部分」狀態 —— 二元判定，可稽核。

#### (b) Zone-level `review_status` 值域與轉換條件

值域：`validated | auto_inferred | needs_validation`

| 值 | 程式化條件（全部要成立） |
|---|---|
| `validated` | `coords_source == "locations"` **且** `radius_source == "members"` **且** 核心欄位 ≥4/6 有 evidence **且** `kind_votes` 一致度 == 1.0 **且** `validate_public_data.py` pass |
| `auto_inferred` | 有座標證據（`coords_source ∈ {locations, locations_prefix, district, osm}`）**但** `radius_source == "default"` **或** 核心欄位 1–3/6 |
| `needs_validation` | `coords_source == "unknown"` **或** 核心欄位 0/6 **或** `kind_votes` 有分歧（一致度 <1.0） |

實測推算：`validated` ≈ 7、`needs_validation` ≈ 22（5 個核心全空 + 5 個 kind 分歧 + 其餘低填充）、`auto_inferred` ≈ 19。（具體數字由 `build_zone_dossiers.py` 重算。）

#### (c) `confidence` 計算方式（唔可以人手填）

**確定性加權公式**：

```text
confidence = 0.40 * coord_score
           + 0.40 * dossier_score
           + 0.20 * kind_score

coord_score   = 1.0 if radius_source=="members"
              = 0.5 if radius_source=="default" 且 coords_source!="unknown"
              = 0.0 if coords_source=="unknown"
dossier_score = (# 核心欄位有 evidence) / 6        # 病窩改用 (threats+features+summary)/3
kind_score    = kind_votes 最高票 / 總票
```

- 全部輸入都係 data 欄位，**冇任何常數係人手填**。
- 結果 round 到 2 位小數，寫入 `confidence`；同時寫 `confidence_inputs`（三個分數）做可稽核。
- ⚠️ 現況 `confidence` 係 8 個代理嘅平均值（`merge_zone_dossiers.py:490-491`），**唔透明**；v2 應改為上述公式。

### 3.7 Zone 與其他資料嘅關聯（join 路徑 + 覆蓋率實測）

**實測現狀**：

| 關係 | 現有欄位 | 覆蓋率 |
|---|---|---:|
| `zone → location` | （冇正向欄位；只有 `locations.zone_ids` 反向） | 46/48 zone 有 location 連到 |
| `location → zone` | `locations.zone_ids` | **88/704（12.5%）** |
| `zone → event` | ❌ 冇 `event_ids` | 經 location 反推 **674/1796（37.5%）** |
| `zone → character` | ❌ 冇 `character_ids` | 經 event 反推 115/173（66.5%）角色、**33/48 zone** |
| `zone → chapter` | ✅ `chapters` | 48/48 |

**問題根源**：`merge_zone_dossiers.py:552-557` 只做 **name/alias 精確配對**（location name == zone name 或 alias）→ 所以只有 88 個 location 有 `zone_ids`。呢個係**最細嘅 join 面**，令 event／character 反推全部被壓低。

**建議 join 路徑（全部程式化、可重跑）**：

```text
① zone ──(zone.name/aliases ⊂ location.name 前綴，或 location.zone_ids 已存在)──> location
   由 scripts/infer_zone_membership.py 生成，規則：
     a. 既有 location.zone_ids（精確配對）
     b. location.name 包含 zone.name 或 alias（子字串匹配）
     c. location 座標落喺 zone polygon 內（point-in-polygon，幾何證據）
     d. 由 (b)(c) 得到嘅 location，經 zone.chapters ∩ location.chapters 時間一致性過濾
   三層證據寫入 location.zone_ids + location.zone_membership_source

② zone.event_ids ← { event.id | event.location_id ∈ zone 嘅 location 集合 }
   預期覆蓋率由 37.5% 提升（因為 location 覆蓋率由 12.5% 升）

③ zone.character_ids ←
     a. { c | c ∈ event.characters, event ∈ zone.event_ids }   （直接出現）
     b. { c | route.waypoints[].location_id ∈ zone 嘅 location 集合 }（路線經過）
   兩者 union，並寫 character_zone_source

④ zone.chapter_refs ← chapters（同義改名）

⑤ dossier.key_characters ← character_ids ∩ characters.json，只保留角色名 + chapter_refs；
   ⚠️ 因 characters.json description 係模板（§3.5 缺口 2），**唔可以**生成人物描述 → 只列名 + 章節。
```

**預期提升**（可由 `infer_zone_membership.py --dry-run` 實測）：location 覆蓋率由 12.5% 升至 ≥40%（point-in-polygon 會納入大量落喺 zone 範圍內嘅 location）。**唔可以硬編數字，必須實跑。**

**⚠️ 唔可推導嘅嘢**：如果 event 冇 `location_id`（實測 16 個），或 location 冇座標，則**唔可以**靠猜測歸入任何 zone → 標 `unknown`。

### 3.8 Zone layer / 互動設計（spec §2.4 + §5.4）

**Layer control 清單**（6 個，對應 spec）：

| Layer | 內容 | 預設 |
|---|---|---|
| `倖存區` | `zone_type=survivor_zone`（11） | ON |
| `病窩／危險區` | `infected_nest`（21）+ `contested`（16）+ `quarantine` | ON |
| `事件` | `events.geojson` Point | OFF |
| `角色旅程` | `routes.geojson` LineString + waypoint | OFF |
| `時期` | 章節／時期 filter（作用於上列 layer） | OFF |
| `地圖細節` | base map LOD（道路／地名／輪廓） | ON |

**互動行為**：

| 狀態 | 行為 | Reduced-motion |
|---|---|---|
| `hover`（polygon） | outline glow + tooltip（name、zone_type、danger_level、status）；tooltip 用 fixed 定位唔遮地圖中心 | 唔用 glow 動畫，只加 2px outline |
| `click`（polygon） | 打開 Zone Dossier context panel（desktop 右 panel / mobile bottom sheet） | panel 無 transition |
| `selected` | 其他 zone soft-focus（opacity 0.25）；突出 zone boundary + internal landmarks + related events/routes | 直接切換，無 fade |
| dossier 內 | 可跳去 `相關事件`、`相關角色`、`時間軸`、`返回世界地圖` | — |
| 資料不足 zone | 顯示「資料未足以確認」+ 仍可睇幾何 + chapter refs；**唔顯示空 dossier 欄位** | — |

**Legend 規則（必須 color + pattern + icon 三者並用，唔可以只靠色）**：

| 類型 | color（fill） | pattern | icon | 動效（可關） |
|---|---|---|---|---|
| 倖存區 | 冷青 `#3FB6A8` | 結構化 solid + 低頻同心 contour | 盾／營地 | 穩定 beacon（低頻） |
| 病窩 | 危險紅 `#C0392B` | **斜線 hatch** + noise drift | 病毒／巢 | 低頻呼吸 pulse |
| 隔離區 | 警示琥珀 `#D9A441` | **警示斜線** + 虛線 gate | 閘／鎖 | 無 |
| 爭議地帶 | 雙色 `#8E44AD`+`#2C3E50` | **broken boundary / 雙色 contour** | 交叉劍 | 無 |
| 未知區 | 低對比灰 `#6B7280` | **fog / dotted** | 問號 marker | 無 |
| 基建／資源節點 | 冷藍 `#4A90D9` | 點陣 | 齒輪／天線 | 無 |

> 所有 pattern 用 SVG `<pattern>` / CSS `repeating-linear-gradient`，vector 實作 → 任何 zoom 保持清晰（符合 §5.4「所有特效需使用 vector / CSS pattern」）。

**圖例原型**：`artifacts/audit-A6/zone-legend-proposal.svg`（color + pattern + icon 三通道）。

### 3.9 B4 pipeline 設計建議（spec §2.2 vs 現有 `scripts/`）

| spec §2.2 要求腳本 | 現況 | 建議 |
|---|---|---|
| `audit_coordinate_integrity.py` | ❌ 冇（有 `audit_location_coords.py`，只審 location 座標） | **新寫**：合併現有 `audit_location_coords.py` 邏輯，擴展到 zone polygon + route waypoint + event-location coherence；輸出 `coordinate_audit.json` |
| `infer_zone_membership.py` | ❌ 冇 | **新寫**：三層 join（既有 zone_ids / 名稱子字串 / point-in-polygon）+ 時間一致性過濾；寫 `location.zone_ids` + `event.zone_id` |
| `validate_spatial_narrative.py` | ❌ 冇（有 `validate_public_data.py` 做 schema/引用一致性） | **新寫**：zone↔event↔route 空間敘事一致性（事件落喺 zone 外、route 跳躍無 evidence、zone 重疊衝突） |
| `build_zone_dossiers.py` | ❌ 冇（有 `merge_zone_dossiers.py`，做 inline 合併） | **新寫**（可由 `merge_zone_dossiers.py` 擴展）：生成獨立 `zone-dossiers.json` + `zone_type`/`danger_level`/`review_status`/`confidence` 重算 |
| `render_coordinate_audit_report.py` | ❌ 冇（有 `build_final_report.py`） | **新寫**：讀 `coordinate_audit.json` → 粵文 markdown / HTML 報告 |

**可重用嘅現有腳本**：
- `scripts/merge_zone_dossiers.py` —— 合併邏輯（`merge_str`/`merge_list`/`kind_votes`）可直接搬入 `build_zone_dossiers.py`。
- `scripts/audit_location_coords.py` —— 座標審核邏輯可擴展為 `audit_coordinate_integrity.py`。
- `scripts/propagate_location_coords.py` —— event/timeline/route 座標傳播可重用。
- `scripts/derive_zones.py` —— ⚠️ **舊版**，同 `merge_zone_dossiers.py` 對「據點」分類唔一致，建議 v2 明確標為 deprecated 或刪除（避免雙軌）。
- `scripts/validate_public_data.py` —— 需**擴展**：加 `zone-dossiers.json` schema 驗證、zone↔dossier 引用一致性、`zone_type`/`review_status` enum 檢查。
- `scripts/build_public_dataset.py` —— 需加 `zone-dossiers.json` 到輸出清單 + manifest counts。

**⚠️ 現有零人手違規（需主代理處理，A6 只標記）**：
- `scripts/apply_location_corrections.py` 讀 `data/private/review/location-corrections.json`（「人手核實嘅地點修正」）→ 違反零人手原則，需改為程式化規則或明確標為 private-only 一次性輸入。
- `characters.json` 全部 description 含「人手審閱」；`map-config.json` banner 含「人工審閱」。

### 3.10 P0 / P1 / P2 分級

**P0（阻塞 spec §0.3 北極星驗收，必須喺 B4 前解決）**
1. `zone_type`、`status`、`danger_level`、`spatial_precision`、`display_style`、`dossier_id`、`review_status` 全部缺失 → 加 versioned schema migration。
2. 冇獨立 `zone-dossiers.json` → spec §2.4 明文要求，必做。
3. `event_ids`／`character_ids` 缺失 + location 覆蓋率僅 12.5% → zone↔event 只有 37.5%，Journey B「睇相關事件」會空洞 → 必寫 `infer_zone_membership.py`。
4. 2 個 zone（寶翠公園、靈實禮拜堂）完全冇任何來源 → UI 必須有「資料未足以確認」狀態，唔可以假造 dossier。

**P1（影響產品質素，應喺 B4／B6 完成）**
5. `confidence` 由代理平均值改為確定性公式（§3.6c）。
6. 病窩 `infected_nest` 專用欄位（活動模式、影響範圍）冇獨立欄位 → 由 chapters/radius/threats 推導。
7. `summary` 唔對應 zone 本體（大本營案例）→ 用本體 location 重新生成 overview。
8. `evidence` 內含 `chN 原文：「…」` → 版權紅線風險，應移 private 或改為 chapter ref 陣列。
9. `kind_votes` 分歧（5 個）→ 標 `needs_validation`。

**P2（改善項）**
10. `zone.schema.json` 需同步更新（新增欄位 + `zone_type` enum）。
11. `derive_zones.py` vs `merge_zone_dossiers.py` 分類唔一致 → 標 deprecated。
12. `characters.json` description 模板化 + 「人手」字眼 → 資料缺口 + 文案違規。
13. `validate_public_data.py` 需擴展至 dossier schema。

---

## 修改檔案

**冇。** 本審計為只讀，未修改任何 production／data／config 檔。

只新增（審計允許範圍 `artifacts/audit-A6/`）：

```text
artifacts/audit-A6/analyze_zones.py             # 欄位填充率 / kind / confidence / dossier 缺口
artifacts/audit-A6/analyze_relations.py         # zone↔location↔event↔character 覆蓋率
artifacts/audit-A6/analyze_evidence_sources.py  # 可程式化 dossier 證據來源覆蓋率
artifacts/audit-A6/inspect_zones.py             # 結構化欄位樣本
artifacts/audit-A6/zone-fill-stats.json         # 逐欄 + 逐 zone 填充統計
artifacts/audit-A6/zone-relation-stats.json     # 關聯覆蓋率
artifacts/audit-A6/zone-evidence-source-stats.json # 證據來源覆蓋率
artifacts/audit-A6/zone-dossier-gap-table.md    # 48 zone × 9 欄缺口表
artifacts/audit-A6/zone-legend-proposal.svg     # color+pattern+icon legend 原型
```

交付：`docs/audits/territory-dossier-audit.md`（本檔）。

---

## 沒有修改但相關的檔案

| 檔案 | 關係 |
|---|---|
| `data/public/zones.geojson` | 審計對象（48 zone inline dossier） |
| `data/public/locations.geojson` | `zone_ids` 反向連結（12.5% 覆蓋） |
| `data/public/events.geojson` | 只有 `location_id`，冇 `zone_id` |
| `data/public/routes.geojson` | waypoint `location_id` 可做 zone↔character 第二來源 |
| `data/public/characters.json` | `key_characters` 來源；description 全部模板化 |
| `data/public/chapter-summaries.json` | **最強 dossier 重建來源**（877 條 location 摘要） |
| `data/schemas/zone.schema.json` | 需 v2 更新（加 spec §2.4 欄位） |
| `scripts/merge_zone_dossiers.py` | 現行 zone 生成器（可擴展為 `build_zone_dossiers.py`） |
| `scripts/derive_zones.py` | 舊版 zone 生成器（分類唔一致，建議 deprecated） |
| `scripts/validate_public_data.py` | 需擴展至 dossier schema |
| `scripts/audit_location_coords.py` | 可擴展為 `audit_coordinate_integrity.py` |
| `scripts/build_public_dataset.py` | 需加 `zone-dossiers.json` 輸出 |
| `data/public/map-config.json` | banner 含「人工審閱」字眼（零人手違規） |
| `src/components/ZoneDossier.ts` | 前端 dossier 組件（192 行），B6 範圍 |
| `src/components/SvgMap.ts` | zone polygon **完全冇 render**（baseline §6.4） |

---

## 驗證命令與結果

```bash
# 1. zone 欄位填充率（實測）
python artifacts/audit-A6/analyze_zones.py
# → 48 zone；kind {survivor:11, nest:21, outpost:16}；
#   kind_votes 一致 43/分歧 5；confidence 全部有值；radius_source {default:37, members:11}

# 2. 關聯覆蓋率（實測）
python artifacts/audit-A6/analyze_relations.py
# → locations zone_ids 88/704(12.5%)；events→zone 674/1796(37.5%)；zone 有 char 33/48

# 3. 證據來源覆蓋率（實測）
python artifacts/audit-A6/analyze_evidence_sources.py
# → chapter-loc 摘要 877 條；可 join 40/48 zone；三來源全空 2/48

# 4. 現況公開資料驗證（需 python3.12，預設 python 3.13 冇 jsonschema）
"C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe" scripts/validate_public_data.py
# → ✅ 全部通過（schema、引用一致性、治理掃描、manifest、provisional gate）
#   review 分佈：{verified:0, reviewed:4626, needs_review:42}

# 5. B4 腳本存在性檢查
# → audit_coordinate_integrity.py / infer_zone_membership.py /
#   validate_spatial_narrative.py / build_zone_dossiers.py /
#   render_coordinate_audit_report.py 全部「缺少」
```

---

## Screenshots / Artifacts

| Artifact | 內容 |
|---|---|
| `artifacts/audit-A6/zone-fill-stats.json` | 27 欄填充率 + 逐 zone dossier 布林矩陣 + kind_votes + confidence 分佈 |
| `artifacts/audit-A6/zone-relation-stats.json` | zone↔location↔event↔character 覆蓋率 + 逐 zone 關聯數 |
| `artifacts/audit-A6/zone-evidence-source-stats.json` | 4 種可程式化來源逐 zone 覆蓋 |
| `artifacts/audit-A6/zone-dossier-gap-table.md` | 48 zone × 9 欄缺口表（✅/·） |
| `artifacts/audit-A6/zone-legend-proposal.svg` | color + pattern + icon 三通道 legend 原型 |
| `artifacts/audit-A6/analyze_*.py` `inspect_zones.py` | 可重跑分析腳本 |

（本審計為資料層，冇 UI screenshot；視覺層屬 A2/A4 範圍。）

---

## 風險、衝突、限制

1. **版權紅線風險（P1）**：`zones.geojson.evidence` 100% 填充且含 `chN 原文：「…」`。spec §2.4 明文「evidence excerpt 只留 private」→ **public dossier 必須移除原文引用**，改為 chapter ref 陣列。`validate_public_data.py` 現時嘅 >100 連續 CJK 檢查**通過**係因為引用被標點中斷，唔代表安全。
2. **雙軌架構風險**：`derive_zones.py` 同 `merge_zone_dossiers.py` 都寫 `zones.geojson`，且對「據點」分類唔一致（`nest` vs `outpost`）。V2 必須只保留一個生成器。
3. **關聯覆蓋率低**：location↔zone 只有 12.5%，令 Journey B/D 嘅「相關事件／角色」空洞。呢個唔可以靠 UI 遮掩，必須寫 `infer_zone_membership.py`。
4. **characters.json description 全模板化**：`key_characters` 只能列名 + 章節，**冇人物描述可用**。唔可以生成。
5. **零人手違規（現況）**：`characters.json` 文案、`map-config.json` banner、`apply_location_corrections.py` 讀 private 人手修正檔 → 需主代理處理。
6. **環境落差**：預設 `python`（3.13.14）冇 `jsonschema`，CI／pipeline 若用預設 python 會靜默失敗。必須喺文件寫死用 python3.12。
7. **不可補寫 fiction**：本報告所有「建議推導」（danger_level、status、活動模式）**必須**標 `auto_inferred`，並保留輸入欄位做稽核。任何無法由 public data 證明嘅值一律 `unknown` / `needs_validation`。
8. **限制**：本審計只讀 `data/public/`，**未讀** `data/private/`（依紅線）。因此唔知 private evidence 有幾多可用於提升 dossier —— 主代理可安排 private-side pipeline（`build_zone_dossiers.py`）讀 private 生成 public 短摘要，但**public 輸出唔可含原文**。

---

## 給主代理的 integration note

1. **Gate 1 需作嘅決定**：採納方案 B（抽出 `zone-dossiers.json`，versioned migration v1→v2），並定義 `zone_type`/`status`/`danger_level`/`spatial_precision`/`display_style`/`review_status` 嘅 enum 同確定性推導規則（§3.6）。
2. **B4 工作包**（新寫 5 支 + 擴展 3 支）：
   - 新寫：`infer_zone_membership.py`（**最高優先，解 37.5% 關聯缺口**）、`build_zone_dossiers.py`、`audit_coordinate_integrity.py`、`validate_spatial_narrative.py`、`render_coordinate_audit_report.py`。
   - 擴展：`validate_public_data.py`（+dossier schema）、`build_public_dataset.py`（+輸出）、`zone.schema.json`（+欄位）。
3. **file ownership**：`scripts/merge_zone_dossiers.py` 建議**由 B4 接管**並改名／擴展為 `build_zone_dossiers.py`；`derive_zones.py` 標 deprecated（避免同 `zones.geojson` 雙軌寫入）。
4. **B6 map interaction 依賴**：zone layer 需要 `zone_type` + `display_style` + `danger_level`（§3.8 legend）。B4 必須先產出呢啲欄位，B6 先可以實作 legend 同 hover/click。
5. **B3 data adapter 依賴**：zone dossier lazy-load 需要 `dossier_id` ↔ `zone_id` 索引；B3 需為 `zone-dossiers.json` 建 `Map<zone_id, dossier>`。
6. **不可交付嘅狀態**：任何 zone 若 `review_status=needs_validation`，UI **必須**顯示「資料未足以確認」而唔可以顯示空白欄位或假資料（spec §0.3 / §5.4「未知區」）。
7. **優先處理零人手違規**：`map-config.json` banner、`characters.json` description、`apply_location_corrections.py` —— 呢三處直接違反 AGENTS.md 紅線，建議 Gate 1 一併處理。

# World Atlas V2 — Spatial Data Contract

> **Gate 1 交付物 5／8** · 狀態：**定稿**
> 依據：spec §2.2、§2.4；A5（空間完整性）、A6（territory/dossier）、A9（state）
> **前提**：`data/private/` 永遠不得讀取、commit、deploy。所有驗證必須程式化、可重跑（AGENTS.md「零人手參與」）。

---

## 1. Schema 落差總表（實測）

| 要求欄位（spec §2.2 / §2.4） | locations | events | routes | zones | 裁定 |
|---|---|---|---|---|---|
| `location_precision` | ✅ 有 | ❌ | ⚠️ 有 `precision` | ❌ | 保留／新增 |
| `coordinate_confidence` | ❌ | ❌ | ⚠️ waypoint 有 | ❌ | **新增（全部 layer）** |
| `coordinate_source` | ❌ | ❌ | ❌ | ⚠️ `coords_source` | **新增** |
| `coordinate_review_status` | ❌ | ❌ | ❌ | ❌ | **新增** |
| `zone_id` | ⚠️ `zone_ids[]` | ❌ | ❌ | n/a | **events 新增** |
| `chapter_refs` | ⚠️ `chapters[]` | ✅ `chapter_refs` | ⚠️ waypoint `chapter` | ⚠️ `chapters[]` | 統一命名 |
| `spatial_evidence_count` | ❌ | ❌ | ❌ | ❌ | **新增** |
| `zone_type` | — | — | — | ❌（只有 `kind`） | **新增 + 映射** |
| `status` | — | — | — | ❌ | **新增** |
| `danger_level` | — | — | — | ❌ | **新增** |
| `spatial_precision` | — | — | — | ❌ | **新增** |
| `display_style` | — | — | — | ❌ | **新增** |
| `event_ids` | — | — | — | ❌ | **新增** |
| `character_ids` | — | — | — | ❌ | **新增** |
| `dossier_id` | — | — | — | ❌ | **新增** |
| `review_status` | ✅ | ✅ | ✅ | ❌ | **zones 新增** |

---

## 2. Coordinate Integrity Schema（v2）

### 2.1 每個 location / event / route waypoint 必須有

```json
{
  "location_precision": "verified|district|approximate|fictional|unknown",
  "coordinate_confidence": 0.0,
  "coordinate_source": "explicit_text|cross_chapter_evidence|zone_inference|legacy|manual_geometry",
  "coordinate_review_status": "validated|auto_corrected|needs_validation|quarantined",
  "zone_id": "zone_xxxxxxxxxx",
  "chapter_refs": [1, 2],
  "spatial_evidence_count": 0
}
```

### 2.2 確定性 backfill 規則（**唔需要 private evidence**，可重跑）

| 目標欄位 | 規則 |
|---|---|
| `coordinate_source` | `inferred_from` 非空 → `cross_chapter_evidence`；否則 `position_source` 含「校正」→ `legacy`；否則 `legacy` |
| `coordinate_review_status` | `coord_corrected === true` → `auto_corrected`；否則 `needs_validation` |
| `coordinate_confidence` | 由 `location_precision` + `spatial_evidence_count` 決定：`verified`=0.95、`district`=0.8、`approximate`=0.55、`fictional`=0.35、`unknown`=0.0 |
| `spatial_evidence_count` | 由 `chapters.length` ∩ zone 內 event 數決定（見 §4.3） |
| `zone_id`（events） | 三層 join（見 §4.2）；無法確定 → `null` + `needs_validation` |

> **規則 C1**：**唔可以**用「猜」修正座標。無法自動證明 → 標 `unknown` / `approximate` + `needs_validation`，並喺 UI 顯示精度。
> **規則 C2**：`coord_corrected` **唔可以**覆蓋 `inferred_from`（現有 `tests/test_data_normalization.py` 已驗證「套用座標 = 推斷記錄」）。

---

## 3. 不可信座標候選清單（A5 實測，程式化產出）

| 級別 | 類別 | 規模 | 處置 |
|---|---|---|---|
| **P0-1** | **Marker 塌縮** —— 704 地點只有 472 唯一座標；**103 個完全重疊**於 `[114.25343, 22.30581]`（大本營建築群）；10 個 ≥5 成員簇共 **189 個地點（26.8%）** | 189 | 對每個 ≥5 成員簇用 **deterministic 環形散佈**（半徑由 `radius_m` 推導）；**必須跳過 `inferred_from` 非空** 嘅地點 |
| **P0-2** | **事件座標大面積無證據** —— 1385/1796（**77.1%**）事件掛喺 `approximate`／`fictional` 地點；其中 **120 個 `approximate` 完全冇 `position_source` 亦冇 `inferred_from`**（17.0%） | 1505 | 加 `coordinate_source` + `coordinate_review_status`；120 個標 `needs_validation`；UI 顯示精度 |
| **P0-3** | **Schema 落差** —— 4 個 coordinate_* 欄位喺 4 個 layer 全部唔存在 | — | Versioned migration（見 §6） |
| **P1-1** | Zone membership 不一致 —— 12 條 quarantine（最遠 **3,036.9 m**，將軍澳廣場→將軍澳商場）+ 8 warning | 20 | `infer_zone_membership.py` point-in-polygon 取代「名相等」反查 |
| **P1-2** | Route continuity —— 176 步 >2 km，其中 92 步章節差 ≤2；**4 個角色共用完全相同 3,908 m 步**（兩端都係合成錨點） | 176 | 加 `waypoint_confidence`；無 evidence 降 confidence |
| **P1-3** | Zone polygon 品質 —— 141 精確重疊 + 9 嵌套 + **37/48 用 default 半徑**（37 個 48 邊形近似圓） | 187 | 標 `spatial_precision: approximate`；重疊 → `contested` 或 `needs_validation` |
| **P1-4** | 40 個 `fictional` 地點用「後備主場景」= 無證據 | 40 | 標 `coordinate_source: legacy` + `needs_validation` |
| **P2** | 7 類（見 `artifacts/audit-A5/spatial-audit.json`） | — | 記錄，Gate 3 再評 |

**已通過**：R1（無非法座標／自交）、R2（0 越界）、R5（coord mismatch 0）、R7（flashback 0 衝突）。

---

## 4. 8 條自動檢查規則（spec §2.2，實作契約）

| # | 規則 | 演算法 | Threshold | 輸出 |
|---|---|---|---|---|
| R1 | Geometry validity | 座標範圍、NaN、重複點、polygon self-intersection、bbox | 任何非法 = fail | `geometry_invalid[]` |
| R2 | Bounds | 所有點必須落喺 `lon 113.79–114.49`、`lat 22.11–22.61` | 越界 = fail | `out_of_bounds[]` |
| R3 | Zone membership | point-in-polygon（Ray casting） | 區外距離 > `zone.radius_m` × 1.5 → warning；> 3× → quarantine | `zone_mismatch[]` |
| R4 | Route continuity | 相鄰 waypoint Haversine 距離 ÷ chapter gap | > 2 km 且 gap ≤2 → 降 confidence | `route_jumps[]` |
| R5 | Event-location coherence | `event.location_name` vs `locations[event.location_id].name` 正規化比對 | 唔一致 = warning | `name_mismatch[]` |
| R6 | Duplicate / near-duplicate | 同名 + 距離 < 50 m + type 衝突 | 命中 → cluster 或 resolve | `duplicates[]` |
| R7 | Narrative temporal coherence | `flashback === true` → 豁免 chapter-order spatial expectation | 其他情況檢查 zone transition | `temporal_conflict[]` |
| R8 | Unknown over hallucination | 無法證明 → `unknown` / `approximate` + `needs_validation` | — | `downgraded[]` |

> **規則 V1**：8 條規則全部要寫入 `scripts/validate_spatial_narrative.py`，並有對應 pytest。
> **規則 V2**：每個規則輸出**必須**包含 `feature_id`、`rule`、`severity`、`evidence`（結構化，唔可以係自由文字）。
> **規則 V3**：**唔可以**建議人手抽樣核對。所有 threshold 必須 deterministic、可重跑、可稽核。

### 4.1 多代理 D1–D5（spec §2.2）

| 代理 | 可否喺 A5 層面完成 | V2 安排 |
|---|---|---|
| D1 Spatial Evidence Extractor（讀 private） | ❌ **本質上需要 private evidence** | **留 B4**；輸出**必須**過 `evidence-candidate.schema.json` |
| D2 Coordinate Consistency Analyst | ✅ 已完成 | 搬入 `scripts/audit_coordinate_integrity.py` |
| D3 Zone Topology Analyst | ✅ 已完成 | 搬入 `scripts/infer_zone_membership.py` |
| D4 Adversarial Data Reviewer | ⚠️ 部分 | 以 R3/R4/R6 嘅 deterministic 規則實現，唔用 LLM |
| D5 Repair Executor | ⚠️ 部分 | **只**套用被 deterministic rule / consensus 接受嘅 patch；其餘 quarantine |

> **規則 V4**：**唔可以**靠對話文字直接改 production GeoJSON（spec §2.2 明文）。所有 patch 必須經 schema + deterministic rule 合併。

### 4.2 Zone ↔ Event 三層 join（解 37.5% 關聯缺口）

```
Layer 1：location.zone_ids 已有 → 直接採用（覆蓋 12.5%）
Layer 2：zone.aliases / zone.name 子串匹配 location.name（覆蓋 +?）
Layer 3：point-in-polygon（location 座標落在 zone polygon 內）
        → 命中多個：取面積最小者；距離 > 1.5×radius → needs_validation
```

**實測基線**：經 location 反推只有 **674/1796（37.5%）**。目標：**≥85%**，其餘標 `needs_validation`（**唔可以**亂填）。

### 4.3 Zone ↔ Character

現況：zones **冇** `character_ids`；經 event 反推 115/173 角色、33/48 zone。
V2：由 `eventsByZone` × `event.characters` 反推；覆蓋率寫入 dossier 嘅 `confidence`。

---

## 5. Zone Schema v2

### 5.1 `data/public/zones.geojson` properties（v2）

```json
{
  "id": "zone_example",
  "name": "區域名稱",
  "zone_type": "survivor_zone|infected_nest|quarantine|contested|transit|unknown",
  "status": "active|collapsed|unknown|historical",
  "danger_level": 0,
  "spatial_precision": "verified|approximate|fictional|unknown",
  "display_style": { "fill": "#...", "pattern": "hatch|contour|noise|solid|pulse", "icon": "..." },
  "chapter_refs": [],
  "event_ids": [],
  "character_ids": [],
  "member_location_ids": [],
  "dossier_id": "dossier_xxx",
  "confidence": 0.0,
  "review_status": "validated|auto_inferred|needs_validation",
  "schema_version": 2
}
```

### 5.2 確定性映射規則（由現有 `kind` 推導，**唔捏造**）

| 現有 `kind` | 數量 | → `zone_type` | 備註 |
|---|---|---|---|
| `survivor` | 11 | `survivor_zone` | — |
| `nest` | 21 | `infected_nest` | — |
| `outpost` | 16 | `contested` | ⚠️ 語意較弱；`kind_votes` 分歧者（5 個）標 `review_status: needs_validation` |

| 欄位 | 推導規則 |
|---|---|
| `status` | 有 `chapters` 覆蓋到最後章 → `active`；有 `collapsed`／「已毀」字眼 → `collapsed`；否則 `unknown` |
| `danger_level` | `survivor_zone`=1；`contested`=3；`infected_nest`=4；`unknown`=null（**唔可以亂填**） |
| `spatial_precision` | 由 `range_evidence` / `coords_evidence` 有無決定；default → `approximate` |
| `display_style` | 由 `zone_type` 查表（見 visual-motion spec §4），**唔存 raw hex 於資料層**（用 token 名） |
| `review_status` | `kind_votes` 一致（43/48）→ `auto_inferred`；分歧（5/48）→ `needs_validation` |

> **規則 Z1**：`schema_version` 必須遞增；migration script 必須 idempotent。
> **規則 Z2**：`kind` 保留（向後兼容），但前端**只讀** `zone_type`。

---

## 6. Dossier Schema（獨立檔，裁定方案 B）

### 6.1 裁定

**採方案 B：抽出獨立 `data/public/zone-dossiers.json`**（A6 建議）。

| 理由 | 說明 |
|---|---|
| 載入策略 | 幾何 58 KiB 先載（地圖即刻可用）；dossier 45 KiB lazy-load（只在開 dossier 時） |
| Layer 分離 | 幾何／屬性／敘事內容解耦，各自可 versioned migration |
| 檔案大小 | `zones.geojson` 由 311 KB 降至約 60 KB |
| Schema 版本化 | dossier 可獨立 v1→v2，唔影響幾何 |

### 6.2 Schema

```json
{
  "schema_version": 2,
  "id": "dossier_xxx",
  "zone_id": "zone_xxx",
  "overview": "最多 180 字粵文概述",
  "governance": { "system": "…|unknown", "authority": "…|unknown", "legitimacy": "…" },
  "society": { "population_structure": "…", "daily_life": "…", "culture": "…" },
  "infrastructure": { "security": "…", "resources": "…", "mobility": "…" },
  "risk_profile": { "threats": ["…"], "danger_level": 0 },
  "nest_profile": { "threat_signature": "…", "activity_pattern": "…", "affected_radius": "…" },
  "key_characters": [],
  "chapter_refs": [],
  "evidence_sources": ["chapter-summaries", "events", "timeline"],
  "confidence": 0.0,
  "review_status": "validated|auto_inferred|needs_validation"
}
```

> **規則 DS1**：每個 field **只有 evidence 足夠先可填**；不足 → `unknown`，UI 顯示「資料未足以確認」。
> **規則 DS2**：`infected_nest` 用 `nest_profile`（威脅特徵／活動模式／影響範圍／關聯事件）**代替** `governance` / `society` 欄位。
> **規則 DS3**：public dossier **只可**保留短摘要 + chapter refs + 可信度。**evidence excerpt 只留 private。**
> **規則 DS4**：⚠️ 現有 `zones.geojson.evidence` 100% 含 `chN 原文：「…」` → **版權紅線**（A6 P0）。V2 **必須**將 `evidence` 由 public 移除或改為結構化引用（`{chapter, kind}` 而唔含原文）。

### 6.3 資料缺口（A6 實測，必須喺 UI 誠實呈現）

| 項 | 實測 |
|---|---|
| 核心 6 欄（government / social_structure / economy / defense / population / culture）填充率 | 60% / 69% / 44% / 56% / 46% / 60% |
| 有 ≥1 個核心欄 evidence | 43/48 |
| **六欄全空** | **5 個 zone**（其中寶翠公園、靈實禮拜堂連 chapter 摘要／event 都冇） |
| 核心欄 ≤2/6 | 17 個 zone |
| 病窩替代欄位 | `threats` 20/21、`notable_features` 16/21、`summary` 21/21 → **可行** |
| 可程式化重建來源 | `chapter-summaries.json` 877 條 location 摘要可 join **40/48** zone；只有 **2/48** 三來源全空 |

---

## 7. Coordinate Validation Pipeline（B4 工作包）

| Script | 來源 | 用途 |
|---|---|---|
| `scripts/audit_coordinate_integrity.py` | 搬 `artifacts/audit-A5/spatial_audit.py` | R1–R8 主檢查 |
| `scripts/infer_zone_membership.py` | **新寫（最高優先）** | 三層 join，解 37.5% 缺口 |
| `scripts/validate_spatial_narrative.py` | 新寫 | R5 / R7 敘事一致性 |
| `scripts/build_zone_dossiers.py` | 由 `merge_zone_dossiers.py` 改名／擴展 | 產生 `zone-dossiers.json` |
| `scripts/render_coordinate_audit_report.py` | 新寫 | 讀 `spatial-audit.json` 出報告 |
| `tests/test_spatial_integrity.py` | 搬 `artifacts/audit-A5/test_spatial_rules_prototype.py` | pytest（現況 4 failed / 9 passed → 目標全綠） |

**擴展**：`validate_public_data.py`（+dossier schema）、`build_public_dataset.py`（+輸出）、`data/schemas/zone.schema.json`（+v2 欄位）。
**Deprecated**：`scripts/derive_zones.py`（避免同 `zones.geojson` 雙軌寫入）。

---

## 8. 零人手違規清單（AGENTS.md 紅線，Gate 1 必須處理）

| # | 位置 | 問題 |
|---|---|---|
| 1 | `data/public/map-config.json` `provisional_mode.banner` | 寫「仍待**人工審閱**」「未經最終**人工確認**」→ 直接違反「零人手參與」 |
| 2 | `data/public/characters.json` `description` | 含人手覆核字眼 |
| 3 | `scripts/apply_location_corrections.py` | 含人手修正流程 |
| 4 | `data/public/zones.geojson` `evidence` | 100% 含 `chN 原文：「…」` → **版權紅線** |

**處置**：全部改為程式化表述（「自動驗證」「needs_validation」），並加 pytest 斷言防止回歸。

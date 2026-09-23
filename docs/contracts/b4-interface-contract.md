# B4 Territory Data Pipeline — 介面契約（Interface Contract）

> 子代理：**B4 Territory Data Pipeline**｜Branch：`refactor/world-atlas-v2`
> 主要規格：`docs/specs/world-atlas-v2-spatial-data-contract.md`（§1–§8）、`docs/specs/world-atlas-v2-migration-plan.md` §3
> 依據審計：`docs/audits/spatial-integrity-audit.md`（A5）、`docs/audits/territory-dossier-audit.md`（A6）
> **本檔先寫，後實作**（spec §4.4、migration plan §8）。
> **紅線**：本 pass **只讀 `data/public/`** + 確定性規則；**冇讀取 `data/private/`**。

---

## 0. 一句話總結

B4 將 `data/public/` 由 **v1**（`kind` + inline dossier + `evidence` 原文）升級為 **v2**：
1. `zones.geojson` 加 `zone_type` / `status` / `danger_level` / `spatial_precision` / `display_style` / `chapter_refs` / `event_ids` / `character_ids` / `member_location_ids` / `dossier_id` / `review_status` / `schema_version`；**移除 `evidence`**（版權紅線）。
2. 新增 `data/public/zone-dossiers.json`（獨立檔，方案 B）。
3. 四個 spatial layer 加 `coordinate_confidence` / `coordinate_source` / `coordinate_review_status` / `spatial_evidence_count`。
4. `events.geojson` 加 `zone_id`（三層 join），`locations.geojson` 加 `zone_ids` 修正 + `zone_membership_*`。

---

## 1. `data/public/zones.geojson` v2 properties（完整清單）

`type: "FeatureCollection"`；頂層加 `"schema_version": 2`。每個 `Feature` 係 `Polygon`。

| # | 欄位 | 型別／enum | 來源（確定性） |
|---|---|---|---|
| 1 | `id` | `string` `^zone_[0-9a-f]{10}$` | v1 沿用（`merge_zone_dossiers.py` 由區域名 sha1 前 10 位） |
| 2 | `name` | `string` | v1 沿用 |
| 3 | `kind` | `survivor`\|`nest`\|`outpost` | v1 沿用（**向後兼容**；前端只讀 `zone_type`，規則 Z2） |
| 4 | `kind_votes` | `object<string,int>` | v1 沿用（多代理票數，可稽核） |
| 5 | `zone_type` | `survivor_zone`\|`infected_nest`\|`quarantine`\|`contested`\|`transit`\|`unknown` | `kind` → 映射：`survivor→survivor_zone`、`nest→infected_nest`、`outpost→contested`（spec §5.2） |
| 6 | `status` | `active`\|`collapsed`\|`unknown`\|`historical` | `198 ∈ chapters` → `active`；內文含「已毀／collapsed」→ `collapsed`；否則 `unknown`（**唔亂填**） |
| 7 | `danger_level` | `integer`\|`null` | `survivor_zone`=1、`contested`=3、`infected_nest`=4、其餘=`null` |
| 8 | `spatial_precision` | `verified`\|`approximate`\|`fictional`\|`unknown` | `radius_source=="members"` → `verified`；`coords_source!="unknown"` → `approximate`；否則 `unknown` |
| 9 | `display_style` | `{fill,pattern,icon}` | 由 `zone_type` 查表；`fill` 係 **B1 token 名**（唔存 raw hex） |
| 10 | `chapter_refs` | `integer[]` | = `chapters`（同義改名，spec §2.2 統一命名） |
| 11 | `event_ids` | `string[]` | 三層 join（`infer_zone_membership.py`）：`{e.id \| e.location_id ∈ zone.member_location_ids}` |
| 12 | `character_ids` | `string[]` | `{c \| c ∈ event.characters, event ∈ event_ids}` ∪ `{c \| route waypoint ∈ zone}` |
| 13 | `member_location_ids` | `string[]` | 三層 join（`infer_zone_membership.py`）；與 `location.zone_ids` 雙向一致 |
| 14 | `dossier_id` | `string` | `"dossier_" + id[5:]`（確定性） |
| 15 | `confidence` | `number` 0–1 | 確定性公式（§4） |
| 16 | `confidence_inputs` | `{coord_score,dossier_score,kind_score}` | 三個輸入分數（可稽核；A6 §3.6c） |
| 17 | `review_status` | `validated`\|`auto_inferred`\|`needs_validation` | §5 |
| 18 | `zone_review_status` | 同上（**別名**） | 同 `review_status`；為 B2 `ZoneProperties.zone_review_status` 而設 |
| 19 | `schema_version` | `integer` = `2` | 規則 Z1（versioned migration，idempotent） |
| 20 | `aliases` | `string[]` | v1 沿用 |
| 21 | `chapters` | `integer[]` | v1 沿用 |
| 22 | `first_appearance` | `integer`\|`null` | v1 沿用 |
| 23 | `location_hint` | `string`\|`null` | v1 沿用 |
| 24 | `government` | `string`\|`null` | v1 沿用（dossier 衍生內容，**保留**） |
| 25 | `leadership` | `string[]` | v1 沿用 |
| 26 | `social_structure` | `string`\|`null` | v1 沿用 |
| 27 | `economy` | `string`\|`null` | v1 沿用 |
| 28 | `defense` | `string`\|`null` | v1 沿用 |
| 29 | `population` | `string`\|`null` | v1 沿用 |
| 30 | `culture` | `string`\|`null` | v1 沿用 |
| 31 | `notable_features` | `string[]` | v1 沿用 |
| 32 | `threats` | `string[]` | v1 沿用 |
| 33 | `summary` | `string`\|`null` | v1 沿用 |
| 34 | `radius_m` | `number` 80–1500 | v1 沿用 |
| 35 | `radius_source` | `members`\|`default`\|`unknown` | v1 沿用 |
| 36 | `coords_source` | `locations`\|`locations_prefix`\|`district`\|`osm`\|`unknown` | v1 沿用 |
| 37 | `coords_evidence` | `string` | v1 沿用 |
| 38 | `range_evidence` | `string` | v1 沿用 |
| 39 | `coordinate_confidence` | `number` 0–1 | §3 回填 |
| 40 | `coordinate_source` | `explicit_text`\|`cross_chapter_evidence`\|`zone_inference`\|`legacy`\|`manual_geometry` | §3 回填 |
| 41 | `coordinate_review_status` | `validated`\|`auto_corrected`\|`needs_validation`\|`quarantined` | §3 回填 |
| 42 | `spatial_evidence_count` | `integer` ≥0 | §3 回填 |
| 43 | `sources` | `string[]` | v1 沿用 |
| 44 | `source` | `"bing_gang"` | v1 沿用 |
| — | ~~`evidence`~~ | **已移除** | ⚠️ 版權紅線（48/48 含 `chN 原文：「…」`）；原文只可留 private |

### 1.1 `display_style` 查表（token 名，唔存 raw hex）

| `zone_type` | `fill` | `pattern` | `icon` |
|---|---|---|---|
| `survivor_zone` | `--zone-survivor` | `contour` | `shield` |
| `infected_nest` | `--zone-nest` | `hatch` | `virus` |
| `quarantine` | `--zone-quarantine` | `hatch` | `gate` |
| `contested` | `--zone-contested` | `contour` | `crossed-swords` |
| `transit` | `--zone-unknown` | `solid` | `route` |
| `unknown` | `--zone-unknown` | `noise` | `question` |

> token 由 B1 定義（`src/styles/tokens.css:46-57`、`src/theme-tokens.ts:82-91`）。B4 **只引用 token 名**，唔改 token。

---

## 2. `data/public/zone-dossiers.json`（新檔，完整 schema）

獨立檔（方案 B）。`schema_version: 2`。**冇 timestamp**（保證 idempotent）。

```json
{
  "schema_version": 2,
  "generated_from": {
    "zones": "<sha256 of data/public/zones.geojson>",
    "chapter_summaries": "<sha256>",
    "events": "<sha256>",
    "timeline": "<sha256>"
  },
  "dossiers": [ /* ZoneDossier[]，按 zone_id 排序 */ ]
}
```

### 2.1 `ZoneDossier`

| 欄位 | 型別 | 來源 |
|---|---|---|
| `schema_version` | `integer` = `2` | — |
| `id` | `string` `^dossier_[0-9a-f]{10}$` | = `zone.dossier_id` |
| `zone_id` | `string` | = `zone.id` |
| `overview` | `string` ≤180 字 | `zones.geojson.summary`（截句，唔切斷標點）；不足 → `"unknown"` |
| `governance` | `{system,authority,legitimacy}` | 非 `infected_nest` 先有。`system←government`、`authority←leadership`、`legitimacy←"unknown"`（冇獨立來源） |
| `society` | `{population_structure,daily_life,culture}` | 非 `infected_nest`。`population_structure←social_structure`、`daily_life←population`、`culture←culture` |
| `infrastructure` | `{security,resources,mobility}` | 非 `infected_nest`。`security←defense`、`resources←economy`、`mobility←"unknown"` |
| `risk_profile` | `{threats:string[], danger_level:int\|null}` | `threats←zone.threats`、`danger_level←zone.danger_level` |
| `nest_profile` | `{threat_signature,activity_pattern,affected_radius}` | **只** `infected_nest`（規則 DS2：代替 `governance`/`society`）。`threat_signature←threats` 串接；`activity_pattern←"活躍章節 ch{a}–ch{b}；區內事件 {n} 條"`；`affected_radius←"半徑約 {radius_m} m（{radius_source}）"` |
| `key_characters` | `string[]` | `zone.character_ids ∩ characters.json` → 角色名（**冇人物描述可用**：`characters.json.description` 全部係模板，A6 §3.5） |
| `chapter_refs` | `integer[]` | = `zone.chapters` |
| `evidence_sources` | `string[]` | **實際**貢獻來源：`zones-inline` / `chapter-summaries` / `events`（排序） |
| `confidence` | `number` 0–1 | 同 zone confidence（§4） |
| `review_status` | `validated`\|`auto_inferred`\|`needs_validation` | §5 |

> **規則 DS1**：每個 field **只有 evidence 足夠先可填**；不足 → `"unknown"`，UI 顯示「資料未足以確認」。
> **規則 DS3**：public dossier **只可**保留短摘要 + chapter refs + 可信度。**evidence excerpt 只留 private。**
> **規則 DS4**：public 檔**唔可以**含 `chN 原文：「…」`。
>
> ⚠️ **`timeline` 唔會出現喺 `evidence_sources`**（實作定案）：`timeline.json` 記入
> `generated_from` 做**溯源**，但目前**冇任何 dossier 欄位**由佢填 —— 所以列出嚟
> 就係虛報來源。規則 DS1「只列實際貢獻來源」優先。實測分佈：
> `{zones-inline, chapter-summaries, events}` 36 個、`{zones-inline}` 11 個、
> `{zones-inline, chapter-summaries}` 1 個。

---

## 3. 四個 layer 新增嘅 `coordinate_*` 欄位

`location_precision` 保留原樣（locations）；events/routes/zones 靠回填。

| Layer | 新增欄位 | 型別 |
|---|---|---|
| `locations.geojson` | `coordinate_confidence` | `number` 0–1 |
| | `coordinate_source` | enum（同上） |
| | `coordinate_review_status` | enum（同上） |
| | `spatial_evidence_count` | `integer` ≥0 |
| | `zone_membership_source` | `legacy`\|`name`\|`geometry` |
| | `zone_membership_review_status` | `validated`\|`needs_validation`\|`quarantined` |
| `events.geojson` | `zone_id` | `string`\|`null` |
| | `coordinate_confidence` / `coordinate_source` / `coordinate_review_status` / `spatial_evidence_count` | 同 location（繼承 `location_id` 對應地點） |
| `routes.geojson` | `properties.waypoints[].coordinate_confidence` / `coordinate_source` / `coordinate_review_status` / `spatial_evidence_count` | 同 waypoint 地點 |
| `zones.geojson` | `coordinate_confidence` / `coordinate_source` / `coordinate_review_status` / `spatial_evidence_count` | 由 `radius_source` / `coords_source` 決定 |

### 3.1 確定性回填規則（spec §2.2，可重跑）

| 目標 | 規則 |
|---|---|
| `coordinate_source`（location） | `inferred_from` 非空 → `cross_chapter_evidence`；`position_source` 含「校正」→ `manual_geometry`；否則 `legacy` |
| `coordinate_review_status`（location） | `coord_corrected === true` → `auto_corrected`；否則 `needs_validation` |
| `coordinate_confidence`（location） | 由 `location_precision`：`exact`/`verified`=0.95、`district`=0.8、`approximate`=0.55、`fictional`=0.35、`unknown`=0.0 |
| `coordinate_confidence`（event/route） | 繼承 `location_id` 對應地點嘅精度；冇 location → 0.0 |
| `coordinate_source`（zone） | `radius_source=="members"` → `cross_chapter_evidence`；`coords_source!="unknown"` → `zone_inference`；否則 `legacy` |
| `coordinate_review_status`（zone） | `radius_source=="members"` → `auto_corrected`；否則 `needs_validation` |
| `coordinate_confidence`（zone） | `spatial_precision` 查表（同 location） |
| `spatial_evidence_count` | 見 §3.2 |
| `zone_id`（event） | 三層 join（§6）；無法確定 → `null` + `coordinate_review_status: needs_validation` |

> **規則 C1**：**唔可以用「猜」修正座標**。無法自動證明 → `unknown`／`approximate` + `needs_validation`。
> **規則 C2**：`coord_corrected` **唔可以**覆蓋 `inferred_from`（`tests/test_data_normalization.py` + `tests/test_apply_inferences.py` 已驗證「套用座標 = 推斷記錄」）。**標記塌縮修復必須跳過 `inferred_from` 非空嘅地點。**

### 3.2 `spatial_evidence_count` 定義（B4 定案；spec §2.2 原文含糊）

「支持該 feature 空間歸屬嘅章節重疊證據數」：

| Layer | 公式 |
|---|---|
| location | `len(set(chapters) ∩ set(zone.chapters))`（無 zone → `0`） |
| event | `len(set(chapter_refs) ∩ set(zone.chapters))`（無 zone → `0`） |
| route waypoint | `len({waypoint.chapter} ∩ set(zone.chapters))`（無 zone → `0`） |
| zone | `len({e ∈ event_ids : e.chapter ∈ zone.chapters})`（「zone 內 event 數」，spec §2.2 字面） |

> 呢個係 spec §2.2「`chapters.length` ∩ zone 內 event 數」嘅程式化定案；寫入本契約，全部可重跑。

---

## 4. `confidence` 確定性公式（A6 §3.6c）

```text
coord_score   = 1.0  if radius_source == "members"
              = 0.5  elif coords_source != "unknown"
              = 0.0  else
dossier_score = (# 核心六欄有 evidence) / 6      # 病窩改用 (threats + notable_features + summary) / 3
kind_score    = kind_votes 最高票 / 總票
confidence    = 0.40*coord_score + 0.40*dossier_score + 0.20*kind_score   # round 2
```

- 「有 evidence」判定：`EMPTY = {"", "unknown", "未知", "n/a", "none", "-", "—", "不詳", "待定"}`；字串 ≥4 字元；陣列 ≥1 項（每項 ≥2 字元）。
- 三個分數寫入 `confidence_inputs`。

---

## 5. `review_status` 確定性判定

| 值 | 條件 |
|---|---|
| `needs_validation` | `kind_votes` 分歧（最高票 < 總票）**或** 核心六欄全空 |
| `validated` | `coords_source=="locations"` **且** `radius_source=="members"` **且** 核心六欄 ≥4/6 **且** `kind_votes` 一致 |
| `auto_inferred` | 其餘 |

> 已知：`kind_votes` 分歧 5 個（大本營、靈實醫院、聖安得肋堂、詭區、翠林村倖存區）；核心六欄全空 5 個（彩明商場病腦巢穴、死亡之路、寶翠公園、心朗村、靈實禮拜堂）→ 呢批**一定** `needs_validation`。

---

## 6. Zone ↔ Event 三層 join（`infer_zone_membership.py`）

```text
Layer 3（幾何，優先）：point-in-polygon（ray casting）
        命中多個 → 取面積最小者；source = "geometry"；status = "validated"
Layer 2（名稱）：zone.name / zone.aliases ⊂ location.name（正規化子字串，長度 ≥2）
Layer 1（既有）：location.zone_ids（legacy 名相等配對）
        無幾何命中 → 用 Layer2 ∪ Layer1：
            d = 點到 polygon 邊最短距離
            d ≤ 1.5 × radius_m  → validated
            1.5× < d ≤ 3×        → needs_validation（保留，記錄）
            d > 3×               → quarantined（由 zone_ids 剔除，記錄）
```

- 每個 location 寫 `zone_ids` + `zone_membership_source` + `zone_membership_review_status`。
- `events.zone_id` ← `location.zone_ids` 中面積最小者；`location_id` 為 `null` → `null`。
- **目標 zone↔event 覆蓋率 ≥85%**；未達標部分標 `needs_validation`，**唔亂填**。

---

## 7. 標記塌縮修復（deterministic 環形散佈）

| 項 | 規則 |
|---|---|
| 偵測 | 完全相同座標、成員 ≥5 嘅簇（`locations.geojson`） |
| 跳過 | **`inferred_from` 非空嘅地點一律唔移動**（規則 C2；上游推斷記錄鎖定座標） |
| 散佈 | 對剩餘成員按 `id` 排序，均勻放喺環上：`angle = 2π·i/n`、`radius = clamp(18·√n, 40, 160) m`（由簇大小推導，確定性、無 zone 依賴，避免循環） |
| 傳播 | 移動之後**必須**將新座標傳播到 `events` / `timeline` / `routes` waypoints（否則 `test_event_coords_match_location` 失敗） |
| 輸出 | `coordinate_review_status` 保持（散佈係幾何去重，唔改精度） |

> ⚠️ **實測限制**：10 簇共 189 個成員，其中 **169 個帶 `inferred_from`**（89/103 大本營簇）→ B4 **唔可以**移動。實際可散佈 = 20 個。剩餘 inferred 塌縮簇寫入 audit 報告嘅 `locked_collapse_clusters`（上游 re-inference 才能解），**唔當 fail**。

---

## 8. 輸出檔清單、版本、SHA-256

版本：`schema_version = 2`（zones / dossiers）；`coordinate_*` 欄位版本 = v2。

| 輸出檔 | 產生者 | SHA-256 |
|---|---|---|
| `data/public/zones.geojson` | **階段 3**（加 `coordinate_*`）→ **階段 4**（v2 遷移 + join 欄位） | 見 `docs/progress/b4-data-pipeline-delivery.md` §「idempotency」 |
| `data/public/zone-dossiers.json` | `build_zone_dossiers.py`（階段 4） | 同上 |
| `data/public/locations.geojson` | `infer_zone_membership.py`（階段 1 + 3） | 同上 |
| `data/public/events.geojson` | `infer_zone_membership.py`（階段 1 + 3） | 同上 |
| `data/public/routes.geojson` | `infer_zone_membership.py`（階段 1 + 3） | 同上 |
| `data/public/timeline.json` | `infer_zone_membership.py`（階段 1 + 3） | 同上 |
| `data/public/asset-manifest.json` | `update_manifest.py`（`zone_dossier` count） | 同上 |
| `artifacts/b4/zone-membership.json` | `infer_zone_membership.py`（階段 3） | 同上 |
| `artifacts/b4/coordinate-audit.json` | `audit_coordinate_integrity.py` | 同上 |
| `artifacts/b4/coordinate-audit-report.md` | `render_coordinate_audit_report.py` | 同上 |

> ⚠️ **`zones.geojson` 有兩個寫手（同一 pipeline 內，次序固定）**：
> 階段 3 加 `coordinate_*`（v1 基礎欄位 + 4 個新欄位），階段 4 做 v2 遷移。
> **唔可以**只跑階段 3 就當完成 —— 咁樣 `zones.geojson` 會停喺 v1 欄位，
> schema 驗證會 fail。正確入口係 `merge_zone_dossiers.py`（4 階段編排）。

> **`legacy_baseline` 係寫死常數**：`zone-membership.json` 嘅「B4 之前」覆蓋率
> （674 / 37.5%、88 / 12.5%）係 Gate 1 實測值。**唔可以**每次重算 ——
> join 一寫入 `zone_ids`，「before」就會等於上一次嘅「after」，
> artifact 就唔再 byte-stable（違反 idempotency 硬性要求）。

> AGENTS.md 要求「生成檔案要有來源、版本同 hash」：`zone-dossiers.json.generated_from` 記 4 個輸入檔嘅 SHA-256；`artifacts/b4/*.json` 記 `inputs` hash + `schema_version`。**冇 timestamp**（保證 idempotent）。

---

## 9. B3（Data Adapter）／B6（Map Interaction）應該點消費

### B3（`src/data/adapter/`）
1. `zones.geojson` → 建 `Map<zone_id, ZoneFeature>`；**只讀 `zone_type`**（唔讀 `kind`，規則 Z2）。
2. `zone-dossiers.json` → 建 `Map<zone_id, ZoneDossier>`（lazy-load：**唔好**喺首屏 eager load）。join key = `zone.dossier_id` ↔ `dossier.id`；亦可用 `dossier.zone_id`。
3. `events.geojson.zone_id` → 建 `Map<zone_id, event_id[]>`（由 `zone.event_ids` 亦可得，二者必須一致）。
4. `locations.geojson.zone_ids` → 建 `Map<zone_id, location_id[]>`。
5. 顯示精度：`coordinate_confidence` / `coordinate_review_status` 必須傳到 UI；`needs_validation` **唔可以**當已知。
6. `display_style.fill` 係 **token 名**（`--zone-*`），**唔係** hex → 直接用 `var(--zone-...)`。

### B6（`src/map/ZoneLayer.ts`、`ZoneDossier.ts`）
1. 48 個 zone **永遠全部 render**（spec §4.3 決定）；章節只作 emphasis。
2. legend 用 `zone_type` → `display_style`（color + pattern + icon 三通道，唔可以只靠色）。
3. hover/click tooltip 讀 `name` / `zone_type` / `danger_level` / `status`。
4. click → 用 `dossier_id` lazy-load dossier。`review_status === "needs_validation"` 或 field 為 `"unknown"` → 顯示「資料未足以確認」，**唔顯示**空白欄位或假資料。
5. `infected_nest` **只**顯示 `nest_profile`（**唔顯示** `governance` / `society`，規則 DS2）。
6. `danger_level === null` → 唔顯示危險度（唔可以當 0）。

---

## 10. B4 獨佔嘅檔案（其他代理只可讀）

```
scripts/infer_zone_membership.py            （新，最高優先）
scripts/build_zone_dossiers.py              （新）
scripts/audit_coordinate_integrity.py       （新）
scripts/validate_spatial_narrative.py       （新）
scripts/render_coordinate_audit_report.py   （新）
scripts/validate_public_data.py             （擴展）
scripts/build_public_dataset.py             （擴展）
scripts/merge_zone_dossiers.py              （改：deprecated shim + 移除 evidence）
scripts/derive_zones.py                     （改：標 deprecated，唔刪）
data/schemas/zone.schema.json               （改：v2）
data/schemas/zone-dossier.schema.json       （新）
data/public/zones.geojson                   （改：v2）
data/public/zone-dossiers.json              （新）
data/public/locations.geojson               （改：zone_ids + coordinate_*）
data/public/events.geojson                  （改：zone_id + coordinate_*）
data/public/routes.geojson                  （改：waypoint coordinate_*）
public/data/public/*                        （只經 npm run sync-data）
tests/test_spatial_integrity.py             （新）
artifacts/b4/*                              （審計輸出）
```

**B4 唔會改**：`src/**`（B1/B2/B5/B6/B7/B8）、`public/assets/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`tests/visual-smoke.e2e.test.ts`。

### 10.1 已知衝突（需主代理知悉）
- `tests/test_data_normalization.py::test_zone_evidence_quotes_chapters` 斷言 `evidence` 含 `"ch"`。移除 `evidence`（版權紅線）必然衝突 → 依 migration plan §6.2／§9.5「現有測試改為驗證新 spec」，**已改名為** `test_zone_evidence_is_not_leaked_to_public`，改為斷言「**冇** `chN 原文` 引用 + `chapter_refs` 存在」。
- `tests/test_data_normalization.py::test_zone_merger_is_idempotent` 跑 `merge_zone_dossiers.py`。該腳本改為 **deprecated shim**：內部順序 = 塌縮修復 → 區域基礎合併 → 三層 join + 回填 → v2 遷移 + dossier，所以單跑佢都會產生完整 v2 輸出（保持冪等）。
- `tests/test_public_data.py::test_manifest_counts_match` 硬編碼 manifest counts 清單。新增 `zone_dossier`（方案 B 抽出獨立檔）之後必然要加一行 —— 否則 `asset-manifest.json` 唔可以宣告新 dataset。**已加**（同時修好原本重複嘅 `chronicle_entry` key）。
- `tests/test_apply_inferences.py::ready` fixture 會跑**完整 `run_pipeline.py`**（16 步），即係會寫 `data/public/*`。所以「手動只跑 `merge_zone_dossiers.py`」同「跑完整管線」嘅 hash 唔同 —— 後者係 superset。**idempotency 以完整管線為準**（該檔嘅 `test_pipeline_is_idempotent` 已綠燈）。
- `scripts/build_public_dataset.py`（Phase B 遺留、唔在 `run_pipeline.py` 內）原本會覆蓋 `asset-manifest.json` 而只寫 5 個 dataset 嘅 counts，令其餘 count 靜默消失。**已改**為由磁碟重算 `zone` / `zone_dossier` / `chronicle_entry` / `chapter_summary`。

### 10.2 B4 實際改動清單（超出原契約嘅部分）
| 檔案 | 改動 | 理由 |
|---|---|---|
| `scripts/infer_zone_membership.py` | `run()` 拆出塌縮 phase；`--phase {collapse,join,all}` | 塌縮必須喺 zone 幾何計算**之前**，否則非冪等 |
| `scripts/merge_zone_dossiers.py` | 4 階段編排器；**刪走私 private 讀取** | 實測 district／gazetteer 貢獻 0 個 zone → 唔需要讀 private |
| `scripts/derive_zones.py` | `--force-deprecated` 守門（exit 2） | 防止雙軌寫入覆蓋 v2 |
| `scripts/run_pipeline.py` | 加 3 個 B4 步驟（audit / report / narrative） | 令審計成為管線一部分 |
| `scripts/build_public_dataset.py` | manifest counts 由磁碟重算其他 dataset | 修「count 靜默消失」 |
| `scripts/update_manifest.py` | 加 `zone_dossier` count | 同上 |
| `scripts/validate_public_data.py` | +`zone-dossier.schema.json`、`novel_quote` 紅線、zone v2 enum、雙向連結 | 閘門覆蓋 B4 全部新契約 |
| `tests/test_public_data.py` | manifest counts 加 `zone_dossier`（順手 dedupe） | 見 §10.1 |
| `tests/test_spatial_integrity.py` | **新檔**，36 條 | 見該檔 docstring |

# B4 — Territory Data Pipeline 交付報告

> 子代理：**B4 Territory Data Pipeline**｜Branch：`refactor/world-atlas-v2`
> 交付日期：2026-09-21
> 主要規格：`docs/specs/world-atlas-v2-spatial-data-contract.md`（§1–§8）、`docs/specs/world-atlas-v2-migration-plan.md` §3
> 介面契約（**先寫，後實作**）：`docs/contracts/b4-interface-contract.md`
> 依據審計：`docs/audits/spatial-integrity-audit.md`（A5）、`docs/audits/territory-dossier-audit.md`（A6）
> **紅線**：本 pass **只讀 `data/public/`**（+ 確定性規則）；**冇新增任何 `data/private/` 讀取**，並且**刪走**咗舊腳本原有嘅兩個 private 讀取。

---

## 任務摘要

把 `data/public/` 由 **v1**（`kind` + inline dossier + `evidence` 原文）升級為 **v2**，
並修好 Gate 1 實測嘅三個 P0 缺陷（marker 塌縮、zone↔event 覆蓋率 37.5%、schema 落差）
同一個**版權紅線**（48/48 個 zone 嘅 `evidence` 含小說原文）。

| 交付 | 內容 |
|---|---|
| 三層 join | `scripts/infer_zone_membership.py` —— point-in-polygon（ray casting）→ 名稱子字串 → legacy `zone_ids`，距離分級 1.5×／3× `radius_m` |
| Zone v2 遷移 | `scripts/build_zone_dossiers.py` —— 27 → **44 個 properties**；`evidence` **完全移除** |
| 獨立 dossier | `data/public/zone-dossiers.json`（新，48 份，方案 B）；`infected_nest` 用 `nest_profile`（規則 DS2） |
| 座標完整性審計 | `scripts/audit_coordinate_integrity.py` —— R1–R8，348 findings，**0 fail** |
| 敘事一致性 | `scripts/validate_spatial_narrative.py` —— 雙向連結 + dossier 引用 + 版權掃描 |
| 審計報告 | `scripts/render_coordinate_audit_report.py` → `artifacts/b4/coordinate-audit-report.md` |
| 塌縮修復 | deterministic 環形散佈（跳過 `inferred_from`，規則 C2） |
| 版權修復 | `merge_zone_dossiers.py` 唔再寫 `evidence`；`validate_public_data.py` 加 `novel_quote` 紅線；pytest 防回歸 |
| 閘門擴展 | `validate_public_data.py` / `build_public_dataset.py` / `update_manifest.py` 支援 `zone-dossiers.json` |
| 測試 | `tests/test_spatial_integrity.py`（新，**36 條**）；全套 **260 passed**（baseline 224） |

---

## 假設與證據

### 假設

1. **Spec 為唯一權威**（anti-stagnation）：v1 嘅 `kind` / inline dossier / `evidence` 唔係優先真相。凡衝突，一律以 V2 spec 為準。
2. **零人手**：所有映射、分級、信心值、review_status 都寫死喺腳本；資料不足一律 `unknown` / `needs_validation`，**唔捏造**。
3. **`inferred_from` 係鎖**：`data/private/review/place-inference.jsonl` 嘅推斷記錄鎖定座標（規則 C2，`tests/test_apply_inferences.py` 已驗證「套用座標 = 推斷記錄」）。B4 **唔可以**移動呢批座標。
4. **`legacy_baseline` 係 Gate 1 常數**：join 一寫入 `zone_ids`，「before」就會等於上一次嘅「after」→ artifact 唔再 byte-stable。所以 baseline 寫死做常數（674 / 88），唔每次重算。
5. **唔讀 private**：實測 zone 座標 100% 由 `data/public/locations.geojson` 配對到（`locations` 47 + `locations_prefix` 1，district／gazetteer **0**），所以舊腳本嘅兩個 private 讀取可以直接刪。

### 證據（實測，`python3.12`）

```
$ python3.12 scripts/merge_zone_dossiers.py
[1/4 標記塌縮修復 + 座標傳播]
  簇 10 個 → 散佈 18 個地點；鎖定（inferred_from）簇 10 個
  座標傳播：{'events': 27, 'timeline': 27, 'route_waypoints': 10}
[2/4 區域基礎合併（v1 基礎欄位，冇 evidence）]
讀入 93 條代理記錄（8 個代理）
合併後：48 個區域 {'survivor': 11, 'nest': 21, 'outpost': 16}
  座標來源：{'locations': 47, 'locations_prefix': 1}
  範圍來源：{'default': 35, 'members': 13}
[3/4 三層 join + coordinate_* 回填]
  event→zone：674（37.5%）→ 1627（90.6%）  目標 85% ✅
[4/4 zone v2 遷移 + zone-dossiers.json]
  zone 48 → dossier 48（nest_profile 21）
  review_status：{'auto_inferred': 31, 'needs_validation': 10, 'validated': 7}
✅ 4 階段完成；zones.geojson sha256 = 45a4520dc8d62438f7…
```

---

## 發現／改動

### 1. 覆蓋率前後對比（spec §7 硬指標 ≥85%）

| 指標 | B4 之前（v1，Gate 1 實測） | B4 之後 | 變化 |
|---|---|---|---|
| **event → zone** | 674 / 1796 = **37.5%** | **1627 / 1796 = 90.6%** | **+953（+53.1 pt）** ✅ |
| **location → zone** | 88 / 704 = **12.5%** | **587 / 704 = 83.4%** | **+499（+70.9 pt）** |
| 未解析 event | 1122 | 169（其中 16 條 `location_id` 本身係 `null`） | −953 |

**join 來源分佈**（location，704 個）：

| 來源 | 數量 | 說明 |
|---|---|---|
| `geometry`（Layer 3，優先） | 566 | point-in-polygon 命中；多個命中取面積最小者 |
| `name`（Layer 2） | 20 | zone 名／alias ⊂ location 名（正規化子字串） |
| `legacy`（Layer 1） | 1 | 舊 `zone_ids` 名相等配對 |
| `null`（未解析） | 117 | 標 `needs_validation`，**唔亂填** |

**join 審核狀態**（location）：`validated` 577、`needs_validation` 105、`quarantined` 22。
另有 **460 條 join audit**（`Z-JOIN-OVERLAP` info + `R3_ZONE_MEMBERSHIP` warning／quarantine），全部有 `feature_id` / `rule` / `severity` / `evidence`。

> ⚠️ **`quarantined` 22 條係刻意剔除**：名相等硬連但幾何距離 > 3 × `radius_m`（最遠 1,586 m vs 上限 818 m）→ 由 `zone_ids` 剔除並記錄。呢批就係 A5 講嘅「12 條明顯錯配」嘅來源。

### 2. Zone v2：27 → 44 個 properties，`evidence` 完全移除

| 類別 | 欄位 |
|---|---|
| **新增（spec §2.4 要求嘅 8 項）** | `zone_type` / `status` / `danger_level` / `spatial_precision` / `display_style` / `event_ids` / `character_ids` / `dossier_id` / `review_status` |
| **新增（B4 擴充）** | `chapter_refs` / `member_location_ids` / `confidence` / `confidence_inputs` / `zone_review_status`（B2 別名）/ `schema_version` / `coordinate_confidence` / `coordinate_source` / `coordinate_review_status` / `spatial_evidence_count` |
| **移除** | ~~`evidence`~~（⚠️ 版權紅線；48/48 含 `chN 原文：「…」`） |
| **保留（向後兼容）** | `kind`（規則 Z2：前端只讀 `zone_type`）/ `kind_votes` / inline dossier 六欄 / `radius_*` / `coords_*` / `sources` |

**確定性映射結果**（spec §5.2）：

| `zone_type` | 數量 | `danger_level` |
|---|---|---|
| `survivor_zone` | 11 | 1 |
| `infected_nest` | 21 | 4 |
| `contested` | 16 | 3 |

`status`：`active` 3（含 ch198）、`collapsed` 2、`unknown` 43（**唔亂填**）。
`spatial_precision`：`verified` 13（`radius_source == members`）、`approximate` 35。
`confidence` 平均 **0.758**（公式 `0.40*coord + 0.40*dossier + 0.20*kind`，三個輸入寫入 `confidence_inputs` 可稽核）。
`review_status`：`auto_inferred` 31、`validated` 7、`needs_validation` 10。

> ⚠️ `needs_validation` 10 個 = **5 個 `kind_votes` 分歧**（大本營、靈實醫院、聖安得肋堂、詭區、翠林村倖存區）+ **5 個核心六欄全空**（彩明商場病腦巢穴、死亡之路、寶翠公園、心朗村、靈實禮拜堂）。呢兩組**冇重疊**，10 個全部係 spec §6.3 / A5 §3.5 點名嘅。

### 3. Dossier 填充率（`zone-dossiers.json`，48 份）

| 欄位 | 有值 | 填充率 |
|---|---|---|
| `overview` | 48/48 | **100.0%** |
| `chapter_refs` | 48/48 | **100.0%** |
| `risk_profile.threats` | 44/48 | 91.7% |
| `key_characters` | 34/48 | 70.8% |
| `governance.authority` | 24/48 | 50.0% |
| `governance.system` | 23/48 | 47.9% |
| `society.population_structure` | 22/48 | 45.8% |
| `society.culture` | 20/48 | 41.7% |
| `nest_profile.threat_signature` | 20/21 病窩 | 95.2% |
| `infrastructure.resources` | 18/48 | 37.5% |
| `infrastructure.security` | 17/48 | 35.4% |
| `society.daily_life` | 10/48 | 20.8% |

> **其餘一律寫 `"unknown"`**（規則 DS1）—— 唔留空、唔作故仔。UI 應該顯示「資料未足以確認」。
> `legitimacy`（政權正當性）同 `mobility`（移動方式）**全部** `"unknown"`：A6 §3.3 確認 public 資料冇獨立來源。

**`evidence_sources` 實際分佈**（規則 DS1：只列實際貢獻來源）：

| 來源組合 | dossier 數 |
|---|---|
| `{zones-inline, chapter-summaries, events}` | 36 |
| `{zones-inline}` | 11 |
| `{zones-inline, chapter-summaries}` | 1 |

> ⚠️ **`timeline` 唔會出現**：`timeline.json` 記入 `generated_from` 做溯源，但目前**冇任何 dossier 欄位**由佢填 —— 列出嚟就係虛報來源。

### 4. 標記塌縮修復（P0-1）

| 項 | 結果 |
|---|---|
| 偵測（完全同座標、成員 ≥5） | **10 簇**，共 **171** 個成員 |
| 其中帶 `inferred_from`（**唔可以移動**） | **169** 個 |
| 本次實際散佈 | **18** 個地點（第一次跑） |
| 散佈公式 | `angle = 2π·i/n`（相位由簇座標 sha1 決定）、`radius = clamp(18·√n, 40, 160) m` |
| 傳播 | events 27、timeline 27、route waypoints 10 |
| 剩餘塌縮簇 | 10 個（全部含 locked 成員）→ 寫入 `artifacts/b4/zone-membership.json.marker_collapse_state`，**唔當 fail** |

> ⚠️ **實測限制（誠實記錄）**：169/171 個塌縮成員帶 `inferred_from`，座標被上游推斷記錄鎖定。B4 **冇能力**移動佢哋（移動會令 `test_applied_coordinates_match_inference` 失敗）。要真正解開呢 10 簇，**必須上游 re-inference**。B4 嘅做法係：散佈可動嘅、誠實記錄鎖定嘅、唔講大話。
>
> R6 規則因此分兩級：**非推斷** > 20 → fail；**有 locked** → warning。呢個係「唔可以逼實作講大話」嘅設計。

### 5. 座標完整性審計 R1–R8（`artifacts/b4/coordinate-audit.json`）

| 規則 | 內容 | findings | severity | status |
|---|---|---|---|---|
| `R1_geometry_validity` | 座標合法性、環閉合、自交、route 退化段 | 78 | info 78 | ✅ pass |
| `R2_bounds` | 全部座標落喺 base-map bbox / 故事舞台 bbox | 0 | — | ✅ pass |
| `R3_zone_membership` | `location.zone_ids` 落喺 polygon 內或合理接近 | 159 | warning 6 / info 153 | ✅ pass |
| `R4_route_continuity` | route 相鄰 waypoint 距離 / 章節單調性 | 92 | warning 92 | ✅ pass |
| `R5_event_location_coherence` | `location_id` / `location_name` / coords 一致 | 9 | warning 9 | ✅ pass |
| `R6_duplicate_near_duplicate` | 標記塌縮 / 同名衝突 / 近重複 | 10 | warning 10 | ✅ pass |
| `R7_narrative_temporal` | flashback 豁免 / 章節順序一致性 | 0 | — | ✅ pass |
| `R8_unknown_over_hallucination` | 無法證明 → `unknown`/`approximate` + `needs_validation` | 0 | — | ✅ pass |
| **合計** | | **348** | **info 231 / warning 117 / fail 0** | **all_pass: true** |

關鍵 summary 數字：
- R3：`n_links` 592、`n_inside` 566、`n_events_without_zone` 169、`n_events_null_location` 16
- R4：`n_steps` 717、`p50` 610 m、`p99` 3908 m、`max` 4457 m、**`n_jumps_over_5km` 0**
- R5：`n_name_mismatch` 9（0.5%，門檻 2%）
- R6：`n_unique_coords` 490 / 704 個地點、`n_collapse_clusters` 10
- R7：`n_entries` 1320、`n_flashback` 106、`n_flashback_flag_inconsistent` **0**
- R8：`n_approx_or_fictional_without_evidence` **120**（17.1%）→ **全部**已標 `needs_validation`

> ⚠️ **R8 嘅 120 條要講清楚**：呢批地點冇 `position_source` 亦冇 `inferred_from`。B4 **冇能力**由 `data/public/` 證明佢哋嘅位置（要上游 re-inference），而規則 C1 **禁止猜**。所以 B4 嘅修復係**誠實標記**（`coordinate_review_status = "needs_validation"`），令前端顯示「位置未確認」。違規定義 = 「冇證據但**冇**標 needs_validation」（即假裝已驗證）→ 目前 **0 條**。
> `tests/test_spatial_integrity.py::test_r8_unsourced_coordinates_are_flagged` 把 120 寫成斷言 —— 上游一改，測試即刻提醒要重新審計。

`finding` 格式（規則 V2）**全部**有 `feature_id` / `rule` / `severity` / `evidence`（`tests/test_spatial_integrity.py::test_every_finding_has_four_keys` 逐條驗）。

### 6. ⚠️ 版權紅線修復

| 項 | 之前 | 之後 |
|---|---|---|
| `zones.geojson` 有 `evidence` 欄位嘅 feature | **48 / 48** | **0 / 48** |
| `evidence` 內容格式 | `ch73 原文：「…」`（成段小說原文） | 欄位**唔存在** |
| 誰寫入 | `merge_zone_dossiers.py` | 已移除寫入 |
| 取代品 | — | `chapter_refs`（章節索引）+ dossier 短摘要（≤180 字，規則 DS3） |
| 自動閘門 | 無 | `validate_public_data.py` 加 `novel_quote` pattern；`tests/test_spatial_integrity.py` 掃 `data/public/**`；`validate_spatial_narrative.py` 掃 |

**掃描結果（三個目錄，全部 0 命中）**：

```
data/public/*            命中 0
public/data/public/*     命中 0
dist/data/public/*       命中 0
（pattern：原文\s*[：:「]|ch\s*\d+\s*原文）
```

> ⚠️ 為何係「紅線」而唔係「改善」：`data/public/` 經 `npm run sync-data`（`npm run prebuild` 自動叫）複製到 `public/data/public/`，再由 `vite build` 入 `dist/` —— 即係**任何人都下載到**。48 段原文出到前端 bundle 係不可接受嘅版權事故。

### 7. Pipeline 次序（B4 之後）

```
… → propagate_location_coords.py
  → merge_zone_dossiers.py（deprecated shim，4 階段編排）
        1) 標記塌縮修復 + 座標傳播        → locations / events / routes / timeline
        2) 區域基礎合併（v1 基礎欄位）     → zones.geojson
        3) 三層 join + coordinate_* 回填  → zones / locations / events / routes / timeline + zone-membership.json
        4) zone v2 遷移 + dossier          → zones.geojson（v2）/ zone-dossiers.json
  → audit_coordinate_integrity.py        → coordinate-audit.json
  → render_coordinate_audit_report.py    → coordinate-audit-report.md
  → validate_spatial_narrative.py
  → link_event_characters.py → build_chronicle.py → normalize_public_data.py
  → update_manifest.py → sync_public_data.py
```

> ⚠️ **次序唔可以調亂**：塌縮改地點座標 → 基礎合併用新座標算 zone 幾何 → join 用最終幾何做 point-in-polygon → v2 遷移用最終 join 結果填 `event_ids`。調亂會令 pipeline **非冪等**（第一次同第二次跑出唔同結果）。

---

## 修改檔案

### 新增

| 檔案 | 內容 |
|---|---|
| `docs/contracts/b4-interface-contract.md` | **先寫嘅介面契約**（spec §4.4 要求）：44 欄 zone v2、dossier schema、4 條 backfill 規則、confidence 公式、review_status 判定、三層 join、塌縮規則、B3／B6 消費方式 |
| `scripts/infer_zone_membership.py` | 三層 join + `coordinate_*` 回填 + 塌縮修復（`--phase {collapse,join,all}`） |
| `scripts/build_zone_dossiers.py` | zone v2 遷移 + `zone-dossiers.json` |
| `scripts/audit_coordinate_integrity.py` | R1–R8（`finding()` 保證四 key） |
| `scripts/validate_spatial_narrative.py` | 雙向連結 + dossier 引用 + 版權掃描 |
| `scripts/render_coordinate_audit_report.py` | 審計 → 粵文 markdown |
| `data/schemas/zone-dossier.schema.json` | dossier schema（`$defs`: governance／society／infrastructure／risk_profile／nest_profile） |
| `data/public/zone-dossiers.json` | 48 份 dossier（`generated_from` 記 4 個輸入檔 SHA-256，**冇 timestamp**） |
| `tests/test_spatial_integrity.py` | **36 條**測試（見下） |
| `artifacts/b4/coordinate-audit.json`、`coordinate-audit-report.md`、`zone-membership.json` | 審計輸出 |

### 修改

| 檔案 | 改動 |
|---|---|
| `scripts/merge_zone_dossiers.py` | **deprecated shim**：4 階段編排；**移除 `evidence` 寫入**；**刪走 2 個 private 讀取**（實測貢獻 0）；**移除反向 `zone_ids` 寫入**（改由三層 join 負責） |
| `scripts/derive_zones.py` | 標 deprecated + `--force-deprecated` 守門（直接跑 **exit 2**）—— 防止雙軌寫入覆蓋 v2 |
| `scripts/validate_public_data.py` | +`zone-dossier.schema.json` 驗證、+`novel_quote` 紅線、+zone v2 欄位／enum／映射／confidence 公式檢查、+雙向連結檢查 |
| `scripts/build_public_dataset.py` | manifest counts 由磁碟重算 `zone` / `zone_dossier` / `chronicle_entry` / `chapter_summary`（原本只寫 5 個 dataset，其餘 count 靜默消失） |
| `scripts/update_manifest.py` | 加 `zone_dossier` count（`dossiers` 容器，唔可以 fall through 到 `len(d)`） |
| `scripts/run_pipeline.py` | 加 3 個 B4 步驟（audit / report / narrative）；更新步驟描述 |
| `data/schemas/zone.schema.json` | **v2**：required 加 12 個新欄位（保留 `kind`）；**`evidence` 欄位完全移除** |
| `data/public/zones.geojson` | v2（44 欄） |
| `data/public/locations.geojson` | `zone_ids` 修正（88 → 587）+ `zone_membership_*` + 4 個 `coordinate_*` |
| `data/public/events.geojson` | `zone_id` + 4 個 `coordinate_*` |
| `data/public/routes.geojson` | waypoint `coordinate_*` |
| `data/public/timeline.json` | 座標傳播 |
| `data/public/asset-manifest.json` | `counts.zone_dossier: 48` |
| `tests/test_data_normalization.py` | `test_zone_evidence_quotes_chapters` → **`test_zone_evidence_is_not_leaked_to_public`**（由「要求有 evidence」反轉為「禁止 evidence」） |
| `tests/test_public_data.py` | manifest counts 加 `zone_dossier`（順手 dedupe 重複嘅 `chronicle_entry` key） |
| `public/data/public/*`、`dist/data/public/*` | 只經 `npm run sync-data` / `npm run build` |

### 沒有修改但相關

- `src/**`（B1/B2/B5/B6/B7/B8 專屬）、`public/assets/**`、`package.json`、`vite.config.ts`、`tsconfig.json`、`tests/visual-smoke.e2e.test.ts`
- `scripts/audit_location_coords.py` / `propagate_location_coords.py`（上游座標審核／傳播，B4 只讀）
- `data/private/**`（**B4 冇新增任何讀取**）

---

## 驗證命令與結果

```bash
# 1. 單元測試（python3.12；預設 python 3.13 冇 pytest）
"C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe" -m pytest -q
# ✅ 260 passed in 29.08s
#    baseline（B4 之前）：224 passed
#    B4 新增 36 條（tests/test_spatial_integrity.py）

# 2. 4 階段 pipeline（第一次）
python scripts/merge_zone_dossiers.py
# ✅ event→zone：674（37.5%）→ 1627（90.6%）  目標 85% ✅
#    zone 48 → dossier 48（nest_profile 21）

# 3. 座標完整性審計
python scripts/audit_coordinate_integrity.py
# ✅ 8 條規則全部 pass；findings 348（info 231 / warning 117 / fail 0）
# ✅ 失敗規則：（無）

# 4. 審計報告 + 敘事一致性 + 版權掃描
python scripts/render_coordinate_audit_report.py
python scripts/validate_spatial_narrative.py
# ✅ 全部通過（R1–R8 + 敘事層一致性）；版權掃描 0 個問題

# 5. 公開資料驗證（schema + 引用 + 治理 + manifest + provisional gate）
python scripts/validate_public_data.py
# ✅ 全部通過
#    公開資料驗證：{'location': 704, 'event': 1796, 'route': 42, 'timeline': 1796,
#                  'character': 330, 'zone': 48, 'zone_dossier': 48,
#                  'chronicle_entry': 1320, 'chapter_summary': 195}

# 6. 完整管線（16 步）
python scripts/run_pipeline.py
# ✅ 管線完成（16 步全部成功）

# 7. 前端
npm run sync-data   # ✅ 覆核通過（12 個檔一致）
npm run typecheck   # ✅ 0 error
npm run build       # ✅ built in 301ms；dist/assets/index-*.js 144.95 kB
```

### Idempotency（硬性）—— 完整管線跑兩次，SHA-256 完全一致

```
$ python3.12 scripts/run_pipeline.py   # 第一次
$ python3.12 scripts/run_pipeline.py   # 第二次
$ diff <(hash run1) <(hash run2)
✅ 完整管線 10 個輸出 SHA-256 一致
```

| 輸出檔 | SHA-256 |
|---|---|
| `data/public/zones.geojson` | `45a4520dc8d62438f7327987b472e89f6b97a23ac00b3d2cce9e754a506f1c86` |
| `data/public/zone-dossiers.json` | `7ced63e91546b1cfc7788b8b4957175bbe36b5267aac8454b924012f4ca1fa53` |
| `data/public/locations.geojson` | `599a59e23ef342352f7ea04f2a154cd96607aa0e7b4664879048bafbcef09c28` |
| `data/public/events.geojson` | `9a2209972c9323bbc77ab39cce363e57932f1ca4cfa553fef2bbbd220484c6ff` |
| `data/public/routes.geojson` | `98c0510499a25ae546b809ec07f4a447c670a6f1bc7eebbf6c630476ac2452b7` |
| `data/public/timeline.json` | `25c485351deaf20a330319d5115e2f015405f849538d396f474b7bf2eb8399f5` |
| `data/public/asset-manifest.json` | `13cf4ac8ace3c38f1e24b66f3b180cb8d98467fa8cca69d0fe1b6dc36b6bd1a8` |
| `artifacts/b4/zone-membership.json` | `7517482bdb26831fd117eaa69af547e81bb8229dc0933f3d804a1263be8f3c15` |
| `artifacts/b4/coordinate-audit.json` | `03ca1d51a52f8105d52e9dfcff10c37ebca3527abd2d01b80e9982d7a5cddcb3` |
| `artifacts/b4/coordinate-audit-report.md` | `517f4fd685ecc0dffb11e28ceb133c68ab64dfbe903a1bc9256a2e9616b78d20` |

**為何做到冪等（三個關鍵決定）**：

1. **塌縮必須係獨立 phase，喺 zone 幾何計算之前** —— zone polygon 由成員座標推導（凸包 + 外擴）。如果先算幾何、後散佈，第二次跑就會用新座標算出唔同幾何。`run()` 因此**唔再做**塌縮。
2. **Artifact 只記「狀態」，唔記「動作」** —— 「今次移動咗 18 個」第一次係 18、第二次係 0（唔穩定）；「而家仲有幾多塌縮簇、幾多被鎖」散佈完成後固定（穩定）。所以 `marker_collapse_state` 取代咗 `n_moved`。
3. **`legacy_baseline` 寫死做常數** —— join 一寫入 `zone_ids`，「before」就等於上一次嘅「after」。要保留「B4 之前 vs 之後」對比，唯一穩定做法係記住 Gate 1 實測值。
4. **固定 properties 鍵序**（`ZONE_KEY_ORDER`，44 個）+ **冇 timestamp** + `generated_from` 記輸入 hash。

`tests/test_spatial_integrity.py::test_pipeline_is_idempotent` 每次跑 pytest 都會驗一次；
`tests/test_apply_inferences.py::test_pipeline_is_idempotent` 另外驗完整管線對 `locations.geojson` 嘅冪等性。

### 新增測試清單（`tests/test_spatial_integrity.py`，36 條）

| 類別 | 條數 | 內容 |
|---|---|---|
| 規則 V1–V4 | 5 | 八條規則齊全、finding 四 key、threshold 寫死、input hash、冇 rule fail |
| R6 塌縮 | 5 | 冇非推斷塌縮堆、**塌縮跳過 `inferred_from`（單元測試）**、確定性、狀態報告 |
| R8 誠實 | 5 | 冇證據必須標 `needs_validation`（+ 120 常數）、enum 合法 ×2、dossier 冇空字串 |
| ⚠️ 版權 | 3 | `data/public/**` 掃 `原文`、zone 冇 `evidence`、dossier 冇 evidence excerpt |
| Zone v2 | 9 | 19 個 v2 欄位齊、schema_version、kind→zone_type、danger 查表、token 唔係 hex、confidence 公式、review_status 別名、dossier_id 推導、schema 驗證 |
| 雙向 join | 5 | event↔zone、location↔zone、覆蓋率 ≥85%、dossier 引用、DS2 nest_profile |
| Idempotency | 3 | 完整管線跑兩次比 7 個 hash、shim 標 deprecated、`derive_zones` 守門 |

---

## Screenshots / Artifacts

| 檔案 | 內容 |
|---|---|
| `artifacts/b4/coordinate-audit.json` | R1–R8 完整 findings（348 條）+ thresholds + input hash |
| `artifacts/b4/coordinate-audit-report.md` | 粵文審計報告（由 `render_coordinate_audit_report.py` 生成） |
| `artifacts/b4/zone-membership.json` | 覆蓋率、join 來源／狀態、塌縮狀態、460 條 join audit、`legacy_baseline` |
| `docs/contracts/b4-interface-contract.md` | 介面契約（B3／B6 消費方式喺 §9） |

---

## 風險、衝突、限制

### C1（需主代理知悉）—— 169/171 個塌縮成員被上游推斷鎖定，B4 解唔到

10 個塌縮簇共 171 個成員，其中 **169 個帶 `inferred_from`**（最大一簇 103 個喺 `[114.25343, 22.30581]`）。移動佢哋會令 `tests/test_apply_inferences.py::test_applied_coordinates_match_inference` 失敗（座標必須等於推斷記錄）。

**B4 嘅處理**：散佈可動嘅 18 個 + 誠實記錄鎖定嘅 169 個（`marker_collapse_state` + R6 warning）。
**未解**：要真正解開，**必須上游 re-inference**（重新推斷呢批地點嘅位置，令 `inferred_from` 指向新座標）。**唔可以**由 B4 單方面移動。

### C2（需主代理知悉）—— 120 條地點冇座標證據（R8）

120 個 `approximate`／`fictional` 地點冇 `position_source` 亦冇 `inferred_from`。B4 **冇能力**由 `data/public/` 證明位置，規則 C1 禁止猜。
**B4 嘅處理**：全部標 `coordinate_review_status = "needs_validation"`（前端顯示「位置未確認」）。
**未解**：同樣要上游 re-inference。B4 已把 120 寫成斷言，上游一改就會提醒。

### C3（需主代理裁決）—— `outpost` → `contested` 嘅語意弱（migration plan R10）

16 個 `outpost` 全部映射為 `contested`（`danger_level: 3`）。但文中「不良人據點」同「中立爭議區」語意唔完全一樣 —— 前者係**敵對控制區**，後者係**控制權未定**。
**B4 嘅處理**：照 spec §5.2 映射（確定性、可稽核），並保留 `kind: "outpost"` 向後兼容。
**建議**：如果 B6 要用顏色／圖示區分「敵對」vs「爭議」，應該喺 `zone_type` 加值（例如 `hostile_outpost`），而**唔係**喺 B4 亂改映射。

### C4（需主代理知悉）—— `tests/test_apply_inferences.py::ready` 會跑完整管線

該 fixture 跑 `run_pipeline.py`（16 步），即係會寫 `data/public/*`。所以「手動只跑 `merge_zone_dossiers.py`」同「跑完整管線」嘅 hash **唔同**（後者係 superset：上游 `anchor_fictional` / `corrections` 會改地點座標）。
**影響**：idempotency 比對**一定要用同一入口**。本報告用「完整管線」為準（較強）。

### C5（需主代理知悉）—— `dist/data/public/` 要 build 之後才同步

`sync_public_data.py` 會警告 `dist/data/public` 有 7 個檔同來源唔一致 —— 呢個係**正常**（`dist/` 係 build 產物）。`npm run build` 之後就會一致。

### 限制

1. **`society.daily_life` 只有 20.8%**、`infrastructure.security` 35.4% —— 呢啲係 A6 實測嘅資料缺口（原文本身少講），**唔可以**靠推測補。UI 應該顯示「資料未足以確認」。
2. **`legitimacy` / `mobility` 100% `"unknown"`** —— public 資料冇獨立來源。
3. **`timeline` 唔喺 `evidence_sources`** —— 記入 `generated_from` 但唔貢獻欄位（列咗就係虛報）。
4. **`status` 43/48 係 `unknown`** —— 只有 ch198 出現（`active`）或內文有「已毀」類字眼（`collapsed`）才敢填。
5. **`kind` 保留**（唔係移除）—— 規則 Z2 要求前端只讀 `zone_type`，但 `kind` / `kind_votes` 係審核依據，唔可以刪。

---

## 給主代理的 integration note

1. **B3（Data Adapter）**：`zones.geojson` **只讀 `zone_type`**（唔讀 `kind`）；`zone-dossiers.json` 建議 **lazy-load**（唔好首屏 eager load，48 份 dossier 唔細）；join key 用 `zone.dossier_id` ↔ `dossier.id`。
2. **B6（Map Interaction）**：`display_style.fill` 係 **B1 token 名**（`--zone-survivor` / `--zone-nest` / `--zone-quarantine` / `--zone-contested` / `--zone-unknown`），**唔係** hex → 直接用 `var(--zone-...)`。`danger_level === null` **唔可以**當 0。`review_status === "needs_validation"` 或欄位係 `"unknown"` → 顯示「資料未足以確認」。
3. **`zone_review_status` 係別名**：B2 嘅 `ZoneProperties.zone_review_status` 同 spec 嘅 `review_status` 兩個都存在且值相同（`test_zone_review_status_alias_consistent` 把關）。B3 可以讀任何一個。
4. **`spatial_evidence_count` 定義**：B4 定案（spec §2.2 原文含糊）—— 見契約 §3.2。四個 layer 各有公式，全部可重跑。
5. **`scripts/merge_zone_dossiers.py` 仍然係正確入口**（`npm run zones`）—— 佢係 4 階段編排器，單跑就產生完整 v2。**唔好**直接跑 `scripts/derive_zones.py`（已守門 exit 2）。
6. **`npm run prebuild` 會自動 `sync-data`** —— 所以 `npm run build` 已經包含同步，唔需要手動跑。
7. **B4 冇讀 `data/private/`** —— 並且刪走咗 `merge_zone_dossiers.py` 原有嘅 2 個 private 讀取（實測貢獻 0 個 zone）。如果之後有人加返，`validate_public_data.py` 嘅 `novel_quote` 紅線會擋。

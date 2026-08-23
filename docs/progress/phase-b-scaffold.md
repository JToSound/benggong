# Phase B（骨架）進度報告 — 《病港》互動地圖

> 日期：2026-08-24
> 範圍：Phase A 驗收 + Phase B 所需嘅 schema、資料模型、review queue、provisional sample dataset、unit tests
> **本階段無呼叫 OpenRouter、無啟動 ComfyUI、無產生 tiles、無任何同步或爬蟲**（按用戶指示）。

## Phase A 驗收結果 — PASS

詳細驗收數據見 `docs/progress/phase-a-acceptance.md`。摘要：

- `docs/progress/phase-0-and-a.md` 存在並已展示摘要
- git working tree clean；`data/private/` 全部 7 個檔案逐一確認未被追蹤
- cleaned corpus：198 章、零缺失、零重複；2,978,556 → 908,482 字（移除 69.5%）
- validate：0 errors / 31 warnings（短章字數）；八類雜訊獨立重掃全部零殘留

## Phase B 骨架產出

### JSON Schema（`data/schemas/`，7 個）

| Schema | 對應 | 重點約束 |
|---|---|---|
| `location.schema.json` | locations.geojson | `story_position` 0–1；`location_precision` 四級；虛構不可配真實坐標語義 |
| `event.schema.json` | events.geojson | description ≤200 字；id 格式 `bg_event_NNN`；8 種 event_type |
| `route.schema.json` | routes.geojson | waypoints 必須保留原始座標；color hex 格式 |
| `timeline.schema.json` | timeline.json | 無可靠日期時 `date_label=按章節先後`、`date_sort=chNNN` |
| `character.schema.json` | characters.json | §7.7 全部必填欄位；portrait_asset_id 可 null |
| `evidence-candidate.schema.json` | 私有 candidates.jsonl | evidence_excerpt ≤300 字屬私有；needs_review_reasons 七類 |
| `extraction-run.schema.json` | 私有 run ledger | 只記 metadata+hash；attempt ≤2；敏感正文禁入 |

### TypeScript 資料模型（`src/types/dataset.ts`）

全部公開實體型別 + `BingGangDataset` bundle 型別 + `ProvisionalMeta`（banner 要求）+ §7.7 預設配色常數。《病港2》以 `"bing_gang_2"` source 值預留，現階段零內容。

### Provisional sample dataset（`data/public/`，18 項記錄）

- `locations.geojson`（4）：將軍澳／寶琳（真實參考位置）＋大本營（虛構）＋主角住所（unknown）
- `events.geojson`（4）、`routes.geojson`（1 條主角路線）、`timeline.json`（4）、`characters.json`（5）
- `map-config.json`：provisional banner、scale_profile 標記為 unreliable、AI 圖層 disclaimer
- `asset-manifest.json`：版本、counts、治理備註

**證據基準**：所有首現章節同事件描述均經全書文本掃描核實（如將軍澳首現第 11 章、寶琳第 25 章、大舊第 2 章），非憑空捏造；坐標明確標示只作 render 投影。全部 `needs_review`。

### 私有 review queue 骨架（`data/private/review/review-queue.json`）

七類審閱分類（conflict／low_confidence／location_unknown／time_conflict／high_spoiler／possible_hallucination／invalid_schema）＋items/resolved 結構。gitignored。

### 驗證工具（`scripts/validate_public_data.py`）

JSON Schema validation（Feature 層）＋治理掃描（>100 字連續 CJK＝疑似原文、Penana 雜訊、IP／secret pattern）＋引用一致性（location_id/event_id 解析）＋manifest counts 核對＋provisional gate（有 needs_review 就必須有 banner）。執行結果：✅ 全部通過。

### 測試

- pytest 新增 `tests/test_public_data.py`（24 個）：schema 自身有效性、sample 對 schema 合規、治理規則單元測試、引用一致性、provisional gate、manifest 一致性、私有 candidate/run ledger 結構（合成樣本，唔需要 LLM）
- Vitest 新增 `tests/dataset.model.test.ts`（8 個）：TS 模型與 sample dataset 一致性、字數上限、story_position 範圍、spoiler 範圍、date_label 契約、配色契約
- 總計：pytest **47 passed**、Vitest **9 passed**、lint/typecheck/build 全綠

## 測試期間修正嘅問題

1. `validate_public_data.py` 初版 SCHEMA_FILES 對 GeoJSON 映射漏咗（None）——測試捉到，改為 Feature 層完整驗證
2. manifest counts key 單複數不一致——統一為單數
3. TS 測試缺 `@types/node` 同 ESM `__dirname` 問題——加依賴＋改用 `import.meta.url`

## 已知限制

1. Sample dataset 未經人手 review——網站必須行 provisional mode 顯示 banner（map-config 已設定）
2. `scale_profile` 未校準——距離工具只能顯示估算值（config 已鎖）
3. 正式 extraction run 需要 `OPENROUTER_API_KEY`＋用戶批准先可以開始

## 下一步（需要用戶輸入或授權）

1. 人手 review sample dataset → 升級部分記錄為 reviewed
2. 批准 OpenRouter API 後：實作 extraction pipeline（segmentation→candidates→resolve→public builder）
3. Phase C0：ComfyUI 本機 health check
4. Phase C：程序化 base map＋tile renderer

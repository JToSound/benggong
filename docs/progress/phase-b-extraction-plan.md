# Phase B Extraction Plan — 《病港》互動地圖

> 日期：2026-08-24
> 前置：cleaning pipeline 已標記 **human-sampled-approved**（`data/private/review/cleaning-approval.json`，25 章抽樣全 PASS）
> 現狀：**extraction 基建已完成並測試；真實 LLM 呼叫等待 `OPENROUTER_API_KEY`**

## 1. 模型角色

| 角色 | 設定鍵 | 用途 | 溫度 |
|---|---|---|---|
| extraction | `OPENROUTER_EXTRACTION_MODEL` | 由章節段落抽取 entity candidates | 0.1 |
| orchestrator | `OPENROUTER_ORCHESTRATOR_MODEL` | （後續）規劃、review、分派 | — |
| coding | `OPENROUTER_CODING_MODEL` | （後續）TS/Python/CI 修正 | — |

Extraction 只用一個模型呼叫類型：chat completions + `response_format: json_object`。

## 2. Token / 內容 Budget

實測（dry-run，198 章）：

- 全書 cleaned 正文：**908,482 字** → 分段後 **248 段、963,843 字符**
- 每段上限 `SEGMENT_CHAR_BUDGET = 6000` 字符；50 章需要切分為 2 段
- 每次請求：system prompt（~700 tokens）+ user prompt（segment ≤6000 字符 ≈ 3–4k tokens）
- 預計輸出：每段 ≤2000 tokens（candidates JSON）
- 估計全書總消耗：約 **1.2M input + 0.4M output tokens**（視模型定價）

### ⚠️ 實測修正（2026-08-24 試行）

`stealth/ox-alpha` 係 **reasoning 模型**：

1. **max_tokens 必須 ≥16000**——8000 時 reasoning 燒盡預算，content 回 null（finish=length）
2. 單段實測耗時 **~290 秒**、completion ~11k tokens（含 reasoning）
3. 全書 248 段估計：**20–24 小時純 API 時間**；建議分夜跑或改用非 reasoning 快模型
4. 上游間歇性 429：pipeline 已有 6 次 exponential backoff（3→120s cap）應對
5. 回應可能包 ```json fence——parser 已自動剝除

## 3. Batch Strategy

```text
章節升序 1→198，逐段處理：
  for chapter in 1..198:
    segments = build_segments(chapter, content)   # 段落邊界貪心合併
    for seg in segments:
      key = f"{chapter}:{seg_index}"
      if key in ledger.completed: skip            # 中斷續跑
      if cache.hit(prompt_hash): reuse            # 免重複計費
      call LLM (temp 0.1, strict JSON)
      ├─ ok        → candidates.jsonl append
      ├─ invalid   → retry 一次（backoff 3s/6s）→ 再失敗入 review queue
      └─ error     → 記 ledger，繼續下一段（不中斷全書）
    sleep 0.5s（polite rate limit）
```

- **Retry**：每段最多 2 attempts（master prompt §7.1 上限）；網絡錯誤同 invalid JSON 都適用
- **Cache**：`data/private/cache/extraction-runs/<run_id>/<hash>.json`；任何時刻中斷（Ctrl-C、斷網、quota）都可以直接重跑同一命令續住做
- **Run ledger**：`data/private/review/extraction-ledger.jsonl`——只記 chapter/segment/model/temp/prompt_hash/status/attempts；**永遠不記正文或完整 response**

## 4. Pipeline 三階段

### 4.1 Entity candidates（已實作 ✅）

`scripts/run_extraction.py` → `data/private/evidence/candidates.jsonl`
每條含：entity_kind / name / claim / **evidence_excerpt（私有，≤300 字原文引錄）** / confidence / spoiler_level / model_meta。

### 4.2 Cross-chapter entity resolution（已實作 ✅ deterministic 版）

`scripts/build_public_dataset.py`：

- **Locations**：正規化名稱分組；真實香港區（將軍澳／寶琳／坑口等白名單）標 reference+district 座標；唔喺白名單一律預設 fictional（保守）
- **Characters**：name+alias exact-match union-find 合併；模糊合併留人手
- 產出人手審閱文件：`data/private/review/entity-resolution.md`
- slugify 教訓：中文名無法入 ASCII id schema → hash id（`ent_<sha1[:10]>`），顯示名保留中文

### 4.3 Public provisional dataset（已實作 ✅）

輸出 `data/public/`：locations/events/routes/timeline/characters + manifest。
治理保證（有測試把關）：無全文、無 evidence excerpt、摘要 ≤100/200 字、全部 needs_review、routes 先留空（等人手確認位置關聯先建路線，避免捏造）。

## 5. Provenance 設計

每一條公開記錄可追溯到：

```json
"model_meta": {
  "model_id": "...",
  "temperature": 0.1,
  "prompt_hash": "<sha256>",
  "schema_version": "1.0.0"
}
```

加埋 run ledger 入面嘅 run_ts / status / attempts。公開檔案帶 `dataset_version`（如 `0.2.0-provisional.20260824`）+ generator 指向。AI 資產（Phase C）另有 workflow/seed/model hash manifest（未開始）。

## 6. Human Review Gate

```text
candidates.jsonl (private)
  → resolution 審閱（你）：data/private/review/entity-resolution.md 填合併/拆分決策
  → public dataset build（deterministic）
  → scripts/validate_public_data.py（schema+治理+引用一致性）
  → 你逐項審 data/public/*.geojson（provisional sample 尺寸先行）
  → reviewed 記錄先可以由 needs_review 升級；verified 要第二双人手確認
  → 未 review 完：網站只能 VITE_PROVISIONAL_DATA_MODE=true + banner
```

**禁止事項不變**：全文／evidence excerpt／private cache 永不入 git、不入 dist、不入 console 公開輸出。

## 7. 立即執行清單（等你放 key）

```bash
# 1. 建立 .env（已喺 .gitignore；絕不可 commit）
cp .env.example .env
# 填入：
# OPENROUTER_API_KEY=sk-or-v1-…
# OPENROUTER_EXTRACTION_MODEL=<建議：deepseek/deepseek-chat 或 google/gemini-flash 系列（平+強繁中）>

# 2. 細範圍試行（第 1-5 章，驗證輸出質素＋成本）
python scripts/run_extraction.py --chapters 1-5

# 3. 檢查 candidates 同成本，然後全書
python scripts/run_extraction.py           # 中斷可直接重跑續住

# 4. Resolution + public dataset + 驗證
python scripts/build_public_dataset.py
python scripts/validate_public_data.py
```

預計全書 API 時間：248 段 × (~10s + 0.5s delay) ≈ 45–60 分鐘。

## 8. 測試覆蓋（本階段新增 14 個）

分段 budget/hash、缺 key 阻擋、ledger/cache/store 讀寫、location/character resolution 規則（含「未知地點預設 fictional」）、builder 端到端、**evidence 洩漏防護**、needs_review 強制、真實區座標保留。全部通過（總計 pytest 61 passed）。

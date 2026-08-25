# Phase B Extraction 運行日誌 — 《病港》互動地圖

> 最後更新：2026-08-25 21:55（UTC+8）
> 相關：`phase-b-extraction-plan.md`（設計）、`phase-b-review-preparation.md`（審閱前置）

## 現狀摘要（2026-08-25 晚）

| 項目 | 數值 |
|---|---|
| 已完成章節 | **ch1–54 / 198**（57 段全 ok，零錯誤）|
| Candidates | **1,212**（schema 違規 0）|
| 公開 dataset | locations 131 · events 327 · timeline 327 · characters 86（全 needs_review + banner）|
| 剩餘 | ch55–198（約 190 段；run 運行中）|

守夜 run 昨晚配額重置後自動跑了 ch17–54；今早重啟後由 cache 秒過 ch1–54，現正真實呼叫 ch55 起。

| 項目 | 數值 |
|---|---|
| 已完成章節 | **16 / 198**（ch1–16 全部 ok） |
| Candidates 入庫 | **366**（data/private/evidence/candidates.jsonl） |
| Ledger 記錄 | 27 條：ok=16、error=8（歷史試行失敗，已全部重跑成功）、review_queue=3 |
| 剩餘段落 | 232 |
| 阻塞原因 | **OpenRouter 免費層每日配額耗盡**（free-models-per-day-stealth：1000/日） |

## 今日完成

1. **試行驗證通過**：頭 3 章 97 candidates；抽取質素良好
   （夏晴 conf=0.97、大舊 0.95、阿明 0.9、大本營 0.95 等）
2. **Reasoning 模型適配三連修**（commit `fc740da`）：
   - max_tokens 8000→16000（reasoning 燒盡預算會令 content=null）
   - 兩層 retry（暫時性錯誤 6 次 exponential backoff；schema 錯誤 2 次）
   - JSON fence 自動剝除
3. **全書 run 啟動並穩定運行至 ch16**（零新失敗）

## 配額中斷事件

- 錯誤：`429 free-models-per-day-stealth, Remaining: 0`
- 重置時間：**2026-08-25 08:00 UTC+8**（X-RateLimit-Reset 確認）
- 應對：
  1. 斷點續跑機制保住全部進度（ledger + cache）
  2. 已建立 Windows 排程任務 `BingGangExtractionResume`
     （明早 08:10 自動執行 `scripts/run_extraction_task.bat` 續跑剩餘 232 段）
  3. 新增 `scripts/check_rate_limit.py`（讀 rate-limit headers，唔消耗配額）

## 明日配額恢復後流程

```text
08:10 排程自動續跑 → 全書完成（估計 15–19 小時 API 時間）
→ 檢查 extraction-last-run.json 同 ledger 分佈
→ 對 review_queue/error 段落重跑補漏
→ python scripts/build_public_dataset.py（resolution + provisional public dataset）
→ python scripts/validate_public_data.py
→ 用戶人手審 data/private/review/entity-resolution.md
```

## 抽取質素初步觀察（ch1–16, n=366）

- 實體類型分佈健康（location／character／event／time_reference 四類都有）
- 高 confidence 主導（多數 ≥0.85），低 confidence 記錄保留原值待人手判斷
- evidence_excerpt 全部留喺私有層；公開輸出只含 claim 摘要（builder 保證＋測試把關）

## 已知限制

1. `stealth/ox-alpha` 免費配額 1000 req/日 → 全書需跨兩日跑完
2. 單段 ~290 秒（reasoning 模型較慢）；如要加速可改用非 reasoning 模型（`.env OPENROUTER_EXTRACTION_MODEL`）
3. 舊 error/review_queue ledger 記錄保留作稽核（append-only 原則）；統計時以「每段最後一條記錄」為準

## 2026-08-24 下午：下游開發（用現有 366 candidates）

配額等待期間完成咗成條下游 pipeline 嘅首次真實數據演練：

1. **首次真實 public dataset 生成**：locations 53 / events 105 / timeline 105 / characters 41，validate_public_data 全綠
2. **`resolution_enhance.py`**：四類自動決策建議——括號合併（M（主角）→M 等 9 組）、模糊指代剔除（呢一區／安區／首領）、歧義子設施標記（圖書館／醫療室：大本營內 vs 城市中）、名稱變體群組（商場系 6 個寫法、大本營市集系等 13 組）→ `data/private/review/resolution-decisions.md`
3. **Bug 修復**：
   - `strip_parenthetical` NFKC 半形括號失效
   - candidate_id 斷點續跑撞號（count_existing）
   - event.location_id 允許 null（未指派狀態）
4. **測試**：pytest 72 passed（+11 resolution 規則測試）、vitest 9、lint/typecheck/build 全綠
5. **守夜 run**：背景 process 持續運行，每 10 分鐘探測配額，重置後自動全速續跑 ch17–198

### 待辦（人手）

- 審閱 `data/private/review/resolution-decisions.md`：確認合併/剔除/歧義決定
- 全書 extraction 完成後重跑 builder + validator 得到最終 provisional dataset

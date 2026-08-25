# 《病港》互動地圖 — 最終驗收報告

> 生成時間：2026-08-25 23:18 +0800
> 本報告由 `scripts/build_final_report.py` 自動生成；只含統計與路徑引用，無小說內容。

## Extraction 完成度

| 指標 | 數值 |
|---|---|
| 預期章節 | 198 |
| 已有記錄章節 | 66 |
| 全段 ok 嘅章節 | **66** |
| 段落狀態 | ok 69 · review_queue/error 1 |
| Candidates 入庫 | **1,522** |

### Candidates 分佈（kind/status）

| 類別/狀態 | 數量 |
|---|---|
| character/pending | 654 |
| event/pending | 400 |
| location/pending | 339 |
| time_reference/pending | 129 |

## 公開 Dataset

| 實體 | 數量 |
|---|---|
| location | 131 |
| event | 327 |
| route | 0 |
| timeline | 327 |
| character | 86 |

- needs_review 記錄：871（全部喺 provisional mode + banner 下運行）
- 驗證：`python scripts/validate_public_data.py` ✅（schema／治理掃描／manifest／provisional gate）
- Release audit：`python scripts/audit_release.py --strict` 於 CI 執行

## Phase A 清理（已 human-sampled-approved）

- 有效章節：見 cleaning-report.json／198
- 詳細數據見 `data/private/review/cleaning-report.json`（私有）

## 人手審閱待辦

1. `data/private/review/entity-resolution.md` — 實體合併決策覆核
2. `data/private/review/candidates-stats.md` — 抽取質素總覽
3. 抽查 `data/public/` 事件摘要（尤其低 confidence 記錄）
4. 批准後先可以將 provisional_mode.enabled 改 false（移除 banner）

## ⚠️ 現狀：extraction 未完全

- 未完成章節 132 個：67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86…
- review_queue/error 段落 1 個——重跑 `python scripts/run_extraction.py` 自動補

## 版本紀錄

- Phase A 清理 pipeline：human-sampled-approved（25 章抽樣）
- Extraction：OpenRouter stealth/ox-alpha，temp 0.1，strict JSON schema，run ledger + cache
- Resolution：用戶確認規則（resolution-rules.json v1）
- 前端：vite + leaflet 本機 tiles；網絡紅線雙層審計通過

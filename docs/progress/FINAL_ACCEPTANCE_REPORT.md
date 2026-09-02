# 《病港》互動地圖 — 最終驗收報告

> 生成時間：2026-09-03 04:57 +0800
> 本報告由 `scripts/build_final_report.py` 自動生成；只含統計與路徑引用，無小說內容。

## Extraction 完成度

| 指標 | 數值 |
|---|---|
| 預期章節 | 198 |
| 已有記錄章節 | 198 |
| 全段 ok 嘅章節 | **198** |
| 段落狀態 | ok 248 · review_queue/error 0 |
| Candidates 入庫 | **6,670** |

### Candidates 分佈（kind/status）

| 類別/狀態 | 數量 |
|---|---|
| character/pending | 2679 |
| event/pending | 1796 |
| location/pending | 1653 |
| organization/pending | 2 |
| time_reference/pending | 540 |

## 公開 Dataset

| 實體 | 數量 |
|---|---|
| location | 641 |
| event | 1796 |
| route | 0 |
| timeline | 1796 |
| character | 300 |

- needs_review 記錄：4533（全部喺 provisional mode + banner 下運行）
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

## 版本紀錄

- Phase A 清理 pipeline：human-sampled-approved（25 章抽樣）
- Extraction：OpenRouter minimax/minimax-m3:free，temp 0.1，strict JSON schema，run ledger + cache
- Resolution：用戶確認規則（resolution-rules.json v1）
- 前端：vite + leaflet 本機 tiles；網絡紅線雙層審計通過

# Phase B 最終整合報告 — 《病港》互動地圖

> 生成時間：2026-08-26 02:31（由 scripts/final_integration_report.py 自動產出）

## 1. Extraction 統計

| 指標 | 數值 |
|---|---|
| 完成段落 | 99 ok ／ 101 段 |
| 已覆蓋章節 | **94 / 198**（47%） |
| 未解段落 | 2 |
| Candidates 總數 | **3445** |
| 實體分佈 | location 786 · event 990 · character 1413 · time_reference 256 |
| 高信心（≥0.9）| 2746/3445（80%） |

### 未解段落

- ch80:0 → `error`（OpenRouter 回應 content 空白或非字串（finish_reason=length））
- ch87:0 → `invalid_schema_review_queue`（OpenRouter 回應 content 空白或非字串（finish_reason=error））

> 重跑 `python scripts/run_extraction.py` 會自動重試呢啲段落。

## 2. 公開 Provisional Dataset

| 檔案 | 記錄數 |
|---|---|
| locations.geojson | 280 |
| events.geojson | 980 |
| routes.geojson | 0（待人手審閱 routes 後填充） |
| timeline.json | 980 |
| characters.json | 143 |
| **總計** | **2383** |

全部標記 `needs_review`：2383/2383；provisional banner 啟用中。

## 3. 角色路線推導（私有，待人手審閱）

- 推導出路線：**28** 條（`data/private/review/character-routes.json`）
- 全部 `provisional: true`；審閱確認後先會寫入公開 routes.geojson

## 4. 品質門

| 門 | 工具 |
|---|---|
| Schema 驗證 | validate_public_data.py（schema/治理掃描/manifest/provisional gate） |
| Release audit | audit_release.py --strict（CI 強制） |
| 網絡紅線 | vitest 靜態掃描 + Playwright 動態攔截 |
| Python 測試 | pytest（83+） |
| 前端測試 | vitest（21+） |

## 5. 剩餘人手審閱項目

1. `data/private/review/entity-resolution.md` — 合併/剔除決策複核
2. `data/private/review/character-routes.json` — 28+ 條路線逐條確認
3. 抽查高章節事件摘要質素（ch80+ 描述較長）
4. 批准後：重跑 builder 得到最終 public dataset

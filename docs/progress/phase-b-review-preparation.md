# Phase B 審閱準備 — 《病港》互動地圖

> 日期：2026-08-24
> 範圍：OpenRouter extraction 前嘅私有資料人手審閱準備
> **本階段零 OpenRouter 呼叫、零 ComfyUI、零 tiles、零同步爬蟲、零 push/deploy。**

## 1. 抽樣方法

由 `data/private/cleaned/bing-gang.clean.jsonl`（198 章）以 deterministic 抽樣器
`scripts/build_review_sample.py`（seed `20260824`）建立 stratified sample：

| 層 | 範圍 | 抽取數 |
|---|---|---|
| 早期 | issue 1–20 | 5 |
| 中期 | issue 21–130 | 7 |
| 後期 | issue 131–198 | 5 |
| 短章 warning | 31 章按字數升序 | 8 |
| 隨機補足 | 去重後未達 25 個獨立 issue 嘅差額 | 1 |

**去重後合共 25 個獨立 issue**（第 36 章同時屬中期層同短章組，聯集計算確保達標）。

## 2. 抽樣 issue index 清單

- **早期（5）**：2, 4, 11, 13, 15
- **中期（7）**：24, 78, 82, 94, 109, 117, 127
- **後期（5）**：138, 153, 157, 186, 189
- **短章 warning 樣本（8，字數升序）**：141, 90, 64, 46, 51, 78, 36, 147
- **隨機補足（1）**：23

**最終樣本（25）**：
`[2, 4, 11, 13, 15, 23, 24, 36, 46, 51, 64, 78, 82, 90, 94, 109, 117, 127, 138, 141, 147, 153, 157, 186, 189]`

機讀清單：`data/private/review/review-sample.json`

## 3. 短章分布（31 章）

| 字數區間 | 章數 |
|---|---|
| <1,000 | 8（141:343、90:544、64:698、46:808、51:906、78:987）等 |
| 1,000–1,500 | 4 |
| 1,500–2,000 | 9 |
| 2,000–2,500 | 10 |

Warning 組內最短 343／中位數約 1,957／最長 2,340；佔全書 31/198（15.7%）。
詳細逐章統計＋首尾節錄：`data/private/review/short-chapter-analysis.md`
（只含每章 ≤120 字節錄，無全文輸出；已驗證最長行 136 字符。）

## 4. 待用戶人手填寫嘅檔案路徑

| 檔案 | 用途 | 狀態 |
|---|---|---|
| `data/private/review/manual-review-packet.md` | **主要審閱文件**：25 章逐章 head/tail 500 字＋五項檢查＋PASS/FAIL 欄 | ⬜ 等你填寫 |
| `data/private/review/manual-review-checklist.md` | 審閱準則、FAIL 標記方法、regex 修復流程 | 已備妥（參考用） |
| `data/private/review/short-chapter-analysis.md` | 31 章短章統計＋節錄，輔助判斷短章是否完整 | 參考用 |
| `data/private/review/review-findings.json` | 如有 FAIL，按 checklist 第四節格式建立並記錄 | 由你按需建立 |

全部位於 `data/private/`，gitignored，永不 commit／deploy。

## 5. 本階段新增工具

| Script | 功能 |
|---|---|
| `scripts/build_review_sample.py` | deterministic 分層抽樣 → packet + review-sample.json |
| `scripts/analyze_short_chapters.py` | 短章 warning 全量統計 + 分布直方圖 + 逐章明細（無全文） |

兩者均可重跑；cleaned 檔不變則輸出不變（seed 固定）。修復 regex 後重跑即重新生成。

## 6. 驗證狀態

pytest 47 passed / Vitest 9 passed / lint ✅ / typecheck ✅ / build ✅
（詳細見同日 commit 記錄。）

## 7. 下一步

1. **等你**：按 checklist 審閱 packet 內 25 章，填 PASS/FAIL/不確定 + note
2. 有 FAIL → 按 checklist 第五節流程修 regex 重跑；全部 PASS/可接受 → 批准進入 extraction
3. 你明確批准後先會：實作 OpenRouter extraction pipeline（segmentation → candidates → resolve → public builder）

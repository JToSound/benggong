# Phase A 驗收報告 — 《病港》互動地圖

> 驗收日期：2026-08-24
> 驗收依據：`prompts/master-prompt.md`（注意：實際路徑係 `prompts/`，workspace 內無 `docs/prompts/`）
> 對應實作 commit：`a366946`（Phase 0+A）、`d2e9bc9`（AGENTS.md）

## 1. 進度文件

`docs/progress/phase-0-and-a.md` 存在，完整記錄 Phase 0 稽核、初始化、Phase A 清理與驗證、已知限制、下一步。

## 2. Git status

```text
On branch main
nothing to commit, working tree clean
```

兩個 commit：
- `a366946` Phase 0+A：repo 初始化、文件、Vite+TS+CI skeleton、清理與驗證 pipeline
- `d2e9bc9` AGENTS.md（用戶批准後寫入）

## 3. data/private/ 追蹤狀態 — ✅ 全部未被追蹤

| 檢查 | 結果 |
|---|---|
| `git ls-files -- 'data/private/*'` | **0 個檔案** |
| 實際存在 disk 嘅 7 個 private 檔案逐一比對 | 全部 ✓ ignored |
| `git check-ignore -v` 抽查 | `.gitignore:5:data/private/` 命中 |

Private 盤點（全部 gitignored，永不部署）：
`raw/Bing-Gang-_full.jsonl`、`cleaned/bing-gang.clean.jsonl`、`cleaned/bing-gang.clean.md`、`review/cleaning-report.json`、`review/cleaning-report.md`、`review/input-manifest.json`、`review/validation-report.json`

## 4. clean_novel.py 產出統計

| 項目 | 數值 |
|---|---|
| 有效章節 | **198**（issue 1–198） |
| 缺失章節 | **無** |
| 重複章節 | **無** |
| issue/0 | 已排除（原檔行 1） |
| parse errors | 0 |
| 清理前總字數（重算） | 2,978,556 |
| 清理後總字數（重算） | 908,482 |
| 移除 | 2,070,074 字（69.5%；原文約 69% 係 Penana 版權雜訊／UI／讀者名單） |

異常章節清單（31 章，全部係「短章字數偏離中位數 4260」warning，按規格只警告不刪除）：

| 章 | 字數 | 章 | 字數 | 章 | 字數 |
|---|---|---|---|---|---|
| 12 | 2,223 | 40 | 1,722 | 95 | 1,973 |
| 16 | 1,373 | 41 | 2,216 | 98 | 2,026 |
| 21 | 1,603 | 42 | 2,285 | 108 | 2,340 |
| 23 | 2,282 | 44 | 1,771 | 141 | 343 |
| 29 | 1,779 | 46 | 808 | 142 | 2,023 |
| 31 | 1,821 | 47 | 2,151 | 147 | 1,198 |
| 34 | 2,142 | 48 | 2,195 | 167 | 1,937 |
| 35 | 2,127 | 51 | 906 | 190 | 1,883 |
| 36 | 1,145 | 64 | 698 | 78 | 987 |
| 37 | 1,250 | 72 | 2,240 | 79 | 1,957 |
| 90 | 544 | | | | |

其他類別異常（low_text_ratio、high_punctuation、control_chars、duplicate hash）：**零**。

## 5. validate_novel.py — ✅ 通過（0 errors / 31 warnings）

獨立重掃 cleaned 全文（唔依賴 validator 自己，用另一組 regex 驗證），結果全部 **0 章殘留**：

| 雜訊 | 殘留章數 |
|---|---|
| No Plagiarism | 0 |
| copyright protection | 0 |
| Please respect copyright | 0 |
| PENANA token（全半形混合掃描） | 0 |
| IP address pattern | 0 |
| And N More | 0 |
| ns…da… token | 0 |
| Penana UI token（上一章／下一章／書籤!／format_color_text／open_in_full／arrow_*） | 0 |

測試鏈：pytest **23 passed**；Vitest 1 passed；lint/typecheck/build 全過。

## 6. Private 內容處理聲明

本次驗收及後續工作**不會**將 `data/private/` 任何內容公開、commit、push 或部署。CI 設有 `private-data-guard` job 自動把關。

## 驗收結論

**PASS** —— 全部檢查通過，Phase A 可視為完成。下一步進入 Phase B 骨架（schema、資料模型、review queue、provisional sample dataset、unit tests），暫不呼叫 OpenRouter、不啟動 ComfyUI、不產生 tiles、不做任何同步或爬蟲。

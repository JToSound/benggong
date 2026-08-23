# Phase 0 + Phase A 進度報告 — 《病港》互動地圖

> 日期：2026-08-24
> 執行者：Hermes Agent（ox-alpha，autopilot 模式）
> 規格來源：`prompts/master-prompt.md`

## 摘要

Phase 0（workspace 稽核、repo 初始化、文件、Vite+TS+Python+CI skeleton）同 Phase A（`clean_novel.py`、`validate_novel.py`）已全部完成並通過驗證。清理後 corpus：**198/198 章，零雜訊殘留，零結構錯誤**。按用戶指示，本階段**無執行任何網站同步、爬蟲或 ComfyUI 模型下載**。

## Phase 0：稽核與初始化

### Workspace 稽核結果

| 項目 | 結果 |
|---|---|
| Git | 原本未初始化 → 已 `git init -b main` |
| 目錄 | 全新 workspace，只有 `prompts/master-prompt.md` |
| 小說輸入 | `Bing-Gang-_full.jsonl`（5.76 MB）喺 `Desktop/病港/`；**`Bing-Gang-_full-2.md` 不存在**（唔影響：JSONL 先係 canonical input，md 只是衍生品） |
| Python | 3.11.15 / 3.12.10 可用 |
| Node | v22.23.2、npm 12.0.2 |

原始 JSONL 結構檢查：199 行（issue_index 0–198），欄位齊全（`story`、`issue_index`、`chapter_num`、`url`、`content`、`word_count`），無 duplicate、無 missing index。`issue/0` 確認係網站頁面非正文。

### 已建立檔案

- `.gitignore` — 封鎖 `data/private/` 全部內容 + 防呆規則（`Bing-Gang-_full.jsonl`、`*clean*.jsonl` 等）
- `.env.example` — 按 master prompt §6.1，無任何真實 token
- `docs/ARCHITECTURE.md` — 系統架構、技術決策、座標策略、離線圖層政策
- `docs/DATA_GOVERNANCE.md` — 私有／公開界線矩陣、不確定性標記、release gate、takedown 政策
- `package.json` / `tsconfig.json`（strict）/ `vite.config.ts` / `eslint.config.js`
- `index.html` / `timeline.html` / `404.html` + `src/main.ts` / `src/timeline.ts` / 樣式骨架
- `tests/timeline.test.ts`（Vitest）、`pytest.ini`
- `.github/workflows/ci.yml` — frontend（lint/typecheck/test/build）+ python pipeline + **private-data-guard job**
- 目錄骨架：`data/{public,private,schemas}`、`scripts/`、`public/assets/*`、`workflows/`、`docs/progress/`

### ⚠️ AGENTS.md 未建立

寫入 `AGENTS.md` 需要用戶批准（受保護嘅 agent-instruction 檔案），批准提示逾時未回應。**內容已備好，等用戶批准後即可寫入。**

### 私有資料 staging

`Desktop/病港/Bing-Gang-_full.jsonl` 已複製到 `data/private/raw/Bing-Gang-_full.jsonl`。
`git check-ignore -v` 確認：`.gitignore:5:data/private/` 命中。

## Phase A：清理與驗證

### 清理規則設計（經全書實測校準）

分析咗全部 198 章後定稿嘅 versioned rules（`clean-rules-v1`，喺 `scripts/novel_lib.py`）：

1. **行首宣告**：`No Plagiarism!<token>posted on PＥNAＮＡ`（23 章；PENANA 係全半形混合 `PＥNAＮＡ`／`ＰＥＮＡＮＡ`）
2. **Footer 截斷**：由最後一行獨立 IP 行開始截走全部 reader-interaction 內容（IP、`ns…da…`、讀者名單、`And N More`、`喜歡` footer）。**安全條件**：只有 IP 行之後有 `ns…da` 或 `And N More` 特徵先至截，避免誤刪正文中段疑似 IP 數字。
3. **結尾數字行**：移除最多兩行純數字 reader counts（`\n0\n36` 形態 172 章；`\n32` 單行形態 3 章）
4. **行內噪音**：`(數字)Please respect copyright.PENANA<token>` 同 `(1234) copyright protection(數字)PENANA<token>( 尼)`——只移除污染部分，保留前後正文
5. **連續空行壓縮**

**關鍵安全決定**：「喜歡」「分享」「展開」等詞喺至少 43 章係正文一部分（例如「喜歡少佐」「展開了意想不到的事」），所以**絕不可作 UI token 刪除或截斷錨點**。UI token 只在 footer 截斷範圍內自然移除。

### clean_novel.py 執行結果

```text
Parse：199 行；保留 198 章；skip issue/0：1
duplicates=0 parse_errors=0
總移除字符：2,203,749（約佔原文 38%）
exit code 0
```

輸出（全部喺 `data/private/`，gitignored）：
- `cleaned/bing-gang.clean.jsonl`（含重新計算 word_count）
- `cleaned/bing-gang.clean.md`
- `review/cleaning-report.json` / `cleaning-report.md`（逐章統計）
- `review/input-manifest.json`（SHA-256、schema version、pipeline git commit、run timestamp）

### validate_novel.py 執行結果

```text
驗證：198/198 章；errors=0 warnings=31
中位數字數：4260.5；總字數：908,482
exit code 2（只係 warnings，無 errors）
```

- 31 個 warning 全部係短章字數偏離中位數（如第 36 章 1,145 字 vs 中位數 4,260）——正常文學現象，按規格只警告不刪除
- 結構檢查：index 完整 1–198、無 issue/0、無 duplicate hash
- 雜訊掃描：`No Plagiarism` / `copyright protection` / `Please respect copyright` / PENANA token / IP pattern / `And N More` / UI token 全部 **0 殘留**
- CJK/Latin/punctuation ratio、control chars、invalid Unicode 全部通過

### 抽查確認（人眼層級）

- 第 50 章：頭尾乾淨，對白完整
- 第 36 章（無 footer 例外）：結尾對白完整保留
- 第 198 章（外傳，單行數字結尾）：「──外傳完──」正確保留為最後一行
- 43 章含「喜歡/分享/展開」正文用詞全部無誤刪

### 測試結果

| 測試套件 | 結果 |
|---|---|
| pytest（`tests/test_cleaning.py`，涵蓋 master prompt §6.4 全部要求） | **23 passed** |
| Vitest（`tests/timeline.test.ts`） | 1 passed |
| `npm run lint` | ✅ exit 0 |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ 成功（dist/index.html + timeline.html） |
| dist 掃描 | ✅ 無 private/小說內容 |

測試期間修正咗兩個問題：
1. Footer 截斷窗口原本太闊（2000 字符距離限制），會誤刪中段疑似 IP 數字——改為特徵匹配（IP 後必須有 `ns…da` 或 `And N More`）
2. 加 `src/vite-env.d.ts` 解決 TS 對 CSS import 嘅型別報錯

## 已知限制

1. `AGENTS.md` 未寫入（等用戶批准受保護檔案寫入）
2. `Bing-Gang-_full-2.md` 唔存在於來源目錄——如果用戶有呢份檔案請提供，但 JSONL 已足夠作 canonical input
3. 31 章短章 warnings 屬預期，Phase B extraction 時會以 chapter-level 處理
4. `word_count` 原始值與重算值差異 <50 字（全書無異常），但仍以重算值為準

## 下一步

1. 用戶批准後寫入 `AGENTS.md`
2. Phase B：extraction schema、OpenRouter run ledger、review queue、最小 provisional sample data（需要 `OPENROUTER_API_KEY`）
3. Phase C0：ComfyUI 本機 health check（需要本機 ComfyUI 運行中）
4. Phase C/D：程序化 base map → tiles → 前端功能

## Private data 驗證快照

本報告完成時：`git status` 只顯示 tracked/scheduled 檔案（設定檔、src、scripts、tests、docs）；`data/private/` 整個目錄被 `.gitignore` 第 5 行封鎖，**無任何 private 檔案被 git 追蹤**。

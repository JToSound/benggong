# AGENTS.md — 《病港》互動地圖

> 本檔案係俾 AI agent（Hermes autopilot 模式）同埋人類協作者嘅工作指引。
> 完整規格見 `prompts/master-prompt.md`；架構見 `docs/ARCHITECTURE.md`；資料治理見 `docs/DATA_GOVERNANCE.md`。

## 專案一句話講晒

為香港網絡小說《病港》建立一個完全開源、完全離線、可部署到 GitHub Pages 嘅互動故事地圖網站。所有地圖 tiles、圖示、字體一律本機 bundled；**唔使用任何 online map API / remote tile / runtime geocoding**。

## 語言規則（強制）

- 所有用戶介面、README、文件、程式註解、錯誤訊息、報告：**粵文**。
- 程式識别字、檔名、JSON keys、環境變數、library names、模型 prompts：可用英文。

## 版權紅線（違反即係事故）

1. `data/private/` 入面所有嘢（原始 JSONL／Markdown 全文、清理後全文、evidence excerpts、review queue、LLM cache）**永遠不得 commit、不得 deploy**。
2. 公開網站只可以有：經審閱短摘要、章節參照、結構化事件／位置資料、原創視覺資產。
3. 不得將未提供或未審閱嘅《病港2》內容捏造入資料集；schema 預留 `bing_gang_2` namespace 即可。
4. 「喜歡」「分享」「展開」等詞常為正文一部分（已實測確認），清理時絕不可當 UI token 刪除或作截斷錨點。

## Agent 自主執行原則

- 每個 phase 開始前：讀 `git status`、`AGENTS.md`、`README.md`、`.env.example`、schema、lockfile、既有測試。
- 寫入優先用可重跑、deterministic、可驗證 script；生成檔案要有來源、版本同 hash（SHA-256）。
- 不確定嘅小說資料只可以標 `unknown`／`approximate`／`fictional`／`needs_review`，不得當事實寫。
- 所有 LLM output 必須過 JSON Schema validation 先可以用。
- 每個 phase 完成後：跑 lint → typecheck → test → build → 資料驗證 → release audit；fail 要修或者喺報告記錄 block reason。
- 每個 major phase 完成後：喺 `docs/progress/` 寫粵文進度報告（改動、驗證、已知限制、下一步）。
- 除非缺密碼、授權或硬件，否則自主繼續；採最保守、可逆、可稽核決策。

## 內容同步（Phase A0）預設停用

- 預設 `SYNC_ENABLED=false`；只處理使用者本機已提供檔案。
- 啟用同步需要全部四項：`data/private/AUTHORIZATION.md` 存在並記錄授權、`.env` 有 `SYNC_ENABLED=true`、來源條款及 robots 容許、固定 allowlisted URL 清單。
- 即使獲授權：不可繞過 login／CAPTCHA／Cloudflare／anti-bot／paywall；不可 stealth browser／cookie theft／proxy rotation。
- 未授權時 `sync_authorized_source.py` 必须 exit non-zero 並顯示粵文說明。

## 常用指令

```bash
npm ci                # 安裝前端依賴
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
npm run test          # Vitest unit tests
npm run build         # Vite production build
python scripts/clean_novel.py      # Phase A 清理（讀 data/private/raw/）
python scripts/validate_novel.py   # Phase A 驗證（讀 data/private/cleaned/）
python -m pytest tests/ -v         # Python unit tests
```

Python 注意：本機 Hermes venv 嘅 `python` 冇 pip；跑 pipeline 同 pytest 用系統 Python
`C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe`。

## 目錄速覽

| 路徑 | 用途 |
|---|---|
| `scripts/` | Python pipeline（clean / validate / extract / render / audit） |
| `src/` | TypeScript 前端（Vite + strict TS + Leaflet local tiles） |
| `data/public/` | 經審閱公開資料（GeoJSON / timeline / characters），可 commit |
| `data/private/` | 私有 working material，gitignored，永不部署 |
| `public/assets/` | 本機 tiles、markers、UI assets |
| `docs/progress/` | 每階段粵文進度報告 |

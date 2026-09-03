# 《病港》互動地圖

> 粉絲製作嘅香港網絡小說《病港》互動故事地圖。完全離線、完全靜態、可部署 GitHub Pages。

[![CI](https://github.com/YOUR_ORG/bing-gang-map/actions/workflows/ci.yml/badge.svg)](../../actions)

## 係乜嘢

一個可自由縮放、拖曳瀏覽嘅小說世界地圖，標示《病港》入面嘅事件、地點同角色路線：

- **故事地圖**：所有 tiles 本機生成並 bundled——唔使用任何 online map API、remote tile 或 runtime geocoding
- **時間軸**：按章節先後排列（未確認故事日期會清楚標示「按章節先後」）
- **劇透控制**：0–3 級，預設只顯示 0–1 級
- **搜尋**：角色／事件／地點／章節編號（撳 `F`）
- **距離量度**：多點路徑，以「故事單位」顯示（比例未校準前唔會扮 km）
- **鍵盤導覽**：`F` 搜尋 · `M` 量度 · `S` 面板 · `T` 時間軸 · `Esc` 關閉
- **Deep links**：`?event=<id>` 開詳情、`#location=<id>` 飛去位置
- **角色路線**（Phase D 暫停）：51 條 character-routes 已喺私有審閱檔推導完成；公開 routes.geojson 因 character cross-alias 衝突延後（見 `data/private/review/route-blockers.md`）

## 快速開始

```bash
npm ci            # 安裝依賴
npm run dev       # 開發伺服器 http://localhost:5173
npm run build     # 生產構建到 dist/
npm run preview   # 預覽生產構建
```

Python pipeline（資料清理／驗證）：

```bash
python scripts/clean_novel.py          # 清理原始 JSONL（需要 data/private/raw/）
python scripts/validate_novel.py       # 驗證清理結果
python scripts/validate_public_data.py # 驗證公開 dataset
python -m pytest tests/ -v             # Python 測試
```

## 資料來源與治理

本站只顯示由小說文本抽取嘅**結構化摘要**（事件／地點／角色），全部帶 `review_status` 標記：

- 未經人手審閱嘅資料以 **provisional mode** 顯示（頂部橙色 banner）
- 唔會出現小說原文段落、evidence 摘錄或任何可重組全文嘅內容
- 詳細規則見 [`docs/DATA_GOVERNANCE.md`](docs/DATA_GOVERNANCE.md)

開發者注意：`data/private/`（原始文本、清理後全文、LLM cache）被 `.gitignore` 封鎖，**永遠不得 commit 或部署**。AI 協作者請先讀 [`AGENTS.md`](AGENTS.md)。

## 技術棧

| 層 | 工具 |
|---|---|
| 前端 | Vite + TypeScript (strict) + Leaflet（本機 tiles） |
| 測試 | Vitest（21+）、pytest（72+）、Playwright 網絡審計 |
| 資料 | JSON Schema 驗證嘅 GeoJSON / JSON |
| CI | GitHub Actions：lint → typecheck → test → build → 資料驗證 → private-data-guard |

## 文件

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 系統架構
- [`docs/DATA_GOVERNANCE.md`](docs/DATA_GOVERNANCE.md) — 私有／公開資料界線
- [`docs/progress/`](docs/progress/) — 各階段進度報告

## 授權

代碼以 MIT 授權發佈（見 [LICENSE](LICENSE)）。《病港》小說內容版權屬原作者；本站對小說文本嘅使用限於短摘要與章節參照，詳見 [NOTICE.md](NOTICE.md)。

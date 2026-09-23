# NOTICE — 第三方內容與版權聲明

## 《病港》小說內容

《病港》係香港網絡小說，原著及全部文本內容版權屬原作者所有（Penana 平台連載：https://www.penana.com/story/73992）。

本專案係**非官方粉絲製作**：

- 本站只顯示由小說抽取嘅**短摘要**（事件描述 ≤200 字、地點描述 ≤100 字）、章節參照同結構化資料
- 唔包含、唔重組、唔替代小說原文；閱讀體驗請支持原著
- 如版權持有人認為任何內容越界，請按 `docs/DATA_GOVERNANCE.md` §7 takedown 流程提出，我們會盡快移除

## 地圖資料（OpenStreetMap，ODbL）

底圖（陸地輪廓、海岸線、道路、建築、內陸水體、地名）係由
**OpenStreetMap** 資料衍生：

- 資料來源：© OpenStreetMap contributors
- 授權：Open Database License (ODbL) 1.0 —
  https://www.openstreetmap.org/copyright
- 產生方式：`scripts/build_vector_basemap.py` 由**本機 OSM 快取**
  （`data/private/cache/osm-hk.json`，經 Overpass API 匯出）離線渲染成
  向量圖磚，輸出喺 `public/assets/vector/`。
  網站運行時**唔會**連任何地圖服務。
- 衍生檔案（`public/assets/vector/`、`public/assets/hk-basemap*.png`）
  同樣以 ODbL 提供。

「地名 → 座標」對照表（`data/private/cache/gazetteer.json`）同樣由 OSM
衍生，但屬**私有中間資料**，唔會 commit、唔會部署 —— 座標只會**烘焙入**
公開資料集（`data/public/locations.geojson`）。

## 開源組件

| 組件 | 授權 | 用途 |
|---|---|---|
| OpenStreetMap 資料 | ODbL 1.0 | 底圖幾何（見上） |
| Leaflet | BSD-2-Clause | 地圖渲染（舊 raster 路線遺留） |
| Vite / Vitest | MIT | 構建與測試 |
| TypeScript | Apache-2.0 | 語言工具鏈 |
| ESLint / typescript-eslint | MIT | 代碼品質 |
| Playwright | Apache-2.0 | E2E 測試 |
| pytest / jsonschema | MIT | Python 測試與驗證 |

## AI 生成內容

- 所有 AI 生成嘅視覺資產（Phase C 起）會喺 `public/assets/generated/` 附 provenance manifest（workflow／seed／model hash）
- AI 生成空拍概念圖上線後將固定顯示：「AI 生成概念空拍圖，僅供小說世界觀瀏覽，唔代表真實衛星影像。」
- 文字摘要由 LLM 協助整理，但全部經 schema 驗證並標示 `review_status`；未經人手審閱前網站以 provisional mode 運行

## 商標

本專案與 Penana 或任何地圖服務商無隸屬關係。提及嘅第三方名稱屬其各自持有者嘅商標。

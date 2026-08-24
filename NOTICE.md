# NOTICE — 第三方內容與版權聲明

## 《病港》小說內容

《病港》係香港網絡小說，原著及全部文本內容版權屬原作者所有（Penana 平台連載：https://www.penana.com/story/73992）。

本專案係**非官方粉絲製作**：

- 本站只顯示由小說抽取嘅**短摘要**（事件描述 ≤200 字、地點描述 ≤100 字）、章節參照同結構化資料
- 唔包含、唔重組、唔替代小說原文；閱讀體驗請支持原著
- 如版權持有人認為任何內容越界，請按 `docs/DATA_GOVERNANCE.md` §7 takedown 流程提出，我們會盡快移除

## 開源組件

| 組件 | 授權 | 用途 |
|---|---|---|
| Leaflet | BSD-2-Clause | 地圖渲染 |
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

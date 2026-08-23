# ARCHITECTURE — 《病港》互動地圖

> 目標：完全離線、靜態、可部署 GitHub Pages 嘅小說世界地圖。零 runtime 第三方服務。
> 狀態：Phase 0 + Phase A 完成（見 `docs/progress/phase-0-and-a.md`）。

## 1. 系統總覽

```text
┌─────────────────────────── 私有層（gitignored）───────────────────────────┐
│  data/private/raw/          原始 JSONL（199 行，issue 0–198）             │
│        │  scripts/clean_novel.py（versioned regex rules）                │
│        ▼                                                                 │
│  data/private/cleaned/      bing-gang.clean.jsonl / .md                  │
│        │  scripts/validate_novel.py                                      │
│        ▼                                                                 │
│  data/private/review/       cleaning-report / input-manifest / 驗證報告   │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ Phase B（未開始）：evidence-grounded extraction（OpenRouter）
               ▼
┌─────────────────────────── 公開層（經 audit）─────────────────────────────┐
│  data/public/     locations.geojson / events.geojson / routes.geojson    │
│                   timeline.json / characters.json / map-config.json      │
│  public/assets/   story-cartography tiles / ai-aerial-concept tiles /    │
│                   markers / ui / attribution（全部本機）                  │
└──────────────┬───────────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────── 前端（Vite + TS strict）───────────────────────┐
│  index.html   Leaflet 地圖、markers、routes、搜尋、劇透控制、距離工具     │
│  timeline.html 時間軸 + deep link 返地圖                                  │
│  404.html     GitHub Pages fallback                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

## 2. 技術決策

| 決策 | 選擇 | 原因 |
|---|---|---|
| Build | Vite + TypeScript `strict: true` | 快、簡單、型別安全 |
| 地圖 renderer | Leaflet + 本機 XYZ raster tiles（EPSG:3857） | 直接可靠、完全離線 |
| Unit test | Vitest（TS）/ pytest（Python scripts） | 兩邊生態原生 |
| E2E / network audit | Playwright | 可攔截 network request 證明零外連 |
| AI 視覺資產 | 本機 ComfyUI（localhost only） | 版權與離線要求；禁止 cloud fallback |
| LLM extraction | OpenRouter API（key 只由 `.env`） | strict JSON + schema validation |

## 3. 座標策略

- Renderer 用標準 EPSG:3857 XYZ tile grid。
- 每個小說位置同時有 `story_position: {x, y}`（normalized 0–1），係唯一可信嘅故事空間座標。
- 真實香港名稱只作「參考位置」；`location_precision ∈ {district, approximate, fictional, unknown}`。
- 距離一律經 `scale_profile` 換算；精度不足就顯示「估算距離」或「地圖單位」，不可扮現實精確。

## 4. Basemap 圖層（全部本機）

1. `story-cartography` — 程序化／AI-enhanced 主地圖（海陸、山勢、水系、道路層級、故事區域、label anchors）
2. `ai-aerial-concept` — 本機 ComfyUI img2img/ControlNet 空拍概念圖，UI 固定顯示「AI 生成概念圖」disclaimer
3. `debug-grid` — 開發模式座標網格，production 關閉

**禁止**：Google Maps、Mapbox、OSM tile endpoint、Carto、Esri、Bing、任何 online tile/geocoder/map CDN。缺 tile 只可以 fallback 較低 zoom 本機 tile。

## 5. 資料界線摘要

詳細規則見 `docs/DATA_GOVERNANCE.md`。一句講晒：
`data/private/` 永不 commit、永不 deploy；公開資料必須 schema-valid、經 audit、帶 review status。

## 6. CI / 部署

- `.github/workflows/ci.yml`：npm ci → lint → typecheck → test → build → Python validate → release audit。
- `deploy-pages.yml`：CI 全綠先跑，只 upload `dist/`，支援 GitHub Pages base path。
- Release gate：private text、secrets、remote map URL、未審閱 evidence 一律不得入 `dist/`。

## 7. 《病港2》預留

Schema、source filter、UI filter、route namespace 全部預留 `bing_gang_2`；現階段零內容、零爬取、零捏造。

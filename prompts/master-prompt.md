# 《病港》互動地圖：Hermes Agent 全自動 Agentic Coding Master Prompt（更新完整版）

> **適用環境**：Windows 11、本機 Hermes Agent、OpenRouter API、本機 ComfyUI、GitHub repository、GitHub Pages。
>
> **主要目標**：開發一個完全開源、免費使用、可部署到 GitHub Pages 嘅《病港》互動地圖。網站提供原創、AI 生成、完全本機 bundled 嘅地圖與視覺資產；唔使用 online map API、remote map tile、remote geocoding 或 runtime 第三方地圖服務。
>
> **續作支援**：架構由第一日已支援《病港2》，但目前只處理《病港》。絕不可將未提供或未審閱嘅《病港2》內容捏造入資料集。
>
> **專案語言規則**：所有用戶介面、README、文件、程式註解、錯誤訊息、報告，一律用粵文。程式識別字、檔案名、JSON keys、環境變數、library names 與模型 prompts 可用英文。
>
> **重要版權規則**：小說全文、原始爬蟲內容、清理後全文、完整 Markdown、evidence excerpts、可重組全文嘅 RAG corpus 或 embedding，一律視為 private working material；不得 commit 到公開 repo，亦不得 deploy 到 GitHub Pages。公開網站只可提供經審閱嘅短摘要、章節參照、結構化事件／位置資料及原創視覺資產。

---

## 0. Agent 角色、權限與執行模式

你係一個資深 autonomous staff engineer、Python data engineer、GIS/cartography engineer、creative-technology engineer、front-end accessibility specialist、CI/CD engineer。你而家以 **Hermes Agent autopilot** 模式執行，使用 OpenRouter API 作為文字／推理模型供應商；按需要使用本機 ComfyUI 生成視覺資產。

你要自主完成整個專案：審核 workspace、初始化 repo、文件管理、選擇性授權同步、清理與驗證資料、抽取地圖資料、產生 AI 地圖及圖磚、開發前端、測試、CI、GitHub Pages 部署、撰寫交付文件。除非缺少不可替代嘅密碼、權利人授權或硬件資源，否則唔好停低問問題；採用最保守、可逆、可稽核嘅合理決策繼續。

### 0.1 Autopilot 原則

1. 每個 phase 開始前，讀取 repository 現況、`AGENTS.md`、`README.md`、`.env.example`、data schema、lockfile、既有測試與 git status。
2. 任何寫入前，優先建立可重跑、deterministic、可驗證嘅 script；所有生成檔案都要有來源、版本與 hash。
3. 不確定嘅小說資料只可以寫成 `unknown`、`approximate`、`fictional` 或 `needs_review`；不得將推測寫成事實。
4. 所有資料提取 output 都要通過 JSON Schema / Pydantic / Zod validation；LLM output 不可直接當真。
5. 對任何 public release 執行完整 audit：private text、API keys、cookies、remote map URL、未授權圖片、未審閱 evidence 一律不得進入 `dist/`。
6. 所有 map / tile / artwork 的 runtime assets 必須喺 repository build output 裏面；瀏覽地圖時不得向網上地圖服務發出請求。
7. 每個 phase 完成後，先跑 lint、typecheck、test、build、資料驗證、release audit；所有 fail 必須修正或在 report 清楚記錄 block reason。
8. 每個 major phase 完成後，在 `docs/progress/` 寫一份粵文進度報告，列出改動、驗證、已知限制、下一步。

---

## 1. 背景、內容範圍與既有檔案

### 1.1 作品與章節範圍

- 目標作品：香港網絡小說《病港》。
- 後續支援：《病港2》，但暫時唔可爬取、分析或顯示其內容。
- 已知 Penana URL pattern 為 `https://www.penana.com/story/73992/%E7%97%85%E6%B8%AF/issue/{issue_index}`。
- `issue/0` 係書籍／目錄／網站頁面，**唔係小說正文**。
- 有效《病港》正文應為 `issue/1` 至 `issue/198`，共 **198 章**。

### 1.2 已提供輸入檔案

在 workspace 尋找以下檔案；優先使用 JSONL 作 canonical input：

- `Bing-Gang-_full.jsonl`
- `Bing-Gang-_full-2.md`

已知呢兩份檔案有以下問題：

- `issue/0` 包含網站 menu、login、導航等非正文內容。
- 其餘章節有 Penana 版權保護雜訊、UI token、IP、讀者名單。
- `word_count` 包含雜訊，因此唔可信，必須重新計算。
- Markdown 為 JSONL 內容衍生品，唔可以當作獨立真實來源。

### 1.3 已知噪音模式

可能出現以下形態，必須以保守 regex 清除：

```text
No Plagiarism!H1ju9ceSrVSHL8gq2Ee0posted on PＥＮＡＮＡ
18649Please respect copyright.ＰＥＮＡＮＡuq4o8YBuml
1234 copyright protection18645ＰＥＮＡＮＡtFCvArwtma 尼
223.122.76.172
ns223.122.76.172da2
And 68 More
```

亦可能出現：

```text
favorite
comment
上一章
下一章
樣式
展開
打賞
催更
分享
檢舉
後一篇 >
前一篇 <
喜歡
書籤!
home
format_color_text
open_in_full
campaign
share
report
arrow_back_ios_new
arrow_forward_ios
```

**注意**：清理器只能移除高度明確嘅污染字串；不得以過度寬鬆 regex 刪走正文、角色名、數字、標點或粵文內容。

---

## 2. 產品規格

建立一個 responsive、keyboard-accessible、mobile-friendly 嘅互動地圖網站，提供：

1. **自建故事地圖**：高解析度、自由縮放、拖曳瀏覽；所有 tiles 由專案本機生成並 bundled。
2. **AI 空拍概念圖**：以本機 ComfyUI 生成，保留地圖結構，但明確標示「AI 生成概念圖，唔代表真實衛星影像」。
3. **事件標記系統**：支援百個以上可擴充 marker，類型包括 major、minor、battle、discovery、death、reunion、travel、landmark。
4. **角色旅程**：多角色彩色虛線路線，按角色開關、按章節／故事時段篩選，顯示 waypoint 與可信度。
5. **時間軸頁**：獨立 Timeline，按故事內時間排序；如無可靠故事日期，使用章節次序並清楚標示。
6. **地圖深連結**：Timeline card 可跳返地圖指定 event/location；地圖 URL state 支援 query/hash。
7. **搜尋**：可搵角色、事件、地點、章節編號。
8. **距離工具**：支援兩點直線距離及多點路徑距離；明示係「故事地圖比例估算」，不可扮成現實精確距離。
9. **劇透控制**：至少 0、1、2、3 級；預設只顯示 0–1 級。
10. **資料透明度**：每個公開 metadata 顯示適當嘅 source、chapter refs、precision、confidence 與 review label。
11. **《病港2》兼容**：schema、source filter、UI filter、route namespace 預留 `bing_gang_2`，但現階段不放任何內容。

---

## 3. 強制技術與資料治理決策

### 3.1 前端與 build

- Vite + TypeScript（`strict: true`）+ HTML5 + CSS。
- 優先 Leaflet 作為地圖 renderer，因為 local XYZ raster tiles 直接、可靠。
- 所有 package 鎖定版本，保留 lockfile。
- 使用 Vitest 做 unit tests、Playwright 做 E2E 與 browser network audit。
- 網站完全靜態，可部署 GitHub Pages；不得需要 server-side runtime、database runtime 或 API key。

### 3.2 地圖與座標策略

- renderer 採標準 `EPSG:3857` / XYZ tile structure。
- 每個小說位置亦保留 `story_position: {x, y}`，使用 normalized 0–1 或 configured integer grid。
- 真實香港名稱只可用作「參考位置」；如無可靠精確位置，只能用 `location_precision: district | approximate | fictional | unknown`。
- 虛構地點不可假扮成真實坐標資料。
- 所有距離要經 `scale_profile` 計算；如果 scale 未足夠可靠，只可顯示 map units 或 approximate distance。

### 3.3 完全離線自建視覺地圖

**禁止使用：** Google Maps、Mapbox、OpenStreetMap tile endpoint、Carto、Esri、Bing Maps、任何 public or private online tile service、runtime online geocoder、runtime map CDN。

必須有以下 local basemap layers：

1. `story-cartography`：程序化／AI-enhanced 主地圖，包含海陸、山勢、水系、道路層級、故事區域、地圖標籤 anchor。
2. `ai-aerial-concept`：本機 ComfyUI img2img / ControlNet 產生嘅小說世界空拍概念圖。
3. `debug-grid`：開發模式專用，本機座標、區域 border、tile ID、anchor，production 預設關閉。

**所有 icons、fonts、marker SVG、texture、tile image、人物插圖都必須 local bundled。**

### 3.4 私有／公開資料界線

| 資料 | 儲存位置 | 可 commit 公開 repo | 可 deploy |
|---|---|---:|---:|
| 原始 JSONL / Markdown 全文 | `data/private/raw/` | 否 | 否 |
| 清理後全文 | `data/private/cleaned/` | 否 | 否 |
| evidence excerpts / review queue | `data/private/evidence/`, `data/private/review/` | 否 | 否 |
| LLM extraction cache / embeddings | `data/private/` | 否 | 否 |
| public GeoJSON / timeline summary | `data/public/` | 可以，經 audit | 可以，經 audit |
| AI tiles / marker / original artwork | `public/assets/` | 可以，帶 manifest | 可以 |

所有 private directory 必須寫入 `.gitignore`。公開資料不可包含大段小說文本、私有 evidence、cookie、IP、LLM request prompt 原文或 API keys。

---

## 4. Repository 結構

建立或整理成以下結構：

```text
bing-gang-map/
├── AGENTS.md
├── README.md
├── LICENSE
├── NOTICE.md
├── CONTRIBUTING.md
├── SECURITY.md
├── package.json
├── vite.config.ts
├── tsconfig.json
├── eslint.config.js
├── .gitignore
├── .env.example
├── index.html
├── timeline.html
├── 404.html
├── public/
│   ├── assets/
│   │   ├── map-tiles/
│   │   │   ├── story-cartography/{z}/{x}/{y}.webp
│   │   │   ├── ai-aerial-concept/{z}/{x}/{y}.webp
│   │   │   └── manifest.json
│   │   ├── markers/
│   │   ├── generated/
│   │   ├── ui/
│   │   └── attribution/
│   └── favicon.svg
├── src/
│   ├── main.ts
│   ├── timeline.ts
│   ├── styles/
│   ├── components/
│   ├── map/
│   ├── data/
│   ├── lib/
│   └── types/
├── data/
│   ├── public/
│   │   ├── locations.geojson
│   │   ├── events.geojson
│   │   ├── routes.geojson
│   │   ├── timeline.json
│   │   ├── characters.json
│   │   ├── map-config.json
│   │   ├── sources.json
│   │   └── asset-manifest.json
│   ├── private/
│   │   ├── raw/
│   │   ├── cleaned/
│   │   ├── evidence/
│   │   ├── review/
│   │   └── cache/
│   └── schemas/
├── scripts/
│   ├── sync_authorized_source.py
│   ├── clean_novel.py
│   ├── validate_novel.py
│   ├── build_public_dataset.py
│   ├── validate_public_data.py
│   ├── generate_cartographic_base.py
│   ├── render_tiles.py
│   ├── comfyui_client.py
│   ├── setup_comfyui_local.py
│   ├── generate_ai_aerial.py
│   ├── verify_assets.py
│   └── audit_release.py
├── workflows/
│   ├── comfyui/
│   │   ├── aerial_img2img_api.json
│   │   └── character_portrait_api.json
│   └── prompts/
│       ├── base-map.md
│       ├── aerial-map.md
│       ├── characters.md
│       └── literary-extraction.md
├── tests/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DATA_GOVERNANCE.md
│   ├── CONTENT_REVIEW.md
│   ├── MAP_GENERATION.md
│   ├── MCP_AND_SKILLS.md
│   ├── COMFYUI_SETUP.md
│   ├── FINAL_ACCEPTANCE_REPORT.md
│   └── progress/
└── .github/workflows/
    ├── ci.yml
    └── deploy-pages.yml
```

---

## 5. Phase A0：可選「授權」內容同步／網絡爬蟲

### 5.1 預設狀態

預設 `SYNC_ENABLED=false`。Agent 只可處理使用者本機已提供嘅檔案。**不可以重新爬取 Penana 或任何網站。**

### 5.2 唯一可啟用條件

只可以當以下四個條件全部成立時，啟用 `scripts/sync_authorized_source.py`：

1. `data/private/AUTHORIZATION.md` 存在；文件清楚記錄權利人授權、允許用途、有效期、來源範圍及必要限制。
2. `.env` 內明確設定 `SYNC_ENABLED=true`。
3. 已確認目標來源嘅條款及 robots 政策容許該種自動存取。
4. Agent 有一份固定、allowlisted URL 清單；不可自行擴大來源、猜 URL 或搜尋其他鏡像站。

若任何條件缺失：

- 禁止發送內容抓取請求。
- 輸出 `sync_status: disabled_no_authorization`。
- 繼續用本機檔案完成所有可做工作。

### 5.3 已授權同步行為

如全部條件成立，實作一個**合規、節制、不可繞過保護**嘅同步器：

- 只讀取 allowlisted URLs。
- 必須使用明確 User-Agent、rate limit、randomized polite delay、retry with exponential backoff、cache、ETag / Last-Modified。
- 優先只更新有變更內容。
- 不可繞過 login、CAPTCHA、Cloudflare、anti-bot、paywall 或任何訪問控制。
- 不可使用 stealth browser、cookie theft、proxy rotation、fingerprint spoofing 或任何規避手段。
- 不可儲存帳戶密碼、session cookie、access token 入 repository、report 或 log。
- 所有下載內容只可寫到 `data/private/raw/`。
- 每次執行要寫 `data/private/review/sync-report.json`，記錄：run ID、時間、來源 URL、HTTP status、content hash、chapter index、headers policy、success/failure reason。
- 同步完即自動走 `clean_novel.py`、`validate_novel.py`。

### 5.4 同步器介面

```bash
python scripts/sync_authorized_source.py \
  --authorization data/private/AUTHORIZATION.md \
  --url-list data/private/authorized-url-list.json \
  --output data/private/raw/ \
  --max-requests-per-minute 12
```

如未授權，script 必須 exit non-zero 並顯示粵文說明，而唔係嘗試下載。

---

## 6. Phase A：檔案管理、正文清理與驗證

### 6.1 `.env.example`

建立以下項目，但**唔可以放真實 token**：

```dotenv
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_ORCHESTRATOR_MODEL=
OPENROUTER_CODING_MODEL=
OPENROUTER_EXTRACTION_MODEL=
OPENROUTER_VISION_MODEL=

SYNC_ENABLED=false
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_ROOT=
COMFYUI_AUTO_START=true
COMFYUI_PORT=8188
COMFYUI_ALLOW_MODEL_DOWNLOAD=false

VITE_BASE_PATH=/
VITE_PROVISIONAL_DATA_MODE=true
```

### 6.2 `clean_novel.py`

建立 production-quality 清理器：

- Auto-detect `Bing-Gang-_full.jsonl`；如檔案在 root 或 user-specified path，複製到 `data/private/raw/`。
- 每行 parse JSON；檢查必要欄位：`story`、`issue_index`、`chapter_num`、`url`、`content`、`word_count`。
- 跳過 `issue_index == 0`。
- 檢查完整 index `1..198`、duplicate、JSON error、empty content。
- 使用 versioned regex rules 移除：
  - `No Plagiarism!...posted on PＥＮＡＮＡ`
  - `Please respect copyright`
  - `1234 copyright protection...`
  - IP、`ns...da...`、讀者名單、已知 UI token。
- `喜歡`、`And N More` 等正文結尾標記後，截斷後續 reader-interaction UI。
- 對行內污染只移除污染部分，保留其餘正文。
- 連續空行壓成一個空行。
- 重新計字數：

```python
word_count = len(re.sub(r"[\s\n\r]+", "", content))
```

- Output：
  - `data/private/cleaned/bing-gang.clean.jsonl`
  - `data/private/cleaned/bing-gang.clean.md`
  - `data/private/review/cleaning-report.json`
  - `data/private/review/cleaning-report.md`
  - `data/private/review/input-manifest.json`（SHA-256、schema version、pipeline git commit、run timestamp）

### 6.3 `validate_novel.py`

必須檢查：

- 有且只有 198 章，index 完整由 1 到 198。
- 無 `No Plagiarism`、`copyright protection`、`Please respect copyright`、IP pattern、`And N More`、已知 UI token。
- 每章字數 > 30；少於 30 為 error。
- 字數偏離中位數太大要 warning；不可自動刪除。
- 計算 CJK / Latin / punctuation ratio，找出可疑段落。
- 以 content hash 找 duplicate chapter。
- 檢查 invalid Unicode、不可見 control chars。
- 輸出逐章：raw word count、clean word count、removed character count、warnings、hash。

### 6.4 測試要求

對 cleaning rules 寫 unit test，至少涵蓋：

- 每種已知雜訊。
- 行內雜訊仍保留正文。
- 正文含單獨數字、角色名、英文時，唔會誤截斷。
- `issue/0` 正確排除。
- 重複 issue index 正確 fail。
- 最終 clean JSONL schema valid。

---

## 7. Phase B：以 Evidence 為本嘅文學資料抽取

### 7.1 Pipeline 原則

使用 cleaned private JSONL 作輸入，但不可將全文送到前端、public data 或一般 console log。

- 以章節為單位，再按段落／token budget 切分。
- 不可把全書一次投入模型 context。
- 先抽 `entity candidates`，再 cross-chapter resolve / dedupe，再 build public summaries。
- 所有 LLM output 必須係 strict JSON，按 schema validate。
- invalid output 可 retry 一次；再失敗就進 review queue。
- 每個 claim 需要 `chapter_refs`、private `evidence_excerpt`、`confidence`、`review_status`。
- LLM 只可根據傳入 evidence；不確定必須輸出 `null` / `unknown`。
- 不可捏造真實香港地址、精確事件坐標、人物外貌、故事時間、角色關係或未提及情節。

### 7.2 OpenRouter 使用規則

- API key 只可由 `OPENROUTER_API_KEY` 讀取。
- 不可 commit `.env`、API key 或完整 LLM request / response 正文。
- 每個 run 記錄 model ID、temperature、prompt hash、schema version、token／cost estimate、run ID，但敏感正文只記 hash 或最少 metadata。
- extraction temperature 預設 0–0.2。
- 對 request 實作 rate limit、exponential backoff、timeout、可中斷續跑 cache。
- 模型角色：
  - orchestrator：規劃、review、分派。
  - coding model：TypeScript/Python/CI 修正。
  - extraction model：粵文／繁中 structured extraction。
  - cheap batch model：低風險 candidate extraction，必須經 validator。
  - vision model：tile / artwork QA（如有）。

### 7.3 Private extraction data

輸出：

- `data/private/evidence/candidates.jsonl`
- `data/private/review/review-queue.json`
- `data/private/cache/extraction-runs/`

review queue 要列出：conflict、low confidence、location unknown、time conflict、high spoiler、possible hallucination、invalid schema。

### 7.4 Public schema：Locations

```json
{
  "type": "Feature",
  "geometry": {"type": "Point", "coordinates": [114.1694, 22.3193]},
  "properties": {
    "id": "mong_kok_reference",
    "name": "旺角",
    "display_name": "旺角（參考位置）",
    "type": "district|street|building|facility|fictional|overseas|unknown",
    "fictional": false,
    "location_precision": "district|approximate|fictional|unknown",
    "story_position": {"x": 0.52, "y": 0.48},
    "description": "粵文短摘要，不超過 100 字。",
    "first_appearance": 1,
    "chapters": [1, 2],
    "characters": ["protagonist"],
    "confidence": 0.0,
    "review_status": "needs_review|reviewed|verified",
    "source": "bing_gang"
  }
}
```

### 7.5 Public schema：Events

```json
{
  "type": "Feature",
  "geometry": {"type": "Point", "coordinates": [114.1694, 22.3193]},
  "properties": {
    "id": "bg_event_001",
    "title": "粵文事件標題",
    "description": "粵文摘要，最多 200 字；不可轉載長段正文。",
    "chapter": 1,
    "chapter_name": "０１",
    "chapter_refs": [1],
    "characters": ["protagonist", "ha_ching"],
    "event_type": "major|minor|battle|discovery|death|reunion|travel|landmark",
    "spoiler_level": 0,
    "location_id": "mong_kok_reference",
    "confidence": 0.0,
    "review_status": "needs_review|reviewed|verified",
    "source": "bing_gang"
  }
}
```

### 7.6 Public schema：Routes

```json
{
  "type": "Feature",
  "geometry": {"type": "LineString", "coordinates": [[114.16, 22.32], [114.17, 22.31]]},
  "properties": {
    "id": "route_protagonist_001",
    "character_id": "protagonist",
    "character_name": "我",
    "color": "#E74C3C",
    "chapters_span": [1, 4],
    "precision": "reference|approximate|fictional",
    "waypoints": [
      {
        "location_id": "mong_kok_reference",
        "chapter": 1,
        "note": "粵文短說明",
        "confidence": 0.0
      }
    ],
    "source": "bing_gang",
    "review_status": "needs_review|reviewed|verified"
  }
}
```

### 7.7 Characters 與 Timeline

Character record 必須包括：`id`、`name`、`aliases`、`role`、`color`、`first_appearance`、`chapter_refs`、`spoiler_level`、`description`、`confidence`、`review_status`、`portrait_asset_id`。

預設配色：

- `protagonist` / `我`：`#E74C3C`
- `ha_ching` / `夏晴`：`#3498DB`
- `a_ming` / `阿明`：`#2ECC71`
- 其他角色由 deterministic palette 分配：`#F39C12`、`#9B59B6`、`#1ABC9C`、`#E67E22`。

Timeline record 必須有：`id`、`date_label`、`date_sort`、`chapter`、`location_id`、`characters`、`type`、`spoiler_level`、`description`、`confidence`、`review_status`。如無可確認故事日期，`date_label` 要寫「按章節先後」，而 `date_sort` 用 chapter order。

### 7.8 Public release gate

- `data/public/` 只可放 `reviewed` / `verified` 資料。
- 如果未有 human review，網站可以採 `VITE_PROVISIONAL_DATA_MODE=true`，但只載入清楚標示為 provisional 嘅最小 sample dataset，並喺 UI 顯示 banner。
- 禁止將所有 candidate 一次過公開，亦禁止假稱成完整官方資料庫。

---

## 8. Phase C0：自動安裝、啟動與連接本機 ComfyUI

### 8.1 安全與網絡限制

- 只可以連接 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`。
- 由 `.env` 讀取：`COMFYUI_URL`、`COMFYUI_ROOT`、`COMFYUI_AUTO_START`、`COMFYUI_PORT`。
- 如 URL host 不是 `127.0.0.1` 或 `localhost`，必須停止並報錯；不可 fallback 去 cloud endpoint、RunPod、proxy 或任何 online image API。
- 不可用 ComfyUI API nodes 去調用 external closed-source image service。
- 不可將本機 server bind 到 `0.0.0.0`；只可 `127.0.0.1`。
- 不可在未檢查磁碟、Python、GPU driver、PyTorch、VRAM 前下載大模型。

### 8.2 `setup_comfyui_local.py` 自動流程

1. **健康檢查**：嘗試 `${COMFYUI_URL}/system_stats` 或可用 health endpoint，記錄版本、GPU、VRAM、Python、已安裝 model／node。
2. **檢查安裝目錄**：如果 server 未開，而 `COMFYUI_ROOT` 存在，確認包含 `main.py`。
3. **自動啟動**：若 `COMFYUI_AUTO_START=true`，以本機安全指令啟動：

```bash
python main.py --listen 127.0.0.1 --port ${COMFYUI_PORT}
```

4. 等最多 120 秒，採用 exponential backoff health check。
5. 如 server 啟動失敗，產生 `docs/comfyui-setup-report.md`，包含 server log、Python/GPU 診斷、VRAM 估算、缺少檔案與精確修正指令；不得改用 cloud image generation。
6. **Workflow check**：驗證 `workflows/comfyui/aerial_img2img_api.json`、`character_portrait_api.json` 能被 API 接受；檢查 referenced checkpoint、VAE、ControlNet、custom nodes。
7. **Model download policy**：
   - 預設 `COMFYUI_ALLOW_MODEL_DOWNLOAD=false`。
   - 如設定為 true，只可從 `workflows/model-manifest.json` allowlist 的官方／清楚授權來源下載。
   - 對每個下載記錄 URL、license、SHA-256、size、date，寫入 private install manifest。
8. **Smoke test**：排一個 512×512 test workflow，檢查 output 存在、可讀、metadata 完整，寫入 `public/assets/generated/test/` 或 development-only output dir。
9. **成功標準**：只有本機 loopback HTTP、Hermes 能呼叫 workflow、輸出具 provenance manifest。

### 8.3 自動 MCP 連接

建立本機 `comfyui-local` MCP wrapper。優先使用 repository own wrapper；如果使用現成套件，仍必須放一層 policy wrapper，強制 localhost 與 workflow allowlist。

MCP 只暴露以下 tool：

- `health_check`
- `list_workflows`
- `queue_workflow(workflow_path, overrides)`
- `get_job_status(prompt_id)`
- `download_output(file_ref)`
- `verify_output_metadata(asset_path)`

禁止暴露任意 shell、任意 URL fetch、任意 external API node、任意 workflow upload。

在 Hermes 設定中加入等價項目；實際 command 由 agent 依 chosen wrapper 實現：

```yaml
mcp_servers:
  comfyui-local:
    command: python
    args:
      - scripts/comfyui_mcp_server.py
      - --url
      - http://127.0.0.1:8188
      - --workflow-root
      - workflows/comfyui
      - --output-root
      - public/assets/generated
    env:
      COMFYUI_URL: http://127.0.0.1:8188
    enabled: true
    connect_timeout: 120
    timeout: 1800
```

如 Hermes config 現有格式不同，按照已安裝 Hermes 版本修改，但要達到同一安全限制。完成後 reload MCP，先執行只讀 `health_check`，再做 smoke test。

### 8.4 ComfyUI 產物 provenance

每一張生成資產都要記錄：

```json
{
  "asset_id": "aerial_z12_x3780_y1740",
  "is_ai_generated": true,
  "workflow_path": "workflows/comfyui/aerial_img2img_api.json",
  "workflow_sha256": "...",
  "model_name": "...",
  "model_sha256": "...",
  "seed": 123456,
  "prompt_version": "aerial-v1",
  "negative_prompt_version": "aerial-negative-v1",
  "created_at": "ISO-8601",
  "source_guide_asset": "...",
  "license_notes": "..."
}
```

---

## 9. Phase C：完全本機 AI 地圖、人物與資產生成

### 9.1 基礎主地圖：程序化 + AI-enhanced

建立 `scripts/generate_cartographic_base.py`：

- 使用 Python Pillow、SVG、Shapely / rasterio（如可用）程序化生成 base composition。
- 包含：海陸、水域、山勢、地勢紋理、道路層級、港口、故事區域、district boundaries、label anchors、debug grid。
- 如以香港地理關係作靈感，僅使用清楚授權／可分發嘅 offline reference geometry 或 manually authored approximate geometry；不得下載／抄用 online map tile。
- 地圖文字不可燒死入 AI 圖像；文字、labels、marker 必須用 deterministic local renderer 疊加，方便可讀、可搜尋、可切換。
- 視覺基調：濕潤、陰暗、末日、濃密城市、亞熱帶植被；但 water、roads、district boundaries 同 markers 要保持 WCAG 對比。

### 9.2 Tile renderer

建立 `scripts/render_tiles.py`：

- 把 base composition render / slice 成 standard local XYZ tiles。
- 預設 zoom 8–15，以 config 管理；格式優先 WebP。
- 生成：
  - `public/assets/map-tiles/story-cartography/{z}/{x}/{y}.webp`
  - `public/assets/map-tiles/ai-aerial-concept/{z}/{x}/{y}.webp`
- 加 tile count / total size budget；避免 GitHub Pages repository 過大。
- manifest 包含每個 tile hash、image dimension、layer、zoom、size。
- 缺 tile 時，renderer / app 只能 fallback 到較低 zoom local tile，唔可以 request network。
- `verify_assets.py` 驗證 XYZ completeness、尺寸、hash、透明度、缺檔、過大檔案。

### 9.3 AI 空拍概念層

使用本機 ComfyUI 以程序化 base map 作 guide image；必要時用 ControlNet canny / lineart / depth、img2img、inpainting、tile-aware 或 multi-tile canvas generation。

English model prompt：

```text
Top-down oblique-free aerial cartography of a fictional post-apocalyptic coastal megacity inspired by Hong Kong, dense urban blocks, subtropical overgrowth, abandoned infrastructure, stormy humid atmosphere, coherent road and harbor geometry, realistic material detail, no text, no labels, no logos, no people, no watermark
```

Negative prompt：

```text
text, letters, labels, watermark, logo, signature, distorted roads, floating buildings, duplicated bridges, people, faces, vehicles close-up, illegible map symbols
```

要求：

- seed 必須由 `{layer,z,x,y,prompt_version}` deterministic derive。
- 以 overscan + crop 或 multi-tile generation 解決 seam。
- 絕不可宣稱為真實衛星影像。
- UI 要固定展示：`AI 生成概念空拍圖，僅供小說世界觀瀏覽，唔代表真實衛星影像。`

### 9.4 人物、標記與 UI assets

- 角色 portrait 預設使用 abstract silhouette / symbolic illustration；如用 AI 臉孔，只可標示「AI 概念形象」，不得聲稱官方外貌。
- 生成本地 SVG marker，不可依賴 icon CDN。
- marker types：major、location、character、battle、discovery、landmark、death、reunion、travel。
- 每個 icon 32×32，hover scale 1.2，具顏色以外嘅形狀區分，照顧色弱使用者。
- 主色：

```css
:root {
  --color-primary: #E74C3C;
  --color-secondary: #2C3E50;
  --color-accent: #F39C12;
  --color-surface: #1A252F;
  --color-border: #2C3E50;
  --color-text: #ECF0F1;
  --color-text-muted: #95A5A6;
  --color-success: #2ECC71;
  --color-danger: #E74C3C;
  --font-cantonese: "Noto Sans TC", "PingFang HK", "PingFang TC", "Microsoft JhengHei", sans-serif;
}
```

---

## 10. Phase D：前端功能與 UX

### 10.1 頁面

- `index.html`：主地圖，全螢幕。
- `timeline.html`：時間軸。
- `404.html`：GitHub Pages fallback。

### 10.2 主地圖

- 100vw × 100vh Leaflet map。
- 頂欄：`《病港》互動地圖`、資料版本、劇透控制、Timeline link、關於。
- 左側 320px 可收合 sidebar，tabs：`地圖圖層`、`角色路線`、`搵資料`、`關於`。
- 本地 basemap switcher：`故事地圖`、`AI 空拍概念圖`。
- event markers：MarkerCluster 或功能等價 implementation；點擊 marker 在 sidebar 顯示 detail，避免 popup 遮擋。
- 每個 event detail 顯示：type badge、title、短摘要、chapter refs、角色、位置 precision、spoiler level、review state、`飛去位置`、`喺時間軸睇`。
- routes：彩色虛線 `dashArray: "10, 5"`；可按角色切換。
- Catmull-Rom smoothing 只作 visual render；原始 waypoint 必須保留，debug mode 可查看。
- 需要 loading、empty、error states，全部粵文。

### 10.3 Search、keyboard、deep link

- Search 可搵 location、event、character、chapter。
- Keyboard：
  - `S`：開／關 sidebar
  - `L`：開／關圖層 panel
  - `M`：開／關距離量度
  - `T`：去 timeline
  - `F`：focus search
  - `Esc`：關閉 detail / modal
- 雙擊地圖：複製 story / map coordinate，顯示 toast。
- deep link：
  - `#location=<id>`
  - `?event=<id>`
  - `?spoiler=1`
  - Timeline `喺地圖睇` 按鈕必須保留 state 跳轉。

### 10.4 Timeline

- 垂直 scroll；desktop 左右交替，mobile 單欄靠左。
- 篩選：event type、character、source、spoiler level、文字 search。
- 每張卡有 date label、chapter、event title、短摘要、角色 tags、location precision、`喺地圖睇`。
- 若無可確認日期，顯示 `按章節先後`，不可冒充精確故事日期。

### 10.5 距離工具

建立自家 local measure control：

- 支援兩點 direct distance、multi-point path length。
- 經 `scale_profile` 換算 km；若精度不足，寫明 `估算距離` 或 `地圖單位`。
- 顯示原始點距離；平滑路徑只係視覺效果，不可影響數值。
- 所有 UI text 用粵文。

### 10.6 Accessibility、效能與安全

- WCAG 2.2 AA：focus state、鍵盤操作、ARIA label、skip link、reduced-motion、contrast、touch target。
- breakpoints：360、768、1024、1440px。
- escape 所有來自 JSON 嘅 text；不可使用 untrusted `innerHTML`。
- CSP 適合 static hosting。
- progressive loading：先 base layer，再 locations/events，再 routes。
- 禁止把 OpenRouter key、GitHub token、ComfyUI config token 放入前端 bundle。
- 加 service worker，可離線 cache 已 bundled assets；不可在 service worker fallback 到外部 map URLs。

---

## 11. Hermes Skills 與 MCP 配置

### 11.1 必須建立 project-local Skills

每個 skill 要有 `SKILL.md`、trigger、inputs、outputs、failure handling、test command。

1. **`novel-data-governance`**：私有／公開資料界線、版權、release scan、takedown policy。
2. **`authorized-source-sync`**：只在授權條件滿足時同步來源；強制 no-bypass policy。
3. **`jsonl-cleaning-and-validation`**：清理 Penana 雜訊、章節完整性、anomaly report。
4. **`evidence-grounded-literary-extraction`**：分批 extraction、strict JSON、evidence、confidence、dedupe。
5. **`geojson-quality-control`**：schema、coordinate precision、route ordering、spoiler validation。
6. **`offline-ai-cartography`**：程序化 base map、tiles、local-only network policy、manifest。
7. **`comfyui-local-generation`**：ComfyUI setup、localhost MCP、workflow queue、seed/provenance。
8. **`static-map-frontend`**：Leaflet/Vite、responsive、a11y、offline tiles、timeline。
9. **`release-audit-github-pages`**：阻止 private text、secrets、remote map URL 入 `dist`。
10. **`test-and-regression`**：unit/e2e/visual/network/performance tests。

### 11.2 MCP 優先清單

採取 least privilege、tool allowlist、timeout、project-local config。

| 優先級 | MCP / Tool | 用途 |
|---|---|---|
| P0 | Filesystem / shell / git | 本機 scripts、build、測試、artifact 管理 |
| P0 | GitHub MCP | repo、issue、PR、Actions、GitHub Pages |
| P0 | custom local ComfyUI MCP | health、queue、output、provenance |
| P0 | Playwright MCP | E2E、a11y、screenshot、network audit |
| P1 | SQLite MCP | private review queue、cache、run ledger，不部署 |
| P1 | CI / GitHub Actions log tool | monitor deploy、debug logs |
| P1 | 本機 image inspection / OCR | tile seam、AI labels、watermark、可讀性 QA |
| P2 | local GIS tool wrapper | GDAL、rasterio、Shapely、Pillow |
| P2 | browser research tool | 僅作文件／license research；不可變成 runtime dependency |

**唔可配置／唔可使用**：Google Maps MCP、Mapbox MCP、online geocoding、online tile downloader 作 production pipeline。

---

## 12. CI、部署與 Release Audit

### 12.1 CI：`.github/workflows/ci.yml`

至少運行：

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
python scripts/validate_novel.py --if-present
python scripts/validate_public_data.py
python scripts/verify_assets.py
python scripts/audit_release.py
```

### 12.2 GitHub Pages deployment

- `deploy-pages.yml` 只可在 CI 全部成功後執行。
- 只 upload `dist/`。
- `dist/` 必須無 `data/private`、raw JSONL、cleaned full text、`.env`、token、cookie、evidence excerpt。
- 網站要支援 configured GitHub Pages base path。

### 12.3 `audit_release.py` 必須檢查

1. private files 沒有進入 `dist/`。
2. 無完整小說、長引文、raw markdown、embedding corpus。
3. 無 secret patterns。
4. compiled HTML/JS/CSS/JSON 無 remote map/tile URL，例如 OSM、Mapbox、Google、Carto、Esri、Bing。
5. 所有 public image / tile 都存在 asset manifest。
6. `NOTICE.md`、attribution、data governance 文件存在。
7. public locations/events/routes 全部 schema valid。
8. `needs_review` 資料不可 deploy，除非 provisional mode 開啟並有醒目 UI banner。
9. Playwright network test 證明地圖瀏覽時沒有 remote map/tile request。

---

## 13. 驗收標準

項目只可在以下全部達成後標記為 production-ready：

1. cleaned private corpus 有且只有 198 章，issue/0 不存在。
2. cleaning validator 證明已移除已知 Penana 雜訊；所有 anomaly 有明確 report。
3. public metadata schema-valid、evidence-grounded、無私有全文。
4. website 可 `npm run dev`、`npm run build`、`npm run preview` 正常運行。
5. 地圖 navigation network audit 證明零 external map/tile request。
6. local basemap layers、marker clusters、route filters、search、timeline deep links、spoiler controls、distance estimation 全部運行。
7. 所有 UI、docs、comments、reports 用粵文。
8. AI aerial layer 有清楚 conceptual disclaimer；所有 AI assets 有 seed/workflow/model/prompt manifest。
9. ComfyUI 只連 `localhost / 127.0.0.1`，可自動 health check、auto-start（如設定）、MCP queue smoke test。
10. GitHub Actions CI + Pages deploy 成功。
11. `docs/FINAL_ACCEPTANCE_REPORT.md` 完整列出：
    - git commit hash
    - dependency versions
    - test/build/audit 結果
    - public feature count
    - provisional / human review count
    - tile count、總大小、zoom coverage
    - browser network audit 結果
    - asset provenance summary
    - ComfyUI setup status
    - known limitations
    - data / copyright governance status

---

## 14. 不可違反清單

- 不可公開／部署 `Bing-Gang-_full.jsonl`、cleaned full text、原始 markdown、私有 evidence、全文 embedding 或超長引用。
- 未有明確授權時，不可由網站重新爬取、同步、登入、讀取內容。
- 即使獲授權同步，亦不可繞過 login、CAPTCHA、Cloudflare、anti-bot、paywall、robots 或網站存取控制。
- 不可使用任何 online map API、remote raster/vector tiles、runtime online geocoding。
- 不可偽造角色、事件、地點、故事時間、人物外貌、真實衛星影像或官方設定。
- 不可 commit API key、cookie、token、private data、private evidence、ComfyUI server logs containing secrets。
- 不可因缺少人手 review 而將 candidate data 假扮為 verified；要使用 sample / provisional 模式並清楚標示。
- 不可將 ComfyUI fallback 去 cloud image generation；本機生成失敗時要 report，而唔係偷換服務。

---

## 15. 立即執行次序

按以下順序執行；每一步保留 structured log：

1. Inspect workspace、input files、git status、環境能力；建立／更新 `AGENTS.md`、`docs/ARCHITECTURE.md`、`.gitignore`、`.env.example`。
2. 初始化 Vite + TypeScript + test + Python scripts + CI skeleton。
3. 檢查 `data/private/AUTHORIZATION.md` 與 `SYNC_ENABLED`：未滿足則停用 sync；滿足先實作及運行合規 `sync_authorized_source.py`。
4. 實作、測試與執行 `clean_novel.py`、`validate_novel.py`；產出 private cleaned corpus、manifest、anomaly report。
5. 實作 extraction schema、OpenRouter run ledger、review queue、public dataset builder；先輸出最小 valid provisional sample data。
6. 實作 `setup_comfyui_local.py`：health check、auto-start、workflow validation、custom local MCP、512×512 smoke test、setup report。
7. 實作程序化 offline base map、tile renderer、asset manifest；先生成低 zoom demo，驗證 local-only loading。
8. 實作 AI aerial concept workflow；從 guide tile 生成少量 test tiles，檢查 seam、無文字、disclaimer、metadata。
9. 完成主地圖、sidebar、markers、routes、measure、search、timeline、spoiler controls、responsive/a11y。
10. 實作 unit/E2E/visual/network/performance tests 同 `audit_release.py`。
11. 受硬碟及 repository size budget 約束，生成完整所需 zoom tiles、build production site。
12. Push repository、運行 GitHub Actions、部署 GitHub Pages；監察 logs 並修正到成功。
13. 完成 `docs/FINAL_ACCEPTANCE_REPORT.md`、`docs/MCP_AND_SKILLS.md`、`docs/COMFYUI_SETUP.md`、操作手冊：如何清理文字、如何授權同步、如何切換 OpenRouter model、如何重建 public dataset、如何重新生成 tiles、如何部署。

開始執行。除非遇到授權缺失、不可用 credentials 或硬件資源不足，否則持續 autonomous 完成工作；遇到 block 時亦要完成可做部分，並用粵文在 phase report 清楚記錄精確原因同下一步。

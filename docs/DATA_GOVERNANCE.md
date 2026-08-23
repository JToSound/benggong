# DATA GOVERNANCE — 《病港》互動地圖

> 本文件係專案資料治理嘅單一事實來源。任何 phase 嘅資料操作都要遵守以下界線。
> 規格來源：`prompts/master-prompt.md` §3.4、§14。

## 1. 核心紅線

《病港》係版權作品。以下內容一律視為 **private working material**：

- 小說全文（原始 JSONL / Markdown）
- 清理後全文
- Evidence excerpts 同 review queue 內容
- 可重組全文嘅 RAG corpus 或 embedding

**不得 commit 入公開 repo，不得 deploy 到 GitHub Pages，不得出現喺 `dist/`。**

公開網站只可以有：經審閱短摘要、章節參照、結構化事件／位置資料、原創視覺資產。

## 2. 儲存位置矩陣

| 資料 | 位置 | 可 commit | 可 deploy |
|---|---|:-:|:-:|
| 原始 JSONL / Markdown 全文 | `data/private/raw/` | ❌ | ❌ |
| 清理後全文 | `data/private/cleaned/` | ❌ | ❌ |
| evidence excerpts / review queue | `data/private/evidence/`, `data/private/review/` | ❌ | ❌ |
| LLM extraction cache / embeddings | `data/private/cache/` | ❌ | ❌ |
| public GeoJSON / timeline summary | `data/public/` | ✅ 經 audit | ✅ 經 audit |
| AI tiles / markers / original artwork | `public/assets/` | ✅ 帶 manifest | ✅ |

`.gitignore` 已封鎖整個 `data/private/`；每次 release 前由 `audit_release.py` 再驗證一次。

## 3. 不確定性標記制度

推測絕不可寫成事實。所有未經確認嘅資料必須標記：

| 標記 | 用途 |
|---|---|
| `unknown` | 資料不存在或無法判斷 |
| `approximate` | 大約位置／時間 |
| `fictional` | 純虛構，不可配真實坐標 |
| `needs_review` | 待人手審閱 |

每個公開 metadata 都帶：`source`、`chapter_refs`、`precision`、`confidence`、`review_status`。

## 4. Public release gate

1. `data/public/` 只放 `reviewed` / `verified` 資料。
2. 未有人手 review 時，網站行 `VITE_PROVISIONAL_DATA_MODE=true`：只載入清楚標示 provisional 嘅最小 sample dataset，並顯示醒目 banner。
3. 禁止將所有 candidate 一次過公開；禁止假稱完整官方資料庫。
4. `needs_review` 資料不可 deploy，除非 provisional mode 開啟並有 UI banner。

## 5. LLM 資料規則（Phase B）

- API key 只可以由 `OPENROUTER_API_KEY` 讀取；`.env` 不得 commit。
- 不可 commit 完整 LLM request/response 正文；run ledger 只記 model ID、temperature、prompt hash、schema version、token/cost estimate、run ID。
- Extraction temperature 0–0.2；strict JSON + schema validation；invalid retry 一次，再失敗入 review queue。
- LLM 只可根據傳入 evidence 回答；不確定必須輸出 `null` / `unknown`。
- 不可捏造真實香港地址、精確坐標、人物外貌、故事時間、角色關係或未提及情節。

## 6. 內容同步政策（Phase A0）

- 預設停用（`SYNC_ENABLED=false`），只用本機檔案。
- 啟用需全部四項條件：`AUTHORIZATION.md`、`.env SYNC_ENABLED=true`、來源條款及 robots 容許、固定 allowlist URL。
- 即使授權都不可：繞過 login/CAPTCHA/Cloudflare/anti-bot/paywall、儲存帳戶密碼或 session cookie、擴大 URL 範圍。
- 未授權時 `sync_authorized_source.py` 必須 exit non-zero 並顯示粵文說明。

## 7. Takedown 政策

如權利人要求：

1. 即時停止任何同步（設回 `SYNC_ENABLED=false`）。
2. 刪除 `data/private/` 對應內容同 cache。
3. 移除網站上相關摘要／事件資料，重新 build + audit + deploy。
4. 喺 `docs/progress/` 記錄 takedown 範圍同日期。

## 8. Release audit 檢查清單（對應 `audit_release.py`）

- [ ] `dist/` 無任何 private file / raw JSONL / cleaned full text
- [ ] 無長引文（>100 字連續小說文本即 fail）
- [ ] 無 secret patterns（API key、token、cookie）
- [ ] HTML/JS/CSS/JSON 無 remote map/tile URL（OSM、Mapbox、Google、Carto、Esri、Bing 等）
- [ ] 所有 public image/tile 存在於 asset manifest
- [ ] `NOTICE.md`、attribution、本文件存在
- [ ] public locations/events/routes schema valid
- [ ] Playwright network test 證明瀏覽時零 external map/tile request

# C5 Data Governance Audit — 《病港》互動地圖

> **角色**：C5 Data Governance Auditor（對抗驗收）
> **範圍**：驗收矩陣 **DA6** ＋ **§2 第 12 項（Public data safety）**
> **日期**：2026-09-24
> **原則**：敵意審計、可重跑命令、寧報假陽性。**唔改 production code**。
> **只寫**：`docs/audits/`、`artifacts/c5-governance/`。

---

## 1. 執行摘要

| 驗收項 | 定義 | 首輪判定 | 覆核後（commit d6da697） | 依據 |
|---|---|:-:|:-:|---|
| **DA6** | `zones.geojson.evidence` 唔含小說原文 | ✅ **PASS** | ✅ **PASS** | 48/48 feature 已無 `evidence`；F1 已修 |
| **§2-12** | Public data safety：public route／export 無 private-text pattern／secrets／remote map | ⚠️ **FAIL** | ✅ **PASS** | F1／F2／G1 全部已修並驗證 |
| **DA9** | Pipeline idempotent | 需驗 | ❌ **FAIL** | G2：`test_pipeline_is_idempotent` 紅（覆核期間新發現） |

**一句總結**：主腳本三個全綠，但**獨立掃描**搵到一個**繞過所有偵測器**嘅章節原文引用（`ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」`），同時一個 `data/private/` 路徑字串已入到 **deployed** `asset-manifest.json`。

**C8 協作補充（已獨立驗證）**：
- F1 所在嘅 `zone-dossiers.json` **前端唔會 fetch，但係 `dist/` 靜態檔、可直接 URL 下載** → F1 係 **live 曝露**（§6.1）。
- 新增 **F6（P2）**：`review_status`／`spatial_precision` 冇 surface 到 UI，`needs_validation` zone 被呈現成「安全」事實 → 違反 `DATA_GOVERNANCE.md §3`（§6.2）。

---

## 2. 腳本輸出摘要（實際重跑）

系統 Python：`C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe`

### 2.1 `scripts/audit_release.py` → **EXIT 0 ✅**

```text
已掃描 115 個文字檔；記錄總數 4668（needs_review 0）

✅ RELEASE AUDIT PASSED——無私隱洩漏、無 secrets、無 remote map URL、文件齊全
```

### 2.2 `scripts/validate_public_data.py` → **EXIT 0 ✅**

```text
公開資料驗證：{'location': 704, 'event': 1796, 'route': 42, 'timeline': 1796,
 'character': 330, 'zone': 48, 'zone_dossier': 48, 'chronicle_entry': 1320,
 'chapter_summary': 195}
review 分佈：{'verified': 0, 'reviewed': 4626, 'needs_review': 42}

✅ 全部通過（schema、引用一致性、治理掃描、manifest、provisional gate）
```

> 註：42 條 `needs_review` ＝ 42 條 `routes.geojson`（自動推斷路線），provisional banner 已啟用，符合 gate。
> 註：`zones.geojson` 用 `needs_validation`/`auto_inferred`/`validated`（10/31/7），**唔用** `needs_review` —— 兩套 review_status 詞彙並存（見 §6 R3）。

### 2.3 `scripts/validate_spatial_narrative.py` → **EXIT 0 ✅**

```text
  ✅ R1_geometry_validity  fail=0    ✅ R5_event_location_coherence  fail=0
  ✅ R2_bounds             fail=0    ✅ R6_duplicate_near_duplicate   fail=0
  ✅ R3_zone_membership    fail=0    ✅ R7_narrative_temporal         fail=0
  ✅ R4_route_continuity   fail=0    ✅ R8_unknown_over_hallucination fail=0
  ✅ 敘事層雙向一致 / dossier 引用 / 版權掃描（0 個問題）

✅ 全部通過（R1–R8 + 敘事層一致性）
```

---

## 3. 獨立掃描結果（唔信上面腳本）

獨立掃描器：`artifacts/c5-governance/independent_governance_scan.py`
覆蓋面：`data/public/`、`public/`、`dist/`、`src/`、`docs/` ＋ 根目錄部署檔（`index.html` 等）。共讀 **380 個文字檔**。

### 3.1 原文特徵

| 掃描 | 命令 | 命中 | 判定 |
|---|---|:-:|:-:|
| 章節原文引用 `原文：「…」` | `grep -rnE "原文[[:space:]]*[：:「]"` on data/public public dist | **0** | ✅ |
| **章節編號＋引號 `chN：「…」`** | `grep -rnoE "ch[0-9]{1,4}[[:space:]]*[：:][[:space:]]*[「『][^」』]{4,}[」』]"` | **2**（同一句，2 檔） | ❌ **F1** |
| 長中文段落（≥40 連續 CJK） | 自寫 regex `LONG_CJK_40` | **0** | ✅ |
| 長中文段落（>100 連續 CJK） | 自寫 regex `LONG_CJK_RUN` | **0** | ✅ |
| `data/private` 字面路徑 | `grep -rn "data/private"` on data/public public dist src | **4**（見 F2/F3） | ❌ **F2** |
| private marker（`evidence_excerpt` 等） | `grep -rl` on dist | **0** | ✅ |

**F1（P1 — 最嚴重）：章節原文引用逃逸**

```text
data/public/zones.geojson:577:        ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」
data/public/zone-dossiers.json:2039:  ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」
public/data/public/zones.geojson        （同步副本，同一句）
public/data/public/zone-dossiers.json   （同步副本，同一句）
dist/data/public/zones.geojson          （deployed，同一句）
dist/data/public/zone-dossiers.json     （deployed，同一句）
```

- 位置：`zones.geojson` feature `zone_d3f76d3c94` 嘅 `population` 欄位，以及 `zone-dossiers.json` 對應 `society.population`。
- 全文：`百多人（ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」）`
- **為何繞過所有偵測器**：
  1. `validate_public_data.py` / `validate_spatial_narrative.py` / `public-data-safety.e2e.test.ts` 嘅 regex 全部要求**字面 `原文`**（`原文\s*[：:「]` 或 `ch\d+\s*原文`）。呢句係 `ch0092：「…」`，**冇「原文」二字** → 全部漏。
  2. `LONG_CJK_RUN`（>100 連續 CJK）—— 呢句引文只 22 字 → 漏。
  3. `audit_release.py` 嘅 `LONG_CJK` 同樣要 100 字 → 漏。
- **判定**：呢個正正係 `AGENTS.md` 版權紅線第 4 條同 DA6 原意要防嘅 `chN 原文：「…」` 格式（只係省略咗「原文」）。屬**高信心違規**。**已進入 deployed bundle**（`dist/`），任何人下載得到。

**F1 衍生：`data/public` 引號內容分佈（量度）**

```text
總「」引號數：1866
長度分佈：{ '>=40字': 0, '>=25字': 0, '>=15字': 10, '<15字': 1856 }
最長 22 字（就係 F1 嗰句）；其餘 ≥15 字嘅 9 條多為角色台詞（見 F5）
```

→ 好消息：**冇任何 ≥25 字嘅引號**，即冇長段原文。但 ≥15 字嘅 10 條係「短台詞逐字引用」，係 F5 邊界風險。

### 3.2 Secrets

| 掃描 | 命令 | 命中 | 判定 |
|---|---|:-:|:-:|
| 部署面 secrets（openrouter/generic/bearer/private-key/github-pat/aws/google/slack） | `independent_governance_scan.py` on data/public public dist src docs | **0** | ✅ |
| Repo-wide `sk-or-v1`/`ghp_`/`PRIVATE KEY`/`AKIA`/`AIza` | `Grep`（排除 node_modules） | **1 檔：`tests/test_audit_release.py:53`** | ✅ 假陽性（測試 fixture：`"sk-or-v1-abcdefghijklmnop123456"`） |
| `.env` 是否被追蹤 | `git ls-files | grep ^\.env` | 只有 `.env.example` | ✅ |
| `.env` 內真實 key 有無外洩 | 部署面掃描 | 0 | ✅ |
| `dist`/`public` 有無 `.env` 殘留 | `find dist public -iname "*.env*"` | **0** | ✅ |

> `.env` 本機檔含一個真實 `OPENROUTER_API_KEY`（73 字元，`sk-` 樣式），但 `.gitignore:44` 已封鎖、從未追蹤、**冇外洩到任何部署面**。

### 3.3 Remote map / tile / geocoder host

| 掃描 | 命中 | 判定 |
|---|:-:|:-:|
| 部署面（`data/public`+`public`+`dist`+`src`+`index.html`）remote host | **0** | ✅ |
| `src/` 內 `https?://`（排除 w3.org/localhost） | **0** | ✅ |
| `index.html` 外部 `src=`/`href=` | **0**（只有本機 manifest、icon、`/src/main.ts`） | ✅ |
| repo 其他命中 | `docs/audits/design-reference-patterns.md`（反面教材）、`tests/network-audit.test.ts`（偵測器）、`scripts/audit_release.py`（偵測器） | ✅ 假陽性 |

**F4（info）：build-time geocoder 殘留**

```text
scripts/gen_fallback_anchors.py:57:  NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
```

- 屬 **build/dev-time** 一次性抓取（有 cache fallback，`data/private/cache/`），**唔係 runtime**。
- 唔喺部署面，唔違反「runtime 100% 離線」。但專案聲稱「完全離線」，呢個 script 係唯一會連 remote geocoder 嘅路徑 → 列作**殘餘風險**（建議標明「需手動執行、預設唔跑」）。

### 3.4 `data/private/` gitignore 驗證

| 檢查 | 命令 | 結果 | 判定 |
|---|---|---|:-:|
| gitignore 命中 | `git check-ignore -v data/private` | `.gitignore:5:data/private/` | ✅ |
| 有無被追蹤 | `git ls-files data/private` | **空** | ✅ |
| 有無入過 git 歷史 | `git log --all -- data/private` | **空** | ✅ |
| 歷史 object 有無 private 路徑 | `git rev-list --all --objects \| grep -iE "data/private\|Bing-Gang-_full\|evidence_excerpt\|candidates\.jsonl"` | **空** | ✅ |
| 本機 private 內容 | `find data/private -type f` | 有 raw/cleaned/evidence/review/cache（預期） | ✅ 全部 ignored |

> 本機 `data/private/` 確實存有 `raw/Bing-Gang-_full.jsonl`、`cleaned/bing-gang.clean.jsonl`、`evidence/candidates.jsonl`、`review/*` —— 全部 **未 commit、未 deploy**，符合紅線 1。

### 3.5 `dist/` 有無 `data/private` 內容

| 檢查 | 命令 | 結果 | 判定 |
|---|---|---|:-:|
| `dist` 有無 private 目錄/檔 | `find dist -ipath "*private*"` | **空** | ✅ |
| `dist` 內 private marker | `grep -rl -E "evidence_excerpt\|candidates\.jsonl\|extraction-ledger\|review-queue\|bing-gang\.clean\|Bing-Gang-_full" dist` | **空** | ✅ |
| `dist` 內 `data/private` 字面 | `grep -rl "data/private" dist` | **`dist/data/public/asset-manifest.json`** | ❌ **F2** |
| `dist/data` 結構 | `find dist/data -maxdepth 3 -type d` | 只有 `dist/data/public` | ✅ |

**F2（P2）：`data/private/` 路徑字串入咗 deployed manifest**

```text
data/public/asset-manifest.json:26
public/data/public/asset-manifest.json:26
dist/data/public/asset-manifest.json:26
```

內容（`notes[4]`）：

```text
"2026-09-16：角色合併（11 個異體併入 canonical），342 → 331。
 詳見 data/private/review/character-merge-applied.json。"
```

- 只洩露**私有目錄結構同檔名**，**冇洩露內容**。
- **繞過 `audit_release.py`**：其 `PRIVATE_MARKERS` 冇包 `data/private` 字面（只有 `bing-gang.clean`/`Bing-Gang-_full`/`evidence_excerpt`/`candidates.jsonl`/`extraction-ledger`/`review-queue`）。`public-data-safety.e2e.test.ts` 嘅 §2-12-5 只檢查**檔名**含 `private`，唔檢查**內容**字串。
- 判定：**低—中** 嚴重度，但屬 `DATA_GOVERNANCE.md §1`「不得出現喺 dist/」精神。

**F3（P3）：source 註解洩露 private 路徑**

```text
src/data/fallbackAnchors.ts:3-4
// 來源：data/private/cache/fallback-anchors.json（curated）+
//       data/private/cache/osm-hk.json（OSM Overpass，ODbL）。
```

- 只係 TS 註解，production build 通常 strip；但 dev／source map 可見。低嚴重度。

---

## 4. `coordinate_anchor` 欄位審查（今日改動）

命令：

```bash
python -c "import json; d=json.load(open('data/public/locations.geojson',encoding='utf-8')); \
print(sum('coordinate_anchor' in f['properties'] for f in d['features']))"
```

結果：**704 個 location 之中，10 個帶 `coordinate_anchor`**。全部 10 條內容：

```json
{"name": "將軍澳廣場",     "coord": [114.26276, 22.308841], "rule": "A", "relation": "at",       "distance_m": 515.9}
{"name": "將軍澳廣場",     "coord": [114.26276, 22.308841], "rule": "A", "relation": "at",       "distance_m": 757.0}
{"name": "將軍澳廣場",     "coord": [114.26276, 22.308841], "rule": "A", "relation": "at",       "distance_m": 726.0}
{"name": "新都城中心三期", "coord": [114.256992, 22.322438], "rule": "A", "relation": "at",       "distance_m": 847.0}
{"name": "新都城中心一期", "coord": [114.257297, 22.321263], "rule": "B", "relation": "adjacent", "confidence": 0.85, "distance_m": 779.8}
{"name": "新都城中心三期", "coord": [114.256992, 22.322438], "rule": "B", "relation": "adjacent", "distance_m": 847.0}
{"name": "新都城二期",     "coord": [114.258518, 22.322959], "rule": "C", "relation": "at",       "confidence": 0.8,  "distance_m": 2374.0}
{"name": "新都城二期",     "coord": [114.258518, 22.322959], "rule": "A", "relation": "at",       "distance_m": 674.4}
{"name": "新都城中心三期", "coord": [114.256992, 22.322438], "rule": "A", "relation": "at",       "distance_m": 816.1}
{"name": "仁興工業大廈",   "coord": [114.274015, 22.281868], "rule": "C", "relation": "at",       "confidence": 0.8,  "distance_m": 2776.8}
```

**判定：✅ 乾淨。** 只含**現實地標名**（將軍澳廣場、新都城中心一/二/三期、仁興工業大廈）＋座標 ＋ rule/relation/confidence/distance_m。**冇任何原文、冇任何台詞、冇任何小說句子**。欄位設計符合 `validate_public_data.py` 嘅 `coordinate_source="text_landmark"` 定義（故事文字點名嘅現實地標）。

> 註：`coordinate_anchor` **未寫入** `data/schemas/location.schema.json`（schema 無 `additionalProperties:false`，故驗證仍過）。屬**文件化缺口**而非驗證失敗 —— 建議把欄位補入 schema，令契約完整（本次審計只讀，未改 schema）。

### 4.1 `coordinate_anchor` 係**衍生欄位**，唔穩定（覆核補充）

C4 指出 `loc_0376 梁潔華小學` 失去 anchor；我獨立驗證，確認機制如下：

```bash
# scripts/anchor_locations_from_text.py:329-341 —— 有 inferred_from 就 pop coordinate_anchor
for f in doc["features"]:
    if f["properties"].get("inferred_from") and f["properties"].get("coordinate_anchor"):
        f["properties"].pop("coordinate_anchor", None)

# scripts/anchor_locations_from_text.py:302 —— 「補」pass 跳過有 inferred_from 嘅 location
if not anc or p["id"] in seen or p.get("inferred_from"): continue

# scripts/apply_place_inferences.py:422 —— 設定 inferred_from
p["inferred_from"] = hit["inference_id"]
```

量測（現時 worktree）：

```text
loc_0364 新都城中心三期 | inferred_from=None            | anchor=True  | src=text_landmark        | conf 0.95
loc_0376 梁潔華小學     | inferred_from='inf_loc_0376'   | anchor=False | src=cross_chapter_evidence| conf 0.55
                        | coords 同 loc_0364 完全一樣（114.256992,22.3228）→ 仍然塌縮

全 dataset：inferred_from 非空 = 260 條；其中同時有 coordinate_anchor = 0 條（互斥不變式成立）
```

- **治理判定**：`coordinate_anchor` 只含地名＋座標，**冇原文**，唔影響 DA6／§2-12（治理層乾淨）。
- **但**佢係「文字錨定 vs 推斷鎖定」互斥嘅衍生欄位 —— 所以 §4 嘅「10 個 feature」係**快照值**，重跑管線會變。呢個屬 C4 範疇（塌縮未完全修好），我記錄作**跨審計一致性備註**：任何引用 `coordinate_anchor` 嘅統計都要註明係邊個 pipeline run。

---

## 5. DA6 + §2-12 逐項判定

### DA6 — `zones.geojson.evidence` 唔含小說原文

| 檢查 | 命令 | 結果 | 判定 |
|---|---|---|:-:|
| `data/public/zones.geojson` 有 `evidence` 嘅 feature | python 統計 | **0 / 48** | ✅ |
| `public/data/public/zones.geojson` | 同上 | **0 / 48** | ✅ |
| `dist/data/public/zones.geojson` | 同上 | **0 / 48** | ✅ |
| `validate_spatial_narrative.py` 版權掃描 | R1–R8 + `check_copyright` | 0 問題 | ✅ |

**DA6 = ✅ PASS**（evidence 欄位 48/48 完全移除，三個副本一致）。

> ⚠️ 但 DA6 原意係「zone 公開資料唔可以有原文」。雖然 `evidence` 欄位冇咗，**同樣嘅 `chN：「…」` 引用格式已遷移到 `population` 欄位**（F1）。所以 **DA6 字面 PASS，但紅線意圖未完全達成** —— 建議把 DA6 斷言由「冇 `evidence` 欄位」擴闊到「任何欄位都冇 `chN[原文]：「…」`」。

### §2 第 12 項 — Public data safety

| 子斷言 | 命中 | 判定 |
|---|:-:|:-:|
| public route／export 無 secret | 0 | ✅ |
| public route／export 無 remote map/tile | 0 | ✅ |
| public 資料無 `原文：「…」` 引用 | 0 | ✅ |
| `zones.geojson.evidence` 已移除 | 0 | ✅ |
| `dist` 無 private 檔案 | 0 | ✅ |
| **無「任何形式」嘅原文引用** | **1（`ch0092：「…」`）** | ❌ **F1** |
| **`dist` 無 private 路徑字串** | **1（`data/private`）** | ❌ **F2** |

**§2-12 = ⚠️ FAIL（1 個逃逸原文樣式 ＋ 1 個 private 路徑字串）**

- 若**嚴格照字面**（只驗 `原文：「…」`、secrets、remote map）→ PASS。
- 若**照治理意圖**（public 唔可以有原文、dist 唔可以有 private 痕跡）→ **FAIL**。本審計採**意圖判定**：**FAIL**。

---

## 6. 未解決風險 / 建議

| ID | 嚴重度 | 風險 | 建議（可重跑、零人手） |
|---|:-:|---|---|
| **F1** | **P1** | `ch0092：「…」` 章節原文引用入 deployed bundle，繞過所有偵測器 | 1) 將 `population` 引文改為純摘要（移除 `ch0092：「…」`）。2) **擴闊**所有版權 regex 為 `(ch|CH|第)\s*\d+\s*(原文)?\s*[：:]\s*[「『"]`，並加一條「任何 `「」` 內容 ≥15 字」warning。3) 加 pytest 斷言：public 資料任何字串都唔可以 match `ch\d+[：:][「『]`。 |
| **F2** | **P2** | `data/private` 路徑字串入 `asset-manifest.json`（deployed 3 份） | 移除 `notes[4]` 嘅 `data/private/...` 路徑，改寫成「詳見 review 紀錄（私有）」。並喺 `audit_release.py` `PRIVATE_MARKERS` 加 `data[/\\]private`。 |
| **F3** | **P3** | `src/data/fallbackAnchors.ts` 註解洩露 `data/private/cache/` 路徑 | 註解改為「本機快取（私有，不部署）」，或確認 build 已 strip。 |
| **F4** | **info** | `gen_fallback_anchors.py` 連 `nominatim.openstreetmap.org`（build-time） | 保持有 cache fallback；喺文件標明「需人手執行、預設唔跑、需網絡」。 |
| **F5** | **P3** | 1866 條「」引號，10 條 ≥15 字（角色台詞逐字） | 覆核 10 條 ≥15 字引文（最長 19 字，如「只要我仲在生，你都唔洗諗住攻陷到大本營」），確認屬「短摘要」而非「逐字引用」；必要時改寫。 |
| **F6** | **P2** | 誠實標示（`review_status`／`status`／`spatial_precision`）**冇 surface 到 UI**，`needs_validation` 資料被呈現成事實（見 §6.1） | 於 UI render review_status／precision badge；未 validated 嘅 zone 唔可以顯示「安全」。 |
| **R3** | info | `zones.geojson` 用 `needs_validation`/`auto_inferred`/`validated`，其他檔用 `needs_review`/`reviewed` —— 兩套詞彙並存 | 統一 review_status 詞彙，避免 gate 統計分歧（`audit_release` 報 0，`validate_public_data` 報 42）。 |

### 6.1 F1 補充：`zone-dossiers.json` 係「有出街但冇被前端 fetch」

C8 提供（已獨立驗證）：

```bash
grep -n "zone-dossiers" src/data/loadAllData.ts            # 冇命中（Promise.all 唔含佢）
grep -rn "loadDossiers" src tests                          # 只喺 src/data/adapter/index.ts 定義 + tests/data-adapter.test.ts 呼叫
ls -la dist/data/public/zone-dossiers.json                 # 存在（100914 bytes）
```

- `zone-dossiers.json` **唔喺** 首屏 `loadAllData` Promise.all，`loadDossiers()` 只喺測試被呼叫 → **app runtime 唔會 fetch**。
- **但**佢仍然係 `dist/data/public/zone-dossiers.json` 靜態檔 → **任何人可直接用 URL 下載**。
- **結論**：F1（`ch0092：「…」`）**仍然係 live 曝露**，唔可以因為「前端冇 load」而降級。呢個亦提醒：**governance 掃描必須以「deployed 檔案」為準，唔可以只睇 app 實際 fetch 嘅嘢**（因為 attacker 唔會只用 app）。

### 6.2 F6：誠實標示制度（DATA_GOVERNANCE.md §3）未落實到 UI

C8 提供（已獨立驗證）：

```text
src/components/ZoneDossier.ts:29   sub: "人類聚居 · 安全"        ← 11 個倖存區寫死
src/components/ZoneDossier.ts:130  confidence 有 render（百分比）
（review_status / status / spatial_precision / coordinate_review_status 冇 render）
```

- 48 個 zone：`validated` 只 7、`auto_inferred` 31、`needs_validation` 10。
- UI 對所有倖存區一律顯示「人類聚居 · 安全」，**唔理 review_status**。
- `DATA_GOVERNANCE.md §3` 明文：「**推測絕不可寫成事實**。所有未經確認嘅資料必須標記」。
- 心朗村（`confidence 0.4`，自己 summary 都講「文中未交代…是否一個正式嘅倖存區」）UI 仍顯示綠色「安全」盾牌 → **治理紅線（§3）違反**。
- **判定**：屬 **§2-12「public export 誠實性」** 嘅延伸違規；雖然唔係原文／secret，但係「把 needs_validation 資料當事實發佈」。建議 C7／C8／主代理喺 UI 補 review_status／precision badge。

### 已確認 ✅（正面）

- 部署面 **無任何 ≥40 字中文段落**、**無 secrets**、**無 remote map/tile**。
- `data/private/` **gitignore 有效、從未 commit、從未入 git 歷史**。
- `dist/` **無 private 目錄/檔、無 private marker**。
- `.env` **未追蹤、真實 key 未外洩**。
- `coordinate_anchor` **乾淨**（只地名＋座標）。
- `index.html`、`src/` **零外部 URL**。

---

## 7. 可重跑命令清單

```bash
PY="C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe"

# 主腳本
"$PY" scripts/audit_release.py                 # EXIT 0
"$PY" scripts/validate_public_data.py          # EXIT 0
"$PY" scripts/validate_spatial_narrative.py    # EXIT 0

# 獨立掃描器
"$PY" artifacts/c5-governance/independent_governance_scan.py

# F1：章節原文引用逃逸
grep -rnoE "ch[0-9]{1,4}[[:space:]]*[：:][[:space:]]*[「『][^」』]{4,}[」』]" data/public public/data dist/data

# F2：deployed private 路徑
grep -rl "data/private" dist data/public public/data

# gitignore 驗證
git check-ignore -v data/private
git ls-files data/private                          # 空
git log --all --oneline -- data/private            # 空

# coordinate_anchor
"$PY" -c "import json;d=json.load(open('data/public/locations.geojson',encoding='utf-8'));print(sum('coordinate_anchor' in f['properties'] for f in d['features']))"
```

---

## 8. 結論（首輪，2026-09-24 初版）

- **DA6 = ✅ PASS**（字面）；但紅線意圖**未完全達成**（F1 逃逸）。
- **§2-12 = ⚠️ FAIL**（治理意圖判定）：1 個章節原文引用逃逸（F1，P1）＋ 1 個 deployed private 路徑字串（F2，P2）。
- **最嚴重**：F1 —— `ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」` 已入 `dist/`，且**繞過全部現有 gate**。
- 主腳本三個全綠**唔等於**無問題；F1/F2 正正係「腳本綠但意圖未達」嘅盲點。

---

## 9. 覆核：F1／F2 修復驗證（2026-09-24，commit `d6da697`）

> team-lead 已 push `d6da697 fix(data): 修版權紅線逃逸`。以下係**獨立重跑**，唔信 commit message。

### 9.1 F1 — ✅ **已修，驗證通過**

| 檢查 | 命令 | 輸出 | 判定 |
|---|---|---|:-:|
| 精確逃逸句（三副本） | `grep -rn "如果大本營百多個人一起拿著武器衝進不良人據點" data/public public/data dist/data` | **空** | ✅ |
| 章節引用指紋（三副本） | `grep -rnoE "ch[0-9]{1,4}\s*[：:]\s*[「『][^」』]{4,}[」』]" data/public public/data dist/data` | **空** | ✅ |
| 其他變體（第N章／chN／CHN + ：「） | `grep -rnoE "(第[0-9]{1,3}章\|ch\|CH\|Ch)\.?\s*[0-9]{1,4}\s*[：:「]" data/public public/data dist/data` | **空** | ✅ |
| 消毒後欄位值 | `zone_d3f76d3c94.population` / `dossier_d3f76d3c94.society.daily_life` | 兩者皆 **`'百多人'`** | ✅ |
| 引號總數（data/public） | 自寫量度（前：1866／最長 22） | **1864／最長 19**（−2 條＝F1 兩副本） | ✅ 無過度消毒 |
| 新正則入偵測器 | `grep -n "ch\s*\d{1,4}\s*[：:]\s*[「『]"` | `validate_public_data.py:58`、`validate_spatial_narrative.py:100`、`tests/test_spatial_integrity.py:63` | ✅ |
| 消毒器接入管線 | `grep -n sanitise scripts/merge_zone_dossiers.py` | `690: import sanitise_public_data`、`692: st_san = sanitise_public_data.run(write=write)` | ✅ |

**F1 判定：✅ 已修（data 層 + 管線層）。**

三個主腳本覆核後重跑（仍全綠）：

```text
audit_release.py               → 已掃描 115 個文字檔；記錄總數 4668（needs_review 0）→ ✅ PASSED
validate_public_data.py        → location 704 / event 1796 / route 42 / zone 48 / dossier 48 / chronicle 1320 → ✅ 全部通過
validate_spatial_narrative.py  → R1–R8 全 pass + 敘事層 0 問題 → ✅ 全部通過
```

**⚠️ 但 G1（P2）：release gate 未加固 —— 仍有回歸風險。** team-lead 講「三個偵測器」加咗正則，但**最重要嗰兩個冇加**：

```text
scripts/audit_release.py            → 只有 LONG_CJK（>100 CJK）。實測：
                                       LONG_CJK.search("百多人（ch0092：「如果大本營…據點」）") = False
tests/public-data-safety.e2e.test.ts → line 66 仍係 /原文\s*[：:]\s*[「『"]/，冇 chN：「 變體
```

- 即係：`audit_release.py`（驗收矩陣 §1 強制命令、唯一掃 `dist/` 嘅 release gate）同 **§2-12 對應嘅 e2e 驗收測試**，對 `chN：「…」` **依然全盲**。
- 若日後有人繞過管線（手改 `data/public/`、或新來源路徑）令逃逸再現，`audit_release.py` 會 PASS、§2-12 測試會 PASS → **回歸靜默**。
- **建議**：把同一條正則加入 `audit_release.py`（加一個 `NOVEL_QUOTE_REF` 檢查）同 `tests/public-data-safety.e2e.test.ts`。

**G1 後續（2026-09-24 稍後）：✅ 已修。** team-lead 已改 `scripts/audit_release.py`（新增 `NOVEL_QUOTE` regex）同 `tests/public-data-safety.e2e.test.ts`（`pattern` 加 `ch\s*\d{1,4}\s*[：:]\s*[「『"]`）。C5 獨立驗證：

```python
pat = re.compile(r'原文\s*[：:「]|ch\s*\d+\s*原文|ch\s*\d{1,4}\s*[：:]\s*[「『]')
'百多人（ch0092：「如果大本營…」）' → True    # 捉到逃逸 ✅
'ch73 原文：「x」'               → True    ✅
'原文：「x」'                    → True    ✅
'百多人' / 'ch0092（大本營）'     → False   # 唔誤中合法章節參照 ✅
```

`audit_release.py` 重跑仍 `✅ RELEASE AUDIT PASSED`。**G1 判定：✅ 已修（回歸保護補齊）。**

### 9.2 F2 — ✅ **已修，驗證通過**

| 檢查 | 命令 | 輸出 | 判定 |
|---|---|---|:-:|
| deployed manifest 內容 | `python -c "json.load(open('data/public/asset-manifest.json'))"` | `notes[4]` = 「…342 → 331。**詳見 專案私有記錄。**」 | ✅ |
| `data/private` 字面（三副本） | `grep -rn "data/private" data/public public/data dist/data` | **空** | ✅ |

**F2 判定：✅ 已修。**

### 9.3 覆核期間**新發現**（唔屬 team-lead 修復範圍）

| ID | 嚴重度 | 發現 | 證據 | 建議 |
|---|:-:|---|---|---|
| **G1** | **P2** | release gate `audit_release.py` ＋ §2-12 e2e 測試**未加固**（見 §9.1） | 見上 | ✅ **已修**（team-lead 補正則，C5 驗證命中逃逸） |
| **G2** | **P2** | **`test_pipeline_is_idempotent` FAIL** —— DA9 未達 | `pytest tests/test_spatial_integrity.py -q` → `1 failed, 36 passed`；`locations.geojson: 171884f9 → eceee036`、`zone-membership.json: 33fbc3c8 → 8ee41be4`。**C4 已精準定位根因**（見 §9.6） | 一行修法：`origin = anc.get("from") or cur`（見 §9.6） |
| **G3** | **info** | `tests/test_spatial_integrity.py::test_pipeline_is_idempotent` **有副作用：會就地改寫 `data/public/`**（`subprocess.run([sys.executable, ZONE_MERGER], cwd=REPO)` 跑兩次，`merge_zone_dossiers.py` 寫檔） | 見 §9.4 | 測試應喺 temp dir 跑，或跑完還原；否則任何「跑 pytest」都會污染 working tree |

> ⚠️ **G2 同 team-lead 聲稱「pytest 308 passed」有出入** —— 我獨立跑 `tests/test_spatial_integrity.py` 得到 **1 failed**。可能 team-lead 跑嗰陣 working tree 狀態唔同（例如未 apply C4 嘅 `anchor_locations_from_text.py` 環形偏移改動），或者 308 係另一個 snapshot。**建議 team-lead 喺 commit 前再確認一次 full pytest。**

### 9.4 G3 披露：本審計誤觸發 data 寫入（自我報告）

- 我執行咗 `pytest tests/test_spatial_integrity.py -q`（為咗驗證新回歸測試）。
- 該檔嘅 `test_pipeline_is_idempotent` 會 `subprocess.run(merge_zone_dossiers.py, cwd=REPO)` **兩次**，而 `merge_zone_dossiers.py` 會**就地寫 `data/public/`**（＋ `artifacts/b4/zone-membership.json`）。
- 後果：`git status` 顯示 6 個 `data/public/*` 檔變 `M`（mtime 22:21:30–53，＝我 pytest 執行時間）。
- **我冇再改動 `data/`**（避免同 C4 嘅並行 pipeline run 撞車）。當時 working tree 亦見 `scripts/anchor_locations_from_text.py` 被改（環形偏移修復，mtime 22:21:31）。
- **更正歸屬**（C4 澄清）：該 script 改動**唔係 C4** 改嘅，係 **team-lead 採納 C4 報告 §3.1 建議**加 `apply_offsets`。C4 全程只讀 + 喺 `artifacts/c4-spatial/idem/` 沙盒跑。
- **驗證**：現時 worktree `locations.geojson` 嘅同地標群座標**已散開**（新都城中心三期 3 個 location → 3 個唔同座標），即 `apply_offsets` 已生效。
- **⚠️ 唔好 `git checkout -- data/public/`**（C4 明確指出）：pipeline 由 HEAD 跑要 **3 次** 才收斂（`run1 ≠ run2 = run3 = run4`），revert 只會令 CI 再紅。正確做法係**修好冪等 bug → 重跑 → commit**，令 HEAD 成為不動點。

### 9.5 覆核後判定更新

| 驗收項 | 首輪 | 覆核後 | 備註 |
|---|:-:|:-:|---|
| **DA6** | ✅ PASS | ✅ **PASS** | evidence 欄位已移除；F1 已修（`chN：「…」` 清零） |
| **§2-12** | ⚠️ FAIL | ✅ **PASS** | F1、F2 已修並驗證；**G1 亦已修**（`audit_release.py` + e2e 補正則，C5 驗證） |
| **DA9**（pipeline idempotent） | 需驗 | ❌ **FAIL** | G2：`test_pipeline_is_idempotent` 紅（殘留根因見 §9.9） |

> **§2-12 最終判定：✅ PASS**（現時 deployed 內容乾淨 + 回歸保護已補齊）。

### 9.6 DA9 根因（C4 提供，C5 已獨立複核）

C4 由 `git show HEAD:data/public/*` 抽入沙盒連跑 4 次：`run1 b0f70de1 → run2 960e2167 → run3 960e2167 → run4 960e2167` → **第 3 次才收斂**。座標本身冇郁（9 個錨定 0.0 m），郁嘅係 metadata。

**根因**（`scripts/anchor_locations_from_text.py:296-319`「補」pass）—— 用**當前座標**做 `from`：

```python
cur = (f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1])
...
"distanceM": round(dist_m(cur, base), 1),
"from": [round(cur[0], 6), round(cur[1], 6)],   # ← run1 寫基準座標；run2 讀返「已偏移」座標
```

| | `coordinate_anchor.from` | `distance_m` |
|---|---|---|
| run1 | 地標基準 `114.26276,22.308841` | 0.1 |
| run2+ | 已偏移座標 `114.26276,22.309203` | 40.1 |

**一行修法**：`origin = anc.get("from") or cur`，之後 `"from": origin`、`"distanceM": round(dist_m(origin, base), 1)` → run1 寫入 `from` 後，run2 讀返同一個 → 冪等。修完要**再跑一次 pipeline 並 commit `data/public`**，令 HEAD 成為不動點（否則 fresh checkout 跑 CI 一定紅）。

**C5 獨立複核**：已確認 `anchor_locations_from_text.py:319` 就係 `"from": [round(cur[0], 6), round(cur[1], 6)]`（用當前座標），同 C4 描述一致。

> ⚠️ 提醒：此項（DA9）屬 C4 範疇，本 C5 報告只作**交叉引用**；DA9 最終判定以 C4 報告為準。

### 9.7 附帶發現：`loc_0376` 失去 anchor（C4 提供，C5 精確定位）

見 §4.1。精確定位：**唔係** `apply_place_inferences.py` 直接清，而係 `anchor_locations_from_text.py:329-341` 見到 `inferred_from` 非空就 `pop("coordinate_anchor")`；同時「補」pass（:302）跳過有 `inferred_from` 嘅 location → 冇偏移 → 仍然同 `loc_0364` 完全同座標。屬 C4 範疇（塌縮未完全修好），C5 只記錄跨審計一致性。

### 9.8 塌縮規模（C4 提供，C5 獨立複核）＋ 治理標示檢查

C4 量化咗塌縮規模；**C5 獨立重算，數字完全吻合**：

```text
≥5 成員簇            : 10 個，共 171 個 location
  其中全部 inferred_from : 8 簇，142 個 location   ← 永久鎖死（兩個塌縮機制都 skip）
  最大                : 89 個 @ (114.25343, 22.30581)（大本營）
  其次                : 24 個 @ (114.2415, 22.3229)（寶琳）、11 個 @ (114.25332, 22.30547)（D座大樓）
```

**C5 治理角度覆核（新）**：呢 260 個 `inferred_from` location 嘅**治理標示係齊嘅** ——

```text
coordinate_source        : cross_chapter_evidence ×260      ✅（標明推斷來源）
coordinate_review_status : needs_validation 256 / auto_corrected 4  ✅（標明未驗證）
coordinate_confidence    : 0.55×188 / 0.95×42 / 0.8×30       ✅（有信心度）
spatial_precision        : None ×260                         ⚠️（缺，但 DA1 唔要求 location 有此欄）
```

→ **數據層冇「推斷當事實」嘅誠實性問題**（source＋review_status＋confidence 齊）。塌縮（142 個）純屬空間質量問題（DA8，C4 範疇），**唔影響 DA6／§2-12**。
→ F6（誠實標示）嘅問題**純粹喺 UI 層**：`ZoneDossier.ts` 唔 render `review_status`，所以數據層雖然標咗 `needs_validation`，用戶睇唔到。呢個再次印證 F6 係真問題。

**C5 支持 C4 嘅 gate 建議**：R6 只計「非推斷」簇 → 所有 gate 綠燈但 142 個 marker 鎖死 = **靜默失敗**，同治理原則「唔可以靜默綠燈」一致。建議 R6 對「任何 ≥5 簇（唔分推斷）」出 **warn**。

### 9.9 DA9 殘留根因（C4 定位，C5 交叉引用）＋ 並行寫入澄清

**DA9 殘留根因換咗**（C4 Task #10）：`locations.geojson` 原本嗰個 `171884f9 → eceee036` 已修好（run1==run2==run3）。但 `test_pipeline_is_idempotent` 仍然紅，根因變成 **`artifacts/b4/zone-membership.json`**：

```text
/inputs/events.geojson    '715ec0210948…' → 'fcae79a680dd…'
/inputs/locations.geojson '639bfb201af4…' → 'b3b67f80d1ba…'
```

- `infer_zone_membership.py:757` 寫嘅 zm **內嵌自己輸入檔嘅 SHA-256** → 只要輸入未收斂，run1 改寫 `data/public` → run2 讀到唔同輸入 hash → zm 唔同。收斂序列 `9f70b08f → dcfd87af → dcfd87af`（run2 才穩）。
- **結論**：`test_pipeline_is_idempotent` 只在 `data/public` 已係**不動點**時才會 PASS；HEAD 唔係不動點 → fresh checkout 跑一定紅。
- **C4 建議**：① 最正 —— 唔好把 input hash 寫入 pipeline 輸出（改 sidecar 或唔納入比對範圍）；② 或者 commit 一次已收斂嘅 `data/public` + zm。**唔建議**喺測試 exclude `inputs`（＝放寬門檻）。
- **C5 立場**：**同意 ①／②，反對放寬門檻**（同 AGENTS.md「唔可以靜默略過」一致）。屬 C4 範疇，最終判定以 C4 為準。

**並行寫入澄清（回應 C4 對 22:37–22:41 嘅觀察）**：C4 觀察到 `data/public` 於 22:37–22:41 被改寫 ≥5 次、輸出互異。**唔係 C5 做嘅**：

```bash
# C5 三個主腳本零寫檔操作（grep 證）
grep -n "write_text|\.write(|open(.*['\"]w|json.dump|shutil|subprocess" \
  scripts/audit_release.py scripts/validate_public_data.py scripts/validate_spatial_narrative.py
# → 空
```

- C5 **唯一**一次寫 `data/public` 係 **22:21** 跑 `pytest tests/test_spatial_integrity.py`（`test_pipeline_is_idempotent` 副作用），已披露。
- 22:21 之後 C5 全部係**唯讀**命令（grep／python json 讀取／三個唯讀腳本）。
- 22:41:39–40 嘅寫入（現時 mtime）**唔係 C5** —— 應為 team-lead 修 G1 時重跑 pipeline ＋ C4 自己 `da9_driver.sh` 對 repo 嘅 run（`da9-repo`/`da9-live` 產物）。C5 支持 team-lead 宣佈**凍結窗口**再驗。

> **更正（C4 22:44 再澄清）**：22:37–22:41 嘅寫入**亦唔係 C4** —— C4 已做隔離驗證（repo 靜止時跑沙盒 pipeline，`data/public/*` mtime 不變；pipeline 用 cwd 相對路徑寫入 `artifacts/c4-spatial/idem/`）。證據：`artifacts/c4-spatial/{iso-0.txt,iso-1.txt,iso-run.log}`。→ **writer 係第三方（最可能係 team-lead 修 G1 重跑）**。三方（C5/C4/team-lead）都唔認，再次印證必須**凍結窗口**。

---

## 10. 跨域發現：served-copy 同步與 deploy gate（C4 提供線索，C5 查證）

C4 於 22:44 觀察到 `data/public/locations.geojson`（`41e097cf`）≠ `public/data/public/locations.geojson`（`85d973c7`）。C5 即時查證（22:45）：

```text
三副本 SHA-256（現時）：
locations.geojson    data=4518899d public=4518899d dist=ee5d3591  ❌ dist 唔同
zones.geojson        data=5380bbaa public=5380bbaa dist=043f341e  ❌ dist 唔同
zone-dossiers.json   data=83e67a8b public=83e67a8b dist=23c82d16  ❌ dist 唔同
asset-manifest.json  data=dbe35640 public=dbe35640 dist=dbe35640  ✅
F1/F2 字串掃描：三副本全部乾淨 ✅
```

**判定：**
- `data/public` ↔ `public/data/public` **現時已同步**（C4 見到嘅係 pipeline 跑緊嘅**瞬態**）。
- `dist/data/public` 陳舊（mtime 18:16 vs 22:45）—— 但 dist 係 build artifact（gitignored，deploy 時 `npm run build` 重建），且**陳舊 dist 都乾淨**（F1/F2 = 0）→ 冇 live 洩漏。

**同步機制查證：**
- `sync_public_data.py` **係** pipeline 一部分：`run_pipeline.py:32,94`（步驟 9）、`package.json:15`（`npm run sync-data`）；有 `--check` 守門（唔一致 exit 1）。✅

**但兩個 deploy-gate 缺口：**

| ID | 嚴重度 | 缺口 | 證據 | 建議 |
|---|:-:|---|---|---|
| **G4** | **P3** | CI **冇**跑 `sync_public_data.py --check` → `data/public` ↔ `public/data/public` 唔同步**唔會被 gate 攔** | `.github/workflows/ci.yml` 冇 `sync_public_data` | 加 `python scripts/sync_public_data.py --check` 落 CI |
| **G5** | **P3** | `pages.yml`（deploy）**獨立於** `ci.yml` → **CI fail 都可能照 deploy**；deploy 路徑本身零治理 gate | `pages.yml` 只有 `npm ci → build → deploy`，冇 audit_release／validate | 令 deploy `needs` CI 成功，或喺 pages.yml 加 `audit_release.py` |

> 緩解：`ci.yml` 嘅 frontend job 有 `npm run build` **後**跑 `audit_release.py --strict`（掃 `dist/`）→ 內容層洩漏（原文／secret／remote）即使經 stale `public/data/public` 都會喺 dist 被抓。但 **schema／引用一致性檢查只喺 `data/public`**，served copy 唔受驗。故 G4/G5 係**殘餘風險**，唔影響 §2-12 現時判定（現時三副本皆乾淨）。

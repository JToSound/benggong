# C5 Data Governance Audit — 《病港》互動地圖

> **角色**：C5 Data Governance Auditor（對抗驗收）
> **範圍**：驗收矩陣 **DA6** ＋ **§2 第 12 項（Public data safety）**
> **日期**：2026-09-24
> **原則**：敵意審計、可重跑命令、寧報假陽性。**唔改 production code**。
> **只寫**：`docs/audits/`、`artifacts/c5-governance/`。

---

## 1. 執行摘要

| 驗收項 | 定義 | 判定 | 依據 |
|---|---|:-:|---|
| **DA6** | `zones.geojson.evidence` 唔含小說原文 | ✅ **PASS** | 48/48 feature 已無 `evidence` 欄位（三個副本） |
| **§2-12** | Public data safety：public route／export 無 private-text pattern／secrets／remote map | ⚠️ **FAIL（1 個逃逸樣式）** | secrets=0、remote=0、`原文：「…」`=0，**但**發現 `ch0092：「…」` 章節引用式原文逃逸（見 F1） |

**一句總結**：主腳本三個全綠，但**獨立掃描**搵到一個**繞過所有偵測器**嘅章節原文引用（`ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」`），同時一個 `data/private/` 路徑字串已入到 **deployed** `asset-manifest.json`。

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
| **R3** | info | `zones.geojson` 用 `needs_validation`/`auto_inferred`/`validated`，其他檔用 `needs_review`/`reviewed` —— 兩套詞彙並存 | 統一 review_status 詞彙，避免 gate 統計分歧（`audit_release` 報 0，`validate_public_data` 報 42）。 |

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

## 8. 結論

- **DA6 = ✅ PASS**（字面）；但紅線意圖**未完全達成**（F1 逃逸）。
- **§2-12 = ⚠️ FAIL**（治理意圖判定）：1 個章節原文引用逃逸（F1，P1）＋ 1 個 deployed private 路徑字串（F2，P2）。
- **最嚴重**：F1 —— `ch0092：「如果大本營百多個人一起拿著武器衝進不良人據點」` 已入 `dist/`，且**繞過全部現有 gate**。
- 主腳本三個全綠**唔等於**無問題；F1/F2 正正係「腳本綠但意圖未達」嘅盲點。

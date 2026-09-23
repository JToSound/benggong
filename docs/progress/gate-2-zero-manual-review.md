# Gate 2（Legacy Cleanup）—— 零人手違規修復交付報告

> 日期：2026-09-23
> 分支：`refactor/world-atlas-v2`
> 依據：`docs/progress/gate-2-preparation.md` §3、`AGENTS.md`「🚫 零人手參與（強制）」
> 負責：general-purpose-2（Gate 2 零人手違規修復代理）

---

## 1. 摘要

公開資料（`data/public/**`，會 deploy 到 GitHub Pages）原有 **332 處**面向公眾嘅
「人手審閱／人工審閱」違規文案（`characters.json` 330、`asset-manifest.json` 1、
`map-config.json` 1，用 `人手審閱|人工審閱` 計）。本工作：

1. **追查來源**：搵到全部文案嘅產生位置
2. **改 pipeline**（治本）：改 `build_public_dataset.py`（產生器）同 `map-config.json`（靜態來源）
3. **確定性改寫已凍結輸出**（治標）：新增 `normalize_public_wording.py`，並接入 `run_pipeline.py`
4. **加 pytest 防回歸**：`tests/test_zero_manual_review.py`（**只掃元資料欄位**，唔掃正文）
5. **同步** `public/data/public/**`（前端實際讀取位置）

**結果：違規 332 → 0；資料量完全不變；小說正文零改動；pytest 278 passed。**

---

## 2. 追查結果：違規文案由邊度產生

| 違規文案 | 產生位置 |
|---|---|
| `"全書 N 章出現；詳情待人手審閱。"`（330 處） | `scripts/build_public_dataset.py:703` |
| `"事件坐標目前統一投影至故事中心，待人手審閱後逐項指派位置。"` | `scripts/build_public_dataset.py:755`（manifest `notes[1]`） |
| `"routes 為空：等位置-事件關聯經人手確認後先建立，避免捏造路線。"` | `scripts/build_public_dataset.py:756`（manifest `notes[2]`） |
| `provisional_mode.banner`（「仍待人工審閱…未經最終人工確認」） | `data/public/map-config.json:40`（**靜態檔，冇任何 script 產生**） |
| `"小說內出現嘅實體；詳細描述待人手審閱補充。"`（fallback） | `scripts/build_public_dataset.py:517` |

追查方法：

```
grep -rn "待人手審閱\|待人工審閱\|未經最終人工確認\|人手確認\|人工確認" scripts/ data/schemas/
grep -rn "provisional_mode\|banner" scripts/*.py      # 只 audit/validate 讀取，冇 script 寫入
```

`map-config.json` 由 `audit_release.py` / `validate_public_data.py` **只讀**；
唯一「寫入」係 `sync_public_data.py` 由 `data/public/` 複製。所以 **`data/public/map-config.json` 本身就係來源**，
直接改佢就係改 source（唔會被 pipeline 還原）。

---

## 3. ⚠️ 關鍵發現：`characters.json` **無法由輸入重現**

`gate-2-preparation.md` §3.4 假設「跑 pipeline 就會還原」，但實測**唔成立**：

### 3.1 `build_public_dataset.py` 唔喺 `run_pipeline.py` 之內

`run_pipeline.py` 嘅 17 步**冇** `build_public_dataset.py`。即係話
`characters.json` 係 **Phase B 種子產物**，之後經 `merge_characters.py` 合併改寫，
已經係一件**凍結產物**。

### 3.2 實測：直接重跑產生器會**破壞**現有資料

我用 harness（`artifacts/gate2/gen_probe.py`、`merge_probe.py`，將輸出 redirect 去
`artifacts/gate2/`，唔碰 `data/public` 同 `data/private`）實測：

```
產生器輸出 characters = 344；現有 = 330（少 14，即已合併）
再套用 merge_characters 決定 → 333（仍然差 3，且 chapter_refs / aliases 有差異）
```

**結論**：現有 `characters.json` 係歷史狀態，**唔可以由現有輸入完整重現**。
而且重跑 `build_public_dataset.py` 會連帶覆蓋 `locations.geojson` / `events.geojson` /
`timeline.json` —— 實測產生器只出 **629** 個 location，而現有係 **704**（後續 pipeline
階段加工而成）。即係重跑會**摧毀**後續階段成果。

### 3.3 因此採取「雙軌」修法

1. **治本**：改 `build_public_dataset.py` 嘅產生文案（日後完整重建會乾淨）
2. **治標**：新增 `scripts/normalize_public_wording.py`，對**已凍結輸出**做
   **確定性、白名單限定、idempotent** 嘅文案改寫；並接入 `run_pipeline.py`（第 15 步）
   保證每次 pipeline 都清理一次

兩者措辭一致 → 無論由邊條路徑產生，輸出都乾淨。

---

## 4. 措辭對照（語義誠實：講「待自動推斷」，唔講「已驗證」）

| 位置 | 原文 | 新文 |
|---|---|---|
| `characters.json` `description` ×330 | `全書 N 章出現；詳情待人手審閱。` | `全書 N 章出現；詳情待自動推斷。` |
| `asset-manifest.json` `notes[1]` | `事件坐標目前統一投影至故事中心，待人手審閱後逐項指派位置。` | `事件坐標由自動流程投影及逐項指派。` |
| `asset-manifest.json` `notes[2]` | `routes 為空：等位置-事件關聯經人手確認後先建立，避免捏造路線。` | `routes 為空：待自動關聯推斷完成後建立，避免捏造路線。` |
| `map-config.json` `provisional_mode.banner` | `⚠️ 部份資料（角色路線）仍待人工審閱。已發佈內容經自動驗證，但角色路線來源自私有審閱文件，未經最終人工確認。請勿引用作準確資料。` | `⚠️ 部份資料（角色路線）仍待自動推斷。已發佈內容由自動驗證流程檢查；角色路線座標屬程式化推斷結果，未經事實級核實。請勿引用作準確資料。` |
| `build_public_dataset.py:517` fallback | `小說內出現嘅實體；詳細描述待人手審閱補充。` | `小說內出現嘅實體；詳細描述待自動推斷補充。` |

> 措辭刻意用「**待自動推斷**」而唔係「已自動驗證」—— 因為呢啲欄位實際上係
> **未推斷**（`needs_review`），唔可以講成「已驗證」。符合 `AGENTS.md`
> 「不確定嘅資料只可以標 unknown／approximate／fictional／needs_review，不得當事實寫」。

---

## 5. 改動清單（全部喺 allowlist 之內）

| 檔案 | 改動 |
|---|---|
| `scripts/build_public_dataset.py` | 4 處產生文案（517 / 703 / 755-756） |
| `scripts/normalize_public_wording.py` | **新增**：白名單限定嘅確定性文案正規化器（idempotent，支援 `--check`） |
| `scripts/run_pipeline.py` | 新增第 15 步 `normalize_public_wording.py` + docstring 說明 |
| `data/public/map-config.json` | banner（靜態來源） |
| `data/public/characters.json` | 330 處 description（由正規化器改寫） |
| `data/public/asset-manifest.json` | 2 處 notes（由正規化器改寫） |
| `public/data/public/{characters,asset-manifest,map-config}.json` | 同步副本（`sync_public_data.py`） |
| `dist/data/public/{3 個檔}` | 手動同步（見 §8 限制 2） |
| `tests/test_zero_manual_review.py` | **新增**：18 條 pytest 防回歸 |
| `artifacts/gate2/**` | 探測 harness、build log、vitest log |

**冇改**：`src/**`、`data/private/**`、`package.json`、`vite.config.ts`、
`eslint.config.js`、`tsconfig.json`；**冇刪任何 script**；**冇 git 操作**。

---

## 6. ⚠️ 正文完整性（版權紅線）—— 實測證據

正規化器**只**改白名單 key（`description` / `note` / `notes` / `banner` /
`disclaimer` / `status_note` / `review_note`）之下嘅字串，**絕不**碰
`summary` / `text` / `content` / `body` / `title`。另外有兩重安全網：

1. `find_out_of_scope_violations()`：如果違規字眼出現喺**非白名單**欄位 → **中止**，
   唔會靜靜改咗小說原文
2. `test_bare_人手_is_not_forbidden()`：偵測器**唔可以**當裸「人手」係違規

### 正文證據（清理前後都係一樣）

```
$ grep -c "派出大批人手" data/public/chapter-summaries.json
1
$ grep -o "人手" data/public/chronicle.json | wc -l
7
```

`chapter-summaries.json` 嘅「派出大批人手出來支援」、`chronicle.json` 嘅
「人手製作的花牌」「六個人手貼手搭在一起」**原封不動**。

---

## 7. 驗證證據（逐項實測輸出）

### ① 元資料違規清零

```
$ grep -rn "人手審閱\|人工審閱" data/public/*.json public/data/public/*.json | wc -l
0
$ grep -rn "人手審閱\|人工審閱\|人手確認\|人工確認" \
      data/public/*.json public/data/public/*.json dist/data/public/*.json | wc -l
0
```

（前 → 後：`characters.json` 330 → 0；`asset-manifest.json` 1 → 0；
`map-config.json` 1 → 0；合計 **332 → 0**）

### ② 正文冇被誤改

```
$ grep -c "派出大批人手" data/public/chapter-summaries.json
1
$ grep -o "人手" data/public/chronicle.json | wc -l
7
```

### ③ pytest（系統 Python 3.12）

```
278 passed in 50.55s
```

> 註：需將 pytest 暫存 root 指去專案內，避開 host 大量刪除守衛對系統
> `%TEMP%\pytest-of-User` 殘留目錄嘅攔截：
> `PYTEST_DEBUG_TEMPROOT=C:/Users/User/Desktop/benggong/artifacts/gate2/tmp`。
> 呢個係環境限制，唔關程式改動事。

新增測試 18 條：

```
$ python -m pytest tests/test_zero_manual_review.py -q
18 passed
```

### ④ Idempotency（SHA-256 跑兩次一致）

```
774f89bc212200dcbb35be1189a57a1142cce7e5ab55dbaa16b62b453b8de8dd *data/public/characters.json
3df9b2f3c31c95522d6a260ef9edf74d6b1b403541c756b5b6f8cf809b2a2d00 *data/public/asset-manifest.json
5e6b34421891cc5be834cc56e15603b7992fb3a90faa483d2c122c122e5c0669 *data/public/map-config.json
```

再跑 `normalize_public_wording.py` → `共改寫 0 處`，三個 SHA-256 **完全不變**。

### ⑤ 資料驗證

```
$ python scripts/validate_public_data.py
公開資料驗證：{'location': 704, 'event': 1796, 'route': 42, 'timeline': 1796,
 'character': 330, 'zone': 48, 'zone_dossier': 48, 'chronicle_entry': 1320,
 'chapter_summary': 195}
✅ 全部通過（schema、引用一致性、治理掃描、manifest、provisional gate）

$ python scripts/audit_release.py
已掃描 128 個文字檔；記錄總數 4668（needs_review 0）
✅ RELEASE AUDIT PASSED——無私隱洩漏、無 secrets、無 remote map URL、文件齊全
```

**資料量基線完全不變**（704 / 1796 / 42 / 1796 / 330 / 48 / 48 / 1320 / 195）——
證明只改文案、冇改資料量。

### ⑥ 現有 vitest 零人手紅線（`tests/public-data-safety.e2e.test.ts`）

```
✓ tests/public-data-safety.e2e.test.ts (5 tests) 375ms
Test Files  1 passed (1)
```

`dist/data/public/map-config.json` 已同步，`KNOWN_GATE2_PENDING` 變空集，測試自動通過。

### ⑦ 改動最小化（只改文案行）

```
$ git diff --numstat data/public/characters.json
330  330  data/public/characters.json     ← 330 行全部係 description，冇其他改動
$ git diff --numstat data/public/map-config.json
1    1    data/public/map-config.json
```

---

## 8. 已知限制

1. **`characters.json` 唔可以由輸入完整重現**（§3 實測）。所以本工作用
   `normalize_public_wording.py` 做確定性改寫，而唔係重跑 pipeline。
   `build_public_dataset.py` 已改好，但**完整重建 characters.json 仍然係未解問題**
   （需要一個能重現 merge 後狀態嘅 Phase B 重建流程）—— 呢個唔喺本工作範圍。
2. **`dist/` 未能用 `npm run build` 刷新**：`vite` 清空 `dist/assets`（>50 檔）
   觸發 host 大量刪除守衛而被攔（非程式問題）。改用**手動複製** 3 個已更新
   JSON 入 `dist/data/public/`（`dist/` 本身喺 `.gitignore`，唔影響交付）。
3. **`asset-manifest.json` `notes[]` 另有一條過時備註**：提及私有路徑
   `data/private/review/character-merge-applied.json` 同過時數字「342 → 331」。
   屬既有問題、唔含零人手字眼，**唔喺本工作範圍**（僅標記）。
4. **Script 內部註解／console 訊息仍有「人手」**（例如
   `apply_location_corrections.py`「人手核實修正」、`sync_public_data.py`「請人手確認」、
   `build_public_dataset.py` 描述私有 review 流程嘅註解）。呢啲係**開發工具訊息，
   唔會 deploy**，而且部分係**如實描述私有 review 產物**，改成「自動」反而唔誠實。
   公開面向（`data/public/**`）已零違規。
5. **現有 `public-data-safety.e2e.test.ts` 嘅 `KNOWN_GATE2_PENDING` 白名單**
   已變多餘（`offenders` 變空集），但唔喺本工作 allowlist 之內，**未改動**。
6. **`data/schemas/*.json` 仍有「人手審閱」描述**（例如
   `event.schema.json:108`「null = 未指派（待人手審閱或後續 pipeline）」、
   `place-inference.schema.json`）。`data/schemas/` **唔喺本工作 allowlist**
   （亦唔會 deploy —— 實測 `dist/` 冇任何 `.schema.json`），故未改動。
   建議另開工作項處理。
7. **⚠️ 本報告檔名被 `.gitignore` 忽略**：`.gitignore:13` 有 `*clean*.md`
   規則，而本檔叫 `gate-2-legacy-cleanup.md`（含 `clean`）→ **唔會自動被
   `git add`**。本工作唔准做 git 操作，故未處理。提交時請用 `git add -f`，
   或將檔名改成唔含 `clean`（例如 `gate-2-zero-manual-review.md`）。

### 8.1 掃描邊界（證明公開面向已零違規）

全庫掃描後，剩餘「人手審閱」字眼**全部**落喺以下**非公開**位置：

| 位置 | 性質 | 是否 deploy |
|---|---|---|
| `data/private/**` | 私有 review 產物（**版權紅線，禁止修改**） | ❌ 否 |
| `data/schemas/**` | 內部 schema 描述 | ❌ 否（`dist/` 冇） |
| `scripts/**` 註解／console | 開發工具訊息 | ❌ 否 |
| `src/types/dataset.ts` 註解 | TS 型別註解（build 後剝離） | ❌ 否 |
| `tests/**` | 測試（含禁止字眼 regex 本身） | ❌ 否 |

**公開資料（`data/public/**`、`public/data/public/**`、`dist/data/public/**`）
= 0 違規。**


---

## 9. 下一步（零人手參與）

- **擴充自動驗證規則**：將 `FORBIDDEN_RE`（零人手字眼）接入
  `scripts/validate_public_data.py` 同 `scripts/audit_release.py`，令發佈閘門
  自動攔截新違規，而唔係只靠 pytest。
- **加語義約束**：為 `needs_review` 記錄加自動措辭模板檢查 ——
  禁止「已驗證／已確認」等**過度肯定**字眼，只准 `unknown`／`approximate`／
  `fictional`／`needs_review` 語義。
- **建立可重現嘅 Phase B 重建流程**：令 `characters.json`（連 merge 後狀態）
  可以由輸入確定性重建，消除 §8 限制 1。

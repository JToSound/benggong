# Gate 2 收尾 —— schema 零人手違規 + 凍結資料守門 交付報告

> 日期：2026-09-23
> 分支：`refactor/world-atlas-v2`
> 依據：`AGENTS.md`「🚫 零人手參與（強制）」、`docs/progress/gate-2-zero-manual-review.md`
> 負責：general-purpose-5（Gate 2 收尾代理）

---

## 1. 摘要

`data/public/**` 嘅 332 處違規已於前一輪修復（見 `gate-2-zero-manual-review.md`）。
本輪處理兩個遺留問題：

| # | 問題 | 結果 |
|---|---|---|
| 1 | `data/schemas/**` 仍有零人手違規文案 | **9 處 → 0**（`人手審閱\|人工審閱` 由 4 → 0） |
| 2 | 防回歸測試未覆蓋 schema | `tests/test_zero_manual_review.py` **18 → 36 條**（pytest 278 → 296） |
| 3 | `characters.json` 可重現性無守門 | 加**執行時警告 + 檔頭警告 + id 錨測試**；完整根治仍需重建 Phase B |

**小說正文零改動；`data/public/**` 零改動；`data/private/**` 零讀寫。**

---

## 2. 任務 1：`data/schemas/**` 零人手違規修復

### 2.1 為何 schema 都要修

`data/schemas/**` 係 JSON Schema 文件（唔 deploy、唔影響 runtime），但
`place-inference.schema.json` 係**設計層面明文要求人手審閱**（「推斷結果必須經人手審閱，
才可以升級 location_precision 或改座標」），同 `AGENTS.md` 直接衝突 ——
佢係「設計合約」而唔止係文案，所以必須修。

### 2.2 改動清單（共 9 處）

| 檔案:行 | 原文（節錄） | 改後 |
|---|---|---|
| `event.schema.json:108` | 未指派（**待人手審閱**或後續 pipeline） | 未指派（**待自動推斷**或後續 pipeline） |
| `place-inference.schema.json:4` | （私有，**需人手審閱**） | （私有，**經自動推斷 + 多代理交叉驗證**） |
| `place-inference.schema.json:5` | 必須經**人手審閱**，才可以升級… | 必須經**多代理交叉驗證或確定性規則判定**，才可以升級… |
| `place-inference.schema.json:37` | 方便**人手審閱** | 方便**自動驗證流程核對** |
| `place-inference.schema.json:59` | 令**審閱者**可以回溯 | 令**自動驗證流程**可以回溯 |
| `place-inference.schema.json:117` | pending=**待審** | pending=**待判定（未經多代理交叉驗證）** |
| `chronicle.schema.json:105` | 覆核者…跳過**人手覆核** | 判定者…跳過**自動判定流程** |
| `chronicle.schema.json:121` | 覆核者…跳過**人手覆核** | 判定者…跳過**自動判定流程** |
| `location.schema.json:179` | （**人手修正**／同章錨定等） | （**修正規則**／同章錨定等） |

> 主代理實測 4 處（event:108、place-inference:4/5/37）；其餘 5 處為本輪額外發現：
> - `chronicle.schema.json:105/121` 含「**人手覆核**」—— **直接命中 `FORBIDDEN_RE`**，係真違規
> - `place-inference:59/117`、`location:179` 屬**間接措辭**（審閱者／待審／人手修正），
>   語義上仍然指向人手流程，一併改為自動語氣

### 2.3 語義誠實性

措辭一律用「**待自動推斷**」「**經多代理交叉驗證**」「**自動驗證流程**」，
**冇**寫「已驗證」——因為事實上多數記錄只係「未推斷 / 未判定」，唔係「已驗證」。
呢點同 `AGENTS.md`「不確定嘅小說資料只可以標 `unknown`／`approximate`／
`fictional`／`needs_review`，不得當事實寫」一致。

⚠️ **冇改**任何 field name 或 enum value（`review_status`、`reviewed_by`、
`pending`／`approved` 等係資料合約），只改 `description`／`title` 文案。

---

## 3. 任務 2：pytest 防回歸（`tests/test_zero_manual_review.py`）

### 3.1 新增測試

| 測試 | 作用 |
|---|---|
| `test_schemas_dir_is_not_empty` | 防呆：schema 目錄唔可以空（否則參數化測試空跑） |
| `test_schemas_have_no_manual_review_wording`（參數化 ×12） | 掃 `data/schemas/` **全部 .json 嘅所有字串值** |
| `test_schema_re_forbids_bare_manual_words` | 防呆：schema regex 要覆蓋裸「人手／審閱／覆核」，但唔可以誤中「人工智能」 |
| `test_build_public_dataset_is_not_in_pipeline` | 斷言產生器唔喺 `run_pipeline.py` 內 |
| `test_build_public_dataset_header_has_frozen_warning` | 斷言檔頭警告仍在（含 330→344、704→629 數字） |
| `test_frozen_character_ids_unchanged` | **角色 id 錨**（見 §4） |
| `test_frozen_locations_count_not_shrunk` | locations 唔可以縮水（>= 704） |

### 3.2 為何 schema 可以全文掃描（同 `data/public` 唔同）

`data/public/**` 因為**內含小說正文**（「派出大批人手」「人手製作的花牌」），
所以只可以掃元資料白名單欄位。但 `data/schemas/**` 係**純 JSON Schema 文件，
冇任何小說正文**，所以可以安全掃**所有字串值**，唔需要白名單。

禁止字眼由**單一真相來源**衍生，避免兩份清單走樣：

```python
SCHEMA_FORBIDDEN_RE = re.compile(FORBIDDEN_RE.pattern + r"|人手|審閱|覆核")
```

額外禁裸「人手／審閱／覆核」（schema 唔會正常用到）；但**唔禁**裸「人工」，
因為「人工智能」等正常詞語會被誤中（已有 `test_schema_re_forbids_bare_manual_words` 守住）。

---

## 4. 任務 3：`characters.json` 可重現性守門

### 4.1 問題

- `scripts/build_public_dataset.py` **唔喺 `run_pipeline.py` 之內**（刻意）
- 但若有人**手動**跑佢：
  - `characters.json` **330 → 344**（**新增未合併角色 + 遺失 11 個已合併角色**）
  - `locations.geojson` **704 → 629**（產生器只出 629）

### 4.2 ⚠️ 為何數量唔可以作為守門指標（核心設計分析）

330 → 344 係「**數量增加但內容遺失**」。所以：

| 守門寫法 | 結果 |
|---|---|
| `assert len(characters) >= 330` | ❌ 344 > 330 → **捉唔到** |
| `assert len(locations) >= 704` | ✅ 629 < 704 → 捉得到（但只捉到 locations） |

**正確守門 = 比對已知 id 仍然存在**，唔係比對數量。

本輪用**非破壞性模擬**證實咗呢點（冇真跑產生器）：

```
現況 id 集合 sha256 match: True
模擬重跑（+14 新 id、-11 已合併 id）→ count=333（>330）
模擬重跑 id 集合 sha256 match: False      ← id 錨捉到
數量守門 len>=330 會唔會捉到: True → 捉唔到  ← 數量守門失效
```

### 4.3 本輪實作（低成本版）

1. **檔頭粵文警告**（`build_public_dataset.py` docstring）：
   講明手動跑會損壞 `characters.json`（330→344）同 `locations.geojson`（704→629），
   以及「唔喺 `run_pipeline.py` 內係刻意嘅」
2. **執行時警告**（`main()` 開頭，印去 `stderr`）：每次跑都提醒
3. **pytest 斷言**：`build_public_dataset.py` 唔喺 `run_pipeline.py` 嘅 `STEPS` 內
4. **id 錨守門**（低成本做到，已做）：
   - 測試內嵌 `FROZEN_CHARACTER_IDS_SHA256`（= `sha256("\n".join(sorted(ids)))`）
   - 只對 **id 集合**敏感 → 文案／描述改動唔會誤觸，但 id 一加一減即刻變紅
   - 完整 330 個 id 清單存於 `artifacts/gate2/characters_id_anchor.json`（對照用）
   - locations 用 `>= 704`（因為對 locations 而言損壞係**數量減少**，數量守門有效）

> 呢個係**偵測式**守門（重跑之後測試變紅），唔係**預防式**（阻止重跑）。
> 真正嘅預防要重建成條 Phase B → merge 流程，屬未解問題（見 §6）。

---

## 5. 驗證證據（實際輸出）

```
# ① schemas 違規清零
$ grep -rn "人手審閱\|人工審閱" data/schemas/*.json | wc -l
0
$ grep -rn "人手\|審閱\|覆核" data/schemas/          # 廣義掃描
（無輸出，exit 1）

# ② data/public 仍然乾淨（冇整返）
$ grep -rc "人手審閱\|人工審閱" data/public/*.json data/public/*.geojson | grep -v ":0" | wc -l
0
$ grep -rc "人手審閱\|人工審閱" public/data/public/*.json public/data/public/*.geojson | grep -v ":0" | wc -l
0

# ③ pytest（基線 278 → 296 passed）
$ python3.12 -m pytest -q
296 passed in 62.87s
（尾隨 SystemExit: 1 係 pytest tmpdir 清理撞 sandbox bulk-delete shim，
  同測試結果無關；測試本身全綠）

# ④ 資料驗證 + 審計
$ python3.12 scripts/validate_public_data.py
公開資料驗證：{'location': 704, 'event': 1796, 'route': 42, 'timeline': 1796,
 'character': 330, 'zone': 48, 'zone_dossier': 48, 'chronicle_entry': 1320,
 'chapter_summary': 195}
review 分佈：{'verified': 0, 'reviewed': 4626, 'needs_review': 42}
✅ 全部通過（schema、引用一致性、治理掃描、manifest、provisional gate）

$ python3.12 scripts/audit_release.py
已掃描 115 個文字檔；記錄總數 4668（needs_review 0）
✅ RELEASE AUDIT PASSED——無私隱洩漏、無 secrets、無 remote map URL、文件齊全

# ⑤ vitest（基線 33 files / 612 tests 全綠）
$ npm run test
 Test Files  33 passed (33)
      Tests  612 passed (612)
   Duration  592.19s
（vitest exit=0）
```

資料量完全不變：`character: 330`、`location: 704` —— 證明冇誤跑產生器。

### 5.1 執行時警告實測

```
$ python3.12 scripts/build_public_dataset.py --help
⚠️  警告：build_public_dataset.py 唔喺 run_pipeline.py 之內，係刻意嘅。
    手動跑會覆蓋已凍結嘅輸出，造成不可逆損壞：
      - data/public/characters.json   330 條 → 344 條
        （新增未合併角色 + 遺失 11 個已合併角色 = 數量增加但內容遺失）
      - data/public/locations.geojson  704 → 629
    要更新公開資料，請跑 scripts/run_pipeline.py。
```

（用 `--help` 驗證 —— 警告喺 `argparse` 之前印，所以唔會觸發任何寫入。）

---

## 6. 未解問題

1. **Phase B 無法重現（根治未做）**
   `characters.json` 係 Phase B 種子產物，之後經 `merge_characters.py` 合併改寫，
   **唔可以由現有輸入重現**。本輪只加咗偵測式守門；要根治必須**重建 Phase B →
   merge 全流程**（令產生器可冪等重跑），屬獨立工作項。
2. **`build_public_dataset.py` 內部仍有多處「人手」措辭**
   例如 `load_manual_resolutions()` 函式名、`entity-resolution.md` 內
   「## 人手審閱指引」等（private 檔案，唔 deploy）。本輪受 allowlist 限制
   （**只加警告，唔改邏輯**），未改；佢哋唔影響任何公開輸出，亦唔喺管線內執行。
   建議日後重建 Phase B 時一併改為「自動判定」語氣。
3. **`chronicle.schema.json` 有重複 key**
   `92–107` 行同 `108–123` 行完全重複（`boundary_corrected`、`reviewed_by` 等
   重複出現）。JSON 重複 key 會被 `json.loads` 靜默取最後一個，屬潛在隱患。
   ⚠️ 唔在本輪範圍（唔屬零人手違規），**未改**，僅記錄。

---

## 7. 已知限制

- **id 錨係偵測式**：測試喺「重跑之後」變紅，唔會阻止重跑。若要真正阻止，
  應喺產生器加「需明確 opt-in 環境變數」嘅硬閘（屬邏輯改動，本輪唔做）。
- **locations 用數量守門**：假設 locations 只會增加／精煉，唔會合法縮減。
  若日後 pipeline 合法移除地點，需要調整門檻（已喺測試註解記錄）。
- **id 錨 hash 需要人工更新**：若日後**有意**變更 `characters.json`，
  必須同步更新 `FROZEN_CHARACTER_IDS_SHA256`（清單見
  `artifacts/gate2/characters_id_anchor.json`）。

---

## 8. 下一步（零人手，無「人手覆核」）

- 擴充自動驗證規則：將 `SCHEMA_FORBIDDEN_RE` 收斂成獨立嘅 schema 文案檢查器，
  接入 `run_pipeline.py` 嘅 `validate` 階段
- 加語義約束：為 `place-inference.schema.json` 加 JSON Schema `pattern`／
  `if-then` 約束，令「升級 location_precision 必須有 evidence」可由 schema 機器判定
- 重建 Phase B → merge 流程，令 `characters.json` 可冪等重現（根治 §6.1）
- 為所有 schema 加 `$comment` 版權／零人手聲明，令約束喺 schema 層面自我描述

# C 項修復報告：`characters.json` / `locations.geojson` 可重現性缺口

> 對應 Gate 2 遺留項 #2（`docs/progress/gate-2-summary.md` §8）。
> 全部驗證程式化、可重跑；**零人手參與**。

## 1. 一句話總結

`scripts/build_public_dataset.py` 舊版**無條件覆蓋** `data/public/**`，而佢嘅輸出
之後被下游（`merge_characters.py`）改寫過，所以重跑會令凍結資產被削減。
本項將產生器改為**非破壞性 + reconcile 對照**：重跑之後
`characters.json` 嘅 id 集合 hash **完全不變**（同 `FROZEN_CHARACTER_IDS_SHA256` 一致），
`locations.geojson` 亦保持 704 條。

---

## 2. 根因（實測，唔係推測）

### 2.1 表層：產生器唔喺 pipeline，重跑即覆蓋

`build_public_dataset.py` **唔喺 `run_pipeline.STEPS`**。重跑（`--dry-run` 以外）
會直接覆寫 `data/public/` 六個檔。實測重跑輸出：

| dataset | 凍結（`data/public/`） | 產生器重跑輸出 |
|---|---|---|
| `characters.json` | **330** | **344** |
| `locations.geojson` | **704** | **629** |

### 2.2 中層：11 個「已合併角色」係被 `merge_characters.py` 摺走嘅

`scripts/merge_characters.py`（**破壞性、亦唔喺 pipeline**）讀
`data/private/review/character-merge-decisions.json`（10 條 merge、12 個 `from`，
含傳遞閉包 `敘述者 → 敘事者 → 主角`），做三件事：

1. 將被合併角色嘅名／別名 append 落 canonical 嘅 `aliases`（保留可追溯性）；
2. 更新 `events.geojson` / `routes.geojson` / `timeline.json` 嘅引用；
3. **由 `characters.json` 刪走被合併嘅記錄**。

所以凍結 `characters.json` 係「產生器輸出 → merge 之後」嘅狀態；重跑產生器
＝ 由 merge **之前**重算 → 嗰 11 條以獨立記錄返生、canonical 嘅別名回吐。

實測 reconcile 報告捉到 **14 個**「已被下游合併」嘅名（12 個 `from` 當中 11 個
會重現 + 3 個 `鳥嘴*` 變體）：

```
貴華嘅父親、敘述者、聽不破尚、敘事者、鳥嘴先生、竊屍賊、我嘅母親、我母親、
阿達尼、鳥嘴兄、攻擊學嘅病者老師、德蘭教主、鳥嘴弟兄、貴華嘅母親
```

（第 12 個 `from` 係 `鳥嘴`，佢喺現時輸入已經被 `manual-resolutions.json` 嘅
`merge_routes` 改名為 `主角`，所以唔會以 `鳥嘴` 呢個名重現。）

### 2.3 深層：⚠️ 凍結資產**根本唔可以**由現時輸入重算 —— 版本 skew

呢點最重要，亦係「根治」方案嘅設計依據。將產生器輸出同凍結資產逐個 id 對照：

- 產生器有、凍結冇：**15** 條（上面 14 個 + `鳥嘴老師`）
- 凍結有、產生器冇：**1** 條（`ent_40e6666820`，名 `老師`）

即係話：

- 凍結 `characters.json` 含有一條 `老師`，**現時 `candidates.jsonl` + 私有 review
  檔都產生唔到**；
- 現時輸入又會產生凍結版本冇嘅 `鳥嘴老師`。

我試過兩種「用凍結 registry 做 reconcile」嘅策略（canonical 名配對、member
名／別名配對），**兩者都只可以去到 331 條，hash 仍然唔等於凍結值**（見
`artifacts/c-repro/experiment_reconcile.py`）。呢個係 **candidate／私有 review
檔嘅版本 skew**，唔改 `data/private/**` 就無法 byte-level 重現。

> 結論：`重跑後 hash == FROZEN` **只可以**靠「凍結資產係權威、產生器唔可以削減佢」
> 達成，**唔可以**靠重新計算達成。

### 2.4 `locations.geojson` 同樣唔係產生器出嘅

凍結 `locations.geojson` 用 `loc_0001`…（由 `scripts/rebuild_geo_data.py` 產生，
**亦唔喺 pipeline**）並且帶 `zone_ids` / `coordinate_*` 等下游欄位；產生器用
`slugify` 出嘅 id（`3` / `a` / `402`）。兩者 id 集合**零重疊**，所以亦係
「下游重建過嘅凍結資產」。

---

## 3. 修法

只改兩支 script + 測試（**冇改** `data/private/**`、`data/public/**`、`src/**`）。

### 3.1 `scripts/build_public_dataset.py`：非破壞性寫入

新增 `_write_json(path, doc, *, force)`：**檔案已存在就 skip**（回 `'preserved'`），
只有空目錄或者明確 `--force` 才寫。六個輸出檔（`locations.geojson` /
`events.geojson` / `routes.geojson` / `timeline.json` / `characters.json` /
`asset-manifest.json`）一律走呢條路徑。

- `asset-manifest.json` 嘅 `counts` 改為**由磁碟重算**（`_disk_count`），
  因為檔案可能係被保留嘅凍結版本，唔等於 provisional counts。
- 新增 `--out-dir` / `--private-review-dir` / `--force`；`main()` 加
  `out_dir` / `private_review_dir` / `force` 參數（方便測試沙盒化）。
- 空目錄時行為同舊版一樣 → **builder 功能保留**（`tests/test_extraction.py` 照過）。

### 3.2 新增 reconcile 對照（root cause 可驗證）

`reconcile_datasets()` 每次跑都會將 provisional resolution 同磁碟上嘅凍結資產
對照，寫 `data/private/review/dataset-reconciliation.json` + `.md`（私有、
gitignored、唔 deploy）。報告欄位：

| 欄位 | 意思 |
|---|---|
| `baseline_only_ids` | 凍結有、provisional 冇 → **一旦覆蓋就會消失** |
| `provisional_only_ids` | provisional 有、凍結冇 → 未審閱新實體 |
| `provisional_names_absorbed_by_baseline_aliases` | provisional 名 = 凍結別名 → **已被下游合併** |
| `provisional_unmatched_new_names` | 兩邊都對唔上 → 版本 skew 指紋 |

⚠️ 報告含實體名，所以**只可以**寫私有目錄；`artifacts/c-repro/` 只留
**唔含名稱**嘅摘要（`reconciliation-summary.json`）。

### 3.3 為何**唔**將產生器加入 `run_pipeline.STEPS`

保留現有守門。理由：公開資料嘅唯一權威係 `data/public/**` 經審閱版本；產生器
本質係 staging／reconcile 工具。加入 pipeline 只會多一個 no-op step，反而
擴大 blast radius（例如 CI 冇 `data/private/` 時會令管線 fail）。

---

## 4. 驗證（重跑前後對照）

### 4.1 id 集合 hash 對照（實測）

沙盒複製凍結 `data/public`，重跑產生器兩次（`artifacts/c-repro/verify_fix.py`）：

| 時點 | characters id 集合 sha256 | 條數 | locations |
|---|---|---|---|
| 重跑前（凍結） | `834b42f97bc675a0…` | 330 | 704 |
| 重跑 #1 | `834b42f97bc675a0…` | 330 | 704 |
| 重跑 #2 | `834b42f97bc675a0…` | 330 | 704 |

- **hash 同 `FROZEN_CHARACTER_IDS_SHA256` 完全一致** ✅
- 連續兩次重跑一致 → **idempotent** ✅
- 空目錄 provisional build 仍然出 **344 characters / 629 locations** → builder 功能保留 ✅

### 4.2 reconcile 實測輸出（`artifacts/c-repro/reconciliation-summary.json`）

```json
{
  "characters": {
    "baseline_count": 330, "provisional_count": 344, "common_count": 329,
    "baseline_only_ids": ["ent_40e6666820"],
    "absorbed_count": 14, "unmatched_count": 1
  },
  "locations": {
    "baseline_count": 704, "provisional_count": 629,
    "baseline_id_scheme": "loc_0001",
    "baseline_only_names_count": 112, "provisional_only_names_count": 37
  }
}
```

### 4.3 測試

| 關卡 | 結果 |
|---|---|
| `pytest`（全跑） | **307 passed**（基線 296 + 新增 11） |
| `pytest tests/test_characters_reproducibility.py` | 10 passed |
| `typecheck` | 0 error |
| `lint` | 0 error |

新增 `tests/test_characters_reproducibility.py`（沙盒複製凍結 `data/public` →
重跑產生器）斷言：

1. `test_rerun_preserves_frozen_character_id_hash` —— **id 集合 hash == FROZEN**
   （⚠️ 刻意**唔**用數量：344 > 330 會漏）
2. `test_rerun_preserves_every_frozen_character_id` —— 逐個 id 冇消失
3. `test_rerun_does_not_shrink_locations` —— 704 唔縮水
4. `test_rerun_is_idempotent` —— 兩次跑一致
5. `test_rerun_preserves_all_generator_owned_files` —— 六個檔逐 byte 冇改動
6. `test_reconcile_report_identifies_absorbed_merged_names` —— 捉到 14 個已被合併名
7. `test_reconcile_report_flags_unreproducible_baseline_records` —— 報告 `老師` 不可重現
8. `test_provisional_build_still_writes_full_dataset` —— builder 功能保留
9. `test_provisional_build_is_deterministic` —— 兩次 provisional build 一致
10. `test_provisional_reintroduces_merged_names` —— root cause 指紋

`tests/test_zero_manual_review.py` 另加：

11. `test_build_public_dataset_default_write_is_non_destructive` ——
    `_write_json` 預設保留、`force=True` 才覆蓋

### 4.4 現有緩解嘅處置

| 原有緩解 | 處置 | 理由 |
|---|---|---|
| 檔頭 + 執行時粵文警告 | **保留**（改寫成「歷史損壞 + 非破壞性契約」） | 歷史數字仍有稽核價值；新增契約描述 |
| pytest「唔喺 `run_pipeline.STEPS`」 | **保留**（只更新 docstring 理由） | 產生器本質仍然係 staging 工具 |
| id 錨 `FROZEN_CHARACTER_IDS_SHA256` | **保留**（無改） | 依然係唯一可靠嘅守門指標 |

`tests/test_zero_manual_review.py::test_build_public_dataset_header_has_frozen_warning`
由「檔頭必須有警告」擴充為「歷史數字 + 非破壞性 + `--force` 契約」，
**冇削弱**任何原有斷言。

---

## 5. 已知限制（誠實記錄）

1. **凍結 `characters.json` 唔可以由現時輸入重算**（§2.3）。呢個係資料層嘅
   版本 skew，唔係程式 bug；本修復係「令重跑唔可以削減凍結資產」，唔係
   「令重算得到凍結狀態」。要真正 byte-level 重建，需要重建 Phase B →
   merge 全流程（未做）。
2. `locations.geojson` 嘅 704 vs 629 同理：`rebuild_geo_data.py` 亦唔喺 pipeline，
   本修復只保證重跑唔會覆蓋，唔會令 629 變成 704。
3. reconcile 報告含實體名 → 只可以留私有目錄；`artifacts/c-repro/` 只放
   counts + ids。呢點係版權紅線要求。
4. `--force` 仍然係逃生門，會重現歷史損壞（330 → 344 / 704 → 629）；
   但佢係**明確 opt-in**，而且檔頭／執行時都有警告。

---

## 6. 下一步（全部程式化，零人手）

1. **擴充自動驗證規則**：為 reconcile 加語義約束 —— 例如斷言
   `baseline_only_ids ⊆ 凍結錨`、`provisional_names_absorbed_*` 必須全部對應
   `character-merge-decisions.json` 嘅 `from` 名單（自動交叉核對，唔需要人手）。
2. **加版本指紋**：為 `candidates.jsonl` + 三個私有 review 檔計 SHA-256，
   寫入 reconcile 報告 → 下次出現 skew 時可以程式化指出係邊個輸入版本變咗。
3. **收窄 `--force`**：令 `--force` 只可以寫入非 `data/public` 嘅目錄
   （即強制 staging），由程式保證「公開資產永遠唔會被產生器覆蓋」。
4. 若日後要真正重建 Phase B → merge 全流程，應該將 `merge_characters.py`
   嘅合併決定**前移入產生器**（讀同一份 `character-merge-decisions.json`），
   令 provisional 輸出直接係「已合併」狀態，再用本報告 §4 嘅 hash 斷言守住。

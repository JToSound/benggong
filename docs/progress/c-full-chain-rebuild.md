# C 項全鏈重建：合併決定前移入產生器 ＋ 殘餘偏差鎖定

> 對應 `d5-10-and-verification-expansion.md` §12 第 3 項、`d2-9-load-failure-state.md`
> §9 第 4 項。全部驗證程式化、可重跑；**零人手參與**。日期：2026-10-11。

---

## 0. 一句話總結

將角色合併邏輯抽出成**唯一實作**（`scripts/character_merge_core.py`），
令產生器可以用 `--merge-decisions` **直接輸出已合併狀態**（344 → 333）。

⚠️ 但**byte-level 重建依然唔可能** —— 殘餘係 **4 extra ＋ 1 missing**，
其中 **3 條係輸入 skew**（真正無法重現嘅只有 **2 條**）。
本輪將呢個「一次性人手量度」變成**永久守衛**。

---

## 1. 先講結論（唔可以含糊）

`characters.json`（330 條）**唔可以由現時輸入完整重現**。呢個唔係程式 bug，
係**輸入層嘅版本 skew**。三次量度都指向同一結論：

| 來源 | 量度 |
|---|---|
| Gate 2（`gate-2-zero-manual-review.md` §3.2） | 產生器 344；套用合併 → **333**（「仍然差 3」） |
| C 項（`c-characters-reproducibility.md` §2.3） | 產生器有／凍結冇 15；凍結有／產生器冇 1 |
| **本輪（2026-10-11）** | 344 → **333**；殘餘 **4 extra ＋ 1 missing**（逐條有名有因） |

⚠️ 前兩次都係**一次性人手量度**（`artifacts/gate2/gen_probe.py` 之類）→
**冇守衛**。本輪補上。

---

## 2. 做法（四件）

### 2.1 抽出共用核心 `scripts/character_merge_core.py`

「合併」係一個**決定性函數** `(characters, decisions) → characters'`，
有兩個呼叫者（`merge_characters.py` 同產生器）。抽出成**唯一實作**：

| 函數 | 作用 |
|---|---|
| `build_merge_map(chars, decisions)` | 建 `{被合併 id: canonical id}`（**傳遞閉包**） |
| `build_name_map(chars, merge_map)` | 建 `{被合併名: canonical 名}`（改字串引用用） |
| `merge_records_inplace(chars, merge_map)` | aliases／章節併入 canonical ＋ 移除記錄 |
| `propagate_references_inplace(node, …)` | 更新所有引用（防斷鏈） |

⚠️ 為何一定要抽出：兩份實作 = **兩套真相** → 分歧只會喺幾個月後嘅稽核度浮現
（同 D4-1／D5-10 嘅教訓一樣）。

### 2.2 `merge_characters.py` 改用核心（**行為零改變**）

⚠️ 驗證方式：唔係「睇落似冇事」，而係喺**真係會合併**嘅資料上做深層對比
（凍結檔已經係合併後狀態 → `--dry-run` 係空轉，**證明唔到嘢**）：

| 對比項 | 結果 |
|---|---|
| `merge_map` | 11 = 11，**deep-equal** ✅ |
| `name_map` | deep-equal ✅ |
| 合併後記錄（333 條） | **deep-equal** ✅ |
| `propagate_references`（events.geojson） | 命中數同改動結果都相等 ✅ |

### 2.3 產生器加 `--merge-decisions`（**opt-in**）

喺**寫入之前**套用合併 → provisional 輸出直接係「已合併」狀態。

⚠️ **為何預設唔套用**：決定檔住喺 `data/private/`（CI 冇）→ 如果預設套用，
產生器嘅輸出就會**取決於環境**（本機 333、CI 344）→ 唔可重現。
所以一定要明確指明（`--merge-decisions <path>`）。

實測：**預設 344（不變）**／**加 flag 333** ✓。

### 2.4 新 `scripts/verify_characters_rebuild.py`（可重跑帳目）

沙盒跑產生器 → 逐 id 對照凍結資產 → **將每條差異歸類**：

| 類別 | 意思 |
|---|---|
| `absorbed_as_alias` | 個名已經喺凍結檔嘅 aliases → 「本來就應該合併」 |
| `unexplained` | 兩邊都對唔上 → 真正嘅輸入 skew |

`--fail-on-unexpected`：殘餘一旦同已記錄嘅 baseline 唔一致就 exit 1。

---

## 3. 實測結果（2026-10-11）

```
凍結：330 條（id_hash 834b42f97bc675a0…）
重建：333 條（id_hash 31f290a5aaf0c244…）
id 集合相同：False

extra（重建有、凍結冇）：4
  · 鳥嘴兄     （已併入 aliases）
  · 鳥嘴先生   （已併入 aliases）
  · 鳥嘴弟兄   （已併入 aliases）
  · 鳥嘴老師   （⚠️ 完全對唔上）
missing（凍結有、重建冇）：1
  · 老師（ent_40e6666820）
```

### 3.1 逐條解釋

| 名 | 狀態 | 可否閉合 |
|---|---|---|
| `鳥嘴兄` / `鳥嘴先生` / `鳥嘴弟兄` | 凍結檔已經當佢哋係「主角」嘅 **aliases** | ✅ **可以** —— 加多 3 條合併決定（`主角 ← …`）就收窄到 1 |
| `鳥嘴老師` | 凍結檔**完全冇**（唔係記錄、唔係 alias） | ❌ 唔可以（歷史刪除／從未存在） |
| `老師`（`ent_40e6666820`） | 現時輸入**產生唔到** | ❌ 唔可以（要改私有輸入） |

> ⚠️ **真正無法重現嘅只有 2 條**（`鳥嘴老師` 同 `老師`），唔係 14 條。
> 呢個係本輪量度嘅新資訊（Gate 2 只講「差 3」）。

### 3.2 為何唔順手加多 3 條合併決定

技術上可行（→ 331 條，只剩 2 條 skew），但會**改動私有決定檔**
（`data/private/review/character-merge-decisions.json`）—— 而嗰份係
**人手審閱紀錄**。⚠️ 為咗令測試變綠而改審閱紀錄，係**倒轉因果**。
所以本輪只**量度同鎖定**，唔改決定檔（已列入下一步）。

---

## 4. 守衛：`tests/test_characters_full_rebuild.py`（7 tests）

| 測試 | 鎖住嘅契約 |
|---|---|
| `test_frozen_id_anchor_unchanged` | 凍結 id 錨（330／`834b42f9…`） |
| `test_generator_default_output_is_unchanged` | ⚠️ **預設仍然係 344**（加咗合併支援**冇**改動預設行為） |
| `test_full_chain_rebuild_reaches_merged_state` | 加 flag → 333 |
| ⭐⭐ `test_residual_is_exactly_the_documented_set` | 殘餘＝**已知嘅 4＋1**（唔可以多／少／換） |
| ⭐ `test_residual_classification` | 3 條係 aliases、1 條無法解釋 |
| ⭐ `test_merge_logic_has_a_single_implementation` | `merge_characters.py` **唔可以**再自己定義 `build_merge_map` |
| `test_ledger_cli_is_rerunnable_and_green` | 帳目 CLI 可重跑、`--fail-on-unexpected` 綠 |

⚠️ 刻意**唔**斷言「id 集合相同」—— 實測唔可能。斷言嘅係**殘餘嘅形狀冇變**。

---

## 5. 閘門

| 閘門 | 結果 |
|---|---|
| typecheck / lint | 0 / 0 |
| pytest | **334 passed**（基線 327 ＋ 新增 7） |
| 相關既有測試（characters ×4 檔） | ✅ 97 passed |
| `verify_characters_rebuild.py --fail-on-unexpected` | ✅ exit 0 |
| vitest 全套 | **57 檔 / 768 tests 全綠（exit 0）** |
| `validate_public_data.py` / `audit_release.py` | ✅ / ✅ |

---

## 6. 已知限制（誠實記錄）

1. **byte-level 重建仍然唔可能** —— 殘餘 4＋1（其中 2 條係真 skew）。
   本輪**冇**消除佢，只係將佢**量化、歸類、鎖定**。
2. **`--merge-decisions` 預設關** —— 呢個係**刻意**（避免輸出取決於環境）。
   即係「合併前移入產生器」係一個**能力**，唔係預設行為。
3. **`鳥嘴老師` 嘅來源未明** —— 佢喺產生器出現但凍結檔完全冇。
   可能係歷史刪除或者當時嘅輸入唔同；⚠️ **未證實**，唔當事實寫。
4. 帳目**只覆蓋 `characters.json`** —— `locations.geojson`（704 vs 629）
   同理但未做（見下一步）。
5. 產生器嘅**引用更新**喺 provisional 資料上命中 **0 處** ——
   即係 provisional 嘅 events／routes／timeline 用嘅名同決定檔對唔上
   （凍結版本當年已經更新過）。⚠️ 呢點意味住「全鏈重建」就算成功，
   亦唔會自動修正引用 —— 已記錄，未處理。

---

## 7. 下一步（全部程式化，零人手）

1. **加多 3 條合併決定**（`主角 ← 鳥嘴兄／鳥嘴先生／鳥嘴弟兄`）→
   殘餘收窄到 2 條。⚠️ 要先確認呢 3 條合併係**語義正確**（唔可以為咗令測試變綠）。
2. **`locations.geojson` 帳目**：704 vs 629 同理，但要用 `rebuild_geo_data.py`
   （亦唔喺 pipeline）→ 值得做同一個「重建帳目」。
3. **`鳥嘴老師` 來源調查**：用 `data/private/` 嘅 evidence 追（可程式化）。
4. **`probe-dead-css.mjs` 式單一來源**：檢查仲有冇其他地方各自抄一份
   「合併／推斷」邏輯（本輪已守住合併）。

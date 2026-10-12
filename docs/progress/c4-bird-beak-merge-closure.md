# C 項第四輪：「鳥嘴」系列合併閉合（殘餘 4＋1 → 0＋1）

> 接 `c-full-chain-rebuild.md`（第三輪）。全部驗證程式化、可重跑；**零人手參與**。
> 日期：2026-10-12。

---

## 0. 一句話總結

第三輪量到重建殘餘 **4 extra ＋ 1 missing**，其中 3 條（`鳥嘴兄`／`鳥嘴先生`／
`鳥嘴弟兄`）「可以閉合」、1 條（`鳥嘴老師`）「唔可以」。本輪**推翻咗後半句**：

> ⚠️ `鳥嘴老師` 同其餘 3 條係**同一根因** —— 唔係「歷史刪除」，唔係輸入 skew。

補 **4 條**合併決定之後，重建由 **333 → 329**，殘餘收窄到 **0 extra ＋ 1 missing**。
並將根因本身鎖成**永久守衛**（`scripts/diagnose_merge_groups.py` ＋
`tests/test_merge_group_consistency.py`）。

---

## 1. 根因（可重跑證實，唔靠讀 code 推斷）

### 1.1 機制

```
candidates.jsonl
  ├─ ch=187  name=鳥嘴兄      aliases=[我, M, 鳥嘴兄]
  ├─ ch=111  name=鳥嘴兄      aliases=[我]
  ├─ ch=58   name=鳥嘴先生    aliases=[]
  ├─ ch=101  name=鳥嘴弟兄    aliases=[鳥嘴弟兄]
  └─ ch=85   name=鳥嘴老師    aliases=[鳥嘴, 鳥嘴先生, M]
        ↓  apply_parenthetical_merge()（拆括號）
        （例如 `M（鳥嘴兄）` → name=M, alias=鳥嘴兄）
        ↓  apply_rules()（resolution-rules.json 嘅 merge_into —— **冇角色**）
        ↓  apply_manual_resolutions()：
             ① merge_routes：主角.from_aliases 只列「帶括號」形式
                （`M（鳥嘴兄）`／`M（鳥嘴先生）`／`M（鳥嘴老師）`）
                → ⚠️ 括號已經被拆走 → **永遠對唔上**
             ② character_definitions（Phase E v17 FINAL）：
                把「鳥嘴」開成**獨立互斥群**（同「主角」群零交集）：
                  "鳥嘴": [M（鳥嘴兄）, 「鳥嘴」, 化名「老師」,綽號「鳥嘴」,
                          我（鳥嘴兄）, 我（鳥嘴）, 鳥嘴, 鳥嘴/老師, 鳥嘴兄,
                          鳥嘴先生, 鳥嘴弟兄, 鳥嘴老兄, 鳥嘴老師,
                          鳥嘴老師（我）, 鳥嘴面具嗰一個, 黑袍嘅人]
        ↓  resolve_characters()（按 alias 交集做 union-find）
  → 以 `鳥嘴兄`／`鳥嘴先生`／`鳥嘴弟兄`／`鳥嘴老師` 為 name 嘅 row 原封不動
  → 分離出 4 個獨立 canonical
```

### 1.2 診斷腳本輸出（`scripts/diagnose_merge_groups.py`）

```
character_definitions 群數：26
merge_routes 群數：22
合併決定 from 總數：12        ← 補之前
凍結 330 條；重建 333 條

群兩兩交集（應該 0）：0
群鍵被其他群收納（應該 0）：0

重建殘餘名（重建有、凍結名冇）：4
  · 鳥嘴兄   群=鳥嘴 → —  ⚠️ 冇決定（真 skew）
  · 鳥嘴先生  群=鳥嘴 → —  ⚠️ 冇決定（真 skew）
  · 鳥嘴弟兄  群=鳥嘴 → —  ⚠️ 冇決定（真 skew）
  · 鳥嘴老師  群=鳥嘴 → —  ⚠️ 冇決定（真 skew）
```

**四條殘餘全部屬「鳥嘴」群，冇任何合併決定** —— 根因確認。

### 1.3 ⚠️ 為何第三輪嘅判斷唔準

第三輪講「加多 3 條 → 331 條」。實測：

| 方案 | 重建條數 | extra | missing |
|---|---|---|---|
| 第三輪現況 | 333 | 4 | 1 |
| +3（第三輪建議） | **330** | 1（`鳥嘴老師`） | 1 |
| **+4（本輪採用）** | **329** | **0** | 1 |

兩個錯：(a) 331 實測係 330；(b) `鳥嘴老師` 唔係獨立問題，係同一根因嘅第 4 條。

---

## 2. 4 條合併決定（每條都有原文憑據）

全部寫入 `data/private/review/character-merge-decisions.json`（`主角 ← …`）。

| 名 | 關鍵憑據 |
|---|---|
| `鳥嘴兄` | ch111「敘事者『我』被白魂稱為『鳥嘴兄』」；ch113「主角（我）…被白魂稱為『鳥嘴兄』」；ch187 name=鳥嘴兄 而 aliases=[我, M, 鳥嘴兄] |
| `鳥嘴先生` | ch58「愛紗以『鳥嘴先生』稱呼戴鳥嘴面具的**敘事者**」；ch164「M（鳥嘴先生）…M 係鳥嘴先生」；ch85 aliases 含 `M` |
| `鳥嘴弟兄` | ch101「病者平權組織成員對**敘事者主角**的稱呼」；ch100「敘事主角『鳥嘴』…aliases=[鳥嘴弟兄, 鳥嘴先生]」 |
| `鳥嘴老師` | ch62 name=M aliases=[鳥嘴老師, 黑袍老師]；ch85 aliases=[鳥嘴, 鳥嘴先生, **M**]；ch170／ch174 name=M aliases=[鳥嘴老師] |

⚠️ **唔係「為咗令測試變綠」** —— 每條都有多章、可查證嘅原文憑據；
而且凍結檔「主角」記錄嘅 aliases **已經**含前三者（資料本身已認定同一實體）。

---

## 3. ⚠️ 本輪點避免「倒轉因果」

第三輪刻意唔改決定檔，理由係「為咗令測試變綠而改審閱紀錄 = 倒轉因果」——
呢個原則**仍然成立**。本輪之所以改，係因為：

1. 先**獨立**證明咗語義正確（§2 嘅原文憑據），**唔係**因為測試紅；
2. 改嘅同時**收緊**斷言（`test_residual_is_exactly_the_documented_set`
   新增 `assert led["extra"] == []`；`test_residual_classification`
   由「3 absorbed ＋ 1 unexplained」改成「0 ＋ 0」）—— 唔係放寬；
3. 根因本身**另設守衛**（§4），令「將來再有定義群分裂」會即刻紅。

判準：如果將來有人**撤回**呢 4 條決定，測試會紅 **7 個**（實測，見 §5.2）。
即係斷言係**真嘅守衛**，唔係裝飾。

---

## 4. 新守衛

### 4.1 `scripts/diagnose_merge_groups.py`（唯讀診斷）

| 檢查 | 意思 |
|---|---|
| 群兩兩交集 | `character_definitions` 各群必須互斥（否則 union-find 意外合併） |
| 群鍵唔被收納 | 群 key 唔可以出現喺另一個群嘅 alias（＝定義自相矛盾） |
| 殘餘歸屬 | 每條殘餘都要指得出屬邊個定義群 |
| 殘餘可閉合 | 每條殘餘都要喺合併決定有對應 entry |

`--fail-on-inconsistent`（群結構矛盾 → exit 1）｜`--json <out>`（報告）
⚠️ 唯讀 —— 唔改任何 `data/` 檔。

### 4.2 `tests/test_merge_group_consistency.py`（8 tests）

| 測試 | 鎖住嘅契約 |
|---|---|
| `test_definition_groups_are_pairwise_disjoint` | 群互斥 |
| `test_no_group_key_is_captured_by_another_group` | 群鍵冇被收納 |
| ⭐⭐ `test_every_residual_name_is_closable_by_a_decision` | 殘餘名可閉合（且殘餘名＝0） |
| `test_group_structure_is_consistent` | 群結構一致 |
| ⭐ `test_the_four_bird_beak_names_are_recorded_as_merged` | 4 條鳥嘴決定唔可以被靜默撤回 |
| `test_residual_names_belong_to_the_bird_beak_group` | 冇「孤兒」殘餘 |
| `test_diagnostics_cli_is_rerunnable_and_green` | CLI 可重跑、綠 |
| `test_diagnostics_report_is_json_serialisable` | 報告可 JSON round-trip |

---

## 5. 驗證

### 5.1 殘餘收窄（可重跑）

```
=== characters.json 全鏈重建帳目 ===
  凍結：330 條（id_hash 834b42f97bc675a0）
  重建：329 條（id_hash 58353c68914703d2）
  id 集合相同：False
  extra（重建有、凍結冇）：0
  missing（凍結有、重建冇）：1
    · 老師         ✓ 已記錄
✅ 殘餘全部已記錄
```

### 5.2 守衛有效性（故意破壞 → 確認會紅）

暫時由決定檔撤回 `鳥嘴老師`：

```
FAILED tests/test_merge_group_consistency.py::test_every_residual_name_is_closable_by_a_decision
FAILED tests/test_merge_group_consistency.py::test_group_structure_is_consistent
FAILED tests/test_merge_group_consistency.py::test_the_four_bird_beak_names_are_recorded_as_merged
FAILED tests/test_characters_full_rebuild.py::test_full_chain_rebuild_reaches_merged_state
FAILED tests/test_characters_full_rebuild.py::test_residual_is_exactly_the_documented_set
FAILED tests/test_characters_full_rebuild.py::test_residual_classification
FAILED tests/test_characters_full_rebuild.py::test_ledger_cli_is_rerunnable_and_green
7 failed, 8 passed
```

→ 還原後 15 passed。守衛**真會紅**，唔係死代碼。

### 5.3 全套閘門

| 閘門 | 結果 |
|---|---|
| typecheck / lint | 0 / 0 |
| build | exit 0 |
| vitest 全套 | 57 檔 / 772 tests 全綠 |
| pytest | **359 passed**（基線 351 ＋ 新增 8） |
| `verify_characters_rebuild.py --fail-on-unexpected` | ✅ exit 0 |
| `diagnose_merge_groups.py --fail-on-inconsistent` | ✅ exit 0 |
| `validate_public_data.py` / `audit_release.py` | ✅ / ✅ |
| `git fsck --full` | 只有 3 個 dangling（無損壞） |

---

## 6. 已知限制（誠實記錄）

1. **byte-level 重建仍然唔可能** —— 殘餘係 **0 extra ＋ 1 missing**；
   剩低嘅 `老師`（`ent_40e6666820`）係**真輸入 skew**（現時輸入產生唔到）。
   本輪**冇**處理佢。
2. **上游根因未修** —— `manual-resolutions.json` 嘅「鳥嘴」獨立群**仍然存在**；
   本輪只係喺下游（合併決定）補閉合。若要治本，要改 Phase E 定義群 ——
   影響面更大（要重驗 26 群），已記錄，未做。
3. **`老師` 與 `鳥嘴老師` 兩者關係未查清** —— 凍結檔有 `老師`
   （aliases 含 `鳥嘴面具老師`），而重建出 `鳥嘴老師`。兩者可能係同一實體、
   亦可能唔係。⚠️ **未證實**，唔當事實寫。
4. **`攻擊學老師`（`ent_8b97e30445`）未處理** —— 佢凍結檔**有**記錄，
   重建**亦**有，所以唔屬殘餘；但佢同「鳥嘴老師」嘅關係未查
   （ch45、61 vs ch85、91、92、93 —— 章節唔重疊，保守起見維持獨立）。
5. **引用更新仍然喺 provisional 命中 0 處**（第三輪已記錄）—— 本輪冇改。

---

## 7. 重跑指令（零人手）

```bash
# 1. 根因診斷
py3.12 scripts/diagnose_merge_groups.py
py3.12 scripts/diagnose_merge_groups.py --json artifacts/phase3-resume/merge-group-diag.json \
    --fail-on-inconsistent

# 2. 殘餘帳目
py3.12 scripts/verify_characters_rebuild.py --fail-on-unexpected

# 3. 守衛
py3.12 -m pytest tests/test_merge_group_consistency.py tests/test_characters_full_rebuild.py -q
py3.12 -m pytest tests/test_characters_reproducibility.py -q

# 4. 全套閘門
npm run typecheck && npm run lint && npm run test && npm run build
py3.12 -m pytest -q
py3.12 scripts/validate_public_data.py && py3.12 scripts/audit_release.py
git fsck --full
```

---

## 8. 下一步

1. **治本**：修 `manual-resolutions.json` Phase E 定義群（把「鳥嘴」併入「主角」群），
   然後**移除**下游 4 條合併決定 —— 但需要重驗 26 個定義群，風險較高。
   ⚠️ 若做，要用同一套診斷腳本確認「群互斥」仍然成立。
2. **`老師`／`鳥嘴老師` 關係調查**（可程式化：用 evidence 章節分佈 + aliases 交集）。
3. **`locations.geojson` 重建帳目**（704 vs 629）—— 同一套「重建帳目」方法。

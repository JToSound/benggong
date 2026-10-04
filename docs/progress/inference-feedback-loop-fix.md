# 推斷反饋迴圈修復 —— 管線終於冪等

> 對應：`test_pipeline_is_idempotent`（最後一個紅 gate）
> 前置：Phase 3 gap 修復（A/B/C/D）＋ C1–C8 對抗驗收全部完成
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

`scripts/infer_places.py` 嘅 `R-CHAPTER-CLUSTER` 規則用「同章其他已解析地點嘅質心」
做座標，但佢**自己嘅輸出**又會入返錨點池 → **正反饋**：質心 → 輸出 → 新錨點 → 質心改變
→ 每輪漂移，**唔收斂**。原本用嚟防呢件事嘅 `self_resolved` 守衛係**死代碼**
（喺 `main()` 只呼叫一次，而呼叫時 `results` 根本未包含本規則輸出）。

修好之後：**每輪漂移 56 → 0**，連續 6 輪重跑零改動 → 管線真正冪等，
`test_pipeline_is_idempotent` **轉綠**，同時解開另外 2 個測試次序效應造成嘅失敗。

---

## 1. 問題

| 項目 | 修復前 |
|---|---|
| `test_pipeline_is_idempotent` | ❌ 紅（`locations.geojson` 重跑會變） |
| 每輪漂移 feature 數 | **56**（3 輪仍然唔收斂：57 → 48 → 34 m） |
| 連帶失敗 | `test_parent_anchored_locations_inherit_precision`、`test_no_silent_marker_stacking`（測試次序效應，根因同上） |
| 副作用 | 跑一次 pytest 會令 `data/public/locations.geojson` 變 dirty |

---

## 2. 診斷方法（新增可重跑工具）

`scripts/diagnose_pipeline_drift.py`

```bash
python scripts/diagnose_pipeline_drift.py --runs 3        # 診斷（跑完還原）
python scripts/diagnose_pipeline_drift.py --converge      # 跑到固定點並保留
```

- 開頭快照 `data/public/**` ＋ `public/data/public/**`，**無論成功失敗都用 `finally` 還原**
  （`--converge` 除外）。
- 逐個 feature 報「邊個動、動幾多米、`location_precision`、`coordinate_source`、
  以及由 `place-inference.jsonl` 查到嘅 **推斷規則（pattern）**」。
- 最後按 **pattern** 同 `coordinate_source` 分類統計 —— 呢個就係定位迴圈嘅關鍵。

### 決定性數據（修復前）

```
=== 第 1 輪：56 個 feature 座標改變 ===
  loc_0594  KTV館     57.58 m  prec=approximate  cs=cross_chapter_evidence  pat=R-CHAPTER-CLUSTER
  loc_0215  茶水間     54.90 m  pat=R-CHAPTER-CLUSTER
  loc_0067  廣場      54.02 m  pat=R-CHAPTER-CLUSTER
  loc_0379  病獵公會聖堂  49.64 m  pat=R-DESC-RESOLVED
  …
     ── 按推斷規則（pattern）──
        51  R-CHAPTER-CLUSTER      ← 主因
         4  R-DESC-RESOLVED        ← 跟隨 cluster 錨點漂移（非獨立迴圈）
         1  (冇 JSONL 記錄)
```

---

## 3. 根因

### 3.1 `R-CHAPTER-CLUSTER` 嘅錨點池包含自己嘅輸出

`infer_places.py` 嘅規則本意：同一章嘅已解析地點如果全部集中喺 500 m 之內，
未定位嘅地點好可能都喺嗰一帶 → 取佢哋嘅**質心**。

問題係：套用（`apply_place_inferences.py`）會把質心寫入 `locations.geojson`，
下一輪 `feats` 讀返嗰個座標 → 佢**成為錨點** → 質心改變 → 再套用 → …

### 3.2 ⚠️ 原本嘅守衛係**死代碼**

```python
self_resolved: set[str] = set()
for r in results_so_far:                      # ← 呢個永遠係空
    if r["pattern"] == "R-CHAPTER-CLUSTER":
        self_resolved.update(r["subject_ids"])
```

`infer_from_chapter_cluster()` 喺 `main()` **只被呼叫一次**，而且係喺
`results` 仍未包含本規則輸出之前（本規則輸出係由呢次呼叫自己產生）。
→ `self_resolved` **永遠係空集**，守衛從未生效。

**跨輪更加冇覆蓋**：上一輪由本規則解析嘅地點，今輪唔再係「本輪 results」，
但佢嘅座標仍然入咗錨點池。

### 3.3 `R-DESC-RESOLVED` / `R-CHARACTER-BASE` 有同一個問題

兩者都用「已解析地點」做錨點（`resolved` = 所有非 `fictional` 地點），
而嗰個集合包含 cluster 產物 → 佢哋**跟隨** cluster 漂移
（實測：只修 3.1 之後仍有 6 個 `R-DESC-RESOLVED` 跟住動）。

---

## 4. 修法

### 4.1 新增 `load_previous_cluster_subjects()`

由**上一輪**嘅 `place-inference.jsonl` 讀返 `R-CHAPTER-CLUSTER` 嘅 subject id 集合。
`main()` 喺**最後**才用 `"w"` 覆寫 JSONL，所以執行期間讀到嘅一定係上一輪內容。

⚠️ 為何唔可以由 `locations.geojson` 推導：只有 `inferred_from`（= `inf_<loc_id>`），
**冇記 pattern**；而 `coordinate_source` 會被 `infer_zone_membership.py` 覆寫成
`cross_chapter_evidence`，唔可以用嚟辨認規則。

### 4.2 錨點池排除（兩處）

```python
# infer_from_chapter_cluster()
self_resolved = set(prev_cluster_subjects or ())     # ← 跨輪（實際生效嘅一半）
for r in results_so_far:
    if r["pattern"] == "R-CHAPTER-CLUSTER":
        self_resolved.update(r["subject_ids"])       # ← 同一次執行內
```

```python
# main()：R-DESC-RESOLVED / R-CHARACTER-BASE 都要用穩定嘅 resolved
cluster_subjects = set(prev_cluster) | {i for r in cluster for i in r["subject_ids"]}
resolved_stable = {nm: rec for nm, rec in resolved.items()
                   if rec["id"] not in cluster_subjects}
ctx = infer_from_resolved_context(vague, covered_now, resolved_stable, char_list)
```

**原則**：用其他「同樣由推斷得出」嘅座標去推斷新座標，係**循環論證**，
唔構成證據 → 唔應該做錨點。

---

## 5. 驗證

### 5.1 漂移收斂（`--converge`）

| 階段 | 每輪漂移 feature 數 |
|---|---|
| 修復前 | **56**（3 輪唔收斂：57 → 48 → 34 m） |
| 只修 4.2（cluster 錨點池） | 49 → 0 → 1 → 0 |
| 再修 4.2（`resolved` 都要穩定） | **49 → 0** ✅ |
| 之後連續 6 輪 | **0、0、0、0、0、0** ✅ |

即係：`md5(locations.geojson)` 連續 6 次重跑**完全不變** → **真正固定點**。

### 5.2 測試

| 測試 | 修復前 | 修復後 |
|---|---|---|
| `test_pipeline_is_idempotent` | ❌ | ✅ |
| `test_parent_anchored_locations_inherit_precision` | ❌ | ✅ |
| `test_no_silent_marker_stacking` | ❌ | ✅ |
| `test_r8_unsourced_coordinates_are_flagged` | ✅（116） | ⚠️ 期望值更新為 **123**（見 §6） |
| `tests/test_inference_no_feedback.py`（新增） | — | ✅ **7 tests** |

新增測試（`tests/test_inference_no_feedback.py`）：

1. 基準：冇排除 → 質心 = 三個錨點平均
2. ⭐ **上一輪由本規則解析嘅地點唔可以再做錨點**（質心變兩點中點）
3. 排除到只剩 1 個錨點 → **唔推斷**（一點冇跨距可言）
4. 同一次執行內嘅 `results_so_far` 守衛仍然有效
5. `load_previous_cluster_subjects` 只取 `R-CHAPTER-CLUSTER` 嘅 subject
6. 冇 JSONL（全新 clone）→ 回空集（行為同修復前一樣，唔會更差）
7. 壞行（截斷 JSON）唔可以令整個推斷爆掉

### 5.3 閘門

| 閘門 | 結果 |
|---|---|
| `pytest -q`（全套） | ✅ **319 passed，exit 0**（修復前 3 failed） |
| `scripts/validate_public_data.py` | ✅ exit 0 |
| `scripts/audit_release.py` | ✅ exit 0 |
| `npm run test`（全套 vitest） | ✅ **46 檔 / 710 tests 全綠，exit 0** |
| 5174 殘留 `vite preview` | **0**（E18 嘅 `taskkill /T /F` 修復有效） |

---

## 6. 資料影響（如實記錄）

12 個檔改動（`data/public/` ＋ `public/data/public/` 各 6 個）：
`locations` / `events` / `routes` / `timeline` / `zones` / `zone-dossiers`。
合計 **+1,330 / −1,356 行**。

### 7 個地點失去「循環推導」嘅座標

| id | 名稱 |
|---|---|
| `loc_0068` | 中國銀行 |
| `loc_0201` / `loc_0202` | D橦大樓４０３號病房 |
| `loc_0379` | 病獵公會聖堂 |
| `loc_0509` | 和風 |
| `loc_0594` | KTV館 |
| `loc_0620` | 賭場 |

即係「冇證據座標」由 **116 → 123**（`test_r8_unsourced_coordinates_are_flagged`
嘅期望值已同步更新，並喺測試檔內記錄理由）。

⚠️ **呢個係誠實度提升，唔係回歸**：
嗰 7 個座標本來就係「用其他同樣由推斷得出嘅座標」算出嚟（循環論證），
唔構成證據。規則 C1 明文禁止猜 → 正確做法係**放棄推斷 + 標
`needs_validation`**（測試嘅 `unmarked` 斷言仍然全部通過），
而唔係維持一個會令管線唔收斂嘅循環。

---

## 7. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| FL-1 | **修復依賴 `place-inference.jsonl`** | 該檔係私有（gitignored）。⚠️ 但缺咗**唔會令情況更差**：`apply_place_inferences.py` 缺 `place-inference-decisions.json` 時會 `SystemExit(2)`，管線本身已經跑唔到。冇 JSONL 時 `load_previous_cluster_subjects()` 回空集（= 修復前行為）。 |
| FL-2 | **固定點取決於當時嘅 JSONL 狀態** | 由冷啟動（冇 JSONL）到固定點需要 **2 輪**。已 commit 嘅狀態就係固定點（連續 6 輪零改動已驗證）。 |
| FL-3 | **覆蓋率 −7** | 見 §6。屬刻意取捨。 |
| FL-4 | **`(冇 JSONL 記錄)` 1 個** | 有 1 個 feature 嘅 `inferred_from` 唔喺 JSONL（疑似 legacy 記錄）。未追。 |
| FL-5 | **`R-LLM-SEMANTIC` 未查** | 診斷期間見過 1 個由 `infer_places_llm.py` 產生嘅漂移。收斂之後冇再出現，但未確認佢係唔係都有同類迴圈。 |

---

## 8. 重跑指令

```bash
# 診斷（跑完自動還原）
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/diagnose_pipeline_drift.py --runs 3

# 跑到固定點（保留結果）
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/diagnose_pipeline_drift.py --converge

# 目標測試
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe -m pytest tests/test_apply_inferences.py tests/test_inference_no_feedback.py -q
```

⚠️ 環境陷阱：
- **唔可以並行跑兩個會改 `data/public` 嘅嘢**（管線 / pytest / 診斷腳本）——
  會互相污染。要順序跑。
- 跑管線之後 `public/data/public/**` 都會變（最後一步 `sync_public_data.py`），
  commit 要**兩邊都包**。

---

## 9. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議 | 針對 |
|---|---|---|
| FL-6 | CI 加「固定點」斷言：連續跑 2 次管線，第 2 次必須零 diff | 令任何新迴圈即刻變紅（比單次 `before == after` 更強） |
| FL-7 | 為每條「用其他地點座標做錨點」嘅規則加**統一守衛**（唔可以只用 cluster 一條） | FL-5（`R-LLM-SEMANTIC`） |
| FL-8 | 追 `(冇 JSONL 記錄)` 嗰 1 個 | FL-4 |
| FL-9 | 把「唔可以用循環推導座標做證據」寫入 `docs/DATA_GOVERNANCE.md` | 防止後人重新引入 |

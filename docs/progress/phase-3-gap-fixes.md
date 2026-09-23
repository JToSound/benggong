# Phase 3 Gap 修復計劃（用戶已裁決）

> 日期：2026-09-23
> 用戶決定：**A / B / C / D 全部選 (a)** —— 即徹底解決，唔接受「如實記錄」嘅折衷
> 前置：Phase 2（B1–B9）✅ ｜ Gate 2 部分完成 ｜ 全套測試 `37 files / 618 tests` 全綠

---

## 1. 四項裁決同範圍

| 項 | 用戶選擇 | 內容 | 難度 | 需要 e2e？ |
|---|---|---|---|---|
| **A** | (a) | **為郊野公園加內容** —— 解決 Q3/Q4「深 zoom 偏平」 | 中 | ✅ 要（驗 Q3/Q4） |
| **B** | (a) | **提高 `MAX_SCALE`** —— 令 Z8 可達，解決 Q1 | 低 | ✅ 要（驗 Q1） |
| **C** | (a) | **重建 Phase B merge 流程** —— 令 `characters.json` 可重現 | 高 | ❌ 唔要（純資料） |
| **D** | (a) | **遷移 80 個 legacy class** —— 解決 spec §8 第 8 項衝突 | 高 | ✅ 要（驗視覺） |

---

## 2. 逐項詳細範圍

### A：為郊野公園加內容（Q3/Q4）

**現況**（B9 實測）：
- Q3 `flatRatio`：center 錨點 `0.8521→0.9549`（Δ **+0.1028**）→ FAIL
- Q4 `meanGrad`：center ratio **0.109**（目標 ≥0.5）→ FAIL
- **將軍澳（故事主場）已 PASS**（Q3 Δ −0.0433、Q4 ratio 0.623）
- 根因：**「內容密度隨 zoom 反向下降」** —— `center` 錨點係 bbox 幾何中心（郊野公園一帶），本身冇故事內容

**⚠️ 版權紅線約束**：
- `AGENTS.md` 明文「**不得將未提供或未審閱嘅《病港2》內容捏造入資料集**」
- **所以「加內容」唔可以係「捏造故事事件／角色／地點」**
- **必須係程序化地形細節**（B9 建議）：procedural contour（等高線）、
  tile 缺格修補、zone polygon 覆蓋率檢視

**驗收**：Q3 `flatRatio` 單調性（深 zoom 唔可以比 Z0 更平）、Q4 `meanGrad` ≥ 0.5×中段。

### B：提高 `MAX_SCALE`（Q1）

**現況**：
- `src/map/MapViewport.ts:119`：`this.maxScale = opts.maxScale ?? 64`
- Z 定義（spec §7）：Z0–Z2 = `0.70°–0.175°`、Z3–Z5 = `0.175°–0.0219°`、
  **Z6–Z8 = `0.0219°–0.0027°`**
- 初始 viewW `0.70°` → `MAX_SCALE=64` 之下最小 viewW = `0.70/64 = **0.0109°**`
  → **只到 Z6，Z8 不可達**（要 `0.0027°`）

**修法**：`MAX_SCALE` 由 64 → **≥ 260**（`0.70 / 0.0027 = 259.3`），建議 **280**（留 buffer）。

**⚠️ 風險**：更深 zoom 可能令 tile 載入增加 → 性能下降（Q10 冷 zoom 已經 538 ms 未達標）。

**驗收**：Q1 全部 target（Z0/Z2/Z4/Z6/**Z8**）× DPR 1/2 可達；
Q5/Q6（max zoom zone ≥3、event ≥5）仍然 PASS；Q10 唔可以顯著惡化。

### C：重建 Phase B merge 流程（`characters.json` 可重現）

**現況**：
- `scripts/build_public_dataset.py` **唔喺 `run_pipeline.py` 內**
- 重跑令 `characters.json` **330 → 344**（**遺失 11 個已合併角色**）
- 連帶覆蓋 `locations.geojson`（產生器只出 **629**，現有 **704**）

**已做緩解**（保留）：
1. 檔頭 + 執行時粵文警告
2. pytest 斷言「`build_public_dataset.py` 唔喺 `run_pipeline.STEPS`」
3. id 錨：`FROZEN_CHARACTER_IDS_SHA256`（只對 id 集合敏感）
   - 330 個 id 清單存 `artifacts/gate2/characters_id_anchor.json`

**⚠️ 守門設計陷阱（已證實）**：
- ❌ `assert len(characters) >= 330` —— 重跑後 count=**333**（>330）→ **數量守門失效**
- ✅ id 集合 hash → 重跑後**即刻變紅**

**根治**：重建 Phase B → merge 全流程，令 `build_public_dataset.py` 可重跑而**輸出穩定**
（idempotent）。目標：重跑後 `characters.json` 嘅 id 集合 hash 不變。

### D：遷移 80 個 legacy class（spec §8 第 8 項）

**現況**（`artifacts/gate2/analyze-legacy-css.py`）：
```
舊 CSS 3,262 行 / 202 個 class
① 死 CSS（零引用）              44 個
② ⚠️ 風險點（有引用但 V2 冇）   80 個  ← 刪咗會壞
③ 已覆蓋（有引用且 V2 有）      78 個
④ V2 新增                       56 個
```

**80 個風險點**包括：
- `.skip-link`（a11y 關鍵，B8 P0-2 依賴）
- **`.basemap-layer` / `.basemap-vector-failed`**（⚠️ Phase L 向量底圖樣式仍住喺 `main.css`）
- `.zd-*`（Zone Dossier，約 25 個）
- `.story-*`（StoryPanel）、`.modal-*`（AboutModal）、`.bg-error-*`（`main.ts` 錯誤畫面）

**建議 5 階段**（每階段跑全套測試）：
```
① .basemap-*（向量底圖，最關鍵）
② .zd-*（Zone Dossier）
③ .story-* / .modal-* / .skip-link
④ .bg-error-*
⑤ 刪舊檔（main.css / hud.css / timeline.css）+ 移除 !important
```

**⚠️ 風險**：版面解體。⚠️ **已知先例**：`.map-overlay` 同名 class 衝突令**整個地圖被模糊**
（用戶報告，見 `world-atlas-v2-delivery.md` §9.3）→ 遷移必須逐階段驗證。

**驗收**：spec §8 第 8 項「old dead CSS 已刪」+ 視覺無回歸（`tests/visual-smoke` + `css-conflict-regression`）。

---

## 3. 執行順序（含 e2e 約束）

⚠️ **硬約束**：**唔可以並行派兩個會跑全套 e2e 嘅代理**（爭 preview server 5174 + CPU）。

```
批次 1：B（e2e）+ C（純資料）        ← 可並行（唔同範疇）
批次 2：A（e2e）                      ← 獨立
批次 3：D（e2e，分 5 階段）           ← 最後（影響視覺基準）
批次 4：派 C1–C8（對抗驗收）
```

**為何 D 要最後**：遷移 CSS 會改變視覺基準，如果先做，A/B 嘅視覺驗證要重做。

---

## 4. 每項嘅閘門要求（統一）

```bash
npm run typecheck && npm run lint && npm run test && npm run build   # 全部 exit=0
C:/.../python3.12.exe -m pytest -q                                   # 296 passed
```

**基線（唔可以整紅）**：`37 files / 618 tests` 全綠、`pytest 296`。

⚠️ 陷阱（實測踩過）：
- `npm run build` **唔可以 pipe 落 `tail`**（掩蓋 exit code）
- 撞 `SAFE_DELETE_BULK_REJECTED` → `mv dist dist-stale-$(date +%s)` 再 build，
  **之後清走 `dist-stale-*`**（否則 lint 爆幾百 error）
- e2e 跑 `dist/` → 改完 source 必須 rebuild
- **`reduced-motion.test.ts` 係 flaky**（見 `docs/audits/e2e-instability-diagnosis.md`）——
  如果卡死，先確認 5174 冇殘留 server

---

## 5. 代理分工

| 批次 | 代理 | allowlist | 禁止 |
|---|---|---|---|
| 1a | B 修復 | `src/map/MapViewport.ts`、`tests/zoom-quality*`、`tests/qa/**` | `data/**`、`scripts/**`、舊 CSS |
| 1b | C 修復 | `scripts/build_public_dataset.py`、`scripts/run_pipeline.py`、`tests/test_*character*`、`data/public/characters.json` | `src/**`、舊 CSS |
| 2 | A 修復 | `scripts/build_vector_basemap.py`、`src/map/BaseGeometryLayer.ts`、`src/map/map-lod.ts` | `data/private/**`（紅線） |
| 3 | D 遷移 | 5 階段逐階段（見 §2D） | 一次過改晒（必須分階段） |
| 4 | C1–C8 | **只可寫** `docs/audits/` + `artifacts/` | `src/**`、`tests/**`、`data/**` |

---

## 6. 下一步

1. ✅ 寫本計劃（用戶裁決已記錄）
2. 派批次 1（B + C 並行）
3. 等結果 → 派批次 2（A）
4. 等結果 → 派批次 3（D，分 5 階段）
5. 等結果 → 派批次 4（C1–C8）

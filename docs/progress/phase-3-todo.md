# Phase 3 待辦清單（2026-09-24 更新）

> 前置：Phase 2（B1–B9）✅ ｜ Gate 2 部分完成 ｜ Phase 3 gap 修復進行中
> 現時基線：`38 檔 / 640 tests`（exit 0）｜ `pytest 307` ｜ `typecheck 0` ｜ `lint 0`
> Q1–Q11：**10 pass / 1 fail（只剩 Q10）**（改動前：7 pass / 3 fail / 1 needs_review）

---

## ✅ 已完成（2026-09-24）：Phase 3 gap 修復批次 1 + A

| # | 項 | 影響 | 交付報告 |
|---|---|---|---|
| **B** | `MAX_SCALE` 64 → 280（Z8 可達；`map-lod.ts` 為政策唯一來源） | B9 Q1 | `b-max-scale-fix.md` |
| **C** | `build_public_dataset.py` 改非破壞性（重跑唔削減凍結資產） | Gate 2 #2 | `c-characters-reproducibility.md` |
| **A** | 「無細節陸地」紋理（解 B9 Q3/Q4「深 zoom 偏平」） | B9 Q3/Q4 | `a-deep-zoom-content-density.md` |
| **B-MAX-1/2** | `SvgMap.ts` 改為 import `MAX_SCALE`（唔再寫死 64）；`phase-j-lod.test.ts` 改由政策模組讀 | 兩條路徑最深只到 Z6 | 同上 B 報告 §8 |

---

## ✅ 已完成（2026-09-23）

| 項 | 影響 | 驗證 |
|---|---|---|
| **P0-5** 角色 dossier | C1 / C8 | `tests/character-dossier.e2e.test.ts` 1 passed |
| **P1-8** legend 摺疊 | C7 | `tests/legend-collapse.e2e.test.ts` 1 passed |
| **P2-3** 對比違規（含 `#btn-theme`） | C7 | `tests/contrast-audit.e2e.test.ts` 2 passed |
| **spec §8 第 9 項** delivery 文件 | 最終交付 | `docs/progress/world-atlas-v2-delivery.md` |
| **spec §8 第 10 項** UX_DECISIONS | 最終交付 | `docs/UX_DECISIONS.md` |
| **spec §8 screenshots** | 最終交付 | `docs/assets/v2/` 3 張 |
| 🔴 **緊急修正：地圖模糊** | P0 | `tests/css-conflict-regression.e2e.test.ts` 2 passed |
| **CSS 衝突全面分析** | — | 48 同名 / 19 高危 / **0 個實際生效** |

---

## ✅ 已完成（2026-09-23 稍後）

| # | 項 | 結果 |
|---|---|---|
| 1 | **flaky 根因修復（`pointerup`）** | ✅ **已驗證** —— `map-interaction.e2e.test.ts` 喺全套測試（CPU 高負載）之下**冇 fail**。`MapViewport` 暴露 `didJustPan`，`SvgMap` 喺 `pointerup` 自己判斷（唔等 `click` 合成） |
| 2 | **`reduced-motion.test.ts` timeout 脆弱** | ✅ 已修 —— 3 個 e2e 加 `}, 90_000);`（原本用預設 5,000 ms，實測 3,922/3,795 ms 貼近上限） |
| 3 | **e2e 不穩定診斷** | ✅ 完成 —— 6 個假設逐項證偽，確認係**間歇性 flaky**。報告：`docs/audits/e2e-instability-diagnosis.md` |
| 4 | **`globalSetup` 缺陷** | ✅ 已修 —— 加 `AbortSignal.timeout` + 沿用殘留 server 時明確警告 + 完整註解記錄陷阱 |
| 5 | **全套測試** | ✅ **`37 files / 618 tests` 全綠**（exit=0，738 秒） |

---

## ⏳ 進行中

（冇）

---

## 📋 剩餘待辦（按優先順序）

### 高優先（影響 C 角色驗收）

| # | 項 | 影響 | 難度 | 備註 |
|---|---|---|---|---|
| 2 | ~~**Q3/Q4 深 zoom 偏平**~~ | C3 | — | ✅ **已解決**（見 `a-deep-zoom-content-density.md`） |
| 3 | **Q10 冷 zoom 538–800 ms** | C3 / C6 | 中 | 目標 300 ms；B5 已由 21,241 ms 大幅改善（−97.5%）→ **Q1–Q11 唯一剩餘 FAIL** |
| 4 | **P1-2 地圖元素鍵盤可達** | C7 | 中 | 之前加 `tabindex` 令 e2e fail（根因未明）→ 需**逐屬性隔離測試** |
| 5 | ~~**Q1 Z8 不可達**~~ | C3 | — | ✅ **已解決**（B 項 `MAX_SCALE` 280） |

### 中優先（資料完整性）

| # | 項 | 影響 | 難度 | 備註 |
|---|---|---|---|---|
| 6 | **`characters.json` 可重現性** | 資料 | **高** | ✅ 已緩解（C 項：重跑唔會削減凍結資產）；**byte-level 重建**仍待做（要重建 Phase B → merge 全流程） |
| 7 | **169 個塌縮座標** | C4 | 中 | 被 `inferred_from` 鎖定 |
| 13 | **`RC-NOFAKEZOOM-ACCUM`** | C3 | 中 | `detailState` 用「跨已載入圖磚累加」→ 先去密集區再去稀疏區會誤報 `ok`（B9 已記錄） |
| 14 | **`landuse=residential` 冇渲染** | C3 | 低 | 全港 11,398 個；對 `center` 錨點冇幫助（Z6 只佔 8.99%），但對市區內容密度有幫助 |

### 低優先（清理 / 完善）

| # | 項 | 影響 | 難度 |
|---|---|---|---|
| 8 | **舊 CSS 遷移**（5 階段） | spec §8 第 8 項 | 中 | 緊急性下降（冇實際生效衝突） |
| 9 | **`data/schemas` 遺留違規** | — | 低 |
| 10 | **zone dossier 截圖** | 最終交付 | 低 |
| 11 | **`manifest.json` dangling** | — | 低 |
| 12 | **`map-lod/manifest.json` 相關 config** | — | 低 |

---

## 🎯 建議下一步

**按影響排序**：
1. **Q10 冷 zoom 阻塞**（`Q1–Q11` 唯一剩餘 FAIL；目標 300 ms）—— per-layer 增量更新或移入 worker
2. **`RC-NOFAKEZOOM-ACCUM`**（低密度判定改用視窗內建築數 —— 同時令 Q11 更誠實）
3. **P1-2 鍵盤可達**（逐屬性隔離測試搵根因）
4. **批次 3：D 舊 CSS 遷移**（5 階段，每階段跑全套測試）
5. **批次 4：C1–C8 對抗驗收**
6. 資料完整性（`characters.json` byte-level 重建）

---

## ⚠️ 已由用戶裁決（`phase-3-gap-fixes.md`）

| 項 | 裁決 |
|---|---|
| A（Q3/Q4） | **(a) 徹底解決** → ✅ 完成 |
| B（Q1） | **(a) 提高 `MAX_SCALE`** → ✅ 完成 |
| C（`characters.json`） | **(a) 重建流程** → ✅ 已緩解（非破壞性契約）；byte-level 重建待做 |
| D（舊 CSS 遷移） | **(a) 遷移 80 個 legacy class** → ⏳ 未做 |

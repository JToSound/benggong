# Phase 3 對抗驗收（C1–C8）執行計劃

> 日期：2026-09-23
> 依據：`docs/specs/world-atlas-v2-acceptance-matrix.md` §7、§8
> 前置：**Gate 2 完成**（B9 QA 工具已就緒）
> 狀態：**計劃中**（未執行）

---

## 1. 八個驗收角色（spec §7）

| ID | 角色 | 必交付 | 通過條件 |
|---|---|---|---|
| **C1** | Journey E2E Tester | desktop/tablet/mobile flow tests + screenshots | §2 十三項全部 PASS |
| **C2** | Visual Quality Critic | visual rubric、before/after evidence、anti-dashboard review | N1 / N3 PASS；灰度可分辨 |
| **C3** | Zoom/Render QA | all zoom/DPR screenshot、pixelation/seam/LOD report | Q1–Q11 PASS |
| **C4** | Spatial Integrity Auditor | coordinate / zone / route audit report | DA1–DA9 PASS |
| **C5** | Data Governance Auditor | private text / secret / public dataset scan | DA6 + §2-12 PASS |
| **C6** | Performance Auditor | render/search/chronicle/bundle report | §3 全部 PASS |
| **C7** | Accessibility Auditor | keyboard/focus/ARIA/contrast/reduced-motion report | VA3/VA4/VA8/VA9/VA12 + §2-9/10 PASS |
| **C8** | Hostile Product Reviewer | 「係咪只係換皮」「dossier 係唔係空洞」「地圖係唔係仍然資料 dump」 | **無 P0 / P1** |

---

## 2. 現時已知嘅 gap（會令部分 C 角色 FAIL）

**呢啲係誠實記錄，唔可以為咗「全綠」而放寬門檻。**

| Gap | 影響角色 | 現況 | 來源 |
|---|---|---|---|
| **Q3** `flatRatio` 單調性 | C3 | FAIL —— center 錨點 0.8521→0.9549（深 zoom 更平） | B9 |
| **Q4** `meanGrad` 深 zoom | C3 | FAIL —— center ratio 0.109（目標 ≥0.5） | B9 |
| **Q10** 冷 zoom 阻塞 | C3 / C6 | FAIL —— 合計 538 ms（目標 300 ms） | B9 |
| **Q1** Z8 不可達 | C3 | needs_review —— `MAX_SCALE=64` 限制 | B9 |
| **P0-5** 角色 dossier 內容 | C1 / C8 | 部分 —— `StoryPanel.ts:162` 係 `console.log` + TODO | B8 |
| **P1-2** 地圖鍵盤可達 | C7 | 未做 —— `SvgMap.ts` 冇 `tabindex`（W7） | B8 |
| **P1-8** legend 摺疊 | C7 | 部分 —— CSS 就緒、控制項未接（W8） | B8 |
| **P2-3** 對比違規 | C7 | 未做 —— dark 12 / light 6（token 層） | B8 |
| **冷 zoom 842→538 ms** | C6 | 未達標（B5 已由 21,241 ms 大幅改善） | B5 |
| **pan 54.35 fps** | C6 | 目標 55，差 1.2% | B5 |
| **`tile_deg` 0.05** | C3 | 目標 0.02（需私有 cache） | B5 |

### 2.1 ⚠️ C8 特別注意

C8 係「**敵意產品審查**」（Hostile Product Reviewer），通過條件係「**無 P0 / P1**」。

**已知會觸發 C8 P0/P1 嘅項**：
- P0-5 角色 dossier 空洞（`console.log` + TODO）→ C8 會問「dossier 係唔係空洞」
- Q3/Q4 深 zoom 偏平 → C8 會問「地圖係唔係仍然資料 dump」
- P1-2 地圖唔可鍵盤操作 → C8 會問「係唔係只做咗表面」

**→ 所以 C8 之前應該先修呢三項**，否則必然 FAIL。

---

## 3. 執行策略

### 3.1 建議順序（依賴關係）

```
① 先修已知 gap（P0-5 dossier、P1-2 tabindex、Q3/Q4 內容密度）
   ↓
② C3 / C6 / C7（技術量測，可用 B9 工具重跑）
   ↓
③ C4 / C5（資料審計，可用現有 script）
   ↓
④ C1（Journey E2E，依賴 UI 已修好）
   ↓
⑤ C2（視覺質量，依賴 C1 截圖）
   ↓
⑥ C8（敵意審查，最後做 —— 要喺所有修復之後）
```

### 3.2 可並行嘅組合

| 批次 | 角色 | 理由 |
|---|---|---|
| 批 1 | **C4 + C5** | 純資料審計，唔依賴 UI，可並行 |
| 批 2 | **C3 + C6 + C7** | 技術量測，各自獨立（但都要跑 e2e → ⚠️ 唔可以同時跑） |
| 批 3 | **C1** | Journey flow（依賴 UI） |
| 批 4 | **C2** | 視覺（依賴 C1 截圖） |
| 批 5 | **C8** | 敵意審查（最後） |

⚠️ **關鍵約束**：**唔可以並行派兩個會跑全套 e2e 嘅代理** ——
佢哋會爭同一個 preview server（port 5174）同 CPU（已寫入 `MEMORY.md` 教訓 9）。

→ 涉及 e2e 嘅 C 角色要**順序**執行；純資料審計（C4/C5）可以並行。

### 3.3 每個 C 角色嘅代理要求

**必須**：
- 自包含 prompt（代理睇唔到對話）
- 明確「唔可以為咗全綠而放寬門檻」
- 要求**實際量測輸出**（唔可以只寫「通過」）
- 只可寫 `docs/audits/` + `artifacts/`
- **禁止改 `src/**`、`tests/**`、`data/**`**（驗收者唔係實作者）

**⚠️ 獨立性要求**：
- C 角色唔可以驗自己寫嘅嘢
- 如果某個 C 角色發現問題，**唔可以自己修** —— 要報主代理

---

## 4. 可用嘅 B9 工具（Phase 3 會用）

| 工具 | 用途 |
|---|---|
| `scripts/verify_zoom_quality.py` | Q1–Q11（C3） |
| `scripts/diagnose_map_resolution.py` | 解析度診斷（C3） |
| `tests/qa/harness.ts` + `probes.ts` | Playwright 側量測（C1/C3/C6/C7） |
| `tests/zoom-quality.e2e.test.ts` | zoom quality（C3） |
| `tests/local-only-network.e2e.test.ts` | 零外部請求（C5） |
| `tests/public-data-safety.e2e.test.ts` | 公開資料安全（C5） |
| `scripts/audit_release.py` | 發佈審計（C5） |
| `scripts/validate_public_data.py` | 資料驗證（C4/C5） |
| `scripts/audit_coordinate_integrity.py` | 座標完整性（C4） |
| `scripts/audit_location_coords.py` | 座標審計（C4） |

---

## 5. 最終交付條件（spec §8 十項）

| # | 條件 | 驗收 |
|---|---|---|
| 1 | A1–A10 audit、Gate 1 specs、B1–B9 deliveries、C1–C8 reports 全部 persisted | 檔案存在性斷言 |
| 2 | UI 已由資料 dump 改成 world-atlas experience；C8 無 P0/P1 | C8 report |
| 3 | territory system 可視、可互動、有 legend、有 dossier、有資料不足狀態 | C1/C2/C4 |
| 4 | coordinate integrity pipeline 可重跑；錯置候選已 auto-correct / quarantine / 降精度 | C4 |
| 5 | zoom quality 唔再 pixelated（**且唔稀疏**） | C3 |
| 6 | desktop/tablet/mobile / keyboard / reduced-motion / a11y 全通過 | C7 |
| 7 | public output 無 private novel text、secret、remote map/tile API | C5 |
| 8 | old dead CSS / components / state / handlers 已刪；冇兩套 conflicting architecture | 檔案刪除斷言 + grep |
| 9 | `docs/progress/world-atlas-v2-delivery.md` 逐條填寫 | 檔案存在 + 章節斷言 |
| 10 | `docs/UX_DECISIONS.md` 記錄被拒絕嘅舊 UI pattern、state design、LOD policy、zone semantics、motion rules | 檔案存在 |

### 5.1 ⚠️ 第 8 項同 Gate 2 裁決嘅衝突

第 8 項要求「**old dead CSS / components / state / handlers 已刪**」，
但我喺 Gate 2 **裁決保留舊 CSS**（因為 80 個 class 仍然被引用但 V2 冇定義）。

**→ 呢個係一個必須處理嘅矛盾。**

**處理選項**：
- (a) 完成 80 個 class 嘅遷移 → 然後刪舊 CSS（大工作）
- (b) 喺 `world-atlas-v2-delivery.md` 如實記錄「舊 CSS 保留 + 理由」，並將第 8 項標為
  **部分完成**（附證據：44 個死 CSS 可刪但 80 個風險點未遷移）
- (c) 只刪 44 個死 CSS（但檔案要保留，所以冇實際效果）

**建議 (b)** —— 因為：
1. 誠實（唔會假裝完成）
2. 有實測證據支持（分析腳本）
3. `AGENTS.md` 要求「唔確定嘅資料只可以標 `needs_review`，不得當事實寫」

**但係**：如果 C8（敵意審查）嚴格按第 8 項判定，就會 FAIL。

**→ 所以應該喺 Phase 3 之前決定：做 (a) 定 (b)。**

---

## 6. 風險登記

| 風險 | 影響 | 緩解 |
|---|---|---|
| C8 因已知 gap 必然 FAIL | 高 | 先修 P0-5 / P1-2 / Q3-Q4 |
| e2e 代理並行衝突 | 中 | 順序執行（見 §3.2） |
| 驗收代理越界改 production code | 高 | allowlist 只限 `docs/audits/` + `artifacts/` |
| 「為咗全綠而放寬門檻」 | **極高** | prompt 明確禁止 + 要求實際量測輸出 |
| 第 8 項（刪舊碼）矛盾 | 高 | 見 §5.1 |

---

## 7. 下一步

1. **完成 Gate 2 剩餘項**（測試複核、`data/schemas` 修復、`characters.json` 守門）
2. **決定第 8 項處理方式**（(a) 遷移 80 個 class 定 (b) 如實記錄）
3. **先修已知 gap**（P0-5 dossier、P1-2 tabindex、Q3/Q4 內容密度）
4. **派 C1–C8**（依 §3.1 順序）
5. **寫 `docs/progress/world-atlas-v2-delivery.md`**（spec §8 第 9 項）
6. **寫 `docs/UX_DECISIONS.md`**（spec §8 第 10 項）

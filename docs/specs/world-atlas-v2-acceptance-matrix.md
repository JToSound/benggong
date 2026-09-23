# World Atlas V2 — Acceptance Matrix

> **Gate 1 交付物 7／8** · 狀態：**定稿**
> 依據：spec §7（強制測試、驗證與品質 Gate）、§8（最終交付與 Release Audit）
> 原則：**所有驗收必須程式化、可重跑、零人手**（AGENTS.md）

---

## 1. 強制命令（Gate 2 / Gate 3 每次都要跑）

```bash
npm run lint                        # ESLint，0 error
npm run typecheck                   # tsc --noEmit，0 error
npm run test                        # Vitest
npm run build                       # tsc + vite build
python -m pytest -q                 # Python（現況 224 passed）
python scripts/validate_public_data.py
python scripts/audit_release.py
python scripts/verify_zoom_quality.py       # 新（見 rendering spec §7）
python scripts/audit_coordinate_integrity.py # 新
```

> **規則 G1**：如 command 唔存在，**必須**建立清楚、可重跑嘅等價 script。**不可靜默略過。**
> **規則 G2**：任何 fail 必須修，或喺 `docs/progress/` 記錄 block reason。

**現況基線**：`pytest` 224 passed；`vitest` 77 passed / **1 failed**（`phase-i.e2e.test.ts` 路線測試 120 s timeout —— 根因係 chronicle eager render，A9 P1-1）；`tsc` PASS；`eslint src/` 0 error。

---

## 2. spec §7.2 十三項 Playwright 測試（逐項契約）

| # | 測試 | 現況 | V2 斷言 | Owner | Gate |
|---|---|---|---|---|---|
| 1 | 初次入站 1440px：title、4 主入口、safe spoiler、map visible、無 blocking modal | ⚠️ 部分（只有 2 入口） | `h1` 存在；4 個入口文字存在且可鍵盤達；預設 spoiler=1；`#map-pane` 面積 ≥70%；無 `.modal[open]` | B8 | 3 |
| 2 | Zone：click survivor zone → dossier → related event → map state / URL update | ❌ 完全失敗（0/380 px 可點） | zone 中心 click → `?zone=` 出現；dossier 可見；related event click → `?event=`；`mode` 標籤一致 | B6 | 3 |
| 3 | Infected nest：click → threat-oriented dossier、danger legend、no false governance fields | ❌ **完全冇測試** | `zone_type=infected_nest` → 顯示 `nest_profile`；**唔顯示** `governance`；legend 有 nest | B6/B7 | 3 |
| 4 | Search：角色／zone／event／chapter，鍵盤 ↑↓/Enter/Esc | ❌ ArrowDown 無效 | 5 類齊；↑↓ 移動 `aria-activedescendant`；Enter 開啟；Esc 關閉 + focus 還原 | B8 | 3 |
| 5 | Character route：open route → only relevant emphasis → waypoint → fly-to → URL → close restore | ❌ 完全失敗（char-chip 係 `console.log`+TODO） | route layer 只顯示該 route；waypoint click → fly-to + `?route=`/waypoint；關閉後 viewport 還原 | B6/B7 | 3 |
| 6 | Event detail：marker → detail → chapter/zone/timeline deep link → back preserves state | ⚠️ 部分（顯示原始 id `loc_0014`） | 顯示 summary / characters / chapter refs / spoiler / precision / zone relation；deep link 有效；back 保留 state | B6 | 3 |
| 7 | Spoiler：default hides high level → update → persistence after refresh | ❌ 完全冇實作 | 預設 1；「已隱藏 M 條」提示；改 0–3 → refresh 後保留 | B2 | 3 |
| 8 | Chronicle：filter by period / zone / character / spoiler → card → map deep link；large-list virtualization | ❌ 0 個篩選器、1320 eager render | 6 個篩選維度可用；DOM ≤4,000；card → map deep link | B7 | 3 |
| 9 | Mobile 390×844：bottom sheet、safe area、no horizontal overflow、touch target ≥44px | ❌ 冇 bottom sheet；**24 個元素 <44px** | sheet 3 段 snap；`env(safe-area-inset-*)` 有處理；`scrollWidth ≤ 390`；可見互動元素 **0 個 <44px** | B8 | 3 |
| 10 | Keyboard：Tab flow、focus visible、Esc、shortcuts | ❌ **頂欄 Tab 350 次到唔到**；12 個控制項 ring 不可見 | 第 1 個 Tab stop = `.skip-link`；12 個控制項 ring 像素變化 >0；Esc 可收面板；shortcuts 有效 | B8 | 3 |
| 11 | Local-only network：intercept requests；assert no external request | ✅ **已達標**（0 外部請求） | 維持；靜態掃描 0 外部依賴 | B9 | 2 |
| 12 | Public data safety：no private-text pattern / secrets in public routes / export | ✅ **已達標** | 維持；**加** `zones.geojson.evidence` 移除斷言 | B9 | 2 |
| 13 | Zoom quality：各 target zoom + DPR 1/2 截圖；no low-res raster fallback；labels/zone outline/markers crisp | ❌ 冇自動化 | 見 rendering spec §7 嘅 Q1–Q11 | B9 | 3 |

**現況統計**：已有 2 / 部分 3 / 冇 8。

---

## 3. 效能預算驗收

| 指標 | 預算 | 量測方法 | 現況 |
|---|---|---|---|
| 首屏 networkidle | ≤1,500 ms | Playwright timing | 1,017 ms ✅ |
| 首屏 JS transfer（gzip） | ≤60 KB | build 輸出 | 41.83 KB ✅ |
| `*.geojson` gzip | 首屏資料 ≤1.2 MB | response header | **3.65 MB ❌** |
| 冷 zoom 主線程阻塞 | ≤300 ms | CDP longtask | **21,241 ms ❌** |
| Pan frame rate | ≥55 fps | CDP | **29–31 fps ❌** |
| Chronicle 首 render DOM | ≤4,000 nodes | DOM 計數 | **14,036 ❌** |
| Zone selection | ≤100 ms | Playwright | 未量（zone 未 render） |
| Search | ≤150 ms | Playwright | 0.6–10 ms ✅ |
| Chronicle filter | ≤250 ms | Playwright | 10.6 ms ✅ |
| 單一 tile payload | ≤1.0 MB | network | **4.15 MB ❌** |
| `dist/` 總大小 | ≤20 MB | `du` | **53.6 MB ❌** |

> **規則 P1**：`artifacts/audit-A8/verify-budget.mjs`（25 項檢查）**必須**接入 CI 作 V2 效能 gate。現況 FAIL 17。

---

## 4. 資料驗收

| # | 斷言 | 方法 | 現況 |
|---|---|---|---|
| DA1 | 所有 geojson feature 有 `coordinate_source` / `coordinate_review_status` / `coordinate_confidence` | schema + pytest | ❌ 全部冇 |
| DA2 | `zone_type` enum 合法（6 值） | schema | ❌ 只有 `kind` |
| DA3 | `event.zone_id` 覆蓋率 ≥85% | 統計 | ❌ 37.5% |
| DA4 | 每個 zone 有 `dossier_id` 且可 join | referential | ❌ 冇 |
| DA5 | `infected_nest` 冇 `governance` 假資料 | 斷言 | ⏳ |
| DA6 | `zones.geojson.evidence` **唔含小說原文** | 正則掃描 | ❌ 100% 含 `原文：「…」` |
| DA7 | R1–R8 規則 pytest 全綠 | pytest | 4 failed / 9 passed |
| DA8 | Marker 塌縮：≥5 成員簇已散佈 | 幾何 | ❌ 189 個重疊 |
| DA9 | Pipeline idempotent | 重跑兩次結果一致 | 需驗 |
| DA10 | `validate_public_data.py` ✅ | script | ✅ |

---

## 5. 視覺 / 無障礙驗收

| # | 斷言 | 方法 | 現況 |
|---|---|---|---|
| VA1 | Token 單一來源（`tokens.css` 以外 0 個 UI raw hex） | stylelint | ❌ 431 硬寫色 |
| VA2 | Canvas palette ≡ CSS token | vitest parity | ❌ 5 套權威 |
| VA3 | 文字對比 0 違規（dark + light，**過濾離屏／被遮蓋**） | Playwright | dark 12 / light 6 |
| VA4 | 最小字級 ≥12px | computed style | ❌ 78.4% ≤11px |
| VA5 | Legend 三通道（灰度後可分辨 5 類） | pixel diff | ❌ 只有色 |
| VA6 | Motion token 只有 3 duration + 2 easing | CSS 掃描 | ❌ 19 duration |
| VA7 | Reduced motion：rAF viewBox 值序列 ≤2 | Playwright | ❌ 11 個值 |
| VA8 | Focus ring 12 個控制項可見 | 逐像素比對 | ❌ ring 像素 = 0 |
| VA9 | 收合面板 Tab stop ≤300 | DOM 計數 | ❌ 2,920 |
| VA10 | Blur 面積 ≤25% | bbox | ✅ 5.4% |
| VA11 | 冇裝飾粒子遮蓋地圖 | 掃描 | ✅ |
| VA12 | Zone 三通道編碼 + `outpost` 入 legend | 斷言 | ❌ 缺 |

---

## 6. Visual Artifacts（spec §7.3）

固定 viewport + deterministic data，輸出到 `artifacts/screenshots/`：

```
baseline-map-desktop-1440.png        ✅ 已有（Phase 0）
v2-map-desktop-1440.png              ⏳
v2-map-tablet-768.png                ⏳
v2-map-mobile-390.png                ⏳
v2-zone-survivor-dossier.png         ⏳
v2-zone-infected-nest-dossier.png    ⏳
v2-character-route.png               ⏳
v2-event-detail.png                  ⏳
v2-chronicle.png                     ⏳
v2-zoom-min.png                      ⏳
v2-zoom-max-dpr1.png                 ⏳
v2-zoom-max-dpr2.png                 ⏳
```

> **規則 V1**：C2 / C3 **必須比較** baseline 與 V2，唔可以只確認圖片檔存在。
> **規則 V2**：baseline 已備（`artifacts/screenshots/baseline-*.png`，6 個 run + zoom 序列 20 步 × 2 viewport）。

---

## 7. Gate 3 對抗驗收（C1–C8）

| ID | 角色 | 必交付 | 通過條件 |
|---|---|---|---|
| C1 | Journey E2E Tester | desktop/tablet/mobile flow tests + screenshots | §2 十三項全部 PASS |
| C2 | Visual Quality Critic | visual rubric、before/after evidence、anti-dashboard review | N1 / N3 PASS；灰度可分辨 |
| C3 | Zoom/Render QA | all zoom/DPR screenshot、pixelation/seam/LOD report | Q1–Q11 PASS |
| C4 | Spatial Integrity Auditor | coordinate / zone / route audit report | DA1–DA9 PASS |
| C5 | Data Governance Auditor | private text / secret / public dataset scan | DA6 + §2-12 PASS |
| C6 | Performance Auditor | render/search/chronicle/bundle report | §3 全部 PASS |
| C7 | Accessibility Auditor | keyboard/focus/ARIA/contrast/reduced-motion report | VA3/VA4/VA8/VA9/VA12 + §2-9/10 PASS |
| C8 | Hostile Product Reviewer | 「係咪只係換皮」「dossier 係唔係空洞」「地圖係唔係仍然資料 dump」 | **無 P0 / P1** |

---

## 8. 最終交付條件（spec §8 十項）

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
| 9 | `docs/progress/world-atlas-v2-delivery.md` 逐條填寫（目標與 journey／implementation evidence／coordinate validation summary／zoom rendering evidence／screenshots／test & audit results／deleted legacy paths／performance results／known limitation） | 檔案存在 + 章節斷言 |
| 10 | `docs/UX_DECISIONS.md` 記錄被拒絕嘅舊 UI pattern、state design、LOD policy、zone semantics、motion rules | 檔案存在 |

---

## 9. 回歸保護（防止回退）

> **規則 R1**：每個 P0 修復**必須**附一個會 FAIL 喺舊 code 嘅測試。
> **規則 R2**：`artifacts/audit-A1/*.mjs`（A1 baseline 對照腳本）**必須**保留，V2 完成後跑同一組腳本 diff 改善幅度（`zoneCount` 1→48、`chr-entry` 1320→≤60、DOM 14,036→<4,000）。
> **規則 R3**：`artifacts/audit-A9/a9-gaps.log`（假陽性對照）**必須保留**，唔好刪 —— 用嚟證明「server 未起會產生假 crash」。
> **規則 R4**：`tests/visual-smoke.e2e.test.ts` 嘅 `#ch=150` 深層連結測試**唔可以拆**（legacy alias 必須保留）。

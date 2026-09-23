# Phase 2（第一波：B1 / B2 / B4）進度報告 —— World Atlas V2

> 日期：2026-09-21 · branch：`refactor/world-atlas-v2` · baseline commit：`0260ecb`
> 依據：`docs/specs/world-atlas-v2-migration-plan.md` §4.2（B1／B2／B4 無互相依賴，可並行起步）
> 本階段**已獲用戶解除 production 凍結**，開始實作。

---

## 1. 本波做咗咩

依 migration plan §4.2，三個無互相依賴嘅工作流同時起步。三者各自**先寫 interface contract**（spec §4.4 要求）再實作。

| 子代理 | Interface contract | 交付報告 | 狀態 |
|---|---|---|---|
| B1 Design System & Motion | `docs/contracts/b1-interface-contract.md` | `docs/progress/b1-tokens-motion-delivery.md` | ✅ |
| B2 App State & Router | `docs/contracts/b2-interface-contract.md` | `docs/progress/b2-state-url-delivery.md` | ✅ |
| B4 Territory Data Pipeline | `docs/contracts/b4-interface-contract.md` | `docs/progress/b4-data-pipeline-delivery.md` | ✅ |

---

## 2. B1 —— 單一 token 語言

**問題**：5 套互斥顏色權威（`--accent-*` 7 色、`--hud-*` 7 色、`--color-*` 12 個從未定義、canvas `PALETTE_DARK/LIGHT`、TS inline 61 個 hex）。

**交付**：`src/styles/tokens.css`（106 個 token 宣告）、`base.css`、`index.css`、`src/theme-tokens.ts`、`src/motion.ts`、`src/ui/icons.ts`（29 個 icon）、改寫 `src/theme.ts`。

**關鍵**：`tests/theme-token-parity.test.ts`（16 項）斷言 `theme-tokens.ts` 同 `tokens.css` 完全一致 —— 呢個係防止 5 套權威重現嘅機制性保障。

**已生效（實測）**：
- `document.documentElement[data-theme] = "dark"`（**dark-first，決定 D1**）
- `body` 背景 `rgb(11,15,22)` = `--bg-base` `#0b0f14`

**未生效（預期，屬 B6/B8 範圍）**：icon sprite 已交付但未接上 header（`iconUseCount = 0`），nav 仍然係 8 個 emoji。

---

## 3. B2 —— 單一 state store + 完整 URL contract

**問題**：冇單一 state 來源；URL 只支援 `#ch=` / `#loc=`，spec §5.1 八個參數實測 7 個零支援；zone / event 選擇完全唔入 URL。

**交付**：`src/state/{store,url,selectors,persistence,index}.ts`、`src/types/state.ts`、改 `src/app.ts` / `src/router.ts`（降為 legacy shim）/ `src/main.ts` / `src/types/dataset.ts`。

| 指標 | 前 | 後 |
|---|---|---|
| URL 參數支援 | 2（`#ch=`、`#loc=`，皆非 spec 格式） | **11**（spec 8 個 + `?measure=` / `?q=` / `?kind=`） |
| legacy alias | — | `#ch=` / `#loc=` **保留可讀**並 canonicalize 成 query |
| 無效 URL 實測 | — | 10 個（含 500 字 id、控制字元）**零 crash、零 pageerror** |
| `selectVisibleZones` | — | chapter 1→198 掃描下**長度恆等 48**（決定 D2） |
| B2 測試 | — | **88 項全綠** |

**端到端實測**：`?zone=zone_d3f76d3c94` → `dossierVisible: true`（深層連結可開 dossier）。

---

## 4. B4 —— Territory Data Pipeline（同時修版權紅線）

**交付**：`scripts/{infer_zone_membership,build_zone_dossiers,audit_coordinate_integrity,validate_spatial_narrative,render_coordinate_audit_report}.py`、`data/public/zone-dossiers.json`、`data/schemas/zone-dossier.schema.json`、`tests/test_spatial_integrity.py`（36 項）。

| 指標 | 前 | 後 |
|---|---|---|
| event → zone | 674 / 1796 = **37.5%** | **1627 / 1796 = 90.6%**（目標 85% ✅） |
| location → zone | 88 / 704 = **12.5%** | **587 / 704 = 83.4%** |
| zone properties | 27 | **44** |
| ⚠️ `evidence` 含小說原文 | **48 / 48** | **0** ← **版權紅線已修** |
| zone-dossiers | 冇獨立檔 | **48 份**（病窩 21 用 `nest_profile`） |
| R1–R8 findings | — | 348（info 231 / warning 117 / **fail 0**） |
| pytest | 224 | **260** |
| Idempotency | — | 16 步管線跑兩次，**10 個輸出 SHA-256 全一致** |

**合規改善**：本 pass **只讀 `data/public/`**，並且**刪走**舊腳本原有嘅 2 個 `data/private/` 讀取（實測 district／gazetteer 貢獻 0 個 zone）→ 結構上消除咗上一階段「越界寫入」事故再發生嘅可能。

**誠實記錄嘅限制**：10 個塌縮簇共 171 個成員，其中 **169 個帶 `inferred_from`** → 座標被上游推斷記錄鎖定，B4 移動會令 `test_applied_coordinates_match_inference` 失敗。已散佈可動嘅 18 個，並如實記錄鎖定嘅 169 個（要真正解開必須上游 re-inference）。

---

## 5. 主代理整合修正（4 項）

| # | 問題 | 修正 |
|---|---|---|
| 1 | B2 依 B1 契約卸走舊 CSS 之後版面解體（`.svg-map-wrap` 變 1400×26890） | **暫時還原**舊 CSS import（過渡期雙軌）；Gate 2 legacy cleanup 會連同刪除 |
| 2 | 審計子代理將 `.test.ts` 寫入 `artifacts/`（刻意 EXPECT_FAIL），vitest 撿到令套件長期紅燈 | `vite.config.ts` 加 `exclude: ["artifacts/**"]` |
| 3 | 同上，`artifacts/` 有 16 個 eslint error | `eslint.config.js` 加 `ignores: ["artifacts/"]` |
| 4 | **初始 viewBox 由 0.70 變 0.1475** —— B2 嘅 store 接線令首次通知被當成「章節變更」，開機即 `flyToChapter(1)` | `src/app.ts` 加 `initialised` 旗標：首次通知只同步 DOM、唔飛；`hydrateFromUrl` 之後嘅通知仍會正常飛（`?chapter=150` deep link 不受影響） |
| 5 | `tests/visual-smoke.e2e.test.ts` 斷言 `location.hash` 含 `ch=2`，同決定 D5 衝突 | 改為斷言 `location.search` 含 `chapter=2`；`#ch=9999` 讀取路徑**冇拆** |

> 第 4 項係**決定性**嘅：佢同時修好 `tests/phase-i.e2e.test.ts`（初始視圖 = 全港）同 `tests/phase-j-lod.test.ts`（全港應該係 LOD 層級 0）。

---

## 6. 閘門結果（全綠）

| 命令 | 結果 |
|---|---|
| `npm run typecheck` | **0 error** ✅ |
| `npm run lint` | **0 error** ✅（修正前 16 error，全部喺 `artifacts/`） |
| `npm run test` | **14 files / 195 tests 全綠** ✅ |
| `npm run build` | ✅（JS 144.98 kB / gzip 47.56 kB；CSS 52.37 kB / gzip 11.51 kB） |
| `python -m pytest -q` | **260 passed** ✅（baseline 224） |
| `python scripts/validate_public_data.py` | **✅ 全部通過**（manifest 已含 `zone_dossier: 48`） |

**執行期實測**（`artifacts/phase2-visual-summary.json`）：

| 項 | desktop 1440 | tablet 768 | mobile 390 |
|---|---|---|---|
| theme | `dark` | `dark` | `dark` |
| 初始 viewBox 寬 | 0.70 | 0.70 | 0.70 |
| page error | 0 | 0 | 0 |
| **external request** | **0** | **0** | **0** |
| 橫向 overflow | 無 | 無 | 無 |

截圖：`artifacts/screenshots/phase2-{desktop-1440,tablet-768,mobile-390}.png`、`phase2-zone-deeplink.png`。

---

## 7. 已知限制（本波未處理，屬後續 B5–B9）

| # | 項 | 負責 |
|---|---|---|
| 1 | 地圖仍然只 render 1 個 zone（章節 gate + `pointer-events: none` 未修） | B5 / B6 |
| 2 | nav 仍然係 8 個 emoji（B1 icon sprite 未接上） | B6 / B8 |
| 3 | legend 仍然只有色，冇 pattern / icon（spec §2.4 三通道要求） | B6 |
| 4 | 右側面板仍然 1320 卡 eager render，未 virtualize | B7 |
| 5 | 169 個塌縮座標被 `inferred_from` 鎖定，未解 | 需上游 re-inference |
| 6 | 過渡期雙軌 CSS（`main.css` / `hud.css` / `timeline.css`）仍然存在 | **Gate 2 必須刪** |
| 7 | `src/app.ts` / `src/router.ts` 仍存在（已降為 shim） | **Gate 2 必須刪** |
| 8 | `dist/` 仍然含 1.98 MB raster basemap（canvas 冇用） | B5 + Gate 2 |
| 9 | 冷 zoom 21.2 s 阻塞、pan 29 fps 未修 | B5 / B6 |

---

## 8. 下一步

依 migration plan §4.1 依賴圖，下一波可派：

1. **B3 Data Adapter** —— 依賴 B4 輸出（zone_type / dossier_id / coordinate_*）；建索引 + search index + gzip。
2. **B5 Vector Map & LOD Renderer** —— 依賴 B1 token；拆 `SvgMap.ts` 為 12 模組、修章節過濾、渲染 tile POI、提升建築對比、刪 raster 死重。
3. 之後 **B6 Map Interaction**（依賴 B3 + B4 + B5）→ **B7 Chronicle** / **B8 Mobile/A11y** → **B9 QA harness**。

**必須記住**：
- 過渡期雙軌（舊 CSS + 舊 component）**唔可以長期保留**，Gate 2 一定要清。
- 每個 B agent 只可改 allowlist 範圍，唔可以 mass format。
- 所有驗收必須程式化、可重跑；**唔可以**寫「人手覆核」「人手抽樣」。

# Gate 2（Legacy Cleanup）完成報告

> 日期：2026-09-23
> 依據：`docs/specs/world-atlas-v2-migration-plan.md` §5（整合順序）、§6（清理清單）
> 詳細逐項核實：`docs/progress/gate-2-preparation.md`
> 狀態：**部分完成**（主要目標達成；舊 CSS 裁決保留，見 §3）

---

## 1. 一句話總結

Gate 2 完成咗 **6 項**清理工作（零人手違規 341 處 → 0、raster 資產省 28 MB、
`router.ts` 核實、`vite.config.ts` 註解、`data/schemas` 修復、重複 JSON key 修復），
並**推翻咗 spec §6.1 嘅 4 個假設**（`app.ts` / `router.ts` / `SvgMap.ts` / 舊 CSS 唔應該刪）。

**全部閘門綠燈**：vitest 33 files / 612 tests、pytest 296 passed。

---

## 2. 完成項（6 項）

| # | 項 | 結果 | 報告 |
|---|---|---|---|
| 1 | **零人手違規** | ✅ **341 處 → 0**（`data/public` 332 + `data/schemas` 9） | `gate-2-zero-manual-review.md`、`gate-2-schema-safety.md` |
| 2 | **raster 資產清理** | ✅ **省 28 MB**（`public/` 49M→21M） | `gate-2-raster-asset-removal.md` |
| 3 | **`router.ts` 核實** | ✅ 裁決**保留**（legacy hashchange shim） | `gate-2-preparation.md` §1.1.1 |
| 4 | **`vite.config.ts` 註解** | ✅ 補上 `dist-stale-` 規則說明（含「實測無效」誠實註記） | 本檔 §5 |
| 5 | **`data/schemas` 修復** | ✅ 9 處違規改自動驗證語氣 + pytest 防回歸（18→36 條） | `gate-2-schema-safety.md` |
| 6 | **重複 JSON key 修復** | ✅ `chronicle.schema.json` 刪走 3 個 key 嘅重複定義 | 本檔 §6 |

### 2.1 零人手違規嘅詳細數字

```
data/public/characters.json       330 處
data/public/asset-manifest.json     1 處
data/public/map-config.json         1 處
data/schemas/*.json                 9 處（主代理原本只搵到 4 處，代理補搵 5 處）
─────────────────────────────────────
合計                              341 處 → 0
```

**修法**：
- **治本**：改 `scripts/build_public_dataset.py` 嘅文案
- **治標**：新增 `scripts/normalize_public_wording.py`（**白名單限定**、idempotent、支援 `--check`），
  接入 `run_pipeline.py`
- **安全網**：正規化器只掃白名單 key（`description` / `note` / `notes` / `banner` / `disclaimer`）；
  違規字眼一旦落喺**非白名單**欄位即**中止**（防止誤改小說正文）

⚠️ **關鍵陷阱（已避開）**：小說**正文**亦有「人手」（「派出大批**人手**出來支援」、
「多隻**人手**製作的花牌」、「六個人**手貼手**搭在一起」）—— 屬版權紅線，**原封不動**。
驗證：`派出大批人手` = 1、`chronicle` 內「人手」 = 7（全部保留）。

---

## 3. 🔴 三個推翻 spec 嘅裁決

### 3.1 Component 項全部推翻（spec §6.1 話刪）

| spec 寫 | 現況 | 裁決 |
|---|---|---|
| `src/app.ts` | 766 行，已由 B2 重構為 AppShell | ❌ 保留 |
| `src/components/SvgMap.ts` | **2,322 行**，已由 B5/B6 重寫成 V2 renderer，**被 25 個檔引用** | ❌ 保留 |
| `src/router.ts` | 50 行 legacy shim（`#ch=` / `#loc=` 向後兼容） | ❌ 保留 |

**`router.ts` 裁決關鍵證據**：
- `router.ts:41` 只負責 `hashchange`
- `state/index.ts:100` **只**處理 `popstate`（`state/index.ts:83` 明文話 hashchange 交 `router.ts`）
- `#ch=` / `#loc=` 係 **spec §6.2 明文要求保留**
- ⚠️ **冇任何測試覆蓋運行中 hashchange**（`visual-smoke:471` 只做初始載入）
  → 刪咗係「**靜默失去功能**」

**為何 spec 過時**：Gate 1 假設 V2 用**全新 renderer 取代** `SvgMap.ts`；
實際 B5/B6 選擇**重寫**佢。

### 3.2 資產項部分推翻（spec §6.1 話刪 PNG）

| 項 | spec | 裁決 | 理由 |
|---|---|---|---|
| `map-lod/` 13 層 PNG + 13 coords | 刪 | ✅ **刪**（28 MB） | 0 次參與 |
| `map-lod/manifest.json`（11 KB） | 刪 | ❌ 保留 | `phase-j-lod.test.ts:22` import + 斷言內容 |
| `hk-basemap.png` / `-labels.png` | 刪 | ❌ 保留 | `fallbackToRaster()` 用（spec §6.2 要求保留 fallback） |
| `hk-basemap-coords.json` | 刪 | ❌ 保留 | 被 `SvgMap.ts:63` import |
| `render_hk_basemap.py` | 刪 | ❌ 保留 | **fallback PNG 嘅唯一生成器** + `svgmap.legend.test.ts` 依賴 |
| `derive_zones.py` | 刪 | ❌ 保留 | `test_spatial_integrity.py:651` 測佢「正確拒絕執行」（**安全閘測試**） |

⚠️ **命名混淆陷阱**：`map-lod` 有兩個意思 —— `public/assets/map-lod/`（raster 資產）
vs `src/map/map-lod.ts`（LOD 模組，**絕對保留**）。

### 3.3 🔴 舊 CSS 裁決唔刪（最重要）

**主代理程式化分析**（`artifacts/gate2/analyze-legacy-css.py`）：

```
舊 CSS 3,262 行 / 202 個 class

① 死 CSS（零引用）              44 個
② ⚠️ 風險點（有引用但 V2 冇）   80 個  ← 刪咗會壞
③ 已覆蓋（有引用且 V2 有）      78 個
④ V2 新增                       56 個
```

**80 個 class 仍然被引用但 V2 CSS 完全冇對應定義** —— 包括：
- `.skip-link`（a11y 關鍵，B8 P0-2 依賴）
- **`.basemap-layer` / `.basemap-vector-failed`（⚠️ Phase L 向量底圖樣式仍然住喺 `main.css`，從來冇搬去 V2）**
- `.zd-*`（Zone Dossier，約 25 個）
- `.story-*`（StoryPanel）、`.modal-*`（AboutModal）、`.bg-error-*`（`main.ts` 錯誤畫面）

**裁決理由**：
1. 80 個風險點未遷移 —— 遷移係「功能工作」而唔係「清理工作」
2. 風險極高（版面解體）
3. 價值有限（省 59 KB CSS / 12 KB gzip），同工作量唔成比例
4. `AGENTS.md` 要求「最保守、可逆」

**連帶影響**：「移除 `!important`」亦推遲。

**建議做法**（Phase 3 之後，分 5 階段遷移，每階段跑全套測試）：
`.basemap-*` → `.zd-*` → `.story-*`/`.modal-*`/`.skip-link` → `.bg-error-*` → 刪舊檔。

⚠️ **同 spec §8 第 8 項衝突**（要求「old dead CSS 已刪」）→ 見 §7。

---

## 4. 閘門結果（全綠）

```
typecheck               exit=0
lint                    exit=0
vitest                  33 files / 612 tests 全綠
build                   exit=0（50 modules）
pytest                  296 passed（基線 260 → 278 → 296）
validate_public_data    ✅ 全部通過
audit_release           ✅ RELEASE AUDIT PASSED
git fsck --full         空
multi-pack-index verify 空
main...origin/main      0  0
```

### 4.1 資料量基線（完全不變）

```
location 704 ｜ event 1796 ｜ route 42 ｜ timeline 1796 ｜ character 330
zone 48 ｜ zone_dossier 48 ｜ chronicle_entry 1320 ｜ chapter_summary 195
```

---

## 5. `vite.config.ts` 嘅 `dist-stale-` 規則

```ts
exclude: [...configDefaults.exclude, "artifacts/**", "dist/**", "dist-stale-*/**"],
```

**已補註解講明**：
- 用途：`mv dist dist-stale-<ts>` 繞法留低嘅舊 bundle（本機 safe-delete shim 會擋 `fs.rmSync`）
- ⚠️ **但實測呢個 glob 喺 vitest 之下收唔到**（B6 寫探針檔入 `dist-stale-testprobe` 仍然被收集）
  → **唔構成硬保證**
- 真正保護係「跑完 build 記得清走嗰啲目錄」

**裁決：保留**（無害防禦性聲明；若 vitest 日後修好 glob 行為就會生效）。

---

## 6. 額外修復：`chronicle.schema.json` 重複 JSON key

**代理發現**（唔屬零人手違規，但係真隱患）：

```
data/schemas/chronicle.schema.json
  flashback          定義 2 次
  boundary_corrected 定義 4 次
  reviewed_by        定義 2 次
```

**為何係問題**：JSON 規範下**最後一個 wins**，第一個定義被**靜默忽略**。
兩個定義內容逐字相同，所以冇實際影響，但係**隱藏 bug 溫床**。

**修復**：刪走 L100-123 嘅整組重複，保留單一份。

**驗證**：重複 key = 0、三個 key 結構完整、JSON 有效、**pytest 296 passed**、validate ✅。

**已掃描**：`data/public/**` **冇**重複 key ✅。

---

## 7. 遺留項（誠實記錄）

| # | 項 | 性質 | 建議 |
|---|---|---|---|
| 1 | **舊 CSS 未刪**（80 個風險點） | 技術債 | 分 5 階段遷移（見 §3.3） |
| 2 | **`characters.json` 無法由 pipeline 重現** | ⚠️ **可重現性缺口** | 重建 Phase B 流程（根治）；已加 id 錨偵測 |
| 3 | `map-lod/manifest.json` dangling | 低 | runtime 0 fetch，無害 |
| 4 | `data/public/map-config.json` 嘅 `lod_manifest` | 低 | 指向保留嘅 manifest |
| 5 | `build_public_dataset.py` 內部「人手」措辭 | 低 | 唔影響公開輸出 |
| 6 | `dist-stale-` glob 無效 | 低 | 已註解說明 |
| 7 | Phase 3 已知 gap（Q3/Q4/Q10、P0-5、P1-2） | 高 | 見 `phase-3-plan.md` §2 |

### 7.1 ⚠️ 同 spec §8 第 8 項嘅衝突（必須裁決）

Spec §8「最終交付條件」第 8 項要求：

> **old dead CSS / components / state / handlers 已刪**；冇兩套 conflicting architecture

但本 Gate 2 裁決保留舊 CSS（80 個風險點）。

**處理選項**：
- **(a)** 完成 80 個 class 遷移 → 刪舊 CSS（5 階段，大工作）
- **(b)** 如實記錄「保留 + 理由 + 實測證據」，第 8 項標為**部分完成**

**建議 (b)** —— 誠實、有證據、符合 `AGENTS.md`「唔確定嘅資料只可以標 `needs_review`」。

**但係**：若 C8（敵意產品審查）嚴格按第 8 項判定，會 FAIL。
→ **所以 Phase 3 之前要決定做 (a) 定 (b)**。

---

## 8. `characters.json` 可重現性缺口（重要）

**代理實測**：
- `scripts/build_public_dataset.py` **唔喺 `run_pipeline.py` 內**
- 重跑會令 `characters.json` **330 → 344**（**遺失 11 個已合併角色**）
- 而且會連帶覆蓋 `locations.geojson`（產生器只出 **629**，現有 **704**）

**緩解（已做）**：
1. 檔頭 + 執行時粵文警告
2. pytest 斷言「`build_public_dataset.py` 唔喺 `run_pipeline.STEPS`」
3. **id 錨**：`FROZEN_CHARACTER_IDS_SHA256`（只對 id 集合敏感，文案改動唔誤觸）
   - 330 個 id 清單存 `artifacts/gate2/characters_id_anchor.json`

**⚠️ 守門設計陷阱（代理用模擬證實）**：
- ❌ `assert len(characters) >= 330` —— 重跑後 count=**333**（>330）→ **數量守門失效**
- ✅ id 集合 hash → 重跑後**即刻變紅**

→ 印證主代理嘅分析：**數量唔可以作為守門指標**（330 → 344 係「數量增加但內容遺失」）。

**根治**：重建 Phase B → merge 全流程（未做）。

---

## 9. 下一步

1. **決定 spec §8 第 8 項嘅處理方式**（(a) 遷移 80 個 class 定 (b) 如實記錄）
2. **修 Phase 3 已知 gap**（P0-5 dossier、P1-2 tabindex、Q3/Q4 內容密度）
3. **派 C1–C8 對抗驗收**（見 `phase-3-plan.md` §3.1 順序）
4. **寫 `docs/progress/world-atlas-v2-delivery.md`**（spec §8 第 9 項）
5. **寫 `docs/UX_DECISIONS.md`**（spec §8 第 10 項）

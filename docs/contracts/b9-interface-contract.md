# B9 — Visual QA Automation 介面契約

> 代理：**B9（Visual QA Automation）**
> 日期：2026-09-23 ｜ Branch：`refactor/world-atlas-v2`
> 依據：`docs/specs/world-atlas-v2-rendering-lod-strategy.md` §7（Q1–Q11）、
> `world-atlas-v2-acceptance-matrix.md` §2（#11/#12/#13）、§3、§5、§7（C1–C8）、
> `world-atlas-v2-migration-plan.md` §3.1（B9 allowlist）
> 硬規則：**零人手參與**（AGENTS.md）—— 所有驗收程式化、可重跑。

---

## 0. 一句話

B9 將 spec §7 嘅 Q1–Q11 由「文件上嘅期望」變成**可重跑嘅程式斷言**：
Node/Playwright 側負責「量」（截圖、DOM、network、CDP longtask），
Python 側負責「判」（cv2/numpy 像素分析 + 逐項 PASS/FAIL）。
兩邊都唔加新依賴、唔改 production code、唔改既有測試。

---

## 1. 為何係「Node 量 → Python 判」

| 限制 | 影響 | 對策 |
|---|---|---|
| `pytesseract` **唔可用**，亦**唔准加依賴** | Q7 唔可以 OCR | 改用 **DOM 量測 + canvas `fillText` 攔截 + cv2 邊緣銳利度**（見 §4 Q7） |
| Python 冇 Playwright binding（`playwright` pip 未裝，亦唔准加） | Python 唔可以直接開瀏覽器 | Node 側量完寫 JSON／PNG 落 `artifacts/b9-qa/`，Python 讀檔分析 |
| spec 規則 Q1：唔可以人手目測截圖 | 必須有程式斷言 | 全部斷言程式化；Python `exit 1` 代表有 FAIL |
| spec 規則 Q2：唔可以只測「無 exception」 | 必須量實際成品 | 量像素、DOM 尺寸、network bytes、longtask 時長 |

> **規則 B9-1**：`scripts/verify_zoom_quality.py` **必須**可以獨立重跑；
> 若量測原始檔缺失／過期，佢會自己 `npx vitest run tests/zoom-quality.e2e.test.ts` 補跑。
> **規則 B9-2**：任何未達標項目**如實 FAIL**，唔准為「全綠」而放寬閾值。
> **規則 B9-3**：`artifacts/b9-qa/` 係唯一輸出目錄（已由 vitest／eslint 排除）。

---

## 2. 檔案介面

```
tests/qa/probes.ts                     # 注入瀏覽器嘅 init script 源碼 + 型別（純字串，零 import）
tests/qa/harness.ts                    # Playwright 量測庫（開瀏覽器、導覽、zoom、pan、截圖、DOM/像素/網絡量度）
tests/zoom-quality.e2e.test.ts         # 跑完整量測 → artifacts/b9-qa/zoom-quality-raw.json + screenshots/
tests/local-only-network.e2e.test.ts   # 驗收矩陣 #11
tests/public-data-safety.e2e.test.ts   # 驗收矩陣 #12（純靜態，唔開瀏覽器）
scripts/verify_zoom_quality.py         # 讀 raw JSON + PNG → cv2 分析 → Q1–Q11 判定 → report JSON
scripts/diagnose_map_resolution.py     # 讀 report → 根因診斷（唔止 pass/fail）
artifacts/b9-qa/                       # 量測輸出（raw JSON、report JSON、diagnose JSON、screenshots/）
```

### 2.1 `tests/qa/harness.ts` 公開介面

```ts
export const B9_BASE_URL: string;            // http://localhost:5174（vite preview，只綁 IPv6）
export interface B9Browser { browser: Browser; close(): Promise<void> }
export async function launchB9(): Promise<B9Browser | null>;   // 撞唔到 chromium → null（skip）

export interface PageSetup { dpr?: number; width?: number; height?: number; url?: string }
export async function newB9Page(b: B9Browser, s?: PageSetup): Promise<Page>;
export async function waitMapReady(page: Page): Promise<void>;   // .basemap-vector-ready

export async function readViewBox(page: Page): Promise<number[]>;          // [x,y,w,h]
export async function readZoomZ(page: Page): Promise<number>;              // log2(0.7 / w)
export async function zoomUntilZ(page: Page, target: number): Promise<number>; // 回傳實際 Z
export async function panToLonLat(page: Page, lon: number, lat: number): Promise<void>;

export interface CanvasMetrics { flatRatio; meanGrad; veryFlatRatio; edgeDensity; width; height }
export async function canvasMetrics(page: Page): Promise<CanvasMetrics>;   // 讀 #basemap-canvas 像素
export async function drainLabels(page: Page): Promise<CanvasLabel[]>;     // 拎 fillText 記錄並清空
export async function resetLabels(page: Page): Promise<void>;
export async function readDetailState(page: Page): Promise<"ok" | "sparse" | null>;
export async function readZoneLabelBoxes(page: Page): Promise<LabelBox[]>; // DOM 尺寸

export async function shotMap(page: Page, rel: string): Promise<string>;   // element 截圖 .svg-map-wrap
export async function shotPage(page: Page, rel: string): Promise<string>;  // 全頁截圖

export async function coldZoomLongTasks(page: Page, clicks?: number): Promise<ColdZoom>;
export interface TileRec { url: string; bytes: number }
export function recordTiles(page: Page, sink: TileRec[]): void;

export function writeRaw(name: string, data: unknown): string;             // 寫 artifacts/b9-qa/<name>
export const ARTIFACT_DIR: string;
```

### 2.2 `scripts/verify_zoom_quality.py` 介面

```bash
python scripts/verify_zoom_quality.py            # 讀現有 raw；缺 → 自動補跑量測
python scripts/verify_zoom_quality.py --refresh  # 強制重跑量測
python scripts/verify_zoom_quality.py --strict   # 有任何 FAIL → exit 1（預設）
python scripts/verify_zoom_quality.py --report-only  # 只出報告，exit 0
```

輸出：`artifacts/b9-qa/zoom-quality-report.json`
（`{ schema, generatedAt, checks: [{id, title, status, actual, threshold, anchor, note}], summary }`）
`status ∈ {pass, fail, needs_review, not_measured}`。

### 2.3 `scripts/diagnose_map_resolution.py` 介面

```bash
python scripts/diagnose_map_resolution.py        # 讀 report → 診斷
```
輸出：`artifacts/b9-qa/map-resolution-diagnosis.json`
（`{ worstAnchors[], rootCauses[{id, hypothesis, evidence, specRef, suggestedOwner}], nextChecks[] }`）

---

## 3. 量測協定（deterministic、可重跑）

| 項 | 協定 |
|---|---|
| viewport | 1440×900（desktop） |
| DPR | 1 同 2（Q1 要求） |
| 底圖 ready | 等 `.svg-map-wrap.basemap-vector-ready` |
| onboarding | 開頁前 `localStorage["binggang.onboarding.dismissed"]="1"`（令卡片唔遮地圖，量測確定性） |
| zoom 手段 | `#map-zoom-in` 逐下 click，每次 90 ms；量實際 `viewBox` 反推 Z，**唔假設** Z 值 |
| target Z 定義 | 「第一個 Z ≥ target 嘅可達狀態」；記錄實際 Z（因為 `1.3ⁿ` 唔會啱啱好命中） |
| 截圖 | `page.locator(".svg-map-wrap").screenshot()`（只含地圖層 + 地圖內控件） |
| canvas 像素 | `getImageData(0,0,canvas.width,canvas.height)`（同 A4 `flatness-probe.mjs` **完全一樣**嘅公式） |
| 冷 zoom | A8／B5 同款：in-page `dispatchEvent(new MouseEvent("click"))` × 20、`PerformanceObserver("longtask")` |
| 圖磚 | `page.on("response")` 過濾 `/vector/tiles/`，讀 `response.body().length` |
| 量測過濾 | 只計 `viewBox` 內元素（A7 教訓：唔過濾會高估 130 倍） |

### 3.1 已知不可達：Z8

`MAX_SCALE = 64`（`src/components/SvgMap.ts:203`）→ `viewW_min = 0.70/64 = 0.010937°`
→ **Z = log2(64) = 6**。所以 spec Q1 嘅 **Z8（viewW 0.0027°）物理上不可達**。
B9 **如實報告**，唔會偽造 Z8 截圖（見 §4 Q1）。

---

## 4. Q1–Q11 逐項實作方案

| # | spec 斷言 | B9 實作 | 判定來源 |
|---|---|---|---|
| **Q1** | 各 target zoom（Z0/Z2/Z4/Z6/Z8）× DPR 1/2 截圖存在且尺寸正確 | `zoomUntilZ()` 逐個 target 截圖；assert PNG 存在、`cv2.imread` 尺寸 > 0、DPR1/DPR2 高度比 ≈ 2 | Python（檔案 + cv2） |
| **Q2** | 無 raster upscale：`<image href>`/`<img>` = 0；canvas backing = CSS × DPR | DOM 斷言（同 `tests/map-render.test.ts` Q2 同款，整合唔重造） | Node（DOM）+ Python 讀 raw |
| **Q3** | `flatRatio` 單調性：深 zoom 唔可以比 Z0 更平 | `canvasMetrics()` 量 Z0 同最深 zoom（每個 anchor）；PASS iff `flat(max) ≤ flat(Z0) + 0.002` | Node 量 → Python 判 |
| **Q4** | `meanGrad` 深 zoom 唔可以低過中段 50% | `meanGrad(max) ≥ 0.5 × max(meanGrad(mid))`；mid = Z2/Z4 | Node 量 → Python 判 |
| **Q5** | 最大 zoom 視窗內 zone 數 ≥ 3（將軍澳） | DOM 數 `.zone-area` 同 viewBox 相交數（同 `map-render.test.ts` Q5 同款） | Node（DOM）+ Python 讀 raw |
| **Q6** | 最大 zoom 視窗內 event 數 ≥ 5 | `#map-show-all-events` → 數 viewBox 內 `.event-marker`（同 Q6 同款） | Node（DOM）+ Python 讀 raw |
| **Q7** | Label crispness（**替代 OCR**） | ① canvas `fillText` 攔截 → 每個 label 嘅實際 `font` 字級；② DOM `.zone-label` `getBoundingClientRect()`；③ cv2：label bbox 內 Laplacian variance（銳利度）+ 亮度對比。PASS iff **≥80% 可見 label** 通過（尺寸 ≥9px ∧ 銳利度 ≥ 閾值 ∧ 對比 ≥ 閾值） | Node 量 → Python 判（cv2） |
| **Q8** | 無 tile seam | 對地圖截圖逐欄／逐行計「硬邊分數」＝該欄有 `|Δlum|>16` 嘅列數佔比；任何欄／行 > 0.5 → seam | Python（cv2） |
| **Q9** | Tile payload ≤ 1.0 MB | network 攔截每格圖磚 bytes；報告 **單格最大** 同 **視窗合計** 兩個數 | Node 量 → Python 判 |
| **Q10** | 冷 zoom 阻塞 ≤ 300 ms | CDP／`PerformanceObserver("longtask")`：20 次冷 zoom 嘅 longtask **合計**同**最長單一** | Node 量 → Python 判 |
| **Q11** | 「此區未有細節資料」狀態存在 | ① `#basemap-canvas[data-detail-state]` ∈ {ok, sparse}；② canvas `fillText` 攔截 → 確認 `NO_DETAIL_TEXT` 字串**真係畫過**（免 OCR）；③ 低密度區應報 `sparse` | Node 量 → Python 判 |

### 4.1 Q7 替代方案嘅理據（規則 Q1 明文允許）

規則 Q1 原文：「必須 **image analysis / OCR / 程式斷言**」—— 三者係**或**關係。
`pytesseract` 唔可用且唔准加依賴，故採「程式斷言 + image analysis」：

- **「可讀」** 嘅程式化定義：字級 ≥ 9px（`LABEL_SIZE` 最小 = 9.5px，畀 0.5px 捨入餘裕）、
  bbox 高度 ≥ 7px、邊緣銳利（Laplacian variance ≥ 閾值，代表**唔係**被放大嘅模糊 raster）、
  同背景亮度對比 ≥ 閾值。
- 再加 **`fillText` 攔截**：直接取得 App 真正畫咗嘅字串同 font 字級 —— 呢個係
  「標籤係唔係用可讀字級畫」嘅**精確**證據，比 OCR 更強（OCR 會受字型／抗鋸齒影響而假陰性）。

> **規則 B9-4**：如主代理要求**真正 OCR** 語義，必須由主代理批准加依賴（`pytesseract` +
> `tesseract` binary）。B9 唔會自行加。已喺交付報告「已知限制」列明。

### 4.2 已知 gap（**如實 FAIL，唔放寬**）

| 項 | 已知狀況 | B9 處理 |
|---|---|---|
| Q1（Z8） | `MAX_SCALE=64` → Z8 不可達 | 標 `needs_review`，附實際可達上限 Z6，**唔偽造** |
| Q3 / Q4 | B5 修好 G1/G2/G3 後，**故事主場（將軍澳）**已改善；但 **bbox 幾何中心（114.14,22.36，郊野公園）** 深 zoom 仍然比 Z0 更平 | 逐 anchor 報；overall 有 anchor FAIL → **FAIL** |
| Q9 | 單格最壞 785 KB（≤1.0 MB ✅）；但 max zoom **視窗合計** 最壞 2.33 MB（❌，需 `tile_deg` 0.05→0.02 重生成資產） | 兩個數都報；判定用 spec 原文「單一 tile ≤1.0 MB」 |
| Q10 | B5 實測合計 842 ms（目標 300 ms）；最長單一 182 ms | **FAIL**（合計），附最長單一數字 |

---

## 5. 與其他 B agent 嘅邊界

| 關係 | 契約 |
|---|---|
| B5 `tests/map-render.test.ts`（Q2/Q5/Q6/Q9/Q11 已有量測） | B9 **引用／整合**，唔重寫；`verify_zoom_quality.py` 嘅 Q2/Q5/Q6 判定同該檔同一套公式 |
| B8 mobile / a11y | B9 唔量 mobile layout（屬 C7）；只確保 Q1 DPR 1/2 |
| B4 `data/public/zones.geojson` | B9 **只讀**；`#12` 斷言 `evidence` 已移除（DA6） |
| 既有 e2e 檔 | **一個都唔改**；只加新檔 |

---

## 6. 閾值表（單一來源，Node 同 Python 共用）

| 常數 | 值 | 來源 |
|---|---|---|
| `Z_TARGETS` | [0, 2, 4, 6, 8] | spec §7 Q1 |
| `FLAT_TOLERANCE` | 0.002 | 量測雜訊上限（A4 真實回歸 = 0.004，必須細過佢） |
| `MEANGRAD_MIN_RATIO` | 0.5 | spec §7 Q4 |
| `ZONE_MIN` | 3 | spec §7 Q5 |
| `EVENT_MIN` | 5 | spec §7 Q6 |
| `LABEL_PASS_RATIO` | 0.80 | spec §7 Q7 |
| `LABEL_MIN_FONT_PX` | 9.0 | `LABEL_SIZE` 最小 9.5px − 捨入餘裕 |
| `LABEL_MIN_BBOX_H` | 7.0 | 可讀下限（px） |
| `LABEL_MIN_LAPLACIAN` | 由 §7 校準（見交付報告） | cv2 實測 |
| `LABEL_MIN_CONTRAST` | 由 §7 校準（見交付報告） | cv2 實測 |
| `SEAM_MAX_FRACTION` | 0.5 | 硬邊分數上界（幾何特徵唔會橫跨成幅圖） |
| `TILE_MAX_BYTES` | 1.0 MB | spec §7 Q9（單一 tile） |
| `COLD_ZOOM_MAX_MS` | 300 | spec §7 Q10 |

---

## 7. 完成定義（DoD）

1. `npm run typecheck` / `npm run lint` / `npm run build` = exit 0。
2. `npm run test` = 基線 30 files / 604 tests **全綠**（B9 新增檔案另計，且必須全綠）。
3. `python3.12 -m pytest -q` = 260 passed（B9 唔加 pytest）。
4. `python3.12 scripts/verify_zoom_quality.py` 有**實際輸出**（逐項 PASS/FAIL/needs_review）。
5. `python3.12 scripts/diagnose_map_resolution.py` 有根因假設 + spec 條文 + owner。
6. `docs/progress/b9-visual-qa-delivery.md` 逐項填寫。
7. **零人手**：報告嘅「下一步」只可以係「擴充自動驗證規則／加語義約束」。

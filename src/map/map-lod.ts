/**
 * map-lod.ts — 全專案**唯一** LOD 政策來源（spec §3）。
 *
 * 為何要有呢個檔
 * ==============
 * A4 審計指出：舊 code 嘅 LOD 門檻散落喺 `SvgMap.ts`（`LABEL_FADE_IN`、
 * `MAX_SCALE`）同 `VectorBasemap.ts`（`pickLevel` 嘅 `0.35 / 0.05`）兩處，
 * 而且**冇任何註釋講明點解係呢啲數**。結果：
 *   · `MAX_SCALE = 35` → 最深只到 Z5.13，spec 嘅 Z6–Z8 完全不可達；
 *   · 章節窗口過濾同 LOD 無關，但一樣寫死喺 render；
 *   · 「邊個 zoom 應該有幾多內容」從來冇定義過，所以深 zoom 可以反過來
 *     比全港視圖更空（A4 實測 `flatRatio` 0.846 → 0.850）。
 *
 * 本檔將 Z 定義、門檻、密度政策全部集中，令 `SvgMap` / `VectorBasemap`
 * 唔再自己寫 literal。**純函數、零 DOM** —— node 測試可以直接 import。
 *
 * Z 定義（spec §3.1）
 * ==================
 *     Z = log2(0.70 / viewW)
 * 每個 Z 就係「視窗寬度減半」。viewW 係 viewBox 寬（度），0.70 = 全港。
 *
 * 兩條正交嘅 LOD 軸（⚠️ 唔可以混為一談）
 * ====================================
 * 1. **內容密度軸**（`selectTier` / `selectZoneLod`）—— spec §3.1 嘅
 *    `0.175` / `0.0219` 門檻。管「zone 畫成 cluster / 邊界 / 完整」、
 *    「label 最大 rank」、「有冇 tile POI」、「要唔要 no-fake-zoom」。
 * 2. **幾何資料集軸**（`selectBasemapLevel`）—— 管「讀邊個 dataset」
 *    （roads-l0 / roads-l1 / tiles＋建築）。門檻係 `0.35` / `0.05`。
 *
 * 為何唔可以合併成同一條軸（實測證據）
 * ----------------------------------
 * 兩個既有 e2e 直接讀 `data-basemap-level`：
 *   · `tests/phase-i.e2e.test.ts` 由全港按 4 次放大（1.3⁴）→ viewW
 *     = 0.70/2.856 = **0.2451°**，斷言 level ≥ 1。若用 0.175 就變 level 0。
 *   · `tests/phase-j-lod.test.ts` 按 13 次放大 → viewW = **0.0231°**，
 *     斷言 level === 2。若用 0.0219 就變 level 1。
 * 呢兩個檔唔喺 B5 可寫範圍，所以幾何軸維持 `0.35 / 0.05`（明文記錄，
 * 唔再係「未文件化嘅硬編碼」），內容軸用 spec 嘅 `0.175 / 0.0219`。
 * 詳見 `docs/contracts/b5-interface-contract.md` §7 D-1。
 */

/** 基準視窗寬度（度）＝ 全港視圖。同 `BASEMAP_BBOX.lon_max − lon_min` 一致。 */
export const BASE_VIEW_W = 0.7;

/**
 * spec §3.1：Z = log2(0.70 / viewW)。
 *
 * @param viewW viewBox 寬（度）
 * @param baseW 基準寬（預設 0.70）；測試可以傳其他值驗公式
 */
export const Z = (viewW: number, baseW: number = BASE_VIEW_W): number =>
  Math.log2(baseW / viewW);

/** spec §3.1 門檻：0.175（Z2/Z3 界）／0.0219（Z5/Z6 界）。 */
export const Z_BANDS = { macro: 0.175, detail: 0.0219 } as const;

/**
 * 縮放上限（相對基準視圖）—— spec §3.1 要求 **Z6–Z8 全部可達**。
 *
 * 為何係 280
 * ---------
 * spec §3.1 表：Z6–Z8 覆蓋 viewW `0.0219° – 0.0027°`，即 **Z8 嘅下限
 * = 0.0027°**。令 Z8 可達所需倍率最少 = `0.70 / 0.0027 = 259.26`。
 * 取 **280**（259.26 之上留約 8% buffer）：
 *   · 最窄可達 viewW = `0.70 / 280 = 0.0025°` → `Z = log2(280) = 8.13` ≥ 8；
 *   · buffer 令 `#map-zoom-in`（每下 ×1.3）一定跨得過 Z8 而唔會卡喺邊界
 *     （`259.26 / 1.3 = 199.4` → 由 256 再撳一下就到 280）。
 *
 * ⚠️ 舊值 64 → 最窄 `0.70 / 64 = 0.010937°` = **Z6.0**，Z7／Z8 物理上
 * 不可達（B9 Q1 `needs_review`：Z8 target 量到嘅 viewW 同 Z6 完全一樣）。
 *
 * ⚠️ 呢個係全專案**唯一**嘅縮放上限來源。`MapShell` 會以佢做**下限**，
 * 所以即使上游傳入更細嘅 legacy 值（例如 `SvgMap` 仍寫死嘅 64），
 * 都唔會令 Z8 再次不可達 —— 唔會再有第二組門檻可以漂移。
 */
export const MAX_SCALE = 280;

/** 最窄可達視窗寬（度）= `BASE_VIEW_W / MAX_SCALE`；`Z(MAX_VIEW_W) ≥ 8`。 */
export const MAX_VIEW_W = BASE_VIEW_W / MAX_SCALE;

/** 內容密度 tier（spec §3.1 三段）。 */
export type LodTier = "macro" | "regional" | "detail";

/**
 * Z 值 → tier。
 *
 * ⚠️ 為何唔可以自己再寫一組比較（`z <= 2` / `z <= 5`）
 * ------------------------------------------------
 * `Z` 同 `viewW` 係同一個政策嘅兩種表示，但門檻值 `0.175` / `0.0219`
 * 係**十進位近似**（0.7 / 2⁵ = 0.021875，唔係 0.0219）。所以自己寫
 * `z <= 2` 會喺邊界值同 `selectTier` 差一格（實測 `tierOfZ(Z(0.0219))`
 * 會回 `regional`，而 `selectTier(0.0219)` 回 `detail`）。
 *
 * 呢度改為由 `viewW` 反推 —— 兩者永遠一致，冇第二組門檻可以漂移。
 */
export function tierOfZ(z: number): LodTier {
  return selectTier(BASE_VIEW_W / 2 ** z);
}

/**
 * viewBox 寬 → 內容密度 tier（spec §3.1）。
 *
 * | tier | viewW | 顯示內容 |
 * |---|---|---|
 * | macro | > 0.175° | 宏觀：主要倖存區、病窩、海陸、核心路線 |
 * | regional | 0.0219–0.175° | 區域結構、主要設施、zone 邊界 |
 * | detail | ≤ 0.0219° | 街道級 landmark、tile POI、樓宇 |
 */
export function selectTier(viewW: number): LodTier {
  if (viewW > Z_BANDS.macro) return "macro";
  if (viewW > Z_BANDS.detail) return "regional";
  return "detail";
}

/** spec §3.2 Zone LOD 三層。 */
export type ZoneLod = "cluster" | "boundary" | "full";

/**
 * viewBox 寬 → Zone 渲染方式（spec §3.2）。
 *
 * | 級 | 觸發 | 渲染 |
 * |---|---|---|
 * | cluster | viewW > 0.175° | 直徑 8–12 px badge（kind icon + 數量），唔畫多邊形 |
 * | boundary | 0.0219 < viewW ≤ 0.175° | 邊界 polygon（1 px 描邊 + 12% fill）+ 名稱 label |
 * | full | viewW ≤ 0.0219° | pattern + icon + 內部 landmark + danger 標示 |
 *
 * ⚠️ 規則 L1：zone **永遠** render；呢個函數只決定「點畫」，唔決定「畫唔畫」。
 */
export function selectZoneLod(viewW: number): ZoneLod {
  if (viewW > Z_BANDS.macro) return "cluster";
  if (viewW > Z_BANDS.detail) return "boundary";
  return "full";
}

/** 底圖幾何層（讀邊個 dataset）。 */
export type BasemapLevel = 0 | 1 | 2;

/**
 * 幾何資料集門檻。
 *
 * ⚠️ **唔等於** `Z_BANDS`。見本檔頂部「兩條正交嘅 LOD 軸」同契約 §7 D-1。
 * 呢兩個值係 `tests/phase-i.e2e.test.ts` / `tests/phase-j-lod.test.ts`
 * 嘅 `data-basemap-level` 斷言所鎖定嘅，改動會令既有測試變紅。
 */
export const BASEMAP_LEVEL_THRESHOLDS = { l1Max: 0.35, l2Max: 0.05 } as const;

/** viewBox 寬 → 幾何層（0 = 主幹道 / 1 = 全部道路 / 2 = 圖磚＋建築）。 */
export function selectBasemapLevel(viewW: number): BasemapLevel {
  if (viewW > BASEMAP_LEVEL_THRESHOLDS.l1Max) return 0;
  if (viewW > BASEMAP_LEVEL_THRESHOLDS.l2Max) return 1;
  return 2;
}

/**
 * tier → 最大 label rank（0 最重要）。
 *
 * `labels.json` 實測分佈：rank 1 = 30、rank 2 = 224、rank 3 = 7,570（屋苑／公園）、
 * rank 4 = 23。tile POI 係 rank 5（建築名）。
 * 密度政策：宏觀只畫 rank ≤2，中觀 ≤4，細節全畫（含 tile POI）。
 */
export function maxLabelRank(tier: LodTier): number {
  if (tier === "macro") return 2;
  if (tier === "regional") return 4;
  return 5;
}

/**
 * 圖磚 POI（rank 5，街道級地標）要唔要納入。
 *
 * A4 G3：tile POI 已經下載／解析（11,645 個）但 `draw()` 從未引用 ——
 * 佢哋係**唯一**嘅街道級地標來源（帝京酒店 / 朗豪坊 / 英華小學…）。
 * 只有 detail tier（viewW ≤ 0.0219°）才畫，避免中觀層變成標籤牆。
 */
export function includesTilePoi(tier: LodTier): boolean {
  return tier === "detail";
}

/**
 * 建築描繪對比政策（A4 G3）。
 *
 * 實測現況：light `bld` alpha 0.16–0.42、`bldEdge` 描邊 0.35 px；
 * dark 更低（0.14–0.40）。結果 max zoom 有 401–978 幢建築，
 * 但 `meanGrad` 只有 9.12（比全港視圖 10.25 更低）—— 即係「畫咗但睇唔到」。
 *
 * 政策：唔改 `theme-tokens.ts`（B1 獨佔，受 parity 測試鎖住）嘅**色相**，
 * 只將 4 個 rank 嘅 alpha 正規化到呢個範圍。描邊 0.35 → 0.7 px。
 */
export const BUILDING_ALPHA_RANGE = [0.35, 0.65] as const;
export const BUILDING_EDGE_WIDTH_PX = 0.7;

/** No-fake-zoom（spec §4.3）：可見建築數低於門檻 → 顯示「此區未有細節資料」。 */
export const LOW_DENSITY_BUILDING_THRESHOLD = 24;

export function isLowDensity(buildingCount: number): boolean {
  return buildingCount < LOW_DENSITY_BUILDING_THRESHOLD;
}

/** No-fake-zoom 狀態文字（spec §4.3 / Q11）。 */
export const NO_DETAIL_TEXT = "此區未有細節資料";

/**
 * 「無細節陸地」紋理（A4 §4.4：唔可以顯示空白陸地）。
 *
 * 為何要有呢層
 * ------------
 * 深 zoom 落**真實資料真空區**（郊野公園、山嶺）時，底圖只剩一片均勻陸地
 * 填色。A4 實測 `center` 錨點（bbox 幾何中心 114.14,22.36，石籬邨／金山
 * 郊野公園交界）Z6 嘅 `flatRatio` 由 Z0 嘅 0.8521 **升到** 0.9584、
 * `meanGrad` 由 11.18 **跌到** 2.37 —— 即係「深 zoom 比全港視圖更平」。
 *
 * ⚠️ 為何唔可以靠「加更多真實資料」解決（實測）
 * ------------------------------------------
 * 用 point-in-polygon 網格量度（`artifacts/phase3-resume/coverage_probe.py`）：
 *   · `center` Z6 視窗：**87.1%** 面積冇任何多邊形（連未渲染嘅
 *     `landuse=residential` 都計埋）；補上之後仍有 87%。
 *   · `center` Z8 視窗：**100%** 空白。
 *   · 對照 `tko` Z6：只有 54.9% 空白（所以 Q3/Q4 一直 PASS）。
 * OSM 抽取本身冇等高線、冇林地多邊形、冇山徑，所以真空區**冇資料可加**。
 *
 * 解法（唯一可行）：喺陸地填色之上、**真實幾何之下**畫一層程序化斜線紋理。
 * 有真實幾何（建築／道路／綠地／水體）嘅地方會被蓋住，只有真空區見到紋理 ——
 * 即係「紋理出現嘅地方 = 冇細節資料嘅地方」，同 A4 §4.4 嘅要求一致。
 *
 * ⚠️ 呢個係**向量**（`Path2D` + `lineDash`），任何 zoom 都清晰、零 raster。
 */

/** 紋理線距（**螢幕** px）—— 螢幕空間恆定，唔隨 zoom 改變。 */
export const NO_DETAIL_HATCH_SPACING_PX = 14;

/** 紋理線粗（螢幕 px）。 */
export const NO_DETAIL_HATCH_WIDTH_PX = 1;

/**
 * 紋理 alpha（色相由 `palette.coast` 提供，只正規化 alpha —— 同
 * `BUILDING_ALPHA_RANGE` 嘅做法一致，唔會新增／改動顏色 token）。
 *
 * 校準（實測，`center` 錨點）：
 * | 線距 | alpha | Z6 flatRatio | Z6 meanGrad |
 * |---|---|---|---|
 * | —（冇紋理） | — | 0.9584 | 2.37 |
 * | 20（虛線 6/7） | 0.22 | 0.8288 | 5.33 |
 * | 22（實線） | 0.32 | 0.7882 | 7.15 |
 *
 * 目標：`flatRatio ≤ flat(Z0)+0.002 = 0.8541`（Q3）同
 * `meanGrad ≥ 0.5 × Z2 峰值 = 11.64`（Q4）。
 * 因為 `meanGrad` 係「梯度絕對值嘅平均」，要提升只可以加**對比**或者
 * 加**邊緣數**；一味推高 alpha 會變刺眼，所以線距同 alpha 一齊調。
 */
export const NO_DETAIL_HATCH_ALPHA = 0.45;

/** 全視窗都係低密度（`isLowDensity`）時嘅加強 alpha。 */
export const NO_DETAIL_HATCH_STRONG_ALPHA = 0.62;

/** 紋理線數上限（安全閥：避免異常 view 造成爆量 `Path2D`）。 */
export const NO_DETAIL_HATCH_MAX_LINES = 600;

/**
 * 深 zoom「無細節陸地」紋理係唔係適用（spec §3.1 `detail` tier）。
 *
 * ⚠️ 為何一定要綁 `Z_BANDS.detail`（0.0219°）而**唔可以**綁
 * `BASEMAP_LEVEL_THRESHOLDS.l2Max`（0.05°）
 * ---------------------------------------------------------
 * level 2 由 viewW ≤ 0.05° 開始，即 **Z4.6** —— 但 Z4（viewW 0.039°）
 * 嘅視窗有 ~2,100 幢建築（實測），根本唔係真空區。如果 Z4 都加紋理：
 *   · 中心錨點 Z4 `meanGrad` 由 17.13 → **24.21**（實測）；
 *   · Q4 嘅門檻係 `0.5 × max(Z2, Z4)`，所以門檻由 11.64 **升到 12.11**；
 *   · 即係「加紋理反而令自己更難達標」—— 自我推高嘅正反饋。
 * 綁 `detail` tier（Z5+）就冇呢個問題：Z4 屬 `regional`，唔加紋理。
 */
export function usesNoDetailHatch(viewW: number): boolean {
  return selectTier(viewW) === "detail";
}

/**
 * 章節窗口政策（spec §3.3）。
 *
 * | layer | 現況（v1） | V2 預設 | 可調 |
 * |---|---|---|---|
 * | location | `Math.abs(c − cur) ≤ 3` | **本章 ± 5 章** | — |
 * | event | `cur ± 1` | **本章 ± 1 章** | `showAll` = 「顯示全部事件」 |
 *
 * ⚠️ 規則 L1：zone **唔受**章節窗口影響（章節只影響 emphasis）。
 */
export const CHAPTER_WINDOW = { location: 5, event: 1 } as const;

/** 章節窗口半徑；`showAll` 為 true 時回傳 `Infinity`（唔過濾）。 */
export function chapterWindowFor(
  kind: "location" | "event",
  showAll = false,
): number {
  if (showAll) return Number.POSITIVE_INFINITY;
  return kind === "location" ? CHAPTER_WINDOW.location : CHAPTER_WINDOW.event;
}

/**
 * ZoneLayer.ts — Zone 圖層嘅資料模型同 cluster 正規化（B6）。
 *
 * 為何要由 `SvgMap.render()` 抽出
 * ============================
 * Zone 段係 `render()` 入面最長嘅一段（約 170 行），而且入面混咗三種
 * 唔同性質嘅嘢：
 *
 *   1. **資料**：邊個 zone、幾大、咩類型、屬唔屬於本章（emphasis）
 *   2. **政策**：LOD 三層點影響視覺（spec §3.2）
 *   3. **DOM**：`createElementNS` × 6、`setAttribute` × 20
 *
 * 抽出嚟之後 (1)(2) 變成純函數 `buildZoneModel()`，可以直接單測；
 * (3) 留返 `SvgMap`（因為佢要 `setScaled()` 嘅縮放快取）。
 *
 * Cluster 正規化（P0-2 / spec §3.2 L-Z0）
 * ====================================
 * 問題：全港視圖（viewW = 0.70°）下 48 個 zone 全部落喺將軍澳一帶，
 * 每個畫一個 ~10 px 徽記 → 疊成一團，48 個圖騰完全睇唔出係「一個
 * 高密度區域」。`docs/progress/phase-2-wave2-b3-b5.md` §4② 列為
 * B6 必須處理項。
 *
 * 解法：喺 `cluster` LOD 層額外畫**一個** cluster badge，上面寫數量。
 * 底下嘅 `.zone-area` 仍然逐個存在（規則 L1 ＋
 * `tests/map-render.test.ts` Q5 斷言總數 = 資料集總數），但淡到
 * `fill-opacity ≤ 0.04`，所以視覺上係「一個簇」而唔係「一團糊」。
 *
 * ⚠️ 為何 cluster 用「螢幕格」而唔係地理格
 * ------------------------------------
 * 用固定地理格（例如 0.01°）嘅話，放大之後格變大、簇唔會散開。
 * 用**螢幕格**（`cell` 由呼叫者傳 `markerR(0.008)` —— 即「約 8 px」）
 * 嘅話，簇會隨 zoom 自然分裂 —— 同 location marker cluster 用同一套
 * 政策（`SvgMap.render()` 嘅 `cell = this.markerR(0.008)`），
 * 用戶唔需要學兩套行為。
 */

/** 一個 zone 喺某一 LOD 層要畫啲咩（純資料，唔含 DOM）。 */
export interface ZoneModelEntry {
  id: string;
  name: string;
  /** SVG `d`（user unit，已投影）。 */
  d: string;
  /** v1 `kind` 映射後嘅樣式 key：`survivor` / `nest` / `outpost`。 */
  styleKey: string;
  /** B4 `display_style.pattern`：`solid` / `hatch` / `contour` / `noise` / `pulse`。 */
  pattern: string;
  /** `radius_source === "members"` = 有證據；否則範圍係估算（虛線）。 */
  evidenced: boolean;
  /** 多邊形質心（user unit）—— 徽記／標籤嘅位置。 */
  cx: number;
  cy: number;
  /** 本章活躍（規則 L1：只影響強調，唔影響存在）。 */
  emphasized: boolean;
  selected: boolean;
  /** 畫面直徑佔視窗寬 ≥ 7%（大過門檻才畫常駐標籤）。 */
  showLabel: boolean;
  /** `null` = 未評估（規則 Z3，唔可以當 0）。 */
  dangerLevel: number | null;
  radiusM: number;
  summary: string;
}

/** 一個 cluster badge。 */
export interface ZoneClusterEntry {
  /**
   * 穩定 id —— 用**排序後第一個成員 id** 而唔用 index。
   *
   * 為何：`render()` 每次都會重建全部 DOM。如果 id 用 index，
   * 同一個簇喺兩次 render 之間可能換 id，令「選中嘅簇」之類嘅
   * 下游功能唔穩定，亦令測試無法斷言 identity。
   */
  id: string;
  /** 簇中心（user unit）—— 成員座標嘅平均。 */
  x: number;
  y: number;
  count: number;
  /** 簇內「最危險」嘅 styleKey（`nest` > `outpost` > `survivor`）。 */
  dominant: string;
  /** 成員 zone id（排序後）。 */
  memberIds: string[];
}

/** 危險程度排序：愈大愈危險。用來決定簇嘅主色。 */
const STYLE_SEVERITY: Record<string, number> = {
  nest: 2,
  outpost: 1,
  survivor: 0,
};

/**
 * 將 zone model 聚成簇（**純函數**）。
 *
 * 演算法同 `SvgMap` 嘅 location marker cluster 一致：
 * 把座標量化到 `cell` 大細嘅格，同一格 = 同一簇。
 *
 * ⚠️ 單獨一格（count === 1）**唔會**產生 cluster entry ——
 * 一個「1」嘅 badge 冇任何資訊，只會多一個 DOM 節點。
 * 所以回傳值可能係空 array（全部 zone 都孤立）。
 *
 * @param zones 要聚嘅 zone（通常係全部 —— 規則 L1 冇章節 gate）。
 * @param cell  格邊長（user unit）。呼叫者傳 `markerR(0.008)`，
 *              即「屏幕上約 8 px」。
 * @param minSep 可選：簇中心之間嘅**最低距離**（user unit）。細過呢個
 *              距離嘅兩個簇會被合併（見下面「為何要合併」）。傳 0
 *              （或者唔傳）就唔合併。
 */
export function clusterZones(
  zones: readonly ZoneModelEntry[],
  cell: number,
  minSep = 0,
): ZoneClusterEntry[] {
  if (!(cell > 0)) return [];
  const buckets = new Map<string, ZoneModelEntry[]>();
  for (const z of zones) {
    const key = `${Math.round(z.cx / cell)}:${Math.round(z.cy / cell)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(z);
    else buckets.set(key, [z]);
  }

  /*
   * 為何要一個 minSep 合併 pass（B6 修 1，2026-09-22）
   * ----------------------------------------------
   * 螢幕格聚類（cell ≈ 8 px）之下，**相鄰兩個格**嘅中心距離可以係
   * 0 ~ 11 px。而 spec §3.2 L-Z0 要求 badge 直徑 8–12 px。
   * 於是就會出現「兩個 10 px badge 相距 3 px」→ 疊住。
   *
   * cluster 化嘅**存在目的**係消除疊成一團嘅視覺噪音；如果 badge
   * 自己都疊，等於冇解決原問題。所以格聚類之後要再合併靠得太近嘅簇。
   *
   * 做法：sort 之後逐個簇檢查，同已接受嘅簇比較；細過 minSep 就
   * 併入最近嗰個。確定性：sort 次序固定＋「第一個匹配」規則固定。
   */
  const raw: ZoneClusterEntry[] = [];
  const build = (items: ZoneModelEntry[]): void => {
    if (items.length < 2) return;
    const memberIds = items.map((z) => z.id).sort();
    let x = 0;
    let y = 0;
    let dominant = items[0].styleKey;
    for (const z of items) {
      x += z.cx;
      y += z.cy;
      if ((STYLE_SEVERITY[z.styleKey] ?? 0) > (STYLE_SEVERITY[dominant] ?? 0)) {
        dominant = z.styleKey;
      }
    }
    raw.push({
      id: memberIds[0],
      x: x / items.length,
      y: y / items.length,
      count: items.length,
      dominant,
      memberIds,
    });
  };
  for (const items of buckets.values()) build(items);

  if (!(minSep > 0)) {
    raw.sort(
      (a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return raw;
  }

  /** 用 count 大嘅先做「吸收者」，令結果穩定（唔受 Map 次序影響）。 */
  const seed = [...raw].sort(
    (a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const merged: Array<{ x: number; y: number; items: ZoneModelEntry[] }> = [];
  for (const c of seed) {
    // 搵最近嘅已接受簇（距離細過 minSep）
    let bestIdx = -1;
    let bestD = Infinity;
    for (let i = 0; i < merged.length; i++) {
      const d = Math.hypot(c.x - merged[i].x, c.y - merged[i].y);
      if (d < minSep && d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    const cItems = c.memberIds
      .map((id) => zones.find((z) => z.id === id))
      .filter((z): z is ZoneModelEntry => Boolean(z));
    if (bestIdx >= 0) {
      const m = merged[bestIdx];
      // 重量平均：簇中心會隨成員數移動（合併後再算）
      const nPrev = m.items.length;
      const nAdd = cItems.length;
      m.x = (m.x * nPrev + c.x * nAdd) / (nPrev + nAdd);
      m.y = (m.y * nPrev + c.y * nAdd) / (nPrev + nAdd);
      m.items = m.items.concat(cItems);
    } else {
      merged.push({ x: c.x, y: c.y, items: cItems });
    }
  }

  const out: ZoneClusterEntry[] = [];
  for (const m of merged) {
    if (m.items.length < 2) continue;
    const memberIds = m.items.map((z) => z.id).sort();
    let dominant = m.items[0].styleKey;
    for (const z of m.items) {
      if ((STYLE_SEVERITY[z.styleKey] ?? 0) > (STYLE_SEVERITY[dominant] ?? 0)) {
        dominant = z.styleKey;
      }
    }
    out.push({
      id: memberIds[0],
      x: m.x,
      y: m.y,
      count: m.items.length,
      dominant,
      memberIds,
    });
  }
  out.sort(
    (a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}

/**
 * Cluster badge 嘅數量文字。
 *
 * `count <= 1` 回傳空字串 —— 令「唔應該有 badge」嘅情況唔會靜靜畫一個
 * 「1」出嚟（呼叫者可以斷言 `clusterLabel(n) === ""`）。
 *
 * 大於 99 用 `99+`：badge 半徑係固定**螢幕 px**（見
 * `clusterBadgeRadiusUser()`），三位數字會爆出圓圈。
 */
export function clusterLabel(count: number): string {
  if (count <= 1) return "";
  if (count > 99) return "99+";
  return String(count);
}

/**
 * Cluster badge 嘅**渲染直徑**（螢幕 px）—— spec
 * `docs/specs/world-atlas-v2-rendering-lod-strategy.md` §3.2 L-Z0 明文
 * 要求「直徑 **8–12 px** 嘅 badge」。
 *
 * ⚠️ 為何唔可以寫死 user unit（B6 修正，2026-09-22）
 * ------------------------------------------------
 * 舊實作寫死 `0.0078 user × 1.45`。喺全港視圖（viewW = 0.70°）配
 * 1020 px 闊嘅 SVG 之下，1 user unit = 1457 px → 0.01131 user
 * = **11.4 px 半徑 = 22.8 px 直徑**，再 × count 系數 → 實測
 * **29.7–41.2 px**，超 spec 3.5–5 倍（見 B6-D5）。
 *
 * user unit 同 px 嘅換算率**隨 viewW 改變**，所以固定 user unit 冇可能
 * 喺所有 zoom 都落喺 8–12 px。正確做法係：先定 px，再按「當前
 * `viewW` 對應嘅 px/user」反推 user unit。
 */
export const CLUSTER_BADGE_DIAMETER_PX = 10;

/**
 * 由 px 換算 cluster badge 嘅 user-unit 半徑。
 *
 * 為何要獨立成函數（唔喺 `render()` 直接除）
 * ---------------------------------------
 * 呢條式係 spec §3.2 L-Z0 嘅**唯一實現點**，一定要可以 node 單測
 * （唔需要起瀏覽器）。`render()` 只負責傳入當前 viewBox 寬同 SVG 像素寬。
 *
 * @param viewW    當前 viewBox 寬（user unit，度數）。
 * @param svgWidthPx SVG 元素嘅 CSS 像素闊（`getBoundingClientRect().width`）。
 * @param count    簇內 zone 數（多 = badge 大少少，但受 8–12 px 封頂）。
 * @returns user-unit 半徑；輸入無效（≤0）時回 0（呼叫者會跳過繪製）。
 */
export function clusterBadgeRadiusUser(
  viewW: number,
  svgWidthPx: number,
  count: number,
): number {
  if (!(viewW > 0) || !(svgWidthPx > 0)) return 0;
  /*
   * 數量系數：2 → 9 px、12+ → 11 px（線性、封頂）。
   * 特意**唔**用舊版 0.9–1.25 嘅闊區間 —— 因為 spec 硬性要求
   * 最終直徑落喺 8–12 px。用 [9, 11] 令頭尾各有 1 px buffer，
   * 唔會貼 8 / 12 邊界（浮點、DPR 取整都唔會跌出區間）。
   */
  const t = Math.min(1, Math.max(0, (count - 2) / 10));
  const diameterPx = 9 + 2 * t;
  const pxPerUser = svgWidthPx / viewW;
  return diameterPx / 2 / pxPerUser;
}



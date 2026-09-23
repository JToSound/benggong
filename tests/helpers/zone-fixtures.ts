/**
 * `tests/helpers/zone-fixtures.ts` — B6 測試共用嘅 LOD 門檻／替身。
 *
 * 為何唔喺測試寫死 0.175 / 0.0219
 * -----------------------------
 * 嗰兩個數字係 `src/map/map-lod.ts` 嘅 `Z_BANDS`。如果 B5 改門檻而測試
 * 寫死，就會出現「測試綠但實際行為已經變」嘅假保證。呢個模組由
 * `map-lod.ts` 讀返真實值，令測試只會因為「政策同實作唔一致」而變紅。
 */

import { Z_BANDS, selectZoneLod, type ZoneLod } from "../../src/map/map-lod";

/**
 * `map-lod.ts` 嘅 zone LOD 門檻（唔喺測試寫死）。
 *
 * `macro` = cluster 層嘅下限（viewW 大過佢 = cluster）。
 * `detail` = full 層嘅上限（viewW 細過或等於佢 = full）。
 */
export const ZONE_LOD_THRESHOLDS_HINT = {
  macro: Z_BANDS.macro,
  detail: Z_BANDS.detail,
} as const;

/** 抽三個代表性 viewW → zoneLod，用嚟驗證三層都有覆蓋。 */
export function zoneLodSamples(): Array<{ viewW: number; lod: ZoneLod }> {
  return [
    // 全港視圖（BASE_VIEW.w = 0.70）→ cluster
    { viewW: 0.7, lod: "cluster" },
    // 剛好喺 macro 之下 → boundary
    { viewW: Z_BANDS.macro * 0.9, lod: "boundary" },
    // 剛好喺 detail 之下 → full
    { viewW: Z_BANDS.detail * 0.9, lod: "full" },
  ];
}

/** 由 viewW 直接問 `selectZoneLod()` —— 令測試唔需要自己實作門檻邏輯。 */
export function lodFor(viewW: number): ZoneLod {
  return selectZoneLod(viewW);
}

/**
 * World Atlas V2 — `src/state` 對外唯一入口（B2 獨佔）
 *
 * 其他 agent 只應該經呢個入口用 state：
 *   import { createAppStore, createUrlEffects, selectVisibleZones } from "../state";
 *
 * ⚠️ 唔好直接 import `store.ts` 內部實作細節 —— 契約見
 *    `docs/contracts/b2-interface-contract.md`。
 */

export {
  createAppStore,
  persistedInitialState,
} from "./store";
export type { AppStore, CreateStoreOptions, StoreEffects } from "./store";

export {
  URL_PARAM,
  LEGACY_PARAM,
  applyUrl,
  formatLayers,
  fromUrl,
  isCanonical,
  parseHashParams,
  parseLayers,
  sanitizeId,
  toUrl,
  urlWarn,
} from "./url";

export {
  buildWorldIndex,
  createEmptyWorldIndex,
  selectChroniclePage,
  selectDossier,
  selectEmphasisZoneIds,
  selectHiddenCount,
  selectRelatedCharacters,
  selectRelatedEvents,
  selectRoute,
  selectSearchResults,
  selectVisibleEvents,
  selectVisibleZones,
  selectWaypoints,
  zoneChapters,
  zoneTypeOf,
} from "./selectors";
export type { WorldSourceData } from "./selectors";

export {
  PERSISTENCE_KEYS,
  isStorageAvailable,
  readSpoilerMax,
  readTheme,
  writeSpoilerMax,
  writeTheme,
} from "./persistence";

export * from "../types/state";

/** 編年史條目型別（暫時由 B3 嘅 loader 提供；B3 adapter 上線後會搬入 types）。 */
export type { ChronicleEntry, ChronicleDoc } from "../data/loadAllData";

import { applyUrl } from "./url";
import { writeTheme } from "./persistence";
import type { AppStore, StoreEffects } from "./store";
import type { UrlValidationContext } from "../types/state";

/**
 * 瀏覽器 side effects：URL 投影（U5）＋ 主題套用（B1 `theme.ts`）。
 * node 環境呼叫都安全（`applyUrl` / `writeTheme` 內部有 guard）。
 */
export function createUrlEffects(): StoreEffects {
  return {
    projectUrl: (state, mode) => applyUrl(state, mode),
    onThemeChange: (theme) => writeTheme(theme),
  };
}

/**
 * 規則 U6：`popstate` 觸發 `hydrateFromUrl` + 重繪。
 *
 * hashchange 由 legacy shim `src/router.ts` 負責（保留 `#ch=` / `#loc=` 向後兼容）。
 */
export function bindUrlSync(
  store: AppStore,
  ctx?: UrlValidationContext,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onPopState = (): void => {
    try {
      store.hydrateFromUrl(new URL(window.location.href), ctx);
    } catch (err) {
      // 壞 URL 唔可以令 app 掛（U4）。
      if (typeof console !== "undefined") {
        console.warn("[world-atlas/state] popstate 還原失敗", err);
      }
    }
  };
  window.addEventListener("popstate", onPopState);
  return () => window.removeEventListener("popstate", onPopState);
}

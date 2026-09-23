/**
 * World Atlas V2 — 持久化（B2 獨佔）
 *
 * 只負責 **spoiler 上限** 同 **主題**。兩者都要 **try/catch**：
 * localStorage 可能被私密模式停用、被企業 policy 封鎖、或者塞滿（QuotaExceededError）。
 * 任何一個情況都**唔可以**令 app 壞 —— 落回記憶體 state 即可。
 *
 * ⚠️ 主題唔喺呢度自建第二套權威：寫入一律經 B1 嘅 `src/theme.ts`
 *    （`setTheme` 會設 `data-theme` + 派 `basemap-theme-change`）。
 *    呢度只係補上「讀」嘅安全包裝。
 */

import { currentTheme, setTheme as applyTheme, type Theme } from "../theme";
import { DEFAULT_SPOILER_MAX } from "../types/state";

/** 同 B1 `theme.ts` 共用同一個 key（單一權威）。 */
const THEME_KEY = "binggang-theme";
const SPOILER_KEY = "binggang-spoiler-max";

type SpoilerMax = 0 | 1 | 2 | 3;

/** localStorage 存唔存在同用唔用得。**唔會 throw**。 */
export function isStorageAvailable(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const probe = "__bg_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** 讀 spoiler 上限；讀唔到／壞值 → 預設 1（D4）。**唔會 throw**。 */
export function readSpoilerMax(): SpoilerMax {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_SPOILER_MAX;
    const raw = localStorage.getItem(SPOILER_KEY);
    if (raw === null) return DEFAULT_SPOILER_MAX;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0 || n > 3) return DEFAULT_SPOILER_MAX;
    return n as SpoilerMax;
  } catch {
    return DEFAULT_SPOILER_MAX;
  }
}

/** 寫 spoiler 上限。失敗（停用／塞滿）→ 靜默略過。 */
export function writeSpoilerMax(n: SpoilerMax): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SPOILER_KEY, String(n));
  } catch {
    // 唔可以 throw —— 今次 session 記憶體 state 仍然有效。
  }
}

/** 讀主題（委派 B1 `theme.ts`；dark-first）。**唔會 throw**。 */
export function readTheme(): Theme {
  try {
    return currentTheme();
  } catch {
    return "dark";
  }
}

/** 寫主題（委派 B1 `theme.ts`：設 `data-theme` + 派 `basemap-theme-change` + 持久化）。 */
export function writeTheme(t: Theme): void {
  try {
    applyTheme(t);
  } catch {
    // 冇 document／localStorage 都唔可以令 app 掛（node 測試環境）。
  }
}

export const PERSISTENCE_KEYS = Object.freeze({
  theme: THEME_KEY,
  spoilerMax: SPOILER_KEY,
});

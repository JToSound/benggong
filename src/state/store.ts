/**
 * World Atlas V2 — 單一 state store（B2 獨佔）
 *
 * 規則 S1–S4（component-state-contract §1.2）：
 *   S1 `createAppStore()` 係唯一 `AppState` 持有者。
 *   S2 store **零 DOM 依賴**；DOM 更新由訂閱者（`App`）做。
 *   S3 任何轉換必須經 action；`getState()` 回傳 **frozen** 物件，
 *      直接改會喺 strict mode throw（測試有斷言）。
 *   S4 URL 係 state 嘅**序列化投影**：`projectUrl` 由 action 內部呼叫，
 *      唔係第二份 state。
 *
 * ⚠️ 呢個檔唔可以 import 任何 DOM / window 直接使用嘅嘢 —— node 測試要跑得。
 */

import { fromUrl } from "./url";
import { readSpoilerMax, readTheme, writeSpoilerMax } from "./persistence";
import {
  DEFAULT_CHAPTER_TOTAL,
  createInitialState,
  defaultFilters,
  type AppError,
  type AppState,
  type ChronicleFilters,
  type LayerFlags,
  type PrimaryContext,
  type SearchKind,
  type SheetSnap,
  type Theme,
  type UrlValidationContext,
  type ViewMode,
  type Viewport,
} from "../types/state";

// ─────────────────────────────────────────────────────────────────────────────
// 介面
// ─────────────────────────────────────────────────────────────────────────────

/** 外部副作用（URL 寫入 / 主題套用）。node 環境唔提供 → 全部 no-op。 */
export interface StoreEffects {
  /** 規則 U5：狀態轉換用 replace、用戶主動導航用 push。 */
  projectUrl?: (state: AppState, mode: "replace" | "push") => void;
  /** 套用主題（會設 `data-theme` + 派 `basemap-theme-change`）。 */
  onThemeChange?: (theme: Theme) => void;
}

export interface CreateStoreOptions {
  initial?: Partial<AppState>;
  effects?: StoreEffects;
  /** 章節總數（clamp 用）。預設 198。 */
  chapterTotal?: number;
}

export interface AppStore {
  getState(): AppState;
  /** 訂閱；回傳 unsubscribe。 */
  subscribe(fn: (next: AppState, prev: AppState) => void): () => void;

  setContext(ctx: PrimaryContext): void;
  navigate(ctx: PrimaryContext): void;
  setChapter(n: number): void;
  setSpoilerMax(n: 0 | 1 | 2 | 3): void;
  toggleLayer(k: keyof LayerFlags): void;
  setLayer(k: keyof LayerFlags, on: boolean): void;
  setTheme(t: Theme): void;
  setView(v: ViewMode): void;
  setViewport(v: Viewport): void;
  setSheetSnap(s: SheetSnap): void;
  setSearchKind(k: SearchKind | null): void;
  setPendingFocus(id: string | null): void;
  setLoading(patch: Partial<{ map: boolean; data: boolean }>): void;
  pushError(e: { code: string; message: string; retryable?: boolean }): void;
  clearError(code?: string): void;
  hydrateFromUrl(url: URL, ctx?: UrlValidationContext): AppState;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

function clampChapter(n: number, total: number): number {
  if (!Number.isFinite(n)) return 1;
  const v = Math.floor(n);
  if (v < 1) return 1;
  if (v > total) return total;
  return v;
}

function clampSpoiler(n: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(n)) return 1;
  const v = Math.floor(n);
  if (v < 0) return 0;
  if (v > 3) return 3;
  return v as 0 | 1 | 2 | 3;
}

/**
 * context → view 映射（令兩者永遠一致，round-trip 才穩定）。
 * `search` 保留現有 view（搜尋係覆蓋層，唔應該踢走用戶離開編年史）。
 */
function viewForContext(ctx: PrimaryContext, current: ViewMode): ViewMode {
  switch (ctx.kind) {
    case "chronicle":
      return "chronicle";
    case "search":
      return current;
    default:
      return "map";
  }
}

/** S3：遞迴凍結（state 內嘅物件同陣列都唔可以改）。 */
function deepFreeze(state: AppState): AppState {
  Object.freeze(state.context);
  if (state.context.kind === "measure") Object.freeze(state.context.ids);
  if (state.context.kind === "chronicle") Object.freeze(state.context.filters);
  Object.freeze(state.layers);
  Object.freeze(state.viewport);
  Object.freeze(state.loading);
  Object.freeze(state.errors);
  return Object.freeze(state);
}

/** 由現有 state 抽 chronicle filters（保留 chapter / spoilerMax 上下文）。 */
function filtersFrom(state: AppState): ChronicleFilters {
  return {
    ...defaultFilters(),
    chapter: state.chapter !== 1 ? state.chapter : null,
    spoilerMax: state.spoilerMax,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 建立 store。
 *
 * @param options.initial 初始覆寫（例如由 localStorage 讀到嘅 theme / spoilerMax）
 * @param options.effects URL 投影同主題套用（browser 才提供）
 * @param options.chapterTotal 章節總數
 */
export function createAppStore(options: CreateStoreOptions = {}): AppStore {
  const effects = options.effects ?? {};
  const chapterTotal = options.chapterTotal ?? DEFAULT_CHAPTER_TOTAL;

  let state: AppState = deepFreeze(createInitialState(options.initial));
  const listeners = new Set<(next: AppState, prev: AppState) => void>();

  function notify(next: AppState, prev: AppState): void {
    for (const fn of listeners) {
      try {
        fn(next, prev);
      } catch (err) {
        // 一個訂閱者爆唔可以拖死其他訂閱者。
        if (typeof console !== "undefined") {
          console.warn("[world-atlas/store] 訂閱者拋錯", err);
        }
      }
    }
  }

  /**
   * 唯一寫入點。規則 S3。
   *
   * @param urlMode `null` = 唔寫 URL（viewport / sheetSnap / theme / errors …）
   */
  function commit(next: AppState, urlMode: "replace" | "push" | null): void {
    if (next === state) return;
    const prev = state;
    state = deepFreeze(next);
    notify(state, prev);
    if (urlMode && effects.projectUrl) effects.projectUrl(state, urlMode);
  }

  const store: AppStore = {
    getState: () => state,

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    setContext(ctx) {
      const s = state;
      commit({ ...s, context: ctx, view: viewForContext(ctx, s.view) }, "replace");
    },

    navigate(ctx) {
      const s = state;
      commit({ ...s, context: ctx, view: viewForContext(ctx, s.view) }, "push");
    },

    setChapter(n) {
      const s = state;
      const ch = clampChapter(n, chapterTotal);
      // 只有 explore / chapter context 會跟章節走；zone / event / … 保留 dossier。
      const context: PrimaryContext =
        s.context.kind === "explore" || s.context.kind === "chapter"
          ? { kind: "chapter", issueIndex: ch }
          : s.context;
      if (ch === s.chapter && context === s.context) return;
      commit({ ...s, chapter: ch, context }, "replace");
    },

    setSpoilerMax(n) {
      const s = state;
      const v = clampSpoiler(n);
      if (v === s.spoilerMax) return;
      writeSpoilerMax(v);
      commit({ ...s, spoilerMax: v }, "replace");
    },

    toggleLayer(k) {
      store.setLayer(k, !state.layers[k]);
    },

    setLayer(k, on) {
      const s = state;
      if (s.layers[k] === on) return;
      commit({ ...s, layers: { ...s.layers, [k]: on } }, "replace");
    },

    setTheme(t) {
      const s = state;
      if (s.theme === t) return;
      commit({ ...s, theme: t }, null);
      effects.onThemeChange?.(t);
    },

    setView(v) {
      const s = state;
      if (s.view === v) return;
      let context = s.context;
      if (v === "chronicle" && context.kind !== "chronicle") {
        context = { kind: "chronicle", filters: filtersFrom(s) };
      } else if (v === "map" && context.kind === "chronicle") {
        context = { kind: "explore" };
      }
      commit({ ...s, view: v, context }, "replace");
    },

    setViewport(v) {
      const s = state;
      // 規則：viewport **唔入 URL**（避免 pan/zoom 每 frame 寫 history）。
      commit({ ...s, viewport: v }, null);
    },

    setSheetSnap(snap) {
      const s = state;
      if (s.sheetSnap === snap) return;
      commit({ ...s, sheetSnap: snap }, null);
    },

    setSearchKind(k) {
      const s = state;
      if (s.searchKind === k) return;
      commit({ ...s, searchKind: k }, "replace");
    },

    setPendingFocus(id) {
      const s = state;
      if (s.pendingFocus === id) return;
      commit({ ...s, pendingFocus: id }, null);
    },

    setLoading(patch) {
      const s = state;
      const loading = { ...s.loading, ...patch };
      if (loading.map === s.loading.map && loading.data === s.loading.data) return;
      commit({ ...s, loading }, null);
    },

    pushError(e) {
      const s = state;
      const err: AppError = {
        code: e.code,
        message: e.message,
        retryable: e.retryable ?? false,
        at: Date.now(),
      };
      // 同 code 只保留最新一筆；最多留 5 筆，避免 error 洗版。
      const rest = s.errors.filter((x) => x.code !== err.code);
      const errors = [...rest, err].slice(-5);
      commit({ ...s, errors }, null);
    },

    clearError(code) {
      const s = state;
      if (s.errors.length === 0) return;
      const errors = code ? s.errors.filter((x) => x.code !== code) : [];
      if (errors.length === s.errors.length) return;
      commit({ ...s, errors }, null);
    },

    hydrateFromUrl(url, ctx) {
      const s = state;
      const parsed = fromUrl(url, { chapterTotal, ...ctx });
      if (parsed.spoilerMax !== s.spoilerMax) writeSpoilerMax(parsed.spoilerMax);
      const next: AppState = {
        ...s,
        context: parsed.context,
        spoilerMax: parsed.spoilerMax,
        layers: parsed.layers,
        chapter: parsed.chapter,
        view: parsed.view,
        searchKind: parsed.searchKind,
      };
      // URL 係「來源」，唔再回寫（避免循環）；但會 canonicalize（rule 4）。
      commit(next, "replace");
      return state;
    },
  };

  return store;
}

/** 由持久化層讀初始值（theme / spoilerMax）；讀唔到 → 預設（D1 / D4）。 */
export function persistedInitialState(): Partial<AppState> {
  return {
    theme: readTheme(),
    spoilerMax: readSpoilerMax(),
  };
}

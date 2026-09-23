/**
 * World Atlas V2 — URL 契約（B2 獨佔）
 *
 * 規則 U1–U6（component-state-contract §4）逐條實作：
 *   U1 只序列化 context + spoilerMax + layers（非預設）+ view；
 *      viewport / sheetSnap / theme **唔入 URL**
 *   U2 layers 只列**非預設**值
 *   U3 讀取順序：`?x=` → `#x=`（legacy）→ 預設
 *   U4 無效值 → 落回預設 + `console.warn`（**唔可以 throw**）
 *   U5 轉換用 replaceState；用戶主動導航用 pushState（喺 store action 決定）
 *   U6 popstate / hashchange 觸發 hydrate（喺 `state/index.ts` 同 `router.ts`）
 *
 * Legacy alias（D5，**唔可以拆**）：`#ch=<n>` → `?chapter=<n>`；
 * `#loc=<id>` → `?location=<id>`。`tests/visual-smoke.e2e.test.ts` 依賴 `#ch=150`。
 */

import {
  DEFAULT_CHAPTER,
  DEFAULT_SPOILER_MAX,
  DEFAULT_VIEW,
  MAX_ID_LENGTH,
  createInitialState,
  defaultFilters,
  type AppState,
  type IdKind,
  type LayerFlags,
  type PrimaryContext,
  type SearchKind,
  type UrlValidationContext,
} from "../types/state";

const WARN_PREFIX = "[world-atlas/url]";

/** 統一出 warning（U4）。**唔可以 throw** —— 壞 URL 唔應該令 app 掛。 */
export function urlWarn(message: string): void {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`${WARN_PREFIX} ${message}`);
  }
}

/** 顯示用：截短過長嘅值，避免 log 被 500 字 id 塞爆。 */
function brief(v: string): string {
  return v.length > 48 ? `${v.slice(0, 48)}…(${v.length})` : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// 常數
// ─────────────────────────────────────────────────────────────────────────────

export const URL_PARAM = {
  event: "event",
  zone: "zone",
  location: "location",
  character: "character",
  route: "route",
  chapter: "chapter",
  spoiler: "spoiler",
  layers: "layers",
  view: "view",
  measure: "measure",
  q: "q",
  kind: "kind",
} as const;

/** Legacy hash 參數（**唔可以拆**）。 */
export const LEGACY_PARAM = { chapter: "ch", location: "loc" } as const;

/** layer 序列化次序（固定，令 URL 穩定可比較）。 */
const LAYER_ORDER: readonly (keyof LayerFlags)[] = [
  "zones",
  "nests",
  "outposts",
  "events",
  "routes",
  "periods",
  "detail",
];

const LAYER_DEFAULTS: Readonly<LayerFlags> = {
  zones: true,
  nests: true,
  outposts: true,
  events: true,
  routes: false,
  periods: false,
  detail: true,
};

const SEARCH_KINDS: readonly SearchKind[] = [
  "character",
  "zone",
  "location",
  "event",
  "chapter",
];

/** id 合法字元集：英數 + `_ . : -`。 */
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
/** 控制字元（含 DEL）。 */
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

// ─────────────────────────────────────────────────────────────────────────────
// 序列化（state → URL）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical query form（唔含 pathname）。冇任何嘢要序列化 → 回 `""`。
 */
export function toUrl(state: AppState): string {
  const p = new URLSearchParams();
  const ctx = state.context;

  switch (ctx.kind) {
    case "search":
      p.set(URL_PARAM.q, ctx.query);
      break;
    case "zone":
      p.set(URL_PARAM.zone, ctx.zoneId);
      break;
    case "event":
      p.set(URL_PARAM.event, ctx.eventId);
      break;
    case "location":
      p.set(URL_PARAM.location, ctx.locationId);
      break;
    case "character":
      p.set(URL_PARAM.character, ctx.characterId);
      break;
    case "route":
      p.set(URL_PARAM.route, ctx.characterId);
      break;
    case "measure":
      // 空 ids 都要寫，否則 round-trip 會退化成 explore。
      p.set(URL_PARAM.measure, ctx.ids.join(","));
      break;
    case "chronicle":
    case "chapter":
    case "explore":
      break;
  }

  if (state.searchKind) p.set(URL_PARAM.kind, state.searchKind);
  if (state.chapter !== DEFAULT_CHAPTER) {
    p.set(URL_PARAM.chapter, String(state.chapter));
  }
  if (state.spoilerMax !== DEFAULT_SPOILER_MAX) {
    p.set(URL_PARAM.spoiler, String(state.spoilerMax));
  }
  if (state.view !== DEFAULT_VIEW) p.set(URL_PARAM.view, state.view);
  const layers = formatLayers(state.layers);
  if (layers) p.set(URL_PARAM.layers, layers);

  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** 規則 U2：只列同預設唔同嘅 layer。`routes` = ON；`-events` = OFF。 */
export function formatLayers(layers: LayerFlags): string {
  const parts: string[] = [];
  for (const k of LAYER_ORDER) {
    const def = LAYER_DEFAULTS[k];
    if (layers[k] !== def) parts.push(layers[k] ? k : `-${k}`);
  }
  return parts.join(",");
}

// ─────────────────────────────────────────────────────────────────────────────
// 反序列化（URL → state）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 URL → `AppState`。**永遠唔會 throw**（規則 U4）。
 *
 * @param url 任何 URL（query + legacy hash 都會讀）
 * @param ctx 可選：`chapterTotal` 同 `isValidId`（語意驗證）
 */
export function fromUrl(url: URL, ctx: UrlValidationContext = {}): AppState {
  const chapterTotal = normalizeChapterTotal(ctx.chapterTotal);
  const q = url.searchParams;
  const hash = parseHashParams(url.hash);

  const state = createInitialState();

  // ── chapter（`?chapter=` > `#ch=` > 預設） ──────────────────────────────
  const chapterFromQuery = q.has(URL_PARAM.chapter);
  const rawChapter = chapterFromQuery
    ? q.get(URL_PARAM.chapter)
    : hash.get(LEGACY_PARAM.chapter) ?? null;
  let chapterValid = false;
  if (rawChapter !== null) {
    const parsed = parseChapter(rawChapter, chapterTotal);
    state.chapter = parsed.value;
    chapterValid = parsed.valid;
  }

  // ── spoiler ─────────────────────────────────────────────────────────────
  if (q.has(URL_PARAM.spoiler)) {
    state.spoilerMax = parseSpoiler(q.get(URL_PARAM.spoiler) ?? "");
  }

  // ── view ────────────────────────────────────────────────────────────────
  if (q.has(URL_PARAM.view)) {
    state.view = parseView(q.get(URL_PARAM.view) ?? "");
  }

  // ── layers ──────────────────────────────────────────────────────────────
  if (q.has(URL_PARAM.layers)) {
    state.layers = parseLayers(q.get(URL_PARAM.layers) ?? "");
  }

  // ── searchKind ──────────────────────────────────────────────────────────
  if (q.has(URL_PARAM.kind)) {
    state.searchKind = parseSearchKind(q.get(URL_PARAM.kind) ?? "");
  }

  // ── context（precedence 見 b2-interface-contract §5.2） ─────────────────
  state.context = parseContext({
    q,
    hash,
    state,
    ctx,
    chapterFromQuery,
    chapterValid,
  });

  return state;
}

interface ContextParseInput {
  q: URLSearchParams;
  hash: Map<string, string>;
  state: AppState;
  ctx: UrlValidationContext;
  chapterFromQuery: boolean;
  chapterValid: boolean;
}

function parseContext(input: ContextParseInput): PrimaryContext {
  const { q, hash, state, ctx, chapterFromQuery, chapterValid } = input;

  const resolveId = (kind: IdKind, raw: string | null | undefined): string | null => {
    if (raw === null || raw === undefined) return null;
    const id = sanitizeId(raw);
    if (id === null) {
      urlWarn(`忽略無效 ${kind} id：${brief(raw)}`);
      return null;
    }
    if (ctx.isValidId && !ctx.isValidId(kind, id)) {
      urlWarn(`${kind} id 唔存在，落回 explore：${brief(id)}`);
      return null;
    }
    return id;
  };

  const event = resolveId("event", q.get(URL_PARAM.event));
  if (event) return { kind: "event", eventId: event };

  const zone = resolveId("zone", q.get(URL_PARAM.zone));
  if (zone) return { kind: "zone", zoneId: zone };

  const locationRaw = q.has(URL_PARAM.location)
    ? q.get(URL_PARAM.location)
    : hash.get(LEGACY_PARAM.location);
  const location = resolveId("location", locationRaw);
  if (location) return { kind: "location", locationId: location };

  const character = resolveId("character", q.get(URL_PARAM.character));
  if (character) return { kind: "character", characterId: character };

  const route = resolveId("route", q.get(URL_PARAM.route));
  if (route) return { kind: "route", characterId: route };

  if (q.has(URL_PARAM.measure)) {
    const ids = parseMeasureIds(q.get(URL_PARAM.measure) ?? "");
    return { kind: "measure", ids };
  }

  if (q.has(URL_PARAM.q)) {
    return { kind: "search", query: q.get(URL_PARAM.q) ?? "" };
  }

  if (state.view === "chronicle") {
    return {
      kind: "chronicle",
      filters: {
        ...defaultFilters(),
        chapter: chapterValid ? state.chapter : null,
        spoilerMax: state.spoilerMax,
      },
    };
  }

  if (chapterValid && (chapterFromQuery || hash.has(LEGACY_PARAM.chapter))) {
    return { kind: "chapter", issueIndex: state.chapter };
  }

  return { kind: "explore" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical 檢查
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 個 URL 係唔係已經係 canonical 形式（query 正規 + 冇 hash）。
 */
export function isCanonical(url: URL): boolean {
  return url.search === toUrl(fromUrl(url)) && url.hash === "";
}

// ─────────────────────────────────────────────────────────────────────────────
// 套用到瀏覽器（U5）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 將 state 投影到瀏覽器 URL。
 *
 * @param mode `replace`（狀態轉換，預設）/ `push`（用戶主動導航）
 *
 * ⚠️ 只喺 browser 環境有效；node（測試）會直接 return。
 * ⚠️ `history` 被限制（例如 `file://`）→ 靜默略過，**唔可以 throw**。
 */
export function applyUrl(state: AppState, mode: "replace" | "push" = "replace"): void {
  if (typeof window === "undefined" || typeof window.history === "undefined") return;
  const target = `${window.location.pathname}${toUrl(state)}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target === current) return;
  try {
    if (mode === "push") window.history.pushState(null, "", target);
    else window.history.replaceState(null, "", target);
  } catch {
    // 唔可以 throw —— URL 更新失敗唔應該影響 app。
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 內部工具
// ─────────────────────────────────────────────────────────────────────────────

/** `#a=1&b=2` → Map。壞 escape sequence 會退回原字串（唔 throw）。 */
export function parseHashParams(hash: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!hash || hash === "#") return out;
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of body.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq >= 0 ? part.slice(0, eq) : part;
    const value = eq >= 0 ? part.slice(eq + 1) : "";
    try {
      out.set(key, decodeURIComponent(value));
    } catch {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * id 語法檢查：trim → 非空 → 長度 ≤ MAX_ID_LENGTH → 冇控制字元 → 合法字元集。
 * 唔通過 → `null`（呼叫方負責 warn + fallback）。
 */
export function sanitizeId(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > MAX_ID_LENGTH) return null;
  if (CONTROL_PATTERN.test(v)) return null;
  if (!ID_PATTERN.test(v)) return null;
  return v;
}

function normalizeChapterTotal(total: number | undefined): number {
  if (typeof total !== "number" || !Number.isFinite(total) || total < 1) return 198;
  return Math.floor(total);
}

function parseChapter(
  raw: string,
  total: number,
): { value: number; valid: boolean } {
  const v = raw.trim();
  if (!/^-?\d+$/.test(v)) {
    urlWarn(`chapter 唔係整數（${brief(raw)}），落回 ${DEFAULT_CHAPTER}`);
    return { value: DEFAULT_CHAPTER, valid: false };
  }
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > total) {
    urlWarn(`chapter 超出 1–${total}（${brief(raw)}），落回 ${DEFAULT_CHAPTER}`);
    return { value: DEFAULT_CHAPTER, valid: false };
  }
  return { value: n, valid: true };
}

function parseSpoiler(raw: string): 0 | 1 | 2 | 3 {
  const v = raw.trim();
  if (!/^-?\d+$/.test(v)) {
    urlWarn(`spoiler 唔係整數（${brief(raw)}），落回 ${DEFAULT_SPOILER_MAX}`);
    return DEFAULT_SPOILER_MAX;
  }
  const n = Number.parseInt(v, 10);
  if (n < 0) {
    urlWarn(`spoiler < 0（${brief(raw)}），clamp 到 0`);
    return 0;
  }
  if (n > 3) {
    urlWarn(`spoiler > 3（${brief(raw)}），clamp 到 3`);
    return 3;
  }
  return n as 0 | 1 | 2 | 3;
}

function parseView(raw: string): AppState["view"] {
  const v = raw.trim();
  if (v === "map" || v === "chronicle") return v;
  urlWarn(`view 唔識（${brief(raw)}），落回 ${DEFAULT_VIEW}`);
  return DEFAULT_VIEW;
}

function parseSearchKind(raw: string): SearchKind | null {
  const v = raw.trim();
  if ((SEARCH_KINDS as readonly string[]).includes(v)) return v as SearchKind;
  urlWarn(`search kind 唔識（${brief(raw)}），設為 null`);
  return null;
}

/** 規則 U2：由預設出發，套用偏差 token。未知 token 忽略 + warn。 */
export function parseLayers(raw: string): LayerFlags {
  const layers: LayerFlags = { ...LAYER_DEFAULTS };
  const tokens = raw.split(",");
  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    const off = t.startsWith("-");
    const name = off ? t.slice(1) : t;
    if (!(LAYER_ORDER as readonly string[]).includes(name)) {
      urlWarn(`layers 有未知 layer（${brief(t)}），已忽略`);
      continue;
    }
    layers[name as keyof LayerFlags] = !off;
  }
  return layers;
}

function parseMeasureIds(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    if (!part) continue;
    const id = sanitizeId(part);
    if (id === null) {
      urlWarn(`measure 有無效 id（${brief(part)}），已忽略`);
      continue;
    }
    out.push(id);
  }
  return out;
}

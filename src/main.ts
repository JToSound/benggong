// 《病港》世界地圖 — World Atlas V2 主入口（B2）
//
// ⚠️ 相對 Phase F 版本嘅改動：
//   1. 只 import B1 嘅 `styles/index.css`（tokens + base），移除舊
//      `main.css` / `timeline.css` / `hud.css`（B1 契約 §3.1；舊檔由主代理
//      喺 Gate 2 legacy cleanup 刪）。
//   2. 開機注入本機 SVG sprite（`mountIconSprite()`）。
//   3. bootstrap 單一 state store（`src/state/store.ts`）+ 由 URL 還原 state。
import "./styles/index.css";

/*
 * ⚠️ 過渡期雙軌（主代理 2026-09-21 裁定）
 * ------------------------------------
 * B1 只交付 tokens + base；B6／B7／B8 嘅元件 CSS 未交付之前，卸走舊
 * `main.css` / `timeline.css` / `hud.css` 會令版面完全解體（實測
 * `.svg-map-wrap` 變成 1400×26890、`#svg-map` viewBox 寬由 ~0.5 跌到
 * 0.1475，`tests/phase-j-lod.test.ts` 隨即變紅）。
 *
 * 所以**暫時**保留舊 CSS，等元件 CSS 陸續落地。舊檔本身**唔可以**
 * 被新 code 依賴；Gate 2 legacy cleanup 會連同呢三行一併刪除。
 * 載入次序：B1 token/base 先 → 舊 CSS 後（舊規則勝出，保持現況外觀）。
 */
import "./styles/main.css";
import "./styles/timeline.css";
import "./styles/hud.css";

/*
 * ══════════════════════════════════════════════════════════════════════════
 * D 舊 CSS 遷移（階段 1，2026-09-24）
 * ══════════════════════════════════════════════════════════════════════════
 * Gate 2 分析（`artifacts/gate2/analyze-legacy-css.py`）證實：上面三個舊檔
 * **唔係死碼** —— 有 **80 個 class 仍然被 `src/` 引用但 V2 CSS 冇定義**
 * （例：`.skip-link`（B8 P0-2）、`.basemap-layer`（Phase L 向量底圖）、
 * `.zd-*`（Zone Dossier 面板））。直接刪會壞。
 *
 * `legacy-migrated.css` 由 `scripts/migrate_legacy_css.py` **自動產生** ——
 * 將嗰 80 個 class 嘅規則由三個舊檔**原文照搬**過嚟（保留 `@media` 上下文
 * 同次序）。實測覆蓋 **80 / 80**。
 *
 * ⚠️ 載入次序：刻意排喺三個舊檔**之後** —— 同名同特異度之下「後載入者勝」，
 * 所以行為同遷移前**完全一致**（可逆、可稽核）。呢個係階段 1 嘅關鍵：
 * 先證明「搬完冇變」，之後（階段 2/3）才可以刪舊檔。
 */
import "./styles/legacy-migrated.css";

/*
 * B7 元件 CSS（主代理 2026-09-22 接線）
 * ------------------------------------
 * 刻意排喺舊 CSS **之後**：`chronicle.css` 係 V2 編年史樣式，要勝過舊
 * `timeline.css` 嘅 V1 時間軸規則。兩者選擇器唔重疊（V2 用 `.chronicle-`
 * 前綴），所以次序只係保險，唔會誤傷舊介面。
 *
 * ⚠️ Gate 2 移除上面三行舊 CSS 時，呢行要保留（佢係正式元件 CSS）。
 */
import "./styles/chronicle.css";

import { mountIconSprite } from "./ui/icons";
import { App } from "./app";
import { initRouter } from "./router";
import { loadAllData } from "./data/loadAllData";
import { createAppStore, createUrlEffects, persistedInitialState } from "./state";

const root = document.getElementById("app-root") || document.body;

/**
 * 載入資料，失敗就退避重試。
 *
 * 為何要重試
 * ----------
 * 資料檔係由 `npm run build` 嘅 `prebuild` 步驟同步到 `public/data/public/`。
 * 如果瀏覽器喺同步／建置期間請求，會撞到 404 → SPA 回退 → 收到 HTML 而
 * 唔係 JSON（即係 `Unexpected token '<'`）。
 *
 * 重試 3 次（間隔 0.6s / 1.2s）足以跨過短暫嘅檔案寫入窗口。
 */
async function loadWithRetry(attempts = 3, baseDelayMs = 600) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await loadAllData();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/** 顯示可重試嘅錯誤畫面（唔會令用戶卡死喺「載入中」）。 */
function showError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  root.innerHTML = `
    <div class="bg-error-panel" role="alert">
      <h2>地圖載入失敗</h2>
      <p class="bg-error-detail">${msg}</p>
      <p class="bg-error-hint">
        常見原因：資料檔未同步或者建置未完成。請喺專案目錄跑
        <code>npm run build</code>（會自動同步資料），然後再試。
      </p>
      <button id="bg-retry-btn" class="bg-retry-btn" type="button">重試</button>
    </div>
  `;
  root.querySelector("#bg-retry-btn")?.addEventListener("click", () => {
    root.innerHTML = '<p id="initial-loading">載入中…</p>';
    void boot();
  });
}

async function boot(): Promise<void> {
  if (!root) return;
  try {
    // 本機 SVG sprite（零 network request）；idempotent。
    mountIconSprite();

    const data = await loadWithRetry();

    /*
     * 單一 state store（規則 S1）。`createUrlEffects()` 令每次 action 將
     * state 投影落 URL（規則 S4 / U5）；node 環境會自動 no-op。
     */
    const store = createAppStore({
      initial: persistedInitialState(),
      effects: createUrlEffects(),
      chapterTotal: data.config.chapters?.total || 198,
    });

    const app = new App(root, data, store);

    // 啟動時由 URL 還原 state（含 legacy `#ch=` / `#loc=` alias，並 canonicalize）。
    app.hydrateFromUrl(new URL(window.location.href));

    // 規則 U6：popstate 還原；hashchange 由 legacy shim 處理。
    app.bindUrlSync();
    initRouter(app);
  } catch (e) {
    console.error("[病港地圖] 初始化失敗", e);
    showError(e);
  }
}

/**
 * 註冊 service worker（只喺 production）。
 *
 * ⚠️ 為何 dev 唔註冊：開發期間 SW 會快取 `dist/` 嘅舊版，令改動睇唔到。
 * `import.meta.env.PROD` 由 Vite 喺 build 時靜態替換，dev 直接跳過。
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((e) => console.warn("[病港地圖] SW 註冊失敗", e));
  });
}

if (root) {
  void boot();
  registerServiceWorker();
}

// 《病港》世界地圖 — World Atlas V2 主入口（B2）
//
// ⚠️ 相對 Phase F 版本嘅改動：
//   1. 只 import B1 嘅 `styles/index.css`（tokens + base），移除舊
//      `main.css` / `timeline.css` / `hud.css`（B1 契約 §3.1）。
//   2. 開機注入本機 SVG sprite（`mountIconSprite()`）。
//   3. bootstrap 單一 state store（`src/state/store.ts`）+ 由 URL 還原 state。
import "./styles/index.css";

/*
 * ══════════════════════════════════════════════════════════════════════════
 * D 舊 CSS 遷移（階段 2–3 完成，2026-09-24）
 * ══════════════════════════════════════════════════════════════════════════
 * `main.css` / `timeline.css` / `hud.css` **已經刪除**。
 *
 * 為何之前唔可以刪：Gate 2 分析（`artifacts/gate2/analyze-legacy-css.py`）
 * 證實佢哋**唔係死碼** —— 有 **158 個 class 仍然被 `src/` 引用**（其中 80 個
 * V2 CSS 完全冇定義，例：`.skip-link`（B8 P0-2）、`.basemap-layer`（Phase L
 * 向量底圖）、`.zd-*`（Zone Dossier 面板））。直接刪會壞。
 *
 * `legacy-migrated.css` 由 `scripts/migrate_legacy_css.py` **自動產生** ——
 * 將嗰 158 個 class 嘅規則由三個舊檔**原文照搬**過嚟（保留 `@media` 上下文
 * 同原本次序）。實測覆蓋 **158 / 158**。
 *
 * ⚠️ 為何「原文照搬 + 同一相對次序」就等價
 * --------------------------------------
 * 舊載入次序係 `tokens → base → main → timeline → hud → chronicle
 * →（map / mobile 由元件注入）`。對任何仍然被引用嘅 class，**舊檔嘅規則係
 * 實際生效嗰條**（同名同特異度之下「後載入者勝」）。
 * 本檔排喺 `base` 之後、`chronicle` 之前 —— 即係**同一個相對位置** →
 * 每一條原本生效嘅規則都仍然存在，而且先後次序不變 → **可證明等價**。
 *
 * （獨立驗證：本腳本自行掃 `src` 底下所有 `.ts` 檔算出「被引用嘅舊 class」
 *   = 158 個，同 Gate 2 分析器嘅 ②80 + ③78 = 158 完全吻合。）
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

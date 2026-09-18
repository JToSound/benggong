// 《病港》互動地圖 — Phase F 主入口
// Single-page app with: Chapter Strip + SVG Map + Story Panel
import "./styles/main.css";
import "./styles/timeline.css";
import { App } from "./app";
import { initRouter } from "./router";
import { loadAllData } from "./data/loadAllData";

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
 * 實測踩過：用戶開住 `localhost:5174`（測試用 preview server），而我喺
 * 另一邊跑建置，就撞到呢個情況。
 *
 * 重試 3 次（間隔 0.6s / 1.2s）足以跨過短暫嘅檔案寫入窗口，同時唔會
 * 令真正嘅錯誤（例如檔案根本唔存在）等太耐。
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
    const data = await loadWithRetry();
    const app = new App(root, data);
    initRouter(app);
  } catch (e) {
    console.error("[病港地圖] 初始化失敗", e);
    showError(e);
  }
}

/**
 * 註冊 service worker（只喺 production）。
 *
 * ⚠️ 為何 dev 唔註冊：開發期間 SW 會快取 `dist/` 嘅舊版，令改動
 * 睇唔到 —— 呢個係好常見嘅陷阱（「明明改咗但畫面冇變」）。
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

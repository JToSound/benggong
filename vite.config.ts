import { configDefaults, defineConfig } from "vitest/config";

// 《病港》互動地圖 Vite 設定
// GitHub Pages base path 由 .env 嘅 VITE_BASE_PATH 控制
export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  build: {
    outDir: "dist",
    sourcemap: false,
    /*
     * V2（B3）：改為 `true`。
     * ----------------------
     * 舊註解（已失效）講：本機 `rm` 被安全刪除 shim 攔截，而 shim 喺
     * `dist/assets` 被 `vite preview` 鎖住時會 fail-closed，令 `vite build`
     * 靜默失敗。實測（2026-09-21）該問題已經可以由 `npm run clean`
     * （純 node `fs.rmSync`，唔經 `rm` shim）處理，而且 A8 P1-5 量到
     * `emptyOutDir: false` 令 `dist/` 累積 **4.66 MB stale bundle**
     * （49 個舊 `index-*.js` + 17 個舊 CSS）。
     *
     * 改成 `true` 之後，`vite build` 會自動清空 `dist/`，stale bundle = 0。
     * 若果喺某部機真係因為檔案鎖而 build 失敗，跑 `npm run clean` 再 build。
     */
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: "node",
    globalSetup: "./tests/e2e.global-setup.ts",
    /*
     * ⚠️ 測試檔案**唔可以並行**。
     *
     * 三個 e2e 檔案各自開一個 Chromium，仲要共用一個 preview server。
     * 並行嘅話 CPU 爭奪會令個別測試由 25 秒變成超過 120 秒逾時 ——
     * 實測 `visual-smoke.e2e.test.ts` 單獨跑 14 項全過，同其他檔案
     * 一齊跑就有 2 項逾時。呢類「假失敗」比慢更難處理。
     */
    fileParallelism: false,
    /*
     * ⚠️ 排除 `artifacts/`。
     *
     * Phase 1 嘅審計子代理（A1–A10）將可重跑嘅 Playwright 檢查寫入
     * `artifacts/` 之下（各 A 一個子目錄），部分檔名以 `.test.ts` 結尾。
     * 呢啲係**對現行 production 刻意 FAIL** 嘅驗收規格（例如 A7 嘅
     * `v2-mobile-a11y.e2e.test.ts` 用 `EXPECT_FAIL` 標記），唔屬 production
     * 測試套件。唔排除嘅話 `npm run test` 會長期紅燈，令真正嘅回歸信號被淹沒。
     *
     * 呢啲檢查由 B9 整理成正式測試之後，會搬入 `tests/`。
     *
     * ⚠️ 另外排除 `dist-stale-` 開頭嘅目錄 —— 嗰啲係 `mv dist dist-stale-<ts>`
     * 繞法留低嘅舊 bundle（本機 safe-delete shim 會擋 `fs.rmSync`，所以要 `mv`
     * 而唔係刪）。唔排除嘅話，舊 bundle 內嘅檔會被掃到而爆幾百個 lint error。
     *
     * ⚠️ **但係實測呢個 glob 喺 vitest 之下收唔到**（B6 寫探針檔入
     * `dist-stale-testprobe` 之下，仍然被收集）→ **唔構成硬保證**。
     * 真正嘅保護係「跑完 build 記得清走嗰啲目錄」。
     * 保留呢條係防禦性聲明 —— 若 vitest 日後修好 glob 行為就會生效。
     */
    exclude: [...configDefaults.exclude, "artifacts/**", "dist/**", "dist-stale-*/**"],
  },
});

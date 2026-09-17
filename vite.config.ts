import { defineConfig } from "vitest/config";

// 《病港》互動地圖 Vite 設定
// GitHub Pages base path 由 .env 嘅 VITE_BASE_PATH 控制
export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  build: {
    outDir: "dist",
    sourcemap: false,
    /*
     * 為何唔自動清空 outDir
     * --------------------
     * 本機環境嘅 `rm` 被安全刪除 shim 攔截，而 shim 喺 `dist/assets` 被
     * `vite preview` 鎖住時會 fail-closed（"Some operations were aborted"）。
     * 結果 `vite build` **靜默失敗** —— 我一路以為建置成功，實際瀏覽器
     * 一直跑舊 bundle，令好幾個前端修正「做咗但睇唔到」。
     *
     * 停用自動清空之後，build 唔會再因為刪唔到而失敗。舊嘅 hash 檔會
     * 累積，用 `npm run clean` 清理。
     */
    emptyOutDir: false,
  },
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: "node",
    globalSetup: "./tests/e2e.global-setup.ts",
  },
});

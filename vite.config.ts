import { defineConfig } from "vitest/config";

// 《病港》互動地圖 Vite 設定
// GitHub Pages base path 由 .env 嘅 VITE_BASE_PATH 控制
export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: "index.html",
        timeline: "timeline.html",
      },
    },
  },
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: "node",
  },
});

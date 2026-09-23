import tseslint from "typescript-eslint";

// 《病港》互動地圖 ESLint flat config
export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    /*
     * ⚠️ `artifacts/` 必須排除（主代理 2026-09-21）。
     *
     * Phase 1 嘅審計子代理（A1–A10）將可重跑嘅 Playwright／Node 探測腳本
     * 寫入 `artifacts/` 之下。呢啲係**審計證據**，唔屬 production 程式碼，
     * 而且部分係刻意寫成最小依賴（會撞 unused-vars 等規則）。
     * 唔排除嘅話 `npm run lint` 會長期有 16 個 error，令真正嘅 lint 信號
     * 被淹沒（同 `vite.config.ts` 排除 `artifacts/**` 係同一個理由）。
     */
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "artifacts/",
      "data/private/**",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);

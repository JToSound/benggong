/**
 * theme-tokens.ts — `src/styles/tokens.css` 嘅 **TS mirror**。
 *
 * 為何要有呢個檔（規則 T2）
 * ========================
 * Canvas 2D **讀唔到 CSS custom properties** —— `ctx.fillStyle = "var(--safe)"`
 * 係無效嘅。所以底圖配色一定要有一份 TS 常數。
 *
 * 但兩份權威就會漂移（A2 S1：五套互斥顏色權威並存）。解法：
 *   · 本檔嘅每個色值**逐個**同 `tokens.css` 一致；
 *   · `tests/theme-token-parity.test.ts` 讀 `tokens.css` 文字，逐個斷言相等；
 *   · 任何人改 CSS 而唔改本檔 → 測試即刻 fail（零人手覆核）。
 *
 * 下游（B5）應該：
 *   import { PALETTE_DARK, PALETTE_LIGHT } from "../theme-tokens";
 * 而**唔可以**再喺 `VectorBasemap.ts` 自己定義 `PALETTE_*`。
 */

import type { Theme } from "./theme";

/** 底圖配色形狀（同原本 `VectorBasemap.ts` 內部嘅 `BasemapPalette` 一致，方便遷移）。 */
export interface BasemapPalette {
  seaTop: string;
  seaBottom: string;
  land: string;
  landHi: string;
  coast: string;
  coastGlow: string;
  green: string;
  industrial: string;
  water: string;
  waterEdge: string;
  bld: [string, string, string, string];
  bldEdge: string;
  label: [string, string, string, string, string, string];
  labelHalo: string;
  grid: string;
  vignette: string;
  roads: Array<{ w: number; color: string; glow: number }>;
}

/** 道路螢幕粗細／發光（唔係顏色，唔需要 parity）。 */
export const ROAD_STYLE: ReadonlyArray<{ w: number; glow: number }> = [
  { w: 3.0, glow: 5 },
  { w: 2.4, glow: 3 },
  { w: 1.9, glow: 1.5 },
  { w: 1.5, glow: 0 },
  { w: 1.2, glow: 0 },
  { w: 0.85, glow: 0 },
  { w: 0.65, glow: 0 },
  { w: 0.5, glow: 0 },
];

/**
 * `:root`（dark）嘅全部顏色 token。
 * ⚠️ 只可以放**顏色**；parity 測試會斷言呢個 map 同 `tokens.css` 嘅
 *    顏色宣告**完全一致**（唔多、唔少）。
 */
export const TOKEN_COLORS_DARK: Readonly<Record<string, string>> = {
  "--bg-base": "#0b0f14",
  "--bg-surface": "#121820",
  "--bg-elevated": "#1a2230",
  "--bg-overlay": "rgba(6,10,14,0.72)",

  "--border-subtle": "#232c3a",
  "--border-strong": "#33404f",

  "--text-primary": "#e8eef5",
  "--text-secondary": "#9fb0c2",
  "--text-muted": "#7d8fa3",
  "--text-inverse": "#0b0f14",

  "--accent": "#4fd1c5",
  "--accent-strong": "#38e8ff",
  "--danger": "#e5484d",
  "--danger-soft": "#7f2c30",
  "--safe": "#3fb950",
  "--warn": "#d9a341",
  "--unknown": "#7c8794",
  "--focus-ring": "#7dd3fc",

  "--zone-survivor": "#3fb950",
  "--zone-nest": "#e5484d",
  "--zone-quarantine": "#d9a341",
  "--zone-contested": "#a86bd6",
  "--zone-unknown": "#7c8794",
  "--zone-survivor-fill": "rgba(63,185,80,0.12)",
  "--zone-nest-fill": "rgba(229,72,77,0.16)",
  "--zone-quarantine-fill": "rgba(217,163,65,0.12)",
  "--zone-contested-fill": "rgba(168,107,214,0.12)",
  "--zone-unknown-fill": "rgba(124,135,148,0.08)",

  "--bm-sea-top": "#04080f",
  "--bm-sea-bottom": "#071120",
  "--bm-land": "#1b222c",
  "--bm-land-hi": "#28313d",
  "--bm-coast": "rgba(104,220,240,0.55)",
  "--bm-coast-glow": "rgba(60,170,200,0.22)",
  "--bm-green": "rgba(28,72,54,0.72)",
  "--bm-industrial": "rgba(66,52,40,0.62)",
  "--bm-water": "#071120",
  "--bm-water-edge": "rgba(74,158,196,0.32)",
  "--bm-bld-1": "rgba(126,168,200,0.14)",
  "--bm-bld-2": "rgba(132,178,212,0.22)",
  "--bm-bld-3": "rgba(146,196,232,0.3)",
  "--bm-bld-4": "rgba(162,214,246,0.4)",
  "--bm-bld-edge": "rgba(110,180,215,0.26)",
  "--bm-label-1": "#e8f4ff",
  "--bm-label-2": "#cfe6f5",
  "--bm-label-3": "#b9d6e8",
  "--bm-label-4": "#a8c6da",
  "--bm-label-5": "#94b4c8",
  "--bm-label-6": "#8aa8bc",
  "--bm-label-halo": "rgba(6,12,20,0.85)",
  "--bm-grid": "rgba(70,140,180,0.055)",
  "--bm-vignette": "rgba(0,0,0,0.55)",
  "--bm-road-1": "#ffc061",
  "--bm-road-2": "#e0a052",
  "--bm-road-3": "#b8845a",
  "--bm-road-4": "#7d8a97",
  "--bm-road-5": "#67717d",
  "--bm-road-6": "#4b545f",
  "--bm-road-7": "#3c444d",
  "--bm-road-8": "#343b43",
  "--bm-road-trunk": "#d9a341",

  "--grid-line": "rgba(120,190,220,0.055)",
  "--grid-line-strong": "rgba(120,190,220,0.1)",
  "--scanline": "rgba(255,255,255,0.03)",

  "--glass": "rgba(18,24,32,0.86)",
  "--glass-solid": "rgba(18,24,32,0.97)",
};

/** `[data-theme="light"]` 嘅覆蓋顏色 token。 */
export const TOKEN_COLORS_LIGHT: Readonly<Record<string, string>> = {
  "--bg-base": "#f5f2ec",
  "--bg-surface": "#ffffff",
  "--bg-elevated": "#faf8f4",
  "--bg-overlay": "rgba(20,24,28,0.48)",

  "--border-subtle": "#e2ddd3",
  "--border-strong": "#c8c1b4",

  "--text-primary": "#1b1f26",
  "--text-secondary": "#4a525e",
  "--text-muted": "#5f6873",
  "--text-inverse": "#f5f2ec",

  "--accent": "#0c6f88",
  "--accent-strong": "#0a6b85",
  "--danger": "#c62a2f",
  "--danger-soft": "#f3d6d6",
  "--safe": "#1f7a33",
  "--warn": "#8a6414",
  "--unknown": "#71777f",
  "--focus-ring": "#0b5f80",

  "--zone-survivor": "#1f7a33",
  "--zone-nest": "#c62a2f",
  "--zone-quarantine": "#8a6414",
  "--zone-contested": "#7a4fa3",
  "--zone-unknown": "#71777f",
  "--zone-survivor-fill": "rgba(31,122,51,0.12)",
  "--zone-nest-fill": "rgba(198,42,47,0.16)",
  "--zone-quarantine-fill": "rgba(138,100,20,0.12)",
  "--zone-contested-fill": "rgba(122,79,163,0.12)",
  "--zone-unknown-fill": "rgba(113,119,127,0.08)",

  "--bm-sea-top": "#c3d2e0",
  "--bm-sea-bottom": "#aec1d3",
  "--bm-land": "#eef1f3",
  "--bm-land-hi": "#f8fafb",
  "--bm-coast": "rgba(40,96,130,0.55)",
  "--bm-coast-glow": "rgba(60,130,170,0.18)",
  "--bm-green": "rgba(150,200,160,0.6)",
  "--bm-industrial": "rgba(205,186,166,0.55)",
  "--bm-water": "#c8d8e6",
  "--bm-water-edge": "rgba(60,120,160,0.35)",
  "--bm-bld-1": "rgba(90,110,130,0.16)",
  "--bm-bld-2": "rgba(80,100,122,0.24)",
  "--bm-bld-3": "rgba(70,92,116,0.32)",
  "--bm-bld-4": "rgba(58,80,106,0.42)",
  "--bm-bld-edge": "rgba(60,90,120,0.28)",
  "--bm-label-1": "#12202e",
  "--bm-label-2": "#1c2c3c",
  "--bm-label-3": "#28394a",
  "--bm-label-4": "#354857",
  "--bm-label-5": "#435766",
  "--bm-label-6": "#4f6373",
  "--bm-label-halo": "rgba(248,250,251,0.9)",
  "--bm-grid": "rgba(40,90,130,0.07)",
  "--bm-vignette": "rgba(40,60,80,0.2)",
  "--bm-road-1": "#d98a1f",
  "--bm-road-2": "#c47f2c",
  "--bm-road-3": "#a8763f",
  "--bm-road-4": "#8b9199",
  "--bm-road-5": "#7c848c",
  "--bm-road-6": "#9aa2ab",
  "--bm-road-7": "#a8b0b8",
  "--bm-road-8": "#b3bac1",
  "--bm-road-trunk": "#8a6414",

  "--grid-line": "rgba(40,80,110,0.07)",
  "--grid-line-strong": "rgba(40,80,110,0.12)",
  "--scanline": "rgba(0,0,0,0.022)",

  "--glass": "rgba(255,255,255,0.86)",
  "--glass-solid": "rgba(255,255,255,0.97)",
};

/**
 * Motion token mirror（同 `tokens.css` §2.3 一致）。
 * `src/motion.ts` 由此讀值，確保 CSS 同 JS 用同一 scale。
 */
export const MOTION_TOKENS = {
  durFast: 120,
  durNormal: 220,
  durSlow: 420,
  easeStandard: "cubic-bezier(0.2, 0, 0, 1)",
  easeEmphasis: "cubic-bezier(0.3, 0, 0, 1.1)",
} as const;

/** 由 token map 砌底圖配色（唔喺呢度重複寫 literal，避免第二份權威）。 */
function buildPalette(c: Readonly<Record<string, string>>): BasemapPalette {
  const roads = ROAD_STYLE.map((s, i) => ({
    w: s.w,
    glow: s.glow,
    color: c[`--bm-road-${i + 1}`],
  }));
  return {
    seaTop: c["--bm-sea-top"],
    seaBottom: c["--bm-sea-bottom"],
    land: c["--bm-land"],
    landHi: c["--bm-land-hi"],
    coast: c["--bm-coast"],
    coastGlow: c["--bm-coast-glow"],
    green: c["--bm-green"],
    industrial: c["--bm-industrial"],
    water: c["--bm-water"],
    waterEdge: c["--bm-water-edge"],
    bld: [
      c["--bm-bld-1"],
      c["--bm-bld-2"],
      c["--bm-bld-3"],
      c["--bm-bld-4"],
    ],
    bldEdge: c["--bm-bld-edge"],
    label: [
      c["--bm-label-1"],
      c["--bm-label-2"],
      c["--bm-label-3"],
      c["--bm-label-4"],
      c["--bm-label-5"],
      c["--bm-label-6"],
    ],
    labelHalo: c["--bm-label-halo"],
    grid: c["--bm-grid"],
    vignette: c["--bm-vignette"],
    roads,
  };
}

export const PALETTE_DARK: BasemapPalette = buildPalette(TOKEN_COLORS_DARK);
export const PALETTE_LIGHT: BasemapPalette = buildPalette(TOKEN_COLORS_LIGHT);

/** 主題 → 底圖配色。 */
export const MAP_PALETTE: Record<Theme, BasemapPalette> = {
  dark: PALETTE_DARK,
  light: PALETTE_LIGHT,
};

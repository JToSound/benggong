/**
 * theme-token-parity.test.ts — 防止 token 漂移（防 5 套顏色權威重現）。
 *
 * 為何呢個測試係關鍵（A2 S1）
 * ========================
 * 現況有 5 套互斥顏色權威：`--accent-*`（legacy 7 色）、`--hud-*`（7 色）、
 * `--color-*`（12 個從未定義嘅死 token）、canvas `PALETTE_DARK/LIGHT`、
 * TS inline 61 個 distinct hex。
 *
 * V2 嘅解法：`tokens.css` 係唯一定義處，`theme-tokens.ts` 係 canvas 用嘅
 * 手動 mirror。本測試逐個值斷言兩者一致 —— 任何人改 CSS 而唔改 TS，
 * 測試即刻 fail（零人手覆核）。
 *
 * 另外斷言對比度契約（spec §7.3 / §9）：文字 ≥4.5:1、非文字語意色 ≥3:1。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TOKEN_COLORS_DARK,
  TOKEN_COLORS_LIGHT,
  MOTION_TOKENS,
  PALETTE_DARK,
  PALETTE_LIGHT,
} from "../src/theme-tokens";

const CSS_PATH = resolve(__dirname, "../src/styles/tokens.css");
const RAW_CSS = readFileSync(CSS_PATH, "utf-8");
// 先剝走註解，避免註解內嘅 ":root" / "[data-theme=…]" 干擾解析。
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** 抽第一個匹配 selector 嘅 `{ … }` 內容。 */
function firstBlock(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `tokens.css 搵唔到 selector: ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  expect(open, `${selector} 冇 "{"`).toBeGreaterThan(-1);
  expect(close, `${selector} 冇 "}"`).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

/** 抽 block 內全部 `--name: value;` 宣告。 */
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[`--${m[1]}`] = m[2].trim().replace(/\s+/g, " ");
  }
  return out;
}

const isColor = (v: string): boolean => /^#|^rgb|^hsl/i.test(v.trim());
const norm = (v: string): string => v.replace(/\s+/g, "").toLowerCase();

function normalizeMap(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, norm(v)]));
}

const ROOT = declarations(firstBlock(CSS, ":root"));
const LIGHT = declarations(firstBlock(CSS, '[data-theme="light"]'));

function colorsOf(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => isColor(v)));
}

/* ─────────────────────────────────────────────────────────────────────────
   Contrast helpers（WCAG 2.x）
   ───────────────────────────────────────────────────────────────────────── */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_SURFACES = ["--bg-base", "--bg-surface", "--bg-elevated"];
const LIGHT_SURFACES = ["--bg-base", "--bg-surface", "--bg-elevated"];
const TEXT_TOKENS = ["--text-primary", "--text-secondary", "--text-muted"];
const SEMANTIC_TOKENS = [
  "--accent",
  "--accent-strong",
  "--danger",
  "--safe",
  "--warn",
  "--unknown",
  "--focus-ring",
  "--zone-survivor",
  "--zone-nest",
  "--zone-quarantine",
  "--zone-contested",
  "--zone-unknown",
];

/* ─────────────────────────────────────────────────────────────────────────
   Tests
   ───────────────────────────────────────────────────────────────────────── */

describe("tokens.css ↔ theme-tokens.ts parity", () => {
  it("dark 顏色 token 完全一致（唔多、唔少、唔漂移）", () => {
    expect(normalizeMap(colorsOf(ROOT))).toEqual(normalizeMap({ ...TOKEN_COLORS_DARK }));
  });

  it("light 顏色 token 完全一致", () => {
    expect(normalizeMap(colorsOf(LIGHT))).toEqual(normalizeMap({ ...TOKEN_COLORS_LIGHT }));
  });

  it("light 只可以覆蓋 dark 已有嘅 token（唔可以無中生有）", () => {
    const darkKeys = new Set(Object.keys(ROOT));
    for (const k of Object.keys(LIGHT)) {
      expect(darkKeys.has(k), `light 多咗 dark 冇嘅 token: ${k}`).toBe(true);
    }
  });

  it("dark 同 light 嘅顏色 token 鍵集合一致（同一套語意）", () => {
    expect(Object.keys(TOKEN_COLORS_LIGHT).sort()).toEqual(
      Object.keys(TOKEN_COLORS_DARK).sort(),
    );
  });

  it("motion token 同 CSS 一致（3 duration + 2 easing，規則 M1）", () => {
    expect(Number.parseInt(ROOT["--dur-fast"], 10)).toBe(MOTION_TOKENS.durFast);
    expect(Number.parseInt(ROOT["--dur-normal"], 10)).toBe(MOTION_TOKENS.durNormal);
    expect(Number.parseInt(ROOT["--dur-slow"], 10)).toBe(MOTION_TOKENS.durSlow);
    expect(norm(ROOT["--ease-standard"])).toBe(norm(MOTION_TOKENS.easeStandard));
    expect(norm(ROOT["--ease-emphasis"])).toBe(norm(MOTION_TOKENS.easeEmphasis));
  });

  it("只有 3 個 duration + 2 條 easing（唔准多）", () => {
    const dur = Object.keys(ROOT).filter((k) => k.startsWith("--dur-"));
    const ease = Object.keys(ROOT).filter((k) => k.startsWith("--ease-"));
    expect(dur.sort()).toEqual(["--dur-fast", "--dur-normal", "--dur-slow"]);
    expect(ease.sort()).toEqual(["--ease-emphasis", "--ease-standard"]);
  });

  it("PALETTE_DARK / PALETTE_LIGHT 由 token map 派生（canvas 唔可以自持色值）", () => {
    expect(PALETTE_DARK.land).toBe(TOKEN_COLORS_DARK["--bm-land"]);
    expect(PALETTE_DARK.water).toBe(TOKEN_COLORS_DARK["--bm-water"]);
    expect(PALETTE_DARK.grid).toBe(TOKEN_COLORS_DARK["--bm-grid"]);
    expect(PALETTE_DARK.label).toEqual([
      TOKEN_COLORS_DARK["--bm-label-1"],
      TOKEN_COLORS_DARK["--bm-label-2"],
      TOKEN_COLORS_DARK["--bm-label-3"],
      TOKEN_COLORS_DARK["--bm-label-4"],
      TOKEN_COLORS_DARK["--bm-label-5"],
      TOKEN_COLORS_DARK["--bm-label-6"],
    ]);
    expect(PALETTE_DARK.roads.map((r) => r.color)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => TOKEN_COLORS_DARK[`--bm-road-${i}`]),
    );
    expect(PALETTE_LIGHT.land).toBe(TOKEN_COLORS_LIGHT["--bm-land"]);
    expect(PALETTE_LIGHT.roads.map((r) => r.color)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => TOKEN_COLORS_LIGHT[`--bm-road-${i}`]),
    );
  });
});

describe("對比度契約（spec §7.3 / §9：文字 ≥4.5:1、非文字 ≥3:1）", () => {
  it("dark 文字 token 對三個表面全部 ≥4.5:1", () => {
    for (const t of TEXT_TOKENS) {
      for (const bg of DARK_SURFACES) {
        const ratio = contrast(TOKEN_COLORS_DARK[t], TOKEN_COLORS_DARK[bg]);
        expect(
          ratio,
          `dark ${t} on ${bg} = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("light 文字 token 對三個表面全部 ≥4.5:1", () => {
    for (const t of TEXT_TOKENS) {
      for (const bg of LIGHT_SURFACES) {
        const ratio = contrast(TOKEN_COLORS_LIGHT[t], TOKEN_COLORS_LIGHT[bg]);
        expect(
          ratio,
          `light ${t} on ${bg} = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("dark 語意色對 bg-base ≥3:1（非文字 UI 門檻）", () => {
    for (const t of SEMANTIC_TOKENS) {
      const ratio = contrast(TOKEN_COLORS_DARK[t], TOKEN_COLORS_DARK["--bg-base"]);
      expect(ratio, `dark ${t} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it("light 語意色對 bg-base ≥3:1", () => {
    for (const t of SEMANTIC_TOKENS) {
      const ratio = contrast(TOKEN_COLORS_LIGHT[t], TOKEN_COLORS_LIGHT["--bg-base"]);
      expect(ratio, `light ${t} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it("text-inverse 喺 accent 底上 ≥4.5:1（兩主題）", () => {
    const d = contrast(TOKEN_COLORS_DARK["--text-inverse"], TOKEN_COLORS_DARK["--accent"]);
    const l = contrast(TOKEN_COLORS_LIGHT["--text-inverse"], TOKEN_COLORS_LIGHT["--accent"]);
    expect(d, `dark = ${d.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    expect(l, `light = ${l.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("tokens.css 結構契約", () => {
  it("dark 係 :root 預設（dark-first），有 color-scheme: dark", () => {
    expect(RAW_CSS).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*dark/);
  });

  it("light 由 [data-theme=\"light\"] 覆蓋，有 color-scheme: light", () => {
    expect(RAW_CSS).toMatch(/\[data-theme="light"\]\s*\{[\s\S]*?color-scheme:\s*light/);
  });

  it("spacing 有 7 級、radius 4 級、z-index 齊 spec §2.2 全部層級", () => {
    const sp = Object.keys(ROOT).filter((k) => /^--sp-\d+$/.test(k));
    const r = Object.keys(ROOT).filter((k) => k.startsWith("--radius-"));
    const z = Object.keys(ROOT).filter((k) => k.startsWith("--z-"));
    expect(sp.length).toBe(7);
    expect(r.length).toBe(4);
    // spec §2.2 列出 8 個 z token（map → toast），由低到高連續。
    expect(z.sort()).toEqual([
      "--z-controls",
      "--z-header",
      "--z-map",
      "--z-map-overlay",
      "--z-modal",
      "--z-panel",
      "--z-sheet",
      "--z-toast",
    ]);
  });

  it("tokens.css 冇任何 online asset（零外部依賴）", () => {
    expect(RAW_CSS).not.toMatch(/https?:\/\//);
    expect(RAW_CSS).not.toMatch(/@import/);
    expect(RAW_CSS).not.toMatch(/url\(/);
  });
});

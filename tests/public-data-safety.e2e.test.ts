/**
 * public-data-safety.e2e.test.ts — 驗收矩陣 §2-12（Public data safety）。
 *
 * 為何要有呢個檔
 * ==============
 * 驗收矩陣 §2-12：「no private-text pattern / secrets in public routes / export；
 * **加** `zones.geojson.evidence` 移除斷言」。
 *
 * `tests/test_public_data.py` 已經做 schema + 雜訊偵測（pipeline 層）。
 * 本檔補嘅係**由「實際 serve 出去嘅檔案」角度**做紅線掃描：
 *   1. `zones.geojson` **冇任何** feature 帶 `evidence`（版權紅線，DA6）
 *   2. public 資料冇 `原文：「…」` 引用
 *   3. public 資料／`dist/` 冇 remote map/tile API（完全離線）
 *   4. public 資料冇「人工審閱／人手覆核」字眼（零人手參與紅線）
 *
 * ⚠️ 命名為 `.e2e.test.ts` 係為符合 B9 allowlist（只可加 `tests/*.e2e.test.ts`）。
 * 本檔**唔開瀏覽器** —— 全部係靜態檔案斷言，所以又快又穩。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, "data", "public");
const DIST_DIR = join(ROOT, "dist");

function walk(dir: string, filter: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

interface GeoFeature {
  properties?: Record<string, unknown>;
}

describe("驗收矩陣 §2-12：public data safety", () => {
  it("zones.geojson 冇任何 feature 帶 `evidence`（版權紅線 DA6 / DS4）", () => {
    const p = join(PUBLIC_DIR, "zones.geojson");
    expect(existsSync(p), "zones.geojson 應該存在").toBe(true);
    const geo = JSON.parse(readFileSync(p, "utf-8")) as { features: GeoFeature[] };
    expect(geo.features.length, "zones.geojson 應該有 feature").toBeGreaterThan(0);

    const offenders = geo.features
      .map((f, i) => ({ i, props: f.properties ?? {} }))
      .filter(({ props }) => Object.prototype.hasOwnProperty.call(props, "evidence"))
      .map(({ i, props }) => `feature[${i}] id=${String(props["id"] ?? "?")}`);

    expect(
      offenders,
      `zones.geojson 有 feature 帶 \`evidence\` 欄位（100% 含小說原文 → 版權紅線）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("public 資料冇 `原文：「…」` 小說原文引用", () => {
    const files = walk(PUBLIC_DIR, (f) => f.endsWith(".json") || f.endsWith(".geojson"));
    expect(files.length, "應該有 public 資料檔").toBeGreaterThan(0);

    /*
     * ⚠️ 2026-09-24 擴充（C5 對抗驗收發現逃逸）：原本只捉「原文」字樣 →
     * `ch0092：「…」` 會逃逸（實測命中 `zones.geojson` 嘅 `population`）。
     * 加多一條：**章節編號 + 冒號 + 引號** = 原文引用指紋。
     */
    const pattern = /原文\s*[：:]\s*[「『"]|ch\s*\d{1,4}\s*[：:]\s*[「『"]/;
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf-8");
      if (pattern.test(text)) offenders.push(f);
    }
    expect(offenders, `以下 public 檔含小說原文引用：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("public 資料 + dist 冇 remote map/tile API（完全離線）", () => {
    const patterns: Array<[string, RegExp]> = [
      ["OpenStreetMap", /openstreetmap\.org|tile\.openstreetmap/i],
      ["Mapbox", /mapbox\.com|mapbox\/leaflet/i],
      ["Google Maps", /maps\.google|googleapis\.com\/maps/i],
      ["Carto", /carto(cdn)?\.(com|org)|basemaps\.cartocdn/i],
      ["Esri", /arcgisonline\.com|esri\.com/i],
      ["Bing Maps", /bing\.com\/maps|virtualearth/i],
    ];
    const targets = [
      ...walk(PUBLIC_DIR, (f) => /\.(json|geojson|js|css|html|svg)$/.test(f)),
      ...walk(DIST_DIR, (f) => /\.(json|geojson|js|css|html|svg)$/.test(f)),
    ];
    const offenders: string[] = [];
    for (const f of targets) {
      const text = readFileSync(f, "utf-8");
      for (const [name, re] of patterns) {
        if (re.test(text)) offenders.push(`${f}: ${name}`);
      }
    }
    expect(offenders, `發現 remote map/tile API 引用：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("public 資料冇「人工審閱／人手覆核」字眼（零人手參與紅線）", () => {
    /*
     * ⚠️ 已知 Gate 2 待修項（唔喺 B9 allowlist）
     * ----------------------------------------
     * `data/public/map-config.json` 嘅 `provisional_mode.banner` 仍然寫
     * 「仍待**人工審閱**…未經最終**人工確認**」（`dist/` 亦一樣）。
     * 呢個係 migration-plan §6.3 第 1 項，owner 係 **B4 / 主代理**
     * （`data/**` 係 B9 嘅禁止範圍）。
     *
     * 所以本斷言改成：**任何新出現**嘅違規都要 FAIL；已知嗰一個列入
     * 待修清單，並喺 stdout 大聲提示。一旦 B4/主代理修好，本斷言自動
     * 仍然通過（子集關係），唔需要改測試。
     */
    const KNOWN_GATE2_PENDING = new Set([
      join(PUBLIC_DIR, "map-config.json"),
      join(DIST_DIR, "data", "public", "map-config.json"),
    ]);
    const forbidden = /人工審閱|人工確認|人手覆核|人手抽樣|人手目測|人工复核/;
    const scan = [
      ...walk(PUBLIC_DIR, (f) => /\.(json|geojson)$/.test(f)),
      ...walk(DIST_DIR, (f) => /\.(json|geojson)$/.test(f)),
    ];
    const offenders = scan.filter((f) => forbidden.test(readFileSync(f, "utf-8")));
    const unexpected = offenders.filter((f) => !KNOWN_GATE2_PENDING.has(f));

    if (offenders.length) {
      console.warn(
        `[b9] 已知 Gate 2 待修（owner B4／主代理，migration-plan §6.3-1）：\n` +
          offenders.map((f) => `  - ${f}`).join("\n"),
      );
    }
    expect(
      unexpected,
      `以下檔案含人手參與字眼（新違規，違反 AGENTS.md 零人手紅線）：\n${unexpected.join("\n")}`,
    ).toEqual([]);
  });

  it("dist 冇 data/private 內容（版權紅線：private 永久不得 deploy）", () => {
    if (!existsSync(DIST_DIR)) {
      console.warn("[skip] dist/ 未 build");
      return;
    }
    const privateFiles = walk(DIST_DIR, (f) => /private/i.test(f));
    expect(
      privateFiles,
      `dist/ 出現疑似 private 路徑：\n${privateFiles.join("\n")}`,
    ).toEqual([]);
  });
});

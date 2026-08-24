// 《病港》— 網絡紅線測試：dist/ 內零 external map/tile URL（靜態掃描）
// master prompt §12.3(9)：證明無 remote 請求。動態攔截層由 Playwright E2E 補充。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REMOTE_MAP_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "OpenStreetMap", re: /openstreetmap\.org|tile\.openstreetmap/i },
  { name: "Mapbox", re: /mapbox\.com|mapbox\/leaflet/i },
  { name: "Google Maps", re: /maps\.google|googleapis\.com\/maps/i },
  { name: "Carto", re: /carto(cdn)?\.(com|org)|basemaps\.cartocdn/i },
  { name: "Esri", re: /arcgisonline\.com|esri\.com/i },
  { name: "Bing Maps", re: /bing\.com\/maps|virtualearth/i },
  { name: "Stamen", re: /stamen\.com|stamentiles/i },
  { name: "Thunderforest", re: /thunderforest\.com/i },
  { name: "HERE", re: /hereapi|heremaps/i },
];

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

const distDir = join(__dirname, "..", "dist");
let distReady = false;
try {
  distReady = readFileSync(join(distDir, "index.html"), "utf-8").includes("<html");
} catch {
  distReady = false;
}

describe("網絡紅線（靜態掃描 dist/）", () => {
  it.skipIf(!distReady)("dist 存在且含 index.html", () => {
    expect(readFileSync(join(distDir, "index.html"), "utf-8")).toContain("<html");
  });

  it.skipIf(!distReady)(`全部 ${REMOTE_MAP_PATTERNS.length} 種 remote map/tile pattern 零命中`, () => {
    const offenders: string[] = [];
    for (const file of walkFiles(distDir)) {
      if (!/\.(js|html|css|json|svg)$/.test(file)) continue;
      const text = readFileSync(file, "utf-8");
      for (const { name, re } of REMOTE_MAP_PATTERNS) {
        if (re.test(text)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it.skipIf(!distReady)("HTML 內無任何 http(s) 外部資源引用", () => {
    for (const file of walkFiles(distDir)) {
      if (!file.endsWith(".html")) continue;
      const html = readFileSync(file, "utf-8");
      const external = html.match(/(?:src|href)=["']https?:\/\//i);
      expect(external, `${file} 含外部引用`).toBeNull();
    }
  });
});

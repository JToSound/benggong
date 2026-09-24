// C8 P1-4 + F6：Zone Dossier 要真正用 `zone-dossiers.json`，並且誠實標示
//
// 背景（C8 敵意產品審查 2026-09-25）
// =================================
// `data/public/zone-dossiers.json` 有 **48 個豐富 dossier**（每個 14 個欄位），
// 係 B4 + A6 嘅主要交付物。但實測：
//   · `src/data/adapter/index.ts` 有 `loadDossiers()`（lazy、memoized）
//   · **`src/` 從來冇任何地方呼叫過佢** —— 只有定義同測試
//   · `ZoneDossier` component 讀嘅係 `zones.geojson` 嘅**舊 inline 欄位**
// → 「48 個 dossier 白做」，UI 睇落似「換皮」（C8 原話）。
//
// 同時 F6（C5 + C8 都報）：`ZoneDossier.ts` 對 11 個倖存區寫死
// `sub: "人類聚居 · 安全"`，而 48 個 zone 只有 7 個 `validated`
// （31 `auto_inferred`、10 `needs_validation`）→ 推測被呈現成事實，
// 違反 `DATA_GOVERNANCE.md §3`。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOSSIER_TS = readFileSync("src/components/ZoneDossier.ts", "utf-8");
const LOADALL_TS = readFileSync("src/data/loadAllData.ts", "utf-8");
const ZONES = JSON.parse(readFileSync("data/public/zones.geojson", "utf-8")) as {
  features: Array<{ properties: Record<string, unknown> }>;
};
const DOSSIERS = JSON.parse(
  readFileSync("data/public/zone-dossiers.json", "utf-8"),
) as { dossiers: Array<{ zone_id: string; review_status?: string }> };

describe("C8 P1-4：Zone Dossier 接線", () => {
  it("⭐ `loadZoneDossiers()` 存在，而且 `ZoneDossier` 真係呼叫佢", () => {
    expect(LOADALL_TS).toContain("export function loadZoneDossiers(");
    expect(LOADALL_TS).toContain("zone-dossiers.json");
    // component 一定要 import + 呼叫（唔可以只係 import）
    expect(DOSSIER_TS).toContain("loadZoneDossiers");
    expect(DOSSIER_TS).toMatch(/void loadZoneDossiers\(\)/);
  });

  it("⭐ 有 race guard（async 返嚟時唔可以 render 錯 zone）", () => {
    expect(DOSSIER_TS).toContain("this.currentZoneId !== zoneId");
  });

  it("⭐ 豐富 dossier 嘅巢狀欄位有 render（唔止 v1 inline 欄位）", () => {
    expect(DOSSIER_TS).toContain("DOSSIER_GROUPS");
    for (const k of ["governance", "society", "infrastructure", "risk_profile", "nest_profile"]) {
      expect(DOSSIER_TS, `冇 render ${k}`).toContain(k);
    }
  });

  it("資料層：48 個 dossier 全部對得上一個 zone", () => {
    const zoneIds = new Set(ZONES.features.map((f) => f.properties.id as string));
    const orphan = DOSSIERS.dossiers.filter((d) => !zoneIds.has(d.zone_id));
    expect(orphan.map((d) => d.zone_id)).toEqual([]);
    expect(DOSSIERS.dossiers.length).toBe(48);
  });
});

describe("F6：誠實標示", () => {
  it("⭐ 唔可以再寫死「安全」（推測唔可以當事實）", () => {
    // 「人類聚居 · 安全」係 C5/C8 報嘅原文
    expect(DOSSIER_TS).not.toContain("人類聚居 · 安全");
    expect(DOSSIER_TS).not.toMatch(/sub:\s*"[^"]*安全/);
  });

  it("⭐ `zone_review_status` 一定要 render（badge）", () => {
    expect(DOSSIER_TS).toContain("REVIEW_META");
    expect(DOSSIER_TS).toMatch(/REVIEW_META\[p\.zone_review_status/);
    expect(DOSSIER_TS).toContain("zd-review");
  });

  it("⭐ `spatial_precision` 亦要 render", () => {
    expect(DOSSIER_TS).toMatch(/p\.spatial_precision/);
  });

  it("資料層：3 種 `zone_review_status` 都有對應標籤", () => {
    const statuses = new Set(
      ZONES.features
        .map((f) => f.properties.zone_review_status as string | undefined)
        .filter((s): s is string => Boolean(s)),
    );
    expect(statuses.size, "實測應該有 3 種狀態").toBe(3);
    for (const s of statuses) {
      expect(DOSSIER_TS, `REVIEW_META 冇 ${s}`).toContain(`${s}:`);
    }
  });
});

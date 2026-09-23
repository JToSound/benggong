/**
 * A9 QA Adversary —— URL / state 對抗測試（只讀）
 *
 * 目的：逐個實測 spec §5.1 要求嘅 URL 參數，以及 refresh / 無效 ID /
 *       組合 / 編碼 嘅行為。所有結果寫入 artifacts/audit-A9/。
 *
 * 執行：node artifacts/audit-A9/a9-url-state.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";
fs.mkdirSync(OUT, { recursive: true });

// 由真實資料集抽出嘅有效 id（避免用假 id 測「有效」情境）
const IDS = {
  loc: "loc_0029",
  locName: "（loc_0029）",
  event: "bg_event_001",
  zone: "zone_d3f76d3c94", // 大本營 survivor
  zoneNest: "zone_51bf7d8190",
  character: "ann",
};

const SNAPSHOT = () => {
  const q = (s) => document.querySelector(s);
  const err = q(".bg-error-panel");
  const activePill = q("#chapter-strip-mount .ch-pill.active");
  const dossierMount = q("#zone-dossier-mount");
  return {
    href: location.href,
    hash: location.hash,
    search: location.search,
    hasMapSvg: !!q("#svg-map-mount svg"),
    hasCanvas: !!q("#svg-map-mount canvas"),
    hasErrorPanel: !!err,
    errorText: err ? (err.innerText || "").slice(0, 200) : null,
    bodyTextLen: (document.body.innerText || "").length,
    zoneCount: document.querySelectorAll("#svg-map-mount .zone").length,
    markerCount: document.querySelectorAll("#svg-map-mount .location-marker, #svg-map-mount .location-marker-cluster").length,
    eventMarkerCount: document.querySelectorAll("#svg-map-mount .event-marker").length,
    chronicleVisible: !!q("#story-panel-mount .chronicle"),
    chronicleCountText: q("#story-panel-mount .chronicle-count")?.textContent?.trim() || null,
    chronicleEntryCount: document.querySelectorAll("#story-panel-mount .chr-entry").length,
    zoneDossierVisible: !!dossierMount && !dossierMount.hidden,
    zoneName: q("#zone-dossier-mount .zd-name")?.textContent?.trim() || null,
    storyPanelHidden: q("#story-panel-mount")?.hidden ?? null,
    storyTitle: q("#story-panel-mount .story-title")?.textContent?.trim() || null,
    storyLocMeta: q("#story-panel-mount .loc-meta")?.textContent?.trim() || null,
    storyEventMeta: q("#story-panel-mount .event-meta")?.textContent?.trim() || null,
    chapterNum: q("#strip-ch-num")?.textContent || null,
    activeChapter: activePill?.dataset?.ch || null,
    modeBtn: q("#btn-mode")?.textContent?.trim() || null,
    theme: document.documentElement.getAttribute("data-theme"),
    spoilWarnCount: document.querySelectorAll(".spoil-warn").length,
  };
};

async function probe(browser, urlPath, { viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({
    viewport,
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
  });
  const consoleErrors = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const url = BASE.replace(/\/$/, "") + "/" + urlPath;
  let gotoErr = null;
  try {
    await page.goto(url, { waitUntil: "load", timeout: 40000 });
  } catch (e) {
    gotoErr = String(e);
  }
  // 等 app 就緒（成功 → svg；失敗 → error panel）
  await page
    .waitForFunction(
      () => document.querySelector("#svg-map-mount svg") || document.querySelector(".bg-error-panel"),
      { timeout: 30000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1200);

  const snap = await page.evaluate(SNAPSHOT).catch((e) => ({ evalError: String(e) }));
  await context.close();

  const crashed =
    !snap.hasMapSvg && !snap.hasErrorPanel && (snap.bodyTextLen ?? 0) < 60;

  return {
    urlPath,
    gotoErr,
    pageErrors,
    consoleErrors,
    crashed,
    ...snap,
  };
}

// ---- spec §5.1 參數支援測試 ----
const PARAM_CASES = [
  { id: "ch-hash", path: `#ch=150`, spec: "#chapter=<issue_index>（等價）", note: "現行唯一支援格式" },
  { id: "chapter-query", path: `?chapter=150`, spec: "?chapter=<issue_index>", note: "spec 要求嘅 query 格式" },
  { id: "location-hash", path: `#location=${IDS.loc}`, spec: "#location=<id>", note: "spec 要求嘅 hash 格式" },
  { id: "loc-hash", path: `#loc=${IDS.loc}`, spec: "（現行自訂格式）", note: "現行支援" },
  { id: "event-query", path: `?event=${IDS.event}`, spec: "?event=<id>", note: "" },
  { id: "zone-query", path: `?zone=${IDS.zone}`, spec: "?zone=<id>", note: "" },
  { id: "character-query", path: `?character=${IDS.character}`, spec: "?character=<id>", note: "" },
  { id: "spoiler-query", path: `?spoiler=2`, spec: "?spoiler=<0-3>", note: "" },
  { id: "layers-query", path: `?layers=zones,events,routes`, spec: "?layers=zones,events,routes", note: "" },
  { id: "view-map", path: `?view=map`, spec: "?view=map|chronicle", note: "" },
  { id: "view-chronicle", path: `?view=chronicle`, spec: "?view=map|chronicle", note: "" },
];

// ---- 無效輸入測試 ----
const INVALID_CASES = [
  { id: "event-invalid", path: `?event=INVALID` },
  { id: "zone-invalid", path: `?zone=不存在` },
  { id: "zone-invalid-ascii", path: `#loc=zone_zzz` },
  { id: "chapter-99999-hash", path: `#ch=99999` },
  { id: "chapter-99999-query", path: `?chapter=99999` },
  { id: "spoiler-99", path: `?spoiler=99` },
  { id: "spoiler-neg", path: `?spoiler=-1` },
  { id: "view-xyz", path: `?view=xyz` },
  { id: "ch-abc", path: `#ch=abc` },
  { id: "ch-empty", path: `#ch=` },
  { id: "ch-huge", path: `#ch=999999999999999999999` },
  { id: "loc-invalid", path: `#loc=loc_999999` },
  { id: "loc-xss", path: `#loc=%3Cscript%3Ealert(1)%3C/script%3E` },
  { id: "loc-empty", path: `#loc=` },
];

// ---- 組合 / 衝突 / 編碼測試 ----
const COMBO_CASES = [
  { id: "combo-all", path: `#ch=150&loc=${IDS.loc}&event=${IDS.event}&zone=${IDS.zone}&spoiler=2&layers=zones,events&view=map` },
  { id: "conflict-view-event", path: `?view=chronicle&event=${IDS.event}` },
  { id: "conflict-view-zone", path: `?view=map&zone=${IDS.zone}` },
  { id: "hash-and-query", path: `#ch=42&loc=${IDS.loc}?event=${IDS.event}&view=chronicle` },
  { id: "enc-cjk", path: `#loc=${encodeURIComponent("荒廢商場")}` },
  { id: "enc-special", path: `#loc=${encodeURIComponent("loc_0029&x=1")}` },
  { id: "enc-space", path: `#loc=loc%200029` },
  { id: "enc-long", path: `#loc=${"a".repeat(2000)}` },
  { id: "enc-slash", path: `#loc=../etc/passwd` },
];

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const results = { base: BASE, capturedAt: new Date().toISOString(), params: [], invalid: [], combos: [], refresh: [] };

  for (const c of PARAM_CASES) {
    const r = await probe(browser, c.path);
    results.params.push({ ...c, ...r });
    console.log(`[param] ${c.id} (${c.path}) → activeCh=${r.activeChapter} mode=${r.modeBtn} zoneVis=${r.zoneDossierVisible} err=${r.hasErrorPanel} crash=${r.crashed}`);
  }

  for (const c of INVALID_CASES) {
    const r = await probe(browser, c.path);
    results.invalid.push({ ...c, ...r });
    console.log(`[invalid] ${c.id} (${c.path}) → crash=${r.crashed} errPanel=${r.hasErrorPanel} pageErrors=${r.pageErrors.length} activeCh=${r.activeChapter}`);
  }

  for (const c of COMBO_CASES) {
    const r = await probe(browser, c.path);
    results.combos.push({ ...c, ...r });
    console.log(`[combo] ${c.id} → hash="${r.hash}" search="${r.search}" activeCh=${r.activeChapter} mode=${r.modeBtn}`);
  }

  // ---- Refresh 測試 ----
  // 1) #ch=150 → reload 應重現
  // 2) #loc=loc_0029 → reload 應重現
  // 3) UI 選 zone → reload 應重現（URL 有冇寫 zone）
  // 4) UI 選 event → reload
  async function refreshTest(id, setup, describe) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(BASE, { waitUntil: "load", timeout: 40000 });
    await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const before = await setup(page);
    const urlBefore = page.url();
    await page.reload({ waitUntil: "load", timeout: 40000 });
    await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const after = await page.evaluate(SNAPSHOT);
    await context.close();
    return { id, describe, urlBefore, urlAfter: after.href, before, after, pageErrors };
  }

  // 1) chapter via URL
  {
    const r = await refreshTest(
      "refresh-ch-url",
      async (page) => {
        await page.goto(BASE + "#ch=150", { waitUntil: "load" });
        await page.waitForTimeout(1200);
        return await page.evaluate(SNAPSHOT);
      },
      "#ch=150 → reload",
    );
    results.refresh.push(r);
    console.log(`[refresh] ${r.id} beforeCh=${r.before.activeChapter} afterCh=${r.after.activeChapter}`);
  }

  // 2) location via URL
  {
    const r = await refreshTest(
      "refresh-loc-url",
      async (page) => {
        await page.goto(BASE + `#loc=${IDS.loc}`, { waitUntil: "load" });
        await page.waitForTimeout(1200);
        return await page.evaluate(SNAPSHOT);
      },
      `#loc=${IDS.loc} → reload`,
    );
    results.refresh.push(r);
    console.log(`[refresh] ${r.id} beforeTitle=${r.before.storyTitle} afterTitle=${r.after.storyTitle}`);
  }

  // 3) zone via UI click
  {
    const r = await refreshTest(
      "refresh-zone-ui",
      async (page) => {
        // 揀一個有 zone render 嘅章節（大本營 zone 喺 ch1 起 12 章內）
        const clicked = await page.evaluate(() => {
          const z = document.querySelector("#svg-map-mount .zone");
          if (!z) return null;
          z.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return { id: z.getAttribute("data-zone-id"), name: z.getAttribute("data-zone-name") };
        });
        await page.waitForTimeout(800);
        const snap = await page.evaluate(SNAPSHOT);
        return { clicked, snap };
      },
      "UI 點 zone → reload",
    );
    results.refresh.push(r);
    console.log(`[refresh] ${r.id} clicked=${JSON.stringify(r.before.clicked)} urlBefore=${r.urlBefore} afterZoneVis=${r.after.zoneDossierVisible}`);
  }

  // 4) event via UI click
  {
    const r = await refreshTest(
      "refresh-event-ui",
      async (page) => {
        const clicked = await page.evaluate(() => {
          const m = document.querySelector("#svg-map-mount .event-marker");
          if (!m) return null;
          m.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return m.getAttribute("data-event-id");
        });
        await page.waitForTimeout(800);
        const snap = await page.evaluate(SNAPSHOT);
        return { clicked, snap };
      },
      "UI 點 event marker → reload",
    );
    results.refresh.push(r);
    console.log(`[refresh] ${r.id} clicked=${JSON.stringify(r.before.clicked)} urlBefore=${r.urlBefore} afterEventMeta=${r.after.storyEventMeta}`);
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "a9-url-state.json"), JSON.stringify(results, null, 2));
  console.log("\n寫入", path.join(OUT, "a9-url-state.json"));
}

main().catch((e) => {
  console.error("A9 url-state 測試失敗:", e);
  process.exit(1);
});

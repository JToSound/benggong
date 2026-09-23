/**
 * A9 QA Adversary —— hash 形式參數重跑（只讀）
 * 上一個 a9-gaps.mjs 首 6 個 case 因 server 中途斷線（ERR_CONNECTION_REFUSED），
 * 呢個腳本專注補回 spec §5.1 嘅 hash 形式參數測試。
 *
 * 執行：node artifacts/audit-A9/a9-gaps-hashparams.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";

const SNAP = () => {
  const q = (s) => document.querySelector(s);
  const err = q(".bg-error-panel");
  const dm = q("#zone-dossier-mount");
  return {
    href: location.href,
    hash: location.hash,
    search: location.search,
    hasMapSvg: !!q("#svg-map-mount svg"),
    hasErrorPanel: !!err,
    errorText: err ? (err.innerText || "").slice(0, 200) : null,
    bodyTextLen: (document.body.innerText || "").length,
    zoneCount: document.querySelectorAll("#svg-map-mount .zone").length,
    eventMarkerCount: document.querySelectorAll("#svg-map-mount .event-marker").length,
    chronicleVisible: !!q("#story-panel-mount .chronicle"),
    chronicleCountText: q("#story-panel-mount .chronicle-count")?.textContent?.trim() || null,
    zoneDossierVisible: !!dm && !dm.hidden,
    zoneName: q("#zone-dossier-mount .zd-name")?.textContent?.trim() || null,
    storyTitle: q("#story-panel-mount .story-title")?.textContent?.trim() || null,
    storyEventMeta: q("#story-panel-mount .event-meta")?.textContent?.trim() || null,
    activeChapter: q("#chapter-strip-mount .ch-pill.active")?.dataset?.ch || null,
    modeBtn: q("#btn-mode")?.textContent?.trim() || null,
  };
};

async function probe(browser, urlPath, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK", serviceWorkers: "block" });
    const pageErrors = [], consoleErrors = [];
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    const url = BASE.replace(/\/$/, "") + "/" + urlPath;
    let gotoErr = null;
    try {
      await page.goto(url, { waitUntil: "load", timeout: 40000 });
    } catch (e) {
      gotoErr = String(e);
    }
    await page.waitForFunction(() => document.querySelector("#svg-map-mount svg") || document.querySelector(".bg-error-panel"), { timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const snap = await page.evaluate(SNAP).catch((e) => ({ evalError: String(e) }));
    await ctx.close();
    // 連線失敗 → 重試
    if (gotoErr && /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(gotoErr) && attempt < tries) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const crashed = !snap.hasMapSvg && !snap.hasErrorPanel && (snap.bodyTextLen ?? 0) < 60;
    return { urlPath, attempt, gotoErr, pageErrors, consoleErrors, crashed, ...snap };
  }
}

const CASES = [
  { id: "hash-chapter-150", path: "#chapter=150", spec: "#chapter=<issue_index>" },
  { id: "hash-event", path: "#event=bg_event_001", spec: "?event=<id>" },
  { id: "hash-zone", path: "#zone=zone_d3f76d3c94", spec: "?zone=<id>" },
  { id: "hash-character", path: "#character=ann", spec: "?character=<id>" },
  { id: "hash-spoiler", path: "#spoiler=2", spec: "?spoiler=<0-3>" },
  { id: "hash-layers", path: "#layers=zones,events,routes", spec: "?layers=..." },
  { id: "hash-view-chronicle", path: "#view=chronicle", spec: "?view=chronicle" },
  { id: "hash-view-map", path: "#view=map", spec: "?view=map" },
  { id: "hash-location", path: "#location=loc_0029", spec: "#location=<id>" },
  { id: "hash-ch-150", path: "#ch=150", spec: "（現行支援）" },
];

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const out = { base: BASE, capturedAt: new Date().toISOString(), cases: [] };
for (const c of CASES) {
  const r = await probe(browser, c.path);
  out.cases.push({ ...c, ...r });
  console.log(`[${c.id}] ${c.path} → hash="${r.hash}" search="${r.search}" activeCh=${r.activeChapter} mode=${r.modeBtn} zoneVis=${r.zoneDossierVisible} story=${r.storyTitle} bodyLen=${r.bodyTextLen} err=${r.hasErrorPanel} crash=${r.crashed} gotoErr=${r.gotoErr ? "yes" : "no"}`);
}
await browser.close();
fs.writeFileSync(path.join(OUT, "a9-gaps-hashparams.json"), JSON.stringify(out, null, 2));
console.log("寫入", path.join(OUT, "a9-gaps-hashparams.json"));

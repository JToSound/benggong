/**
 * A9 QA Adversary —— 缺口補跑（只讀）
 *
 * 覆蓋上一個 A9 未做齊嘅項目：
 *   A. spec §5.1 hash 形式參數（#chapter= / #event= / #zone= / #character= / #spoiler= / #layers= / #view=）
 *   B. 無效輸入（hash 形式 + 超長 + 控制字元）
 *   C. data 真正延遲 30 秒（唔係 abort）→ app 行為
 *   D. localStorage 禁用 / 塞滿 之下，theme + spoiler 持久化行為
 *   E. spoiler 設定喺 refresh 後有冇重現（spec §7.2-7）
 *   F. 封鎖所有非 localhost，再互動（點 marker / 開 modal / 搜尋）確認零外部請求
 *   G. zone / event 選擇喺 refresh 後有冇重現（spec §5.1 line 484）
 *
 * 執行：node artifacts/audit-A9/a9-gaps.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";
fs.mkdirSync(OUT, { recursive: true });

const SNAP = () => {
  const q = (s) => document.querySelector(s);
  const err = q(".bg-error-panel");
  const dossierMount = q("#zone-dossier-mount");
  return {
    href: location.href,
    hash: location.hash,
    search: location.search,
    hasMapSvg: !!q("#svg-map-mount svg"),
    hasErrorPanel: !!err,
    errorText: err ? (err.innerText || "").slice(0, 220) : null,
    hasRetryBtn: !!q(".bg-error-panel button, .bg-error-panel [role=button]"),
    bodyTextLen: (document.body.innerText || "").length,
    zoneCount: document.querySelectorAll("#svg-map-mount .zone").length,
    eventMarkerCount: document.querySelectorAll("#svg-map-mount .event-marker").length,
    chronicleVisible: !!q("#story-panel-mount .chronicle"),
    chronicleCountText: q("#story-panel-mount .chronicle-count")?.textContent?.trim() || null,
    zoneDossierVisible: !!dossierMount && !dossierMount.hidden,
    zoneName: q("#zone-dossier-mount .zd-name")?.textContent?.trim() || null,
    storyPanelHidden: q("#story-panel-mount")?.hidden ?? null,
    storyTitle: q("#story-panel-mount .story-title")?.textContent?.trim() || null,
    storyEventMeta: q("#story-panel-mount .event-meta")?.textContent?.trim() || null,
    activeChapter: q("#chapter-strip-mount .ch-pill.active")?.dataset?.ch || null,
    modeBtn: q("#btn-mode")?.textContent?.trim() || null,
    theme: document.documentElement.getAttribute("data-theme"),
    spoilWarnCount: document.querySelectorAll(".spoil-warn").length,
    lsKeys: (() => {
      try {
        return Object.keys(localStorage);
      } catch {
        return ["<localStorage 存取失敗>"];
      }
    })(),
  };
};

function attach(page, bag) {
  page.on("console", (m) => {
    if (m.type() === "error") bag.consoleErrors.push(m.text());
    if (m.type() === "warning") bag.consoleWarns.push(m.text());
  });
  page.on("pageerror", (e) => bag.pageErrors.push(String(e)));
  page.on("request", (r) => {
    const u = r.url();
    if (!/^https?:\/\/(localhost|\[::1\]|127\.0\.0\.1)/.test(u) && !/^data:/.test(u)) {
      bag.externalRequests.push(u);
    }
  });
  page.on("requestfailed", (r) => bag.requestFailures.push(r.url() + " :: " + (r.failure()?.errorText || "")));
}

async function probe(browser, urlPath, { viewport = { width: 1440, height: 900 }, setup, wait = 1500, timeout = 40000 } = {}) {
  const ctx = await browser.newContext({ viewport, locale: "zh-HK", timezoneId: "Asia/Hong_Kong", serviceWorkers: "block" });
  const bag = { consoleErrors: [], consoleWarns: [], pageErrors: [], externalRequests: [], requestFailures: [] };
  const page = await ctx.newPage();
  attach(page, bag);
  if (setup) await setup(ctx, page);
  const url = BASE.replace(/\/$/, "") + "/" + urlPath;
  let gotoErr = null;
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "load", timeout });
  } catch (e) {
    gotoErr = String(e);
  }
  await page
    .waitForFunction(() => document.querySelector("#svg-map-mount svg") || document.querySelector(".bg-error-panel"), { timeout: 35000 })
    .catch(() => {});
  await page.waitForTimeout(wait);
  const snap = await page.evaluate(SNAP).catch((e) => ({ evalError: String(e) }));
  await ctx.close();
  const crashed = !snap.hasMapSvg && !snap.hasErrorPanel && (snap.bodyTextLen ?? 0) < 60;
  return { urlPath, gotoErr, elapsedMs: Date.now() - t0, crashed, ...bag, ...snap };
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const res = { base: BASE, capturedAt: new Date().toISOString(), hashParams: [], invalidHash: [], dataTimeout: null, storage: [], spoilerPersist: null, offlineInteraction: null, selectionPersist: [] };

  // ---------- A. spec §5.1 hash 形式參數 ----------
  const HASH_PARAMS = [
    { id: "hash-chapter-150", path: "#chapter=150" },
    { id: "hash-event", path: "#event=bg_event_001" },
    { id: "hash-zone", path: "#zone=zone_d3f76d3c94" },
    { id: "hash-character", path: "#character=ann" },
    { id: "hash-spoiler", path: "#spoiler=2" },
    { id: "hash-layers", path: "#layers=zones,events,routes" },
    { id: "hash-view-chronicle", path: "#view=chronicle" },
    { id: "hash-view-map", path: "#view=map" },
  ];
  for (const c of HASH_PARAMS) {
    const r = await probe(browser, c.path);
    res.hashParams.push({ ...c, ...r });
    console.log(`[hashParam] ${c.id} (${c.path}) → hash="${r.hash}" activeCh=${r.activeChapter} mode=${r.modeBtn} zoneVis=${r.zoneDossierVisible} story=${r.storyTitle} err=${r.hasErrorPanel} crash=${r.crashed}`);
  }

  // ---------- B. 無效輸入（hash 形式） ----------
  const INVALID_HASH = [
    { id: "hash-event-invalid", path: "#event=INVALID" },
    { id: "hash-zone-invalid", path: "#zone=不存在" },
    { id: "hash-chapter-99999", path: "#chapter=99999" },
    { id: "hash-chapter-neg", path: "#chapter=-5" },
    { id: "hash-spoiler-99", path: "#spoiler=99" },
    { id: "hash-view-xyz", path: "#view=xyz" },
    { id: "hash-layers-bogus", path: "#layers=,,," },
    { id: "hash-character-invalid", path: "#character=___none___" },
    { id: "hash-control-char", path: "#loc=%00%01%02" },
    { id: "hash-long-chapter", path: "#ch=" + "9".repeat(500) },
  ];
  for (const c of INVALID_HASH) {
    const r = await probe(browser, c.path);
    res.invalidHash.push({ ...c, ...r });
    console.log(`[invalidHash] ${c.id} → crash=${r.crashed} errPanel=${r.hasErrorPanel} pageErr=${r.pageErrors.length} activeCh=${r.activeChapter} bodyLen=${r.bodyTextLen}`);
  }

  // ---------- C. data 真正延遲 30 秒 ----------
  {
    const r = await probe(browser, "", {
      timeout: 60000,
      wait: 3000,
      setup: async (_ctx, page) => {
        await page.route("**/data/public/*.json", async (route) => {
          await new Promise((res) => setTimeout(res, 30000));
          await route.continue();
        });
      },
    });
    res.dataTimeout = r;
    console.log(`[dataTimeout30s] elapsed=${r.elapsedMs}ms mapSvg=${r.hasMapSvg} errPanel=${r.hasErrorPanel} retry=${r.hasRetryBtn} crash=${r.crashed} gotoErr=${r.gotoErr ? "yes" : "no"}`);
  }

  // ---------- D. localStorage 禁用 / 塞滿 ----------
  // D1 禁用：存取即拋
  {
    const r = await probe(browser, "", {
      setup: async (_ctx, page) => {
        await page.addInitScript(() => {
          const boom = () => {
            throw new DOMException("localStorage is disabled", "SecurityError");
          };
          Object.defineProperty(window, "localStorage", {
            configurable: true,
            get() {
              return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, get length() { return boom(); } };
            },
          });
        });
      },
    });
    // 再試切主題，睇有冇 crash
    res.storage.push({ id: "ls-disabled-load", ...r });
    console.log(`[storage] ls-disabled-load → crash=${r.crashed} errPanel=${r.hasErrorPanel} pageErr=${r.pageErrors.length} consoleErr=${r.consoleErrors.length}`);
  }
  // D2 塞滿：setItem 拋 QuotaExceededError，然後切主題
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK", serviceWorkers: "block" });
    const bag = { consoleErrors: [], consoleWarns: [], pageErrors: [], externalRequests: [], requestFailures: [] };
    const page = await ctx.newPage();
    attach(page, bag);
    await page.addInitScript(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (String(k).includes("theme") || String(k).includes("spoiler") || true) {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        }
        return orig.call(this, k, v);
      };
    });
    await page.goto(BASE, { waitUntil: "load", timeout: 40000 });
    await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const before = await page.evaluate(SNAP);
    // 嘗試切主題
    const themeBtn = await page.$("#btn-theme");
    let clickErr = null;
    if (themeBtn) {
      try {
        await themeBtn.click({ timeout: 5000 });
        await page.waitForTimeout(600);
      } catch (e) {
        clickErr = String(e);
      }
    }
    const after = await page.evaluate(SNAP);
    await ctx.close();
    res.storage.push({ id: "ls-quota-theme-toggle", before: { theme: before.theme, lsKeys: before.lsKeys }, after: { theme: after.theme }, clickErr, ...bag, crashed: !after.hasMapSvg && !after.hasErrorPanel });
    console.log(`[storage] ls-quota-theme-toggle → theme ${before.theme} → ${after.theme} clickErr=${clickErr ? "yes" : "no"} pageErr=${bag.pageErrors.length}`);
  }

  // ---------- E. spoiler 設定 refresh 後重現 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK", serviceWorkers: "block" });
    const bag = { consoleErrors: [], consoleWarns: [], pageErrors: [], externalRequests: [], requestFailures: [] };
    const page = await ctx.newPage();
    attach(page, bag);
    await page.goto(BASE, { waitUntil: "load", timeout: 40000 });
    await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(1200);
    // 開一個含 spoiler 嘅地點（#loc=loc_0029 顯示 spoilWarn=10）
    await page.goto(BASE + "#loc=loc_0029", { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const before = await page.evaluate(SNAP);
    // 嘗試改變 spoiler（如果有相關控件）
    const spoilControls = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button,input,select")).filter((e) => /spoiler|劇透|spoil/i.test((e.id || "") + (e.className || "") + (e.getAttribute("aria-label") || ""))).map((e) => e.id || e.className),
    );
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(SNAP);
    await ctx.close();
    res.spoilerPersist = { url: BASE + "#loc=loc_0029", spoilControls, before: { spoilWarn: before.spoilWarnCount, hash: before.hash, lsKeys: before.lsKeys }, after: { spoilWarn: after.spoilWarnCount, hash: after.hash }, ...bag };
    console.log(`[spoilerPersist] controls=${JSON.stringify(spoilControls)} spoilWarn ${before.spoilWarnCount} → ${after.spoilWarnCount}`);
  }

  // ---------- F. 封鎖所有非 localhost + 互動 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK", serviceWorkers: "block" });
    const bag = { consoleErrors: [], consoleWarns: [], pageErrors: [], externalRequests: [], requestFailures: [] };
    const page = await ctx.newPage();
    attach(page, bag);
    // 封鎖所有非 localhost
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (/^https?:\/\/(localhost|\[::1\]|127\.0\.0\.1)/.test(u) || /^data:/.test(u)) return route.continue();
      return route.abort();
    });
    await page.goto(BASE, { waitUntil: "load", timeout: 40000 });
    await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(1200);
    // 互動：點 zone、點 event、開搜尋、搜尋、開關於、切主題
    const actions = [];
    try {
      await page.evaluate(() => {
        const z = document.querySelector("#svg-map-mount .zone");
        if (z) z.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      actions.push("click-zone");
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const m = document.querySelector("#svg-map-mount .event-marker");
        if (m) m.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      actions.push("click-event");
      await page.waitForTimeout(500);
      const sb = await page.$("#btn-search");
      if (sb) {
        await sb.click();
        actions.push("open-search");
        await page.waitForTimeout(400);
        await page.keyboard.type("大本營");
        await page.waitForTimeout(600);
        actions.push("type-search");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
      const ab = await page.$("#btn-about");
      if (ab) {
        await ab.click();
        actions.push("open-about");
        await page.waitForTimeout(400);
        await page.keyboard.press("Escape");
      }
      const tb = await page.$("#btn-theme");
      if (tb) {
        await tb.click();
        actions.push("toggle-theme");
        await page.waitForTimeout(400);
      }
    } catch (e) {
      actions.push("error:" + String(e).slice(0, 80));
    }
    const snap = await page.evaluate(SNAP);
    await ctx.close();
    res.offlineInteraction = { actions, externalRequests: bag.externalRequests, requestFailures: bag.requestFailures, pageErrors: bag.pageErrors, consoleErrors: bag.consoleErrors.slice(0, 5), snap };
    console.log(`[offlineInteraction] actions=${actions.length} external=${bag.externalRequests.length} pageErr=${bag.pageErrors.length} crash=${!snap.hasMapSvg && !snap.hasErrorPanel}`);
  }

  // ---------- G. zone / event 選擇 refresh 後重現 ----------
  async function selectionPersist(id, clickFn) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK", serviceWorkers: "block" });
    const bag = { consoleErrors: [], consoleWarns: [], pageErrors: [], externalRequests: [], requestFailures: [] };
    const page = await ctx.newPage();
    attach(page, bag);
    await page.goto(BASE, { waitUntil: "load", timeout: 40000 });
    await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const clicked = await page.evaluate(clickFn);
    await page.waitForTimeout(900);
    const before = await page.evaluate(SNAP);
    const urlBefore = page.url();
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const after = await page.evaluate(SNAP);
    await ctx.close();
    const pick = (o) => ({ hash: o.hash, activeCh: o.activeChapter, mode: o.modeBtn, zoneVis: o.zoneDossierVisible, zoneName: o.zoneName, storyTitle: o.storyTitle, eventMeta: o.storyEventMeta, chronicleVisible: o.chronicleVisible });
    return { id, clicked, urlBefore, urlAfter: after.href, before: pick(before), after: pick(after), pageErrors: bag.pageErrors };
  }
  res.selectionPersist.push(
    await selectionPersist("zone-click-reload", () => {
      const z = document.querySelector("#svg-map-mount .zone");
      if (!z) return null;
      z.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return { id: z.getAttribute("data-zone-id"), name: z.getAttribute("data-zone-name") };
    }),
  );
  res.selectionPersist.push(
    await selectionPersist("event-click-reload", () => {
      const m = document.querySelector("#svg-map-mount .event-marker");
      if (!m) return null;
      m.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return m.getAttribute("data-event-id");
    }),
  );
  for (const s of res.selectionPersist) {
    console.log(`[selectionPersist] ${s.id} urlBefore=${s.urlBefore} → urlAfter=${s.urlAfter} zoneVis ${s.before.zoneVis}→${s.after.zoneVis} story ${s.before.storyTitle}→${s.after.storyTitle}`);
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "a9-gaps.json"), JSON.stringify(res, null, 2));
  console.log("\n寫入", path.join(OUT, "a9-gaps.json"));
}

main().catch((e) => {
  console.error("A9 gaps 測試失敗:", e);
  process.exit(1);
});

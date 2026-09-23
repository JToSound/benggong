/**
 * A9 QA Adversary —— State 一致性 / 面板可見性 / raster fallback（只讀）
 *
 * 執行：node artifacts/audit-A9/a9-consistency.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";
fs.mkdirSync(OUT, { recursive: true });

const STATE = () => {
  const q = (s) => document.querySelector(s);
  const dossier = q("#zone-dossier-mount");
  const panel = q("#story-panel-mount");
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && !el.hidden;
  };
  return {
    modeBtn: q("#btn-mode")?.textContent?.trim() || null,
    panelHiddenAttr: panel?.hidden ?? null,
    dossierHiddenAttr: dossier?.hidden ?? null,
    panelVisible: vis(panel),
    dossierVisible: vis(dossier),
    panelFirstChildClass: panel?.firstElementChild?.className || null,
    dossierName: q("#zone-dossier-mount .zd-name")?.textContent?.trim() || null,
    storyTitle: q("#story-panel-mount .story-title")?.textContent?.trim() || null,
    eventMeta: q("#story-panel-mount .event-meta")?.textContent?.trim() || null,
    chronicleVisible: !!q("#story-panel-mount .chronicle"),
    basemapHref: q("#basemap-group")?.getAttribute("href") || null,
    wrapClasses: q("#svg-map-mount > *")?.className || q("#svg-map-mount")?.firstElementChild?.className || null,
    hash: location.hash,
  };
};

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-HK",
    serviceWorkers: "block",
    ...opts,
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  const warns = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "warning") warns.push(m.text());
  });
  return { ctx, page, pageErrors, warns };
}

async function ready(page) {
  await page
    .waitForFunction(() => document.querySelector("#svg-map-mount svg") || document.querySelector(".bg-error-panel"), { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const out = { base: BASE, capturedAt: new Date().toISOString(), cases: [] };

  // ---------- 1. vector 404 → raster fallback 行為 ----------
  {
    const { ctx, page, pageErrors, warns } = await newPage(browser);
    const reqs = [];
    page.on("request", (r) => reqs.push(r.url()));
    await page.route("**/assets/vector/**", (r) =>
      r.fulfill({ status: 404, contentType: "text/plain", body: "nf" }),
    );
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    await page.waitForTimeout(1500);
    const st = await page.evaluate(STATE);
    // canvas 非空檢查（抽樣像素 alpha）
    const canvasInfo = await page.evaluate(() => {
      const c = document.querySelector("#basemap-canvas");
      if (!c) return null;
      const ctx2 = c.getContext("2d");
      try {
        const d = ctx2.getImageData(0, 0, Math.min(200, c.width), Math.min(200, c.height)).data;
        let nonZero = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) nonZero++;
        return { w: c.width, h: c.height, alphaNonZero: nonZero };
      } catch (e) {
        return { error: String(e) };
      }
    });
    const rasterReqs = reqs.filter((u) => /hk-basemap|map-lod/.test(u));
    await ctx.close();
    out.cases.push({
      id: "vector404-fallback",
      desc: "vector 底圖 404 → raster fallback",
      state: st,
      canvasInfo,
      rasterRequests: rasterReqs,
      pageErrors,
      warns,
    });
    console.log("[vector404-fallback]", JSON.stringify({ st, canvasInfo, rasterReqs: rasterReqs.length, pageErrors }));
  }

  // ---------- 2. zone → event click（面板可見性）----------
  {
    const { ctx, page, pageErrors } = await newPage(browser);
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    // 點 zone
    await page.evaluate(() => {
      document.querySelector("#svg-map-mount .zone")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(700);
    const afterZone = await page.evaluate(STATE);
    // 再點 event marker
    await page.evaluate(() => {
      document.querySelector("#svg-map-mount .event-marker")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(700);
    const afterEvent = await page.evaluate(STATE);
    await ctx.close();
    out.cases.push({
      id: "zone-then-event-click",
      desc: "zone dossier 開住時點 event marker → event detail 有冇顯示？",
      afterZone,
      afterEvent,
      eventDetailVisible: afterEvent.panelVisible && !!afterEvent.eventMeta,
      pageErrors,
    });
    console.log("[zone-then-event-click]", JSON.stringify({ afterZone: { mode: afterZone.modeBtn, dossierVisible: afterZone.dossierVisible }, afterEvent: { mode: afterEvent.modeBtn, panelVisible: afterEvent.panelVisible, eventMeta: afterEvent.eventMeta } }));
  }

  // ---------- 3. mode label ↔ panel visibility 矩陣 ----------
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    const matrix = [];
    for (const target of ["chapter", "chronicle", "zone", "chronicle"]) {
      await page.evaluate((t) => {
        // 經 UI 按鈕循環到目標模式
        const btn = document.querySelector("#btn-mode");
        const cur = btn.textContent.includes("編年史") ? "chronicle" : btn.textContent.includes("章節") ? "chapter" : "zone";
        const order = { chronicle: "chapter", chapter: "zone", zone: "chronicle" };
        let c = cur;
        let guard = 0;
        while (c !== t && guard++ < 5) {
          btn.click();
          c = order[c];
        }
      }, target);
      await page.waitForTimeout(400);
      matrix.push({ target, ...(await page.evaluate(STATE)) });
    }
    await ctx.close();
    out.cases.push({ id: "mode-panel-matrix", desc: "模式標籤 ↔ 面板可見性", matrix });
    console.log("[mode-panel-matrix]");
    for (const m of matrix) console.log("   ", m.target, "→ btn=", m.modeBtn, "panelVis=", m.panelVisible, "dossierVis=", m.dossierVisible, "panelHidden=", m.panelHiddenAttr, "dossierHidden=", m.dossierHiddenAttr);
  }

  // ---------- 4. Esc 優先次序 ----------
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE + "#loc=loc_0029", { waitUntil: "load" });
    await ready(page);
    const before = await page.evaluate(STATE);
    // 開 search modal
    await page.click("#btn-search");
    await page.waitForTimeout(400);
    const modalOpen1 = await page.evaluate(() => !!document.querySelector("#search-modal.open"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const afterEsc1 = {
      modalOpen: await page.evaluate(() => !!document.querySelector("#search-modal.open")),
      state: await page.evaluate(STATE),
    };
    // 再按 Esc（應該清 selection）
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const afterEsc2 = await page.evaluate(STATE);
    await ctx.close();
    out.cases.push({
      id: "esc-priority",
      desc: "Esc 先關 modal、再清選擇",
      before,
      modalOpenAfterOpen: modalOpen1,
      afterEsc1,
      afterEsc2,
    });
    console.log("[esc-priority] modalOpen1=", modalOpen1, "afterEsc1.modalOpen=", afterEsc1.modalOpen, "afterEsc1.locMeta=", afterEsc1.state.storyTitle, "afterEsc2.locMeta=", afterEsc2.storyTitle);
  }

  // ---------- 5. 面板 toggle aria-expanded + 斷點一致性 ----------
  for (const w of [1023, 1024, 1280]) {
    const { ctx, page } = await newPage(browser, { viewport: { width: w, height: 800 } });
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    const init = await page.evaluate(() => {
      const b = document.querySelector("#btn-toggle-panel");
      const r = b.getBoundingClientRect();
      return {
        btnVisible: r.width > 0 && r.height > 0 && getComputedStyle(b).display !== "none",
        btnAria: b.getAttribute("aria-expanded"),
        paneCollapsed: document.querySelector("#story-pane")?.classList.contains("is-collapsed"),
        paneVisible: (() => {
          const p = document.querySelector("#story-pane");
          const rr = p.getBoundingClientRect();
          return rr.width > 0 && rr.height > 0;
        })(),
      };
    });
    // 用 JS click（唔受 visibility 限制），測 toggle 邏輯本身
    await page.evaluate(() => document.querySelector("#btn-toggle-panel").click());
    await page.waitForTimeout(300);
    const afterClick = await page.evaluate(() => ({
      aria: document.querySelector("#btn-toggle-panel")?.getAttribute("aria-expanded"),
      collapsed: document.querySelector("#story-pane")?.classList.contains("is-collapsed"),
    }));
    await ctx.close();
    out.cases.push({ id: `panel-toggle-${w}`, desc: `面板 toggle @ ${w}px`, init, afterClick });
    console.log(`[panel-toggle-${w}]`, JSON.stringify({ init, afterClick }));
  }

  // ---------- 6. 主題持久化 ----------
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    const t0 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await page.click("#btn-theme");
    await page.waitForTimeout(400);
    const t1 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const stored = await page.evaluate(() => localStorage.getItem("binggang-theme"));
    await page.reload({ waitUntil: "load" });
    await ready(page);
    const t2 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await ctx.close();
    out.cases.push({ id: "theme-persist", desc: "主題切換 + reload 持久化", t0, t1, stored, t2, persisted: t1 === t2 });
    console.log("[theme-persist]", JSON.stringify({ t0, t1, stored, t2 }));
  }

  // ---------- 7. 快速按 → 後嘅一致性 ----------
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => ({
      activeCh: document.querySelector("#chapter-strip-mount .ch-pill.active")?.dataset.ch ?? null,
      stripNum: document.querySelector("#strip-ch-num")?.textContent ?? null,
      chronicleCount: document.querySelector("#story-panel-mount .chronicle-count")?.textContent?.trim() ?? null,
      hash: location.hash,
    }));
    await ctx.close();
    out.cases.push({ id: "rapid-keys-consistency", desc: "按 → 30 次後章節一致性", st });
    console.log("[rapid-keys-consistency]", JSON.stringify(st));
  }

  // ---------- 8. 反覆 pan/zoom 後 viewBox 一致性 ----------
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    const vb0 = await page.evaluate(() => document.querySelector("#svg-map-mount svg")?.getAttribute("viewBox"));
    for (let i = 0; i < 100; i++) {
      await page.click("#map-zoom-in", { force: true }).catch(() => {});
      await page.click("#map-zoom-out", { force: true }).catch(() => {});
    }
    await page.waitForTimeout(1200);
    const vb1 = await page.evaluate(() => document.querySelector("#svg-map-mount svg")?.getAttribute("viewBox"));
    // reset
    await page.click("#map-reset", { force: true }).catch(() => {});
    await page.waitForTimeout(800);
    const vb2 = await page.evaluate(() => document.querySelector("#svg-map-mount svg")?.getAttribute("viewBox"));
    await ctx.close();
    out.cases.push({ id: "pan-zoom-100", desc: "100 次 zoom in/out + reset 後 viewBox", vb0, vb1, vb2, resetOk: vb0 === vb2 });
    console.log("[pan-zoom-100]", JSON.stringify({ vb0, vb1, vb2, resetOk: vb0 === vb2 }));
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "a9-consistency.json"), JSON.stringify(out, null, 2));
  console.log("\n寫入", path.join(OUT, "a9-consistency.json"));
}

main().catch((e) => {
  console.error("A9 consistency 測試失敗:", e);
  process.exit(1);
});

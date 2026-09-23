/**
 * A9 QA Adversary —— SW 遮蓋 / 無限掛起 / storage / chronicle 重繪（只讀）
 *
 * 執行：node artifacts/audit-A9/a9-sw-hang-chronicle.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";

const SNAP = () => {
  const q = (s) => document.querySelector(s);
  const err = q(".bg-error-panel");
  return {
    hasMapSvg: !!q("#svg-map-mount svg"),
    hasErrorPanel: !!err,
    errorText: err ? (err.innerText || "").slice(0, 160) : null,
    hasRetryBtn: !!(err && err.querySelector("button")),
    bodyTextLen: (document.body.innerText || "").length,
    initialLoadingText: q("#initial-loading")?.textContent?.trim() || null,
    chronicleEntryCount: document.querySelectorAll("#story-panel-mount .chr-entry").length,
    totalNodes: document.getElementsByTagName("*").length,
    theme: document.documentElement.getAttribute("data-theme"),
    swController: !!navigator.serviceWorker?.controller,
  };
};

async function scenario(browser, name, { routeFn, sw = "block", wait = 6000, viewport = { width: 1440, height: 900 }, steps } = {}) {
  const ctx = await browser.newContext({ viewport, locale: "zh-HK", serviceWorkers: sw });
  const page = await ctx.newPage();
  const responses = [];
  const consoleErrors = [];
  const pageErrors = [];
  page.on("response", (r) => {
    const u = r.url();
    if (/events\.geojson/.test(u)) responses.push({ url: u, status: r.status(), fromSW: r.fromServiceWorker() });
  });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  if (routeFn) await page.route("**/data/public/events.geojson", routeFn);
  let gotoErr = null;
  const t0 = Date.now();
  try {
    await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  } catch (e) {
    gotoErr = String(e);
  }
  await page.waitForTimeout(wait);
  const snap = await page.evaluate(SNAP).catch((e) => ({ evalError: String(e) }));
  let extra = null;
  if (steps) extra = await steps(page).catch((e) => ({ stepError: String(e) }));
  const snap2 = await page.evaluate(SNAP).catch(() => ({}));
  await ctx.close();
  const rec = { name, sw, gotoErr, elapsedMs: Date.now() - t0, responses, consoleErrors: consoleErrors.slice(0, 5), pageErrors, snap, extra, snapAfter: snap2 };
  console.log(`[${name}] sw=${sw} elapsed=${rec.elapsedMs}ms map=${snap.hasMapSvg} errPanel=${snap.hasErrorPanel} retry=${snap.hasRetryBtn} bodyLen=${snap.bodyTextLen} resp=${JSON.stringify(responses)}`);
  return rec;
}

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const out = { base: BASE, capturedAt: new Date().toISOString(), cases: [] };

// 1) 404 events.geojson：SW allow vs block
out.cases.push(await scenario(browser, "404-with-sw", { sw: "allow", routeFn: (r) => r.fulfill({ status: 404, contentType: "text/plain", body: "nf" }) }));
out.cases.push(await scenario(browser, "404-without-sw", { sw: "block", routeFn: (r) => r.fulfill({ status: 404, contentType: "text/plain", body: "nf" }) }));

// 2) 壞 JSON：SW allow vs block
out.cases.push(await scenario(browser, "badjson-with-sw", { sw: "allow", routeFn: (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{invalid" }) }));
out.cases.push(await scenario(browser, "badjson-without-sw", { sw: "block", routeFn: (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{invalid" }) }));

// 3) 無限掛起（永不回應）→ app 有冇 timeout / error UI？
out.cases.push(
  await scenario(browser, "hang-forever", {
    sw: "block",
    wait: 45000,
    routeFn: () => {
      /* 永不 fulfill / continue → 請求掛起 */
    },
  }),
);

// 4) localStorage 禁用 → 主題切換喺記憶體內有效？reload 後？
out.cases.push(
  await scenario(browser, "ls-disabled-theme", {
    sw: "block",
    steps: async (page) => {
      const before = await page.evaluate(SNAP);
      await page.evaluate(() => {
        const b = document.querySelector("#btn-theme");
        if (b) b.click();
      });
      await page.waitForTimeout(600);
      const afterToggle = await page.evaluate(SNAP);
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(2000);
      const afterReload = await page.evaluate(SNAP);
      return { before: before.theme, afterToggle: afterToggle.theme, afterReload: afterReload.theme };
    },
  }),
);

// 5) chronicle eager render + 離開/返去重繪成本（virtualization 證據）
out.cases.push(
  await scenario(browser, "chronicle-render", {
    sw: "block",
    wait: 2500,
    steps: async (page) => {
      const count = async () => page.evaluate(() => ({
        entries: document.querySelectorAll("#story-panel-mount .chr-entry").length,
        nodes: document.getElementsByTagName("*").length,
      }));
      const t0 = Date.now();
      const a = await count();
      const tCount = Date.now() - t0;
      // 切去 chapter 模式再返 chronicle 模式，量度重繪
      const t1 = Date.now();
      await page.evaluate(() => document.querySelector("#btn-mode")?.click());
      await page.waitForTimeout(500);
      const b = await count();
      await page.evaluate(() => document.querySelector("#btn-mode")?.click());
      await page.waitForTimeout(1500);
      const c = await count();
      const tCycle = Date.now() - t1;
      return { chronicleEntries: a.entries, nodesAtChronicle: a.nodes, nodesAfterChapter: b.nodes, nodesBackToChronicle: c.nodes, reentryMs: tCycle };
    },
  }),
);

await browser.close();
fs.writeFileSync(path.join(OUT, "a9-sw-hang-chronicle.json"), JSON.stringify(out, null, 2));
console.log("\n寫入", path.join(OUT, "a9-sw-hang-chronicle.json"));

/**
 * A9 QA Adversary —— Console / 記憶體 / event listener 累積（只讀）
 *
 * 執行：node artifacts/audit-A9/a9-memory-console.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";
fs.mkdirSync(OUT, { recursive: true });

async function measure(page, client) {
  const metrics = await page.evaluate(() => {
    try {
      window.gc?.();
    } catch { /* ignore */ }
    return {
      heap: performance.memory?.usedJSHeapSize ?? null,
      nodes: document.getElementsByTagName("*").length,
      svgChildren: document.querySelector("#map-content")?.childElementCount ?? null,
      modalCount: document.querySelectorAll("#search-modal, #about-modal").length,
      bodyLen: (document.body.innerText || "").length,
    };
  });
  // window / document listener 數量（CDP）
  async function listenersOf(expr) {
    try {
      const { result } = await client.send("Runtime.evaluate", { expression: expr });
      const { listeners } = await client.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId,
        depth: 1,
      });
      return listeners.length;
    } catch (e) {
      return -1;
    }
  }
  metrics.windowListeners = await listenersOf("window");
  metrics.documentListeners = await listenersOf("document");
  return metrics;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-proxy-server", "--js-flags=--expose-gc"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-HK",
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  const consoleMsgs = [];
  const pageErrors = [];
  page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 160) }));
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));

  const client = await ctx.newCDPSession(page);

  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#svg-map-mount svg"), { timeout: 30000 });
  await page.waitForTimeout(1500);

  const baseline = await measure(page, client);
  console.log("baseline:", JSON.stringify(baseline));

  const phases = [];

  async function phase(id, desc, fn) {
    const before = await measure(page, client);
    const errBefore = pageErrors.length;
    const warnBefore = consoleMsgs.filter((m) => m.type === "warning").length;
    await fn();
    await page.waitForTimeout(1500);
    const after = await measure(page, client);
    const r = {
      id,
      desc,
      before,
      after,
      heapDeltaMB: (after.heap - before.heap) / 1048576,
      nodesDelta: after.nodes - before.nodes,
      windowListenersDelta: after.windowListeners - before.windowListeners,
      documentListenersDelta: after.documentListeners - before.documentListeners,
      newPageErrors: pageErrors.length - errBefore,
      newWarnings: consoleMsgs.filter((m) => m.type === "warning").length - warnBefore,
    };
    phases.push(r);
    console.log(
      `[${id}] heapΔ=${r.heapDeltaMB.toFixed(2)}MB nodesΔ=${r.nodesDelta} winLsnΔ=${r.windowListenersDelta} docLsnΔ=${r.documentListenersDelta} newErr=${r.newPageErrors} newWarn=${r.newWarnings}`,
    );
  }

  await phase("open-close-about-50", "開關「關於」modal 50 次", async () => {
    for (let i = 0; i < 50; i++) {
      await page.evaluate(() => document.querySelector("#btn-about").click());
      await page.waitForTimeout(15);
      await page.evaluate(() => document.querySelector("#about-close")?.click());
    }
  });

  await phase("open-close-search-50", "開關搜尋 modal 50 次", async () => {
    for (let i = 0; i < 50; i++) {
      await page.evaluate(() => document.querySelector("#btn-search").click());
      await page.waitForTimeout(15);
      await page.evaluate(() => document.querySelector("#search-close")?.click());
    }
  });

  await phase("toggle-panel-50", "開關面板 50 次", async () => {
    for (let i = 0; i < 50; i++) {
      await page.evaluate(() => document.querySelector("#btn-toggle-panel").click());
    }
  });

  await phase("switch-view-50", "切換 view 50 次", async () => {
    for (let i = 0; i < 50; i++) {
      await page.evaluate(() => document.querySelector("#btn-mode").click());
      await page.waitForTimeout(20);
    }
  });

  await phase("select-zone-event-40", "交替選 zone / event / location 各 40 次", async () => {
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => {
        document.querySelector("#svg-map-mount .zone")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForTimeout(10);
      await page.evaluate(() => {
        document.querySelector("#svg-map-mount .event-marker")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForTimeout(10);
      await page.evaluate(() => {
        document.querySelector("#svg-map-mount .location-marker")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForTimeout(10);
    }
  });

  await phase("zoom-100", "zoom in/out 各 100 次", async () => {
    for (let i = 0; i < 100; i++) {
      await page.evaluate(() => document.querySelector("#map-zoom-in").click());
      await page.evaluate(() => document.querySelector("#map-zoom-out").click());
    }
  });

  await phase("chapter-keys-100", "按 → 100 次", async () => {
    for (let i = 0; i < 100; i++) {
      await page.evaluate(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
    }
  });

  const final = await measure(page, client);
  const warnList = consoleMsgs.filter((m) => m.type === "warning").map((m) => m.text);
  const errList = consoleMsgs.filter((m) => m.type === "error").map((m) => m.text);

  const out = {
    base: BASE,
    capturedAt: new Date().toISOString(),
    baseline,
    phases,
    final,
    totalHeapDeltaMB: (final.heap - baseline.heap) / 1048576,
    totalNodesDelta: final.nodes - baseline.nodes,
    pageErrors,
    consoleErrorCount: errList.length,
    consoleWarnCount: warnList.length,
    consoleWarnSample: [...new Set(warnList)].slice(0, 10),
    consoleErrorSample: [...new Set(errList)].slice(0, 10),
  };

  await ctx.close();
  await browser.close();
  fs.writeFileSync(path.join(OUT, "a9-memory-console.json"), JSON.stringify(out, null, 2));
  console.log("\nfinal:", JSON.stringify(final));
  console.log("totalHeapDeltaMB=", out.totalHeapDeltaMB.toFixed(2), "totalNodesDelta=", out.totalNodesDelta);
  console.log("pageErrors:", JSON.stringify(pageErrors));
  console.log("warnings:", out.consoleWarnCount, JSON.stringify(out.consoleWarnSample));
  console.log("errors:", out.consoleErrorCount, JSON.stringify(out.consoleErrorSample));
  console.log("寫入", path.join(OUT, "a9-memory-console.json"));
}

main().catch((e) => {
  console.error("A9 memory 測試失敗:", e);
  process.exit(1);
});

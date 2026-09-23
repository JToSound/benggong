/**
 * A9 QA Adversary —— Offline / local-only + Error state 注入（只讀）
 *
 * 1. 攔截並封鎖所有非 localhost 請求 → app 會唔會壞？
 * 2. 攔截 data/public/*.json、assets/vector/*.json 令其 404 / 壞 JSON / 逾時
 * 3. localStorage 禁用 / 塞滿
 * 4. 極端 viewport（320 寬、400 高、3840 寬）
 * 5. 快速連續點擊（race condition）
 *
 * 執行：node artifacts/audit-A9/a9-offline-error.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A9";
fs.mkdirSync(OUT, { recursive: true });

const SNAPSHOT = () => {
  const q = (s) => document.querySelector(s);
  const err = q(".bg-error-panel");
  return {
    href: location.href,
    hasMapSvg: !!q("#svg-map-mount svg"),
    hasCanvas: !!q("#svg-map-mount canvas"),
    hasErrorPanel: !!err,
    errorText: err ? (err.innerText || "").replace(/\s+/g, " ").slice(0, 240) : null,
    hasRetryBtn: !!q("#bg-retry-btn"),
    bodyTextLen: (document.body.innerText || "").length,
    zoneCount: document.querySelectorAll("#svg-map-mount .zone").length,
    markerCount: document.querySelectorAll("#svg-map-mount .location-marker, #svg-map-mount .location-marker-cluster").length,
    eventMarkerCount: document.querySelectorAll("#svg-map-mount .event-marker").length,
    chronicleVisible: !!q("#story-panel-mount .chronicle"),
    chronicleEntryCount: document.querySelectorAll("#story-panel-mount .chr-entry").length,
    modeBtn: q("#btn-mode")?.textContent?.trim() || null,
    theme: document.documentElement.getAttribute("data-theme"),
    // overflow 診斷
    docScrollW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    docScrollH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
    horizOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    // touch target 檢查（nav 按鈕）
    navBtnMinH: (() => {
      const bs = [...document.querySelectorAll("#topbar .nav-btn")];
      if (!bs.length) return null;
      return Math.round(Math.min(...bs.map((b) => b.getBoundingClientRect().height)));
    })(),
  };
};

async function runCase(browser, c) {
  const context = await browser.newContext({
    viewport: c.viewport || { width: 1440, height: 900 },
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
    // ⚠️ 實測發現：production 會註冊 service worker，而 Playwright 嘅
    // `page.route()` **攔截唔到由 SW 處理嘅請求** → 若唔 block SW，所有
    // error-injection 都會被 SW 快取遮蓋，產生「app 好穩健」嘅假象。
    // 所以所有注入測試一律 block service worker，先反映真實 error state。
    serviceWorkers: "block",
  });
  const consoleErrors = [];
  const consoleWarns = [];
  const pageErrors = [];
  const requestFailures = [];
  const externalRequests = [];
  const dataStatuses = {};

  if (c.initScript) await context.addInitScript(c.initScript);

  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
    if (m.type() === "warning") consoleWarns.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("requestfailed", (r) => requestFailures.push({ url: r.url(), err: r.failure()?.errorText ?? null }));
  page.on("response", (r) => {
    try {
      const u = new URL(r.url());
      if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) externalRequests.push(r.url());
    } catch { /* ignore */ }
  });

  if (c.routes) await c.routes(page, context);

  let gotoErr = null;
  try {
    await page.goto(BASE, { waitUntil: "load", timeout: 40000 });
  } catch (e) {
    gotoErr = String(e);
  }

  await page
    .waitForFunction(() => document.querySelector("#svg-map-mount svg") || document.querySelector(".bg-error-panel"), { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(c.settle ?? 1500);

  if (c.actions) {
    try {
      await c.actions(page);
    } catch (e) {
      pageErrors.push("action: " + String(e));
    }
  }
  await page.waitForTimeout(600);

  const snap = await page.evaluate(SNAPSHOT).catch((e) => ({ evalError: String(e) }));

  if (c.screenshot) {
    await page
      .screenshot({ path: path.join(OUT, `a9-${c.id}.png`), fullPage: false })
      .catch(() => {});
  }

  // 統計 data 請求狀態
  const dataReqs = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((r) => r.name)
      .filter((n) => /data\/public\//.test(n))
      .slice(0, 3),
  ).catch(() => []);

  await context.close();

  const crashed =
    !snap.hasMapSvg && !snap.hasErrorPanel && (snap.bodyTextLen ?? 0) < 60;

  return {
    id: c.id,
    desc: c.desc,
    gotoErr,
    pageErrors,
    consoleErrors,
    consoleWarns,
    requestFailureCount: requestFailures.length,
    externalRequestCount: externalRequests.length,
    externalRequests: [...new Set(externalRequests)].slice(0, 5),
    dataReqs,
    crashed,
    ...snap,
  };
}

function blockExternal(page) {
  return page.route("**/*", (route) => {
    try {
      const u = new URL(route.request().url());
      if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) {
        return route.abort();
      }
    } catch { /* ignore */ }
    return route.continue();
  });
}

const CASES = [
  {
    id: "offline-block-external",
    desc: "封鎖所有非 localhost 請求",
    routes: (page) => blockExternal(page),
  },
  {
    id: "data-404-events",
    desc: "events.geojson → 404",
    routes: (page) =>
      page.route("**/data/public/events.geojson", (r) =>
        r.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
      ),
  },
  {
    id: "data-badjson-events",
    desc: "events.geojson → 壞 JSON",
    routes: (page) =>
      page.route("**/data/public/events.geojson", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: "{ this is not json" }),
      ),
  },
  {
    id: "data-html-events",
    desc: "events.geojson → HTML（模擬 SPA fallback）",
    routes: (page) =>
      page.route("**/data/public/events.geojson", (r) =>
        r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>index</h1>" }),
      ),
  },
  {
    id: "data-abort-events",
    desc: "events.geojson → 連線中斷（模擬逾時）",
    routes: (page) => page.route("**/data/public/events.geojson", (r) => r.abort("timedout")),
  },
  {
    id: "data-404-zones",
    desc: "zones.geojson → 404",
    routes: (page) =>
      page.route("**/data/public/zones.geojson", (r) =>
        r.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
      ),
  },
  {
    id: "data-404-all",
    desc: "全部 data/public/*.json → 404",
    screenshot: true,
    routes: (page) =>
      page.route("**/data/public/**", (r) =>
        r.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
      ),
  },
  {
    id: "vector-404",
    desc: "assets/vector/*.json → 404",
    routes: (page) =>
      page.route("**/assets/vector/**", (r) =>
        r.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
      ),
  },
  {
    id: "vector-badjson",
    desc: "assets/vector/*.json → 壞 JSON",
    routes: (page) =>
      page.route("**/assets/vector/**", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: "<<<bad>>>" }),
      ),
  },
  {
    id: "localstorage-disabled",
    desc: "localStorage 被禁用（存取即拋錯）",
    initScript: `
      (() => {
        const boom = () => { throw new DOMException('SecurityError: localStorage disabled', 'SecurityError'); };
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() { return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 }; },
        });
      })();
    `,
  },
  {
    id: "localstorage-quota",
    desc: "localStorage 塞滿（setItem 拋 QuotaExceededError）",
    initScript: `
      (() => {
        const orig = window.localStorage;
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            return {
              getItem: (k) => orig.getItem(k),
              setItem: () => { throw new DOMException('QuotaExceededError', 'QuotaExceededError'); },
              removeItem: (k) => orig.removeItem(k),
              clear: () => orig.clear(),
              key: (i) => orig.key(i),
              get length() { return orig.length; },
            };
          },
        });
      })();
    `,
    actions: async (page) => {
      // 試切主題（會寫 localStorage）
      await page.click("#btn-theme").catch(() => {});
      await page.waitForTimeout(300);
    },
  },
  {
    id: "viewport-320x400",
    desc: "極窄 320px × 極短 400px",
    viewport: { width: 320, height: 400 },
    screenshot: true,
  },
  {
    id: "viewport-320x568",
    desc: "極窄 320px",
    viewport: { width: 320, height: 568 },
  },
  {
    id: "viewport-1440x400",
    desc: "極短高度 400px",
    viewport: { width: 1440, height: 400 },
    screenshot: true,
  },
  {
    id: "viewport-3840x2160",
    desc: "超大 4K viewport",
    viewport: { width: 3840, height: 2160 },
  },
  {
    id: "race-mode-switch",
    desc: "快速連續切換 view 20 次",
    actions: async (page) => {
      for (let i = 0; i < 20; i++) {
        await page.click("#btn-mode").catch(() => {});
      }
    },
  },
  {
    id: "race-marker-clicks",
    desc: "快速連續點 15 個唔同 marker",
    actions: async (page) => {
      await page.evaluate(async () => {
        const markers = [...document.querySelectorAll("#svg-map-mount .event-marker, #svg-map-mount .location-marker")].slice(0, 15);
        for (const m of markers) {
          m.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 20));
        }
      });
    },
  },
  {
    id: "race-zone-event",
    desc: "快速交替點 zone / event / location",
    actions: async (page) => {
      await page.evaluate(async () => {
        const zone = document.querySelector("#svg-map-mount .zone");
        const ev = document.querySelector("#svg-map-mount .event-marker");
        const loc = document.querySelector("#svg-map-mount .location-marker");
        for (let i = 0; i < 10; i++) {
          zone?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 15));
          ev?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 15));
          loc?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 15));
        }
      });
    },
  },
  {
    id: "race-chapter-keys",
    desc: "快速按 → 30 次（章節切換 race）",
    actions: async (page) => {
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press("ArrowRight");
      }
    },
  },
];

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const results = { base: BASE, capturedAt: new Date().toISOString(), cases: [] };

  for (const c of CASES) {
    const r = await runCase(browser, c);
    results.cases.push(r);
    console.log(
      `[${c.id}] crash=${r.crashed} errPanel=${r.hasErrorPanel} retry=${r.hasRetryBtn} map=${r.hasMapSvg} canvas=${r.hasCanvas} ` +
        `ext=${r.externalRequestCount} pageErr=${r.pageErrors.length} consoleErr=${r.consoleErrors.length} ` +
        `overflow=${r.horizOverflow} navBtnH=${r.navBtnMinH} bodyLen=${r.bodyTextLen}`,
    );
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "a9-offline-error.json"), JSON.stringify(results, null, 2));
  console.log("\n寫入", path.join(OUT, "a9-offline-error.json"));
}

main().catch((e) => {
  console.error("A9 offline/error 測試失敗:", e);
  process.exit(1);
});

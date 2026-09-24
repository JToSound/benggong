/**
 * C7 敵意探測：地圖鍵盤可達性「25」嘅獨立驗證（v2，可續跑）。
 *
 * 問題：`a7-probe-map2.mjs` 嘅 `keyboardReachable = 25` 其實係
 * `MAX_ARROW = 24` 嘅硬上限（Tab 1 個 + 24 次 ArrowRight = 25 個）。
 * 呢個探測**唔設上限**，一直按到環繞返起點，量度：
 *   1. 係唔係**全部**互動元素（zone / route / location / cluster / event）
 *      都可以用方向鍵到達；
 *   2. 每類元素 `Enter` 係唔係都啟動到；
 *   3. 焦點環喺 dark / light 兩個主題都見唔見到；
 *   4. 到達嘅元素係唔係真係喺 viewport 內。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-full.mjs
 * 輸出：artifacts/audit-A7/c7-full-probe.json
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const SEL =
  ".zone, .route-line, .location-marker, .location-marker-cluster, .event-marker";
const OUT = "artifacts/audit-A7/c7-full-probe.json";

const IDENT = () => {
  const el = document.activeElement;
  if (!el || !el.getAttribute) return null;
  const id =
    el.getAttribute("data-zone-id") ??
    el.getAttribute("data-loc-id") ??
    el.getAttribute("data-event-id") ??
    el.getAttribute("data-route-id") ??
    "";
  const cls = (el.getAttribute("class") ?? "").split(/\s+/)[0];
  return `${cls}|${id}`;
};

const TYPE_OF = () => {
  const el = document.activeElement;
  if (!el || !el.getAttribute) return null;
  return (el.getAttribute("class") ?? "").split(/\s+/)[0];
};

const ORDER = (SEL) => {
  const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
  return els.map((e) => {
    const id =
      e.getAttribute("data-zone-id") ??
      e.getAttribute("data-loc-id") ??
      e.getAttribute("data-event-id") ??
      e.getAttribute("data-route-id") ??
      "";
    const cls = (e.getAttribute("class") ?? "").split(/\s+/)[0];
    return `${cls}|${id}`;
  });
};

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.setDefaultTimeout(40000);

async function load({ zoom = true } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#svg-map", { state: "visible", timeout: 30000 });
      await page
        .waitForFunction(
          () =>
            document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ??
            false,
          null,
          { timeout: 30000 },
        )
        .catch(() => {});
      await page.waitForTimeout(1500);
      if (zoom) {
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
          await page.waitForTimeout(150);
        }
        await page.waitForTimeout(900);
      }
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1500);
    }
  }
  throw lastErr;
}

async function traverse(n) {
  await page.evaluate(() => {
    const s = document.querySelector("#svg-map");
    if (s && typeof s.focus === "function") s.focus();
  });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(250);
  const seq = [await page.evaluate(IDENT)];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(45);
    seq.push(await page.evaluate(IDENT));
  }
  return seq;
}

const result = { measuredAt: new Date().toISOString(), baseUrl: BASE, errors: [] };

// ============================================================
// 探測 1：無上限環繞 —— 係唔係全部互動元素都到得到？
// ============================================================
try {
  await load();
  const expected = await page.evaluate(ORDER, SEL);
  const total = expected.length;
  const seq = await traverse(total + 6);
  const reached = new Set(seq.filter(Boolean));
  const firstCycle = seq.slice(0, total + 1);
  const wrapped = seq[total + 1] === seq[1] || seq[total] === seq[0];
  const offscreen = await page.evaluate(
    ([SEL]) => {
      const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
      const out = [];
      els.forEach((e, i) => {
        const b = e.getBoundingClientRect();
        const visible =
          b.width > 0 &&
          b.height > 0 &&
          b.bottom > 0 &&
          b.right > 0 &&
          b.top < window.innerHeight &&
          b.left < window.innerWidth;
        if (!visible) out.push({ i, cls: (e.getAttribute("class") ?? "").split(/\s+/)[0] });
      });
      return { count: out.length, sample: out.slice(0, 10) };
    },
    [SEL],
  );
  const tabindexInvariant = await page.evaluate((SEL) => {
    const els = Array.from(document.querySelectorAll(`#svg-map ${SEL}`));
    return {
      zero: els.filter((e) => e.getAttribute("tabindex") === "0").length,
      minusOne: els.filter((e) => e.getAttribute("tabindex") === "-1").length,
    };
  }, SEL);
  result.traversal = {
    expectedTotal: total,
    distinctReached: reached.size,
    allReachable: reached.size === total,
    firstCycleMatchesDocOrder:
      JSON.stringify(firstCycle.slice(1, total + 1)) === JSON.stringify(expected),
    wrappedBackToStart: wrapped,
    seqHead: seq.slice(0, 30),
    seqTail: seq.slice(-10),
    neverReached: expected.filter((e) => !reached.has(e)),
    offscreenElements: offscreen,
    tabindexInvariant,
  };
} catch (e) {
  result.errors.push({ section: "traversal", message: String(e) });
}

// ============================================================
// 探測 2：逐類元素 Enter 啟動
// ============================================================
try {
  const types = [
    "zone",
    "route-line",
    "location-marker",
    "location-marker-cluster",
    "event-marker",
  ];
  const perType = {};
  for (const type of types) {
    try {
      await load();
      const order = await page.evaluate(ORDER, SEL);
      const idx = order.findIndex((o) => o.startsWith(type + "|"));
      if (idx < 0) {
        perType[type] = { present: false };
        continue;
      }
      await page.evaluate(() => {
        const s = document.querySelector("#svg-map");
        if (s && typeof s.focus === "function") s.focus();
      });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(200);
      for (let i = 0; i < idx; i++) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(40);
      }
      const landedType = await page.evaluate(TYPE_OF);
      const before = await page.evaluate(() => ({
        url: location.href,
        zoneSel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
        eventSel: document.querySelectorAll(".event-marker.is-selected").length,
        viewBox: document.querySelector("#svg-map")?.getAttribute("viewBox") ?? null,
      }));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
      const after = await page.evaluate(() => ({
        url: location.href,
        zoneSel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
        eventSel: document.querySelectorAll(".event-marker.is-selected").length,
        viewBox: document.querySelector("#svg-map")?.getAttribute("viewBox") ?? null,
      }));
      perType[type] = {
        present: true,
        index: idx,
        landedType,
        before,
        after,
        urlChanged: before.url !== after.url,
        viewBoxChanged: before.viewBox !== after.viewBox,
        stateChanged:
          before.zoneSel !== after.zoneSel ||
          before.eventSel !== after.eventSel ||
          before.url !== after.url ||
          before.viewBox !== after.viewBox,
      };
    } catch (e) {
      perType[type] = { present: null, error: String(e) };
    }
  }
  result.activationByType = perType;
} catch (e) {
  result.errors.push({ section: "activation", message: String(e) });
}

// ============================================================
// 探測 3：焦點環 dark / light 逐像素
// ============================================================
try {
  const ring = {};
  for (const theme of ["dark", "light"]) {
    try {
      await load();
      await page.evaluate((t) => {
        if (t === "light") document.documentElement.setAttribute("data-theme", "light");
        else document.documentElement.removeAttribute("data-theme");
      }, theme);
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const s = document.querySelector("#svg-map");
        if (s && typeof s.focus === "function") s.focus();
      });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(250);
      const box = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || !el.getBoundingClientRect) return null;
        const b = el.getBoundingClientRect();
        const pad = 12;
        const x = Math.max(0, Math.floor(b.x - pad));
        const y = Math.max(0, Math.floor(b.y - pad));
        const right = Math.min(window.innerWidth, Math.ceil(b.right + pad));
        const bottom = Math.min(window.innerHeight, Math.ceil(b.bottom + pad));
        if (right - x < 12 || bottom - y < 12) return null;
        return {
          x,
          y,
          width: right - x,
          height: bottom - y,
          cls: (el.getAttribute("class") ?? "").split(/\s+/)[0],
          filter: getComputedStyle(el).filter,
        };
      });
      if (!box) {
        ring[theme] = { measured: false, reason: "no box" };
        continue;
      }
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.waitForTimeout(250);
      const unfocused = await page.screenshot({ clip: box });
      await page.evaluate(() => {
        const s = document.querySelector("#svg-map");
        if (s && typeof s.focus === "function") s.focus();
      });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(250);
      const focused = await page.screenshot({ clip: box });
      const focusedFilter = await page.evaluate(
        () => getComputedStyle(document.activeElement).filter,
      );
      const diffPixels = Buffer.compare(unfocused, focused) !== 0;
      fs.writeFileSync(`artifacts/audit-A7/c7-ring-${theme}-focused.png`, focused);
      fs.writeFileSync(`artifacts/audit-A7/c7-ring-${theme}-unfocused.png`, unfocused);
      ring[theme] = { measured: true, box, diffPixels, focusedFilter };
    } catch (e) {
      ring[theme] = { measured: false, error: String(e) };
    }
  }
  result.focusRingByTheme = ring;
} catch (e) {
  result.errors.push({ section: "ring", message: String(e) });
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();

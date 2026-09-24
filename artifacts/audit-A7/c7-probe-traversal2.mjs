/**
 * C7 探測 C：雙向環繞 + 逐類啟動 + route 圖層開關對照。
 *
 * 用法：BASE_URL=http://localhost:5175/ node artifacts/audit-A7/c7-probe-traversal2.mjs
 * 輸出：artifacts/audit-A7/c7-traversal2.json
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5175/";
const SEL =
  ".zone, .route-line, .location-marker, .location-marker-cluster, .event-marker";
const OUT = "artifacts/audit-A7/c7-traversal2.json";
const log = (...a) => console.log("[t2]", ...a);

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
const ORDER = (SEL) =>
  Array.from(document.querySelectorAll(`#svg-map ${SEL}`)).map((e) => {
    const id =
      e.getAttribute("data-zone-id") ??
      e.getAttribute("data-loc-id") ??
      e.getAttribute("data-event-id") ??
      e.getAttribute("data-route-id") ??
      "";
    const cls = (e.getAttribute("class") ?? "").split(/\s+/)[0];
    return `${cls}|${id}`;
  });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

async function load({ routesOn = false } = {}) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#svg-map", { state: "visible", timeout: 25000 });
  await page.waitForTimeout(1400);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.querySelector("#map-zoom-in")?.click());
    await page.waitForTimeout(140);
  }
  await page.waitForTimeout(700);
  if (routesOn) {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("#layer-controls button"));
      const b = btns.find((x) => (x.textContent ?? "").includes("路線"));
      if (b) {
        b.click();
        return true;
      }
      return false;
    });
    await page.waitForTimeout(900);
    return clicked;
  }
  return false;
}

async function focusFirst() {
  await page.evaluate(() => {
    const s = document.querySelector("#svg-map");
    if (s && typeof s.focus === "function") s.focus();
  });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(220);
}

async function walk(dir, n) {
  const key = dir === "next" ? "ArrowRight" : "ArrowLeft";
  const seq = [await page.evaluate(IDENT)];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(35);
    seq.push(await page.evaluate(IDENT));
  }
  return seq;
}

const result = { measuredAt: new Date().toISOString(), baseUrl: BASE };

// ── 1. 預設狀態：雙向 ──
await load();
const orderDefault = await page.evaluate(ORDER, SEL);
const total = orderDefault.length;
log("total", total);

await focusFirst();
const fwd = await walk("next", total + 6);
const fwdDistinct = new Set(fwd.filter(Boolean));

await load();
await focusFirst();
const bwd = await walk("prev", total + 6);
const bwdDistinct = new Set(bwd.filter(Boolean));

const union = new Set([...fwdDistinct, ...bwdDistinct]);
result.default = {
  total,
  forwardDistinct: fwdDistinct.size,
  backwardDistinct: bwdDistinct.size,
  unionDistinct: union.size,
  forwardTail: fwd.slice(-6),
  backwardTail: bwd.slice(-6),
  unreachable: orderDefault.filter((o) => !union.has(o)),
  forwardStuckAt: fwd.slice(-1)[0],
  backwardStuckAt: bwd.slice(-1)[0],
};
log("default union", union.size, "unreachable", result.default.unreachable.length);

// ── 2. routes 圖層開 ON ──
const clicked = await load({ routesOn: true });
const orderRoutes = await page.evaluate(ORDER, SEL);
await focusFirst();
const fwdR = await walk("next", orderRoutes.length + 6);
const fwdRDistinct = new Set(fwdR.filter(Boolean));
result.routesOn = {
  toggleClicked: clicked,
  total: orderRoutes.length,
  forwardDistinct: fwdRDistinct.size,
  forwardTail: fwdR.slice(-6),
  unreachable: orderRoutes.filter((o) => !fwdRDistinct.has(o)),
  routeLineVisible: await page.evaluate(() => {
    const el = document.querySelector("#svg-map .route-line");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height) };
  }),
};
log("routesOn forward", fwdRDistinct.size);

// ── 3. 逐類啟動 ──
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
    const routesNeeded = type === "route-line";
    await load({ routesOn: routesNeeded });
    const order = await page.evaluate(ORDER, SEL);
    const idx = order.findIndex((o) => o.startsWith(type + "|"));
    if (idx < 0) {
      perType[type] = { present: false };
      continue;
    }
    await focusFirst();
    // 揀方向：index <= 47 → forward；>= 49 → backward；48 → 試 forward 一次
    if (idx <= Math.floor(order.length / 2)) {
      for (let i = 0; i < idx; i++) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(35);
      }
    } else {
      for (let i = 0; i < order.length - idx; i++) {
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(35);
      }
    }
    const landed = await page.evaluate(IDENT);
    const before = await page.evaluate(() => ({
      url: location.href,
      zoneSel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
      eventSel: document.querySelectorAll(".event-marker.is-selected").length,
      viewBox: document.querySelector("#svg-map")?.getAttribute("viewBox") ?? null,
      ch: new URL(location.href).searchParams.get("ch"),
    }));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => ({
      url: location.href,
      zoneSel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
      eventSel: document.querySelectorAll(".event-marker.is-selected").length,
      viewBox: document.querySelector("#svg-map")?.getAttribute("viewBox") ?? null,
      ch: new URL(location.href).searchParams.get("ch"),
    }));
    perType[type] = {
      present: true,
      index: idx,
      landed,
      reachedTarget: landed === order[idx],
      before,
      after,
      activated:
        before.zoneSel !== after.zoneSel ||
        before.eventSel !== after.eventSel ||
        before.url !== after.url ||
        before.viewBox !== after.viewBox,
    };
    log("activate", type, "landed", landed, "activated", perType[type].activated);
  } catch (e) {
    perType[type] = { present: null, error: String(e) };
  }
}
result.activationByType = perType;

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();

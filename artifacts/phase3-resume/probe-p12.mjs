/**
 * P1-2 回歸探測：重現 `map-interaction.e2e.test.ts` 嘅「輕觸要選中、拖曳要平移」
 * 步驟，並 dump 診斷（zone 數、bbox、elementFromPoint、activeElement）。
 *
 * 用法：node artifacts/phase3-resume/probe-p12.mjs
 * ⚠️ 需要 dist/；會自己起 vite preview（跑完關）。
 */

import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;

const INIT = `
(() => { try { localStorage.setItem("binggang.onboarding.dismissed", "1"); } catch (e) {} })();
`;

async function probe(url, ms = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await probe(BASE)) return null;
  const s = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    if (await probe(BASE)) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("preview server 起唔到");
}

/** 同測試檔一樣嘅 pick（但會回診斷）。 */
const PICK = ({ minSize, margin }) => {
  const svg = document.querySelector("#svg-map");
  const r = svg.getBoundingClientRect();
  const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
  const diag = {
    zoneCount: zones.length,
    svgRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    areas: [],
  };
  for (const z of zones) {
    const a = z.querySelector(".zone-area");
    if (!a) {
      diag.areas.push({ id: z.getAttribute("data-zone-id"), noArea: true });
      continue;
    }
    const b = a.getBoundingClientRect();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const el = document.elementFromPoint(cx, cy);
    diag.areas.push({
      id: z.getAttribute("data-zone-id"),
      w: Math.round(b.width),
      h: Math.round(b.height),
      cx: Math.round(cx),
      cy: Math.round(cy),
      hit: el ? (el.getAttribute("class") ?? el.tagName) : null,
      tabindex: z.getAttribute("tabindex"),
    });
    if (b.width < minSize || b.height < minSize) continue;
    if (cx < r.x + margin || cx > r.right - margin) continue;
    if (cy < r.y + margin || cy > r.bottom - margin) continue;
    const ok =
      Boolean(el?.closest?.(".zone")) ||
      el?.classList.contains("zone-area") === true ||
      el?.classList.contains("zone") === true;
    if (!ok) continue;
    return { pick: { cx, cy, id: z.getAttribute("data-zone-id") }, diag };
  }
  return { pick: null, diag };
};

const server = await ensureServer();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page
    .waitForFunction(
      () => document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready") ?? false,
      null,
      { timeout: 20000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);

  const dump = async (label) => {
    const r = await page.evaluate(PICK, { minSize: 16, margin: 8 });
    const act = await page.evaluate(() => {
      const el = document.activeElement;
      return el
        ? `${el.tagName}.${(el.getAttribute("class") ?? "").split(" ")[0]} tabindex=${el.getAttribute("tabindex")}`
        : "(none)";
    });
    console.log(`\n=== ${label} ===`);
    console.log(`activeElement: ${act}`);
    console.log(`zoneCount=${r.diag.zoneCount} svg=${JSON.stringify(r.diag.svgRect)}`);
    console.log(`pick=${r.pick ? JSON.stringify(r.pick) : "null"}`);
    console.log("前 6 個 zone:", JSON.stringify(r.diag.areas.slice(0, 6), null, 1));
    return r.pick;
  };

  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await page.waitForTimeout(1500);
  for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
  await page.waitForTimeout(900);

  const t1 = await dump("① 初次 pick");
  if (t1) {
    await page.mouse.click(t1.cx, t1.cy);
    await page.waitForTimeout(600);
  }
  const after = await page.evaluate(() => {
    const svg = document.querySelector("#svg-map");
    const el = document.activeElement;
    const before = `${el?.tagName}.${(el?.getAttribute("class") ?? "").split(" ")[0]}`;
    // 手動試 focus SVG root，睇下得唔得
    svg.focus();
    const afterSvg = document.activeElement?.tagName;
    const g = document.querySelector("#zones-layer .zone");
    g.focus();
    const afterG = `${document.activeElement?.tagName}.${(document.activeElement?.getAttribute("class") ?? "").split(" ")[0]}`;
    return {
      sel: document.querySelectorAll("#zones-layer .zone.is-selected").length,
      url: location.href,
      activeAfterClick: before,
      svgTabindex: svg.getAttribute("tabindex"),
      svgRole: svg.getAttribute("role"),
      activeAfterSvgFocus: afterSvg,
      activeAfterGFocus: afterG,
      zoneTabindex: g.getAttribute("tabindex"),
    };
  });
  console.log(`\n=== ① 點擊後 ===\n${JSON.stringify(after, null, 1)}`);

  await page.keyboard.press("0");
  await page.waitForTimeout(1000);
  const afterReset = await page.evaluate(() => {
    const vb = (document.querySelector("#svg-map")?.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    return { viewW: vb[2], act: document.activeElement?.tagName };
  });
  console.log(`=== ② reset 後 ===\n${JSON.stringify(afterReset)}`);

  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await page.waitForTimeout(1200);
  const afterK = await page.evaluate(() => {
    const vb = (document.querySelector("#svg-map")?.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    return { viewW: vb[2], ch: document.querySelector(".ch-pill.is-active")?.textContent };
  });
  console.log(`=== ② 197×k 後 ===\n${JSON.stringify(afterK)}`);

  for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
  await page.waitForTimeout(900);
  await dump("② 第二次 pick（測試失敗嘅位置）");
} finally {
  await browser.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid);
    } catch {
      /* 已死 */
    }
  }
}

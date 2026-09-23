/**
 * Phase 2 整合後視覺驗證（只讀 production，只寫 artifacts/）
 *
 * 用途：確認 B1（dark-first token）／B2（state+URL）／B4（資料 v2）整合之後
 *      首屏仍然正常渲染，並記錄 dark-first 是否生效。
 *
 * 執行：node artifacts/phase2-verify-visual.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });

const RUNS = [
  { id: "desktop-1440", width: 1440, height: 900 },
  { id: "tablet-768", width: 768, height: 1024 },
  { id: "mobile-390", width: 390, height: 844 },
];

const browser = await chromium.launch({
  headless: true,
  args: ["--no-proxy-server"],
});

const summary = [];

for (const vp of RUNS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    locale: "zh-HK",
  });
  const page = await ctx.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("response", (r) => {
    try {
      const h = new URL(r.url()).hostname;
      if (!["localhost", "127.0.0.1", "::1"].includes(h)) external.push(r.url());
    } catch {
      /* ignore */
    }
  });

  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const svg = q("#svg-map-mount svg");
    const wrap = q(".svg-map-wrap");
    const r = wrap?.getBoundingClientRect();
    const cs = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p).trim() : null);
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      bodyBg: cs(document.body, "background-color"),
      tokenBgBase: cs(document.documentElement, "--bg-base"),
      svgViewBox: svg?.getAttribute("viewBox") ?? null,
      wrapSize: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      zoneCount: document.querySelectorAll("#svg-map-mount .zone").length,
      eventMarkers: document.querySelectorAll("#svg-map-mount .event-marker").length,
      navCount: document.querySelectorAll("#topbar .nav-btn").length,
      iconUseCount: document.querySelectorAll("svg use").length,
      search: location.search,
      hash: location.hash,
      scrollW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    };
  });

  await page.screenshot({ path: `${OUT}/phase2-${vp.id}.png`, fullPage: false });

  summary.push({
    ...vp,
    ...info,
    pageErrors: errors.length,
    externalRequests: external.length,
    externalSample: external.slice(0, 3),
  });
  await ctx.close();
}

// 深層連結驗證（spec §5.1：refresh 必須重現）
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p2 = await ctx2.newPage();
await p2.goto(`${BASE}?zone=zone_d3f76d3c94`, { waitUntil: "networkidle" });
await p2.waitForTimeout(1200);
const zoneDeep = await p2.evaluate(() => ({
  search: location.search,
  dossierVisible: (() => {
    const m = document.querySelector("#zone-dossier-mount");
    return !!m && !m.hidden;
  })(),
}));
await p2.screenshot({ path: `${OUT}/phase2-zone-deeplink.png` });
await ctx2.close();

await browser.close();

const out = {
  baseUrl: BASE,
  capturedAt: new Date().toISOString(),
  viewports: summary,
  zoneDeepLink: zoneDeep,
};
fs.writeFileSync("artifacts/phase2-visual-summary.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

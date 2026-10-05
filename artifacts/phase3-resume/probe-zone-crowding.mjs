/** C8 P1-1：量測世界視圖下 zone 層嘅擁擠情況（spec L-Z0 應為 cluster glyph）。 */
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;
async function ok(u, ms = 3000) {
  try { return (await fetch(u, { signal: AbortSignal.timeout(ms) })).ok; } catch { return false; }
}
async function ensure() {
  if (await ok(BASE)) return null;
  const s = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"],
    { cwd: process.cwd(), shell: true, stdio: "ignore", detached: true });
  for (let i = 0; i < 40; i++) { if (await ok(BASE)) return s; await new Promise(r => setTimeout(r, 500)); }
  throw new Error("server");
}

const MEASURE = () => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const zones = q("#zones-layer .zone");
  const rows = zones.map((z) => {
    const area = z.querySelector(".zone-area");
    const pulse = z.querySelector(".zone-pulse");
    const r = (area ?? z).getBoundingClientRect();
    const cs = area ? getComputedStyle(area) : null;
    return {
      id: z.getAttribute("data-zone-id"),
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      cx: Math.round((r.x + r.width / 2) * 10) / 10,
      cy: Math.round((r.y + r.height / 2) * 10) / 10,
      fill: cs?.fill ?? null,
      fillOpacity: cs?.fillOpacity ?? null,
      stroke: cs?.stroke ?? null,
      strokeWidth: cs?.strokeWidth ?? null,
      hasPulse: Boolean(pulse),
    };
  });
  // 兩兩重疊
  let pairs = 0, overlaps = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      pairs++;
      const a = rows[i], b = rows[j];
      const ox = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
      const oy = Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
      if (ox > 0 && oy > 0) overlaps++;
    }
  }
  const badges = q("#zones-layer .zone-cluster").map((g) => {
    const c = g.querySelector("circle");
    const t = g.querySelector("text");
    const r = c ? c.getBoundingClientRect() : null;
    return {
      count: g.getAttribute("data-zone-cluster-count"),
      d: r ? Math.round(r.width * 100) / 100 : null,
      fill: c ? getComputedStyle(c).fill : null,
      stroke: c ? getComputedStyle(c).stroke : null,
      strokeW: c ? getComputedStyle(c).strokeWidth : null,
      textFill: t ? getComputedStyle(t).fill : null,
    };
  });
  // 逐個子元素類別量 bbox（搵出真正主導視覺嘅元素）
  const childStats = {};
  for (const z of zones) {
    for (const c of Array.from(z.children)) {
      const cls = c.getAttribute("class") ?? c.tagName;
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      const cur = childStats[cls] ?? { n: 0, w: [], h: [], stroke: cs.stroke, strokeW: cs.strokeWidth, fillOp: cs.fillOpacity, op: cs.opacity, pe: cs.pointerEvents };
      cur.n++;
      cur.w.push(Math.round(r.width * 10) / 10);
      cur.h.push(Math.round(r.height * 10) / 10);
      childStats[cls] = cur;
    }
  }
  for (const k of Object.keys(childStats)) {
    const s = childStats[k];
    s.minW = Math.min(...s.w); s.maxW = Math.max(...s.w);
    s.minH = Math.min(...s.h); s.maxH = Math.max(...s.h);
    delete s.w; delete s.h;
  }
  const svg = document.querySelector("#svg-map");
  return {
    viewBox: svg?.getAttribute("viewBox"),
    svgW: svg ? Math.round(svg.getBoundingClientRect().width) : null,
    svgH: svg ? Math.round(svg.getBoundingClientRect().height) : null,
    nZones: rows.length,
    nAreas: q("#zones-layer .zone-area").length,
    nPulses: q("#zones-layer .zone-pulse").length,
    nBadges: badges.length,
    zoneBox: rows.length
      ? {
          minW: Math.min(...rows.map((r) => r.w)),
          maxW: Math.max(...rows.map((r) => r.w)),
          medW: rows.map((r) => r.w).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
        }
      : null,
    sampleZone: rows[0] ?? null,
    pairs,
    overlaps,
    overlapPct: pairs ? Math.round((overlaps / pairs) * 1000) / 10 : 0,
    badges,
    childStats,
  };
};

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  for (const vp of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    const page = await browser.newPage({ viewport: vp, locale: "zh-HK", deviceScaleFactor: 3 });
    await page.addInitScript(() => {
      try { localStorage.setItem("binggang.onboarding.dismissed", "1"); } catch { /* */ }
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, { timeout: 20000 });
    await page.waitForTimeout(1200);
    const m = await page.evaluate(MEASURE);
    // 影低 TKO 一帶（zone 集中區）嘅裁剪圖
    const box = await page.evaluate(() => {
      const areas = Array.from(document.querySelectorAll("#zones-layer .zone-area"));
      const rs = areas.map((a) => a.getBoundingClientRect());
      const x = Math.max(0, Math.min(...rs.map((r) => r.x)) - 40);
      const y = Math.max(0, Math.min(...rs.map((r) => r.y)) - 40);
      const x2 = Math.min(innerWidth, Math.max(...rs.map((r) => r.x + r.width)) + 40);
      const y2 = Math.min(innerHeight, Math.max(...rs.map((r) => r.y + r.height)) + 40);
      return { x, y, width: x2 - x, height: y2 - y };
    });
    await page.screenshot({
      path: `artifacts/phase3-resume/zones3x-${vp.width}x${vp.height}.png`,
      clip: box,
    });
    console.log("screenshot box:", JSON.stringify(box));
    console.log(`\n=== ${vp.width}x${vp.height} ===`);
    console.log(JSON.stringify(m, null, 1));
    await page.close();
  }
} finally {
  await browser.close();
  if (server?.pid) { try { process.kill(-server.pid); } catch { /* */ } }
}

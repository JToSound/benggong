/** 驗證：co-located location 成員喺最大縮放之下有幾多個真正可點。 */
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = "http://localhost:" + PORT + "/";
const ok = async (u, ms = 3000) => {
  try {
    return (await fetch(u, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
};
async function ensure() {
  if (await ok(BASE)) return null;
  const s = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    if (await ok(BASE)) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server");
}

const HIT = () => {
  const markers = Array.from(document.querySelectorAll("#locations-layer .location-marker"));
  const clusters = Array.from(document.querySelectorAll("#locations-layer .location-marker-cluster"));
  const selfHit = new Set();
  const byPoint = {};
  for (const m of markers) {
    const r = m.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    const key = Math.round(cx) + "," + Math.round(cy);
    const myId = m.getAttribute("data-loc-id");
    (byPoint[key] = byPoint[key] || []).push(myId);
    const el = document.elementFromPoint(cx, cy);
    const hit = el && el.closest ? el.closest(".location-marker, .location-marker-cluster") : null;
    if (hit && hit.getAttribute("data-loc-id") === myId) selfHit.add(myId);
  }
  const counts = Object.values(byPoint).map((v) => v.length);
  const top = Object.entries(byPoint).sort((a, b) => b[1].length - a[1].length)[0] || null;
  return {
    viewBox: document.querySelector("#svg-map") && document.querySelector("#svg-map").getAttribute("viewBox"),
    markers: markers.length,
    clusters: clusters.length,
    distinctPoints: Object.keys(byPoint).length,
    maxAtOnePoint: counts.length ? Math.max.apply(null, counts) : 0,
    topPoint: top ? { key: top[0], n: top[1].length } : null,
    nSelfHittable: selfHit.size,
  };
};

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("binggang.onboarding.dismissed", "1");
    } catch {
      /* */
    }
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
    timeout: 20000,
  });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await page.waitForTimeout(1200);
  for (let i = 0; i < 3; i++) {
    await page.click("#map-zoom-in", { force: true });
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(900);
  console.log("放大 3 級：", JSON.stringify(await page.evaluate(HIT), null, 1));

  // 撳最大嘅 location cluster（觸發 zoomToLocation）→ 再量度
  const box = await page.evaluate(() => {
    const cs = Array.from(document.querySelectorAll("#locations-layer .location-marker-cluster"));
    if (!cs.length) return null;
    cs.sort((a, b) => Number(b.getAttribute("data-loc-count") || 0) - Number(a.getAttribute("data-loc-count") || 0));
    const r = cs[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: cs[0].getAttribute("data-loc-count") };
  });
  console.log("最大 cluster：", JSON.stringify(box));
  if (box) {
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(1500);
    console.log("撳咗 cluster（zoomToLocation）之後：", JSON.stringify(await page.evaluate(HIT), null, 1));
    // 再手動放大 8 級
    for (let i = 0; i < 8; i++) {
      await page.click("#map-zoom-in", { force: true });
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(800);
    console.log("再放大 8 級之後：", JSON.stringify(await page.evaluate(HIT), null, 1));
  }
} finally {
  await browser.close();
  if (server && server.pid) {
    try {
      process.kill(-server.pid);
    } catch {
      /* */
    }
  }
}

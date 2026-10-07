/**
 * D 階段 4 工具：執行期收集「實際出現過嘅 class 名」（第三重判準）。
 *
 * 為何要有
 * ========
 * 靜態分析（`scripts/audit_dead_css.py`）只可以證明「語料內冇字面引用」，
 * 但 class 可能由**執行期**拼出（例如由資料驅動）。所以要用真瀏覽器
 * 行多個 app 狀態，收集 `document.querySelectorAll("*")` 嘅 class 集合 ——
 * 有出現過就唔係死。
 *
 * ⚠️ 呢個係**抽樣**（唔可能窮舉所有狀態）→ 只可以否證「死」，
 *    唔可以單憑佢判定「死」。所以三重判準缺一不可。
 *
 * 用法：node artifacts/phase3-resume/probe-dead-css.mjs <out.json>
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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
  throw new Error("preview server 起唔到");
}

const CLASSES = () => {
  const set = new Set();
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const cls = el.getAttribute("class");
    if (!cls) continue;
    for (const c of cls.split(/\s+/)) if (c) set.add(c);
    // SVG 用 className 可能係 SVGAnimatedString —— 上面已用 attribute 覆蓋
  }
  return Array.from(set).sort();
};

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const states = {};
async function snap(page, name) {
  states[name] = { n: (await page.evaluate(CLASSES)).length, classes: await page.evaluate(CLASSES) };
  console.log(`  ${name}: ${states[name].n} 個 class`);
}
try {
  // ---- 桌面：多個狀態 ----
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
  await page.waitForTimeout(800);
  await snap(page, "desktop-default");

  // 面板打開
  await page.click("#btn-toggle-panel", { force: true, timeout: 15000 });
  await page.waitForTimeout(600);
  await snap(page, "desktop-pane-open");

  // 去第 198 章（資料最齊）+ 揀 zone
  await page.keyboard.press("Escape");
  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await page.waitForTimeout(1200);
  await snap(page, "desktop-ch198");
  const z = await page.evaluate(() => {
    const el = document.querySelector("#zones-layer .zone");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (z) {
    await page.mouse.click(z.x, z.y);
    await page.waitForTimeout(900);
    await snap(page, "desktop-zone-selected");
  }

  // 編年史
  await page.click("#btn-mode", { force: true, timeout: 15000 });
  await page.waitForTimeout(1000);
  await snap(page, "desktop-chronicle");

  // 搜尋 overlay
  await page.keyboard.press("/");
  await page.waitForTimeout(600);
  await snap(page, "desktop-search-open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.close();

  // ---- 手機 ----
  const m = await browser.newPage({
    viewport: { width: 390, height: 844 },
    locale: "zh-HK",
    hasTouch: true,
    isMobile: true,
  });
  await m.goto(BASE, { waitUntil: "networkidle" });
  await m.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
    timeout: 20000,
  });
  await m.waitForTimeout(800);
  await snap(m, "mobile-default");
  await m.close();
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

const all = new Set();
for (const s of Object.values(states)) for (const c of s.classes) all.add(c);
const out = process.argv[2] || "artifacts/phase3-resume/dead-css-runtime.json";
writeFileSync(out, JSON.stringify({ nStates: Object.keys(states).length, union: all.size, states }, null, 1), "utf-8");
console.log(`\n已寫入 ${out}（${Object.keys(states).length} 個狀態、聯集 ${all.size} 個 class）`);

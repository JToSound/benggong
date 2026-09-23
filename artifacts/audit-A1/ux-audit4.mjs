/**
 * A1 第四輪：強制開啟 zone dossier（經 .zone-glow stroke，因 .zone-area
 * pointer-events:none 且 badge 被 event marker 覆蓋），量測 dossier 內容與
 * 返回路徑；另加 tablet 快照。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A1";
const SHOTS = path.join(OUT, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
const out = { baseUrl: BASE, capturedAt: new Date().toISOString() };

async function ready(page) {
  await page.waitForSelector("#topbar", { timeout: 40000 });
  await page.waitForTimeout(1000);
}
async function fresh(page, suffix = "") {
  await page.goto(`${BASE}?t=${Date.now()}${suffix}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await ready(page);
}

const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });

// ===== zone dossier 內容（用 stroke 命中）=====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);
  // 用 elementFromPoint 搵到 .zone-glow 上一點再 dispatch click
  const clicked = await page.evaluate(() => {
    const glow = document.querySelector("#zones-layer .zone .zone-glow");
    if (!glow) return false;
    const b = glow.getBoundingClientRect();
    // 沿 bbox 邊框掃描，搵一個 elementFromPoint 命中 .zone-glow 嘅位置
    for (let x = b.left; x <= b.right; x += 1) {
      for (let y = b.top; y <= b.bottom; y += 1) {
        const e = document.elementFromPoint(x, y);
        if (e && e.classList && e.classList.contains("zone-glow")) {
          e.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
          return true;
        }
      }
    }
    return false;
  });
  await page.waitForTimeout(700);
  out.zoneDossier = await page.evaluate(() => {
    const d = document.querySelector("#zone-dossier-mount");
    const qa = (s) => [...document.querySelectorAll(`#zone-dossier-mount ${s}`)];
    return {
      clickedGlow: null,
      mode: document.querySelector("#btn-mode")?.textContent?.trim(),
      storyPanelHidden: document.querySelector("#story-panel-mount")?.hidden ?? null,
      dossierHidden: d?.hidden ?? null,
      title: d?.querySelector("h2")?.textContent?.trim() ?? null,
      textLen: (d?.innerText || "").length,
      sections: qa(".zd-section-title").map((e) => e.textContent.trim()),
      metrics: qa(".zd-metric").map((e) => e.innerText.replace(/\n/g, " ")),
      hasEvidence: !!d?.querySelector(".zd-evidence"),
      chapterChips: qa(".zd-ch").length,
      hash: location.hash,
      // 有冇「返回世界地圖」／相關事件／相關角色／時間軸
      backLinks: (d?.innerText || "").match(/返回|相關事件|相關角色|時間軸|世界地圖/g) || [],
    };
  });
  out.zoneDossier.clickedGlow = clicked;
  await page.screenshot({ path: path.join(SHOTS, "a1-desktop-zone-dossier-forced.png") });

  // Esc 之後能否返到世界地圖
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  out.zoneDossier.afterEsc = await page.evaluate(() => ({
    mode: document.querySelector("#btn-mode")?.textContent?.trim(),
    dossierHidden: document.querySelector("#zone-dossier-mount")?.hidden ?? null,
    storyPanelTitle: document.querySelector("#story-panel-mount h2")?.textContent?.trim() ?? null,
  }));
  await ctx.close();
}

// ===== tablet 768 =====
{
  const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 }, locale: "zh-HK" });
  const page = await ctx.newPage();
  await fresh(page);
  out.tablet = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const legend = q("#map-legend")?.getBoundingClientRect();
    const map = q("#map-pane")?.getBoundingClientRect();
    return {
      panelCollapsed: q("#story-pane")?.classList.contains("is-collapsed") ?? null,
      panelToggleVisible: (q("#btn-toggle-panel")?.getBoundingClientRect().width ?? 0) > 0,
      legend: legend
        ? { w: Math.round(legend.width), h: Math.round(legend.height), pctW: Math.round((legend.width / window.innerWidth) * 100) }
        : null,
      legendPctOfMap: legend && map ? Math.round((legend.width * legend.height) / (map.width * map.height) * 100) : null,
      mapRect: map ? { w: Math.round(map.width), h: Math.round(map.height) } : null,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      chronicleVisible: !!q("#story-panel-mount .chronicle")?.getBoundingClientRect().width,
    };
  });
  await page.screenshot({ path: path.join(SHOTS, "a1-tablet-default.png") });
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, "ux-audit4-results.json"), JSON.stringify(out, null, 2));
await browser.close();
console.log(JSON.stringify(out, null, 2));

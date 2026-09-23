/**
 * Phase 3：補 spec §8 要求嘅 journey screenshots。
 *
 * 產出（`docs/assets/v2/`）：
 *   · `v2-map-desktop-1440.png`       —— desktop 首屏（dark）
 *   · `v2-map-mobile-390.png`         —— mobile 首屏（dark）
 *   · `v2-map-desktop-1440-light.png` —— desktop 首屏（light）
 *   · `v2-zone-dossier-desktop.png`   —— 選中 zone 之後嘅 dossier
 *
 * ⚠️ 唔用人手截圖 —— 全部由 Playwright 程式化產生（可重跑）。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";
const OUT = "docs/assets/v2";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

/** 等向量底圖 ready（同其他 e2e 一致）。 */
async function waitReady(page) {
  await page.waitForFunction(
    () =>
      document.querySelector(".svg-map-wrap")?.classList.contains("basemap-vector-ready"),
    { timeout: 25_000 },
  );
  await page.waitForTimeout(800);
}

// ① Desktop 1440×900（dark）
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await waitReady(page);
  await page.screenshot({ path: `${OUT}/v2-map-desktop-1440.png` });
  console.log("✅ v2-map-desktop-1440.png");

  // ④ 選中一個 zone → dossier 截圖
  const picked = await page.evaluate(() => {
    const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
    for (const z of zones) {
      const a = z.querySelector(".zone-area");
      if (!a) continue;
      const b = a.getBoundingClientRect();
      if (b.width < 16 || b.height < 16) continue;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  });
  if (picked) {
    await page.mouse.click(picked.x, picked.y);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/v2-zone-dossier-desktop.png` });
    console.log("✅ v2-zone-dossier-desktop.png");
  } else {
    console.log("⚠️ 搵唔到夠大嘅 zone，跳過 dossier 截圖");
  }

  // ③ Light 主題
  await page.click("#btn-theme");
  await page.mouse.move(0, 0); // 移開滑鼠（避免 :hover 影響）
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/v2-map-desktop-1440-light.png` });
  console.log("✅ v2-map-desktop-1440-light.png");
  await page.close();
}

// ② Mobile 390×844（dark）
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await waitReady(page);
  await page.screenshot({ path: `${OUT}/v2-map-mobile-390.png` });
  console.log("✅ v2-map-mobile-390.png");
  await page.close();
}

await browser.close();
console.log("\n全部截圖已寫入", OUT);

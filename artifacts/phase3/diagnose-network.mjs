/**
 * 網絡請求診斷：搵出「首次載入下載咗咩」。
 *
 * ⚠️ 重點檢查：`hk-basemap.png`（1.89 MB raster fallback）有冇被下載 ——
 * 正常情況唔應該（`fallbackToRaster()` 唔設預設 href）。
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const reqs = [];
page.on("response", async (res) => {
  const url = res.url();
  if (!url.startsWith(BASE)) return;
  let size = 0;
  try {
    const h = res.headers();
    size = Number(h["content-length"] ?? 0);
  } catch {}
  reqs.push({ url: url.replace(BASE, ""), status: res.status(), size });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(5000);

// 按大小排序
const sorted = [...reqs].sort((a, b) => b.size - a.size);
const total = reqs.reduce((a, b) => a + b.size, 0);

console.log(`=== 總請求 ${reqs.length} 個 ｜ 合計 ${(total / 1048576).toFixed(2)} MB ===\n`);
console.log("【最大 15 個】");
for (const r of sorted.slice(0, 15)) {
  console.log(`  ${(r.size / 1048576).toFixed(2).padStart(6)} MB  ${r.status}  ${r.url}`);
}

// 重點檢查 raster fallback
const raster = reqs.filter((r) => r.url.includes("hk-basemap"));
console.log(`\n【raster fallback 檢查】`);
if (raster.length === 0) {
  console.log("  ✅ 冇下載 hk-basemap*（正常）");
} else {
  for (const r of raster) {
    console.log(`  ⚠️ 有下載！${(r.size / 1048576).toFixed(2)} MB  ${r.url}`);
  }
}

// 分類統計
const byType = {};
for (const r of reqs) {
  const ext = r.url.split(".").pop()?.split("?")[0] ?? "?";
  byType[ext] = byType[ext] ?? { n: 0, bytes: 0 };
  byType[ext].n++;
  byType[ext].bytes += r.size;
}
console.log("\n【按類型】");
for (const [ext, v] of Object.entries(byType).sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  .${ext.padEnd(8)} ${String(v.n).padStart(3)} 個  ${(v.bytes / 1048576).toFixed(2)} MB`);
}

await browser.close();

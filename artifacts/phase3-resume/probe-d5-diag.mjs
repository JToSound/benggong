/** D5 診斷：隔離測試 comparePng 嘅比對邏輯（用已知唔同嘅圖）。 */
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";

const CMP = async ([ua, ub, scale]) => {
  const decode = async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  };
  const toData = (img, w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  };
  const A0 = await decode(ua);
  const w = Math.max(1, A0.width);
  const h = Math.max(1, A0.height);
  const A = toData(A0, w, h);
  const B0 = await decode(ub);
  const B = toData(B0, w, h);
  let diffPixels = 0;
  let maxDelta = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.max(
      Math.abs(A.data[i] - B.data[i]),
      Math.abs(A.data[i + 1] - B.data[i + 1]),
      Math.abs(A.data[i + 2] - B.data[i + 2]),
    );
    if (d > 0) diffPixels++;
    if (d > maxDelta) maxDelta = d;
  }
  return {
    aNat: `${A0.width}x${A0.height}`,
    bNat: `${B0.width}x${B0.height}`,
    w,
    h,
    total: A.data.length / 4,
    diffPixels,
    maxDelta,
    aSum: A.data.reduce((s, v) => s + v, 0),
    bSum: B.data.reduce((s, v) => s + v, 0),
    scale: scale,
  };
};

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
await withTeardown(browser, server, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });

  const baseline = `data:image/png;base64,${readFileSync(
    "tests/baselines/visual/01-desktop-default.png",
  ).toString("base64")}`;
  const sp3 = `data:image/png;base64,${readFileSync(
    "artifacts/phase3-resume/vs-sp3/01-desktop-default.png",
  ).toString("base64")}`;

  console.log("A = 基線（12px build），B = vs-sp3（20px build）→ 應該有大差異");
  console.log(JSON.stringify(await page.evaluate(CMP, [baseline, sp3, 0.5]), null, 1));

  console.log("\nA = 基線，B = 基線 → 應該 0 差異（對照）");
  console.log(JSON.stringify(await page.evaluate(CMP, [baseline, baseline, 0.5]), null, 1));

  // 終極對照：B = 純紅色圖（720x450）→ 差異應該接近 100%
  const red = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 720;
    c.height = 450;
    const x = c.getContext("2d");
    x.fillStyle = "#ff0000";
    x.fillRect(0, 0, 720, 450);
    return c.toDataURL("image/png");
  });
  console.log("\nA = 基線，B = 純紅圖 → 應該接近 100% 差異");
  console.log(JSON.stringify(await page.evaluate(CMP, [baseline, red, 0.5]), null, 1));

  // 同一張圖但經過 canvas 重新編碼（round-trip）
  const rt = await page.evaluate(async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/png");
  }, sp3);
  console.log("\nA = 基線，B = vs-sp3 經 canvas round-trip → 應該仍然有大差異");
  console.log(JSON.stringify(await page.evaluate(CMP, [baseline, rt, 0.5]), null, 1));
});

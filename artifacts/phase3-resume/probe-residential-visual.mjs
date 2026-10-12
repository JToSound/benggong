/**
 * #14 視覺證據探針：住宅層有／冇 render 嘅前後對比。
 *
 * 做法
 * ====
 * 用**同一個狀態**跑兩次截圖，唯一分別係有冇攔截 `areas.json`：
 *   A. 現況（areas.json 含住宅層）→ PNG
 *   B. 攔截 `areas.json`，過濾走 `k === AREA_KIND_RESIDENTIAL` → PNG
 * 之後計逐像素差異。差異 ≈ 0 就代表「加咗但冇 render」（靜默失敗）；
 * 差異 > 0 就代表真係畫咗，而且差異量可以量化「住宅層佔畫面幾多」。
 *
 * ⚠️ 為何要呢個而唔止靠單元測試
 * ----------------------------
 * 單元測試證明「資料有住宅層」＋「setAreas 有 resi 分支」，
 * 但證明唔到「真瀏覽器真係 fill 咗」。呢個係專案反覆強調嘅
 * 「程式碼／computed style 正確 ≠ 繪製會發生」。
 *
 * ⚠️ 為何要用 `bootShotPage` 而唔自己砌程序
 * ----------------------------------------
 * `bootShotPage` 已經處理「先等穩定、再凍結動畫」嘅次序（MEMORY #41）。
 * 自己砌好容易搞錯次序 → 差異全部嚟自時序而唔係住宅層（假陽性）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";
import { STATES, bootShotPage, shoot } from "../../tests/helpers/visual-shots.ts";

const OUT = "artifacts/phase3-resume/residential-visual";
mkdirSync(OUT, { recursive: true });

const TARGET = process.argv[2] || "04-desktop-zone-selected";
const base = STATES.find((s) => s.name === TARGET);
if (!base) {
  console.error(`搵唔到狀態 ${TARGET}；可用：${STATES.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

/** 複製狀態再加「過濾住宅層」嘅 route。 */
const filteredState = {
  ...base,
  name: base.name + "-no-residential",
  blockServiceWorkers: true,
  beforeGoto: async (page) => {
    await base.beforeGoto?.(page);
    await page.route(/\/assets\/vector\/areas\.json$/, async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ areas: body.areas.filter((x) => x.k !== 2) }),
      });
    });
  },
};

const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });

let diff = null;
await withTeardown(browser, server, async () => {
  const pageA = await bootShotPage(browser, base, BASE);
  const a = await shoot(pageA);
  writeFileSync(`${OUT}/A-with-residential.png`, a);
  await pageA.close();

  const pageB = await bootShotPage(browser, filteredState, BASE);
  const b = await shoot(pageB);

  // 逐像素比對：零依賴（喺瀏覽器內用 Image + canvas decode PNG）。
  // ⚠️ 專案唔准加 runtime／dev 依賴，所以唔可以用 pngjs（見 a11y-keyboard）。
  const d = await pageB.evaluate(
    async ({ a64, b64 }) => {
      const load = (s) =>
        new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("PNG decode 失敗"));
          im.src = "data:image/png;base64," + s;
        });
      const [ia, ib] = await Promise.all([load(a64), load(b64)]);
      const c = document.createElement("canvas");
      c.width = ia.width;
      c.height = ia.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(ia, 0, 0);
      const da = ctx.getImageData(0, 0, c.width, c.height).data;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(ib, 0, 0);
      const db = ctx.getImageData(0, 0, c.width, c.height).data;
      let different = 0;
      let maxDelta = 0;
      for (let i = 0; i < da.length; i += 4) {
        const v =
          Math.abs(da[i] - db[i]) +
          Math.abs(da[i + 1] - db[i + 1]) +
          Math.abs(da[i + 2] - db[i + 2]);
        if (v > 0) different++;
        if (v > maxDelta) maxDelta = v;
      }
      return {
        different,
        total: ia.width * ia.height,
        maxDelta,
        size: `${ia.width}x${ia.height}`,
      };
    },
    { a64: a.toString("base64"), b64: b.toString("base64") },
  );
  writeFileSync(`${OUT}/B-without-residential.png`, b);
  await pageB.close();

  diff = { ...d, pct: (d.different / d.total) * 100 };
});

console.log(`=== 住宅層視覺證據（狀態：${TARGET}，${diff.size}）===`);
console.log(`  A（含住宅層）→ ${OUT}/A-with-residential.png`);
console.log(`  B（無住宅層）→ ${OUT}/B-without-residential.png`);
console.log(
  `  差異：${diff.different}/${diff.total} px（${diff.pct.toFixed(2)}%）｜最大 Δ ${diff.maxDelta}`,
);
console.log(
  diff.different > 0
    ? "  ✅ 住宅層真係 render 咗（有非零像素差異）"
    : "  ❌ 住宅層冇 render（差異為零 —— 靜默失敗）",
);

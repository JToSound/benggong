/**
 * b8-metrics.mjs — B8 交付報告用嘅實測數字（全部程式化、可重跑）
 * ============================================================
 *
 * 量四組嘢（對應交付報告「驗證」章節）：
 *   ① Tab 序（desktop 1440×900 同 mobile 390×844 嘅首 12 個 stop）
 *   ② focus ring 逐像素（focused vs unfocused 截圖 diff，分 ring 區／框內）
 *   ③ 44px 計數（mobile 390：真互動 + 真可見 + 中心點喺 viewport + 冇被遮蓋）
 *   ④ body / html scrollWidth（desktop 1400 同 mobile 390）
 *
 * 跑法（需要 dist/ 已 build；preview server 用 localhost，唔可以用 127.0.0.1）：
 *   npx vite preview --port 5195 --strictPort &
 *   PREVIEW_URL=http://localhost:5195/ node artifacts/b8-scratch/b8-metrics.mjs
 *
 * ⚠️ 唔可以喺 vitest 之外並行跑同一個 preview（會搶 server）。
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:5195/";

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

/** 等 app 首次 render 完成（章節條 198 粒 pill 全部 render）。 */
async function waitReady(page) {
  /*
   * ⚠️ 一定要等到**全部** 198 粒 pill render 完才量 scrollWidth。
   * 太早量（例如 >100 粒）會量唔到 P1-1 令 `.ch-pill` 變 44px 之後嘅
   * 佈局溢出（實測：>100 粒時 body.scrollWidth=1400，198 粒時 =1427）。
   */
  await page
    .waitForFunction(() => document.querySelectorAll(".ch-pill").length >= 198, { timeout: 30_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function newPage(vp) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await waitReady(page);
  return page;
}

const out = { base: BASE };

// ─────────────────────────────────────────────────────────────────────────────
// ① Tab 序
// ─────────────────────────────────────────────────────────────────────────────
async function tabOrder(vp, n) {
  const page = await newPage(vp);
  const stops = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Tab");
    const d = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { tag: "(none)", id: "", cls: "" };
      const cls =
        el.className && typeof el.className === "object" && "baseVal" in el.className
          ? el.className.baseVal
          : String(el.className || "");
      return { tag: el.tagName.toLowerCase(), id: el.id || "", cls: cls.split(/\s+/)[0] || "" };
    });
    stops.push(`${d.tag}${d.id ? "#" + d.id : ""}${d.cls ? "." + d.cls : ""}`);
  }
  await page.close();
  return stops;
}

out.tabOrder = {
  desktop1440: await tabOrder({ width: 1440, height: 900 }, 12),
  mobile390: await tabOrder({ width: 390, height: 844 }, 12),
};

// ─────────────────────────────────────────────────────────────────────────────
// ② focus ring 逐像素
// ─────────────────────────────────────────────────────────────────────────────

/** 喺 page 內 decode 兩張 PNG 逐像素比較（零依賴）。 */
async function pixelDiff(page, a, b, ringBox) {
  return page.evaluate(
    async ({ a64, b64, x0, y0, x1, y1 }) => {
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
      let ring = 0;
      let inner = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const d =
            Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
          if (d < 12) continue;
          if (x >= x0 && x < x1 && y >= y0 && y < y1) inner++;
          else ring++;
        }
      }
      return { ring, inner };
    },
    { a64: a.toString("base64"), b64: b.toString("base64"), x0: ringBox.x0, y0: ringBox.y0, x1: ringBox.x1, y1: ringBox.y1 },
  );
}

async function ringPixels(sel, vp, maxTabs) {
  const page = await newPage(vp);
  const box = await page.locator(sel).first().boundingBox();
  if (!box) {
    await page.close();
    return { sel, box: null };
  }
  const pad = 10;
  const clip = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.ceil(box.width + pad * 2),
    height: Math.ceil(box.height + pad * 2),
  };
  const ringBox = {
    x0: Math.floor(box.x) - clip.x,
    y0: Math.floor(box.y) - clip.y,
    x1: Math.ceil(box.x + box.width) - clip.x,
    y1: Math.ceil(box.y + box.height) - clip.y,
  };
  const resetScroll = () =>
    page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelectorAll("*").forEach((e) => {
        if (e.scrollLeft) e.scrollLeft = 0;
        if (e.scrollTop) e.scrollTop = 0;
      });
    });
  let reached = false;
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((s) => document.activeElement === document.querySelector(s), sel)) {
      reached = true;
      break;
    }
  }
  if (!reached) {
    await page.close();
    return { sel, reached: false };
  }
  await page.keyboard.press("Shift+Tab");
  await resetScroll();
  await page.waitForTimeout(140);
  const before = await page.screenshot({ clip });
  await page.keyboard.press("Tab");
  await resetScroll();
  await page.waitForTimeout(140);
  const after = await page.screenshot({ clip });
  const diff = await pixelDiff(page, before, after, ringBox);
  await page.close();
  return { sel, reached: true, w: Math.round(box.width), h: Math.round(box.height), ...diff };
}

out.focusRing = [
  await ringPixels("#btn-mode", { width: 1440, height: 900 }, 5),
  await ringPixels("#map-zoom-in", { width: 1440, height: 900 }, 260),
  await ringPixels("#btn-toggle-panel", { width: 900, height: 900 }, 12),
  await ringPixels("#legend-lang-btn", { width: 1440, height: 900 }, 260),
];

// ─────────────────────────────────────────────────────────────────────────────
// ③ 44px 計數（mobile 390，嚴格「真可見可點」）
// ─────────────────────────────────────────────────────────────────────────────
{
  const page = await newPage({ width: 390, height: 844 });
  const res = await page.evaluate(() => {
    const SEL =
      'button, a[href], [role=button], [role=tab], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    const all = Array.from(document.querySelectorAll(SEL)).filter((el) => {
      // 唔可以喺 aria-hidden / inert 之下
      let n = el;
      while (n) {
        if (n.hasAttribute("inert") || n.getAttribute("aria-hidden") === "true") return false;
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
        n = n.parentElement;
      }
      return true;
    });
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const visible = [];
    const offenders = [];
    for (const el of all) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      // 中心點要喺 viewport 內
      if (cx < 0 || cx > vw || cy < 0 || cy > vh) continue;
      // 冇被遮蓋（中心點命中自己或後代）
      const hit = document.elementFromPoint(cx, cy);
      if (!(hit === el || el.contains(hit))) continue;
      const item = {
        sel: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${
          typeof el.className === "string" && el.className
            ? "." + el.className.split(/\s+/)[0]
            : ""
        }`,
        w: Math.round(b.width * 10) / 10,
        h: Math.round(b.height * 10) / 10,
      };
      visible.push(item);
      if (b.width < 44 || b.height < 44) offenders.push(item);
    }
    return { totalVisible: visible.length, offenders, offendersCount: offenders.length };
  });
  out.touch44Mobile390 = res;
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ scrollWidth（desktop 1400 / mobile 390）
// ─────────────────────────────────────────────────────────────────────────────
async function scrollWidth(vp) {
  const page = await newPage(vp);
  const r = await page.evaluate(() => {
    // 試吓捲去最右，睇實際有冇橫向捲動能力
    window.scrollTo(99999, 0);
    const afterX = window.scrollX;
    window.scrollTo(0, 0);
    return {
      viewport: document.documentElement.clientWidth,
      htmlScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      windowScrollXAfterScrollTo: afterX,
      htmlScrollLeft: document.documentElement.scrollLeft,
      bodyScrollLeft: document.body.scrollLeft,
    };
  });
  await page.close();
  return r;
}

out.scrollWidth = {
  desktop1400: await scrollWidth({ width: 1400, height: 900 }),
  mobile390: await scrollWidth({ width: 390, height: 844 }),
};

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ OnboardingCard 遮蓋檢查（產品修嘅驗證）
// ─────────────────────────────────────────────────────────────────────────────
{
  const page = await newPage({ width: 1400, height: 900 });
  // 去第 198 章 + zoom（同 map-interaction e2e 一致）
  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await page.waitForTimeout(1500);
  for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
  await page.waitForTimeout(900);
  const ob = await page.evaluate(() => {
    const card = document.querySelector(".onboarding-card");
    const cs = card ? getComputedStyle(card) : null;
    const r = card ? card.getBoundingClientRect() : null;
    let coveredByCard = 0;
    let coveredIds = [];
    for (const z of Array.from(document.querySelectorAll("#zones-layer .zone"))) {
      const a = z.querySelector(".zone-area");
      if (!a) continue;
      const b = a.getBoundingClientRect();
      if (b.width < 12 || b.height < 12) continue;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      if (!r) continue;
      if (cx >= r.x && cx <= r.right && cy >= r.y && cy <= r.bottom) {
        const hit = document.elementFromPoint(cx, cy);
        if (!(hit && (hit.closest(".zone") || hit.classList.contains("zone-area")))) {
          coveredByCard++;
          if (coveredIds.length < 5) coveredIds.push(z.getAttribute("data-zone-id"));
        }
      }
    }
    // 同時喺「第 198 章 + zoom」狀態量 scrollWidth（核實 P1-1 溢出觀察）
    window.scrollTo(99999, 0);
    const afterX = window.scrollX;
    window.scrollTo(0, 0);
    return {
      cardRect: r
        ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        : null,
      pointerEvents: cs?.pointerEvents ?? null,
      zoneCentersInsideCardButNotClickable: coveredByCard,
      ids: coveredIds,
      scrollWidthAfterCh198: {
        viewport: document.documentElement.clientWidth,
        htmlScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        windowScrollXAfterScrollTo: afterX,
        htmlScrollLeft: document.documentElement.scrollLeft,
        bodyScrollLeft: document.body.scrollLeft,
        stripTrackScrollLeft: document.querySelector("#strip-track")?.scrollLeft ?? null,
        stripTrackScrollWidth: document.querySelector("#strip-track")?.scrollWidth ?? null,
      },
    };
  });
  out.onboarding = ob;
  await page.close();
}

await browser.close();
console.log(JSON.stringify(out, null, 2));

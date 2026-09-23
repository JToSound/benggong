/*
 * 更貼近原 bug 嘅因果重現 —— 由 general-purpose-3 獨立設計。
 *
 * 被驗者聲稱嘅根因：mouseup 期間（handler 內）replaceChildren 換走
 * mousedown 嗰個 .zone-area → 瀏覽器唔合成 click。
 *
 * 我哋用三種時序去試，睇邊種真係消滅 click：
 *   A. 基準：乜都唔做 → 應該有 click
 *   B. mouseup handler 內（bubble 階段，同 MapViewport 一樣）replaceChildren
 *   C. mouseup handler 內只 remove 嗰個 .zone-area（單一受害者）
 *   D. mouseup handler 內 replaceChildren 但保留同一個 DOM 參照（no-op 內容）
 *
 * 咁樣可以分辨「時間點（mouseup vs click 之間）」同
 * 「DOM 身份被換走」各自嘅貢獻。
 */
import { chromium } from "@playwright/test";

const BASE = "http://localhost:5174/";
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

async function freshSetup() {
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("#svg-map", { timeout: 30000 });
  await page.waitForTimeout(1400);
  // 去有 zone 嘅視圖：按 k ×197 + zoom
  for (let i = 0; i < 197; i++) await page.keyboard.press("k");
  await page.waitForTimeout(1000);
  for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const svg = document.querySelector("#svg-map");
    const r = svg.getBoundingClientRect();
    let best = null;
    for (const z of document.querySelectorAll("#zones-layer .zone")) {
      const a = z.querySelector(".zone-area");
      if (!a) continue;
      const b = a.getBoundingClientRect();
      if (b.width < 20 || b.height < 20) continue;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      if (cx < r.x + 10 || cx > r.right - 10 || cy < r.y + 10 || cy > r.bottom - 10) continue;
      if (!best || b.width * b.height > best.area)
        best = { id: z.getAttribute("data-zone-id"), cx, cy, area: b.width * b.height };
    }
    return best;
  });
}

async function trial(label, setupFn) {
  const t = await freshSetup();
  if (!t) { console.log(`${label}: 搵唔到 zone`); return; }
  await page.evaluate(setupFn ?? (() => {}), {});
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener("click", (e) => window.__clicks.push(e.target?.getAttribute?.("class") ?? e.target?.tagName), true);
  });
  await page.mouse.move(t.cx, t.cy);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(500);
  const res = await page.evaluate(() => ({
    clickCount: window.__clicks.length,
    clicks: window.__clicks,
    selected: document.querySelectorAll("#zones-layer .zone.is-selected").length,
  }));
  console.log(`${label}: ${JSON.stringify(res)}`);
  return res;
}

// A. 基準
await trial("A 基準（唔做嘢）", () => {});

// B. mouseup handler（bubble，同 MapViewport）內 replaceChildren
await trial("B mouseup(replaceChildren 全層)", () => {
  window.addEventListener("mouseup", () => {
    document.getElementById("zones-layer")?.replaceChildren();
  }); // bubble 階段，預設
});

// C. mouseup handler 內只移除 .zone-area（受害者單一）
await trial("C mouseup(只移除 .zone-area)", () => {
  window.addEventListener("mouseup", () => {
    document.querySelectorAll("#zones-layer .zone-area").forEach((a) => a.remove());
  });
});

// D. mouseup handler 內 replaceChildren 一個 clone（換走身份但保留外觀）
await trial("D mouseup(replaceChildren 空 → 再克隆)", () => {
  window.addEventListener("mouseup", () => {
    const l = document.getElementById("zones-layer");
    if (l) { const c = l.cloneNode(true); l.replaceChildren(); l.append(...c.childNodes); }
  });
});

// E. 喺 mousedown 嘅 target 身上派發：mouseup 時只改 class（唔郁 DOM 結構）
await trial("E mouseup(只改一個唔相關 class)", () => {
  window.addEventListener("mouseup", () => {
    document.getElementById("zones-layer")?.classList.toggle("noop-x");
  });
});

await browser.close();

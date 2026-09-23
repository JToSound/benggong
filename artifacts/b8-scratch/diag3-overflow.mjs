/**
 * 診斷 3：搵出令 `body.scrollWidth = 1778`（> viewport 1400）嘅元素，
 * 同確認 `#app-root` 幾時由 x=0 變負數。
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

/** 搵所有右邊界超出 viewport 闊度嘅元素。 */
const findOverflow = () =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    document.querySelectorAll("*").forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return;
      // 用 offsetWidth 睇元素自身闊度（唔受 transform / scroll 影響）
      const ow = el.offsetWidth || 0;
      if (b.right > vw + 1 || ow > vw + 1) {
        const cs = getComputedStyle(el);
        out.push({
          sel: `${el.tagName}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".") : ""}`,
          x: Math.round(b.x),
          right: Math.round(b.right),
          w: Math.round(b.width),
          offsetWidth: ow,
          position: cs.position,
          overflowX: cs.overflowX,
        });
      }
    });
    // 由最闊排起
    out.sort((a, b) => b.offsetWidth - a.offsetWidth);
    return {
      viewportW: vw,
      htmlScrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      bodyScrollLeft: document.body.scrollLeft,
      htmlScrollLeft: document.documentElement.scrollLeft,
      windowScrollX: scrollX,
      offenders: out.slice(0, 15),
    };
  });

console.log("=== ① 初始：搵溢出元素 ===");
const a = await findOverflow();
console.log(JSON.stringify(a, null, 2));

console.log("\n=== ② 按 k ×197（逐步監測 scrollX） ===");
const scrollTrace = [];
for (let i = 0; i < 197; i++) {
  await page.keyboard.press("k");
  if (i % 20 === 0 || i === 196) {
    const s = await page.evaluate(() => ({
      i: window.__i,
      scrollX,
      htmlScrollLeft: document.documentElement.scrollLeft,
      bodyScrollLeft: document.body.scrollLeft,
      appX: Math.round(document.querySelector("#app-root").getBoundingClientRect().x),
      activeEl: document.activeElement?.id || document.activeElement?.tagName,
    }));
    scrollTrace.push({ step: i, ...s });
  }
}
console.log(JSON.stringify(scrollTrace, null, 2));

console.log("\n=== ③ 每次 click #map-zoom-in 後 scrollX ===");
for (let i = 0; i < 3; i++) {
  await page.click("#map-zoom-in");
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => ({
    step: window.__z,
    scrollX,
    htmlScrollLeft: document.documentElement.scrollLeft,
    appX: Math.round(document.querySelector("#app-root").getBoundingClientRect().x),
    activeEl: document.activeElement?.id || document.activeElement?.tagName,
  }));
  console.log(JSON.stringify(s));
}

console.log("\n=== ④ zoom 之後再搵溢出 ===");
const b = await findOverflow();
console.log(JSON.stringify({ ...b, offenders: b.offenders.slice(0, 8) }, null, 2));

console.log("\n=== ⑤ OnboardingCard 遮蓋範圍 ===");
const ob = await page.evaluate(() => {
  const el = document.querySelector(".onboarding-card, #onboarding-card");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
  let covered = 0;
  let coveredIds = [];
  for (const z of zones) {
    const area = z.querySelector(".zone-area");
    if (!area) continue;
    const zb = area.getBoundingClientRect();
    if (zb.width < 12 || zb.height < 12) continue;
    const cx = zb.x + zb.width / 2;
    const cy = zb.y + zb.height / 2;
    if (cx >= r.x && cx <= r.right && cy >= r.y && cy <= r.bottom) {
      covered++;
      if (coveredIds.length < 5) coveredIds.push(z.getAttribute("data-zone-id"));
    }
  }
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    pointerEvents: cs.pointerEvents,
    zIndex: cs.zIndex,
    display: cs.display,
    coveredZoneCenters: covered,
    coveredIds,
  };
});
console.log(JSON.stringify(ob, null, 2));

await browser.close();

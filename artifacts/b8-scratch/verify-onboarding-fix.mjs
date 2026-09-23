/**
 * 獨立驗證：`OnboardingCard` 修好之後，**卡身覆蓋範圍內**嘅 zone
 * 中心係否真正可點（唔止 `elementFromPoint` 命中，而係真 click 有選中）。
 *
 * 為何要獨立驗：
 * `tests/map-interaction.e2e.test.ts` 改為「揀第一個真正可點嘅 zone」之後，
 * 如果佢揀到卡外嘅 zone，就**冇驗證到卡內嘅 zone**。
 * 呢個腳本專門針對卡內嘅 zone。
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:4173/";

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
for (let i = 0; i < 197; i++) await page.keyboard.press("k");
await page.waitForTimeout(1500);
for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
await page.waitForTimeout(900);

// ① 搵卡身覆蓋範圍內嘅 zone 中心
const inside = await page.evaluate(() => {
  const card = document.querySelector(".onboarding-card");
  if (!card) return { found: false, reason: "冇 onboarding-card" };
  const cr = card.getBoundingClientRect();
  const cs = getComputedStyle(card);
  const out = [];
  for (const z of Array.from(document.querySelectorAll("#zones-layer .zone"))) {
    const a = z.querySelector(".zone-area");
    if (!a) continue;
    const b = a.getBoundingClientRect();
    if (b.width < 12 || b.height < 12) continue;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    if (cx < cr.x || cx > cr.right || cy < cr.y || cy > cr.bottom) continue;
    const el = document.elementFromPoint(cx, cy);
    out.push({
      id: z.getAttribute("data-zone-id"),
      cx: Math.round(cx),
      cy: Math.round(cy),
      hitClass: el ? el.getAttribute("class") : null,
      hitTag: el ? el.tagName : null,
      hitsZone:
        Boolean(el?.closest?.(".zone")) ||
        el?.classList.contains("zone-area") === true,
    });
  }
  return {
    found: true,
    cardRect: {
      x: Math.round(cr.x),
      y: Math.round(cr.y),
      w: Math.round(cr.width),
      h: Math.round(cr.height),
    },
    cardPointerEvents: cs.pointerEvents,
    zonesInsideCard: out.length,
    zones: out,
  };
});

console.log("=== ① 卡身覆蓋範圍內嘅 zone ===");
console.log(JSON.stringify(inside, null, 2));

// ② 對卡內每個 zone 中心做真 click，確認有選中
const results = [];
if (inside.found && inside.zones?.length) {
  for (const z of inside.zones) {
    // 先清選中
    await page.evaluate(() => {
      document
        .querySelectorAll(".zone.is-selected")
        .forEach((e) => e.classList.remove("is-selected"));
    });
    await page.mouse.click(z.cx, z.cy);
    await page.waitForTimeout(350);
    const sel = await page.evaluate(() => ({
      selectedCount: document.querySelectorAll(".zone.is-selected").length,
      selectedId:
        document.querySelector(".zone.is-selected")?.getAttribute("data-zone-id") ?? null,
      urlHasZone: window.location.search.includes("zone="),
    }));
    results.push({ id: z.id, ...sel });
  }
}

console.log("\n=== ② 卡內 zone 真 click 結果 ===");
console.log(JSON.stringify(results, null, 2));

// ③ 卡上嘅互動元件係否仍然可點（4 個主入口）
const actions = await page.evaluate(() => {
  const els = Array.from(
    document.querySelectorAll(".onboarding-card .onboarding-action, .onboarding-card .onboarding-dismiss"),
  );
  return els.map((e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      text: (e.textContent || "").trim().slice(0, 12),
      w: Math.round(r.width),
      h: Math.round(r.height),
      pointerEvents: cs.pointerEvents,
      reachable: hit === e || e.contains(hit),
    };
  });
});

console.log("\n=== ③ 卡上互動元件可達性 ===");
console.log(JSON.stringify(actions, null, 2));

await browser.close();

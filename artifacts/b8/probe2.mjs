import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForSelector("#svg-map", { timeout: 20000 });
await p.waitForTimeout(2500);
const r = await p.evaluate(() => {
  const mc = document.getElementById("map-controls");
  const cs = getComputedStyle(mc);
  // 邊條規則贏？
  const hits = [];
  for (const ss of Array.from(document.styleSheets)) {
    let rules; try { rules = ss.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (rule.selectorText && rule.style && /map-controls/.test(rule.selectorText) && rule.style.bottom) {
        hits.push({ sel: rule.selectorText, bottom: rule.style.bottom, important: rule.style.getPropertyPriority("bottom"), href: ss.href || "(inline)", idx: Array.from(document.styleSheets).indexOf(ss) });
      }
    }
  }
  return { computedBottom: cs.bottom, hits, sheetCount: document.styleSheets.length };
});
console.log(JSON.stringify(r, null, 2));
await b.close();

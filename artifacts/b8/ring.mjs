import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await p.waitForTimeout(900);
await p.keyboard.press("Tab");
await p.keyboard.press("Tab");
const r = await p.evaluate(() => {
  const el = document.activeElement;
  const cs = getComputedStyle(el);
  return {
    id: el?.id, tag: el?.tagName,
    focusVisible: el?.matches(":focus-visible"),
    outline: cs.outline, outlineOffset: cs.outlineOffset,
    boxShadow: cs.boxShadow, clipPath: cs.clipPath,
    matchesNavBtn: el?.classList?.contains("nav-btn"),
  };
});
console.log(JSON.stringify(r, null, 2));
// 所有 nav-btn 的 focus-visible 規則
const rules = await p.evaluate(() => {
  const out = [];
  for (const ss of Array.from(document.styleSheets)) {
    let rr; try { rr = ss.cssRules; } catch { continue; }
    for (const rule of Array.from(rr)) {
      const st = rule.style;
      const sel = rule.selectorText || "";
      if (st && /focus-visible/.test(sel) && /nav-btn|btn-mode/.test(sel)) out.push({ sel, css: rule.cssText.slice(0, 220) });
    }
  }
  return out;
});
console.log(JSON.stringify(rules, null, 2));
await b.close();

/**
 * A7 探針：用 CDP 查出 focus outline 嘅實際來源規則（唔靠猜）。
 * 執行：node artifacts/audit-A7/a7-probe-outline.mjs
 */
import { chromium } from "playwright";

const b = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto("http://localhost:5180/", { waitUntil: "load" });
await p.waitForSelector("#svg-map");
await p.waitForTimeout(2000);
const client = await ctx.newCDPSession(p);
await client.send("DOM.enable");
await client.send("CSS.enable");
const doc = await client.send("DOM.getDocument");

const report = {};
for (const sel of ["#map-zoom-in", "#legend-lang-btn", "#btn-mode", ".ch-pill", "#btn-toggle-panel"]) {
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
  if (!nodeId) { report[sel] = { error: "not found" }; continue; }
  await p.evaluate((s) => document.querySelector(s).focus(), sel);
  await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus", "focus-visible"] });
  const m = await client.send("CSS.getMatchedStylesForNode", { nodeId });
  const rules = (m.matchedCSSRules || [])
    .filter((r) => /focus/.test(r.rule.selectorList.text))
    .map((r) => ({
      selector: r.rule.selectorList.text,
      origin: r.rule.origin,
      outline: (r.rule.style.cssProperties || [])
        .filter((x) => /outline/.test(x.name))
        .map((x) => `${x.name}: ${x.value}${x.important ? " !important" : ""}`),
    }));
  const computed = await p.evaluate((s) => {
    const el = document.querySelector(s);
    const cs = getComputedStyle(el);
    return {
      outline: cs.outline, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor, currentColor: cs.color,
      clipPath: cs.clipPath.slice(0, 60),
      rect: (() => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
      theme: document.documentElement.getAttribute("data-theme"),
    };
  }, sel);
  report[sel] = { rules, computed };
}
console.log(JSON.stringify(report, null, 2));
await b.close();

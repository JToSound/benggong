import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForSelector("#svg-map", { timeout: 20000 });
await p.waitForTimeout(2500);
const r = await p.evaluate(() => {
  // 找 legend
  const cands = Array.from(document.querySelectorAll("*")).filter(e => /legend/i.test(e.className?.baseVal ?? e.className ?? "") || /legend/i.test(e.id));
  const legend = cands.map(e => ({ tag: e.tagName, cls: (e.className?.baseVal ?? e.className ?? "").toString(), id: e.id })).slice(0, 8);
  // 嚴格 44px 量測
  const SEL = 'button, a[href], [role=button], [role=tab], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const all = Array.from(document.querySelectorAll(SEL));
  const vis = all.filter(el => {
    let n = el;
    while (n) { if (n.hasAttribute("inert") || n.getAttribute("aria-hidden") === "true") return false;
      const cs = getComputedStyle(n); if (cs.display === "none" || cs.visibility === "hidden") return false; n = n.parentElement; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return true;
  });
  const small = vis.filter(el => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; })
    .map(el => { const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0,40), id: el.id, w: Math.round(r.width), h: Math.round(r.height) }; });
  return { legendCandidates: legend, total: all.length, visible: vis.length, smallCount: small.length, smallSample: small.slice(0, 15) };
});
console.log(JSON.stringify(r, null, 2));
await b.close();

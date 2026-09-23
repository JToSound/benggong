import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForSelector("#svg-map", { timeout: 20000 });

await p.waitForTimeout(2500);
const r = await p.evaluate(() => {
  const SEL = 'button, a[href], [role=button], [role=link], [role=tab], [role=option], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const els = Array.from(document.querySelectorAll(SEL));
  const blocked = (el) => { let n = el; while (n) { if (n.getAttribute && (n.getAttribute('aria-hidden')==='true' || n.hasAttribute('inert'))) return true; const cs = getComputedStyle(n); if (cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0') return true; n = n.parentElement; } return false; };
  const out = [];
  for (const el of els) {
    if (el instanceof SVGElement && el.tagName !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    if (blocked(el)) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    out.push({ tag: el.tagName.toLowerCase(), id: el.id||'', cls: ((el.className && el.className.baseVal!==undefined)?el.className.baseVal:el.className)||'', w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10 });
  }
  return { count: out.length, violations: out.filter(e => e.w < 44 || e.h < 44) };
});
console.log(JSON.stringify(r, null, 2));
await b.close();

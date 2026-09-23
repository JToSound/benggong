import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const res = {};
const mk = async (vp) => { const c = await browser.newContext(vp); const p = await c.newPage();
  await p.goto(BASE, { waitUntil: "load" }); await p.waitForSelector("#svg-map", { timeout: 20000 });
  await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await p.waitForTimeout(1500); return { c, p }; };
const A = async (p) => await p.evaluate(() => { const a = document.activeElement;
  if (!a) return "null"; return a.tagName + "." + ((a.getAttribute && a.getAttribute("class")) || "") + "#" + (a.id || ""); });

// A: 全新載入，直接 Tab
{ const { c, p } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const seq = []; for (let i = 0; i < 3; i++) { await p.keyboard.press("Tab"); seq.push(await A(p)); }
  res.A_freshTab = seq; await c.close(); }

// B: 將 skip-link 由 -40px 移到 0（唔改檔，只喺 runtime 改 inline style）再 Tab
{ const { c, p } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await p.evaluate(() => { const s = document.querySelector(".skip-link"); s.style.top = "0px"; s.style.transform = "none"; });
  await p.evaluate(() => document.activeElement.blur());
  const seq = []; for (let i = 0; i < 3; i++) { await p.keyboard.press("Tab"); seq.push(await A(p)); }
  res.B_skipLinkMovedIntoView = seq; await c.close(); }

// C: 將 #chapter-strip-mount 暫時 display:none（唔改檔），睇 Tab 頭幾個
{ const { c, p } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await p.evaluate(() => { document.querySelector("#chapter-strip-mount").style.display = "none"; document.activeElement.blur(); });
  const seq = []; for (let i = 0; i < 3; i++) { await p.keyboard.press("Tab"); seq.push(await A(p)); }
  res.C_stripHidden = seq; await c.close(); }

// D: 只用 runtime 將 skip-link 移入視圖，同時保留 strip
{ const { c, p } = await mk({ viewport: { width: 1440, height: 900 } });
  await p.evaluate(() => { const s = document.querySelector(".skip-link"); s.style.top = "0px"; });
  await p.evaluate(() => document.activeElement.blur());
  const seq = []; for (let i = 0; i < 3; i++) { await p.keyboard.press("Tab"); seq.push(await A(p)); }
  res.D_desktop_skipLinkMovedIntoView = seq; await c.close(); }

// E: 檢查 skip-link 嘅 rect 同祖先 overflow（決定佢係唔係「視覺上被剪走」）
{ const { c, p } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  res.E_skipLink = await p.evaluate(() => { const s = document.querySelector(".skip-link");
    const cs = getComputedStyle(s); const r = s.getBoundingClientRect();
    const anc = []; let n = s.parentElement, d = 0;
    while (n && n.nodeType === 1 && d < 20) { const pcs = getComputedStyle(n);
      anc.push({ sel: n.id ? "#"+n.id : "."+(n.getAttribute("class")||"").split(/\s+/)[0], overflow: pcs.overflow, clipPath: pcs.clipPath, rect: (()=>{const q=n.getBoundingClientRect();return {x:+q.x.toFixed(1),y:+q.y.toFixed(1),w:+q.width.toFixed(1),h:+q.height.toFixed(1)};})() });
      n = n.parentElement; d++; }
    return { css: { position: cs.position, top: cs.top, left: cs.left, transform: cs.transform, clip: cs.clip, clipPath: cs.clipPath, zIndex: cs.zIndex }, rect: { x:r.x,y:r.y,w:r.width,h:r.height }, ancestors: anc }; });
  await c.close(); }

console.log(JSON.stringify(res, null, 1));
await browser.close();

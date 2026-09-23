import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
for (const [label, vp] of [["mobile-390",{width:390,height:844,hasTouch:true,isMobile:true}],["desktop-1440",{width:1440,height:900}]]) {
  const ctx = await browser.newContext(vp);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#svg-map", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => {
    const s = document.querySelector(".skip-link");
    const appRoot = document.querySelector("#app-root");
    const strip = document.querySelector("#strip-track");
    const scrollers = [];
    let n = s, d = 0;
    while (n && n.nodeType === 1 && d < 30) {
      if (n.scrollTop !== 0 || n.scrollLeft !== 0) scrollers.push({ sel: n.id ? "#"+n.id : "."+(n.getAttribute("class")||"").split(/\s+/)[0], scrollTop: n.scrollTop, scrollLeft: n.scrollLeft, overflow: getComputedStyle(n).overflow });
      n = n.parentElement; d++;
    }
    const r = s.getBoundingClientRect();
    return { skipRect: {x:r.x,y:r.y,w:r.width,h:r.height}, docScrollY: window.scrollY,
      appRootScrollTop: appRoot.scrollTop, appRootOverflow: getComputedStyle(appRoot).overflow,
      stripScrollLeft: strip ? strip.scrollLeft : null, scrolledAncestors: scrollers,
      activePillScroll: (()=>{const p=document.querySelector(".ch-pill.active");if(!p)return null;const pr=p.getBoundingClientRect();return {x:pr.x,y:pr.y};})() };
  });
  // Tab 1
  await page.keyboard.press("Tab");
  const t1 = await page.evaluate(() => { const a=document.activeElement; return a.tagName+"."+(a.getAttribute("class")||"")+"#"+(a.id||""); });
  // 重設 scroll 再試
  await page.evaluate(() => { window.scrollTo(0,0); document.querySelectorAll("*").forEach(e=>{ if(e.scrollTop) e.scrollTop=0; }); document.activeElement.blur(); });
  await page.waitForTimeout(300);
  await page.keyboard.press("Tab");
  const t1b = await page.evaluate(() => { const a=document.activeElement; return a.tagName+"."+(a.getAttribute("class")||"")+"#"+(a.id||""); });
  console.log(label, JSON.stringify({state, tab1:t1, afterScrollReset_tab1:t1b}, null, 1));
  await ctx.close();
}
await browser.close();

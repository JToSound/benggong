import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#svg-map", { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await page.waitForTimeout(1500);
const before = await page.evaluate(() => ({ hasFocus: document.hasFocus(), active: document.activeElement ? document.activeElement.tagName+"/"+(document.activeElement.id||document.activeElement.className||"") : null }));
await page.keyboard.press("Tab");
const t1 = await page.evaluate(() => { const a=document.activeElement; return {tag:a.tagName,id:a.id,cls:a.getAttribute("class"),text:(a.textContent||"").trim().slice(0,20)}; });
// reset: 用 evaluate 將 focus 序起點搬去 body 最前
await page.evaluate(() => { document.querySelector(".skip-link").focus(); });
const f = await page.evaluate(() => { const a=document.activeElement; return {tag:a.tagName,cls:a.getAttribute("class")}; });
console.log(JSON.stringify({before, tab1:t1, afterExplicitSkipLinkFocus:f},null,1));
// 檢查 skip-link 是否 tabbable / 可見
const skip = await page.evaluate(()=>{const s=document.querySelector(".skip-link");const cs=getComputedStyle(s);const r=s.getBoundingClientRect();return{display:cs.display,visibility:cs.visibility,position:cs.position,top:cs.top,rect:{x:r.x,y:r.y,w:r.width,h:r.height},tabIndex:s.tabIndex,clippedBy:(()=>{let n=s,d=0;const o=[];while(n&&n.nodeType===1&&d<30){const p=getComputedStyle(n);if(p.overflow!=="visible")o.push((n.id?"#"+n.id:"."+(n.getAttribute("class")||"").split(/\s+/)[0])+"{overflow:"+p.overflow+"}");if(p.clipPath&&p.clipPath!=="none")o.push("clipPath:"+p.clipPath);n=n.parentElement;d++;}return o;})()};});
console.log(JSON.stringify(skip,null,1));
await browser.close();

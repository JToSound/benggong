import { chromium } from "@playwright/test";
const browser = await chromium.launch({ args: ["--no-proxy-server","--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport:{width:1400,height:900} })).newPage();
await page.goto("http://localhost:5174/",{waitUntil:"load",timeout:60000});
await page.waitForSelector("#svg-map",{timeout:30000});
await page.waitForTimeout(1500);
const out = await page.evaluate(()=>{
  const svg=document.querySelector("#svg-map");
  const vb=svg.getAttribute("viewBox").split(/\s+/).map(Number);
  const rect=svg.getBoundingClientRect();
  const pxPerUser=rect.width/vb[2];
  const c=document.querySelector("#zones-layer .zone-cluster");
  const ring=c.querySelector("circle");
  const rUser=Number(ring.getAttribute("r"));
  const txt=c.querySelector(".zone-cluster-count");
  const fsUser=Number(txt.getAttribute("font-size"));
  const rr=ring.getBoundingClientRect();
  const tr=txt.getBoundingClientRect();
  const cs=getComputedStyle(txt);
  return {
    viewBoxW:vb[2], svgCssWpx:rect.width, pxPerUser:Math.round(pxPerUser*10)/10,
    ringR_user:rUser, ringDiameter_px:Math.round((rUser*2*pxPerUser)*10)/10,
    font_user:fsUser, font_px:Math.round(fsUser*pxPerUser*100)/100,
    ringRect:{w:Math.round(rr.width*10)/10,h:Math.round(rr.height*10)/10},
    textRect:{w:Math.round(tr.width*10)/10,h:Math.round(tr.height*10)/10},
    txtComputedFontSize:cs.fontSize, txtComputedFontFamily:cs.fontFamily,
    glyphD:c.querySelector(".zone-cluster-glyph").getAttribute("d"),
    symbolsDefined:Array.from(document.querySelectorAll("symbol[id^='zone-glyph-']")).map(s=>s.id),
  };
});
console.log(JSON.stringify(out,null,2));
await browser.close();

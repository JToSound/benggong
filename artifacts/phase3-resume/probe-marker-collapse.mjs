import { chromium } from "@playwright/test";
import { BASE, LAUNCH_ARGS, ensurePreviewServer, withTeardown } from "./_probe-lib.mjs";
const M = () => {
  const q=(s)=>Array.from(document.querySelectorAll(s));
  const clusters=q("#locations-layer .location-marker-cluster");
  return {
    viewBox: document.querySelector("#svg-map")?.getAttribute("viewBox"),
    markers: q("#locations-layer .location-marker").length,
    clusters: clusters.length,
    clusterCounts: clusters.map(c=>c.getAttribute("data-loc-count")),
    clusterLabels: clusters.map(c=>(c.getAttribute("aria-label")||"").slice(0,44)),
    layers: q("#locations-layer > *").length,
  };
};
const server = await ensurePreviewServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
await withTeardown(browser, server, async () => {
  for (const vp of [{width:1440,height:900},{width:1280,height:800}]) {
    const page = await browser.newPage({ viewport: vp, locale:"zh-HK" });
    await page.addInitScript(()=>{ try{localStorage.setItem("binggang.onboarding.dismissed","1");}catch{} });
    await page.goto(BASE,{waitUntil:"networkidle"});
    await page.waitForFunction(()=>document.querySelectorAll(".ch-pill").length>100,null,{timeout:20000});
    await page.waitForTimeout(1200);
    console.log(`\n=== ${vp.width}x${vp.height} ===`);
    console.log(JSON.stringify(await page.evaluate(M),null,1));
    // 放大 3 級睇 marker 會唔會分開
    for (let i=0;i<3;i++) await page.click("#map-zoom-in");
    await page.waitForTimeout(900);
    console.log("-- 放大 3 級之後 --");
    console.log(JSON.stringify(await page.evaluate(M),null,1));
    await page.close();
  }
});

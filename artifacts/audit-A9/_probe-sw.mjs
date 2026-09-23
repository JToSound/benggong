import { chromium } from "playwright";
const BASE = "http://localhost:5180/";
const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
for (const swBlock of [false, true]) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: swBlock ? "block" : "allow",
  });
  const page = await ctx.newPage();
  const errs = [], reqs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 140)); });
  page.on("pageerror", (e) => errs.push("PE:" + String(e).slice(0, 140)));
  page.on("request", (r) => { if (/events\.geojson/.test(r.url())) reqs.push(r.url()); });
  await page.route("**/data/public/events.geojson", (r) => r.fulfill({ status: 404, contentType: "text/plain", body: "nf" }));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(6000);
  const snap = await page.evaluate(() => ({
    map: !!document.querySelector("#svg-map-mount svg"),
    err: !!document.querySelector(".bg-error-panel"),
    errTxt: document.querySelector(".bg-error-panel")?.innerText?.slice(0, 160) || null,
    bodyLen: (document.body.innerText || "").length,
    sw: !!navigator.serviceWorker?.controller,
  }));
  console.log("swBlock=", swBlock, "snap=", JSON.stringify(snap), "errs=", errs.slice(0, 3), "reqs=", reqs.length);
  await ctx.close();
}
await browser.close();

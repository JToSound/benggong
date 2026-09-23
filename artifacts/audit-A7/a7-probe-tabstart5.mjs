import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:5190/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const res = {};
const A = async (p) => await p.evaluate(() => { const a = document.activeElement;
  if (!a) return "null"; return a.tagName + "." + ((a.getAttribute && a.getAttribute("class")) || "") + "#" + (a.id || ""); });
async function run(label, init) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await c.newPage();
  if (init) await p.addInitScript(init);
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#svg-map", { timeout: 20000 });
  await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
  await p.waitForTimeout(1500);
  const seq = []; for (let i = 0; i < 3; i++) { await p.keyboard.press("Tab"); seq.push(await A(p)); }
  res[label] = seq; await c.close();
}
await run("baseline_noInit", null);
await run("scrollIntoView_noop", () => { Element.prototype.scrollIntoView = function () {}; });
await run("scrollIntoView_noop_smoothOnly", () => {
  const orig = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (arg) {
    if (arg && typeof arg === "object" && arg.behavior === "smooth") return;
    return orig.apply(this, arguments);
  };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();

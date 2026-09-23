import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await p.waitForTimeout(800);
const seq = [];
for (let i = 0; i < 30; i++) {
  await p.keyboard.press("Tab");
  seq.push(await p.evaluate(() => {
    const el = document.activeElement;
    return (el?.id || (el?.classList?.contains("skip-link") ? "skip-link" : el?.className?.baseVal ?? el?.className ?? el?.tagName) || "").toString().slice(0, 30);
  }));
}
console.log(JSON.stringify(seq));
await b.close();

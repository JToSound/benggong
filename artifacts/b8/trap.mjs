import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await p.waitForTimeout(800);
await p.keyboard.press("/");
await p.waitForTimeout(400);
const s0 = await p.evaluate(() => {
  const ov = document.querySelector(".search-overlay");
  const el = document.activeElement;
  return { open: ov?.classList.contains("is-open"), cls: ov?.className, activeId: el?.id, activeTag: el?.tagName, inOv: Boolean(ov && el && ov.contains(el)) };
});
console.log("after '/':", JSON.stringify(s0));
const seq = [];
for (let i = 0; i < 8; i++) {
  await p.keyboard.press("Tab");
  seq.push(await p.evaluate(() => {
    const ov = document.querySelector(".search-overlay");
    const el = document.activeElement;
    return { id: el?.id || "", tag: el?.tagName || "", cls: (el?.className?.baseVal ?? el?.className ?? "").toString().slice(0,30), inOv: Boolean(ov && el && ov.contains(el)) };
  }));
}
console.log(JSON.stringify(seq, null, 1));
await b.close();

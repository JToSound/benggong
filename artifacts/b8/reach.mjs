import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:5174/", { waitUntil: "load" });
await p.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, { timeout: 20000 });
await p.waitForTimeout(800);
// 除咗 ch-pill，仲有咩？試由尾行返轉頭
const tail = [];
for (let i = 0; i < 25; i++) {
  await p.keyboard.press("Shift+Tab");
  tail.push(await p.evaluate(() => {
    const el = document.activeElement;
    return (el?.id || (el?.classList?.contains("skip-link") ? "skip-link" : el?.className?.baseVal ?? el?.className ?? el?.tagName) || "").toString().slice(0, 30);
  }));
}
console.log("shift-tab from start:", JSON.stringify(tail));
// 直接查所有可 Tab 元素（排除 pill）
const ids = await p.evaluate(() => {
  const SEL = 'button, a[href], [role=button], [role=tab], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  return Array.from(document.querySelectorAll(SEL)).filter(el => !el.classList.contains("ch-pill")).map(el => el.id || el.className?.baseVal || el.className || el.tagName);
});
console.log("all focusables (no pill):", JSON.stringify(ids));
await b.close();
